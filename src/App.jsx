
import React, { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

const TIMEFRAME = 300;
const CANDLE_COUNT = 1000;
const BUFFER_PIPS = 2;
const FX_SL_PIPS = 10;
const FX_TP_PIPS = 31;
const NON_FX_TP_POINTS = 1000;

const CATEGORIES = [
  "All", "Forex", "Indices", "Metals",
  "Synthetics", "Crypto", "Stocks", "Other"
];

const DIAGNOSTIC_REASONS = [
  "Asia range unavailable",
  "No boxes found",
  "Waiting for breakout",
  "Waiting for first retest",
  "Waiting for opposite-side breakout",
  "Waiting for FLIPPY retest",
  "Third touch — DELETE",
  "Neutral retest candle",
  "Signal confirmed",
  "Market data unavailable"
];

const fmt = (n, digits = 5) =>
  Number.isFinite(n) ? Number(n).toFixed(digits) : "—";

function categoryOf(s) {
  const market = String(s.market || "").toLowerCase();
  const sub = String(s.submarket || "").toLowerCase();
  const subgroup = String(s.subgroup || "").toLowerCase();
  const name = String(s.display_name || "").toLowerCase();
  const symbol = String(s.symbol || "").toLowerCase();
  const type = String(s.symbol_type || "").toLowerCase();

  if (
    market.includes("forex") ||
    sub.includes("forex") ||
    type.includes("forex")
  ) return "Forex";

  if (
    market.includes("synthetic") ||
    sub.includes("synthetic") ||
    subgroup.includes("synthetic") ||
    symbol.startsWith("1hz") ||
    symbol.startsWith("r_") ||
    symbol.includes("boom") ||
    symbol.includes("crash") ||
    symbol.includes("step")
  ) return "Synthetics";

  if (
    market.includes("crypt") ||
    sub.includes("crypt") ||
    subgroup.includes("crypt") ||
    name.includes("bitcoin") ||
    name.includes("ethereum") ||
    type.includes("crypt")
  ) return "Crypto";

  if (
    market.includes("stock") ||
    sub.includes("stock") ||
    subgroup.includes("stock") ||
    market.includes("share") ||
    type.includes("stock")
  ) return "Stocks";

  if (
    market.includes("index") ||
    sub.includes("index") ||
    subgroup.includes("index") ||
    type.includes("index")
  ) return "Indices";

  if (
    market.includes("commodit") ||
    sub.includes("metal") ||
    subgroup.includes("metal") ||
    name.includes("gold") ||
    name.includes("silver") ||
    name.includes("platinum") ||
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
    return symbol.toUpperCase().includes("JPY")
      ? 0.01
      : 0.0001;
  }

  const last = candles[candles.length - 1]?.close || 1;
  const decimals = (String(last).split(".")[1] || "").length;

  return Math.pow(10, -Math.min(decimals, 8));
}

// ASIA RANGE: 00:00–07:00 UTC
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

// THREE ORIGINAL BOX TYPES ONLY.
function createBoxes(candles, asiaDay) {
  const boxes = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    const date = new Date(c.epoch * 1000);
    const candleDay = date.toISOString().slice(0, 10);

    if (candleDay !== asiaDay) continue;
    if (date.getUTCHours() < 7) continue;

    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);

    if (range <= 0) continue;

    const currentBull = c.close > c.open;
    const previousBear = prev.close < prev.open;
    const currentBear = c.close < c.open;
    const previousBull = prev.close > prev.open;

    // ENGULFED BOX
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

    // DOJI BOX
    if (body / range <= 0.25) {
      boxes.push({
        type: "DOJI",
        high: c.high,
        low: c.low,
        created: i
      });
    }

    // WICK BOX
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
  return candle.low <= box.high &&
    candle.high >= box.high;
}

function touchesBottom(candle, box) {
  return candle.low <= box.low &&
    candle.high >= box.low;
}

function touchesBox(candle, box) {
  return candle.low <= box.high &&
    candle.high >= box.low;
}

// NORMAL RETEST DIRECTION
// Green candle at bottom = SELL.
// Red candle at top = BUY.
function getRetestDirection(candle, boundary) {
  const color = candleColor(candle);

  if (boundary === "BOTTOM" && color === "GREEN") {
    return "SELL";
  }

  if (boundary === "TOP" && color === "RED") {
    return "BUY";
  }

  return "NONE";
}

function makeBoxId(box, asiaDay) {
  return [
    asiaDay,
    box.type,
    box.created,
    box.high.toPrecision(12),
    box.low.toPrecision(12)
  ].join("-");
}

// HLZ BOX LIFECYCLE
//
// 1. First breakout.
// 2. First retest.
// 3. If first retest fails, wait for opposite-side breakout.
// 4. Wait for FLIPPY retest.
// 5. Third touch deletes the box.
//
// Confirmed signals remain available on later scans.
// EMA IS NOT USED.
function findRetestSignal(candles, symbol, category) {
  const empty = {
    direction: "NONE",
    reason: "Market data unavailable",
    deletedBoxIds: []
  };

  if (!candles.length) return empty;

  const asia = buildAsiaRange(candles);

  if (!asia) {
    return {
      ...empty,
      reason: "Asia range unavailable"
    };
  }

  const boxes = createBoxes(candles, asia.day);

  if (!boxes.length) {
    return {
      ...empty,
      reason: "No boxes found"
    };
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

    // STEP 1: FIRST BREAKOUT
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

    // STEP 2: FIRST RETEST
    const firstBoundary =
      breakoutDirection === "UP" ? "TOP" : "BOTTOM";

    let firstTouchIndex = -1;

    for (let i = breakoutIndex + 1; i <= lastIndex; i++) {
      const candle = candles[i];

      const touched = firstBoundary === "TOP"
        ? touchesTop(candle, box)
        : touchesBottom(candle, box);

      if (touched) {
        firstTouchIndex = i;
        break;
      }
    }

    if (firstTouchIndex < 0) continue;

    sawFirstRetest = true;

    const firstTouch = candles[firstTouchIndex];

    const firstDirection = getRetestDirection(
      firstTouch,
      firstBoundary
    );

    // NORMAL RETEST CONFIRMED
    if (firstDirection !== "NONE") {
      let touchCount = 1;
      let deleted = false;

      // The setup remains active until its third touch.
      for (
        let i = firstTouchIndex + 1;
        i <= lastIndex;
        i++
      ) {
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
        candleTime: firstTouch.epoch,
        reason: "Signal confirmed"
      };

      if (!best || box.created > best.created) {
        best = { ...signal, created: box.created };
      }

      continue;
    }

    // FIRST RETEST FAILED.
    // WAIT FOR PRICE TO BREAK THE OPPOSITE SIDE.
    const oppositeBoundary =
      firstBoundary === "TOP" ? "BOTTOM" : "TOP";

    let oppositeBreakIndex = -1;

    for (
      let i = firstTouchIndex + 1;
      i <= lastIndex;
      i++
    ) {
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

    // STEP 3: FLIPPY RETEST
    let flippyTouchIndex = -1;

    for (
      let i = oppositeBreakIndex + 1;
      i <= lastIndex;
      i++
    ) {
      const candle = candles[i];

      const touched = oppositeBoundary === "TOP"
        ? touchesTop(candle, box)
        : touchesBottom(candle, box);

      if (touched) {
        flippyTouchIndex = i;
        break;
      }
    }

    if (flippyTouchIndex < 0) continue;

    sawFlippyRetest = true;

    // STEP 4: THIRD TOUCH DELETES THE BOX.
    let touchCount = 2;
    let deleted = false;

    for (
      let i = flippyTouchIndex + 1;
      i <= lastIndex;
      i++
    ) {
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

    const flippyCandle = candles[flippyTouchIndex];

    const flippyDirection = getRetestDirection(
      flippyCandle,
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
      candleTime: flippyCandle.epoch,
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

  if (deletedBoxIds.length) {
    reason = "Third touch — DELETE";
  } else if (sawFlippyRetest) {
    reason = "Neutral retest candle";
  } else if (sawOppositeBreak) {
    reason = "Waiting for FLIPPY retest";
  } else if (sawFirstRetest) {
    reason = "Waiting for opposite-side breakout";
  } else if (sawBreakout) {
    reason = "Waiting for first retest";
  } else if (sawNeutral) {
    reason = "Neutral retest candle";
  }

  return {
    direction: "NONE",
    reason,
    boxCount: boxes.length,
    deletedBoxIds
  };
}

// SIMULATED PENDING ORDER.
// This does not submit an order to a Deriv account.
function makeDemoOrder(
  signal,
  symbol,
  category,
  balance,
  riskPct
) {
  const point = signal.pip;
  const isForex = category === "Forex";

  const slDistance = isForex
    ? FX_SL_PIPS * point
    : 10 * point;

  const tpDistance = isForex
    ? FX_TP_PIPS * point
    : NON_FX_TP_POINTS * point;

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

  const riskMoney = balance * safeRisk / 100;

  return {
    id: `${symbol}-${signal.boxId}-${Date.now()}`,
    boxId: signal.boxId,
    symbol,
    category,
    direction: signal.direction,
    source: `${signal.boxType} ${signal.touchType}`,
    entry: signal.entry,
    sl,
    tp,
    riskMoney,
    status: "DEMO PENDING",
    created: new Date().toLocaleTimeString()
  };
}

export default function App() {
  const socketRef = useRef(null);
  const requestRef = useRef(0);
  const pendingRef = useRef(new Map());
  const scanLock = useRef(false);
  const runningRef = useRef(false);
  const scanTimer = useRef(null);

  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [connectionText, setConnectionText] = useState("DISCONNECTED");

  const [symbols, setSymbols] = useState([]);
  const [signals, setSignals] = useState({});
  const [candleDiagnostics, setCandleDiagnostics] = useState({});
  const [orders, setOrders] = useState([]);

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

  // DERIV REQUEST HANDLER
  const request = useCallback(payload => {
    return new Promise((resolve, reject) => {
      const ws = socketRef.current;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Deriv data connection is not open."));
        return;
      }

      const id = ++requestRef.current;

      const timeout = setTimeout(() => {
        pendingRef.current.delete(id);
        reject(new Error("Deriv request timed out."));
      }, 30000);

      pendingRef.current.set(id, {
        resolve,
        reject,
        timeout
      });

      ws.send(JSON.stringify({
        ...payload,
        req_id: id
      }));
    });
  }, []);

  // DATA CONNECTION
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

        if (
          data.req_id &&
          pendingRef.current.has(data.req_id)
        ) {
          const pending = pendingRef.current.get(data.req_id);

          clearTimeout(pending.timeout);
          pendingRef.current.delete(data.req_id);

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

        pendingRef.current.forEach(p => {
          clearTimeout(p.timeout);
          p.reject(new Error("Connection closed."));
        });

        pendingRef.current.clear();

        if (runningRef.current) {
          runningRef.current = false;
          setRunning(false);
          setMessage("Deriv connection closed. Robot stopped.");
        }
      };
    });
  }, []);

  // DISCOVER ALL AVAILABLE MARKETS
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
      throw new Error(
        "Deriv active-symbol response was not an array."
      );
    }

    const list = rawList
      .map(s => {
        const symbol = s.underlying_symbol || s.symbol || "";

        return {
          ...s,
          symbol,
          display_name:
            s.underlying_symbol_name ||
            s.display_name ||
            symbol,
          symbol_type:
            s.underlying_symbol_type ||
            s.symbol_type ||
            "",
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
        String(a.display_name).localeCompare(
          String(b.display_name)
        )
      );

    setSymbols(list);

    setMessage(
      `${list.length} active Deriv markets discovered.`
    );

    return list;
  }, [request]);

  // SCAN ONE MARKET.
  // Use every valid closed candle Deriv actually returns.
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

      diagnostic.responseType =
        response.msg_type || "Unknown";

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
        diagnostic.latestEpoch =
          closed[closed.length - 1].epoch;
      }

      const signal = findRetestSignal(
        closed,
        item.symbol,
        item.category
      );

      return {
        ...signal,
        _candleData: diagnostic
      };

    } catch (error) {
      diagnostic.error =
        error.message || "Unknown Deriv API error";

      return {
        direction: "NONE",
        reason: "Market data unavailable",
        deletedBoxIds: [],
        _candleData: diagnostic
      };
    }
  }, [request]);

  // SCAN ALL MARKETS
  const scanAll = useCallback(async list => {
    if (scanLock.current || !runningRef.current) return;

    scanLock.current = true;

    setMessage("Scanning all available Deriv markets...");

    const results = {};
    let completed = 0;
    let nextIndex = 0;

    const worker = async () => {
      while (
        nextIndex < list.length &&
        runningRef.current
      ) {
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
        setProgress(
          Math.round(completed / list.length * 100)
        );

        if (completed % 10 === 0) {
          setSignals(previous => ({
            ...previous,
            ...results
          }));
        }
      }
    };

    try {
      await Promise.all([
        worker(),
        worker()
      ]);

      setSignals(previous => ({
        ...previous,
        ...results
      }));

      // CANCEL ORDERS LINKED TO DELETED BOXES.
      setOrders(previous => previous.filter(order => {
        const result = results[order.symbol];

        if (!result) return true;

        const deleted = result.deletedBoxIds || [];

        return !deleted.includes(order.boxId);
      }));

      setLastScan(new Date().toLocaleTimeString());

      setMessage(
        runningRef.current
          ? `Scan complete: ${completed} of ${list.length} symbols checked.`
          : "Scanning stopped."
      );

    } finally {
      scanLock.current = false;
    }
  }, [scanSymbol]);

  // START
  const startRobot = async () => {
    if (runningRef.current) return;

    try {
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

      if (scanTimer.current) {
        clearInterval(scanTimer.current);
      }

      scanTimer.current = setInterval(() => {
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

  // STOP
  const stopRobot = () => {
    runningRef.current = false;
    setRunning(false);

    if (scanTimer.current) {
      clearInterval(scanTimer.current);
      scanTimer.current = null;
    }

    setOrders([]);
    setMessage(
      "STOPPED. All simulated pending orders cleared."
    );
  };

  // ACTIVATE CONFIRMED SIGNAL
  const activateSignal = item => {
    const signal = signals[item.symbol];

    if (!signal || signal.direction === "NONE") return;

    if (!signal.boxId) {
      setMessage("Signal has no valid box identifier.");
      return;
    }

    // PREVENT DUPLICATE ORDERS FROM THE SAME BOX.
    const duplicate = orders.some(order =>
      order.symbol === item.symbol &&
      order.boxId === signal.boxId
    );

    if (duplicate) {
      setMessage(
        `${item.symbol}: an order already exists for this box.`
      );
      return;
    }

    const order = makeDemoOrder(
      signal,
      item.symbol,
      item.category,
      balance,
      riskPct
    );

    setOrders(previous => [
      order,
      ...previous
    ]);

    setSelected(item);
    setLastActivated(order.source);

    setMessage(
      `${item.symbol}: simulated pending order placed at ${fmt(order.entry, 8)}.`
    );
  };

  // CLEANUP
  useEffect(() => {
    return () => {
      runningRef.current = false;

      if (scanTimer.current) {
        clearInterval(scanTimer.current);
      }

      if (socketRef.current) {
        socketRef.current.close();
      }

      pendingRef.current.forEach(p => {
        clearTimeout(p.timeout);
      });

      pendingRef.current.clear();
    };
  }, []);

  // FILTER MARKETS
  const visibleSymbols = symbols.filter(item => {
    const matchesCategory =
      category === "All" ||
      item.category === category;

    const searchTerm = search.toLowerCase();

    const matchesSearch =
      !searchTerm ||
      String(item.display_name || "")
        .toLowerCase().includes(searchTerm) ||
      String(item.symbol || "")
        .toLowerCase().includes(searchTerm);

    return matchesCategory && matchesSearch;
  });

  const buyCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "BUY"
  ).length;

  const sellCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "SELL"
  ).length;

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
    .filter(item =>
      signals[item.symbol].direction === "NONE"
    )
    .sort((a, b) =>
      String(a.display_name).localeCompare(
        String(b.display_name)
      )
    );

  const candleDiagnosticList =
    Object.values(candleDiagnostics);

  const marketsWithCandleData =
    candleDiagnosticList.filter(d =>
      d.returned > 0
    ).length;

  const marketsWithErrors =
    candleDiagnosticList.filter(d =>
      d.error
    ).length;

  const signalColor = direction =>
    direction === "BUY"
      ? "#16c784"
      : direction === "SELL"
      ? "#ea5455"
      : "#8993a4";

  return (
    <div style={styles.app}>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #080d18; }
        button, input { font: inherit; }
        button { cursor: pointer; }
        .market-scroll {
          display:flex;
          gap:7px;
          overflow-x:auto;
          padding:4px 0 10px;
          scrollbar-width:none;
        }
        .market-scroll::-webkit-scrollbar { display:none; }
        .market-card:active { transform:scale(.99); }
        .market-card { transition:transform .12s ease; }
        .market-card:disabled {
          opacity:.55;
          cursor:not-allowed;
        }
        input:focus { outline:1px solid #31a8ff; }
      `}</style>

      <header style={styles.header}>
        <div>
          <div style={styles.brand}>iFX BILLIONAIRE</div>
          <div style={styles.subtitle}>
            HLZ MOBILE ROBOT · RETEST EDITION
          </div>
        </div>

        <div style={{
          ...styles.status,
          background: running ? "#123e30" : "#33252a",
          color: running ? "#25d99a" : "#ff7a82"
        }}>
          <span style={{
            ...styles.dot,
            background: running ? "#25d99a" : "#ff626c"
          }}/>
          {running ? "RUNNING" : "STOPPED"}
        </div>
      </header>

      <main style={styles.main}>

        {/* ROBOT CONTROL */}
        <section style={styles.panel}>
          <div style={styles.panelTitle}>ROBOT CONTROL</div>

          <div style={styles.connection}>
            <span style={{
              ...styles.dot,
              background: connected ? "#20c997" : "#8892a6"
            }}/>
            {connectionText}
            <span style={styles.demoTag}>DEMO EXECUTION</span>
          </div>

          <div style={styles.buttonRow}>
            <button
              onClick={startRobot}
              disabled={running}
              style={{
                ...styles.primaryButton,
                opacity: running ? .5 : 1
              }}
            >
              ▶ START ROBOT
            </button>

            <button
              onClick={stopRobot}
              disabled={!running && orders.length === 0}
              style={styles.stopButton}
            >
              ■ STOP
            </button>
          </div>

          <div style={styles.message}>{message}</div>

          <div style={styles.progressTrack}>
            <div style={{
              ...styles.progressFill,
              width: `${progress}%`
            }}/>
          </div>

          <div style={styles.smallText}>
            Scan progress: {scanned}/{symbols.length} · {progress}%
          </div>
        </section>

        {/* SUMMARY */}
        <section style={styles.statsGrid}>
          <div style={styles.stat}>
            <div style={styles.statLabel}>MARKETS FOUND</div>
            <div style={styles.statValue}>{symbols.length}</div>
          </div>

          <div style={styles.stat}>
            <div style={styles.statLabel}>BUY SIGNALS</div>
            <div style={{
              ...styles.statValue,
              color: "#16c784"
            }}>
              {buyCount}
            </div>
          </div>

          <div style={styles.stat}>
            <div style={styles.statLabel}>SELL SIGNALS</div>
            <div style={{
              ...styles.statValue,
              color: "#ea5455"
            }}>
              {sellCount}
            </div>
          </div>

          <div style={styles.stat}>
            <div style={styles.statLabel}>OPEN DEMO ORDERS</div>
            <div style={styles.statValue}>{orders.length}</div>
          </div>
        </section>

        {/* STRATEGY */}
        <section style={styles.panel}>
          <div style={styles.panelTitle}>STRATEGY RULES</div>

          <div style={styles.ruleText}>
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
            EMA: Completely removed. No EMA calculations or filters.
          </div>
        </section>

        {/* CANDLE DATA */}
        <section style={styles.panel}>
          <div style={styles.panelHeading}>
            <div>
              <div style={styles.panelTitle}>
                DERIV CANDLE DATA DIAGNOSTICS
              </div>
              <div style={styles.smallText}>
                Maximum request: {CANDLE_COUNT} candles · M5
              </div>
            </div>
          </div>

          {scanned === 0 && (
            <div style={styles.empty}>
              Start the robot to inspect Deriv candle responses.
            </div>
          )}

          {scanned > 0 && (
            <>
              <div style={styles.diagnosticList}>
                {[
                  ["Markets checked", scanned],
                  ["Maximum candles requested", CANDLE_COUNT],
                  ["Markets with candle data", marketsWithCandleData],
                  ["Markets with API errors", marketsWithErrors]
                ].map(([label, value]) => (
                  <div key={label} style={styles.diagnosticRow}>
                    <span style={styles.diagnosticReason}>
                      {label}
                    </span>
                    <span style={styles.diagnosticCount}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{
                ...styles.panelTitle,
                marginTop: 17
              }}>
                INDIVIDUAL MARKET DATA
              </div>

              {symbols
                .filter(item => candleDiagnostics[item.symbol])
                .map(item => {
                  const d = candleDiagnostics[item.symbol];

                  return (
                    <div
                      key={item.symbol}
                      style={styles.diagnosticMarket}
                    >
                      <div style={styles.diagnosticMarketName}>
                        {item.display_name || item.symbol}
                      </div>

                      <div style={styles.smallText}>
                        Symbol: {item.symbol}
                      </div>

                      <div style={styles.diagnosticReasonText}>
                        Maximum requested: {d.requestedMaximum}
                      </div>

                      <div style={styles.diagnosticReasonText}>
                        Returned by Deriv: {d.returned}
                      </div>

                      <div style={styles.diagnosticReasonText}>
                        Valid candles: {d.valid}
                      </div>

                      <div style={styles.diagnosticReasonText}>
                        Closed candles: {d.closed}
                      </div>

                      <div style={styles.diagnosticReasonText}>
                        Response type: {d.responseType}
                      </div>

                      {d.oldestEpoch && (
                        <div style={styles.smallText}>
                          Oldest closed candle:{" "}
                          {new Date(
                            d.oldestEpoch * 1000
                          ).toISOString()}
                        </div>
                      )}

                      {d.latestEpoch && (
                        <div style={styles.smallText}>
                          Latest closed candle:{" "}
                          {new Date(
                            d.latestEpoch * 1000
                          ).toISOString()}
                        </div>
                      )}

                      {d.error && (
                        <div style={{
                          ...styles.diagnosticReasonText,
                          color: "#ff7777"
                        }}>
                          API ERROR: {d.error}
                        </div>
                      )}
                    </div>
                  );
                })}
            </>
          )}

          <div style={styles.ruleText}>
            Deriv may return fewer candles than requested.
            All valid closed candles returned are used.
            No minimum of 1,200 candles is required.
          </div>
        </section>

        {/* STRATEGY DIAGNOSTICS */}
        <section style={styles.panel}>
          <div style={styles.panelHeading}>
            <div>
              <div style={styles.panelTitle}>
                STRATEGY DIAGNOSTICS
              </div>
              <div style={styles.smallText}>
                Why each scanned market does or does not have a signal
              </div>
            </div>

            <div style={styles.countBadge}>
              {scanned} SCANNED
            </div>
          </div>

          {!scanned && (
            <div style={styles.empty}>
              Start the robot to see diagnostic results.
            </div>
          )}

          {scanned > 0 && (
            <div style={styles.diagnosticList}>
              {Object.entries(diagnosticCounts)
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <div
                    key={reason}
                    style={styles.diagnosticRow}
                  >
                    <span style={styles.diagnosticReason}>
                      {reason}
                    </span>
                    <span style={styles.diagnosticCount}>
                      {count}
                    </span>
                  </div>
                ))}
            </div>
          )}

          <div style={styles.ruleText}>
            Diagnostics only. No EMA conditions are used.
          </div>

          <div style={{
            ...styles.panelTitle,
            marginTop: 17
          }}>
            MARKET-BY-MARKET REASONS
          </div>

          {!diagnosticMarkets.length && scanned > 0 && (
            <div style={styles.empty}>
              No markets currently have a NONE signal.
            </div>
          )}

          {diagnosticMarkets.map(item => (
            <div
              key={item.symbol}
              style={styles.diagnosticMarket}
            >
              <div style={styles.diagnosticMarketName}>
                {item.display_name || item.symbol}
              </div>

              <div style={styles.smallText}>
                {item.symbol}
              </div>

              <div style={styles.diagnosticReasonText}>
                {signals[item.symbol]?.reason ||
                  "No diagnostic available"}
              </div>
            </div>
          ))}
        </section>

        {/* ACTIVE SIGNALS */}
        <section style={styles.panel}>
          <div style={styles.panelHeading}>
            <div>
              <div style={styles.panelTitle}>
                ACTIVE RETEST SIGNALS
              </div>
              <div style={styles.smallText}>
                All currently discovered Deriv markets
              </div>
            </div>

            <div style={styles.smallText}>
              M5 · BOX RETEST ONLY
            </div>
          </div>

          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search symbol or market..."
            style={styles.search}
          />

          <div className="market-scroll">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                style={{
                  ...styles.categoryButton,
                  background: category === cat
                    ? "#1677d2"
                    : "#18243a",
                  color: category === cat
                    ? "#fff"
                    : "#aab7cc"
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          {!symbols.length && (
            <div style={styles.empty}>
              Press START ROBOT to discover Deriv markets.
            </div>
          )}

          <div style={styles.marketList}>
            {visibleSymbols.map(item => {
              const signal = signals[item.symbol] || {
                direction: "NONE",
                reason: "Waiting for scan"
              };

              const color = signalColor(signal.direction);

              const isSelected =
                selected?.symbol === item.symbol;

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
                        `${item.display_name}: ${
                          signal.reason || "No signal"
                        }`
                      );
                    }
                  }}
                  style={{
                    ...styles.marketCard,
                    borderColor: isSelected
                      ? "#31a8ff"
                      : "#24334b"
                  }}
                >
                  <div style={styles.marketLeft}>
                    <div style={styles.marketName}>
                      {item.display_name || item.symbol}
                    </div>

                    <div style={styles.marketMeta}>
                      {item.symbol} · {item.category}
                    </div>

                    {signal.direction !== "NONE" && (
                      <>
                        <div style={styles.signalDetail}>
                          {signal.boxType} · {signal.touchType}
                        </div>

                        <div style={styles.signalDetail}>
                          Entry: {fmt(signal.entry, 8)}
                        </div>

                        {hasOrder && (
                          <div style={{
                            ...styles.signalDetail,
                            color: "#f4c46a"
                          }}>
                            DEMO ORDER ALREADY CREATED
                          </div>
                        )}
                      </>
                    )}

                    {signal.direction === "NONE" && (
                      <div style={styles.diagnosticReasonText}>
                        {signal.reason}
                      </div>
                    )}
                  </div>

                  <div style={{
                    ...styles.signalBadge,
                    background: color
                  }}>
                    {signal.direction === "NONE"
                      ? "NONE"
                      : signal.direction}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* SETTINGS */}
        <section style={styles.panel}>
          <div style={styles.panelTitle}>TRADE SETTINGS</div>

          <div style={styles.settingsGrid}>
            <label style={styles.field}>
              <span>Demo balance ($)</span>
              <input
                type="number"
                value={balance}
                onChange={e =>
                  setBalance(Number(e.target.value))
                }
                style={styles.numberInput}
              />
            </label>

            <label style={styles.field}>
              <span>Risk per trade (%)</span>
              <input
                type="number"
                min="0.1"
                max="10"
                step="0.1"
                value={riskPct}
                onChange={e =>
                  setRiskPct(Number(e.target.value))
                }
                style={styles.numberInput}
              />
            </label>

            <label style={styles.field}>
              <span>Fixed lots (display only)</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={fixedLots}
                onChange={e =>
                  setFixedLots(Number(e.target.value))
                }
                style={styles.numberInput}
              />
            </label>
          </div>

          <div style={styles.ruleText}>
            Forex demo: 10-pip SL / 31-pip TP.
            <br/>
            Non-Forex demo: 10-point SL / 1,000-point TP.
            <br/>
            Non-Forex distances remain provisional test values,
            not validated live contract settings.
          </div>
        </section>

        {/* DEMO ORDERS */}
        <section style={styles.panel}>
          <div style={styles.panelHeading}>
            <div>
              <div style={styles.panelTitle}>
                DEMO PENDING ORDERS
              </div>
              <div style={styles.smallText}>
                Orders created by tapping a valid signal
              </div>
            </div>

            <div style={styles.countBadge}>
              {orders.length}
            </div>
          </div>

          {!orders.length && (
            <div style={styles.empty}>
              No demo pending orders.
            </div>
          )}

          {orders.map(order => (
            <div
              key={order.id}
              style={styles.orderCard}
            >
              <div style={styles.panelHeading}>
                <strong>{order.symbol}</strong>

                <span style={{
                  color: order.direction === "BUY"
                    ? "#16c784"
                    : "#ea5455",
                  fontWeight: 800
                }}>
                  {order.direction}
                </span>
              </div>

              <div style={styles.smallText}>
                {order.source}
              </div>

              <div style={styles.orderGrid}>
                <div>
                  ENTRY
                  <b>{fmt(order.entry, 8)}</b>
                </div>

                <div>
                  STOP LOSS
                  <b>{fmt(order.sl, 8)}</b>
                </div>

                <div>
                  TAKE PROFIT
                  <b>{fmt(order.tp, 8)}</b>
                </div>

                <div>
                  RISK
                  <b>${fmt(order.riskMoney, 2)}</b>
                </div>
              </div>

              <div style={styles.demoTag}>
                {order.status}
              </div>
            </div>
          ))}
        </section>

        {/* LAST ACTIVATED */}
        <section style={styles.panel}>
          <div style={styles.panelTitle}>LAST ACTIVATED</div>

          <div style={styles.lastActivated}>
            {lastActivated}
          </div>

          <div style={styles.smallText}>
            Last scan: {lastScan}
          </div>
        </section>

        {/* EXECUTION WARNING */}
        <section style={styles.warning}>
          <strong>IMPORTANT — EXECUTION STATUS</strong>

          <p>
            Deriv public market data is connected separately
            from broker execution. This build scans Deriv
            market data and creates simulated pending orders.
            It does not send real pending orders, close real
            positions or manage a live account.
          </p>

          <p>
            Simulated pending orders are recorded at the
            calculated entry price. Automatic fill, SL and TP
            outcome simulation is not implemented in this build.
          </p>

          <p>
            Asia session is calculated using UTC candle
            timestamps.
          </p>
        </section>

        <footer style={styles.footer}>
          iFX BILLIONAIRE ROBOT · HLZ MOBILE
          <br/>
          Breakouts · Retests · FLIPPY
        </footer>

      </main>
    </div>
  );
}

const styles = {
  app: {
    minHeight: "100vh",
    background: "#080d18",
    color: "#eef4ff",
    fontFamily: "Arial, sans-serif"
  },

  header: {
    padding: "20px 16px",
    background: "#101a2b",
    borderBottom: "1px solid #24334b",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10
  },

  brand: {
    fontSize: 19,
    fontWeight: 900,
    letterSpacing: 1.2
  },

  subtitle: {
    fontSize: 10,
    color: "#8293ad",
    marginTop: 5,
    letterSpacing: 1.5
  },

  status: {
    borderRadius: 20,
    padding: "8px 11px",
    fontSize: 11,
    fontWeight: 900,
    display: "flex",
    alignItems: "center",
    gap: 7
  },

  dot: {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%"
  },

  main: {
    width: "100%",
    maxWidth: 900,
    margin: "0 auto",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 12
  },

  panel: {
    background: "#101a2b",
    border: "1px solid #24334b",
    borderRadius: 13,
    padding: 14
  },

  panelTitle: {
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: 1,
    color: "#dce8fb"
  },

  panelHeading: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10
  },

  connection: {
    marginTop: 12,
    fontSize: 11,
    color: "#9aaac1",
    display: "flex",
    alignItems: "center",
    gap: 8
  },

  demoTag: {
    display: "inline-block",
    fontSize: 9,
    color: "#f4c46a",
    background: "#382e1d",
    borderRadius: 5,
    padding: "5px 7px",
    fontWeight: 900,
    letterSpacing: .5,
    marginTop: 7
  },

  buttonRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 9,
    marginTop: 15
  },

  primaryButton: {
    border: 0,
    borderRadius: 9,
    background: "#138d68",
    color: "white",
    padding: 14,
    fontWeight: 900
  },

  stopButton: {
    border: 0,
    borderRadius: 9,
    background: "#a52d3a",
    color: "white",
    padding: 14,
    fontWeight: 900
  },

  message: {
    fontSize: 11,
    color: "#9fb1ca",
    marginTop: 12,
    lineHeight: 1.5
  },

  progressTrack: {
    height: 5,
    background: "#26364e",
    borderRadius: 10,
    marginTop: 10,
    overflow: "hidden"
  },

  progressFill: {
    height: "100%",
    background: "#31a8ff",
    transition: "width .2s"
  },

  smallText: {
    fontSize: 10,
    color: "#8395af",
    marginTop: 6,
    lineHeight: 1.5
  },

  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    gap: 8
  },

  stat: {
    padding: 13,
    background: "#101a2b",
    border: "1px solid #24334b",
    borderRadius: 10
  },

  statLabel: {
    fontSize: 9,
    color: "#8193ad",
    fontWeight: 800,
    letterSpacing: .7
  },

  statValue: {
    fontSize: 23,
    fontWeight: 900,
    marginTop: 7
  },

  search: {
    width: "100%",
    marginTop: 13,
    background: "#0a1424",
    border: "1px solid #30435e",
    borderRadius: 8,
    color: "white",
    padding: 12,
    fontSize: 13
  },

  categoryButton: {
    border: 0,
    borderRadius: 20,
    padding: "8px 12px",
    fontSize: 10,
    fontWeight: 800,
    whiteSpace: "nowrap"
  },

  marketList: {
    display: "flex",
    flexDirection: "column",
    gap: 7
  },

  marketCard: {
    width: "100%",
    background: "#0b1525",
    border: "1px solid #24334b",
    borderRadius: 9,
    padding: 11,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    textAlign: "left",
    gap: 8,
    color: "#edf4ff"
  },

  marketLeft: {
    minWidth: 0,
    flex: 1
  },

  marketName: {
    fontSize: 12,
    fontWeight: 800,
    overflowWrap: "anywhere"
  },

  marketMeta: {
    fontSize: 9,
    color: "#8294ae",
    marginTop: 4
  },

  signalDetail: {
    fontSize: 9,
    color: "#a9c9e9",
    marginTop: 5
  },

  signalBadge: {
    minWidth: 65,
    textAlign: "center",
    padding: "8px 7px",
    borderRadius: 6,
    fontSize: 10,
    fontWeight: 900,
    color: "#07111c"
  },

  empty: {
    textAlign: "center",
    padding: 22,
    color: "#8395af",
    fontSize: 12,
    lineHeight: 1.6
  },

  settingsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    gap: 12,
    marginTop: 13
  },

  field: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
    fontSize: 10,
    color: "#94a8c3"
  },

  numberInput: {
    width: "100%",
    minWidth: 0,
    background: "#0a1424",
    border: "1px solid #30435e",
    borderRadius: 7,
    color: "white",
    padding: 10,
    fontSize: 13
  },

  ruleText: {
    marginTop: 13,
    fontSize: 10,
    lineHeight: 1.7,
    color: "#a8b7cb",
    background: "#0b1525",
    padding: 10,
    borderRadius: 7
  },

  countBadge: {
    background: "#203653",
    borderRadius: 20,
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 900
  },

  orderCard: {
    background: "#0b1525",
    border: "1px solid #2b3e58",
    borderRadius: 9,
    padding: 12,
    marginTop: 10
  },

  orderGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
    marginTop: 13,
    fontSize: 9,
    color: "#8395af"
  },

  lastActivated: {
    marginTop: 12,
    padding: 12,
    background: "#0b1525",
    borderRadius: 8,
    color: "#48c9a0",
    fontSize: 13,
    fontWeight: 900,
    overflowWrap: "anywhere"
  },

  diagnosticList: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
    marginTop: 14
  },

  diagnosticRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    background: "#0b1525",
    padding: "10px 11px",
    borderRadius: 7
  },

  diagnosticReason: {
    color: "#b9c9df",
    fontSize: 11,
    lineHeight: 1.4
  },

  diagnosticCount: {
    color: "#55c9ff",
    fontSize: 13,
    fontWeight: 900
  },

  diagnosticMarket: {
    background: "#0b1525",
    border: "1px solid #24334b",
    padding: 10,
    borderRadius: 7,
    marginTop: 8
  },

  diagnosticMarketName: {
    fontSize: 11,
    fontWeight: 800,
    color: "#edf4ff"
  },

  diagnosticReasonText: {
    fontSize: 10,
    color: "#f1c477",
    marginTop: 5,
    lineHeight: 1.5
  },

  warning: {
    background: "#302719",
    border: "1px solid #725b2e",
    color: "#f4d69a",
    padding: 13,
    borderRadius: 10,
    fontSize: 11,
    lineHeight: 1.6
  },

  footer: {
    textAlign: "center",
    padding: "16px 5px 28px",
    color: "#647893",
    fontSize: 9,
    letterSpacing: 1.2,
    lineHeight: 1.8
  }
};
