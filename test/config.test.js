const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");

const configPath = path.join(__dirname, "../config.js");

function readConfig(env) {
  return spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(configPath)})))`], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", PORT: "", API_HOST: "", CORS_ORIGIN: "", FLATTRADE_WS_PORT: "", SHOONYA_WS_PORT: "", WEBSOCKET_INTERNAL_TOKEN: "a".repeat(32), ...env },
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
});

test("invalid environments and ports are rejected", () => {
  const invalidEnvironment = readConfig({ NODE_ENV: "staging" });
  assert.notEqual(invalidEnvironment.status, 0);
  assert.match(invalidEnvironment.stderr, /NODE_ENV must be/);
  const missingEnvironment = readConfig({ NODE_ENV: "" });
  assert.notEqual(missingEnvironment.status, 0);
  assert.match(missingEnvironment.stderr, /NODE_ENV must be/);
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
