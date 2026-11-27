const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const LOT_COLUMNS = `lot_id, position_id, account, symbol, exchange, product_type, side,
  quantity, remaining_quantity, entry_order_id, entry_average_price, exit_order_ids,
  exit_average_price, stop_loss, target, trailing_stop_loss, realized_pnl, unrealized_pnl,
  status, legacy, entry_timestamp, exit_timestamp, protection_enabled, highest_favourable_price,
  trailing_activation_threshold, trailing_distance, trailing_step, trailing_active,
  execution_intent_id, reserved_quantity, broker_order_id, execution_message,
  protection_state, created_at, updated_at`;

function createLotLedger(directory) {
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("An absolute state directory is required for lot positions");
  }
  const file = path.join(directory, "lot-positions.sqlite");
  fs.closeSync(fs.openSync(file, "a", 0o600));
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS lot_position (
    lot_id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    account TEXT NOT NULL,
    symbol TEXT NOT NULL,
    exchange TEXT NOT NULL,
    product_type TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    remaining_quantity INTEGER NOT NULL,
    entry_order_id TEXT,
    entry_average_price REAL,
    exit_order_ids TEXT NOT NULL DEFAULT '[]',
    exit_average_price REAL,
    stop_loss REAL,
    target REAL,
    trailing_stop_loss REAL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    unrealized_pnl REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    legacy INTEGER NOT NULL DEFAULT 0,
    entry_timestamp INTEGER,
    exit_timestamp INTEGER,
    protection_enabled INTEGER NOT NULL DEFAULT 1,
    highest_favourable_price REAL,
    trailing_activation_threshold REAL,
    trailing_distance REAL,
    trailing_step REAL,
    trailing_active INTEGER NOT NULL DEFAULT 0,
    execution_intent_id TEXT,
    reserved_quantity INTEGER NOT NULL DEFAULT 0,
    broker_order_id TEXT,
    execution_message TEXT,
    protection_state TEXT NOT NULL DEFAULT 'OPEN',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const migrations = {
    protection_enabled: "ALTER TABLE lot_position ADD COLUMN protection_enabled INTEGER NOT NULL DEFAULT 1",
    highest_favourable_price: "ALTER TABLE lot_position ADD COLUMN highest_favourable_price REAL",
    trailing_activation_threshold: "ALTER TABLE lot_position ADD COLUMN trailing_activation_threshold REAL",
    trailing_distance: "ALTER TABLE lot_position ADD COLUMN trailing_distance REAL",
    trailing_step: "ALTER TABLE lot_position ADD COLUMN trailing_step REAL",
    trailing_active: "ALTER TABLE lot_position ADD COLUMN trailing_active INTEGER NOT NULL DEFAULT 0",
    execution_intent_id: "ALTER TABLE lot_position ADD COLUMN execution_intent_id TEXT",
    reserved_quantity: "ALTER TABLE lot_position ADD COLUMN reserved_quantity INTEGER NOT NULL DEFAULT 0",
    broker_order_id: "ALTER TABLE lot_position ADD COLUMN broker_order_id TEXT",
    execution_message: "ALTER TABLE lot_position ADD COLUMN execution_message TEXT",
    protection_state: "ALTER TABLE lot_position ADD COLUMN protection_state TEXT NOT NULL DEFAULT 'OPEN'",
  };
  const columns = new Set(db.prepare("PRAGMA table_info(lot_position)").all().map((column) => column.name));
  for (const [name, sql] of Object.entries(migrations)) {
    if (!columns.has(name)) db.exec(sql);
  }
  const selectSymbol = db.prepare(`SELECT ${LOT_COLUMNS} FROM lot_position
    WHERE account = ? AND symbol = ? ORDER BY created_at, lot_id`);
  const selectAll = db.prepare(`SELECT ${LOT_COLUMNS} FROM lot_position
    WHERE account = ? ORDER BY symbol, created_at, lot_id`);
  const upsert = db.prepare(`INSERT INTO lot_position (
    lot_id, position_id, account, symbol, exchange, product_type, side,
    quantity, remaining_quantity, entry_order_id, entry_average_price, exit_order_ids,
    exit_average_price, stop_loss, target, trailing_stop_loss, realized_pnl, unrealized_pnl,
    status, legacy, entry_timestamp, exit_timestamp,
    protection_enabled, highest_favourable_price, trailing_activation_threshold,
    trailing_distance, trailing_step, trailing_active, execution_intent_id,
    reserved_quantity, broker_order_id, execution_message, protection_state,
    created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lot_id) DO UPDATE SET position_id=excluded.position_id,
    quantity=excluded.quantity, remaining_quantity=excluded.remaining_quantity,
    entry_order_id=excluded.entry_order_id, entry_average_price=excluded.entry_average_price,
    exit_order_ids=excluded.exit_order_ids, exit_average_price=excluded.exit_average_price,
    stop_loss=excluded.stop_loss, target=excluded.target,
    trailing_stop_loss=excluded.trailing_stop_loss, realized_pnl=excluded.realized_pnl,
    unrealized_pnl=excluded.unrealized_pnl, status=excluded.status,
    legacy=excluded.legacy, entry_timestamp=excluded.entry_timestamp,
    exit_timestamp=excluded.exit_timestamp,
    protection_enabled=excluded.protection_enabled,
    highest_favourable_price=excluded.highest_favourable_price,
    trailing_activation_threshold=excluded.trailing_activation_threshold,
    trailing_distance=excluded.trailing_distance,
    trailing_step=excluded.trailing_step,
    trailing_active=excluded.trailing_active,
    execution_intent_id=excluded.execution_intent_id,
    reserved_quantity=excluded.reserved_quantity,
    broker_order_id=excluded.broker_order_id,
    execution_message=excluded.execution_message,
    protection_state=excluded.protection_state,
    updated_at=excluded.updated_at`);

  const toLot = (row) => ({
    lotId: row.lot_id,
    positionId: row.position_id,
    account: row.account,
    symbol: row.symbol,
    exchange: row.exchange,
    productType: row.product_type,
    side: row.side,
    quantity: row.quantity,
    remainingQuantity: row.remaining_quantity,
    entryOrderId: row.entry_order_id,
    entryAveragePrice: row.entry_average_price,
    exitOrderIds: JSON.parse(row.exit_order_ids || "[]"),
    exitAveragePrice: row.exit_average_price,
    stopLoss: row.stop_loss,
    target: row.target,
    trailingStopLoss: row.trailing_stop_loss,
    realizedPnl: row.realized_pnl,
    unrealizedPnl: row.unrealized_pnl,
    status: row.status,
    legacy: Boolean(row.legacy),
    entryTimestamp: row.entry_timestamp,
    exitTimestamp: row.exit_timestamp,
    protectionEnabled: Boolean(row.protection_enabled),
    highestFavourablePrice: row.highest_favourable_price,
    trailingActivationThreshold: row.trailing_activation_threshold,
    trailingDistance: row.trailing_distance,
    trailingStep: row.trailing_step,
    trailingActive: Boolean(row.trailing_active),
    executionIntentId: row.execution_intent_id,
    reservedQuantity: row.reserved_quantity,
    brokerOrderId: row.broker_order_id,
    executionMessage: row.execution_message,
    protectionState: row.protection_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    list(account) {
      return selectAll.all(account || "").map(toLot);
    },
    listBySymbol(account, symbol) {
      return selectSymbol.all(account || "", symbol).map(toLot);
    },
    get(account, lotId) {
      const row = db.prepare(`SELECT ${LOT_COLUMNS} FROM lot_position
        WHERE account = ? AND lot_id = ?`).get(account || "", lotId);
      return row ? toLot(row) : null;
    },
    save(account, lot) {
      const now = Date.now();
      const quantity = Number(lot.quantity);
      const remainingQuantity = Number(lot.remainingQuantity);
      const side = lot.side === "BUY" ? "long" : lot.side === "SELL" ? "short" : lot.side;
      if (!lot.lotId || !lot.positionId || !lot.symbol || !lot.exchange ||
          !lot.productType || !["long", "short"].includes(side) ||
          !Number.isSafeInteger(quantity) || quantity <= 0 ||
          !Number.isSafeInteger(remainingQuantity) || remainingQuantity < 0 ||
          remainingQuantity > quantity) {
        throw Object.assign(new Error("Invalid lot position"), { status: 400 });
      }
      upsert.run(
        lot.lotId, lot.positionId, account || "", lot.symbol, lot.exchange,
        lot.productType, side, quantity, remainingQuantity,
        lot.entryOrderId || null, lot.entryAveragePrice == null ? null : Number(lot.entryAveragePrice),
        JSON.stringify(Array.isArray(lot.exitOrderIds) ? lot.exitOrderIds : []),
        lot.exitAveragePrice == null ? null : Number(lot.exitAveragePrice),
        lot.stopLoss == null ? null : Number(lot.stopLoss),
        lot.target == null ? null : Number(lot.target),
        lot.trailingStopLoss == null ? null : Number(lot.trailingStopLoss),
        Number(lot.realizedPnl) || 0, Number(lot.unrealizedPnl) || 0,
        lot.status || (remainingQuantity === 0 ? "closed" : "open"),
        lot.legacy ? 1 : 0, lot.entryTimestamp || null, lot.exitTimestamp || null,
        lot.protectionEnabled == null ? 1 : lot.protectionEnabled ? 1 : 0,
        lot.highestFavourablePrice == null ? null : Number(lot.highestFavourablePrice),
        lot.trailingActivationThreshold == null ? null : Number(lot.trailingActivationThreshold),
        lot.trailingDistance == null ? null : Number(lot.trailingDistance),
        lot.trailingStep == null ? null : Number(lot.trailingStep),
        lot.trailingActive ? 1 : 0,
        lot.executionIntentId || null,
        Number(lot.reservedQuantity) || 0,
        lot.brokerOrderId || null,
        lot.executionMessage || null,
        lot.protectionState || "OPEN",
        lot.createdAt || now, now,
      );
      return this.listBySymbol(account, lot.symbol).find((item) => item.lotId === lot.lotId);
    },
    updateProtection(account, lotId, patch) {
      const existing = this.get(account, lotId);
      if (!existing) return null;
      const now = Date.now();
      const fields = [];
      const values = [];
      if ("stopLoss" in patch) { fields.push("stop_loss = ?"); values.push(patch.stopLoss == null ? null : Number(patch.stopLoss)); }
      if ("target" in patch) { fields.push("target = ?"); values.push(patch.target == null ? null : Number(patch.target)); }
      if ("trailingStopLoss" in patch) { fields.push("trailing_stop_loss = ?"); values.push(patch.trailingStopLoss == null ? null : Number(patch.trailingStopLoss)); }
      if ("protectionEnabled" in patch) { fields.push("protection_enabled = ?"); values.push(patch.protectionEnabled ? 1 : 0); }
      if ("highestFavourablePrice" in patch) { fields.push("highest_favourable_price = ?"); values.push(patch.highestFavourablePrice == null ? null : Number(patch.highestFavourablePrice)); }
      if ("trailingActivationThreshold" in patch) { fields.push("trailing_activation_threshold = ?"); values.push(patch.trailingActivationThreshold == null ? null : Number(patch.trailingActivationThreshold)); }
      if ("trailingDistance" in patch) { fields.push("trailing_distance = ?"); values.push(patch.trailingDistance == null ? null : Number(patch.trailingDistance)); }
      if ("trailingStep" in patch) { fields.push("trailing_step = ?"); values.push(patch.trailingStep == null ? null : Number(patch.trailingStep)); }
      if ("trailingActive" in patch) { fields.push("trailing_active = ?"); values.push(patch.trailingActive ? 1 : 0); }
      if ("protectionState" in patch) { fields.push("protection_state = ?"); values.push(String(patch.protectionState)); }
      if (!fields.length) return existing;
      fields.push("updated_at = ?");
      values.push(now, account || "", lotId);
      const result = db.prepare(`UPDATE lot_position SET ${fields.join(", ")}
        WHERE account = ? AND lot_id = ?`).run(...values);
      return result.changes ? this.get(account, lotId) : existing;
    },
    reserveExit(account, lotId, intentId) {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const lot = this.get(account, lotId);
        if (!lot || lot.remainingQuantity <= 0) {
          db.exec("ROLLBACK");
          return { reserved: false, reason: "Lot is closed or unavailable", lot };
        }
        if (lot.executionIntentId && ["EXIT_PENDING", "EXIT_PARTIALLY_FILLED"].includes(lot.status)) {
          db.exec("ROLLBACK");
          return { reserved: false, reason: "Lot already has an active exit", lot };
        }
        const quantity = lot.remainingQuantity;
        const result = db.prepare(`UPDATE lot_position SET reserved_quantity = ?, execution_intent_id = ?,
          status = 'EXIT_PENDING', protection_state = 'EXIT_PENDING', execution_message = ?,
          updated_at = ? WHERE account = ? AND lot_id = ?`)
          .run(quantity, intentId, "Exit quantity reserved before broker submission", now, account || "", lotId);
        db.exec("COMMIT");
        return result.changes ? { reserved: true, quantity, intentId, lot: this.get(account, lotId) }
          : { reserved: false, reason: "Lot reservation changed", lot };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    recordBrokerExit(account, lotId, intentId, brokerOrderId, message) {
      const now = Date.now();
      return db.prepare(`UPDATE lot_position SET broker_order_id = ?, execution_intent_id = ?,
        status = 'EXIT_PENDING', protection_state = 'EXIT_PENDING', execution_message = ?, updated_at = ?
        WHERE account = ? AND lot_id = ? AND execution_intent_id = ?`)
        .run(brokerOrderId, intentId, message, now, account || "", lotId, intentId).changes > 0;
    },
    releaseExit(account, lotId, message) {
      const now = Date.now();
      return db.prepare(`UPDATE lot_position SET status = 'OPEN', protection_state = 'PROTECTED',
        reserved_quantity = 0, execution_intent_id = NULL, broker_order_id = NULL,
        execution_message = ?, updated_at = ? WHERE account = ? AND lot_id = ?`)
        .run(message, now, account || "", lotId).changes > 0;
    },
    updateExitFill(account, lotId, filledQuantity, averageFillPrice, status, message) {
      const lot = this.get(account, lotId);
      if (!lot || filledQuantity < 0 || filledQuantity > lot.remainingQuantity) return false;
      const now = Date.now();
      const remaining = lot.remainingQuantity - filledQuantity;
      const exitedQuantity = lot.quantity - remaining;
      const previousExitQuantity = lot.quantity - lot.remainingQuantity;
      const previousExitAverage = lot.exitAveragePrice;
      const newExitAverage = previousExitQuantity > 0 && previousExitAverage != null
        ? (previousExitAverage * previousExitQuantity + Number(averageFillPrice) * filledQuantity) /
          (previousExitQuantity + filledQuantity)
        : Number(averageFillPrice);
      const sign = lot.side === "long" ? 1 : -1;
      const realized = Number.isFinite(newExitAverage) && lot.entryAveragePrice != null
        ? (newExitAverage - lot.entryAveragePrice) * (exitedQuantity) * sign
        : lot.realizedPnl;
      const nextStatus = remaining === 0 ? "EXIT_COMPLETED" : status;
      const previousExitIds = Array.isArray(lot.exitOrderIds) ? [...lot.exitOrderIds] : [];
      if (lot.brokerOrderId && !previousExitIds.includes(lot.brokerOrderId)) {
        previousExitIds.push(lot.brokerOrderId);
      }
      return db.prepare(`UPDATE lot_position SET remaining_quantity = ?, exit_average_price = ?,
        exit_order_ids = ?,
        realized_pnl = ?, status = ?, protection_state = ?, reserved_quantity = ?,
        execution_message = ?, exit_timestamp = ?, updated_at = ?
        WHERE account = ? AND lot_id = ?`)
        .run(remaining, newExitAverage, JSON.stringify(previousExitIds),
          realized, nextStatus,
          remaining === 0 ? "CLOSED" : "PROTECTED",
          remaining === 0 ? 0 : lot.reservedQuantity - filledQuantity,
          message, remaining === 0 ? now : lot.exitTimestamp,
          now, account || "", lotId).changes > 0;
    },
    close(account, lotId) {
      const now = Date.now();
      return db.prepare(`UPDATE lot_position SET remaining_quantity = 0, status = 'closed',
        exit_timestamp = ?, updated_at = ? WHERE account = ? AND lot_id = ?`)
        .run(now, now, account || "", lotId).changes > 0;
    },
    remove(account, lotId) {
      return db.prepare("DELETE FROM lot_position WHERE account = ? AND lot_id = ?")
        .run(account || "", lotId).changes > 0;
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createLotLedger };
