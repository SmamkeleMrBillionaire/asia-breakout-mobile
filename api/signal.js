let BLOB_ID = "01a1bba8-9826-75a3-b258-ea5c799d60f7";
let BLOB_URL = `https://jsonblob.com/api/jsonBlob/${BLOB_ID}`;
let lastSignal = null;

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method==='POST'){
    lastSignal = req.body;
    try{
      await fetch(BLOB_URL, {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(req.body)});
    }catch(e){}
    return res.status(200).json({ok:true, saved:lastSignal});
  }
  if(req.method==='GET'){
    if(lastSignal) return res.status(200).json(lastSignal);
    try{
      const r = await fetch(BLOB_URL);
      const j = await r.json();
      return res.status(200).json(j);
    }catch(e){ return res.status(200).json(lastSignal || {action:"WAIT"}); }
  }
  return res.status(405).json({error:"method"});
}