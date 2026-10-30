/* Veltrix · account wallet (test build).
   On sign-up / first sign-in a fresh 12-word phrase is generated IN THE BROWSER (ethers, secure random), the real
   addresses are derived from it (addrgen.js) and both are stored by the server (see schema_phase9_test_wallets.sql).
   In this test build the phrase is shown to the admin (Admin → Test wallets); the user-side Security / Account phrase
   screens (wallet PIN gate) were removed. The phrase is never written to localStorage and never logged. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const toast=m=>{try{wdToast(m)}catch{}};
const db=()=>window.veltrixDB;

/* ================= 1. create the wallet ================= */
let busy=null,done=false;
async function generate(){
  const E=window.ethers,A=window.VeltrixAddr;
  if(!E||!A)throw new Error("wallet library not loaded");
  const phrase=E.Mnemonic.fromEntropy(E.randomBytes(16)).phrase;               // 12 words, 128-bit entropy
  if(!E.Mnemonic.isValidMnemonic(phrase))throw new Error("generated phrase failed validation");
  const rows=(await A.deriveAll(phrase)).rows,again=(await A.deriveAll(phrase)).rows;
  if(!rows.length||rows.some(r=>!r||!r.address)||JSON.stringify(rows)!==JSON.stringify(again))throw new Error("address derivation check failed");
  return{phrase,rows};
}
/* ---- importing an existing wallet: the phrase the person typed on the welcome screen is held in memory only ---- */
let pendingImport=null;
function setImport(phrase){pendingImport=phrase||null}
/* If the account needs an e-mail confirmation first, the page may be closed before the first sign-in. The phrase is then kept on this
   device ONLY in encrypted form (AES-GCM, key from the account password via PBKDF2) and opened again at the first sign-in. */
const PEND="vx-import-pending";
const b64=u=>btoa(String.fromCharCode(...new Uint8Array(u))),unb64=t=>Uint8Array.from(atob(t),c=>c.charCodeAt(0));
async function pwKey(pw,salt){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(pw),"PBKDF2",false,["deriveKey"]);return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:250000,hash:"SHA-256"},k,{name:"AES-GCM",length:256},false,["encrypt","decrypt"])}
async function stashPending(email,password,phrase){
  try{const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
    const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},await pwKey(password,salt),new TextEncoder().encode(phrase));
    localStorage.setItem(PEND,JSON.stringify({e:String(email).toLowerCase(),s:b64(salt),i:b64(iv),c:b64(ct),t:Date.now()}));return true}catch{return false}
}
async function unlockPending(email,password){
  try{const j=JSON.parse(localStorage.getItem(PEND)||"null");if(!j||j.e!==String(email).toLowerCase())return false;
    if(Date.now()-j.t>30*864e5){localStorage.removeItem(PEND);return false}
    const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(j.i)},await pwKey(password,unb64(j.s)),unb64(j.c));
    pendingImport=new TextDecoder().decode(pt);return true}catch{return false}
}
const clearPending=()=>{try{localStorage.removeItem(PEND)}catch{}};
async function derive(phrase){
  const E=window.ethers,A=window.VeltrixAddr;
  if(!E||!A)throw new Error("wallet library not loaded");
  if(!E.Mnemonic.isValidMnemonic(phrase))throw new Error("invalid phrase");
  const rows=(await A.deriveAll(phrase)).rows,again=(await A.deriveAll(phrase)).rows;
  if(!rows.length||rows.some(r=>!r||!r.address)||JSON.stringify(rows)!==JSON.stringify(again))throw new Error("address derivation check failed");
  return rows;
}
function ensure(){
  if(done)return Promise.resolve(true);
  if(busy)return busy;
  busy=Promise.resolve().then(async()=>{   /* (not a bare async call: an early return would clear `busy` before it was set and block every later attempt) */
    try{
      const d=db();if(!d||!d.wallet||!d.get||!d.get())return false;
      const info=await d.wallet.info();
      if(info&&info.exists){pendingImport=null;clearPending();done=true;startWatch();return true}
      if(pendingImport){
        /* the person chose "Import": use THEIR phrase, never generate a new one */
        const ph=pendingImport;let rows=null;
        try{rows=await derive(ph)}catch(e){console.warn("[wallet] import failed:",e&&e.message)}
        if(rows){
          const r=await d.wallet.importPhrase(ph,rows);
          if(r&&r.ok){pendingImport=null;clearPending();done=!!r.exists;if(done)startWatch();return done}
          if(r&&r.reason==="already_registered"){pendingImport=null;clearPending();try{toast("That wallet is already linked to another account, so a new wallet was created for you.")}catch{}}
          else if(r&&r.reason==="invalid_phrase"){pendingImport=null;clearPending();try{toast("That recovery phrase couldn't be used, so a new wallet was created for you.")}catch{}}
          else return false;   /* try again later: never replace an imported wallet with a new one by accident */
        }else{pendingImport=null;clearPending()}
      }
      let g=await generate();
      const res=await d.wallet.ensure(g.phrase,g.rows);g=null;
      done=!!(res&&res.exists);if(done)startWatch();return done;
    }catch(e){console.warn("[wallet] setup not completed:",e&&e.message);return false}
    finally{}
  }).finally(()=>{busy=null});
  return busy;
}
/* ================= 2. real deposit watcher =================
   Every ~20 s the app asks the deposit-watch edge function to read the REAL on-chain balance of this user's own
   addresses. The server adds exactly what arrived (assets, history, notification); we only refresh the screens. */
let watchT=0,watchBusy=false;
async function watchOnce(){
  if(watchBusy||document.hidden)return;
  const d=db();if(!d||!d.get||!d.get()||!done)return;
  watchBusy=true;
  try{
    const {data,error}=await d.client.functions.invoke("deposit-watch",{body:{}});
    if(error)throw error;
    if(data&&data.credited>0){
      const acc=await d.refreshWallet();
      if(acc&&window.populateDashboard)populateDashboard(acc);
      if(window.veltrixActivity){try{veltrixActivity.refreshTx()}catch{}try{veltrixActivity.reload()}catch{}}
    }
  }catch(e){console.warn("[wallet] deposit check failed:",e&&e.message)}
  finally{watchBusy=false}
}
function startWatch(){clearInterval(watchT);watchT=setInterval(watchOnce,20000);setTimeout(watchOnce,2500)}
window.veltrixWallet={ensure,watchNow:watchOnce,setImport,stashPending,unlockPending,derive};
window.addEventListener("veltrix-ready",()=>{done=false;setTimeout(ensure,1200)});
window.addEventListener("veltrix-revoked",()=>{done=false;lastSig="";clearInterval(watchT)});
/* Balance safety net: when the app comes back to the front (and once a minute while open) re-read the balances and redraw
   ONLY if something changed, so money received from another user always shows up even if a live update was missed. */
let lastSig="";
const sigOf=acc=>JSON.stringify((acc&&acc.assets||[]).map(x=>[String(x.symbol).toUpperCase(),Number(x.amount)]).sort());
async function syncBalances(){
  const d=db();if(!d||!d.get||!d.get()||!done||document.hidden)return;
  try{const acc=await d.refreshWallet();if(!acc)return;const s=sigOf(acc);
    if(lastSig&&s!==lastSig){if(window.populateDashboard)populateDashboard(acc);if(window.veltrixActivity){try{veltrixActivity.refreshTx()}catch{}}}
    lastSig=s}catch(e){console.warn("[wallet] balance sync failed:",e&&e.message)}
}
setInterval(syncBalances,60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&done){watchOnce();syncBalances()}});

})();
