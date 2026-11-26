const assert = require("node:assert/strict");
const { test } = require("node:test");
const { reconstructOpeningFill } = require("../positionLifecycle");

const position = (buy, sell, carryBuy = 0, carrySell = 0) => ({
  tsym: "NIFTYCE", exch: "NFO", prd: "M", token: "123",
  daybuyqty: String(buy), daysellqty: String(sell),
  cfbuyqty: String(carryBuy), cfsellqty: String(carrySell),
  netqty: String(carryBuy - carrySell + buy - sell),
});
const fill = (id, side, qty, price, time) => ({
  tsym: "NIFTYCE", exch: "NFO", prd: "M", norenordno: id, flid: id,
  trantype: side, flqty: String(qty), flprc: String(price),
  fltm: `26-11-2026 ${time}`,
});
const resolve = (p, trades) => reconstructOpeningFill(p, trades, "2026-11-26");

test("first fill survives additional entries and partial exits", () => {
  const trades = [
    fill("1", "B", 75, 150, "09:15:00"),
    fill("2", "B", 75, 200, "09:20:00"),
    fill("3", "S", 75, 210, "09:25:00"),
  ];
  assert.deepEqual(resolve(position(150, 75), trades), {
    status: "open", side: "long", quantity: 75, openingOrderId: "1",
    openingFillId: "1", openingPrice: 150,
  });
  assert.deepEqual(resolve(position(150, 75), [...trades].reverse()).openingPrice, 150);
});

test("full exits, reversals, and repeated cycles create new lifecycles", () => {
  const trades = [
    fill("1", "B", 75, 100, "09:15:00"),
    fill("2", "S", 75, 120, "09:20:00"),
    fill("3", "B", 75, 150, "09:25:00"),
    fill("4", "S", 150, 140, "09:30:00"),
  ];
  assert.equal(resolve(position(150, 75), trades.slice(0, 3)).openingPrice, 150);
  const short = resolve(position(150, 225), trades);
  assert.equal(short.side, "short");
  assert.equal(short.openingOrderId, "4");
  assert.equal(short.openingPrice, 140);
  assert.deepEqual(resolve(position(75, 75), trades.slice(0, 2)), { status: "flat" });
});

test("fails closed for missing, invalid, duplicate, or ambiguous fills", () => {
  const valid = fill("1", "B", 75, 150, "09:15:00");
  for (const [p, trades] of [
    [position(75, 0), []],
    [position(75, 0), [null]],
    [position(150, 0), [valid, valid]],
    [position(75, 0), [{ ...valid, flprc: "0" }]],
    [position(75, 0), [{ ...valid, fltm: "bad" }]],
    [position(150, 0), [valid, fill("2", "B", 75, 200, "09:15:00")]],
    [{ ...position(75, 0), daybuyqty: undefined }, [valid]],
    [{ ...position(75, 0), netqty: "150" }, [valid]],
  ]) {
    assert.throws(() => resolve(p, trades), /reconciliation/i);
  }
});

test("refuses an unidentified carry-forward position and ignores unrelated positions", () => {
  assert.throws(() => resolve(position(0, 0, 75), []), /reconciliation/i);
  const other = { ...fill("other", "B", 75, 500, "09:10:00"), prd: "I" };
  assert.equal(resolve(position(75, 0), [other, fill("1", "B", 75, 150, "09:15:00")]).openingPrice, 150);
});
