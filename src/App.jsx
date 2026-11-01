import React, { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const TIMEFRAME = 300;
const CANDLE_COUNT = 1000;
const BUFFER_PIPS = 2;
const FX_SL_PIPS = 10;
const FX_TP_PIPS = 31;

const CATEGORIES = [
  "All", "Forex", "Indices", "Metals",
  "Synthetics", "Crypto", "Stocks", "Other"
];

const DIAGNOSTIC_REASONS = [
  "Asia range unavailable", "No boxes found",
  "Waiting for breakout", "Waiting for first retest",
  "Waiting for opposite-side breakout",
  "Waiting for FLIPPY retest",
  "Third touch — DELETE",
  "Neutral retest candle",
  "Signal confirmed",
  "Market data unavailable"
];

const fmt = (n, digits = 5) =>
  Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "—";

function categoryOf(s) {
  const market = String(s.market || "").toLowerCase();
  const sub = String(s.submarket || "").toLowerCase();
  const subgroup = String(s.subgroup || "").toLowerCase();
  const name = String(s.display_name || "").toLowerCase();
  const symbol = String(s.symbol || "").toLowerCase();
  const type = String(s.symbol_type || "").toLowerCase();

  if (market.includes("forex") || sub.includes("forex") || type.includes("forex")) return "Forex";

  if (
    market.includes("synthetic") || sub.includes("synthetic") ||
    subgroup.includes("synthetic") || symbol.startsWith("1hz") ||
    symbol.startsWith("r_") || symbol.includes("boom") ||
    symbol.includes("crash") || symbol.includes("step")
  ) return "Synthetics";

  if (
    market.includes("crypt") || sub.includes("crypt") ||
    subgroup.includes("crypt") || name.includes("bitcoin") ||
    name.includes("ethereum") || type.includes("crypt")
  ) return "Crypto";

  if (
    market.includes("stock") || sub.includes("stock") ||
    subgroup.includes("stock") || market.includes("share") ||
    type.includes("stock")
  ) return "Stocks";

  if (
    market.includes("index") || sub.includes("index") ||
    subgroup.includes("index") || type.includes("index")
  ) return "Indices";

  if (
    market.includes("commodit") || sub.includes("metal") ||
    subgroup.includes("metal") || name.includes("gold") ||
    name.includes("silver") || name.includes("platinum") ||
    name.includes("palladium")
  ) return "Metals";

  return "Other";
}

function candleColor(c) {
  if (c.close > c.open) return "GREEN";
  if (c.close < c.open) return "RED";
  return "NEUTRAL";
}

function pipSize(symbol, category, candles) {
  if (category === "Forex") {
    return symbol.toUpperCase().includes("JPY") ? 0.01 : 0.0001;
  }

  const last = candles[candles.length - 1]?.close || 1;
  const decimals = (String(last).split(".")[1] || "").length;
  return Math.pow(10, -Math.min(decimals, 8));
}

function buildAsiaRange(candles) {
  if (!candles.length) return null;

  const lastDay = new Date(
    candles[candles.length - 1].epoch * 1000
  ).toISOString().slice(0, 10);

  const asia = candles.filter(c => {
    const date = new Date(c.epoch * 1000);
    return (
      date.toISOString().slice(0, 10) === lastDay &&
      date.getUTCHours() >= 0 &&
      date.getUTCHours() < 7
    );
  });

  if (!asia.length) return null;

  return {
    high: Math.max(...asia.map(c => c.high)),
    low: Math.min(...asia.map(c => c.low)),
    day: lastDay
  };
}

function createBoxes(candles, asiaDay) {
  const boxes = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const date = new Date(c.epoch * 1000);

    if (date.toISOString().slice(0, 10) !== asiaDay) continue;
    if (date.getUTCHours() < 7) continue;

    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);

    if (range <= 0) continue;

    const currentBull = c.close > c.open;
    const previousBear = prev.close < prev.open;
    const currentBear = c.close < c.open;
    const previousBull = prev.close > prev.open;

    if (
      (currentBull && previousBear &&
        c.open <= prev.close && c.close >= prev.open) ||
      (currentBear && previousBull &&
        c.open >= prev.close && c.close <= prev.open)
    ) {
      boxes.push({
        type: "ENGULFED",
        high: prev.high,
        low: prev.low,
        created: i
      });
    }

    if (body / range <= 0.25) {
      boxes.push({
        type: "DOJI",
        high: c.high,
        low: c.low,
        created: i
      });
    }

    if (currentBull) {
      const upperWick = c.high - c.close;

      if (upperWick >= body * 0.20) {
        boxes.push({
          type: "WICK",
          high: c.high,
          low: c.close,
          created: i
        });
      }
    }

    if (currentBear) {
      const lowerWick = c.close - c.low;

      if (lowerWick >= body * 0.20) {
        boxes.push({
          type: "WICK",
          high: c.close,
          low: c.low,
          created: i
        });
      }
    }
  }

  return boxes;
}

function touchesTop(candle, box) {
  return candle.low <= box.high && candle.high >= box.high;
}

function touchesBottom(candle, box) {
  return candle.low <= box.low && candle.high >= box.low;
}

function touchesBox(candle, box) {
  return candle.low <= box.high && candle.high >= box.low;
}

function getRetestDirection(candle, boundary) {
  const color = candleColor(candle);

  if (boundary === "BOTTOM" && color === "GREEN") return "SELL";
  if (boundary === "TOP" && color === "RED") return "BUY";

  return "NONE";
}

function makeBoxId(box, asiaDay) {
  return [
    asiaDay, box.type, box.created,
    box.high.toPrecision(12),
    box.low.toPrecision(12)
  ].join("-");
}

// Only a qualifying touch on the latest CLOSED M5 candle
// can generate an actionable signal.
function findRetestSignal(candles, symbol, category) {
  const empty = {
    direction: "NONE",
    reason: "Market data unavailable",
    deletedBoxIds: []
  };

  if (!candles.length) return empty;

  const asia = buildAsiaRange(candles);

  if (!asia) {
    return { ...empty, reason: "Asia range unavailable" };
  }

  const boxes = createBoxes(candles, asia.day);

  if (!boxes.length) {
    return { ...empty, reason: "No boxes found" };
  }

  const lastIndex = candles.length - 1;
  const unit = pipSize(symbol, category, candles);
  const entryBuffer = unit * BUFFER_PIPS;

  const deletedBoxIds = [];

  let sawBreakout = false;
  let sawFirstRetest = false;
  let sawOppositeBreak = false;
  let sawFlippyRetest = false;
  let sawNeutral = false;
  let best = null;

  for (const box of boxes) {
    if (lastIndex <= box.created) continue;

    const boxId = makeBoxId(box, asia.day);

    let breakoutIndex = -1;
    let breakoutDirection = null;

    for (let i = box.created + 1; i <= lastIndex; i++) {
      if (candles[i].close > box.high) {
        breakoutIndex = i;
        breakoutDirection = "UP";
        break;
      }

      if (candles[i].close < box.low) {
        breakoutIndex = i;
        breakoutDirection = "DOWN";
        break;
      }
    }

    if (breakoutIndex < 0) continue;

    sawBreakout = true;

    if (lastIndex <= breakoutIndex) continue;

    const firstBoundary =
      breakoutDirection === "UP" ? "TOP" : "BOTTOM";

    let firstTouchIndex = -1;

    for (let i = breakoutIndex + 1; i <= lastIndex; i++) {
      const touched = firstBoundary === "TOP"
        ? touchesTop(candles[i], box)
        : touchesBottom(candles[i], box);

      if (touched) {
        firstTouchIndex = i;
        break;
      }
    }

    if (firstTouchIndex < 0) continue;

    sawFirstRetest = true;

    const firstDirection = getRetestDirection(
      candles[firstTouchIndex],
      firstBoundary
    );

    if (firstDirection !== "NONE") {

      // Normal retest must be the latest closed candle.
      if (firstTouchIndex !== lastIndex) continue;

      let touchCount = 1;
      let deleted = false;

      for (let i = firstTouchIndex + 1; i <= lastIndex; i++) {
        if (touchesBox(candles[i], box)) {
          touchCount++;

          if (touchCount >= 3) {
            deleted = true;
            break;
          }
        }
      }

      if (deleted) {
        deletedBoxIds.push(boxId);
        continue;
      }

      const signal = {
        direction: firstDirection,
        boxType: box.type,
        touchType: "RETEST",
        sourceBoxType: box.type,
        boxId,
        boxHigh: box.high,
        boxLow: box.low,
        asiaHigh: asia.high,
        asiaLow: asia.low,
        entry: firstDirection === "BUY"
          ? box.high + entryBuffer
          : box.low - entryBuffer,
        pip: unit,
        candleTime: candles[firstTouchIndex].epoch,
        reason: "Signal confirmed"
      };

      if (!best || box.created > best.created) {
        best = { ...signal, created: box.created };
      }

      continue;
    }

    const oppositeBoundary =
      firstBoundary === "TOP" ? "BOTTOM" : "TOP";

    let oppositeBreakIndex = -1;

    for (let i = firstTouchIndex + 1; i <= lastIndex; i++) {
      if (
        firstBoundary === "TOP" &&
        candles[i].close < box.low
      ) {
        oppositeBreakIndex = i;
        break;
      }

      if (
        firstBoundary === "BOTTOM" &&
        candles[i].close > box.high
      ) {
        oppositeBreakIndex = i;
        break;
      }
    }

    if (oppositeBreakIndex < 0) {
      sawNeutral = true;
      continue;
    }

    sawOppositeBreak = true;

    let flippyTouchIndex = -1;

    for (let i = oppositeBreakIndex + 1; i <= lastIndex; i++) {
      const touched = oppositeBoundary === "TOP"
        ? touchesTop(candles[i], box)
        : touchesBottom(candles[i], box);

      if (touched) {
        flippyTouchIndex = i;
        break;
      }
    }

    if (flippyTouchIndex < 0) continue;

    sawFlippyRetest = true;

    // FLIPPY retest must also be the latest closed candle.
    if (flippyTouchIndex !== lastIndex) continue;

    let touchCount = 2;
    let deleted = false;

    for (let i = flippyTouchIndex + 1; i <= lastIndex; i++) {
      if (touchesBox(candles[i], box)) {
        touchCount++;

        if (touchCount >= 3) {
          deleted = true;
          break;
        }
      }
    }

    if (deleted) {
      deletedBoxIds.push(boxId);
      continue;
    }

    const flippyDirection = getRetestDirection(
      candles[flippyTouchIndex],
      oppositeBoundary
    );

    if (flippyDirection === "NONE") {
      sawNeutral = true;
      continue;
    }

    const signal = {
      direction: flippyDirection,
      boxType: "FLIPPY",
      sourceBoxType: box.type,
      touchType: "FLIPPY",
      boxId,
      boxHigh: box.high,
      boxLow: box.low,
      asiaHigh: asia.high,
      asiaLow: asia.low,
      entry: flippyDirection === "BUY"
        ? box.high + entryBuffer
        : box.low - entryBuffer,
      pip: unit,
      candleTime: candles[flippyTouchIndex].epoch,
      reason: "Signal confirmed"
    };

    if (!best || box.created > best.created) {
      best = { ...signal, created: box.created };
    }
  }

  if (best) {
    const { created, ...signal } = best;

    return {
      ...signal,
      deletedBoxIds,
      reason: "Signal confirmed"
    };
  }

  let reason = "Waiting for breakout";

  if (deletedBoxIds.length) reason = "Third touch — DELETE";
  else if (sawFlippyRetest) reason = "Neutral retest candle";
  else if (sawOppositeBreak) reason = "Waiting for FLIPPY retest";
  else if (sawFirstRetest) reason = "Waiting for opposite-side breakout";
  else if (sawBreakout) reason = "Waiting for first retest";
  else if (sawNeutral) reason = "Neutral retest candle";

  return {
    direction: "NONE",
    reason,
    boxCount: boxes.length,
    deletedBoxIds
  };
}

// Non-Forex SL uses average range of latest 14 closed M5 candles.
// TP maintains the 3.1:1 reward-to-risk ratio.
function nonForexStopDistance(signal, candles) {
  const recent = candles.slice(-14);

  const ranges = recent
    .map(c => c.high - c.low)
    .filter(n => Number.isFinite(n) && n > 0);

  const averageRange = ranges.length
    ? ranges.reduce((a, b) => a + b, 0) / ranges.length
    : signal.pip * 10;

  const minimumDistance = signal.pip * 10;

  return Math.max(averageRange, minimumDistance);
}

function makeDemoOrder(signal, symbol, category, balance, riskPct, candles = []) {
  const point = signal.pip;
  const isForex = category === "Forex";

  const slDistance = isForex
    ? FX_SL_PIPS * point
    : nonForexStopDistance(signal, candles);

  const tpDistance = isForex
    ? FX_TP_PIPS * point
    : slDistance * 3.1;

  const buy = signal.direction === "BUY";

  const sl = buy
    ? signal.entry - slDistance
    : signal.entry + slDistance;

  const tp = buy
    ? signal.entry + tpDistance
    : signal.entry - tpDistance;

  const safeRisk = Math.max(
    0,
    Number.isFinite(riskPct) ? riskPct : 0
  );

  const createdAtMs = Date.now();

  return {
    id: `${symbol}-${signal.boxId}-${createdAtMs}`,
    boxId: signal.boxId,
    symbol,
    category,
    direction: signal.direction,
    source: `${signal.boxType} ${signal.touchType} · MARKET EXECUTION`,
    entry: signal.entry,
    sl,
    tp,
    slDistance,
    tpDistance,
    riskMoney: balance * safeRisk / 100,
    status: "OPEN DEMO TRADE",
    currentPrice: signal.entry,
    floatingPnl: 0,
    fillPrice: signal.entry,
    filledAt: new Date(createdAtMs).toLocaleTimeString(),
    created: new Date(createdAtMs).toLocaleTimeString(),
    createdAtMs
  };
}

function calculateDemoPnl(trade, price) {
  const stopDistance = Math.abs(trade.entry - trade.sl);

  if (!stopDistance) return 0;

  const priceMove = trade.direction === "BUY"
    ? price - trade.entry
    : trade.entry - price;

  return (priceMove / stopDistance) * trade.riskMoney;
}

function getExitReason(trade, price) {
  if (trade.direction === "BUY") {
    if (price <= trade.sl) return "STOP LOSS";
    if (price >= trade.tp) return "TAKE PROFIT";
  } else {
    if (price >= trade.sl) return "STOP LOSS";
    if (price <= trade.tp) return "TAKE PROFIT";
  }

  return null;
}

function sendBrowserNotification(title, body) {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "granted") {
    new Notification(title, { body });
    return true;
  }

  return false;
}

export default function App() {
  const socketRef = useRef(null);
  const requestRef = useRef(0);
  const pendingRequestsRef = useRef(new Map());
  const scanLockRef = useRef(false);
  const runningRef = useRef(false);
  const scanTimerRef = useRef(null);

  const subscriptionsRef = useRef(new Map());
  const subscribingRef = useRef(new Set());
  const latestPricesRef = useRef({});
  const ordersRef = useRef([]);
  const closedTradesRef = useRef([]);

  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [connectionText, setConnectionText] = useState("DISCONNECTED");

  const [symbols, setSymbols] = useState([]);
  const [signals, setSignals] = useState({});
  const [candleDiagnostics, setCandleDiagnostics] = useState({});
  const [orders, setOrders] = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);

  const [lastActivated, setLastActivated] = useState("NONE");
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [progress, setProgress] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [balance, setBalance] = useState(10000);
  const [riskPct, setRiskPct] = useState(1);
  const [fixedLots, setFixedLots] = useState(0.10);
  const [message, setMessage] = useState(
    "Connect to Deriv to discover available markets."
  );
  const [lastScan, setLastScan] = useState("Not scanned");
  const [latestPrices, setLatestPrices] = useState({});

  const updateOrders = useCallback(updater => {
    const next = typeof updater === "function"
      ? updater(ordersRef.current)
      : updater;

    ordersRef.current = next;
    setOrders(next);
  }, []);

  const updateClosedTrades = useCallback(updater => {
    const next = typeof updater === "function"
      ? updater(closedTradesRef.current)
      : updater;

    closedTradesRef.current = next;
    setClosedTrades(next);
  }, []);

  const request = useCallback(payload => {
    return new Promise((resolve, reject) => {
      const ws = socketRef.current;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Deriv data connection is not open."));
        return;
      }

      const id = ++requestRef.current;

      const timeout = setTimeout(() => {
        pendingRequestsRef.current.delete(id);
        reject(new Error("Deriv request timed out."));
      }, 30000);

      pendingRequestsRef.current.set(id, {
        resolve,
        reject,
        timeout
      });

      ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }, []);

  const processTick = useCallback((symbol, price) => {
    if (!symbol || !Number.isFinite(price)) return;

    latestPricesRef.current[symbol] = price;

    setLatestPrices(previous => ({
      ...previous,
      [symbol]: price
    }));

    const remaining = [];
    const newlyClosed = [];

    for (const original of ordersRef.current) {
      if (
        original.symbol !== symbol ||
        original.status !== "OPEN DEMO TRADE"
      ) {
        remaining.push(original);
        continue;
      }

      const trade = {
        ...original,
        currentPrice: price
      };

      const exitReason = getExitReason(trade, price);

      if (exitReason) {
        const finalPnl = calculateDemoPnl(trade, price);

        newlyClosed.push({
          ...trade,
          status: "CLOSED",
          exitPrice: price,
          exitReason,
          realisedPnl: finalPnl,
          floatingPnl: 0,
          closedAt: new Date().toLocaleTimeString()
        });

        continue;
      }

      trade.floatingPnl = calculateDemoPnl(trade, price);
      remaining.push(trade);
    }

    updateOrders(remaining);

    if (newlyClosed.length) {
      updateClosedTrades(previous => [
        ...newlyClosed,
        ...previous
      ]);

      setMessage(
        newlyClosed.map(t =>
          `${t.symbol} ${t.exitReason}: ${t.realisedPnl >= 0 ? "+" : ""}$${fmt(t.realisedPnl, 2)}`
        ).join(" · ")
      );
    }
  }, [updateOrders, updateClosedTrades]);

  const connect = useCallback(() => {
    return new Promise((resolve, reject) => {
      if (
        socketRef.current &&
        socketRef.current.readyState === WebSocket.OPEN
      ) {
        resolve();
        return;
      }

      setConnectionText("CONNECTING");

      const ws = new WebSocket(WS_URL);
      socketRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setConnectionText("DATA CONNECTED");
        resolve();
      };

      ws.onmessage = event => {
        let data;

        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (data.msg_type === "tick" && data.tick) {
          processTick(
            data.tick.symbol,
            Number(data.tick.quote)
          );
        }

        if (data.req_id && pendingRequestsRef.current.has(data.req_id)) {
          const pending = pendingRequestsRef.current.get(data.req_id);

          clearTimeout(pending.timeout);
          pendingRequestsRef.current.delete(data.req_id);

          if (data.error) {
            pending.reject(new Error(data.error.message));
          } else {
            pending.resolve(data);
          }
        }
      };

      ws.onerror = () => {
        setConnectionText("CONNECTION ERROR");
        reject(new Error("Could not connect to Deriv."));
      };

      ws.onclose = () => {
        setConnected(false);
        setConnectionText("DISCONNECTED");

        subscriptionsRef.current.clear();
        subscribingRef.current.clear();

        pendingRequestsRef.current.forEach(p => {
          clearTimeout(p.timeout);
          p.reject(new Error("Connection closed."));
        });

        pendingRequestsRef.current.clear();

        if (runningRef.current) {
          runningRef.current = false;
          setRunning(false);
          setMessage("Deriv connection closed. Robot stopped.");
        }
      };
    });
  }, [processTick]);

  const subscribeMarket = useCallback(async symbol => {
    if (subscriptionsRef.current.has(symbol)) return true;

    if (subscribingRef.current.has(symbol)) {
      return false;
    }

    if (
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN
    ) {
      setMessage(`${symbol}: Deriv is disconnected.`);
      return false;
    }

    subscribingRef.current.add(symbol);

    try {
      const response = await request({
        ticks: symbol,
        subscribe: 1
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const subscriptionId = response.subscription?.id || "SUBSCRIBED";

      subscriptionsRef.current.set(symbol, subscriptionId);

      if (response.tick) {
        processTick(
          response.tick.symbol || symbol,
          Number(response.tick.quote)
        );
      }

      setMessage(`${symbol}: live price monitoring active.`);
      return true;
    } catch (error) {
      setMessage(`${symbol}: subscription failed: ${error.message}`);
      return false;
    } finally {
      subscribingRef.current.delete(symbol);
    }
  }, [request, processTick]);

  const discoverMarkets = useCallback(async () => {
    setMessage("Requesting active markets from Deriv...");

    const response = await request({
      active_symbols: "full"
    });

    const rawList =
      response.active_symbols ||
      response.data?.active_symbols ||
      [];

    if (!Array.isArray(rawList)) {
      throw new Error("Deriv active-symbol response was not an array.");
    }

    const list = rawList
      .map(s => {
        const symbol = s.underlying_symbol || s.symbol || "";

        return {
          ...s,
          symbol,
          display_name: s.underlying_symbol_name || s.display_name || symbol,
          symbol_type: s.underlying_symbol_type || s.symbol_type || "",
          pip: s.pip_size ?? s.pip ?? null
        };
      })
      .filter(s =>
        s.symbol &&
        Number(s.is_trading_suspended || 0) !== 1
      )
      .map(s => ({
        ...s,
        category: categoryOf(s)
      }))
      .sort((a, b) =>
        String(a.display_name).localeCompare(String(b.display_name))
      );

    setSymbols(list);
    setMessage(`${list.length} active Deriv markets discovered.`);

    return list;
  }, [request]);

  const scanSymbol = useCallback(async item => {
    const diagnostic = {
      requestedMaximum: CANDLE_COUNT,
      returned: 0,
      valid: 0,
      closed: 0,
      latestEpoch: null,
      oldestEpoch: null,
      responseType: "Not received",
      error: null
    };

    try {
      const response = await request({
        ticks_history: item.symbol,
        count: CANDLE_COUNT,
        end: "latest",
        style: "candles",
        granularity: TIMEFRAME
      });

      diagnostic.responseType = response.msg_type || "Unknown";

      const raw = Array.isArray(response.candles)
        ? response.candles
        : [];

      diagnostic.returned = raw.length;

      const candles = raw.map(c => ({
        epoch: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      })).filter(c =>
        Number.isFinite(c.epoch) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.high >= c.low
      ).sort((a, b) => a.epoch - b.epoch);

      diagnostic.valid = candles.length;

      const now = Math.floor(Date.now() / 1000);

      const closed = candles.filter(c =>
        c.epoch + TIMEFRAME <= now
      );

      diagnostic.closed = closed.length;

      if (closed.length) {
        diagnostic.oldestEpoch = closed[0].epoch;
        diagnostic.latestEpoch = closed[closed.length - 1].epoch;
      }

      const signal = findRetestSignal(
        closed,
        item.symbol,
        item.category
      );

      return {
        ...signal,
        _candles: closed,
        _candleData: diagnostic
      };
    } catch (error) {
      diagnostic.error = error.message || "Unknown Deriv API error";

      return {
        direction: "NONE",
        reason: "Market data unavailable",
        deletedBoxIds: [],
        _candles: [],
        _candleData: diagnostic
      };
    }
  }, [request]);

  const scanAll = useCallback(async list => {
    if (scanLockRef.current || !runningRef.current) return;

    scanLockRef.current = true;
    setMessage("Scanning all available Deriv markets...");

    const results = {};
    let completed = 0;
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < list.length && runningRef.current) {
        const index = nextIndex++;
        const item = list[index];

        const result = await scanSymbol(item);
        results[item.symbol] = result;

        if (result._candleData) {
          setCandleDiagnostics(previous => ({
            ...previous,
            [item.symbol]: result._candleData
          }));
        }

        completed++;
        setScanned(completed);
        setProgress(Math.round(completed / list.length * 100));

        if (completed % 10 === 0) {
          setSignals(previous => ({
            ...previous,
            ...results
          }));
        }
      }
    };

    try {
      await Promise.all([worker(), worker()]);

      setSignals(previous => ({
        ...previous,
        ...results
      }));

      setMessage(
        runningRef.current
          ? `Scan complete: ${completed} of ${list.length} symbols checked.`
          : "Scanning stopped."
      );

      setLastScan(new Date().toLocaleTimeString());
    } finally {
      scanLockRef.current = false;
    }
  }, [scanSymbol]);

  const startRobot = async () => {
    if (runningRef.current) return;

    try {
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "default"
      ) {
        try {
          await Notification.requestPermission();
        } catch {
          // Notifications may be blocked.
        }
      }

      setMessage("Connecting to Deriv...");
      await connect();

      runningRef.current = true;
      setRunning(true);

      setCandleDiagnostics({});
      setSignals({});
      setScanned(0);
      setProgress(0);

      const list = await discoverMarkets();

      if (!list.length) {
        setMessage("No active markets returned by Deriv.");
        runningRef.current = false;
        setRunning(false);
        return;
      }

      await scanAll(list);

      if (scanTimerRef.current) {
        clearInterval(scanTimerRef.current);
      }

      scanTimerRef.current = setInterval(() => {
        if (runningRef.current) {
          scanAll(list);
        }
      }, TIMEFRAME * 1000);
    } catch (error) {
      runningRef.current = false;
      setRunning(false);
      setMessage(error.message);
    }
  };

  const stopRobot = () => {
    runningRef.current = false;
    setRunning(false);

    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }

    const now = new Date().toLocaleTimeString();
    const closedNow = [];

    for (const order of ordersRef.current) {
      if (order.status !== "OPEN DEMO TRADE") continue;

      const price =
        latestPricesRef.current[order.symbol] ??
        order.currentPrice ??
        order.entry;

      closedNow.push({
        ...order,
        status: "CLOSED",
        exitPrice: price,
        exitReason: "ROBOT STOPPED",
        realisedPnl: calculateDemoPnl(order, price),
        floatingPnl: 0,
        closedAt: now
      });
    }

    if (closedNow.length) {
      updateClosedTrades(previous => [
        ...closedNow,
        ...previous
      ]);
    }

    updateOrders([]);

    const ws = socketRef.current;

    if (ws && ws.readyState === WebSocket.OPEN) {
      subscriptionsRef.current.forEach(subscriptionId => {
        if (subscriptionId && subscriptionId !== "SUBSCRIBED") {
          try {
            ws.send(JSON.stringify({
              forget: subscriptionId,
              req_id: ++requestRef.current
            }));
          } catch {
            // Socket may already be closing.
          }
        }
      });
    }

    subscriptionsRef.current.clear();
    subscribingRef.current.clear();

    setMessage(
      `STOPPED. ${closedNow.length} open demo trade(s) closed.`
    );
  };

  // Click BUY or SELL to execute immediately at the current live price.
  const activateSignal = async item => {
    const signal = signals[item.symbol];

    if (!signal || signal.direction === "NONE") return;

    if (!signal.boxId) {
      setMessage("Signal has no valid box identifier.");
      return;
    }

    const duplicate = ordersRef.current.some(order =>
      order.symbol === item.symbol &&
      order.boxId === signal.boxId
    );

    if (duplicate) {
      setMessage(`${item.symbol}: this box already has a trade.`);
      return;
    }

    const alreadyClosed = closedTradesRef.current.some(order =>
      order.symbol === item.symbol &&
      order.boxId === signal.boxId
    );

    if (alreadyClosed) {
      setMessage(`${item.symbol}: this box has already been traded.`);
      return;
    }

    // Ensure a live price subscription exists before execution.
    const subscribed = await subscribeMarket(item.symbol);

    if (!subscribed) {
      setMessage(`${item.symbol}: could not obtain live price. Try again.`);
      return;
    }

    const currentPrice = latestPricesRef.current[item.symbol];

    if (!Number.isFinite(currentPrice)) {
      setMessage(`${item.symbol}: waiting for live price. Try again.`);
      return;
    }

    // Recheck duplicate after awaiting the live-price subscription.
    const duplicateAfterSubscription = ordersRef.current.some(order =>
      order.symbol === item.symbol &&
      order.boxId === signal.boxId
    );

    if (duplicateAfterSubscription) {
      setMessage(`${item.symbol}: this box already has a trade.`);
      return;
    }

    const executionSignal = {
      ...signal,
      entry: currentPrice
    };

    const order = makeDemoOrder(
      executionSignal,
      item.symbol,
      item.category,
      balance,
      riskPct,
      signal._candles || []
    );

    updateOrders(previous => [order, ...previous]);

    setSelected(item);
    setLastActivated(
      `${signal.direction} · ${signal.boxType} · MARKET EXECUTION`
    );

    setMessage(
      `${item.symbol}: ${signal.direction} OPENED IMMEDIATELY at ${fmt(currentPrice, 8)}.`
    );

    sendBrowserNotification(
      "iFX BILLIONAIRE — Trade Opened",
      `${item.symbol} ${signal.direction} at ${fmt(currentPrice, 8)}`
    );
  };

  useEffect(() => {
    return () => {
      runningRef.current = false;

      if (scanTimerRef.current) {
        clearInterval(scanTimerRef.current);
      }

      if (socketRef.current) {
        socketRef.current.close();
      }

      pendingRequestsRef.current.forEach(p => {
        clearTimeout(p.timeout);
      });

      pendingRequestsRef.current.clear();
    };
  }, []);

  const visibleSymbols = symbols.filter(item => {
    const matchesCategory =
      category === "All" || item.category === category;

    const searchTerm = search.toLowerCase();

    const matchesSearch =
      !searchTerm ||
      String(item.display_name || "").toLowerCase().includes(searchTerm) ||
      String(item.symbol || "").toLowerCase().includes(searchTerm);

    return matchesCategory && matchesSearch;
  });

  const buyCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "BUY"
  ).length;

  const sellCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "SELL"
  ).length;

  const pendingOrders = orders.filter(o =>
    o.status === "DEMO PENDING"
  );

  const openTrades = orders.filter(o =>
    o.status === "OPEN DEMO TRADE"
  );

  const floatingPnl = openTrades.reduce(
    (total, trade) => total + (trade.floatingPnl || 0),
    0
  );

  const realisedPnl = closedTrades.reduce(
    (total, trade) => total + (trade.realisedPnl || 0),
    0
  );

  const totalPnl = floatingPnl + realisedPnl;

  const moneyColor = value =>
    value > 0 ? "#16c784" : value < 0 ? "#ea5455" : "#eef4ff";

  const diagnosticCounts = {};

  DIAGNOSTIC_REASONS.forEach(reason => {
    diagnosticCounts[reason] = 0;
  });

  symbols.forEach(item => {
    const result = signals[item.symbol];
    if (!result) return;

    const reason = result.direction !== "NONE"
      ? "Signal confirmed"
      : result.reason || "Market data unavailable";

    diagnosticCounts[reason] =
      (diagnosticCounts[reason] || 0) + 1;
  });

  const diagnosticMarkets = symbols
    .filter(item => signals[item.symbol])
    .filter(item => signals[item.symbol].direction === "NONE")
    .sort((a, b) =>
      String(a.display_name).localeCompare(String(b.display_name))
    );

  const candleDiagnosticList = Object.values(candleDiagnostics);

  const marketsWithCandleData = candleDiagnosticList.filter(d =>
    d.returned > 0
  ).length;

  const marketsWithErrors = candleDiagnosticList.filter(d =>
    d.error
  ).length;

  const signalColor = direction =>
    direction === "BUY"
      ? "#16c784"
      : direction === "SELL"
      ? "#ea5455"
      : "#8993a4";

  const card = {
    background: "#101a2b",
    border: "1px solid #24334b",
    borderRadius: 13,
    padding: 14,
    marginBottom: 12
  };

  const title = {
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: 1,
    color: "#dce8fb"
  };

  const small = {
    fontSize: 10,
    color: "#8395af",
    marginTop: 6,
    lineHeight: 1.5
  };

  const stat = {
    padding: 13,
    background: "#101a2b",
    border: "1px solid #24334b",
    borderRadius: 10
  };

  const statLabel = {
    fontSize: 9,
    color: "#8193ad",
    fontWeight: 800,
    letterSpacing: .7
  };

  const statValue = {
    fontSize: 22,
    fontWeight: 900,
    marginTop: 7
  };

  const orderCard = {
    background: "#0b1525",
    border: "1px solid #2b3e58",
    borderRadius: 9,
    padding: 12,
    marginTop: 10
  };

  const orderGrid = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
    marginTop: 13,
    fontSize: 9,
    color: "#8395af"
  };

  const diagnosticRow = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    background: "#0b1525",
    padding: "10px 11px",
    borderRadius: 7,
    marginTop: 7
  };

  const searchStyle = {
    width: "100%",
    marginTop: 13,
    background: "#0a1424",
    border: "1px solid #30435e",
    borderRadius: 8,
    color: "white",
    padding: 12,
    fontSize: 13
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080d18",
      color: "#eef4ff",
      fontFamily: "Arial, sans-serif"
    }}>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #080d18; }
        button, input { font: inherit; }
        button { cursor: pointer; }
        .market-scroll {
          display:flex; gap:7px; overflow-x:auto;
          padding:4px 0 10px; scrollbar-width:none;
        }
        .market-scroll::-webkit-scrollbar { display:none; }
        .market-card:active { transform:scale(.99); }
        .market-card { transition:transform .12s ease; }
        .market-card:disabled { opacity:.55; cursor:not-allowed; }
        input:focus { outline:1px solid #31a8ff; }
      `}</style>

      <header style={{
        padding: "20px 16px",
        background: "#101a2b",
        borderBottom: "1px solid #24334b",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10
      }}>
        <div>
          <div style={{
            fontSize: 19,
            fontWeight: 900,
            letterSpacing: 1.2
          }}>
            iFX BILLIONAIRE
          </div>
          <div style={{
            fontSize: 10,
            color: "#8293ad",
            marginTop: 5,
            letterSpacing: 1.5
          }}>
            HLZ MOBILE ROBOT · RETEST EDITION
          </div>
        </div>

        <div style={{
          borderRadius: 20,
          padding: "8px 11px",
          fontSize: 11,
          fontWeight: 900,
          background: running ? "#123e30" : "#33252a",
          color: running ? "#25d99a" : "#ff7a82"
        }}>
          ● {running ? "RUNNING" : "STOPPED"}
        </div>
      </header>

      <main style={{
        width: "100%",
        maxWidth: 900,
        margin: "0 auto",
        padding: 12
      }}>
        <section style={card}>
          <div style={title}>ROBOT CONTROL</div>
          <div style={small}>
            ● {connectionText}
            <span style={{
              marginLeft: 10,
              color: "#f4c46a",
              background: "#382e1d",
              padding: "5px 7px",
              borderRadius: 5,
              fontWeight: 900
            }}>
              DEMO EXECUTION
            </span>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 9,
            marginTop: 15
          }}>
            <button
              onClick={startRobot}
              disabled={running}
              style={{
                border: 0,
                borderRadius: 9,
                background: "#138d68",
                color: "white",
                padding: 14,
                fontWeight: 900,
                opacity: running ? .5 : 1
              }}
            >
              ▶ START ROBOT
            </button>

            <button
              onClick={stopRobot}
              disabled={!running && orders.length === 0}
              style={{
                border: 0,
                borderRadius: 9,
                background: "#a52d3a",
                color: "white",
                padding: 14,
                fontWeight: 900
              }}
            >
              ■ STOP
            </button>
          </div>

          <div style={small}>{message}</div>

          <div style={{
            height: 5,
            background: "#26364e",
            borderRadius: 10,
            marginTop: 10,
            overflow: "hidden"
          }}>
            <div style={{
              height: "100%",
              background: "#31a8ff",
              width: `${progress}%`
            }}/>
          </div>

          <div style={small}>
            Scan progress: {scanned}/{symbols.length} · {progress}%
          </div>
        </section>

        <section style={{
          display: "grid",
          gridTemplateColumns: "repeat(2,minmax(0,1fr))",
          gap: 8,
          marginBottom: 12
        }}>
          <div style={stat}>
            <div style={statLabel}>MARKETS FOUND</div>
            <div style={statValue}>{symbols.length}</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>BUY SIGNALS</div>
            <div style={{ ...statValue, color: "#16c784" }}>{buyCount}</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>SELL SIGNALS</div>
            <div style={{ ...statValue, color: "#ea5455" }}>{sellCount}</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>OPEN DEMO TRADES</div>
            <div style={statValue}>{openTrades.length}</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>PENDING ORDERS</div>
            <div style={statValue}>{pendingOrders.length}</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>FLOATING P&L</div>
            <div style={{ ...statValue, color: moneyColor(floatingPnl) }}>
              {floatingPnl >= 0 ? "+" : ""}${fmt(floatingPnl, 2)}
            </div>
          </div>
          <div style={stat}>
            <div style={statLabel}>REALISED P&L</div>
            <div style={{ ...statValue, color: moneyColor(realisedPnl) }}>
              {realisedPnl >= 0 ? "+" : ""}${fmt(realisedPnl, 2)}
            </div>
          </div>
          <div style={stat}>
            <div style={statLabel}>TOTAL P&L</div>
            <div style={{ ...statValue, color: moneyColor(totalPnl) }}>
              {totalPnl >= 0 ? "+" : ""}${fmt(totalPnl, 2)}
            </div>
          </div>
        </section>

        <section style={card}>
          <div style={title}>ACTIVE RETEST SIGNALS</div>
          <div style={small}>
            All discovered Deriv markets · M5 · Latest closed candle only
          </div>

          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search symbol or market..."
            style={searchStyle}
          />

          <div className="market-scroll">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                style={{
                  border: 0,
                  borderRadius: 20,
                  padding: "8px 12px",
                  fontSize: 10,
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                  background: category === cat ? "#1677d2" : "#18243a",
                  color: category === cat ? "#fff" : "#aab7cc"
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          {!symbols.length && (
            <div style={{
              textAlign: "center",
              padding: 22,
              color: "#8395af"
            }}>
              Press START ROBOT to discover Deriv markets.
            </div>
          )}

          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 7
          }}>
            {visibleSymbols.map(item => {
              const signal = signals[item.symbol] || {
                direction: "NONE",
                reason: "Waiting for scan"
              };

              const isSelected = selected?.symbol === item.symbol;

              const hasOrder = orders.some(order =>
                order.symbol === item.symbol &&
                order.boxId === signal.boxId
              );

              return (
                <button
                  key={item.symbol}
                  className="market-card"
                  onClick={() => {
                    if (signal.direction !== "NONE") {
                      activateSignal(item);
                    } else {
                      setSelected(item);
                      setMessage(
                        `${item.display_name}: ${signal.reason || "No signal"}`
                      );
                    }
                  }}
                  style={{
                    width: "100%",
                    background: "#0b1525",
                    border: `1px solid ${isSelected ? "#31a8ff" : "#24334b"}`,
                    borderRadius: 9,
                    padding: 11,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    textAlign: "left",
                    gap: 8,
                    color: "#edf4ff"
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>
                      {item.display_name || item.symbol}
                    </div>
                    <div style={small}>
                      {item.symbol} · {item.category}
                    </div>

                    {signal.direction !== "NONE" && (
                      <>
                        <div style={{
                          fontSize: 9,
                          color: "#a9c9e9",
                          marginTop: 5
                        }}>
                          {signal.boxType} · {signal.touchType}
                        </div>
                        <div style={{
                          fontSize: 9,
                          color: "#a9c9e9",
                          marginTop: 5
                        }}>
                          Execution: CURRENT MARKET PRICE
                        </div>
                        {hasOrder && (
                          <div style={{
                            fontSize: 9,
                            color: "#f4c46a",
                            marginTop: 5
                          }}>
                            THIS BOX ALREADY TRADED
                          </div>
                        )}
                      </>
                    )}

                    {signal.direction === "NONE" && (
                      <div style={{
                        fontSize: 10,
                        color: "#f1c477",
                        marginTop: 5
                      }}>
                        {signal.reason}
                      </div>
                    )}
                  </div>

                  <div style={{
                    minWidth: 65,
                    textAlign: "center",
                    padding: "8px 7px",
                    borderRadius: 6,
                    fontSize: 10,
                    fontWeight: 900,
                    color: "#07111c",
                    background: signalColor(signal.direction)
                  }}>
                    {signal.direction}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section style={card}>
          <div style={title}>TRADE SETTINGS</div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(2,minmax(0,1fr))",
            gap: 12,
            marginTop: 13
          }}>
            {[
              ["Demo balance ($)", balance, setBalance],
              ["Risk per trade (%)", riskPct, setRiskPct],
              ["Fixed lots (display only)", fixedLots, setFixedLots]
            ].map(([label, value, setter]) => (
              <label key={label} style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
                fontSize: 10,
                color: "#94a8c3"
              }}>
                <span>{label}</span>
                <input
                  type="number"
                  value={value}
                  onChange={e => setter(Number(e.target.value))}
                  style={{
                    width: "100%",
                    minWidth: 0,
                    background: "#0a1424",
                    border: "1px solid #30435e",
                    borderRadius: 7,
                    color: "white",
                    padding: 10,
                    fontSize: 13
                  }}
                />
              </label>
            ))}
          </div>

          <div style={{
            marginTop: 13,
            fontSize: 10,
            lineHeight: 1.7,
            color: "#a8b7cb",
            background: "#0b1525",
            padding: 10,
            borderRadius: 7
          }}>
            EXECUTION: Immediate demo market execution at the live price.
            <br/>
            FOREX: 10-pip SL / 31-pip TP.
            <br/>
            NON-FOREX: SL based on average range of the latest 14 closed M5 candles.
            <br/>
            NON-FOREX TP: 3.1 times the calculated SL distance.
            <br/>
            NO PENDING ORDERS OR EXPIRY.
          </div>
        </section>

        <section style={card}>
          <div style={title}>MARKET EXECUTION</div>
          <div style={small}>
            Trades open immediately at the current live price when you click a valid signal.
          </div>

          {!pendingOrders.length && (
            <div style={{
              textAlign: "center",
              padding: 18,
              color: "#8395af"
            }}>
              No pending orders. All new signals use immediate market execution.
            </div>
          )}
        </section>

        <section style={card}>
          <div style={title}>OPEN DEMO TRADES</div>
          <div style={small}>Live price monitoring · Floating P&L</div>

          {!openTrades.length && (
            <div style={{
              textAlign: "center",
              padding: 18,
              color: "#8395af"
            }}>
              No open demo trades.
            </div>
          )}

          {openTrades.map(trade => (
            <div key={trade.id} style={orderCard}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10
              }}>
                <strong>{trade.symbol}</strong>
                <strong style={{
                  color: trade.direction === "BUY" ? "#16c784" : "#ea5455"
                }}>
                  {trade.direction}
                </strong>
              </div>

              <div style={small}>
                {trade.source} · {trade.status}
              </div>

              <div style={orderGrid}>
                <div>
                  ENTRY
                  <b style={{ display: "block", color: "white" }}>
                    {fmt(trade.entry, 8)}
                  </b>
                </div>
                <div>
                  CURRENT PRICE
                  <b style={{ display: "block", color: "white" }}>
                    {fmt(trade.currentPrice, 8)}
                  </b>
                </div>
                <div>
                  STOP LOSS
                  <b style={{ display: "block", color: "white" }}>
                    {fmt(trade.sl, 8)}
                  </b>
                </div>
                <div>
                  TAKE PROFIT
                  <b style={{ display: "block", color: "white" }}>
                    {fmt(trade.tp, 8)}
                  </b>
                </div>
                <div>
                  RISK
                  <b style={{ display: "block", color: "white" }}>
                    ${fmt(trade.riskMoney, 2)}
                  </b>
                </div>
              </div>

              <div style={{
                marginTop: 12,
                fontSize: 17,
                fontWeight: 900,
                color: moneyColor(trade.floatingPnl)
              }}>
                FLOATING P&L: {trade.floatingPnl >= 0 ? "+" : ""}
                ${fmt(trade.floatingPnl, 2)}
              </div>
            </div>
          ))}
        </section>

        <section style={card}>
          <div style={title}>CLOSED DEMO TRADES</div>
          <div style={small}>Results after SL, TP or robot stop</div>

          {!closedTrades.length && (
            <div style={{
              textAlign: "center",
              padding: 18,
              color: "#8395af"
            }}>
              No closed demo trades yet.
            </div>
          )}

          {closedTrades.slice(0, 20).map(trade => (
            <div key={trade.id} style={orderCard}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10
              }}>
                <strong>{trade.symbol} · {trade.direction}</strong>
                <strong style={{ color: moneyColor(trade.realisedPnl) }}>
                  {trade.realisedPnl >= 0 ? "+" : ""}
                  ${fmt(trade.realisedPnl, 2)}
                </strong>
              </div>

              <div style={small}>
                {trade.exitReason} · Closed {trade.closedAt}
              </div>

              <div style={small}>
                Entry: {fmt(trade.entry, 8)} · Exit: {fmt(trade.exitPrice, 8)}
              </div>
            </div>
          ))}
        </section>

        <section style={card}>
          <div style={title}>LAST ACTIVATED</div>
          <div style={{
            marginTop: 12,
            padding: 12,
            background: "#0b1525",
            borderRadius: 8,
            color: "#48c9a0",
            fontSize: 13,
            fontWeight: 900,
            overflowWrap: "anywhere"
          }}>
            {lastActivated}
          </div>
          <div style={small}>Last scan: {lastScan}</div>
        </section>

        <section style={{
          background: "#302719",
          border: "1px solid #725b2e",
          color: "#f4d69a",
          padding: 13,
          borderRadius: 10,
          fontSize: 11,
          lineHeight: 1.6,
          marginBottom: 12
        }}>
          <strong>IMPORTANT — EXECUTION STATUS</strong>
          <p>
            This build uses Deriv public market data and simulated demo orders.
            It does not place or manage real broker trades.
          </p>
          <p>
            A qualifying BUY or SELL opens immediately at the current live
            market price when its market card is clicked.
          </p>
          <p>
            Signals require a qualifying touch on the latest closed M5 candle.
            Green candle touching the box bottom = SELL. Red candle touching
            the box top = BUY.
          </p>
          <p>
            No pending orders or pending-order expiry are used.
          </p>
          <p>
            Browser notifications must be permitted for trade alerts.
            Notifications may not arrive if the browser or app is closed.
          </p>
          <p>
            Non-Forex SL uses recent M5 candle range and TP uses 3.1 times
            that distance. These are simulated distances, not broker-specific
            contract or tick-value calculations.
          </p>
          <p>
            P&L is risk-normalised using configured risk and stop distance.
            It is not actual Deriv contract valuation. Fixed lots are display-only.
          </p>
          <p>Asia session is calculated using UTC candle timestamps.</p>
        </section>

        <section style={card}>
          <div style={title}>DERIV CANDLE DATA DIAGNOSTICS</div>
          <div style={small}>
            Maximum request: {CANDLE_COUNT} candles · M5
          </div>

          {scanned === 0 && (
            <div style={{
              textAlign: "center",
              padding: 18,
              color: "#8395af"
            }}>
              Start the robot to inspect Deriv candle responses.
            </div>
          )}

          {scanned > 0 && (
            <div style={{ marginTop: 14 }}>
              {[
                ["Markets checked", scanned],
                ["Maximum candles requested", CANDLE_COUNT],
                ["Markets with candle data", marketsWithCandleData],
                ["Markets with API errors", marketsWithErrors]
              ].map(([label, value]) => (
                <div key={label} style={diagnosticRow}>
                  <span style={{ color: "#b9c9df", fontSize: 11 }}>
                    {label}
                  </span>
                  <strong style={{ color: "#55c9ff" }}>{value}</strong>
                </div>
              ))}
            </div>
          )}

          <div style={{
            marginTop: 13,
            fontSize: 10,
            lineHeight: 1.7,
            color: "#a8b7cb",
            background: "#0b1525",
            padding: 10,
            borderRadius: 7
          }}>
            Deriv may return fewer candles than requested. All valid closed
            candles returned are used. No minimum of 1,200 candles is required.
          </div>
        </section>

        <section style={card}>
          <div style={title}>STRATEGY RULES</div>
          <div style={{
            marginTop: 13,
            fontSize: 10,
            lineHeight: 1.7,
            color: "#a8b7cb",
            background: "#0b1525",
            padding: 10,
            borderRadius: 7
          }}>
            ASIA RANGE: 00:00–07:00 UTC.
            <br/>
            BOXES: DOJI · ENGULFED · WICK.
            <br/>
            NORMAL RETEST: Green candle at bottom = SELL.
            Red candle at top = BUY.
            <br/>
            FLIPPY: First retest fails, price breaks the opposite
            side, then returns to retest that opposite boundary.
            <br/>
            BOX LIFECYCLE: First retest → Second retest/FLIPPY
            → Third touch DELETE.
            <br/>
            EXECUTION: Click BUY or SELL to open immediately at current price.
            <br/>
            SL/TP: Forex 10-pip SL / 31-pip TP.
            <br/>
            EMA: Completely removed. No EMA calculations or filters.
          </div>
        </section>

        <section style={card}>
          <div style={title}>INDIVIDUAL MARKET DATA</div>
          <div style={small}>
            Candle history returned by Deriv · {candleDiagnosticList.length} markets
          </div>

          {scanned === 0 && (
            <div style={{
              textAlign: "center",
              padding: 18,
              color: "#8395af"
            }}>
              Individual candle information will appear here after scanning.
            </div>
          )}

          {symbols
            .filter(item => candleDiagnostics[item.symbol])
            .map(item => {
              const d = candleDiagnostics[item.symbol];

              return (
                <div key={item.symbol} style={{
                  background: "#0b1525",
                  border: "1px solid #24334b",
                  padding: 10,
                  borderRadius: 7,
                  marginTop: 8
                }}>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>
                    {item.display_name || item.symbol}
                  </div>
                  <div style={small}>Symbol: {item.symbol}</div>
                  <div style={small}>Maximum requested: {d.requestedMaximum}</div>
                  <div style={small}>Returned by Deriv: {d.returned}</div>
                  <div style={small}>Valid candles: {d.valid}</div>
                  <div style={small}>Closed candles: {d.closed}</div>
                  <div style={small}>Response type: {d.responseType}</div>

                  {d.oldestEpoch && (
                    <div style={small}>
                      Oldest closed candle: {new Date(d.oldestEpoch * 1000).toISOString()}
                    </div>
                  )}

                  {d.latestEpoch && (
                    <div style={small}>
                      Latest closed candle: {new Date(d.latestEpoch * 1000).toISOString()}
                    </div>
                  )}

                  {d.error && (
                    <div style={{ ...small, color: "#ff7777" }}>
                      API ERROR: {d.error}
                    </div>
                  )}
                </div>
              );
            })}
        </section>

        <section style={card}>
          <div style={title}>STRATEGY DIAGNOSTICS</div>
          <div style={small}>
            Why each scanned market does or does not have a signal · {scanned} scanned
          </div>

          {!scanned && (
            <div style={{
              textAlign: "center",
              padding: 18,
              color: "#8395af"
            }}>
              Start the robot to see diagnostic results.
            </div>
          )}

          {scanned > 0 && (
            <div style={{ marginTop: 14 }}>
              {Object.entries(diagnosticCounts)
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <div key={reason} style={diagnosticRow}>
                    <span style={{ color: "#b9c9df", fontSize: 11 }}>
                      {reason}
                    </span>
                    <strong style={{ color: "#55c9ff" }}>{count}</strong>
                  </div>
                ))}
            </div>
          )}

          <div style={{
            marginTop: 13,
            fontSize: 10,
            lineHeight: 1.7,
            color: "#a8b7cb",
            background: "#0b1525",
            padding: 10,
            borderRadius: 7
          }}>
            Diagnostics only. No EMA conditions are used.
          </div>
        </section>

        <section style={card}>
          <div style={title}>MARKET-BY-MARKET REASONS</div>
          <div style={small}>
            Individual explanation for every market without a signal · {diagnosticMarkets.length} markets
          </div>

          {!scanned && (
            <div style={{
              textAlign: "center",
              padding: 18,
              color: "#8395af"
            }}>
              Start the robot to see individual market reasons.
            </div>
          )}

          {diagnosticMarkets.map(item => (
            <div key={item.symbol} style={{
              background: "#0b1525",
              border: "1px solid #24334b",
              padding: 10,
              borderRadius: 7,
              marginTop: 8
            }}>
              <div style={{ fontSize: 11, fontWeight: 800 }}>
                {item.display_name || item.symbol}
              </div>
              <div style={small}>{item.symbol}</div>
              <div style={{
                fontSize: 10,
                color: "#f1c477",
                marginTop: 5,
                lineHeight: 1.5
              }}>
                {signals[item.symbol]?.reason || "No diagnostic available"}
              </div>
            </div>
          ))}
        </section>

        <footer style={{
          textAlign: "center",
          padding: "16px 5px 28px",
          color: "#647893",
          fontSize: 9,
          letterSpacing: 1.2,
          lineHeight: 1.8
        }}>
          iFX BILLIONAIRE ROBOT · HLZ MOBILE
          <br/>
          Breakouts · Retests · FLIPPY · Immediate Market Execution
        </footer>
      </main>
    </div>
  );
}