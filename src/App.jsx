
import React, { useMemo, useState } from "react";

// ==================================================
// ASIA BREAKOUT MOBILE
// V6.11 - EXACT 10-STEP STRATEGY PORT
// DEMO CANDLE REPLAY ONLY - NO BROKER CONNECTION
// ==================================================

const DEFAULTS = {
  asiaStart: 0,
  asiaEnd: 7,
  tradeStart: 9,
  tradeEnd: 19,
  tradeOnlyAfterAsia: true,

  riskPct: 1,
  useRiskPercent: true,
  fixedLots: 0.10,

  fixedSL: 10,
  forexTP: 31,
  otherTPPoints: 1000,

  pendingBuffer: 2,
  pendingExpiryMinutes: 60,

  maxTrades: 1,
  oneDirectionOnly: true,
  oneTradePerSignal: true,

  useEmaFilter: true,
  emaPeriods: [35, 60, 90, 200, 120, 1068],
  emaDistancePoints: 10,

  useRSIFilter: false,
  rsiPeriod: 14,

  wickPercent: 20,
  dojiBodyPercent: 25,
  maxBoxes: 3,
  deleteOnTouch: 3,

  breakevenPips: 25,
  spreadPips: 1.5,
  trailingExtraPips: 10
};

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "NZD/USD",
  "USD/CAD"
];

const BASE = {
  "EUR/USD": 1.085,
  "GBP/USD": 1.265,
  "USD/JPY": 150.2,
  "USD/CHF": 0.895,
  "AUD/USD": 0.655,
  "NZD/USD": 0.61,
  "USD/CAD": 1.375
};

const fmt = (n, pair) =>
  Number.isFinite(n)
    ? n.toFixed(pair?.includes("JPY") ? 3 : 5)
    : "—";

const pipSize = pair =>
  pair?.includes("JPY") ? 0.01 : 0.0001;

const pointSize = pair => pipSize(pair) / 10;

const money = n =>
  (n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(2);

const hourOf = t => new Date(t).getHours();

const inHours = (t, start, end) => {
  const h = hourOf(t);
  return start <= end
    ? h >= start && h < end
    : h >= start || h < end;
};

const candleDir = (fallback, c) =>
  c.close > c.open ? true :
  c.close < c.open ? false : fallback;

const isBullEngulf = (c, p) =>
  c.close > c.open &&
  p.close < p.open &&
  c.close >= p.open &&
  c.open <= p.close;

const isBearEngulf = (c, p) =>
  c.close < c.open &&
  p.close > p.open &&
  c.close <= p.open &&
  c.open >= p.close;

const isDoji = (c, percent = 25) => {
  const range = c.high - c.low;
  return range > 0 &&
    Math.abs(c.close - c.open) <= range * percent / 100;
};

const emaAt = (bars, period, index) => {
  if (index + 1 < period) return null;

  const k = 2 / (period + 1);
  let value = bars[index + 1 - period].close;

  for (let i = index + 2 - period; i <= index; i++) {
    value = bars[i].close * k + value * (1 - k);
  }

  return value;
};

const rsiAt = (bars, period, index) => {
  if (index < period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = index - period + 1; i <= index; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
};

const overlaps = (a, b) =>
  a.top >= b.bot && a.bot <= b.top;

// ==================================================
// SIMULATED CANDLE GENERATOR
// ==================================================

function makeReplay(pair, scenario, timeframe) {
  const step = timeframe * 60000;
  const now = new Date();

  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();

  const base = BASE[pair];
  const pip = pipSize(pair);
  const bars = [];

  let price = base;

  let seed = pair.split("").reduce(
    (a, c) => a + c.charCodeAt(0),
    scenario.length * 91 + timeframe
  );

  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const historyCount = Math.max(
    1150,
    Math.ceil(24 * 60 / timeframe) + 100
  );

  // EMA warm-up history
  for (let i = historyCount; i > 0; i--) {
    const drift = (rnd() - 0.5) * pip * 2.4;
    const o = price;
    price += drift;

    bars.push({
      time: day - i * step,
      open: o,
      high: Math.max(o, price) + rnd() * pip * 0.4,
      low: Math.min(o, price) - rnd() * pip * 0.4,
      close: price
    });
  }

  // Asia session
  for (let i = 0; i < Math.ceil(7 * 60 / timeframe); i++) {
    const o = price;
    price += (rnd() - 0.5) * pip * 1.7;

    bars.push({
      time: day + i * step,
      open: o,
      high: Math.max(o, price) + rnd() * pip * 0.25,
      low: Math.min(o, price) - rnd() * pip * 0.25,
      close: price
    });
  }

  // Post-Asia session
  for (let i = 0; i < Math.ceil(13 * 60 / timeframe); i++) {
    const o = price;
    let drift = (rnd() - 0.5) * pip * 1.5;

    if (scenario === "bullish" && i > 3) {
      drift += pip * 0.55;
    }

    if (scenario === "bearish" && i > 3) {
      drift -= pip * 0.55;
    }

    if (scenario === "retest" && i > 3 && i < 9) {
      drift += pip * 0.65;
    }

    if (scenario === "retest" && i >= 9 && i < 15) {
      drift -= pip * 0.85;
    }

    if (scenario === "range") drift *= 0.25;

    price += drift;

    const index = Math.ceil(7 * 60 / timeframe) + i;

    bars.push({
      time: day + index * step,
      open: o,
      high: Math.max(o, price) + rnd() * pip * 0.55,
      low: Math.min(o, price) - rnd() * pip * 0.55,
      close: price
    });
  }

  return bars;
}

// ==================================================
// BOX CREATION
// ==================================================

function createBox(c, p, cfg) {
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  // ENGULFED BOX
  if (isBullEngulf(c, p) || isBearEngulf(c, p)) {
    return {
      id: "ENG-" + c.time,
      type: "ENGULFED",
      top: Math.max(c.open, c.close),
      bot: Math.min(c.open, c.close),
      createdTime: c.time,
      isBuyBox: c.close > c.open,
      touches: 0,
      broken: false,
      breakoutTime: 0,
      active: true
    };
  }

  // WICK BOX
  if (body > 0) {
    if (
      c.close > c.open &&
      upper >= body * cfg.wickPercent / 100
    ) {
      return {
        id: "WICK-" + c.time,
        type: "WICK",
        top: c.high,
        bot: Math.max(c.open, c.close),
        createdTime: c.time,
        isBuyBox: false,
        touches: 0,
        broken: false,
        breakoutTime: 0,
        active: true
      };
    }

    if (
      c.close < c.open &&
      lower >= body * cfg.wickPercent / 100
    ) {
      return {
        id: "WICK-" + c.time,
        type: "WICK",
        top: Math.min(c.open, c.close),
        bot: c.low,
        createdTime: c.time,
        isBuyBox: true,
        touches: 0,
        broken: false,
        breakoutTime: 0,
        active: true
      };
    }
  }

  // DOJI BOX
  if (isDoji(c, cfg.dojiBodyPercent)) {
    return {
      id: "DOJI-" + c.time,
      type: "DOJI",
      top: c.high,
      bot: c.low,
      createdTime: c.time,
      isBuyBox: c.close >= c.open,
      touches: 0,
      broken: false,
      breakoutTime: 0,
      active: true
    };
  }

  return null;
}

// ==================================================
// EMA REJECTION FILTER
// ==================================================

function checkEMARejection(bars, index, isBuy, asia, boxes, pair, cfg) {
  if (!cfg.useEmaFilter) return true;

  const c = bars[index];
  const distance = cfg.emaDistancePoints * pointSize(pair);

  const validBox = boxes.some(b =>
    b.active &&
    b.touches <= 3 &&
    c.time > b.createdTime &&
    c.high >= b.bot &&
    c.low <= b.top
  );

  if (!validBox) return false;

  for (const period of cfg.emaPeriods) {
    const ema = emaAt(bars, period, index);

    if (ema == null) continue;

    // EMA must be outside the Asia range.
    if (ema >= asia.low && ema <= asia.high) continue;

    let rejected = false;

    if (isBuy) {
      rejected =
        c.close < c.open &&
        c.open > ema + distance &&
        c.low <= ema + distance &&
        c.close > ema;
    } else {
      rejected =
        c.close > c.open &&
        c.open < ema - distance &&
        c.high >= ema - distance &&
        c.close < ema;
    }

    if (rejected) return true;
  }

  return false;
}

// ==================================================
// ASIA BREAKOUT V6.11 ENGINE
// ==================================================

function runV611(bars, pair, cfg, startingBalance) {
  const pip = pipSize(pair);

  const boxes = [];
  const signals = [];
  const trades = [];
  const pending = [];

  let open = null;
  let balance = startingBalance;
  let peak = startingBalance;
  let drawdown = 0;

  let lastSignal = "WAIT FOR SETUP";
  let lastActivated = null;
  let lastNotification = "";

  let directionLock = null;
  const usedSignals = new Set();

  const lastBar = bars[bars.length - 1];
  const today = new Date(lastBar.time).toDateString();

  const todayBars = bars.filter(
    b => new Date(b.time).toDateString() === today
  );

  const asiaBars = todayBars.filter(
    b =>
      hourOf(b.time) >= cfg.asiaStart &&
      hourOf(b.time) < cfg.asiaEnd
  );

  if (!asiaBars.length) {
    return {
      asia: null,
      boxes: [],
      signals: [],
      trades: [],
      pending: [],
      open: null,
      balance,
      drawdown: 0,
      lastSignal: "WAITING FOR ASIA DATA",
      lastActivated: null,
      lastNotification: ""
    };
  }

  const asia = {
    high: Math.max(...asiaBars.map(b => b.high)),
    low: Math.min(...asiaBars.map(b => b.low))
  };

  const asiaRangePips = (asia.high - asia.low) / pip;

  const firstAsiaTime = asiaBars[0].time;
  const lastAsiaTime = asiaBars[asiaBars.length - 1].time;

  const startIndex = bars.findIndex(
    b => b.time >= firstAsiaTime
  );

  // Approximate USD pip value for demo sizing.
  // Actual lot sizing depends on broker and instrument.
  const pipValuePerLot = 10;

  const placePending = (isBuy, box, source, candle, index) => {
    const direction = isBuy ? "BUY" : "SELL";

    const signalKey = box.id + "-" + box.touches;

    if (cfg.oneTradePerSignal && usedSignals.has(signalKey)) {
      return false;
    }

    if (cfg.oneDirectionOnly && directionLock &&
        directionLock !== direction) {
      return false;
    }

    // Same-direction pending blocks another order.
    const samePending = pending.find(
      p => p.direction === direction
    );

    if (samePending) return false;

    // Opposite pending is deleted.
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].direction !== direction) {
        pending.splice(i, 1);
      }
    }

    // Opposite open position closes at current candle close.
    if (open && open.direction !== direction) {
      const priceMove = open.direction === "BUY"
        ? candle.close - open.entry
        : open.entry - candle.close;

      const pipsMoved = priceMove / pip;
      const profit = pipsMoved * open.lots * pipValuePerLot;

      balance += profit;
      peak = Math.max(peak, balance);

      trades.unshift({
        id: candle.time + "-OPPOSITE",
        time: candle.time,
        direction: open.direction,
        source: open.source,
        entry: open.entry,
        exit: candle.close,
        result: profit >= 0 ? "WIN" : "LOSS",
        profit,
        risk: open.risk,
        exitReason: "OPPOSITE SIGNAL"
      });

      open = null;
    }

    // Maximum active positions.
    if (open || pending.length >= cfg.maxTrades) return false;

    if (cfg.tradeOnlyAfterAsia && candle.time <= lastAsiaTime) {
      return false;
    }

    if (!inHours(candle.time, cfg.tradeStart, cfg.tradeEnd)) {
      return false;
    }

    // RSI filter (optional).
    if (cfg.useRSIFilter) {
      const rsi = rsiAt(bars, cfg.rsiPeriod, index);
      if (rsi == null) return false;

      if (isBuy && rsi <= 50) return false;
      if (!isBuy && rsi >= 50) return false;
    }

    // EMA rejection filter.
    if (
      !checkEMARejection(
        bars, index, isBuy, asia, boxes, pair, cfg
      )
    ) {
      return false;
    }

    const entry = isBuy
      ? box.top + cfg.pendingBuffer * pip
      : box.bot - cfg.pendingBuffer * pip;

    const sl = entry + (isBuy ? -1 : 1) * cfg.fixedSL * pip;

    const tpDistance = cfg.forexTP * pip;

    const tp = entry + (isBuy ? 1 : -1) * tpDistance;

    const risk = cfg.useRiskPercent
      ? balance * cfg.riskPct / 100
      : cfg.fixedSL * cfg.fixedLots * pipValuePerLot;

    const lots = cfg.useRiskPercent
      ? risk / (cfg.fixedSL * pipValuePerLot)
      : cfg.fixedLots;

    pending.push({
      direction,
      entry,
      sl,
      tp,
      risk,
      lots,
      source,
      created: candle.time,
      boxId: box.id,
      signalKey
    });

    usedSignals.add(signalKey);

    if (!directionLock) directionLock = direction;

    lastSignal = source;

    signals.unshift({
      name: source,
      direction,
      time: candle.time,
      entry,
      box: box.id
    });

    return true;
  };

  // ==================================================
  // CHRONOLOGICAL CANDLE PROCESSING
  // ==================================================

  for (let i = Math.max(1, startIndex); i < bars.length; i++) {
    const c = bars[i];
    const p = bars[i - 1];

    if (new Date(c.time).toDateString() !== today) continue;

    const h = hourOf(c.time);

    // No trading during Asia.
    if (h >= cfg.asiaStart && h < cfg.asiaEnd) continue;

    // Only create boxes after Asia.
    if (h >= cfg.asiaEnd) {
      const newBox = createBox(c, p, cfg);

      if (newBox) {
        boxes.push(newBox);

        // Maximum 3 visible boxes.
        const visible = boxes.filter(b => b.active);

        while (visible.length > cfg.maxBoxes) {
          const oldest = visible.shift();
          oldest.active = false;
        }
      }
    }

    // ----------------------------------------------
    // PENDING ORDER EXPIRY
    // ----------------------------------------------

    for (let j = pending.length - 1; j >= 0; j--) {
      const order = pending[j];

      if (
        c.time - order.created >=
        cfg.pendingExpiryMinutes * 60000
      ) {
        pending.splice(j, 1);
        lastNotification = "PENDING EXPIRED: " + order.direction;
      }
    }

    // ----------------------------------------------
    // PENDING ORDER ACTIVATION
    // ----------------------------------------------

    let activatedThisBar = false;

    for (let j = pending.length - 1; j >= 0; j--) {
      const order = pending[j];

      const hit = order.direction === "BUY"
        ? c.high >= order.entry
        : c.low <= order.entry;

      if (!hit) continue;

      if (open) continue;

      open = {
        ...order,
        entryTime: c.time,
        originalSL: order.sl,
        breakevenDone: false,
        trailingActive: false
      };

      pending.splice(j, 1);

      lastActivated = {
        direction: order.direction,
        source: order.source,
        entry: order.entry,
        time: c.time
      };

      lastNotification =
        "PENDING ACTIVATED: " + order.direction +
        " " + order.source;

      activatedThisBar = true;
      break;
    }

    // Do not assume intrabar price sequence after activation.
    if (activatedThisBar) continue;

    // ----------------------------------------------
    // OPEN TRADE MANAGEMENT
    // ----------------------------------------------

    if (open) {
      const isBuy = open.direction === "BUY";

      const stopHit = isBuy
        ? c.low <= open.sl
        : c.high >= open.sl;

      const targetHit = isBuy
        ? c.high >= open.tp
        : c.low <= open.tp;

      // Conservative execution: SL wins if both touched.
      if (stopHit || targetHit) {
        const won = targetHit && !stopHit;

        const profit = won
          ? open.risk * (cfg.forexTP / cfg.fixedSL)
          : open.sl === open.entry + (isBuy ? -1 : 1) *
            cfg.fixedSL * pip
            ? -open.risk
            : (
                (isBuy
                  ? open.sl - open.entry
                  : open.entry - open.sl
                ) / (cfg.fixedSL * pip)
              ) * open.risk;

        balance += profit;
        peak = Math.max(peak, balance);

        drawdown = Math.max(
          drawdown,
          peak > 0 ? (peak - balance) / peak * 100 : 0
        );

        trades.unshift({
          id: c.time + "-" + trades.length,
          time: c.time,
          direction: open.direction,
          source: open.source,
          entry: open.entry,
          exit: won ? open.tp : open.sl,
          sl: open.sl,
          tp: open.tp,
          result: won ? "WIN" : "LOSS",
          profit,
          risk: open.risk,
          exitReason: won ? "TAKE PROFIT" : "STOP LOSS"
        });

        open = null;
        continue;
      }

      // BREAKEVEN: open price + spread.
      const favorablePips = isBuy
        ? (c.close - open.entry) / pip
        : (open.entry - c.close) / pip;

      if (
        !open.breakevenDone &&
        favorablePips >= cfg.breakevenPips
      ) {
        const be = open.entry +
          (isBuy ? 1 : -1) * cfg.spreadPips * pip;

        if (isBuy) open.sl = Math.max(open.sl, be);
        else open.sl = Math.min(open.sl, be);

        open.breakevenDone = true;
      }

      // EMA 60 TRAILING STOP.
      // Activates after Asia range + extra 10 pips.
      const trailingTrigger =
        asiaRangePips + cfg.trailingExtraPips;

      if (favorablePips >= trailingTrigger) {
        open.trailingActive = true;

        const ema60 = emaAt(bars, 60, i);

        if (ema60 != null) {
          if (isBuy && ema60 < c.close) {
            open.sl = Math.max(open.sl, ema60);
          }

          if (!isBuy && ema60 > c.close) {
            open.sl = Math.min(open.sl, ema60);
          }
        }
      }
    }

    // ----------------------------------------------
    // TRADING HOURS
    // ----------------------------------------------

    if (
      open ||
      pending.length >= cfg.maxTrades ||
      !inHours(c.time, cfg.tradeStart, cfg.tradeEnd)
    ) {
      continue;
    }

    if (cfg.tradeOnlyAfterAsia && c.time <= lastAsiaTime) {
      continue;
    }

    // ----------------------------------------------
    // BOX BREAKOUT DETECTION AND RETEST TOUCHES
    // ----------------------------------------------

    for (const b of boxes) {
      if (!b.active || c.time <= b.createdTime) continue;

      // Detect breakout and save its time.
      if (!b.broken) {
        if (c.high > b.top) {
          b.broken = true;
          b.breakoutDirection = "UP";
          b.breakoutTime = c.time;
        } else if (c.low < b.bot) {
          b.broken = true;
          b.breakoutDirection = "DOWN";
          b.breakoutTime = c.time;
        }

        continue;
      }

      // Touch must happen on a later candle.
      if (c.time <= b.breakoutTime) continue;

      const touched =
        c.high >= b.bot &&
        c.low <= b.top;

      if (!touched) continue;

      // Each candle can count only once.
      if (b.lastTouchTime === c.time) continue;

      b.lastTouchTime = c.time;
      b.touches++;

      const isBuy = candleDir(b.isBuyBox, c);

      const stage = b.touches === 1
        ? "RETEST"
        : b.touches < cfg.deleteOnTouch
          ? "FLIPPY"
          : "DELETE";

      const source = b.type + " " + stage;

      // Third touch deletes the box.
      if (b.touches >= cfg.deleteOnTouch) {
        b.active = false;
      }

      placePending(isBuy, b, source, c, i);

      if (open || pending.length) break;
    }
  }

  return {
    asia,
    boxes: boxes.filter(b => b.active),
    allBoxes: boxes,
    signals: signals.slice(0, 30).reverse(),
    trades,
    pending,
    open,
    balance,
    drawdown,
    lastSignal,
    lastActivated,
    lastNotification,
    asiaRangePips,
    ema: cfg.emaPeriods.map(period => ({
      period,
      value: emaAt(bars, period, bars.length - 1)
    })),
    bars: bars.slice(-80)
  };
}

// ==================================================
// MOBILE INTERFACE
// ==================================================

const panel = {
  background: "#121c2d",
  border: "1px solid #25344a",
  borderRadius: 16,
  padding: 16,
  marginTop: 14
};

const btn = bg => ({
  background: bg,
  color: "white",
  border: 0,
  borderRadius: 10,
  padding: "12px 14px",
  fontWeight: 800,
  width: "100%",
  cursor: "pointer"
});

const label = {
  fontSize: 12,
  color: "#91a4bd",
  display: "block",
  marginBottom: 6
};

const field = {
  width: "100%",
  boxSizing: "border-box",
  background: "#0b1422",
  color: "#edf4ff",
  border: "1px solid #33445d",
  borderRadius: 9,
  padding: "11px",
  fontSize: 14
};

export default function App() {
  const [pair, setPair] = useState("EUR/USD");
  const [timeframe, setTimeframe] = useState(5);
  const [scenario, setScenario] = useState("range");
  const [balance, setBalance] = useState(10000);
  const [cfg, setCfg] = useState(DEFAULTS);
  const [replay, setReplay] = useState(null);
  const [tab, setTab] = useState("overview");

  const result = useMemo(
    () => replay
      ? runV611(replay, pair, cfg, balance)
      : null,
    [replay, pair, cfg, balance]
  );

  const update = (key, value) =>
    setCfg(s => ({ ...s, [key]: value }));

  const run = (type = scenario) => {
    setScenario(type);
    setReplay(makeReplay(pair, type, timeframe));
  };

  const reset = () => setReplay(null);

  const total = result?.trades?.length || 0;

  const wins =
    result?.trades?.filter(t => t.result === "WIN").length || 0;

  const winRate = total
    ? (wins / total * 100).toFixed(1)
    : "0.0";

  return (
    <main style={{
      minHeight: "100vh",
      background: "#080e19",
      color: "#edf4ff",
      fontFamily: "Inter,system-ui,Arial",
      padding: 16,
      boxSizing: "border-box"
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>

        <header style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap"
        }}>
          <div>
            <div style={{
              color: "#45c5ff",
              fontWeight: 900,
              letterSpacing: 2,
              fontSize: 12
            }}>
              V6.11 STRATEGY PORT
            </div>

            <h1 style={{ margin: "5px 0", fontSize: 28 }}>
              ASIA BREAKOUT
            </h1>

            <div style={{ color: "#93a5bd", fontSize: 13 }}>
              Mobile demo · candle replay · no broker connection
            </div>
          </div>

          <span style={{
            background: "#422b12",
            color: "#ffce79",
            padding: "7px 10px",
            borderRadius: 30,
            fontSize: 11,
            fontWeight: 800
          }}>
            DEMO ONLY
          </span>
        </header>

        {/* MARKET SETUP */}
        <section style={panel}>
          <h3 style={{ marginTop: 0 }}>Market setup</h3>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(2,minmax(0,1fr))",
            gap: 12
          }}>
            <label>
              <span style={label}>Forex major pair</span>
              <select
                value={pair}
                onChange={e => {
                  setPair(e.target.value);
                  reset();
                }}
                style={field}
              >
                {PAIRS.map(p => <option key={p}>{p}</option>)}
              </select>
            </label>

            <label>
              <span style={label}>Chart timeframe</span>
              <select
                value={timeframe}
                onChange={e => {
                  setTimeframe(+e.target.value);
                  reset();
                }}
                style={field}
              >
                {[1, 5, 15, 30, 60].map(v => (
                  <option key={v} value={v}>
                    {v === 60 ? "1 hour" : v + " minutes"}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span style={label}>Demo starting balance ($)</span>
              <input
                type="number"
                min="100"
                value={balance}
                onChange={e =>
                  setBalance(Math.max(100, +e.target.value || 100))
                }
                style={field}
              />
            </label>

            <label>
              <span style={label}>Position sizing</span>
              <input
                value={cfg.useRiskPercent
                  ? cfg.riskPct + "% risk"
                  : cfg.fixedLots + " lots"}
                readOnly
                style={field}
              />
            </label>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3,minmax(0,1fr))",
            gap: 8,
            marginTop: 14
          }}>
            <button style={btn("#334155")} onClick={() => run("range")}>
              RANGE TEST
            </button>

            <button style={btn("#166534")} onClick={() => run("bullish")}>
              BULLISH TEST
            </button>

            <button style={btn("#991b1b")} onClick={() => run("bearish")}>
              BEARISH TEST
            </button>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginTop: 8
          }}>
            <button style={btn("#075985")} onClick={() => run("retest")}>
              BREAKOUT TEST
            </button>

            <button style={btn("#475569")} onClick={reset}>
              CLEAR REPLAY
            </button>
          </div>

          <p style={{
            fontSize: 11,
            color: "#91a4bd",
            lineHeight: 1.5,
            marginBottom: 0
          }}>
            Deterministic test candles only. These are not live
            market prices or broker historical data.
          </p>
        </section>

        {/* NAVIGATION */}
        <nav style={{
          display: "flex",
          gap: 8,
          marginTop: 14
        }}>
          {["overview", "strategy", "journal", "settings"].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...btn(tab === t ? "#0369a1" : "#1b293d"),
                textTransform: "capitalize",
                padding: 10
              }}
            >
              {t}
            </button>
          ))}
        </nav>

        {/* OVERVIEW */}
        {tab === "overview" && (
          <>
            <section style={panel}>
              <h3 style={{ marginTop: 0 }}>Asia session range</h3>

              {result?.asia ? (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12
                }}>
                  <Metric title="ASIA HIGH" value={fmt(result.asia.high, pair)} />
                  <Metric title="ASIA LOW" value={fmt(result.asia.low, pair)} />
                  <Metric
                    title="RANGE"
                    value={result.asiaRangePips.toFixed(1) + " pips"}
                  />
                  <Metric title="TIME WINDOW" value="00:00–07:00" />
                </div>
              ) : (
                <p style={{ color: "#91a4bd" }}>
                  Run a replay to calculate the Asia high and low.
                </p>
              )}
            </section>

            <section style={panel}>
              <h3 style={{ marginTop: 0 }}>Strategy status</h3>

              <div style={{
                fontSize: 19,
                fontWeight: 900,
                color: result?.pending?.length
                  ? "#fbbf24"
                  : "#94a3b8"
              }}>
                {result?.lastSignal || "WAITING FOR CANDLES"}
              </div>

              <p style={{ color: "#91a4bd", fontSize: 12 }}>
                Pending: {result?.pending?.length || 0} ·
                Open trade: {result?.open?.direction || "None"}
              </p>

              {result?.pending?.map((p, i) => (
                <div key={i} style={{
                  borderTop: "1px solid #29384d",
                  paddingTop: 10,
                  marginTop: 10
                }}>
                  <b>{p.direction} STOP · {p.source}</b>
                  <p style={{ fontSize: 12, color: "#a9b9cd" }}>
                    Entry {fmt(p.entry, pair)} ·
                    SL {fmt(p.sl, pair)} ·
                    TP {fmt(p.tp, pair)} ·
                    Lots {p.lots.toFixed(2)} ·
                    Risk {money(p.risk)}
                  </p>
                </div>
              ))}

              {result?.open && (
                <div style={{
                  borderTop: "1px solid #29384d",
                  paddingTop: 10,
                  marginTop: 10
                }}>
                  <b>OPEN {result.open.direction}</b>
                  <p style={{ fontSize: 12, color: "#a9b9cd" }}>
                    Entry {fmt(result.open.entry, pair)} ·
                    SL {fmt(result.open.sl, pair)} ·
                    TP {fmt(result.open.tp, pair)}
                  </p>
                  <p style={{ fontSize: 11, color: "#91a4bd" }}>
                    Breakeven: {result.open.breakevenDone ? "ACTIVE" : "WAITING"} ·
                    EMA trailing: {result.open.trailingActive ? "ACTIVE" : "WAITING"}
                  </p>
                </div>
              )}
            </section>

            <section style={panel}>
              <h3 style={{ marginTop: 0 }}>LAST ACTIVATED</h3>

              {result?.lastActivated ? (
                <>
                  <b style={{ color: "#4ade80" }}>
                    {result.lastActivated.direction} · {result.lastActivated.source}
                  </b>
                  <p style={{ fontSize: 12, color: "#a9b9cd" }}>
                    Entry: {fmt(result.lastActivated.entry, pair)}
                  </p>
                  <p style={{ fontSize: 11, color: "#91a4bd" }}>
                    {new Date(result.lastActivated.time).toLocaleString()}
                  </p>
                </>
              ) : (
                <p style={{ color: "#91a4bd", fontSize: 12 }}>
                  No pending order has activated in this replay.
                </p>
              )}

              {result?.lastNotification && (
                <p style={{
                  color: "#fbbf24",
                  fontSize: 12,
                  borderTop: "1px solid #29384d",
                  paddingTop: 10
                }}>
                  {result.lastNotification}
                </p>
              )}
            </section>

            <section style={panel}>
              <h3 style={{ marginTop: 0 }}>Visible boxes</h3>

              {!result?.boxes?.length ? (
                <p style={{ color: "#91a4bd", fontSize: 12 }}>
                  No active boxes detected.
                </p>
              ) : result.boxes.map(b => (
                <div key={b.id} style={{
                  borderTop: "1px solid #29384d",
                  padding: "10px 0"
                }}>
                  <b>{b.type} · {b.isBuyBox ? "BUY BOX" : "SELL BOX"}</b>
                  <p style={{ fontSize: 12, color: "#a9b9cd" }}>
                    Top: {fmt(b.top, pair)} ·
                    Bottom: {fmt(b.bot, pair)}
                  </p>
                  <p style={{ fontSize: 11, color: "#91a4bd" }}>
                    {b.broken ? "BROKEN " + b.breakoutDirection : "NOT BROKEN"} ·
                    Touches: {b.touches}
                  </p>
                </div>
              ))}
            </section>

            <section style={panel}>
              <h3 style={{ marginTop: 0 }}>Demo performance</h3>

              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(2,minmax(0,1fr))",
                gap: 12
              }}>
                <Metric title="BALANCE" value={money(result?.balance ?? balance)} />
                <Metric title="CLOSED TRADES" value={total} />
                <Metric title="WIN RATE" value={winRate + "%"} />
                <Metric
                  title="MAX DRAWDOWN"
                  value={(result?.drawdown || 0).toFixed(2) + "%"}
                />
              </div>
            </section>
          </>
        )}

        {/* STRATEGY */}
        {tab === "strategy" && (
          <section style={panel}>
            <h3 style={{ marginTop: 0 }}>V6.11 strategy rules</h3>

            <ol style={{
              paddingLeft: 20,
              lineHeight: 1.8,
              color: "#d6e2f1"
            }}>
              <li>Build Asia high and low from 00:00–07:00.</li>
              <li>No trading during Asia.</li>
              <li>
                Create ENGULFED, WICK and DOJI boxes after Asia.
              </li>
              <li>Keep a maximum of 3 visible boxes.</li>
              <li>Save breakout direction and breakout time.</li>
              <li>
                Count later touches: RETEST, FLIPPY, DELETE.
              </li>
              <li>Determine trade direction from touch candle colour.</li>
              <li>
                Require at least one valid rejection from EMA 35,
                60, 90, 200, 120 or 1068.
              </li>
              <li>
                Trade only between 09:00 and 19:00.
              </li>
              <li>
                Place BUY STOP or SELL STOP at box boundary
                plus/minus 2 pips.
              </li>
              <li>
                Apply 10-pip SL and 31-pip Forex TP.
              </li>
              <li>
                Expire pending orders after 60 minutes.
              </li>
              <li>
                Breakeven after 25 pips; follow EMA 60 after
                Asia range plus 10 pips.
              </li>
            </ol>

            <div style={{
              borderTop: "1px solid #29384d",
              paddingTop: 12
            }}>
              <b>EMA values</b>

              {(result?.ema || []).map(e => (
                <p key={e.period} style={{
                  margin: "7px 0",
                  color: "#a9b9cd",
                  fontSize: 13
                }}>
                  EMA {e.period}: {fmt(e.value, pair)}
                </p>
              ))}
            </div>
          </section>
        )}

        {/* JOURNAL */}
        {tab === "journal" && (
          <section style={panel}>
            <h3 style={{ marginTop: 0 }}>Trade journal</h3>

            {!result?.trades?.length ? (
              <p style={{ color: "#91a4bd" }}>
                No completed demo trades in this replay.
              </p>
            ) : result.trades.map(t => (
              <div key={t.id} style={{
                borderTop: "1px solid #29384d",
                padding: "12px 0"
              }}>
                <b style={{
                  color: t.result === "WIN" ? "#4ade80" : "#fb7185"
                }}>
                  {t.result} · {t.direction} · {t.source}
                </b>

                <p style={{
                  fontSize: 12,
                  color: "#a9b9cd",
                  margin: "5px 0"
                }}>
                  {new Date(t.time).toLocaleString()}
                </p>

                <p style={{ fontSize: 12, margin: "5px 0" }}>
                  Entry {fmt(t.entry, pair)} ·
                  Exit {fmt(t.exit, pair)} ·
                  Risk {money(t.risk)}
                </p>

                <b>{money(t.profit)}</b>
                <p style={{ fontSize: 11, color: "#91a4bd" }}>
                  Exit: {t.exitReason}
                </p>
              </div>
            ))}
          </section>
        )}

        {/* SETTINGS */}
        {tab === "settings" && (
          <section style={panel}>
            <h3 style={{ marginTop: 0 }}>Execution & risk settings</h3>

            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12
            }}>
              <Setting
                label="Fixed SL (pips)"
                value={cfg.fixedSL}
                onChange={v => update("fixedSL", Math.max(1, +v || 1))}
              />

              <Setting
                label="Forex TP (pips)"
                value={cfg.forexTP}
                onChange={v => update("forexTP", Math.max(1, +v || 1))}
              />

              <Setting
                label="Pending buffer (pips)"
                value={cfg.pendingBuffer}
                onChange={v => update("pendingBuffer", Math.max(0, +v || 0))}
              />

              <Setting
                label="Pending expiry (minutes)"
                value={cfg.pendingExpiryMinutes}
                onChange={v => update("pendingExpiryMinutes", Math.max(1, +v || 1))}
              />

              <Setting
                label="Risk (%)"
                value={cfg.riskPct}
                onChange={v => update("riskPct", Math.max(0.1, Math.min(100, +v || 1)))}
              />

              <Setting
                label="Fixed lots"
                value={cfg.fixedLots}
                onChange={v => update("fixedLots", Math.max(0.01, +v || 0.01))}
              />

              <Setting
                label="Breakeven trigger (pips)"
                value={cfg.breakevenPips}
                onChange={v => update("breakevenPips", Math.max(1, +v || 1))}
              />

              <Setting
                label="Trailing extra trigger (pips)"
                value={cfg.trailingExtraPips}
                onChange={v => update("trailingExtraPips", Math.max(0, +v || 0))}
              />

              <Setting
                label="EMA distance (points)"
                value={cfg.emaDistancePoints}
                onChange={v => update("emaDistancePoints", Math.max(0, +v || 0))}
              />

              <Setting
                label="Wick threshold (%)"
                value={cfg.wickPercent}
                onChange={v => update("wickPercent", Math.max(1, Math.min(100, +v || 20)))}
              />

              <Setting
                label="Doji body maximum (%)"
                value={cfg.dojiBodyPercent}
                onChange={v => update("dojiBodyPercent", Math.max(1, Math.min(100, +v || 25)))}
              />
            </div>

            <div style={{
              borderTop: "1px solid #29384d",
              marginTop: 16,
              paddingTop: 14
            }}>
              <b>Position sizing</b>

              <Toggle
                label="Use risk percentage sizing"
                checked={cfg.useRiskPercent}
                onChange={v => update("useRiskPercent", v)}
              />

              <Toggle
                label="One direction only"
                checked={cfg.oneDirectionOnly}
                onChange={v => update("oneDirectionOnly", v)}
              />

              <Toggle
                label="One trade per signal"
                checked={cfg.oneTradePerSignal}
                onChange={v => update("oneTradePerSignal", v)}
              />

              <Toggle
                label="Trade only after Asia"
                checked={cfg.tradeOnlyAfterAsia}
                onChange={v => update("tradeOnlyAfterAsia", v)}
              />

              <Toggle
                label="Enable six-EMA rejection filter"
                checked={cfg.useEmaFilter}
                onChange={v => update("useEmaFilter", v)}
              />

              <Toggle
                label="Enable RSI filter"
                checked={cfg.useRSIFilter}
                onChange={v => update("useRSIFilter", v)}
              />
            </div>

            <p style={{
              fontSize: 12,
              color: "#91a4bd",
              lineHeight: 1.6
            }}>
              Trading window: 09:00–19:00. Maximum active
              trades: 1. Maximum visible boxes: 3.
              Forex TP: 31 pips. SL: 10 pips.
            </p>

            <button
              style={btn("#334155")}
              onClick={() => setCfg(DEFAULTS)}
            >
              RESTORE DEFAULT SETTINGS
            </button>
          </section>
        )}

        {/* DISCLAIMER */}
        <section style={{
          ...panel,
          borderColor: "#6b4c1e",
          background: "#17170f"
        }}>
          <b style={{ color: "#ffce79" }}>
            Simulation limitations
          </b>

          <p style={{
            fontSize: 12,
            color: "#d8c9a7",
            lineHeight: 1.6,
            marginBottom: 0
          }}>
            This is a browser-based strategy simulator, not an
            MT4 execution engine. It uses generated OHLC candles.
            Spread, commissions, broker execution, slippage and
            actual account notifications are not connected.
            The lot-sizing calculation uses an approximate
            $10 per pip per standard lot assumption. Gold and
            indices require their own contract specifications
            before their 1,000-point TP can be tested accurately.
          </p>
        </section>

        <footer style={{
          textAlign: "center",
          color: "#6f829b",
          fontSize: 11,
          padding: "20px 0"
        }}>
          ASIA BREAKOUT MOBILE · V6.11 · DEMO ONLY
        </footer>
      </div>
    </main>
  );
}

// ==================================================
// REUSABLE COMPONENTS
// ==================================================

function Metric({ title, value }) {
  return (
    <div style={{
      background: "#0b1422",
      padding: 12,
      borderRadius: 10
    }}>
      <div style={{
        fontSize: 10,
        color: "#8196b1",
        fontWeight: 800,
        letterSpacing: 1
      }}>
        {title}
      </div>

      <div style={{
        fontSize: 19,
        fontWeight: 900,
        marginTop: 5,
        overflowWrap: "anywhere"
      }}>
        {value}
      </div>
    </div>
  );
}

function Setting({ label, value, onChange }) {
  return (
    <label>
      <span style={{
        fontSize: 12,
        color: "#91a4bd",
        display: "block",
        marginBottom: 6
      }}>
        {label}
      </span>

      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={field}
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 0",
      borderBottom: "1px solid #29384d",
      fontSize: 13,
      color: "#d6e2f1"
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
