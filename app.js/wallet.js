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
function ensure(){
  if(done)return Promise.resolve(true);
  if(busy)return busy;
  busy=(async()=>{
    try{
      const d=db();if(!d||!d.wallet||!d.get||!d.get())return false;
      const info=await d.wallet.info();
      if(info&&info.exists){done=true;startWatch();return true}
      let g=await generate();
      const res=await d.wallet.ensure(g.phrase,g.rows);g=null;
      done=!!(res&&res.exists);if(done)startWatch();return done;
    }catch(e){console.warn("[wallet] setup not completed:",e&&e.message);return false}
    finally{busy=null}
  })();
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
window.veltrixWallet={ensure,watchNow:watchOnce};
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
