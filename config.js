const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const profile = (process.env.PROFILE || process.env.profile || "prod").trim().toLowerCase();
if (!["dev", "prod"].includes(profile)) {
  throw new Error("profile must be dev or prod");
}

const environment = profile === "dev" ? "development" : "production";
process.env.NODE_ENV = environment;

function readPort(name, defaultPort) {
  const port = Number(process.env[name] || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

const corsOrigin = process.env.CORS_ORIGIN ||
  (environment === "development" ? "http://localhost:5173" : "");

if (!corsOrigin) {
  throw new Error("CORS_ORIGIN is required in production");
}

const internalToken = process.env.WEBSOCKET_INTERNAL_TOKEN || "";
if (environment === "production" && !internalToken) {
  throw new Error("WEBSOCKET_INTERNAL_TOKEN is required in production");
}
if (internalToken && !/^[A-Za-z0-9_-]{32,256}$/.test(internalToken)) {
  throw new Error("WEBSOCKET_INTERNAL_TOKEN must be 32-256 URL-safe characters");
}

let parsedOrigin;
try {
  parsedOrigin = new URL(corsOrigin);
} catch {
  throw new Error("CORS_ORIGIN must be an absolute origin");
}
if (
  parsedOrigin.origin !== corsOrigin ||
  !["http:", "https:"].includes(parsedOrigin.protocol) ||
  (environment === "production" && parsedOrigin.protocol !== "https:")
) {
  throw new Error("CORS_ORIGIN must be an HTTPS origin in production");
}

const host = process.env.API_HOST || "127.0.0.1";
if (environment === "production" && !["127.0.0.1", "::1", "localhost"].includes(host)) {
  throw new Error("API_HOST must be loopback in production");
}

module.exports = {
  environment,
  internalToken,
  port: readPort("PORT", 3000),
  host,
  brokerPorts: {
    flattrade: readPort("FLATTRADE_WS_PORT", 8765),
    shoonya: readPort("SHOONYA_WS_PORT", 8766),
  },
  corsHeaders: {
    origin: corsOrigin,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  },
};
