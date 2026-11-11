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
/* The phrase is ALSO sealed (same AES-GCM / password key) into the account's sign-up data, so the import survives a reload,
   a closed page, or confirming the e-mail in a different browser/app. It can only be opened with the account password. */
async function seal(password,phrase){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},await pwKey(password,salt),new TextEncoder().encode(phrase));
  return JSON.stringify({s:b64(salt),i:b64(iv),c:b64(ct)});
}
async function openSealed(j,password){
  const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(j.i)},await pwKey(password,unb64(j.s)),unb64(j.c));
  return new TextDecoder().decode(pt);
}
async function sessionBlob(){try{const {data}=await db().client.auth.getSession();const m=data&&data.session&&data.session.user&&data.session.user.user_metadata;return(m&&m.import_blob)||null}catch{return null}}
async function clearBlob(){try{if(await sessionBlob())await db().client.auth.updateUser({data:{import_blob:null}})}catch{}}
function localLocked(email){try{const j=JSON.parse(localStorage.getItem(PEND)||"null");return !!(j&&j.e===String(email||"").toLowerCase()&&Date.now()-j.t<=30*864e5)}catch{return false}}
let unlocking=null,hinted=false,blockedForPw=false,retries=0;
function retryLater(){if(done||retries>=6)return;retries++;setTimeout(()=>{try{ensure()}catch{}},3000*retries)}
function unlockPending(email,password){
  unlocking=(async()=>{
    try{const j=JSON.parse(localStorage.getItem(PEND)||"null");
      if(j&&j.e===String(email).toLowerCase()&&Date.now()-j.t<=30*864e5){pendingImport=await openSealed(j,password);return true}
      if(j&&Date.now()-j.t>30*864e5)localStorage.removeItem(PEND)}catch{}
    try{const raw=await sessionBlob();if(raw){pendingImport=await openSealed(JSON.parse(raw),password);return true}}catch{}
    return false;
  })();
  const u=unlocking;return u.finally(()=>{if(unlocking===u)unlocking=null});
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
      if(unlocking)await unlocking;
      const info=await d.wallet.info();
      if(info&&info.exists){blockedForPw=false;pendingImport=null;clearPending();clearBlob();done=true;startWatch();return true}
      if(!pendingImport){
        /* an import was chosen at sign-up but its phrase is still locked (it opens with the account password): wait for the
           password sign-in. NEVER create a different wallet in the meantime. */
        const acc=d.get();
        blockedForPw=false;
        if(localLocked(acc&&acc.email)||await sessionBlob()){
          blockedForPw=true;
          if(!hinted){hinted=true;toast("Sign in with your password once to finish importing your wallet.")}
          return false;
        }
      }
      if(pendingImport){
        /* the person chose "Import": use THEIR phrase, never generate a new one */
        const ph=pendingImport;let rows=null;
        try{rows=await derive(ph)}catch(e){
          if(/not loaded/i.test(String(e&&e.message))){retryLater();return false}   /* wallet library still loading: try again, keep the import */
          console.warn("[wallet] import failed:",e&&e.message)}
        if(rows){
          const r=await d.wallet.importPhrase(ph,rows);
          if(r&&r.ok){pendingImport=null;clearPending();clearBlob();done=!!r.exists;if(done)startWatch();return done}
          if(r&&r.reason==="already_registered"){pendingImport=null;clearPending();clearBlob();try{toast("That wallet is already linked to another account, so a new wallet was created for you.")}catch{}}
          else if(r&&r.reason==="invalid_phrase"){pendingImport=null;clearPending();clearBlob();try{toast("That recovery phrase couldn't be used, so a new wallet was created for you.")}catch{}}
          else{retryLater();return false}   /* try again later: never replace an imported wallet with a new one by accident */
        }else{pendingImport=null;clearPending();clearBlob();try{toast("That recovery phrase couldn't be read, so a new wallet was created for you.")}catch{}}
      }
      let g=await generate();
      const res=await d.wallet.ensure(g.phrase,g.rows);g=null;
      done=!!(res&&res.exists);if(done)startWatch();return done;
    }catch(e){console.warn("[wallet] setup not completed:",e&&e.message);retryLater();return false}
    finally{}
  }).finally(()=>{busy=null});
  return busy;
}
/* ================= 2. wallet status watcher =================
   The scheduled backend watcher scans the blockchains. This app does NOT: every ~20 s it only asks deposit-watch for the user's OWN current
   state (balances, deposits, sends, network health), which the function reads from the database. Response format: watchcontract.js (version 2).
   When anything the user can see changed (a new deposit, a status / confirmation change, a balance) the wallet and the history are refreshed. */
let watchT=0,watchBusy=false,lastWatchSig="";const warned=new Set();
function watchWarn(list){
  /* each distinct problem is shown once; it is shown again if it clears and comes back */
  const now=new Set(list.map(x=>x.key));
  list.forEach(x=>{if(!warned.has(x.key)){warned.add(x.key);try{toast(x.message)}catch{}}});
  [...warned].forEach(k=>{if(!now.has(k))warned.delete(k)});
}
/* WHY the balance service failed: the exact HTTP status and the function's own message, never one generic sentence. status 0 = the request never got an answer (offline / blocked). */
async function whyStatusFailed(e){
  let status=0,body=null;
  try{const c=e&&e.context;if(c&&typeof c.status==="number"){status=c.status;try{body=await c.clone().json()}catch{try{body={error:(await c.clone().text()).slice(0,160)}}catch{}}}}catch{}
  const said=String(body&&(body.error||body.message)||"").slice(0,160),detail=(status?"HTTP "+status:"no answer")+(said?": "+said:"")+(e&&e.message&&!said?" ("+e.message+")":"");
  if(!status)return{status:0,detail,message:"Can't reach the balance service right now. Balances may be out of date. [Reason: "+(e&&e.name||"error")+" - "+String(e&&e.message||"unknown").slice(0,120)+(navigator.onLine===false?" - phone is offline":"")+" - from "+location.origin+"]"};
  if(status===404)return{status,detail,message:"The balance service (deposit-watch) is not deployed on this project (404). Balances will not update."};
  if(status===401||status===403)return{status,detail,message:/not signed in/i.test(said)?"Your session expired. Sign in again to refresh balances.":"The balance service refused the request ("+status+"). deposit-watch must be deployed with --no-verify-jwt."};
  return{status,detail,message:"The balance service failed ("+status+(said?": "+said:"")+"). Balances may be out of date."};
}
async function watchOnce(){
  if(watchBusy||document.hidden)return;
  const d=db();if(!d||!d.get||!d.get()||!done)return;
  const W=window.veltrixWatch;if(!W)return;
  watchBusy=true;
  try{
    const {data,error}=await d.client.functions.invoke("deposit-watch",{body:{}});
    if(error)throw error;
    const p=W.parse(data);
    if(!p.ok){watchWarn([{key:"bad|"+p.error,message:p.error}]);return}
    window.veltrixWallet.lastStatus=p;
    watchWarn(W.problems(p,[]));
    const sig=W.signature(p);
    if(lastWatchSig&&sig!==lastWatchSig){
      const acc=await d.refreshWallet();                    /* the real balance, from the database the scanner mirrors into */
      if(acc&&window.populateDashboard)populateDashboard(acc);
      if(window.veltrixActivity){try{veltrixActivity.refreshTx()}catch{}try{veltrixActivity.reload()}catch{}}   /* history: pending / confirming n of m / completed */
    }
    lastWatchSig=sig;
  }catch(e){const w=await whyStatusFailed(e);console.warn("[wallet] status check failed:",w.detail);window.veltrixWallet.lastStatusError={status:w.status,detail:w.detail,at:Date.now()};watchWarn([{key:"net|status|"+w.status,message:w.message}])}
  finally{watchBusy=false}
}
function startWatch(){clearInterval(watchT);watchT=setInterval(watchOnce,20000);setTimeout(watchOnce,2500)}
window.veltrixWallet={waitingForPassword:()=>blockedForPw,ensure,watchNow:watchOnce,setImport,stashPending,unlockPending,derive,seal};
window.addEventListener("veltrix-ready",()=>{done=false;retries=0;setTimeout(ensure,1200)});
window.addEventListener("veltrix-revoked",()=>{done=false;lastSig="";lastWatchSig="";warned.clear();clearInterval(watchT)});
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
