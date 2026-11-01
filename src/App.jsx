```jsx
import React, { useMemo, useState } from "react";

// Asia Breakout Mobile — strategy port based on AsiaBreakoutEA v6.11.
// This build is a candle-replay simulator. It does not connect to a broker or live feed.

const DEFAULTS = {
  asiaStart: 0, asiaEnd: 7, tradeStart: 8, tradeEnd: 20,
  riskPct: 1, fixedSL: 11, rr: 2, pendingBuffer: 2,
  maxTrades: 1, oneDirectionOnly: true, useEmaFilter: true,
  useFiboTouch: true, fibLevels: [50, 68, 90],
  fibMaxTouches: 3, wickPercent: 20, dojiBodyPercent: 25,
  flippyDeleteOnTouch: 3, useOverlapFilter: false,
  emaPeriods: [35, 60, 90, 200, 120, 1068],
  emaDistancePips: 10,
};

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD", "NZD/USD", "USD/CAD"];
const BASE = {"EUR/USD":1.085,"GBP/USD":1.265,"USD/JPY":150.2,"USD/CHF":0.895,"AUD/USD":0.655,"NZD/USD":0.61,"USD/CAD":1.375};
const fmt = (n, pair) => Number.isFinite(n) ? n.toFixed(pair?.includes("JPY") ? 3 : 5) : "—";
const money = n => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const pipSize = pair => pair.includes("JPY") ? 0.01 : 0.0001;

const emaAt = (bars, period, index) => {
  if (index + 1 < period) return null;
  const k = 2 / (period + 1);
  let value = bars[index + 1 - period].close;
  for (let i = index + 2 - period; i <= index; i++) {
    value = bars[i].close * k + value * (1-k);
  }
  return value;
};

const overlaps = (a,b) => a.top >= b.bot && a.bot <= b.top;
const candleDir = (fallback, c) => c.close > c.open ? false : c.close < c.open ? true : fallback;
const isDoji = c => c.high > c.low && Math.abs(c.close-c.open) <= (c.high-c.low)*0.25;
const isBullEngulf = (c,p) => c.close>c.open && p.close<p.open && c.close>=p.open && c.open<=p.close;
const isBearEngulf = (c,p) => c.close<c.open && p.close>p.open && c.close<=p.open && c.open>=p.close;
const hourOf = t => new Date(t).getHours();
const inHours = (t, start, end) => {
  const h=hourOf(t);
  return start<=end ? h>=start&&h<end : h>=start||h<end;
};

function makeReplay(pair, scenario, timeframe) {
  const step = timeframe * 60000, now = new Date();
  const day = new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const base = BASE[pair], pip = pipSize(pair), bars=[];
  let price=base;

  // Historical bars provide warm-up for the longest v6.11 EMA (1068).
  let seed=pair.split("").reduce((a,c)=>a+c.charCodeAt(0),scenario.length*91+timeframe);
  const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
  const historyCount=Math.max(1150, Math.ceil(24*60/timeframe)+100);

  for(let i=historyCount;i>0;i--){
    const drift=(rnd()-.5)*pip*2.4;
    const o=price;
    price+=drift;
    bars.push({
      time:day-i*step,open:o,
      high:Math.max(o,price)+rnd()*pip*.4,
      low:Math.min(o,price)-rnd()*pip*.4,close:price
    });
  }

  const start=day;

  // Build Asia range between 00:00 and 07:00 server-local simulation time.
  for(let i=0;i<Math.ceil(7*60/timeframe);i++){
    const o=price;
    price+=(rnd()-.5)*pip*1.7;
    bars.push({
      time:start+i*step,open:o,
      high:Math.max(o,price)+rnd()*pip*.25,
      low:Math.min(o,price)-rnd()*pip*.25,close:price
    });
  }

  // London / later candles deliberately form different test conditions, not market forecasts.
  for(let i=0;i<Math.ceil(13*60/timeframe);i++){
    const o=price;
    let drift=(rnd()-.5)*pip*1.5;
    if(scenario==="bullish" && i>3) drift+=pip*.55;
    if(scenario==="bearish" && i>3) drift-=pip*.55;
    if(scenario==="retest" && i>3 && i<9) drift+=pip*.65;
    if(scenario==="retest" && i>=9 && i<15) drift-=pip*.85;
    if(scenario==="range") drift*=.25;
    price+=drift;
    bars.push({
      time:start+(Math.ceil(7*60/timeframe)+i)*step,open:o,
      high:Math.max(o,price)+rnd()*pip*.55,
      low:Math.min(o,price)-rnd()*pip*.55,close:price
    });
  }
  return bars;
}

function runV611(bars, pair, cfg, startingBalance, timeframe) {
  const pip=pipSize(pair), boxes=[], signals=[], pending=[], trades=[];
  const dayBars=bars.filter(b=>new Date(b.time).toDateString()===new Date(bars[bars.length-1].time).toDateString());
  const today=dayBars.filter(b=>hourOf(b.time)>=cfg.asiaStart&&hourOf(b.time)<cfg.asiaEnd);

  if(!today.length) {
    return {boxes,signals,pending,trades,asia:null,balance:startingBalance,drawdown:0,lastSignal:"WAITING FOR ASIA DATA"};
  }

  const asia={
    high:Math.max(...today.map(b=>b.high)),
    low:Math.min(...today.map(b=>b.low))
  };
  const sessionBars=bars.filter(b=>b.time>=today[0].time);
  const lastIndex=bars.length-1;
  const currentDayStart=new Date(bars[lastIndex].time);
  currentDayStart.setHours(0,0,0,0);
  const prevDay=bars.filter(b=>b.time<currentDayStart.getTime());
  const prevDayBars=prevDay.filter(b=>b.time>=currentDayStart.getTime()-24*60*60*1000);
  const yHigh=prevDayBars.length?Math.max(...prevDayBars.map(b=>b.high)):asia.high;
  const yLow=prevDayBars.length?Math.min(...prevDayBars.map(b=>b.low)):asia.low;
  const tHigh=Math.max(...sessionBars.map(b=>b.high));
  const tLow=Math.min(...sessionBars.map(b=>b.low));

  let fibDir=0,f0=yHigh,f100=yLow;
  if(tHigh>yHigh){fibDir=1;f0=tHigh;f100=yLow;}
  else if(tLow<yLow){fibDir=-1;f0=tLow;f100=yHigh;}
  const fib=p=>fibDir===-1?f0+(f100-f0)*p/100:f0-(f0-f100)*p/100;
  const active=[];

  // Rebuild the same three v6.11 pattern families from closed candles.
  for(let i=Math.max(1,bars.length-1200);i<bars.length;i++){
    const c=bars[i], p=bars[i-1];
    if(c.time<today[0].time || hourOf(c.time)<cfg.asiaEnd) continue;

    const previousInsideAsia=p.close>asia.low&&p.close<asia.high&&(c.time-p.time)<86400000;
    const currentInsideAsia=c.close>asia.low&&c.close<asia.high&&(c.time-p.time)<86400000;

    if(!previousInsideAsia&&(isBullEngulf(c,p)||isBearEngulf(c,p))){
      const b={
        id:`ENG-${p.time}`,type:"ENGULFED",createdTime:c.time,
        top:p.high,bot:p.low,isBuyBox:!(p.close>p.open),
        touches:0,active:true,broken:false,breakoutTime:0,wasInside:false
      };
      if(!cfg.useOverlapFilter||!active.some(x=>x.active&&overlaps(x,b))) active.push(b);
    }

    const body=Math.abs(c.close-c.open);
    if(!currentInsideAsia&&body>0){
      const upper=c.high-Math.max(c.open,c.close);
      const lower=Math.min(c.open,c.close)-c.low;

      if(c.close>c.open&&upper>=body*cfg.wickPercent/100){
        const b={
          id:`WICK-${c.time}`,type:"WICK",createdTime:c.time,
          top:c.high,bot:c.close,isBuyBox:false,touches:0,
          active:true,broken:false,breakoutTime:0,wasInside:false
        };
        if(!cfg.useOverlapFilter||!active.some(x=>x.active&&overlaps(x,b)))active.push(b);
      } else if(c.close<c.open&&lower>=body*cfg.wickPercent/100){
        const b={
          id:`WICK-${c.time}`,type:"WICK",createdTime:c.time,
          top:c.close,bot:c.low,isBuyBox:true,touches:0,
          active:true,broken:false,breakoutTime:0,wasInside:false
        };
        if(!cfg.useOverlapFilter||!active.some(x=>x.active&&overlaps(x,b)))active.push(b);
      }
    }

    if(!currentInsideAsia&&isDoji(c)){
      const b={
        id:`DOJI-${c.time}`,type:"DOJI",createdTime:c.time,
        top:c.high,bot:c.low,isBuyBox:!(c.close>=c.open),
        touches:0,active:true,broken:false,breakoutTime:0,wasInside:false
      };
      if(!cfg.useOverlapFilter||!active.some(x=>x.active&&overlaps(x,b)))active.push(b);
    }
  }

  // Determine EMA rejection on the latest closed candle exactly as the EA filter requires.
  const emaReject=(idx,isBuy,period)=>{
    const c=bars[idx], e=emaAt(bars,period,idx);
    if(e==null)return false;
    const d=cfg.emaDistancePips*pip;
    return isBuy
      ? c.close<c.open&&c.open>e+d&&c.low<=e+d&&c.close>e
      : c.close>c.open&&c.open<e-d&&c.high>=e-d&&c.close<e;
  };

  const filterPass=(idx,isBuy)=>{
    if(!cfg.useEmaFilter)return true;
    const rejects=cfg.emaPeriods.filter(p=>emaReject(idx,isBuy,p));
    if(!rejects.length)return false;
    const outside=rejects.some(p=>{
      const e=emaAt(bars,p,idx);
      return e>asia.high||e<asia.low;
    });
    const c=bars[idx];
    const inBox=active.some(b=>b.active&&c.time>b.createdTime&&c.high>=b.bot&&c.low<=b.top&&b.touches>=0&&b.touches<=3);
    return outside&&inBox;
  };

  let balance=startingBalance,peak=startingBalance,drawdown=0,lastSignal="WAIT FOR SETUP";
  let open=null,openedThisBar=false;
  let asiaCombinedDone=false,londonTopDone=false,londonBottomDone=false,asiaTopDone=false,asiaBottomDone=false;
  const pushSignal=(name,direction,bar,entry,box)=>signals.push({name,direction,time:bar.time,entry,box});

  const placePending=(isBuy,box,source,bar,combined=false)=>{
    if(open||pending.length)return false;
    if(cfg.oneDirectionOnly&&open&&open.direction!==(isBuy?"BUY":"SELL"))return false;
    if(!combined&&!filterPass(bars.indexOf(bar),isBuy))return false;

    const entry=combined
      ? bar.close+(isBuy?1:-1)*cfg.pendingBuffer*pip
      : ((isBuy?box.top:box.bot)+(isBuy?1:-1)*cfg.pendingBuffer*pip);
    const sl=entry+(isBuy?-1:1)*cfg.fixedSL*pip;
    const tp=entry+(isBuy?1:-1)*cfg.fixedSL*cfg.rr*pip;
    const risk=balance*cfg.riskPct/100;

    pending.push({
      direction:isBuy?"BUY":"SELL",entry,sl,tp,risk,source,
      created:bar.time,expiresAt:combined?null:bar.time+120*60000,
      boxId:box?.id||"ASIA"
    });
    lastSignal=source;
    pushSignal(source,isBuy?"BUY":"SELL",bar,entry,box?.id||"ASIA");
    return true;
  };

  // Walk closed candles chronologically after Asia range has completed.
  for(let i=1;i<bars.length;i++){
    const c=bars[i], prev=bars[i-1];
    if(c.time<today[0].time)continue;
    openedThisBar=false;

    // Manage pending stop orders by actual candle high/low; no timed contract expiry.
    if(pending.length){
      const p=pending[0];
      if(p.expiresAt&&c.time>p.expiresAt){
        pending.length=0;
      } else {
        const hit=p.direction==="BUY"?c.high>=p.entry:c.low<=p.entry;
        if(hit){
          open={...p,entryTime:c.time};
          pending.length=0;
          openedThisBar=true;
        }
      }
    }

    // Resolve SL/TP using candle extremes; if both hit in one candle, conservatively count SL first.
    if(open){
      const stop=open.direction==="BUY"?c.low<=open.sl:c.high>=open.sl;
      const take=open.direction==="BUY"?c.high>=open.tp:c.low<=open.tp;
      if(stop||take){
        const won=take&&!stop;
        const profit=won?open.risk*cfg.rr:-open.risk;
        balance+=profit;
        peak=Math.max(peak,balance);
        drawdown=Math.max(drawdown,(peak-balance)/peak*100);
        trades.unshift({
          id:`${c.time}-${trades.length}`,time:c.time,
          direction:open.direction,source:open.source,
          entry:open.entry,exit:won?open.tp:open.sl,
          sl:open.sl,tp:open.tp,result:won?"WIN":"LOSS",
          profit,risk:open.risk
        });
        open=null;
      }
    }

    if(open||pending.length||!inHours(c.time,cfg.tradeStart,cfg.tradeEnd))continue;

    // Box breakout -> first/second/third retest logic. Each touch is counted once after breakout.
    for(const b of active){
      if(!b.active||c.time<=b.createdTime)continue;
      if(!b.broken){
        if(c.high>b.top||c.low<b.bot){
          b.broken=true;
          b.breakoutTime=c.time;
          b.wasInside=false;
        }
        continue;
      }

      const touched=c.high>=b.bot&&c.low<=b.top;
      if(!touched){
        b.wasInside=false;
        continue;
      }
      if(c.time<=b.breakoutTime){
        b.wasInside=true;
        continue;
      }
      if(b.wasInside)continue;

      b.touches++;
      const direction=candleDir(b.isBuyBox,c);
      const stage=b.touches===1?"RETEST":b.touches<cfg.flippyDeleteOnTouch?"FLIPPY":"DELETE";
      const enabled=b.type==="ENGULFED"||b.type==="WICK"||b.type==="DOJI";

      if(enabled&&!openedThisBar){
        const ok=placePending(direction,b,`${b.type} ${stage}`,c);
        if(ok){
          openedThisBar=true;
          if(stage==="DELETE")b.active=false;
        }
      }
      b.wasInside=true;
      if(openedThisBar)break;
    }

    if(openedThisBar||open||pending.length)continue;

    // Fibo first-touch entries: only if a level sits inside an active pattern box.
    if(cfg.useFiboTouch){
      for(const level of cfg.fibLevels){
        const price=fib(level);
        const box=active.find(b=>b.active&&b.touches<=cfg.fibMaxTouches&&price<=b.top&&price>=b.bot);
        if(!box||!(c.high>=price&&c.low<=price))continue;
        const key=`fib${level}`;
        if(!signals.some(s=>s.name===`FIBO ${level} TOUCH`)){
          const ok=placePending(box.isBuyBox,box,`FIBO ${level} TOUCH`,c);
          if(ok){
            openedThisBar=true;
            break;
          }
        }
      }
    }

    if(openedThisBar||open||pending.length)continue;

    // v6.11 Asia/London combined signal priority and flipped retest conditions.
    const touchesAsia=c.high>=asia.low&&c.low<=asia.high;
    const fib68=fib(68),fib50=fib(50);

    if(touchesAsia){
      let direction=null,source="";
      const londonPendingAlive=pending.some(p=>p.source.includes("ASIA LONDON"));

      if(!asiaCombinedDone&&!londonPendingAlive){
        if(!londonTopDone&&c.close>asia.high&&c.open<asia.high&&c.close>fib68){
          londonTopDone=true;
          direction=false;
          source="ASIA LONDON TOP BREAKOUT SELL";
        } else if(!londonBottomDone&&c.close<asia.low&&c.open>asia.low&&c.close<fib68){
          londonBottomDone=true;
          direction=true;
          source="ASIA LONDON BOTTOM BREAKOUT BUY";
        }
      }

      if(direction===null&&!asiaCombinedDone&&!londonPendingAlive){
        if(!asiaTopDone&&c.close>asia.high&&c.close<fib50){
          asiaTopDone=true;
          direction=true;
          source="ASIA RETEST TOP BUY";
        } else if(!asiaBottomDone&&c.close<asia.low&&c.close>fib50){
          asiaBottomDone=true;
          direction=false;
          source="ASIA RETEST BOTTOM SELL";
        }
      }

      if(direction!==null){
        const ok=placePending(direction,null,source,c,true);
        if(ok){
          openedThisBar=true;
          asiaCombinedDone=true;
        }
      }
    }
  }

  const allBoxes=active.filter(b=>b.active);
  return {
    asia,boxes:allBoxes,signals:signals.slice(-20).reverse(),
    pending,open,trades,balance,drawdown,lastSignal,
    ema:cfg.emaPeriods.map(p=>({period:p,value:emaAt(bars,bars.length-1,p)})),
    fib:[50,68,90].map(p=>({level:p,value:fib(p)})),
    bars:bars.slice(-80)
  };
}

const panel={
  background:"#121c2d",border:"1px solid #25344a",
  borderRadius:16,padding:16,marginTop:14
};
const btn=(bg)=>({
  background:bg,color:"white",border:0,borderRadius:10,
  padding:"12px 14px",fontWeight:800,width:"100%",cursor:"pointer"
});
const label={fontSize:12,color:"#91a4bd",display:"block",marginBottom:6};

export default function App(){
  const [pair,setPair]=useState("EUR/USD");
  const [timeframe,setTimeframe]=useState(5);
  const [scenario,setScenario]=useState("range");
  const [balance,setBalance]=useState(10000);
  const [cfg,setCfg]=useState(DEFAULTS);
  const [replay,setReplay]=useState(null);
  const [tab,setTab]=useState("overview");

  const result=useMemo(
    ()=>replay?runV611(replay,pair,cfg,balance,timeframe):null,
    [replay,pair,cfg,balance]
  );

  const update=(k,v)=>setCfg(s=>({...s,[k]:v}));
  const run=(type=scenario)=>{
    setScenario(type);
    setReplay(makeReplay(pair,type,timeframe));
  };
  const reset=()=>setReplay(null);
  const total=result?.trades?.length||0;
  const wins=result?.trades?.filter(t=>t.result==="WIN").length||0;
  const winRate=total?(wins/total*100).toFixed(1):"0.0";

  return <main style={{
    minHeight:"100vh",background:"#080e19",color:"#edf4ff",
    fontFamily:"Inter,system-ui,Arial",padding:16,boxSizing:"border-box"
  }}>
    <div style={{maxWidth:760,margin:"0 auto"}}>
      <header style={{
        display:"flex",justifyContent:"space-between",
        alignItems:"center",gap:12,flexWrap:"wrap"
      }}>
        <div>
          <div style={{color:"#45c5ff",fontWeight:900,letterSpacing:2,fontSize:12}}>
            V6.11 STRATEGY PORT
          </div>
          <h1 style={{margin:"5px 0",fontSize:28}}>ASIA BREAKOUT</h1>
          <div style={{color:"#93a5bd",fontSize:13}}>
            Mobile demo · candle replay · no broker connection
          </div>
        </div>
        <span style={{
          background:"#422b12",color:"#ffce79",padding:"7px 10px",
          borderRadius:30,fontSize:11,fontWeight:800
        }}>DEMO ONLY</span>
      </header>

      <section style={panel}>
        <h3 style={{marginTop:0}}>Market setup</h3>
        <div style={{
          display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:12
        }}>
          <label>
            <span style={label}>Forex major pair</span>
            <select value={pair} onChange={e=>{setPair(e.target.value);reset();}} style={field}>
              {PAIRS.map(p=><option key={p}>{p}</option>)}
            </select>
          </label>
          <label>
            <span style={label}>Chart timeframe</span>
            <select value={timeframe} onChange={e=>{setTimeframe(+e.target.value);reset();}} style={field}>
              {[1,5,15,30,60].map(v=>
                <option key={v} value={v}>{v===60?"1 hour":`${v} minutes`}</option>
              )}
            </select>
          </label>
          <label>
            <span style={label}>Demo starting balance ($)</span>
            <input type="number" min="100" value={balance}
              onChange={e=>setBalance(Math.max(100,+e.target.value||100))}
              style={field}/>
          </label>
          <label>
            <span style={label}>Risk per trade</span>
            <input value={`${cfg.riskPct}%`} readOnly style={field}/>
          </label>
        </div>

        <div style={{
          display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",
          gap:8,marginTop:14
        }}>
          <button style={btn("#334155")} onClick={()=>run("range")}>RANGE TEST</button>
          <button style={btn("#166534")} onClick={()=>run("bullish")}>BULLISH TEST</button>
          <button style={btn("#991b1b")} onClick={()=>run("bearish")}>BEARISH TEST</button>
        </div>

        <div style={{
          display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8
        }}>
          <button style={btn("#075985")} onClick={()=>run("retest")}>BREAKOUT / RETEST TEST</button>
          <button style={btn("#475569")} onClick={reset}>CLEAR REPLAY</button>
        </div>

        <p style={{fontSize:11,color:"#91a4bd",lineHeight:1.5,marginBottom:0}}>
          These are deterministic test candles, not live prices. For real strategy validation,
          feed historical OHLC data from your broker before relying on results.
        </p>
      </section>

      <nav style={{display:"flex",gap:8,marginTop:14}}>
        {["overview","strategy","journal","settings"].map(t=>
          <button key={t} onClick={()=>setTab(t)}
            style={{
              ...btn(tab===t?"#0369a1":"#1b293d"),
              textTransform:"capitalize",padding:10
            }}>{t}</button>
        )}
      </nav>

      {tab==="overview"&&<>
        <section style={panel}>
          <h3 style={{marginTop:0}}>Asia session range</h3>
          {result?.asia?
            <div style={{
              display:"grid",gridTemplateColumns:"1fr 1fr",gap:12
            }}>
              <Metric title="ASIA HIGH" value={fmt(result.asia.high,pair)}/>
              <Metric title="ASIA LOW" value={fmt(result.asia.low,pair)}/>
              <Metric title="RANGE" value={`${((result.asia.high-result.asia.low)/pipSize(pair)).toFixed(1)} pips`}/>
              <Metric title="TIME WINDOW" value="00:00–07:00"/>
            </div>
            :<p style={{color:"#91a4bd"}}>Run a replay to calculate the Asia high and low.</p>
          }
        </section>

        <section style={panel}>
          <h3 style={{marginTop:0}}>Strategy status</h3>
          <div style={{
            fontSize:22,fontWeight:900,
            color:result?.pending?.length?"#fbbf24":"#94a3b8"
          }}>{result?.lastSignal||"WAITING FOR CANDLES"}</div>
          <p style={{color:"#91a4bd",fontSize:12}}>
            Pending orders: {result?.pending?.length||0} ·
            Active trade: {result?.open?result.open.direction:"None"}
          </p>

          {result?.pending?.map((p,i)=>
            <div key={i} style={{
              borderTop:"1px solid #29384d",paddingTop:10,marginTop:10
            }}>
              <b>{p.direction} STOP · {p.source}</b>
              <p style={{margin:"5px 0",fontSize:12,color:"#a9b9cd"}}>
                Entry {fmt(p.entry,pair)} · SL {fmt(p.sl,pair)} ·
                TP {fmt(p.tp,pair)} · Risk {money(p.risk)}
              </p>
            </div>
          )}

          {result?.open&&
            <div style={{
              borderTop:"1px solid #29384d",paddingTop:10,marginTop:10
            }}>
              <b>OPEN {result.open.direction}</b>
              <p style={{fontSize:12,color:"#a9b9cd"}}>
                Entry {fmt(result.open.entry,pair)} ·
                SL {fmt(result.open.sl,pair)} · TP {fmt(result.open.tp,pair)}
              </p>
            </div>
          }
        </section>

        <section style={panel}>
          <h3 style={{marginTop:0}}>Demo performance</h3>
          <div style={{
            display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:12
          }}>
            <Metric title="BALANCE" value={money(result?.balance??balance)}/>
            <Metric title="CLOSED TRADES" value={total}/>
            <Metric title="WIN RATE" value={`${winRate}%`}/>
            <Metric title="MAX DRAWDOWN" value={`${(result?.drawdown||0).toFixed(2)}%`}/>
          </div>
        </section>
      </>}

      {tab==="strategy"&&
        <section style={panel}>
          <h3 style={{marginTop:0}}>v6.11 entry engine</h3>
          <ol style={{paddingLeft:20,lineHeight:1.8,color:"#d6e2f1"}}>
            <li>Build the 00:00–07:00 Asia high/low.</li>
            <li>Detect engulfing, wick (20% minimum) and doji (25% maximum body) boxes.</li>
            <li>Wait for price to break a box high or low, then a later candle must retest the box.</li>
            <li>Count touches: first RETEST, second FLIPPY, third DELETE.</li>
            <li>Apply the six-EMA rejection filter (35, 60, 90, 200, 120, 1068) and valid-box check.</li>
            <li>Check Fibonacci 50%, 68%, 90% first touches inside active boxes.</li>
            <li>Check v6.11 Asia/London combined breakout and flipped retest conditions.</li>
            <li>Place simulated stop entries; close only at SL or TP (no timed expiry).</li>
          </ol>

          <div style={{borderTop:"1px solid #29384d",paddingTop:12}}>
            <b>EMA values (latest replay candle)</b>
            {(result?.ema||[]).map(e=>
              <p key={e.period} style={{margin:"7px 0",color:"#a9b9cd",fontSize:13}}>
                EMA {e.period}: {fmt(e.value,pair)}
              </p>
            )}
          </div>

          <div style={{borderTop:"1px solid #29384d",paddingTop:12}}>
            <b>Fibonacci levels</b>
            {(result?.fib||[]).map(f=>
              <p key={f.level} style={{margin:"7px 0",color:"#a9b9cd",fontSize:13}}>
                {f.level}%: {fmt(f.value,pair)}
              </p>
            )}
          </div>
        </section>
      }

      {tab==="journal"&&
        <section style={panel}>
          <h3 style={{marginTop:0}}>Trade journal</h3>
          {!result?.trades?.length?
            <p style={{color:"#91a4bd"}}>No completed demo trades in this replay.</p>
            :result.trades.map(t=>
              <div key={t.id} style={{
                borderTop:"1px solid #29384d",padding:"12px 0"
              }}>
                <b style={{color:t.result==="WIN"?"#4ade80":"#fb7185"}}>
                  {t.result} · {t.direction} · {t.source}
                </b>
                <p style={{fontSize:12,color:"#a9b9cd",margin:"5px 0"}}>
                  {new Date(t.time).toLocaleString()}
                </p>
                <p style={{fontSize:12,margin:"5px 0"}}>
                  Entry {fmt(t.entry,pair)} · Exit {fmt(t.exit,pair)} · Risk {money(t.risk)}
                </p>
                <b>{money(t.profit)}</b>
              </div>
            )}
        </section>
      }

      {tab==="settings"&&
        <section style={panel}>
          <h3 style={{marginTop:0}}>Execution & risk settings</h3>
          <div style={{
            display:"grid",gridTemplateColumns:"1fr 1fr",gap:12
          }}>
            <Setting label="Fixed stop loss (pips)" value={cfg.fixedSL}
              onChange={v=>update("fixedSL",Math.max(1,+v||1))}/>
            <Setting label="Risk : reward" value={`1 : ${cfg.rr}`}
              onChange={v=>update("rr",Math.max(1,+String(v).replace("1 : ","")||2))}/>
            <Setting label="Pending buffer (pips)" value={cfg.pendingBuffer}
              onChange={v=>update("pendingBuffer",Math.max(0,+v||0))}/>
            <Setting label="Risk (%)" value={cfg.riskPct}
              onChange={v=>update("riskPct",Math.max(.1,Math.min(1,+v||1)))}/>
          </div>
          <p style={{fontSize:12,color:"#91a4bd"}}>
            Default: 1% risk, 11-pip fixed SL, 1:2 target (22 pips),
            one active trade, no time-based expiry. The v6.11 EA's other entry rules remain in the strategy engine.
          </p>
        </section>
      }

      <section style={{
        ...panel,borderColor:"#6b4c1e",background:"#17170f"
      }}>
        <b style={{color:"#ffce79"}}>Important simulation limitation</b>
        <p style={{
          fontSize:12,color:"#d8c9a7",lineHeight:1.6,marginBottom:0
        }}>
          This App.jsx ports the v6.11 rule families into a browser replay,
          but it is not byte-for-byte MT4 execution. Broker server time,
          tick-by-tick pending fills, spread, commission, swap, margin,
          and the full MT4 order-management layer are not available in this demo.
          No live trades are placed.
        </p>
      </section>

      <footer style={{
        textAlign:"center",color:"#6f829b",fontSize:11,padding:"20px 0"
      }}>
        ASIA BREAKOUT MOBILE · v6.11 RULESET · SIMULATED EXECUTION ONLY
      </footer>
    </div>
  </main>;
}

const field={
  width:"100%",boxSizing:"border-box",background:"#0b1422",
  color:"#edf4ff",border:"1px solid #33445d",
  borderRadius:9,padding:"11px",fontSize:14
};

function Metric({title,value}){
  return <div style={{
    background:"#0b1422",padding:12,borderRadius:10
  }}>
    <div style={{
      fontSize:10,color:"#8196b1",fontWeight:800,letterSpacing:1
    }}>{title}</div>
    <div style={{
      fontSize:19,fontWeight:900,marginTop:5,overflowWrap:"anywhere"
    }}>{value}</div>
  </div>;
}

function Setting({label,value,onChange}){
  return <label>
    <span style={{
      fontSize:12,color:"#91a4bd",display:"block",marginBottom:6
    }}>{label}</span>
    <input value={value} onChange={e=>onChange(e.target.value)} style={field}/>
  </label>;
}
