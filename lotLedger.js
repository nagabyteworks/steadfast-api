const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const LOT_COLUMNS = `lot_id, position_id, account, symbol, exchange, product_type, side,
  quantity, remaining_quantity, entry_order_id, entry_average_price, exit_order_ids,
  exit_average_price, stop_loss, target, trailing_stop_loss, realized_pnl, unrealized_pnl,
  status, legacy, entry_timestamp, exit_timestamp, created_at, updated_at`;

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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const selectSymbol = db.prepare(`SELECT ${LOT_COLUMNS} FROM lot_position
    WHERE account = ? AND symbol = ? ORDER BY created_at, lot_id`);
  const selectAll = db.prepare(`SELECT ${LOT_COLUMNS} FROM lot_position
    WHERE account = ? ORDER BY symbol, created_at, lot_id`);
  const upsert = db.prepare(`INSERT INTO lot_position (
    lot_id, position_id, account, symbol, exchange, product_type, side,
    quantity, remaining_quantity, entry_order_id, entry_average_price, exit_order_ids,
    exit_average_price, stop_loss, target, trailing_stop_loss, realized_pnl, unrealized_pnl,
    status, legacy, entry_timestamp, exit_timestamp, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lot_id) DO UPDATE SET position_id=excluded.position_id,
    quantity=excluded.quantity, remaining_quantity=excluded.remaining_quantity,
    entry_order_id=excluded.entry_order_id, entry_average_price=excluded.entry_average_price,
    exit_order_ids=excluded.exit_order_ids, exit_average_price=excluded.exit_average_price,
    stop_loss=excluded.stop_loss, target=excluded.target,
    trailing_stop_loss=excluded.trailing_stop_loss, realized_pnl=excluded.realized_pnl,
    unrealized_pnl=excluded.unrealized_pnl, status=excluded.status,
    legacy=excluded.legacy, entry_timestamp=excluded.entry_timestamp,
    exit_timestamp=excluded.exit_timestamp, updated_at=excluded.updated_at`);

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
    save(account, lot) {
      const now = Date.now();
      const quantity = Number(lot.quantity);
      const remainingQuantity = Number(lot.remainingQuantity);
      if (!lot.lotId || !lot.positionId || !lot.symbol || !lot.exchange ||
          !lot.productType || !["long", "short"].includes(lot.side) ||
          !Number.isSafeInteger(quantity) || quantity <= 0 ||
          !Number.isSafeInteger(remainingQuantity) || remainingQuantity < 0 ||
          remainingQuantity > quantity) {
        throw Object.assign(new Error("Invalid lot position"), { status: 400 });
      }
      upsert.run(
        lot.lotId, lot.positionId, account || "", lot.symbol, lot.exchange,
        lot.productType, lot.side, quantity, remainingQuantity,
        lot.entryOrderId || null, lot.entryAveragePrice == null ? null : Number(lot.entryAveragePrice),
        JSON.stringify(Array.isArray(lot.exitOrderIds) ? lot.exitOrderIds : []),
        lot.exitAveragePrice == null ? null : Number(lot.exitAveragePrice),
        lot.stopLoss == null ? null : Number(lot.stopLoss),
        lot.target == null ? null : Number(lot.target),
        lot.trailingStopLoss == null ? null : Number(lot.trailingStopLoss),
        Number(lot.realizedPnl) || 0, Number(lot.unrealizedPnl) || 0,
        lot.status || (remainingQuantity === 0 ? "closed" : "open"),
        lot.legacy ? 1 : 0, lot.entryTimestamp || null, lot.exitTimestamp || null,
        lot.createdAt || now, now,
      );
      return this.listBySymbol(account, lot.symbol).find((item) => item.lotId === lot.lotId);
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
