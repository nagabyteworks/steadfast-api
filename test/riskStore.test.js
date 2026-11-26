const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRiskStore, validateRule } = require("../riskStore");
const { marketableLimitPrice } = require("../routes/risk");

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
  assert.equal(store.finish("NIFTYCE", "done", "ok"), true);
  assert.equal(store.list()[0].status, "done");
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

test("exit orders are limit prices through the market because Flattrade rejects MKT", () => {
  assert.equal(marketableLimitPrice(100, true), "98.00");
  assert.equal(marketableLimitPrice(100, false), "102.00");
  assert.equal(marketableLimitPrice(0.05, true), "0.05");
  assert.throws(() => marketableLimitPrice(undefined, true), /live price/);
});

test("rules default to server monitoring and persist the monitor choice", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steadfast-risk-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createRiskStore(directory);
  t.after(() => store.close());

  assert.equal(validateRule("X", input()).monitor, "server");
  assert.throws(() => validateRule("X", input({ monitor: "phone" })), /Invalid monitor/);
  store.save(validateRule("UI1", input({ monitor: "ui" })));
  store.save(validateRule("SRV1", input()));
  const monitors = Object.fromEntries(store.list().map((rule) => [rule.tsym, rule.monitor]));
  assert.deepEqual(monitors, { SRV1: "server", UI1: "ui" });
});
