const assert = require("node:assert/strict");
const { test } = require("node:test");
const requireInternalToken = require("../middleware/requireInternalToken");

test("internal access requires the configured token", () => {
  const secret = "a".repeat(32);
  const middleware = requireInternalToken(secret);
  for (const [provided, allowed] of [[undefined, false], ["wrong", false], ["b".repeat(32), false], [secret, true]]) {
    let status;
    let continued = false;
    middleware(
      { headers: { "x-steadfast-internal-token": provided } },
      {
        status(code) { status = code; return this; },
        json() {},
      },
      () => { continued = true; }
    );
    assert.equal(continued, allowed);
    if (!allowed) assert.equal(status, 403);
  }
});
