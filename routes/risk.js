const express = require("express");
const axios = require("axios");
const requireInternalToken = require("../middleware/requireInternalToken");
const { validateRule } = require("../riskStore");
const { reconstructOpeningFill } = require("../positionLifecycle");
const { asBook, getOrderState } = require("../reconciliationService");

const BROKER = "https://piconnect.flattrade.in/PiConnectAPI";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const encodeSymbol = (tsym) => encodeURIComponent(tsym).replace(/%20/g, "+")
  .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

async function reconcilePosition(session, tsym, tradingDay) {
  const payload = `jKey=${session.usersession}&jData=${JSON.stringify({ uid: session.userid, actid: session.userid })}`;
  const request = (name) => axios.post(`${BROKER}/${name}`, payload, { headers: FORM, timeout: 10000 });
  const before = (await request("PositionBook")).data;
  const trades = (await request("TradeBook")).data;
  const after = (await request("PositionBook")).data;
  const find = (book) => {
    if (!Array.isArray(book)) throw new Error("Position needs reconciliation: broker position book unavailable");
    const matching = book.filter((item) => item?.tsym === tsym);
    if (matching.length > 1) throw new Error("Position needs reconciliation: duplicate position records");
    if (matching.some((item) => !/^-?\d+$/.test(String(item.netqty)))) {
      throw new Error("Position needs reconciliation: invalid position quantity");
    }
    const open = matching.filter((item) => Number(item.netqty) !== 0);
    if (open.length !== 1) throw new Error("Position needs reconciliation: no unique open position");
    return open[0];
  };
  const first = find(before);
  const position = find(after);
  const fields = ["exch", "prd", "token", "netqty", "daybuyqty", "daysellqty", "cfbuyqty", "cfsellqty"];
  if (fields.some((field) => first[field] !== position[field])) {
    throw new Error("Position needs reconciliation: position changed during refresh");
  }
  let opening;
  try {
    opening = reconstructOpeningFill(position, trades, tradingDay);
  } catch (error) {
    const relevantTradeHistory = trades.filter((trade) =>
      trade?.tsym === position.tsym && trade?.exch === position.exch &&
      trade?.prd === position.prd);
    if (relevantTradeHistory.length !== 0) throw error;
    const netQuantity = Number(position.netqty);
    const netAverage = Number(position.netavgprc);
    const lastPrice = Number(position.lp);
    const fallbackEntry = Number.isFinite(netAverage) && netAverage > 0
      ? netAverage
      : Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : null;
    if (!Number.isSafeInteger(netQuantity) || netQuantity === 0 || fallbackEntry == null) {
      throw error;
    }
    opening = {
      status: "open",
      side: netQuantity > 0 ? "long" : "short",
      quantity: Math.abs(netQuantity),
      openingOrderId: "legacy-unavailable",
      openingFillId: "legacy-unavailable",
      openingPrice: Number(fallbackEntry.toFixed(4)),
      legacy: true,
    };
  }
  if (opening.status !== "open") throw new Error("Position needs reconciliation: position is flat");
  return { position, opening };
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
  if (typeof data.norenordno !== "string" || !data.norenordno) {
    throw new Error("Position needs reconciliation: broker accepted the exit without an order ID");
  }
  return data.norenordno;
}

module.exports = ({ store, getSession, internalToken, reconciliationService = null,
  tradingEnabled = () => process.env.TRADING_ENABLED === "true",
  tradingDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()) }) => {
  const router = express.Router();
  const internal = requireInternalToken(internalToken);
  const noStore = (res) => res.set("Cache-Control", "no-store");

  router.get("/rules", (req, res) => {
    try {
      const session = getSession();
      if (!session?.usersession || !session.userid) {
        store.suspendAll(session?.userid || "", "Position needs reconciliation: Flattrade session is unavailable");
      }
      return noStore(res).json({
        rules: store.list(),
        reconciliation: store.listReconciliation(session?.userid || null),
        reconciliationStatus: reconciliationService?.getStatus() ?? null,
      });
    } catch (error) {
      console.error("Unable to load risk rules", { code: error.code });
      try {
        store.suspendAll("", "Position needs reconciliation: broker session or risk state is unavailable");
      } catch (suspendError) {
        console.error("Unable to suspend risk rules", { code: suspendError.code });
      }
      return res.status(503).json({ message: "Unable to load risk rules" });
    }
  });

  router.post("/rules/:tsym/:operation(default|manual)", async (req, res) => {
    const { stopPoints, targetPoints, trailPoints, trailingStop, targetTrailing, monitor, kind } = req.body || {};
    const manual = req.params.operation === "manual";
    const isPositive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
    if ((stopPoints !== null && !isPositive(stopPoints)) || (targetPoints !== null && !isPositive(targetPoints)) ||
        (stopPoints === null && targetPoints === null) || typeof trailingStop !== "boolean" ||
        typeof targetTrailing !== "boolean" || (trailingStop && (stopPoints === null || targetTrailing)) ||
        (targetTrailing && ((!manual && stopPoints === null) || targetPoints === null || !isPositive(trailPoints))) ||
        (manual && !((kind === "stop" && stopPoints !== null && targetPoints === null) ||
          (kind === "target" && stopPoints === null && targetPoints !== null))) ||
        (!targetTrailing && trailPoints !== null) || !["server", "ui"].includes(monitor)) {
      return res.status(400).json({ message: "Invalid default protection configuration" });
    }
    let expectedRev;
    try {
      expectedRev = store.beginReconciliation(req.params.tsym);
    } catch (error) {
      return res.status(error.status || 503).json({ message: error.status ? error.message : "Unable to suspend protection for reconciliation" });
    }
    const failReconciliation = (account, reason, status = 409) => {
      try {
        store.markReconciliationRequired(account, req.params.tsym, expectedRev, reason);
      } catch (error) {
        console.error("Unable to persist reconciliation status", { tsym: req.params.tsym, code: error.code });
        return res.status(503).json({ message: "ACTION REQUIRED" });
      }
      return res.status(status).json({
        status: "RECONCILIATION_REQUIRED",
        message: "OPEN – RECOVERING",
      });
    };
    let session;
    try {
      session = getSession();
    } catch (error) {
      console.error("Unable to read Flattrade session for reconciliation", { code: error.code });
      return failReconciliation("", "Position needs reconciliation: Flattrade session is unavailable", 503);
    }
    if (!session?.usersession || !session.userid) {
      return failReconciliation(session?.userid || "", "Position needs reconciliation: Flattrade session is unavailable", 503);
    }
    try {
      const { position, opening } = await reconcilePosition(session, req.params.tsym, tradingDay());
      const sign = opening.side === "long" ? 1 : -1;
      const round = (value) => Number(value.toFixed(2));
      const rule = validateRule(req.params.tsym, {
        instrument: `${position.exch}|${position.token}`, side: opening.side, entry: opening.openingPrice,
        mode: targetTrailing ? "target_trail" : trailingStop ? "trailing_sl" : "static",
        slPrice: stopPoints === null ? null : round(opening.openingPrice - sign * stopPoints),
        slPoints: stopPoints, targetPrice: targetPoints === null ? null : round(opening.openingPrice + sign * targetPoints),
        trailPoints: targetTrailing ? trailPoints : null, monitor,
      });
      noStore(res).json(manual
        ? store.saveManual(session.userid, position.prd, opening, rule, expectedRev, kind)
        : store.saveDefault(session.userid, position.prd, opening, rule, expectedRev));
    } catch (error) {
      console.error("Default protection reconciliation failed", { tsym: req.params.tsym, code: error.code });
      if (error.code === "RECONCILIATION_REQUIRED") {
        return res.status(409).json({ status: error.code, message: error.message });
      }
      const reason = error.message.startsWith("Position needs reconciliation:") ? error.message
        : error.code === "ECONNABORTED" || error.code === "ETIMEDOUT"
          ? "Position needs reconciliation: broker request timed out"
          : "Position needs reconciliation: broker request failed or protection could not be verified";
      return failReconciliation(session.userid, reason,
        error.status || (error.message.startsWith("Position needs reconciliation:") ? 409 : 502));
    }
  });

  router.put("/rules/:tsym", (req, res) =>
    res.status(409).json({ message: "Create protection using reconciled default or manual rules" }));

  // Partial edit applied to the latest stored state, so a trailing stop that moved since the
  // browser last refreshed is never overwritten by a stale value.
  router.patch("/rules/:tsym", (req, res) => {
    try {
      const existing = store.get(req.params.tsym);
      if (!existing || existing.status !== "armed") return res.status(404).json({ message: "No armed rule for this position" });
      const patch = req.body || {};
      if ("rev" in patch && (!Number.isSafeInteger(patch.rev) || patch.rev !== existing.rev)) {
        return res.status(409).json({ message: "Risk rule revision changed; refresh before updating it" });
      }
      const merged = { ...existing };
      for (const field of ["monitor", "mode", "slPrice", "slPoints", "targetPrice", "trailPoints"]) {
        if (field in patch) merged[field] = patch[field];
      }
      const shift = (value, delta) => value === null || !Number.isFinite(Number(delta)) ? value : Number((value + Number(delta)).toFixed(2));
      if ("slDelta" in patch) merged.slPrice = shift(merged.slPrice, patch.slDelta);
      if ("targetDelta" in patch) merged.targetPrice = shift(merged.targetPrice, patch.targetDelta);
      const rule = validateRule(req.params.tsym, merged);
      const rev = store.save(rule);
      console.log(`Risk rule saved: ${rule.tsym} monitor=${rule.monitor} mode=${rule.mode} sl=${rule.slPrice} target=${rule.targetPrice} trail=${rule.trailPoints} rev=${rev}`);
      noStore(res).json({ ...rule, status: "armed", rev });
    } catch (error) {
      res.status(error.status || 500).json({ message: error.status ? error.message : "Unable to update the rule" });
    }
  });

  router.delete("/rules/:tsym", (req, res) => {
    const removed = store.remove(req.params.tsym);
    try {
      const session = getSession();
      const account = session?.userid || "";
      store.clearReconciliationForSymbol(account, req.params.tsym);
    } catch (error) {
      store.clearReconciliationForSymbol("", req.params.tsym);
    }
    console.log(`Risk rule removed: ${req.params.tsym} (existed=${removed})`);
    noStore(res).json({ removed: true });
  });

  // ===> Internal endpoints used by the WebSocket service
  // Rules monitored by the browser (monitor = "ui") are never handed to the WebSocket service.
  router.get("/internal/rules", internal, (req, res) =>
    noStore(res).json({ rules: store.list().filter((rule) => rule.status === "armed" && rule.monitor === "server") }));

  router.post("/internal/progress", internal, (req, res) => {
    const { tsym, rev, slPrice, targetPrice } = req.body || {};
    const valid = typeof tsym === "string" && Number.isSafeInteger(rev) && Number.isFinite(slPrice) &&
      (targetPrice === null || Number.isFinite(targetPrice));
    if (!valid) return res.status(400).json({ message: "Invalid progress update" });
    const applied = store.updateProgress(tsym, rev, slPrice, targetPrice);
    console.log(`Risk trailing progress for ${tsym}: sl=${slPrice} target=${targetPrice} rev=${rev} applied=${applied}`);
    noStore(res).json({ applied });
  });
  router.post("/internal/reconcile", internal, (req, res) => {
    if (!reconciliationService) return res.status(503).json({ message: "Reconciliation service is unavailable" });
    void reconciliationService.requestNow("websocket_reconnect");
    return noStore(res).status(202).json({ accepted: true });
  });

  const trigger = (monitor) => async (req, res) => {
    const { tsym, reason, ltp, rev } = req.body || {};
    if (typeof tsym !== "string" || !["Stop-loss", "Target"].includes(reason) ||
        typeof ltp !== "number" || !Number.isFinite(ltp) || ltp <= 0 ||
        !Number.isSafeInteger(rev)) {
      return res.status(400).json({ message: "Invalid trigger" });
    }
    const rule = store.get(tsym);
    if (rule?.monitor !== monitor || rev !== rule.rev) {
      return noStore(res).json({ handled: false });
    }
    const sign = rule.side === "long" ? 1 : -1;
    const crossed = reason === "Stop-loss"
      ? rule.slPrice !== null && sign * (ltp - rule.slPrice) <= 0
      : rule.mode !== "target_trail" && rule.targetPrice !== null &&
        sign * (ltp - rule.targetPrice) >= 0;
    if (!crossed) {
      return res.status(409).json({ message: "Trigger price has not crossed the configured protection level" });
    }
    if (!store.claim(tsym)) {
      console.log(`Risk trigger for ${tsym} ignored: rule is not armed (already handled or removed)`);
      return noStore(res).json({ handled: false });
    }
    const claimedRev = store.get(tsym)?.rev;

    const note = `${reason.slice(0, 40)} at ${Number(ltp)}`;
    console.log(`Risk trigger received for ${tsym}: ${note}`);
    try {
      const session = getSession();
      if (!session?.usersession || !session.userid) {
        store.markReconciliationRequired(session?.userid || "", tsym, claimedRev,
          "Position needs reconciliation: Flattrade session is unavailable");
        return noStore(res).json({ handled: true, status: "reconciliation_required" });
      }
      const { position, opening } = await reconcilePosition(session, tsym, tradingDay());
      if (!store.matchesLifecycle(session.userid, position, opening, rule)) {
        throw new Error("Position needs reconciliation: opening fill does not match the stored lifecycle");
      }
      if (!tradingEnabled() || !["NFO", "BFO"].includes(position.exch)) {
        store.finish(tsym, "failed", `${note}: trading disabled or unsupported exchange`);
        return noStore(res).json({ handled: true, status: "failed" });
      }
      if (!store.canSubmit(tsym, claimedRev)) {
        return noStore(res).json({ handled: false, status: "reconciliation_required" });
      }
      const orderPayload = `jData=${JSON.stringify({ uid: session.userid, prd: position.prd })}&jKey=${session.usersession}`;
      const orderResponse = await axios.post(`${BROKER}/OrderBook`, orderPayload,
        { headers: FORM, timeout: 10000 });
      const activeOrders = asBook(orderResponse.data, "OrderBook").filter((order) =>
        order?.tsym === position.tsym && order?.exch === position.exch && order?.prd === position.prd &&
        getOrderState(order) !== "final");
      if (activeOrders.length) {
        const order = activeOrders[0];
        const isExitSide = order.trantype === (Number(position.netqty) > 0 ? "S" : "B");
        if (activeOrders.length === 1 && isExitSide && getOrderState(order) === "active" &&
            typeof order.norenordno === "string" && order.norenordno) {
          const message = `An active Flattrade exit order ${order.norenordno} was found; awaiting reconciliation`;
          if (!store.adoptActiveExitOrder(session.userid, tsym, claimedRev, order.norenordno, message)) {
            store.recordExitOrder(session.userid, tsym, order.norenordno);
            store.markReconciliationRequired(session.userid, tsym, claimedRev,
              `Position needs reconciliation: ${message}`);
          }
          if (reconciliationService) void reconciliationService.requestNow("exit_order_discovered");
          return noStore(res).json({ handled: true, status: "exit_pending", brokerOrderId: order.norenordno });
        }
        throw new Error("Position needs reconciliation: a conflicting or unrecognized broker order is active");
      }
      if (!store.canSubmit(tsym, claimedRev)) {
        return noStore(res).json({ handled: false, status: "reconciliation_required" });
      }
      const brokerOrderId = await submitExit(session, position, ltp);
      console.log(`Risk exit accepted for ${tsym}; awaiting fill confirmation`);
      const exitMessage = `${note}: Flattrade accepted exit order ${brokerOrderId}; execution is unconfirmed`;
      if (!store.finishExit(session.userid, tsym, claimedRev, brokerOrderId, exitMessage)) {
        store.recordExitOrder(session.userid, tsym, brokerOrderId);
        const message = `Position needs reconciliation: Flattrade accepted exit order ${brokerOrderId}, but exit state changed before it could be recorded`;
        store.markReconciliationRequired(session.userid, tsym, claimedRev, message);
        noStore(res).json({ handled: true, status: "reconciliation_required", brokerOrderId });
        return;
      }
      if (reconciliationService) void reconciliationService.requestNow("exit_submitted");
      noStore(res).json({ handled: true, status: "exit_pending", brokerOrderId });
    } catch (error) {
      if (reconciliationService) void reconciliationService.requestNow("exit_status_uncertain");
      console.error("Risk exit failed", { tsym, code: error.code, status: error.response?.status });
      try {
        store.markReconciliationRequired("", tsym, claimedRev,
          error.message.startsWith("Position needs reconciliation:") ? error.message :
            error.code === "ECONNABORTED" || error.code === "ETIMEDOUT"
              ? "Position needs reconciliation: broker request timed out or exit is uncertain"
              : "Position needs reconciliation: broker request failed or exit is uncertain");
        noStore(res).json({ handled: true, status: "reconciliation_required" });
      } catch (markError) {
        console.error("Unable to persist reconciliation status", { tsym, code: markError.code });
        res.status(503).json({ message: "ACTION REQUIRED" });
      }
    }
  };
  router.post("/internal/trigger", internal, trigger("server"));
  router.post("/trigger", trigger("ui"));

  return router;
};

module.exports.marketableLimitPrice = marketableLimitPrice;
