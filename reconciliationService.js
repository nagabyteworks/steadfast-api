const { randomUUID } = require("node:crypto");
const axios = require("axios");
const { reconstructOpeningFill } = require("./positionLifecycle");

const BROKER = "https://piconnect.flattrade.in/PiConnectAPI";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const ACTIVE_ORDER_STATES = new Set([
  "OPEN", "PENDING", "PARTIAL", "PARTIALLY_FILLED", "TRIGGER_PENDING",
  "OPEN_PENDING", "CANCEL_PENDING", "MODIFY_PENDING", "AMO_REQ_RECEIVED",
  "VALIDATION_PENDING",
]);
const FINAL_ORDER_STATES = new Set(["COMPLETE", "COMPLETED", "REJECTED", "CANCELED", "CANCELLED"]);
const INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000;
const LEASE_MS = 60000;

function isNoData(data) {
  return data?.stat === "Not_Ok" &&
    typeof data.emsg === "string" &&
    /^no\s+(data|orders|trades|positions)(\s+available)?$/i.test(data.emsg.trim());
}

function asBook(data, name) {
  if (Array.isArray(data)) return data;
  if (isNoData(data)) return [];
  throw new Error(`Invalid ${name} response from Flattrade`);
}

function parseInteger(value, name, { signed = false, allowMissing = false } = {}) {
  if (allowMissing && (value === undefined || value === null || value === "")) return null;
  if ((typeof value !== "string" && typeof value !== "number") ||
      typeof value === "string" && !/^-?\d+$/.test(value)) {
    throw new Error(`Invalid ${name} in Flattrade response`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!signed && parsed < 0)) {
    throw new Error(`Invalid ${name} in Flattrade response`);
  }
  return parsed;
}

function getOrderState(order) {
  const rawStatus = order.status ?? order.ordstatus ?? order.stat;
  const status = typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() : "";
  if (ACTIVE_ORDER_STATES.has(status)) return "active";
  if (FINAL_ORDER_STATES.has(status)) return "final";
  return "unknown";
}

function aggregateFills(trades) {
  const fills = new Map();
  const seen = new Set();
  for (const trade of trades) {
    if (!trade || typeof trade !== "object" || Array.isArray(trade) ||
        typeof trade.norenordno !== "string" || !trade.norenordno ||
        typeof trade.flid !== "string" || !trade.flid ||
        !["B", "S"].includes(trade.trantype)) {
      throw new Error("Invalid trade execution identity in Flattrade response");
    }
    const fillKey = `${trade.norenordno}|${trade.flid}`;
    if (seen.has(fillKey)) throw new Error("Duplicate trade execution in Flattrade response");
    seen.add(fillKey);
    const quantity = parseInteger(trade.flqty, "trade quantity");
    const price = Number(trade.flprc);
    if (!quantity || typeof trade.flprc !== "string" && typeof trade.flprc !== "number" ||
        !Number.isFinite(price) || price <= 0) {
      throw new Error("Invalid trade execution quantity or price in Flattrade response");
    }
    const item = fills.get(trade.norenordno) || { quantity: 0, value: 0 };
    item.quantity += quantity;
    item.value += quantity * price;
    fills.set(trade.norenordno, item);
  }
  return fills;
}

function orderFillMismatch(orders, fills) {
  for (const order of orders) {
    if (typeof order?.norenordno !== "string" || !order.norenordno) return true;
    const orderFill = fills.get(order.norenordno)?.quantity ?? 0;
    const reportedFill = parseInteger(order.fillshares ?? order.flqty, "order fill quantity", { allowMissing: true });
    const quantity = parseInteger(order.qty, "order quantity", { allowMissing: true });
    if (reportedFill !== null && reportedFill !== orderFill) return true;
    if (quantity !== null && orderFill > quantity) return true;
    if (getOrderState(order) === "final" &&
        ["COMPLETE", "COMPLETED"].includes(String(order.status ?? order.ordstatus ?? order.stat).toUpperCase()) &&
        quantity !== null && orderFill !== quantity) return true;
  }
  return false;
}

function summarizeOrders(orders, fills) {
  return orders.map((order) => {
    if (typeof order?.tsym !== "string" || !order.tsym ||
        typeof order.exch !== "string" || !order.exch ||
        typeof order.prd !== "string" || !order.prd ||
        !["B", "S"].includes(order.trantype)) {
      throw new Error("Invalid order identity in Flattrade response");
    }
    const fill = fills.get(order.norenordno) || { quantity: 0, value: 0 };
    const quantity = parseInteger(order.qty, "order quantity", { allowMissing: true });
    const rawStatus = order.status ?? order.ordstatus ?? order.stat;
    let orderStatus = typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() : "UNKNOWN";
    if (getOrderState(order) === "active" && fill.quantity > 0 &&
        quantity !== null && fill.quantity < quantity) {
      orderStatus = "PARTIALLY_FILLED";
    }
    return {
      orderId: order.norenordno,
      tsym: order.tsym,
      exch: order.exch,
      prd: order.prd,
      side: order.trantype,
      quantity,
      filledQuantity: fill.quantity,
      remainingQuantity: quantity === null ? null : Math.max(0, quantity - fill.quantity),
      averageFillPrice: fill.quantity ? fill.value / fill.quantity : null,
      status: orderStatus,
    };
  });
}

function currentAverageEntry(position, trades, opening) {
  const carry = parseInteger(position.cfbuyqty, "carry buy quantity") -
    parseInteger(position.cfsellqty, "carry sell quantity");
  if (carry !== 0) return null;
  const fills = trades
    .filter((trade) => trade.tsym === position.tsym && trade.exch === position.exch &&
      trade.prd === position.prd)
    .sort((left, right) => left.fltm.localeCompare(right.fltm));
  let net = 0;
  let average = 0;
  for (const fill of fills) {
    const quantity = parseInteger(fill.flqty, "trade quantity");
    const price = Number(fill.flprc);
    const direction = fill.trantype === "B" ? 1 : -1;
    const next = net + direction * quantity;
    if (net === 0 || Math.sign(net) === direction) {
      average = (Math.abs(net) * average + quantity * price) / (Math.abs(net) + quantity);
    } else if (next === 0) {
      average = 0;
    } else if (Math.sign(next) !== Math.sign(net)) {
      average = price;
    }
    net = next;
  }
  return net === opening.quantity * (opening.side === "long" ? 1 : -1)
    ? Number(average.toFixed(4))
    : null;
}

function exitOrderId(store, account, rule) {
  const stored = store.getExitOrderId(account, rule.tsym);
  if (stored) return stored;
  const match = /accepted exit order\s+([A-Za-z0-9_-]+)/i.exec(rule.message || "");
  return match?.[1] ?? null;
}

function createReconciliationService({
  store,
  getSession,
  account,
  lotLedger = null,
  request = axios.post,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = INTERVAL_MS,
  tradingDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()),
}) {
  if (!store || typeof getSession !== "function") {
    throw new Error("Risk store and broker session getter are required");
  }

  const owner = randomUUID();
  let interval = null;
  let inFlight = null;
  let queuedReason = null;
  let stopped = false;
  let consecutiveFailures = 0;
  let retryAt = 0;
  const status = {
    enabled: true,
    running: false,
    cycleRunning: false,
    intervalMs,
    currentCycleId: null,
    currentStatus: "idle",
    lastAttemptAt: null,
    lastCompletedAt: null,
    lastSuccessfulAt: null,
    durationMs: null,
    activePositionCount: 0,
    orderCount: 0,
    discrepancyCount: 0,
    repairedCount: 0,
    unresolvedCount: 0,
    skippedCycles: 0,
    brokerStateUpdates: 0,
    lastError: null,
    positions: {},
    positionMetrics: {},
  };

  const publishStatus = () => {
    status.unresolvedCount = store.listReconciliation(account || "").length;
  };

  const setActionRequired = (tsym, rule, reason) => {
    if (rule && rule.status !== "reconciliation_required") {
      store.markReconciliationRequired(account || "", tsym, rule.rev, reason);
    }
    if (rule) store.setRecoveryStatus(account || "", tsym, "ACTION_REQUIRED", reason);
    else store.flagUnprotectedPosition(account || "", tsym, reason);
    status.positions[tsym] = "ACTION REQUIRED";
  };

  const checkOrderBooks = (orders, fills) => {
    const orderIds = new Set();
    for (const order of orders) {
      if (orderIds.has(order.norenordno)) throw new Error("Duplicate order in Flattrade order book");
      orderIds.add(order.norenordno);
    }
    return orderFillMismatch(orders, fills);
  };

  const activeOrdersFor = (orders, tsym, exch, prd) => orders.filter((order) =>
    order.tsym === tsym && order.exch === exch && order.prd === prd &&
    getOrderState(order) !== "final");

  const reconcileSnapshot = ({ positions, orders, trades }) => {
    const fills = aggregateFills(trades);
    status.brokerStateUpdates = store.recordBrokerOrders(account || "", summarizeOrders(orders, fills));
    if (lotLedger) {
      for (const lot of lotLedger.list(account || "")) {
        if (!lot.brokerOrderId && lot.executionIntentId &&
            ["EXIT_PENDING", "EXIT_PARTIALLY_FILLED"].includes(lot.status)) {
          const exitSide = lot.side === "long" ? "S" : "B";
          const matches = orders.filter((item) =>
            item.tsym === lot.symbol && item.exch === lot.exchange &&
            item.prd === lot.productType && item.trantype === exitSide &&
            getOrderState(item) !== "final" &&
            parseInteger(item.qty, "lot exit quantity", { allowMissing: true }) === lot.reservedQuantity);
          if (matches.length === 1) {
            lotLedger.recordBrokerExit(account || "", lot.lotId, lot.executionIntentId,
              matches[0].norenordno, "Reconciliation adopted an existing lot exit order");
          }
        }
        if (!lot.brokerOrderId) continue;
        const order = orders.find((item) => item.norenordno === lot.brokerOrderId);
        if (!order) continue;
        const state = getOrderState(order);
        const fillQuantity = fills.get(lot.brokerOrderId)?.quantity ?? 0;
        const fillData = fills.get(lot.brokerOrderId);
        const averageFillPrice = fillData?.quantity ? fillData.value / fillData.quantity : null;
        const alreadyExited = lot.quantity - lot.remainingQuantity;
        const fillDelta = Math.max(0, fillQuantity - alreadyExited);
        if (fillDelta > 0 && averageFillPrice != null) {
          const partial = fillDelta < lot.remainingQuantity;
          lotLedger.updateExitFill(account || "", lot.lotId, fillDelta, averageFillPrice,
            partial ? "EXIT_PARTIALLY_FILLED" : "EXIT_COMPLETED",
            `Flattrade execution reconciled: ${fillQuantity} filled at ${averageFillPrice.toFixed(4)}`);
        } else if (state === "final" &&
            ["REJECTED", "CANCELED", "CANCELLED"].includes(String(order.status ?? order.ordstatus ?? order.stat).toUpperCase())) {
          lotLedger.releaseExit(account || "", lot.lotId,
            `Lot exit ${lot.brokerOrderId} was rejected or cancelled`);
        }
      }
    }
    const orderMismatch = checkOrderBooks(orders, fills);
    const openBySymbol = new Map();
    for (const position of positions) {
      if (!position || typeof position.tsym !== "string" || !position.tsym ||
          typeof position.exch !== "string" || typeof position.prd !== "string") {
        throw new Error("Invalid position identity in Flattrade response");
      }
      const net = parseInteger(position.netqty, "position quantity", { signed: true });
      if (net !== 0) {
        const matched = openBySymbol.get(position.tsym) || [];
        matched.push(position);
        openBySymbol.set(position.tsym, matched);
      }
    }

    const rules = store.list();
    const rulesBySymbol = new Map(rules.map((rule) => [rule.tsym, rule]));
    const positionStatuses = {};
    let discrepancies = orderMismatch ? 1 : 0;
    let repaired = 0;
    let unresolved = 0;
    const positionMetrics = {};

    for (const [tsym, matching] of openBySymbol) {
      const rule = rulesBySymbol.get(tsym);
      if (matching.length !== 1) {
        discrepancies++;
        unresolved++;
        setActionRequired(tsym, rule, "Position identity is ambiguous across Flattrade products");
        continue;
      }
      const position = matching[0];
      let opening;
      try {
        opening = reconstructOpeningFill(position, trades, tradingDay());
      } catch (error) {
        discrepancies++;
        unresolved++;
        setActionRequired(tsym, rule, error.message);
        continue;
      }
      positionMetrics[tsym] = {
        side: opening.side,
        netQuantity: Number(position.netqty),
        openingOrderId: opening.openingOrderId,
        openingFillId: opening.openingFillId,
        openingPrice: opening.openingPrice,
        averageEntryPrice: currentAverageEntry(position, trades, opening),
      };

      if (!rule) {
        discrepancies++;
        unresolved++;
        setActionRequired(tsym, null, "Open position has no saved protection configuration to restore");
        continue;
      }
      if (orderMismatch || !store.matchesLifecycle(account || "", position, opening, rule)) {
        discrepancies++;
        unresolved++;
        setActionRequired(tsym, rule, orderMismatch
          ? "Flattrade order fills do not match the order book"
          : "Open position lifecycle does not match the saved protection configuration");
        continue;
      }

      const pendingOrders = activeOrdersFor(orders, tsym, position.exch, position.prd);
      const orderId = exitOrderId(store, account, rule);
      const exitOrder = orderId ? orders.find((order) => order.norenordno === orderId) : null;
      if (pendingOrders.some((order) => getOrderState(order) === "unknown")) {
        discrepancies++;
        unresolved++;
        setActionRequired(tsym, rule, "A broker order has an unrecognized status");
        continue;
      }
      const exitSide = Number(position.netqty) > 0 ? "S" : "B";
      const activeExitOrders = pendingOrders.filter((order) => order.trantype === exitSide);
      if (!orderId && activeExitOrders.length === 1 &&
          getOrderState(activeExitOrders[0]) === "active" &&
          typeof activeExitOrders[0].norenordno === "string" && activeExitOrders[0].norenordno) {
        const externalOrderId = activeExitOrders[0].norenordno;
        const partial = (fills.get(externalOrderId)?.quantity ?? 0) > 0;
        const state = partial ? "exit_partially_filled" : "exit_pending";
        const adopted = store.adoptBrokerExitOrder(account || "", tsym, rule.rev,
          externalOrderId, state, `Flattrade exit order ${externalOrderId} is being reconciled`);
        positionStatuses[tsym] = partial ? "EXIT PARTIALLY FILLED" : "EXITING";
        if (adopted) repaired++;
        continue;
      }
      if (exitOrder && getOrderState(exitOrder) === "active") {
        const partial = (fills.get(orderId)?.quantity ?? 0) > 0;
        const state = partial ? "exit_partially_filled" : "exit_pending";
        store.confirmExitOrder(account || "", tsym, rule.rev, state,
          `Flattrade exit order ${orderId} is ${partial ? "partially filled" : "pending"}`);
        positionStatuses[tsym] = partial ? "EXIT PARTIALLY FILLED" : "EXITING";
        continue;
      }
      if (pendingOrders.length) {
        discrepancies++;
        unresolved++;
        const sameSideOrders = pendingOrders.filter((order) =>
          order.trantype === (Number(position.netqty) > 0 ? "B" : "S"));
        if (!activeExitOrders.length && sameSideOrders.length) {
          const reason = "An entry order is still active for this position";
          if (rule.status !== "reconciliation_required") {
            store.markReconciliationRequired(account || "", tsym, rule.rev, reason);
          }
          store.setRecoveryStatus(account || "", tsym, "RECOVERING", reason);
          positionStatuses[tsym] = "OPEN – RECOVERING";
        } else if (activeExitOrders.length === 1 && pendingOrders.length === 1) {
          positionStatuses[tsym] = "EXITING";
        } else {
          setActionRequired(tsym, rule, "Multiple or conflicting broker exit orders are active");
          positionStatuses[tsym] = "ACTION REQUIRED";
        }
        continue;
      }
      if (rule.status === "reconciliation_required") {
        const priorTriggered = /prior status=triggered/i.test(rule.message || "");
        if (orderId && !exitOrder || priorTriggered && !orderId) {
          discrepancies++;
          unresolved++;
          setActionRequired(tsym, rule, "An uncertain exit order cannot be matched to Flattrade");
          continue;
        }
        if (exitOrder && getOrderState(exitOrder) === "unknown") {
          discrepancies++;
          unresolved++;
          setActionRequired(tsym, rule, "The saved exit order has an unrecognized broker status");
          continue;
        }
        if (store.restoreReconciledRule(account || "", tsym, rule.rev, position, opening)) {
          repaired++;
          positionStatuses[tsym] = "OPEN – PROTECTED";
          continue;
        }
        discrepancies++;
        unresolved++;
        setActionRequired(tsym, rule, "Protection could not be restored against the verified position lifecycle");
        continue;
      }
      if (["exit_pending", "exit_partially_filled"].includes(rule.status)) {
        if (!orderId || !exitOrder || getOrderState(exitOrder) === "unknown") {
          discrepancies++;
          unresolved++;
          setActionRequired(tsym, rule, "Pending exit order cannot be matched to Flattrade");
          continue;
        }
        if (getOrderState(exitOrder) === "final" &&
            store.restoreReconciledRule(account || "", tsym, rule.rev, position, opening)) {
          repaired++;
          positionStatuses[tsym] = "OPEN – PROTECTED";
          continue;
        }
      }
      if (rule.status === "armed") {
        positionStatuses[tsym] = "OPEN – PROTECTED";
      } else if (rule.status === "exit_pending") {
        positionStatuses[tsym] = "EXITING";
      } else if (rule.status === "exit_partially_filled") {
        positionStatuses[tsym] = "EXIT PARTIALLY FILLED";
      } else if (rule.status === "triggered") {
        positionStatuses[tsym] = "EXITING";
      } else {
        positionStatuses[tsym] = "OPEN – RECOVERING";
      }
    }

    for (const rule of rules) {
      if (openBySymbol.has(rule.tsym)) continue;
      const relatedOrders = orders.filter((order) => order.tsym === rule.tsym &&
        getOrderState(order) !== "final");
      if (relatedOrders.length) {
        positionStatuses[rule.tsym] = relatedOrders.some((order) =>
          getOrderState(order) === "unknown") ? "ACTION REQUIRED" : "EXITING";
        if (relatedOrders.some((order) => getOrderState(order) === "unknown")) {
          setActionRequired(rule.tsym, rule, "A broker order has an unrecognized status");
          discrepancies++;
          unresolved++;
        }
        continue;
      }
      if (orderMismatch) {
        setActionRequired(rule.tsym, rule, "Flattrade order fills do not match the order book");
        discrepancies++;
        unresolved++;
        continue;
      }
      const pendingExitId = exitOrderId(store, account, rule);
      if (["exit_pending", "exit_partially_filled"].includes(rule.status) &&
          (!pendingExitId || !orders.some((order) => order.norenordno === pendingExitId))) {
        setActionRequired(rule.tsym, rule, "Pending exit order cannot be matched to Flattrade");
        discrepancies++;
        unresolved++;
        continue;
      }
      if (rule.status === "triggered" ||
          rule.status === "reconciliation_required" &&
          /prior status=triggered/i.test(rule.message || "") &&
          !exitOrderId(store, account, rule)) {
        setActionRequired(rule.tsym, rule, "An uncertain exit request cannot be proven complete");
        discrepancies++;
        unresolved++;
        continue;
      }
      if (store.closeReconciledRule(account || "", rule.tsym, rule.rev)) {
        repaired++;
      }
      positionStatuses[rule.tsym] = "CLOSED";
    }

    for (const item of store.listReconciliation(account || "")) {
      if (!openBySymbol.has(item.tsym) && !rulesBySymbol.has(item.tsym)) {
        store.clearReconciliationForSymbol(account || "", item.tsym);
      }
    }

    status.positions = positionStatuses;
    status.positionMetrics = positionMetrics;
    status.activePositionCount = [...openBySymbol.values()].reduce((total, items) => total + items.length, 0);
    status.orderCount = orders.length;
    status.discrepancyCount = discrepancies;
    status.repairedCount = repaired;
    status.unresolvedCount = store.listReconciliation(account || "").length;
    if (status.unresolvedCount > unresolved) unresolved = status.unresolvedCount;
    for (const item of store.listReconciliation(account || "")) {
      if (openBySymbol.has(item.tsym)) {
        positionStatuses[item.tsym] = item.recoveryStatus === "ACTION_REQUIRED"
          ? "ACTION REQUIRED"
          : positionStatuses[item.tsym] || "OPEN – RECOVERING";
      }
    }
    status.positions = positionStatuses;
    return { discrepancies, repaired, unresolved };
  };

  const brokerRequest = async (endpoint, session, product) => {
    const accountData = endpoint === "OrderBook"
      ? { uid: session.userid, prd: product }
      : { uid: session.userid, actid: session.userid };
    const payload = `jData=${JSON.stringify(accountData)}&jKey=${session.usersession}`;
    return request(`${BROKER}/${endpoint}`, payload, { headers: FORM, timeout: REQUEST_TIMEOUT_MS });
  };

  const executeCycle = async (reason) => {
    const cycleId = randomUUID();
    const startedAt = now();
    status.currentCycleId = cycleId;
    status.currentStatus = retryAt > startedAt ? "backoff" : "running";
    status.lastAttemptAt = startedAt;
    status.cycleRunning = true;
    const calls = [];
    let leaseClaimed = false;
    let outcome = "failed";
    let error = null;
    try {
      if (retryAt > startedAt) {
        status.skippedCycles++;
        outcome = "skipped";
        return;
      }
      leaseClaimed = store.claimReconciliationLease(owner, startedAt, LEASE_MS);
      if (!leaseClaimed) {
        status.currentStatus = "another_instance";
        status.skippedCycles++;
        outcome = "skipped";
        return;
      }
      const session = getSession();
      if (!session?.usersession || !session.userid) {
        throw Object.assign(new Error("Flattrade session is unavailable"), { code: "SESSION_UNAVAILABLE" });
      }
      const specs = [
        ["PositionBook", null],
        ["OrderBook", "M"],
        ["OrderBook", "I"],
        ["TradeBook", null],
      ];
      const responses = [];
      for (const [endpoint, product] of specs) {
        const call = { endpoint, product, status: null, rows: 0 };
        calls.push(call);
        const response = await brokerRequest(endpoint, session, product);
        call.status = response.status;
        const name = product ? `${endpoint} ${product}` : endpoint;
        const data = asBook(response.data, name);
        call.rows = data.length;
        responses.push({ endpoint, product, data });
      }
      const positions = responses.find((item) => item.endpoint === "PositionBook").data;
      const orders = responses.filter((item) => item.endpoint === "OrderBook").flatMap((item) => item.data);
      const trades = responses.find((item) => item.endpoint === "TradeBook").data;
      const result = reconcileSnapshot({ positions, orders, trades });
      consecutiveFailures = 0;
      retryAt = 0;
      status.lastSuccessfulAt = now();
      status.lastError = null;
      status.currentStatus = "success";
      outcome = "success";
      console.log(JSON.stringify({
        event: "broker_reconciliation_cycle",
        cycleId,
        reason,
        startedAt,
        completedAt: now(),
        durationMs: now() - startedAt,
        apiCalls: calls,
        positionsChecked: positions.length,
        ordersChecked: orders.length,
        discrepancies: result.discrepancies,
        repaired: result.repaired,
        unresolved: result.unresolved,
      }));
    } catch (caught) {
      error = caught;
      consecutiveFailures++;
      const retryAfter = Number(caught.response?.headers?.["retry-after"]);
      const retryDelay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 120000)
        : Math.min(60000, intervalMs * (2 ** Math.min(consecutiveFailures - 1, 5)));
      retryAt = now() + retryDelay;
      status.currentStatus = "failed";
      status.lastError = caught.code || (caught.response?.status
        ? `HTTP_${caught.response.status}` : "BROKER_RECONCILIATION_FAILED");
      console.error(JSON.stringify({
        event: "broker_reconciliation_cycle",
        cycleId,
        reason,
        startedAt,
        completedAt: now(),
        durationMs: now() - startedAt,
        apiCalls: calls,
        status: "failed",
        error: status.lastError,
      }));
    } finally {
      if (leaseClaimed) store.releaseReconciliationLease(owner);
      status.cycleRunning = false;
      status.lastCompletedAt = now();
      status.durationMs = status.lastCompletedAt - startedAt;
      if (error) status.lastError = status.lastError || "BROKER_RECONCILIATION_FAILED";
      publishStatus();
      if (outcome === "failed" && status.currentStatus !== "backoff") status.currentStatus = "failed";
    }
  };

  const runCycle = (reason) => {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      queuedReason = reason;
      return inFlight;
    }
    inFlight = executeCycle(reason).finally(() => {
      inFlight = null;
      if (!stopped && queuedReason) {
        const nextReason = queuedReason;
        queuedReason = null;
        queueMicrotask(() => { void runCycle(nextReason); });
      }
    });
    return inFlight;
  };

  return {
    start() {
      if (interval || stopped) return;
      status.enabled = true;
      status.running = true;
      interval = setIntervalFn(() => {
        if (inFlight) {
          status.skippedCycles++;
          return;
        }
        void runCycle("interval");
      }, intervalMs);
      interval.unref?.();
      void runCycle("startup");
    },
    requestNow(reason = "event") {
      if (inFlight) queuedReason = reason;
      return runCycle(reason);
    },
    getStatus() {
      publishStatus();
      return {
        ...status,
        positions: { ...status.positions },
        positionMetrics: { ...status.positionMetrics },
      };
    },
    async stop() {
      stopped = true;
      if (interval) clearIntervalFn(interval);
      interval = null;
      queuedReason = null;
      if (inFlight) await inFlight;
      store.releaseReconciliationLease(owner);
      status.running = false;
      status.cycleRunning = false;
      status.enabled = false;
      status.currentStatus = "stopped";
    },
    async runOnce(reason = "test") {
      return runCycle(reason);
    },
  };
}

module.exports = {
  createReconciliationService,
  INTERVAL_MS,
  asBook,
  aggregateFills,
  getOrderState,
};
