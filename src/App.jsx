
import React, { useEffect, useState } from "react";

const START_BALANCE = 100;
const STAKE = 10;
const PAYOUT = 0.80;
const DURATION = 300;

const initialMarket = {
  price: 1.08500,
  high: null,
  low: null,
  candles: [],
  tick: 0,
  fast: null,
  slow: null,
  signal: "WAIT",
  expiry: DURATION,
  active: false,
  entryPrice: null,
  direction: null,
  hasTraded: false,
};

function calculateEMA(values, period) {
  if (!values.length) return null;

  const multiplier = 2 / (period + 1);

  return values.reduce(
    (ema, value) =>
      ema === null
        ? value
        : value * multiplier + ema * (1 - multiplier),
    null
  );
}

export default function App() {
  const [pair, setPair] = useState("EUR/USD");
  const [scenario, setScenario] = useState("range");
  const [running, setRunning] = useState(false);

  const [app, setApp] = useState({
    market: initialMarket,
    history: [],
    balance: START_BALANCE,
    wins: 0,
    losses: 0,
  });

  const market = app.market;

  useEffect(() => {
    if (!running) return;

    const interval = setInterval(() => {
      setApp(previous => {
        const m = previous.market;
        let price = m.price;
        let expiry = m.expiry;
        let history = previous.history;
        let balance = previous.balance;
        let wins = previous.wins;
        let losses = previous.losses;

        // Simulate price movement during a contract.
        if (m.active) {
          const drift =
            scenario === "bullish" ? 0.000025 :
            scenario === "bearish" ? -0.000025 : 0;

          price += (Math.random() - 0.5) * 0.00012 + drift;
          expiry = Math.max(0, expiry - 1);

          if (expiry === 0) {
            const won =
              m.direction === "BUY"
                ? price > m.entryPrice
                : price < m.entryPrice;

            const profit = won ? STAKE * PAYOUT : -STAKE;

            wins += won ? 1 : 0;
            losses += won ? 0 : 1;
            balance += profit;

            history = [
              {
                id: Date.now(),
                time: new Date().toLocaleString(),
                pair,
                direction: m.direction,
                entry: m.entryPrice,
                exit: price,
                result: won ? "WIN" : "LOSS",
                profit,
              },
              ...history,
            ].slice(0, 100);

            return {
              ...previous,
              history,
              balance,
              wins,
              losses,
              market: {
                ...m,
                price,
                expiry: 0,
                active: false,
                signal: won ? "WIN" : "LOSS",
              },
            };
          }

          return {
            ...previous,
            market: { ...m, price, expiry },
          };
        }

        if (m.hasTraded) return previous;

        // Build the simulated Asian session range.
        const noise = (Math.random() - 0.5) * 0.00008;
        let movement = noise;

        if (m.tick >= 12) {
          if (scenario === "bullish") movement += 0.00015;
          if (scenario === "bearish") movement -= 0.00015;
        }

        price += movement;

        const candles = [...m.candles, price].slice(-100);
        const fast = calculateEMA(candles, 9);
        const slow = calculateEMA(candles, 21);

        const tick = m.tick + 1;

        const high = tick <= 12
          ? Math.max(m.high ?? price, price)
          : m.high;

        const low = tick <= 12
          ? Math.min(m.low ?? price, price)
          : m.low;

        let signal = "WAIT";
        let active = false;
        let entryPrice = null;
        let direction = null;
        let hasTraded = false;
        let nextExpiry = DURATION;

        if (tick > 12) {
          if (price > high && fast > slow) {
            signal = "BUY";
            direction = "BUY";
            active = true;
            entryPrice = price;
            hasTraded = true;
          } else if (price < low && fast < slow) {
            signal = "SELL";
            direction = "SELL";
            active = true;
            entryPrice = price;
            hasTraded = true;
          }
        }

        return {
          ...previous,
          market: {
            ...m,
            price,
            high,
            low,
            candles,
            tick,
            fast,
            slow,
            signal,
            active,
            expiry: nextExpiry,
            entryPrice,
            direction,
            hasTraded,
          },
        };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [running, scenario, pair]);

  function startTest(type) {
    setApp(previous => ({
      ...previous,
      market: initialMarket,
    }));
    setScenario(type);
    setRunning(true);
  }

  function stopTest() {
    setRunning(false);
  }

  function resetTest() {
    setRunning(false);
    setApp(previous => ({
      ...previous,
      market: initialMarket,
    }));
    setScenario("range");
  }

  function clearJournal() {
    setRunning(false);
    setApp({
      market: initialMarket,
      history: [],
      balance: START_BALANCE,
      wins: 0,
      losses: 0,
    });
    setScenario("range");
  }

  const total = app.wins + app.losses;
  const winRate = total
    ? ((app.wins / total) * 100).toFixed(1)
    : "0.0";

  const formatPrice = value =>
    value === null ? "--" :
    value.toFixed(pair.includes("JPY") ? 3 : 5);

  const formatTime = seconds =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      seconds % 60
    ).padStart(2, "0")}`;

  const card = {
    background: "#172033",
    padding: "17px",
    borderRadius: "13px",
    marginTop: "15px",
  };

  const button = (color) => ({
    width: "100%",
    padding: "13px",
    marginTop: "9px",
    border: "none",
    borderRadius: "9px",
    background: color,
    color: "white",
    fontWeight: "bold",
    fontSize: "14px",
  });

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0b1120",
      color: "white",
      fontFamily: "Arial, sans-serif",
      padding: "18px",
      boxSizing: "border-box",
    }}>
      <div style={{ maxWidth: "500px", margin: "auto" }}>

        <h1 style={{ color: "#38bdf8" }}>ASIA BREAKOUT</h1>
        <p style={{ color: "#94a3b8" }}>
          Mobile Trading Assistant v3.0
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
              width: "100%",
              padding: "12px",
              background: "#0b1120",
              color: "white",
              borderRadius: "8px",
            }}
          >
            {[
              "EUR/USD", "GBP/USD", "USD/JPY",
              "USD/CHF", "AUD/USD", "NZD/USD",
              "USD/CAD",
            ].map(p => <option key={p}>{p}</option>)}
          </select>

          <h1 style={{ fontSize: "32px" }}>
            {formatPrice(market.price)}
          </h1>
          <p style={{ color: "#94a3b8" }}>
            SIMULATED PRICE
          </p>
        </div>

        <div style={card}>
          <h2>Asia Session Range</h2>
          <p>Session: 00:00 – 07:00</p>
          <p>Range High: {formatPrice(market.high)}</p>
          <p>Range Low: {formatPrice(market.low)}</p>
          <p>Simulated ticks: {market.tick}</p>
        </div>

        <div style={card}>
          <h2>EMA Confirmation</h2>
          <p>EMA 9: {formatPrice(market.fast)}</p>
          <p>EMA 21: {formatPrice(market.slow)}</p>
          <p>
            Trend: {
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
          <h1 style={{
            color: market.signal === "BUY" ||
              market.signal === "WIN" ? "#22c55e" :
              market.signal === "SELL" ||
              market.signal === "LOSS" ? "#ef4444" : "#facc15",
          }}>
            {market.signal === "WAIT"
              ? "WAIT FOR SIGNAL"
              : market.signal}
          </h1>
          <p>
            {market.active
              ? `${market.direction} CONTRACT ACTIVE`
              : "No active contract"}
          </p>
          {market.entryPrice !== null && (
            <p>Entry: {formatPrice(market.entryPrice)}</p>
          )}
        </div>

        <div style={card}>
          <h2>5-Minute Contract</h2>
          <h1 style={{ color: "#38bdf8" }}>
            {formatTime(market.expiry)}
          </h1>
          <p>Stake: $10</p>
          <p>Winning payout: $8 net profit</p>
          <p>Loss: -$10</p>
          <p>Execution: DEMO ONLY</p>
        </div>

        <div style={card}>
          <h2>Simulation Controls</h2>

          <button
            style={button("#475569")}
            onClick={() => startTest("range")}
          >
            TEST MARKET RANGE
          </button>

          <button
            style={button("#15803d")}
            onClick={() => startTest("bullish")}
          >
            TEST BULLISH BREAKOUT
          </button>

          <button
            style={button("#b91c1c")}
            onClick={() => startTest("bearish")}
          >
            TEST BEARISH BREAKOUT
          </button>

          <button
            style={button("#334155")}
            onClick={stopTest}
          >
            PAUSE SIMULATION
          </button>

          <button
            style={button("#64748b")}
            onClick={resetTest}
          >
            RESET CURRENT TEST
          </button>
        </div>

        <div style={card}>
          <h2>Trading Performance</h2>

          <h1 style={{ color: "#38bdf8" }}>
            ${app.balance.toFixed(2)}
          </h1>
          <p>Simulated account balance</p>

          <p>Total trades: {total}</p>
          <p>Winning trades: {app.wins}</p>
          <p>Losing trades: {app.losses}</p>
          <p>Win rate: {winRate}%</p>
          <p>Net profit/loss: {
            (app.balance - START_BALANCE) >= 0 ? "+" : ""
          }${(app.balance - START_BALANCE).toFixed(2)}</p>
        </div>

        <div style={card}>
          <h2>Trading Journal</h2>

          {app.history.length === 0 ? (
            <p style={{ color: "#94a3b8" }}>
              No completed trades yet.
            </p>
          ) : (
            app.history.map(trade => (
              <div key={trade.id} style={{
                borderBottom: "1px solid #334155",
                padding: "12px 0",
              }}>
                <strong style={{
                  color: trade.result === "WIN"
                    ? "#22c55e" : "#ef4444",
                }}>
                  {trade.result} · {trade.direction}
                </strong>
                <p>{trade.pair} · {trade.time}</p>
                <p>Entry: {formatPrice(trade.entry)}</p>
                <p>Exit: {formatPrice(trade.exit)}</p>
                <p>
                  Result: {trade.profit > 0 ? "+" : ""}
                  ${trade.profit.toFixed(2)}
                </p>
              </div>
            ))
          )}

          <button
            style={button("#7f1d1d")}
            onClick={clearJournal}
          >
            RESET PERFORMANCE & JOURNAL
          </button>
        </div>

        <p style={{
          textAlign: "center",
          color: "#22c55e",
          padding: "22px 0",
        }}>
          DEMO ONLY · NO LIVE TRADES
        </p>
      </div>
    </div>
  );
}
