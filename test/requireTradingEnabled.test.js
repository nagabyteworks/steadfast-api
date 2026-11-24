const assert = require("node:assert/strict");
const { test } = require("node:test");
const requireTradingEnabled = require("../middleware/requireTradingEnabled");

test("trading requires the exact value true in production and development", (t) => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    tradingEnabled: process.env.TRADING_ENABLED,
  };
  t.after(() => {
    if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original.nodeEnv;
    if (original.tradingEnabled === undefined) delete process.env.TRADING_ENABLED;
    else process.env.TRADING_ENABLED = original.tradingEnabled;
  });

  for (const environment of ["development", "production"]) {
    process.env.NODE_ENV = environment;
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
        assert.equal(continued, true, `${environment}: ${value}`);
      } else {
        assert.equal(continued, false, `${environment}: ${value}`);
        assert.equal(status, 403);
        assert.match(body.message, /Trading is disabled/);
      }
    }
  }
});
