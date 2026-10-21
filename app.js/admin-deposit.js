/* Admin: "Deposit wallet" — enter the recovery phrase of the (test) wallet, preview the generated address for every
   supported coin, then save the ADDRESSES for the users' Deposit screen. The phrase stays in this browser tab only:
   it is cleared right after generating and is never saved or sent.
   Styled with the app's own theme variables (--bg / --card / --line / --tx / --mut + the brand tokens), so it follows
   the light and dark themes like the rest of the admin app. */
(function(){
"use strict";
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let pending=null;

const CSS=`
#dwPage{z-index:2147483000;overflow:hidden}
#dwPage .dw-scroll{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 12px 14px}
#dwPage .dw-wrap{width:100%;max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
#dwPage .dw-hero{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:var(--card)}
#dwPage .dw-badge{flex:none;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;background:var(--brand-grad,linear-gradient(135deg,#1a86ff,#2450ff 55%,#6d3bff));color:#fff}
#dwPage .dw-badge svg{width:16px;height:16px}
#dwPage .dw-hero h2{margin:0 0 2px;font-size:13px;font-weight:650}
#dwPage .dw-hero p{margin:0;font-size:11px;line-height:1.45;color:var(--mut)}
#dwPage .dw-note{display:flex;gap:7px;align-items:center;padding:7px 11px;border-radius:10px;background:var(--brand-soft,#eef2ff);color:var(--brand,#2450ff);font-size:11px;font-weight:650}
#dwPage .dw-note svg{width:14px;height:14px;flex:none}
html[data-theme="dark"] #dwPage .dw-note{background:rgba(47,107,255,.16);color:#8fb0ff}
#dwPage label.dw-l{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut);padding:2px 2px 0}
#dwPage textarea{width:100%;box-sizing:border-box;resize:none;padding:10px 12px;border-radius:12px;border:1px solid transparent;background:var(--card);color:var(--tx);font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;outline:0;transition:border-color .15s,box-shadow .15s}
#dwPage textarea::placeholder{color:var(--mut);opacity:1}
#dwPage textarea:focus{border-color:var(--brand,#2450ff);box-shadow:0 0 0 3px var(--brand-ring,rgba(36,80,255,.22))}
#dwPage .dw-foot{flex:none;display:flex;gap:8px;padding:8px 12px calc(10px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line)}
#dwPage .dw-foot-in{width:100%;max-width:520px;margin:0 auto;display:flex;gap:8px}
#dwPage .dw-btn{flex:1;height:40px;border:0;border-radius:20px;background:var(--brand-grad,linear-gradient(135deg,#1a86ff,#2450ff 55%,#6d3bff));color:#fff;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer;box-shadow:0 5px 14px rgba(36,80,255,.25);transition:filter .15s,transform .1s}
#dwPage .dw-btn:active{transform:scale(.98);filter:brightness(.94)}
#dwPage .dw-btn:disabled{opacity:.6;cursor:default;transform:none}
#dwPage .dw-btn.alt{background:var(--card);color:var(--tx);box-shadow:none}
#dwPage .dw-btn[hidden]{display:none}
#dwPage .dw-msg{margin:0;font-size:11.5px;line-height:1.4;color:var(--neg,#d93a49)}
#dwPage .dw-msg:empty{display:none}
#dwPage .dw-ok{padding:10px 12px;border-radius:10px;background:var(--pos-soft,#e6f6ee);color:var(--pos,#0f9d58);font-weight:700;font-size:12px}
#dwPage .dw-h{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 0}
#dwPage .dw-h b{font-size:12px}#dwPage .dw-h span{font-size:10px;color:var(--mut)}
#dwPage .dw-list{border-radius:12px;background:var(--card);overflow:hidden}
#dwPage .dw-row{display:flex;gap:9px;padding:8px 10px;align-items:center}
#dwPage .dw-row+.dw-row{border-top:1px solid var(--line)}
#dwPage .dw-coin{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--brand-grad,linear-gradient(135deg,#1a86ff,#2450ff 55%,#6d3bff));color:#fff;font-size:8px;font-weight:800}
#dwPage .dw-body{flex:1;min-width:0}
#dwPage .dw-top{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
#dwPage .dw-top b{font-size:12px;font-weight:650}#dwPage .dw-top small{font-size:10px;color:var(--mut)}
#dwPage .dw-addr{margin-top:2px;font:10.5px/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;color:var(--tx)}
#dwPage .dw-path{margin-top:1px;font-size:9px;color:var(--mut)}
#dwPage .dw-copy{flex:none;padding:5px 9px;border-radius:999px;border:0;background:var(--bg);color:var(--brand,#2450ff);font-weight:700;font-size:10px;font-family:inherit;cursor:pointer}
#dwPage .dw-copy:active{opacity:.6}
#dwPage .dw-fine{margin:0;padding:0 2px;font-size:10.5px;line-height:1.5;color:var(--mut)}
/* the open button: same look as the chat "new message" button, on the opposite (left) side */
#vmList .vm-fab#dwOpen{right:auto;left:16px}
`;
const ICO={
 back:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
 wallet:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v10a2 2 0 002 2h14a1 1 0 001-1v-3"/><path d="M21 9H5"/><path d="M17 14h4v3h-4a1.5 1.5 0 010-3z"/></svg>',
 warn:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>'
};

function ensureStyle(){if(document.getElementById("dwStyle"))return;const s=document.createElement("style");s.id="dwStyle";s.textContent=CSS;document.head.appendChild(s)}

function rowsHTML(rows){return rows.map(r=>`<div class="dw-row"><div class="dw-coin">${esc(r.symbol.slice(0,4))}</div><div class="dw-body"><div class="dw-top"><b>${esc(r.symbol)}</b><small>${esc(r.network)}</small></div><div class="dw-addr">${esc(r.address)}</div>${r.derivation_path?`<div class="dw-path">${esc(r.derivation_path)}</div>`:""}</div><button type="button" class="dw-copy" data-copy="${esc(r.address)}">Copy</button></div>`).join("")}
function listHTML(rows,title){return `<div class="dw-h"><b>${title}</b><span>${rows.length} coins</span></div><div class="dw-list">${rowsHTML(rows)}</div>`}

function open(){
 ensureStyle();
 const app=document.getElementById("adminApp");if(app)app.style.display="none";
 const g=document.createElement("section");g.className="vm-page";g.id="dwPage";g.setAttribute("aria-label","Deposit wallet");
 g.innerHTML=`
  <header class="vm-top"><button type="button" class="vm-ic" id="dwClose" aria-label="Back">${ICO.back}</button><h1>Deposit wallet</h1><span class="ad-chip">Admin</span></header>
  <div class="dw-scroll"><div class="dw-wrap">
   <div class="dw-hero"><div class="dw-badge">${ICO.wallet}</div><div><h2>Receiving wallet</h2><p>Enter the recovery phrase of the wallet that receives deposits. One address is made per coin and shown on users' Deposit screen. The phrase is never saved.</p></div></div>
   <div class="dw-note">${ICO.warn}<span>Use a test wallet only.</span></div>
   <label class="dw-l" for="dwPhrase">Recovery phrase</label>
   <textarea id="dwPhrase" rows="3" placeholder="12 or 24 recovery words" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
   <p class="dw-msg" id="dwMsg" role="alert"></p>
   <div id="dwOut" style="display:flex;flex-direction:column;gap:14px"></div>
  </div></div>
  <div class="dw-foot"><div class="dw-foot-in"><button type="button" class="dw-btn" id="dwGen">Generate addresses</button><button type="button" class="dw-btn" id="dwSave" hidden>Save for users</button></div></div>`;
 document.body.appendChild(g);
 const $=id=>g.querySelector("#"+id),msg=$("dwMsg"),out=$("dwOut");
 const close=()=>{pending=null;$("dwPhrase").value="";g.remove();if(app)app.style.display=""};
 $("dwClose").onclick=close;
 g.addEventListener("click",e=>{const b=e.target.closest("[data-copy]");if(!b)return;
  const t=b.getAttribute("data-copy"),done=()=>{b.textContent="Copied";setTimeout(()=>b.textContent="Copy",1200)};
  try{navigator.clipboard.writeText(t).then(done,()=>{})}catch{}});
 veltrixDB.deposits.list().then(r=>{if(r.length&&!pending)out.innerHTML=listHTML(r.sort((a,b)=>a.symbol.localeCompare(b.symbol)),"Currently saved")}).catch(()=>{});
 const gen=$("dwGen"),save=$("dwSave");
 gen.onclick=async()=>{msg.textContent="";gen.disabled=true;gen.textContent="Generating…";save.hidden=true;
  try{const res=await VeltrixAddr.deriveAll($("dwPhrase").value);pending=res.rows;$("dwPhrase").value="";
   out.innerHTML=listHTML(res.rows,"Preview")+
    (res.unsupported.length?`<p class="dw-fine">Not generated yet (these coins show "not available" to users): ${esc(res.unsupported.join(", "))}.</p>`:"")+
    `<p class="dw-fine">Before saving, import the same phrase into a wallet app and confirm the first address matches for a coin or two.</p>`;
   save.hidden=false;save.disabled=false;save.textContent="Save for users";gen.classList.add("alt");gen.textContent="Generate again";
   g.querySelector(".dw-scroll").scrollTo({top:0})}
  catch(e){msg.textContent=e.message||"Couldn't generate addresses.";gen.textContent=pending?"Generate again":"Generate addresses";save.hidden=!pending}
  gen.disabled=false};
 save.onclick=async()=>{save.disabled=true;save.textContent="Saving…";
  try{await veltrixDB.deposits.replaceAll(pending);pending=null;save.hidden=true;gen.classList.remove("alt");gen.textContent="Generate addresses";out.innerHTML=`<div class="dw-ok">Saved. Users now see these addresses on their Deposit screen.</div>`}
  catch(e){console.error(e);save.disabled=false;save.textContent="Save for users";msg.textContent="Couldn't save. Make sure the phase 4 SQL has been run in Supabase."}};
}
const FAB_ICON='<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v10a2 2 0 002 2h14a1 1 0 001-1v-3"/><path d="M21 9H5"/><path d="M17 14h4v3h-4a1.5 1.5 0 010-3z"/></svg>';
function mount(){const l=document.getElementById("vmList");if(!l||l.querySelector("#dwOpen"))return;ensureStyle();
 const b=document.createElement("button");b.type="button";b.className="vm-fab";b.id="dwOpen";b.setAttribute("aria-label","Deposit wallet");b.title="Deposit wallet";b.innerHTML=FAB_ICON;
 b.onclick=open;l.appendChild(b)}
mount();
})();
