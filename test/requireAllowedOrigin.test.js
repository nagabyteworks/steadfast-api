const assert = require("node:assert/strict");
const { test } = require("node:test");
const requireAllowedOrigin = require("../middleware/requireAllowedOrigin");

test("production mutations require the configured browser origin", () => {
  const middleware = requireAllowedOrigin("https://trade.example.com");
  for (const [method, origin, allowed] of [
    ["POST", "https://trade.example.com", true],
    ["POST", "https://other.example.com", false],
    ["POST", undefined, false],
    ["GET", undefined, true],
    ["OPTIONS", undefined, true],
  ]) {
    let status;
    let continued = false;
    middleware(
      { method, headers: { origin } },
      {
        status(code) { status = code; return this; },
        json() {},
      },
      () => { continued = true; }
    );
    assert.equal(continued, allowed, `${method} ${origin}`);
    if (!allowed) assert.equal(status, 403);
  }
});
