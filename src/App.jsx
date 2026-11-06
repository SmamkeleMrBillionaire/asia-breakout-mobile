
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

// ======================================================
// iFX BILLIONAIRE R10.24
// DERIV PUBLIC MARKETS - SIMULATED DEMO
// FIXED UNDERLYING SYMBOL DISCOVERY
// UI UPDATE: COLLAPSIBLE VALID M15 SIGNALS
// =============================================

// --- iFX NOTIFICATION - PENDING ACTIVATED ---
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}
function sendIFXAlert(title, body) {
  if (navigator.vibrate) navigator.vibrate([300,100,300]);
  try {
    const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
    audio.play().catch(()=>{});
  } catch(e){}
  if ('Notification' in window && Notification.permission === 'granted') {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [300,100,300], requireInteraction: true }));
    } else {
      new Notification(title, { body });
    }
  } else {
    alert(title + ' - ' + body);
  }
}
// Watch for PENDING -> ACTIVATED on screen
setInterval(() => {
  const text = document.body.innerText || '';
  if (text.includes('ACTIVATED') && !window._ifxNotified) {
    window._ifxNotified = true;
    sendIFXAlert('iFX BILLIONAIRE - PENDING ACTIVATED!', 'R10.24 M15 ORANGE BOX - TRADE ACTIVE!');
    setTimeout(()=> window._ifxNotified = false, 60000);
  }
  if (text.includes('PENDING') && !text.includes('ACTIVATED')) {
    window._ifxNotified = false;
  }
}, 2000);

=========

const WS_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const TIMEFRAME = 900;
const CANDLE_COUNT = 220;
const SCAN_INTERVAL = 300000;

const TRADING_START_HOUR = 7;
const TRADING_END_HOUR = 22;

const TP_BOX_MULTIPLIER = 4.0;
const SL_EXTRA_PIPS = 0;
const MAX_SPREAD_POINTS = 300;

const MAX_DAILY_TRADES = 4;
const MAX_OPEN_TRADES = 4;
const PENDING_EXPIRY_SECONDS = 3600;

const PRIORITY_SYMBOLS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF",
  "AUDUSD", "USDCAD", "NZDUSD", "EURJPY",
  "GBPJPY", "EURGBP", "XAUUSD", "US30",
  "NAS100", "AUDCAD", "NZDJPY", "GBPCAD",
  "AUDJPY", "EURAUD", "EURCAD", "NZDCHF",
  "CADJPY"
];

const CATEGORIES = [
  "All", "Forex", "Indices", "Metals",
  "Synthetics", "Crypto", "Stocks", "Other"
];

const fmt = (n, d = 5) =>
  Number.isFinite(Number(n))
    ? Number(n).toFixed(d)
    : "—";

const serverDay = e =>
  new Date(e * 1000).toISOString().slice(0, 10);

const serverHour = e =>
  new Date(e * 1000).getUTCHours();

const serverMinute = e =>
  new Date(e * 1000).getUTCMinutes();

const candleColor = c =>
  c.close > c.open
    ? "GREEN"
    : c.close < c.open
      ? "RED"
      : "NEUTRAL";

const normalizeSymbol = s =>
  String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function priorityMatch(s) {
  const n = normalizeSymbol(s);
  return PRIORITY_SYMBOLS.find(p => n.includes(p)) || null;
}

function priorityIndex(s) {
  const m = priorityMatch(s);
  return m ? PRIORITY_SYMBOLS.indexOf(m) : 999;
}

// ======================================================
// MARKET CATEGORY DETECTION
// ======================================================

function categoryOf(s) {
  const m = [
    s.market,
    s.market_display_name,
    s.submarket,
    s.submarket_display_name,
    s.subgroup,
    s.subgroup_display_name,
    s.symbol_type,
    s.underlying_symbol_type,
    s.display_name,
    s.underlying_symbol_name
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    m.includes("forex") ||
    m.includes("major pairs") ||
    m.includes("minor pairs") ||
    m.includes("exotic pairs")
  ) return "Forex";

  if (
    m.includes("synthetic") ||
    m.includes("derived") ||
    m.includes("volatility") ||
    m.includes("crash") ||
    m.includes("boom") ||
    m.includes("step index") ||
    m.includes("random index")
  ) return "Synthetics";

  if (m.includes("crypto")) return "Crypto";

  if (
    m.includes("indices") ||
    m.includes("index") ||
    m.includes("stock index")
  ) return "Indices";

  if (
    m.includes("commodit") ||
    m.includes("metal") ||
    m.includes("gold") ||
    m.includes("silver")
  ) return "Metals";

  if (
    m.includes("stock") ||
    m.includes("equities") ||
    m.includes("shares")
  ) return "Stocks";

  return "Other";
}

// ======================================================
// PRICE / PIP HELPERS
// ======================================================

function pipSize(sym, cat, candles, mp) {
  const supplied = Number(mp);

  if (
    mp !== null &&
    mp !== undefined &&
    mp !== "" &&
    Number.isFinite(supplied) &&
    supplied > 0
  ) {
    return supplied;
  }

  if (cat === "Forex") {
    return String(sym).toUpperCase().includes("JPY")
      ? 0.01
      : 0.0001;
  }

  const last =
    candles?.[candles.length - 1]?.close || 1;

  const dec = (String(last).split(".")[1] || "").length;

  return Math.pow(10, -Math.min(dec, 8));
}

function pointSize(p) {
  const d = (String(p).split(".")[1] || "").length;
  return Math.pow(10, -Math.min(d, 10));
}

function makeBoxId(t, day, h, l, e = "") {
  return [
    t,
    day,
    Number(h).toPrecision(12),
    Number(l).toPrecision(12),
    e
  ].join("-");
}

function isTradingTime(e) {
  const h = serverHour(e);
  return h >= TRADING_START_HOUR && h < TRADING_END_HOUR;
}

// ======================================================
// RSI
// ======================================================

function calculateRSI(candles, idx, period = 3) {
  if (!candles || idx < period) return null;

  let g = 0;
  let l = 0;

  for (let i = 1; i <= period; i++) {
    const ch = candles[i].close - candles[i - 1].close;

    if (ch > 0) g += ch;
    if (ch < 0) l += Math.abs(ch);
  }

  let ag = g / period;
  let al = l / period;

  for (let i = period + 1; i <= idx; i++) {
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

// ======================================================
// ORANGE BOX
// ======================================================

function buildOrangeBox(candles, day) {
  const f = candles
    .filter(c =>
      serverDay(c.epoch) === day &&
      serverHour(c.epoch) === 0 &&
      [0, 15, 30, 45].includes(serverMinute(c.epoch))
    )
    .sort((a, b) => a.epoch - b.epoch)
    .slice(0, 4);

  if (f.length !== 4) return null;

  const ok = f.every((c, i) =>
    i === 0 || c.epoch - f[i - 1].epoch === TIMEFRAME
  );

  if (!ok) return null;

  const high = Math.max(...f.map(c => c.high));
  const low = Math.min(...f.map(c => c.low));

  if (!(high > low)) return null;

  return {
    type: "ORANGE",
    day,
    high,
    low,
    size: high - low,
    startEpoch: f[0].epoch,
    createdEpoch: f[0].epoch,
    boxId: makeBoxId("ORANGE", day, high, low)
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
  entryLevel,
  reason,
  rsi,
  pendingType
}) {
  return {
    direction,
    strategy,
    boxType: "ORANGE",
    touchType: strategy,
    signalId: `${orangeBox.boxId}|${strategy}|${candle.epoch}`,
    boxId: orangeBox.boxId,
    orangeBoxId: orangeBox.boxId,
    boxHigh: orangeBox.high,
    boxLow: orangeBox.low,
    boxSize: orangeBox.size,
    entryLevel,
    pendingType,
    pip,
    candleTime: candle.epoch,
    candleColor: candleColor(candle),
    rsi,
    reason
  };
}

// ======================================================
// R10.24 SIGNAL ENGINE - NO DOJI
// ======================================================

function findClosedEntrySignal(
  candles,
  symbol,
  category,
  marketPip
) {
  const empty = {
    direction: "NONE",
    reason: "Waiting",
    boxCount: 0
  };

  if (!candles || candles.length < 30) {
    return { ...empty, reason: "Not enough M15" };
  }

  const li = candles.length - 1;
  const candle = candles[li];
  const today = serverDay(candle.epoch);

  const orangeBox = buildOrangeBox(candles, today);

  if (!orangeBox) {
    return {
      ...empty,
      reason: "Waiting for 00:00-01:00 box"
    };
  }

  const pip = pipSize(symbol, category, candles, marketPip);
  const rsi = calculateRSI(candles, li, 3);

  const boxInfo = {
    boxCount: 1,
    boxHigh: orangeBox.high,
    boxLow: orangeBox.low,
    boxSize: orangeBox.size,
    boxId: orangeBox.boxId,
    boxDay: orangeBox.day,
    rsi
  };

  if (candle.epoch < orangeBox.createdEpoch + TIMEFRAME * 4) {
    return {
      ...empty,
      ...boxInfo,
      reason: "Box built, waiting setup"
    };
  }

  if (!isTradingTime(candle.epoch)) {
    return {
      ...empty,
      ...boxInfo,
      reason: "Paused 07-22 UTC"
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

  // A) ORANGE RETEST

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
        entryLevel: candle.high,
        pendingType: "BUY STOP",
        rsi,
        reason: "Red opened above, wicked into box and closed above. Buy Stop on retest candle HIGH."
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
        entryLevel: candle.low,
        pendingType: "SELL STOP",
        rsi,
        reason: "Green opened below, wicked into box and closed below. Sell Stop on retest candle LOW."
      }),
      ...boxInfo
    };
  }

  // B) BREAK-IN

  if (openAbove && color === "RED" && closeInside) {
    return {
      ...makeSignal({
        direction: "SELL",
        strategy: "ORANGE BREAK-IN SELL",
        candle,
        orangeBox,
        pip,
        entryLevel: orangeBox.low - pip,
        pendingType: "SELL STOP",
        rsi,
        reason: "Red opened above and closed inside the Orange Box."
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
        pendingType: "BUY STOP",
        rsi,
        reason: "Green opened below and closed inside the Orange Box."
      }),
      ...boxInfo
    };
  }

  // C) BREAKOUT + FIRST OPPOSITE CANDLE

  for (let shift = 2; shift <= 10; shift++) {
    if (li - shift < 0) break;

    const bC = candles[li - shift];

    const bOpenInside =
      bC.open >= orangeBox.low &&
      bC.open <= orangeBox.high;

    const bCloseAbove = bC.close > orangeBox.high;
    const bCloseBelow = bC.close < orangeBox.low;

    if (!bOpenInside) continue;

    if (bCloseAbove) {
      let redAlready = false;

      for (let k = shift - 1; k > 1; k--) {
        const cc = candles[li - k];

        if (candleColor(cc) === "RED") {
          redAlready = true;
          break;
        }
      }

      if (redAlready) break;

      if (color === "RED") {
        return {
          ...makeSignal({
            direction: "BUY",
            strategy: "BREAKOUT BUY 1ST RED",
            candle,
            orangeBox,
            pip,
            entryLevel: candle.high,
            pendingType: "BUY STOP",
            rsi,
            reason: "Breakout upward from inside. First RED candle after breakout. Buy Stop on its HIGH."
          }),
          ...boxInfo
        };
      }

      break;
    }

    if (bCloseBelow) {
      let greenAlready = false;

      for (let k = shift - 1; k > 1; k--) {
        const cc = candles[li - k];

        if (candleColor(cc) === "GREEN") {
          greenAlready = true;
          break;
        }
      }

      if (greenAlready) break;

      if (color === "GREEN") {
        return {
          ...makeSignal({
            direction: "SELL",
            strategy: "BREAKOUT SELL 1ST GREEN",
            candle,
            orangeBox,
            pip,
            entryLevel: candle.low,
            pendingType: "SELL STOP",
            rsi,
            reason: "Breakout downward from inside. First GREEN candle after breakout. Sell Stop on its LOW."
          }),
          ...boxInfo
        };
      }

      break;
    }
  }

  return {
    ...empty,
    ...boxInfo,
    reason: "No valid closed M15 entry. Waiting."
  };
}

// ======================================================
// LIVE SCANNER STATE
// ======================================================

function getLiveScannerState({
  candles,
  liveCandle,
  price,
  orangeBox
}) {
  if (!orangeBox || !Number.isFinite(price)) {
    return {
      state: "WAITING FOR ORANGE BOX",
      proximity: Infinity,
      touching: false,
      breaking: false
    };
  }

  const current = liveCandle || candles[candles.length - 1];

  if (!current) {
    return {
      state: "WAITING",
      proximity: Infinity,
      touching: false,
      breaking: false
    };
  }

  const touching =
    current.low <= orangeBox.high &&
    current.high >= orangeBox.low;

  if (touching) {
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
      touching: true,
      breaking: false,
      rsi
    };
  }

  const openInside =
    current.open >= orangeBox.low &&
    current.open <= orangeBox.high;

  const closeOutside =
    current.close > orangeBox.high ||
    current.close < orangeBox.low;

  const breaking = openInside && closeOutside;

  if (breaking) {
    return {
      state: "BREAKING ORANGE BOX",
      proximity: 0,
      touching: false,
      breaking: true
    };
  }

  const nearest = Math.min(
    Math.abs(price - orangeBox.high),
    Math.abs(price - orangeBox.low)
  );

  return {
    state: "NOT TOUCHING",
    proximity: nearest,
    touching: false,
    breaking: false
  };
}

// ======================================================
// SPREAD HANDLING
// ======================================================

function getSpreadInfo(
  tick,
  price,
  symbol = "",
  category = "Other",
  marketPip = null
) {
  const hasBid =
    tick?.bid !== null &&
    tick?.bid !== undefined &&
    tick?.bid !== "";

  const hasAsk =
    tick?.ask !== null &&
    tick?.ask !== undefined &&
    tick?.ask !== "";

  const bid = hasBid ? Number(tick.bid) : NaN;
  const ask = hasAsk ? Number(tick.ask) : NaN;

  if (
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0 &&
    ask >= bid
  ) {
    const spread = ask - bid;
    const point = pointSize(price || bid);

    return {
      known: true,
      estimated: false,
      source: "LIVE BID/ASK",
      bid,
      ask,
      spread,
      points: spread / point
    };
  }

  const p = Number(price);

  if (!Number.isFinite(p) || p <= 0) {
    return {
      known: false,
      estimated: true,
      source: "ESTIMATED",
      spread: 0,
      points: 0
    };
  }

  const point = pointSize(p);
  const pip = pipSize(
    symbol,
    category,
    [{ close: p }],
    marketPip
  );

  let estimatedSpread;

  switch (category) {
    case "Forex":
      estimatedSpread = pip * 1.5;
      break;

    case "Metals":
      estimatedSpread = pip * 3;
      break;

    case "Indices":
      estimatedSpread = point * 2;
      break;

    case "Synthetics":
      estimatedSpread = point * 2;
      break;

    case "Crypto":
      estimatedSpread = Math.max(point * 2, p * 0.0005);
      break;

    case "Stocks":
      estimatedSpread = point * 2;
      break;

    default:
      estimatedSpread = point * 2;
      break;
  }

  return {
    known: true,
    estimated: true,
    source: "ESTIMATED",
    bid: null,
    ask: null,
    spread: estimatedSpread,
    points: estimatedSpread / point
  };
}

// ======================================================
// SIMULATED ORDERS
// ======================================================

function alreadyExecuted(trades, signal, symbol) {
  return trades.some(t =>
    t.symbol === symbol &&
    t.signalId === signal.signalId
  );
}

function makeDemoOrder(
  signal,
  symbol,
  category,
  displayName,
  balance,
  riskPct,
  sizingMode,
  fixedLots,
  spreadInfo,
  tick
) {
  if (!spreadInfo?.known) {
    throw new Error("Price unavailable for spread estimate");
  }

  if (
    !spreadInfo.estimated &&
    spreadInfo.points > MAX_SPREAD_POINTS
  ) {
    throw new Error(
      `Live spread ${fmt(spreadInfo.points, 1)} > 300`
    );
  }

  const buy = signal.direction === "BUY";
  const spread = spreadInfo.spread;
  const entry = signal.entryLevel;

  const boxSize = signal.boxSize;
  const extra = SL_EXTRA_PIPS * signal.pip;

  const sl = buy
    ? entry - boxSize - extra - spread
    : entry + boxSize + extra + spread;

  const slD = Math.abs(entry - sl);

  if (!slD) throw new Error("Invalid SL");

  const tpD = boxSize * TP_BOX_MULTIPLIER;

  const tp = buy
    ? entry + tpD
    : entry - tpD;

  const bid = tick?.bid;
  const ask = tick?.ask;

  let pendingType = signal.pendingType || "MARKET";

  if (buy) {
    if (Number.isFinite(ask) && entry > ask) {
      pendingType = "BUY STOP";
    } else {
      pendingType = "BUY LIMIT";
    }
  } else {
    if (Number.isFinite(bid) && entry < bid) {
      pendingType = "SELL STOP";
    } else {
      pendingType = "SELL LIMIT";
    }
  }

  const safeBalance = Math.max(0, Number(balance) || 0);

  const riskMoney =
    sizingMode === "FIXED_LOTS"
      ? safeBalance * 0.01 * (
          (Number(fixedLots) || 0) / 0.10
        )
      : safeBalance * (
          Math.max(0, Number(riskPct) || 0) / 100
        );

  const nowMs = Date.now();
  const ep = Math.floor(nowMs / 1000);

  return {
    id: `${symbol}-${signal.signalId}-${nowMs}`,
    signalId: signal.signalId,
    comment: "Ifx Billionaire R10.24",
    boxId: signal.boxId,
    boxType: "ORANGE",
    strategy: signal.strategy,
    pendingType,
    orderType: pendingType,
    symbol,
    displayName: displayName || symbol,
    category,
    direction: signal.direction,
    entry,
    signalEntryLevel: signal.entryLevel,
    sl,
    tp,
    slDistance: slD,
    tpDistance: tpD,
    boxSize,
    spread,
    spreadPoints: spreadInfo.points,
    spreadEstimated: Boolean(spreadInfo.estimated),
    spreadSource: spreadInfo.source,
    riskMoney,
    rewardRatio: tpD / slD,
    status: "PENDING DEMO TRADE",
    pendingExpiry: nowMs + PENDING_EXPIRY_SECONDS * 1000,
    currentPrice:
      Number.isFinite(bid)
        ? bid
        : Number.isFinite(tick?.quote)
          ? tick.quote
          : entry,
    floatingPnl: 0,
    created: new Date(nowMs).toLocaleTimeString(),
    createdAtMs: nowMs,
    openedEpoch: ep,
    openedDay: serverDay(ep)
  };
}

function calculateDemoPnl(t, p) {
  if (t.status === "PENDING DEMO TRADE") return 0;

  const sd = Math.abs(t.entry - t.sl);
  if (!sd) return 0;

  const mv = t.direction === "BUY"
    ? p - t.entry
    : t.entry - p;

  return (mv / sd) * t.riskMoney;
}

function getExitReason(t, p) {
  if (t.status === "PENDING DEMO TRADE") return null;

  if (t.direction === "BUY") {
    if (p <= t.sl) return "STOP LOSS";
    if (p >= t.tp) return "TAKE PROFIT";
  } else {
    if (p >= t.sl) return "STOP LOSS";
    if (p <= t.tp) return "TAKE PROFIT";
  }

  return null;
}

function getExitPrice(t, r, o) {
  if (r === "STOP LOSS") return t.sl;
  if (r === "TAKE PROFIT") return t.tp;
  return o;
}

// ======================================================
// MAIN APP
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
  const pingTimerRef = useRef(null);

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

  // NEW UI STATE: SIGNALS COLLAPSED BY DEFAULT
  const [signalsCollapsed, setSignalsCollapsed] = useState(true);

  const [progress, setProgress] = useState(0);
  const [scanned, setScanned] = useState(0);

  const [balance, setBalance] = useState(10000);
  const [riskPct, setRiskPct] = useState(1);
  const [fixedLots, setFixedLots] = useState(0.10);
  const [sizingMode, setSizingMode] = useState("RISK_PERCENT");

  const [message, setMessage] = useState(
    "Connect to Deriv Public Market - R10.24"
  );

  const [lastScan, setLastScan] = useState("Not scanned");

  const [clock, setClock] = useState(
    Math.floor(Date.now() / 1000)
  );

  useEffect(() => {
    const t = setInterval(() => {
      setClock(Math.floor(Date.now() / 1000));
    }, 1000);

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

  // ====================================================
  // REQUEST MANAGER
  // ====================================================

  const request = useCallback(payload =>
    new Promise((resolve, reject) => {
      const ws = socketRef.current;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to Deriv"));
        return;
      }

      const id = ++requestRef.current;

      const timeout = setTimeout(() => {
        pendingRequestsRef.current.delete(id);
        reject(
          new Error(
            `Deriv request timeout: ${Object.keys(payload).join(", ")}`
          )
        );
      }, 20000);

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
      } catch (e) {
        clearTimeout(timeout);
        pendingRequestsRef.current.delete(id);
        reject(e);
      }
    }), []);

  // ====================================================
  // TICK PROCESSING
  // ====================================================

  const processTick = useCallback((symbol, tick) => {
    if (!symbol || !tick) return;

    const quote = Number(tick.quote);
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);

    const usable =
      Number.isFinite(bid) && bid > 0
        ? bid
        : quote;

    if (!Number.isFinite(usable) || usable <= 0) return;

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
      if (orig.symbol !== symbol) {
        remaining.push(orig);
        continue;
      }

      if (orig.status === "PENDING DEMO TRADE") {
        const expired = Date.now() > orig.pendingExpiry;

        if (expired) {
          newlyClosed.push({
            ...orig,
            status: "CLOSED",
            exitPrice: orig.entry,
            exitReason: "PENDING EXPIRED",
            realisedPnl: 0,
            floatingPnl: 0,
            closedAt: new Date().toLocaleTimeString()
          });

          continue;
        }

        let shouldActivate = false;

        if (orig.pendingType === "BUY STOP") {
          shouldActivate = usable >= orig.entry;
        } else if (orig.pendingType === "BUY LIMIT") {
          shouldActivate = usable <= orig.entry;
        } else if (orig.pendingType === "SELL STOP") {
          shouldActivate = usable <= orig.entry;
        } else if (orig.pendingType === "SELL LIMIT") {
          shouldActivate = usable >= orig.entry;
        } else {
          shouldActivate = orig.direction === "BUY"
            ? usable >= orig.entry
            : usable <= orig.entry;
        }

        if (shouldActivate) {
          remaining.push({
            ...orig,
            status: "OPEN DEMO TRADE",
            currentPrice: usable,
            activatedAt: new Date().toLocaleTimeString(),
            floatingPnl: 0
          });

          setMessage(
            `${orig.displayName} ${orig.pendingType} ACTIVATED at ${fmt(orig.entry, 5)}`
          );

          continue;
        }

        remaining.push(orig);
        continue;
      }

      if (orig.status !== "OPEN DEMO TRADE") {
        remaining.push(orig);
        continue;
      }

      const trade = {
        ...orig,
        currentPrice: usable
      };

      const reason = getExitReason(trade, usable);

      if (reason) {
        const ep = getExitPrice(trade, reason, usable);
        const pnl = calculateDemoPnl(trade, ep);

        newlyClosed.push({
          ...trade,
          status: "CLOSED",
          exitPrice: ep,
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
      updateClosedTrades(p => [
        ...newlyClosed,
        ...p
      ]);

      setMessage(
        newlyClosed.map(t =>
          `${t.displayName} ${t.exitReason}: ${t.realisedPnl >= 0 ? "+" : ""}$${fmt(t.realisedPnl, 2)}`
        ).join(" · ")
      );
    }
  }, [updateOrders, updateClosedTrades]);

  // ====================================================
  // RECONNECTION
  // ====================================================

  const scheduleReconnect = useCallback(() => {
    if (!runningRef.current || reconnectTimerRef.current) return;

    setConnectionText("RECONNECTING");

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;

      if (runningRef.current) {
        window.dispatchEvent(
          new Event("ifx-robot-reconnect")
        );
      }
    }, 5000);
  }, []);

  // ====================================================
  // DERIV CONNECTION
  // ====================================================

  const connect = useCallback(() => {
    const existing = socketRef.current;

    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (connectionPromiseRef.current) {
      return connectionPromiseRef.current;
    }

    setConnectionText("CONNECTING TO DERIV PUBLIC DATA...");

    let ws;

    try {
      ws = new WebSocket(WS_URL);
      socketRef.current = ws;
    } catch (e) {
      setConnected(false);
      setConnectionText("WEBSOCKET CREATION FAILED");

      return Promise.reject(
        new Error(`WebSocket creation failed: ${e.message}`)
      );
    }

    let cp;

    cp = new Promise((resolve, reject) => {
      let settled = false;
      let connectionTimeout = null;

      const clearConnection = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }

        if (connectionPromiseRef.current === cp) {
          connectionPromiseRef.current = null;
        }
      };

      const failConnection = error => {
        if (settled) return;

        settled = true;
        clearConnection();

        setConnected(false);
        setConnectionText("CONNECTION FAILED");

        reject(error);
      };

      connectionTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          failConnection(
            new Error(
              "Deriv connection timeout after 20 seconds. Check internet access and whether your hosting provider allows WebSocket connections."
            )
          );

          try {
            ws.close();
          } catch {}
        }
      }, 20000);

      ws.onopen = () => {
        if (socketRef.current !== ws) {
          ws.close();
          return;
        }

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }

        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
        }

        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ ping: 1 }));
            } catch {}
          }
        }, 30000);

        setConnected(true);
        setConnectionText("DERIV PUBLIC MARKET CONNECTED");

        clearConnection();

        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = ev => {
        if (socketRef.current !== ws) return;

        let d;

        try {
          d = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (d.msg_type === "tick" && d.tick) {
          processTick(d.tick.symbol, d.tick);
        }

        if (
          d.req_id !== undefined &&
          pendingRequestsRef.current.has(d.req_id)
        ) {
          const p = pendingRequestsRef.current.get(d.req_id);

          clearTimeout(p.timeout);
          pendingRequestsRef.current.delete(d.req_id);

          if (d.error) {
            p.reject(
              new Error(d.error.message || "Deriv API request failed")
            );
          } else {
            p.resolve(d);
          }
        }
      };

      ws.onerror = () => {
        if (socketRef.current !== ws) return;

        setConnectionText("WEBSOCKET NETWORK ERROR");

        failConnection(
          new Error(
            "The browser could not establish a reliable Deriv WebSocket connection. Check your internet connection, browser and hosting restrictions."
          )
        );
      };

      ws.onclose = event => {
        if (socketRef.current !== ws) return;

        socketRef.current = null;

        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }

        setConnected(false);

        setConnectionText(
          `DISCONNECTED - CODE ${event.code || "UNKNOWN"}`
        );

        subscriptionsRef.current.clear();
        subscribingRef.current.clear();

        pendingRequestsRef.current.forEach(p => {
          clearTimeout(p.timeout);
          p.reject(new Error("Deriv connection closed"));
        });

        pendingRequestsRef.current.clear();

        clearConnection();

        const detail = event.reason
          ? ` ${event.reason}`
          : "";

        if (runningRef.current) {
          scheduleReconnect();
        }

        failConnection(
          new Error(
            `Deriv disconnected. Code: ${event.code || "unknown"}.${detail || " No server reason supplied."}`
          )
        );
      };
    });

    connectionPromiseRef.current = cp;

    return cp;
  }, [processTick, scheduleReconnect]);

  // ====================================================
  // MARKET SUBSCRIPTIONS
  // ====================================================

  const subscribeMarket = useCallback(async sym => {
    if (subscriptionsRef.current.has(sym)) return true;
    if (subscribingRef.current.has(sym)) return false;

    if (
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN
    ) {
      return false;
    }

    subscribingRef.current.add(sym);

    try {
      const res = await request({
        ticks: sym,
        subscribe: 1
      });

      if (res.error) {
        throw new Error(res.error.message);
      }

      const sid = res.subscription?.id || "SUBSCRIBED";

      subscriptionsRef.current.set(sym, sid);

      if (res.tick) {
        processTick(res.tick.symbol || sym, res.tick);
      }

      return true;
    } catch (e) {
      setMessage(`${sym}: subscription failed - ${e.message}`);
      return false;
    } finally {
      subscribingRef.current.delete(sym);
    }
  }, [request, processTick]);

  // ====================================================
  // MARKET DISCOVERY - R10.24 FIX
  // ====================================================

  const discoverMarkets = useCallback(async () => {
    setMessage("Requesting Deriv active market list...");

    const res = await request({
      active_symbols: "brief"
    });

    if (res.error) {
      throw new Error(
        `Deriv market discovery error: ${
          res.error.message || "Unknown API error"
        }`
      );
    }

    const raw =
      res.active_symbols ??
      res.data?.active_symbols ??
      res.active_symbols_list ??
      res.data?.active_symbols_list ??
      [];

    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(
        `Deriv returned no market array. Response: ${
          JSON.stringify(res).slice(0, 700)
        }`
      );
    }

    const list = raw
      .filter(s => {
        if (!s) return false;

        const symbol =
          s.underlying_symbol ||
          s.symbol;

        if (
          typeof symbol !== "string" ||
          !symbol.trim()
        ) {
          return false;
        }

        const suspended =
          Number(s.is_trading_suspended ?? 0);

        const exchangeOpen =
          Number(s.exchange_is_open ?? 1);

        return suspended !== 1 && exchangeOpen !== 0;
      })
      .map(s => {
        const symbol = (
          s.underlying_symbol ||
          s.symbol
        ).trim();

        const normalized = {
          ...s,
          symbol,

          display_name:
            s.underlying_symbol_name ||
            s.display_name ||
            s.symbol_name ||
            symbol,

          market:
            s.market ||
            s.market_display_name ||
            "other",

          category: "Other",

          pip:
            s.pip_size ||
            s.pip ||
            null
        };

        normalized.category = categoryOf(normalized);
        normalized.prioritySymbol = priorityMatch(symbol);
        normalized.priority = priorityIndex(symbol);

        return normalized;
      })
      .sort((a, b) =>
        a.priority !== b.priority
          ? a.priority - b.priority
          : String(a.display_name).localeCompare(
              String(b.display_name)
            )
      );

    if (!list.length) {
      const sample = JSON.stringify(raw[0] || {}).slice(0, 700);

      throw new Error(
        `Deriv returned ${raw.length} markets, but none passed the filter. First item: ${sample}`
      );
    }

    marketsRef.current = list;

    setSymbols(list);
    setScanned(0);
    setProgress(0);

    const categoryCounts = list.reduce((acc, item) => {
      acc[item.category] =
        (acc[item.category] || 0) + 1;

      return acc;
    }, {});

    const categorySummary = Object.entries(categoryCounts)
      .map(([name, count]) => `${name}: ${count}`)
      .join(" · ");

    setMessage(
      `SUCCESS: ${list.length} active Deriv markets discovered. ${categorySummary}`
    );

    return list;
  }, [request]);

  // ====================================================
  // M15 MARKET SCANNER
  // ====================================================

  const scanSymbol = useCallback(async item => {
    try {
      const res = await request({
        ticks_history: item.symbol,
        count: CANDLE_COUNT,
        end: "latest",
        style: "candles",
        granularity: TIMEFRAME
      });

      if (res.error) {
        throw new Error(res.error.message);
      }

      const raw = Array.isArray(res.candles)
        ? res.candles
        : [];

      const candles = raw
        .map(c => ({
          epoch: Number(c.epoch),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close)
        }))
        .filter(c =>
          Number.isFinite(c.epoch) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.close) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          c.high >= c.low
        )
        .sort((a, b) => a.epoch - b.epoch);

      const now = Math.floor(Date.now() / 1000);

      const closed = candles.filter(
        c => c.epoch + TIMEFRAME <= now
      );

      const liveCandles = candles.filter(
        c => c.epoch + TIMEFRAME > now
      );

      const liveCandle =
        liveCandles[liveCandles.length - 1] || null;

      const signal = findClosedEntrySignal(
        closed,
        item.symbol,
        item.category,
        item.pip
      );

      const curClosed = closed[closed.length - 1];
      const today = serverDay(now);

      const orangeBox = buildOrangeBox(closed, today);

      const tick = latestTicksRef.current[item.symbol];

      const livePrice =
        Number.isFinite(tick?.bid)
          ? tick.bid
          : Number.isFinite(tick?.quote)
            ? tick.quote
            : liveCandle?.close ?? curClosed?.close ?? null;

      const scanner = getLiveScannerState({
        candles: closed,
        liveCandle,
        price: livePrice,
        orangeBox
      });

      const spreadInfo = getSpreadInfo(
        tick,
        livePrice,
        item.symbol,
        item.category,
        item.pip
      );

      return {
        ...signal,
        scannerState: scanner.state,
        scannerProximity: scanner.proximity,
        isTouching: scanner.touching,
        isBreaking: scanner.breaking,
        livePrice,
        spreadKnown: spreadInfo.known,
        spreadEstimated: spreadInfo.estimated,
        spreadSource: spreadInfo.source,
        spreadPoints: spreadInfo.points,
        spread: spreadInfo.spread,
        orangeBox,
        liveCandle,
        chartCandles: closed
      };
    } catch (e) {
      return {
        direction: "NONE",
        reason: e.message || "Data unavailable",
        boxCount: 0,
        scannerState: "DATA ERROR",
        scannerProximity: Infinity,
        isTouching: false,
        isBreaking: false
      };
    }
  }, [request]);

  // ====================================================
  // SCAN ALL MARKETS
  // ====================================================

  const scanAll = useCallback(async list => {
    if (!runningRef.current || !list?.length) return;

    if (scanLockRef.current) {
      rescanRequestedRef.current = true;
      return;
    }

    scanLockRef.current = true;

    setMessage(
      "Scanning Deriv markets - M15 - Orange Box only..."
    );

    setScanned(0);
    setProgress(0);

    const results = {};

    let completed = 0;
    let failed = 0;
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

        if (r.scannerState === "DATA ERROR") {
          failed++;
        }

        completed++;

        setScanned(completed);

        setProgress(
          Math.round(completed / list.length * 100)
        );

        if (completed % 5 === 0) {
          setSignals(p => ({
            ...p,
            ...results
          }));

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
                  spreadEstimated: v.spreadEstimated,
                  spreadSource: v.spreadSource,
                  spreadPoints: v.spreadPoints,
                  touching: v.isTouching,
                  breaking: v.isBreaking
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

      if (!runningRef.current) return;

      setSignals(p => ({
        ...p,
        ...results
      }));

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
              spreadEstimated: v.spreadEstimated,
              spreadSource: v.spreadSource,
              spreadPoints: v.spreadPoints,
              touching: v.isTouching,
              breaking: v.isBreaking
            }
          ])
        )
      }));

      setMessage(
        `Scan complete: ${completed}/${list.length} markets · ${failed} data errors · R10.24`
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

  // ====================================================
  // START ROBOT
  // ====================================================

  const startRobot = async () => {
    if (runningRef.current) return;

    try {
      setMessage("Connecting to Deriv public markets...");

      await connect();

      runningRef.current = true;
      setRunning(true);

      setSignals({});
      setScannerStates({});
      setScanned(0);
      setProgress(0);

      const list = await discoverMarkets();

      if (!runningRef.current || !list.length) {
        return;
      }

      const prio = list.filter(i => i.prioritySymbol);

      for (const it of prio) {
        if (!runningRef.current) break;
        await subscribeMarket(it.symbol);
      }

      if (!runningRef.current) return;

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
        "Robot running R10.24 - Public markets - 5 MIN scan - NO DOJI"
      );
    } catch (e) {
      runningRef.current = false;
      setRunning(false);

      setConnectionText(
        socketRef.current?.readyState === WebSocket.OPEN
          ? "CONNECTED - MARKET DISCOVERY FAILED"
          : "DISCONNECTED"
      );

      setMessage(e.message || "Unable to start robot");
    }
  };

  // ====================================================
  // STOP ROBOT
  // ====================================================

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
      if (
        o.status !== "OPEN DEMO TRADE" &&
        o.status !== "PENDING DEMO TRADE"
      ) {
        continue;
      }

      const price =
        latestPricesRef.current[o.symbol] ??
        o.currentPrice ??
        o.entry;

      closedNow.push({
        ...o,
        status: "CLOSED",
        exitPrice: price,
        exitReason: "ROBOT STOPPED",
        realisedPnl:
          o.status === "PENDING DEMO TRADE"
            ? 0
            : calculateDemoPnl(o, price),
        floatingPnl: 0,
        closedAt: now
      });
    }

    if (closedNow.length) {
      updateClosedTrades(p => [
        ...closedNow,
        ...p
      ]);
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
      `STOPPED. ${closedNow.length} simulated trades closed.`
    );
  };

  // ====================================================
  // SIGNAL ACTIVATION
  // ====================================================

  const activateSignal = async item => {
    const signal = signals[item.symbol];

    if (
      !signal ||
      signal.direction === "NONE"
    ) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    if (!isTradingTime(now)) {
      setMessage("Trading paused: UTC 07:00-21:59");
      return;
    }

    const lockKey =
      `${item.symbol}|${signal.signalId}`;

    if (activationLocksRef.current.has(lockKey)) return;

    activationLocksRef.current.add(lockKey);

    try {
      const prev = [
        ...ordersRef.current,
        ...closedTradesRef.current
      ];

      const today = serverDay(now);

      const daily = prev.filter(
        t => t.openedDay === today
      );

      const openCount = ordersRef.current.filter(
        t =>
          t.status === "OPEN DEMO TRADE" ||
          t.status === "PENDING DEMO TRADE"
      ).length;

      if (daily.length >= MAX_DAILY_TRADES) {
        setMessage(`Daily limit ${MAX_DAILY_TRADES}`);
        return;
      }

      if (openCount >= MAX_OPEN_TRADES) {
        setMessage(`Open limit ${MAX_OPEN_TRADES}`);
        return;
      }

      if (alreadyExecuted(prev, signal, item.symbol)) {
        setMessage("This signal has already been traded");
        return;
      }

      const sub = await subscribeMarket(item.symbol);

      if (!sub) {
        setMessage("Unable to subscribe to live market");
        return;
      }

      const tick = latestTicksRef.current[item.symbol];

      const curPrice =
        Number.isFinite(tick?.bid)
          ? tick.bid
          : tick?.quote;

      if (!Number.isFinite(curPrice) || curPrice <= 0) {
        setMessage("Waiting for a live market price");
        return;
      }

      const spreadInfo = getSpreadInfo(
        tick,
        curPrice,
        item.symbol,
        item.category,
        item.pip
      );

      if (!spreadInfo.known) {
        setMessage("Unable to calculate spread. Waiting for price.");
        return;
      }

      if (
        !spreadInfo.estimated &&
        spreadInfo.points > MAX_SPREAD_POINTS
      ) {
        setMessage("Live spread too high");
        return;
      }

      const order = makeDemoOrder(
        signal,
        item.symbol,
        item.category,
        item.display_name,
        balance,
        riskPct,
        sizingMode,
        fixedLots,
        spreadInfo,
        tick
      );

      updateOrders(p => [
        order,
        ...p
      ]);

      setLastActivated(
        `${signal.direction} · ${signal.strategy} · ${order.pendingType}`
      );

      setMessage(
        `${item.display_name}: ${order.pendingType} ${signal.direction} at ${fmt(order.entry, 5)} · ${spreadInfo.estimated ? "EST. SPREAD" : "LIVE SPREAD"} · SL ${fmt(order.sl, 5)} · TP ${fmt(order.tp, 5)}`
      );
    } catch (e) {
      setMessage(`${item.symbol}: ${e.message}`);
    } finally {
      activationLocksRef.current.delete(lockKey);
    }
  };

  // ====================================================
  // CONNECTION RECOVERY
  // ====================================================

  useEffect(() => {
    const recover = async () => {
      if (
        !runningRef.current ||
        reconnectingRef.current
      ) {
        return;
      }

      const ws = socketRef.current;

      if (
        ws &&
        ws.readyState === WebSocket.OPEN
      ) {
        if (marketsRef.current.length) {
          await scanAll(marketsRef.current);
        }

        return;
      }

      reconnectingRef.current = true;

      try {
        await connect();

        if (!runningRef.current) return;

        const openSyms = [
          ...new Set(
            ordersRef.current
              .filter(o =>
                o.status === "OPEN DEMO TRADE" ||
                o.status === "PENDING DEMO TRADE"
              )
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

        for (
          const s of [...new Set([...prioSyms, ...openSyms])]
        ) {
          if (!runningRef.current) break;
          await subscribeMarket(s);
        }

        if (!runningRef.current) return;

        let list = marketsRef.current;

        if (!list.length) {
          list = await discoverMarkets();
        }

        if (runningRef.current && list.length) {
          await scanAll(list);
        }
      } catch (e) {
        if (runningRef.current) {
          setMessage(`Reconnect failed: ${e.message}`);
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

    document.addEventListener(
      "visibilitychange",
      hV
    );

    return () => {
      window.removeEventListener("ifx-robot-reconnect", hR);
      window.removeEventListener("online", hO);

      document.removeEventListener(
        "visibilitychange",
        hV
      );
    };
  }, [
    connect,
    scanAll,
    subscribeMarket,
    discoverMarkets,
    scheduleReconnect
  ]);

  // ====================================================
  // CLEANUP
  // ====================================================

  useEffect(() => {
    return () => {
      runningRef.current = false;

      if (scanTimerRef.current) {
        clearInterval(scanTimerRef.current);
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
      }

      pendingRequestsRef.current.forEach(p => {
        clearTimeout(p.timeout);
        p.reject(new Error("App closed"));
      });

      pendingRequestsRef.current.clear();

      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {}
      }
    };
  }, []);

  // ====================================================
  // VISIBLE SIGNALS
  // ====================================================

  const touchingSymbols = useMemo(() => {
    return symbols
      .filter(item => {
        const sig = signals[item.symbol];

        if (!sig) return false;

        if (
          sig.direction !== "BUY" &&
          sig.direction !== "SELL"
        ) {
          return false;
        }

        const sc = scannerStates[item.symbol];

        if (!sc) return false;

        const breakoutSignal =
          String(sig.strategy || "").startsWith("BREAKOUT ");

        if (
          !sc.touching &&
          !sc.breaking &&
          !breakoutSignal
        ) {
          return false;
        }

        if (
          category !== "All" &&
          item.category !== category
        ) {
          return false;
        }

        const term = search.toLowerCase();

        if (
          term &&
          !String(item.display_name || "")
            .toLowerCase()
            .includes(term) &&
          !String(item.symbol || "")
            .toLowerCase()
            .includes(term)
        ) {
          return false;
        }

        return true;
      })
      .sort((a, b) => a.priority - b.priority);
  }, [
    symbols,
    signals,
    scannerStates,
    category,
    search
  ]);

  const visibleSymbols = touchingSymbols;

  const openTrades = orders.filter(o =>
    o.status === "OPEN DEMO TRADE" ||
    o.status === "PENDING DEMO TRADE"
  );

  const floatingPnl = openTrades.reduce(
    (s, t) => s + (t.floatingPnl || 0),
    0
  );

  const isTradingHours = isTradingTime(clock);
  const todayDay = serverDay(clock);

  const dailyCount = [
    ...orders,
    ...closedTrades
  ].filter(t => t.openedDay === todayDay).length;

  const realisedPnl = closedTrades.reduce(
    (s, t) => s + (Number(t.realisedPnl) || 0),
    0
  );

  // ====================================================
  // USER INTERFACE
  // ====================================================

  return (
    <div style={{
      background: "#0a0f1a",
      minHeight: "100vh",
      color: "#e6edf7",
      fontFamily: "system-ui",
      paddingBottom: 30
    }}>

      {/* HEADER */}

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
            fontWeight: 900
          }}>
            iFX BILLIONAIRE R10.24
          </div>

          <div style={{
            fontSize: 9,
            color: "#8a9bb5"
          }}>
            M15 • NO DOJI • ORANGE BOX ONLY • SIMULATED DEMO
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

      {/* ROBOT CONTROL */}

      <div style={{
        background: "#131e32",
        border: "1px solid #24334b",
        borderRadius: 12,
        margin: 12,
        padding: 14
      }}>
        <div style={{
          fontSize: 12,
          fontWeight: 900
        }}>
          ROBOT CONTROL - R10.24 - 5 MIN SCAN
        </div>

        <div style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          margin: "10px 0",
          fontSize: 11,
          flexWrap: "wrap"
        }}>
          <span style={{
            color: connected ? "#4ade80" : "#ff6b6b"
          }}>
            ● {connectionText}
          </span>

          <span style={{
            background: "#4a3a12",
            color: "#fbbf24",
            padding: "3px 8px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 800
          }}>
            SIMULATED DEMO - R10.24
          </span>
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
          overflowWrap: "anywhere"
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
            width: `${progress}%`,
            transition: "width .2s"
          }} />
        </div>

        <div style={{
          fontSize: 11,
          color: "#8a9bb5"
        }}>
          Scan: {scanned}/{symbols.length} · {progress}% · Every 5 MIN · UTC: {new Date(clock * 1000).toISOString().slice(11, 19)} · Last: {lastScan}
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
          TRADING: {isTradingHours ? "ACTIVE" : "PAUSED"} · 07:00-21:59 UTC · R10.24 NO DOJI
        </div>

        {/* ACCOUNT SETTINGS */}

        <div style={{
          display: "flex",
          gap: 8,
          marginTop: 12,
          fontSize: 11,
          flexWrap: "wrap"
        }}>
          <label>
            Balance $
            <input
              type="number"
              value={balance}
              onChange={e => setBalance(Number(e.target.value))}
              style={{
                width: 80,
                background: "#0f172a",
                color: "white",
                border: "1px solid #334155",
                borderRadius: 4,
                padding: 4
              }}
            />
          </label>

          <label>
            Risk %
            <input
              type="number"
              value={riskPct}
              onChange={e => setRiskPct(Number(e.target.value))}
              style={{
                width: 50,
                background: "#0f172a",
                color: "white",
                border: "1px solid #334155",
                borderRadius: 4,
                padding: 4
              }}
            />
          </label>

          <label>
            Lots
            <input
              type="number"
              step="0.01"
              value={fixedLots}
              onChange={e => setFixedLots(Number(e.target.value))}
              style={{
                width: 60,
                background: "#0f172a",
                color: "white",
                border: "1px solid #334155",
                borderRadius: 4,
                padding: 4
              }}
            />
          </label>
        </div>

        {/* ACCOUNT SUMMARY */}

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(2,minmax(0,1fr))",
          gap: 8,
          marginTop: 14
        }}>
          <div style={{
            background: "#0f172a",
            padding: 10,
            borderRadius: 8
          }}>
            <div style={{
              color: "#94a3b8",
              fontSize: 10
            }}>
              OPEN / PENDING
            </div>
            <b>{openTrades.length}</b>
          </div>

          <div style={{
            background: "#0f172a",
            padding: 10,
            borderRadius: 8
          }}>
            <div style={{
              color: "#94a3b8",
              fontSize: 10
            }}>
              DAILY TRADES
            </div>
            <b>{dailyCount}/{MAX_DAILY_TRADES}</b>
          </div>

          <div style={{
            background: "#0f172a",
            padding: 10,
            borderRadius: 8
          }}>
            <div style={{
              color: "#94a3b8",
              fontSize: 10
            }}>
              FLOATING P/L
            </div>
            <b style={{
              color: floatingPnl >= 0 ? "#4ade80" : "#f87171"
            }}>
              ${fmt(floatingPnl, 2)}
            </b>
          </div>

          <div style={{
            background: "#0f172a",
            padding: 10,
            borderRadius: 8
          }}>
            <div style={{
              color: "#94a3b8",
              fontSize: 10
            }}>
              REALISED P/L
            </div>
            <b style={{
              color: realisedPnl >= 0 ? "#4ade80" : "#f87171"
            }}>
              ${fmt(realisedPnl, 2)}
            </b>
          </div>
        </div>
      </div>

      {/* VALID SIGNALS PANEL */}

      <div style={{
        background: "#131e32",
        border: "1px solid #24334b",
        borderRadius: 12,
        margin: 12,
        padding: 14
      }}>

        {/* COLLAPSIBLE HEADING */}

        <button
          onClick={() => setSignalsCollapsed(v => !v)}
          aria-expanded={!signalsCollapsed}
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            background: "#0f172a",
            color: "#e6edf7",
            border: "1px solid #334155",
            borderRadius: 8,
            padding: 13,
            fontSize: 12,
            fontWeight: 900,
            textAlign: "left",
            cursor: "pointer"
          }}
        >
          <span>
            VALID M15 SIGNALS - ORANGE BOX STRATEGIES - R10.24
          </span>

          <span style={{
            color: "#fbbf24",
            fontSize: 16,
            flexShrink: 0
          }}>
            {signalsCollapsed ? "▼" : "▲"}
          </span>
        </button>

        {/* COLLAPSIBLE SIGNAL CONTENT */}

        {!signalsCollapsed && (
          <>

            <p style={{
              fontSize: 11,
              color: "#8a9bb5",
              marginTop: 8
            }}>
              No Doji. A) Retest High/Low, B) Break-in, C) Breakout + 1st Red/Green. Breakout signals do not require a current box touch. Scan every 5 min.
            </p>

            <div style={{
              background: "#332b16",
              border: "1px solid #66501b",
              borderRadius: 7,
              padding: 9,
              color: "#fbbf24",
              fontSize: 10,
              marginTop: 8
            }}>
              SPREAD MODE: ESTIMATED WHEN LIVE BID/ASK IS UNAVAILABLE.
              Estimated spreads are modelling assumptions, not confirmed market spreads.
              P/L and risk are simulated estimates, not broker-calculated values.
            </div>

            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search..."
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
              {CATEGORIES.map(c => (
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

            <div style={{
              marginTop: 10
            }}>
              {visibleSymbols.length === 0 && (
                <div style={{
                  padding: 20,
                  textAlign: "center",
                  color: "#64748b",
                  fontSize: 12
                }}>
                  {symbols.length === 0
                    ? "No markets loaded. Press START ROBOT to connect."
                    : "No valid M15 Orange Box signals currently available."}

                  <br />

                  Scanner runs every 5 min. R10.24 - No Doji.
                </div>
              )}

              {visibleSymbols.map(item => {
                const sig = signals[item.symbol];

                if (!sig) return null;

                const isBuy = sig.direction === "BUY";
                const sc = scannerStates[item.symbol];

                return (
                  <div
                    key={item.symbol}
                    style={{
                      background: "#0f172a",
                      border: "1px solid #1e293b",
                      borderRadius: 8,
                      padding: 12,
                      marginTop: 10
                    }}
                  >
                    <div style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8
                    }}>
                      <div style={{
                        minWidth: 0
                      }}>
                        <b>
                          {item.display_name || item.symbol} {item.prioritySymbol ? "*" : ""}
                        </b>

                        <div style={{
                          fontSize: 10,
                          color: "#94a3b8"
                        }}>
                          {item.symbol} · {item.category} · {sc?.state} · {sig.pendingType}
                        </div>

                        <div style={{
                          fontSize: 11,
                          color: "#fbbf24",
                          fontWeight: 800,
                          marginTop: 6
                        }}>
                          {sig.strategy}
                        </div>

                        <div style={{
                          fontSize: 11,
                          color: "#cbd5e1",
                          marginTop: 4
                        }}>
                          {sig.reason}
                        </div>

                        <div style={{
                          fontSize: 11,
                          marginTop: 6
                        }}>
                          ORANGE HIGH {fmt(sig.boxHigh, 5)} · LOW {fmt(sig.boxLow, 5)}
                        </div>

                        <div style={{
                          fontSize: 11,
                          color: "#fbbf24",
                          fontWeight: 700
                        }}>
                          ENTRY: {fmt(sig.entryLevel, 5)} · {sig.pendingType} · SL BoxSize+spread · TP 4x Box
                        </div>

                        <div style={{
                          fontSize: 10,
                          color: "#fbbf24",
                          marginTop: 4
                        }}>
                          {sc?.spreadEstimated
                            ? "ESTIMATED SPREAD"
                            : sc?.spreadKnown
                              ? "LIVE BID/ASK SPREAD"
                              : "SPREAD NOT YET AVAILABLE"}
                          {Number.isFinite(sc?.spreadPoints)
                            ? ` · ${fmt(sc.spreadPoints, 1)} points`
                            : ""}
                        </div>
                      </div>

                      <div style={{
                        background: isBuy ? "#16a34a" : "#dc2626",
                        color: "white",
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontWeight: 900,
                        fontSize: 12,
                        height: "fit-content"
                      }}>
                        {sig.direction}
                      </div>
                    </div>

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
                        background: isBuy ? "#16a34a" : "#dc2626"
                      }}
                    >
                      {isBuy ? "▲" : "▼"} TAP {sig.direction} — {sig.pendingType}
                    </button>
                  </div>
                );
              })}
            </div>

          </>
        )}

        {/* OPEN TRADES - ALWAYS VISIBLE */}

        {openTrades.length > 0 && (
          <div style={{
            marginTop: 16
          }}>
            <b style={{
              fontSize: 12
            }}>
              OPEN / PENDING - R10.24
            </b>

            {openTrades.map(t => (
              <div
                key={t.id}
                style={{
                  background: "#0f172a",
                  padding: 10,
                  borderRadius: 8,
                  marginTop: 8,
                  fontSize: 11
                }}
              >
                <b>{t.displayName}</b> {t.direction} {t.pendingType}

                <br />

                ENTRY {fmt(t.entry, 5)} · SL {fmt(t.sl, 5)} · TP {fmt(t.tp, 5)}

                <br />

                SPREAD: {t.spreadEstimated ? "ESTIMATED" : "LIVE BID/ASK"} · {fmt(t.spreadPoints, 1)} points

                <br />

                {t.status} · P/L ${fmt(t.floatingPnl, 2)}
              </div>
            ))}
          </div>
        )}

        {/* CLOSED TRADES - ALWAYS VISIBLE */}

        {closedTrades.length > 0 && (
          <div style={{
            marginTop: 12
          }}>
            <b style={{
              fontSize: 12
            }}>
              CLOSED TRADES
            </b>

            {closedTrades.slice(0, 10).map(t => (
              <div
                key={t.id}
                style={{
                  background: "#0f172a",
                  padding: 8,
                  borderRadius: 6,
                  marginTop: 6,
                  fontSize: 11
                }}
              >
                {t.displayName} {t.direction} {t.exitReason}

                <span style={{
                  color: t.realisedPnl >= 0 ? "#4ade80" : "#f87171",
                  fontWeight: 800
                }}>
                  {" "}${fmt(t.realisedPnl, 2)}
                </span>

                <div style={{
                  color: "#fbbf24",
                  fontSize: 10,
                  marginTop: 3
                }}>
                  {t.spreadEstimated ? "ESTIMATED SPREAD" : "LIVE BID/ASK SPREAD"}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>

      <div style={{
        textAlign: "center",
        color: "#64748b",
        fontSize: 10,
        padding: 12
      }}>
        iFX BILLIONAIRE R10.24 · DERIV PUBLIC DATA · SIMULATED EXECUTION ONLY
      </div>
    </div>
  );
}
