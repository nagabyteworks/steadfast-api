const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { nextExpiry } = require("./sessionStore");

const MODES = new Set(["static", "trailing_sl", "target_trail"]);
const COLUMNS = "tsym, instrument, side, entry, mode, sl_price, sl_points, target_price, trail_points, status, message, rev, expires_at, updated_at";

const toRule = (row) => ({
  tsym: row.tsym,
  instrument: row.instrument,
  side: row.side,
  entry: row.entry,
  mode: row.mode,
  slPrice: row.sl_price,
  slPoints: row.sl_points,
  targetPrice: row.target_price,
  trailPoints: row.trail_points,
  status: row.status,
  message: row.message,
  rev: row.rev,
  updatedAt: row.updated_at,
});

const positive = (value) => Number.isFinite(value) && value > 0;

// Returns a cleaned rule or throws when the browser-supplied rule is not usable.
function validateRule(tsym, input) {
  const rule = {
    tsym,
    instrument: input?.instrument,
    side: input?.side,
    entry: Number(input?.entry),
    mode: input?.mode,
    slPrice: input?.slPrice == null ? null : Number(input.slPrice),
    slPoints: input?.slPoints == null ? null : Number(input.slPoints),
    targetPrice: input?.targetPrice == null ? null : Number(input.targetPrice),
    trailPoints: input?.trailPoints == null ? null : Number(input.trailPoints),
  };
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (typeof tsym !== "string" || !tsym || tsym.length > 64) fail("Invalid trading symbol");
  if (typeof rule.instrument !== "string" || !/^[A-Z]{2,10}\|\d{1,12}$/.test(rule.instrument)) fail("Invalid instrument");
  if (!["long", "short"].includes(rule.side)) fail("Invalid side");
  if (!MODES.has(rule.mode)) fail("Invalid mode");
  if (!positive(rule.entry) || (rule.slPrice !== null && !positive(rule.slPrice))) fail("Entry and stop-loss prices must be positive");
  if (rule.slPrice === null && rule.targetPrice === null) fail("A rule needs a stop-loss or a target");
  if (rule.targetPrice !== null && !positive(rule.targetPrice)) fail("Invalid target price");
  if (rule.mode === "trailing_sl" && (rule.slPrice === null || !positive(rule.slPoints))) fail("Trailing stop-loss needs positive points");
  if (rule.mode === "target_trail" && (!positive(rule.trailPoints) || rule.targetPrice === null)) {
    fail("Target trailing needs a target and positive trail points");
  }
  const long = rule.side === "long";
  if (rule.slPrice !== null && rule.targetPrice !== null && (long ? rule.targetPrice <= rule.slPrice : rule.targetPrice >= rule.slPrice)) {
    fail("Target must be on the profit side of the stop-loss");
  }
  return rule;
}

function createRiskStore(directory) {
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("An absolute state directory is required for risk rules");
  }
  const file = path.join(directory, "risk-rules.sqlite");
  fs.closeSync(fs.openSync(file, "a", 0o600));
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS risk_rule (
    tsym TEXT PRIMARY KEY, instrument TEXT NOT NULL, side TEXT NOT NULL, entry REAL NOT NULL,
    mode TEXT NOT NULL, sl_price REAL, sl_points REAL, target_price REAL, trail_points REAL,
    status TEXT NOT NULL, message TEXT, rev INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);

  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM risk_rule WHERE expires_at > ? ORDER BY tsym`);
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM risk_rule WHERE tsym = ? AND expires_at > ?`);
  const selectRev = db.prepare("SELECT rev FROM risk_rule WHERE tsym = ?");
  const upsert = db.prepare(`INSERT OR REPLACE INTO risk_rule (${COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', NULL, ?, ?, ?)`);
  const remove = db.prepare("DELETE FROM risk_rule WHERE tsym = ?");
  const progress = db.prepare("UPDATE risk_rule SET sl_price = ?, target_price = ?, updated_at = ? WHERE tsym = ? AND rev = ? AND status = 'armed'");
  const claim = db.prepare("UPDATE risk_rule SET status = 'triggered', updated_at = ? WHERE tsym = ? AND status = 'armed'");
  const finish = db.prepare("UPDATE risk_rule SET status = ?, message = ?, updated_at = ? WHERE tsym = ? AND status = 'triggered'");

  return {
    get(tsym) {
      const row = selectOne.get(tsym, Date.now());
      return row ? toRule(row) : null;
    },
    list: () => selectAll.all(Date.now()).map(toRule),
    save(rule) {
      const now = Date.now();
      const rev = (selectRev.get(rule.tsym)?.rev ?? 0) + 1;
      upsert.run(rule.tsym, rule.instrument, rule.side, rule.entry, rule.mode, rule.slPrice, rule.slPoints,
        rule.targetPrice, rule.trailPoints, rev, nextExpiry(now), now);
      return rev;
    },
    remove: (tsym) => remove.run(tsym).changes > 0,
    updateProgress: (tsym, rev, slPrice, targetPrice) =>
      progress.run(slPrice, targetPrice, Date.now(), tsym, rev).changes > 0,
    // Atomic: only one caller can move a rule from armed to triggered.
    claim: (tsym) => claim.run(Date.now(), tsym).changes > 0,
    finish: (tsym, status, message) => finish.run(status, message, Date.now(), tsym).changes > 0,
    close: () => db.close(),
  };
}

module.exports = { createRiskStore, validateRule };
