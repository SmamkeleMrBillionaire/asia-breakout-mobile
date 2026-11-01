
import React from "react";

export default function App() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0b1120",
      color: "#ffffff",
      fontFamily: "Arial, sans-serif",
      padding: "24px",
      boxSizing: "border-box"
    }}>
      <div style={{
        maxWidth: "500px",
        margin: "0 auto"
      }}>
        <h1 style={{ color: "#38bdf8" }}>
          ASIA BREAKOUT
        </h1>

        <p style={{ color: "#94a3b8" }}>
          Mobile Trading Assistant
        </p>

        <div style={{
          background: "#172033",
          padding: "20px",
          borderRadius: "14px",
          marginTop: "25px"
        }}>
          <h2>Market Status</h2>
          <p>Waiting for Asia session breakout</p>
          <h3 style={{ color: "#facc15" }}>
            WAIT FOR SIGNAL
          </h3>
        </div>

        <div style={{
          background: "#172033",
          padding: "20px",
          borderRadius: "14px",
          marginTop: "16px"
        }}>
          <h2>Trading Settings</h2>
          <p>Market: Forex Majors</p>
          <p>Confirmation: EMA</p>
          <p>Contract Expiry: 5 Minutes</p>
          <p>Session: Asia</p>
        </div>

        <div style={{
          background: "#172033",
          padding: "20px",
          borderRadius: "14px",
          marginTop: "16px"
        }}>
          <h2>Execution Mode</h2>
          <p style={{ color: "#22c55e" }}>
            DEMO ONLY
          </p>
          <p>No live trades are executed.</p>
        </div>

        <p style={{
          color: "#64748b",
          textAlign: "center",
          marginTop: "35px"
        }}>
          Asia Breakout Mobile v1.0
        </p>
      </div>
    </div>
  );
}
