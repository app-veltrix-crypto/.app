/* Veltrix · activity: notifications feed, price alerts (watchlist) and transaction history.
   Data lives in Supabase (notifications, watchlist, transactions); this file is the screens + the glue. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const toast=m=>{try{wdToast(m)}catch{}};
const db=()=>window.veltrixDB;
const signedIn=()=>!!(db()&&db().get&&db().get());
const mode=()=>(window.getAccountMode&&getAccountMode()==="usd")?"usd":"crypto";

/* ====================================================== price-alert thresholds (change here) */
const PRICE_UP=1.10;    /* alert when a watched coin is 10% above the price it was measured from */
const PRICE_DOWN=0.90;  /* alert when it is 10% below */
const POLL_MS=60000;

/* ====================================================== helpers */
const TOPIC={security:["Security alert","🛡"],chat:["Chat message","💬"],transaction:["Transaction","⇄"],withdrawal:["Withdrawal","↗"],deposit:["Deposit","↙"],price:["Price alert","📈"],login:["New login","🔑"],promo:["Promotion","🎁"],news:["News & updates","📰"]};
const topicTitle=t=>(TOPIC[t]||["Notification"])[0],topicIcon=t=>(TOPIC[t]||[,"🔔"])[1];
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
    html+=`<button type="button" class="wd-act-row${n.read?"":" unread"}" data-nid="${esc(n.id)}"><span class="wd-act-ic">${topicIcon(n.topic)}</span><span class="wd-act-main"><b>${esc(n.title)}</b><small>${esc(n.body)}</small></span><span class="wd-act-side"><em>${esc(ago(n.created_at))}</em>${n.read?"":"<i></i>"}</span></button>`}
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
  $("ndIcon").textContent=topicIcon(n.topic);$("ndTopic").textContent=topicTitle(n.topic);$("ndTitle").textContent=n.title;$("ndBody").textContent=n.body;$("ndTime").textContent=when(n.created_at);
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
let txRows=[],txAll=[],openTx=null;
function txView(t){
  const n=Number(t.amount),u=t.usd_value==null?null:Number(t.usd_value);
  if(t.kind==="send")return{icon:"↗",title:"Sent "+t.symbol,sub:t.to_address?"To "+short(t.to_address):"Withdrawal",amt:"-"+trimNum(n)+" "+t.symbol,sub2:u!=null?"≈ "+usd(u):"",dir:"out",type:"Send"};
  if(t.kind==="convert_out")return{icon:"⇄",title:"Converted "+t.symbol,sub:"To dollar wallet",amt:"-"+trimNum(n)+" "+t.symbol,sub2:u!=null?"≈ "+usd(u):"",dir:"out",type:"Conversion"};
  return{icon:"$",title:"Converted from "+t.symbol,sub:"From crypto wallet",amt:"+"+usd(n),sub2:"",dir:"in",type:"Conversion"};
}
const short=a=>a.length>22?a.slice(0,10)+"…"+a.slice(-8):a;
function txRowHTML(t,i,src){const v=txView(t);
  return `<button type="button" class="wd-row wd-tx-row" data-tx="${src}:${i}"><div class="wd-coin wd-tx-ic ${v.dir}">${v.icon}</div><div class="wd-coin-info"><b>${esc(v.title)}${t.test?' <span class="wd-tx-test">Test</span>':""}</b><small>${esc(v.sub)} · ${esc(ago(t.created_at))}</small></div><div class="wd-coin-value wd-tx-amt ${v.dir}">${esc(v.amt)}${v.sub2?`<small>${esc(v.sub2)}</small>`:""}</div></button>`}
function paintMode(){
  const m=mode(),t=$("txTitle");if(!t)return;
  t.textContent=m==="usd"?"Dollar history":"Crypto history";
  const f=$("txHistoryTitle");if(f)f.textContent=m==="usd"?"Dollar history":"Crypto history";
  refreshTx();
}
async function refreshTx(){
  if(!$("txList"))return;
  if(!signedIn()){$("txList").innerHTML="";$("txViewAll").hidden=true;return}
  const m=mode();
  try{txRows=await db().tx.list(m,5)}catch(e){console.error("History could not be loaded",e);txRows=[]}
  if(m!==mode())return;
  $("txList").innerHTML=txRows.length?txRows.map((t,i)=>txRowHTML(t,i,"d")).join(""):`<div class="wd-empty"><strong>No transactions yet</strong><p>${m==="usd"?"Conversions into your dollar wallet will show up here.":"Sends and conversions from your crypto wallet will show up here."}</p></div>`;
  $("txViewAll").hidden=txRows.length<5;
}
function openDetail(t){
  openTx=t;const v=txView(t);
  $("tdIcon").textContent=v.icon;$("tdIcon").className="wd-act-ic big "+v.dir;$("tdAmount").textContent=v.amt;$("tdSub").textContent=v.title;
  const rows=[["Type",v.type],["Status",(t.status||"completed").replace(/^./,c=>c.toUpperCase())],["Date",when(t.created_at)]];
  if(t.kind==="send"){rows.push(["Amount",trimNum(t.amount)+" "+t.symbol]);if(t.usd_value!=null)rows.push(["Value",usd(t.usd_value)]);if(t.to_address)rows.push(["To",t.to_address,"copy"]);if(t.network)rows.push(["Network",t.network])}
  else if(t.kind==="convert_out"){rows.push(["Converted",trimNum(t.amount)+" "+t.symbol]);if(t.usd_value!=null)rows.push(["Credited",usd(t.usd_value)]);rows.push(["To","Dollar wallet"])}
  else{rows.push(["Credited",usd(t.amount)]);rows.push(["Converted from",t.symbol]);rows.push(["From","Crypto wallet"])}
  if(t.reference)rows.push(["Reference",t.reference,"copy"]);
  if(t.test)rows.push(["Note","Test transaction (demo balance)"]);
  $("tdRows").innerHTML=rows.map(r=>`<div class="wd-td-row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b>${r[2]?`<button type="button" class="wd-td-copy" data-copy-val="${esc(r[1])}" aria-label="Copy ${esc(r[0])}">Copy</button>`:""}</div>`).join("");
  openFeature("txDetailPage");
}
async function openAll(){
  $("txHistoryTitle").textContent=mode()==="usd"?"Dollar history":"Crypto history";
  $("txAllList").innerHTML='<div class="wd-act-note">Loading…</div>';openFeature("txHistoryPage");
  try{txAll=await db().tx.list(mode(),500)}catch{txAll=[];$("txAllList").innerHTML='<div class="wd-act-note">Couldn\'t load your history. Make sure schema_phase6_notifications_history.sql has been run.</div>';return}
  if(!txAll.length){$("txAllList").innerHTML='<div class="wd-act-note">No transactions yet.</div>';return}
  let html="",last=null;txAll.forEach((t,i)=>{const k=dayKey(t.created_at);if(k!==last){html+=`<div class="wd-act-day">${esc(dayLabel(k))}</div>`;last=k}html+=txRowHTML(t,i,"a")});
  $("txAllList").innerHTML=html;
}
document.addEventListener("click",e=>{
  const r=e.target.closest("[data-tx]");if(r){const [src,i]=r.dataset.tx.split(":");const t=(src==="a"?txAll:txRows)[+i];if(t)openDetail(t);return}
  if(e.target.closest("#txViewAll")){openAll();return}
  if(e.target.closest("#txHistoryBack")){closeFeature("txHistoryPage");return}
  if(e.target.closest("#txDetailBack")){closeFeature("txDetailPage",true);return}
  const c=e.target.closest("[data-copy-val]");if(c){const v=c.dataset.copyVal;(navigator.clipboard?navigator.clipboard.writeText(v):Promise.reject()).then(()=>toast("Copied")).catch(()=>toast("Copy not supported"))}
});
/* Called by the Send / Convert flows for demo ("test balance") money, which never reaches the server wallet */
async function logTest(row){if(!signedIn())return;try{await db().tx.logTest(row)}catch(e){console.error("History not saved",e)}refreshTx()}

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

window.veltrixActivity={push,refreshTx,paintMode,logTest,syncFav:coin=>paintFav(!!(coin&&wl.has(String(coin.symbol).toUpperCase()))),reload:loadNotifs};
window.veltrixWatch={sync:coin=>paintFav(!!(coin&&wl.has(String(coin.symbol).toUpperCase()))),toggle:toggleWatch};
})();
