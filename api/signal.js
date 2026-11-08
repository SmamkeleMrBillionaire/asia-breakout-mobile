const BLOB_ID = "01a1bb61-16fe-79a7-b235-3bd3f2833a8a";
const BLOB_URL = `https://jsonblob.com/api/jsonBlob/${BLOB_ID}`;
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const payload = req.body;
      const r = await fetch(BLOB_URL, {method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)});
      const text = await r.text();
      return res.status(200).json({ok:true, blobStatus:r.status, blobResp:text});
    } catch(e){ return res.status(500).json({ok:false, error:e.message}); }
  }
  return res.status(405).json({error:'method not allowed'});
    }
