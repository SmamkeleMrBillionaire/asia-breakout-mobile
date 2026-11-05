import React, { useCallback, useEffect, useRef, useState } from "react";

// === MARKET DATA ONLY - NO TRADING API, NO RISE/FALL ===
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const TIMEFRAME = 900;
const CANDLE_COUNT = 220;
const SCAN_INTERVAL = 30000;
const TRADING_START_HOUR = 7;
const TRADING_END_HOUR = 22;
const ARM_DISTANCE_PIPS = 3;
const ARM_CANDLE_LIMIT = 6;
const SL_OFFSET_PIPS = 15;
const TAKE_PROFIT_MULTIPLE = 4;
const MAX_SPREAD_POINTS = 300;
const MAX_DAILY_TRADES = 4;
const MAX_OPEN_TRADES = 4;
const CONNECTION_TIMEOUT = 15000;
const REQUEST_TIMEOUT = 20000;
const RECONNECT_DELAY = 5000;

const PRIORITY_SYMBOLS = ["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","USDCAD","NZDUSD","EURJPY","GBPJPY","EURGBP","XAUUSD","US30","NAS100","AUDCAD","NZDJPY","GBPCAD","AUDJPY","EURAUD","EURCAD","NZDCHF","CADJPY"];
const CATEGORIES = ["All","Forex","Indices","Metals","Synthetics","Crypto","Stocks","Other"];

const fmt = (n, digits = 5) => Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "—";
const serverDay = epoch => new Date(epoch * 1000).toISOString().slice(0, 10);
const serverHour = epoch => new Date(epoch * 1000).getUTCHours();
const serverMinute = epoch => new Date(epoch * 1000).getUTCMinutes();
const candleColor = c => c.close > c.open ? "GREEN" : c.close < c.open ? "RED" : "NEUTRAL";
const normalizeSymbol = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function priorityMatch(symbol){ const n=normalizeSymbol(symbol); return PRIORITY_SYMBOLS.find(p=>n.includes(p))||null; }
function priorityIndex(symbol){ const m=priorityMatch(symbol); return m?PRIORITY_SYMBOLS.indexOf(m):999; }
function categoryOf(s){
  const market=String(s.market||"").toLowerCase(); const sub=String(s.submarket||"").toLowerCase();
  const symbol=String(s.symbol||"").toLowerCase(); const type=String(s.symbol_type||"").toLowerCase();
  if(market.includes("forex")||sub.includes("forex")||type.includes("forex")) return "Forex";
  if(market.includes("synthetic")||sub.includes("synthetic")||symbol.startsWith("1hz")||symbol.startsWith("r_")||symbol.includes("boom")||symbol.includes("crash")) return "Synthetics";
  if(market.includes("crypt")||sub.includes("crypt")) return "Crypto";
  if(market.includes("stock")||type.includes("stock")) return "Stocks";
  if(market.includes("index")||type.includes("index")) return "Indices";
  if(market.includes("commodit")||sub.includes("metal")) return "Metals";
  return "Other";
}
function pipSize(symbol, category, candles, marketPip){
  if(Number.isFinite(Number(marketPip))&&Number(marketPip)>0) return Number(marketPip);
  if(category==="Forex") return String(symbol).toUpperCase().includes("JPY")?0.01:0.0001;
  const last=candles[candles.length-1]?.close||1; const dec=(String(last).split(".")[1]||"").length;
  return Math.pow(10,-Math.min(dec,8));
}
function pointSize(price){ const d=(String(price).split(".")[1]||"").length; return Math.pow(10,-Math.min(d,10)); }
function candleBody(c){ return {high:Math.max(c.open,c.close),low:Math.min(c.open,c.close)}; }
function isDoji(c){ const r=c.high-c.low; if(r<=0) return false; return Math.abs(c.close-c.open)<=r*0.20; }
function isEngulfing(cur,prev){
  if(!cur||!prev) return false; const a=candleColor(cur),b=candleColor(prev);
  if(a==="NEUTRAL"||b==="NEUTRAL"||a===b) return false;
  const cb=candleBody(cur),pb=candleBody(prev); return cb.high>=pb.high&&cb.low<=pb.low;
}
function makeBoxId(type,day,high,low,epoch=""){ return [type,day,Number(high).toPrecision(12),Number(low).toPrecision(12),epoch].join("-"); }
function isTradingTime(epoch){ const h=serverHour(epoch); return h>=TRADING_START_HOUR&&h<TRADING_END_HOUR; }
function calculateRSI(candles,index,period=3){
  if(!candles||index<period) return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){ const ch=candles[i].close-candles[i-1].close; if(ch>0)gains+=ch; if(ch<0)losses+=Math.abs(ch); }
  let ag=gains/period,al=losses/period;
  for(let i=period+1;i<=index;i++){ const ch=candles[i].close-candles[i-1].close; ag=(ag*(period-1)+Math.max(ch,0))/period; al=(al*(period-1)+Math.max(-ch,0))/period; }
  if(al===0&&ag===0) return 50; if(al===0) return 100; if(ag===0) return 0;
  const rs=ag/al; return 100-100/(1+rs);
}
function buildOrangeBox(candles,day){
  const firstFour=candles.filter(c=>serverDay(c.epoch)===day&&serverHour(c.epoch)===0&&[0,15,30,45].includes(serverMinute(c.epoch))).sort((a,b)=>a.epoch-b.epoch).slice(0,4);
  if(firstFour.length!==4) return null;
  const consecutive=firstFour.every((c,i)=>i===0||c.epoch-firstFour[i-1].epoch===TIMEFRAME);
  if(!consecutive) return null;
  const high=Math.max(...firstFour.map(c=>c.high)); const low=Math.min(...firstFour.map(c=>c.low));
  if(!(high>low)) return null;
  return {type:"ORANGE",day,high,low,size:high-low,startEpoch:firstFour[0].epoch,endEpoch:firstFour[0].epoch+86400,createdEpoch:firstFour[0].epoch,createdIndex:candles.indexOf(firstFour[3]),boxId:makeBoxId("ORANGE",day,high,low)};
}
function previousDay(day){ return new Date(new Date(`${day}T00:00:00Z`).getTime()-86400000).toISOString().slice(0,10); }
function buildDojiZones(candles,todayOrange,yesterdayOrange,pip){
  const zones=[]; if(!candles?.length) return zones;
  const today=todayOrange?.day; const yesterday=yesterdayOrange?.day;
  if(!todayOrange&&!yesterdayOrange) return zones;
  for(let i=1;i<candles.length;i++){
    const c=candles[i],prev=candles[i-1],day=serverDay(c.epoch);
    const doji=isDoji(c),eng=isEngulfing(c,prev); if(!doji&&!eng) continue;
    const orange=day===today?todayOrange:day===yesterday?yesterdayOrange:null; if(!orange) continue;
    let side=null; if(c.low>orange.high) side="ABOVE"; else if(c.high<orange.low) side="BELOW"; if(!side) continue;
    const type=doji?"DOJI":"ENGULFING";
    zones.push({type,side,day,high:c.high,low:c.low,sourceIndex:i,sourceEpoch:c.epoch,sourceCandle:c,boxId:makeBoxId(type,day,c.high,c.low,c.epoch),orangeBoxId:orange.boxId,touchCount:0,firstTouchIndex:null,lastTouchIndex:null,armed:day===yesterday,armExpired:false,deleted:false});
  }
  const groups=[{day:today,side:"ABOVE"},{day:today,side:"BELOW"},{day:yesterday,side:"ABOVE"},{day:yesterday,side:"BELOW"}];
  const selected=[];
  for(const g of groups){ const m=zones.filter(z=>z.day===g.day&&z.side===g.side).sort((a,b)=>b.sourceIndex-a.sourceIndex)[0]; if(m) selected.push(m); }
  return selected.map(zone=>{
    let touchCount=0,firstTouchIndex=null,lastTouchIndex=null,armed=zone.armed,armExpired=false;
    for(let i=zone.sourceIndex+1;i<candles.length;i++){
      const c