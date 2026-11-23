const assert = require("node:assert/strict");
const { test } = require("node:test");
const requireTradingEnabled = require("../middleware/requireTradingEnabled");

test("trading requires the exact value true", (t) => {
  const original = process.env.TRADING_ENABLED;
  t.after(() => {
    if (original === undefined) {
      delete process.env.TRADING_ENABLED;
    } else {
      process.env.TRADING_ENABLED = original;
    }
  });

  for (const value of [undefined, "", "false", "TRUE", "1", "true"]) {
    if (value === undefined) {
      delete process.env.TRADING_ENABLED;
    } else {
      process.env.TRADING_ENABLED = value;
    }
    let status;
    let body;
    let continued = false;
    const response = {
      status(code) {
        status = code;
        return this;
      },
      json(data) {
        body = data;
      },
    };

    requireTradingEnabled({}, response, () => { continued = true; });
    if (value === "true") {
      assert.equal(continued, true);
    } else {
      assert.equal(continued, false);
      assert.equal(status, 403);
      assert.match(body.message, /Trading is disabled/);
    }
  }
});
