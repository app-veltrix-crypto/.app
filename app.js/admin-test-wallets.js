/* Admin: "Test wallets" — TEST BUILD ONLY (replaces the old "Deposit wallet" screen).
   A new account's recovery phrase is sent here. Tap an account to open it, then Unhide / Hide / Copy. No PIN or 2FA step.
   Accounts are never deleted automatically.
   Server side: supabase/schema_phase9_test_wallets.sql. Remove before launch: schema_phase9_REMOVE_before_launch.sql. */
(function(){
"use strict";
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const CSS=`
#twPage{z-index:2147483000;overflow:hidden}
#twPage .tw-scroll{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 12px 14px}
#twPage .tw-wrap{width:100%;max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
#twPage .tw-note{padding:8px 11px;border-radius:10px;background:var(--brand-soft,#eef2ff);color:var(--brand,#2450ff);font-size:10px;font-weight:600;line-height:1.45}
html[data-theme="dark"] #twPage .tw-note{background:rgba(47,107,255,.16);color:#8fb0ff}
#twPage .tw-list{border-radius:12px;background:var(--card);overflow:hidden}
#twPage .tw-item{display:flex;width:100%;gap:10px;align-items:center;padding:11px 12px;border:0;background:transparent;color:var(--tx);font-family:inherit;text-align:left;cursor:pointer}
#twPage .tw-item+.tw-item{border-top:1px solid var(--line)}
#twPage .tw-item:active{opacity:.6}
#twPage .tw-av{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:var(--brand-grad,linear-gradient(135deg,#1a86ff,#2450ff 55%,#6d3bff));color:#fff;font-size:11px;font-weight:650}
#twPage .tw-body{flex:1;min-width:0}
#twPage .tw-body b{display:block;font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#twPage .tw-body small{display:block;font-size:9.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#twPage .tw-left{flex:none;font-size:9.5px;font-weight:600;color:var(--brand,#2450ff);font-variant-numeric:tabular-nums}
#twPage .tw-empty{padding:26px 14px;text-align:center;font-size:11px;color:var(--mut)}
#twPage .tw-card{position:relative;border-radius:14px;padding:12px;background:var(--card)}
#twPage .tw-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;-webkit-user-select:none;user-select:none}
#twPage .tw-w{display:flex;align-items:center;gap:6px;min-width:0;padding:9px 8px;border-radius:11px;background:var(--bg);border:1px solid var(--line)}
#twPage .tw-w i{flex:none;font-style:normal;font-size:9px;font-weight:600;color:var(--mut);min-width:13px;text-align:right}
#twPage .tw-w b{min-width:0;font:600 11.5px ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#twPage .tw-who{padding:2px 2px 0}
#twPage .tw-who b{display:block;font-size:12px}#twPage .tw-who small{font-size:10px;color:var(--mut)}
#twPage .tw-msg{margin:0;font-size:10.5px;color:var(--neg,#d93a49)}#twPage .tw-msg:empty{display:none}
#twPage .tw-foot{flex:none;padding:8px 12px calc(10px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line)}
#twPage .tw-foot-in{width:100%;max-width:520px;margin:0 auto;display:flex;gap:8px}
#twPage .tw-btn{flex:1;height:40px;border:0;border-radius:20px;background:var(--brand-grad,linear-gradient(135deg,#1a86ff,#2450ff 55%,#6d3bff));color:#fff;font-weight:600;font-size:12px;font-family:inherit;cursor:pointer}
#twPage .tw-btn.alt{background:var(--card);color:var(--tx)}
#twPage .tw-btn:disabled{opacity:.5;cursor:default}
#vmList .vm-fab#twOpen{right:auto;left:16px}
`;
const ICO={
 back:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
 fab:'<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v10a2 2 0 002 2h14a1 1 0 001-1v-3"/><path d="M21 9H5"/><path d="M17 14h4v3h-4a1.5 1.5 0 010-3z"/></svg>'
};
const db=()=>window.veltrixDB;
const ensureStyle=()=>{if(document.getElementById("twStyle"))return;const s=document.createElement("style");s.id="twStyle";s.textContent=CSS;document.head.appendChild(s)};
const left=t=>{if(!t)return"";const s=Math.max(0,Math.ceil((Date.parse(t)-Date.now())/1000));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")};
const initials=s=>String(s||"?").trim().split(/[\s@.]+/).filter(Boolean).slice(0,2).map(w=>w[0]).join("").toUpperCase()||"?";
async function copyText(t){
 try{await navigator.clipboard.writeText(t);return true}catch{}
 try{const ta=document.createElement("textarea");ta.value=t;ta.setAttribute("readonly","");ta.style.cssText="position:fixed;left:-9999px;top:0;opacity:0";document.body.appendChild(ta);ta.select();const ok=document.execCommand("copy");ta.remove();return ok}catch{return false}
}

function open(){
 ensureStyle();
 const app=document.getElementById("adminApp");if(app)app.style.display="none";
 const g=document.createElement("section");g.className="vm-page";g.id="twPage";g.setAttribute("aria-label","Test wallets");
 g.innerHTML=`<header class="vm-top"><button type="button" class="vm-ic" id="twBack" aria-label="Back">${ICO.back}</button><h1 id="twTitle">Test wallets</h1><span class="ad-chip">Admin</span></header>
  <div class="tw-scroll"><div class="tw-wrap" id="twBody"></div></div><div class="tw-foot" id="twFoot" hidden><div class="tw-foot-in"><button type="button" class="tw-btn alt" id="twToggle">Unhide</button><button type="button" class="tw-btn" id="twCopy">Copy phrase</button></div></div>`;
 document.body.appendChild(g);
 const $=id=>g.querySelector("#"+id),bodyEl=$("twBody"),foot=$("twFoot");
 let view="list",items=[],sel=null,phrase=null,shown=false,tick=0,poll=0;

 const stop=()=>{clearInterval(tick);tick=0};
 const close=()=>{stop();clearInterval(poll);phrase=null;g.remove();if(app)app.style.display=""};

 async function loadList(){
  try{items=await db().wallet.testList()}catch(e){console.error(e);bodyEl.innerHTML=`<p class="tw-msg" style="display:block">Couldn't load. Make sure supabase/schema_phase9_test_wallets.sql has been run, and that you are signed in as an admin.</p>`;return}
  if(view==="list")drawList();
 }
 function drawList(){
  stop();phrase=null;shown=false;foot.hidden=true;$("twTitle").textContent="Test wallets";
  bodyEl.innerHTML=`<div class="tw-note">Test build: new accounts appear here with their recovery phrase.</div>`+
   (items.length?`<div class="tw-list">${items.map((w,i)=>`<button type="button" class="tw-item" data-i="${i}"><span class="tw-av">${esc(initials(w.name||w.email))}</span><span class="tw-body"><b>${esc(w.name||w.email)}</b><small>${esc(w.email)} · ${esc(new Date(w.created_at).toLocaleString([], {hour:"2-digit",minute:"2-digit",day:"numeric",month:"short"}))}</small></span>${w.expires_at?`<span class="tw-left" data-exp="${esc(w.expires_at)}">${left(w.expires_at)}</span>`:""}</button>`).join("")}</div>`
   :`<div class="tw-list"><div class="tw-empty">No test wallets right now. A new sign-up will show up here.</div></div>`);
  tick=setInterval(()=>{let gone=false;bodyEl.querySelectorAll("[data-exp]").forEach(e=>{e.textContent=left(e.dataset.exp);if(Date.parse(e.dataset.exp)<=Date.now())gone=true});if(gone)loadList()},1000);
 }
 async function openOne(w){
  stop();view="one";sel=w;phrase=null;shown=false;$("twTitle").textContent="Wallet phrase";
  bodyEl.innerHTML=`<div class="tw-who"><b>${esc(w.name||w.email)}</b><small>${esc(w.email)}</small></div><div class="tw-card"><div class="tw-grid" id="twGrid" translate="no"></div></div><p class="tw-msg" id="twMsg"></p>`;
  foot.hidden=false;$("twToggle").disabled=$("twCopy").disabled=true;draw();
  tick=setInterval(()=>{const e=$("twLeft");if(e)e.textContent=left(w.expires_at);if(w.expires_at&&Date.parse(w.expires_at)<=Date.now()){backToList()}},1000);
  try{const r=await db().wallet.testPhrase(w.user_id);
   if(r&&r.ok){phrase=r.phrase;$("twToggle").disabled=$("twCopy").disabled=false}
   else $("twMsg").textContent=r&&r.reason==="missing"?"This wallet no longer exists.":"The test view is switched off."}
  catch(e){console.error(e);$("twMsg").textContent="Couldn't load this phrase."}
 }
 function draw(){
  const grid=$("twGrid");if(!grid)return;const words=phrase?phrase.split(" "):new Array(12).fill("");
  grid.innerHTML=words.map((w,i)=>`<div class="tw-w"><i>${i+1}</i><b>${shown&&w?esc(w):"••••••"}</b></div>`).join("");
  $("twToggle").textContent=shown?"Hide":"Unhide";
 }
 function backToList(){view="list";sel=null;phrase=null;shown=false;loadList().then(drawList)}
 $("twToggle").onclick=()=>{if(!phrase)return;shown=!shown;draw()};
 $("twCopy").onclick=async e=>{if(!phrase)return;const b=e.currentTarget,ok=await copyText(phrase);b.textContent=ok?"Copied":"Couldn't copy";setTimeout(()=>b.textContent="Copy phrase",1400)};
 $("twBack").onclick=()=>view==="one"?backToList():close();
 bodyEl.addEventListener("click",e=>{const b=e.target.closest(".tw-item");if(b)openOne(items[+b.dataset.i])});
 document.addEventListener("visibilitychange",()=>{if(document.hidden&&shown){shown=false;draw()}});
 poll=setInterval(()=>{if(view==="list")loadList()},15000);
 loadList();
}
function mount(){const l=document.getElementById("vmList");if(!l||l.querySelector("#twOpen"))return;ensureStyle();
 const b=document.createElement("button");b.type="button";b.className="vm-fab";b.id="twOpen";b.setAttribute("aria-label","Test wallets");b.title="Test wallets";b.innerHTML=ICO.fab;
 b.onclick=open;l.appendChild(b)}
mount();
})();
