function reconciliationError(detail) {
  return new Error(`Position needs reconciliation: ${detail}`);
}

function quantity(value, name, { signed = false } = {}) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw reconciliationError(`missing ${name}`);
  }
  if (typeof value === "string" && !/^-?\d+$/.test(value)) {
    throw reconciliationError(`invalid ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!signed && parsed < 0)) {
    throw reconciliationError(`invalid ${name}`);
  }
  return parsed;
}

function fillTime(value, tradingDay) {
  const match = typeof value === "string" &&
    /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw reconciliationError("invalid fill time");
  const [, day, month, year, hour, minute, second] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second));
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) ||
      date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second) ||
      `${year}-${month}-${day}` !== tradingDay) {
    throw reconciliationError("fill is outside the current trading day");
  }
  return timestamp;
}

function reconstructOpeningFill(position, tradeBook, tradingDay) {
  if (!position || typeof position.tsym !== "string" || !position.tsym ||
      typeof position.exch !== "string" || !position.exch ||
      typeof position.prd !== "string" || !position.prd ||
      !Array.isArray(tradeBook) || !/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) {
    throw reconciliationError("missing position identity or trade history");
  }

  const buys = quantity(position.daybuyqty, "day buy quantity");
  const sells = quantity(position.daysellqty, "day sell quantity");
  const carry = quantity(position.cfbuyqty, "carry buy quantity") -
    quantity(position.cfsellqty, "carry sell quantity");
  const net = quantity(position.netqty, "net quantity", { signed: true });
  if (!Number.isSafeInteger(carry + buys - sells) || carry + buys - sells !== net) {
    throw reconciliationError("broker position quantities disagree");
  }

  const fills = [];
  const seen = new Set();
  for (const trade of tradeBook) {
    if (!trade || typeof trade !== "object" || Array.isArray(trade)) {
      throw reconciliationError("invalid trade history");
    }
    if (trade.tsym !== position.tsym) continue;
    if (!trade.exch || !trade.prd) throw reconciliationError("trade identity is incomplete");
    if (trade.exch !== position.exch || trade.prd !== position.prd) continue;
    if (typeof trade.norenordno !== "string" || !trade.norenordno ||
        typeof trade.flid !== "string" || !trade.flid ||
        !["B", "S"].includes(trade.trantype)) {
      throw reconciliationError("trade execution identity is incomplete");
    }
    const key = JSON.stringify([trade.norenordno, trade.flid]);
    if (seen.has(key)) throw reconciliationError("duplicate fill");
    seen.add(key);
    const qty = quantity(trade.flqty, "fill quantity");
    const price = Number(trade.flprc);
    if (!qty || typeof trade.flprc !== "string" && typeof trade.flprc !== "number" ||
        !Number.isFinite(price) || price <= 0) {
      throw reconciliationError("invalid fill quantity or price");
    }
    fills.push({ key, orderId: trade.norenordno, fillId: trade.flid, qty, price,
      direction: trade.trantype === "B" ? 1 : -1, time: fillTime(trade.fltm, tradingDay) });
  }
  fills.sort((a, b) => a.time - b.time);
  let actualBuys = 0;
  let actualSells = 0;
  let current = carry;
  let opening = null;
  for (let i = 0; i < fills.length; i++) {
    const fill = fills[i];
    if (i && fills[i - 1].time === fill.time) {
      throw reconciliationError("fill ordering is ambiguous");
    }
    if (fill.direction === 1) actualBuys += fill.qty;
    else actualSells += fill.qty;
    const next = current + fill.direction * fill.qty;
    if (!Number.isSafeInteger(next) || !Number.isSafeInteger(actualBuys) || !Number.isSafeInteger(actualSells)) {
      throw reconciliationError("fill quantities overflow");
    }
    if (current === 0 || (next !== 0 && Math.sign(next) !== Math.sign(current))) opening = fill;
    if (next === 0) opening = null;
    current = next;
  }
  if (actualBuys !== buys || actualSells !== sells || current !== net) {
    throw reconciliationError("trade history does not match the position");
  }
  if (current === 0) return { status: "flat" };
  if (!opening) throw reconciliationError("opening fill is not in the available history");
  return {
    status: "open",
    side: current > 0 ? "long" : "short",
    quantity: Math.abs(current),
    openingOrderId: opening.orderId,
    openingFillId: opening.fillId,
    openingPrice: opening.price,
  };
}

module.exports = { reconstructOpeningFill };
