import React from 'react';

export default function App() {
  return (
    <div className="app">
      <header className="header">
        <div className="logo">ASIA BREAKOUT</div>
        <span className="status">● DEMO MODE</span>
      </header>

      <main className="container">
        <section className="hero">
          <p className="eyebrow">TRADING SYSTEM</p>
          <h1>Wait for the<br /><span>Asia Breakout.</span></h1>
          <p className="subtitle">
            Trade with confirmation. Protect your capital.
          </p>
        </section>

        <section className="card">
          <h2>Market Overview</h2>
          <div className="market-status">
            <span>Market status</span>
            <strong>Waiting for setup</strong>
          </div>
          <div className="market-status">
            <span>Trading session</span>
            <strong>Asia Session</strong>
          </div>
          <div className="market-status">
            <span>Entry confirmation</span>
            <strong>EMA</strong>
          </div>
          <div className="market-status">
            <span>Market</span>
            <strong>Forex Majors</strong>
          </div>
        </section>

        <section className="card">
          <h2>Strategy Settings</h2>
          <div className="setting">
            <span>Contract expiry</span>
            <strong>5 Minutes</strong>
          </div>
          <div className="setting">
            <span>Confirmation</span>
            <strong>EMA</strong>
          </div>
          <div className="setting">
            <span>Execution</span>
            <strong>Demo Only</strong>
          </div>
        </section>

        <section className="notice">
          <strong>Patience is the strategy.</strong>
          <p>Wait for the breakout and EMA confirmation before considering an entry.</p>
        </section>
      </main>

      <footer>ASIA BREAKOUT MOBILE · VERSION 1.0</footer>
    </div>
  );
      }
