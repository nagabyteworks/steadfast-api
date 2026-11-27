const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const axios = require("axios");
const { createRiskStore } = require("../riskStore");
const riskRoutes = require("../routes/risk");

const rule = {
  instrument: "NFO|123", side: "long", entry: 150, mode: "static",
  slPrice: 140, slPoints: 10, targetPrice: 170, trailPoints: null, monitor: "server",
};

function dispatch(router, method, url, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, body, headers };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      json(value) { resolve({ status: this.statusCode, body: value }); },
    };
    router.handle(req, res, (error) => reject(error || new Error(`Unhandled ${method} ${url}`)));
  });
}

function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-risk-routes-"));
  const store = createRiskStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const router = riskRoutes({
    store, internalToken: "test-token", getSession: () => ({ usersession: "test", userid: "test" }),
    tradingEnabled: () => true, ...options,
  });
  return { router, store };
}
const internal = { "x-steadfast-internal-token": "test-token" };
const livePosition = { tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
  daybuyqty: "75", daysellqty: "0", cfbuyqty: "0", cfsellqty: "0" };
const liveTrades = [{ tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "1", flid: "1",
  trantype: "B", flqty: "75", flprc: "150", fltm: "26-11-2026 09:25:00" }];
const seed = (store, overrides = {}) => store.saveDefault("test", "M", {
  openingOrderId: "1", openingFillId: "1", openingPrice: 150,
}, { ...rule, tsym: "NIFTYCE", ...overrides }, null);

test("startup suspends persisted rules and rejects triggers from the wrong monitor", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-startup-risk-"));
  let store = createRiskStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  store.save({ ...rule, tsym: "NIFTYCE" });
  store.close();
  store = createRiskStore(directory);
  store.suspendOnStartup("test");
  const router = riskRoutes({ store, internalToken: "test-token",
    getSession: () => ({ usersession: "test", userid: "test" }) });
  let calls = 0;
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  axios.post = async () => { calls++; throw new Error("unexpected broker request"); };
  for (const reason of ["Stop-loss", "Target"]) {
    assert.equal((await dispatch(router, "POST", "/internal/trigger",
      { tsym: "NIFTYCE", reason, ltp: 140, rev: 1 }, internal)).body.handled, false);
    assert.equal((await dispatch(router, "POST", "/trigger",
      { tsym: "NIFTYCE", reason, ltp: 140, rev: 1 })).body.handled, false);
  }
  assert.equal(calls, 0);
  assert.equal(store.get("NIFTYCE").status, "reconciliation_required");
  assert.equal((await dispatch(router, "GET", "/rules")).body.reconciliation.length, 1);
});

test("broker timeout or missing session suspends existing protection before a trigger", async (t) => {
  let session = { usersession: "test", userid: "test" };
  const { router, store } = setup(t, { getSession: () => session });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const config = { stopPoints: 10, targetPoints: null, trailingStop: false,
    targetTrailing: false, trailPoints: null, monitor: "server" };
  store.save({ ...rule, tsym: "NIFTYCE" });
  axios.post = async () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); };
  let result = await dispatch(router, "POST", "/rules/NIFTYCE/default", config);
  assert.equal(result.body.status, "RECONCILIATION_REQUIRED");
  assert.equal(store.get("NIFTYCE").status, "reconciliation_required");
  assert.equal((await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 }, internal)).body.handled, false);
  session = {};
  store.save({ ...rule, tsym: "OTHER" });
  result = await dispatch(router, "POST", "/rules/OTHER/default", config);
  assert.equal(result.status, 503);
  assert.equal(result.body.status, "RECONCILIATION_REQUIRED");
  assert.equal(store.get("OTHER").status, "reconciliation_required");
  assert.equal((await dispatch(router, "GET", "/rules")).body.reconciliation.length, 2);
});

test("a trigger awaiting the broker cannot submit after the rule becomes flagged", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  let release;
  let calls = 0;
  axios.post = async (url) => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { release = resolve; });
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    return { data: [livePosition] };
  };
  const pending = dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Target", ltp: 170, rev: 1 }, internal);
  store.markReconciliationRequired("test", "NIFTYCE", 1, "Position needs reconciliation: changed");
  release({ data: [livePosition] });
  assert.equal((await pending).body.handled, false);
  assert.equal(calls, 3);
});

for (const scenario of [
  { name: "empty trade history", positions: [livePosition], trades: [] },
  { name: "duplicate position records", positions: [livePosition, livePosition], trades: liveTrades },
  { name: "partial exit with missing execution", positions: [{ ...livePosition, netqty: "50", daysellqty: "25" }], trades: liveTrades },
  { name: "reopened symbol with a different opening fill", positions: [livePosition],
    trades: [{ ...liveTrades[0], norenordno: "2", flid: "2", flprc: "200" }] },
]) {
  test(`automatic exit blocks ${scenario.name}`, async (t) => {
    const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
    seed(store);
    const originalPost = axios.post;
    t.after(() => { axios.post = originalPost; });
    const calls = [];
    axios.post = async (url) => {
      calls.push(url);
      return { data: url.endsWith("/TradeBook") ? scenario.trades : scenario.positions };
    };
    const response = await dispatch(router, "POST", "/internal/trigger",
      { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 }, internal);
    assert.equal(response.body.status, "reconciliation_required");
    assert.equal(store.get("NIFTYCE").status, "reconciliation_required");
    assert.equal(calls.some((url) => url.endsWith("/PlaceOrder")), false);
  });
}

test("rule endpoints validate, update, list and delete protection", async (t) => {
  const { router, store } = setup(t);
  assert.equal((await dispatch(router, "PUT", "/rules/NIFTYCE", rule)).status, 409);
  assert.equal((await dispatch(router, "POST", "/rules/NIFTYCE/manual", { stopPoints: -1 })).status, 400);
  assert.equal((await dispatch(router, "PATCH", "/rules/NIFTYCE", { slPrice: 145 })).status, 404);
  store.save({ ...rule, tsym: "NIFTYCE" });
  const edited = await dispatch(router, "PATCH", "/rules/NIFTYCE", { slDelta: 1, targetDelta: -1 });
  assert.equal(edited.body.slPrice, 141);
  assert.equal(edited.body.targetPrice, 169);
  assert.equal((await dispatch(router, "GET", "/rules")).body.rules.length, 1);
  assert.equal((await dispatch(router, "DELETE", "/rules/NIFTYCE")).status, 200);
  assert.equal((await dispatch(router, "GET", "/rules")).body.rules.length, 0);
});

test("UI trailing progress rejects stale revisions", async (t) => {
  const { router, store } = setup(t);
  seed(store, { mode: "trailing_sl" });
  const stale = await dispatch(router, "PATCH", "/rules/NIFTYCE", { slPrice: 145, rev: 99 });
  assert.equal(stale.status, 409);
  assert.equal(store.get("NIFTYCE").slPrice, 140);
  const updated = await dispatch(router, "PATCH", "/rules/NIFTYCE", { slPrice: 145, rev: 1 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.slPrice, 145);
  assert.equal(updated.body.rev, 2);
});

test("manual protection falls back to the live average or LTP when opening fills are unavailable", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const position = { tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
    daybuyqty: "75", daysellqty: "0", cfbuyqty: "0", cfsellqty: "0",
    netavgprc: "125", lp: "200" };
  axios.post = async (url) => ({ data: url.endsWith("/TradeBook") ? [] : [position] });
  const stop = { kind: "stop", stopPoints: 10, targetPoints: null, trailingStop: false,
    targetTrailing: false, trailPoints: null, monitor: "server" };
  const response = await dispatch(router, "POST", "/rules/NIFTYCE/manual", stop);
  assert.equal(response.status, 200);
  assert.deepEqual([response.body.entry, response.body.slPrice], [125, 115]);
  assert.equal(store.get("NIFTYCE").status, "armed");
});

test("manual protection uses reconciled fills and discards a stale lifecycle", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const position = { tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
    daybuyqty: "150", daysellqty: "75", cfbuyqty: "0", cfsellqty: "0", netavgprc: "125", lp: "200" };
  let trades = [
    { tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "1", flid: "1", trantype: "B", flqty: "75", flprc: "100", fltm: "26-11-2026 09:15:00" },
    { tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "2", flid: "2", trantype: "S", flqty: "75", flprc: "120", fltm: "26-11-2026 09:20:00" },
    { tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "3", flid: "3", trantype: "B", flqty: "75", flprc: "150", fltm: "26-11-2026 09:25:00" },
  ];
  axios.post = async (url) => ({ data: url.endsWith("/TradeBook") ? trades : [position] });
  store.save({ ...rule, tsym: "NIFTYCE", entry: 100, slPrice: 90, targetPrice: 120 });
  const stop = { kind: "stop", stopPoints: 10, targetPoints: null, trailingStop: false,
    targetTrailing: false, trailPoints: null, monitor: "server" };
  let response = await dispatch(router, "POST", "/rules/NIFTYCE/manual", stop);
  assert.equal(response.status, 200);
  assert.deepEqual([response.body.entry, response.body.slPrice, response.body.targetPrice], [150, 140, null]);
  const target = { ...stop, kind: "target", stopPoints: null, targetPoints: 20 };
  response = await dispatch(router, "POST", "/rules/NIFTYCE/manual", target);
  assert.deepEqual([response.body.entry, response.body.slPrice, response.body.targetPrice], [150, 140, 170]);
  trades = trades.slice(1);
  response = await dispatch(router, "POST", "/rules/NIFTYCE/manual", stop);
  assert.equal(response.status, 409);
  assert.equal(response.body.status, "RECONCILIATION_REQUIRED");
  assert.equal(response.body.message, "OPEN – RECOVERING");
  assert.equal(store.get("NIFTYCE").status, "reconciliation_required");
  assert.deepEqual([store.get("NIFTYCE").slPrice, store.get("NIFTYCE").targetPrice], [140, 170]);
});

test("unidentified carry-forward is flagged and the stale rule stays suspended across restarts", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-carry-"));
  let store = createRiskStore(directory);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let day = "2026-11-26";
  const router = () => riskRoutes({ store, internalToken: "test",
    getSession: () => ({ usersession: "test", userid: "test" }), tradingDay: () => day });
  let position = { tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
    daybuyqty: "0", daysellqty: "0", cfbuyqty: "75", cfsellqty: "0" };
  let trades = [];
  axios.post = async (url) => ({ data: url.endsWith("/TradeBook") ? trades : [position] });
  store.save({ ...rule, tsym: "NIFTYCE" });
  const config = { stopPoints: 10, targetPoints: null, trailingStop: false,
    targetTrailing: false, trailPoints: null, monitor: "server" };
  let response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.equal(response.body.status, "RECONCILIATION_REQUIRED");
  const firstStatus = (await dispatch(router(), "GET", "/rules")).body.reconciliation;
  assert.equal(firstStatus[0].status, "RECONCILIATION_REQUIRED");
  assert.equal(store.get("NIFTYCE").status, "reconciliation_required");
  assert.equal(store.claim("NIFTYCE"), false);
  const revision = store.get("NIFTYCE").rev;
  store.close();
  store = createRiskStore(directory);
  day = "2026-11-27";
  response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.equal(response.body.status, "RECONCILIATION_REQUIRED");
  const secondStatus = (await dispatch(router(), "GET", "/rules")).body.reconciliation;
  assert.equal(secondStatus[0].message, firstStatus[0].message);
  assert.ok(secondStatus[0].updatedAt >= firstStatus[0].updatedAt);
  assert.equal(store.get("NIFTYCE").rev, revision);
  position = { ...position, cfbuyqty: "0", daybuyqty: "75" };
  trades = [{ tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "7", flid: "7",
    trantype: "B", flqty: "75", flprc: "150", fltm: "27-11-2026 09:25:00" }];
  response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.equal(response.status, 409);
  assert.equal(response.body.status, "RECONCILIATION_REQUIRED");
  assert.equal(response.body.message, "ACTION REQUIRED: automatic recovery cannot verify this position lifecycle");
  const manual = { ...config, kind: "stop" };
  response = await dispatch(router(), "POST", "/rules/NIFTYCE/manual", manual);
  assert.equal(response.status, 409);
  assert.equal(store.get("NIFTYCE").status, "reconciliation_required");
  assert.equal((await dispatch(router(), "GET", "/rules")).body.reconciliation[0].status, "RECONCILIATION_REQUIRED");
});

test("internal progress is authenticated and cannot overwrite a newer revision", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store);
  assert.equal((await dispatch(router, "GET", "/internal/rules")).status, 403);
  assert.equal((await dispatch(router, "GET", "/internal/rules", {}, internal)).body.rules.length, 1);
  assert.equal((await dispatch(router, "POST", "/internal/progress", { tsym: "NIFTYCE" }, internal)).status, 400);
  const update = { tsym: "NIFTYCE", rev: 1, slPrice: 150, targetPrice: 175 };
  assert.equal((await dispatch(router, "POST", "/internal/progress", update, internal)).body.applied, true);
  await dispatch(router, "PATCH", "/rules/NIFTYCE", { slPrice: 155 });
  assert.equal((await dispatch(router, "POST", "/internal/progress", update, internal)).body.applied, false);
  assert.equal(store.get("NIFTYCE").slPrice, 155);
});

test("reconciliation status is exposed and only an authenticated reconnect can trigger an immediate cycle", async (t) => {
  const requests = [];
  const reconciliationService = {
    getStatus: () => ({ running: true, currentStatus: "success", activePositionCount: 2 }),
    requestNow: (reason) => requests.push(reason),
  };
  const { router } = setup(t, { reconciliationService });
  const denied = await dispatch(router, "POST", "/internal/reconcile");
  assert.equal(denied.status, 403);
  const accepted = await dispatch(router, "POST", "/internal/reconcile", {}, internal);
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, { accepted: true });
  assert.deepEqual(requests, ["websocket_reconnect"]);
  assert.deepEqual((await dispatch(router, "GET", "/rules")).body.reconciliationStatus,
    { running: true, currentStatus: "success", activePositionCount: 2 });
});

test("a server trigger sends one exit for the open quantity and never retries", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const calls = [];
  axios.post = async (url, body) => {
    calls.push({ url, body });
    if (url.endsWith("/PositionBook")) return { data: [livePosition] };
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    if (url.endsWith("/OrderBook")) return { data: [] };
    return { data: { stat: "Ok", norenordno: "exit-1" } };
  };
  const trigger = { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 };
  assert.equal((await dispatch(router, "POST", "/internal/trigger", trigger, internal)).body.status, "exit_pending");
  assert.equal(store.get("NIFTYCE").status, "exit_pending");
  assert.equal(store.getExitOrderId("test", "NIFTYCE"), "exit-1");
  assert.match(store.get("NIFTYCE").message, /exit-1.*execution is unconfirmed/);
  assert.match(calls[4].body, /"trantype":"S"/);
  assert.match(calls[4].body, /"qty":"75"/);
  assert.equal((await dispatch(router, "POST", "/internal/trigger", trigger, internal)).body.handled, false);
  assert.equal(calls.length, 5);
});

test("a trigger adopts an existing broker exit order instead of submitting another", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const calls = [];
  axios.post = async (url) => {
    calls.push(url);
    if (url.endsWith("/PositionBook")) return { data: [livePosition] };
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    if (url.endsWith("/OrderBook")) return { data: [{
      norenordno: "manual-exit", tsym: "NIFTYCE", exch: "NFO", prd: "M",
      trantype: "S", status: "OPEN", qty: "75", fillshares: "0",
    }] };
    throw new Error("A duplicate exit order must not be sent");
  };
  const result = await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 }, internal);
  assert.deepEqual(result.body, { handled: true, status: "exit_pending", brokerOrderId: "manual-exit" });
  assert.equal(store.getExitOrderId("test", "NIFTYCE"), "manual-exit");
  assert.equal(calls.some((url) => url.endsWith("/PlaceOrder")), false);
});

test("a trigger for a flat position requires reconciliation", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const trigger = { tsym: "NIFTYCE", reason: "Target", ltp: 170, rev: 1 };
  seed(store);
  axios.post = async () => ({ data: [] });
  assert.equal((await dispatch(router, "POST", "/internal/trigger", trigger, internal)).body.status, "reconciliation_required");
});

test("a rejected exit requires reconciliation and is not retried", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const trigger = { tsym: "NIFTYCE", reason: "Target", ltp: 170, rev: 1 };
  seed(store);
  let calls = 0;
  axios.post = async (url) => {
    calls++;
    if (url.endsWith("/PositionBook")) return { data: [livePosition] };
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    if (url.endsWith("/OrderBook")) return { data: [] };
    return { data: { stat: "Not_Ok" } };
  };
  assert.equal((await dispatch(router, "POST", "/internal/trigger", trigger, internal)).body.status, "reconciliation_required");
  assert.equal((await dispatch(router, "POST", "/internal/trigger", trigger, internal)).body.handled, false);
  assert.equal(calls, 5);
});

test("an accepted exit without a broker order ID is uncertain, not complete", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  axios.post = async (url) => {
    if (url.endsWith("/PositionBook")) return { data: [livePosition] };
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    if (url.endsWith("/OrderBook")) return { data: [] };
    return { data: { stat: "Ok" } };
  };
  const result = await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 }, internal);
  assert.equal(result.body.status, "reconciliation_required");
  assert.notEqual(store.get("NIFTYCE").status, "done");
});

test("an accepted exit is flagged when its lifecycle changes during submission", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  axios.post = async (url) => {
    if (url.endsWith("/PositionBook")) return { data: [livePosition] };
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    if (url.endsWith("/OrderBook")) return { data: [] };
    store.markReconciliationRequired("test", "NIFTYCE", 1, "Position needs reconciliation: changed");
    return { data: { stat: "Ok", norenordno: "exit-race" } };
  };
  const result = await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 }, internal);
  assert.equal(result.body.status, "reconciliation_required");
  assert.match(store.listReconciliation("test")[0].message, /exit-race/);
});

test("UI-monitored triggers use the API-owned broker exit flow", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store, { monitor: "ui" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const calls = [];
  axios.post = async (url) => {
    calls.push(url);
    if (url.endsWith("/PositionBook")) return { data: [livePosition] };
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    if (url.endsWith("/OrderBook")) return { data: [] };
    return { data: { stat: "Ok", norenordno: "ui-exit" } };
  };
  const result = await dispatch(router, "POST", "/trigger",
    { tsym: "NIFTYCE", reason: "Target", ltp: 170, rev: 1 });
  assert.equal(result.body.status, "exit_pending");
  assert.ok(calls.some((url) => url.endsWith("/PlaceOrder")));
  assert.equal(store.get("NIFTYCE").monitor, "ui");
  assert.equal(store.get("NIFTYCE").status, "exit_pending");
});

test("risk triggers require a finite positive price that crossed the configured level", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  seed(store);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const calls = [];
  axios.post = async (url) => {
    calls.push(url);
    if (url.endsWith("/PositionBook")) return { data: [livePosition] };
    if (url.endsWith("/TradeBook")) return { data: liveTrades };
    if (url.endsWith("/OrderBook")) return { data: [] };
    return { data: { stat: "Ok", norenordno: "exit-2" } };
  };
  assert.equal((await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Target", ltp: 170, rev: 99 }, internal)).body.handled, false);
  assert.equal(calls.length, 0);
  assert.equal((await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Target", ltp: 0, rev: 1 }, internal)).status, 400);
  assert.equal((await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Target", ltp: 150, rev: 1 }, internal)).status, 409);
  assert.equal(store.get("NIFTYCE").status, "armed");
  assert.equal((await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Target", ltp: 170, rev: 1 }, internal)).body.status, "exit_pending");
  assert.equal(calls.filter((url) => url.endsWith("/PlaceOrder")).length, 1);
});

test("a missing session fails safely without requesting an exit", async (t) => {
  const { router, store } = setup(t, { getSession: () => ({}) });
  store.save({ ...rule, tsym: "NIFTYCE" });
  const result = await dispatch(router, "POST", "/internal/trigger", { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 }, internal);
  assert.equal(result.body.status, "reconciliation_required");
  assert.match(store.get("NIFTYCE").message, /session is unavailable/);
});

test("disabled trading or an unsupported exchange never sends an exit", async (t) => {
  let enabled = false;
  let exchange = "NFO";
  const { router, store } = setup(t, { tradingEnabled: () => enabled, tradingDay: () => "2026-11-26" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  let calls = 0;
  axios.post = async (url) => {
    calls++;
    if (url.endsWith("/TradeBook")) return { data: liveTrades.map((item) => ({ ...item, exch: exchange })) };
    return { data: [{ ...livePosition, exch: exchange }] };
  };
  seed(store);
  const result = await dispatch(router, "POST", "/internal/trigger", { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 1 }, internal);
  assert.equal(result.body.status, "failed");
  assert.equal(calls, 3);
  enabled = true;
  exchange = "NSE";
  store.save({ ...rule, tsym: "NIFTYCE" });
  assert.equal((await dispatch(router, "POST", "/internal/trigger", { tsym: "NIFTYCE", reason: "Stop-loss", ltp: 140, rev: 2 }, internal)).body.status, "reconciliation_required");
  assert.equal(calls, 6);
});

test("malformed triggers are rejected without claiming a rule", async (t) => {
  const { router, store } = setup(t);
  store.save({ ...rule, tsym: "NIFTYCE" });
  assert.equal((await dispatch(router, "POST", "/internal/trigger", { tsym: "NIFTYCE" }, internal)).status, 400);
  assert.equal((await dispatch(router, "POST", "/internal/trigger",
    { tsym: "NIFTYCE", reason: "Stop-loss", ltp: "140", rev: 1 }, internal)).status, 400);
  assert.equal(store.get("NIFTYCE").status, "armed");
});

test("default protection reconciles the opening fill and survives a store restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-lifecycle-"));
  let store = createRiskStore(directory);
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const router = () => riskRoutes({
    store, internalToken: "test", getSession: () => ({ usersession: "test", userid: "test" }),
    tradingDay: () => "2026-11-26",
  });
  const fill = (id, side, qty, price, time) => ({
    tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: id, flid: id,
    trantype: side, flqty: String(qty), flprc: String(price), fltm: `26-11-2026 ${time}`,
  });
  let trades = [fill("1", "B", 75, 100, "09:15:00"), fill("2", "S", 75, 120, "09:20:00"),
    fill("3", "B", 75, 150, "09:25:00")];
  let position = { tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
    daybuyqty: "150", daysellqty: "75", cfbuyqty: "0", cfsellqty: "0" };
  axios.post = async (url) => ({ data: url.endsWith("/TradeBook") ? trades : [position] });
  const config = { stopPoints: 10, targetPoints: 20, trailPoints: 5,
    trailingStop: false, targetTrailing: true, monitor: "server" };
  let response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.equal(response.status, 200);
  assert.deepEqual([response.body.entry, response.body.slPrice, response.body.targetPrice], [150, 140, 170]);
  await dispatch(router(), "PATCH", "/rules/NIFTYCE", { slPrice: 155, targetPrice: 180 });
  trades = [...trades, fill("4", "B", 75, 200, "09:30:00"), fill("5", "S", 75, 210, "09:35:00")];
  position = { ...position, daybuyqty: "225", daysellqty: "150" };
  store.close();
  store = createRiskStore(directory);
  response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.deepEqual([response.body.entry, response.body.slPrice, response.body.targetPrice], [150, 155, 180]);
  trades = [...trades, fill("6", "S", 75, 220, "09:40:00"), fill("7", "B", 75, 250, "09:45:00")];
  position = { ...position, daybuyqty: "300", daysellqty: "225" };
  response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.deepEqual([response.body.entry, response.body.slPrice, response.body.targetPrice], [250, 240, 270]);
  await dispatch(router(), "PATCH", "/rules/NIFTYCE", { slPrice: 245, targetPrice: 280 });
  trades = [...trades, fill("8", "S", 75, 260, "09:50:00"), fill("9", "B", 75, 250, "09:55:00")];
  position = { ...position, daybuyqty: "375", daysellqty: "300" };
  response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.deepEqual([response.body.entry, response.body.slPrice, response.body.targetPrice], [250, 240, 270]);
  trades = trades.slice(1);
  response = await dispatch(router(), "POST", "/rules/NIFTYCE/default", config);
  assert.equal(response.status, 409);
  assert.equal(store.get("NIFTYCE").entry, 250);
});

test("default protection uses the opening fill for every protection mode", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const position = { tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
    daybuyqty: "75", daysellqty: "0", cfbuyqty: "0", cfsellqty: "0", netavgprc: "125" };
  const trades = [{ tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "1", flid: "1",
    trantype: "B", flqty: "75", flprc: "150", fltm: "26-11-2026 09:25:00" }];
  axios.post = async (url) => ({ data: url.endsWith("/TradeBook") ? trades : [position] });
  const cases = [
    [{ stopPoints: 10, targetPoints: null, trailingStop: false, targetTrailing: false, trailPoints: null }, "static", 140, null],
    [{ stopPoints: null, targetPoints: 20, trailingStop: false, targetTrailing: false, trailPoints: null }, "static", null, 170],
    [{ stopPoints: 10, targetPoints: null, trailingStop: true, targetTrailing: false, trailPoints: null }, "trailing_sl", 140, null],
    [{ stopPoints: 10, targetPoints: 20, trailingStop: false, targetTrailing: true, trailPoints: 5 }, "target_trail", 140, 170],
  ];
  for (const [config, mode, sl, target] of cases) {
    store.remove("NIFTYCE");
    const result = await dispatch(router, "POST", "/rules/NIFTYCE/default", { ...config, monitor: "server" });
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.entry, result.body.mode, result.body.slPrice, result.body.targetPrice],
      [150, mode, sl, target]);
  }
});

test("default reconciliation rejects a changing position or concurrent rule edit", async (t) => {
  const { router, store } = setup(t, { tradingDay: () => "2026-11-26" });
  const originalPost = axios.post;
  t.after(() => { axios.post = originalPost; });
  const position = { tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
    daybuyqty: "75", daysellqty: "0", cfbuyqty: "0", cfsellqty: "0" };
  const trades = [{ tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "1", flid: "1",
    trantype: "B", flqty: "75", flprc: "150", fltm: "26-11-2026 09:25:00" }];
  const config = { stopPoints: 10, targetPoints: null, trailPoints: null,
    trailingStop: false, targetTrailing: false, monitor: "server" };
  let positions = 0;
  axios.post = async (url) => {
    if (url.endsWith("/TradeBook")) return { data: trades };
    positions++;
    return { data: [positions === 1 ? position : { ...position, netqty: "150" }] };
  };
  assert.equal((await dispatch(router, "POST", "/rules/NIFTYCE/default", config)).status, 409);
  assert.equal(store.get("NIFTYCE"), null);

  axios.post = async (url) => {
    if (url.endsWith("/TradeBook")) {
      store.save({ ...rule, tsym: "OTHER" });
      return { data: trades.map((item) => ({ ...item, tsym: "OTHER" })) };
    }
    return { data: [{ ...position, tsym: "OTHER" }] };
  };
  assert.equal((await dispatch(router, "POST", "/rules/OTHER/default", config)).status, 409);
  assert.equal(store.get("OTHER").status, "reconciliation_required");
});
