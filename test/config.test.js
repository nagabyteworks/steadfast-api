const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");

const configPath = path.join(__dirname, "../config.js");

function readConfig(env) {
  const childEnv = {
    ...process.env,
    profile: "",
    PROFILE: "",
    NODE_ENV: "production",
    PORT: "",
    API_HOST: "",
    CORS_ORIGIN: "",
    FLATTRADE_WS_PORT: "",
    SHOONYA_WS_PORT: "",
    WEBSOCKET_INTERNAL_TOKEN: "a".repeat(32),
    ...env,
  };
  return spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(configPath)})))`], {
    encoding: "utf8",
    env: childEnv,
  });
}

test("production requires an explicit frontend origin", () => {
  const result = readConfig({});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CORS_ORIGIN is required/);
});

test("production listens on loopback and uses configured origin and port", () => {
  const result = readConfig({ CORS_ORIGIN: "https://trade.example.com", PORT: "3001", FLATTRADE_WS_PORT: "9001" });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3001);
  assert.equal(config.brokerPorts.flattrade, 9001);
  assert.equal(config.corsHeaders.origin, "https://trade.example.com");
  assert.equal(config.environment, "production");
});

test("development profile enables local defaults and no profile defaults to production", () => {
  const development = readConfig({ profile: "dev" });
  assert.equal(development.status, 0, development.stderr);
  const config = JSON.parse(development.stdout);
  assert.equal(config.environment, "development");
  assert.equal(config.corsHeaders.origin, "http://localhost:5173");

  const production = readConfig({ CORS_ORIGIN: "https://trade.example.com" });
  assert.equal(production.status, 0, production.stderr);
  assert.equal(JSON.parse(production.stdout).environment, "production");

  const explicitProduction = readConfig({
    profile: "dev",
    PROFILE: "prod",
    CORS_ORIGIN: "https://trade.example.com",
  });
  assert.equal(explicitProduction.status, 0, explicitProduction.stderr);
  assert.equal(JSON.parse(explicitProduction.stdout).environment, "production");
});

test("invalid profiles and ports are rejected", () => {
  const invalidProfile = readConfig({ profile: "staging" });
  assert.notEqual(invalidProfile.status, 0);
  assert.match(invalidProfile.stderr, /profile must be dev or prod/);
  const invalidPort = readConfig({ CORS_ORIGIN: "https://trade.example.com", PORT: "invalid" });
  assert.notEqual(invalidPort.status, 0);
  assert.match(invalidPort.stderr, /PORT must be/);
  const invalidBrokerPort = readConfig({ CORS_ORIGIN: "https://trade.example.com", FLATTRADE_WS_PORT: "65536" });
  assert.notEqual(invalidBrokerPort.status, 0);
  assert.match(invalidBrokerPort.stderr, /FLATTRADE_WS_PORT must be/);
  const publicHost = readConfig({ CORS_ORIGIN: "https://trade.example.com", API_HOST: "0.0.0.0" });
  assert.notEqual(publicHost.status, 0);
  assert.match(publicHost.stderr, /API_HOST must be loopback/);
  for (const origin of ["http://trade.example.com", "https://trade.example.com/path", "not-a-url"]) {
    assert.notEqual(readConfig({ CORS_ORIGIN: origin }).status, 0);
  }
  for (const token of ["", "short", " ".repeat(32), "a".repeat(257)]) {
    const invalidToken = readConfig({ CORS_ORIGIN: "https://trade.example.com", WEBSOCKET_INTERNAL_TOKEN: token });
    assert.notEqual(invalidToken.status, 0);
    assert.match(invalidToken.stderr, /WEBSOCKET_INTERNAL_TOKEN/);
  }
});
