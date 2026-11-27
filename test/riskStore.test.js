const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRiskStore, validateRule } = require("../riskStore");
const { marketableLimitPrice } = require("../routes/risk");
const { createLotLedger } = require("../lotLedger");

const input = (overrides = {}) => ({
  instrument: "NFO|123", side: "long", entry: 100, mode: "target_trail",
  slPrice: 90, targetPrice: 120, trailPoints: 5, ...overrides,
});

test("a rule can be claimed once and progress is ignored after a user edit", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-risk-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createRiskStore(directory);
  t.after(() => store.close());

  const rev = store.save(validateRule("NIFTYCE", input()));
  assert.equal(store.updateProgress("NIFTYCE", rev, 120, 125), true);
  const edited = store.save(validateRule("NIFTYCE", input({ slPrice: 95 })));
  assert.equal(store.updateProgress("NIFTYCE", rev, 120, 125), false);
  assert.equal(store.list()[0].slPrice, 95);

  assert.equal(store.claim("NIFTYCE"), true);
  assert.equal(store.claim("NIFTYCE"), false);
  assert.equal(store.updateProgress("NIFTYCE", edited, 100, 130), false);
  assert.equal(store.finish("NIFTYCE", "exit_pending", "awaiting fill confirmation"), true);
  assert.equal(store.list()[0].status, "exit_pending");
});

test("invalid rules are rejected", () => {
  assert.throws(() => validateRule("X", input({ mode: "bogus" })), /Invalid mode/);
  assert.throws(() => validateRule("X", input({ trailPoints: null })), /Target trailing/);
  assert.throws(() => validateRule("X", input({ targetPrice: 80 })), /profit side/);
  assert.throws(() => validateRule("X", input({ slPrice: null, targetPrice: null })), /stop-loss or a target/);
  assert.equal(validateRule("X", input({ slPrice: null })).slPrice, null);
  assert.throws(() => validateRule("X", input({ instrument: "bad" })), /Invalid instrument/);
});

test("each mode validates its own required fields", () => {
  const stat = validateRule("X", input({ mode: "static", trailPoints: null }));
  assert.equal(stat.mode, "static");
  assert.throws(() => validateRule("X", input({ mode: "trailing_sl", slPoints: null })), /./);
  assert.throws(() => validateRule("X", input({ mode: "trailing_sl", slPrice: null, slPoints: 10 })), /./);
  assert.throws(() => validateRule("X", input({ mode: "target_trail", targetPrice: null })), /./);
  assert.throws(() => validateRule("X", input({ side: "short", slPrice: 90, targetPrice: 95 })), /./);
  const short = validateRule("X", input({ side: "short", slPrice: 110, targetPrice: 80 }));
  assert.equal(short.side, "short");
});

test("lot ledger persists independent allocations and restarts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-lots-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let ledger = createLotLedger(directory);
  ledger.save("account", {
    lotId: "lot-1", positionId: "NFO:M:NIFTYCE", symbol: "NIFTYCE",
    exchange: "NFO", productType: "M", side: "long", quantity: 75,
    remainingQuantity: 75, entryOrderId: "order-1", entryAveragePrice: 100,
  });
  ledger.close();
  ledger = createLotLedger(directory);
  t.after(() => ledger.close());
  const lot = ledger.listBySymbol("account", "NIFTYCE")[0];
  assert.equal(lot.lotId, "lot-1");
  assert.equal(lot.entryAveragePrice, 100);
});

test("lot exit reservation prevents duplicate submissions and partial fills", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-lot-exit-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = createLotLedger(directory);
  t.after(() => ledger.close());
  ledger.save("account", {
    lotId: "lot-1", positionId: "NFO:M:NIFTYCE", symbol: "NIFTYCE",
    exchange: "NFO", productType: "M", side: "long", quantity: 75,
    remainingQuantity: 75, entryOrderId: "order-1", entryAveragePrice: 100,
  });
  const first = ledger.reserveExit("account", "lot-1", "intent-1");
  const duplicate = ledger.reserveExit("account", "lot-1", "intent-2");
  assert.equal(first.reserved, true);
  assert.equal(first.quantity, 75);
  assert.equal(duplicate.reserved, false);
  ledger.recordBrokerExit("account", "lot-1", "intent-1", "exit-1", "accepted");
  assert.equal(ledger.updateExitFill("account", "lot-1", 25, 110,
    "EXIT_PARTIALLY_FILLED", "25 filled"), true);
  let lot = ledger.get("account", "lot-1");
  assert.equal(lot.remainingQuantity, 50);
  assert.equal(lot.realizedPnl, 250);
  assert.equal(ledger.updateExitFill("account", "lot-1", 50, 120,
    "EXIT_COMPLETED", "50 filled"), true);
  lot = ledger.get("account", "lot-1");
  assert.equal(lot.remainingQuantity, 0);
  assert.equal(lot.status, "EXIT_COMPLETED");
  assert.ok(Math.abs(lot.realizedPnl - 1250) < 0.01);
});

test("exit orders are limit prices through the market because Flattrade rejects MKT", () => {
  assert.equal(marketableLimitPrice(100, true), "98.00");
  assert.equal(marketableLimitPrice(100, false), "102.00");
  assert.equal(marketableLimitPrice(0.05, true), "0.05");
  assert.throws(() => marketableLimitPrice(undefined, true), /live price/);
});

test("rules accept and persist server or UI monitoring", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-risk-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createRiskStore(directory);
  t.after(() => store.close());

  assert.equal(validateRule("X", input()).monitor, "server");
  assert.throws(() => validateRule("X", input({ monitor: "phone" })), /Invalid monitor/);
  store.save(validateRule("SRV1", input()));
  store.save(validateRule("UI1", input({ monitor: "ui" })));
  const monitors = Object.fromEntries(store.list().map((rule) => [rule.tsym, rule.monitor]));
  assert.deepEqual(monitors, { SRV1: "server", UI1: "ui" });
});

test("UI monitoring selection persists across API restarts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-risk-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = createRiskStore(directory);
  store.save(validateRule("UI1", input({ monitor: "ui" })));
  store.close();
  store = createRiskStore(directory);
  t.after(() => store.close());
  assert.equal(store.get("UI1").monitor, "ui");
});

test("startup flags pending broker exits for reconciliation", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-risk-exit-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = createRiskStore(directory);
  store.save(validateRule("PENDING", input({ mode: "static", targetPrice: null, trailPoints: null })));
  assert.equal(store.claim("PENDING"), true);
  assert.equal(store.finish("PENDING", "exit_pending", "broker order accepted; fill unknown"), true);
  store.close();
  store = createRiskStore(directory);
  t.after(() => store.close());
  store.suspendOnStartup("test");
  assert.equal(store.get("PENDING").status, "reconciliation_required");
  assert.equal(store.listReconciliation("test")[0].tsym, "PENDING");
  assert.match(store.listReconciliation("test")[0].message, /broker order accepted; fill unknown/);
});
