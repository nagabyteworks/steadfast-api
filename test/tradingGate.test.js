const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const express = require("express");
const axios = require("axios");
const flattradeRoutes = require("../routes/flattrade");
const shoonyaRoutes = require("../routes/shoonya");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/flattrade", flattradeRoutes({}));
app.use("/shoonya", shoonyaRoutes({}));

let server;
let baseUrl;
let calls;
const originalPost = axios.post;
const originalTradingEnabled = process.env.TRADING_ENABLED;

before(async () => {
  calls = [];
  axios.post = async (...args) => {
    calls.push(args);
    return { data: { stat: "Ok" } };
  };
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  axios.post = originalPost;
  if (originalTradingEnabled === undefined) {
    delete process.env.TRADING_ENABLED;
  } else {
    process.env.TRADING_ENABLED = originalTradingEnabled;
  }
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("disabled trading blocks both brokers' order routes and proxy bypasses", async () => {
  for (const value of [undefined, "false", "TRUE", "1"]) {
    if (value === undefined) {
      delete process.env.TRADING_ENABLED;
    } else {
      process.env.TRADING_ENABLED = value;
    }

    for (const path of [
      "/flattrade/placeOrder",
      "/flattrade/cancelOrder",
      "/shoonya/placeOrder",
      "/shoonya/cancelOrder",
      "/flattrade/flattradeApi/trade/apitoken",
      "/shoonya/shoonyaApi/NorenWClientTP/PlaceOrder",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { method: "POST" });
      assert.equal(response.status, 403, `${value}: ${path}`);
      assert.match((await response.json()).message, /Trading is disabled/);
    }
  }

  assert.equal(calls.length, 0);
  const response = await fetch(`${baseUrl}/flattrade/test`);
  assert.equal(response.status, 200);
});

test("enabled Flattrade routes require server credentials while Shoonya uses the legacy path", async () => {
  process.env.TRADING_ENABLED = "true";
  calls.length = 0;

  for (const broker of ["flattrade", "shoonya"]) {
    const tokenQuery = broker === "flattrade"
      ? "FLATTRADE_API_TOKEN=test-token"
      : "SHOONYA_API_TOKEN=test-token";
    for (const path of ["placeOrder", `cancelOrder?${tokenQuery}`]) {
      const response = await fetch(`${baseUrl}/${broker}/${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ norenordno: "test-order", uid: "test-user" }),
      });
      if (broker === "flattrade") {
        assert.equal(response.status, 403, `${broker}/${path}`);
        assert.match((await response.json()).message, /requires credentials configured/);
        continue;
      }
      assert.equal(response.status, 200, `${broker}/${path}`);
      assert.deepEqual(await response.json(), { stat: "Ok" });
    }
  }

  assert.equal(calls.length, 2);
});
