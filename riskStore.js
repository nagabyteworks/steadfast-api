const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { nextExpiry } = require("./sessionStore");

const MONITORS = new Set(["server", "ui"]);
const MODES = new Set(["static", "trailing_sl", "target_trail"]);
const COLUMNS = "tsym, instrument, side, entry, mode, sl_price, sl_points, target_price, trail_points, status, message, rev, expires_at, updated_at, monitor";

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
  monitor: row.monitor,
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
    monitor: input?.monitor ?? "server",
  };
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (typeof tsym !== "string" || !tsym || tsym.length > 64) fail("Invalid trading symbol");
  if (typeof rule.instrument !== "string" || !/^[A-Z]{2,10}\|\d{1,12}$/.test(rule.instrument)) fail("Invalid instrument");
  if (!["long", "short"].includes(rule.side)) fail("Invalid side");
  if (!MODES.has(rule.mode)) fail("Invalid mode");
  if (!MONITORS.has(rule.monitor)) fail("Invalid monitor");
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
  db.exec(`CREATE TABLE IF NOT EXISTS risk_lifecycle (
    account TEXT NOT NULL, tsym TEXT NOT NULL, instrument TEXT NOT NULL, product TEXT NOT NULL,
    opening_order_id TEXT NOT NULL, opening_fill_id TEXT NOT NULL, opening_price REAL NOT NULL,
    PRIMARY KEY (account, tsym))`);
  db.exec(`CREATE TABLE IF NOT EXISTS risk_reconciliation (
    account TEXT NOT NULL, tsym TEXT NOT NULL, reason TEXT NOT NULL, updated_at INTEGER NOT NULL,
    recovery_status TEXT NOT NULL DEFAULT 'RECOVERING',
    PRIMARY KEY (account, tsym))`);
  db.exec(`CREATE TABLE IF NOT EXISTS risk_exit_order (
    account TEXT NOT NULL, tsym TEXT NOT NULL, order_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (account, tsym))`);
  db.exec(`CREATE TABLE IF NOT EXISTS broker_order_state (
    account TEXT NOT NULL, order_id TEXT NOT NULL, tsym TEXT NOT NULL, exch TEXT NOT NULL, prd TEXT NOT NULL,
    side TEXT, quantity INTEGER, filled_quantity INTEGER NOT NULL, remaining_quantity INTEGER,
    average_fill_price REAL,
    status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (account, order_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS reconciliation_lease (
    name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)`);

  // Databases created before the monitor column existed are upgraded in place.
  if (!db.prepare("PRAGMA table_info(risk_rule)").all().some((column) => column.name === "monitor")) {
    db.exec("ALTER TABLE risk_rule ADD COLUMN monitor TEXT NOT NULL DEFAULT 'server'");
  }
  if (!db.prepare("PRAGMA table_info(risk_reconciliation)").all()
    .some((column) => column.name === "recovery_status")) {
    db.exec("ALTER TABLE risk_reconciliation ADD COLUMN recovery_status TEXT NOT NULL DEFAULT 'RECOVERING'");
  }
  if (!db.prepare("PRAGMA table_info(broker_order_state)").all()
    .some((column) => column.name === "remaining_quantity")) {
    db.exec("ALTER TABLE broker_order_state ADD COLUMN remaining_quantity INTEGER");
  }
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM risk_rule WHERE expires_at > ? ORDER BY tsym`);
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM risk_rule WHERE tsym = ? AND expires_at > ?`);
  const selectRev = db.prepare("SELECT rev FROM risk_rule WHERE tsym = ?");
  const upsert = db.prepare(`INSERT OR REPLACE INTO risk_rule (${COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', NULL, ?, ?, ?, ?)`);
  const remove = db.prepare("DELETE FROM risk_rule WHERE tsym = ?");
  const progress = db.prepare("UPDATE risk_rule SET sl_price = ?, target_price = ?, updated_at = ? WHERE tsym = ? AND rev = ? AND status = 'armed'");
  const claim = db.prepare(`UPDATE risk_rule SET status = 'triggered', updated_at = ?
    WHERE tsym = ? AND status = 'armed' AND NOT EXISTS
    (SELECT 1 FROM risk_reconciliation WHERE tsym = risk_rule.tsym)`);
  const finish = db.prepare("UPDATE risk_rule SET status = ?, message = ?, updated_at = ? WHERE tsym = ? AND status = 'triggered'");
  const lifecycle = db.prepare("SELECT * FROM risk_lifecycle WHERE account = ? AND tsym = ?");
  const saveLifecycle = db.prepare(`INSERT OR REPLACE INTO risk_lifecycle
    (account, tsym, instrument, product, opening_order_id, opening_fill_id, opening_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const flagReconciliation = db.prepare(`INSERT INTO risk_reconciliation (account, tsym, reason, updated_at, recovery_status)
    VALUES (?, ?, ?, ?, 'RECOVERING') ON CONFLICT(account, tsym) DO UPDATE SET
    reason = excluded.reason, updated_at = excluded.updated_at, recovery_status = 'RECOVERING'`);
  const clearReconciliation = db.prepare("DELETE FROM risk_reconciliation WHERE account = ? AND tsym = ?");
  const reconciliation = db.prepare("SELECT 1 FROM risk_reconciliation WHERE tsym = ? LIMIT 1");
  const reconciliationOne = db.prepare(`SELECT recovery_status, reason FROM risk_reconciliation
    WHERE account = ? AND tsym = ?`);
  const reconciliationList = db.prepare(`SELECT tsym, reason, updated_at, recovery_status FROM risk_reconciliation
    WHERE account = ? OR account = '' ORDER BY updated_at`);
  const setRecovery = db.prepare(`UPDATE risk_reconciliation SET recovery_status = ?, reason = ?, updated_at = ?
    WHERE account = ? AND tsym = ?`);
  const exitOrder = db.prepare("SELECT order_id FROM risk_exit_order WHERE account = ? AND tsym = ?");
  const saveExitOrder = db.prepare(`INSERT INTO risk_exit_order (account, tsym, order_id, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(account, tsym) DO UPDATE SET
    order_id = excluded.order_id, updated_at = excluded.updated_at`);
  const removeExitOrder = db.prepare("DELETE FROM risk_exit_order WHERE account = ? AND tsym = ?");
  const recordBrokerOrder = db.prepare(`INSERT INTO broker_order_state
    (account, order_id, tsym, exch, prd, side, quantity, filled_quantity, remaining_quantity,
    average_fill_price, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account, order_id) DO UPDATE SET tsym = excluded.tsym, exch = excluded.exch,
    prd = excluded.prd, side = excluded.side, quantity = excluded.quantity,
    filled_quantity = excluded.filled_quantity, remaining_quantity = excluded.remaining_quantity,
    average_fill_price = excluded.average_fill_price,
    status = excluded.status, updated_at = excluded.updated_at
    WHERE broker_order_state.tsym IS NOT excluded.tsym OR broker_order_state.exch IS NOT excluded.exch OR
    broker_order_state.prd IS NOT excluded.prd OR broker_order_state.side IS NOT excluded.side OR
    broker_order_state.quantity IS NOT excluded.quantity OR
    broker_order_state.filled_quantity IS NOT excluded.filled_quantity OR
    broker_order_state.remaining_quantity IS NOT excluded.remaining_quantity OR
    broker_order_state.average_fill_price IS NOT excluded.average_fill_price OR
    broker_order_state.status IS NOT excluded.status`);
  const brokerOrder = db.prepare(`SELECT order_id, tsym, exch, prd, side, quantity, filled_quantity,
    remaining_quantity, average_fill_price, status FROM broker_order_state
    WHERE account = ? AND order_id = ?`);
  const lease = db.prepare(`INSERT INTO reconciliation_lease (name, owner, expires_at)
    VALUES ('broker', ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE reconciliation_lease.expires_at <= ? OR reconciliation_lease.owner = ?`);
  const renewLease = db.prepare(`UPDATE reconciliation_lease SET expires_at = ?
    WHERE name = 'broker' AND owner = ?`);
  const releaseLease = db.prepare("DELETE FROM reconciliation_lease WHERE name = 'broker' AND owner = ?");
  const suspendRule = db.prepare(`UPDATE risk_rule SET status = 'reconciliation_required', message = ?, rev = rev + 1,
    updated_at = ? WHERE tsym = ? AND status IN ('armed', 'triggered', 'exit_pending',
      'exit_partially_filled', 'reconciliation_in_progress')`);
  const begin = db.prepare(`UPDATE risk_rule SET status = 'reconciliation_in_progress', rev = rev + 1, updated_at = ?
    WHERE tsym = ? AND status = 'armed'`);
  const sameOpening = (previous, product, opening, rule) => previous &&
    previous.instrument === rule.instrument && previous.product === product &&
    previous.opening_order_id === opening.openingOrderId &&
    previous.opening_fill_id === opening.openingFillId && previous.opening_price === opening.openingPrice;

  return {
    get(tsym) {
      const row = selectOne.get(tsym, Date.now());
      return row ? toRule(row) : null;
    },
    list: () => selectAll.all(Date.now()).map(toRule),
    save(rule) {
      if (reconciliation.get(rule.tsym)) {
        throw Object.assign(new Error("ACTION REQUIRED: automatic recovery cannot verify this position lifecycle"),
          { status: 409, code: "RECONCILIATION_REQUIRED" });
      }
      const now = Date.now();
      const rev = (selectRev.get(rule.tsym)?.rev ?? 0) + 1;
      upsert.run(rule.tsym, rule.instrument, rule.side, rule.entry, rule.mode, rule.slPrice, rule.slPoints,
        rule.targetPrice, rule.trailPoints, rev, nextExpiry(now), now, rule.monitor);
      return rev;
    },
    saveDefault(account, product, opening, rule, expectedRev) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (reconciliation.get(rule.tsym)) {
          throw Object.assign(new Error("ACTION REQUIRED: automatic recovery cannot verify this position lifecycle"), { status: 409, code: "RECONCILIATION_REQUIRED" });
        }
        const existing = this.get(rule.tsym);
        if ((existing?.rev ?? null) !== expectedRev || existing?.status === "triggered") {
          throw Object.assign(new Error("Rule changed during position reconciliation"), { status: 409 });
        }
        const previous = lifecycle.get(account, rule.tsym);
        const sameLifecycle = sameOpening(previous, product, opening, rule);
        if (sameLifecycle && existing && !["armed", "reconciliation_in_progress"].includes(existing.status)) {
          throw Object.assign(new Error("Previous exit requires reconciliation before protection can be rearmed"), { status: 409 });
        }
        if (sameLifecycle && ["armed", "reconciliation_in_progress"].includes(existing?.status) &&
            existing.side === rule.side && existing.entry === opening.openingPrice) {
          if (existing.status === "reconciliation_in_progress") this.save(existing);
          const restored = this.get(rule.tsym);
          clearReconciliation.run(account, rule.tsym);
          db.exec("COMMIT");
          return restored;
        }
        const rev = this.save(rule);
        saveLifecycle.run(account, rule.tsym, rule.instrument, product,
          opening.openingOrderId, opening.openingFillId, opening.openingPrice);
        clearReconciliation.run(account, rule.tsym);
        db.exec("COMMIT");
        return { ...rule, status: "armed", rev };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    saveManual(account, product, opening, rule, expectedRev, kind) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (reconciliation.get(rule.tsym)) {
          throw Object.assign(new Error("ACTION REQUIRED: automatic recovery cannot verify this position lifecycle"), { status: 409, code: "RECONCILIATION_REQUIRED" });
        }
        const existing = this.get(rule.tsym);
        if ((existing?.rev ?? null) !== expectedRev || existing?.status === "triggered") {
          throw Object.assign(new Error("Rule changed during position reconciliation"), { status: 409 });
        }
        const sameLifecycle = sameOpening(lifecycle.get(account, rule.tsym), product, opening, rule);
        if (sameLifecycle && existing && !["armed", "reconciliation_in_progress"].includes(existing.status)) {
          throw Object.assign(new Error("Previous exit requires reconciliation before protection can be rearmed"), { status: 409 });
        }
        let next = rule;
        if (sameLifecycle && ["armed", "reconciliation_in_progress"].includes(existing?.status) &&
            existing.side === rule.side && existing.entry === opening.openingPrice) {
          if (kind === "stop") {
            if (rule.mode === "trailing_sl" && existing.mode === "target_trail") {
              throw Object.assign(new Error("Remove target trailing before using a trailing stop-loss"), { status: 409 });
            }
            next = { ...existing, slPrice: rule.slPrice, slPoints: rule.slPoints,
              mode: rule.mode === "trailing_sl" ? "trailing_sl" :
                existing.mode === "target_trail" ? "target_trail" : "static" };
          } else {
            if (rule.mode === "target_trail" && (existing.slPrice === null || existing.mode === "trailing_sl")) {
              throw Object.assign(new Error("Target trailing requires a fixed stop-loss"), { status: 409 });
            }
            next = { ...existing, targetPrice: rule.targetPrice, trailPoints: rule.trailPoints,
              mode: rule.mode === "target_trail" ? "target_trail" :
                existing.mode === "target_trail" ? "static" : existing.mode };
          }
        } else if (rule.mode === "target_trail") {
          throw Object.assign(new Error("Target trailing requires a reconciled stop-loss"), { status: 409 });
        }
        next = validateRule(rule.tsym, next);
        const rev = this.save(next);
        saveLifecycle.run(account, rule.tsym, rule.instrument, product,
          opening.openingOrderId, opening.openingFillId, opening.openingPrice);
        clearReconciliation.run(account, rule.tsym);
        db.exec("COMMIT");
        return { ...next, status: "armed", rev };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    beginReconciliation(tsym) {
      const current = this.get(tsym);
      if (current?.status === "reconciliation_in_progress") {
        throw Object.assign(new Error("Position reconciliation is already in progress"), { status: 409 });
      }
      if (current?.status === "triggered") {
        this.markReconciliationRequired("", tsym, current.rev,
          "Position needs reconciliation: an automatic exit is already in progress");
        throw Object.assign(new Error("An automatic exit is already in progress"), { status: 409 });
      }
      begin.run(Date.now(), tsym);
      return this.get(tsym)?.rev ?? null;
    },
    markReconciliationRequired(account, tsym, expectedRev, reason) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now();
        flagReconciliation.run(account || "", tsym, reason, now);
        suspendRule.run(`${reason}; previous rule suspended pending automatic recovery.`, now, tsym);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listReconciliation(account) {
      const rows = account ? reconciliationList.all(account) : db.prepare(
        "SELECT tsym, reason, updated_at, recovery_status FROM risk_reconciliation ORDER BY updated_at").all();
      return rows.map((row) => ({
        tsym: row.tsym, status: "RECONCILIATION_REQUIRED", recoveryStatus: row.recovery_status,
        message: row.reason, updatedAt: row.updated_at,
      }));
    },
    getLifecycle(account, tsym) {
      return lifecycle.get(account, tsym) ?? null;
    },
    getExitOrderId(account, tsym) {
      return exitOrder.get(account || "", tsym)?.order_id ?? null;
    },
    recordExitOrder(account, tsym, orderId) {
      if (typeof orderId !== "string" || !orderId) return false;
      saveExitOrder.run(account || "", tsym, orderId, Date.now());
      return true;
    },
    recordBrokerOrders(account, orders) {
      let changed = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const order of orders) {
          const result = recordBrokerOrder.run(account || "", order.orderId, order.tsym, order.exch, order.prd,
            order.side, order.quantity, order.filledQuantity, order.remainingQuantity,
            order.averageFillPrice, order.status, Date.now());
          changed += result.changes;
        }
        db.exec("COMMIT");
        return changed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getBrokerOrder(account, orderId) {
      return brokerOrder.get(account || "", orderId) ?? null;
    },
    finishExit(account, tsym, expectedRev, orderId, message) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const updated = db.prepare(`UPDATE risk_rule SET status = 'exit_pending', message = ?, rev = rev + 1, updated_at = ?
          WHERE tsym = ? AND rev = ? AND status = 'triggered'`)
          .run(message, Date.now(), tsym, expectedRev).changes > 0;
        if (updated && typeof orderId === "string" && orderId) {
          saveExitOrder.run(account || "", tsym, orderId, Date.now());
        }
        db.exec("COMMIT");
        return updated;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    adoptActiveExitOrder(account, tsym, expectedRev, orderId, message) {
      if (typeof orderId !== "string" || !orderId) return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const updated = db.prepare(`UPDATE risk_rule SET status = 'exit_pending', message = ?, rev = rev + 1, updated_at = ?
          WHERE tsym = ? AND rev = ? AND status = 'triggered'`)
          .run(message, Date.now(), tsym, expectedRev).changes > 0;
        if (updated) saveExitOrder.run(account || "", tsym, orderId, Date.now());
        db.exec("COMMIT");
        return updated;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    adoptBrokerExitOrder(account, tsym, expectedRev, orderId, status, message) {
      if (typeof orderId !== "string" || !orderId ||
          !["exit_pending", "exit_partially_filled"].includes(status)) return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const updated = db.prepare(`UPDATE risk_rule SET status = ?, message = ?, rev = rev + 1, updated_at = ?
          WHERE tsym = ? AND rev = ? AND status IN
          ('armed', 'reconciliation_required', 'exit_pending', 'exit_partially_filled')`)
          .run(status, message, Date.now(), tsym, expectedRev).changes > 0;
        if (updated) {
          saveExitOrder.run(account || "", tsym, orderId, Date.now());
          clearReconciliation.run(account || "", tsym);
          clearReconciliation.run("", tsym);
        }
        db.exec("COMMIT");
        return updated;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    setRecoveryStatus(account, tsym, status, reason) {
      if (!["RECOVERING", "ACTION_REQUIRED"].includes(status)) {
        throw new Error("Invalid reconciliation recovery status");
      }
      const current = reconciliationOne.get(account || "", tsym);
      if (!current || (current.recovery_status === status && current.reason === reason)) return false;
      return setRecovery.run(status, reason, Date.now(), account || "", tsym).changes > 0;
    },
    flagUnprotectedPosition(account, tsym, reason) {
      const current = reconciliationOne.get(account || "", tsym);
      if (current?.recovery_status === "ACTION_REQUIRED" && current.reason === reason) return false;
      flagReconciliation.run(account || "", tsym, reason, Date.now());
      return this.setRecoveryStatus(account || "", tsym, "ACTION_REQUIRED", reason);
    },
    restoreReconciledRule(account, tsym, expectedRev, position, opening) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.get(tsym);
        const previous = lifecycle.get(account, tsym);
        if (!current || current.rev !== expectedRev ||
            !["reconciliation_required", "exit_pending", "exit_partially_filled"].includes(current.status) ||
            !sameOpening(previous, position.prd, opening, current) ||
            current.side !== opening.side || current.entry !== opening.openingPrice) {
          db.exec("ROLLBACK");
          return false;
        }
        const updated = db.prepare(`UPDATE risk_rule SET status = 'armed', message = NULL, rev = rev + 1, updated_at = ?
          WHERE tsym = ? AND rev = ? AND status IN
          ('reconciliation_required', 'exit_pending', 'exit_partially_filled')`)
          .run(Date.now(), tsym, expectedRev).changes > 0;
        if (!updated) {
          db.exec("ROLLBACK");
          return false;
        }
        clearReconciliation.run(account || "", tsym);
        clearReconciliation.run("", tsym);
        removeExitOrder.run(account || "", tsym);
        removeExitOrder.run("", tsym);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    closeReconciledRule(account, tsym, expectedRev) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`UPDATE risk_rule SET status = 'closed', message = NULL, rev = rev + 1,
          updated_at = ? WHERE tsym = ? AND rev = ? AND status IN
          ('armed', 'exit_pending', 'exit_partially_filled', 'reconciliation_required')`)
          .run(Date.now(), tsym, expectedRev);
        if (result.changes) {
          clearReconciliation.run(account || "", tsym);
          clearReconciliation.run("", tsym);
          removeExitOrder.run(account || "", tsym);
          removeExitOrder.run("", tsym);
        }
        db.exec("COMMIT");
        return result.changes > 0;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    confirmExitOrder(account, tsym, expectedRev, status, message) {
      if (!["exit_pending", "exit_partially_filled"].includes(status)) {
        throw new Error("Invalid confirmed exit status");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.get(tsym);
        if (!current || current.rev !== expectedRev ||
            !["reconciliation_required", "exit_pending", "exit_partially_filled"].includes(current.status)) {
          db.exec("ROLLBACK");
          return false;
        }
        if (current.status !== status || current.message !== message) {
          db.prepare("UPDATE risk_rule SET status = ?, message = ?, rev = rev + 1, updated_at = ? WHERE tsym = ? AND rev = ?")
            .run(status, message, Date.now(), tsym, expectedRev);
        }
        clearReconciliation.run(account || "", tsym);
        clearReconciliation.run("", tsym);
        if (status === "exit_pending" || status === "exit_partially_filled") {
          const orderId = this.getExitOrderId(account, tsym);
          if (orderId) saveExitOrder.run(account || "", tsym, orderId, Date.now());
        }
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    claimReconciliationLease(owner, now, leaseMs) {
      return lease.run(owner, now + leaseMs, now, owner).changes > 0;
    },
    renewReconciliationLease(owner, expiresAt) {
      return renewLease.run(expiresAt, owner).changes > 0;
    },
    releaseReconciliationLease(owner) {
      return releaseLease.run(owner).changes > 0;
    },
    clearReconciliationForSymbol(account, tsym) {
      const own = clearReconciliation.run(account || "", tsym).changes;
      const shared = account ? clearReconciliation.run("", tsym).changes : 0;
      return own + shared > 0;
    },
    suspendAll(account, reason) {
      for (const rule of this.list()) {
        if (["armed", "triggered", "exit_pending", "exit_partially_filled",
          "reconciliation_in_progress"].includes(rule.status)) {
          const detail = `${reason}; prior status=${rule.status}` +
            (rule.message ? `; ${rule.message}` : "");
          this.markReconciliationRequired(account, rule.tsym, rule.rev, detail);
        }
      }
    },
    suspendOnStartup(account) {
      this.suspendAll(account, "Position needs reconciliation: protection was suspended after backend restart");
    },
    canSubmit(tsym, rev) {
      const rule = this.get(tsym);
      return rule?.status === "triggered" && rule.rev === rev && !reconciliation.get(tsym);
    },
    matchesLifecycle(account, position, opening, rule) {
      return Boolean(rule.instrument === `${position.exch}|${position.token}` &&
        sameOpening(lifecycle.get(account, rule.tsym), position.prd, opening, rule) &&
        rule.side === opening.side && rule.entry === opening.openingPrice);
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
