
import React, { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const TIMEFRAME = 300;
const CANDLE_COUNT = 1200;
const EMA_PERIODS = [35, 60, 90, 120, 200, 1068];
const BUFFER_PIPS = 2;
const FX_SL_PIPS = 10;
const FX_TP_PIPS = 31;
const NON_FX_TP_POINTS = 1000;

const CATEGORIES = [
  "All",
  "Forex",
  "Indices",
  "Metals",
  "Synthetics",
  "Crypto",
  "Stocks",
  "Other"
];

const fmt = (n, digits = 5) =>
  Number.isFinite(n) ? Number(n).toFixed(digits) : "—";

function categoryOf(s) {
  const market = String(s.market || "").toLowerCase();
  const sub = String(s.submarket || "").toLowerCase();
  const name = String(s.display_name || "").toLowerCase();
  const symbol = String(s.symbol || "").toLowerCase();

  if (market.includes("forex")) return "Forex";
  if (
    market.includes("synthetic") ||
    sub.includes("synthetic") ||
    symbol.startsWith("1hz") ||
    symbol.startsWith("r_") ||
    symbol.includes("volatility") ||
    symbol.includes("boom") ||
    symbol.includes("crash") ||
    symbol.includes("step")
  ) return "Synthetics";

  if (
    market.includes("crypt") ||
    sub.includes("crypt") ||
    name.includes("bitcoin") ||
    name.includes("ethereum")
  ) return "Crypto";

  if (
    market.includes("stock") ||
    sub.includes("stock") ||
    market.includes("share")
  ) return "Stocks";

  if (
    market.includes("index") ||
    sub.includes("index")
  ) return "Indices";

  if (
    market.includes("commodit") ||
    sub.includes("metal") ||
    name.includes("gold") ||
    name.includes("silver") ||
    name.includes("platinum") ||
    name.includes("palladium")
  ) {
    if (
      name.includes("gold") ||
      name.includes("silver") ||
      name.includes("platinum") ||
      name.includes("palladium") ||
      sub.includes("metal")
    ) return "Metals";

    return "Other";
  }

  return "Other";
}

function candleColor(c) {
  return c.close > c.open
    ? "BUY"
    : c.close < c.open
    ? "SELL"
    : "NONE";
}

function calculateEMA(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;

  const multiplier = 2 / (period + 1);
  let ema = values[0];

  for (let i = 0; i < values.length; i++) {
    ema = values[i] * multiplier + ema * (1 - multiplier);
    result[i] = ema;
  }

  return result;
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

function buildAsiaRange(candles) {
  if (!candles.length) return null;

  const lastDay = new Date(
    candles[candles.length - 1].epoch * 1000
  ).toISOString().slice(0, 10);

  const asia = candles.filter(c => {
    const date = new Date(c.epoch * 1000);
    const day = date.toISOString().slice(0, 10);
    const hour = date.getUTCHours();
    return day === lastDay && hour >= 0 && hour < 7;
  });

  if (!asia.length) return null;

  return {
    high: Math.max(...asia.map(c => c.high)),
    low: Math.min(...asia.map(c => c.low)),
    day: lastDay
  };
}

function createBoxes(candles) {
  const boxes = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const date = new Date(c.epoch * 1000);

    if (date.getUTCHours() < 7) continue;

    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);

    if (range <= 0) continue;

    // ENGULFED: current body engulfs previous opposite body.
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

    // DOJI: body is 25% or less of full candle range.
    if (body / range <= 0.25) {
      boxes.push({
        type: "DOJI",
        high: c.high,
        low: c.low,
        created: i
      });
    }

    // WICK: wick is at least 20% of candle body.
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

function findHLZSignal(candles, symbol, category) {
  if (candles.length < 1070) {
    return { direction: "NONE", reason: "Insufficient EMA history" };
  }

  const asia = buildAsiaRange(candles);

  if (!asia) {
    return { direction: "NONE", reason: "Asia range unavailable" };
  }

  const boxes = createBoxes(candles).filter(box =>
  new Date(candles[box.created].epoch * 1000)
    .toISOString().slice(0, 10) === asia.day
);
  if (!boxes.length) {
    return { direction: "NONE", reason: "No HLZ boxes" };
  }

  const closes = candles.map(c => c.close);
  const emas = {};

  EMA_PERIODS.forEach(period => {
    emas[period] = calculateEMA(closes, period);
  });

  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];
  const direction = candleColor(last);

  if (direction === "NONE") {
    return { direction: "NONE", reason: "Neutral candle" };
  }

  const unit = pipSize(symbol, category, candles);
  const rejectionBuffer = unit * 10;
  const entryBuffer = unit * BUFFER_PIPS;

  let best = null;

  for (const box of boxes) {
    if (lastIndex <= box.created) continue;

    // Find the first breakout after box creation.
    let breakoutIndex = -1;

    for (let i = box.created + 1; i <= lastIndex; i++) {
      if (
        candles[i].close > box.high ||
        candles[i].close < box.low
      ) {
        breakoutIndex = i;
        break;
      }
    }

    if (breakoutIndex < 0 || lastIndex <= breakoutIndex) {
      continue;
    }

    // Count only touches after the breakout.
    let touchCount = 0;
    let lastTouchIndex = -1;

    for (let i = breakoutIndex + 1; i <= lastIndex; i++) {
      const candle = candles[i];

      const touched =
        candle.low <= box.high &&
        candle.high >= box.low;

      if (touched) {
        touchCount++;
        lastTouchIndex = i;
      }
    }

    // Third touch deletes the box.
    if (touchCount >= 3 || lastTouchIndex !== lastIndex) {
      continue;
    }

    const touchType = touchCount === 1
      ? "RETEST"
      : "FLIPPY";

    // Direction comes from the touch candle.
    const touchDirection = candleColor(last);
    if (touchDirection === "NONE") continue;

    // EMA must be inside the HLZ box and outside Asia.
    for (const period of EMA_PERIODS) {
      const ema = emas[period][lastIndex];
      if (!Number.isFinite(ema)) continue;

      const emaInsideBox =
        ema >= box.low && ema <= box.high;

      const emaOutsideAsia =
        ema < asia.low || ema > asia.high;

      if (!emaInsideBox || !emaOutsideAsia) continue;

      // Last closed candle must reject the EMA.
      const buyRejection =
        touchDirection === "BUY" &&
        last.low <= ema + rejectionBuffer &&
        last.close > ema;

      const sellRejection =
        touchDirection === "SELL" &&
        last.high >= ema - rejectionBuffer &&
        last.close < ema;

      if (!buyRejection && !sellRejection) continue;

      const signal = {
        direction: touchDirection,
        boxType: box.type,
        touchType,
        touchCount,
        emaPeriod: period,
        ema,
        boxHigh: box.high,
        boxLow: box.low,
        asiaHigh: asia.high,
        asiaLow: asia.low,
        entry: touchDirection === "BUY"
          ? box.high + entryBuffer
          : box.low - entryBuffer,
        pip: unit,
        candleTime: last.epoch
      };

      if (
        !best ||
        signal.emaPeriod < best.emaPeriod
      ) {
        best = signal;
      }
    }
  }

  return best || {
    direction: "NONE",
    reason: "No breakout + retest + EMA confirmation"
  };
}

function makeDemoOrder(signal, symbol, category, balance, riskPct) {
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

  const riskMoney = balance * riskPct / 100;

  return {
    id: `${symbol}-${Date.now()}`,
    symbol,
    category,
    direction: signal.direction,
    source: `${signal.boxType} ${signal.touchType} EMA${signal.emaPeriod}`,
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

  const request = useCallback((payload) => {
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

        if (data.req_id && pendingRef.current.has(data.req_id)) {
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
      };
    });
  }, []);

  const discoverMarkets = useCallback(async () => {
    const response = await request({
      active_symbols: "full"
    });

    const list = (response.active_symbols || [])
      .filter(s => s.symbol && !s.is_trading_suspended)
      .map(s => ({
        ...s,
        category: categoryOf(s)
      }))
      .sort((a, b) =>
        a.display_name.localeCompare(b.display_name)
      );

    setSymbols(list);
    setMessage(
      `${list.length} active Deriv symbols discovered.`
    );

    return list;
  }, [request]);

  const scanSymbol = useCallback(async (item) => {
    try {
      const response = await request({
        ticks_history: item.symbol,
        count: CANDLE_COUNT,
        end: "latest",
        style: "candles",
        granularity: TIMEFRAME
      });

      const raw = response.candles || [];

      const candles = raw.map(c => ({
        epoch: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      })).filter(c =>
        Number.isFinite(c.close) &&
        Number.isFinite(c.epoch)
      );

      // Ignore the still-forming candle.
      const now = Math.floor(Date.now() / 1000);
      const closed = candles.filter(c =>
        c.epoch + TIMEFRAME <= now
      );

      return findHLZSignal(
        closed,
        item.symbol,
        item.category
      );
    } catch (error) {
      return {
        direction: "NONE",
        reason: error.message || "Market data unavailable"
      };
    }
  }, [request]);

  const scanAll = useCallback(async (list) => {
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

        results[item.symbol] = await scanSymbol(item);

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

    // Conservative request concurrency for mobile.
    await Promise.all([
      worker(),
      worker()
    ]);

    setSignals(previous => ({
      ...previous,
      ...results
    }));

    setLastScan(new Date().toLocaleTimeString());
    setMessage(
      runningRef.current
        ? `Scan complete: ${completed} of ${list.length} symbols checked.`
        : "Scanning stopped."
    );

    scanLock.current = false;
  }, [scanSymbol]);

  const startRobot = async () => {
    try {
      setMessage("Connecting to Deriv...");
      await connect();

      runningRef.current = true;
      setRunning(true);

      const list = await discoverMarkets();

      if (!list.length) {
        setMessage("No active markets returned by Deriv.");
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

  const stopRobot = () => {
    runningRef.current = false;
    setRunning(false);

    if (scanTimer.current) {
      clearInterval(scanTimer.current);
      scanTimer.current = null;
    }

    // Demo-only STOP: clear all simulated orders.
    setOrders([]);
    setMessage(
      "STOPPED. All simulated pending orders cleared."
    );
  };

  const activateSignal = item => {
    const signal = signals[item.symbol];

    if (!signal || signal.direction === "NONE") return;

    const order = makeDemoOrder(
      signal,
      item.symbol,
      item.category,
      balance,
      riskPct
    );

    setOrders(previous => [order, ...previous]);
    setSelected(item);
    setLastActivated(order.source);
    setMessage(
      `${item.symbol}: simulated pending stop created.`
    );
  };

  useEffect(() => {
    return () => {
      runningRef.current = false;

      if (scanTimer.current) {
        clearInterval(scanTimer.current);
      }

      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  const visibleSymbols = symbols.filter(item => {
    const matchesCategory =
      category === "All" || item.category === category;

    const matchesSearch =
      !search ||
      item.display_name.toLowerCase().includes(search.toLowerCase()) ||
      item.symbol.toLowerCase().includes(search.toLowerCase());

    return matchesCategory && matchesSearch;
  });

  const buyCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "BUY"
  ).length;

  const sellCount = symbols.filter(s =>
    signals[s.symbol]?.direction === "SELL"
  ).length;

  const noneCount = Math.max(
    0,
    scanned - buyCount - sellCount
  );

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
          display:flex; gap:7px; overflow-x:auto;
          padding:4px 0 10px; scrollbar-width:none;
        }
        .market-scroll::-webkit-scrollbar { display:none; }
        .market-card:active { transform:scale(.99); }
        .market-card {
          transition:transform .12s ease;
        }
        .market-card:disabled { opacity:.55; cursor:not-allowed; }
        input:focus { outline:1px solid #31a8ff; }
      `}</style>

      <header style={styles.header}>
        <div>
          <div style={styles.brand}>iFX BILLIONAIRE</div>
          <div style={styles.subtitle}>HLZ MOBILE ROBOT · V1</div>
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

        <section style={styles.statsGrid}>
          <div style={styles.stat}>
            <div style={styles.statLabel}>MARKETS FOUND</div>
            <div style={styles.statValue}>{symbols.length}</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>BUY SIGNALS</div>
            <div style={{...styles.statValue, color:"#16c784"}}>
              {buyCount}
            </div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>SELL SIGNALS</div>
            <div style={{...styles.statValue, color:"#ea5455"}}>
              {sellCount}
            </div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statLabel}>OPEN DEMO ORDERS</div>
            <div style={styles.statValue}>{orders.length}</div>
          </div>
        </section>

        <section style={styles.panel}>
          <div style={styles.panelHeading}>
            <div>
              <div style={styles.panelTitle}>ACTIVE HLZ SIGNALS</div>
              <div style={styles.smallText}>
                All currently discovered Deriv markets
              </div>
            </div>
            <div style={styles.smallText}>
              M5 · EMA 35/60/90/120/200/1068
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
                  background: category === cat ? "#1677d2" : "#18243a",
                  color: category === cat ? "#fff" : "#aab7cc"
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
            {visibleSymbols.slice(0, 250).map(item => {
              const signal = signals[item.symbol] || {
                direction: "NONE",
                reason: "Waiting for scan"
              };

              const color = signalColor(signal.direction);
              const isSelected = selected?.symbol === item.symbol;

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
                    ...styles.marketCard,
                    borderColor: isSelected ? "#31a8ff" : "#24334b"
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
                      <div style={styles.signalDetail}>
                        {signal.boxType} · {signal.touchType} · EMA{signal.emaPeriod}
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

          {visibleSymbols.length > 250 && (
            <div style={styles.smallText}>
              Showing first 250 of {visibleSymbols.length} matching
              instruments. All discovered instruments remain in the scan.
            </div>
          )}
        </section>

        <section style={styles.panel}>
          <div style={styles.panelTitle}>TRADE SETTINGS</div>

          <div style={styles.settingsGrid}>
            <label style={styles.field}>
              <span>Demo balance ($)</span>
              <input
                type="number"
                value={balance}
                onChange={e => setBalance(Number(e.target.value))}
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
                onChange={e => setRiskPct(Number(e.target.value))}
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
                onChange={e => setFixedLots(Number(e.target.value))}
                style={styles.numberInput}
              />
            </label>
          </div>

          <div style={styles.ruleText}>
            Forex demo: 10-pip SL / 31-pip TP.
            Non-Forex demo: 10-point SL / 1,000-point TP.
            Non-Forex distances are provisional point-based test values,
            not validated live contract settings.
          </div>
        </section>

        <section style={styles.panel}>
          <div style={styles.panelHeading}>
            <div>
              <div style={styles.panelTitle}>DEMO PENDING ORDERS</div>
              <div style={styles.smallText}>
                Orders created by tapping a valid signal
              </div>
            </div>
            <div style={styles.countBadge}>{orders.length}</div>
          </div>

          {!orders.length && (
            <div style={styles.empty}>No demo pending orders.</div>
          )}

          {orders.map(order => (
            <div key={order.id} style={styles.orderCard}>
              <div style={styles.panelHeading}>
                <strong>{order.symbol}</strong>
                <span style={{
                  color: order.direction === "BUY" ? "#16c784" : "#ea5455",
                  fontWeight:800
                }}>
                  {order.direction}
                </span>
              </div>
              <div style={styles.smallText}>{order.source}</div>

              <div style={styles.orderGrid}>
                <div>ENTRY <b>{fmt(order.entry, 6)}</b></div>
                <div>STOP LOSS <b>{fmt(order.sl, 6)}</b></div>
                <div>TAKE PROFIT <b>{fmt(order.tp, 6)}</b></div>
                <div>RISK <b>${fmt(order.riskMoney, 2)}</b></div>
              </div>

              <div style={styles.demoTag}>{order.status}</div>
            </div>
          ))}
        </section>

        <section style={styles.panel}>
          <div style={styles.panelTitle}>LAST ACTIVATED</div>
          <div style={styles.lastActivated}>{lastActivated}</div>
          <div style={styles.smallText}>
            Last scan: {lastScan}
          </div>
        </section>

        <section style={styles.warning}>
          <strong>IMPORTANT — EXECUTION STATUS</strong>
          <p>
            Deriv public market data is connected separately from broker
            execution. This build scans real Deriv candles but creates
            simulated orders only. It does not send real pending orders,
            close real positions or manage a live account.
          </p>
          <p>
            Asia session is calculated using UTC candle timestamps.
            Confirm the session timezone against the original EA before
            comparing signals.
          </p>
        </section>

        <footer style={styles.footer}>
          iFX BILLIONAIRE ROBOT · HLZ MOBILE V1
          <br/>
          Breakouts · Retests · EMA rejection
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
    lineHeight: 1.6,
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
