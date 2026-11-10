// api/license.js - iFX BILLIONAIRE KING
const LICENSES = {
  "71826432": "2099.12.31",
};
const KING_USER = "King";
const KING_PASS = "Billionaire123";
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { account, username, password } = req.query;
  if (username === KING_USER && password === KING_PASS) return res.status(200).json({ ok: true, type: "KING", expiry: "2099.12.31" });
  if (!account) return res.status(200).json({ ok: false, error: "no account" });
  const expiry = LICENSES[account];
  if (!expiry) return res.status(200).json({ ok: false, error: "not registered", account });
  if (expiry === "BLOCKED") return res.status(200).json({ ok: false, error: "blocked", account });
  const now = new Date();
  const expDate = new Date(expiry.replace(/\./g, '-'));
  if (now > expDate) return res.status(200).json({ ok: false, error: "expired", account, expiry });
  return res.status(200).json({ ok: true, account, expiry });
}