const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const axios = require("axios");
const flattradeRoutes = require("../routes/flattrade");
const shoonyaRoutes = require("../routes/shoonya");
const { createSessionStore } = require("../sessionStore");

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
    TRADING_ENABLED: "false",
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
  await assert.rejects(dispatch(router, "GET", "/test"), /No route handled/);
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

test("development server-managed Flattrade uses .env credentials and live order limits", async (t) => {
  const originalEnv = { ...process.env };
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
    for (const key of ["TRADING_ENABLED", "FLATTRADE_API_KEY", "FLATTRADE_API_SECRET", "FLATTRADE_CLIENT_ID"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  Object.assign(process.env, {
    TRADING_ENABLED: "true",
    FLATTRADE_API_KEY: "local-key",
    FLATTRADE_API_SECRET: "local-secret",
    FLATTRADE_CLIENT_ID: "local-user",
  });
  const sessions = { flattrade: { usersession: "", userid: "" } };
  const calls = [];
  const router = flattradeRoutes(
    sessions,
    internalToken,
    async () => {},
    async () => 50,
    null,
    "development",
    true
  );
  axios.post = async (url, body) => {
    calls.push({ url, body });
    return url.includes("/apitoken")
      ? { data: { token: "local-session", status: "Ok", client: "local-user" } }
      : { data: { stat: "Ok", norenordno: "mock-order" } };
  };

  const account = await dispatch(router, "GET", "/account");
  assert.deepEqual(account.body, { configured: true, clientId: "local-user", hasSession: false });
  const login = await dispatch(router, "POST", "/generateToken", {}, {}, { request_code: "local-code" });
  assert.equal(login.status, 200);
  assert.deepEqual(sessions.flattrade, { usersession: "local-session", userid: "local-user" });
  assert.equal(calls[0].body.api_key, "local-key");

  const deniedCredentials = await dispatch(router, "POST", "/setCredentials");
  assert.equal(deniedCredentials.status, 403);
  const orderData = {
    uid: "attacker-user",
    actid: "attacker-user",
    exch: "NFO",
    tsym: "TEST CE",
    qty: "50",
    prc: "0",
    prd: "M",
    trantype: "B",
    prctyp: "MKT",
    ret: "DAY",
    ordersource: "API",
  };
  const order = await dispatch(router, "POST", "/placeOrder", {}, {}, orderData);
  assert.equal(order.status, 200);
  assert.match(calls[1].body, /"uid":"local-user"/);
  assert.doesNotMatch(calls[1].body, /attacker-user/);

  const tooLarge = await dispatch(router, "POST", "/placeOrder", {}, {}, { ...orderData, qty: "51" });
  assert.equal(tooLarge.status, 400);
  assert.equal(calls.length, 2);
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

test("enabled legacy order routes remain available only for Shoonya", async (t) => {
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

  for (const url of ["/placeOrder", "/cancelOrder"]) {
    const response = await dispatch(routers.shoonya, "POST", url, {
      SHOONYA_API_TOKEN: "mock-token",
    });
    assert.equal(response.status, 200, `Shoonya ${url}`);
    assert.deepEqual(response.body, { stat: "Ok" });
  }
  for (const url of ["/placeOrder", "/cancelOrder"]) {
    const response = await dispatch(routers.flattrade, "POST", url, {
      FLATTRADE_API_TOKEN: "mock-token",
    });
    assert.equal(response.status, 403, `Flattrade ${url}`);
    assert.match(response.body.message, /requires credentials configured/);
  }
  assert.equal(calls.length, 2);
});

test("production Flattrade accepts only NFO orders no larger than one lot", async (t) => {
  const originalEnv = { ...process.env };
  const originalPost = axios.post;
  t.after(() => {
    axios.post = originalPost;
    for (const key of ["NODE_ENV", "TRADING_ENABLED"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  process.env.NODE_ENV = "production";
  process.env.TRADING_ENABLED = "true";

  const sessions = { flattrade: { usersession: "server-session", userid: "server-user" } };
  const router = flattradeRoutes(
    sessions,
    internalToken,
    undefined,
    async (tradingSymbol) => ["NIFTY-TEST-CE", "TEST&+ CE"].includes(tradingSymbol) ? 50 : null
  );
  const calls = [];
  axios.post = async (url, body) => {
    calls.push({ url, body });
    return { data: { stat: "Ok", norenordno: "mock-order" } };
  };

  const baseOrder = {
    exch: "NFO", tsym: "NIFTY-TEST-CE", qty: "50", uid: "injected-user",
    prctyp: "MKT", prc: "0", trantype: "B", prd: "M", ret: "DAY",
  };
  const tooLarge = await dispatch(router, "POST", "/placeOrder", {}, {}, { ...baseOrder, qty: "100" });
  assert.equal(tooLarge.status, 400);
  assert.equal(calls.length, 0);

  const wrongExchange = await dispatch(router, "POST", "/placeOrder", {}, {}, { ...baseOrder, exch: "BFO" });
  assert.equal(wrongExchange.status, 403);
  assert.equal(calls.length, 0);

  const unknownContract = await dispatch(router, "POST", "/placeOrder", {}, {}, { ...baseOrder, tsym: "UNKNOWN" });
  assert.equal(unknownContract.status, 400);
  assert.equal(calls.length, 0);

  for (const extraFields of [
    { tsym2: "OTHER", qty2: "100" },
    { tsym3: "OTHER", qty3: "100" },
    { prctyp: "2L" },
    { ordersource: "API&jData=other" },
  ]) {
    const rejected = await dispatch(router, "POST", "/placeOrder", {}, {}, { ...baseOrder, ...extraFields });
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 0);
  }

  const accepted = await dispatch(router, "POST", "/placeOrder", {}, {}, baseOrder);
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /server-session/);
  assert.match(calls[0].body, /server-user/);
  assert.doesNotMatch(calls[0].body, /injected-user/);
  const [data, key] = calls[0].body.split("&jKey=");
  assert.equal(key, "server-session");
  assert.deepEqual(JSON.parse(data.slice("jData=".length)), {
    ...baseOrder, uid: "server-user", actid: "server-user",
  });

  const specialSymbol = await dispatch(router, "POST", "/placeOrder", {}, {}, { ...baseOrder, tsym: "TEST&+ CE" });
  assert.equal(specialSymbol.status, 200);
  const [specialData, specialKey] = calls[1].body.split("&jKey=");
  assert.equal(specialKey, "server-session");
  assert.equal(JSON.parse(specialData.slice("jData=".length)).tsym, "TEST%26%2B+CE");

  axios.post = async () => {
    throw {
      response: { status: 400, data: { stat: "Not_Ok", emsg: "Rejected: insufficient funds" } },
    };
  };
  const rejected = await dispatch(router, "POST", "/placeOrder", {}, {}, baseOrder);
  assert.equal(rejected.status, 502);
  assert.equal(rejected.body.message, "Flattrade rejected the order: Rejected: insufficient funds");

  axios.post = async () => {
    throw { response: { status: 400, data: { stat: "Not_Ok", emsg: "Invalid server-session" } } };
  };
  const redacted = await dispatch(router, "POST", "/placeOrder", {}, {}, baseOrder);
  assert.doesNotMatch(redacted.body.message, /server-session/);

  axios.post = async () => { throw new Error("network failure"); };
  const uncertain = await dispatch(router, "POST", "/placeOrder", {}, {}, baseOrder);
  assert.match(uncertain.body.message, /uncertain.*before retrying/i);
});

test("production login persists the session for a recreated router", async (t) => {
  const originalEnv = { ...process.env };
  const originalPost = axios.post;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-route-session-"));
  let store;
  t.after(() => {
    if (store) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    axios.post = originalPost;
    for (const key of ["NODE_ENV", "FLATTRADE_API_KEY", "FLATTRADE_API_SECRET", "FLATTRADE_CLIENT_ID"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  Object.assign(process.env, {
    NODE_ENV: "production",
    FLATTRADE_API_KEY: "fake-key",
    FLATTRADE_API_SECRET: "fake-secret",
    FLATTRADE_CLIENT_ID: "server-user",
  });
  axios.post = async () => ({ data: { status: "Ok", client: "server-user", token: "server-session" } });
  store = createSessionStore(directory, "server-user");
  let router = flattradeRoutes({ flattrade: {} }, internalToken, async () => {}, undefined, store);
  assert.equal((await dispatch(router, "POST", "/generateToken", {}, {}, { request_code: "fake-code" })).status, 200);
  store.close();
  store = createSessionStore(directory, "server-user");
  router = flattradeRoutes({ flattrade: {} }, internalToken, async () => {}, undefined, store);
  assert.equal((await dispatch(router, "GET", "/account")).body.hasSession, true);
  const credentials = await dispatch(router, "GET", "/websocketData", {}, { "x-steadfast-internal-token": internalToken });
  assert.deepEqual(credentials.body, { usersession: "server-session", userid: "server-user" });
});
