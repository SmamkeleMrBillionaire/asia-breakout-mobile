// api/license.js - iFX BILLIONAIRE KING LICENSE SERVER
// Creating More Bread Winners

// === KING CONTROL LIST - EDIT THIS FROM YOUR PHONE ===
// Add account = expiry date
// To BLOCK someone, change date to "BLOCKED" or delete line
const LICENSES = {
  "12345678": "2027.12.31",  // Example - King test account
  "87654321": "2026.12.31",  // Example client 1 - 1 year
  // Add your real clients here:
  // "YOUR_CLIENT_ACCOUNT": "2027.06.30",
};

// Master King login - same as mobile
const KING_USER = "King";
const KING_PASS = "Billionaire123";

export default function handler(req, res) {
  // Allow MT4 to call
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { account, key, username, password } = req.query;

  // 1. Master King bypass
  if (username === KING_USER && password === KING_PASS) {
    return res.status(200).json({ ok: true, type: "KING", expiry: "2099.12.31", message: "KING ACCESS GRANTED" });
  }

  // 2. Client license check
  if (!account) {
    return res.status(200).json({ ok: false, error: "no account" });
  }

  const expiry = LICENSES[account];

  if (!expiry) {
    return res.status(200).json({ ok: false, error: "not registered", account });
  }

  if (expiry === "BLOCKED") {
    return res.status(200).json({ ok: false, error: "blocked", account });
  }

  // Check expiry date
  const now = new Date();
  const expDate = new Date(expiry.replace(/\./g, '-'));
  
  if (now > expDate) {
    return res.status(200).json({ ok: false, error: "expired", account, expiry });
  }

  // OK
  return res.status(200).json({ ok: true, account, expiry, message: "Creating More Bread Winners - LICENSE OK" });
}