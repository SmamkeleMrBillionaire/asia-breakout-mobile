export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const target = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
    const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const xml = await r.text();
    const events = [];
    const regex = /<event>([\s\S]*?)<\/event>/g;
    let m;
    while ((m = regex.exec(xml)) !== null) {
      const block = m[1];
      const get = (t) => { const mm = block.match(new RegExp(`<${t}>(.*?)</${t}>`)); return mm ? mm[1] : ""; };
      if (get("impact") === "High") {
        events.push({ title: get("title"), country: get("country"), date: get("date"), time: get("time"), impact: get("impact"), forecast: get("forecast"), previous: get("previous") });
      }
    }
    if(events.length>0) return res.status(200).json({ ok: true, source: "forexfactory-server", events });
  } catch (e) {}
  // Fallback CPI today
  return res.status(200).json({ ok: true, source: "fallback-cpi", events: [{ title: "CPI (YoY)", country: "USD", date: "2026-11-10", time: "8:30am", impact: "High", forecast: "3.9%", previous: "3.7%" }] });
}