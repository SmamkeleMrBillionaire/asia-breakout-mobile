import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

const TIMEFRAME = 900;
const CANDLE_COUNT = 220;
const SCAN_INTERVAL = 10000;

const TRADING_START_HOUR = 7;
const TRADING_END_HOUR = 22;

const ARM_DISTANCE_PIPS = 3;
const ARM_CANDLE_LIMIT = 6;
const SL_OFFSET_PIPS = 15;
const TAKE_PROFIT_MULTIPLE = 4;
const MAX_SPREAD_POINTS = 300;
const MAX_DAILY_TRADES = 4;
const MAX_OPEN_TRADES = 4;

const PRIORITY_SYMBOLS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD",
  "USDCAD", "NZDUSD", "EURJPY", "GBPJPY", "EURGBP",
  "XAUUSD", "US30", "NAS100", "AUDCAD", "NZDJPY",
  "GBPCAD", "AUDJPY", "EURAUD", "EURCAD", "NZDCHF",
  "CADJPY"
];

const CATEGORIES = [
  "All", "Forex", "Indices", "Metals",
  "Synthetics", "Crypto", "Stocks", "Other"
];

const fmt = (n, digits = 5) =>
  Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "—";

const serverDay = epoch =>
  new Date(epoch * 1000).toISOString().slice(0, 10);

const serverHour = epoch =>
  new Date(epoch * 1000).getUTCHours();

const serverMinute = epoch =>
  new Date(epoch * 1000).getUTCMinutes();

const serverTime = epoch =>
  new Date(epoch * 1000).toISOString().slice(11, 19);

const candleColor = c =>
  c.close > c.open ? "GREEN" :
  c.close < c.open ? "RED" : "NEUTRAL";

const normalizeSymbol = symbol =>
  String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function priorityMatch(symbol) {
  const normalized = normalizeSymbol(symbol);
  return PRIORITY_SYMBOLS.find(p => normalized.includes(p)) || null;
}

function priorityIndex(symbol) {
  const match = priorityMatch(symbol);
  return match ? PRIORITY_SYMBOLS.indexOf(match) : 999;
}

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

function pipSize(symbol, category, candles, marketPip) {
  if (
    Number.isFinite(Number(marketPip)) &&
    Number(marketPip) > 0
  ) return Number(marketPip);

  if (category === "Forex") {
    return String(symbol).toUpperCase().includes("JPY")
      ? 0.01
      : 0.0001;
  }

  const last = candles[candles.length - 1]?.close || 1;
  const decimals = (String(last).split(".")[1] || "").length;
  return Math.pow(10, -Math.min(decimals, 8));
}

function pointSize(price) {
  const decimals = (String(price).split(".")[1] || "").length;
  return Math.pow(10, -Math.min(decimals, 10));
}

function candleBody(c) {
  return {
    high: Math.max(c.open, c.close),
    low: Math.min(c.open, c.close)
  };
}

function isDoji(c) {
  const range = c.high - c.low;
  if (range <= 0) return false;
  return Math.abs(c.close - c.open) <= range * 0.20;
}

function isEngulfing(current, previous) {
  if (!current || !previous) return false;

  const a = candleColor(current);
  const b = candleColor(previous);

  if (
    a === "NEUTRAL" ||
    b === "NEUTRAL" ||
    a === b
  ) return false;

  const currentBody = candleBody(current);
  const previousBody = candleBody(previous);

  return (
    currentBody.high >= previousBody.high &&
    currentBody.low <= previousBody.low
  );
}

function makeBoxId(type, day, high, low, epoch = "") {
  return [
    type,
    day,
    Number(high).toPrecision(12),
    Number(low).toPrecision(12),
    epoch
  ].join("-");
}

function isTradingTime(epoch) {
  const hour = serverHour(epoch);
  return hour >= TRADING_START_HOUR && hour < TRADING_END_HOUR;
}

// ======================================================
// RSI(3)
// ======================================================

function calculateRSI(candles, index, period = 3) {
  if (!candles || index < period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    if (change < 0) losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i <= index; i++) {
    const change = candles[i].close - candles[i - 1].close;

    averageGain = (
      averageGain * (period - 1) + Math.max(change, 0)
    ) / period;

    averageLoss = (
      averageLoss * (period - 1) + Math.max(-change, 0)
    ) / period;
  }

  if (averageLoss === 0 && averageGain === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;

  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

// ======================================================
// ORANGE BOX
// ======================================================

function buildOrangeBox(candles, day) {
  const firstFour = candles
    .filter(c =>
      serverDay(c.epoch) === day &&
      serverHour(c.epoch) === 0 &&
      [0, 15, 30, 45].includes(serverMinute(c.epoch))
    )
    .sort((a, b) => a.epoch - b.epoch)
    .slice(0, 4);

  if (firstFour.length !== 4) return null;

  const consecutive = firstFour.every((c, i) =>
    i === 0 ||
    c.epoch - firstFour[i - 1].epoch === TIMEFRAME
  );

  if (!consecutive) return null;

  const high = Math.max(...firstFour.map(c => c.high));
  const low = Math.min(...firstFour.map(c => c.low));

  if (!(high > low)) return null;

  return {
    type: "ORANGE",
    day,
    high,
    low,
    size: high - low,
    startEpoch: firstFour[0].epoch,
    endEpoch: firstFour[0].epoch + 86400,
    createdEpoch: firstFour[0].epoch,
    createdIndex: candles.indexOf(firstFour[3]),
    boxId: makeBoxId("ORANGE", day, high, low)
  };
}

// ======================================================
// DOJI / ENGULFING BOXES
// Four independent zones:
// TODAY ABOVE, TODAY BELOW,
// YESTERDAY ABOVE, YESTERDAY BELOW.
// ======================================================

function previousDay(day) {
  return new Date(
    new Date(`${day}T00:00:00Z`).getTime() - 86400000
  ).toISOString().slice(0, 10);
}

function buildDojiZones(candles, todayOrange, yesterdayOrange, pip) {
  const zones = [];

  if (!candles?.length) return zones;

  const today = todayOrange?.day;
  const yesterday = yesterdayOrange?.day;

  if (!todayOrange && !yesterdayOrange) return zones;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const previous = candles[i - 1];
    const day = serverDay(c.epoch);

    const doji = isDoji(c);
    const engulfing = isEngulfing(c, previous);

    if (!doji && !engulfing) continue;

    const orange = day === today
      ? todayOrange
      : day === yesterday
        ? yesterdayOrange
        : null;

    if (!orange) continue;

    let side = null;

    if (c.low > orange.high) {
      side = "ABOVE";
    } else if (c.high < orange.low) {
      side = "BELOW";
    }

    if (!side) continue;

    const type = doji ? "DOJI" : "ENGULFING";

    zones.push({
      type,
      side,
      day,
      high: c.high,
      low: c.low,
      sourceIndex: i,
      sourceEpoch: c.epoch,
      sourceCandle: c,
      boxId: makeBoxId(type, day, c.high, c.low, c.epoch),
      orangeBoxId: orange.boxId,
      touchCount: 0,
      firstTouchIndex: null,
      lastTouchIndex: null,
      armed: day === yesterday,
      armExpired: false,
      deleted: false
    });
  }

  // Keep the latest zone for each of the four categories.
  const groups = [
    { day: today, side: "ABOVE" },
    { day: today, side: "BELOW" },
    { day: yesterday, side: "ABOVE" },
    { day: yesterday, side: "BELOW" }
  ];

  const selected = [];

  for (const group of groups) {
    const match = zones
      .filter(z => z.day === group.day && z.side === group.side)
      .sort((a, b) => b.sourceIndex - a.sourceIndex)[0];

    if (match) selected.push(match);
  }

  return selected.map(zone => {
    let touchCount = 0;
    let firstTouchIndex = null;
    let lastTouchIndex = null;
    let armed = zone.armed;
    let armExpired = false;

    for (
      let i = zone.sourceIndex + 1;
      i < candles.length;
      i++
    ) {
      const c = candles[i];

      // Today's zones must arm within the next six candles.
      if (zone.day === today && !armed) {
        const age = i - zone.sourceIndex;

        if (age > ARM_CANDLE_LIMIT) {
          armExpired = true;
          break;
        }

        const armDistance = ARM_DISTANCE_PIPS * pip;

        const armedNow = zone.side === "ABOVE"
          ? c.close >= zone.high + armDistance
          : c.close <= zone.low - armDistance;

        if (armedNow) {
          armed = true;
        }
      }

      if (!armed) continue;

      const intersects =
        c.low <= zone.high &&
        c.high >= zone.low;

      if (intersects && i !== lastTouchIndex) {
        touchCount++;

        if (firstTouchIndex === null) {
          firstTouchIndex = i;
        }

        lastTouchIndex = i;
      }

      if (touchCount >= 2) break;
    }

    return {
      ...zone,
      touchCount,
      firstTouchIndex,
      lastTouchIndex,
      armed,
      armExpired,
      deleted: touchCount >= 2 || armExpired
    };
  }).filter(z => !z.deleted);
}

// ======================================================
// DAILY CANDLES
// ======================================================

function buildDailyCandles(candles, today) {
  const daily = new Map();

  for (const c of candles) {
    const day = serverDay(c.epoch);

    if (!daily.has(day)) {
      daily.set(day, {
        day,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        firstEpoch: c.epoch,
        lastEpoch: c.epoch
      });
    } else {
      const d = daily.get(day);

      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);

      if (c.epoch < d.firstEpoch) {
        d.open = c.open;
        d.firstEpoch = c.epoch;
      }

      if (c.epoch > d.lastEpoch) {
        d.close = c.close;
        d.lastEpoch = c.epoch;
      }
    }
  }

  const yesterday = previousDay(today);

  return {
    today: daily.get(today) || null,
    yesterday: daily.get(yesterday) || null
  };
}

// ======================================================
// SIGNAL CREATION
// ======================================================

function makeSignal({
  direction,
  strategy,
  candle,
  orangeBox,
  pip,
  zone = null,
  entryLevel,
  reason,
  rsi
}) {
  return {
    direction,
    strategy,
    boxType: zone ? zone.type : "ORANGE",
    touchType: strategy,
    signalId: `${zone?.boxId || orangeBox.boxId}|${strategy}|${candle.epoch}`,
    boxId: zone?.boxId || orangeBox.boxId,
    orangeBoxId: orangeBox.boxId,
    boxHigh: orangeBox.high,
    boxLow: orangeBox.low,
    boxSize: orangeBox.size,
    dojiHigh: zone?.high ?? null,
    dojiLow: zone?.low ?? null,
    dojiId: zone?.boxId ?? null,
    dojiSide: zone?.side ?? null,
    zoneDay: zone?.day ?? null,
    zoneTouchCount: zone?.touchCount ?? null,
    entryLevel,
    pip,
    candleTime: candle.epoch,
    candleColor: candleColor(candle),
    rsi,
    volume: candle.volume ?? null,
    reason
  };
}

// ======================================================
// CLOSED M15 ENTRY LOGIC
// ======================================================

function findClosedEntrySignal(
  candles,
  symbol,
  category,
  marketPip
) {
  const empty = {
    direction: "NONE",
    reason: "Waiting for a valid setup",
    boxCount: 0
  };

  if (!candles || candles.length < 30) {
    return { ...empty, reason: "Not enough M15 candles" };
  }

  const lastIndex = candles.length - 1;
  const candle = candles[lastIndex];
  const today = serverDay(candle.epoch);
  const yesterday = previousDay(today);

  const orangeBox = buildOrangeBox(candles, today);

  if (!orangeBox) {
    return {
      ...empty,
      reason: "Waiting for four completed 00:00–01:00 UTC candles"
    };
  }

  const pip = pipSize(symbol, category, candles, marketPip);

  const yesterdayOrange = buildOrangeBox(candles, yesterday);

  const zones = buildDojiZones(
    candles,
    orangeBox,
    yesterdayOrange,
    pip
  );

  const rsi = calculateRSI(candles, lastIndex, 3);

  const boxInfo = {
    boxCount: 1 + zones.length,
    boxHigh: orangeBox.high,
    boxLow: orangeBox.low,
    boxSize: orangeBox.size,
    boxId: orangeBox.boxId,
    boxDay: orangeBox.day,
    zones,
    rsi
  };

  if (candle.epoch < orangeBox.createdEpoch + TIMEFRAME * 4) {
    return {
      ...empty,
      ...boxInfo,
      reason: "Orange Box constructed. Waiting for M15 setup."
    };
  }

  if (!isTradingTime(candle.epoch)) {
    return {
      ...empty,
      ...boxInfo,
      reason: "Trading paused outside 07:00–22:00 UTC"
    };
  }

  const color = candleColor(candle);

  const openAbove = candle.open > orangeBox.high;
  const openBelow = candle.open < orangeBox.low;

  const closeAbove = candle.close > orangeBox.high;
  const closeBelow = candle.close < orangeBox.low;

  const closeInside =
    candle.close >= orangeBox.low &&
    candle.close <= orangeBox.high;

  // --------------------------------------------------
  // ORANGE BOX RETEST / BOUNCE / REJECTION
  // --------------------------------------------------

  if (
    openAbove &&
    color === "RED" &&
    candle.low >= orangeBox.low &&
    candle.low <= orangeBox.high &&
    closeAbove
  ) {
    return {
      ...makeSignal({
        direction: "BUY",
        strategy: "ORANGE RETEST BUY",
        candle,
        orangeBox,
        pip,
        entryLevel: orangeBox.high,
        rsi,
        reason: "Red candle opened above, wicked into Orange Box and closed above"
      }),
      ...boxInfo
    };
  }

  if (
    openBelow &&
    color === "GREEN" &&
    candle.high >= orangeBox.low &&
    candle.high <= orangeBox.high &&
    closeBelow
  ) {
    return {
      ...makeSignal({
        direction: "SELL",
        strategy: "ORANGE RETEST SELL",
        candle,
        orangeBox,
        pip,
        entryLevel: orangeBox.low,
        rsi,
        reason: "Green candle opened below, wicked into Orange Box and closed below"
      }),
      ...boxInfo
    };
  }

  // --------------------------------------------------
  // ORANGE BOX BREAK-IN
  // --------------------------------------------------

  if (openAbove && color === "RED" && closeInside) {
    return {
      ...makeSignal({
        direction: "SELL",
        strategy: "ORANGE BREAK-IN SELL",
        candle,
        orangeBox,
        pip,
        entryLevel: orangeBox.low - pip,
        rsi,
        reason: "Red candle opened above Orange Box and closed inside"
      }),
      ...boxInfo
    };
  }

  if (openBelow && color === "GREEN" && closeInside) {
    return {
      ...makeSignal({
        direction: "BUY",
        strategy: "ORANGE BREAK-IN BUY",
        candle,
        orangeBox,
        pip,
        entryLevel: orangeBox.high + pip,
        rsi,
        reason: "Green candle opened below Orange Box and closed inside"
      }),
      ...boxInfo
    };
  }

  // --------------------------------------------------
  // DOJI / ENGULFING RETEST AND BREAK-IN
  // --------------------------------------------------

  for (const zone of zones) {
    if (!zone.armed || zone.touchCount >= 2) continue;

    const zoneOpenAbove = candle.open > zone.high;
    const zoneOpenBelow = candle.open < zone.low;

    const zoneCloseAbove = candle.close > zone.high;
    const zoneCloseBelow = candle.close < zone.low;

    const zoneCloseInside =
      candle.close >= zone.low &&
      candle.close <= zone.high;

    // Retest BUY.
    if (
      zoneOpenAbove &&
      color === "RED" &&
      candle.low >= zone.low &&
      candle.low <= zone.high &&
      zoneCloseAbove
    ) {
      return {
        ...makeSignal({
          direction: "BUY",
          strategy: `${zone.type} RETEST BUY`,
          candle,
          orangeBox,
          pip,
          zone,
          entryLevel: zone.high,
          rsi,
          reason: `${zone.day === today ? "Today's" : "Yesterday's"} ${zone.type} zone retest: red candle rejected the zone and closed above`
        }),
        ...boxInfo
      };
    }

    // Retest SELL.
    if (
      zoneOpenBelow &&
      color === "GREEN" &&
      candle.high >= zone.low &&
      candle.high <= zone.high &&
      zoneCloseBelow
    ) {
      return {
        ...makeSignal({
          direction: "SELL",
          strategy: `${zone.type} RETEST SELL`,
          candle,
          orangeBox,
          pip,
          zone,
          entryLevel: zone.low,
          rsi,
          reason: `${zone.day === today ? "Today's" : "Yesterday's"} ${zone.type} zone retest: green candle rejected the zone and closed below`
        }),
        ...boxInfo
      };
    }

    // Break-In SELL.
    if (
      zoneOpenAbove &&
      color === "RED" &&
      zoneCloseInside
    ) {
      return {
        ...makeSignal({
          direction: "SELL",
          strategy: `${zone.type} BREAK-IN SELL`,
          candle,
          orangeBox,
          pip,
          zone,
          entryLevel: zone.low - pip,
          rsi,
          reason: `${zone.type} candle opened above its box and closed inside`
        }),
        ...boxInfo
      };
    }

    // Break-In BUY.
    if (
      zoneOpenBelow &&
      color === "GREEN" &&
      zoneCloseInside
    ) {
      return {
        ...makeSignal({
          direction: "BUY",
          strategy: `${zone.type} BREAK-IN BUY`,
          candle,
          orangeBox,
          pip,
          zone,
          entryLevel: zone.high + pip,
          rsi,
          reason: `${zone.type} candle opened below its box and closed inside`
        }),
        ...boxInfo
      };
    }
  }

  // --------------------------------------------------
  // DOJI FADE — EXACTLY ONE TOUCH
  // --------------------------------------------------

  for (const zone of zones) {
    if (
      !zone.armed ||
      zone.touchCount !== 1 ||
      zone.firstTouchIndex !== lastIndex
    ) continue;

    if (color === "GREEN") {
      return {
        ...makeSignal({
          direction: "SELL",
          strategy: `${zone.type} FADE SELL`,
          candle,
          orangeBox,
          pip,
          zone,
          entryLevel: zone.high,
          rsi,
          reason: `First touch of armed ${zone.type} zone with a GREEN candle`
        }),
        ...boxInfo
      };
    }

    if (color === "RED") {
      return {
        ...makeSignal({
          direction: "BUY",
          strategy: `${zone.type} FADE BUY`,
          candle,
          orangeBox,
          pip,
          zone,
          entryLevel: zone.low,
          rsi,
          reason: `First touch of armed ${zone.type} zone with a RED candle`
        }),
        ...boxInfo
      };
    }
  }

  return {
    ...empty,
    ...boxInfo,
    reason: "No valid closed M15 entry. Waiting for next candle."
  };
}

// ======================================================
// LIVE SCANNER STATE
// ======================================================

function getLiveScannerState({
  candles,
  liveCandle,
  price,
  orangeBox,
  zones,
  pip
}) {
  if (!orangeBox || !Number.isFinite(price)) {
    return {
      state: "WAITING FOR ORANGE BOX",
      proximity: Infinity,
      distance: null
    };
  }

  const current = liveCandle || candles[candles.length - 1];

  if (!current) {
    return {
      state: "WAITING FOR LIVE CANDLE",
      proximity: Infinity,
      distance: null
    };
  }

  const nearestOrange = Math.min(
    Math.abs(price - orangeBox.high),
    Math.abs(price - orangeBox.low)
  );

  const touchingZone = zones.find(zone =>
    zone.armed &&
    current.high >= zone.low &&
    current.low <= zone.high
  );

  if (touchingZone) {
    return {
      state: `${touchingZone.type} TOUCH`,
      proximity: 0,
      distance: 0
    };
  }

  const rsiCandles = liveCandle
    ? [...candles, liveCandle]
    : candles;

  const rsi = calculateRSI(
    rsiCandles,
    rsiCandles.length - 1,
    3
  );

  const outside =
    price > orangeBox.high ||
    price < orangeBox.low;

  if (outside && rsi !== null && (rsi >= 90 || rsi <= 10)) {
    const zoneDistances = zones.map(zone =>
      Math.min(
        Math.abs(price - zone.high),
        Math.abs(price - zone.low)
      )
    );

    return {
      state: "OUTSIDE RSI EXTREME",
      rsi,
      proximity: zoneDistances.length
        ? Math.min(...zoneDistances)
        : nearestOrange,
      distance: zoneDistances.length
        ? Math.min(...zoneDistances)
        : nearestOrange
    };
  }

  if (
    price >= orangeBox.low &&
    price <= orangeBox.high
  ) {
    return {
      state: "INSIDE ORANGE BOX",
      proximity: 0,
      distance: 0
    };
  }

  if (nearestOrange <= pip * 2) {
    return {
      state: "NEAR ORANGE BOX",
      proximity: nearestOrange,
      distance: nearestOrange
    };
  }

  return {
    state: "MONITORING",
    proximity: nearestOrange,
    distance: nearestOrange
  };
}

// ======================================================
// SPREAD
// ======================================================

function getSpreadInfo(tick, price) {
  if (!tick) {
    return { known: false, spread: null, points: null };
  }

  const bid = Number(tick.bid);
  const ask = Number(tick.ask);

  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= 0 ||
    ask < bid
  ) {
    return { known: false, spread: null, points: null };
  }

  const spread = ask - bid;
  const point = pointSize(price || bid);

  return {
    known: true,
    bid,
    ask,
    spread,
    points: spread / point
  };
}

// ======================================================
// DUPLICATE TRADE PROTECTION
// ======================================================

function alreadyExecuted(trades, signal, symbol) {
  return trades.some(trade =>
    trade.symbol === symbol &&
    trade.signalId === signal.signalId
  );
}

// ======================================================
// SIMULATED TRADE
// ======================================================

function makeDemoOrder(
  signal,
  symbol,
  category,
  balance,
  riskPct,
  sizingMode,
  fixedLots,
  spreadInfo
) {
  if (!spreadInfo?.known) {
    throw new Error("Actual bid/ask spread unavailable. Trade rejected.");
  }

  if (spreadInfo.points > MAX_SPREAD_POINTS) {
    throw new Error(
      `Spread filter rejected trade: ${fmt(spreadInfo.points, 1)} points. Maximum ${MAX_SPREAD_POINTS}.`
    );
  }

  const buy = signal.direction === "BUY";
  const spread = spreadInfo.spread;

  // This remains a simulated MARKET execution.
  // signal.entryLevel is displayed as the strategy reference level.
  const entry = buy ? spreadInfo.ask : spreadInfo.bid;

  const stopReferenceHigh = signal.dojiHigh ?? signal.boxHigh;
  const stopReferenceLow = signal.dojiLow ?? signal.boxLow;

  const offset = signal.pip * SL_OFFSET_PIPS + spread;

  const sl = buy
    ? stopReferenceLow - offset
    : stopReferenceHigh + offset;

  const slDistance = Math.abs(entry - sl);

  if (!Number.isFinite(slDistance) || slDistance <= 0) {
    throw new Error("Invalid stop-loss distance.");
  }

  const tpDistance = signal.boxSize * TAKE_PROFIT_MULTIPLE;

  if (!Number.isFinite(tpDistance) || tpDistance <= 0) {
    throw new Error("Invalid Orange Box take-profit distance.");
  }

  const tp = buy
    ? entry + tpDistance
    : entry - tpDistance;

  const safeLots = Math.max(0, Number(fixedLots) || 0);
  const safeRiskPct = Math.max(0, Number(riskPct) || 0);

  const riskMoney = sizingMode === "FIXED_LOTS"
    ? balance * 0.01 * (safeLots / 0.10)
    : balance * safeRiskPct / 100;

  const createdAtMs = Date.now();
  const openedEpoch = Math.floor(createdAtMs / 1000);

  return {
    id: `${symbol}-${signal.signalId}-${createdAtMs}`,
    signalId: signal.signalId,
    comment: "Ifx Billionaire",
    boxId: signal.boxId,
    boxType: signal.boxType,
    strategy: signal.strategy,
    touchType: signal.touchType,
    candleTime: signal.candleTime,
    symbol,
    category,
    direction: signal.direction,
    source: `${signal.boxType} · ${signal.strategy}`,
    sizingMode,
    fixedLots: sizingMode === "FIXED_LOTS" ? safeLots : null,
    entry,
    signalEntryLevel: signal.entryLevel,
    sl,
    tp,
    slDistance,
    tpDistance,
    boxSize: signal.boxSize,
    spread,
    spreadPoints: spreadInfo.points,
    riskMoney,
    rewardRatio: tpDistance / slDistance,
    status: "OPEN DEMO TRADE",
    currentPrice: entry,
    floatingPnl: 0,
    fillPrice: entry,
    filledAt: new Date(createdAtMs).toLocaleTimeString(),
    created: new Date(createdAtMs).toLocaleTimeString(),
    createdAtMs,
    openedEpoch,
    openedDay: serverDay(openedEpoch)
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
  if (
    typeof window === "undefined" ||
    !("Notification" in window)
  ) return false;

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

// ======================================================
// CHART COMPONENT
// ======================================================

function TradingChart({ market }) {
  const candles = market?.chartCandles || [];
  const orangeBox = market?.orangeBox;
  const zones = market?.zones || [];
  const daily = market?.dailyCandles;

  const width = 900;
  const height = 390;
  const left = 58;
  const right = 20;
  const top = 20;
  const bottom = 40;

  const visible = candles.slice(-65);

  if (!visible.length) {
    return (
      <div style={{
        padding: 25,
        background: "#0b1525",
        borderRadius: 9,
        color: "#8395af",
        fontSize: 11,
        textAlign: "center"
      }}>
        Select a market with available M15 candles to view its chart.
      </div>
    );
  }

  const allPrices = visible.flatMap(c => [c.high, c.low]);

  zones.forEach(z => allPrices.push(z.high, z.low));

  if (orangeBox) {
    allPrices.push(orangeBox.high, orangeBox.low);
  }

  const maxPrice = Math.max(...allPrices);
  const minPrice = Math.min(...allPrices);
  const range = Math.max(maxPrice - minPrice, 0.00000001);
  const paddedMin = minPrice - range * 0.08;
  const paddedMax = maxPrice + range * 0.08;

  const chartHeight = height - top - bottom;
  const chartWidth = width - left - right;

  const y = price =>
    top + ((paddedMax - price) / (paddedMax - paddedMin)) * chartHeight;

  const slot = chartWidth / visible.length;
  const candleWidth = Math.max(3, Math.min(9, slot * 0.58));

  const x = index => left + index * slot + slot / 2;

  const startEpoch = visible[0].epoch;
  const endEpoch = visible[visible.length - 1].epoch + TIMEFRAME;

  const rectFor = (high, low, color, opacity, label) => {
    const yTop = y(high);
    const yBottom = y(low);

    return (
      <g key={label}>
        <rect
          x={left}
          y={yTop}
          width={chartWidth}
          height={Math.max(1, yBottom - yTop)}
          fill={color}
          opacity={opacity}
        />
        <line
          x1={left}
          x2={width - right}
          y1={yTop}
          y2={yTop}
          stroke={color}
          strokeWidth="1"
          strokeDasharray="5 4"
        />
        <line
          x1={left}
          x2={width - right}
          y1={yBottom}
          y2={yBottom}
          stroke={color}
          strokeWidth="1"
          strokeDasharray="5 4"
        />
        <text
          x={left + 5}
          y={Math.max(12, yTop - 4)}
          fill={color}
          fontSize="10"
        >
          {label}
        </text>
      </g>
    );
  };

  const boxStartVisible = orangeBox &&
    orangeBox.startEpoch <= endEpoch &&
    orangeBox.endEpoch >= startEpoch;

  return (
    <div style={{
      background: "#0b1525",
      border: "1px solid #24334b",
      borderRadius: 9,
      padding: 7,
      overflow: "hidden"
    }}>
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        padding: "7px 5px 12px",
        fontSize: 9,
        color: "#a8b7cb"
      }}>
        <span style={{ color: "#668cff" }}>■ ORANGE BOX</span>
        <span style={{ color: "#e5b34d" }}>■ DOJI</span>
        <span style={{ color: "#50b9ed" }}>■ ENGULFING</span>
        <span style={{ color: "#16c784" }}>■ GREEN</span>
        <span style={{ color: "#ea5455" }}>■ RED</span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          background: "#08111f"
        }}
      >
        {[0, 1, 2, 3, 4].map(i => {
          const yy = top + chartHeight * i / 4;
          const price = paddedMax - (paddedMax - paddedMin) * i / 4;

          return (
            <g key={i}>
              <line
                x1={left}
                x2={width - right}
                y1={yy}
                y2={yy}
                stroke="#1c2b40"
                strokeWidth="1"
              />
              <text
                x={left - 6}
                y={yy + 3}
                textAnchor="end"
                fill="#8293ad"
                fontSize="10"
              >
                {fmt(price, 5)}
              </text>
            </g>
          );
        })}

        {boxStartVisible && rectFor(
          orangeBox.high,
          orangeBox.low,
          "#526fd8",
          0.17,
          "ORANGE BOX"
        )}

        {zones.map(zone =>
          rectFor(
            zone.high,
            zone.low,
            zone.type === "DOJI" ? "#e5b34d" : "#50b9ed",
            0.14,
            `${zone.day === orangeBox?.day ? "TODAY" : "YESTERDAY"} ${zone.side} ${zone.type}`
          )
        )}

        {visible.map((c, i) => {
          const green = c.close >= c.open;
          const color = green ? "#16c784" : "#ea5455";

          const bodyTop = y(Math.max(c.open, c.close));
          const bodyBottom = y(Math.min(c.open, c.close));
          const bodyHeight = Math.max(1, bodyBottom - bodyTop);

          return (
            <g key={c.epoch}>
              <line
                x1={x(i)}
                x2={x(i)}
                y1={y(c.high)}
                y2={y(c.low)}
                stroke={color}
                strokeWidth="1.3"
              />
              <rect
                x={x(i) - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                fill={color}
              />
            </g>
          );
        })}

        {visible.map((c, i) => {
          if (i % 8 !== 0) return null;

          return (
            <text
              key={`time-${c.epoch}`}
              x={x(i)}
              y={height - 12}
              textAnchor="middle"
              fill="#8293ad"
              fontSize="9"
            >
              {new Date(c.epoch * 1000).toISOString().slice(11, 16)}
            </text>
          );
        })}
      </svg>

      <div style={{
        marginTop: 8,
        fontSize: 9,
        color: "#8395af",
        lineHeight: 1.6
      }}>
        Chart displays the latest 65 closed M15 candles. Box overlays
        are calculated from the available M15 history.
      </div>

      {daily && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginTop: 10
        }}>
          {[
            ["YESTERDAY", daily.yesterday],
            ["TODAY", daily.today]
          ].map(([label, d]) => (
            <div key={label} style={{
              background: "#101a2b",
              borderRadius: 7,
              padding: 9
            }}>
              <div style={{
                fontSize: 9,
                fontWeight: 900,
                color: "#a8b7cb"
              }}>
                {label} DAILY CANDLE
              </div>

              {d ? (
                <div style={{
                  fontSize: 9,
                  lineHeight: 1.7,
                  marginTop: 6,
                  color: "#dce8fb"
                }}>
                  O: {fmt(d.open, 5)}<br/>
                  H: {fmt(d.high, 5)}<br/>
                  L: {fmt(d.low, 5)}<br/>
                  C: {fmt(d.close, 5)}
                </div>
              ) : (
                <div style={{ fontSize: 9, marginTop: 6 }}>
                  Unavailable
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ======================================================
// APPLICATION
// ======================================================

export default function App() {
  const socketRef = useRef(null);
  const connectionPromiseRef = useRef(null);
  const requestRef = useRef(0);
  const pendingRequestsRef = useRef(new Map());

  const scanLockRef = useRef(false);
  const rescanRequestedRef = useRef(false);

  const runningRef = useRef(false);
  const scanTimerRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectingRef = useRef(false);

  const marketsRef = useRef([]);
  const activationLocksRef = useRef(new Set());
  const subscriptionsRef = useRef(new Map());
  const subscribingRef = useRef(new Set());

  const latestPricesRef = useRef({});
  const latestTicksRef = useRef({});
  const ordersRef = useRef([]);
  const closedTradesRef = useRef([]);

  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [connectionText, setConnectionText] = useState("DISCONNECTED");

  const [symbols, setSymbols] = useState([]);
  const [signals, setSignals] = useState({});
  const [scannerStates, setScannerStates] = useState({});
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
  const [clock, setClock] = useState(Math.floor(Date.now() / 1000));

  const [notificationPermission, setNotificationPermission] = useState(
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported"
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(Math.floor(Date.now() / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

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

  // DERIV REQUESTS

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
      }, 12000);

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

  // LIVE SIMULATED TRADE MONITORING

  const processTick = useCallback((symbol, tick) => {
    if (!symbol || !tick) return;

    const quote = Number(tick.quote);
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);

    const usablePrice = Number.isFinite(bid) && bid > 0
      ? bid
      : quote;

    if (!Number.isFinite(usablePrice)) return;

    latestPricesRef.current[symbol] = usablePrice;

    latestTicksRef.current[symbol] = {
      quote,
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
      ask: Number.isFinite(ask) && ask > 0 ? ask : null,
      epoch: Number(tick.epoch) || Math.floor(Date.now() / 1000)
    };

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
        currentPrice: usablePrice
      };

      const exitReason = getExitReason(trade, usablePrice);

      if (exitReason) {
        const exitPrice = getExitPrice(
          trade,
          exitReason,
          usablePrice
        );

        const finalPnl = calculateDemoPnl(trade, exitPrice);

        newlyClosed.push({
          ...trade,
          status: "CLOSED",
          exitPrice,
          observedExitPrice: usablePrice,
          exitReason,
          realisedPnl: finalPnl,
          floatingPnl: 0,
          closedAt: new Date().toLocaleTimeString()
        });

        continue;
      }

      trade.floatingPnl = calculateDemoPnl(trade, usablePrice);
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

  // RECONNECTION

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
          processTick(data.tick.symbol, data.tick);
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
          setMessage(
            "Deriv connection lost. Robot will attempt to reconnect."
          );
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

  // MARKET SUBSCRIPTION

  const subscribeMarket = useCallback(async symbol => {
    if (subscriptionsRef.current.has(symbol)) return true;
    if (subscribingRef.current.has(symbol)) return false;

    if (
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN
    ) return false;

    subscribingRef.current.add(symbol);

    try {
      const response = await request({
        ticks: symbol,
        subscribe: 1
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const subscriptionId =
        response.subscription?.id || "SUBSCRIBED";

      subscriptionsRef.current.set(symbol, subscriptionId);

      if (response.tick) {
        processTick(response.tick.symbol || symbol, response.tick);
      }

      return true;
    } catch (error) {
      setMessage(`${symbol}: subscription failed: ${error.message}`);
      return false;
    } finally {
      subscribingRef.current.delete(symbol);
    }
  }, [request, processTick]);

  // MARKET DISCOVERY

  const discoverMarkets = useCallback(async () => {
    setMessage("Requesting active markets from Deriv...");

    const response = await request({ active_symbols: "full" });

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
        category: categoryOf(s),
        prioritySymbol: priorityMatch(s.symbol),
        priority: priorityIndex(s.symbol)
      }))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return String(a.display_name).localeCompare(String(b.display_name));
      });

    marketsRef.current = list;
    setSymbols(list);

    const foundPriorities = new Set(
      list.map(item => item.prioritySymbol).filter(Boolean)
    );

    const missing = PRIORITY_SYMBOLS.filter(
      symbol => !foundPriorities.has(symbol)
    );

    setMessage(
      `${list.length} Deriv markets discovered. ${foundPriorities.size}/21 priority instruments matched.${missing.length ? ` Not found: ${missing.join(", ")}` : ""}`
    );

    return list;
  }, [request]);

  // M15 SCAN

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

      const liveCandles = candles.filter(c =>
        c.epoch + TIMEFRAME > now
      );

      const liveCandle = liveCandles[liveCandles.length - 1] || null;

      diagnostic.closed = closed.length;

      if (closed.length) {
        diagnostic.latestEpoch = closed[closed.length - 1].epoch;
      }

      const signal = findClosedEntrySignal(
        closed,
        item.symbol,
        item.category,
        item.pip
      );

      const currentClosed = closed[closed.length - 1];
      const today = serverDay(now);
      const yesterday = previousDay(today);

      const orangeBox = buildOrangeBox(closed, today);
      const yesterdayOrange = buildOrangeBox(closed, yesterday);

      const pip = pipSize(
        item.symbol,
        item.category,
        candles,
        item.pip
      );

      const zones = buildDojiZones(
        closed,
        orangeBox,
        yesterdayOrange,
        pip
      );

      const tick = latestTicksRef.current[item.symbol];

      const livePrice = Number.isFinite(tick?.bid)
        ? tick.bid
        : Number.isFinite(tick?.quote)
          ? tick.quote
          : liveCandle?.close ?? currentClosed?.close ?? null;

      const scanner = getLiveScannerState({
        candles: closed,
        liveCandle,
        price: livePrice,
        orangeBox,
        zones,
        pip
      });

      const dailyCandles = buildDailyCandles(candles, today);
      const spreadInfo = getSpreadInfo(tick, livePrice);

      return {
        ...signal,
        scannerState: scanner.state,
        scannerProximity: scanner.proximity,
        scannerDistance: scanner.distance,
        scannerRsi: scanner.rsi ?? null,
        livePrice,
        spreadKnown: spreadInfo.known,
        spreadPoints: spreadInfo.points,
        spread: spreadInfo.spread,
        orangeBox,
        yesterdayOrange,
        zones,
        dailyCandles,
        liveCandle,
        chartCandles: closed,
        latestClosedEpoch: currentClosed?.epoch ?? null,
        _candleData: diagnostic
      };

    } catch (error) {
      diagnostic.error = error.message || "Unknown Deriv API error";

      return {
        direction: "NONE",
        reason: "Market data unavailable",
        boxCount: 0,
        scannerState: "DATA ERROR",
        scannerProximity: Infinity,
        _candleData: diagnostic
      };
    }
  }, [request]);

  // SCAN ALL MARKETS

  const scanAll = useCallback(async list => {
    if (!runningRef.current || !list?.length) return;

    if (scanLockRef.current) {
      rescanRequestedRef.current = true;
      return;
    }

    scanLockRef.current = true;

    setMessage(
      "Scanning priority instruments first, then remaining Deriv markets..."
    );

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

        if (completed % 5 === 0) {
          setSignals(previous => ({
            ...previous,
            ...results
          }));

          setScannerStates(previous => ({
            ...previous,
            ...Object.fromEntries(
              Object.entries(results).map(([symbol, value]) => [
                symbol,
                {
                  state: value.scannerState,
                  proximity: value.scannerProximity,
                  livePrice: value.livePrice,
                  spreadKnown: value.spreadKnown,
                  spreadPoints: value.spreadPoints
                }
              ])
            )
          }));
        }
      }
    };

    try {
      await Promise.all([
        worker(),
        worker(),
        worker(),
        worker()
      ]);

      setSignals(previous => ({
        ...previous,
        ...results
      }));

      setScannerStates(previous => ({
        ...previous,
        ...Object.fromEntries(
          Object.entries(results).map(([symbol, value]) => [
            symbol,
            {
              state: value.scannerState,
              proximity: value.scannerProximity,
              livePrice: value.livePrice,
              spreadKnown: value.spreadKnown,
              spreadPoints: value.spreadPoints
            }
          ])
        )
      }));

      setMessage(
        runningRef.current
          ? `Scan complete: ${completed} of ${list.length} markets checked.`
          : "Scanning stopped."
      );

      setLastScan(new Date().toLocaleTimeString());

    } finally {
      scanLockRef.current = false;

      if (rescanRequestedRef.current && runningRef.current) {
        rescanRequestedRef.current = false;

        setTimeout(() => {
          if (runningRef.current) scanAll(marketsRef.current);
        }, 0);
      }
    }
  }, [scanSymbol]);

  // START ROBOT

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
      setScannerStates({});
      setScanned(0);
      setProgress(0);

      const list = await discoverMarkets();

      if (!list.length) {
        setMessage("No active markets returned by Deriv.");
        runningRef.current = false;
        setRunning(false);
        return;
      }

      const priorityMarkets = list.filter(item => item.prioritySymbol);

      for (const item of priorityMarkets) {
        if (!runningRef.current) break;
        await subscribeMarket(item.symbol);
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
      }, SCAN_INTERVAL);

      setMessage(
        "Robot running. Scanner checks every 10 seconds. Entries require a completed M15 candle."
      );

    } catch (error) {
      runningRef.current = false;
      setRunning(false);
      setMessage(error.message);
    }
  };

  // STOP ROBOT

  const stopRobot = () => {
    runningRef.current = false;
    setRunning(false);

    rescanRequestedRef.current = false;

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

  // MANUAL TAP TO ENTER

  const activateSignal = async item => {
    const signal = signals[item.symbol];

    if (!signal || signal.direction === "NONE") return;

    if (!signal.signalId || !signal.boxId) {
      setMessage("Signal is missing its box or signal identifier.");
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    if (!isTradingTime(now)) {
      setMessage("Trading is paused. Allowed hours are 07:00–21:59 UTC.");
      return;
    }

    const lockKey = `${item.symbol}|${signal.signalId}`;

    if (activationLocksRef.current.has(lockKey)) {
      setMessage(`${item.symbol}: this signal is already processing.`);
      return;
    }

    activationLocksRef.current.add(lockKey);

    try {
      const previousTrades = [
        ...ordersRef.current,
        ...closedTradesRef.current
      ];

      const today = serverDay(now);

      const dailyTrades = previousTrades.filter(trade =>
        trade.openedDay === today
      );

      const openCount = ordersRef.current.filter(trade =>
        trade.status === "OPEN DEMO TRADE"
      ).length;

      if (dailyTrades.length >= MAX_DAILY_TRADES) {
        setMessage(`Daily limit reached: maximum ${MAX_DAILY_TRADES} trades.`);
        return;
      }

      if (openCount >= MAX_OPEN_TRADES) {
        setMessage(`Open-trade limit reached: maximum ${MAX_OPEN_TRADES}.`);
        return;
      }

      if (alreadyExecuted(previousTrades, signal, item.symbol)) {
        setMessage(`${item.symbol}: this signal has already been traded.`);
        return;
      }

      const subscribed = await subscribeMarket(item.symbol);

      if (!subscribed) {
        setMessage(`${item.symbol}: could not obtain live market data.`);
        return;
      }

      const tick = latestTicksRef.current[item.symbol];

      const currentPrice = Number.isFinite(tick?.bid)
        ? tick.bid
        : tick?.quote;

      if (!Number.isFinite(currentPrice)) {
        setMessage(`${item.symbol}: waiting for a live price.`);
        return;
      }

      const spreadInfo = getSpreadInfo(tick, currentPrice);

      if (!spreadInfo.known) {
        setMessage(
          `${item.symbol}: actual bid/ask spread unavailable. Trade rejected.`
        );
        return;
      }

      if (spreadInfo.points > MAX_SPREAD_POINTS) {
        setMessage(
          `${item.symbol}: spread ${fmt(spreadInfo.points, 1)} points exceeds the 300-point limit.`
        );
        return;
      }

      const latestTrades = [
        ...ordersRef.current,
        ...closedTradesRef.current
      ];

      if (alreadyExecuted(latestTrades, signal, item.symbol)) {
        setMessage("This signal has already been traded.");
        return;
      }

      const latestDailyTrades = latestTrades.filter(trade =>
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

      const order = makeDemoOrder(
        signal,
        item.symbol,
        item.category,
        balance,
        riskPct,
        sizingMode,
        fixedLots,
        spreadInfo
      );

      updateOrders(previous => [order, ...previous]);

      setSelected(item);

      setLastActivated(
        `${signal.direction} · ${signal.strategy} · M15`
      );

      setMessage(
        `${item.symbol}: ${signal.direction} simulated market trade opened at ${fmt(order.entry, 8)}.`
      );

      sendBrowserNotification(
        "iFX BILLIONAIRE — Demo Trade Opened",
        `${item.symbol} ${signal.direction} ${signal.strategy} at ${fmt(order.entry, 8)}`
      );

    } catch (error) {
      setMessage(`${item.symbol}: ${error.message}`);
    } finally {
      activationLocksRef.current.delete(lockKey);
    }
  };

  // AUTOMATIC RECONNECTION

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

        const prioritySymbols = [
          ...new Set(
            marketsRef.current
              .filter(item => item.prioritySymbol)
              .map(item => item.symbol)
          )
        ];

        for (const symbol of [
          ...new Set([...prioritySymbols, ...openSymbols])
        ]) {
          if (!runningRef.current) break;
          await subscribeMarket(symbol);
        }

        if (!runningRef.current) return;

        let list = marketsRef.current;

        if (!list.length) {
          list = await discoverMarkets();
        }

        if (runningRef.current && list.length) {
          setMessage("Connection restored. Resuming 10-second scans...");
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
  }, [
    connect,
    scanAll,
    subscribeMarket,
    discoverMarkets,
    scheduleReconnect
  ]);

  useEffect(() => {
    return () => {
      runningRef.current = false;

      if (scanTimerRef.current) {
        clearInterval(scanTimerRef.current);
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
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

  // DASHBOARD CALCULATIONS

  const visibleSymbols = symbols
    .filter(item => {
      const signal = signals[item.symbol];

      const hasSignal =
        signal?.direction === "BUY" ||
        signal?.direction === "SELL";

      const matchesCategory =
        category === "All" || item.category === category;

      const term = search.toLowerCase();

      const matchesSearch =
        !term ||
        String(item.display_name || "").toLowerCase().includes(term) ||
        String(item.symbol || "").toLowerCase().includes(term);

      return hasSignal && matchesCategory && matchesSearch;
    })
    .sort((a, b) => {
      const aSignal = signals[a.symbol];
      const bSignal = signals[b.symbol];

      if (a.priority !== b.priority) return a.priority - b.priority;

      return (
        (aSignal?.scannerProximity ?? Infinity) -
        (bSignal?.scannerProximity ?? Infinity)
      );
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

  const today = serverDay(clock);
  const tradingActive = isTradingTime(clock);

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
    value > 0 ? "#16c784" :
    value < 0 ? "#ea5455" : "#eef4ff";

  const signalColor = direction =>
    direction === "BUY" ? "#16c784" :
    direction === "SELL" ? "#ea5455" : "#8993a4";

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
    letterSpacing: 0.7
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

  const priorityFound = new Set(
    symbols.map(item => item.prioritySymbol).filter(Boolean)
  );

  const selectedMarket = selected
    ? signals[selected.symbol]
    : null;

  const selectedItem = selected
    ? symbols.find(s => s.symbol === selected.symbol)
    : null;

  const zonesForDisplay = selectedMarket?.zones || [];

  const insideOrangeMarkets = symbols
    .filter(item => signals[item.symbol]?.scannerState === "INSIDE ORANGE BOX")
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (
        (signals[a.symbol]?.scannerProximity ?? Infinity) -
        (signals[b.symbol]?.scannerProximity ?? Infinity)
      );
    });

  const insideDojiMarkets = symbols
    .filter(item =>
      String(signals[item.symbol]?.scannerState || "").includes("TOUCH")
    );

  const extremeMarkets = symbols
    .filter(item => signals[item.symbol]?.scannerState === "OUTSIDE RSI EXTREME");

  // UI

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
          display:flex;
          gap:7px;
          overflow-x:auto;
          padding:4px 0 10px;
          scrollbar-width:none;
        }
        .market-scroll::-webkit-scrollbar { display:none; }
        .market-card { transition:transform .12s ease; }
        .market-card:active { transform:scale(.99); }
        .trade-entry-button:disabled {
          opacity:.45;
          cursor:not-allowed;
        }
        input:focus, select:focus { outline:1px solid #31a8ff; }
        details > summary::-webkit-details-marker { display:none; }
        details > summary::after {
          content:"＋";
          color:#55c9ff;
          font-size:16px;
          margin-left:auto;
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
            letterSpacing: 1.2
          }}>
            M15 · ORANGE BOX · DOJI · ENGULFING
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

        {/* ROBOT CONTROL */}

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
                opacity: running ? 0.5 : 1
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
            {" · "}
            Every 10 seconds
          </div>

          <div style={small}>
            Priority instruments matched: {priorityFound.size}/21
            {" · "}
            M15 only · UTC server time: {serverTime(clock)}
          </div>

          <div style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            background: tradingActive ? "#123e30" : "#38252a",
            color: tradingActive ? "#25d99a" : "#ff9ba2",
            fontSize: 11,
            fontWeight: 900
          }}>
            TRADING HOURS: {tradingActive ? "ACTIVE" : "PAUSED"}
            {" · "}
            07:00–21:59 UTC
          </div>
        </section>

        {/* STATISTICS */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            ROBOT STATISTICS
          </summary>

          <section style={{
            display: "grid",
            gridTemplateColumns: "repeat(2,minmax(0,1fr))",
            gap: 8,
            marginTop: 13
          }}>
            <div style={stat}>
              <div style={statLabel}>MARKETS FOUND</div>
              <div style={statValue}>{symbols.length}</div>
            </div>

            <div style={stat}>
              <div style={statLabel}>BUY SIGNALS</div>
              <div style={{ ...statValue, color: "#16c784" }}>
                {buyCount}
              </div>
            </div>

            <div style={stat}>
              <div style={statLabel}>SELL SIGNALS</div>
              <div style={{ ...statValue, color: "#ea5455" }}>
                {sellCount}
              </div>
            </div>

            <div style={stat}>
              <div style={statLabel}>OPEN DEMO TRADES</div>
              <div style={statValue}>{openTrades.length}/4</div>
            </div>

            <div style={stat}>
              <div style={statLabel}>TODAY'S TRADES · UTC</div>
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
        </details>

        {/* CHART */}

        <details open style={card}>
          <summary style={collapsibleSummary}>
            M15 CHART · BOX VISUALISATION
          </summary>

          <div style={small}>
            {selectedItem
              ? `${selectedItem.display_name || selectedItem.symbol} · ${selectedItem.symbol}`
              : "Choose a market from the signal list to view its chart."}
          </div>

          <TradingChart market={selectedMarket}/>
        </details>

        {/* SCANNER GROUPS */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            BACKGROUND SCANNER
          </summary>

          <div style={small}>
            Scanner categories refresh every 10 seconds.
          </div>

          <div style={orderCard}>
            <strong style={{ color: "#668cff", fontSize: 10 }}>
              INSIDE ORANGE BOX · {insideOrangeMarkets.length}
            </strong>

            {insideOrangeMarkets.slice(0, 15).map(item => (
              <div key={item.symbol} style={small}>
                {item.prioritySymbol ? "★ " : ""}
                {item.symbol}
                {" · "}
                {fmt(signals[item.symbol]?.livePrice, 5)}
              </div>
            ))}

            {!insideOrangeMarkets.length && (
              <div style={small}>No markets currently inside Orange Box.</div>
            )}
          </div>

          <div style={orderCard}>
            <strong style={{ color: "#e5b34d", fontSize: 10 }}>
              INSIDE DOJI / ENGULFING BOX · {insideDojiMarkets.length}
            </strong>

            {insideDojiMarkets.slice(0, 15).map(item => (
              <div key={item.symbol} style={small}>
                {item.symbol}
                {" · "}
                {signals[item.symbol]?.scannerState}
              </div>
            ))}

            {!insideDojiMarkets.length && (
              <div style={small}>No active Doji/Engulfing touches.</div>
            )}
          </div>

          <div style={orderCard}>
            <strong style={{ color: "#ea5455", fontSize: 10 }}>
              OUTSIDE ORANGE · RSI 90/10 · {extremeMarkets.length}
            </strong>

            {extremeMarkets.slice(0, 15).map(item => (
              <div key={item.symbol} style={small}>
                {item.symbol}
                {" · "}
                RSI {fmt(signals[item.symbol]?.scannerRsi, 1)}
                {" · "}
                {signals[item.symbol]?.scannerState}
              </div>
            ))}

            {!extremeMarkets.length && (
              <div style={small}>No outside RSI extremes currently detected.</div>
            )}
          </div>
        </details>

        {/* VALID ENTRY SIGNALS */}

        <details open style={card}>
          <summary style={collapsibleSummary}>
            VALID M15 BUY / SELL SIGNALS
          </summary>

          <div style={small}>
            Only valid signals from completed M15 candles are displayed.
            Tap BUY or SELL to open a simulated demo market trade manually.
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

          {symbols.length > 0 && scanned > 0 &&
            visibleSymbols.length === 0 && (
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
                No valid closed M15 BUY or SELL entry signals.
                <br/>
                Markets without valid entry signals are hidden.
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
                openTrades.length >= MAX_OPEN_TRADES ||
                !tradingActive;

              const isBuy = signal.direction === "BUY";

              return (
                <div
                  key={item.symbol}
                  className="market-card"
                  onClick={() => setSelected(item)}
                  style={{
                    width: "100%",
                    background: "#0b1525",
                    border: `1px solid ${
                      isSelected ? "#31a8ff" : "#24334b"
                    }`,
                    borderRadius: 9,
                    padding: 12,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    color: "#edf4ff"
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: 12,
                      fontWeight: 800
                    }}>
                      {item.display_name || item.symbol}
                    </div>

                    <div style={small}>
                      {item.symbol}
                      {" · "}
                      {item.category}
                      {" · M15"}
                      {item.prioritySymbol
                        ? ` · PRIORITY ${item.prioritySymbol}`
                        : ""}
                    </div>

                    <div style={{
                      fontSize: 9,
                      color: "#f4c46a",
                      marginTop: 7,
                      fontWeight: 900
                    }}>
                      {signal.strategy}
                    </div>

                    <div style={{
                      fontSize: 9,
                      color: "#a9c9e9",
                      marginTop: 5
                    }}>
                      {signal.reason}
                    </div>

                    <div style={{
                      fontSize: 9,
                      color: "#a9c9e9",
                      marginTop: 5
                    }}>
                      ORANGE HIGH {fmt(signal.boxHigh, 8)}
                      {" · "}
                      LOW {fmt(signal.boxLow, 8)}
                    </div>

                    {signal.entryLevel !== undefined && (
                      <div style={{
                        fontSize: 9,
                        color: "#f4c46a",
                        marginTop: 5
                      }}>
                        STRATEGY ENTRY LEVEL: {fmt(signal.entryLevel, 8)}
                      </div>
                    )}

                    {signal.dojiHigh !== null && (
                      <div style={{
                        fontSize: 9,
                        color: "#f4c46a",
                        marginTop: 5
                      }}>
                        ZONE HIGH {fmt(signal.dojiHigh, 8)}
                        {" · "}
                        LOW {fmt(signal.dojiLow, 8)}
                      </div>
                    )}

                    <div style={small}>
                      RSI(3): {fmt(signal.rsi, 1)}
                      {" · "}
                      Spread: {signal.spreadKnown
                        ? `${fmt(signal.spreadPoints, 1)} points`
                        : "Unavailable"}
                    </div>

                    {hasOrder && (
                      <div style={{
                        fontSize: 9,
                        color: "#f4c46a",
                        marginTop: 7
                      }}>
                        THIS SIGNAL ALREADY TRADED
                      </div>
                    )}

                    {!tradingActive && (
                      <div style={{
                        fontSize: 9,
                        color: "#ff7a82",
                        marginTop: 7
                      }}>
                        TRADING PAUSED · 07:00–21:59 UTC
                      </div>
                    )}

                    <button
                      type="button"
                      className="trade-entry-button"
                      disabled={limitReached || hasOrder}
                      onClick={e => {
                        e.stopPropagation();
                        activateSignal(item);
                      }}
                      style={{
                        width: "100%",
                        marginTop: 12,
                        padding: "13px 10px",
                        border: 0,
                        borderRadius: 7,
                        background: isBuy ? "#16a36f" : "#c83e4d",
                        color: "#ffffff",
                        fontSize: 12,
                        fontWeight: 900,
                        letterSpacing: 0.6,
                        opacity: limitReached || hasOrder ? 0.45 : 1
                      }}
                    >
                      {isBuy
                        ? "▲ TAP BUY — OPEN DEMO TRADE"
                        : "▼ TAP SELL — OPEN DEMO TRADE"}
                    </button>
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
                </div>
              );
            })}
          </div>
        </details>

        {/* STRATEGY RULES */}

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
            <b style={{ color: "#668cff" }}>TRADING HOURS</b>
            <br/>
            • UTC server time.
            <br/>
            • New entries allowed from 07:00 to 21:59.
            <br/>
            • Trading pauses at 22:00.
            <br/>
            • Existing simulated trades continue to be monitored.
            <br/><br/>

            <b style={{ color: "#668cff" }}>ORANGE BOX</b>
            <br/>
            • First four M15 candles from 00:00–01:00 UTC.
            <br/>
            • High = highest high of the four candles.
            <br/>
            • Low = lowest low of the four candles.
            <br/>
            • Midnight-blue filled rectangle.
            <br/>
            • Resets each UTC day.
            <br/><br/>

            <b style={{ color: "#e5b34d" }}>DOJI / ENGULFING BOXES</b>
            <br/>
            • Today's Above: candle low above Orange High.
            <br/>
            • Today's Below: candle high below Orange Low.
            <br/>
            • Yesterday's Above: candle low above yesterday's Orange High.
            <br/>
            • Yesterday's Below: candle high below yesterday's Orange Low.
            <br/>
            • Doji body ≤20% of candle range.
            <br/>
            • Engulfing candle must cover previous opposite body.
            <br/>
            • Today's zones arm after a close 3 pips beyond the zone within six candles.
            <br/>
            • Yesterday's zones are armed by default.
            <br/>
            • Second distinct candle touch deletes the zone.
            <br/><br/>

            <b style={{ color: "#65aaff" }}>ORANGE RETEST</b>
            <br/>
            • Open above + RED + wick into box + close above = BUY at Box High.
            <br/>
            • Open below + GREEN + wick into box + close below = SELL at Box Low.
            <br/><br/>

            <b style={{ color: "#65aaff" }}>ORANGE BREAK-IN</b>
            <br/>
            • Open above + RED + close inside = SELL at Box Low − 1 pip.
            <br/>
            • Open below + GREEN + close inside = BUY at Box High + 1 pip.
            <br/><br/>

            <b style={{ color: "#65aaff" }}>DOJI / ENGULFING RETEST</b>
            <br/>
            • Same retest rules as Orange Box, using zone High and Low.
            <br/><br/>

            <b style={{ color: "#65aaff" }}>DOJI / ENGULFING BREAK-IN</b>
            <br/>
            • Open above + RED + close inside = SELL at zone Low − 1 pip.
            <br/>
            • Open below + GREEN + close inside = BUY at zone High + 1 pip.
            <br/><br/>

            <b style={{ color: "#f4c46a" }}>DOJI / ENGULFING FADE</b>
            <br/>
            • Armed zone with exactly one touch.
            <br/>
            • First touch GREEN candle = SELL at zone High.
            <br/>
            • First touch RED candle = BUY at zone Low.
            <br/>
            • Second touch deletes the zone.
            <br/><br/>

            <b style={{ color: "#f4c46a" }}>RISK MANAGEMENT</b>
            <br/>
            • SL offset: 15 pips + spread.
            <br/>
            • TP distance: Orange Box size × 4.
            <br/>
            • Maximum spread: 300 points.
            <br/>
            • Maximum four open trades.
            <br/>
            • Maximum four trades per UTC day.
            <br/>
            • Manual tap required for every entry.
            <br/>
            • No automatic trade execution.
          </div>
        </details>

        {/* TRADE SETTINGS */}

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
                onChange={e => setBalance(
                  Math.max(0, Number(e.target.value))
                )}
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
            SCAN FREQUENCY: 10 SECONDS.
            <br/>
            SERVER DAY RESET: 00:00 UTC.
            <br/>
            ORANGE BOX: 00:00–01:00 UTC.
            <br/>
            TRADING HOURS: 07:00–22:00 UTC.
            <br/>
            STOP LOSS OFFSET: 15 PIPS + SPREAD.
            <br/>
            TAKE PROFIT: ORANGE BOX SIZE × 4.
            <br/>
            MAXIMUM SPREAD: 300 POINTS.
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
              SIMULATION NOTE: Fixed lots scale simulated P&L
              using a 0.10-lot baseline. This is not the actual
              contract valuation used by a broker.
            </div>
          )}
        </details>

        {/* PRIORITY INSTRUMENTS */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            PRIORITY INSTRUMENTS · {priorityFound.size}/21 MATCHED
          </summary>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(2,minmax(0,1fr))",
            gap: 7,
            marginTop: 13
          }}>
            {PRIORITY_SYMBOLS.map(symbol => {
              const found = priorityFound.has(symbol);

              return (
                <div
                  key={symbol}
                  style={{
                    background: "#0b1525",
                    border: "1px solid #24334b",
                    borderRadius: 7,
                    padding: 9,
                    fontSize: 10,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 5
                  }}
                >
                  <strong>{symbol}</strong>

                  <span style={{
                    color: found ? "#16c784" : "#f4c46a"
                  }}>
                    {found ? "MATCHED" : "NOT FOUND"}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={small}>
            Matching ignores broker prefixes and suffixes where the
            canonical instrument code appears in the Deriv symbol.
            Instruments not listed by Deriv cannot be scanned.
          </div>
        </details>

        {/* DAILY REFERENCE CANDLES */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            DAILY REFERENCE CANDLES
          </summary>

          <div style={small}>
            Yesterday and today OHLC are aggregated from M15 candles.
          </div>

          {selectedMarket?.dailyCandles && (
            <>
              {[
                {
                  label: "YESTERDAY",
                  candle: selectedMarket.dailyCandles.yesterday
                },
                {
                  label: "TODAY",
                  candle: selectedMarket.dailyCandles.today
                }
              ].map(item => (
                <div key={item.label} style={orderCard}>
                  <strong>{item.label}</strong>

                  {item.candle ? (
                    <div style={orderGrid}>
                      <div>
                        OPEN
                        <b style={{ display: "block", color: "white" }}>
                          {fmt(item.candle.open, 8)}
                        </b>
                      </div>

                      <div>
                        CLOSE
                        <b style={{ display: "block", color: "white" }}>
                          {fmt(item.candle.close, 8)}
                        </b>
                      </div>

                      <div>
                        HIGH
                        <b style={{ display: "block", color: "white" }}>
                          {fmt(item.candle.high, 8)}
                        </b>
                      </div>

                      <div>
                        LOW
                        <b style={{ display: "block", color: "white" }}>
                          {fmt(item.candle.low, 8)}
                        </b>
                      </div>
                    </div>
                  ) : (
                    <div style={small}>Daily candle unavailable.</div>
                  )}
                </div>
              ))}
            </>
          )}

          {!selectedMarket && (
            <div style={small}>
              Select a market with an entry signal to view its daily reference candles.
            </div>
          )}
        </details>

        {/* BROKER CONNECTION */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            BROKER CONNECTION
          </summary>

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
            This version uses Deriv public market data and simulated
            demo trades only. It does not connect to a Deriv account,
            another broker, or a live trading account.
            <br/><br/>
            Spread validation requires bid and ask values from the
            feed. If those values are unavailable, manual trade
            activation is rejected rather than assuming a zero spread.
            <br/><br/>
            The app does not create broker pending orders. Manual
            simulated trades are opened at the current bid/ask.
          </div>
        </details>

        {/* OPEN TRADES */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            OPEN DEMO TRADES · {openTrades.length}
          </summary>

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
                {trade.strategy} · {trade.status}
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
                  STRATEGY LEVEL
                  <b style={{ display: "block", color: "white" }}>
                    {fmt(trade.signalEntryLevel, 8)}
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
                  SPREAD
                  <b style={{ display: "block", color: "white" }}>
                    {fmt(trade.spreadPoints, 1)} points
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
                    {fmt(trade.rewardRatio, 2)}R
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
        </details>

        {/* CLOSED TRADES */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            CLOSED DEMO TRADES · {closedTrades.length}
          </summary>

          <div style={small}>
            Results after SL, TP or robot stop
          </div>

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
                <strong>
                  {trade.symbol} · {trade.direction}
                </strong>

                <strong style={{ color: moneyColor(trade.realisedPnl) }}>
                  {trade.realisedPnl >= 0 ? "+" : ""}
                  ${fmt(trade.realisedPnl, 2)}
                </strong>
              </div>

              <div style={small}>
                {trade.exitReason} · Closed {trade.closedAt}
              </div>

              <div style={small}>
                {trade.strategy} · M15
              </div>

              <div style={small}>
                Entry: {fmt(trade.entry, 8)}
                {" · "}
                Exit: {fmt(trade.exitPrice, 8)}
              </div>
            </div>
          ))}
        </details>

        {/* LAST ACTIVATED */}

        <details style={card}>
          <summary style={collapsibleSummary}>
            LAST ACTIVATED
          </summary>

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

          <div style={small}>
            Last scan: {lastScan}
          </div>
        </details>

        <footer style={{
          textAlign: "center",
          padding: "16px 5px 28px",
          color: "#647893",
          fontSize: 9,
          letterSpacing: 1.2,
          lineHeight: 1.8
        }}>
          iFX BILLIONAIRE ROBOT
          <br/>
          M15 ORANGE BOX · DOJI · ENGULFING
          <br/>
          RETEST · BREAK-IN · FIRST TOUCH FADE
          <br/>
          UTC SERVER DAY · MANUAL SIMULATED EXECUTION
          <br/>
          07:00–22:00 UTC · SCAN EVERY 10 SECONDS
          <br/>
          MAX 4 DAILY · MAX 4 OPEN
        </footer>

      </main>
    </div>
  );
}