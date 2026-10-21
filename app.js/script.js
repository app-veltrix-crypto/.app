const ACCOUNT_KEY="veltrixAccount",SESSION_KEY="veltrixLoggedIn";
const loginPage=document.getElementById("loginPage"),signupPage=document.getElementById("signupPage"),dashboardPage=document.getElementById("dashboardPage");
const signupForm=document.getElementById("signupForm"),loginForm=document.getElementById("loginForm"),profilePicture=document.getElementById("profilePicture"),profilePreview=document.getElementById("profilePreview"),locationInput=document.getElementById("location"),locationButton=document.getElementById("locationButton"),locationStatus=document.getElementById("locationStatus"),locationNotice=document.getElementById("locationNotice"),fingerprintToggle=document.getElementById("fingerprintToggle"),fingerprintStatus=document.getElementById("fingerprintStatus"),fingerprintLoginButton=document.getElementById("fingerprintLoginButton"),signupMessage=document.getElementById("signupMessage"),loginMessage=document.getElementById("loginMessage");

document.addEventListener("DOMContentLoaded",async()=>{try{const account=await veltrixDB.restore();if(account){lockToLogin(account);if(account.fingerprintEnabled&&window.PublicKeyCredential)loginWithFingerprint(true)}else showPage("loginPage")}catch(e){console.error(e);showPage("loginPage")}finally{if(window.__splash)window.__splash.release("boot")}});
function showPage(id){loginPage.classList.add("hidden");signupPage.classList.add("hidden");dashboardPage.classList.add("hidden");document.getElementById(id).classList.remove("hidden");if(id==="signupPage"&&typeof showSignupStep==="function")showSignupStep(1);window.scrollTo({top:0,behavior:"smooth"})}
function getAccount(){return veltrixDB.get()}
function saveAccount(a){veltrixDB.set(a)}
const EYE_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',EYE_OFF_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>';
function togglePassword(id,b){const i=document.getElementById(id),show=i.type==="password";i.type=show?"text":"password";b.innerHTML=show?EYE_OFF_ICON:EYE_ICON;b.setAttribute("aria-label",show?"Hide password":"Show password");b.setAttribute("aria-pressed",show?"true":"false")}

/* =========================================================
   LOCATION DETECTION
   - Location is mandatory until detection has been attempted.
   - If detection fails (denied, unavailable, timeout, unsupported
     browser, insecure page), the error is shown and the user is
     then free to continue without a location.
========================================================= */
let detectedLocation="",locationAttempted=false,locationFailed=false,locationDetecting=false;

function setLocationStatus(msg,type){locationStatus.textContent=msg;locationStatus.className=type?`status-${type}`:""}
function setLocationValue(v){detectedLocation=v;locationInput.textContent=v||"Not detected yet";locationInput.classList.toggle("has-value",!!v)}
function showLocationFailure(reason){
  locationAttempted=true;locationFailed=true;detectedLocation="";
  setLocationValue("");
  setLocationStatus(reason,"error");
  locationNotice.innerHTML=`<strong>We couldn't get your location</strong>${reason} You can still continue to the next step without it, or try again.`;
  locationNotice.classList.remove("hidden");
  locationButton.disabled=false;locationButton.textContent="Try again";locationDetecting=false;
}
function showLocationSuccess(value,msg){
  locationAttempted=true;locationFailed=false;locationDetecting=false;
  setLocationValue(value);setLocationStatus(msg,"success");
  locationNotice.classList.add("hidden");
  locationButton.disabled=false;locationButton.textContent="Detect again";
}

locationButton.addEventListener("click",detectLocation);
function detectLocation(){
  if(locationDetecting)return;
  locationNotice.classList.add("hidden");
  if(!("geolocation" in navigator)){showLocationFailure("Location detection is not supported by this browser.");return}
  if(window.isSecureContext===false){showLocationFailure("Location detection needs a secure (HTTPS) connection, which this page doesn't have.");return}
  locationDetecting=true;locationButton.disabled=true;locationButton.textContent="Detecting...";
  setLocationStatus("Please allow location access in your browser.","");
  try{
    navigator.geolocation.getCurrentPosition(onLocationSuccess,onLocationError,{enableHighAccuracy:false,timeout:15000,maximumAge:300000});
  }catch{
    showLocationFailure("Something went wrong while trying to access your location.");
  }
}
async function onLocationSuccess(p){
  const{latitude,longitude}=p.coords,coords=`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`,{signal:ctrl.signal});
    if(!r.ok)throw new Error("lookup failed");
    const d=await r.json(),a=d.address||{},parts=[a.city||a.town||a.village||a.municipality,a.state,a.country].filter(Boolean);
    if(parts.length)showLocationSuccess(parts.join(", "),"Location detected successfully.");
    else showLocationSuccess(coords,"Coordinates detected successfully.");
  }catch{
    showLocationSuccess(coords,"Coordinates detected successfully.");
  }finally{clearTimeout(timer)}
}
function onLocationError(e){
  const msg=e&&e.code===1?"Location permission was denied by your browser or device."
    :e&&e.code===2?"Your device couldn't determine its position right now."
    :e&&e.code===3?"Location detection timed out."
    :"Something went wrong while detecting your location.";
  showLocationFailure(msg);
}

profilePicture.addEventListener("change",e=>{const f=e.target.files[0];if(!f)return;if(!f.type.startsWith("image/")){showMessage(signupMessage,"Please select an image file.","error");return}const r=new FileReader();r.onload=e=>profilePreview.innerHTML=`<img src="${e.target.result}" alt="Profile preview">`;r.readAsDataURL(f)});

fingerprintToggle.addEventListener("change",handleFingerprintToggle);
async function handleFingerprintToggle(){if(!fingerprintToggle.checked){fingerprintStatus.textContent="Biometric login is disabled.";return}if(!window.PublicKeyCredential){fingerprintToggle.checked=false;fingerprintStatus.textContent="Biometric authentication is not supported by this browser.";return}try{fingerprintStatus.textContent="Setting up biometric authentication...";const challenge=crypto.getRandomValues(new Uint8Array(32)),userId=crypto.getRandomValues(new Uint8Array(16));const c=await navigator.credentials.create({publicKey:{challenge,rp:{name:"Veltrix"},user:{id:userId,name:document.getElementById("signupEmail").value||"user",displayName:document.getElementById("fullName").value||"Veltrix User"},pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required"},timeout:60000,attestation:"none"}});if(c){fingerprintStatus.textContent="Biometric authentication enabled on this device.";fingerprintToggle.dataset.enabled="true"}}catch{fingerprintToggle.checked=false;fingerprintStatus.textContent="Biometric setup was cancelled or unavailable."}}

signupForm.addEventListener("submit",handleSignup);
let signupSubmitting=false;

/* Validates every field on every step. Returns {step,message} for the first problem, or null when all is valid.
   Location is the ONLY optional field. */
function findSignupProblem(){
  const val=id=>document.getElementById(id);
  const fullName=val("fullName").value.trim(),email=val("signupEmail"),password=val("signupPassword").value,confirm=val("confirmPassword").value,dob=val("dateOfBirth").value;
  if(!fullName)return{step:1,message:"Please enter your full name.",field:"fullName"};
  if(!email.value.trim()||!email.checkValidity())return{step:1,message:"Please enter a valid email address.",field:"signupEmail"};
  if(!password)return{step:1,message:"Please create a password.",field:"signupPassword"};
  if(password.length<6)return{step:1,message:"Your password must contain at least 6 characters.",field:"signupPassword"};
  if(!confirm)return{step:1,message:"Please confirm your password.",field:"confirmPassword"};
  if(password!==confirm)return{step:1,message:"The passwords do not match.",field:"confirmPassword"};
  if(locationDetecting)return{step:2,message:"Please wait while we detect your location."};
  if(!detectedLocation&&!locationAttempted)return{step:2,message:"Please tap Detect so we can try to find your location."};
  if(!dob)return{step:2,message:"Please enter your date of birth.",field:"dateOfBirth"};
  const d=new Date(`${dob}T00:00:00`);
  if(Number.isNaN(d.getTime())||d>new Date())return{step:2,message:"Please enter a valid date of birth.",field:"dateOfBirth"};
  const photo=profilePicture.files[0];
  if(!photo)return{step:3,message:"Please choose a profile picture to finish creating your account."};
  if(!photo.type.startsWith("image/"))return{step:3,message:"Your profile picture must be an image file."};
  return null;
}

async function handleSignup(e){
  e.preventDefault();
  if(signupSubmitting)return;
  clearMessage(signupMessage);

  // A submit from any step before the last (e.g. pressing Enter) must never create the account:
  // it only behaves like "Continue" for the current step.
  if(currentSignupStep<3){
    if(validateSignupStep(currentSignupStep))showSignupStep(currentSignupStep+1);
    return;
  }

  // Final gate: re-check every field on every step.
  const problem=findSignupProblem();
  if(problem){
    if(problem.step!==currentSignupStep)showSignupStep(problem.step);
    showMessage(signupMessage,problem.message,"error");
    if(problem.field){const f=document.getElementById(problem.field);if(f)f.focus({preventScroll:true})}
    return;
  }
  
  signupSubmitting=true;createAccountButton.disabled=true;
  try{
    const fullName=document.getElementById("fullName").value.trim(),email=document.getElementById("signupEmail").value.trim().toLowerCase(),password=document.getElementById("signupPassword").value,location=detectedLocation,dateOfBirth=document.getElementById("dateOfBirth").value;
    let profileImage;
    try{profileImage=await convertImageToDataURL(profilePicture.files[0])}
    catch{if(profilePicture.files[0].size>1.5*1024*1024)throw new Error("photo");profileImage=await readFileAsDataURL(profilePicture.files[0])}
    const r=await veltrixDB.signUp({email,password,fullName,location,dateOfBirth,profileImage,fingerprintEnabled:fingerprintToggle.checked&&fingerprintToggle.dataset.enabled==="true"});
    if(r.needsConfirm){showMessage(signupMessage,"Account created. Check your email to confirm it, then sign in.","success");return}
    showMessage(signupMessage,"Your account has been created successfully.","success");
    setTimeout(showDashboard,700);
  }catch(err){
    // Give a useful message for common browser/storage failures instead of hiding
    // every exception behind the same generic account-creation error.
    let message = "Account creation failed. Please refresh the page and try again.";
    const name = err && err.name ? err.name : "";
    const detail = String(err && err.message || "").toLowerCase();

    if (err && err.message === "photo") {
      message = "We couldn't process that photo. Please choose a smaller JPG or PNG image.";
    } else if (
      name === "QuotaExceededError" ||
      name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      /quota|storage.*full/.test(detail)
    ) {
      message = "This browser's site storage is full. Clear this site's stored data, reload the page, and try again.";
    } else if (name === "SecurityError" || /localstorage|storage is disabled|access is denied/.test(detail)) {
      message = "Your browser is blocking site storage. Enable cookies/site data for this page, then reload and try again.";
    } else if (name === "NotSupportedError" || name === "EncodingError" || /canvas|image/.test(detail)) {
      message = "We couldn't process that profile picture. Try a JPG or PNG image.";
    }

    console.error("Veltrix account creation failed:", err);
    showMessage(signupMessage, message, "error");
    signupSubmitting=false;
    createAccountButton.disabled=false;
  }
}
/* Profile photos are resized (max 400px, JPEG) so large phone pictures never exceed the browser's localStorage limit. */
function readFileAsDataURL(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)})}
function convertImageToDataURL(file,max=400){return new Promise((resolve,reject)=>{
  const url=URL.createObjectURL(file),img=new Image();
  img.onload=()=>{try{
    const s=Math.min(1,max/Math.max(img.width,img.height)),w=Math.max(1,Math.round(img.width*s)),h=Math.max(1,Math.round(img.height*s)),c=document.createElement("canvas");
    c.width=w;c.height=h;const x=c.getContext("2d");
    if(!x)throw new Error("Canvas image processing is unavailable");
    x.fillStyle="#fff";x.fillRect(0,0,w,h);x.drawImage(img,0,0,w,h);
    const data=c.toDataURL("image/jpeg",.72);
    URL.revokeObjectURL(url);resolve(data)
  }catch(err){URL.revokeObjectURL(url);reject(err)}};
  img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Unreadable image"))};
  img.src=url})}

loginForm.addEventListener("submit",async e=>{e.preventDefault();clearMessage(loginMessage);const email=document.getElementById("loginEmail").value.trim().toLowerCase(),password=document.getElementById("loginPassword").value;try{await veltrixDB.signIn(email,password);showDashboard()}catch{showMessage(loginMessage,"The email address or password is incorrect.","error")}});

fingerprintLoginButton.addEventListener("click",loginWithFingerprint);
function lockToLogin(a){try{closeProfileScreens()}catch{}document.body.classList.remove("wd-feature-open");showPage("loginPage");document.getElementById("loginEmail").value=a.email||"";document.getElementById("loginPassword").value="";showMessage(loginMessage,a.fingerprintEnabled&&window.PublicKeyCredential?"Welcome back. Use your fingerprint, or your email and password, to continue.":"Welcome back. Enter your password to continue.","success")}
async function loginWithFingerprint(auto){if(auto!==true)clearMessage(loginMessage);const account=getAccount();if(!account)return showMessage(loginMessage,"Sign in with your email and password first.","error");if(!account.fingerprintEnabled)return showMessage(loginMessage,"Fingerprint login has not been enabled for this account.","error");if(!window.PublicKeyCredential)return showMessage(loginMessage,"Biometric authentication is not supported by this browser.","error");try{const challenge=crypto.getRandomValues(new Uint8Array(32));await navigator.credentials.get({publicKey:{challenge,userVerification:"required",timeout:60000}});showDashboard()}catch{if(auto!==true)showMessage(loginMessage,"Biometric authentication was cancelled or could not be completed.","error")}}

function showDashboard(){const a=getAccount();if(!a)return showPage("loginPage");populateDashboard(a);showPage("dashboardPage")}

/* =========================================================
   DASHBOARD (crypto wallet home)
   Account details live in Supabase; the dashboard itself only
   shows the avatar, search, balance, quick actions and the user's
   crypto assets. New accounts have no assets, so the list is empty.
   Asset shape: {symbol, name, amount, price, change}  (change in %)
========================================================= */
let dashboardAssets=[],dashboardUsd=0,balanceHidden=false;
let accountMode="crypto";
window.addEventListener("veltrix-ready",()=>{accountMode=veltrixDB.pref.get("accountMode","crypto")==="usd"?"usd":"crypto"});
function applyAccountModeUI(){
  document.body.classList.toggle("wd-usd-mode",accountMode==="usd");
  const l=document.getElementById("balanceLabel"),t=document.getElementById("assetsTabLabel");
  if(l)l.textContent=accountMode==="usd"?"Dollar Balance":"Total Assets";
  if(t)t.textContent=accountMode==="usd"?"Dollar wallet":"Assets";
}
function setAccountMode(m){
  accountMode=m==="usd"?"usd":"crypto";veltrixDB.pref.set("accountMode",accountMode);
  applyAccountModeUI();renderBalance();renderAssets("");
}
window.setAccountMode=setAccountMode;window.getAccountMode=()=>accountMode;
const fmt=(n,d=2)=>Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
function populateDashboard(a){
  applyAccountModeUI();
  const avatar=document.getElementById("dashboardAvatar");
  avatar.innerHTML=a.profileImage?`<img src="${a.profileImage}" alt="Profile picture">`:`<span>${getInitials(a.fullName)}</span>`;
  dashboardAssets=Array.isArray(a.assets)?a.assets:[];dashboardUsd=Math.max(0,Number(a.usdBalance)||0);
  document.getElementById("assetSearch").value="";
  renderBalance();renderAssets("");
}
function renderBalance(){
  const total=accountMode==="usd"?dashboardUsd:dashboardAssets.reduce((s,x)=>s+x.amount*x.price,0);
  const pnl=dashboardAssets.reduce((s,x)=>{const v=x.amount*x.price;return s+v-v/(1+(x.change||0)/100)},0);
  const pct=total-pnl>0?pnl/(total-pnl)*100:0;
  const pnlEl=document.getElementById("pnlValue");
  {const el=document.getElementById("totalAssets");
  if(balanceHidden)el.textContent="••••••";
  else{const s=String(fmt(total)),i=s.lastIndexOf(".");el.innerHTML=i<0?esc(s):`${esc(s.slice(0,i))}<span class="wd-dec">${esc(s.slice(i))}</span>`}}
  const balanceToggle=document.getElementById("toggleBalance");
  balanceToggle.innerHTML=balanceHidden?EYE_OFF_ICON:EYE_ICON;
  balanceToggle.setAttribute("aria-pressed",String(balanceHidden));
  balanceToggle.setAttribute("aria-label",balanceHidden?"Show balance":"Hide balance");
  pnlEl.textContent=balanceHidden?"••••":`${pnl>=0?"+":"-"}${fmt(Math.abs(pnl))} USD (${fmt(Math.abs(pct),1)}%)`;
  pnlEl.className=pnl<0?"wd-down":pnl>0?"wd-up":"wd-flat";
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function renderAssets(query){
  const list=document.getElementById("assetList"),q=query.trim().toLowerCase();
  if(accountMode==="usd"){list.innerHTML=`<div class="wd-row"><div class="wd-coin">$</div><div class="wd-coin-info"><b>USD<span> Dollar wallet</span></b><small>US Dollar</small></div><div class="wd-coin-value">${fmt(dashboardUsd)}</div></div>`;return}
  if(!dashboardAssets.length){list.innerHTML='<div class="wd-empty"><div class="wd-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M6 8V1h1v6.117L8.743 6.07a.5.5 0 0 1 .514 0L11 7.117V1h1v7a.5.5 0 0 1-.757.429L9 7.083 6.757 8.43A.5.5 0 0 1 6 8"/><path d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2"/><path d="M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z"/></svg></div><strong>No assets yet</strong><p>Crypto you receive will show up here.</p></div>';return}
  const rows=dashboardAssets.filter(x=>!q||x.symbol.toLowerCase().includes(q)||(x.name||"").toLowerCase().includes(q));
  const usdRow="";
  if(!rows.length&&!usdRow){list.innerHTML='<div class="wd-empty"><strong>No results</strong><p>No asset matches your search.</p></div>';return}
  list.innerHTML=usdRow+rows.map(x=>{const up=(x.change||0)>=0;return `<div class="wd-row"><div class="wd-coin">${esc(x.symbol[0])}</div><div class="wd-coin-info"><b>${esc(x.symbol)}<span>/USDT</span></b><small>${fmt(x.amount,4)} ${esc(x.symbol)}</small></div><div class="wd-coin-value">${fmt(x.amount*x.price)}</div><div class="wd-pill ${up?"up":"down"}">${up?"+":"-"}${fmt(Math.abs(x.change||0))}%</div></div>`}).join("");
}
const assetSearchInput=document.getElementById("assetSearch");
const cryptoSearchPanel=document.getElementById("cryptoSearchPanel");
const cryptoMarketList=document.getElementById("cryptoMarketList");
const cryptoSearchStatus=document.getElementById("cryptoSearchStatus");
const cryptoFallback=[
 {id:"bitcoin",symbol:"BTC",name:"Bitcoin",price: null,change:null,color:"#f7931a"},
 {id:"ethereum",symbol:"ETH",name:"Ethereum",price:null,change:null,color:"#627eea"},
 {id:"tether",symbol:"USDT",name:"Tether",price:null,change:null,color:"#26a17b"},
 {id:"binancecoin",symbol:"BNB",name:"BNB",price:null,change:null,color:"#f3ba2f"},
 {id:"solana",symbol:"SOL",name:"Solana",price:null,change:null,color:"#8b5cf6"},
 {id:"ripple",symbol:"XRP",name:"XRP",price:null,change:null,color:"#23292f"},
 {id:"usd-coin",symbol:"USDC",name:"USDC",price:null,change:null,color:"#2775ca"},
 {id:"dogecoin",symbol:"DOGE",name:"Dogecoin",price:null,change:null,color:"#c2a633"},
 {id:"tron",symbol:"TRX",name:"TRON",price:null,change:null,color:"#e5092a"},
 {id:"the-open-network",symbol:"TON",name:"Toncoin",price:null,change:null,color:"#0098ea"},
 {id:"cardano",symbol:"ADA",name:"Cardano",price:null,change:null,color:"#3468d1"},
 {id:"avalanche-2",symbol:"AVAX",name:"Avalanche",price:null,change:null,color:"#e84142"},
 {id:"shiba-inu",symbol:"SHIB",name:"Shiba Inu",price:null,change:null,color:"#f08b2d"},
 {id:"chainlink",symbol:"LINK",name:"Chainlink",price:null,change:null,color:"#2a5ada"},
 {id:"stellar",symbol:"XLM",name:"Stellar",price:null,change:null,color:"#111827"},
 {id:"bitcoin-cash",symbol:"BCH",name:"Bitcoin Cash",price:null,change:null,color:"#8dc351"},
 {id:"sui",symbol:"SUI",name:"Sui",price:null,change:null,color:"#4da9e8"},
 {id:"hedera-hashgraph",symbol:"HBAR",name:"Hedera",price:null,change:null,color:"#242424"},
 {id:"litecoin",symbol:"LTC",name:"Litecoin",price:null,change:null,color:"#345d9d"},
 {id:"polkadot",symbol:"DOT",name:"Polkadot",price:null,change:null,color:"#e6007a"}
];
let cryptoMarkets=cryptoFallback.map(c=>({...c}));
function formatMarketPrice(n){if(n==null||!Number.isFinite(Number(n)))return "—";const v=Number(n);return "$"+v.toLocaleString("en-US",{minimumFractionDigits:v>=1?2:4,maximumFractionDigits:v>=1?2:6})}
function coinLogoHTML(c){const sym=String(c.symbol||"?").toUpperCase();const icon=`https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/${esc(sym.toLowerCase())}.svg`;return `<img src="${esc(c.image||icon)}" alt="" loading="lazy" data-fallback="${icon}" data-letter="${esc(sym.slice(0,1))}" onerror="coinLogoError(this)">`}
function coinLogoError(img){if(img.dataset.fallback&&img.src!==img.dataset.fallback&&!img.dataset.tried){img.dataset.tried="1";img.src=img.dataset.fallback;return}const s=document.createElement("span");s.textContent=img.dataset.letter||"?";img.replaceWith(s)}
function renderCryptoLoading(){
 cryptoMarketList.innerHTML=Array.from({length:7},()=>'<div class="wd-market-loading" aria-hidden="true"><span class="wd-market-skeleton coin"></span><span class="wd-market-skeleton lines"></span><span class="wd-market-skeleton price"></span></div>').join("");
}
function renderCryptoMarkets(query=""){
 const q=query.trim().toLowerCase();
 const rows=cryptoMarkets.filter(c=>c.name.toLowerCase().includes(q)||c.symbol.toLowerCase().includes(q));
 if(!rows.length){cryptoMarketList.innerHTML='<div class="wd-market-empty">No cryptocurrencies match your search.</div>';return}
 cryptoMarketList.innerHTML=rows.map(c=>{const up=Number(c.change)>=0;const change=c.change==null?"—":`${up?"+":""}${Number(c.change).toFixed(2)}%`;return `<button type="button" class="wd-market-row" role="listitem" data-market-symbol="${esc(c.symbol)}"><span class="wd-market-coin" style="--coin-color:${esc(c.color||"#333")}">${coinLogoHTML(c)}</span><span class="wd-market-name"><b>${esc(c.name)}</b><small>${esc(c.symbol)}</small></span><span class="wd-market-values"><b>${formatMarketPrice(c.price)}</b><small class="${c.change==null?"neutral":up?"up":"down"}">${change}</small></span></button>`}).join("");
}
// Always show the Explore crypto panel from its top so the spacing under the header is identical every time it appears.
function resetCryptoPanelScroll(){
 const apply=()=>{try{cryptoSearchPanel.scrollTop=0;window.scrollTo({top:0,left:0,behavior:"instant"})}catch(_){cryptoSearchPanel.scrollTop=0;window.scrollTo(0,0)}};
 apply();requestAnimationFrame(()=>{apply();requestAnimationFrame(apply)});
}
function openCryptoSearch(){
 if(!cryptoSearchPanel)return;
 document.getElementById("dashboardPage").classList.add("searching-crypto");
 cryptoSearchPanel.hidden=false;
 resetCryptoPanelScroll();
 renderCryptoMarkets(assetSearchInput.value);
 assetSearchInput.setAttribute("aria-expanded","true");
 if(!cryptoSearchPanel.dataset.loaded){
  cryptoSearchStatus.textContent="Loading market data…";
  renderCryptoLoading();
  loadCryptoMarkets();
 }
}
function closeCryptoSearch(){
 document.getElementById("dashboardPage").classList.remove("searching-crypto");
 cryptoSearchPanel.hidden=true;assetSearchInput.value="";assetSearchInput.setAttribute("aria-expanded","false");renderAssets("");
}
async function loadCryptoMarkets(){
 cryptoSearchPanel.dataset.loaded="1";
 try{
  const response=await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false",{headers:{accept:"application/json"}});
  if(!response.ok)throw new Error("Market request failed");
  const data=await response.json();
  const colors=Object.fromEntries(cryptoFallback.map(c=>[c.symbol,c.color]));
  if(Array.isArray(data)&&data.length){cryptoMarkets=data.slice(0,20).map(c=>({id:c.id,symbol:String(c.symbol||"").toUpperCase(),name:c.name,price:c.current_price,change:c.price_change_percentage_24h,image:c.image,rank:c.market_cap_rank,cap:c.market_cap,volume:c.total_volume,color:colors[String(c.symbol||"").toUpperCase()]||"#34343a"}));cryptoSearchStatus.textContent="Live prices · USD";renderCryptoMarkets(assetSearchInput.value)}
  else throw new Error("No market data");
 }catch(_){cryptoSearchStatus.textContent="Market prices unavailable";renderCryptoMarkets(assetSearchInput.value)}
}
assetSearchInput.addEventListener("focus",openCryptoSearch);
assetSearchInput.addEventListener("click",openCryptoSearch);
assetSearchInput.addEventListener("input",e=>{if(!cryptoSearchPanel.hidden)renderCryptoMarkets(e.target.value);else renderAssets(e.target.value)});
document.getElementById("closeCryptoSearch").addEventListener("click",closeCryptoSearch);
assetSearchInput.addEventListener("keydown",e=>{if(e.key==="Escape"){closeCryptoSearch();assetSearchInput.blur()}});
cryptoMarketList.addEventListener("click",e=>{const row=e.target.closest("[data-market-symbol]");if(!row)return;openMarketDetail(cryptoMarkets.find(c=>c.symbol===row.dataset.marketSymbol)||cryptoFallback.find(c=>c.symbol===row.dataset.marketSymbol))});

/* Crypto marketplace detail view. Prices and historical series are fetched from CoinGecko;
   the chart converts sampled real price points into visual OHLC candles for this prototype. */
const marketDetailPage=document.getElementById("marketDetailPage");
let activeMarketCoin=null,marketChartRange="1D",marketRefreshTimer=null,marketChartPoints=[];
const marketRangeConfig={"15m":{days:1,windowMs:15*60*1000},"1H":{days:1,windowMs:60*60*1000},"4H":{days:1,windowMs:4*60*60*1000},"1D":{days:1},"1W":{days:7},"1M":{days:30}};
function openMarketDetail(coin){
 if(!coin)return;activeMarketCoin=coin;marketChartRange="1D";
 cryptoSearchPanel.hidden=true;document.getElementById("dashboardPage").classList.remove("searching-crypto");
 marketDetailPage.hidden=false;document.body.classList.add("wd-feature-open");
 const logo=document.getElementById("marketDetailLogo");logo.innerHTML=coinLogoHTML(coin);logo.style.background=coin.color||"#202338";
 document.getElementById("marketDetailSymbol").textContent=coin.symbol;
 document.getElementById("marketDetailName").innerHTML="";
 document.getElementById("marketDetailName").append(document.createTextNode(coin.name+" "));
 const copy=document.createElement("button");copy.type="button";copy.id="copyMarketSymbol";copy.setAttribute("aria-label","Copy cryptocurrency symbol");copy.textContent="▢";document.getElementById("marketDetailName").append(copy);
 document.getElementById("marketDetailBalanceSymbol").textContent=coin.symbol;
 document.getElementById("marketAboutName").textContent=coin.name;
 document.getElementById("marketAboutCopy").hidden=true;
 document.getElementById("marketDetailPrice").textContent=formatMarketPrice(coin.price);
 const change=document.getElementById("marketDetailChange");change.textContent=coin.change==null?"Loading market data…":`${Number(coin.change)>=0?"+":""}${Number(coin.change).toFixed(2)}%`;change.classList.toggle("down",Number(coin.change)<0);
 document.querySelectorAll("[data-market-range]").forEach(b=>b.classList.toggle("active",b.dataset.marketRange===marketChartRange));
 document.getElementById("marketChartLoading").classList.remove("loaded");drawMarketChart([]);
 loadMarketDetailData();if(marketRefreshTimer)clearInterval(marketRefreshTimer);marketRefreshTimer=setInterval(()=>{if(!marketDetailPage.hidden)loadMarketDetailData(true)},30000);
}
async function loadMarketDetailData(quiet=false){
 if(!activeMarketCoin)return;
 const loading=document.getElementById("marketChartLoading");if(!quiet)loading.classList.remove("loaded");
 try{
  const range=marketRangeConfig[marketChartRange]||marketRangeConfig["1D"];
  const res=await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(activeMarketCoin.id)}/market_chart?vs_currency=usd&days=${range.days}`,{headers:{accept:"application/json"}});
  if(!res.ok)throw new Error("Market history unavailable");const data=await res.json();
  const allPoints=Array.isArray(data.prices)?data.prices:[];
  marketChartPoints=allPoints;
  if(range.windowMs && allPoints.length){
   const cutoff=allPoints[allPoints.length-1][0]-range.windowMs;
   const windowPoints=allPoints.filter(point=>point[0]>=cutoff);
   // Use the selected period's actual slice, falling back to the newest points if the API has sparse data.
   marketChartPoints=windowPoints.length>=2?windowPoints:allPoints.slice(-Math.min(allPoints.length,Math.max(2,Math.ceil(range.windowMs/300000))));
  }
  if(marketChartPoints.length){const current=marketChartPoints[marketChartPoints.length-1][1],first=marketChartPoints[0][1],pct=first?((current-first)/first)*100:activeMarketCoin.change;
   document.getElementById("marketDetailPrice").textContent=formatMarketPrice(current);
   const ch=document.getElementById("marketDetailChange");ch.textContent=pct==null?"Market data":`${pct>=0?"+":""}${pct.toFixed(2)}%`;ch.classList.toggle("down",pct<0);
   document.getElementById("marketChartPricePill").textContent=formatMarketPrice(current);drawMarketChart(marketChartPoints);
  }else throw new Error("No chart points");
  loading.classList.add("loaded");
 }catch(_){
  loading.classList.add("loaded");
  if(!marketChartPoints.length){drawMarketChart([]);document.getElementById("marketDetailChange").textContent="Chart data unavailable";}
 }
}
function drawMarketChart(points){
 const canvas=document.getElementById("marketDetailChart"),wrap=canvas.parentElement;if(!canvas||!wrap)return;
 const w=Math.max(280,wrap.clientWidth),h=Math.max(260,wrap.clientHeight),dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+"px";canvas.style.height=h+"px";
 const ctx=canvas.getContext("2d");ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
 const left=12,right=74,top=12,bottom=32,cw=w-left-right,ch=h-top-bottom;
 ctx.strokeStyle="rgba(155,160,180,.25)";ctx.lineWidth=1;ctx.setLineDash([3,4]);
 for(let i=0;i<5;i++){const y=top+ch*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right+8,y);ctx.stroke()}
 for(let i=0;i<5;i++){const x=left+cw*i/4;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,top+ch);ctx.stroke()}ctx.setLineDash([]);
 let values=points.map(p=>Number(p[1])).filter(Number.isFinite);
 if(!values.length){const base=Number(activeMarketCoin?.price)||1;values=Array.from({length:26},(_,i)=>base*(.82+.15*Math.sin(i*.48)+i*.004));}
 const count=Math.min(40,values.length),sample=[];for(let i=0;i<count;i++){const start=Math.floor(i*values.length/count),end=Math.max(start+1,Math.floor((i+1)*values.length/count));const chunk=values.slice(start,end);if(chunk.length)sample.push({open:chunk[0],close:chunk[chunk.length-1],high:Math.max(...chunk),low:Math.min(...chunk)})}
 let min=Math.min(...sample.map(v=>v.low)),max=Math.max(...sample.map(v=>v.high));if(max===min){max+=Math.abs(max*.02)||1;min-=Math.abs(min*.02)||1}const pad=(max-min)*.08;min-=pad;max+=pad;
 const y=v=>top+(max-v)/(max-min)*ch;const step=cw/sample.length,body=Math.max(3,Math.min(12,step*.58));
 sample.forEach((v,i)=>{const x=left+i*step+step/2,up=v.close>=v.open;ctx.strokeStyle=up?"#2db77c":"#e6535b";ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x,y(v.high));ctx.lineTo(x,y(v.low));ctx.stroke();const yy=Math.min(y(v.open),y(v.close)),bh=Math.max(2,Math.abs(y(v.open)-y(v.close)));ctx.fillRect(x-body/2,yy,body,bh)});
 ctx.fillStyle="#8e91a2";ctx.font="11px system-ui, sans-serif";ctx.textAlign="left";for(let i=0;i<5;i++){const val=max-(max-min)*i/4;ctx.fillText(val<.01?val.toFixed(6):val.toFixed(2),w-right+12,top+ch*i/4+4)}
 ctx.strokeStyle="#5445ee";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,y(values[values.length-1]));ctx.lineTo(w-right+5,y(values[values.length-1]));ctx.stroke();
}
document.getElementById("marketDetailBack").addEventListener("click",()=>{marketDetailPage.hidden=true;if(marketRefreshTimer){clearInterval(marketRefreshTimer);marketRefreshTimer=null}document.body.classList.remove("wd-feature-open");document.getElementById("dashboardPage").classList.add("searching-crypto");cryptoSearchPanel.hidden=false;resetCryptoPanelScroll();assetSearchInput.setAttribute("aria-expanded","true")});
document.getElementById("marketDetailPage").addEventListener("click",e=>{const range=e.target.closest("[data-market-range]");if(range){marketChartRange=range.dataset.marketRange;document.querySelectorAll("[data-market-range]").forEach(b=>b.classList.toggle("active",b===range));loadMarketDetailData();return}const action=e.target.closest("[data-market-action]");if(action){wdToast(`${action.dataset.marketAction} will be available when your wallet is connected`);return}});
document.getElementById("marketFavorite").addEventListener("click",e=>{const b=e.currentTarget,on=b.getAttribute("aria-pressed")!=="true";b.setAttribute("aria-pressed",String(on));b.style.color=on?"#f5c65b":"";wdToast(on?"Added to watchlist":"Removed from watchlist")});
document.getElementById("marketDetailPage").addEventListener("click",e=>{if(e.target.closest("#copyMarketSymbol")){navigator.clipboard?.writeText(activeMarketCoin?.symbol||"").then(()=>wdToast("Symbol copied")).catch(()=>wdToast(activeMarketCoin?.symbol||""))}});
document.getElementById("marketAboutToggle").addEventListener("click",()=>{const p=document.getElementById("marketAboutCopy");p.hidden=!p.hidden});
document.getElementById("marketBuyButton").addEventListener("click",()=>wdToast("Buying will be available when trading is connected"));
window.addEventListener("resize",()=>{if(!marketDetailPage.hidden)drawMarketChart(marketChartPoints)});
document.getElementById("toggleBalance").addEventListener("click",()=>{balanceHidden=!balanceHidden;renderBalance()});

// Five-card physical-feeling stack: the front card follows the finger,
// then flies away and joins the back of the stack on a left swipe.
(()=>{
  const stack=document.getElementById("walletCardStack");
  if(!stack)return;
  const dots=document.getElementById("stackDots");
  const cards=()=>Array.from(stack.querySelectorAll("[data-stack-card]"));
  let startX=0,startY=0,dragging=false,activeCard=null,pointerId=null,locked=false,positionIndex=0;

  function paintStack(){
    const items=cards();
    items.forEach((card,index)=>{
      card.style.setProperty("--stack-index",index);
      card.style.zIndex=String(items.length-index);
      card.classList.remove("is-dragging","is-leaving-left","is-leaving-right");
      card.style.transform="";
      card.style.opacity="";
      card.setAttribute("aria-hidden",index===0?"false":"true");
      card.tabIndex=index===0?0:-1;
    });
    dots.innerHTML=items.map((_,i)=>`<span class="wd-stack-dot ${i===positionIndex?"active":""}" aria-hidden="true"></span>`).join("");
    dots.setAttribute("aria-label",`Card ${positionIndex+1} of ${items.length}`);
  }

  function advance(direction=1){
    if(locked)return;
    const items=cards();if(items.length<2)return;
    locked=true;
    const front=items[0];
    if(direction>0){
      front.classList.add("is-leaving-left");
      front.addEventListener("transitionend",function done(e){
        if(e.propertyName!=="transform")return;
        front.removeEventListener("transitionend",done);
        stack.appendChild(front);
        positionIndex=(positionIndex+1)%items.length;
        paintStack();locked=false;
      });
      // Fallback in case transitionend is suppressed by the device/browser.
      setTimeout(()=>{if(locked&&front.parentElement===stack){stack.appendChild(front);positionIndex=(positionIndex+1)%cards().length;paintStack();locked=false}},380);
    }else{
      stack.insertBefore(items[items.length-1],front);
      positionIndex=(positionIndex-1+items.length)%items.length;
      paintStack();
      const newFront=cards()[0];
      newFront.style.transform="translateX(-18px) rotate(-3deg)";
      requestAnimationFrame(()=>requestAnimationFrame(()=>{newFront.style.transform=""}));
      setTimeout(()=>{locked=false},330);
    }
  }

  document.getElementById("stackNext").addEventListener("click",()=>advance(1));
  document.getElementById("stackPrev").addEventListener("click",()=>advance(-1));
  stack.addEventListener("pointerdown",e=>{
    if(locked)return;
    activeCard=cards()[0];if(!activeCard)return;
    startX=e.clientX;startY=e.clientY;pointerId=e.pointerId;dragging=true;
    activeCard.classList.add("is-dragging");
    try{stack.setPointerCapture(e.pointerId)}catch(_){}
  });
  stack.addEventListener("pointermove",e=>{
    if(!dragging||e.pointerId!==pointerId||!activeCard)return;
    const dx=e.clientX-startX,dy=e.clientY-startY;
    // Keep the card under the user's finger while allowing natural vertical page scrolling.
    if(Math.abs(dx)>Math.abs(dy)*.8){
      activeCard.style.transform=`translate(${dx}px, ${Math.max(-12,Math.min(12,dy*.12))}px) rotate(${Math.max(-12,Math.min(12,dx*.045))}deg)`;
    }
  });
  function finishDrag(e){
    if(!dragging||!activeCard||(e&&e.pointerId!==pointerId))return;
    const dx=(e?e.clientX:startX)-startX,dy=(e?e.clientY:startY)-startY;
    dragging=false;
    activeCard.classList.remove("is-dragging");
    activeCard.style.transform="";
    if(Math.abs(dx)>65&&Math.abs(dx)>Math.abs(dy)*1.1)advance(dx<0?1:-1);
    activeCard=null;pointerId=null;
  }
  stack.addEventListener("pointerup",finishDrag);
  stack.addEventListener("pointercancel",()=>{dragging=false;if(activeCard){activeCard.classList.remove("is-dragging");activeCard.style.transform=""}activeCard=null;pointerId=null});
  paintStack();
})();
let toastTimer;
function wdToast(msg){const t=document.getElementById("wdToast");t.textContent=msg;t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),1800)}
document.querySelectorAll("#dashboardPage [data-action]").forEach(b=>b.addEventListener("click",()=>{
 if(b.dataset.action==="Deposit"){openDepositPage();return}
 if(b.dataset.action==="Convert"){openConvertSheet();return}
 if(b.dataset.action==="Send"){openSendSheet();return}
 wdToast(`${b.dataset.action} is coming soon`)
}));
// Deposit flow: 20 popular assets, with clearly labelled prototype-only addresses.
const depositPage=document.getElementById("depositPage");
const depositCoinPicker=document.getElementById("depositCoinPicker");
const depositCoinDetails=document.getElementById("depositCoinDetails");
const depositCoinList=document.getElementById("depositCoinList");
let activeDepositCoin=null,depositAddrs={};
let depositAddrsState="loading";/* loading | ready | error */
let depositLive={};/* live prices for the deposit coins only, keyed by symbol */
async function loadDepositAddrs(){
 try{const r=await veltrixDB.deposits.list();depositAddrs=Object.fromEntries(r.map(x=>[String(x.symbol).toUpperCase(),x]));depositAddrsState="ready"}
 catch(_){if(depositAddrsState!=="ready")depositAddrsState="error"}
 if(!depositPage.hidden&&!depositCoinPicker.hidden){const s=document.getElementById("depositCoinSearch");renderDepositCoins(s?s.value:"")}
}
/* The deposit list = exactly the coins that have an admin-generated address (nothing else is ever shown). */
function depositCoinsList(){
 return Object.keys(depositAddrs).map(sym=>{
  const base=cryptoFallback.find(c=>c.symbol===sym)||{id:sym.toLowerCase(),symbol:sym,name:sym,color:"#34343a"};
  return {...base,...(depositLive[sym]||{}),id:base.id,color:base.color||"#34343a",name:base.name}
 }).sort((a,b)=>cryptoFallback.findIndex(c=>c.symbol===a.symbol)-cryptoFallback.findIndex(c=>c.symbol===b.symbol));
}
function openDepositPage(){
 // Close other full-screen sections first, then explicitly reveal the deposit screen.
 closeCryptoSearch();
 document.querySelectorAll(".wd-feature-page").forEach(p=>{p.hidden=true;p.removeAttribute("aria-hidden")});
 depositPage.hidden=false;
 depositPage.removeAttribute("aria-hidden");
 depositPage.style.display="block";
 depositCoinPicker.hidden=false;depositCoinDetails.hidden=true;
 document.body.classList.add("wd-feature-open");
 const search=document.getElementById("depositCoinSearch");if(search)search.value="";
 depositAddrsState=Object.keys(depositAddrs).length?"ready":"loading";
 renderDepositCoins();
 loadDepositAddrs();
 refreshDepositMarkets();
}
function depositCompact(n){return n==null||!Number.isFinite(Number(n))?null:"$"+new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:2}).format(Number(n))}
function renderDepositCoins(query=""){
 const all=depositCoinsList();
 const q=query.trim().toLowerCase();
 const coins=all.filter(c=>!q||String(c.name||"").toLowerCase().includes(q)||String(c.symbol||"").toLowerCase().includes(q));
 depositCoinList.innerHTML=coins.map(c=>{
  const hasChange=c.change!=null&&Number.isFinite(Number(c.change));const up=Number(c.change)>=0;
  const change=hasChange?`${up?"+":""}${Number(c.change).toFixed(2)}%`:"—";
  const vol=depositCompact(c.volume),cap=depositCompact(c.cap);
  const details=[String(c.symbol||"").toUpperCase(),c.rank?`Rank #${c.rank}`:null,cap?`MCap ${cap}`:null,!cap&&vol?`Vol ${vol}`:null].filter(Boolean).join(" · ");
  return `<button type="button" class="wd-market-row wd-deposit-market-row" role="listitem" data-deposit-id="${esc(c.id)}"><span class="wd-market-coin" style="--coin-color:${esc(c.color||"#333")}">${coinLogoHTML(c)}</span><span class="wd-market-name"><b>${esc(c.name)}</b><small>${esc(details)}</small></span><span class="wd-market-values"><b>${formatMarketPrice(c.price)}</b><small class="${!hasChange?"neutral":up?"up positive":"down negative"}">${change}</small></span></button>`}).join("")||`<div class="wd-deposit-empty">${depositAddrsState==="loading"?"Loading deposit options…":depositAddrsState==="error"?"Couldn't load deposit options. Please try again.":q?"No matching tokens found.":"No deposit options are available yet."}</div>`;
 const count=document.getElementById("depositResultCount");if(count)count.textContent=String(coins.length);
}
// Live prices for the deposit list: fetched when the screen opens, then refreshed every 30s while it is visible.
let depositMarketsBusy=false;
async function refreshDepositMarkets(){
 if(depositMarketsBusy)return;depositMarketsBusy=true;
 try{
  const ids=[...new Set([...cryptoFallback.map(c=>c.id)])].join(",");
  const response=await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids="+encodeURIComponent(ids)+"&order=market_cap_desc&per_page=50&page=1&sparkline=false",{headers:{accept:"application/json"}});
  if(!response.ok)throw new Error("Market request failed");
  const data=await response.json();
  if(Array.isArray(data)&&data.length){
   depositLive={};data.forEach(c=>{depositLive[String(c.symbol||"").toUpperCase()]={price:c.current_price,change:c.price_change_percentage_24h,image:c.image,rank:c.market_cap_rank,cap:c.market_cap,volume:c.total_volume}});
   if(!depositPage.hidden&&!depositCoinPicker.hidden){const s=document.getElementById("depositCoinSearch");renderDepositCoins(s?s.value:"")}
  }
 }catch(_){}finally{depositMarketsBusy=false}
}
setInterval(()=>{if(!depositPage.hidden&&!depositCoinPicker.hidden)refreshDepositMarkets()},30000);
const depositSearch=document.getElementById("depositCoinSearch");
if(depositSearch)depositSearch.addEventListener("input",()=>renderDepositCoins(depositSearch.value));
const clearDepositSearch=document.getElementById("clearDepositSearch");
if(clearDepositSearch)clearDepositSearch.addEventListener("click",()=>{closeFeaturePages();});
const depositPasteButton=document.getElementById("depositPasteButton");
if(depositPasteButton)depositPasteButton.addEventListener("click",async()=>{try{depositSearch.value=await navigator.clipboard.readText();renderDepositCoins(depositSearch.value);depositSearch.focus()}catch(_){wdToast("Clipboard access isn't available")}});
document.querySelectorAll("[data-deposit-tab]").forEach(tab=>tab.addEventListener("click",()=>{document.querySelectorAll("[data-deposit-tab]").forEach(t=>{const active=t===tab;t.classList.toggle("active",active);t.setAttribute("aria-selected",String(active))});if(tab.dataset.depositTab==="dapps"){wdToast("dApps are not available in the receive list yet");document.querySelector('[data-deposit-tab="tokens"]').click()}}));
depositCoinList.addEventListener("click",e=>{
 const row=e.target.closest("[data-deposit-id]");if(!row)return;
 const all=depositCoinsList();
 activeDepositCoin=all.find(c=>c.id===row.dataset.depositId)||all.find(c=>c.symbol===row.dataset.depositId);
 if(!activeDepositCoin)return;
 const symbol=String(activeDepositCoin.symbol||"COIN").toUpperCase();
 document.getElementById("depositCoinName").innerHTML=`<span class="wd-deposit-selected-coin"><span class="wd-deposit-selected-logo" style="--coin-color:${esc(activeDepositCoin.color||"#30354a")}">${coinLogoHTML(activeDepositCoin)}</span><span>${esc(activeDepositCoin.name)}</span></span>`;
 const addrEl=document.getElementById("depositAddress"),netEl=document.getElementById("depositNetwork"),qrTarget=document.getElementById("depositQrImage"),copyBtn=document.getElementById("copyDepositAddress");
 const showAddr=rec=>{qrTarget.replaceChildren();
  if(!rec){addrEl.textContent="Deposit address not available yet";netEl.textContent=`${symbol} deposits are not enabled yet. Please choose another asset.`;copyBtn.disabled=true;qrTarget.textContent="—";return}
  copyBtn.disabled=false;addrEl.textContent=rec.address;netEl.textContent=`Network: ${rec.network}. Only send ${symbol} on this network. Sending anything else, or using another network, can result in permanent loss.`;
  try{VeltrixQR.render(qrTarget,rec.address,{size:240})}catch(e){qrTarget.textContent="QR unavailable. Copy the address below."}};
 showAddr(depositAddrs[symbol]);
 if(!depositAddrs[symbol])loadDepositAddrs().then(()=>{if(String(activeDepositCoin&&activeDepositCoin.symbol).toUpperCase()===symbol)showAddr(depositAddrs[symbol])});
 depositCoinPicker.hidden=true;depositCoinDetails.hidden=false;
 (document.getElementById("depositTitle")||{}).textContent=`Deposit ${symbol}`;
 depositPage.scrollTop=0;
});
document.getElementById("backToDepositCoins").addEventListener("click",()=>{depositCoinDetails.hidden=true;depositCoinPicker.hidden=false;(document.getElementById("depositTitle")||{}).textContent="Deposit crypto"});
depositPage.addEventListener("click",e=>{if(e.target===depositPage && !depositCoinDetails.hidden){depositCoinDetails.hidden=true;depositCoinPicker.hidden=false;(document.getElementById("depositTitle")||{}).textContent="Deposit crypto"}});
document.addEventListener("keydown",e=>{if(e.key==="Escape" && !depositPage.hidden && !depositCoinDetails.hidden){depositCoinDetails.hidden=true;depositCoinPicker.hidden=false;(document.getElementById("depositTitle")||{}).textContent="Deposit crypto"}});
document.getElementById("copyDepositAddress").addEventListener("click",async()=>{
 const value=document.getElementById("depositAddress").textContent;
 try{await navigator.clipboard.writeText(value);wdToast("Address copied")}catch(_){wdToast("Copy isn't available in this browser")}
});
// Notification and QR scanner are full-screen sections within the same page.
const notificationPage=document.getElementById("notificationPage");
const qrScannerPage=document.getElementById("qrScannerPage");
let qrCameraStream=null,qrScanTimer=null,qrDetector=null,qrTorchTrack=null,qrTorchOn=false,qrLightTimer=null,qrBrightnessCanvas=null,qrBrightnessContext=null;
function closeFeaturePages(){
  qrScanning=false;
  notificationPage.hidden=true;qrScannerPage.hidden=true;depositPage.hidden=true;
  if(qrCameraStream){qrCameraStream.getTracks().forEach(track=>track.stop());qrCameraStream=null}
  if(qrLightTimer){clearInterval(qrLightTimer);qrLightTimer=null}
  if(qrTorchTrack&&qrTorchOn){qrTorchTrack.applyConstraints({advanced:[{torch:false}]}).catch(()=>{})}
  qrTorchTrack=null;qrTorchOn=false;qrBrightnessCanvas=null;qrBrightnessContext=null;
  if(qrScanTimer){clearTimeout(qrScanTimer);qrScanTimer=null}
  const video=document.getElementById("qrCameraVideo");video.pause();video.srcObject=null;video.classList.remove("live");
  document.body.classList.remove("wd-feature-open");
}
document.querySelectorAll("[data-close-feature]").forEach(button=>button.addEventListener("click",()=>{const wasScanner=!qrScannerPage.hidden;closeFeaturePages();if(wasScanner)document.getElementById("scanButton").focus({preventScroll:true});else document.getElementById("notifyButton").focus({preventScroll:true})}));
document.getElementById("notifyButton").addEventListener("click",()=>{closeFeaturePages();notificationPage.hidden=false;document.body.classList.add("wd-feature-open")});
// Notification date filter: UI only until notifications are connected to a database.
const notificationFilterButton=document.getElementById("notificationFilterButton");
const notificationFilterSheet=document.getElementById("notificationFilterSheet");
const notificationFilterBackdrop=document.getElementById("notificationFilterBackdrop");
let selectedNotificationRange="all";
function openNotificationFilter(){notificationFilterSheet.hidden=false;notificationFilterBackdrop.hidden=false;notificationFilterButton.setAttribute("aria-expanded","true");document.body.classList.add("wd-filter-open");}
function closeNotificationFilter(){notificationFilterSheet.hidden=true;notificationFilterBackdrop.hidden=true;notificationFilterButton.setAttribute("aria-expanded","false");document.body.classList.remove("wd-filter-open");}
notificationFilterButton.addEventListener("click",openNotificationFilter);
document.getElementById("notificationFilterClose").addEventListener("click",closeNotificationFilter);
notificationFilterBackdrop.addEventListener("click",closeNotificationFilter);
document.querySelectorAll("[data-notification-range]").forEach(option=>option.addEventListener("click",()=>{selectedNotificationRange=option.dataset.notificationRange;document.querySelectorAll("[data-notification-range]").forEach(item=>{const active=item===option;item.classList.toggle("is-selected",active);item.setAttribute("aria-pressed",String(active));});}));
document.getElementById("notificationFilterApply").addEventListener("click",()=>{closeNotificationFilter();/* No notification data is loaded or fabricated yet. */});


let qrScanning=false;
/* Decode a QR from an image file: native BarcodeDetector first, then jsQR (works on iPhone Safari / Firefox too). */
async function decodeQrFromFile(file){
  let bitmap;
  try{bitmap=await createImageBitmap(file)}catch(_){
    bitmap=await new Promise((res,rej)=>{const u=URL.createObjectURL(file),i=new Image();i.onload=()=>{res(i)};i.onerror=rej;i.src=u})}
  const w0=bitmap.width||bitmap.naturalWidth,h0=bitmap.height||bitmap.naturalHeight;
  if("BarcodeDetector" in window){try{const d=new BarcodeDetector({formats:["qr_code"]});const f=await d.detect(bitmap);if(f.length&&f[0].rawValue)return f[0].rawValue}catch(_){}}
  if(!window.jsQR)throw new Error("decoder unavailable");
  for(const max of [1400,800,400]){
    const k=Math.min(1,max/Math.max(w0,h0)),w=Math.max(1,Math.round(w0*k)),h=Math.max(1,Math.round(h0*k));
    const c=document.createElement("canvas");c.width=w;c.height=h;const x=c.getContext("2d",{willReadFrequently:true});
    x.fillStyle="#fff";x.fillRect(0,0,w,h);x.drawImage(bitmap,0,0,w,h);
    const r=window.jsQR(x.getImageData(0,0,w,h).data,w,h,{inversionAttempts:"attemptBoth"});if(r&&r.data)return r.data;
  }
  return "";
}
/* One entry point for BOTH scan sources (camera and image):
   1) account-link QR  -> confirm, then sign this device into that account
   2) crypto address QR -> Send screen (amount first), address pre-filled on the next step */
function parseLinkQr(raw){const m=/^veltrix:\/\/link\?(.+)$/i.exec(String(raw||"").trim());if(!m)return null;const p=new URLSearchParams(m[1]);const e=(p.get("e")||"").trim().toLowerCase(),c=(p.get("c")||"").trim().toUpperCase();return e&&c?{email:e,code:c}:null}
async function handleQrResult(raw){
  const status=document.getElementById("qrScannerStatus");
  const link=parseLinkQr(raw);
  if(link){
    status.textContent="Account link code detected.";
    if(veltrixDB.isLinked&&veltrixDB.isLinked()){status.textContent="This device is already signed in through a link. Sign out first to link another account.";return}
    const ok=window.veltrixDialog?await veltrixDialog({title:"Sign in with this QR code?",msg:"You will be signed out of your own account on this device and signed in to the account that shows this QR code. Only do this for an account you trust.",ok:"Continue",cancel:"Cancel"}):confirm("Sign out of your account and sign in to the account in this QR code?");
    if(!ok){status.textContent="Link cancelled. Point the camera at a QR code.";if(qrCameraStream&&!qrScannerPage.hidden)setTimeout(rescan,1500);return}
    status.textContent="Signing in…";
    try{await veltrixDB.link.login(link.email,link.code);closeFeaturePages();showDashboard();wdToast("Signed in on this device")}
    catch(e){status.textContent=(e&&e.message)||"This QR code is invalid or has expired. Ask for a new one.";if(qrCameraStream&&!qrScannerPage.hidden)setTimeout(rescan,2000)}
    return;
  }
  const coin=window.veltrixDetectCrypto&&veltrixDetectCrypto(raw);
  if(coin){
    status.textContent=`${coin.symbol} address detected.`;
    closeFeaturePages();
    openSendSheet({symbol:coin.symbol,address:coin.address});
    if(coin.evm)wdToast("EVM address detected. ETH is selected, change the token if needed.");
    return;
  }
  status.textContent="This QR code is not a supported wallet address or account link.";
  if(qrCameraStream&&!qrScannerPage.hidden)setTimeout(rescan,1800);
}
let rescan=()=>{};
document.getElementById("scanButton").addEventListener("click",async()=>{
  closeFeaturePages();qrScannerPage.hidden=false;document.body.classList.add("wd-feature-open");
  const status=document.getElementById("qrScannerStatus"),video=document.getElementById("qrCameraVideo");
  status.textContent="Requesting camera access…";qrScannerPage.classList.add("wd-loading");
  if(!navigator.mediaDevices?.getUserMedia){qrScannerPage.classList.remove("wd-loading");status.textContent="Camera access requires a supported browser and a secure HTTPS connection. You can choose a QR image instead.";return}
  try{
    qrCameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
    if(qrScannerPage.hidden){qrCameraStream.getTracks().forEach(track=>track.stop());qrCameraStream=null;return}
    video.srcObject=qrCameraStream;await video.play();video.classList.add("live");qrScannerPage.classList.remove("wd-loading");status.textContent="Camera ready. Hold the QR code inside the frame.";
    // Automatically estimate scene brightness from the live camera and enable the rear torch in low light.
    // Torch and frame access are browser/device dependent; no manual flashlight button is shown.
    const cameraTrack=qrCameraStream.getVideoTracks()[0];const caps=cameraTrack?.getCapabilities?.();
    if(caps?.torch&&video.videoWidth&&video.videoHeight){
      qrTorchTrack=cameraTrack;qrBrightnessCanvas=document.createElement("canvas");qrBrightnessCanvas.width=32;qrBrightnessCanvas.height=24;qrBrightnessContext=qrBrightnessCanvas.getContext("2d",{willReadFrequently:true});
      let darkFrames=0,brightFrames=0,checking=false;
      qrLightTimer=setInterval(async()=>{
        if(checking||qrScannerPage.hidden||!qrCameraStream||video.readyState<2||!qrBrightnessContext)return;
        checking=true;
        try{
          qrBrightnessContext.drawImage(video,0,0,32,24);const pixels=qrBrightnessContext.getImageData(0,0,32,24).data;let total=0;
          for(let i=0;i<pixels.length;i+=4)total+=(pixels[i]*.2126+pixels[i+1]*.7152+pixels[i+2]*.0722);
          const average=total/(pixels.length/4);
          if(average<54){darkFrames++;brightFrames=0}else if(average>86){brightFrames++;darkFrames=0}else{darkFrames=0;brightFrames=0}
          if(darkFrames>=3&&!qrTorchOn){await qrTorchTrack.applyConstraints({advanced:[{torch:true}]});qrTorchOn=true;status.textContent="Low light detected. Flashlight enabled automatically.";darkFrames=0}
          if(brightFrames>=5&&qrTorchOn){await qrTorchTrack.applyConstraints({advanced:[{torch:false}]});qrTorchOn=false;status.textContent="Enough light detected. Flashlight turned off automatically.";brightFrames=0}
        }catch(_){/* Unsupported or denied torch changes are silently ignored. */}finally{checking=false}
      },900);
    }
    qrScanning=true;qrDetector=null;
    if("BarcodeDetector" in window){try{qrDetector=new BarcodeDetector({formats:["qr_code"]})}catch(_){qrDetector=null}}
    const frameCanvas=document.createElement("canvas"),frameCtx=frameCanvas.getContext("2d",{willReadFrequently:true});
    const scanFrame=async()=>{
      if(qrScannerPage.hidden||!qrCameraStream||!qrScanning)return;
      try{
        let raw="";
        if(qrDetector&&video.readyState>=2){const found=await qrDetector.detect(video);if(found.length)raw=found[0].rawValue||""}
        if(!raw&&window.jsQR&&video.readyState>=2&&video.videoWidth){
          const k=Math.min(1,720/video.videoWidth);frameCanvas.width=Math.round(video.videoWidth*k);frameCanvas.height=Math.round(video.videoHeight*k);
          frameCtx.drawImage(video,0,0,frameCanvas.width,frameCanvas.height);
          const img=frameCtx.getImageData(0,0,frameCanvas.width,frameCanvas.height);const r=window.jsQR(img.data,img.width,img.height,{inversionAttempts:"attemptBoth"});if(r)raw=r.data||"";
        }
        if(raw){qrScanning=false;handleQrResult(raw);return}
      }catch(_){}
      qrScanTimer=setTimeout(scanFrame,qrDetector?300:200);
    };
    rescan=()=>{if(qrScannerPage.hidden||!qrCameraStream)return;qrScanning=true;scanFrame()};
    if(!qrDetector&&!window.jsQR)status.textContent="Camera ready. QR auto-detection could not load. Check your connection or choose a QR image instead.";
    scanFrame();
  }catch(error){qrScannerPage.classList.remove("wd-loading");status.textContent=error?.name==="NotAllowedError"?"Camera permission was denied. Allow camera access or choose a QR image instead.":"Unable to start the camera. Use HTTPS and check camera permissions, or choose a QR image instead."}
});
document.getElementById("qrUploadButton").addEventListener("click",()=>document.getElementById("qrImageInput").click());
document.getElementById("qrImageInput").addEventListener("change",async event=>{
  const file=event.target.files?.[0];event.target.value="";if(!file)return;
  const status=document.getElementById("qrScannerStatus");status.textContent="Reading QR image…";
  try{const raw=await decodeQrFromFile(file);if(raw)handleQrResult(raw);else status.textContent="No QR code found in that image. Try a clearer or cropped image."}
  catch(_){status.textContent="Could not read that image. Please try another QR image."}
});
// Prevent page zoom gestures where the browser allows page-level control.
(function disablePageZoom(){
 const viewport=document.querySelector('meta[name="viewport"]');if(viewport)viewport.setAttribute("content","width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover");
 document.addEventListener("gesturestart",e=>e.preventDefault(),{passive:false});document.addEventListener("gesturechange",e=>e.preventDefault(),{passive:false});document.addEventListener("gestureend",e=>e.preventDefault(),{passive:false});
 document.addEventListener("wheel",e=>{if(e.ctrlKey)e.preventDefault()},{passive:false});
 document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&["+","-","=","0"].includes(e.key))e.preventDefault()});
 let lastTouchEnd=0;document.addEventListener("touchend",e=>{const now=Date.now();if(now-lastTouchEnd<=300)e.preventDefault();lastTouchEnd=now},{passive:false});
})();
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&(!notificationPage.hidden||!qrScannerPage.hidden))closeFeaturePages()});
const accountMenu=document.getElementById("accountMenu"),avatarBtn=document.getElementById("dashboardAvatar");
const settingsPage=document.getElementById("profileSettingsPage"),detailsPage=document.getElementById("profileDetailsPage");
function makeUsername(a){return (a.profileUsername||a.username||String(a.fullName||"user").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,".").replace(/^\.|\.$/g,"")||"user")}
function updateProfileScreens(){const a=getAccount()||{},name=a.fullName||"Your name",username=makeUsername(a),image=a.profileImage||"";document.getElementById("settingsDisplayName").textContent=name;document.getElementById("settingsUsername").textContent="@"+username;document.getElementById("settingsAvatarInitials").textContent=getInitials(name)||"U";document.getElementById("profileDetailsAvatarInitials").textContent=getInitials(name)||"U";for(const id of ["settingsAvatarImage","profileDetailsAvatarImage"]){const img=document.getElementById(id),btn=img.closest(".profile-ui-avatar-button");if(image){img.src=image;btn.classList.add("has-image")}else{img.removeAttribute("src");btn.classList.remove("has-image")}}document.getElementById("profileFieldName").textContent=name;document.getElementById("profileFieldAbout").textContent=a.profileAbout||"Add a short bio";document.getElementById("profileFieldUsername").textContent=username;document.getElementById("profileFieldPhone").textContent=a.profilePhone||"Add phone number";document.getElementById("profileFieldLinks").textContent=a.profileLinks||"Add links"}
function openProfileSettings(){accountMenu.classList.add("hidden");avatarBtn.setAttribute("aria-expanded","false");updateProfileScreens();settingsPage.hidden=false;detailsPage.hidden=true;document.querySelector(".wd-screen").style.visibility="hidden";window.scrollTo(0,0)}
function openProfileDetails(){updateProfileScreens();settingsPage.hidden=true;detailsPage.hidden=false;window.scrollTo(0,0)}
function closeProfileScreens(){settingsPage.hidden=true;detailsPage.hidden=true;document.querySelector(".wd-screen").style.visibility="";window.scrollTo(0,0)}
avatarBtn.addEventListener("click",e=>{e.stopPropagation();openProfileSettings()});
document.getElementById("openSettingsMenu").addEventListener("click",openProfileSettings);
document.getElementById("settingsBack").addEventListener("click",closeProfileScreens);
document.getElementById("settingsAvatarButton").addEventListener("click",openProfileDetails);
document.getElementById("editProfileShortcut").addEventListener("click",openProfileDetails);
document.getElementById("profileDetailsBack").addEventListener("click",()=>{detailsPage.hidden=true;settingsPage.hidden=false;updateProfileScreens()});
async function doLogout(){closeProfileScreens();const a=getAccount();if(a&&a.fingerprintEnabled&&window.PublicKeyCredential&&!(veltrixDB.isLinked&&veltrixDB.isLinked())){lockToLogin(a);return}await veltrixDB.signOut();showPage("loginPage");if(a)document.getElementById("loginEmail").value=a.email||""}
document.getElementById("settingsLogout").addEventListener("click",doLogout);
document.addEventListener("click",()=>{accountMenu.classList.add("hidden");avatarBtn.setAttribute("aria-expanded","false")});
const editDialog=document.getElementById("profileEditDialog"),editInput=document.getElementById("profileEditInput"),editLabel=document.getElementById("profileEditLabel");let activeProfileField="name";
const editMeta={name:{label:"Name",key:"fullName",placeholder:"Your name"},about:{label:"About",key:"profileAbout",placeholder:"Add a short bio"},username:{label:"Username",key:"profileUsername",placeholder:"your.username"},phone:{label:"Phone",key:"profilePhone",placeholder:"Phone number"},links:{label:"Links",key:"profileLinks",placeholder:"https://example.com"}};
document.querySelectorAll("[data-edit-field]").forEach(btn=>btn.addEventListener("click",()=>{activeProfileField=btn.dataset.editField;const m=editMeta[activeProfileField],a=getAccount()||{};editLabel.textContent=m.label;document.getElementById("profileEditTitle").textContent="Edit "+m.label.toLowerCase();editInput.value=a[m.key]||(activeProfileField==="username"?makeUsername(a):"");editInput.placeholder=m.placeholder;editDialog.hidden=false;setTimeout(()=>editInput.focus(),40)}));
document.getElementById("profileEditCancel").addEventListener("click",()=>editDialog.hidden=true);
document.getElementById("profileEditSave").addEventListener("click",()=>{const a=getAccount();if(!a)return;const m=editMeta[activeProfileField],value=editInput.value.trim();if(activeProfileField==="name"&&!value){editInput.focus();return}a[m.key]=value;saveAccount(a);editDialog.hidden=true;updateProfileScreens();populateDashboard(a)});
editDialog.addEventListener("click",e=>{if(e.target===editDialog)editDialog.hidden=true});
function chooseProfilePhoto(){document.getElementById("profileDetailsPhotoInput").click()}
document.getElementById("editProfileAvatarButton").addEventListener("click",chooseProfilePhoto);
document.getElementById("profileDetailsPhotoInput").addEventListener("change",async e=>{const file=e.target.files?.[0];if(!file)return;if(!file.type.startsWith("image/"))return;try{const image=await convertImageToDataURL(file);const a=getAccount();if(!a)return;a.profileImage=image;saveAccount(a);updateProfileScreens();populateDashboard(a)}catch{const reader=new FileReader();reader.onload=()=>{const a=getAccount();if(a){a.profileImage=reader.result;saveAccount(a);updateProfileScreens();populateDashboard(a)}};reader.readAsDataURL(file)}e.target.value=""});
document.getElementById("profileSettingsPage").addEventListener("keydown",e=>{if(e.key==="Escape")closeProfileScreens()});
document.getElementById("profileDetailsPage").addEventListener("keydown",e=>{if(e.key==="Escape"){detailsPage.hidden=true;settingsPage.hidden=false}});
function formatDate(s){if(!s)return"Not provided";const d=new Date(`${s}T00:00:00`);return Number.isNaN(d.getTime())?s:d.toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"})}
function formatDateTime(s){const d=new Date(s);return Number.isNaN(d.getTime())?"Not available":d.toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"})}
function getInitials(n){return n.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join("")}
document.getElementById("logoutButton").addEventListener("click",doLogout);
function showMessage(el,msg,type){el.textContent=msg;el.className=`message ${type}`}
function clearMessage(el){el.textContent="";el.className="message"}
(()=>{const d=document.getElementById("dateOfBirth"),t=new Date(),m=String(t.getMonth()+1).padStart(2,"0"),day=String(t.getDate()).padStart(2,"0");d.max=`${t.getFullYear()}-${m}-${day}`})();


/* =========================================================
   SIGN-UP STEP WIZARD
========================================================= */

const signupSteps = [...document.querySelectorAll(".signup-step")];
const progressItems = [...document.querySelectorAll(".progress-item")];
const nextStepButton = document.getElementById("nextStepButton");
const backStepButton = document.getElementById("backStepButton");
const createAccountButton = document.getElementById("createAccountButton");

let currentSignupStep = 1;

function showSignupStep(step) {
    currentSignupStep = step;

    signupSteps.forEach(section => {
        const sectionStep = Number(section.dataset.step);
        section.classList.toggle("hidden-step", sectionStep !== step);
        section.classList.toggle("active-step", sectionStep === step);
    });

    progressItems.forEach(item => {
        const itemStep = Number(item.dataset.step);
        item.classList.toggle("active", itemStep === step);
        item.classList.toggle("completed", itemStep < step);
    });

    backStepButton.classList.toggle("hidden-step", step === 1);
    nextStepButton.classList.toggle("hidden-step", step === 3);
    createAccountButton.classList.toggle("hidden-step", step !== 3);
    createAccountButton.disabled = step !== 3 || signupSubmitting;

    window.scrollTo({ top: 0, behavior: "smooth" });

    if (step === 2 && !locationAttempted && !locationDetecting) detectLocation();
}

function validateSignupStep(step) {
    const section = signupSteps.find(s => Number(s.dataset.step) === step);
    if (!section) return false;

    const fields = [...section.querySelectorAll("input[required]")];

    for (const field of fields) {
        if (!field.checkValidity()) {
            field.reportValidity();
            return false;
        }
    }

    if (step === 1) {
        const password = document.getElementById("signupPassword").value;
        const confirm = document.getElementById("confirmPassword").value;

        if (password.length < 6) {
            showMessage(signupMessage, "Your password must contain at least 6 characters.", "error");
            return false;
        }

        if (password !== confirm) {
            showMessage(signupMessage, "The passwords do not match.", "error");
            return false;
        }
    }

    if (step === 2 && !detectedLocation) {
        if (locationDetecting) {
            showMessage(signupMessage, "Please wait while we detect your location.", "error");
            return false;
        }
        if (!locationAttempted) {
            showMessage(signupMessage, "Please tap Detect so we can try to find your location.", "error");
            return false;
        }
        // Detection was attempted and failed: the user may continue without it.
    }

    if (step === 3) {
        const problem = findSignupProblem();
        if (problem && problem.step === 3) {
            showMessage(signupMessage, problem.message, "error");
            return false;
        }
    }

    clearMessage(signupMessage);
    return true;
}

nextStepButton.addEventListener("click", () => {
    if (validateSignupStep(currentSignupStep) && currentSignupStep < 3) {
        showSignupStep(currentSignupStep + 1);
    }
});

backStepButton.addEventListener("click", () => {
    if (currentSignupStep > 1) {
        showSignupStep(currentSignupStep - 1);
    }
});

showSignupStep(1);

/* Centered currency picker for the dashboard balance. */
(()=>{
 const trigger=document.getElementById('currencySelector'),overlay=document.getElementById('currencyOverlay');
 if(!trigger||!overlay)return;
 const list=document.getElementById('currencyList'),search=document.getElementById('currencySearch'),close=document.getElementById('closeCurrencyModal'),codeLabel=document.getElementById('selectedCurrencyCode');
 let selected='USD';
 codeLabel.textContent=selected;
 const fallback=['AED','ARS','AUD','BDT','BRL','CAD','CHF','CLP','CNY','COP','CZK','DKK','EGP','EUR','GBP','GHS','HKD','HUF','IDR','ILS','INR','JPY','KES','KRW','MAD','MXN','MYR','NGN','NOK','NZD','PEN','PHP','PKR','PLN','QAR','RON','RUB','SAR','SEK','SGD','THB','TRY','TWD','TZS','UAH','UGX','USD','VND','ZAR'];
 let codes=[];try{codes=typeof Intl.supportedValuesOf==='function'?Intl.supportedValuesOf('currency'):fallback}catch{codes=fallback}
 codes=[...new Set([...codes,...fallback])].sort();
 const names=new Intl.DisplayNames(['en'],{type:'currency'});
 const regions={USD:'United States',EUR:'Eurozone',GBP:'United Kingdom',NGN:'Nigeria',CAD:'Canada',AUD:'Australia',JPY:'Japan',CNY:'China',INR:'India',GHS:'Ghana',KES:'Kenya',ZAR:'South Africa',CHF:'Switzerland',NZD:'New Zealand',SGD:'Singapore',AED:'United Arab Emirates',SAR:'Saudi Arabia',BRL:'Brazil',MXN:'Mexico',EGP:'Egypt',PKR:'Pakistan',BDT:'Bangladesh',IDR:'Indonesia',KRW:'South Korea',TRY:'Türkiye',XOF:'West African CFA zone',XAF:'Central African CFA zone',XCD:'Eastern Caribbean'};
 const flags={USD:'🇺🇸',EUR:'🇪🇺',GBP:'🇬🇧',NGN:'🇳🇬',CAD:'🇨🇦',AUD:'🇦🇺',JPY:'🇯🇵',CNY:'🇨🇳',INR:'🇮🇳',GHS:'🇬🇭',KES:'🇰🇪',ZAR:'🇿🇦',CHF:'🇨🇭',NZD:'🇳🇿',SGD:'🇸🇬',AED:'🇦🇪',SAR:'🇸🇦',BRL:'🇧🇷',MXN:'🇲🇽',EGP:'🇪🇬',PKR:'🇵🇰',BDT:'🇧🇩',IDR:'🇮🇩',KRW:'🇰🇷',TRY:'🇹🇷'};
 function render(){
  const usd=window.getAccountMode&&getAccountMode()==='usd';
  list.innerHTML='';const b=document.createElement('button');b.type='button';b.className='wd-currency-option';b.setAttribute('role','option');
  const logo=usd?'<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 13v1.25c0 .138.112.25.25.25h1a.25.25 0 0 0 .25-.25V13h.5v1.25c0 .138.112.25.25.25h1a.25.25 0 0 0 .25-.25V13h.084c1.992 0 3.416-1.033 3.416-2.82 0-1.502-1.007-2.323-2.186-2.44v-.088c.97-.242 1.683-.974 1.683-2.19C11.997 3.93 10.847 3 9.092 3H9V1.75a.25.25 0 0 0-.25-.25h-1a.25.25 0 0 0-.25.25V3h-.573V1.75a.25.25 0 0 0-.25-.25H5.75a.25.25 0 0 0-.25.25V3l-1.998.011a.25.25 0 0 0-.25.25v.989c0 .137.11.25.248.25l.755-.005a.75.75 0 0 1 .745.75v5.505a.75.75 0 0 1-.75.75l-.748.011a.25.25 0 0 0-.25.25v1c0 .138.112.25.25.25zm1.427-8.513h1.719c.906 0 1.438.498 1.438 1.312 0 .871-.575 1.362-1.877 1.362h-1.28zm0 4.051h1.84c1.137 0 1.756.58 1.756 1.524 0 .953-.626 1.45-2.158 1.45H6.927z"/></svg>':'<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1zm7 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4"/><path d="M0 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1zm3 0a2 2 0 0 1-2 2v4a2 2 0 0 1 2 2h10a2 2 0 0 1 2-2V7a2 2 0 0 1-2-2z"/></svg>';
  b.innerHTML='<span class="wd-currency-flag" style="flex:none;width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#3a4170,#20243a);color:#fff;font-size:24px;font-weight:800;line-height:1;display:grid;place-items:center;box-shadow:0 4px 12px rgba(32,36,58,.25)">'+logo+'</span><span class="wd-currency-info"><strong>'+(usd?'Switch to crypto account':'Switch to dollar account')+'</strong><small>'+(usd?'Crypto wallet':'USD wallet')+'</small></span><span class="wd-currency-code">'+(usd?'CRYPTO':'USD')+'</span>';
  b.addEventListener('click',()=>{const next=usd?'crypto':'usd';closeModal();setAccountMode(next);setTimeout(()=>wdToast(next==='usd'?'Switched to your dollar account':'Switched to your crypto account'),150)});
  list.appendChild(b);
 }
 function openModal(){
  overlay.hidden=false;overlay.style.display='flex';overlay.setAttribute('aria-hidden','false');
  trigger.setAttribute('aria-expanded','true');document.body.classList.add('wd-currency-open');
  search.value='';render();setTimeout(()=>search.focus({preventScroll:true}),40)
 }
 function closeModal(){overlay.hidden=true;overlay.style.display='none';overlay.setAttribute('aria-hidden','true');trigger.setAttribute('aria-expanded','false');document.body.classList.remove('wd-currency-open');trigger.focus({preventScroll:true})}
 window.openVeltrixCurrencyModal=openModal;window.closeVeltrixCurrencyModal=closeModal;
 trigger.addEventListener('click',openModal);close.addEventListener('click',closeModal);search.addEventListener('input',()=>render(search.value));overlay.addEventListener('click',e=>{if(e.target===overlay)closeModal()});document.addEventListener('keydown',e=>{if(!overlay.hidden&&e.key==='Escape')closeModal()});
})();


/* Resilient entry points for the two controls reported as unresponsive. */
document.addEventListener("click",function(event){
 const depositButton=event.target.closest('#dashboardPage [data-action="Deposit"]');
 if(depositButton){event.preventDefault();openDepositPage();return}

});

/* ===== Convert bottom sheet: sell crypto for cash in the user's preferred currency (live rates) ===== */
(function(){
 const FEE=0.0011,POLL_MS=15000;
 const FX_FALLBACK={USD:1,EUR:.92,GBP:.79,NGN:1500,CAD:1.37,AUD:1.52,JPY:150,CNY:7.2,INR:83,GHS:15,KES:129,ZAR:18.5,CHF:.88,NZD:1.65,SGD:1.35,AED:3.67,SAR:3.75,BRL:5.1,MXN:17.5,EGP:48,PKR:278,BDT:110,IDR:15700,KRW:1350,TRY:32};
 const NAMES={BTC:"Bitcoin",ETH:"Ethereum",USDT:"Tether",BNB:"BNB",SOL:"Solana",XRP:"XRP",USDC:"USDC",DOGE:"Dogecoin",TRX:"TRON",TON:"Toncoin"};
 const IDS={BTC:"bitcoin",ETH:"ethereum",USDT:"tether",BNB:"binancecoin",SOL:"solana",XRP:"ripple",USDC:"usd-coin",DOGE:"dogecoin",TRX:"tron",TON:"the-open-network"};
 try{if(typeof cryptoFallback!=="undefined")cryptoFallback.forEach(c=>{if(c.symbol&&c.id)IDS[String(c.symbol).toUpperCase()]=c.id})}catch{}
 // Shown for now even when not owned; replaced by real assets once the back end is connected.
 const DEMO=[{symbol:"BTC",name:"Bitcoin",price:60000,amount:0.5},{symbol:"ETH",name:"Ethereum",price:3000,amount:5},{symbol:"USDT",name:"Tether",price:1,amount:1000}];
 const $=id=>document.getElementById(id);
 const sheet=$("cvSheet"),backdrop=$("cvBackdrop"),amountEl=$("cvAmount"),slider=$("cvSlider"),slide=$("cvSlide"),knob=$("cvKnob");
 const pick=$("cvPicker"),pickBack=$("cvPickBack"),pickSearch=$("cvPickSearch"),pickList=$("cvPickList");
 let mode="cash",coins=[],sel="",busy=false,cur="USD",fx=1,live={},liveAt=0,timer=null;
 const num=v=>{const n=parseFloat(String(v).replace(/,/g,""));return isFinite(n)&&n>0?n:0};
 const group=raw=>{raw=String(raw).replace(/[^0-9.]/g,"");const d=raw.indexOf(".");let i=d<0?raw:raw.slice(0,d),f=d<0?null:raw.slice(d+1).replace(/\./g,"");i=i.replace(/^0+(?=\d)/,"");i=i.replace(/\B(?=(\d{3})+(?!\d))/g,",");const max=mode==="cash"?2:8;return f===null?i:i+"."+f.slice(0,max)};
 const trim=v=>fmt(v,8).replace(/\.?0+$/,"")||"0";
 const money=v=>{try{return new Intl.NumberFormat(undefined,{style:"currency",currency:cur}).format(v)}catch{return fmt(v)+" "+cur}};
 const symbol=()=>{try{return new Intl.NumberFormat(undefined,{style:"currency",currency:cur,currencyDisplay:"narrowSymbol"}).formatToParts(0).find(x=>x.type==="currency").value}catch{return cur}};
 const from=()=>coins.find(c=>c.symbol===sel);
 const isLive=c=>c&&live[c.symbol]!=null&&Date.now()-liveAt<60000;
 const unitCash=()=>{const f=from();if(!f)return 0;return live[f.symbol]!=null?live[f.symbol]:f.price*fx};
 const coinAmt=()=>{const u=unitCash();if(!from()||!u)return 0;const v=num(amountEl.value);return mode==="cash"?v/u:v};
 const cashVal=()=>coinAmt()*unitCash();
 const prefCurrency=()=>"USD";
 function loadFx(){
  cur=prefCurrency();fx=cur==="USD"?1:(FX_FALLBACK[cur]||1);
  let cache=window.__fxCache||null;
  if(cache&&cache.rates&&cache.rates[cur])fx=cache.rates[cur];
  if(cur==="USD"||(cache&&Date.now()-cache.t<3600e3))return;
  fetch("https://open.er-api.com/v6/latest/USD").then(r=>r.json()).then(d=>{if(d&&d.rates){window.__fxCache={t:Date.now(),rates:d.rates};if(d.rates[cur]){fx=d.rates[cur];update()}}}).catch(()=>{});
 }
 async function fetchLive(){
  const ids=[...new Set(coins.map(c=>c.id||IDS[c.symbol]).filter(Boolean))];if(!ids.length)return;
  const cl=cur.toLowerCase(),vs=cl==="usd"?"usd":cl+",usd";
  try{
   const r=await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=${vs}`,{headers:{accept:"application/json"},cache:"no-store"});
   if(!r.ok)throw new Error("rate");
   const d=await r.json();let got=false;
   coins.forEach(c=>{const o=d[c.id||IDS[c.symbol]];if(!o)return;const p=o[cl]!=null?o[cl]:(o.usd!=null?o.usd*fx:null);if(p!=null){live[c.symbol]=p;got=true}});
   if(got)liveAt=Date.now();
  }catch{}
  if(sheet.classList.contains("open"))update();
 }
 const logoBox=(c,lg)=>`<span class="cv-logo${lg?" lg":""}">${coinLogoHTML(c)}</span>`;
 function buildCoins(){
  const real=(dashboardAssets||[]).filter(a=>a.amount>0).map(a=>({...a,name:a.name||NAMES[a.symbol]||a.symbol}));
  const test=DEMO.filter(d=>!real.some(r=>r.symbol===d.symbol)).map(d=>({...d,test:true}));
  coins=[...real,...test];
  if(!coins.some(c=>c.symbol===sel))sel=coins[0]?coins[0].symbol:"";
 }
 function update(){
  const f=from(),max=f?f.amount:0,ca=coinAmt(),v=num(amountEl.value);
  $("cvFromDisp").innerHTML=f?`${logoBox(f)}<span class="cv-cname">${esc(f.name)} <small>${esc(f.symbol)}</small></span>`:"";
  $("cvCur").textContent=mode==="cash"?symbol():(f?f.symbol:"");
  $("cvCur").style.fontSize=mode==="cash"?(symbol().length>1?"18px":""):"16px";
  $("cvAmount").parentElement.classList.toggle("filled",v>0);
  amountEl.style.width=Math.max(1,(amountEl.value||"0").length)+"ch";
  $("cvSize").textContent=mode==="cash"?`${trim(ca)} ${f?f.symbol:""}`:money(cashVal());
  $("cvAvail").textContent=f?`${f.test?"Test balance":"Available"} ${trim(f.amount)}`:"";
  $("cvTo").textContent="Dollar wallet (USD)";
  $("cvRate").textContent=f?`1 ${f.symbol} ≈ ${money(unitCash())}`:"—";
  const lv=isLive(f);const tag=$("cvLive");tag.textContent=lv?"Live":"Estimated";tag.classList.toggle("on",!!lv);
  const recv=cashVal()*(1-FEE);
  $("cvRecv").textContent=recv>0?money(recv):"—";
  const pct=max>0?Math.min(100,ca/max*100):0;
  slider.value=pct;slider.style.setProperty("--p",pct+"%");
  document.querySelectorAll("#cvPct button").forEach(b=>b.classList.toggle("on",+b.dataset.p===Math.round(pct)));
  const ok=ca>0&&ca<=max+1e-12&&!!f;
  slide.classList.toggle("ready",ok);slide.setAttribute("aria-disabled",String(!ok));
  $("cvSlideTxt").textContent=ca>max+1e-12?"Insufficient balance":"Slide to Convert";
  return ok;
 }
 function setPct(p){
  const f=from();if(!f)return;
  const c=f.amount*p/100;
  amountEl.value=p===0?"":group(mode==="cash"?String(Math.floor(c*unitCash()*100)/100):String(+c.toFixed(8)));
  update();
 }
 function open(){
  resetFlow();loadFx();live={};liveAt=0;buildCoins();amountEl.value="";mode="cash";knob.style.transform="";$("cvSlideTxt").style.opacity=1;update();
  fetchLive();clearInterval(timer);timer=setInterval(fetchLive,POLL_MS);
  backdrop.hidden=false;sheet.setAttribute("aria-hidden","false");
  requestAnimationFrame(()=>requestAnimationFrame(()=>{sheet.classList.add("open");backdrop.classList.add("show")}));
  document.body.style.overflow="hidden";
 }
 function close(){
  resetFlow();closePick();clearInterval(timer);timer=null;
  sheet.classList.remove("open");backdrop.classList.remove("show");sheet.setAttribute("aria-hidden","true");
  document.body.style.overflow="";setTimeout(()=>{if(!sheet.classList.contains("open"))backdrop.hidden=true},450);
 }
 window.openConvertSheet=open;
 // Crypto picker pop-up
 function renderPick(q){
  q=(q||"").trim().toLowerCase();
  const rows=coins.filter(c=>!q||c.name.toLowerCase().includes(q)||c.symbol.toLowerCase().includes(q));
  if(!rows.length){pickList.innerHTML='<div class="cv-pick-empty">No matching crypto found.</div>';return}
  pickList.innerHTML=rows.map(c=>`<button type="button" class="cv-pick-row${c.symbol===sel?" sel":""}" data-s="${esc(c.symbol)}" role="option" aria-selected="${c.symbol===sel}">${logoBox(c,true)}<span class="cv-pick-info"><b>${esc(c.name)}</b><small>${esc(c.symbol)}</small></span><span class="cv-pick-bal">${trim(c.amount)}<small>${c.test?"Test balance":"Available"}</small></span></button>`).join("");
 }
 function openPick(){pickSearch.value="";renderPick("");pickBack.hidden=false;requestAnimationFrame(()=>requestAnimationFrame(()=>{pick.classList.add("open");pickBack.classList.add("show")}))}
 function closePick(){pick.classList.remove("open");pickBack.classList.remove("show");setTimeout(()=>{if(!pick.classList.contains("open"))pickBack.hidden=true},350)}
 $("cvFromBtn").addEventListener("click",openPick);
 $("cvPickClose").addEventListener("click",closePick);pickBack.addEventListener("click",closePick);
 pickSearch.addEventListener("input",()=>renderPick(pickSearch.value));
 pickList.addEventListener("click",e=>{const b=e.target.closest(".cv-pick-row");if(!b)return;sel=b.dataset.s;amountEl.value="";update();closePick()});
 amountEl.addEventListener("input",()=>{const pos=amountEl.selectionStart||0;const n=amountEl.value.slice(0,pos).replace(/[^0-9.]/g,"").length;const v=group(amountEl.value);amountEl.value=v;let k=0,c=0;while(k<v.length&&c<n){if(v[k]!==",")c++;k++}try{amountEl.setSelectionRange(k,k)}catch{}update()});
 slider.addEventListener("input",()=>setPct(+slider.value));
 $("cvPct").addEventListener("click",e=>{const b=e.target.closest("button[data-p]");if(b)setPct(+b.dataset.p)});
 $("cvSizeBtn").addEventListener("click",()=>{const f=from();if(!f)return;const ca=coinAmt();mode=mode==="cash"?"coin":"cash";amountEl.value=ca>0?group(mode==="cash"?String(Math.floor(ca*unitCash()*100)/100):String(+ca.toFixed(8))):"";update()});
 $("cvClose").addEventListener("click",close);backdrop.addEventListener("click",close);
 document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;if(pick.classList.contains("open"))closePick();else if(sheet.classList.contains("open"))close()});
 let drag=false,startX=0,maxX=0;
 knob.addEventListener("pointerdown",e=>{if(busy||!update())return;drag=true;startX=e.clientX;maxX=slide.clientWidth-knob.offsetWidth-8;knob.setPointerCapture(e.pointerId);slide.classList.remove("done")});
 knob.addEventListener("pointermove",e=>{if(!drag)return;const x=Math.max(0,Math.min(maxX,e.clientX-startX));knob.style.transform=`translateX(${x}px)`;$("cvSlideTxt").style.opacity=1-x/maxX});
 const end=()=>{if(!drag)return;drag=false;const m=new DOMMatrix(getComputedStyle(knob).transform).m41;slide.classList.add("done");
  if(m>=maxX*.9){knob.style.transform=`translateX(${maxX}px)`;execute()}else{knob.style.transform="";$("cvSlideTxt").style.opacity=1}};
 knob.addEventListener("pointerup",end);knob.addEventListener("pointercancel",end);
 function finish(msg){setTimeout(()=>{close();(window.veltrixNotify?veltrixNotify("transaction",msg):wdToast(msg));busy=false;knob.style.transform="";$("cvSlideTxt").style.opacity=1},350)}
 function execute(){
  busy=true;
  pending={f:from(),ca:coinAmt(),recv:cashVal()*(1-FEE),rate:unitCash()};   // quote locked at the moment of the slide
  setTimeout(()=>{
   if(!(window.veltrixTwoStep&&veltrixTwoStep.isOn())){showV("cvSetupView");return}
   openAuth();
  },250);
 }
 /* ---- 2FA -> credit dollar wallet -> receipt ---- */
 let pending=null,tries=0,lockUntil=0,lockTimer=0,confRaf=0,lastRef="",lastReceipt="";
 const VIEWS=["cvAuthView","cvSetupView","cvDoneView"];
 const showV=id=>VIEWS.forEach(v=>{$(v).hidden=v!==id});
 const pins=[...document.querySelectorAll("#cvPin input")];
 const pinVal=()=>pins.map(i=>i.value).join("");
 function resetKnob(){busy=false;knob.style.transform="";$("cvSlideTxt").style.opacity=1;slide.classList.remove("done")}
 function resetPin(){pins.forEach(i=>{i.value="";i.classList.remove("filled")});$("cvPin").classList.remove("bad");$("cvPinErr").hidden=true;$("cvProceed").disabled=true}
 function resetFlow(){cancelAnimationFrame(confRaf);clearInterval(lockTimer);showV(null);resetPin();resetKnob();pending=null}
 $("cvSetupBack").addEventListener("click",()=>{showV(null);resetKnob()});
 $("cvSetupLater").addEventListener("click",()=>{showV(null);resetKnob()});
 $("cvSetupGo").addEventListener("click",()=>{close();setTimeout(()=>{if(window.veltrixTwoStep)veltrixTwoStep.setup()},250)});
 function openAuth(){
  const p=pending;$("cvAuthAmt").textContent=`${trim(p.ca)} ${p.f.symbol}`;$("cvAuthTo").textContent=`≈ ${money(p.recv)} · to your dollar wallet`;
  resetPin();showV("cvAuthView");if(Date.now()<lockUntil)startLock();setTimeout(()=>pins[0].focus(),150);
 }
 $("cvAuthBack").addEventListener("click",()=>{resetPin();showV(null);resetKnob()});
 function pinCheck(){if(Date.now()<lockUntil)return;$("cvProceed").disabled=pinVal().length!==4;$("cvPinErr").hidden=true;$("cvPin").classList.remove("bad")}
 pins.forEach((b,i)=>{
  b.addEventListener("input",()=>{b.value=b.value.replace(/\D/g,"").slice(-1);b.classList.toggle("filled",!!b.value);if(b.value&&i<3)pins[i+1].focus();pinCheck()});
  b.addEventListener("keydown",e=>{if(e.key==="Backspace"&&!b.value&&i>0){pins[i-1].value="";pins[i-1].classList.remove("filled");pins[i-1].focus();pinCheck()}if(e.key==="Enter"&&pinVal().length===4)$("cvProceed").click()});
  b.addEventListener("paste",e=>{const t=(e.clipboardData.getData("text")||"").replace(/\D/g,"").slice(0,4);if(!t)return;e.preventDefault();pins.forEach((x,k)=>{x.value=t[k]||"";x.classList.toggle("filled",!!x.value)});pins[Math.min(t.length,3)].focus();pinCheck()});
 });
 function startLock(){
  clearInterval(lockTimer);
  const tick=()=>{const s=Math.ceil((lockUntil-Date.now())/1000);
   if(s<=0){clearInterval(lockTimer);tries=0;$("cvPinErr").hidden=true;pinCheck();return}
   $("cvPinErr").hidden=false;$("cvPinErr").textContent=`Too many attempts. Try again in ${s}s.`;$("cvProceed").disabled=true};
  tick();lockTimer=setInterval(tick,1000);
 }
 $("cvProceed").addEventListener("click",async()=>{
  if(Date.now()<lockUntil)return;const pin=pinVal();if(pin.length!==4)return;
  const btn=$("cvProceed");btn.disabled=true;btn.textContent="Verifying…";
  let ok=false;try{ok=await veltrixTwoStep.verify(pin)}catch{}
  btn.textContent="Proceed";
  if(!ok){
   tries++;const box=$("cvPin");box.classList.add("bad");box.classList.remove("shake");void box.offsetWidth;box.classList.add("shake");
   pins.forEach(i=>{i.value="";i.classList.remove("filled")});
   if(tries>=5){lockUntil=Date.now()+30000;startLock()}
   else{$("cvPinErr").hidden=false;$("cvPinErr").textContent=`Incorrect 2FA code. ${5-tries} ${5-tries===1?"attempt":"attempts"} left.`;btn.disabled=true;pins[0].focus()}
   return;
  }
  tries=0;complete();
 });
 function complete(){
  const p=pending;if(!p)return;const f=p.f;
  const acc=getAccount();if(!acc){wdToast("Something went wrong. Please try again.");resetFlow();return}
  if(!f.test){
   const a=Array.isArray(acc.assets)?acc.assets.find(x=>x.symbol===f.symbol):null;
   if(!a||a.amount<p.ca-1e-12){wdToast("Insufficient balance");resetFlow();return}
   veltrixDB.convert(f.symbol,p.ca,p.recv).then(populateDashboard).catch(()=>{wdToast("Conversion failed. Please try again.");veltrixDB.refreshWallet().then(populateDashboard)});
  }else{
   acc.usdBalance=+((Number(acc.usdBalance)||0)+p.recv).toFixed(2);   // demo "test balance" stays local-only
   populateDashboard(acc);
  }
  const b=new Uint8Array(5);(crypto.getRandomValues?crypto.getRandomValues(b):b.forEach((_,i)=>b[i]=Math.random()*256|0));
  lastRef="CV-"+[...b].map(x=>x.toString(16).padStart(2,"0")).join("").toUpperCase();
  const when=new Date().toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"});
  $("cvLuxAmt").textContent=money(p.recv);$("cvLuxSub").textContent=`from ${trim(p.ca)} ${f.symbol}`;
  $("cvLuxFrom").textContent=`${trim(p.ca)} ${f.symbol}`;$("cvLuxRate").textContent=`1 ${f.symbol} ≈ ${money(p.rate)}`;
  $("cvLuxAcct").textContent="Dollar wallet";$("cvLuxDate").textContent=when;$("cvLuxRef").textContent=lastRef;
  lastReceipt=`Veltrix conversion receipt\nConverted: ${trim(p.ca)} ${f.symbol}\nCredited: ${money(p.recv)} to your dollar wallet\nRate: 1 ${f.symbol} ≈ ${money(p.rate)}\nDate: ${when}\nReference: ${lastRef}`;
  const v=$("cvDoneView");showV("cvDoneView");v.classList.remove("play");void v.offsetWidth;v.classList.add("play");v.scrollTop=0;
  confetti();(window.veltrixNotify?veltrixNotify("transaction",`Converted ${trim(p.ca)} ${f.symbol} to ${money(p.recv)}`):wdToast("Conversion complete"));
 }
 async function copyText(t){try{await navigator.clipboard.writeText(t)}catch{const ta=document.createElement("textarea");ta.value=t;ta.style.cssText="position:fixed;opacity:0";document.body.appendChild(ta);ta.select();try{document.execCommand("copy")}catch{}ta.remove()}wdToast("Copied")}
 $("cvDoneView").addEventListener("click",e=>{if(e.target.closest("[data-copy]"))copyText(lastRef)});
 $("cvShare").addEventListener("click",async()=>{if(navigator.share){try{await navigator.share({title:"Veltrix receipt",text:lastReceipt});return}catch(err){if(err&&err.name==="AbortError")return}}copyText(lastReceipt)});
 $("cvDoneBtn").addEventListener("click",close);
 function confetti(){
  const cv=$("cvConfetti"),ctx=cv.getContext("2d"),r=cv.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  cv.width=r.width*dpr;cv.height=r.height*dpr;ctx.scale(dpr,dpr);
  const P=Array.from({length:42},()=>({x:r.width/2,y:r.height*.34,vx:(Math.random()-.5)*13,vy:-Math.random()*12-3,s:16+Math.random()*16,a:(Math.random()-.5)*.8,va:(Math.random()-.5)*.08}));
  let t=0;cancelAnimationFrame(confRaf);
  (function step(){ctx.clearRect(0,0,r.width,r.height);t++;
   P.forEach(q=>{q.vy+=.3;q.vx*=.99;q.x+=q.vx;q.y+=q.vy;q.a+=q.va;ctx.save();ctx.translate(q.x,q.y);ctx.rotate(q.a);ctx.globalAlpha=Math.max(0,1-t/150);ctx.font=q.s+"px serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("😌",0,0);ctx.restore()});
   if(t<150)confRaf=requestAnimationFrame(step);else ctx.clearRect(0,0,r.width,r.height)})();
 }
})();

/* ===== Send flow: amount -> recipient address (validated per coin) -> success animation ===== */
(function(){
 const $=id=>document.getElementById(id);
 const B58="[1-9A-HJ-NP-Za-km-z]";
 const COINS=[
  {symbol:"BTC",name:"Bitcoin",price:60000,amount:0.5,net:"Bitcoin",re:/^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,ex:"bc1… or 1… / 3…"},
  {symbol:"ETH",name:"Ethereum",price:3000,amount:5,net:"Ethereum (ERC-20)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"USDT",name:"Tether",price:1,amount:1000,net:"Ethereum (ERC-20)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"USDC",name:"USDC",price:1,amount:500,net:"Ethereum (ERC-20)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"BNB",name:"BNB",price:600,amount:3,net:"BNB Smart Chain",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"SOL",name:"Solana",price:150,amount:20,net:"Solana",re:new RegExp("^"+B58+"{32,44}$"),ex:"Base58, 32–44 characters"},
  {symbol:"XRP",name:"XRP",price:0.55,amount:800,net:"XRP Ledger",re:new RegExp("^r"+B58+"{24,34}$"),ex:"r…"},
  {symbol:"DOGE",name:"Dogecoin",price:0.15,amount:5000,net:"Dogecoin",re:new RegExp("^[DA9]"+B58+"{33}$"),ex:"D…"},
  {symbol:"TRX",name:"TRON",price:0.12,amount:3000,net:"TRON (TRC-20)",re:new RegExp("^T"+B58+"{33}$"),ex:"T…"},
  {symbol:"TON",name:"Toncoin",price:6,amount:100,net:"TON",re:/^(EQ|UQ)[A-Za-z0-9_-]{46}$/,ex:"EQ… or UQ…"},
  {symbol:"ADA",name:"Cardano",price:0.45,amount:1000,net:"Cardano",re:/^addr1[a-z0-9]{50,110}$/,ex:"addr1…"},
  {symbol:"AVAX",name:"Avalanche",price:30,amount:50,net:"Avalanche C-Chain",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"SHIB",name:"Shiba Inu",price:0.00002,amount:10000000,net:"Ethereum (ERC-20)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"LINK",name:"Chainlink",price:15,amount:100,net:"Ethereum (ERC-20)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"XLM",name:"Stellar",price:0.11,amount:3000,net:"Stellar",re:/^G[A-Z2-7]{55}$/,ex:"G…"},
  {symbol:"BCH",name:"Bitcoin Cash",price:400,amount:2,net:"Bitcoin Cash",re:/^(bitcoincash:)?[qp][a-z0-9]{41}$/i,ex:"bitcoincash:q… or q…"},
  {symbol:"SUI",name:"Sui",price:1.5,amount:200,net:"Sui",re:/^0x[a-fA-F0-9]{64}$/,ex:"0x… (64 hex characters)"},
  {symbol:"HBAR",name:"Hedera",price:0.07,amount:5000,net:"Hedera (EVM address)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"LTC",name:"Litecoin",price:70,amount:10,net:"Litecoin",re:new RegExp("^(ltc1[a-z0-9]{25,62}|[LM]"+B58+"{26,33})$"),ex:"ltc1… or L… / M…"},
  {symbol:"DOT",name:"Polkadot",price:6,amount:150,net:"Polkadot",re:new RegExp("^1"+B58+"{46,47}$"),ex:"1…"}
 ];
 const sheet=$("sdSheet"),views=["sdAmountView","sdPickView","sdAddrView","sdAuthView","sdSetupView","sdDoneView"];
 let sel="BTC",val="",coins=[],list=COINS,confettiRaf=0,scanAddr="";
 const num=v=>{const n=parseFloat(v);return isFinite(n)&&n>0?n:0};
 const cur=()=>coins.find(c=>c.symbol===sel)||coins[0];
 const trim=v=>(+v).toFixed(8).replace(/\.?0+$/,"")||"0";
 const usd=v=>"$"+v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
 function show(id){views.forEach(v=>{$(v).hidden=v!==id})}
 function build(){
  const owned=(typeof dashboardAssets!=="undefined"&&Array.isArray(dashboardAssets)?dashboardAssets:[]).filter(a=>a.amount>0);
  coins=COINS.map(c=>{const o=owned.find(a=>String(a.symbol).toUpperCase()===c.symbol);return o?{...c,amount:o.amount,price:o.price||c.price,real:true}:{...c,test:true}});
  if(!coins.some(c=>c.symbol===sel))sel=coins[0].symbol;
 }
 function chip(){
  const c=cur();
  $("sdCoinBtn").innerHTML=`<span class="cv-logo">${coinLogoHTML(c)}</span><span>${esc(c.name)}<small>${esc(c.symbol)}</small></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
 }
 function render(){
  const c=cur(),n=num(val),over=n>c.amount+1e-12;
  $("sdAmt").textContent=val||"0";$("sdAmt").classList.toggle("filled",!!val);
  $("sdAmt").style.fontSize=(val.length>9?26:val.length>6?32:42)+"px";
  $("sdUnit").textContent=c.symbol;
  $("sdUsd").textContent="≈ "+usd(n*c.price);
  $("sdBalVal").textContent=`${trim(c.amount)} ${c.symbol}${c.test?" (test balance)":""}`;
  $("sdAmtErr").hidden=!over;$("sdAmtErr").textContent="Insufficient balance";
  $("sdContinue").disabled=!(n>0&&!over);
 }
 function open(opts){
  build();val="";scanAddr="";
  if(opts&&opts.symbol&&coins.some(c=>c.symbol===opts.symbol))sel=opts.symbol;
  if(opts&&opts.address)scanAddr=String(opts.address).trim();
  chip();render();show("sdAmountView");
  sheet.setAttribute("aria-hidden","false");requestAnimationFrame(()=>requestAnimationFrame(()=>sheet.classList.add("open")));
  document.body.style.overflow="hidden";
 }
 function close(){scanAddr="";cancelAnimationFrame(confettiRaf);resetPin();sheet.classList.remove("open");sheet.setAttribute("aria-hidden","true");document.body.style.overflow=""}
 window.openSendSheet=open;
 /* Recognise a scanned crypto QR (plain address or a payment URI such as bitcoin:addr?amount=…) -> {symbol,address,evm} or null */
 const SCHEMES={bitcoin:"BTC",ethereum:"ETH",litecoin:"LTC",dogecoin:"DOGE",tron:"TRX",solana:"SOL",ripple:"XRP",xrp:"XRP",stellar:"XLM",bitcoincash:"BCH",cardano:"ADA",ton:"TON",polkadot:"DOT",sui:"SUI",hedera:"HBAR",bnb:"BNB",avalanche:"AVAX",chainlink:"LINK"};
 const ORDER=["BTC","LTC","BCH","ADA","XLM","SUI","TON","TRX","XRP","DOGE","DOT","ETH","SOL"];
 window.veltrixDetectCrypto=function(raw){
  let t=String(raw||"").trim();if(!t||t.length>300)return null;
  let hint=null;
  const m=/^([a-z][a-z0-9+.-]*):(.*)$/i.exec(t);
  if(m&&SCHEMES[m[1].toLowerCase()]){hint=SCHEMES[m[1].toLowerCase()];t=m[1].toLowerCase()==="bitcoincash"?t:m[2]}
  t=t.replace(/^\/\//,"").split(/[?#@\/]/)[0].trim();
  if(!t)return null;
  const byRe=sym=>{const c=COINS.find(z=>z.symbol===sym);return c&&c.re.test(t)};
  if(hint&&byRe(hint))return{symbol:hint,address:t};
  for(const sym of ORDER)if(byRe(sym))return{symbol:sym,address:t,evm:sym==="ETH"};
  return null;
 };
 $("sdClose").addEventListener("click",close);
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sheet.classList.contains("open"))close()});
 // keypad
 $("sdKeys").addEventListener("click",e=>{
  const b=e.target.closest("button");if(!b)return;const k=b.dataset.k;
  if(k==="del")val=val.slice(0,-1);
  else if(k==="."){if(!val.includes("."))val=val?val+".":"0."}
  else{if(val==="0")val="";const d=val.split(".")[1];if(d!==undefined&&d.length>=8)return;if(val.replace(".","").length>=14)return;val+=k}
  render();
 });
 $("sdBal").addEventListener("click",()=>{val=trim(cur().amount);render()});
 // coin picker
 function renderList(q){
  q=(q||"").trim().toLowerCase();
  const rows=coins.filter(c=>!q||c.name.toLowerCase().includes(q)||c.symbol.toLowerCase().includes(q));
  $("sdList").innerHTML=rows.length?rows.map(c=>`<button type="button" class="sd-row${c.symbol===sel?" sel":""}" data-s="${esc(c.symbol)}" role="option" aria-selected="${c.symbol===sel}"><span class="cv-logo">${coinLogoHTML(c)}</span><span class="i"><b>${esc(c.name)}</b><small>${esc(c.symbol)}</small></span><span class="r">${trim(c.amount)}<small>${c.test?"Test balance":"Available"}</small></span></button>`).join(""):'<div style="padding:30px;text-align:center;font-size:13px;color:var(--wd-muted,#858995)">No matching crypto found.</div>';
 }
 $("sdCoinBtn").addEventListener("click",()=>{$("sdSearch").value="";renderList("");show("sdPickView")});
 $("sdPickBack").addEventListener("click",()=>show("sdAmountView"));
 $("sdSearch").addEventListener("input",e=>renderList(e.target.value));
 $("sdList").addEventListener("click",e=>{const b=e.target.closest(".sd-row");if(!b)return;sel=b.dataset.s;val="";chip();render();show("sdAmountView")});
 // address step
 $("sdContinue").addEventListener("click",()=>{
  const c=cur(),n=num(val);if(!(n>0&&n<=c.amount+1e-12))return;
  $("sdSumAmt").textContent=`${val} ${c.symbol}`;$("sdSumUsd").textContent=`≈ ${usd(n*c.price)} · ${c.name} · ${c.net}`;
  $("sdAddrLabel").textContent=`${c.name} (${c.symbol}) wallet address`;
  $("sdAddr").value=scanAddr;$("sdAddr").placeholder=`Enter ${c.symbol} address (${c.ex})`;checkAddr();show("sdAddrView");
 });
 $("sdAddrBack").addEventListener("click",()=>show("sdAmountView"));
 function checkAddr(){
  const c=cur(),a=$("sdAddr").value.trim(),box=$("sdInputBox"),m=$("sdAddrMsg");
  box.classList.remove("bad","good");m.hidden=true;m.className="sd-msg";
  let ok=false;
  if(a){ok=c.re.test(a);box.classList.add(ok?"good":"bad");m.hidden=false;m.classList.add(ok?"good":"bad");
   m.textContent=ok?`Valid ${c.symbol} address on ${c.net}`:`Invalid ${c.symbol} address. Enter a valid ${c.name} (${c.net}) address.`}
  $("sdSend").disabled=!ok;return ok;
 }
 $("sdAddr").addEventListener("input",checkAddr);
 $("sdPaste").addEventListener("click",async()=>{try{$("sdAddr").value=(await navigator.clipboard.readText()).trim();checkAddr()}catch{$("sdAddr").focus();wdToast("Long-press the field to paste")}});
 /* ---- step 3: 2FA gate ---- */
 const pins=[...document.querySelectorAll("#sdPin input")];
 const pinVal=()=>pins.map(i=>i.value).join("");
 let tries=0,lockUntil=0,lockTimer=0,lastTx="",lastTo="",lastReceipt="";
 function resetPin(){pins.forEach(i=>{i.value="";i.classList.remove("filled")});$("sdPin").classList.remove("bad");$("sdPinErr").hidden=true;if($("sdProceed"))$("sdProceed").disabled=true}
 function pinCheck(){if(Date.now()<lockUntil)return;$("sdProceed").disabled=pinVal().length!==4;$("sdPinErr").hidden=true;$("sdPin").classList.remove("bad")}
 pins.forEach((b,i)=>{
  b.addEventListener("input",()=>{b.value=b.value.replace(/\D/g,"").slice(-1);b.classList.toggle("filled",!!b.value);if(b.value&&i<3)pins[i+1].focus();pinCheck()});
  b.addEventListener("keydown",e=>{if(e.key==="Backspace"&&!b.value&&i>0){pins[i-1].value="";pins[i-1].classList.remove("filled");pins[i-1].focus();pinCheck()}if(e.key==="Enter"&&pinVal().length===4)$("sdProceed").click()});
  b.addEventListener("paste",e=>{const t=(e.clipboardData.getData("text")||"").replace(/\D/g,"").slice(0,4);if(!t)return;e.preventDefault();pins.forEach((x,j)=>{x.value=t[j]||"";x.classList.toggle("filled",!!x.value)});pins[Math.min(t.length,3)].focus();pinCheck()});
 });
 function startLock(){
  clearInterval(lockTimer);
  const tick=()=>{const s=Math.ceil((lockUntil-Date.now())/1000);
   if(s<=0){clearInterval(lockTimer);tries=0;$("sdPinErr").hidden=true;pinCheck();return}
   $("sdPinErr").hidden=false;$("sdPinErr").textContent=`Too many attempts. Try again in ${s}s.`;$("sdProceed").disabled=true};
  tick();lockTimer=setInterval(tick,1000);
 }
 function hasTwoStep(){return !!(window.veltrixTwoStep&&veltrixTwoStep.isOn())}
 function openAuth(){
  const c=cur(),n=num(val),a=$("sdAddr").value.trim();
  $("sdAuthAmt").textContent=`${val} ${c.symbol}`;$("sdAuthTo").textContent=`≈ ${usd(n*c.price)} · to ${shortAddr(a)}`;
  resetPin();show("sdAuthView");if(Date.now()<lockUntil)startLock();setTimeout(()=>pins[0].focus(),150);
 }
 const shortAddr=a=>a.length>22?a.slice(0,10)+"…"+a.slice(-8):a;
 $("sdAuthBack").addEventListener("click",()=>{resetPin();show("sdAddrView")});
 $("sdSetupBack").addEventListener("click",()=>show("sdAddrView"));
 $("sdSetupLater").addEventListener("click",()=>show("sdAddrView"));
 $("sdSetupGo").addEventListener("click",()=>{close();setTimeout(()=>{if(window.veltrixTwoStep)veltrixTwoStep.setup()},250)});
 $("sdSend").addEventListener("click",()=>{
  if(!checkAddr())return;
  if(!hasTwoStep()){show("sdSetupView");return}
  openAuth();
 });
 $("sdProceed").addEventListener("click",async()=>{
  if(Date.now()<lockUntil)return;const pin=pinVal();if(pin.length!==4)return;
  const btn=$("sdProceed");btn.disabled=true;btn.textContent="Verifying…";
  let ok=false;try{ok=await veltrixTwoStep.verify(pin)}catch{}
  btn.textContent="Proceed";
  if(!ok){
   tries++;const box=$("sdPin");box.classList.add("bad");box.classList.remove("shake");void box.offsetWidth;box.classList.add("shake");
   pins.forEach(i=>{i.value="";i.classList.remove("filled")});
   if(tries>=5){lockUntil=Date.now()+30000;startLock()}
   else{$("sdPinErr").hidden=false;$("sdPinErr").textContent=`Incorrect 2FA code. ${5-tries} ${5-tries===1?"attempt":"attempts"} left.`;btn.disabled=true;pins[0].focus()}
   return;
  }
  tries=0;complete();
 });
 /* ---- step 4: execute + luxury receipt ---- */
 const NETNAME=c=>c.net;
 function makeTx(c){const b=new Uint8Array(32);(crypto.getRandomValues?crypto.getRandomValues(b):b.forEach((_,i)=>b[i]=Math.random()*256|0));const hx=[...b].map(x=>x.toString(16).padStart(2,"0")).join("");return /^0x/.test(c.ex)?"0x"+hx:hx}
 function complete(){
  const c=cur(),n=num(val),a=$("sdAddr").value.trim();
  if(c.real){const acc=getAccount();const x=acc&&Array.isArray(acc.assets)?acc.assets.find(z=>String(z.symbol).toUpperCase()===c.symbol):null;
   if(!x||x.amount<n-1e-12){wdToast("Insufficient balance");show("sdAmountView");return}
   x.amount=Math.max(0,+(x.amount-n).toFixed(10));acc.assets=acc.assets.filter(z=>z.amount>0);populateDashboard(acc);veltrixDB.send(c.symbol,n).then(populateDashboard).catch(()=>{wdToast("Send failed. Balance refreshed.");veltrixDB.refreshWallet().then(populateDashboard)})}
  lastTx=makeTx(c);lastTo=a;
  const when=new Date().toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"});
  $("luxAmt").textContent=`${val} ${c.symbol}`;$("luxUsd").textContent=`≈ ${usd(n*c.price)}`;
  $("luxTo").textContent=shortAddr(a);$("luxNet").textContent=NETNAME(c);$("luxDate").textContent=when;$("luxTx").textContent=lastTx.slice(0,10)+"…"+lastTx.slice(-6);
  lastReceipt=`Veltrix transfer receipt\nAmount: ${val} ${c.symbol} (≈ ${usd(n*c.price)})\nTo: ${a}\nNetwork: ${c.net}\nDate: ${when}\nTransaction ID: ${lastTx}`;
  const v=$("sdDoneView");show("sdDoneView");
  v.classList.remove("play");void v.offsetWidth;v.classList.add("play");v.scrollTop=0;
  confetti();if(window.veltrixNotify)veltrixNotify("withdrawal",`Withdrawal sent: ${val} ${c.symbol}`);
 }
 async function copyText(t){try{await navigator.clipboard.writeText(t)}catch{const ta=document.createElement("textarea");ta.value=t;ta.style.cssText="position:fixed;opacity:0";document.body.appendChild(ta);ta.select();try{document.execCommand("copy")}catch{}ta.remove()}wdToast("Copied")}
 $("sdDoneView").addEventListener("click",e=>{const b=e.target.closest("[data-copy]");if(b)copyText(b.dataset.copy==="to"?lastTo:lastTx)});
 $("sdShare").addEventListener("click",async()=>{if(navigator.share){try{await navigator.share({title:"Veltrix receipt",text:lastReceipt});return}catch(err){if(err&&err.name==="AbortError")return}}copyText(lastReceipt)});
 $("sdDone").addEventListener("click",close);
 function confetti(){
  const cv=$("sdConfetti"),ctx=cv.getContext("2d"),r=cv.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  cv.width=r.width*dpr;cv.height=r.height*dpr;ctx.scale(dpr,dpr);
  const P=Array.from({length:42},()=>({x:r.width/2,y:r.height*.34,vx:(Math.random()-.5)*13,vy:-Math.random()*12-3,s:16+Math.random()*16,a:(Math.random()-.5)*.8,va:(Math.random()-.5)*.08}));
  let t=0;cancelAnimationFrame(confettiRaf);
  (function step(){ctx.clearRect(0,0,r.width,r.height);t++;
   P.forEach(p=>{p.vy+=.3;p.vx*=.99;p.x+=p.vx;p.y+=p.vy;p.a+=p.va;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.a);ctx.globalAlpha=Math.max(0,1-t/150);ctx.font=p.s+"px serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("😌",0,0);ctx.restore()});
   if(t<150)confettiRaf=requestAnimationFrame(step);else ctx.clearRect(0,0,r.width,r.height)})();
 }
})();


/* Leaving the page locks the app: coming back (restored tab, back/forward cache, or away for 30 s+) asks for fingerprint / password again. */
(()=>{let hiddenAt=0;
 const lockNow=()=>{const a=getAccount();if(a&&!dashboardPage.classList.contains("hidden"))lockToLogin(a)};
 document.addEventListener("visibilitychange",()=>{if(document.hidden)hiddenAt=Date.now();else if(hiddenAt&&Date.now()-hiddenAt>=30000){hiddenAt=0;lockNow();const a=getAccount();if(a&&a.fingerprintEnabled&&window.PublicKeyCredential)loginWithFingerprint(true)}else hiddenAt=0});
 window.addEventListener("pageshow",e=>{if(e.persisted){lockNow();const a=getAccount();if(a&&a.fingerprintEnabled&&window.PublicKeyCredential)loginWithFingerprint(true)}});
})();

/* This device was logged out from another device (Linked devices): leave the dashboard at once. */
window.addEventListener("veltrix-revoked",()=>{try{closeProfileScreens()}catch{}document.body.classList.remove("wd-feature-open");document.getElementById("loginPassword").value="";showPage("loginPage");showMessage(loginMessage,"This device was logged out of your account. Sign in again to continue.","error")});
