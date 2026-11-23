const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const axios = require("axios");
const flattradeRoutes = require("../routes/flattrade");
const shoonyaRoutes = require("../routes/shoonya");

const internalToken = "a".repeat(32);
const credentials = {
  flattrade: { usersession: "fake-session", userid: "fake-user" },
  shoonya: { usersession: "fake-session", userid: "fake-user" },
};
const routers = {
  flattrade: flattradeRoutes(credentials, internalToken),
  shoonya: shoonyaRoutes(credentials, internalToken),
};

function dispatch(router, method, url, query = {}, headers = {}, body = { norenordno: "mock-order", uid: "mock-user" }) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      headers: { authorization: "Bearer mock-token", ...headers },
      query,
      body,
    };
    const res = {
      statusCode: 200,
      headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(name, value) {
        this.headers[name] = value;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body, headers: this.headers });
      },
    };
    router.handle(req, res, (error) => {
      if (error) reject(error);
      else reject(new Error(`No route handled ${method} ${url}`));
    });
  });
}

test("production uses a server-managed Flattrade session and blocks browser credentials and trading", async (t) => {
  const originalEnv = { ...process.env };
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
    for (const key of ["NODE_ENV", "TRADING_ENABLED", "FLATTRADE_API_KEY", "FLATTRADE_API_SECRET", "FLATTRADE_CLIENT_ID"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  Object.assign(process.env, {
    NODE_ENV: "production",
    TRADING_ENABLED: "true",
    FLATTRADE_API_KEY: "fake-key",
    FLATTRADE_API_SECRET: "fake-secret",
    FLATTRADE_CLIENT_ID: "server-user",
  });
  const sessions = { flattrade: { usersession: "", userid: "" } };
  let restarts = 0;
  const router = flattradeRoutes(sessions, internalToken, async () => { restarts++; });
  const calls = [];
  axios.post = async (url, body) => {
    calls.push({ url, body });
    return url.includes("/apitoken")
      ? { data: { token: "server-session", status: "Ok", client: "server-user" } }
      : { data: { stat: "Ok" } };
  };

  const account = await dispatch(router, "GET", "/account");
  assert.deepEqual(account.body, { configured: true, clientId: "server-user", hasSession: false });
  const invalid = await dispatch(router, "POST", "/generateToken", {}, {}, { request_code: "" });
  assert.equal(invalid.status, 400);
  const login = await dispatch(router, "POST", "/generateToken", {}, {}, { request_code: "fake-code" });
  assert.deepEqual(login.body, { connected: true });
  assert.deepEqual(sessions.flattrade, { usersession: "server-session", userid: "server-user" });
  assert.equal(restarts, 1);
  assert.equal(calls[0].body.api_key, "fake-key");
  assert.equal(calls[0].body.request_code, "fake-code");
  assert.equal(calls[0].body.api_secret, createHash("sha256").update("fake-keyfake-codefake-secret").digest("hex"));

  const denied = await dispatch(router, "POST", "/setCredentials");
  assert.equal(denied.status, 403);
  const positions = await dispatch(router, "GET", "/positions", {
    FLATTRADE_API_TOKEN: "injected-token",
    FLATTRADE_CLIENT_ID: "injected-user",
  });
  assert.equal(positions.status, 200);
  assert.equal(calls[1].url, "https://piconnect.flattrade.in/PiConnectAPI/PositionBook");
  assert.match(calls[1].body, /server-session/);
  assert.match(calls[1].body, /server-user/);
  assert.doesNotMatch(calls[1].body, /injected/);
  const order = await dispatch(router, "POST", "/placeOrder");
  assert.equal(order.status, 403);
  assert.equal(calls.length, 2);

  axios.post = async () => ({ data: { token: "other-session", stat: "Ok", client: "other-user" } });
  const wrongAccount = await dispatch(router, "POST", "/generateToken", {}, {}, { request_code: "fake-code" });
  assert.equal(wrongAccount.status, 502);
  assert.deepEqual(sessions.flattrade, { usersession: "", userid: "" });

  let finishExchange;
  axios.post = () => new Promise((resolve) => { finishExchange = resolve; });
  const firstLogin = dispatch(router, "POST", "/generateToken", {}, {}, { request_code: "first" });
  const duplicate = await dispatch(router, "POST", "/generateToken", {}, {}, { request_code: "second" });
  assert.equal(duplicate.status, 409);
  finishExchange({ data: { token: "new-session", stat: "Ok", client: "server-user" } });
  assert.equal((await firstLogin).status, 200);
});

test("broker credential endpoints require the internal token", async () => {
  for (const router of Object.values(routers)) {
    const denied = await dispatch(router, "GET", "/websocketData");
    assert.equal(denied.status, 403);
    assert.equal(denied.body.usersession, undefined);
    const allowed = await dispatch(router, "GET", "/websocketData", {}, {
      "x-steadfast-internal-token": internalToken,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.usersession, "fake-session");
    assert.equal(allowed.headers["Cache-Control"], "no-store");
  }
});

test("disabled trading blocks order routes and arbitrary broker proxies without outbound requests", async (t) => {
  const originalFlag = process.env.TRADING_ENABLED;
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
    if (originalFlag === undefined) delete process.env.TRADING_ENABLED;
    else process.env.TRADING_ENABLED = originalFlag;
  });
  delete process.env.TRADING_ENABLED;
  axios.post = () => {
    throw new Error("Unexpected broker request");
  };

  for (const [broker, router] of Object.entries(routers)) {
    for (const url of ["/placeOrder", "/cancelOrder", `/${broker}Api/any/path`]) {
      const response = await dispatch(router, "POST", url);
      assert.equal(response.status, 403, `${broker} ${url}`);
      assert.match(response.body.message, /Trading is disabled/);
    }
  }
  const readOnly = await dispatch(routers.flattrade, "GET", "/test");
  assert.equal(readOnly.status, 200);
});

test("enabled order routes forward only to a mocked broker", async (t) => {
  const originalFlag = process.env.TRADING_ENABLED;
  const originalPost = axios.post;
  const calls = [];
  t.after(() => {
    axios.post = originalPost;
    if (originalFlag === undefined) delete process.env.TRADING_ENABLED;
    else process.env.TRADING_ENABLED = originalFlag;
  });
  process.env.TRADING_ENABLED = "true";
  axios.post = async (url) => {
    calls.push(url);
    return { data: { stat: "Ok" } };
  };

  for (const [broker, router] of Object.entries(routers)) {
    const query = { [`${broker.toUpperCase()}_API_TOKEN`]: "mock-token" };
    for (const url of ["/placeOrder", "/cancelOrder"]) {
      const response = await dispatch(router, "POST", url, query);
      assert.equal(response.status, 200, `${broker} ${url}`);
      assert.deepEqual(response.body, { stat: "Ok" });
    }
  }
  assert.equal(calls.length, 4);
});
