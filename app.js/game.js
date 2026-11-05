/* Veltrix games: head-to-head "Race the clock" bets. Loaded by index.html (users) and admin.html (admin).
   All money logic lives on the server (supabase/schema_phase23_games.sql); this file is only the screens.
   Chat code calls  window.vxGame.onChat({contactId, persona, support, accountId?, admin?})  when a chat opens, and  onChat(null)  when it closes. */
(function(){
"use strict";
const COINS=[["BTC","Bitcoin"],["ETH","Ethereum"],["USDT","Tether"],["USDC","USDC"],["BNB","BNB"],["SOL","Solana"],["XRP","XRP"],["TRX","TRON"],["AVAX","Avalanche"],["SHIB","Shiba Inu"],["LINK","Chainlink"],["LTC","Litecoin"]];
const TAPS=40,ADMIN_PAGE=!!document.getElementById("adminApp");
const $=(s,r)=>(r||document).querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sb=()=>window.veltrixDB&&veltrixDB.client;
const wallet=()=>{try{window.veltrixDB&&veltrixDB.refreshWallet&&veltrixDB.refreshWallet()}catch(e){}};
const fmtMs=ms=>(ms/1000).toFixed(2)+" s";
const fmtAmt=n=>String(+Number(n).toFixed(8));
function findCoin(t){t=String(t||"").trim().toLowerCase();if(!t)return null;return COINS.find(c=>c[0].toLowerCase()===t||c[1].toLowerCase()===t)||(t.length>=3?COINS.find(c=>c[1].toLowerCase().startsWith(t)):null)||null}
function logo(sym,big){const l=(window.VX_LOCAL_LOGOS||{})[sym]||"https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/"+sym.toLowerCase()+".svg";
 return `<span class="vxg-coin${big?" big":""}"><img src="${esc(l)}" alt="${esc(sym)}" onerror="this.remove()"><b>${esc(sym[0])}</b></span>`}
const WALL="data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 110"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#27304a"/><stop offset="1" stop-color="#9fb0c4"/></linearGradient></defs><rect width="160" height="110" fill="url(#s)"/><g fill="#2e3b55"><rect x="6" y="30" width="16" height="30"/><rect x="24" y="22" width="14" height="38"/><rect x="104" y="26" width="18" height="34"/><rect x="124" y="34" width="14" height="26"/></g><path d="M0 60h160v50H0z" fill="#46623a"/><path d="M62 60h36l46 50H16z" fill="#4a4d52"/><path d="M62 60 16 110h10l40-50zM98 60l46 50h-10L94 60z" fill="#d8332f"/><path d="M80 62v48" stroke="#ddd" stroke-width="1.6" stroke-dasharray="6 5"/><g transform="translate(52 78)"><ellipse cx="28" cy="29" rx="30" ry="4" fill="rgba(0,0,0,.35)"/><rect x="2" y="16" width="52" height="12" rx="4" fill="#15171c"/><path d="M8 17l6-10h28l6 10z" fill="#1d2027"/><path d="M15 15l4-7h18l4 7z" fill="#56657a"/><rect x="18" y="16" width="3" height="5" fill="#f5a31a"/><rect x="24" y="16" width="3" height="5" fill="#f5a31a"/><rect x="30" y="16" width="3" height="5" fill="#f5a31a"/><rect x="36" y="16" width="3" height="5" fill="#f5a31a"/><rect x="5" y="21" width="9" height="3" fill="#ff3b3b"/><rect x="42" y="21" width="9" height="3" fill="#ff3b3b"/><rect x="22" y="23" width="12" height="4" fill="#eee"/></g></svg>');
const CAR='<svg viewBox="0 0 64 30" width="46" height="22"><path d="M2 20l6-10 14-4h20l12 8 8 2v4z" fill="#ff3b3b"/><circle cx="16" cy="22" r="6" fill="#111"/><circle cx="48" cy="22" r="6" fill="#111"/></svg>';

let uid=null,chan=null,peer=null,cur=null,game=null,pollT=null,queue=[],shownIn=null,seen={};
const toast=m=>{const t=document.getElementById("vmToast");if(!t)return alert(m);t.textContent=m;t.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove("show"),3200)};
const ERR={insufficient:"Not enough balance for this bet.",invalid_amount:"Enter a valid amount.",unsupported_coin:"That coin isn't supported for bets.",already_open:"There is already an open bet between you two.",not_allowed:"Bets aren't available in this chat.",no_opponent:"No opponent is available right now.",gone:"This bet is no longer available.",wait:"Wait for the other player to finish first.",bad_car:"Pick one of the five cars."};
const rpc=async(fn,a)=>{const {data,error}=await sb().rpc(fn,a||{});if(error){console.error(fn,error);return{ok:false,reason:"error"}}return data||{ok:false}};

/* ---------- dialog (reuses the chat's dialog look) ---------- */
const dlg=document.createElement("div");dlg.className="vm-dialog-backdrop vxg-dlg";dlg.hidden=true;dlg.innerHTML='<section class="vm-dialog" role="dialog" aria-modal="true"></section>';
document.body.appendChild(dlg);const box=$(".vm-dialog",dlg);
const openDlg=h=>{box.innerHTML=h;dlg.hidden=false};const closeDlg=()=>{dlg.hidden=true;box.innerHTML=""};

/* ---------- pull-out handle + game card inside the chat room ----------
   A small round arrow button sits half-hidden in the right edge. Pull it out (drag left): the card grows with a glow while you pull,
   and when you let go past the threshold the game wallpaper is shown. Tap the wallpaper to set up the bet; tap anywhere else to put it away. */
function mountTab(){
 const chat=document.getElementById("vmChat");if(!chat||$(".vxg-pull",chat))return;
 chat.insertAdjacentHTML("beforeend",'<div class="vxg-pull" hidden><span class="vxg-band"></span><button type="button" class="vxg-knob" aria-label="Pull out to open games"><svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/></svg></button></div><div class="vxg-card" aria-hidden="true"><span class="vxg-ring"></span><button type="button" class="vxg-game" tabindex="-1" aria-label="Race the clock"><img src="'+WALL+'" alt=""><span>Race the clock</span></button></div>');
 const pull=$(".vxg-pull",chat),knob=$(".vxg-knob",pull),card=$(".vxg-card",chat),MAXD=96,GO=.72;
 let drag=null,isOpen=false;
 const setP=p=>{chat.style.setProperty("--vxp",p.toFixed(3))};
 const open=()=>{isOpen=true;card.classList.remove("drag");card.classList.add("open","pop");card.setAttribute("aria-hidden","false");$(".vxg-game",card).tabIndex=0;pull.classList.remove("pulling","ready");setP(0);setTimeout(()=>card.classList.remove("pop"),520);
  setTimeout(()=>document.addEventListener("pointerdown",away,true),0)};
 const close=()=>{isOpen=false;card.classList.remove("open","pop","drag");card.setAttribute("aria-hidden","true");$(".vxg-game",card).tabIndex=-1;document.removeEventListener("pointerdown",away,true);setP(0)};
 const away=e=>{if(!card.contains(e.target)&&!pull.contains(e.target))close()};
 chat.__vxgClose=close;
 knob.addEventListener("pointerdown",e=>{if(isOpen)return;e.preventDefault();e.stopPropagation();drag={x:e.clientX,id:e.pointerId,p:0,moved:false};try{knob.setPointerCapture(e.pointerId)}catch(_){}
  pull.classList.add("pulling");card.classList.add("drag")});
 knob.addEventListener("pointermove",e=>{if(!drag||e.pointerId!==drag.id)return;const d=clamp(drag.x-e.clientX,0,MAXD*1.25),p=d/MAXD;if(d>4)drag.moved=true;drag.p=p;setP(p);
  const rdy=p>=GO;if(rdy!==pull.classList.contains("ready")){pull.classList.toggle("ready",rdy);try{navigator.vibrate&&navigator.vibrate(rdy?12:0)}catch(_){}}});
 const end=e=>{if(!drag||(e&&e.pointerId!==drag.id))return;const d=drag;drag=null;try{knob.releasePointerCapture(d.id)}catch(_){}
  pull.classList.remove("pulling");knob.classList.add("spring");setTimeout(()=>knob.classList.remove("spring"),420);
  if(d.p>=GO)open();else{card.classList.remove("drag");setP(0);pull.classList.remove("ready");if(!d.moved){knob.classList.add("nudge");setTimeout(()=>knob.classList.remove("nudge"),700)}}};
 knob.addEventListener("pointerup",end);knob.addEventListener("pointercancel",end);
 knob.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "||e.key==="ArrowLeft"){e.preventDefault();open()}});
 $(".vxg-game",card).addEventListener("click",()=>{close();openSetup()});
}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function onChat(p){mountTab();peer=p&&!p.support?p:null;const chat=document.getElementById("vmChat"),pull=chat&&$(".vxg-pull",chat);if(!pull)return;
 pull.hidden=!peer;if(!peer&&chat.__vxgClose)chat.__vxgClose()}

/* ---------- bet setup ---------- */
function openSetup(){
 if(!peer||!uid)return toast("Sign in to start a bet.");
 let mode="escrow";
 openDlg('<h2>Race the clock</h2><p>Challenge '+esc(peer.persona||"this user")+' to a timed race. Fastest time wins.</p>'
 +'<div class="vxg-coinrow"><span id="vxgLogo"></span><input id="vxgCoin" type="text" value="Bitcoin" autocomplete="off" spellcheck="false" aria-label="Cryptocurrency"></div><small id="vxgHint" class="vxg-hint"></small>'
 +'<input id="vxgAmt" class="vxg-in" type="text" inputmode="decimal" placeholder="Amount" autocomplete="off" aria-label="Amount">'
 +'<div class="vxg-seg"><button type="button" data-m="escrow" class="on">Escrow bet</button><button type="button" data-m="free">Play for fun</button></div>'
 +'<small class="vxg-hint" id="vxgNote"></small><div class="vm-dialog-actions"><button type="button" id="vxgGo">Proceed</button></div><button type="button" class="vm-dialog-cancel" id="vxgNo">Cancel</button>');
 const coin=$("#vxgCoin",box),hint=$("#vxgHint",box),logoEl=$("#vxgLogo",box),amt=$("#vxgAmt",box),note=$("#vxgNote",box);
 const paint=()=>{const c=findCoin(coin.value);logoEl.innerHTML=logo(c?c[0]:"BTC",true);hint.textContent=mode==="free"?"":c?c[0]+" will be used for this bet":"Coin not supported by the wallet";hint.classList.toggle("bad",!c&&mode!=="free")};
 const setMode=m=>{mode=m;box.querySelectorAll(".vxg-seg button").forEach(b=>b.classList.toggle("on",b.dataset.m===m));box.classList.toggle("vxg-free",m==="free");note.textContent=m==="escrow"?"Stakes are held in escrow. The winner is paid straight to their wallet.":"No crypto is locked. The winner gets nothing.";paint()};
 coin.addEventListener("input",paint);box.querySelectorAll(".vxg-seg button").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.m)));setMode("escrow");
 $("#vxgNo",box).addEventListener("click",closeDlg);
 $("#vxgGo",box).addEventListener("click",async()=>{
  const c=findCoin(coin.value),a=amt.value.trim().replace(",",".");
  if(mode==="escrow"){if(!c)return toast("Enter a supported coin.");if(!/^\d*\.?\d{1,8}$|^\d+$/.test(a)||!(+a>0))return toast("Enter a valid amount.")}
  const go=$("#vxgGo",box);go.disabled=true;
  const r=await rpc("game_bet_create",{p_contact:peer.contactId,p_persona:peer.persona||"",p_mode:mode,p_symbol:mode==="escrow"?c[0]:null,p_amount:mode==="escrow"?+a:0,p_request:crypto.randomUUID(),p_peer:peer.admin?peer.accountId:(peer.real?peer.peerId:null)});
  if(!r.ok){go.disabled=false;return toast(ERR[r.reason]||"Couldn't start the bet. Try again.")}
  cur={id:r.id,persona:peer.persona||"The other player",mode,sym:c&&c[0],amt:a};wallet();showWaiting();startPoll();
 });
}
function showWaiting(){
 openDlg('<div class="vxg-wait"><span class="vxg-spin"></span><h2>Waiting for '+esc(cur.persona)+'…</h2><p>'+(cur.mode==="escrow"?esc(fmtAmt(cur.amt)+" "+cur.sym)+" is held in escrow until they respond.":"Playing for fun, nothing is locked.")+'</p></div><button type="button" class="vm-dialog-cancel" id="vxgWd">Cancel bet</button>');
 $("#vxgWd",box).addEventListener("click",async()=>{if(!cur)return;const r=await rpc("game_bet_withdraw",{p_id:cur.id});if(r.ok){toast("Bet cancelled"+(cur.mode==="escrow"?" and refunded":""));cur=null;closeDlg();wallet()}else toast(ERR[r.reason]||"Couldn't cancel.")});
}

/* ---------- incoming bet popup (works on any screen) ---------- */
async function nameOf(id,fallback){if(!ADMIN_PAGE)return fallback;try{const {data}=await sb().from("profiles").select("full_name").eq("id",id).maybeSingle();return data&&data.full_name||fallback}catch(e){return fallback}}
async function showIncoming(r,fromQueue){
 if(!fromQueue){if(seen[r.id])return;seen[r.id]=1;if(shownIn){queue.push(r);return}}shownIn=r;
 const who=ADMIN_PAGE?(await nameOf(r.challenger_id,"A user"))+" (to "+(r.persona_name||"your contact")+")":(r.challenger_name||r.persona_name||"Someone");
 const stake=r.mode==="escrow"?"for "+esc(fmtAmt(r.amount))+" "+esc(r.symbol)+" each, held in escrow":"for fun, no crypto locked";
 const w=document.createElement("div");w.className="vm-dialog-backdrop vxg-in-pop";w.innerHTML='<section class="vm-dialog" role="alertdialog" aria-modal="true"><h2>Race challenge</h2><p><b>'+esc(who)+'</b> challenged you to a timed race '+stake+'.</p><div class="vm-dialog-actions"><button type="button" data-a="1">Accept</button><button type="button" data-a="0" class="danger">Cancel</button></div></section>';
 w.style.zIndex=14500;document.body.appendChild(w);r.__w=w;
 w.addEventListener("click",async e=>{const b=e.target.closest("button[data-a]");if(!b)return;b.disabled=true;
  const ok=b.dataset.a==="1",res=await rpc("game_bet_respond",{p_id:r.id,p_accept:ok});
  if(!res.ok){b.disabled=false;toast(ERR[res.reason]||"Couldn't answer this bet.");if(res.reason!=="insufficient")dropIncoming(r);return}
  dropIncoming(r);wallet();if(ok){const {data}=await sb().from("game_bets").select("*").eq("id",r.id).single();if(data)openGame(data)}else toast("Bet cancelled")});
}
function dropIncoming(r){if(r.__w){r.__w.remove();r.__w=null}if(shownIn&&shownIn.id===r.id)shownIn=null;const n=queue.shift();if(n)showIncoming(n,true)}

/* ---------- the race screen (slides over the page) ----------
   Flow: car select (5 cars) -> "ready" -> server sets a shared GO time -> countdown -> BOTH cars race at once in the same 3D scene.
   Your phone drives your car and streams its position to the other player (Supabase broadcast); the other car is drawn from that stream.
   The server still decides the result: each finish is timed from the shared GO time (game_bet_ready / game_bet_sync / game_bet_finish). */
const CARS=[["Apex GT","A",4],["Nova S","S",5],["Blaze D","D",2],["Phantom S","S",5],["Frost B","B",3]];
const BADGE={A:"#f5a31a",S:"#8b3dff",B:"#2f6bff",C:"#2f9e44",D:"#6b6f76"};
const fmtHud=ms=>{ms=Math.max(0,ms);const m=Math.floor(ms/60000),s=(ms%60000)/1000;return m+":"+(s<10?"0":"")+s.toFixed(1)};
const IC_GAS='<svg viewBox="0 0 24 24"><path d="M12 4v13M6 11l6-7 6 7"/></svg>',IC_BRK='<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>';
function openGame(r){
 if(game&&game.id===r.id)return game.update(r);if(game)return;
 const el=document.createElement("section");el.className="vm-page vm-over vxg-screen";el.setAttribute("aria-label","Race the clock");
 el.innerHTML='<canvas class="vxg-cv"></canvas><div class="vxg-vig"></div>'
  +'<header class="vm-top vxg-top"><button type="button" class="vm-ic" id="vxgX" aria-label="Close" hidden><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button><h1>Race the clock</h1></header>'
  +'<div class="vxg-hd2" hidden><i></i><small>RACE THE CLOCK</small><b id="vxgClock">0:00.0</b><em id="vxgBet"></em></div>'
  +'<div class="vxg-mm" hidden><canvas width="260" height="170"></canvas><div class="vxg-pos"><small>POS</small><b id="vxgPos">1</b><span>/2</span></div></div>'
  +'<div class="vxg-dial" hidden><svg viewBox="0 0 120 120"><circle class="d-bg" cx="60" cy="60" r="50"/><circle class="d-tr" cx="60" cy="60" r="54" pathLength="100"/><circle class="d-ar" id="vxgArc" cx="60" cy="60" r="54" pathLength="100"/></svg><b id="vxgGear">1</b><strong id="vxgSpd">0</strong><small>KM</small></div>'
  +'<div class="vxg-tilt" hidden><i></i></div><div class="vxg-count" id="vxgCnt"></div>'
  +'<button type="button" class="vxg-pad gas" hidden aria-label="Gas"><span class="vxg-padi">'+IC_GAS+'</span><small>Hold to go</small></button>'
  +'<button type="button" class="vxg-pad brk" hidden aria-label="Brake"><span class="vxg-padi">'+IC_BRK+'</span><small>Hold to brake</small></button>'
  +'<div class="vxg-panel"><div class="vxg-msg" id="vxgMsg"></div><button type="button" class="vxg-act" id="vxgAct" hidden></button></div><div class="vxg-sel" hidden></div>';
 document.body.appendChild(el);
 const g=game={id:r.id,row:r,el,running:false,starting:false,started:false,t0:0,raf:0,selRaf:0,finishing:false,rx:null,rxT:0,perm:null,startP:null};
 const mine=()=>g.row.challenger_id===uid,msg=$("#vxgMsg",el),act=$("#vxgAct",el),clock=$("#vxgClock",el),x=$("#vxgX",el),cnt=$("#vxgCnt",el),sel=$(".vxg-sel",el);let cv=$(".vxg-cv",el);
 const hud=$(".vxg-hd2",el),mm=$(".vxg-mm",el),mmc=$("canvas",mm).getContext("2d"),posB=$("#vxgPos",el),dial=$(".vxg-dial",el),arc=$("#vxgArc",el),gearB=$("#vxgGear",el),spdB=$("#vxgSpd",el),tiltEl=$(".vxg-tilt",el),tiltI=$("i",tiltEl),padG=$(".vxg-pad.gas",el),padB=$(".vxg-pad.brk",el);
 let R=null;                                                       /* real 3D scene (WebGL); if the phone can't do it, fall back to the flat road */
 try{if(window.vxRacer3D)R=window.vxRacer3D.create(cv)}catch(err){console.warn("3D racer unavailable, using flat road",err);R=null;const nc=document.createElement("canvas");nc.className="vxg-cv";cv.replaceWith(nc);cv=nc}
 if(!R)R=window.vxRacer.create(cv);
 const hasShow=!!R.showroom,input={gas:false,brake:false,steer:0},opp={car:0,pos:0,x:0,speed:0,steer:0,brake:false};let pick=0;
 const them=()=>ADMIN_PAGE?"the user":((mine()?g.row.persona_name:(g.row.challenger_name||g.row.persona_name))||"your opponent");
 const mineMs=()=>mine()?g.row.c_ms:g.row.o_ms,theirMs=()=>mine()?g.row.o_ms:g.row.c_ms;
 const showAct=(t,fn)=>{act.hidden=!t;act.textContent=t||"";act.onclick=fn||null};
 const hudOn=on=>{[hud,mm,dial,tiltEl,padG,padB].forEach(n=>n.hidden=!on);el.classList.toggle("vxg-racing",on)};
 const paint=()=>{R.size();R.render()};
 requestAnimationFrame(paint);const onRs=()=>paint();window.addEventListener("resize",onRs);
 /* live link to the other player's phone */
 g.ch=sb().channel("race-"+r.id,{config:{broadcast:{self:false}}});
 g.ch.on("broadcast",{event:"s"},m=>{g.rx=m.payload;g.rxT=performance.now()}).subscribe();
 const send=p=>{try{g.ch.send({type:"broadcast",event:"s",payload:p})}catch(_){}};

 /* --- controls: tilt, pedals, keyboard --- */
 const T={base:null,raw:0,f:0,got:false,on:false};
 const readAng=e=>{const o=(screen.orientation&&screen.orientation.angle)||window.orientation||0,a=((o%360)+360)%360;
  return (a===90?-e.beta:a===270?e.beta:a===180?-e.gamma:e.gamma)||0};
 const onOri=e=>{if(e.gamma==null&&e.beta==null)return;T.raw=readAng(e);T.got=true};
 async function askMotion(){
  try{if(typeof DeviceOrientationEvent!=="undefined"&&typeof DeviceOrientationEvent.requestPermission==="function"){const p=await DeviceOrientationEvent.requestPermission();if(p!=="granted")return false}}catch(e){return false}
  if(!T.on){window.addEventListener("deviceorientation",onOri);T.on=true}return true}
 const keys={};
 const onKey=(e,d)=>{const k=e.key;if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(k)){keys[k]=d;e.preventDefault()}};
 const kd=e=>onKey(e,true),ku=e=>onKey(e,false);window.addEventListener("keydown",kd);window.addEventListener("keyup",ku);
 const pedals={gas:false,brake:false};
 const bindPad=(b,k)=>{const on=e=>{e.preventDefault();pedals[k]=true;b.classList.add("on");try{b.setPointerCapture(e.pointerId)}catch(_){}},off=()=>{pedals[k]=false;b.classList.remove("on")};
  b.addEventListener("pointerdown",on);b.addEventListener("pointerup",off);b.addEventListener("pointercancel",off);b.addEventListener("lostpointercapture",off);b.addEventListener("contextmenu",e=>e.preventDefault())};
 bindPad(padG,"gas");bindPad(padB,"brake");
 const steerNow=dt=>{let v=0;
  if(T.got&&T.base!=null){T.f+=(T.raw-T.f)*(1-Math.exp(-dt/0.09));
   const d=T.f-T.base,dz=1.8,rg=19,u=clamp((Math.abs(d)-dz)/(rg-dz),0,1);v=Math.sign(d)*(u*u*(3-2*u)*.55+u*.45)}
  if(keys.ArrowLeft)v=-1;if(keys.ArrowRight)v=1;return clamp(v,-1,1)};

 /* --- garage / car select --- */
 let ang=.7;
 const stopSel=()=>{cancelAnimationFrame(g.selRaf);g.selRaf=0};
 const startSel=()=>{if(!hasShow||g.selRaf)return;const f=()=>{ang+=.011;R.showroom(pick,ang,7.6);R.render();g.selRaf=requestAnimationFrame(f)};g.selRaf=requestAnimationFrame(f)};
 function showSelect(){
  hudOn(false);showAct(null);msg.innerHTML="";el.classList.add("vxg-pick");
  const th=CARS.map((c,i)=>{if(!hasShow)return"";R.size();R.showroom(i,.7,8.6);R.render();try{return cv.toDataURL("image/jpeg",.72)}catch(_){return""}});
  sel.innerHTML='<div class="vxg-sh"><b>SELECT YOUR CAR</b><small>Every car drives the same, so the bet stays fair</small></div>'
   +'<div class="vxg-info"><b id="vxgCn"></b><em id="vxgCs"></em></div>'
   +'<button type="button" class="vxg-go" id="vxgCont">Continue</button>'
   +'<div class="vxg-cards">'+CARS.map((c,i)=>'<button type="button" class="vxg-cc'+(i===pick?" on":"")+'" data-i="'+i+'" aria-label="'+esc(c[0])+'"><span class="vxg-bd" style="background:'+BADGE[c[1]]+'">'+c[1]+'</span>'+(th[i]?'<img src="'+th[i]+'" alt="">':'')+'<i>'+"★".repeat(c[2])+'</i><u>SELECTED</u></button>').join("")+'</div>';
  sel.hidden=false;
  const info=()=>{$("#vxgCn",sel).textContent=CARS[pick][0];$("#vxgCs",sel).textContent="★".repeat(CARS[pick][2])};info();
  sel.querySelectorAll(".vxg-cc").forEach(b=>b.addEventListener("click",()=>{pick=+b.dataset.i;sel.querySelectorAll(".vxg-cc").forEach(n=>n.classList.toggle("on",n===b));info()}));
  $("#vxgCont",sel).addEventListener("click",async e=>{const b=e.currentTarget;b.disabled=true;g.perm=askMotion();      /* must start inside this tap (iOS asks for motion access here) */
   const res=await rpc("game_bet_ready",{p_id:g.id,p_car:pick});if(!res.ok){b.disabled=false;return toast(ERR[res.reason]||"Couldn't lock your car. Try again.")}
   const {data}=await sb().from("game_bets").select("*").eq("id",g.id).single();if(data)g.update(data)});
  startSel();
 }
 function close(){cancelAnimationFrame(g.raf);stopSel();window.removeEventListener("resize",onRs);window.removeEventListener("keydown",kd);window.removeEventListener("keyup",ku);if(T.on)window.removeEventListener("deviceorientation",onOri);try{sb().removeChannel(g.ch)}catch(_){}if(R.dispose)R.dispose();el.remove();game=null;wallet();stopPollIfIdle()}
 x.addEventListener("click",close);

 async function run(){
  if(g.started)return;g.started=true;g.starting=true;showAct(null);stopSel();sel.hidden=true;el.classList.remove("vxg-pick");msg.innerHTML="";
  const m=mine(),myCar=(m?g.row.c_car:g.row.o_car)|0,lane=m?-.42:.42;
  if(hasShow){R.showroom(null);R.setMe(myCar);opp.car=(m?g.row.o_car:g.row.c_car)|0;opp.pos=0;opp.x=-lane;opp.speed=0;opp.steer=0;opp.brake=false;R.setOpp(opp)}
  R.reset(lane);R.size();R.render();hudOn(true);$("#vxgBet",el).textContent=g.row.mode==="escrow"?fmtAmt(g.row.amount)+" "+g.row.symbol+" each":"For fun";
  clock.textContent="0:00.0";spdB.textContent="0";el.classList.add("vxg-cd");
  const okMotion=await(g.perm||Promise.resolve(true));if(!okMotion)toast("Motion access denied: tilt steering is off. Use arrow keys.");
  const t1=Date.now(),s=await rpc("game_bet_sync",{p_id:g.id}),t2=Date.now();
  if(!s.ok||!s.go_at){g.starting=false;g.started=false;hudOn(false);el.classList.remove("vxg-cd");msg.textContent=ERR[s.reason]||"Couldn't sync the start.";showAct("Back",()=>g.update(g.row));return}
  const goLocal=Date.parse(s.go_at)-(Date.parse(s.now)-(t1+t2)/2);      /* the shared GO moment, on this phone's clock */
  let last=-1;
  for(;;){const rem=goLocal-Date.now();if(rem<=0)break;const n=Math.ceil(rem/1000);if(n<=3&&n!==last){last=n;cnt.className="vxg-count";void cnt.offsetWidth;cnt.textContent=n;cnt.classList.add("pop")}R.render();await new Promise(r=>requestAnimationFrame(r))}
  g.starting=false;g.startP=rpc("game_bet_start",{p_id:g.id});
  T.base=T.got?T.raw:null;T.f=T.raw;
  cnt.className="vxg-count go";cnt.textContent="GO!";setTimeout(()=>{if(cnt.textContent==="GO!"){cnt.textContent="";cnt.className="vxg-count"}},650);
  el.classList.remove("vxg-cd");g.running=true;g.t0=performance.now()-(Date.now()-goLocal);let last2=performance.now(),fin=false,lastSend=0,fr=0;const st=R.st;
  const loop=ts=>{if(!g.running)return;const dt=Math.min(.05,Math.max(.001,(ts-last2)/1000));last2=ts;fr++;
   input.gas=pedals.gas||!!keys.ArrowUp||!!keys[" "];input.brake=pedals.brake||!!keys.ArrowDown;input.steer=steerNow(dt);
   fin=R.step(dt,input);
   if(hasShow){                                                   /* the other player's car: dead-reckoned from their last packet, then smoothed */
    const q=g.rx;if(q){const age=Math.min(.6,(ts-g.rxT)/1000),k=1-Math.exp(-dt*10);opp.pos+=(q.p+q.s*age-opp.pos)*k;opp.x+=(q.x-opp.x)*k;opp.speed+=(q.s-opp.speed)*k;opp.steer=q.h;opp.brake=!!q.b}
    const dp=(opp.pos-st.pos)/200,dx=(opp.x-st.x)*6;               /* cars bump instead of ghosting through each other */
    if(Math.abs(dp)<4.4&&Math.abs(dx)<2.1){st.x+=(dx>=0?-1:1)*dt*1.3;st.speed*=1-dt*.7}
    if(ts-lastSend>70){lastSend=ts;send({p:Math.round(st.pos),x:+st.x.toFixed(3),s:Math.round(st.speed),h:+st.steer.toFixed(2),b:st.brake?1:0})}
    posB.textContent=opp.pos>st.pos?2:1}
   R.render();
   const kmh=R.kmh();clock.textContent=fmtHud(ts-g.t0);spdB.textContent=kmh;gearB.textContent=clamp(1+Math.floor(kmh/36),1,6);arc.style.strokeDasharray=(clamp(kmh/220,0,1)*75).toFixed(1)+" 100";
   tiltI.style.transform="translateX("+(input.steer*26).toFixed(1)+"px)";if(R.map&&fr%3===0)R.map(mmc,260,170,st.pos,hasShow?opp.pos:null);
   if(fin){finish();return}g.raf=requestAnimationFrame(loop)};
  g.raf=requestAnimationFrame(loop);
 }
 async function finish(){
  g.finishing=true;g.running=false;cancelAnimationFrame(g.raf);hudOn(false);cnt.textContent="";R.st.speed=0;R.render();showAct(null);msg.textContent="Checking your time…";
  send({p:Math.round(R.st.pos),x:R.st.x,s:0,h:0,b:1});
  try{await g.startP}catch(_){}
  const f=await rpc("game_bet_finish",{p_id:g.id});g.finishing=false;
  if(f.ok){const {data}=await sb().from("game_bets").select("*").eq("id",g.id).single();if(data)g.update(data)}else msg.textContent=ERR[f.reason]||"Couldn't save your time."}
 g.update=function(row){
  g.row=row;x.hidden=true;const st=row.status,m=mine(),stake=row.mode==="escrow"?fmtAmt(row.amount)+" "+row.symbol:null;
  if(g.running||g.finishing||g.starting)return;
  if(st==="finished"||st==="void"||st==="cancelled"||st==="expired"){
   x.hidden=false;showAct(null);stopSel();sel.hidden=true;hudOn(false);el.classList.remove("vxg-pick");if(hasShow)R.showroom(null);
   const a=mineMs(),b=theirMs();
   if(st==="void"){msg.innerHTML=(a&&b?"<b>It's a tie</b><small>You: "+fmtMs(a)+" · "+esc(them())+": "+fmtMs(b)+"</small>":"<b>Bet cancelled</b>")+"<small>"+(stake?"Stakes were refunded.":"")+"</small>";return}
   if(st!=="finished"){msg.innerHTML="<b>Bet cancelled</b>";return}
   const won=row.winner_id===uid;
   msg.innerHTML='<span class="vxg-res '+(won?"win":"lose")+'">'+(won?"You won!":"You lost")+"</span><small>You: "+(a?fmtMs(a):"–")+" · "+esc(them())+": "+(b?fmtMs(b):"no run")+"</small><small>"+(stake?(won?"+"+esc(fmtAmt(row.amount*2)+" "+row.symbol)+" was sent to your wallet.":"You lost "+esc(stake)+"."):"Played for fun, nothing was locked.")+"</small>";
   wallet();return}
  const myFin=m?row.c_finish:row.o_finish,myStart=m?row.c_start:row.o_start,myCar=m?row.c_car:row.o_car;
  if(myFin){msg.innerHTML="<b>Your time: "+fmtMs(mineMs())+"</b><small>Waiting for "+esc(them())+" to finish…</small>";showAct(null);return}
  if(myStart&&!g.started){finish();return}                         /* run was interrupted: close it out with the time that passed */
  if(row.go_at&&myCar!=null){run();return}
  if(myCar!=null){pick=myCar|0;sel.hidden=true;el.classList.remove("vxg-pick");msg.innerHTML="<b>Car locked in</b><small>Waiting for "+esc(them())+" to pick a car…</small><small class=\"vxg-how\">Tilt your phone to steer · hold bottom-left to go · hold bottom-right to brake</small>";showAct(null);startSel();return}
  if(!g.selShown){g.selShown=true;showSelect()}
 };
 g.update(r);startPoll();
}

/* ---------- live updates ---------- */
function onRow(r,ev){
 if(!r||!r.id)return;
 if(r.opponent_id===uid&&r.status==="pending"&&r.expires_at&&Date.parse(r.expires_at)>Date.now())showIncoming(r);
 if(r.opponent_id===uid&&r.status!=="pending"){const i=shownIn&&shownIn.id===r.id?shownIn:queue.find(q=>q.id===r.id);if(i){if(i===shownIn)dropIncoming(i);else queue=queue.filter(q=>q!==i);if(r.status==="cancelled"||r.status==="expired")toast("The challenge was withdrawn")}}
 if(cur&&cur.id===r.id&&r.challenger_id===uid){
  if(r.status==="active"){closeDlg();const c=cur;cur=null;openGame(r)}
  else if(r.status==="cancelled"){closeDlg();toast(c_name()+" cancelled the bet"+(cur.mode==="escrow"?". Your stake was refunded.":"."));cur=null;wallet()}
  else if(r.status==="expired"){closeDlg();toast("No response. Your bet was cancelled"+(cur.mode==="escrow"?" and refunded.":"."));cur=null;wallet()}}
 if(game&&game.id===r.id)game.update(r);
}
const c_name=()=>cur&&cur.persona||"The other player";
function startPoll(){if(pollT)return;pollT=setInterval(async()=>{const ids=[cur&&cur.id,game&&game.id].filter(Boolean);if(!ids.length)return stopPollIfIdle();
 for(const id of ids){const {data}=await sb().from("game_bets").select("*").eq("id",id).maybeSingle();if(data)onRow(data)}},2000)}
function stopPollIfIdle(){if(!cur&&!game&&pollT){clearInterval(pollT);pollT=null}}
async function start(id){
 uid=id;if(chan){sb().removeChannel(chan);chan=null}
 chan=sb().channel("games-"+id+"-"+Math.random().toString(36).slice(2,6))
  .on("postgres_changes",{event:"*",schema:"public",table:"game_bets",filter:"opponent_id=eq."+id},p=>onRow(p.new))
  .on("postgres_changes",{event:"*",schema:"public",table:"game_bets",filter:"challenger_id=eq."+id},p=>onRow(p.new)).subscribe();
 await rpc("game_bet_sweep");
 const {data}=await sb().from("game_bets").select("*").in("status",["pending","active"]).order("created_at");
 (data||[]).forEach(r=>{if(r.status==="active")openGame(r);else if(r.opponent_id===id)onRow(r);else if(r.challenger_id===id&&!cur){cur={id:r.id,persona:r.persona_name||"The other player",mode:r.mode,sym:r.symbol,amt:r.amount};showWaiting();startPoll()}});
}
setInterval(async()=>{try{if(!sb())return;const {data}=await sb().auth.getSession(),id=data&&data.session&&data.session.user.id;
 if(id&&id!==uid)start(id);else if(!id&&uid){uid=null;if(chan){sb().removeChannel(chan);chan=null}}}catch(e){}},1500);
window.vxGame={onChat};
})();
