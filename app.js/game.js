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
const WALL="data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 110"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1f4b"/><stop offset="1" stop-color="#e2574c"/></linearGradient></defs><rect width="160" height="110" fill="url(#s)"/><circle cx="118" cy="40" r="16" fill="#ffd166"/><path d="M0 62l30-14 26 10 34-18 40 16 30-8v62H0z" fill="#161a33"/><path d="M0 84h160v26H0z" fill="#2a2d3e"/><path d="M0 97h160" stroke="#fff" stroke-width="2" stroke-dasharray="14 10"/><g transform="translate(52 66)"><path d="M0 22l6-12 14-4h22l12 8 8 2v6z" fill="#ff3b3b"/><circle cx="14" cy="26" r="6" fill="#111"/><circle cx="44" cy="26" r="6" fill="#111"/></g></svg>');
const CAR='<svg viewBox="0 0 64 30" width="46" height="22"><path d="M2 20l6-10 14-4h20l12 8 8 2v4z" fill="#ff3b3b"/><circle cx="16" cy="22" r="6" fill="#111"/><circle cx="48" cy="22" r="6" fill="#111"/></svg>';

let uid=null,chan=null,peer=null,cur=null,game=null,pollT=null,queue=[],shownIn=null,seen={};
const toast=m=>{const t=document.getElementById("vmToast");if(!t)return alert(m);t.textContent=m;t.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove("show"),3200)};
const ERR={insufficient:"Not enough balance for this bet.",invalid_amount:"Enter a valid amount.",unsupported_coin:"That coin isn't supported for bets.",already_open:"There is already an open bet between you two.",not_allowed:"Bets aren't available in this chat.",no_opponent:"No opponent is available right now.",gone:"This bet is no longer available.",wait:"Wait for the other player to finish first."};
const rpc=async(fn,a)=>{const {data,error}=await sb().rpc(fn,a||{});if(error){console.error(fn,error);return{ok:false,reason:"error"}}return data||{ok:false}};

/* ---------- dialog (reuses the chat's dialog look) ---------- */
const dlg=document.createElement("div");dlg.className="vm-dialog-backdrop vxg-dlg";dlg.hidden=true;dlg.innerHTML='<section class="vm-dialog" role="dialog" aria-modal="true"></section>';
document.body.appendChild(dlg);const box=$(".vm-dialog",dlg);
const openDlg=h=>{box.innerHTML=h;dlg.hidden=false};const closeDlg=()=>{dlg.hidden=true;box.innerHTML=""};

/* ---------- edge tab + game card inside the chat room ---------- */
function mountTab(){
 const chat=document.getElementById("vmChat");if(!chat||$(".vxg-tab",chat))return;
 chat.insertAdjacentHTML("beforeend",'<button type="button" class="vxg-tab" hidden aria-label="Games"><svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/></svg></button><div class="vxg-card" hidden><button type="button" class="vxg-game" aria-label="Race the clock"><img src="'+WALL+'" alt=""><span>Race the clock</span></button></div>');
 const tab=$(".vxg-tab",chat),card=$(".vxg-card",chat);
 tab.addEventListener("click",()=>{const o=card.hidden;card.hidden=!o;tab.classList.toggle("open",o)});
 $(".vxg-game",card).addEventListener("click",()=>{card.hidden=true;tab.classList.remove("open");openSetup()});
}
function onChat(p){mountTab();peer=p&&!p.support?p:null;const chat=document.getElementById("vmChat"),tab=chat&&$(".vxg-tab",chat),card=chat&&$(".vxg-card",chat);if(!tab)return;
 tab.hidden=!peer;if(!peer){card.hidden=true;tab.classList.remove("open")}}

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

/* ---------- the race screen (slides over the page) ---------- */
function openGame(r){
 if(game&&game.id===r.id)return game.update(r);if(game)return;
 const el=document.createElement("section");el.className="vm-page vm-over vxg-screen";el.setAttribute("aria-label","Race the clock");
 el.innerHTML='<header class="vm-top"><button type="button" class="vm-ic" id="vxgX" aria-label="Close" hidden><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button><h1>Race the clock</h1></header><div class="vxg-body"><div class="vxg-road"><span class="vxg-line"></span><span class="vxg-car">'+CAR+'</span><span class="vxg-flag"></span></div><div class="vxg-clock" id="vxgClock">0.00 s</div><div class="vxg-msg" id="vxgMsg"></div><button type="button" class="vxg-act" id="vxgAct" hidden></button></div>';
 document.body.appendChild(el);
 const g=game={id:r.id,row:r,el,running:false,starting:false,taps:0,t0:0,raf:0,finishing:false};
 const mine=()=>g.row.challenger_id===uid,msg=$("#vxgMsg",el),act=$("#vxgAct",el),clock=$("#vxgClock",el),car=$(".vxg-car",el),x=$("#vxgX",el);
 const them=()=>ADMIN_PAGE?"the user":((mine()?g.row.persona_name:(g.row.challenger_name||g.row.persona_name))||"your opponent");
 const setCar=()=>{car.style.left=Math.min(100,g.taps/TAPS*100)+"%"};
 const mineMs=()=>mine()?g.row.c_ms:g.row.o_ms,theirMs=()=>mine()?g.row.o_ms:g.row.c_ms;
 const showAct=(t,fn)=>{act.hidden=!t;act.textContent=t||"";act.onclick=fn||null;act.classList.remove("tap")};
 function close(){cancelAnimationFrame(g.raf);el.remove();game=null;wallet();stopPollIfIdle()}
 x.addEventListener("click",close);
 async function run(){
  g.starting=true;showAct(null);clock.textContent="0.00 s";g.taps=0;setCar();
  for(const n of [3,2,1]){msg.innerHTML='<span class="vxg-big">'+n+'</span>';await new Promise(r=>setTimeout(r,800))}
  const s=await rpc("game_bet_start",{p_id:g.id});g.starting=false;if(!s.ok){msg.textContent=ERR[s.reason]||"Couldn't start the run.";showAct("Back",()=>g.update(g.row));return}
  g.running=true;g.t0=performance.now();msg.innerHTML='<span class="vxg-big go">GO!</span><small>Tap as fast as you can</small>';showAct("TAP!");act.classList.add("tap");
  const loop=()=>{if(!g.running)return;clock.textContent=fmtMs(performance.now()-g.t0);g.raf=requestAnimationFrame(loop)};loop();
  act.onpointerdown=async e=>{e.preventDefault();if(!g.running||g.finishing)return;g.taps++;setCar();if(g.taps>=TAPS)await finish()};
 }
 async function finish(){
  g.finishing=true;g.running=false;cancelAnimationFrame(g.raf);act.onpointerdown=null;showAct(null);msg.textContent="Checking your time…";
  const f=await rpc("game_bet_finish",{p_id:g.id});g.finishing=false;
  if(f.ok){clock.textContent=fmtMs(f.ms);const {data}=await sb().from("game_bets").select("*").eq("id",g.id).single();if(data)g.update(data)}else msg.textContent=ERR[f.reason]||"Couldn't save your time."}
 g.update=function(row){
  g.row=row;x.hidden=true;const st=row.status,m=mine(),stake=row.mode==="escrow"?fmtAmt(row.amount)+" "+row.symbol:null;
  if(g.running||g.finishing||g.starting)return;
  if(st==="finished"||st==="void"||st==="cancelled"||st==="expired"){
   x.hidden=false;showAct(null);car.style.left="100%";
   const a=mineMs(),b=theirMs();clock.textContent=a?fmtMs(a):"–";
   if(st==="void"){msg.innerHTML=(a&&b?"<b>It's a tie</b><small>You: "+fmtMs(a)+" · "+esc(them())+": "+fmtMs(b)+"</small>":"<b>Bet cancelled</b>")+"<small>"+(stake?"Stakes were refunded.":"")+"</small>";return}
   if(st!=="finished"){msg.innerHTML="<b>Bet cancelled</b>";return}
   const won=row.winner_id===uid;
   msg.innerHTML='<span class="vxg-res '+(won?"win":"lose")+'">'+(won?"You won!":"You lost")+"</span><small>You: "+(a?fmtMs(a):"–")+" · "+esc(them())+": "+(b?fmtMs(b):"no run")+"</small><small>"+(stake?(won?"+"+esc(fmtAmt(row.amount*2)+" "+row.symbol)+" was sent to your wallet.":"You lost "+esc(stake)+"."):"Played for fun, nothing was locked.")+"</small>";
   wallet();return}
  const myFin=m?row.c_finish:row.o_finish,myStart=m?row.c_start:row.o_start;
  if(myFin){msg.innerHTML="<b>Your time: "+fmtMs(mineMs())+"</b><small>"+(m?"Waiting for "+esc(them())+" to race…":"Waiting for the result…")+"</small>";showAct(null);return}
  if(myStart){finish();return}                                    /* run was interrupted: close it out with the time that passed */
  if(!m&&!row.c_finish){msg.innerHTML="<b>"+esc(them())+" races first</b><small>You'll get your turn right after.</small>";showAct(null);return}
  msg.innerHTML=(m?"<b>You race first</b>":"<b>"+esc(them())+" ran "+fmtMs(row.c_ms)+"</b><small>Beat that time!</small>")+(stake?"<small>Stake: "+esc(stake)+" each</small>":"<small>Playing for fun</small>");
  showAct("Start race",run);
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
