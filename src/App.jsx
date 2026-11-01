
import React, { useEffect, useState } from "react";

const initialMarket = {
  price: 1.08500,
  high: null,
  low: null,
  candles: [],
  tick: 0,
  fast: null,
  slow: null,
  signal: "WAIT",
  expiry: 300,
  active: false,
};

function calculateEMA(values, period) {
  if (!values.length) return null;
  const multiplier = 2 / (period + 1);
  return values.reduce(
    (ema, value) => ema === null
      ? value
      : value * multiplier + ema * (1 - multiplier),
    null
  );
}

export default function App() {
  const [pair, setPair] = useState("EUR/USD");
  const [scenario, setScenario] = useState("range");
  const [running, setRunning] = useState(false);
  const [market, setMarket] = useState(initialMarket);

  useEffect(() => {
    if (!running) return;

    const interval = setInterval(() => {
      setMarket(previous => {
        if (previous.active && previous.expiry <= 1) {
          return {
            ...previous,
            active: false,
            expiry: 0,
            signal: "EXPIRED",
          };
        }

        if (previous.active) {
          return {
            ...previous,
            expiry: previous.expiry - 1,
          };
        }

        const noise = (Math.random() - 0.5) * 0.00008;
        let movement = noise;

        if (previous.tick >= 12) {
          if (scenario === "bullish") movement += 0.00015;
          if (scenario === "bearish") movement -= 0.00015;
        }

        const price = previous.price + movement;
        const candles = [...previous.candles, price].slice(-30);
        const fast = calculateEMA(candles.slice(-9), 9);
        const slow = calculateEMA(candles.slice(-21), 21);

        const tick = previous.tick + 1;
        const high = previous.tick < 12
          ? Math.max(previous.high ?? price, price)
          : previous.high;
        const low = previous.tick < 12
          ? Math.min(previous.low ?? price, price)
          : previous.low;

        let signal = previous.signal;
        let active = false;
        let expiry = previous.expiry;

        if (tick > 12 && signal === "WAIT") {
          if (price > high && fast > slow) {
            signal = "BUY";
            active = true;
            expiry = 300;
          } else if (price < low && fast < slow) {
            signal = "SELL";
            active = true;
            expiry = 300;
          }
        }

        return {
          price,
          high,
          low,
          candles,
          tick,
          fast,
          slow,
          signal,
          expiry,
          active,
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [running, scenario]);

  function startTest(type) {
    setMarket(initialMarket);
    setScenario(type);
    setRunning(true);
  }

  function stopTest() {
    setRunning(false);
  }

  function resetTest() {
    setRunning(false);
    setMarket(initialMarket);
    setScenario("range");
  }

  const priceDigits = pair.includes("JPY") ? 3 : 5;
  const formatPrice = value =>
    value === null ? "--" : value.toFixed(priceDigits);

  const formatTime = seconds =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      seconds % 60
    ).padStart(2, "0")}`;

  const statusColor =
    market.signal === "BUY" ? "#22c55e" :
    market.signal === "SELL" ? "#ef4444" :
    market.signal === "EXPIRED" ? "#facc15" : "#facc15";

  const card = {
    background: "#172033",
    padding: "18px",
    borderRadius: "14px",
    marginTop: "15px",
  };

  const actionButton = {
    padding: "13px",
    border: "none",
    borderRadius: "9px",
    color: "white",
    fontWeight: "bold",
    width: "100%",
    marginTop: "9px",
    fontSize: "14px",
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0b1120",
      color: "white",
      fontFamily: "Arial, sans-serif",
      padding: "20px",
      boxSizing: "border-box",
    }}>
      <div style={{ maxWidth: "500px", margin: "auto" }}>

        <h1 style={{ color: "#38bdf8" }}>ASIA BREAKOUT</h1>
        <p style={{ color: "#94a3b8" }}>
          Mobile Trading Assistant v2.0
        </p>

        <div style={card}>
          <h2>Market Data</h2>

          <select
            value={pair}
            onChange={e => {
              setPair(e.target.value);
              resetTest();
            }}
            style={{
              padding: "12px",
              width: "100%",
              borderRadius: "8px",
              background: "#0b1120",
              color: "white",
              border: "1px solid #334155",
            }}
          >
            {["EUR/USD", "GBP/USD", "USD/JPY",
              "USD/CHF", "AUD/USD", "NZD/USD",
              "USD/CAD"].map(item => (
              <option key={item}>{item}</option>
            ))}
          </select>

          <h1 style={{ fontSize: "32px" }}>
            {formatPrice(market.price)}
          </h1>
          <p style={{ color: "#94a3b8" }}>
            SIMULATED PRICE · {pair}
          </p>
        </div>

        <div style={card}>
          <h2>Asia Session Range</h2>
          <p>Session: 00:00 – 07:00</p>
          <p>Range High: {formatPrice(market.high)}</p>
          <p>Range Low: {formatPrice(market.low)}</p>
          <p>Candles generated: {market.tick}</p>
        </div>

        <div style={card}>
          <h2>EMA Confirmation</h2>
          <p>Fast EMA (9): {formatPrice(market.fast)}</p>
          <p>Slow EMA (21): {formatPrice(market.slow)}</p>
          <p>
            Confirmation: {
              market.fast === null || market.slow === null
                ? "WAITING"
                : market.fast > market.slow
                  ? "BULLISH"
                  : market.fast < market.slow
                    ? "BEARISH"
                    : "NEUTRAL"
            }
          </p>
        </div>

        <div style={card}>
          <h2>Market Signal</h2>
          <h1 style={{ color: statusColor, fontSize: "36px" }}>
            {market.signal === "WAIT"
              ? "WAIT FOR SIGNAL"
              : market.signal}
          </h1>
          <p>
            {market.active
              ? "Demo contract active"
              : "No active demo contract"}
          </p>
        </div>

        <div style={card}>
          <h2>5-Minute Demo Contract</h2>
          <h1 style={{ color: "#38bdf8", fontSize: "36px" }}>
            {formatTime(market.expiry)}
          </h1>
          <p>Expiry: 5 minutes</p>
          <p>Execution: SIMULATION ONLY</p>
        </div>

        <div style={card}>
          <h2>Simulation Controls</h2>

          <button
            onClick={() => startTest("range")}
            style={{ ...actionButton, background: "#475569" }}
          >
            TEST MARKET RANGE
          </button>

          <button
            onClick={() => startTest("bullish")}
            style={{ ...actionButton, background: "#15803d" }}
          >
            TEST BULLISH BREAKOUT
          </button>

          <button
            onClick={() => startTest("bearish")}
            style={{ ...actionButton, background: "#b91c1c" }}
          >
            TEST BEARISH BREAKOUT
          </button>

          <button
            onClick={stopTest}
            style={{ ...actionButton, background: "#334155" }}
          >
            PAUSE SIMULATION
          </button>

          <button
            onClick={resetTest}
            style={{ ...actionButton, background: "#64748b" }}
          >
            RESET
          </button>
        </div>

        <div style={{
          textAlign: "center",
          color: "#22c55e",
          padding: "25px 0",
        }}>
          DEMO ONLY · NO LIVE TRADES
        </div>
      </div>
    </div>
  );
}
