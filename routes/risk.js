const express = require("express");
const axios = require("axios");
const requireInternalToken = require("../middleware/requireInternalToken");
const { validateRule } = require("../riskStore");

const BROKER = "https://piconnect.flattrade.in/PiConnectAPI";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const encodeSymbol = (tsym) => encodeURIComponent(tsym).replace(/%20/g, "+")
  .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

async function findOpenPosition(session, tsym) {
  const payload = `jKey=${session.usersession}&jData=${JSON.stringify({ uid: session.userid, actid: session.userid })}`;
  const { data } = await axios.post(`${BROKER}/PositionBook`, payload, { headers: FORM, timeout: 10000 });
  if (!Array.isArray(data)) return null;
  return data.find((position) => position.tsym === tsym && Number(position.netqty) !== 0) || null;
}

// Flattrade rejects MKT orders from the API ("ALGO_CHK"), so exits are limit orders priced
// through the market by a small buffer to fill like a market order.
const EXIT_PRICE_BUFFER = 0.02;
function marketableLimitPrice(ltp, selling) {
  const price = Number(ltp);
  if (!Number.isFinite(price) || price <= 0) throw new Error("No live price for the exit order");
  const ticks = (price * (selling ? 1 - EXIT_PRICE_BUFFER : 1 + EXIT_PRICE_BUFFER)) / 0.05;
  return Math.max(0.05, (selling ? Math.floor(ticks) : Math.ceil(ticks)) * 0.05).toFixed(2);
}

async function submitExit(session, position, ltp) {
  const netQty = Number(position.netqty);
  const order = {
    uid: session.userid,
    actid: session.userid,
    exch: position.exch,
    tsym: encodeSymbol(position.tsym),
    qty: String(Math.abs(netQty)),
    prc: marketableLimitPrice(ltp, netQty > 0),
    prd: position.prd,
    trantype: netQty > 0 ? "S" : "B",
    prctyp: "LMT",
    ret: "DAY",
    ordersource: "API",
  };
  const { data } = await axios.post(`${BROKER}/PlaceOrder`, `jData=${JSON.stringify(order)}&jKey=${session.usersession}`,
    { headers: FORM, timeout: 10000 });
  if (data?.stat !== "Ok") throw new Error("Flattrade rejected the exit order");
  return order;
}

module.exports = ({ store, getSession, internalToken, dryRun, tradingEnabled = () => process.env.TRADING_ENABLED === "true" }) => {
  const router = express.Router();
  const internal = requireInternalToken(internalToken);
  const noStore = (res) => res.set("Cache-Control", "no-store");

  router.get("/rules", (req, res) => noStore(res).json({ dryRun, rules: store.list() }));

  router.put("/rules/:tsym", (req, res) => {
    try {
      const rule = validateRule(req.params.tsym, req.body);
      const rev = store.save(rule);
      noStore(res).json({ ...rule, status: "armed", rev });
    } catch (error) {
      res.status(error.status || 500).json({ message: error.status ? error.message : "Unable to save the rule" });
    }
  });

  // Partial edit applied to the latest stored state, so a trailing stop that moved since the
  // browser last refreshed is never overwritten by a stale value.
  router.patch("/rules/:tsym", (req, res) => {
    try {
      const existing = store.get(req.params.tsym);
      if (!existing || existing.status !== "armed") return res.status(404).json({ message: "No armed rule for this position" });
      const patch = req.body || {};
      const merged = { ...existing };
      for (const field of ["mode", "slPrice", "slPoints", "targetPrice", "trailPoints"]) {
        if (field in patch) merged[field] = patch[field];
      }
      const shift = (value, delta) => value === null || !Number.isFinite(Number(delta)) ? value : Number((value + Number(delta)).toFixed(2));
      if ("slDelta" in patch) merged.slPrice = shift(merged.slPrice, patch.slDelta);
      if ("targetDelta" in patch) merged.targetPrice = shift(merged.targetPrice, patch.targetDelta);
      const rule = validateRule(req.params.tsym, merged);
      const rev = store.save(rule);
      noStore(res).json({ ...rule, status: "armed", rev });
    } catch (error) {
      res.status(error.status || 500).json({ message: error.status ? error.message : "Unable to update the rule" });
    }
  });

  router.delete("/rules/:tsym", (req, res) => {
    store.remove(req.params.tsym);
    noStore(res).json({ removed: true });
  });

  // ===> Internal endpoints used by the WebSocket service
  router.get("/internal/rules", internal, (req, res) =>
    noStore(res).json({ rules: store.list().filter((rule) => rule.status === "armed") }));

  router.post("/internal/progress", internal, (req, res) => {
    const { tsym, rev, slPrice, targetPrice } = req.body || {};
    const valid = typeof tsym === "string" && Number.isSafeInteger(rev) && Number.isFinite(slPrice) &&
      (targetPrice === null || Number.isFinite(targetPrice));
    if (!valid) return res.status(400).json({ message: "Invalid progress update" });
    noStore(res).json({ applied: store.updateProgress(tsym, rev, slPrice, targetPrice) });
  });

  router.post("/internal/trigger", internal, async (req, res) => {
    const { tsym, reason, ltp } = req.body || {};
    if (typeof tsym !== "string" || typeof reason !== "string") {
      return res.status(400).json({ message: "Invalid trigger" });
    }
    if (!store.claim(tsym)) return noStore(res).json({ handled: false });

    const note = `${reason.slice(0, 40)} at ${Number(ltp)}`;
    try {
      const session = getSession();
      if (!session.usersession) {
        store.finish(tsym, "failed", `${note}: no broker session`);
        return noStore(res).json({ handled: true, status: "failed" });
      }
      const position = await findOpenPosition(session, tsym);
      if (!position) {
        store.finish(tsym, "cancelled", `${note}: no open position`);
        return noStore(res).json({ handled: true, status: "cancelled" });
      }
      const side = Number(position.netqty) > 0 ? "SELL" : "BUY";
      if (dryRun) {
        console.log(`DRY RUN: would ${side} ${Math.abs(Number(position.netqty))} ${tsym} (${note})`);
        store.finish(tsym, "dry_run", `${note}: dry run, no order sent`);
        return noStore(res).json({ handled: true, status: "dry_run" });
      }
      if (!tradingEnabled() || position.exch !== "NFO") {
        store.finish(tsym, "failed", `${note}: trading disabled or unsupported exchange`);
        return noStore(res).json({ handled: true, status: "failed" });
      }
      await submitExit(session, position, ltp);
      console.log(`Risk exit submitted for ${tsym}`);
      store.finish(tsym, "done", `${note}: exit order submitted`);
      noStore(res).json({ handled: true, status: "done" });
    } catch (error) {
      // The order may or may not have reached the broker, so it is never retried automatically.
      console.error("Risk exit failed", { tsym, code: error.code, status: error.response?.status });
      store.finish(tsym, "failed", `${note}: exit failed or uncertain; verify with Flattrade`);
      noStore(res).json({ handled: true, status: "failed" });
    }
  });

  return router;
};

module.exports.marketableLimitPrice = marketableLimitPrice;
