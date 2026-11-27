const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const config = require("./config");
const net = require("net");
const fs = require("fs");
const path = require("path");

const flattradeRoutes = require("./routes/flattrade");
const shoonyaRoutes = require("./routes/shoonya");
const virtualRoutes = require("./routes/virtual");
const fileUpdates = require('./routes/fileUpdates');
const requireAllowedOrigin = require("./middleware/requireAllowedOrigin");
const { createSessionStore } = require("./sessionStore");
const { createRiskStore } = require("./riskStore");
const { createLotLedger } = require("./lotLedger");
const { createReconciliationService } = require("./reconciliationService");

const app = express();

if (!config.internalToken) {
  console.warn("WebSocket credential access is unprotected in development; keep the API private.");
}
app.use(cors(config.corsHeaders));
if (config.environment === "production") {
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(requireAllowedOrigin(config.corsHeaders.origin));
}

app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

let storedCredentials = {
  flattrade: { usersession: "", userid: "" },
  shoonya: { usersession: "", userid: "" },
};
const stateDirectory = process.env.STATE_DIRECTORY ||
  (config.environment === "production" ? "/var/lib/steadfast-api" : path.join(__dirname, "data"));
if (config.serverManagedAccount) fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
const sessionStore = config.serverManagedAccount
  ? createSessionStore(stateDirectory, process.env.FLATTRADE_CLIENT_ID, async () => {
      if (riskStore) riskStore.suspendAll(process.env.FLATTRADE_CLIENT_ID || "",
        "Position needs reconciliation: Flattrade session expired");
      await sendToPythonServer({ action: "set_broker", broker: "flattrade", restart: true });
    })
  : null;

const riskStore = config.serverManagedAccount ? createRiskStore(stateDirectory) : null;
const lotLedger = config.serverManagedAccount ? createLotLedger(stateDirectory) : null;
if (riskStore) {
  riskStore.suspendOnStartup(process.env.FLATTRADE_CLIENT_ID || "");
  console.log("Server-side stop-loss/target: LIVE");
}
const reconciliationService = riskStore ? createReconciliationService({
  store: riskStore,
  getSession: () => sessionStore.get(),
  account: process.env.FLATTRADE_CLIENT_ID || "",
}) : null;

// Restore the persisted Flattrade token so a restart does not require a new login.
function restoreStoredSession() {
  if (!sessionStore) return null;
  try {
    const session = sessionStore.get();
    if (session.usersession) {
      storedCredentials.flattrade = { usersession: session.usersession, userid: session.userid };
      console.log("Restored Flattrade session from the database");
      return session;
    }
    console.log("No valid Flattrade session found in the database; login required");
  } catch (error) {
    console.error("Unable to read the stored Flattrade session", { code: error.code });
  }
  return null;
}
const restoredSession = restoreStoredSession();

let selectedBroker = "";
const pythonServerPort = 5000; // Choose an available port

app.set("case sensitive routing", false);
app.use("/flattrade", flattradeRoutes(storedCredentials, config.internalToken, async () => {
  if (config.serverManagedAccount || selectedBroker === "flattrade") {
    await sendToPythonServer({ action: "set_broker", broker: "flattrade", restart: true });
  }
}, undefined, sessionStore, config.environment, config.serverManagedAccount, riskStore, reconciliationService, lotLedger));
if (config.serverManagedAccount) {
  app.use("/shoonya", (req, res) => {
    res.status(503).json({ message: "Shoonya is unavailable in server-managed mode" });
  });
} else {
  app.use("/shoonya", shoonyaRoutes(storedCredentials, config.internalToken));
}
if (config.environment === "production") {
  app.use("/virtual", (req, res) => {
    res.status(403).json({ message: "Virtual trading is unavailable in production" });
  });
} else {
  app.use("/virtual", virtualRoutes());
}

app.get("/", (req, res) => res.send("Welcome to the Steadfast API"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));
app.get("/health/reconciliation", (req, res) => res
  .set("Cache-Control", "no-store")
  .json(reconciliationService?.getStatus() ?? {
    enabled: false, running: false, currentStatus: "disabled", unresolvedCount: 0,
  }));

const BROKER_PORTS = config.brokerPorts;

function sendToPythonServer(message) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let response = "";
    client.setTimeout(5000, () => client.destroy(new Error("Broker selector timed out")));
    client.connect(pythonServerPort, "127.0.0.1", () => {
      client.write(`${JSON.stringify({ ...message, token: config.internalToken })}\n`);
    });

    client.on("data", (data) => {
      response += data.toString();
    });

    client.on("end", () => {
      try {
        const result = JSON.parse(response);
        if (result.status !== "success") {
          reject(new Error("Broker selector rejected the request"));
        } else {
          resolve(result);
        }
      } catch {
        reject(new Error("Invalid response from broker selector"));
      }
    });

    client.on("close", () => {
      console.log("Connection closed");
    });

    client.on("error", (err) => {
      console.error("Connection error:", err);
      reject(err);
    });
  });
}

app.post("/set-broker", async (req, res) => {
  const { broker } = req.body;
  if (broker === "flattrade" || (!config.serverManagedAccount && broker === "shoonya")) {
    try {
      // Send the broker selection to the Python server
      await sendToPythonServer({
        action: "set_broker",
        broker,
      });

      selectedBroker = broker;
      const port = BROKER_PORTS[broker];
      res.json({
        message: `Selected broker set to ${selectedBroker}, WebSocket running on port ${port}`,
      });
    } catch (error) {
      console.error("Error sending broker selection:", error);
      res.status(500).json({ message: "Error setting broker" });
    }
  } else {
    res.status(400).json({ message: "Invalid broker selection" });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled request error", { name: err.name });
  res.status(500).json({ message: "An error occurred on the server" });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Server is running on http://${config.host}:${config.port}`);
  if (reconciliationService) reconciliationService.start();
  if (restoredSession) {
    sendToPythonServer({ action: "set_broker", broker: "flattrade", restart: true }).catch((error) => {
      console.error("Unable to restart Flattrade streaming with the restored session:", error.message);
    });
  }
});

let shutdownPromise;
const shutdown = (signal) => {
  if (shutdownPromise) return shutdownPromise;
  console.log(`Received ${signal}; stopping API services`);
  shutdownPromise = (async () => {
    const serverClosed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (reconciliationService) await reconciliationService.stop();
    await serverClosed;
    if (sessionStore) sessionStore.close();
    if (riskStore) riskStore.close();
    console.log("API shutdown completed");
  })().catch((error) => {
    console.error("API shutdown failed", { code: error.code, name: error.name });
    process.exitCode = 1;
  });
  return shutdownPromise;
};
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

// Code To Download Updated Instrument files everyday after 7am IST(1:30am UTC). 
(async () => {
    // Flattrade
    await fileUpdates.checkAndUpdateFiles('flattrade');
    // Shoonya
    await fileUpdates.checkAndUpdateFiles('shoonya');
})();

module.exports = app;
