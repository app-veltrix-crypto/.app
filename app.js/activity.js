/* Veltrix · activity: notifications feed, price alerts (watchlist) and transaction history.
   Data lives in Supabase (notifications, watchlist, transactions); this file is the screens + the glue. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const toast=m=>{try{wdToast(m)}catch{}};
const db=()=>window.veltrixDB;
const signedIn=()=>!!(db()&&db().get&&db().get());
const mode=()=>"crypto";

/* ====================================================== price-alert thresholds (change here) */
const PRICE_UP=1.10;    /* alert when a watched coin is 10% above the price it was measured from */
const PRICE_DOWN=0.90;  /* alert when it is 10% below */
const POLL_MS=60000;

/* ====================================================== helpers */
const SV=b=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${b}</svg>`;
const TOPIC_SVG={
  security:SV('<path d="M12 3 5 6v5.2c0 4.4 2.9 8 7 9.8 4.1-1.8 7-5.4 7-9.8V6l-7-3z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
  chat:SV('<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6.5L8 20.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M8 10h8M8 13h5"/>'),
  transaction:SV('<path d="M4 8h15M15.5 4.5 19 8l-3.5 3.5"/><path d="M20 16H5M8.5 12.5 5 16l3.5 3.5"/>'),
  withdrawal:SV('<path d="M7 17 17 7"/><path d="M9 7h8v8"/>'),
  deposit:SV('<path d="M17 7 7 17"/><path d="M15 17H7V9"/>'),
  price:SV('<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
  login:SV('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m16 7 3 3"/><path d="m14 9 2 2"/>'),
  promo:SV('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12"/><path d="M12 8C10 3.5 6 4.5 7 7c.4 1 3 1 5 1zM12 8c2-4.500 6-3.500 5-1-.4 1-3 1-5 1z"/>'),
  news:SV('<path d="M5 4h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2V4z"/><path d="M18 9h1.5A1.500 1.500 0 0 1 21 10.500V17a2 2 0 0 1-2 2"/><path d="M8.500 8h6M8.500 12h6M8.500 16h3"/>'),
  _:SV('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.500 2h-15L6 16z"/><path d="M10 21h4"/>')
};
const TOPIC={security:["Security alert"],chat:["Chat message"],transaction:["Transaction"],withdrawal:["Withdrawal"],deposit:["Deposit"],price:["Price alert"],login:["New login"],promo:["Promotion"],news:["News & updates"]};
const topicTitle=t=>(TOPIC[t]||["Notification"])[0],topicIcon=t=>TOPIC_SVG[t]||TOPIC_SVG._,topicCls=t=>"t-"+(TOPIC_SVG[t]?t:"x");
const when=t=>{try{return new Date(t).toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"})}catch{return""}};
function ago(t){const s=Math.max(0,(Date.now()-new Date(t))/1000);if(s<60)return"Just now";if(s<3600)return Math.floor(s/60)+" min ago";if(s<86400)return Math.floor(s/3600)+" h ago";
  const d=new Date(t),n=new Date();const y=new Date(n.getFullYear(),n.getMonth(),n.getDate()-1);
  if(d>=y)return"Yesterday";return d.toLocaleDateString(undefined,{day:"numeric",month:"short"})}
const dayKey=t=>{const d=new Date(t);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime()};
function dayLabel(k){const n=new Date(),t0=new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime();if(k===t0)return"Today";if(k===t0-864e5)return"Yesterday";return new Date(k).toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short",year:"numeric"})}
const num=(v,d=2)=>Number(v).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
const trimNum=v=>{const n=Number(v);return n.toFixed(8).replace(/\.?0+$/,"")||"0"};
const usd=v=>"$"+num(v,2);
function openFeature(id){const el=$(id);el.hidden=false;el.scrollTop=0;document.body.classList.add("wd-feature-open")}
function closeFeature(id,keepBody){$(id).hidden=true;if(!keepBody&&document.querySelectorAll(".wd-feature-page:not([hidden])").length===0)document.body.classList.remove("wd-feature-open")}

/* ====================================================== NOTIFICATIONS */
let notifs=[],recent=new Set(),openNotifId=null;
const unread=()=>notifs.filter(n=>!n.read).length;
function paintBadge(){
  const b=$("notifyButton");if(!b)return;let dot=b.querySelector(".wd-bell-badge");
  const c=unread();
  if(!c){if(dot)dot.remove();return}
  if(!dot){dot=document.createElement("span");dot.className="wd-bell-badge";b.appendChild(dot)}
  dot.textContent=c>9?"9+":String(c);
}
function range(){const el=document.querySelector("[data-notification-range].is-selected");return el?el.dataset.notificationRange:"all"}
function inRange(t,r){if(r==="all")return true;const n=new Date(),t0=new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime(),x=new Date(t).getTime();
  if(r==="today")return x>=t0;if(r==="yesterday")return x>=t0-864e5&&x<t0;if(r==="7days")return x>=t0-6*864e5;if(r==="30days")return x>=t0-29*864e5;return true}
function paintNotifs(){
  const list=$("notifList"),empty=document.querySelector("#notificationPage .wd-notification-empty");if(!list)return;
  const rows=notifs.filter(n=>inRange(n.created_at,range()));
  empty.hidden=notifs.length>0&&rows.length>0;
  if(!notifs.length){list.hidden=true;empty.querySelector("h2").textContent="No notifications yet";empty.querySelector("p").textContent="Your updates and alerts will appear here.";return}
  if(!rows.length){list.hidden=true;empty.hidden=false;empty.querySelector("h2").textContent="Nothing in this period";empty.querySelector("p").textContent="Try a different date filter.";return}
  list.hidden=false;
  let html="",last=null;
  for(const n of rows){const k=dayKey(n.created_at);if(k!==last){html+=`<div class="wd-act-day">${esc(dayLabel(k))}</div>`;last=k}
    html+=`<button type="button" class="wd-act-row${n.read?"":" unread"}" data-nid="${esc(n.id)}"><span class="wd-act-ic ${topicCls(n.topic)}">${topicIcon(n.topic)}</span><span class="wd-act-main"><b>${esc(n.title)}</b><small>${esc(n.body)}</small></span><span class="wd-act-side"><em>${esc(ago(n.created_at))}</em>${n.read?"":"<i></i>"}</span></button>`}
  list.innerHTML=html;
}
async function loadNotifs(){if(!signedIn())return;try{notifs=await db().notif.list();paintBadge();paintNotifs()}catch(e){console.error("Notifications could not be loaded",e)}}
async function push(topic,msg,title){
  if(!signedIn())return;const id=db().notif.uuid();recent.add(id);setTimeout(()=>recent.delete(id),60000);
  try{await db().notif.push(topic,title||topicTitle(topic),msg,id)}catch(e){console.error("Notification not saved",e);return}
  loadNotifs();
}
window.addEventListener("veltrix-notif",e=>{
  const d=e.detail||{};
  if(d.type==="INSERT"&&d.row){
    if(!notifs.some(n=>n.id===d.row.id))notifs.unshift(d.row);
    if(!recent.has(d.row.id))toast(d.row.title+": "+d.row.body);
    paintBadge();paintNotifs();
  }else if(d.type==="DELETE"&&d.old){notifs=notifs.filter(n=>n.id!==d.old.id);paintBadge();paintNotifs();if(openNotifId===d.old.id){closeFeature("notificationDetailPage",true);openNotifId=null}}
  else if(d.type==="UPDATE"&&d.row){const i=notifs.findIndex(n=>n.id===d.row.id);if(i>=0)notifs[i]=d.row;paintBadge();paintNotifs()}
});
function openNotif(id){
  const n=notifs.find(x=>x.id===id);if(!n)return;openNotifId=id;
  $("ndIcon").innerHTML=topicIcon(n.topic);$("ndIcon").className="wd-act-ic big "+topicCls(n.topic);$("ndTopic").textContent=topicTitle(n.topic);$("ndTitle").textContent=n.title;$("ndBody").textContent=n.body;$("ndTime").textContent=when(n.created_at);$("ndRows").innerHTML=[["Type",topicTitle(n.topic)],["Received",when(n.created_at)]].map(r=>`<div class="nd-row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join("");
  openFeature("notificationDetailPage");
  if(!n.read){n.read=true;paintBadge();paintNotifs();db().notif.markRead(id).catch(()=>{})}
}
document.addEventListener("click",e=>{
  const row=e.target.closest("#notifList [data-nid]");if(row){openNotif(row.dataset.nid);return}
  if(e.target.closest("#notificationDetailBack")){closeFeature("notificationDetailPage",true);openNotifId=null;return}
  if(e.target.closest("#notificationDeleteBtn")){deleteOpen();return}
  if(e.target.closest("#notifyButton")){loadNotifs();return}
  if(e.target.closest("#notificationFilterApply")){setTimeout(paintNotifs,0);return}
});
async function deleteOpen(){
  const id=openNotifId;if(!id)return;
  const ok=window.veltrixDialog?await veltrixDialog({title:"Delete this notification?",msg:"It will be removed from your notifications.",ok:"Delete",danger:true}):confirm("Delete this notification?");
  if(!ok)return;
  try{await db().notif.remove(id);notifs=notifs.filter(n=>n.id!==id);openNotifId=null;closeFeature("notificationDetailPage",true);paintBadge();paintNotifs();toast("Notification deleted")}
  catch{toast("Couldn't delete. Please try again.")}
}

/* ====================================================== TRANSACTION HISTORY */
let txRows=[],txAll=[],openTx=null,openRows=[];
const EMPTY_TX_SVG='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M6 8V1h1v6.117L8.743 6.07a.5.5 0 0 1 .514 0L11 7.117V1h1v7a.5.5 0 0 1-.757.429L9 7.083 6.757 8.43A.5.5 0 0 1 6 8"/><path d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2"/><path d="M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z"/></svg>';
function txView(t){
  const n=Number(t.amount),u=t.usd_value==null?null:Number(t.usd_value);
  if(t.kind==="send")return{icon:"↗",title:"Sent "+t.symbol,sub:t.internal&&t.counterparty_name?"To "+t.counterparty_name:t.to_address?"To "+short(t.to_address):"Withdrawal",amt:"-"+trimNum(n)+" "+t.symbol,sub2:u!=null?"≈ "+usd(u):"",dir:"out",type:"Send"};
  if(t.kind==="deposit")return{icon:"↙",title:"Received "+t.symbol,sub:t.internal&&t.counterparty_name?"From "+t.counterparty_name:"Deposit",amt:"+"+trimNum(n)+" "+t.symbol,sub2:u!=null?"≈ "+usd(u):"",dir:"in",type:"Deposit"};
  return{icon:"⇄",title:"Converted "+t.symbol,sub:"Conversion",amt:"-"+trimNum(n)+" "+t.symbol,sub2:u!=null?"≈ "+usd(u):"",dir:"out",type:"Conversion"};
}
/* queued / processing (an automatic withdrawal being sent) count as pending everywhere, but are labelled "Processing" */
const stN=t=>{const x=String(t.status||"completed").toLowerCase();return x==="queued"||x==="processing"?"pending":x};
const stProc=t=>{const x=String(t.status||"").toLowerCase();return x==="queued"||x==="processing"};
const stPill=t=>{const st=stN(t);return st==="completed"?"":` <span class="wd-tx-st ${st==="pending"?"pending":"cancelled"}">${st==="pending"?(stProc(t)?"Processing":"Pending"):st==="cancelled"?"Cancelled":esc(st)}</span>`};
const short=a=>a.length>22?a.slice(0,10)+"…"+a.slice(-8):a;
const txSv=(d,w)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w||1.9}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const TX_ICON={
  recv:'<path d="M17 7 7 17"/><path d="M15.500 17H7V8.500"/>',
  send:'<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
  convert:'<path d="m16.5 3.5 3.5 3.5-3.5 3.5"/><path d="M20 7H8.5a4.5 4.5 0 0 0-4.5 4.5"/><path d="m7.5 20.5L4 17l3.500-3.500"/><path d="M4 17h11.500a4.500 4.500 0 0 0 4.500-4.500"/>',
  clock:'<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 1.800"/>',
  x:'<path d="m7 7 10 10M17 7 7 17"/>',
  wifiOff:'<path d="m3 3 18 18"/><path d="M9.200 5.400A14 14 0 0 1 12 5c3.600 0 6.800 1.300 9 3.500"/><path d="M3 8.500a14.600 14.600 0 0 1 3.200-2.300"/><path d="M6.500 12.200a9.800 9.800 0 0 1 3.300-1.900"/><path d="M14.500 10.500a9.800 9.800 0 0 1 3 1.700"/><path d="M9.500 15.800a5.200 5.200 0 0 1 5 0"/><path d="M12 19.500h.01"/>',
  retry:'<path d="M20 11a8 8 0 0 0-14.500-4.200L3.500 9"/><path d="M3.500 4v5h5"/><path d="M4 13a8 8 0 0 0 14.500 4.200l2-2.200"/><path d="M20.500 20v-5h-5"/>'
};
function txIcon(t){
  const st=stN(t),mod=st==="pending"?" is-pending":st==="cancelled"?" is-cancelled":"";
  if(t.kind==="send")return{cls:"t-withdrawal"+mod,svg:txSv(TX_ICON.send,2.1)};
  if(t.kind==="deposit")return{cls:"t-deposit"+mod,svg:txSv(TX_ICON.recv,2.1)};
  return{cls:"t-transaction"+mod,svg:txSv(TX_ICON.convert,2)};
}
/* round-corner tile + a small status badge (clock = pending, cross = cancelled) for the history rows */
function txTile(t){
  const ic=txIcon(t),st=stN(t);
  const bdg=st==="pending"?`<i class="wd-tx-bdg pending">${txSv(TX_ICON.clock,2.6)}</i>`:st==="cancelled"?`<i class="wd-tx-bdg cancelled">${txSv(TX_ICON.x,3)}</i>`:"";
  return `<span class="wd-act-ic wd-tx-tile ${ic.cls}">${ic.svg}${bdg}</span>`;
}
const stCls=t=>{const st=stN(t);return st==="pending"?" st-pending":st==="cancelled"?" st-cancelled":""};

/* ---- no connection / couldn't load: shown inside the history sections ---- */
const isOffline=()=>typeof navigator!=="undefined"&&navigator.onLine===false;
const netErr=e=>{const m=String((e&&(e.message||e.details))||e||"");return isOffline()||/failed to fetch|networkerror|network request failed|load failed|timeout|timed out|offline/i.test(m)};
function netCard(kind,compact){
  const off=kind==="offline";
  return `<div class="wd-net${compact?" compact":""}${off?"":" err"}" role="alert"><span class="wd-net-ic">${txSv(off?TX_ICON.wifiOff:TX_ICON.clock,1.7)}</span><strong>${off?"No internet connection":"Couldn't load your history"}</strong><p>${off?"Check your Wi-Fi or mobile data. Your transactions will load automatically once you're back online.":"Something went wrong while loading. Please try again."}</p><button type="button" class="wd-net-btn" data-net-retry>${txSv(TX_ICON.retry,2.2)}<span>Try again</span></button></div>`;
}
const _unusedNetStrip=()=>`<div class="wd-net-strip" role="status">${txSv(TX_ICON.wifiOff,2)}<span>You're offline. Showing your last loaded transactions.</span></div>`;
function txCardHTML(t,i){const v=txView(t),ic=txIcon(t);
  return `<div class="wd-txc-card" role="button" tabindex="0" data-tx="d:${i}"><span class="wd-act-ic wd-txc-ic ${ic.cls}">${ic.svg}</span><div class="wd-txc-txt"><b>${esc(v.title)}${t.test?' <span class="wd-tx-test">Test</span>':""}${stPill(t)}</b><small class="${v.dir}">${esc(v.amt)}${v.sub2?" · "+esc(v.sub2):""}</small><em>${esc(v.sub)} · ${esc(ago(t.created_at))}</em></div><span class="wd-txc-go">View</span></div>`}
function txCarouselHTML(rows){
  return `<div class="wd-txc-track${rows.length===1?" one":""}">${rows.map(txCardHTML).join("")}</div>`+(rows.length>1?`<div class="wd-txc-dots" aria-hidden="true">${rows.map((_,i)=>`<i${i?"":' class="on"'}></i>`).join("")}</div>`:"");
}
function txRowHTML(t,i,src){const v=txView(t);
  return `<button type="button" class="wd-row wd-tx-row${stCls(t)}" data-tx="${src}:${i}">${txTile(t)}<div class="wd-coin-info"><b>${esc(v.title)}${t.test?' <span class="wd-tx-test">Test</span>':""}${stPill(t)}</b><small>${esc(v.sub)} · ${esc(ago(t.created_at))}</small></div><div class="wd-coin-value wd-tx-amt ${v.dir}">${esc(v.amt)}${v.sub2?`<small>${esc(v.sub2)}</small>`:""}</div></button>`}
/* Empty history: a "ghost ledger" (faded sample rows on a dashed rail) - deliberately NOT the icon + text block the assets list uses */
function txEmptyHTML(m){
  const ghost=(w1,w2)=>`<div class="tx-gh-row"><span class="tx-gh-dot"></span><span class="tx-gh-lines"><i style="width:${w1}%"></i><i style="width:${w2}%"></i></span><span class="tx-gh-amt"></span></div>`;
  const chips=["Deposits","Withdrawals","Swaps"];
  return `<div class="tx-empty" role="status"><div class="tx-gh" aria-hidden="true">${ghost(46,28)}${ghost(58,34)}</div>
   <div class="tx-empty-body"><strong>Your activity starts here</strong>
   <p>Every deposit, withdrawal and swap is listed here, newest first.</p>
   <div class="tx-empty-chips">${chips.map(c=>`<span>${c}</span>`).join("")}</div>
   <button type="button" class="tx-empty-cta" data-tx-cta="deposit">Make a deposit</button></div></div>`;
}
function paintMode(){
  const m=mode(),t=$("txTitle");if(!t)return;
  t.textContent="Crypto history";
  const f=$("txHistoryTitle");if(f)f.textContent="Crypto history";
  refreshTx();
}
let txMode=null;
async function refreshTx(){
  if(!$("txList"))return;
  if(!signedIn()){$("txList").innerHTML="";$("txViewAll").hidden=true;const sc=$("txSection");if(sc)sc.classList.remove("tx-is-empty");return}
  const m=mode();let net=null;
  if(txMode!==m){txRows=[];txMode=m}
  if(!txRows.length&&!isOffline()){$("txList").classList.remove("wd-txc");vxSkeleton.fill($("txList"),3,"tx")}
  if(isOffline())net="offline";
  else{try{txRows=await db().tx.list(m,5)}catch(e){console.error("History could not be loaded",e);net=netErr(e)?"offline":"error"}}
  if(m!==mode())return;
  const slider=txRows.length>0;$("txList").classList.toggle("wd-txc",slider);
  const body=txRows.length?(slider?txCarouselHTML(txRows):txRows.map((t,i)=>txRowHTML(t,i,"d")).join("")):"";
  if(net==="offline")showOffline();
  if(net)$("txList").innerHTML=txRows.length?body:(net==="offline"?"":netCard(net,true));
  else $("txList").innerHTML=txRows.length?body:txEmptyHTML(m);
  const sec=$("txSection");if(sec)sec.classList.toggle("tx-is-empty",!net&&!txRows.length);
  $("txViewAll").hidden=txRows.length<5;
}
function openDetail(t){
  openTx=t;const v=txView(t),ic=txIcon(t);
  $("tdIcon").innerHTML=ic.svg;$("tdIcon").className="wd-act-ic big "+ic.cls;
  const h=$("tdAmount");h.textContent=v.amt;h.className=v.dir;$("tdSub").textContent=v.title;
  const stl=stN(t),st=stProc(t)?"Processing":stl.replace(/^./,c=>c.toUpperCase()),sc=$("tdStatus");sc.textContent=stl==="completed"?"Successful":st;sc.className="wd-act-chip"+(stl==="completed"?" ok":stl==="pending"?" pending":stl==="cancelled"?" cancelled":"");
  const rows=[["Type",v.type],["Status",stl==="completed"?"Successful":st],["Date",when(t.created_at)]];
  if(stl==="cancelled"&&t.cancel_reason)rows.push(["Reason",t.cancel_reason]);
  if(t.kind==="send"){rows.push(["Amount",trimNum(t.amount)+" "+t.symbol]);if(t.usd_value!=null)rows.push(["Value",usd(t.usd_value)]);if(t.internal&&t.counterparty_name)rows.push(["Recipient",t.counterparty_name]);if(t.to_address)rows.push(["To",t.to_address,"copy"]);if(t.network)rows.push(["Network",t.network])}
  else if(t.kind==="deposit"){rows.push(["Received",trimNum(t.amount)+" "+t.symbol]);if(t.usd_value!=null)rows.push(["Value at receipt",usd(t.usd_value)]);if(t.internal&&t.counterparty_name)rows.push(["From",t.counterparty_name]);if(t.to_address)rows.push(["Deposit address",t.to_address,"copy"]);if(t.network)rows.push(["Network",t.network])}
  else{rows.push(["Amount",trimNum(t.amount)+" "+t.symbol]);if(t.usd_value!=null)rows.push(["Value",usd(t.usd_value)])}
  if(t.tx_hash)rows.push(["Transaction hash",t.tx_hash,"copy"]);
  if(t.reference)rows.push(["Reference",t.reference,"copy"]);
  openRows=rows;
  $("tdRows").innerHTML=rows.map(r=>`<div class="nd-row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b>${r[2]?`<button type="button" class="nd-copy" data-copy-val="${esc(r[1])}" aria-label="Copy ${esc(r[0])}">Copy</button>`:""}</div>`).join("");
  openFeature("txDetailPage");
}

/* ---- receipt image (drawn on a canvas, so no external images are needed) ---- */
function wrapText(ctx,text,maxW){
  const lines=[];let cur="";
  for(const w of String(text).split(" ")){
    const t=cur?cur+" "+w:w;if(ctx.measureText(t).width<=maxW){cur=t;continue}
    if(cur){lines.push(cur);cur=""}
    if(ctx.measureText(w).width<=maxW){cur=w;continue}
    for(const ch of w){if(ctx.measureText(cur+ch).width>maxW){lines.push(cur);cur=ch}else cur+=ch}
  }
  if(cur)lines.push(cur);return lines.length?lines:[""];
}
function rrect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
let logoImg=null;
function loadLogo(){
  if(logoImg)return logoImg;
  logoImg=new Promise(res=>{if(!window.VELTRIX_LOGO)return res(null);const i=new Image();i.onload=()=>res(i);i.onerror=()=>res(null);i.src=window.VELTRIX_LOGO});
  return logoImg;
}
/* Receipt styled like a bank-app transfer receipt: logo top-left, centred amount + status, small detail rows,
   plain white edges and the Veltrix logo repeated as a faint watermark. */
let receiptTitle="Veltrix receipt";
/* Receipt text follows the app language: every label/sentence goes through the same translator as the rest of the app
   (the canvas is skipped by the page translator, so it is translated here before drawing). Amounts, addresses, networks,
   coin symbols and references are data and are never translated. */
const RCPT_TR_VALUES=new Set(["Send","Conversion","Deposit","Crypto wallet"]);
const RCPT_NOTE="Veltrix keeps your crypto sends simple and secure. Keep this receipt as proof of your transaction.";
async function receiptBlob(t){
  const logo=await loadLogo();
  const W=360,S=4,pad=20,FONT='-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',v=txView(t);
  const L=window.veltrixLang?veltrixLang():{code:"en",rtl:false},rtl=!!L.rtl;
  const st=stN(t),stEn=st==="completed"?"Successful":stProc(t)?"Processing":st.replace(/^./,c=>c.toUpperCase());
  const amtCol=st==="completed"?"#0f9d58":st==="pending"?"#d98a00":"#d93a49";
  const rawRows=openRows.filter(r=>r[0]!=="Status"&&r[0]!=="Date");
  const noteEn=RCPT_NOTE;
  const valIdx=[];rawRows.forEach((r,i)=>{if(RCPT_TR_VALUES.has(r[1])||r[0]==="Reason")valIdx.push(i)});
  const src=["Transaction Receipt","Veltrix receipt",stEn,noteEn,...rawRows.map(r=>r[0]),...valIdx.map(i=>rawRows[i][1])];
  let out=src;try{out=window.veltrixTranslate?await veltrixTranslate(src):src}catch{out=src}
  const [hdrTxt,shareTxt,stTxt,noteTxt]=out,keys=out.slice(4,4+rawRows.length),vals=out.slice(4+rawRows.length);
  receiptTitle=shareTxt||"Veltrix receipt";
  const rows=rawRows.map((r,i)=>{const k=valIdx.indexOf(i);return[keys[i],k>=0?vals[k]:r[1]]});
  let dateTxt;try{dateTxt=new Date(t.created_at).toLocaleString(L.code,{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"})}catch{dateTxt=when(t.created_at)}
  const START=rtl?"right":"left",END=rtl?"left":"right",X0=rtl?W-pad:pad,X1=rtl?pad:W-pad;
  const m=document.createElement("canvas").getContext("2d");
  m.font='400 10px '+FONT;const keyW=Math.min(150,Math.max(96,Math.ceil(Math.max(...rows.map(r=>m.measureText(r[0]).width),0))+14));
  m.font='700 10px '+FONT;
  const valW=W-pad*2-keyW,laid=rows.map(r=>{const ls=wrapText(m,r[1],valW);return{k:r[0],ls,h:ls.length*13+12}});
  const rowsH=laid.reduce((a,r)=>a+r.h,0);
  m.font='400 8.5px '+FONT;
  const note=wrapText(m,noteTxt,W-pad*2);
  const top=160,H=top+rowsH+26+note.length*12+22;
  const cv=document.createElement("canvas");cv.width=W*S;cv.height=H*S;const c=cv.getContext("2d");c.scale(S,S);
  c.direction=rtl?"rtl":"ltr";
  c.fillStyle="#fff";c.fillRect(0,0,W,H);
  /* watermark: faint tilted logos in a staggered grid (drawn first, so text stays crisp on top) */
  if(logo){
    const ww=88,wh=ww/(logo.width/logo.height);
    c.save();c.globalAlpha=.07;
    for(let row=0,y=40;y<H+40;row++,y+=74){
      for(let x=(row%2?-30:20);x<W+60;x+=130){c.save();c.translate(x+ww/2,y);c.rotate(-.35);c.drawImage(logo,-ww/2,-wh/2,ww,wh);c.restore()}
    }
    c.restore();
  }
  /* header */
  if(logo){const lh=15,lw=lh*(logo.width/logo.height);c.drawImage(logo,rtl?W-pad-lw:pad,26,lw,lh)}
  else{c.fillStyle="#111";c.font='800 16px '+FONT;c.textAlign=START;c.fillText("Veltrix",X0,38)}
  c.textAlign=END;c.fillStyle="#2b2d33";c.font='400 10.5px '+FONT;c.fillText(hdrTxt,X1,37);
  /* amount + status + date */
  c.textAlign="center";c.fillStyle=amtCol;c.font='800 22px '+FONT;
  let amt=v.amt;for(let sz=22;c.measureText(amt).width>W-pad*2&&sz>13;sz--)c.font='800 '+sz+'px '+FONT;
  c.fillText(amt,W/2,88);
  c.fillStyle="#17181d";c.font='500 12.5px '+FONT;c.fillText(stTxt,W/2,110);
  c.fillStyle="#8a8d96";c.font='400 8.5px '+FONT;c.fillText(dateTxt+(v.sub2?"   ·   "+v.sub2:""),W/2,126);
  c.strokeStyle="#dcdee3";c.lineWidth=.6;c.beginPath();c.moveTo(pad,146);c.lineTo(W-pad,146);c.stroke();
  /* rows */
  let y=top;
  for(const r of laid){
    c.textAlign=START;c.fillStyle="#8a8d96";c.font='400 10px '+FONT;c.fillText(r.k,X0,y+10);
    c.textAlign=END;c.fillStyle="#17181d";c.font='700 10px '+FONT;
    r.ls.forEach((ln,i)=>c.fillText(ln,X1,y+10+i*13));
    y+=r.h;
  }
  /* footer */
  c.strokeStyle="#cfd2d8";c.lineWidth=.6;c.setLineDash([3,3]);c.beginPath();c.moveTo(pad,y+8);c.lineTo(W-pad,y+8);c.stroke();c.setLineDash([]);
  c.textAlign=START;c.fillStyle="#8a8d96";c.font='400 8.5px '+FONT;
  note.forEach((ln,i)=>c.fillText(ln,X0,y+26+i*12));
  return new Promise((res,rej)=>cv.toBlob(b=>b?res(b):rej(new Error("no image")),"image/png"));
}
function receiptName(t){return "veltrix-receipt-"+String(t.reference||t.id||Date.now()).replace(/[^a-z0-9]/gi,"").slice(0,12)+".png"}
function saveBlob(blob,name){const u=URL.createObjectURL(blob),a=document.createElement("a");a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),5000)}
async function receiptAction(kind){
  const t=openTx;if(!t)return;const btn=$(kind==="share"?"tdShare":"tdDownload");btn.disabled=true;
  try{
    const blob=await receiptBlob(t),name=receiptName(t);
    if(kind==="download"){saveBlob(blob,name);toast("Receipt downloaded");return}
    const file=new File([blob],name,{type:"image/png"});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file],title:receiptTitle})}catch(err){if(!err||err.name!=="AbortError")throw err}
    }else{saveBlob(blob,name);toast("Sharing isn't available here, so the receipt was downloaded instead")}
  }catch(e){console.error(e);toast("Couldn't create the receipt. Please try again.")}
  finally{btn.disabled=false}
}
/* ---- full-screen "No internet connection" section ---- */
const offOpen=()=>!$("txOfflinePage").hidden;
let offDismissed=false,netDown=false;
/* bottom pop-up: stays up after the full-screen notice is dismissed, until the connection / data is back */
function sheetEl(){
  let s=$("wdOffSheet");if(s)return s;
  s=document.createElement("div");s.id="wdOffSheet";s.className="wd-offsheet";s.setAttribute("role","alert");
  s.innerHTML=`<span class="wd-offsheet-grab" aria-hidden="true"></span><div class="wd-offsheet-body"><span class="wd-offsheet-ic">${txSv(TX_ICON.wifiOff,1.8)}</span><div class="wd-offsheet-txt"><strong>No internet connection</strong><p>Your history and balances can't update. This will close by itself once you're back online.</p></div></div><div class="wd-offsheet-live"><i></i><span>Waiting for connection…</span></div><button type="button" class="wd-offsheet-btn" id="wdOffSheetRetry">${txSv(TX_ICON.retry,2.2)}<span>Try again</span></button>`;
  if(!$("wdOffScrim")){const sc=document.createElement("div");sc.id="wdOffScrim";sc.className="wd-offscrim";sc.setAttribute("aria-hidden","true");document.body.appendChild(sc)}
  document.body.appendChild(s);return s;
}
function syncSheet(){
  const on=netDown&&offDismissed&&!offOpen(),s=sheetEl();
  const sc=$("wdOffScrim");if(sc)sc.classList.toggle("show",on);
  if(on){s.hidden=false;requestAnimationFrame(()=>requestAnimationFrame(()=>s.classList.add("show")))}
  else{s.classList.remove("show");setTimeout(()=>{if(!s.classList.contains("show"))s.hidden=true},320)}
}
function showOffline(force){
  netDown=true;
  if(offOpen())return;if(offDismissed&&!force){syncSheet();return}
  offDismissed=false;
  const b=$("txOfflineRetry");if(b){b.disabled=false;b.querySelector("span").textContent="Try again"}
  const el=$("txOfflinePage");el.style.zIndex="13000";openFeature("txOfflinePage");syncSheet();
}
function hideOffline(){if(offOpen())closeFeature("txOfflinePage")}
function dismissOffline(){offDismissed=true;hideOffline();syncSheet()}
/* real reachability check: asks the server when signed in, otherwise a tiny public request */
async function probeNet(){
  if(isOffline())throw new Error("offline");
  if(signedIn()){await db().tx.list(mode(),1);return}
  await fetch("https://www.gstatic.com/generate_204",{mode:"no-cors",cache:"no-store"});
}
function backOnline(){
  netDown=false;offDismissed=false;hideOffline();syncSheet();
  if(signedIn()){refreshTx();loadNotifs();if(!$("txHistoryPage").hidden)loadAll()}
}
async function retryNet(){
  const b=$("txOfflineRetry"),sb=$("wdOffSheetRetry"),lab=x=>{[b,sb].forEach(z=>{if(z){z.disabled=x!=="Try again";z.querySelector("span").textContent=x}})};
  if(isOffline()){toast("Still no connection");return}
  lab("Checking…");
  try{await probeNet();backOnline();toast("You're back online")}
  catch(e){toast(netErr(e)?"Still no connection":"Couldn't connect. Please try again.")}
  finally{lab("Try again")}
}
function paintAll(net){
  if(net==="offline")showOffline();
  if(net&&!txAll.length){$("txAllList").innerHTML=net==="offline"?"":netCard(net,false);return}
  if(!net)hideOffline();
  if(!txAll.length){$("txAllList").innerHTML='<div class="wd-act-note">No transactions yet.</div>';return}
  let html="",last=null;txAll.forEach((t,i)=>{const k=dayKey(t.created_at);if(k!==last){html+=`<div class="wd-act-day">${esc(dayLabel(k))}</div>`;last=k}html+=txRowHTML(t,i,"a")});
  $("txAllList").innerHTML=html;
}
async function openAll(){
  $("txHistoryTitle").textContent="Crypto history";
  if(!txAll.length)vxSkeleton.fill($("txAllList"),6,"tx");
  openFeature("txHistoryPage");loadAll();
}
async function loadAll(){
  if(isOffline()){paintAll("offline");return}
  try{txAll=await db().tx.list(mode(),500);paintAll(null)}
  catch(e){console.error("Full history could not be loaded",e);paintAll(netErr(e)?"offline":"error")}
}
/* connection comes back / drops while the sections are on screen */
window.addEventListener("online",backOnline);
window.addEventListener("offline",()=>{offDismissed=false;showOffline();refreshTx();if(!$("txHistoryPage").hidden)paintAll("offline")});
/* already offline when the app opens */
if(isOffline())showOffline();
document.addEventListener("scroll",e=>{
  const tr=e.target;if(!tr||!tr.classList||!tr.classList.contains("wd-txc-track"))return;
  const dots=tr.parentNode.querySelectorAll(".wd-txc-dots i");if(!dots.length)return;
  const c=tr.querySelector(".wd-txc-card");if(!c)return;
  const step=c.getBoundingClientRect().width+10,max=tr.scrollWidth-tr.clientWidth;
  let idx=tr.scrollLeft>=max-2?dots.length-1:Math.round(tr.scrollLeft/step);
  dots.forEach((d,i)=>d.classList.toggle("on",i===idx));
},true);
document.addEventListener("keydown",e=>{if((e.key==="Enter"||e.key===" ")&&e.target.classList&&e.target.classList.contains("wd-txc-card")){e.preventDefault();e.target.click()}});
document.addEventListener("click",e=>{
  if(e.target.closest("#txOfflineRetry")){retryNet();return}
  if(e.target.closest("#wdOffSheetRetry")){retryNet();return}
  if(e.target.closest("#txOfflineBack,#txOfflineSkip")){dismissOffline();if(!$("txHistoryPage").hidden&&!txAll.length)closeFeature("txHistoryPage");return}
  if(e.target.closest("[data-net-retry]")){e.stopPropagation();if(isOffline()){toast("Still no connection");return}refreshTx();if(!$("txHistoryPage").hidden)loadAll();return}
    if(e.target.closest("#tdShare")){receiptAction("share");return}
  if(e.target.closest("#tdDownload")){receiptAction("download");return}
  const cta=e.target.closest("[data-tx-cta]");if(cta){if(window.openDepositPage)openDepositPage();return}
  const r=e.target.closest("[data-tx]");if(r){const [src,i]=r.dataset.tx.split(":");const t=(src==="a"?txAll:txRows)[+i];if(t)openDetail(t);return}
  if(e.target.closest("#txViewAll")){openAll();return}
  if(e.target.closest("#txHistoryBack")){closeFeature("txHistoryPage");return}
  if(e.target.closest("#txDetailBack")){closeFeature("txDetailPage",true);return}
  const c=e.target.closest("[data-copy-val]");if(c){const v=c.dataset.copyVal;(navigator.clipboard?navigator.clipboard.writeText(v):Promise.reject()).then(()=>toast("Copied")).catch(()=>toast("Copy not supported"))}
});

/* ====================================================== WATCHLIST + PRICE ALERTS */
let wl=new Map(),pollT=null;
async function loadWatch(){if(!signedIn())return;try{const r=await db().watch.list();wl=new Map(r.map(x=>[x.symbol,{...x,base_price:Number(x.base_price)}]))}catch(e){console.error("Watchlist could not be loaded",e)}}
function paintFav(on){const b=$("marketFavorite");if(!b)return;b.setAttribute("aria-pressed",String(!!on));b.setAttribute("aria-label",on?"Remove from watchlist":"Add to watchlist");b.style.color=on?"#f0476b":"";const s=b.querySelector("svg");if(s)s.style.fill=on?"currentColor":"none"}
async function livePrice(id){try{const r=await fetch("https://api.coingecko.com/api/v3/simple/price?ids="+encodeURIComponent(id)+"&vs_currencies=usd");const j=await r.json();return Number(j[id]&&j[id].usd)||0}catch{return 0}}
async function toggleWatch(coin){
  if(!coin||!signedIn())return;
  const sym=String(coin.symbol).toUpperCase();
  if(wl.has(sym)){
    try{await db().watch.remove(sym);wl.delete(sym);paintFav(false);toast("Removed from watchlist")}catch{toast("Couldn't update your watchlist")}return}
  let price=Number(coin.price);if(!(price>0))price=await livePrice(coin.id);
  if(!(price>0)){toast("Price unavailable right now. Try again.");return}
  try{await db().watch.add({symbol:sym,coin_id:coin.id,name:coin.name,base_price:price});wl.set(sym,{symbol:sym,coin_id:coin.id,name:coin.name,base_price:price});paintFav(true);toast("Added to watchlist. You'll get price alerts.");startPoll()}
  catch{toast("Couldn't update your watchlist")}
}
async function pollWatch(){
  if(!signedIn()||!wl.size||document.hidden)return;
  const ids=[...new Set([...wl.values()].map(r=>r.coin_id))].join(",");
  let j;try{const r=await fetch("https://api.coingecko.com/api/v3/simple/price?ids="+encodeURIComponent(ids)+"&vs_currencies=usd");if(!r.ok)return;j=await r.json()}catch{return}
  for(const r of wl.values()){
    const p=Number(j[r.coin_id]&&j[r.coin_id].usd);if(!(p>0)||!(r.base_price>0))continue;
    const ratio=p/r.base_price,pct=Math.abs(ratio-1)*100;
    const priceTxt="$"+(p>=1?num(p,2):p.toPrecision(4));
    let msg=null;
    if(ratio>=PRICE_UP)msg=`${r.symbol} is up ${num(pct,1)}% and now trades at ${priceTxt}.`;
    else if(ratio<=PRICE_DOWN)msg=`${r.symbol} is down ${num(pct,1)}% and now trades at ${priceTxt}.`;
    if(msg){r.base_price=p;db().watch.rebase(r.symbol,p).catch(()=>{});
      if(window.veltrixNotify)veltrixNotify("price",msg,r.symbol+(ratio>=1?" price up":" price down"));}
  }
}
function startPoll(){if(pollT)return;pollT=setInterval(pollWatch,POLL_MS);setTimeout(pollWatch,3000)}
document.addEventListener("click",e=>{if(e.target.closest("#marketFavorite")){e.stopImmediatePropagation();toggleWatch(window.activeMarketCoin||(typeof activeMarketCoin!=="undefined"?activeMarketCoin:null))}},true);

/* ====================================================== lifecycle */
function reset(){notifs=[];txRows=[];txAll=[];wl=new Map();paintBadge();paintNotifs();refreshTx();clearInterval(pollT);pollT=null}
window.addEventListener("veltrix-ready",async()=>{
  if(!signedIn()){reset();return}
  paintMode();await Promise.all([loadNotifs(),loadWatch()]);if(wl.size)startPoll();
});
window.addEventListener("veltrix-revoked",reset);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&signedIn()){pollWatch();loadNotifs()}});

window.veltrixActivity={push,refreshTx,paintMode,syncFav:coin=>paintFav(!!(coin&&wl.has(String(coin.symbol).toUpperCase()))),reload:loadNotifs,topicSvg:topicIcon};
window.veltrixWatch={sync:coin=>paintFav(!!(coin&&wl.has(String(coin.symbol).toUpperCase()))),toggle:toggleWatch};
})();
