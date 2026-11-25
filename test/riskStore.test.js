const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRiskStore, validateRule } = require("../riskStore");

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
  assert.equal(store.finish("NIFTYCE", "dry_run", "ok"), true);
  assert.equal(store.list()[0].status, "dry_run");
});

test("invalid rules are rejected", () => {
  assert.throws(() => validateRule("X", input({ mode: "bogus" })), /Invalid mode/);
  assert.throws(() => validateRule("X", input({ trailPoints: null })), /Target trailing/);
  assert.throws(() => validateRule("X", input({ targetPrice: 80 })), /profit side/);
  assert.throws(() => validateRule("X", input({ slPrice: null, targetPrice: null })), /stop-loss or a target/);
  assert.equal(validateRule("X", input({ slPrice: null })).slPrice, null);
  assert.throws(() => validateRule("X", input({ instrument: "bad" })), /Invalid instrument/);
});
