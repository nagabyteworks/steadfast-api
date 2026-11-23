const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const config = require("./config");
const net = require("net");

const flattradeRoutes = require("./routes/flattrade");
const shoonyaRoutes = require("./routes/shoonya");
const virtualRoutes = require("./routes/virtual");
const fileUpdates = require('./routes/fileUpdates');
const requireAllowedOrigin = require("./middleware/requireAllowedOrigin");

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

let selectedBroker = "";
const pythonServerPort = 5000; // Choose an available port

app.set("case sensitive routing", false);
app.use("/flattrade", flattradeRoutes(storedCredentials, config.internalToken, async () => {
  if (config.environment === "production" || selectedBroker === "flattrade") {
    await sendToPythonServer({ action: "set_broker", broker: "flattrade", restart: true });
  }
}));
if (config.environment === "production") {
  app.use("/shoonya", (req, res) => {
    res.status(503).json({ message: "Shoonya is unavailable in production until server-managed sessions are implemented" });
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

const BROKER_PORTS = config.brokerPorts;

function sendToPythonServer(message) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let response = "";
    client.setTimeout(5000, () => client.destroy(new Error("Broker selector timed out")));
    client.connect(pythonServerPort, "127.0.0.1", () => {
      client.write(JSON.stringify(message));
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
  if (broker === "flattrade" || (config.environment !== "production" && broker === "shoonya")) {
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

app.listen(config.port, config.host, () => {
  console.log(`Server is running on http://${config.host}:${config.port}`);
});

// Code To Download Updated Instrument files everyday after 7am IST(1:30am UTC). 
(async () => {
    // Flattrade
    await fileUpdates.checkAndUpdateFiles('flattrade');
    // Shoonya
    await fileUpdates.checkAndUpdateFiles('shoonya');
})();

module.exports = app;
