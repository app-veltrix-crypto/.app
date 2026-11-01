/* Veltrix · in-app browser for the Buy button on a coin's market page.
   Tapping Buy opens a full-screen browser section that loads a crypto on-ramp (the coin is pre-selected). */
(function(){
"use strict";
/* ====================================================== settings (change here) */
const BUY={
  provider:"moonpay",     /* "moonpay" or "transak" */
  moonpayKey:"",          /* your MoonPay publishable key (pk_live_… / pk_test_…) */
  transakKey:"",          /* your Transak API key */
  hintAfterMs:6000        /* show the "page not loading? open in browser" hint after this long */
};
const $=id=>document.getElementById(id);
const page=$("buyBrowserPage");if(!page)return;
const loadTitle=$("vbLoadTitle"),loadEl=$("vbLoad"),loadHost=$("vbLoadHost"),frame=$("vbFrame"),prog=$("vbProg").firstElementChild,hint=$("vbHint"),hostEl=$("vbHost"),titleEl=$("vbTitle"),reloadBtn=$("vbReload");
let curUrl="",hintTimer=0,progTimer=0,spinTimer=0,tok=0;
function spin(on){clearTimeout(spinTimer);reloadBtn.classList.toggle("spin",on);if(on)spinTimer=setTimeout(()=>reloadBtn.classList.remove("spin"),25000)}

/* the blockchain name Transak expects, per coin (the coin is always bought on the same network as the user's Veltrix deposit address) */
const TRANSAK_NET={BTC:"bitcoin",ETH:"ethereum",USDT:"ethereum",USDC:"ethereum",SHIB:"ethereum",LINK:"ethereum",BNB:"bsc",AVAX:"avaxcchain",SOL:"solana",XRP:"ripple",TRX:"tron",LTC:"litecoin"};
/* the user's own Veltrix deposit address for this coin, so what they buy lands straight in their wallet */
async function myAddress(sym){
  try{const w=await veltrixDB.wallet.info();const r=(w&&w.exists&&Array.isArray(w.addresses))?w.addresses:[];const x=r.find(a=>String(a.symbol).toUpperCase()===sym.toUpperCase());return x&&x.address?String(x.address):""}catch{return""}
}
async function urlFor(coin){
  const sym=String(coin&&coin.symbol||"").trim(),enc=encodeURIComponent;
  if(BUY.provider==="transak"&&BUY.transakKey){
    const addr=await myAddress(sym),net=TRANSAK_NET[sym.toUpperCase()];
    return"https://global.transak.com/?apiKey="+enc(BUY.transakKey)+"&cryptoCurrencyCode="+enc(sym.toUpperCase())+(net?"&network="+net:"")+(addr?"&walletAddress="+enc(addr)+"&disableWalletAddressForm=true":"")+"&hideMenu=true&referrerDomain="+enc(location.hostname||"veltrix");
  }
  if(BUY.provider==="moonpay"&&BUY.moonpayKey){
    const addr=await myAddress(sym);
    return"https://buy.moonpay.com/?apiKey="+enc(BUY.moonpayKey)+"&currencyCode="+enc(sym.toLowerCase())+(addr?"&walletAddress="+enc(addr):"");
  }
  return"https://www.moonpay.com/buy/"+enc(sym.toLowerCase());   /* no key configured yet: public buy page (cannot run fully inside an app) */
}
function setProg(p,fade){prog.style.opacity=fade?"0":"1";prog.style.width=p+"%"}
function startProg(){clearInterval(progTimer);let p=8;setProg(p);progTimer=setInterval(()=>{p+=(90-p)*.08;setProg(p)},300)}
function endProg(){clearInterval(progTimer);setProg(100);setTimeout(()=>setProg(0,true),350)}
function load(url){
  const my=++tok,t0=Date.now();curUrl=url;hint.hidden=true;clearTimeout(hintTimer);
  let host="";try{host=new URL(url).hostname}catch{}
  hostEl.textContent=host;loadHost.textContent=host;
  loadEl.classList.remove("done");startProg();spin(true);
  frame.onload=()=>{if(my!==tok||frame.src==="about:blank")return;endProg();spin(false);
    setTimeout(()=>{if(my===tok)loadEl.classList.add("done")},Math.max(0,600-(Date.now()-t0)))};
  frame.src=url;
  hintTimer=setTimeout(()=>{if(my===tok&&!page.hidden)hint.hidden=false},BUY.hintAfterMs);
}
function setLock(url){const lk=hostEl.previousElementSibling;if(lk)lk.style.display=/^https:/i.test(url)?"":"none"}
function openUrl(url,title){
  if(!/^https?:\/\//i.test(url||""))return;
  let host="";try{host=new URL(url).hostname.replace(/^www\./,"")}catch{return}
  titleEl.textContent=title||host;loadTitle.textContent="Opening link";
  page.hidden=false;document.body.classList.add("vb-open");
  load(url);setLock(url);
}
function open(coin){
  /* Buy = send the user to a trusted site that sells crypto. They make their account there and, when the site asks for a
     wallet address, they copy it from their Veltrix Deposit section and paste it in. No keys or accounts are needed here. */
  if(!coin)return;
  const sym=String(coin.symbol||"").trim().toLowerCase();
  const url=sym?"https://www.moonpay.com/buy/"+encodeURIComponent(sym):"https://www.moonpay.com/buy";
  const w=window.open(url,"_blank","noopener,noreferrer");
  if(!w)location.href=url;   /* pop-up blocked: open in this tab instead */
  if(typeof window.wdToast==="function")window.wdToast("When asked for a wallet address, copy it from Deposit "+String(coin.symbol||"").toUpperCase());
}
function close(){
  if(page.hidden)return;tok++;clearTimeout(hintTimer);clearInterval(progTimer);
  page.hidden=true;document.body.classList.remove("vb-open");hint.hidden=true;
  frame.onload=null;frame.src="about:blank";setProg(0,true);loadEl.classList.remove("done");spin(false);
}
function external(){if(curUrl)window.open(curUrl,"_blank","noopener,noreferrer")}
$("vbClose").addEventListener("click",close);
reloadBtn.addEventListener("click",()=>{if(curUrl)load(curUrl)});
$("vbExternal").addEventListener("click",external);
$("vbHintOpen").addEventListener("click",external);
$("vbHintX").addEventListener("click",()=>{hint.hidden=true});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!page.hidden)close()});
window.addEventListener("veltrix-revoked",close);
window.veltrixBuyBrowser={open,openUrl,close};
})();
