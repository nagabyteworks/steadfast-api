const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const axios = require("axios");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const csv = require("fast-csv");
const qs = require("qs");
const { parse, isBefore } = require("date-fns");
const { createHash } = require("crypto");
const requireTradingEnabled = require("../middleware/requireTradingEnabled");
const requireInternalToken = require("../middleware/requireInternalToken");
const createRiskRouter = require("./risk");

const symbolCache = new NodeCache({ stdTTL: 4 * 60 * 60 });
const lotSizeCache = new NodeCache({ stdTTL: 4 * 60 * 60 });
const serverManagedOrderFields = new Set([
  "uid", "actid", "exch", "tsym", "qty", "prc", "prd",
  "trantype", "prctyp", "ret", "ordersource",
]);

const readNfoLotSize = (tradingSymbol) => new Promise((resolve, reject) => {
  const filePath = path.join(__dirname, "../symbols/Nfo_Index_Derivatives.csv");
  const source = fs.createReadStream(filePath);
  const parser = source.pipe(csv.parse({ headers: true }));
  let lotSize = null;

  source.on("error", reject);
  parser
    .on("data", (row) => {
      if (row.Exchange === "NFO" && row.Tradingsymbol === tradingSymbol) {
        const parsedLotSize = Number(row.Lotsize);
        if (Number.isSafeInteger(parsedLotSize) && parsedLotSize > 0) {
          lotSize = parsedLotSize;
        }
      }
    })
    .on("error", reject)
    .on("end", () => resolve(lotSize));
});

const getNfoLotSize = async (tradingSymbol) => {
  const cachedLotSize = lotSizeCache.get(tradingSymbol);
  if (cachedLotSize) {
    return cachedLotSize;
  }

  const lotSize = await readNfoLotSize(tradingSymbol);
  if (lotSize) {
    lotSizeCache.set(tradingSymbol, lotSize);
  }
  return lotSize;
};

module.exports = (
  storedCredentials,
  internalToken,
  onSessionUpdated = async () => {},
  resolveNfoLotSize = getNfoLotSize,
  sessionStore = null,
  environment = process.env.NODE_ENV,
  serverManagedAccount = environment === "production" || Boolean(
    process.env.FLATTRADE_CLIENT_ID &&
    process.env.FLATTRADE_API_KEY &&
    process.env.FLATTRADE_API_SECRET
  ),
  riskStore = null,
  dryRun = true
) => {
  const router = express.Router();
  const production = environment === "production";
  const restrictedTrading = production || serverManagedAccount;
  let loginInProgress = false;
  const getStoredSession = () => sessionStore ? sessionStore.get() : storedCredentials.flattrade;

  const getSession = (req) => serverManagedAccount
    ? getStoredSession()
    : {
        usersession: req.query.FLATTRADE_API_TOKEN || req.headers.authorization?.split(" ")[1],
        userid: req.query.FLATTRADE_CLIENT_ID,
      };

  if (riskStore && serverManagedAccount) {
    router.use("/risk", createRiskRouter({ store: riskStore, getSession: getStoredSession, internalToken, dryRun }));
  }

  const configuredAccount = () => ({
    apiKey: process.env.FLATTRADE_API_KEY,
    apiSecret: process.env.FLATTRADE_API_SECRET,
    clientId: process.env.FLATTRADE_CLIENT_ID,
  });
  const requireServerManagedTrading = (req, res, next) => {
    if (!serverManagedAccount) {
      return res.status(403).json({
        message: "Flattrade live trading requires credentials configured in the API environment",
      });
    }
    next();
  };

  router.use(
    "/flattradeApi",
    (req, res, next) => serverManagedAccount
      ? res.status(403).json({ message: "Raw broker proxy is disabled for server-managed accounts" })
      : next(),
    requireTradingEnabled,
    createProxyMiddleware({
      target: "https://authapi.flattrade.in",
      changeOrigin: true,
      pathRewrite: {
        "^/flattradeApi": "",
      },
    })
  );
  router.post("/generateToken", async (req, res) => {
    console.log("Received generateToken request");
    if (serverManagedAccount) {
      const { apiKey, apiSecret, clientId } = configuredAccount();
      const requestCode = req.body?.request_code;
      if (!apiKey || !apiSecret || !clientId) {
        return res.status(503).json({ message: "Flattrade account is not configured on the server" });
      }
      if (typeof requestCode !== "string" || !requestCode || requestCode.length > 1024) {
        return res.status(400).json({ message: "Invalid Flattrade request code" });
      }
      if (loginInProgress) {
        return res.status(409).json({ message: "A Flattrade session exchange is already in progress" });
      }
      loginInProgress = true;
      try {
        if (sessionStore) sessionStore.clear();
        storedCredentials.flattrade = { usersession: "", userid: "" };
        const apiSecretHash = createHash("sha256")
          .update(apiKey + requestCode + apiSecret)
          .digest("hex");
        const response = await axios.post("https://authapi.flattrade.in/trade/apitoken", {
          api_key: apiKey,
          request_code: requestCode,
          api_secret: apiSecretHash,
        }, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
        const status = response.data?.status ?? response.data?.stat;
        if (
          typeof status !== "string" || status.toLowerCase() !== "ok" ||
          typeof response.data?.token !== "string" || !response.data.token ||
          typeof response.data?.client !== "string" ||
          response.data.client.toUpperCase() !== clientId.toUpperCase()
        ) {
          return res.status(502).json({ message: "Flattrade did not issue a session for the configured account" });
        }
        const session = { usersession: response.data.token, userid: clientId };
        if (sessionStore) sessionStore.set(session);
        else storedCredentials.flattrade = session;
        try {
          await onSessionUpdated();
        } catch (error) {
          console.error("Unable to restart Flattrade streaming after session exchange:", error.message);
          return res.status(503).json({ message: "Flattrade session created, but the streaming service could not be restarted" });
        }
        return res.set("Cache-Control", "no-store").json({ connected: true });
      } catch (error) {
        console.error("Flattrade session exchange failed", { code: error.code, status: error.response?.status });
        return res.status(502).json({ message: "Flattrade session exchange failed" });
      } finally {
        loginInProgress = false;
      }
    }
    try {
      if (!req.body || Object.keys(req.body).length === 0) {
        throw new Error("Empty request body");
      }
  
      const response = await axios.post(
        "https://authapi.flattrade.in/trade/apitoken",
        req.body,
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      res.json(response.data);
    } catch (error) {
      console.error("Error in generateToken:", error.message);
      res
        .status(400)
        .json({ message: "Error generating token", error: error.message });
    }
  });
  router.get("/account", (req, res) => {
    if (!serverManagedAccount) {
      return res.status(404).json({ message: "Server-managed account is not enabled" });
    }
    const { apiKey, apiSecret, clientId } = configuredAccount();
    const configured = Boolean(apiKey && apiSecret && clientId);
    const session = getStoredSession();
    res.set("Cache-Control", "no-store").json({
      configured,
      clientId: configured ? clientId : null,
      hasSession: Boolean(session.usersession),
      ...(session.expiresAt && { expiresAt: new Date(session.expiresAt).toISOString() }),
    });
  });
  router.get("/auth", (req, res) => {
    const { apiKey, apiSecret, clientId } = configuredAccount();
    if (!serverManagedAccount || !apiKey || !apiSecret || !clientId) {
      return res.status(503).json({ message: "Flattrade account is not configured on the server" });
    }
    res.set("Cache-Control", "no-store").redirect(`https://auth.flattrade.in/?app_key=${encodeURIComponent(apiKey)}`);
  });
  if (!production) {
    router.get("/test", (req, res) => {
      console.log("Test route accessed");
      res.status(200).json({ message: "Flattrade router is working" });
    });

    router.head("/test", (req, res) => {
      console.log("Test route accessed (HEAD)");
      res.status(200).end();
    });
  }

  // ===> NON-TRADING API CALLS  <===

  // ===> Endpoint to store the credentials
  router.post("/setCredentials", (req, res) => {
    if (serverManagedAccount) {
      return res.status(403).json({ message: "Browser-provided credentials are disabled for server-managed accounts" });
    }
    console.log("Received POST request to set credentials");
    const { usersession, userid } = req.body;

    // Store the credentials
    storedCredentials.flattrade = {
      usersession,
      userid,
    };

    res.json({ message: "Flattrade Credentials updated successfully" });
    console.log(
      `${new Date().toLocaleTimeString()}  Updated Flattrade credentials`
    );
  });

  // ===> Endpoint to use the stored credentials
  router.get("/websocketData", requireInternalToken(internalToken), (req, res) => {
    // console.log("Received GET request for flattrade websocket data");

    // Use the stored credentials
    const { usersession, userid } = serverManagedAccount ? getStoredSession() : storedCredentials.flattrade;
    const websocketData = { usersession, userid };

    res.set("Cache-Control", "no-store").json(websocketData);
    console.log(
      `${new Date().toLocaleTimeString()}  Sending Flattrade websocket data`
    );
  });

  // ===> Get Flattrade Funds
  router.post("/fundLimit", async (req, res) => {
    const { usersession: jKey, userid: clientId } = getSession(req);

    if (!jKey || !clientId) {
      return res
        .status(400)
        .json({ message: "API token or Client ID is missing." });
    }

    const jData = JSON.stringify({
      uid: clientId,
      actid: clientId,
    });
    const payload = `jKey=${jKey}&jData=${jData}`;

    try {
      const response = await axios.post(
        "https://piconnect.flattrade.in/PiConnectAPI/Limits",
        payload,
        {
          timeout: 10000,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      res.json(response.data);
    } catch (error) {
      console.error("Error fetching Flattrade fund limits", { code: error.code, status: error.response?.status });
      res.status(502).json({ message: "Error fetching Flattrade fund limits" });
    }
  });

  router.get("/positions", async (req, res) => {
    const { usersession, userid } = getSession(req);
    if (!usersession || !userid) {
      return res.status(401).json({ message: "Flattrade session is unavailable" });
    }
    try {
      const payload = `jKey=${usersession}&jData=${JSON.stringify({ uid: userid, actid: userid })}`;
      const response = await axios.post(
        "https://piconnect.flattrade.in/PiConnectAPI/PositionBook",
        payload,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
      );
      res.json(response.data);
    } catch (error) {
      console.error("Error fetching Flattrade positions", { code: error.code, status: error.response?.status });
      res.status(502).json({ message: "Error fetching Flattrade positions" });
    }
  });

  // ===> Get Flattrade Symbols
  router.get("/symbols", (req, res) => {
    const { exchangeSymbol, masterSymbol } = req.query;

    const cacheKey = `${exchangeSymbol}_${masterSymbol}`;

    const cachedData = symbolCache.get(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const callStrikes = [];
    const putStrikes = [];
    const expiryDates = new Set();

    const csvFilePath =
      exchangeSymbol === "BFO"
        ? "./symbols/Bfo_Index_Derivatives.csv"
        : "./symbols/Nfo_Index_Derivatives.csv";

    fs.createReadStream(csvFilePath)
      .pipe(csv.parse({ headers: true }))
      .on("data", (row) => {
        if (
          row["Symbol"] === masterSymbol &&
          row["Exchange"] === exchangeSymbol
        ) {
          const parsedLotSize = Number(row["Lotsize"]);
          const strikeData = {
            tradingSymbol: row["Tradingsymbol"],
            securityId: row["Token"],
            expiryDate: row["Expiry"], // Send expiry date without parsing or formatting
            strikePrice: row["Strike"],
            lotSize: Number.isSafeInteger(parsedLotSize) && parsedLotSize > 0
              ? parsedLotSize
              : null,
          };
          if (row["Optiontype"] === "CE") {
            callStrikes.push(strikeData);
          } else if (row["Optiontype"] === "PE") {
            putStrikes.push(strikeData);
          }
          expiryDates.add(row["Expiry"]);
        }
      })
      .on("end", () => {
        console.log("\nFinished processing file");
        console.log(`Call Strikes: ${callStrikes.length}`);
        console.log(`Put Strikes: ${putStrikes.length}`);
        console.log(`Expiry Dates: ${expiryDates.size}`);

        callStrikes.sort((a, b) => a.strikePrice - b.strikePrice);
        putStrikes.sort((a, b) => a.strikePrice - b.strikePrice);
        // Filter out past dates and sort the remaining expiry dates
        const today = new Date();
        const sortedExpiryDates = Array.from(expiryDates)
          .filter(
            (dateStr) =>
              !isBefore(parse(dateStr, "dd-MMM-yyyy", new Date()), today) ||
              parse(dateStr, "dd-MMM-yyyy", new Date()).toDateString() ===
                today.toDateString()
          )
          .sort((a, b) => {
            const dateA = parse(a, "dd-MMM-yyyy", new Date());
            const dateB = parse(b, "dd-MMM-yyyy", new Date());
            return dateA - dateB;
          });

        const result = {
          callStrikes,
          putStrikes,
          expiryDates: sortedExpiryDates,
        };
        symbolCache.set(cacheKey, result);

        res.json(result);
      })
      .on("error", (error) => {
        res
          .status(500)
          .json({ message: "Failed to process Flattrade CSV file" });
        console.error("Error processing Flattrade CSV file:", error);
      });
  });

  // ===> Get Flattrade Orders and Trades
  router.get("/getOrdersAndTrades", async (req, res) => {
    const { usersession: jKey, userid: clientId } = getSession(req);

    if (!jKey || !clientId) {
      return res
        .status(400)
        .json({ message: "Token or Client ID is missing." });
    }

    const orderBookPayload = `jKey=${jKey}&jData=${JSON.stringify({
      uid: clientId,
      prd: "M",
    })}`;
    const tradeBookPayload = `jKey=${jKey}&jData=${JSON.stringify({
      uid: clientId,
      actid: clientId,
    })}`;

    try {
      // Fetch Order Book
      const orderBookRes = await axios.post(
        "https://piconnect.flattrade.in/PiConnectAPI/OrderBook",
        orderBookPayload,
        {
          timeout: 10000,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      // Fetch Trade Book
      const tradeBookRes = await axios.post(
        "https://piconnect.flattrade.in/PiConnectAPI/TradeBook",
        tradeBookPayload,
        {
          timeout: 10000,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      res.json({
        orderBook: orderBookRes.data,
        tradeBook: tradeBookRes.data,
      });
    } catch (error) {
      console.error("Error fetching Flattrade orders and trades", { code: error.code, status: error.response?.status });
      res.status(502).json({ message: "Error fetching Flattrade orders and trades" });
    }
  });

  // ===> Get Flattrade Option Greek
  router.post("/getOptionGreek", async (req, res) => {
    const { usersession: jKey } = getSession(req);
    const { jData } = req.body;

    if (!jKey) {
      return res
        .status(400)
        .json({ message: "Token is missing. Please generate a token first." });
    }

    const payload = `jKey=${jKey}&jData=${jData}`;

    try {
      const response = await axios.post(
        "https://piconnect.flattrade.in/PiConnectAPI/GetOptionGreek",
        payload,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      res.json(response.data);
    } catch (error) {
      console.error("Error getting Flattrade option Greek", { code: error.code, status: error.response?.status });
      res.status(502).json({ message: "Error getting Flattrade option Greek" });
    }
  });

  //===> TRADING API CALLS <===

  // ===> Place Flattrade Order
  router.post("/placeOrder", requireTradingEnabled, requireServerManagedTrading, async (req, res) => {
    const { usersession: jKey } = getSession(req);

    if (!jKey) {
      return res
        .status(400)
        .json({ message: "Token is missing. Please generate a token first." });
    }

    const jData = typeof req.body === "string" ? qs.parse(req.body) : req.body;
    if (!jData || typeof jData !== "object" || Array.isArray(jData)) {
      return res.status(400).json({ message: "Invalid order payload" });
    }

    if (restrictedTrading) {
      if (Object.keys(jData).some((field) => !serverManagedOrderFields.has(field))) {
        return res.status(400).json({ message: "Unsupported server-managed order fields" });
      }
      if (!["MKT", "LMT"].includes(jData.prctyp)) {
        return res.status(400).json({ message: "Unsupported server-managed order type" });
      }
      if (jData.exch !== "NFO") {
        return res.status(403).json({ message: "Server-managed orders are limited to NSE derivatives" });
      }
      if (
        typeof jData.tsym !== "string" || !jData.tsym ||
        !["B", "S"].includes(jData.trantype) ||
        !["I", "M"].includes(jData.prd) ||
        jData.ret !== "DAY" ||
        (jData.ordersource !== undefined && jData.ordersource !== "API") ||
        !/^\d+(?:\.\d+)?$/.test(String(jData.prc)) ||
        !Number.isFinite(Number(jData.prc)) ||
        (jData.prctyp === "LMT" && Number(jData.prc) <= 0)
      ) {
        return res.status(400).json({ message: "Invalid server-managed order parameters" });
      }
      const quantity = Number(jData.qty);
      if (!/^\d+$/.test(String(jData.qty)) || !Number.isSafeInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ message: "Order quantity must be a positive whole number" });
      }

      let lotSize;
      try {
        lotSize = await resolveNfoLotSize(jData.tsym);
      } catch (error) {
        console.error("Unable to verify Flattrade NFO lot size", { code: error.code });
        return res.status(503).json({ message: "Unable to verify contract lot size; order was not sent" });
      }
      if (!lotSize) {
        return res.status(400).json({ message: "Unknown NSE derivatives contract; order was not sent" });
      }
      if (quantity > lotSize) {
        return res.status(400).json({ message: "Server-managed orders are limited to one contract lot" });
      }

      const currentSession = getSession(req);
      if (!currentSession.usersession || currentSession.usersession !== jKey) {
        return res.status(401).json({ message: "Broker session changed; order was not sent" });
      }
      jData.uid = currentSession.userid;
      jData.actid = currentSession.userid;
    }

    if (restrictedTrading && (
      typeof jKey !== "string" || /[&\r\n]/.test(jKey) ||
      typeof jData.uid !== "string" || !jData.uid || /[&\r\n]/.test(jData.uid)
    )) {
      return res.status(503).json({ message: "Invalid broker session; order was not sent" });
    }
    const brokerOrder = restrictedTrading
      ? { ...jData, tsym: encodeURIComponent(jData.tsym).replace(/%20/g, "+").replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) }
      : jData;
    const payload = restrictedTrading
      ? `jData=${JSON.stringify(brokerOrder)}&jKey=${jKey}`
      : `jKey=${jKey}&jData=${JSON.stringify(jData)}`;

    try {
      const response = await axios.post(
        "https://piconnect.flattrade.in/PiConnectAPI/PlaceOrder",
        payload,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      res.json(response.data);
    } catch (error) {
      const brokerResponse = error.response?.data;
      const brokerMessage = brokerResponse?.stat === "Not_Ok" &&
        typeof brokerResponse.emsg === "string" && brokerResponse.emsg.trim()
        ? brokerResponse.emsg.split(jKey).join("[redacted]").slice(0, 500)
        : null;
      const rejected = error.response?.status >= 400 && error.response.status < 500 && brokerMessage;
      console.error("Error placing Flattrade order", { code: error.code, status: error.response?.status });
      res.status(502).json({
        message: rejected
          ? `Flattrade rejected the order: ${brokerMessage}`
          : "Order status is uncertain. Verify orders with Flattrade before retrying.",
      });
    }
  });

  // ===> Cancel Flattrade Order
  router.post("/cancelOrder", requireTradingEnabled, requireServerManagedTrading, async (req, res) => {
    const { norenordno } = req.body;
    const session = getSession(req);
    const uid = serverManagedAccount ? session.userid : req.body.uid;
    const jKey = session.usersession;

    if (!jKey) {
      return res
        .status(400)
        .json({ message: "Token is missing. Please generate a token first." });
    }

    const jData = JSON.stringify({ norenordno, uid });
    const payload = `jKey=${jKey}&jData=${jData}`;

    try {
      const response = await axios.post(
        "https://piconnect.flattrade.in/PiConnectAPI/CancelOrder",
        payload,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      res.json(response.data);
    } catch (error) {
      res.status(500).json({
        message: "Error cancelling Flattrade order",
        error: error.message,
      });
      console.error("Error cancelling Flattrade order:", error.message);
    }
  });

  return router;
};
