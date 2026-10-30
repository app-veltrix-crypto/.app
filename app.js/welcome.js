/* Veltrix · welcome screen: choose "Create new wallet" or "Import existing wallet", then the normal sign-up. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const page=$("welcomePage");if(!page)return;
const opts=$("wlOptions"),pI=$("wlImport");
const ta=$("wlPhrase"),well=$("wlWell"),cnt=$("wlCount"),stat=$("wlStatus"),go=$("wlImportBtn");
let phrase=null,seq=0,timer=0;     /* phrase = a VALID recovery phrase, held in memory only */

function mode(m){
  const imp=m==="import";
  opts.hidden=imp;pI.hidden=!imp;page.classList.toggle("wl-compact",imp);
  if(!imp)reset();else setTimeout(()=>ta.focus({preventScroll:true}),60);
}
/* lower-case, drop numbering / commas / extra spaces and line breaks, so a pasted phrase in any layout works */
const norm=t=>String(t||"").toLowerCase().replace(/[0-9]+[.):]?/g," ").replace(/[^a-z]+/g," ").trim().replace(/\s+/g," ");
function say(t,cls){stat.className=cls==="err"?"status-error":cls==="ok"?"status-success":"";if(typeof t==="string")stat.textContent=t;else{stat.textContent="";stat.appendChild(t)}}
function reset(){phrase=null;seq++;ta.value="";cnt.textContent="0 words";well.className="input-group";say("");go.disabled=true;setBtn(false)}
function setBtn(busy){go.textContent=busy?"Checking wallet…":"Import wallet"}
async function check(){
  const my=++seq,w=norm(ta.value),n=w?w.split(" ").length:0;
  phrase=null;go.disabled=true;setBtn(false);well.className="input-group";
  cnt.textContent=n+(n===1?" word":" words");
  if(!n){say("");return}
  if(n<12){say("Keep going, a recovery phrase has 12 or 24 words.");return}
  if(n!==12&&n!==24){say("A recovery phrase has exactly 12 or 24 words. You entered "+n+".","err");well.classList.add("bad");return}
  const E=window.ethers;
  if(!E||!window.VeltrixAddr||!window.veltrixWallet){say("The wallet tools are still loading. Please wait a moment.");timer=setTimeout(check,900);return}
  let ok=false;try{ok=E.Mnemonic.isValidMnemonic(w)}catch{}
  if(!ok){say("This isn't a valid recovery phrase. Check the spelling and the order of the words.","err");well.classList.add("bad");return}
  say("Looking up your wallet…");setBtn(true);
  try{
    const rows=await veltrixWallet.derive(w);if(my!==seq)return;
    const eth=rows.find(r=>r.symbol==="ETH")||rows[0],a=String(eth.address||"");
    const short=a.length>14?a.slice(0,8)+"…"+a.slice(-6):a;
    const c=document.createElement("span");c.append("Wallet found · "+rows.length+" addresses ready · ");const code=document.createElement("code");code.textContent=(eth.symbol||"")+" "+short;c.appendChild(code);
    say(c,"ok");well.classList.add("ok");phrase=w;go.disabled=false;setBtn(false);
  }catch(e){if(my!==seq)return;say("We couldn't read this wallet. Please check the phrase and try again.","err");well.classList.add("bad");setBtn(false)}
}
ta.addEventListener("input",()=>{clearTimeout(timer);timer=setTimeout(check,260)});
ta.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();if(!go.disabled)go.click()}});
$("wlPaste").addEventListener("click",async()=>{try{const t=await navigator.clipboard.readText();if(t){ta.value=t;check()}else say("Nothing to paste. Copy your phrase first.")}catch{say("Paste isn't allowed here. Long-press the box and choose Paste.");ta.focus()}});
$("wlShowImport").addEventListener("click",()=>mode("import"));$("wlBack").addEventListener("click",()=>mode("create"));

let held=null;   /* the phrase that goes with the sign-up form in front of the person (memory only) */
function toSignup(withImport){
  held=withImport?phrase:null;
  const chip=$("importChip");if(chip)chip.hidden=!held;
  if(window.veltrixWallet)window.veltrixWallet.setImport(held);
  ta.value="";cnt.textContent="0 words";well.className="input-group";say("");go.disabled=true;phrase=null;
  window.showPage("signupPage");
}
$("wlCreateBtn").addEventListener("click",()=>toSignup(false));
go.addEventListener("click",()=>{if(phrase)toSignup(true)});
$("wlLogin").addEventListener("click",()=>{reset();window.showPage("loginPage")});

window.veltrixWelcome={
  show(){mode("create");window.showPage("welcomePage")},
  importPhrase:()=>held,
  clear(){held=null;const chip=$("importChip");if(chip)chip.hidden=true}
};
})();
