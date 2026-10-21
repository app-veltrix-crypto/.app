/* Admin: "Deposit wallet" — enter the recovery phrase of the (test) wallet, preview the generated address for every
   supported coin, then save the ADDRESSES for the users' Deposit screen. The phrase stays in this browser tab only:
   it is cleared right after generating and is never saved or sent. */
(function(){
"use strict";
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const F="padding:12px;border:1px solid #cfd0d6;border-radius:10px;font-size:16px;background:#fff;color:#111;width:100%;box-sizing:border-box";
const BTN="padding:12px 16px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;background:#111;color:#fff";
let pending=null;
function open(){
 const g=document.createElement("div");
 g.style.cssText="position:fixed;inset:0;z-index:2147483000;background:#fff;color:#111;overflow:auto;padding:max(20px,env(safe-area-inset-top)) 20px 40px";
 g.innerHTML=`<div style="max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px">
  <div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0;font-size:22px">Deposit wallet</h1><button type="button" id="dwClose" style="${BTN};background:#eee;color:#111">Close</button></div>
  <p style="margin:0;font-size:14px;line-height:1.45">Enter the recovery phrase of the wallet that should receive deposits. One address is generated per coin and shown to users on their Deposit screen. <b>Use a test wallet only.</b> The phrase is not saved, only the addresses are.</p>
  <textarea id="dwPhrase" rows="3" placeholder="12 or 24 recovery words" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="${F}"></textarea>
  <button type="button" id="dwGen" style="${BTN}">Generate addresses</button>
  <p id="dwMsg" style="margin:0;font-size:14px;color:#b00020"></p>
  <div id="dwOut"></div></div>`;
 const app=document.getElementById("adminApp");if(app)app.style.display="none";
 document.body.appendChild(g);
 const $=id=>g.querySelector("#"+id),msg=$("dwMsg"),out=$("dwOut");
 $("dwClose").onclick=()=>{pending=null;$("dwPhrase").value="";g.remove();if(app)app.style.display=""};
 const table=(rows,title)=>`<div style="font-weight:700;margin:6px 0">${title}</div>`+rows.map(r=>`<div style="padding:10px 0;border-top:1px solid #e3e4ea"><b>${esc(r.symbol)}</b> <small style="opacity:.7">· ${esc(r.network)}</small><div style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all;margin-top:3px">${esc(r.address)}</div><small style="opacity:.55">${esc(r.derivation_path||"")}</small></div>`).join("");
 veltrixDB.deposits.list().then(r=>{if(r.length&&!pending)out.innerHTML=table(r.sort((a,b)=>a.symbol.localeCompare(b.symbol)),`Currently saved (${r.length} coins)`)}).catch(()=>{});
 $("dwGen").onclick=async()=>{msg.textContent="";const b=$("dwGen");b.disabled=true;b.textContent="Generating…";
  try{const res=await VeltrixAddr.deriveAll($("dwPhrase").value);pending=res.rows;$("dwPhrase").value="";
   out.innerHTML=table(res.rows,`Preview (${res.rows.length} coins)`)+
    `<p style="font-size:13px;margin:10px 0">Not generated yet (these coins show "not available" to users): ${esc(res.unsupported.join(", "))}.</p>
     <p style="font-size:13px;margin:10px 0">Before saving, import the same phrase into a wallet app and confirm the first address matches for a coin or two.</p>
     <button type="button" id="dwSave" style="${BTN};width:100%">Save for users</button>`;
   $("dwSave").onclick=async()=>{const s=$("dwSave");s.disabled=true;s.textContent="Saving…";
    try{await veltrixDB.deposits.replaceAll(pending);pending=null;out.innerHTML=`<p style="color:#0a7a3d;font-weight:600">Saved. Users now see these addresses on their Deposit screen.</p>`}
    catch(e){console.error(e);s.disabled=false;s.textContent="Save for users";msg.textContent="Couldn't save. Make sure the phase 4 SQL has been run in Supabase."}}}
  catch(e){msg.textContent=e.message||"Couldn't generate addresses."}
  b.disabled=false;b.textContent="Generate addresses"}
}
function mount(){const h=document.querySelector("#adminApp .vm-top");if(!h||h.querySelector("#dwOpen"))return;
 const b=document.createElement("button");b.type="button";b.id="dwOpen";b.textContent="Deposit wallet";b.style.cssText="margin-left:auto;margin-right:8px;padding:7px 12px;border-radius:999px;border:1px solid #cfd0d6;background:transparent;color:inherit;font-size:13px;font-weight:600;cursor:pointer";
 b.onclick=open;const chip=h.querySelector(".ad-chip");chip?h.insertBefore(b,chip):h.appendChild(b)}
mount();
})();
