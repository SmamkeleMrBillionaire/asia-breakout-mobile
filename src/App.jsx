import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

// Deriv connections
const APP_ID = "34Snkab6STNb2JNY3zRZp";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const DERIV_REST_URL = "https://api.derivws.com";

const TIMEFRAME = 900;
const CANDLE_COUNT = 220;
const SCAN_INTERVAL = 30000;

const TRADING_START_HOUR = 7;
const TRADING_END_HOUR = 22;

const ARM_DISTANCE_PIPS = 3;
const ARM_CANDLE_LIMIT = 6;
const SL_OFFSET_PIPS = 15;
const TAKE_PROFIT_MULTIPLE = 4;

const MAX_SPREAD_POINTS = 300;
const MAX_DAILY_TRADES = 4;
const MAX_OPEN_TRADES = 4;

const CONNECTION_TIMEOUT = 15000;
const REQUEST_TIMEOUT = 20000;
const RECONNECT_DELAY = 5000;

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

const candleColor = c =>
  c.close > c.open ? "GREEN" :
  c.close < c.open ? "RED" : "NEUTRAL";

const normalizeSymbol = symbol =>
  String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function priorityMatch(symbol) {
  const n = normalizeSymbol(symbol);
  return PRIORITY_SYMBOLS.find(p => n.includes(p)) || null;
}

function priorityIndex(symbol) {
  const m = priorityMatch(symbol);
  return m ? PRIORITY_SYMBOLS.indexOf(m) : 999;
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
    name.includes("bitcoin") ||
    name.includes("ethereum") ||
    type.includes("crypt")
  ) return "Crypto";

  if (
    market.includes("stock") ||
    sub.includes("stock") ||
    type.includes("stock")
  ) return "Stocks";

  if (
    market.includes("index") ||
    sub.includes("index") ||
    type.includes("index")
  ) return "Indices";

  if (
    market.includes("commodit") ||
    sub.includes("metal") ||
    name.includes("gold") ||
    name.includes("silver")
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
  const d = (String(price).split(".")[1] || "").length;
  return Math.pow(10, -Math.min(d, 10));
}

function candleBody(c) {
  return {
    high: Math.max(c.open, c.close),
    low: Math.min(c.open, c.close)
  };
}

function isDoji(c) {
  const r = c.high - c.low;
  if (r <= 0) return false;

  return Math.abs(c.close - c.open) <= r * 0.20;
}

function isEngulfing(cur, prev) {
  if (!cur || !prev) return false;

  const a = candleColor(cur);
  const b = candleColor(prev);

  if (a === "NEUTRAL" || b === "NEUTRAL" || a === b) {
    return false;
  }

  const cb = candleBody(cur);
  const pb = candleBody(prev);

  return cb.high >= pb.high && cb.low <= pb.low;
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
  const h = serverHour(epoch);
  return h >= TRADING_START_HOUR && h < TRADING_END_HOUR;
}

function calculateRSI(candles, index, period = 3) {
  if (!candles || index < period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const ch = candles[i].close - candles[i - 1].close;

    if (ch > 0) gains += ch;
    if (ch < 0) losses += Math.abs(ch);
  }

  let ag = gains / period;
  let al = losses / period;

  for (let i = period + 1; i <= index; i++) {
    const ch = candles[i].close - candles[i - 1].close;

    ag = (ag * (period - 1) + Math.max(ch, 0)) / period;
    al = (al * (period - 1) + Math.max(-ch, 0)) / period;
  }

  if (al === 0 && ag === 0) return 50;
  if (al === 0) return 100;
  if (ag === 0) return 0;

  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

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

  const consecutive = firstFour.every(
    (c, i) => i === 0 || c.epoch - firstFour[i - 1].epoch === TIMEFRAME
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
    const prev = candles[i - 1];
    const day = serverDay(c.epoch);

    const doji = isDoji(c);
    const eng = isEngulfing(c, prev);

    if (!doji && !eng) continue;

    const orange =
      day === today ? todayOrange :
      day === yesterday ? yesterdayOrange : null;

    if (!orange) continue;

    let side = null;

    if (c.low > orange.high) side = "ABOVE";
    else if (c.high < orange.low) side = "BELOW";

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

  const groups = [
    { day: today, side: "ABOVE" },
    { day: today, side: "BELOW" },
    { day: yesterday, side: "ABOVE" },
    { day: yesterday, side: "BELOW" }
  ];

  const selected = [];

  for (const g of groups) {
    const m = zones
      .filter(z => z.day === g.day && z.side === g.side)
      .sort((a, b) => b.sourceIndex - a.sourceIndex)[0];

    if (m) selected.push(m);
  }

  return selected.map(zone => {
    let touchCount = 0;
    let firstTouchIndex = null;
    let lastTouchIndex = null;
    let armed = zone.armed;
    let armExpired = false;

    for (let i = zone.sourceIndex + 1; i < candles.length; i++) {
      const c = candles[i];

      if (zone.day === today && !armed) {
        const age = i - zone.sourceIndex;

        if (age > ARM_CANDLE_LIMIT) {
          armExpired = true;
          break;
        }

        const ad = ARM_DISTANCE_PIPS * pip;

        const armedNow = zone.side === "ABOVE"
          ? c.close >= zone.high + ad
          : c.close <= zone.low - ad;

        if (armedNow) armed = true;
      }

      if (!armed) continue;

      const inter = c.low <= zone.high && c.high >= zone.low;

      if (inter && i !== lastTouchIndex) {
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

function findClosedEntrySignal(candles, symbol, category, marketPip) {
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
        reason: "Red candle opened above Orange Box and closed inside - continuation"
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
        reason: "Green candle opened below Orange Box and closed inside - continuation"
      }),
      ...boxInfo
    };
  }

  for (const zone of zones) {
    if (!zone.armed || zone.touchCount >= 2) continue;

    const zoA = candle.open > zone.high;
    const zoB = candle.open < zone.low;
    const zcA = candle.close > zone.high;
    const zcB = candle.close < zone.low;

    const zcI =
      candle.close >= zone.low &&
      candle.close <= zone.high;

    if (
      zoA &&
      color === "RED" &&
      candle.low >= zone.low &&
      candle.low <= zone.high &&
      zcA
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
          reason: `${zone.type} retest BUY`
        }),
        ...boxInfo
      };
    }

    if (
      zoB &&
      color === "GREEN" &&
      candle.high >= zone.low &&
      candle.high <= zone.high &&
      zcB
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
          reason: `${zone.type} retest SELL`
        }),
        ...boxInfo
      };
    }

    if (zoA && color === "RED" && zcI) {
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
          reason: `${zone.type} break-in continuation SELL`
        }),
        ...boxInfo
      };
    }

    if (zoB && color === "GREEN" && zcI) {
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
          reason: `${zone.type} break-in continuation BUY`
        }),
        ...boxInfo
      };
    }
  }

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
          reason: `First touch of armed ${zone.type} with GREEN`
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
          reason: `First touch of armed ${zone.type} with RED`
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
      distance: null,
      touching: false
    };
  }

  const current = liveCandle || candles[candles.length - 1];

  if (!current) {
    return {
      state: "WAITING",
      proximity: Infinity,
      distance: null,
      touching: false
    };
  }

  const touchingZone = zones.find(
    z => z.armed && current.low <= z.high && current.high >= z.low
  );

  if (touchingZone) {
    return {
      state: `${touchingZone.type} TOUCH`,
      proximity: 0,
      distance: 0,
      touching: true,
      touchingBox: touchingZone
    };
  }

  const touchingOrange =
    current.low <= orangeBox.high &&
    current.high >= orangeBox.low;

  if (touchingOrange) {
    const rsiCandles = liveCandle
      ? [...candles, liveCandle]
      : candles;

    const rsi = calculateRSI(
      rsiCandles,
      rsiCandles.length - 1,
      3
    );

    return {
      state: "TOUCHING ORANGE BOX",
      proximity: 0,
      distance: 0,
      touching: true,
      touchingBox: orangeBox,
      rsi
    };
  }

  const nearest = Math.min(
    Math.abs(price - orangeBox.high),
    Math.abs(price - orangeBox.low)
  );

  return {
    state: "NOT TOUCHING",
    proximity: nearest,
    distance: nearest,
    touching: false
  };
}

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

function alreadyExecuted(trades, signal, symbol) {
  return trades.some(
    t => t.symbol === symbol && t.signalId === signal.signalId
  );
}

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
      `Spread filter rejected: ${fmt(spreadInfo.points, 1)} points. Max ${MAX_SPREAD_POINTS}.`
    );
  }

  const buy = signal.direction === "BUY";
  const spread = spreadInfo.spread;
  const entry = buy ? spreadInfo.ask : spreadInfo.bid;

  const sRefH = signal.dojiHigh ?? signal.boxHigh;
  const sRefL = signal.dojiLow ?? signal.boxLow;

  const offset = signal.pip * SL_OFFSET_PIPS + spread;

  const sl = buy
    ? sRefL - offset
    : sRefH + offset;

  const slDistance = Math.abs(entry - sl);

  if (!Number.isFinite(slDistance) || slDistance <= 0) {
    throw new Error("Invalid SL");
  }

  const tpDistance = signal.boxSize * TAKE_PROFIT_MULTIPLE;

  if (!Number.isFinite(tpDistance) || tpDistance <= 0) {
    throw new Error("Invalid TP");
  }

  const tp = buy
    ? entry + tpDistance
    : entry - tpDistance;

  const safeLots = Math.max(0, Number(fixedLots) || 0);
  const safeRisk = Math.max(0, Number(riskPct) || 0);

  const riskMoney = sizingMode === "FIXED_LOTS"
    ? balance * 0.01 * (safeLots / 0.10)
    : balance * safeRisk / 100;

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
  const sd = Math.abs(trade.entry - trade.sl);

  if (!sd) return 0;

  const mv = trade.direction === "BUY"
    ? price - trade.entry
    : trade.entry - price;

  return (mv / sd) * trade.riskMoney;
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

function getExitPrice(trade, reason, obs) {
  if (reason === "STOP LOSS") return trade.sl;
  if (reason === "TAKE PROFIT") return trade.tp;

  return obs;
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
export default function App() {
  // PUBLIC MARKET-DATA SOCKET
  const socketRef = useRef(null);
  const connectionPromiseRef = useRef(null);
  const requestRef = useRef(0);
  const pendingRequestsRef = useRef(new Map());

  // AUTHENTICATED DEMO-TRADING SOCKET
  const tradeSocketRef = useRef(null);
  const tradeRequestRef = useRef(0);
  const tradePendingRequestsRef = useRef(new Map());

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

  const [showStats, setShowStats] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  // Do not save the API token in localStorage.
  const [demoToken, setDemoToken] = useState("");

  const [isLiveDemo, setIsLiveDemo] = useState(false);
  const [demoAccountInfo, setDemoAccountInfo] = useState(null);
  const [liveMode, setLiveMode] = useState("SIMULATED");
  const [stake, setStake] = useState(10);

  useEffect(() => {
    const t = setInterval(
      () => setClock(Math.floor(Date.now() / 1000)),
      1000
    );

    return () => clearInterval(t);
  }, []);

  const updateOrders = useCallback(u => {
    const n = typeof u === "function"
      ? u(ordersRef.current)
      : u;

    ordersRef.current = n;
    setOrders(n);
  }, []);

  const updateClosedTrades = useCallback(u => {
    const n = typeof u === "function"
      ? u(closedTradesRef.current)
      : u;

    closedTradesRef.current = n;
    setClosedTrades(n);
  }, []);

  // REQUEST HANDLER FOR PUBLIC MARKET-DATA SOCKET
  const request = useCallback(payload => new Promise((resolve, reject) => {
    const ws = socketRef.current;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(
        "Deriv market-data WebSocket is not connected. Please reconnect."
      ));
      return;
    }

    const id = ++requestRef.current;

    const timeout = setTimeout(() => {
      pendingRequestsRef.current.delete(id);
      reject(new Error(
        "Deriv market-data request timed out."
      ));
    }, REQUEST_TIMEOUT);

    pendingRequestsRef.current.set(id, {
      resolve,
      reject,
      timeout
    });

    try {
      ws.send(JSON.stringify({
        ...payload,
        req_id: id
      }));
    } catch (error) {
      clearTimeout(timeout);
      pendingRequestsRef.current.delete(id);
      reject(new Error(`Could not send request: ${error.message}`));
    }
  }), []);

  // REQUEST HANDLER FOR AUTHENTICATED DEMO-TRADING SOCKET
  const requestTrade = useCallback(payload => new Promise((resolve, reject) => {
    const ws = tradeSocketRef.current;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(
        "Authenticated Deriv DEMO trading connection is not open. Reconnect your demo account."
      ));
      return;
    }

    const id = ++tradeRequestRef.current;

    const timeout = setTimeout(() => {
      tradePendingRequestsRef.current.delete(id);
      reject(new Error(
        "Deriv DEMO trading request timed out."
      ));
    }, REQUEST_TIMEOUT);

    tradePendingRequestsRef.current.set(id, {
      resolve,
      reject,
      timeout
    });

    try {
      ws.send(JSON.stringify({
        ...payload,
        req_id: id
      }));
    } catch (error) {
      clearTimeout(timeout);
      tradePendingRequestsRef.current.delete(id);
      reject(new Error(`Could not send DEMO trade request: ${error.message}`));
    }
  }), []);

  const processTick = useCallback((symbol, tick) => {
    if (!symbol || !tick) return;

    const quote = Number(tick.quote);
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);

    const usable = Number.isFinite(bid) && bid > 0
      ? bid
      : quote;

    if (!Number.isFinite(usable)) return;

    latestPricesRef.current[symbol] = usable;

    latestTicksRef.current[symbol] = {
      quote,
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
      ask: Number.isFinite(ask) && ask > 0 ? ask : null,
      epoch: Number(tick.epoch) || Math.floor(Date.now() / 1000)
    };

    const remaining = [];
    const newlyClosed = [];

    for (const orig of ordersRef.current) {
      if (
        orig.symbol !== symbol ||
        orig.status !== "OPEN DEMO TRADE"
      ) {
        remaining.push(orig);
        continue;
      }

      const trade = {
        ...orig,
        currentPrice: usable
      };

      const reason = getExitReason(trade, usable);

      if (reason) {
        const exitPrice = getExitPrice(trade, reason, usable);
        const pnl = calculateDemoPnl(trade, exitPrice);

        newlyClosed.push({
          ...trade,
          status: "CLOSED",
          exitPrice,
          observedExitPrice: usable,
          exitReason: reason,
          realisedPnl: pnl,
          floatingPnl: 0,
          closedAt: new Date().toLocaleTimeString()
        });

        continue;
      }

      trade.floatingPnl = calculateDemoPnl(trade, usable);
      remaining.push(trade);
    }

    updateOrders(remaining);

    if (newlyClosed.length) {
      updateClosedTrades(p => [...newlyClosed, ...p]);

      newlyClosed.forEach(t => {
        sendBrowserNotification(
          t.exitReason === "TAKE PROFIT"
            ? "iFX BILLIONAIRE — TAKE PROFIT HIT"
            : "iFX BILLIONAIRE — STOP LOSS HIT",
          `${t.symbol} ${t.direction} · ${t.exitReason} · ${t.realisedPnl >= 0 ? "+" : ""}$${fmt(t.realisedPnl, 2)}`
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
    }, RECONNECT_DELAY);
  }, []);

  // PUBLIC MARKET-DATA CONNECTION
  const connect = useCallback(() => {
    const existing = socketRef.current;

    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (connectionPromiseRef.current) {
      return connectionPromiseRef.current;
    }

    setConnected(false);
    setConnectionText("CONNECTING");
    setMessage("Opening Deriv public market-data connection...");

    let ws;
    let settled = false;
    let connectionTimer = null;
    let pingTimer = null;

    let resolveConnection;
    let rejectConnection;

    const connectionPromise = new Promise((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });

    connectionPromiseRef.current = connectionPromise;

    const clearConnectionPromise = () => {
      if (connectionPromiseRef.current === connectionPromise) {
        connectionPromiseRef.current = null;
      }
    };

    const settleSuccess = () => {
      if (settled) return;
      settled = true;

      if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = null;
      }

      clearConnectionPromise();
      resolveConnection();
    };

    const settleFailure = errorMessage => {
      if (settled) return;
      settled = true;

      if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = null;
      }

      clearConnectionPromise();
      rejectConnection(new Error(errorMessage));
    };

    try {
      ws = new WebSocket(WS_URL);
      socketRef.current = ws;
    } catch (error) {
      setConnectionText("CONNECTION ERROR");
      setMessage(`WebSocket could not start: ${error.message}`);
      settleFailure(`WebSocket could not start: ${error.message}`);
      return connectionPromise;
    }

    connectionTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        setConnectionText("CONNECTION TIMEOUT");

        setMessage(
          "Deriv did not open the market-data connection within 15 seconds. Check internet access and your registered App ID."
        );

        settleFailure(
          "Connection timed out. Check your internet connection and App ID."
        );

        try {
          ws.close();
        } catch {}
      }
    }, CONNECTION_TIMEOUT);

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
      setMessage("Deriv market-data connection opened.");

      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ ping: 1 }));
          } catch {
            try {
              ws.close();
            } catch {}
          }
        }
      }, 25000);

      settleSuccess();

      request({ ping: 1 })
        .then(() => {
          if (socketRef.current === ws) {
            setMessage("Deriv market-data connection verified.");
          }
        })
        .catch(error => {
          if (socketRef.current === ws) {
            setMessage(`Deriv API test failed: ${error.message}`);
          }
        });
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
          pending.reject(
            new Error(data.error.message || "Deriv API returned an error.")
          );
        } else {
          pending.resolve(data);
        }
      }
    };

    ws.onerror = () => {
      if (socketRef.current !== ws) return;

      setConnectionText("CONNECTION ERROR");
      setConnected(false);

      settleFailure(
        "Market-data WebSocket error. Check your network and registered Deriv App ID."
      );
    };

    ws.onclose = event => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = null;
      }

      if (socketRef.current !== ws) return;

      socketRef.current = null;

      setConnected(false);
      setConnectionText("DISCONNECTED");

      subscriptionsRef.current.clear();
      subscribingRef.current.clear();

      const closeDetails =
        `Market-data connection closed. Code: ${event.code}` +
        (event.reason ? ` · Reason: ${event.reason}` : "");

      pendingRequestsRef.current.forEach(pending => {
        clearTimeout(pending.timeout);
        pending.reject(new Error(closeDetails));
      });

      pendingRequestsRef.current.clear();
      clearConnectionPromise();

      if (!settled) {
        settleFailure(closeDetails);
      }

      if (runningRef.current) {
        setMessage(
          `${closeDetails}. Automatic reconnection will be attempted.`
        );
        scheduleReconnect();
      } else {
        setMessage(closeDetails);
      }
    };

    return connectionPromise;
  }, [processTick, scheduleReconnect, request]);

  // DERIV REST HELPER
  const derivRest = useCallback(async (path, token, method = "GET") => {
    const response = await fetch(`${DERIV_REST_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": APP_ID,
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(
        `Deriv REST returned an unreadable response (HTTP ${response.status}).`
      );
    }

    if (!response.ok) {
      const apiMessage =
        data?.errors?.[0]?.message ||
        data?.error?.message ||
        data?.message ||
        `HTTP ${response.status}`;

      throw new Error(apiMessage);
    }

    if (data?.errors?.length) {
      throw new Error(
        data.errors[0]?.message || "Deriv REST request failed."
      );
    }

    return data;
  }, []);

  // CONNECT TO A DEMO OPTIONS ACCOUNT USING REST + ONE-TIME OTP
  const connectDemo = async () => {
    const token = demoToken.trim();

    if (!token || token.length < 10) {
      setMessage("Enter your Deriv API token with Trade scope.");
      return;
    }

    try {
      setMessage("Checking Deriv accounts using your API token...");
      setIsLiveDemo(false);
      setDemoAccountInfo(null);
      setLiveMode("SIMULATED");

      const accountsResponse = await derivRest(
        "/trading/v1/options/accounts",
        token,
        "GET"
      );

      const accountPayload = accountsResponse?.data;

      let accounts = [];

      if (Array.isArray(accountPayload)) {
        accounts = accountPayload;
      } else if (Array.isArray(accountPayload?.accounts)) {
        accounts = accountPayload.accounts;
      } else if (Array.isArray(accountPayload?.items)) {
        accounts = accountPayload.items;
      } else if (accountPayload && typeof accountPayload === "object") {
        accounts = [accountPayload];
      }

      const demoAccount = accounts.find(account => {
        const type = String(
          account.account_type ||
          account.account_category ||
          account.type ||
          ""
        ).toLowerCase();

        return (
          type === "demo" ||
          type === "virtual" ||
          Number(account.is_virtual) === 1
        );
      });

      if (!demoAccount) {
        throw new Error(
          "No DEMO Options account was returned for this token. Check that the token belongs to your Deriv account and has Trade scope."
        );
      }

      const accountId =
        demoAccount.account_id ||
        demoAccount.id;

      if (!accountId) {
        throw new Error(
          "Deriv returned a DEMO account without an account ID. Check the account response."
        );
      }

      setMessage("DEMO account found. Requesting secure one-time connection...");

      const otpResponse = await derivRest(
        `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
        token,
        "POST"
      );

      const wsUrl = otpResponse?.data?.url;

      if (
        typeof wsUrl !== "string" ||
        !wsUrl.startsWith("wss://api.derivws.com/trading/v1/options/ws/demo")
      ) {
        throw new Error(
          "Deriv did not return a valid DEMO WebSocket URL. No trading connection was opened."
        );
      }

      // Close any previous authenticated trade socket.
      if (tradeSocketRef.current) {
        try {
          tradeSocketRef.current.close();
        } catch {}
        tradeSocketRef.current = null;
      }

      tradePendingRequestsRef.current.forEach(pending => {
        clearTimeout(pending.timeout);
        pending.reject(new Error("A new DEMO connection is being opened."));
      });

      tradePendingRequestsRef.current.clear();

      setMessage("Opening authenticated Deriv DEMO trading connection...");

      const tradeWs = new WebSocket(wsUrl);
      tradeSocketRef.current = tradeWs;

      await new Promise((resolve, reject) => {
        let settled = false;

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;

          try {
            tradeWs.close();
          } catch {}

          reject(new Error(
            "DEMO trading connection timed out. Please reconnect."
          ));
        }, CONNECTION_TIMEOUT);

        tradeWs.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        };

        tradeWs.onerror = () => {
          if (settled) {
            setIsLiveDemo(false);
            setLiveMode("SIMULATED");
            setMessage("DEMO trading WebSocket encountered a connection error.");
            return;
          }

          settled = true;
          clearTimeout(timeout);
          reject(new Error(
            "Could not open the authenticated DEMO trading connection."
          ));
        };

        tradeWs.onclose = event => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(
              `DEMO connection closed before opening. Code ${event.code}.`
            ));
          }
        };
      });

      if (tradeSocketRef.current !== tradeWs) {
        throw new Error("DEMO connection was replaced before setup completed.");
      }

      // Install the permanent message handler after the socket opens.
      tradeWs.onmessage = event => {
        if (tradeSocketRef.current !== tradeWs) return;

        let data;

        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (
          data.req_id &&
          tradePendingRequestsRef.current.has(data.req_id)
        ) {
          const pending = tradePendingRequestsRef.current.get(data.req_id);

          clearTimeout(pending.timeout);
          tradePendingRequestsRef.current.delete(data.req_id);

          if (data.error) {
            pending.reject(
              new Error(data.error.message || "Deriv DEMO trade request failed.")
            );
          } else {
            pending.resolve(data);
          }
        }

        if (data.msg_type === "balance" && data.balance) {
          const amount = Number(data.balance.balance);

          if (Number.isFinite(amount)) {
            setDemoAccountInfo(current => current
              ? {
                  ...current,
                  balance: amount,
                  currency: data.balance.currency || current.currency
                }
              : current
            );
          }
        }
      };

      tradeWs.onclose = event => {
        if (tradeSocketRef.current !== tradeWs) return;

        tradeSocketRef.current = null;

        tradePendingRequestsRef.current.forEach(pending => {
          clearTimeout(pending.timeout);
          pending.reject(new Error(
            `DEMO trading connection closed. Code ${event.code}.`
          ));
        });

        tradePendingRequestsRef.current.clear();

        setIsLiveDemo(false);
        setLiveMode("SIMULATED");
        setDemoAccountInfo(null);

        setMessage(
          "DEMO trading connection closed. The app has returned to SIMULATED mode."
        );
      };

      const normalizedAccount = {
        account_id: accountId,
        loginid: demoAccount.loginid || demoAccount.account_id || accountId,
        balance: Number(demoAccount.balance) || 0,
        currency: demoAccount.currency || "USD",
        account_type: "demo",
        is_virtual: 1
      };

      setDemoAccountInfo(normalizedAccount);
      setIsLiveDemo(true);
      setLiveMode("LIVE_DEMO");

      // Request current account balance. This is best-effort.
      try {
        await requestTrade({ balance: 1 });
      } catch {}

      // Remove token from the input after a successful connection.
      setDemoToken("");

      setMessage(
        `LIVE DEMO CONNECTED: ${normalizedAccount.loginid} · ${normalizedAccount.balance} ${normalizedAccount.currency}`
      );

    } catch (error) {
      if (tradeSocketRef.current) {
        try {
          tradeSocketRef.current.close();
        } catch {}
        tradeSocketRef.current = null;
      }

      tradePendingRequestsRef.current.forEach(pending => {
        clearTimeout(pending.timeout);
        pending.reject(error);
      });

      tradePendingRequestsRef.current.clear();

      setIsLiveDemo(false);
      setDemoAccountInfo(null);
      setLiveMode("SIMULATED");

      setMessage(`DEMO CONNECTION FAILED: ${error.message}`);
    }
  };

  const disconnectDemo = () => {
    const ws = tradeSocketRef.current;

    tradeSocketRef.current = null;

    if (ws) {
      try {
        ws.close();
      } catch {}
    }

    tradePendingRequestsRef.current.forEach(pending => {
      clearTimeout(pending.timeout);
      pending.reject(new Error("DEMO account disconnected."));
    });

    tradePendingRequestsRef.current.clear();

    setIsLiveDemo(false);
    setLiveMode("SIMULATED");
    setDemoAccountInfo(null);
    setDemoToken("");

    setMessage("Disconnected from Deriv DEMO. Back to SIMULATED mode.");
  };

  const subscribeMarket = useCallback(async symbol => {
    if (subscriptionsRef.current.has(symbol)) return true;
    if (subscribingRef.current.has(symbol)) return false;

    if (
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN
    ) return false;

    subscribingRef.current.add(symbol);

    try {
      const res = await request({
        ticks: symbol,
        subscribe: 1
      });

      if (res.error) {
        throw new Error(res.error.message);
      }

      const sid = res.subscription?.id || "SUBSCRIBED";

      subscriptionsRef.current.set(symbol, sid);

      if (res.tick) {
        processTick(res.tick.symbol || symbol, res.tick);
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

    const res = await request({
      active_symbols: "full"
    });

    const raw =
      res.active_symbols ||
      res.data?.active_symbols ||
      [];

    if (!Array.isArray(raw)) {
      throw new Error(
        "Deriv active-symbol response was not an array."
      );
    }

    const list = raw
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
      .sort((a, b) =>
        a.priority !== b.priority
          ? a.priority - b.priority
          : String(a.display_name).localeCompare(String(b.display_name))
      );

    marketsRef.current = list;
    setSymbols(list);

    const found = new Set(
      list.map(i => i.prioritySymbol).filter(Boolean)
    );

    const missing = PRIORITY_SYMBOLS.filter(
      s => !found.has(s)
    );

    setMessage(
      `${list.length} Deriv markets discovered. ${found.size}/21 priority instruments matched.` +
      (missing.length ? ` Not found: ${missing.join(", ")}` : "")
    );

    return list;
  }, [request]);

  const scanSymbol = useCallback(async item => {
    const diag = {
      returned: 0,
      valid: 0,
      closed: 0,
      latestEpoch: null,
      error: null
    };

    try {
      const res = await request({
        ticks_history: item.symbol,
        count: CANDLE_COUNT,
        end: "latest",
        style: "candles",
        granularity: TIMEFRAME
      });

      const raw = Array.isArray(res.candles)
        ? res.candles
        : [];

      diag.returned = raw.length;

      const candles = raw
        .map(c => ({
          epoch: Number(c.epoch),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: c.volume === undefined
            ? null
            : Number(c.volume)
        }))
        .filter(c =>
          Number.isFinite(c.epoch) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          c.high >= c.low
        )
        .sort((a, b) => a.epoch - b.epoch);

      diag.valid = candles.length;

      const now = Math.floor(Date.now() / 1000);

      const closed = candles.filter(
        c => c.epoch + TIMEFRAME <= now
      );

      const liveCandles = candles.filter(
        c => c.epoch + TIMEFRAME > now
      );

      const liveCandle =
        liveCandles[liveCandles.length - 1] || null;

      diag.closed = closed.length;

      if (closed.length) {
        diag.latestEpoch = closed[closed.length - 1].epoch;
      }

      const signal = findClosedEntrySignal(
        closed,
        item.symbol,
        item.category,
        item.pip
      );

      const curClosed = closed[closed.length - 1];

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
          : liveCandle?.close ?? curClosed?.close ?? null;

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
        scannerRsi: scanner.rsi ?? signal.rsi ?? null,
        isTouching: scanner.touching,
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
        latestClosedEpoch: curClosed?.epoch ?? null,
        _candleData: diag
      };

    } catch (error) {
      diag.error = error.message || "Unknown";

      return {
        direction: "NONE",
        reason: "Market data unavailable",
        boxCount: 0,
        scannerState: "DATA ERROR",
        scannerProximity: Infinity,
        isTouching: false,
        _candleData: diag
      };
    }
  }, [request]);

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
      while (
        nextIndex < list.length &&
        runningRef.current
      ) {
        const idx = nextIndex++;
        const item = list[idx];

        const r = await scanSymbol(item);

        results[item.symbol] = r;

        completed++;

        setScanned(completed);
        setProgress(
          Math.round(completed / list.length * 100)
        );

        if (completed % 5 === 0) {
          setSignals(p => ({ ...p, ...results }));

          setScannerStates(p => ({
            ...p,
            ...Object.fromEntries(
              Object.entries(results).map(([s, v]) => [
                s,
                {
                  state: v.scannerState,
                  proximity: v.scannerProximity,
                  livePrice: v.livePrice,
                  spreadKnown: v.spreadKnown,
                  spreadPoints: v.spreadPoints,
                  touching: v.isTouching
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

      setSignals(p => ({ ...p, ...results }));

      setScannerStates(p => ({
        ...p,
        ...Object.fromEntries(
          Object.entries(results).map(([s, v]) => [
            s,
            {
              state: v.scannerState,
              proximity: v.scannerProximity,
              livePrice: v.livePrice,
              spreadKnown: v.spreadKnown,
              spreadPoints: v.spreadPoints,
              touching: v.isTouching
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

      if (
        rescanRequestedRef.current &&
        runningRef.current
      ) {
        rescanRequestedRef.current = false;

        setTimeout(() => {
          if (runningRef.current) {
            scanAll(marketsRef.current);
          }
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
          const p = await Notification.requestPermission();
          setNotificationPermission(p);
        } catch {}
      }

      setMessage("Connecting to Deriv M15 market data...");

      await connect();

      // Do not authorize the API token on the public market-data socket.
      // The demo trading connection is established separately by connectDemo.

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

      const prio = list.filter(i => i.prioritySymbol);

      for (const it of prio) {
        if (!runningRef.current) break;
        await subscribeMarket(it.symbol);
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
        "Robot running. Scanner checks every 30s. Entries require a completed M15 candle and a touching box."
      );

    } catch (error) {
      runningRef.current = false;
      setRunning(false);
      setMessage(`START FAILED: ${error.message}`);
    }
  };

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

    for (const o of ordersRef.current) {
      if (o.status !== "OPEN DEMO TRADE") continue;

      const price =
        latestPricesRef.current[o.symbol] ??
        o.currentPrice ??
        o.entry;

      closedNow.push({
        ...o,
        status: "CLOSED",
        exitPrice: price,
        exitReason: "ROBOT STOPPED",
        realisedPnl: calculateDemoPnl(o, price),
        floatingPnl: 0,
        closedAt: now
      });
    }

    if (closedNow.length) {
      updateClosedTrades(p => [...closedNow, ...p]);
    }

    updateOrders([]);

    const ws = socketRef.current;

    if (ws && ws.readyState === WebSocket.OPEN) {
      subscriptionsRef.current.forEach(sid => {
        if (sid && sid !== "SUBSCRIBED") {
          try {
            ws.send(JSON.stringify({
              forget: sid,
              req_id: ++requestRef.current
            }));
          } catch {}
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

    const now = Math.floor(Date.now() / 1000);

    if (!isTradingTime(now)) {
      setMessage(
        "Trading is paused. Allowed hours are 07:00–21:59 UTC."
      );
      return;
    }

    const lockKey = `${item.symbol}|${signal.signalId}`;

    if (activationLocksRef.current.has(lockKey)) {
      setMessage(
        `${item.symbol}: this signal is already processing.`
      );
      return;
    }

    activationLocksRef.current.add(lockKey);

    try {
      if (
        liveMode === "LIVE_DEMO" &&
        isLiveDemo &&
        demoAccountInfo
      ) {
        if (
          !tradeSocketRef.current ||
          tradeSocketRef.current.readyState !== WebSocket.OPEN
        ) {
          throw new Error(
            "DEMO trading socket is not connected. Reconnect your DEMO account."
          );
        }

        const contractType =
          signal.direction === "BUY" ? "CALL" : "PUT";

        const safeStake = Number(stake);

        if (!Number.isFinite(safeStake) || safeStake <= 0) {
          setMessage("Enter a valid DEMO stake greater than zero.");
          return;
        }

        setMessage(
          `${item.symbol}: Requesting LIVE DEMO ${contractType} proposal for $${safeStake}...`
        );

        const proposalResponse = await requestTrade({
          proposal: 1,
          amount: safeStake,
          basis: "stake",
          contract_type: contractType,
          currency: demoAccountInfo.currency || "USD",
          duration: 5,
          duration_unit: "m",
          underlying_symbol: item.symbol
        });

        const proposal = proposalResponse.proposal;

        if (!proposal?.id) {
          throw new Error(
            "Deriv did not return a valid proposal ID."
          );
        }

        const buyResponse = await requestTrade({
          buy: proposal.id,
          price: safeStake
        });

        if (!buyResponse.buy) {
          throw new Error(
            "Deriv did not return a successful buy confirmation."
          );
        }

        const contract = buyResponse.buy;

        setMessage(
          `LIVE DEMO TRADE OPENED: ${item.symbol} ${signal.direction} · Stake $${safeStake} · Contract ${contract.contract_id} · Payout ${contract.payout}`
        );

        setLastActivated(
          `${signal.direction} · LIVE DEMO · ${signal.strategy}`
        );

        return;
      }

      const prev = [
        ...ordersRef.current,
        ...closedTradesRef.current
      ];

      const today = serverDay(now);

      const daily = prev.filter(
        t => t.openedDay === today
      );

      const openCount = ordersRef.current.filter(
        t => t.status === "OPEN DEMO TRADE"
      ).length;

      if (daily.length >= MAX_DAILY_TRADES) {
        setMessage(
          `Daily limit reached: maximum ${MAX_DAILY_TRADES} trades.`
        );
        return;
      }

      if (openCount >= MAX_OPEN_TRADES) {
        setMessage(
          `Open-trade limit reached: maximum ${MAX_OPEN_TRADES}.`
        );
        return;
      }

      if (alreadyExecuted(prev, signal, item.symbol)) {
        setMessage(
          `${item.symbol}: this signal has already been traded.`
        );
        return;
      }

      const sub = await subscribeMarket(item.symbol);

      if (!sub) {
        setMessage(
          `${item.symbol}: could not obtain live market data.`
        );
        return;
      }

      const tick = latestTicksRef.current[item.symbol];

      const curPrice = Number.isFinite(tick?.bid)
        ? tick.bid
        : tick?.quote;

      if (!Number.isFinite(curPrice)) {
        setMessage(`${item.symbol}: waiting for a live price.`);
        return;
      }

      const spreadInfo = getSpreadInfo(tick, curPrice);

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

      const latest = [
        ...ordersRef.current,
        ...closedTradesRef.current
      ];

      if (alreadyExecuted(latest, signal, item.symbol)) {
        setMessage("This signal has already been traded.");
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

      updateOrders(p => [order, ...p]);

      setSelected(item);

      setLastActivated(
        `${signal.direction} · ${signal.strategy} · M15`
      );

      setMessage(
        `${item.symbol}: ${signal.direction} simulated market trade opened at ${fmt(order.entry, 8)}.`
      );

    } catch (error) {
      setMessage(`${item.symbol}: ${error.message}`);

    } finally {
      activationLocksRef.current.delete(lockKey);
    }
  };

  // AUTOMATIC RECONNECTION AND MARKET SUBSCRIPTION RECOVERY
  useEffect(() => {
    const recover = async () => {
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
        setMessage("Restoring Deriv market-data connection...");

        await connect();

        if (!runningRef.current) return;

        const openSyms = [
          ...new Set(
            ordersRef.current
              .filter(o => o.status === "OPEN DEMO TRADE")
              .map(o => o.symbol)
          )
        ];

        const prioSyms = [
          ...new Set(
            marketsRef.current
              .filter(i => i.prioritySymbol)
              .map(i => i.symbol)
          )
        ];

        for (const s of [...new Set([...prioSyms, ...openSyms])]) {
          if (!runningRef.current) break;
          await subscribeMarket(s);
        }

        if (!runningRef.current) return;

        let list = marketsRef.current;

        if (!list.length) {
          list = await discoverMarkets();
        }

        if (runningRef.current && list.length) {
          setMessage("Market-data connection restored. Resuming scans...");
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

    const hR = () => recover();

    const hO = () => {
      if (runningRef.current) recover();
    };

    const hV = () => {
      if (
        document.visibilityState === "visible" &&
        runningRef.current
      ) {
        recover();
      }
    };

    window.addEventListener("ifx-robot-reconnect", hR);
    window.addEventListener("online", hO);
    document.addEventListener("visibilitychange", hV);

    return () => {
      window.removeEventListener("ifx-robot-reconnect", hR);
      window.removeEventListener("online", hO);
      document.removeEventListener("visibilitychange", hV);
    };
  }, [
    connect,
    scanAll,
    subscribeMarket,
    discoverMarkets,
    scheduleReconnect
  ]);

  // CLEANUP BOTH SOCKETS AND THEIR PENDING REQUESTS
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

      if (tradeSocketRef.current) {
        tradeSocketRef.current.close();
      }

      pendingRequestsRef.current.forEach(p => {
        clearTimeout(p.timeout);
        p.reject(new Error("App closed or market connection cleaned up."));
      });

      pendingRequestsRef.current.clear();

      tradePendingRequestsRef.current.forEach(p => {
        clearTimeout(p.timeout);
        p.reject(new Error("App closed or DEMO connection cleaned up."));
      });

      tradePendingRequestsRef.current.clear();
    };
  }, []);

  // FILTER: SIGNALS FIRST, THEN TOUCHING / WAITING MARKETS
  const touchingSymbols = useMemo(() => {
    return symbols.filter(item => {
      const sig = signals[item.symbol];

      if (!sig) return false;

      if (
        category !== "All" &&
        item.category !== category
      ) return false;

      const term = search.toLowerCase();

      if (
        term &&
        !String(item.display_name || "").toLowerCase().includes(term) &&
        !String(item.symbol || "").toLowerCase().includes(term)
      ) return false;

      return true;

    }).sort((a, b) => {
      const sa = signals[a.symbol];
      const sb = signals[b.symbol];

      const rank = s =>
        s?.direction === "BUY" || s?.direction === "SELL"
          ? 0
          : s?.isTouching
            ? 1
            : 2;

      if (rank(sa) !== rank(sb)) {
        return rank(sa) - rank(sb);
      }

      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      return (
        (sa?.scannerProximity ?? Infinity) -
        (sb?.scannerProximity ?? Infinity)
      );
    }).slice(0, 30);

  }, [symbols, signals, category, search]);

  const visibleSymbols = touchingSymbols;

  const buyCount = symbols.filter(
    s =>
      signals[s.symbol]?.direction === "BUY" &&
      signals[s.symbol]?.isTouching
  ).length;

  const sellCount = symbols.filter(
    s =>
      signals[s.symbol]?.direction === "SELL" &&
      signals[s.symbol]?.isTouching
  ).length;

  const openTrades = orders.filter(
    o => o.status === "OPEN DEMO TRADE"
  );

  const isTradingHours = isTradingTime(clock);
  const todayDay = serverDay(clock);

   return (
    <div style={{
      background: "#0a0f1a",
      minHeight: "100vh",
      color: "#e6edf7",
      fontFamily: "system-ui",
      paddingBottom: 30
    }}>

      <div style={{
        padding: "14px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottom: "1px solid #1e2d45"
      }}>
        <div>
          <div style={{
            fontSize: 22,
            fontWeight: 900,
            letterSpacing: 1
          }}>
            iFX BILLIONAIRE
          </div>

          <div style={{
            fontSize: 9,
            color: "#8a9bb5",
            letterSpacing: 1.5
          }}>
            M15 • ORANGE BOX • DOJI • ENGULFING • FIXED
          </div>
        </div>

        <div style={{
          background: running ? "#0f3d1e" : "#3a1a1a",
          color: running ? "#4ade80" : "#ff6b6b",
          padding: "6px 12px",
          borderRadius: 20,
          fontSize: 11,
          fontWeight: 800
        }}>
          ● {running ? "RUNNING" : "STOPPED"}
        </div>
      </div>

      <div style={{
        background: "#131e32",
        border: "1px solid #24334b",
        borderRadius: 12,
        margin: 12,
        padding: 14
      }}>
        <div style={{
          fontSize: 12,
          fontWeight: 900,
          letterSpacing: 1
        }}>
          ROBOT CONTROL
        </div>

        <div style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          margin: "10px 0",
          fontSize: 11
        }}>
          <span>● {connectionText}</span>

          <span style={{
            background: isLiveDemo ? "#14532d" : "#4a3a12",
            color: isLiveDemo ? "#4ade80" : "#fbbf24",
            padding: "3px 8px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 800
          }}>
            {isLiveDemo
              ? `LIVE DEMO: ${demoAccountInfo?.loginid || ""}`
              : "SIMULATED DEMO"}
          </span>
        </div>

        <div style={{
          background: "#0f172a",
          border: "1px solid #334155",
          borderRadius: 8,
          padding: 10,
          marginBottom: 10
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 800,
            marginBottom: 6
          }}>
            🔐 DERIV DEMO ACCOUNT (Optional)
          </div>

          <div style={{
            fontSize: 10,
            color: "#8a9bb5",
            lineHeight: 1.4,
            marginBottom: 8
          }}>
            Deriv.com → DEMO account → Settings → API Token →
            Create token with Trade scope. Paste your DEMO token only.
            Your token is not saved in browser storage.
          </div>

          <input
            type="password"
            value={demoToken}
            onChange={e => setDemoToken(e.target.value)}
            placeholder="Paste DEMO API Token here..."
            autoComplete="off"
            style={{
              width: "100%",
              padding: 10,
              background: "#1e293b",
              border: "1px solid #475569",
              borderRadius: 6,
              color: "white",
              fontSize: 12,
              marginBottom: 8,
              boxSizing: "border-box"
            }}
          />

          <div style={{
            display: "flex",
            gap: 8
          }}>
            {!isLiveDemo ? (
              <button
                onClick={connectDemo}
                style={{
                  flex: 1,
                  padding: 10,
                  background: "#0ea5e9",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 800,
                  fontSize: 12
                }}
              >
                CONNECT DEMO ACCOUNT
              </button>
            ) : (
              <button
                onClick={disconnectDemo}
                style={{
                  flex: 1,
                  padding: 10,
                  background: "#7f1d1d",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 800,
                  fontSize: 12
                }}
              >
                DISCONNECT DEMO
              </button>
            )}

            <button
              onClick={() =>
                setLiveMode(
                  liveMode === "SIMULATED"
                    ? "LIVE_DEMO"
                    : "SIMULATED"
                )
              }
              disabled={!isLiveDemo}
              style={{
                flex: 1,
                padding: 10,
                background:
                  liveMode === "LIVE_DEMO"
                    ? "#16a34a"
                    : "#334155",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontWeight: 800,
                fontSize: 12,
                opacity: !isLiveDemo ? 0.5 : 1
              }}
            >
              MODE: {liveMode === "LIVE_DEMO"
                ? "LIVE DEMO TRADE"
                : "SIMULATED"}
            </button>
          </div>

          {demoAccountInfo && (
            <div style={{
              fontSize: 11,
              marginTop: 8,
              color: "#4ade80"
            }}>
              Balance: {fmt(demoAccountInfo.balance, 2)}{" "}
              {demoAccountInfo.currency}
              (Virtual) • ID: {demoAccountInfo.loginid}
            </div>
          )}

          <div style={{
            display: "flex",
            gap: 8,
            marginTop: 8,
            alignItems: "center"
          }}>
            <span style={{ fontSize: 11 }}>Stake $</span>

            <input
              type="number"
              min="0.35"
              step="0.01"
              value={stake}
              onChange={e => setStake(Number(e.target.value))}
              style={{
                width: 70,
                background: "#1e293b",
                color: "white",
                border: "1px solid #475569",
                borderRadius: 4,
                padding: 5
              }}
            />

            <span style={{
              fontSize: 10,
              color: "#8a9bb5"
            }}>
              for LIVE DEMO trades only (5 min Rise/Fall)
            </span>
          </div>
        </div>

        <div style={{
          display: "flex",
          gap: 10
        }}>
          <button
            onClick={startRobot}
            disabled={running}
            style={{
              flex: 1,
              padding: 14,
              border: "none",
              borderRadius: 8,
              fontWeight: 900,
              background: "#10b981",
              color: "white",
              opacity: running ? 0.5 : 1
            }}
          >
            ▶ START ROBOT
          </button>

          <button
            onClick={stopRobot}
            style={{
              flex: 1,
              padding: 14,
              border: "none",
              borderRadius: 8,
              fontWeight: 900,
              background: "#dc2626",
              color: "white"
            }}
          >
            ■ STOP
          </button>
        </div>

        <div style={{
          fontSize: 11,
          color: "#8a9bb5",
          marginTop: 10,
          lineHeight: 1.5
        }}>
          {message}
        </div>

        <div style={{
          height: 5,
          background: "#1e2d45",
          borderRadius: 3,
          margin: "12px 0 8px"
        }}>
          <div style={{
            height: "100%",
            background: "#3b82f6",
            width: `${progress}%`
          }} />
        </div>

        <div style={{
          fontSize: 11,
          color: "#8a9bb5"
        }}>
          Scan progress: {scanned}/{symbols.length} · {progress}%
          · Every 30s (testing) · UTC:{" "}
          {new Date(clock * 1000).toISOString().slice(11, 19)}
          · Last scan: {lastScan}
        </div>

        <div style={{
          background: isTradingHours ? "#14532d" : "#3f1d1d",
          color: isTradingHours ? "#4ade80" : "#f87171",
          padding: 10,
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 800,
          textAlign: "center",
          marginTop: 10
        }}>
          TRADING HOURS: {isTradingHours ? "ACTIVE" : "PAUSED"}
          · 07:00–21:59 UTC
        </div>
      </div>

      <div style={{
        background: "#131e32",
        border: "1px solid #24334b",
        borderRadius: 12,
        margin: 12,
        padding: 14
      }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between"
        }}>
          <span style={{
            fontSize: 12,
            fontWeight: 900
          }}>
            VALID M15 BUY / SELL SIGNALS - TOUCHING ONLY
          </span>

          <span>−</span>
        </div>

        <p style={{
          fontSize: 11,
          color: "#8a9bb5",
          marginTop: 8,
          lineHeight: 1.5
        }}>
          Signals on top, touching & waiting below.{" "}
          {liveMode === "LIVE_DEMO"
            ? "TAP will place a Deriv DEMO trade."
            : "TAP will open a simulated trade."}
        </p>

        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search symbol or market..."
          style={{
            width: "100%",
            padding: 12,
            background: "#0f172a",
            border: "1px solid #334155",
            borderRadius: 8,
            color: "white",
            margin: "12px 0",
            boxSizing: "border-box"
          }}
        />

        <div style={{
          display: "flex",
          gap: 6,
          overflowX: "auto"
        }}>
          {CATEGORIES.slice(0, 6).map(c => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              style={{
                padding: "7px 14px",
                borderRadius: 20,
                background: category === c ? "#0ea5e9" : "#1e293b",
                color: category === c ? "white" : "#94a3b8",
                fontSize: 12,
                border: "none",
                whiteSpace: "nowrap"
              }}
            >
              {c}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 10 }}>
          {visibleSymbols.length === 0 && (
            <div style={{
              padding: 20,
              textAlign: "center",
              color: "#64748b",
              fontSize: 12
            }}>
              No pairs yet. Tap START ROBOT.
              <br />
              Scanner runs every 30 seconds now.
            </div>
          )}

          {visibleSymbols.map(item => {
            const sig = signals[item.symbol];

            if (!sig) return null;

            const isBuy = sig.direction === "BUY";

            const hasSignal =
              sig.direction === "BUY" ||
              sig.direction === "SELL";

            return (
              <div
                key={item.symbol}
                style={{
                  background: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: 8,
                  padding: 12,
                  marginTop: 10,
                  opacity: hasSignal ? 1 : 0.85
                }}
              >
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start"
                }}>
                  <div>
                    <b>{item.display_name || item.symbol}</b>

                    <div style={{
                      fontSize: 10,
                      color: "#94a3b8",
                      marginTop: 3
                    }}>
                      {item.category} · M15 · {sig.scannerState}
                    </div>

                    <div style={{
                      fontSize: 11,
                      color: "#fbbf24",
                      fontWeight: 800,
                      marginTop: 6
                    }}>
                      {sig.strategy || sig.reason}
                    </div>

                    <div style={{
                      fontSize: 11,
                      color: "#cbd5e1",
                      marginTop: 4,
                      lineHeight: 1.4
                    }}>
                      {sig.reason}
                    </div>

                    <div style={{
                      fontSize: 11,
                      marginTop: 6
                    }}>
                      ORANGE HIGH {fmt(sig.boxHigh, 7)}
                      {" · "}
                      LOW {fmt(sig.boxLow, 7)}
                    </div>

                    {hasSignal && (
                      <div style={{
                        fontSize: 11,
                        color: "#fbbf24",
                        fontWeight: 700
                      }}>
                        ENTRY: {fmt(sig.entryLevel, 7)}
                      </div>
                    )}

                    <div style={{
                      fontSize: 11,
                      color: "#94a3b8",
                      marginTop: 4
                    }}>
                      RSI: {sig.rsi ? fmt(sig.rsi, 1) : "—"}
                      {" · "}
                      Spread: {sig.spreadKnown
                        ? `${fmt(sig.spreadPoints, 1)} points`
                        : "—"}
                      {" · "}
                      Touching: {sig.isTouching ? "YES" : "NO"}
                    </div>
                  </div>

                  <div style={{
                    background: hasSignal
                      ? isBuy ? "#16a34a" : "#dc2626"
                      : "#334155",
                    color: "white",
                    padding: "6px 12px",
                    borderRadius: 6,
                    fontWeight: 900,
                    fontSize: 12
                  }}>
                    {sig.direction}
                  </div>
                </div>

                {hasSignal && (
                  <button
                    onClick={() => activateSignal(item)}
                    style={{
                      width: "100%",
                      marginTop: 12,
                      padding: 14,
                      border: "none",
                      borderRadius: 8,
                      fontWeight: 900,
                      fontSize: 14,
                      color: "white",
                      background: isBuy ? "#16a34a" : "#dc2626",
                      cursor: "pointer"
                    }}
                  >
                    {isBuy ? "▲" : "▼"} TAP {sig.direction}
                    {" — "}
                    {liveMode === "LIVE_DEMO"
                      ? `OPEN LIVE DEMO $${stake}`
                      : "OPEN DEMO TRADE"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
