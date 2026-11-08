let lastSignal = {action:"WAIT",symbol:"NONE",entry:0,sl:0,tp:0,time:0};

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method==='POST'){
    lastSignal = req.body;
    lastSignal.time = Date.now();
    return res.status(200).json({ok:true, saved:lastSignal});
  }
  if(req.method==='GET'){
    return res.status(200).json(lastSignal);
  }
  return res.status(405).json({error:"method"});
}