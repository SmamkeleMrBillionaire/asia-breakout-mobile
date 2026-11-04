
import React, { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

const TIMEFRAME = 900;
const CANDLE_COUNT = 1000;

const SL_OFFSET_PIPS = 5;
const NORMAL_RR = 3;
const FADE_SL_OFFSET_PIPS = 10;
const FADE_RR = 2;

const MAX_BLUE_BOXES = 4;
const MAX_DAILY_TRADES = 4;
const MAX_OPEN_TRADES = 4;

const CATEGORIES = [
  "All", "Forex", "Indices", "Metals",
  "Synthetics", "Crypto", "Stocks", "Other"
];

const fmt = (n, digits = 5) =>
  Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "—";

function utcDate(epoch) {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function utcHour(epoch) {
  return new Date(epoch * 1000).getUTCHours();
}

function utcMinute(epoch) {
  return new Date(epoch * 1000).getUTCMinutes();
}

function candleColor(c) {
  if (c.close > c.open) return "GREEN";
  if (c.close < c.open) return "RED";
  return "NEUTRAL";
}

function categoryOf(s) {
  const market = String(s.market || "").toLowerCase();
  const sub = String(s.submarket || "").toLowerCase();
  const subgroup = String(s.subgroup || "").toLowerCase();
  const name = String(s.display_name || "").toLowerCase();
  const symbol = String(s.symbol || "").toLowerCase();
  const type = String(s.symbol_type || "").toLowerCase();

  if (market.includes("forex") || sub.includes("forex") || type.includes("forex")) {
    return "Forex";
  }

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

function pipSize(symbol, category, candles, marketPip) {
  if (Number.isFinite(Number(marketPip)) && Number(marketPip) > 0) {
    return Number(marketPip);
  }

  if (category === "Forex") {
    return symbol.toUpperCase().includes("JPY") ? 0.01 : 0.0001;
  }

  const last = candles[candles.length - 1]?.close || 1;
  const decimals = (String(last).split(".")[1] || "").length;

  return Math.pow(10, -Math.min(decimals, 8));
}

function sessionAt(epoch) {
  const hour = utcHour(epoch);

  if (hour >= 7 && hour < 11) return "LONDON";
  if (hour >= 15 && hour < 17) return "NEW YORK";

  return null;
}

function makeBoxId(type, epoch, high, low) {
  return [
    type,
    epoch,
    Number(high).toPrecision(12),
    Number(low).toPrecision(12)
  ].join("-");
}

function getVolumeLabel(candle) {
  if (
    candle &&
    Number.isFinite(Number(candle.volume)) &&
    candle.volume !== null &&
    candle.volume !== ""
  ) {
    return fmt(candle.volume, 0);
  }

  return "N/A";
}

function calculateRSI(candles, period = 3) {
  if (!candles || candles.length < period + 1) return null;

  const changes = [];

  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  const recent = changes.slice(-period);

  let gains = 0;
  let losses = 0;

  recent.forEach(change => {
    if (change > 0) gains += change;
    if (change < 0) losses += Math.abs(change);
  });

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0 && averageGain === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

function rsiAt(candles, index, period = 3) {
  if (index < period) return null;

  return calculateRSI(candles.slice(0, index + 1), period);
}

function candleTouchesTop(c, box) {
  return c.low <= box.high && c.high >= box.high;
}

function candleTouchesBottom(c, box) {
  return c.low <= box.low && c.high >= box.low;
}

function candleTouchesBox(c, box) {
  return c.low <= box.high && c.high >= box.low;
}

function rangesOverlap(a, b) {
  return a.low <= b.high && b.low <= a.high;
}

// ORANGE BOX: first four M15 candles of each UTC day.
function buildOrangeBoxes(candles) {
  const byDay = new Map();

  candles.forEach((c, index) => {
    if (utcHour(c.epoch) !== 0) return;

    const day = utcDate(c.epoch);

    if (!byDay.has(day)) byDay.set(day, []);

    byDay.get(day).push({ ...c, index });
  });

  const boxes = [];

  for (const [day, dayCandles] of byDay.entries()) {
    const firstHour = dayCandles
      .filter(c => utcMinute(c.epoch) < 60)
      .sort((a, b) => a.epoch - b.epoch);

    if (firstHour.length < 4) continue;

    const firstFour = firstHour.slice(0, 4);

    const high = Math.max(...firstFour.map(c => c.high));
    const low = Math.min(...firstFour.map(c => c.low));

    boxes.push({
      type: "ORANGE",
      day,
      high,
      low,
      createdEpoch: firstFour[0].epoch,
      createdIndex: firstFour[3].index,
      boxId: makeBoxId("ORANGE", firstFour[0].epoch, high, low)
    });
  }

  return boxes;
}

// BLUE BOXES: current ENGULFING candle or current DOJI candle.
// Boxes are created only from 01:00 to 22:00 UTC.
function buildBlueBoxes(candles) {
  const candidates = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    const hour = utcHour(c.epoch);

    if (hour < 1 || hour >= 22) continue;

    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);

    if (range <= 0) continue;

    const currentBull = c.close > c.open;
    const currentBear = c.close < c.open;
    const previousBear = prev.close < prev.open;
    const previousBull = prev.close > prev.open;

    const engulfing =
      (currentBull && previousBear &&
        c.open <= prev.close && c.close >= prev.open) ||
      (currentBear && previousBull &&
        c.open >= prev.close && c.close <= prev.open);

    if (engulfing) {
      candidates.push({
        type: "ENGULF",
        high: c.high,
        low: c.low,
        createdIndex: i,
        createdEpoch: c.epoch,
        boxId: makeBoxId("ENGULF", c.epoch, c.high, c.low)
      });
    }

    if (body / range <= 0.10) {
      candidates.push({
        type: "DOJI",
        high: c.high,
        low: c.low,
        createdIndex: i,
        createdEpoch: c.epoch,
        boxId: makeBoxId("DOJI", c.epoch, c.high, c.low)
      });
    }
  }

  candidates.sort((a, b) => a.createdIndex - b.createdIndex);

  const accepted = [];

  for (const candidate of candidates) {
    let replaced = false;

    for (let i = accepted.length - 1; i >= 0; i--) {
      const existing = accepted[i];

      if (!rangesOverlap(candidate, existing)) continue;

      const oldTouches = countBoxTouches(candles, existing);
      const newTouches = countBoxTouches(candles, candidate);

      // Keep the box with fewer touches.
      // On a tie, preserve the older box.
      if (newTouches < oldTouches) {
        accepted.splice(i, 1);
      } else {
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      accepted.push(candidate);
    }

    // Keep the most recent four accepted boxes.
    while (accepted.length > MAX_BLUE_BOXES) {
      accepted.shift();
    }
  }

  return accepted;
}

function countBoxTouches(candles, box) {
  let touches = 0;

  for (let i = box.createdIndex + 1; i < candles.length; i++) {
    const c = candles[i];

    if (candleTouchesBox(c, box)) {
      touches++;
    }
  }

  return touches;
}

function insideBox(candle, box) {
  return candle.open >= box.low && candle.open <= box.high;
}

function buildOrangeSignals(candles, boxes, pip) {
  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];

  if (!last) return [];

  const session = sessionAt(last.epoch);

  if (!session) return [];

  const signals = [];

  for (const box of boxes) {
    if (utcDate(last.epoch) !== box.day) continue;
    if (lastIndex <= box.createdIndex) continue;

    const color = candleColor(last);

    // Orange breakout: candle opens inside and closes outside.
    if (insideBox(last, box)) {
      if (last.close > box.high) {
        signals.push({
          direction: "BUY",
          boxType: "ORANGE",
          touchType: "ORANGE BREAKOUT",
          boxId: box.boxId,
          signalId: `${box.boxId}|BREAKOUT_BUY|${last.epoch}`,
          session,
          sessionKey: `${box.day}-${session}`,
          boxHigh: box.high,
          boxLow: box.low,
          pip,
          candleTime: last.epoch,
          volume: getVolumeLabel(last),
          reason: `${session} orange-box upside breakout`
        });
      }

      if (last.close < box.low) {
        signals.push({
          direction: "SELL",
          boxType: "ORANGE",
          touchType: "ORANGE BREAKOUT",
          boxId: box.boxId,
          signalId: `${box.boxId}|BREAKOUT_SELL|${last.epoch}`,
          session,
          sessionKey: `${box.day}-${session}`,
          boxHigh: box.high,
          boxLow: box.low,
          pip,
          candleTime: last.epoch,
          volume: getVolumeLabel(last),
          reason: `${session} orange-box downside breakout`
        });
      }
    }

    // Orange rejection retests:
    // RED candle touches high and closes back inside = BUY.
    // GREEN candle touches low and closes back inside = SELL.
    if (
      color === "RED" &&
      candleTouchesTop(last, box) &&
      last.close <= box.high &&
      last.close >= box.low
    ) {
      signals.push({
        direction: "BUY",
        boxType: "ORANGE",
        touchType: "ORANGE HIGH RETEST",
        boxId: box.boxId,
        signalId: `${box.boxId}|HIGH_RETEST|${last.epoch}`,
        session,
        sessionKey: `${box.day}-${session}`,
        boxHigh: box.high,
        boxLow: box.low,
        pip,
        candleTime: last.epoch,
        volume: getVolumeLabel(last),
        reason: `${session} orange high rejection`
      });
    }

    if (
      color === "GREEN" &&
      candleTouchesBottom(last, box) &&
      last.close >= box.low &&
      last.close <= box.high
    ) {
      signals.push({
        direction: "SELL",
        boxType: "ORANGE",
        touchType: "ORANGE LOW RETEST",
        boxId: box.boxId,
        signalId: `${box.boxId}|LOW_RETEST|${last.epoch}`,
        session,
        sessionKey: `${box.day}-${session}`,
        boxHigh: box.high,
        boxLow: box.low,
        pip,
        candleTime: last.epoch,
        volume: getVolumeLabel(last),
        reason: `${session} orange low rejection`
      });
    }
  }

  return signals;
}

function buildBlueSignals(candles, boxes, pip) {
  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];

  if (!last) return [];

  const color = candleColor(last);

  if (color === "NEUTRAL") return [];

  const signals = [];

  for (const box of boxes) {
    if (lastIndex <= box.createdIndex) continue;

    // Correct blue touch directions:
    // RED candle touches HIGH = BUY.
    // GREEN candle touches LOW = SELL.
    if (
      color === "RED" &&
      candleTouchesTop(last, box)
    ) {
      signals.push({
        direction: "BUY",
        boxType: box.type,
        touchType: "BLUE TOUCH HIGH",
        boxId: box.boxId,
        signalId: `${box.boxId}|TOUCH_HIGH|${last.epoch}`,
        boxHigh: box.high,
        boxLow: box.low,
        pip,
        candleTime: last.epoch,
        volume: getVolumeLabel(last),
        reason: "Red candle rejected blue-box high"
      });
    }

    if (
      color === "GREEN" &&
      candleTouchesBottom(last, box)
    ) {
      signals.push({
        direction: "SELL",
        boxType: box.type,
        touchType: "BLUE TOUCH LOW",
        boxId: box.boxId,
        signalId: `${box.boxId}|TOUCH_LOW|${last.epoch}`,
        boxHigh: box.high,
        boxLow: box.low,
        pip,
        candleTime: last.epoch,
        volume: getVolumeLabel(last),
        reason: "Green candle rejected blue-box low"
      });
    }

    // Breakout confirmation:
    // Close above -> first RED candle confirms BUY.
    // Close below -> first GREEN candle confirms SELL.
    let breakoutIndex = -1;
    let breakoutDirection = null;

    for (let i = box.createdIndex + 1; i <= lastIndex; i++) {
      if (candles[i].close > box.high) {
        breakoutIndex = i;
        breakoutDirection = "BUY";
        break;
      }

      if (candles[i].close < box.low) {
        breakoutIndex = i;
        breakoutDirection = "SELL";
        break;
      }
    }

    if (breakoutIndex < 0 || breakoutIndex >= lastIndex) continue;

    let confirmationIndex = -1;

    for (let i = breakoutIndex + 1; i <= lastIndex; i++) {
      const nextColor = candleColor(candles[i]);

      if (breakoutDirection === "BUY" && nextColor === "RED") {
        confirmationIndex = i;
        break;
      }

      if (breakoutDirection === "SELL" && nextColor === "GREEN") {
        confirmationIndex = i;
        break;
      }
    }

    if (confirmationIndex !== lastIndex) continue;

    signals.push({
      direction: breakoutDirection,
      boxType: box.type,
      touchType: "BLUE BREAKOUT",
      boxId: box.boxId,
      signalId: `${box.boxId}|BREAKOUT|${breakoutDirection}|${last.epoch}`,
      boxHigh: box.high,
      boxLow: box.low,
      pip,
      candleTime: last.epoch,
      volume: getVolumeLabel(last),
      reason: `Blue ${breakoutDirection} breakout confirmation`
    });
  }

  return signals;
}

// RSI fade: scan the latest three closed candles.
// A GREEN breakout candle with RSI >= 90 = SELL fade.
// A RED breakout candle with RSI <= 10 = BUY fade.
function buildFadeSignals(candles, boxes, pip) {
  const signals = [];

  if (candles.length < 5) return signals;

  const start = Math.max(3, candles.length - 3);

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const color = candleColor(c);
    const rsi = rsiAt(candles, i, 3);

    if (rsi === null || color === "NEUTRAL") continue;

    for (const box of boxes) {
      if (i <= box.createdIndex) continue;
      if (!insideBox(c, box)) continue;

      const above = c.close > box.high;
      const below = c.close < box.low;

      if (
        color === "GREEN" &&
        above &&
        rsi >= 90
      ) {
        signals.push({
          direction: "SELL",
          boxType: box.type,
          touchType: "RSI FADE SELL",
          isFade: true,
          rsi,
          fadeCandleHigh: c.high,
          fadeCandleLow: c.low,
          boxId: box.boxId,
          signalId: `${box.boxId}|FADE_SELL|${c.epoch}`,
          boxHigh: box.high,
          boxLow: box.low,
          pip,
          candleTime: c.epoch,
          volume: getVolumeLabel(c),
          reason: `RSI(3) ${fmt(rsi, 1)} overbought breakout fade`
        });
      }

      if (
        color === "RED" &&
        below &&
        rsi <= 10
      ) {
        signals.push({
          direction: "BUY",
          boxType: box.type,
          touchType: "RSI FADE BUY",
          isFade: true,
          rsi,
          fadeCandleHigh: c.high,
          fadeCandleLow: c.low,
          boxId: box.boxId,
          signalId: `${box.boxId}|FADE_BUY|${c.epoch}`,
          boxHigh: box.high,
          boxLow: box.low,
          pip,
          candleTime: c.epoch,
          volume: getVolumeLabel(c),
          reason: `RSI(3) ${fmt(rsi, 1)} oversold breakout fade`
        });
      }
    }
  }

  // If multiple boxes qualify on the same candle, keep one fade only.
  const uniqueByCandle = new Map();

  signals
    .sort((a, b) => b.candleTime - a.candleTime)
    .forEach(signal => {
      const key = signal.candleTime;

      if (!uniqueByCandle.has(key)) {
        uniqueByCandle.set(key, signal);
      }
    });

  return [...uniqueByCandle.values()];
}

function findStrategySignal(candles, symbol, category, marketPip) {
  const empty = {
    direction: "NONE",
    reason: "Waiting for a valid M15 setup",
    boxCount: 0
  };

  if (!candles || candles.length < 5) {
    return { ...empty, reason: "Not enough closed M15 candles" };
  }

  const pip = pipSize(symbol, category, candles, marketPip);

  const orangeBoxes = buildOrangeBoxes(candles);
  const blueBoxes = buildBlueBoxes(candles);

  const allBoxes = [...orangeBoxes, ...blueBoxes];

  const fadeSignals = buildFadeSignals(candles, allBoxes, pip);
  const orangeSignals = buildOrangeSignals(candles, orangeBoxes, pip);
  const blueSignals = buildBlueSignals(candles, blueBoxes, pip);

  // Fade has priority over normal signals.
  const allSignals = [
    ...fadeSignals,
    ...orangeSignals,
    ...blueSignals
  ];

  if (!allSignals.length) {
    return {
      ...empty,
      reason: "Waiting for Orange, Blue or RSI Fade setup",
      orangeBoxCount: orangeBoxes.length,
      blueBoxCount: blueBoxes.length
    };
  }

  allSignals.sort((a, b) => {
    if (Boolean(a.isFade) !== Boolean(b.isFade)) {
      return a.isFade ? -1 : 1;
    }

    return b.candleTime - a.candleTime;
  });

  const signal = allSignals[0];

  return {
    ...signal,
    orangeBoxCount: orangeBoxes.length,
    blueBoxCount: blueBoxes.length,
    _candles: candles
  };
}

function alreadyExecuted(trades, signal, symbol) {
  return trades.some(trade => {
    if (trade.symbol !== symbol) return false;

    if (signal.isFade) {
      return (
        trade.isFade &&
        trade.candleTime === signal.candleTime
      );
    }

    return trade.signalId === signal.signalId;
  });
}

function makeDemoOrder(
  signal,
  symbol,
  category,
  balance,
  riskPct,
  sizingMode,
  fixedLots,
  timeframe = TIMEFRAME
) {
  const buy = signal.direction === "BUY";
  const offset = signal.pip * (
    signal.isFade ? FADE_SL_OFFSET_PIPS : SL_OFFSET_PIPS
  );

  let sl;

  if (signal.isFade) {
    sl = buy
      ? signal.fadeCandleLow - offset
      : signal.fadeCandleHigh + offset;
  } else {
    sl = buy
      ? signal.boxLow - offset
      : signal.boxHigh + offset;
  }

  const entry = signal.entry;
  const slDistance = Math.abs(entry - sl);

  if (!Number.isFinite(slDistance) || slDistance <= 0) {
    throw new Error("Invalid stop-loss distance. Trade was not opened.");
  }

  const rr = signal.isFade ? FADE_RR : NORMAL_RR;
  const tpDistance = slDistance * rr;

  const tp = buy
    ? entry + tpDistance
    : entry - tpDistance;

  const safeLots = Math.max(0, Number(fixedLots) || 0);
  const safeRiskPct = Math.max(0, Number(riskPct) || 0);

  const riskMoney = sizingMode === "FIXED_LOTS"
    ? balance * 0.01 * (safeLots / 0.10)
    : balance * safeRiskPct / 100;

  const createdAtMs = Date.now();

  return {
    id: `${symbol}-${signal.signalId}-${createdAtMs}`,
    signalId: signal.signalId,
    comment: "Ifx Billionaire",
    boxId: signal.boxId,
    boxType: signal.boxType,
    touchType: signal.touchType,
    isFade: Boolean(signal.isFade),
    rsi: signal.rsi ?? null,
    candleTime: signal.candleTime,
    session: signal.session || null,
    sessionKey: signal.sessionKey || null,
    symbol,
    category,
    direction: signal.direction,
    source: `${signal.boxType} · ${signal.touchType}`,
    timeframe,
    sizingMode,
    fixedLots: sizingMode === "FIXED_LOTS" ? safeLots : null,
    entry,
    sl,
    tp,
    slDistance,
    tpDistance,
    riskMoney,
    rewardRatio: rr,
    status: "OPEN DEMO TRADE",
    currentPrice: entry,
    floatingPnl: 0,
    fillPrice: entry,
    filledAt: new Date(createdAtMs).toLocaleTimeString(),
    created: new Date(createdAtMs).toLocaleTimeString(),
    createdAtMs,
    openedEpoch: Math.floor(createdAtMs / 1000),
    openedDay: utcDate(Math.floor(createdAtMs / 1000))
  };
}

function calculateDemoPnl(trade, price) {
  const stopDistance = Math.abs(trade.entry - trade.sl);

  if (!stopDistance) return 0;

  const move = trade.direction === "BUY"
    ? price - trade.entry
    : trade.entry - price;

  return (move / stopDistance) * trade.riskMoney;
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

function getExitPrice(trade, reason, observedPrice) {
  if (reason === "STOP LOSS") return trade.sl;
  if (reason === "TAKE PROFIT") return trade.tp;
  return observedPrice;
}

function sendBrowserNotification(title, body) {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "granted") {
    try {
      new Notification(title, { body });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export default function App() {
  const socketRef = useRef(null);
  const connectionPromiseRef = useRef(null);
  const requestRef = useRef(0);
  const pendingRequestsRef = useRef(new Map());

  const scanLockRef = useRef(false);
  const rescanRequestedRef = useRef(false);
  const queuedScanListRef = useRef(null);

  const runningRef = useRef(false);
  const scanTimerRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectingRef = useRef(false);

  const marketsRef = useRef([]);
  const activationLocksRef = useRef(new Set());

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
  const [sizingMode, setSizingMode] = useState("RISK_PERCENT");

  const [message, setMessage] = useState(
    "Connect to Deriv to discover available markets."
  );

  const [lastScan, setLastScan] = useState("Not scanned");

  const [notificationPermission, setNotificationPermission] = useState(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported"
  );

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

      try {
        ws.send(JSON.stringify({ ...payload, req_id: id }));
      } catch (error) {
        clearTimeout(timeout);
        pendingRequestsRef.current.delete(id);
        reject(error);
      }
    });
  }, []);

  const processTick = useCallback((symbol, price) => {
    if (!symbol || !Number.isFinite(price)) return;

    latestPricesRef.current[symbol] = price;

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
        const exitPrice = getExitPrice(trade, exitReason, price);
        const finalPnl = calculateDemoPnl(trade, exitPrice);

        newlyClosed.push({
          ...trade,
          status: "CLOSED",
          exitPrice,
          observedExitPrice: price,
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

      newlyClosed.forEach(trade => {
        const isTP = trade.exitReason === "TAKE PROFIT";

        sendBrowserNotification(
          isTP
            ? "iFX BILLIONAIRE — TAKE PROFIT HIT"
            : "iFX BILLIONAIRE — STOP LOSS HIT",
          `${trade.symbol} ${trade.direction} · ${trade.exitReason} · ${trade.realisedPnl >= 0 ? "+" : ""}$${fmt(trade.realisedPnl, 2)}`
        );
      });

      setMessage(
        newlyClosed.map(t =>
          `${t.symbol} ${t.exitReason}: ${t.realisedPnl >= 0 ? "+" : ""}$${fmt(t.realisedPnl, 2)}`
        ).join(" · ")
      );
    }
  }, [updateOrders, updateClosedTrades]);

  const scheduleReconnect = useCallback(() => {
    if (!runningRef.current || reconnectTimerRef.current) return;

    setConnectionText("RECONNECTING");
    setMessage("Connection lost. Attempting automatic reconnection...");

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;

      if (runningRef.current) {
        window.dispatchEvent(new Event("ifx-robot-reconnect"));
      }
    }, 5000);
  }, []);

  const connect = useCallback(() => {
    const existing = socketRef.current;

    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (connectionPromiseRef.current) {
      return connectionPromiseRef.current;
    }

    if (existing && existing.readyState === WebSocket.CLOSING) {
      return Promise.reject(
        new Error("Previous Deriv connection is still closing.")
      );
    }

    setConnectionText("CONNECTING");

    let connectionPromise;

    connectionPromise = new Promise((resolve, reject) => {
      let settled = false;
      let ws;

      try {
        ws = new WebSocket(WS_URL);
      } catch (error) {
        reject(error);
        return;
      }

      socketRef.current = ws;

      const clearConnectionAttempt = () => {
        if (connectionPromiseRef.current === connectionPromise) {
          connectionPromiseRef.current = null;
        }
      };

      ws.onopen = () => {
        if (socketRef.current !== ws) {
          ws.close();
          return;
        }

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }

        setConnected(true);
        setConnectionText("DATA CONNECTED");

        clearConnectionAttempt();

        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = event => {
        if (socketRef.current !== ws) return;

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

        if (
          data.req_id &&
          pendingRequestsRef.current.has(data.req_id)
        ) {
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
        if (socketRef.current !== ws) return;

        setConnectionText("CONNECTION ERROR");

        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to Deriv."));
        }

        try {
          ws.close();
        } catch {
          // Socket may already be closed.
        }
      };

      ws.onclose = () => {
        if (socketRef.current !== ws) return;

        socketRef.current = null;

        setConnected(false);
        setConnectionText("DISCONNECTED");

        subscriptionsRef.current.clear();
        subscribingRef.current.clear();

        pendingRequestsRef.current.forEach(p => {
          clearTimeout(p.timeout);
          p.reject(new Error("Connection closed."));
        });

        pendingRequestsRef.current.clear();
        clearConnectionAttempt();

        if (runningRef.current) {
          setMessage("Deriv connection lost. Robot will attempt to reconnect.");
          scheduleReconnect();
        }

        if (!settled) {
          settled = true;
          reject(new Error("Connection closed before connecting."));
        }
      };
    });

    connectionPromiseRef.current = connectionPromise;
    return connectionPromise;
  }, [processTick, scheduleReconnect]);

  const subscribeMarket = useCallback(async symbol => {
    if (subscriptionsRef.current.has(symbol)) return true;
    if (subscribingRef.current.has(symbol)) return false;

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

    marketsRef.current = list;
    setSymbols(list);
    setMessage(`${list.length} active Deriv markets discovered.`);

    return list;
  }, [request]);

  const scanSymbol = useCallback(async item => {
    const diagnostic = {
      returned: 0,
      valid: 0,
      closed: 0,
      latestEpoch: null,
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

      const raw = Array.isArray(response.candles)
        ? response.candles
        : [];

      diagnostic.returned = raw.length;

      const candles = raw.map(c => ({
        epoch: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume === undefined ? null : Number(c.volume)
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
        diagnostic.latestEpoch = closed[closed.length - 1].epoch;
      }

      const signal = findStrategySignal(
        closed,
        item.symbol,
        item.category,
        item.pip
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
        _candles: [],
        _candleData: diagnostic
      };
    }
  }, [request]);

  const scanAll = useCallback(async list => {
    if (!runningRef.current || !list?.length) return;

    if (scanLockRef.current) {
      rescanRequestedRef.current = true;
      queuedScanListRef.current = list;
      return;
    }

    scanLockRef.current = true;

    setMessage("Scanning Deriv markets using completed M15 candles...");

    const results = {};
    let completed = 0;
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < list.length && runningRef.current) {
        const index = nextIndex++;
        const item = list[index];

        const result = await scanSymbol(item);
        results[item.symbol] = result;

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
          ? `M15 scan complete: ${completed} of ${list.length} markets checked.`
          : "Scanning stopped."
      );

      setLastScan(new Date().toLocaleTimeString());
    } finally {
      scanLockRef.current = false;

      if (rescanRequestedRef.current && runningRef.current) {
        rescanRequestedRef.current = false;

        const queuedList = queuedScanListRef.current || marketsRef.current;
        queuedScanListRef.current = null;

        setTimeout(() => {
          if (runningRef.current) scanAll(queuedList);
        }, 0);
      }
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
          const permission = await Notification.requestPermission();
          setNotificationPermission(permission);
        } catch {
          // Notifications are optional.
        }
      }

      setMessage("Connecting to Deriv M15 market data...");
      await connect();

      runningRef.current = true;
      setRunning(true);

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

      if (!runningRef.current) return;

      if (scanTimerRef.current) {
        clearInterval(scanTimerRef.current);
      }

      scanTimerRef.current = setInterval(() => {
        if (runningRef.current) {
          scanAll(marketsRef.current);
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

    rescanRequestedRef.current = false;
    queuedScanListRef.current = null;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

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
    activationLocksRef.current.clear();

    setMessage(
      `STOPPED. ${closedNow.length} open simulated trade(s) closed.`
    );
  };

  const activateSignal = async item => {
    const signal = signals[item.symbol];

    if (!signal || signal.direction === "NONE") return;

    if (!signal.signalId || !signal.boxId) {
      setMessage("Signal is missing its box or signal identifier.");
      return;
    }

    const lockKey = `${item.symbol}|${signal.signalId}`;

    if (activationLocksRef.current.has(lockKey)) {
      setMessage(`${item.symbol}: this signal is already being processed.`);
      return;
    }

    activationLocksRef.current.add(lockKey);

    try {
      const previousTrades = [
        ...ordersRef.current,
        ...closedTradesRef.current
      ];

      const today = utcDate(Math.floor(Date.now() / 1000));

      const dailyTrades = previousTrades.filter(trade =>
        trade.openedDay === today
      );

      const openCount = ordersRef.current.filter(trade =>
        trade.status === "OPEN DEMO TRADE"
      ).length;

      if (dailyTrades.length >= MAX_DAILY_TRADES) {
        setMessage(`Daily limit reached: maximum ${MAX_DAILY_TRADES} trades today.`);
        return;
      }

      if (openCount >= MAX_OPEN_TRADES) {
        setMessage(`Open-trade limit reached: maximum ${MAX_OPEN_TRADES} open trades.`);
        return;
      }

      if (alreadyExecuted(previousTrades, signal, item.symbol)) {
        setMessage(
          signal.isFade
            ? `${item.symbol}: a fade trade was already taken on this candle.`
            : `${item.symbol}: this exact signal has already been traded.`
        );
        return;
      }

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

      const tradesAfterSubscription = [
        ...ordersRef.current,
        ...closedTradesRef.current
      ];

      const latestDailyTrades = tradesAfterSubscription.filter(trade =>
        trade.openedDay === today
      );

      const latestOpenCount = ordersRef.current.filter(trade =>
        trade.status === "OPEN DEMO TRADE"
      ).length;

      if (latestDailyTrades.length >= MAX_DAILY_TRADES) {
        setMessage("Daily trade limit reached.");
        return;
      }

      if (latestOpenCount >= MAX_OPEN_TRADES) {
        setMessage("Maximum open trades reached.");
        return;
      }

      if (alreadyExecuted(tradesAfterSubscription, signal, item.symbol)) {
        setMessage("This signal has already been traded.");
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
        sizingMode,
        fixedLots,
        TIMEFRAME
      );

      updateOrders(previous => [order, ...previous]);

      setSelected(item);

      setLastActivated(
        `${signal.direction} · ${signal.boxType} · ${signal.touchType} · M15`
      );

      setMessage(
        `${item.symbol}: ${signal.direction} simulated trade opened at ${fmt(currentPrice, 8)}.`
      );

      sendBrowserNotification(
        "iFX BILLIONAIRE — Demo Trade Opened",
        `${item.symbol} ${signal.direction} ${signal.touchType} at ${fmt(currentPrice, 8)}`
      );
    } catch (error) {
      setMessage(`${item.symbol}: ${error.message}`);
    } finally {
      activationLocksRef.current.delete(lockKey);
    }
  };

  useEffect(() => {
    const recoverRobot = async () => {
      if (!runningRef.current || reconnectingRef.current) return;

      const ws = socketRef.current;

      if (ws && ws.readyState === WebSocket.OPEN) {
        if (marketsRef.current.length) {
          await scanAll(marketsRef.current);
        }
        return;
      }

      reconnectingRef.current = true;

      try {
        setConnectionText("RECONNECTING");
        setMessage("Restoring Deriv connection...");

        await connect();

        if (!runningRef.current) return;

        const openSymbols = [
          ...new Set(
            ordersRef.current
              .filter(order => order.status === "OPEN DEMO TRADE")
              .map(order => order.symbol)
          )
        ];

        for (const symbol of openSymbols) {
          if (!runningRef.current) break;
          await subscribeMarket(symbol);
        }

        if (!runningRef.current) return;

        let list = marketsRef.current;

        if (!list.length) {
          list = await discoverMarkets();
        }

        if (runningRef.current && list.length) {
          setMessage("Connection restored. Resuming M15 scans...");
          await scanAll(list);
        }
      } catch (error) {
        if (runningRef.current) {
          setMessage(`Reconnection failed: ${error.message}`);
          scheduleReconnect();
        }
      } finally {
        reconnectingRef.current = false;
      }
    };

    const handleReconnect = () => recoverRobot();
    const handleOnline = () => {
      if (runningRef.current) recoverRobot();
    };

    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        runningRef.current
      ) {
        recoverRobot();
      }
    };

    window.addEventListener("ifx-robot-reconnect", handleReconnect);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("ifx-robot-reconnect", handleReconnect);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connect, scanAll, subscribeMarket, discoverMarkets, scheduleReconnect]);

  useEffect(() => {
    return () => {
      runningRef.current = false;

      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

      if (socketRef.current) socketRef.current.close();

      pendingRequestsRef.current.forEach(p => {
        clearTimeout(p.timeout);
      });

      pendingRequestsRef.current.clear();
    };
  }, []);

  const visibleSymbols = symbols.filter(item => {
    const signal = signals[item.symbol];

    const hasSignal =
      signal?.direction === "BUY" || signal?.direction === "SELL";

    const matchesCategory =
      category === "All" || item.category === category;

    const term = search.toLowerCase();

    const matchesSearch =
      !term ||
      String(item.display_name || "").toLowerCase().includes(term) ||
      String(item.symbol || "").toLowerCase().includes(term);

    return hasSignal && matchesCategory && matchesSearch;
  });

  const buyCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "BUY"
  ).length;

  const sellCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "SELL"
  ).length;

  const openTrades = orders.filter(o =>
    o.status === "OPEN DEMO TRADE"
  );

  const today = utcDate(Math.floor(Date.now() / 1000));

  const allTrades = [...orders, ...closedTrades];

  const dailyTradeCount = allTrades.filter(trade =>
    trade.openedDay === today
  ).length;

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

  const fieldStyle = {
    width: "100%",
    minWidth: 0,
    background: "#0a1424",
    border: "1px solid #30435e",
    borderRadius: 7,
    color: "white",
    padding: 10,
    fontSize: 13
  };

  const collapsibleSummary = {
    ...title,
    cursor: "pointer",
    listStyle: "none",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    minHeight: 22
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
        button, input, select { font: inherit; }
        button { cursor: pointer; }
        .market-scroll {
          display:flex; gap:7px; overflow-x:auto;
          padding:4px 0 10px; scrollbar-width:none;
        }
        .market-scroll::-webkit-scrollbar { display:none; }
        .market-card:active { transform:scale(.99); }
        .market-card { transition:transform .12s ease; }
        .market-card:disabled { opacity:.55; cursor:not-allowed; }
        input:focus, select:focus { outline:1px solid #31a8ff; }
        details > summary::-webkit-details-marker { display:none; }
        details > summary::after {
          content:"＋"; color:#55c9ff;
          font-size:16px; margin-left:auto;
        }
        details[open] > summary::after { content:"−"; }
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
            M15 · ORANGE + BLUE + RSI FADE
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
              SIMULATED DEMO
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
            M15 scan progress: {scanned}/{symbols.length} · {progress}%
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
            <div style={statValue}>{openTrades.length}/4</div>
          </div>
          <div style={stat}>
            <div style={statLabel}>TODAY'S TRADES</div>
            <div style={statValue}>{dailyTradeCount}/4</div>
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
          <div style={title}>ACTIVE M15 SIGNALS</div>
          <div style={small}>
            Completed M15 candles only · Tap a signal to open a simulated trade.
          </div>

          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search symbol or market..."
            style={{
              width: "100%",
              marginTop: 13,
              background: "#0a1424",
              border: "1px solid #30435e",
              borderRadius: 8,
              color: "white",
              padding: 12,
              fontSize: 13
            }}
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

          {symbols.length > 0 && scanned > 0 && visibleSymbols.length === 0 && (
            <div style={{
              textAlign: "center",
              padding: 22,
              color: "#8395af",
              background: "#0b1525",
              borderRadius: 8,
              marginTop: 5,
              fontSize: 11,
              lineHeight: 1.6
            }}>
              No active M15 BUY or SELL signals for this selection.
              <br/>
              Inactive markets are hidden.
            </div>
          )}

          <div style={{
            display: "flex",
            flexDirection: "column",
            gap: 7
          }}>
            {visibleSymbols.map(item => {
              const signal = signals[item.symbol];
              const isSelected = selected?.symbol === item.symbol;

              const previousTrades = [...orders, ...closedTrades];

              const hasOrder = alreadyExecuted(
                previousTrades,
                signal,
                item.symbol
              );

              const limitReached =
                dailyTradeCount >= MAX_DAILY_TRADES ||
                openTrades.length >= MAX_OPEN_TRADES;

              return (
                <button
                  key={item.symbol}
                  className="market-card"
                  disabled={limitReached || hasOrder}
                  onClick={() => activateSignal(item)}
                  style={{
                    width: "100%",
                    background: "#0b1525",
                    border: `1px solid ${isSelected ? "#31a8ff" : "#24334b"}`,
                    borderRadius: 9,
                    padding: 12,
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
                      {item.symbol} · {item.category} · M15
                    </div>

                    <div style={{
                      fontSize: 9,
                      color: signal.isFade
                        ? "#f4c46a"
                        : signal.boxType === "ORANGE"
                        ? "#f4a340"
                        : "#65aaff",
                      marginTop: 7,
                      fontWeight: 900
                    }}>
                      {signal.boxType} · {signal.touchType}
                      {signal.isFade ? ` · RSI ${fmt(signal.rsi, 1)}` : ""}
                    </div>

                    <div style={{
                      fontSize: 9,
                      color: "#a9c9e9",
                      marginTop: 5
                    }}>
                      VOL {signal.volume ?? "N/A"} · {signal.direction}
                    </div>

                    <div style={{
                      fontSize: 9,
                      color: "#a9c9e9",
                      marginTop: 5
                    }}>
                      BOX HIGH {fmt(signal.boxHigh, 8)} · LOW {fmt(signal.boxLow, 8)}
                    </div>

                    {hasOrder && (
                      <div style={{
                        fontSize: 9,
                        color: "#f4c46a",
                        marginTop: 5
                      }}>
                        THIS SIGNAL ALREADY TRADED
                      </div>
                    )}

                    {limitReached && (
                      <div style={{
                        fontSize: 9,
                        color: "#ff7a82",
                        marginTop: 5
                      }}>
                        TRADE LIMIT REACHED
                      </div>
                    )}

                    <div style={{
                      fontSize: 9,
                      color: "#55c9ff",
                      marginTop: 6
                    }}>
                      TAP TO OPEN DEMO TRADE
                    </div>
                  </div>

                  <div style={{
                    minWidth: 65,
                    textAlign: "center",
                    padding: "9px 7px",
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

        <details style={card}>
          <summary style={collapsibleSummary}>
            STRATEGY RULES
          </summary>

          <div style={{
            marginTop: 13,
            fontSize: 10,
            lineHeight: 1.8,
            color: "#a8b7cb",
            background: "#0b1525",
            padding: 11,
            borderRadius: 7
          }}>
            <b style={{ color: "#f4a340" }}>ORANGE BOX</b>
            <br/>
            • First four M15 candles: 00:00–01:00 UTC.
            <br/>
            • Orange high and low remain active for that day.
            <br/>
            • Active sessions: London 07:00–11:00 and New York 15:00–17:00 UTC.
            <br/>
            • Breakout: candle opens inside and closes outside the box.
            <br/>
            • Red candle touching the high and closing inside = BUY.
            <br/>
            • Green candle touching the low and closing inside = SELL.
            <br/>
            • Normal SL: opposite box boundary plus 5 pips.
            <br/>
            • TP: 3R.
            <br/><br/>

            <b style={{ color: "#65aaff" }}>BLUE BOX</b>
            <br/>
            • Boxes created from 01:00–22:00 UTC.
            <br/>
            • ENGULFING and DOJI only. No WICK boxes.
            <br/>
            • Box uses the qualifying candle's own high and low.
            <br/>
            • Maximum four active blue boxes.
            <br/>
            • Overlapping boxes: keep the box with fewer touches.
            <br/>
            • Red candle touches high = BUY.
            <br/>
            • Green candle touches low = SELL.
            <br/>
            • Close above box, then first red confirmation = BUY.
            <br/>
            • Close below box, then first green confirmation = SELL.
            <br/>
            • Normal SL: opposite box boundary plus 5 pips.
            <br/>
            • TP: 3R.
            <br/><br/>

            <b style={{ color: "#f4c46a" }}>RSI(3) FADE</b>
            <br/>
            • Green breakout candle with RSI 90 or higher = SELL.
            <br/>
            • Red breakout candle with RSI 10 or lower = BUY.
            <br/>
            • Fade signals are checked across the latest three closed candles.
            <br/>
            • One fade per symbol per candle, even if several boxes qualify.
            <br/>
            • Fade SL: signal candle high/low plus 10-pip default offset.
            <br/>
            • Fade TP: 2R.
            <br/><br/>

            <b style={{ color: "#f4c46a" }}>TRADE PROTECTION</b>
            <br/>
            • Maximum four trades opened per UTC day.
            <br/>
            • Maximum four simultaneously open trades.
            <br/>
            • Manual tap required to open every trade.
            <br/>
            • No pending orders.
            <br/>
            • No breakeven or trailing stop.
            <br/>
            • All entries use the latest available simulated market price.
            <br/>
            • Normal trades: 5-pip SL offset and 3R target.
            <br/>
            • Fade trades: 10-pip SL offset and 2R target.
            <br/>
            • Timeframe: M15 only.
          </div>
        </details>

        <details style={card}>
          <summary style={collapsibleSummary}>
            TRADE SETTINGS
          </summary>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(2,minmax(0,1fr))",
            gap: 12,
            marginTop: 13
          }}>
            <label style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              fontSize: 10,
              color: "#94a8c3"
            }}>
              <span>Timeframe</span>
              <select value="900" disabled style={fieldStyle}>
                <option value="900">M15 — 15 Minutes</option>
              </select>
            </label>

            <label style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              fontSize: 10,
              color: "#94a8c3"
            }}>
              <span>Position sizing mode</span>
              <select
                value={sizingMode}
                onChange={e => setSizingMode(e.target.value)}
                style={fieldStyle}
              >
                <option value="RISK_PERCENT">Risk percentage</option>
                <option value="FIXED_LOTS">Fixed lot size</option>
              </select>
            </label>

            <label style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              fontSize: 10,
              color: "#94a8c3"
            }}>
              <span>Demo balance ($)</span>
              <input
                type="number"
                min="0"
                value={balance}
                onChange={e => setBalance(Math.max(0, Number(e.target.value)))}
                style={fieldStyle}
              />
            </label>

            {sizingMode === "RISK_PERCENT" && (
              <label style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
                fontSize: 10,
                color: "#94a8c3"
              }}>
                <span>Risk per trade (%)</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={riskPct}
                  onChange={e => setRiskPct(
                    Math.max(0, Math.min(100, Number(e.target.value)))
                  )}
                  style={fieldStyle}
                />
              </label>
            )}

            {sizingMode === "FIXED_LOTS" && (
              <label style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
                fontSize: 10,
                color: "#94a8c3"
              }}>
                <span>Fixed lot size</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={fixedLots}
                  onChange={e => setFixedLots(
                    Math.max(0.01, Number(e.target.value))
                  )}
                  style={fieldStyle}
                />
              </label>
            )}
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
            TIMEFRAME: M15 ONLY.
            <br/>
            NORMAL SL OFFSET: 5 PIPS.
            <br/>
            NORMAL TAKE PROFIT: 3R.
            <br/>
            FADE RSI: 3.
            <br/>
            FADE SELL: RSI 90 OR HIGHER.
            <br/>
            FADE BUY: RSI 10 OR LOWER.
            <br/>
            FADE SL OFFSET: 10 PIPS.
            <br/>
            FADE TAKE PROFIT: 2R.
            <br/>
            DAILY TRADE CAP: 4.
            <br/>
            OPEN TRADE CAP: 4.
            <br/>
            POSITION SIZING: {sizingMode === "RISK_PERCENT"
              ? `${fmt(riskPct, 2)}% of demo balance per trade.`
              : `${fmt(fixedLots, 2)} fixed simulated lots.`}
          </div>

          {sizingMode === "FIXED_LOTS" && (
            <div style={{
              marginTop: 9,
              fontSize: 10,
              lineHeight: 1.6,
              color: "#f4d69a",
              background: "#302719",
              padding: 10,
              borderRadius: 7
            }}>
              SIMULATION NOTE: Fixed lots scale simulated P&L using a
              0.10-lot baseline. This is not the actual contract valuation
              used by a broker.
            </div>
          )}
        </details>

        <section style={card}>
          <div style={title}>BROKER CONNECTION</div>
          <div style={small}>
            Current data provider: DERIV PUBLIC MARKET DATA
          </div>

          <div style={{
            marginTop: 10,
            padding: 11,
            borderRadius: 7,
            background: "#0b1525",
            color: "#a8b7cb",
            fontSize: 10,
            lineHeight: 1.7
          }}>
            This version uses Deriv public market data and simulated demo
            trades only. It does not connect to a Deriv account, another
            broker, or a live trading account.
          </div>
        </section>

        <section style={card}>
          <div style={title}>OPEN DEMO TRADES</div>
          <div style={small}>
            Live price monitoring · Floating P&L
          </div>

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

              <div style={small}>
                Order comment: {trade.comment} · M15
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
                  SIMULATED RISK
                  <b style={{ display: "block", color: "white" }}>
                    ${fmt(trade.riskMoney, 2)}
                  </b>
                </div>
                <div>
                  REWARD RATIO
                  <b style={{ display: "block", color: "white" }}>
                    {trade.rewardRatio || 3}R
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

          {closedTrades.slice(0, 30).map(trade => (
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
                {trade.boxType} · {trade.touchType} · M15
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

        <footer style={{
          textAlign: "center",
          padding: "16px 5px 28px",
          color: "#647893",
          fontSize: 9,
          letterSpacing: 1.2,
          lineHeight: 1.8
        }}>
          iFX BILLIONAIRE ROBOT · M15 ORANGE + BLUE + RSI FADE
          <br/>
          Manual Demo Execution · Max 4 Daily · Max 4 Open
        </footer>
      </main>
    </div>
  );
}
