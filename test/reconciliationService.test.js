const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRiskStore } = require("../riskStore");
const { createReconciliationService, INTERVAL_MS } = require("../reconciliationService");

const account = "test-user";
const position = {
  tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123", netqty: "75",
  daybuyqty: "75", daysellqty: "0", cfbuyqty: "0", cfsellqty: "0",
};
const openingTrade = {
  tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: "entry-1", flid: "fill-1",
  trantype: "B", flqty: "75", flprc: "150", fltm: "26-11-2026 09:25:00",
};
const protection = {
  tsym: "NIFTYCE", instrument: "NFO|123", side: "long", entry: 150,
  mode: "static", slPrice: 140, slPoints: 10, targetPrice: 170,
  trailPoints: null, monitor: "server",
};

function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-reconcile-"));
  const store = createRiskStore(directory);
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const snapshot = {
    positions: [position],
    orders: [],
    trades: [openingTrade],
    ...overrides.snapshot,
  };
  const calls = [];
  const request = overrides.request || (async (url, payload, options) => {
    calls.push({ url, payload, options });
    if (url.endsWith("/PositionBook")) return { status: 200, data: snapshot.positions };
    if (url.endsWith("/OrderBook")) {
      const product = JSON.parse(/jData=(\{[^&]+\})/.exec(payload)[1]).prd;
      return { status: 200, data: snapshot.orders.filter((order) => order.prd === product) };
    }
    if (url.endsWith("/TradeBook")) return { status: 200, data: snapshot.trades };
    throw new Error(`Unexpected broker endpoint: ${url}`);
  });
  const service = createReconciliationService({
    store,
    getSession: () => ({ usersession: "mock-session", userid: account }),
    account,
    request,
    tradingDay: () => "2026-11-26",
    ...overrides.service,
  });
  return { store, service, snapshot, calls };
}

function seed(store) {
  store.saveDefault(account, "M", {
    openingOrderId: openingTrade.norenordno,
    openingFillId: openingTrade.flid,
    openingPrice: 150,
  }, protection, null);
}

test("one bulk cycle reconciles every open position, not only the UI-selected symbol", async (t) => {
  const secondPosition = {
    ...position, tsym: "BANKCE", token: "456", netqty: "25",
    daybuyqty: "25",
  };
  const secondTrade = {
    ...openingTrade, tsym: "BANKCE", norenordno: "entry-2",
    flid: "fill-2", flqty: "25", flprc: "200",
  };
  const { store, service } = setup(t, {
    snapshot: { positions: [position, secondPosition], trades: [openingTrade, secondTrade] },
  });
  seed(store);
  store.saveDefault(account, "M", {
    openingOrderId: "entry-2", openingFillId: "fill-2", openingPrice: 200,
  }, { ...protection, tsym: "BANKCE", instrument: "NFO|456", entry: 200,
    slPrice: 190, targetPrice: 220 }, null);

  await service.runOnce();

  assert.equal(service.getStatus().activePositionCount, 2);
  assert.equal(service.getStatus().positions.NIFTYCE, "OPEN – PROTECTED");
  assert.equal(service.getStatus().positions.BANKCE, "OPEN – PROTECTED");
  await service.stop();
});

test("the scheduler starts at 3 seconds and restores a suspended rule only after matching broker evidence", async (t) => {
  let intervalCallback;
  let intervalMs;
  const { store, service, calls } = setup(t, {
    service: {
      setIntervalFn: (callback, ms) => {
        intervalCallback = callback;
        intervalMs = ms;
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    },
  });
  seed(store);
  store.suspendOnStartup(account);

  service.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(intervalMs, INTERVAL_MS);
  assert.equal(calls.length, 4);
  assert.equal(store.get("NIFTYCE").status, "armed");
  assert.equal(service.getStatus().positions.NIFTYCE, "OPEN – PROTECTED");
  assert.equal(service.getStatus().repairedCount, 1);
  assert.equal(typeof intervalCallback, "function");
  await service.stop();
});

test("a slow broker cycle never overlaps the interval cycle", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maximumActive = 0;
  let tick;
  const { service, calls } = setup(t, {
    request: async (url, payload) => {
      calls.push({ url, payload });
      active++;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active--;
      if (url.endsWith("/PositionBook")) return { status: 200, data: [position] };
      if (url.endsWith("/OrderBook")) return { status: 200, data: [] };
      return { status: 200, data: [openingTrade] };
    },
    service: {
      setIntervalFn: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    },
  });
  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  tick();
  assert.equal(calls.length, 1);
  assert.equal(service.getStatus().skippedCycles, 1);
  release();
  await service.stop();
  assert.equal(maximumActive, 1);
});

test("a failed broker cycle backs off and later cycles recover", async (t) => {
  let currentTime = 1000;
  let fail = true;
  const { service, calls } = setup(t, {
    request: async (url, payload, options) => {
      calls.push({ url, payload, options });
      if (fail && url.endsWith("/PositionBook")) {
        throw Object.assign(new Error("mock timeout"), { code: "ECONNABORTED" });
      }
      if (url.endsWith("/PositionBook")) return { status: 200, data: [position] };
      if (url.endsWith("/OrderBook")) return { status: 200, data: [] };
      return { status: 200, data: [openingTrade] };
    },
    service: { now: () => currentTime },
  });
  await service.runOnce();
  assert.equal(service.getStatus().currentStatus, "failed");
  assert.equal(service.getStatus().lastError, "ECONNABORTED");
  assert.equal(calls.length, 1);

  currentTime += INTERVAL_MS;
  fail = false;
  await service.runOnce();
  assert.equal(service.getStatus().currentStatus, "success");
  assert.equal(service.getStatus().lastSuccessfulAt, currentTime);
  assert.equal(calls.length, 5);
  await service.stop();
});

test("the cycle reconciles BUY and SELL fills, remaining quantities, and weighted averages", async (t) => {
  const secondBuy = {
    ...openingTrade, norenordno: "entry-2", flid: "fill-2", flqty: "25",
    flprc: "170", fltm: "26-11-2026 09:26:00",
  };
  const partialExit = {
    ...openingTrade, norenordno: "exit-1", flid: "fill-3", trantype: "S",
    flqty: "50", flprc: "180", fltm: "26-11-2026 09:27:00",
  };
  const { store, service } = setup(t, {
    snapshot: {
      positions: [{ ...position, netqty: "50", daybuyqty: "100", daysellqty: "50" }],
      trades: [openingTrade, secondBuy, partialExit],
      orders: [
        { norenordno: "entry-1", tsym: "NIFTYCE", exch: "NFO", prd: "M",
          trantype: "B", status: "COMPLETE", qty: "75", fillshares: "75" },
        { norenordno: "entry-2", tsym: "NIFTYCE", exch: "NFO", prd: "M",
          trantype: "B", status: "COMPLETE", qty: "25", fillshares: "25" },
        { norenordno: "exit-1", tsym: "NIFTYCE", exch: "NFO", prd: "M",
          trantype: "S", status: "COMPLETE", qty: "50", fillshares: "50" },
      ],
    },
  });
  seed(store);
  await service.runOnce();

  assert.deepEqual(service.getStatus().positionMetrics.NIFTYCE, {
    side: "long", netQuantity: 50, openingOrderId: "entry-1",
    openingFillId: "fill-1", openingPrice: 150, averageEntryPrice: 155,
  });
  assert.deepEqual({ ...store.getBrokerOrder(account, "exit-1") }, {
    order_id: "exit-1", tsym: "NIFTYCE", exch: "NFO", prd: "M", side: "S",
    quantity: 50, filled_quantity: 50, remaining_quantity: 0,
    average_fill_price: 180, status: "COMPLETE",
  });
  assert.equal(service.getStatus().brokerStateUpdates, 3);
  await service.stop();
});

test("a verified partial exit remains in progress, then rearms only after its order is terminal", async (t) => {
  const partialTrade = {
    ...openingTrade, norenordno: "exit-1", flid: "fill-2", trantype: "S",
    flqty: "25", flprc: "140", fltm: "26-11-2026 09:30:00",
  };
  const partialPosition = {
    ...position, netqty: "50", daysellqty: "25",
  };
  const exitOrder = {
    norenordno: "exit-1", tsym: "NIFTYCE", exch: "NFO", prd: "M", trantype: "S",
    status: "OPEN", qty: "75", fillshares: "25",
  };
  const { store, service, snapshot } = setup(t, {
    snapshot: { positions: [partialPosition], orders: [exitOrder], trades: [openingTrade, partialTrade] },
  });
  seed(store);
  assert.equal(store.claim("NIFTYCE"), true);
  assert.equal(store.finishExit(account, "NIFTYCE", 1, "exit-1", "exit pending"), true);
  store.suspendOnStartup(account);

  await service.runOnce();
  assert.equal(store.get("NIFTYCE").status, "exit_partially_filled");
  assert.equal(service.getStatus().positions.NIFTYCE, "EXIT PARTIALLY FILLED");

  snapshot.orders = [{ ...exitOrder, status: "CANCELED" }];
  await service.runOnce();
  assert.equal(store.get("NIFTYCE").status, "armed");
  assert.equal(store.getExitOrderId(account, "NIFTYCE"), null);
  assert.equal(service.getStatus().positions.NIFTYCE, "OPEN – PROTECTED");
  await service.stop();
});

test("a triggered exit with no resolvable order is never automatically retried", async (t) => {
  const { store, service } = setup(t);
  seed(store);
  assert.equal(store.claim("NIFTYCE"), true);
  store.suspendOnStartup(account);

  await service.runOnce();

  assert.equal(store.get("NIFTYCE").status, "reconciliation_required");
  assert.equal(store.listReconciliation(account)[0].recoveryStatus, "ACTION_REQUIRED");
  assert.equal(service.getStatus().positions.NIFTYCE, "ACTION REQUIRED");
  await service.stop();
});

test("the SQLite lease prevents separate API processes from reconciling together", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, service: first } = setup(t, {
    request: async (url) => {
      await gate;
      if (url.endsWith("/PositionBook")) return { status: 200, data: [position] };
      if (url.endsWith("/OrderBook")) return { status: 200, data: [] };
      return { status: 200, data: [openingTrade] };
    },
  });
  const secondCalls = [];
  const second = createReconciliationService({
    store,
    getSession: () => ({ usersession: "mock-session", userid: account }),
    account,
    request: async (url) => {
      secondCalls.push(url);
      return { status: 200, data: [] };
    },
    tradingDay: () => "2026-11-26",
  });
  const firstCycle = first.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  await second.runOnce();
  assert.equal(second.getStatus().currentStatus, "another_instance");
  assert.equal(secondCalls.length, 0);
  release();
  await firstCycle;
  await Promise.all([first.stop(), second.stop()]);
});
