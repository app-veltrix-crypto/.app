const ACCOUNT_KEY="veltrixAccount",SESSION_KEY="veltrixLoggedIn";
const loginPage=document.getElementById("loginPage"),signupPage=document.getElementById("signupPage"),dashboardPage=document.getElementById("dashboardPage");
const signupForm=document.getElementById("signupForm"),loginForm=document.getElementById("loginForm"),profilePicture=document.getElementById("profilePicture"),profilePreview=document.getElementById("profilePreview"),locationInput=document.getElementById("location"),locationButton=document.getElementById("locationButton"),locationStatus=document.getElementById("locationStatus"),locationNotice=document.getElementById("locationNotice"),fingerprintToggle=document.getElementById("fingerprintToggle"),fingerprintStatus=document.getElementById("fingerprintStatus"),fingerprintLoginButton=document.getElementById("fingerprintLoginButton"),signupMessage=document.getElementById("signupMessage"),loginMessage=document.getElementById("loginMessage");

document.addEventListener("DOMContentLoaded",async()=>{try{const account=await veltrixDB.restore();if(account){lockToLogin(account);if(account.fingerprintEnabled&&window.PublicKeyCredential)loginWithFingerprint(true)}else showPage(window.veltrixWelcome?"welcomePage":"loginPage")}catch(e){console.error(e);showPage("loginPage")}finally{if(window.__splash)window.__splash.release("boot")}});
function showPage(id){const wp=document.getElementById("welcomePage");if(wp)wp.classList.add("hidden");loginPage.classList.add("hidden");signupPage.classList.add("hidden");dashboardPage.classList.add("hidden");const pc=document.getElementById("passcodePage");if(pc)pc.classList.add("hidden");document.getElementById(id).classList.remove("hidden");if(id==="signupPage"&&typeof showSignupStep==="function")showSignupStep(1);window.scrollTo({top:0,behavior:"smooth"})}
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
async function handleFingerprintToggle(){if(!fingerprintToggle.checked){fingerprintStatus.textContent="Biometric login is disabled.";fingerprintToggle.dataset.enabled="";fpPending="";return}if(!window.PublicKeyCredential){fingerprintToggle.checked=false;fingerprintStatus.textContent="Biometric authentication is not supported by this browser.";return}try{fingerprintStatus.textContent="Setting up biometric authentication...";fpPending=await fpCreate(document.getElementById("signupEmail").value,document.getElementById("fullName").value);fingerprintStatus.textContent="Biometric authentication enabled on this device.";fingerprintToggle.dataset.enabled="true"}catch{fingerprintToggle.checked=false;fingerprintToggle.dataset.enabled="";fpPending="";fingerprintStatus.textContent="Biometric setup was cancelled or unavailable."}}

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
  
  signupSubmitting=true;createAccountButton.disabled=true;let stage="start";
  try{
    const fullName=document.getElementById("fullName").value.trim(),email=document.getElementById("signupEmail").value.trim().toLowerCase(),password=document.getElementById("signupPassword").value,location=detectedLocation,dateOfBirth=document.getElementById("dateOfBirth").value;
    let profileImage;stage="photo";
    try{profileImage=await convertImageToDataURL(profilePicture.files[0])}
    catch{try{if(profilePicture.files[0].size>1.5*1024*1024)throw 0;profileImage=await readFileAsDataURL(profilePicture.files[0])}catch{profileImage=undefined}}   /* a photo that cannot be read must never block the account: continue without it */
    stage="signup";
    const imp=window.veltrixWelcome?veltrixWelcome.importPhrase():null;if(imp&&window.veltrixWallet)veltrixWallet.setImport(imp);
    const r=await veltrixDB.signUp({email,password,fullName,location,dateOfBirth,profileImage,fingerprintEnabled:fingerprintToggle.checked&&fingerprintToggle.dataset.enabled==="true"});
    if(fpPending){fpSave(email,fpPending);fpPending=""}
    if(imp&&window.veltrixWallet){if(r.needsConfirm)await veltrixWallet.stashPending(email,password,imp);veltrixWelcome.clear()}
    if(r.needsConfirm){showMessage(signupMessage,"Account created. Check your email to confirm it, then sign in.","success");return}
    showMessage(signupMessage,"Your account has been created successfully.","success");
    if(window.veltrixWelcomeSupport)window.veltrixWelcomeSupport();
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
    } else if (/already registered|already been registered|already exists|user_already_exists|email_exists/.test(detail + " " + String(err && err.code || "").toLowerCase())) {
      message = "An account with this email already exists. Use a different email to create a new account, or go back and sign in to the existing one.";
    } else if (/rate limit|too many|over_email_send_rate_limit|429/.test(detail + " " + String(err && (err.code || err.status) || "").toLowerCase())) {
      message = "Too many sign-up attempts. Please wait a few minutes and try again.";
    } else if (/failed to fetch|networkerror|network request|load failed|retryablefetch/.test(detail + " " + name.toLowerCase())) {
      message = "Couldn't reach the server. Check your internet connection and try again.";
    } else if (/signups? (are |is )?(not allowed|disabled)|signup_disabled/.test(detail + " " + String(err && err.code || "").toLowerCase())) {
      message = "New sign-ups are currently turned off.";
    } else if (/database error|saving new user/.test(detail)) {
      message = "The server couldn't set up your profile (database error). Please contact support.";
    } else if (/password/.test(detail)) {
      message = "That password isn't accepted. Try a longer, stronger password.";
    } else if (/valid email|email address.*invalid|invalid.*email/.test(detail)) {
      message = "Please enter a valid email address.";
    } else if (detail) {
      message = "Account creation failed: " + String(err.message).slice(0, 160);
    }

    console.error("Veltrix account creation failed:", err);
    if (message === "Account creation failed. Please refresh the page and try again.") {
      message = "Account creation failed (v120, step: " + stage + (name ? ", " + name : "") + (err && (err.code || err.status) ? ", " + (err.code || err.status) : "") + (detail ? ", " + detail.slice(0, 120) : ", no details") + ").";
    }
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

loginForm.addEventListener("submit",async e=>{e.preventDefault();clearMessage(loginMessage);const email=document.getElementById("loginEmail").value.trim().toLowerCase(),password=document.getElementById("loginPassword").value;try{if(window.veltrixWallet)await veltrixWallet.unlockPending(email,password);await veltrixDB.signIn(email,password);showDashboard();if(window.veltrixNotify)veltrixNotify("login","New login on "+veltrixDB.deviceInfo().name+".")}catch{showMessage(loginMessage,"The email address or password is incorrect.","error")}});

fingerprintLoginButton.addEventListener("click",()=>loginWithFingerprint());
/* ---- fingerprint (WebAuthn) ----
   The credential created when fingerprint login is switched on is remembered on THIS device (its id, per email) and is asked for
   by id at login. Before, the id was thrown away and login asked for "any" credential, which phones refuse, so it never worked. */
const FP_KEY="veltrixFpCred";let fpPending="",fpBusy=false;
const fpB64=u=>btoa(String.fromCharCode(...new Uint8Array(u))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fpBytes=t=>{t=String(t).replace(/-/g,"+").replace(/_/g,"/");while(t.length%4)t+="=";return Uint8Array.from(atob(t),c=>c.charCodeAt(0))};
function fpMap(){try{return JSON.parse(localStorage.getItem(FP_KEY)||"{}")||{}}catch{return{}}}
function fpGet(email){return fpMap()[String(email||"").toLowerCase()]||""}
function fpSave(email,id){try{const m=fpMap();m[String(email||"").toLowerCase()]=id;localStorage.setItem(FP_KEY,JSON.stringify(m))}catch{}}
async function fpCreate(email,name){
  const c=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{name:"Veltrix"},user:{id:crypto.getRandomValues(new Uint8Array(16)),name:email||"user",displayName:name||"Veltrix User"},pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required",residentKey:"preferred"},timeout:60000,attestation:"none"}});
  if(!c)throw new Error("no credential");return fpB64(c.rawId)}
async function fpAssert(id){
  const r=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),allowCredentials:[{type:"public-key",id:fpBytes(id),transports:["internal"]}],userVerification:"required",timeout:60000}});
  if(!r)throw new Error("no assertion")}
/* an account with fingerprint on, signed in on a device that has no credential yet (new phone, cleared data): set it up right after a normal sign-in */
function fpEnsure(a){if(!a||!a.fingerprintEnabled||!window.PublicKeyCredential||fpBusy||fpGet(a.email))return;fpBusy=true;
  setTimeout(()=>{try{wdToast("Setting up fingerprint login on this device")}catch{}fpCreate(a.email,a.fullName).then(id=>fpSave(a.email,id)).catch(()=>{}).finally(()=>{fpBusy=false})},700)}
function fpReady(a){return !!(a&&a.fingerprintEnabled&&window.PublicKeyCredential&&fpGet(a.email))}
function lockToLogin(a){try{closeProfileScreens()}catch{}try{if(window.veltrixSettingsClose)veltrixSettingsClose()}catch{}document.body.classList.remove("wd-feature-open");
 if(window.veltrixPasscode&&veltrixPasscode.wanted()){veltrixPasscode.show(a);return}
 showPage("loginPage");document.getElementById("loginEmail").value=a.email||"";document.getElementById("loginPassword").value="";showMessage(loginMessage,fpReady(a)?"Welcome back. Use your fingerprint, or your email and password, to continue.":"Welcome back. Enter your password to continue.","success")}
async function loginWithFingerprint(auto){
 const onPc=!!(window.veltrixPasscode&&veltrixPasscode.visible());
 const say=(t,k)=>onPc?veltrixPasscode.say(t,k):showMessage(loginMessage,t,k||"error");
 if(auto!==true&&!onPc)clearMessage(loginMessage);
 const account=getAccount();
 if(!account)return say("Sign in with your email and password first.");
 if(!account.fingerprintEnabled)return say("Fingerprint login has not been enabled for this account.");
 if(!window.PublicKeyCredential)return say("Biometric authentication is not supported by this browser.");
 const id=fpGet(account.email);
 if(!id){if(auto!==true)say(onPc?"Unlock with your passcode once to set up fingerprint on this device.":"Sign in with your password once to set up fingerprint on this device.");return}
 if(fpBusy)return;fpBusy=true;
 try{await fpAssert(id);showDashboard()}
 catch{if(auto!==true)say(onPc?"Fingerprint was cancelled. Enter your passcode instead.":"Biometric authentication was cancelled or could not be completed.")}
 finally{fpBusy=false}
}

function showDashboard(){const a=getAccount();if(!a)return showPage("loginPage");populateDashboard(a);showPage("dashboardPage");fpEnsure(a);if(window.veltrixSpeak)window.veltrixSpeak(`Hello ${a.fullName||"there"}, welcome to Veltrix, your gateway to clean, smooth cryptocurrency transactions.`)}

/* =========================================================
   DASHBOARD (crypto wallet home)
   Account details live in Supabase; the dashboard itself only
   shows the avatar, search, balance, quick actions and the user's
   crypto assets. New accounts have no assets, so the list is empty.
   Asset shape: {symbol, name, amount, price, change}  (change in %)
========================================================= */
let dashboardAssets=[],balanceHidden=false;
const fmt=(n,d=2)=>Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
/* Live prices (CoinGecko) for the coins the user actually holds. Total balance = sum of amount x live price. */
let assetPrices={},assetPriceAt=0,assetPriceBusy=false;
function pricedAssets(list){return list.map(x=>{const p=assetPrices[String(x.symbol).toUpperCase()]||{};return {...x,price:Number(p.price)||0,change:Number(p.change)||0}})}
async function refreshAssetPrices(force){
  if(assetPriceBusy||!dashboardAssets.length)return;
  if(!force&&Date.now()-assetPriceAt<20000)return;
  const ids={};dashboardAssets.forEach(x=>{const sym=String(x.symbol).toUpperCase();const c=cryptoFallback.find(k=>k.symbol===sym);if(c)ids[c.id]=sym});
  const list=Object.keys(ids);if(!list.length)return;
  assetPriceBusy=true;
  try{const r=await fetch("https://api.coingecko.com/api/v3/simple/price?ids="+list.join(",")+"&vs_currencies=usd&include_24hr_change=true",{headers:{accept:"application/json"},cache:"no-store"});
   if(r.ok){const d=await r.json();list.forEach(id=>{if(d[id]&&d[id].usd!=null)assetPrices[ids[id]]={price:d[id].usd,change:d[id].usd_24h_change||0}});assetPriceAt=Date.now();
    dashboardAssets=pricedAssets(dashboardAssets);renderBalance();renderAssets(document.getElementById("assetSearch")?document.getElementById("assetSearch").value:"")}}
  catch(_){}finally{assetPriceBusy=false}
}
setInterval(()=>{if(!document.hidden)refreshAssetPrices(true)},30000);
function populateDashboard(a){
  const avatar=document.getElementById("dashboardAvatar");
  avatar.innerHTML=a.profileImage?`<img src="${a.profileImage}" alt="Profile picture">`:`<span>${getInitials(a.fullName)}</span>`;
  dashboardAssets=pricedAssets((Array.isArray(a.assets)?a.assets:[]).filter(vxSupported));
  refreshAssetPrices();
  document.getElementById("assetSearch").value="";
  renderBalance();renderAssets("");
}
function renderBalance(){
  const total=dashboardAssets.reduce((s,x)=>s+x.amount*x.price,0);
  {const el=document.getElementById("totalAssets");
  if(balanceHidden)el.textContent="••••••";
  else{const s=String(fmt(total)),i=s.lastIndexOf(".");el.innerHTML=i<0?esc(s):`${esc(s.slice(0,i))}<span class="wd-dec">${esc(s.slice(i))}</span>`}}
  const balanceToggle=document.getElementById("toggleBalance");
  balanceToggle.innerHTML=balanceHidden?EYE_OFF_ICON:EYE_ICON;
  balanceToggle.setAttribute("aria-pressed",String(balanceHidden));
  balanceToggle.setAttribute("aria-label",balanceHidden?"Show balance":"Hide balance");
  renderGreeting();
}
/* "Good morning, Name" / "Good afternoon, Name" / "Good evening, Name" from the device clock */
function renderGreeting(){
  const el=document.getElementById("greetText");if(!el)return;
  const a=(typeof getAccount==="function"&&getAccount())||{},first=String(a.fullName||"").trim().split(/\s+/)[0]||"";
  const h=new Date().getHours(),g=h>=5&&h<12?"Good morning":h>=12&&h<17?"Good afternoon":"Good evening";
  const t=first?`${g}, ${first}`:g;if(el.textContent!==t)el.textContent=t;
}
setInterval(()=>{if(!document.hidden)renderGreeting()},60000);
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function renderAssets(query){
  const list=document.getElementById("assetList"),q=query.trim().toLowerCase();
  if(!dashboardAssets.length){list.innerHTML='<div class="wd-empty"><div class="wd-empty-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M6 8V1h1v6.117L8.743 6.07a.5.5 0 0 1 .514 0L11 7.117V1h1v7a.5.5 0 0 1-.757.429L9 7.083 6.757 8.43A.5.5 0 0 1 6 8"/><path d="M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2"/><path d="M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z"/></svg></div><strong>No assets yet</strong><p>Crypto you receive will show up here.</p></div>';return}
  const rows=dashboardAssets.filter(x=>!q||x.symbol.toLowerCase().includes(q)||(x.name||"").toLowerCase().includes(q));
  if(!rows.length){list.innerHTML='<div class="wd-empty"><strong>No results</strong><p>No asset matches your search.</p></div>';return}
  list.innerHTML=rows.map(x=>{const up=(x.change||0)>=0;return `<div class="wd-row"><div class="wd-coin">${esc(x.symbol[0])}</div><div class="wd-coin-info"><b>${esc(x.symbol)}<span>/USDT</span></b><small>${fmt(x.amount,4)} ${esc(x.symbol)}</small></div><div class="wd-coin-value">${fmt(x.amount*x.price)}</div><div class="wd-pill ${up?"up":"down"}">${up?"+":"-"}${fmt(Math.abs(x.change||0))}%</div></div>`}).join("");
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
 {id:"tron",symbol:"TRX",name:"TRON",price:null,change:null,color:"#e5092a"},
 {id:"avalanche-2",symbol:"AVAX",name:"Avalanche",price:null,change:null,color:"#e84142"},
 {id:"shiba-inu",symbol:"SHIB",name:"Shiba Inu",price:null,change:null,color:"#f08b2d"},
 {id:"chainlink",symbol:"LINK",name:"Chainlink",price:null,change:null,color:"#2a5ada"},
 {id:"litecoin",symbol:"LTC",name:"Litecoin",price:null,change:null,color:"#345d9d"},
];
/* Only coins that can really be sent to other wallets are ever shown. Anything else a recovery phrase may support is ignored. */
const VX_SUPPORTED=new Set(cryptoFallback.map(c=>c.symbol));
const vxSupported=a=>VX_SUPPORTED.has(String(a&&a.symbol||a).toUpperCase());
let cryptoMarkets=cryptoFallback.map(c=>({...c}));
function formatMarketPrice(n){if(n==null||!Number.isFinite(Number(n)))return "—";const v=Number(n);return "$"+v.toLocaleString("en-US",{minimumFractionDigits:v>=1?2:4,maximumFractionDigits:v>=1?2:6})}
function coinLogoHTML(c){const sym=String(c.symbol||"?").toUpperCase();const local=(window.VX_LOCAL_LOGOS||{})[sym];const icon=local||`https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/${esc(sym.toLowerCase())}.svg`;return `<img src="${esc(local||c.image||icon)}" alt="" loading="lazy" data-fallback="${icon}" data-letter="${esc(sym.slice(0,1))}" onerror="coinLogoError(this)">`}
function coinLogoError(img){if(img.dataset.fallback&&img.src!==img.dataset.fallback&&!img.dataset.tried){img.dataset.tried="1";img.src=img.dataset.fallback;return}const s=document.createElement("span");s.textContent=img.dataset.letter||"?";img.replaceWith(s)}
function renderCryptoLoading(){
 vxSkeleton.fill(cryptoMarketList,8,"market");
}
let cryptoMarketsReady=false;
function renderCryptoMarkets(query=""){
 if(!cryptoMarketsReady){renderCryptoLoading();return}
 cryptoMarketList.removeAttribute("aria-busy");
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
  const response=await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids="+encodeURIComponent(cryptoFallback.map(c=>c.id).join(","))+"&order=market_cap_desc&per_page=50&page=1&sparkline=false",{headers:{accept:"application/json"}});
  if(!response.ok)throw new Error("Market request failed");
  const data=(await response.json());
  const colors=Object.fromEntries(cryptoFallback.map(c=>[c.symbol,c.color]));
  if(Array.isArray(data)&&data.length){cryptoMarkets=data.filter(vxSupported).map(c=>({id:c.id,symbol:String(c.symbol||"").toUpperCase(),name:c.name,price:c.current_price,change:c.price_change_percentage_24h,image:c.image,rank:c.market_cap_rank,cap:c.market_cap,volume:c.total_volume,color:colors[String(c.symbol||"").toUpperCase()]||"#34343a"}));await vxSkeleton.logos(cryptoMarkets,2200);cryptoMarketsReady=true;cryptoSearchStatus.textContent="Live prices · USD";renderCryptoMarkets(assetSearchInput.value)}
  else throw new Error("No market data");
 }catch(_){cryptoMarketsReady=true;cryptoSearchStatus.textContent="Market prices unavailable";renderCryptoMarkets(assetSearchInput.value)}
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
 if(!coin)return;activeMarketCoin=coin;marketChartRange="1D";if(window.veltrixWatch)veltrixWatch.sync(coin);
 cryptoSearchPanel.hidden=true;document.getElementById("dashboardPage").classList.remove("searching-crypto");
 marketDetailPage.hidden=false;document.body.classList.add("wd-feature-open");
 const logo=document.getElementById("marketDetailLogo");logo.innerHTML=coinLogoHTML(coin);logo.style.background=coin.color||"#202338";
 document.getElementById("marketDetailSymbol").textContent=coin.symbol;
 document.getElementById("marketDetailName").innerHTML="";
 document.getElementById("marketDetailName").append(document.createTextNode(coin.name+" "));
 const copy=document.createElement("button");copy.type="button";copy.id="copyMarketSymbol";copy.setAttribute("aria-label","Copy cryptocurrency symbol");copy.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H16"/></svg>';document.getElementById("marketDetailName").append(copy);
 document.getElementById("marketDetailBalanceSymbol").textContent=coin.symbol;
 document.getElementById("marketAboutName").textContent=coin.name;
 document.getElementById("marketAboutCopy").hidden=true;
 document.getElementById("marketDetailPrice").textContent=formatMarketPrice(coin.price);
 const change=document.getElementById("marketDetailChange");change.textContent=coin.change==null?"Loading market data…":`${Number(coin.change)>=0?"+":""}${Number(coin.change).toFixed(2)}%`;change.classList.toggle("down",Number(coin.change)<0);
 document.querySelectorAll("[data-market-range]").forEach(b=>b.classList.toggle("active",b.dataset.marketRange===marketChartRange));
 marketDetailPage.classList.add("vx-busy");document.getElementById("marketChartLoading").classList.remove("loaded");drawMarketChart([]);
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
  loading.classList.add("loaded");marketDetailPage.classList.remove("vx-busy");
 }catch(_){
  loading.classList.add("loaded");marketDetailPage.classList.remove("vx-busy");
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
/* watchlist heart: handled by activity.js (saved in the database, drives price alerts) */
document.getElementById("marketDetailPage").addEventListener("click",e=>{if(e.target.closest("#copyMarketSymbol")){navigator.clipboard?.writeText(activeMarketCoin?.symbol||"").then(()=>wdToast("Symbol copied")).catch(()=>wdToast(activeMarketCoin?.symbol||""))}});
document.getElementById("marketAboutToggle").addEventListener("click",()=>{const p=document.getElementById("marketAboutCopy");p.hidden=!p.hidden});
document.getElementById("marketBuyButton").addEventListener("click",()=>{if(window.veltrixBuyBrowser)veltrixBuyBrowser.open(activeMarketCoin);else wdToast("Buying is not available right now")});
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
  stack.addEventListener("click",e=>{if(e.target.closest&&e.target.closest(".wd-stack-close"))advance(1)});
  stack.addEventListener("pointerdown",e=>{
    if(e.target.closest&&e.target.closest(".wd-stack-close"))return;
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
function wdToast(msg){const t=document.getElementById("wdToast");t.textContent=msg;t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),Math.min(6500,Math.max(1800,1300+String(msg||"").length*48)))}
document.querySelectorAll("#dashboardPage [data-action]").forEach(b=>b.addEventListener("click",()=>{
 if(b.dataset.action==="Deposit"){openDepositPage();return}
 if(b.dataset.action==="Send"){openSendSheet();return}
 wdToast(`${b.dataset.action} is coming soon`)
}));
// Deposit flow: 20 popular assets, with clearly labelled prototype-only addresses.
const depositPage=document.getElementById("depositPage");
const depositCoinPicker=document.getElementById("depositCoinPicker");
const depositCoinDetails=document.getElementById("depositCoinDetails");
let depositDappsMode=false;
const depositCoinList=document.getElementById("depositCoinList");
let activeDepositCoin=null,depositAddrs={};
let depositAddrsState="loading";/* loading | ready | error */
let depositLive={},depositLiveState="loading";/* loading | ready | error *//* live prices for the deposit coins only, keyed by symbol */
async function loadDepositAddrs(){
 try{let w=await veltrixDB.wallet.info();if(!(w&&w.exists)&&window.veltrixWallet){await veltrixWallet.ensure();w=await veltrixDB.wallet.info()}const r=(w&&w.exists&&Array.isArray(w.addresses))?w.addresses:[];depositAddrs=Object.fromEntries(r.filter(vxSupported).map(x=>[String(x.symbol).toUpperCase(),x]));depositAddrsState="ready"}
 catch(_){if(depositAddrsState!=="ready")depositAddrsState="error"}
 if(!depositPage.hidden&&!depositCoinPicker.hidden){const s=document.getElementById("depositCoinSearch");renderDepositCoins(s?s.value:"")}
}
/* The deposit list = exactly the coins that have an address derived from THIS user's own wallet phrase. */
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
 depositLiveState=Object.keys(depositLive).length?"ready":"loading";
 renderDepositCoins();
 loadDepositAddrs();
 refreshDepositMarkets();
}
function depositCompact(n){return n==null||!Number.isFinite(Number(n))?null:"$"+new Intl.NumberFormat("en-US",{notation:"compact",maximumFractionDigits:2}).format(Number(n))}
function renderDepositCoins(query=""){
 const all=depositCoinsList();
 const q=query.trim().toLowerCase();
 const coins=all.filter(c=>!q||String(c.name||"").toLowerCase().includes(q)||String(c.symbol||"").toLowerCase().includes(q));
 if(depositAddrsState==="loading"||depositLiveState==="loading"){vxSkeleton.fill(depositCoinList,9,"market");const cnt=document.getElementById("depositResultCount");if(cnt)cnt.textContent="…";return}
 const paintDeposit=()=>{depositCoinList.innerHTML=coins.map(c=>{
  const hasChange=c.change!=null&&Number.isFinite(Number(c.change));const up=Number(c.change)>=0;
  const change=hasChange?`${up?"+":""}${Number(c.change).toFixed(2)}%`:"—";
  const vol=depositCompact(c.volume),cap=depositCompact(c.cap);
  const details=[String(c.symbol||"").toUpperCase(),c.rank?`Rank #${c.rank}`:null,cap?`MCap ${cap}`:null,!cap&&vol?`Vol ${vol}`:null].filter(Boolean).join(" · ");
  return `<button type="button" class="wd-market-row wd-deposit-market-row" role="listitem" data-deposit-id="${esc(c.id)}"><span class="wd-market-coin" style="--coin-color:${esc(c.color||"#333")}">${coinLogoHTML(c)}</span><span class="wd-market-name"><b>${esc(c.name)}</b><small>${esc(details)}</small></span><span class="wd-market-values"><b>${formatMarketPrice(c.price)}</b><small class="${!hasChange?"neutral":up?"up positive":"down negative"}">${change}</small></span></button>`}).join("")||`<div class="wd-deposit-empty">${depositAddrsState==="loading"?"Loading deposit options…":depositAddrsState==="error"?"Couldn't load deposit options. Please try again.":q?"No matching tokens found.":"No deposit options are available yet."}</div>`};
 vxSkeleton.render(depositCoinList,coins,paintDeposit,"market",9);
 const count=document.getElementById("depositResultCount");if(count)count.textContent=String(depositDappsMode?0:coins.length);
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
   /* any coin the id lookup missed (e.g. an id CoinGecko renamed) is looked up by its symbol instead */
   try{const missing=Object.keys(depositAddrs).filter(sym=>!depositLive[sym]);
    if(missing.length){const r2=await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols="+encodeURIComponent(missing.join(",").toLowerCase())+"&order=market_cap_desc&per_page=250&page=1&sparkline=false",{headers:{accept:"application/json"}});
     if(r2.ok){(await r2.json()).forEach(c=>{const k=String(c.symbol||"").toUpperCase();if(missing.includes(k)&&!depositLive[k])depositLive[k]={price:c.current_price,change:c.price_change_percentage_24h,image:c.image,rank:c.market_cap_rank,cap:c.market_cap,volume:c.total_volume}})}}}catch(_){}
   depositLiveState="ready";
   if(!depositPage.hidden&&!depositCoinPicker.hidden){const s=document.getElementById("depositCoinSearch");renderDepositCoins(s?s.value:"")}
  }else throw new Error("No market data");
 }catch(_){if(depositLiveState!=="ready"){depositLiveState="error";if(!depositPage.hidden&&!depositCoinPicker.hidden){const s=document.getElementById("depositCoinSearch");renderDepositCoins(s?s.value:"")}}}finally{depositMarketsBusy=false}
}
setInterval(()=>{if(!depositPage.hidden&&!depositCoinPicker.hidden)refreshDepositMarkets()},30000);
const depositSearch=document.getElementById("depositCoinSearch");
if(depositSearch)depositSearch.addEventListener("input",()=>renderDepositCoins(depositSearch.value));
const clearDepositSearch=document.getElementById("clearDepositSearch");
if(clearDepositSearch)clearDepositSearch.addEventListener("click",()=>{closeFeaturePages();});
const depositPasteButton=document.getElementById("depositPasteButton");
if(depositPasteButton)depositPasteButton.addEventListener("click",async()=>{try{depositSearch.value=await navigator.clipboard.readText();renderDepositCoins(depositSearch.value);depositSearch.focus()}catch(_){wdToast("Clipboard access isn't available")}});
/* Tokens / dApps tabs: dApps swaps the coin list for a "none available" screen; Tokens brings the list back. */
document.querySelectorAll("[data-deposit-tab]").forEach(tab=>tab.addEventListener("click",()=>{
  document.querySelectorAll("[data-deposit-tab]").forEach(t=>{const active=t===tab;t.classList.toggle("active",active);t.setAttribute("aria-selected",String(active))});
  depositDappsMode=tab.dataset.depositTab==="dapps";
  document.getElementById("depositCoinPicker").classList.toggle("dapps-mode",depositDappsMode);
  const cnt=document.getElementById("depositResultCount");
  if(depositDappsMode){if(cnt)cnt.textContent="0"}else renderDepositCoins(depositSearch?depositSearch.value:"");
}));
depositCoinList.addEventListener("click",e=>{
 const row=e.target.closest("[data-deposit-id]");if(!row)return;
 const all=depositCoinsList();
 activeDepositCoin=all.find(c=>c.id===row.dataset.depositId)||all.find(c=>c.symbol===row.dataset.depositId);
 if(!activeDepositCoin)return;
 const symbol=String(activeDepositCoin.symbol||"COIN").toUpperCase();
 const paintDepositDetail=()=>{depositCoinDetails.classList.remove("vx-dep-busy");
 document.getElementById("depositCoinName").innerHTML=`<span class="wd-deposit-selected-coin"><span class="wd-deposit-selected-logo" style="--coin-color:${esc(activeDepositCoin.color||"#30354a")}">${coinLogoHTML(activeDepositCoin)}</span><span>${esc(activeDepositCoin.name)}</span></span>`;
 const addrEl=document.getElementById("depositAddress"),netEl=document.getElementById("depositNetwork"),qrTarget=document.getElementById("depositQrImage"),copyBtn=document.getElementById("copyDepositAddress");
 const showAddr=rec=>{qrTarget.replaceChildren();
  if(!rec){addrEl.textContent="Deposit address not available yet";netEl.textContent=`${symbol} deposits are not enabled yet. Please choose another asset.`;copyBtn.disabled=true;qrTarget.textContent="—";return}
  copyBtn.disabled=false;addrEl.textContent=rec.address;netEl.textContent=`Network: ${rec.network}. Only send ${symbol} on this network. Sending anything else, or using another network, can result in permanent loss.`;
  try{VeltrixQR.render(qrTarget,rec.address,{size:240})}catch(e){qrTarget.textContent="QR unavailable. Copy the address below."}};
 showAddr(depositAddrs[symbol]);
 if(!depositAddrs[symbol])loadDepositAddrs().then(()=>{if(String(activeDepositCoin&&activeDepositCoin.symbol).toUpperCase()===symbol)showAddr(depositAddrs[symbol])});
 };
 if(vxSkeleton.cached([activeDepositCoin]))paintDepositDetail();
 else{depositCoinDetails.classList.add("vx-dep-busy");document.getElementById("depositCoinName").innerHTML='<span class="vx" style="display:inline-block;width:130px;height:18px;border-radius:7px"></span>';document.getElementById("depositAddress").textContent="loading address";document.getElementById("depositNetwork").textContent="loading network details loading network details";document.getElementById("depositQrImage").replaceChildren();document.getElementById("copyDepositAddress").disabled=true;const want=activeDepositCoin;vxSkeleton.logos([want],1800).then(()=>{if(activeDepositCoin===want)paintDepositDetail()})}
 depositCoinPicker.hidden=false;depositCoinDetails.hidden=false;
 (document.getElementById("depositTitle")||{}).textContent=`Deposit ${symbol}`;
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
   a crypto wallet address QR -> opens the Send screen with the address pre-filled (the scanner does nothing else) */
async function handleQrResult(raw){
  const status=document.getElementById("qrScannerStatus");
  const coin=window.veltrixDetectCrypto&&veltrixDetectCrypto(raw);
  if(coin){
    status.textContent=`${coin.symbol} address detected.`;
    closeFeaturePages();
    openSendSheet({symbol:coin.symbol,address:coin.address});
    if(coin.evm)wdToast("EVM address detected. ETH is selected, change the token if needed.");
    return;
  }
  status.textContent="This QR code is not a supported wallet address.";
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
async function doLogout(){closeProfileScreens();const a=getAccount();if(a&&((window.veltrixPasscode&&veltrixPasscode.wanted())||(a.fingerprintEnabled&&window.PublicKeyCredential))){lockToLogin(a);return}await veltrixDB.signOut();showPage("loginPage");if(a)document.getElementById("loginEmail").value=a.email||""}
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


/* Resilient entry points for the two controls reported as unresponsive. */
document.addEventListener("click",function(event){
 const depositButton=event.target.closest('#dashboardPage [data-action="Deposit"]');
 if(depositButton){event.preventDefault();openDepositPage();return}

});

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
  {symbol:"TRX",name:"TRON",price:0.12,amount:3000,net:"TRON (TRC-20)",re:new RegExp("^T"+B58+"{33}$"),ex:"T…"},
  {symbol:"AVAX",name:"Avalanche",price:30,amount:50,net:"Avalanche C-Chain",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"SHIB",name:"Shiba Inu",price:0.00002,amount:10000000,net:"Ethereum (ERC-20)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"LINK",name:"Chainlink",price:15,amount:100,net:"Ethereum (ERC-20)",re:/^0x[a-fA-F0-9]{40}$/,ex:"0x…"},
  {symbol:"LTC",name:"Litecoin",price:70,amount:10,net:"Litecoin",re:new RegExp("^(ltc1[a-z0-9]{25,62}|[LM]"+B58+"{26,33})$"),ex:"ltc1… or L… / M…"},
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
  const px=(typeof assetPrices!=="undefined"&&assetPrices)||{};
  /* every supported coin is listed; the balance (0 when the user holds none) decides whether a send can go through */
  coins=COINS.map(c=>{const o=owned.find(a=>String(a.symbol).toUpperCase()===c.symbol);
   if(o)return {...c,amount:o.amount,price:o.price||0,real:true,owned:true};
   const p=px[c.symbol];return {...c,amount:0,price:(p&&Number(p.price))||0,real:true,owned:false}}).sort((a,b)=>(b.owned?1:0)-(a.owned?1:0));
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
  $("sdUsd").textContent=c.price?"≈ "+usd(n*c.price):"";
  $("sdBalVal").textContent=`${trim(c.amount)} ${c.symbol}`;
  $("sdAmtErr").hidden=!over;$("sdAmtErr").textContent="Insufficient balance";
  $("sdContinue").disabled=!(n>0&&!over);
 }
 function open(opts){
  build();val="";scanAddr="";recip=null;recipSeq++;clearTimeout(recipTimer);
  if(opts&&opts.symbol&&coins.some(c=>c.symbol===opts.symbol))sel=opts.symbol;
  else{const cc=coins.find(c=>c.symbol===sel);if(!cc||!cc.owned){const f=coins.find(c=>c.owned);if(f)sel=f.symbol}}
  if(opts&&opts.address)scanAddr=String(opts.address).trim();
  chip();render();show("sdAmountView");
  sheet.setAttribute("aria-hidden","false");requestAnimationFrame(()=>requestAnimationFrame(()=>sheet.classList.add("open")));
  document.body.style.overflow="hidden";
 }
 function close(){scanAddr="";recip=null;recipSeq++;clearTimeout(recipTimer);cancelAnimationFrame(confettiRaf);resetPin();sheet.classList.remove("open");sheet.setAttribute("aria-hidden","true");document.body.style.overflow=""}
 window.openSendSheet=open;
 /* Recognise a scanned crypto QR (plain address or a payment URI such as bitcoin:addr?amount=…) -> {symbol,address,evm} or null */
 const SCHEMES={bitcoin:"BTC",ethereum:"ETH",litecoin:"LTC",tron:"TRX",solana:"SOL",ripple:"XRP",xrp:"XRP",bnb:"BNB",avalanche:"AVAX",chainlink:"LINK"};
 const ORDER=["BTC","LTC","TRX","XRP","ETH","SOL"];
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
  const k=(q||"").trim().toLowerCase();
  const rows=coins.filter(c=>!k||c.name.toLowerCase().includes(k)||c.symbol.toLowerCase().includes(k));
  vxSkeleton.render($("sdList"),rows,()=>paintList(q),"pick");
 }
 function paintList(q){
  q=(q||"").trim().toLowerCase();
  const rows=coins.filter(c=>!q||c.name.toLowerCase().includes(q)||c.symbol.toLowerCase().includes(q));
  $("sdList").innerHTML=rows.length?rows.map(c=>`<button type="button" class="sd-row${c.symbol===sel?" sel":""}" data-s="${esc(c.symbol)}" role="option" aria-selected="${c.symbol===sel}"><span class="cv-logo">${coinLogoHTML(c)}</span><span class="i"><b>${esc(c.name)}</b><small>${esc(c.symbol)}</small></span><span class="r">${trim(c.amount)}<small>Available</small></span></button>`).join(""):'<div style="padding:30px;text-align:center;font-size:12px;color:var(--wd-muted,#858995)">No matching crypto found.</div>';
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
 /* recip: null = not looked up yet | {error:true} | {found:false} (outside address) | {found:true,self,name} (a Veltrix wallet) */
 let recip=null,recipSeq=0,recipTimer=0,sending=false,pendingReq=null;
 /* format check; mixed-capital 0x… addresses must also pass their built-in checksum (catches typos before any money is held) */
 function addrOk(c,a){
  if(!c.re.test(a))return false;
  if(/^0x[a-fA-F0-9]{40}$/.test(a)&&a!==a.toLowerCase()&&a!=="0x"+a.slice(2).toUpperCase()&&window.ethers){try{window.ethers.getAddress(a)}catch{return false}}
  return true;
 }
 /* XRP destination tag (optional): shown only for an outside XRP address; a whole number from 0 to 4294967295 */
 function tagVal(){return $("sdTagWrap").hidden?"":$("sdTag").value.trim()}
 function tagOk(){const t=tagVal();return !t||(/^\d{1,10}$/.test(t)&&Number(t)<=4294967295)}
 function syncTag(){const show=cur().symbol==="XRP"&&!!$("sdAddr").value.trim()&&!(recip&&recip.found);$("sdTagWrap").hidden=!show;if(!show)$("sdTag").value=""}
 function addrReady(){const c=cur(),a=$("sdAddr").value.trim();return !!(a&&addrOk(c,a)&&recip&&!recip.error&&!(recip.found&&recip.self)&&tagOk())}
 function checkAddr(){
  const c=cur(),a=$("sdAddr").value.trim(),box=$("sdInputBox"),m=$("sdAddrMsg");
  box.classList.remove("bad","good");m.hidden=true;m.className="sd-msg";
  clearTimeout(recipTimer);recipSeq++;recip=null;$("sdSend").disabled=true;
  let ok=false;
  if(a){ok=addrOk(c,a);box.classList.add(ok?"good":"bad");m.hidden=false;m.classList.add(ok?"good":"bad");
   m.textContent=ok?"Checking recipient…":`Invalid ${c.symbol} address. Enter a valid ${c.name} (${c.net}) address.`}
  if(ok){const seq=recipSeq,sym=c.symbol;recipTimer=setTimeout(()=>lookupRecipient(seq,sym,a),250)}
  syncTag();
  return ok;
 }
 async function lookupRecipient(seq,sym,a){
  let r=null;
  try{r=await veltrixDB.wallet.resolve(sym,a)}catch{r={error:true}}
  if(seq!==recipSeq)return;                      // the address or coin changed while we were asking
  recip=r&&typeof r==="object"?r:{error:true};paintRecip();
  if(recip.error)recipTimer=setTimeout(()=>lookupRecipient(seq,sym,a),3000);
 }
 function paintRecip(){
  const c=cur(),box=$("sdInputBox"),m=$("sdAddrMsg");
  box.classList.remove("bad","good");m.hidden=false;m.className="sd-msg";
  if(recip.error){box.classList.add("bad");m.classList.add("bad");m.textContent="Couldn't check this address. Check your connection, retrying…"}
  else if(recip.found&&recip.self){box.classList.add("bad");m.classList.add("bad");m.textContent="This is your own wallet address. You can't send to yourself."}
  else if(recip.found){box.classList.add("good");m.classList.add("good");m.textContent=`Veltrix wallet · ${recip.name||"Veltrix user"}. Instant transfer, no fee.`}
  else{box.classList.add("good");m.classList.add("good");m.textContent=`Outside wallet. It will be sent on the ${c.net} network. Make sure the receiving app (Binance, Bybit …) accepts ${c.symbol} on ${c.net}, or the funds can be lost.`}
  syncTag();$("sdSend").disabled=!addrReady();
 }
 $("sdAddr").addEventListener("input",checkAddr);
 $("sdTag").addEventListener("input",()=>{$("sdTag").value=$("sdTag").value.replace(/\D/g,"").slice(0,10);$("sdTagBox").classList.toggle("bad",!tagOk());$("sdSend").disabled=!addrReady()});
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
  $("sdAuthAmt").textContent=`${val} ${c.symbol}`;$("sdAuthTo").textContent=`≈ ${usd(n*c.price)} · to ${recip&&recip.found&&!recip.self?(recip.name||"Veltrix user")+" ("+shortAddr(a)+")":shortAddr(a)}`;
  resetPin();show("sdAuthView");if(Date.now()<lockUntil)startLock();setTimeout(()=>pins[0].focus(),150);
 }
 const shortAddr=a=>a.length>22?a.slice(0,10)+"…"+a.slice(-8):a;
 $("sdAuthBack").addEventListener("click",()=>{resetPin();show("sdAddrView")});
 $("sdSetupBack").addEventListener("click",()=>show("sdAddrView"));
 $("sdSetupLater").addEventListener("click",()=>show("sdAddrView"));
 $("sdSetupGo").addEventListener("click",()=>{close();setTimeout(()=>{if(window.veltrixTwoStep)veltrixTwoStep.setup()},250)});
 $("sdSend").addEventListener("click",()=>{
  if(!addrReady())return;
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
  tries=0;complete(pin);
 });
 /* ---- step 4: execute + luxury receipt ---- */
 const NETNAME=c=>c.net;
 function makeTx(c){const b=new Uint8Array(6);crypto.getRandomValues(b);return "WD-"+[...b].map(x=>x.toString(16).padStart(2,"0")).join("").toUpperCase()}
 /* success screen: "processing" = outside withdrawal being sent automatically, "done" = real transfer to another Veltrix user, already completed */
 function setDoneMode(mode){   // "done" | "processing"
  $("luxEyebrow").textContent=mode==="done"?"TRANSFER COMPLETE":"WITHDRAWAL PROCESSING";
  $("luxPill").classList.toggle("lux-pending",mode!=="done");$("luxPillTxt").textContent=mode==="done"?"Completed":"Processing";
  $("luxRecipRow").hidden=mode!=="done";
 }
 function playDone(){const v=$("sdDoneView");show("sdDoneView");v.classList.remove("play");void v.offsetWidth;v.classList.add("play");v.scrollTop=0}
 function refreshAfterTransfer(){
  try{veltrixDB.refreshWallet().then(r=>{if(r)populateDashboard(r)}).catch(()=>{})}catch{}
  if(window.veltrixActivity){try{veltrixActivity.refreshTx()}catch{}try{veltrixActivity.reload()}catch{}}
 }
 function pinProblem(msg){const btn=$("sdProceed");btn.textContent="Proceed";resetPin();show("sdAuthView");$("sdPinErr").hidden=false;$("sdPinErr").textContent=msg;setTimeout(()=>pins[0].focus(),150)}
 /* A real transfer to another Veltrix user. The server checks the PIN, balance and recipient and moves the money in one
    step; the success screen is shown ONLY after the server confirms. A lost connection is retried with the SAME request id,
    so the money can never move twice. */
 async function completeInternal(pin){
  if(sending)return;sending=true;
  const c=cur(),n=num(val),a=$("sdAddr").value.trim(),amt=trim(n),key=[c.symbol,amt,a].join("|");
  if(!pendingReq||pendingReq.key!==key||Date.now()-pendingReq.t>600000)pendingReq={key,id:veltrixDB.notif.uuid(),t:Date.now()};
  const btn=$("sdProceed");btn.disabled=true;btn.textContent="Sending…";
  let r=null;
  for(let i=0;i<3&&!r;i++){
    try{r=await veltrixDB.wallet.transfer(c.symbol,amt,a,pin,pendingReq.id)}catch{await new Promise(z=>setTimeout(z,1200*(i+1)))}
  }
  sending=false;btn.textContent="Proceed";
  if(!r){
    refreshAfterTransfer();
    pinProblem("We couldn't confirm this transfer. Check your transaction history before trying again.");return;
  }
  if(r.ok){
    pendingReq=null;
    const when=new Date(r.created_at).toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"});
    const amtTxt=`${trim(r.amount)} ${c.symbol}`,usdTxt=r.usd_value!=null&&r.usd_value!==""?`≈ ${usd(+r.usd_value)}`:"";
    lastTx=r.reference;lastTo=a;setDoneMode("done");
    $("luxAmt").textContent=amtTxt;$("luxUsd").textContent=usdTxt;
    $("luxRecip").textContent=r.to_name||"Veltrix user";$("luxTo").textContent=shortAddr(a);
    $("luxNet").textContent=r.network||c.net;$("luxDate").textContent=when;$("luxTx").textContent=r.reference;
    lastReceipt=`Veltrix transfer receipt\nStatus: Completed\nAmount: ${amtTxt}${usdTxt?" ("+usdTxt+")":""}\nTo: ${r.to_name||"Veltrix user"} (${a})\nNetwork: ${r.network||c.net}\nDate: ${when}\nReference: ${r.reference}`;
    playDone();refreshAfterTransfer();return;
  }
  pendingReq=null;
  switch(r.reason){
   case"bad_pin":tries++;if(tries>=5){lockUntil=Date.now()+30000;pinProblem("Too many attempts. Try again in 30s.");startLock()}else pinProblem("Incorrect 2FA code. Nothing was sent.");break;
   case"locked":lockUntil=Date.now()+(Number(r.seconds)||30)*1000;pinProblem("Too many attempts.");startLock();break;
   case"no_pin":show("sdSetupView");break;
   case"insufficient":wdToast("Insufficient balance. Nothing was sent.");refreshAfterTransfer();build();render();show("sdAmountView");break;
   case"invalid_amount":wdToast("That amount isn't valid. Nothing was sent.");show("sdAmountView");break;
   case"self":case"recipient_not_found":show("sdAddrView");checkAddr();wdToast(r.reason==="self"?"You can't send to your own wallet.":"That wallet could not be found. Nothing was sent.");break;
   default:wdToast("Transfer failed. Nothing was sent.");show("sdAddrView");checkAddr()
  }
 }
 function complete(pin){
  if(recip&&recip.found&&!recip.self)return completeInternal(pin);
  if(!recip||recip.error||recip.found){show("sdAddrView");checkAddr();wdToast("Please wait while the recipient is checked.");return}
  return completeOutside(pin);
 }
 /* A withdrawal to an OUTSIDE wallet (Binance, Bybit …). The server checks PIN, address, balance and limits and holds the amount;
    the screen is shown ONLY after it confirms. status "queued" = being sent automatically (there is no admin approval). */
 async function completeOutside(pin){
  if(sending)return;sending=true;
  const c=cur(),n=num(val),a=$("sdAddr").value.trim(),amt=trim(n),tag=tagVal(),key="W|"+[c.symbol,amt,a,tag].join("|");
  if(!pendingReq||pendingReq.key!==key||Date.now()-pendingReq.t>600000)pendingReq={key,id:veltrixDB.notif.uuid(),t:Date.now()};
  const btn=$("sdProceed");btn.disabled=true;btn.textContent="Sending…";
  let r=null;
  for(let i=0;i<3&&!r;i++){
   try{r=await veltrixDB.wallet.withdraw(c.symbol,amt,a,pin,pendingReq.id,tag)}catch{await new Promise(z=>setTimeout(z,1200*(i+1)))}
  }
  sending=false;btn.textContent="Proceed";
  if(!r){refreshAfterTransfer();pinProblem("We couldn't confirm this withdrawal. Check your transaction history before trying again.");return}
  if(r.ok){
   pendingReq=null;
   const mode="processing";
   const when=new Date(r.created_at).toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"});
   const amtTxt=`${trim(r.amount)} ${c.symbol}`,usdTxt=r.usd_value!=null&&r.usd_value!==""?`≈ ${usd(+r.usd_value)}`:"";
   lastTx=r.reference;lastTo=a;setDoneMode(mode);
   $("luxAmt").textContent=amtTxt;$("luxUsd").textContent=usdTxt;$("luxTo").textContent=shortAddr(a);
   $("luxNet").textContent=r.network||c.net;$("luxDate").textContent=when;$("luxTx").textContent=r.reference;
   lastReceipt=`Veltrix withdrawal receipt\nStatus: ${"Processing"}\nAmount: ${amtTxt}${usdTxt?" ("+usdTxt+")":""}\nTo: ${a}${tag?"\nDestination tag: "+tag:""}\nNetwork: ${r.network||c.net}\nDate: ${when}\nReference: ${r.reference}`;
   playDone();refreshAfterTransfer();
   if(r.status==="queued")veltrixDB.wallet.sendQueued(r.id).then(()=>setTimeout(refreshAfterTransfer,4000));
   return;
  }
  pendingReq=null;
  switch(r.reason){
   case"bad_pin":tries++;if(tries>=5){lockUntil=Date.now()+30000;pinProblem("Too many attempts. Try again in 30s.");startLock()}else pinProblem("Incorrect 2FA code. Nothing was sent.");break;
   case"locked":lockUntil=Date.now()+(Number(r.seconds)||30)*1000;pinProblem("Too many attempts.");startLock();break;
   case"no_pin":show("sdSetupView");break;
   case"insufficient":wdToast("Insufficient balance. Nothing was sent.");refreshAfterTransfer();build();render();show("sdAmountView");break;
   case"invalid_amount":wdToast(["USDT","USDC"].includes(c.symbol)?`${c.symbol} can only be sent in steps of 0.000001. Nothing was sent.`:"That amount isn't valid. Nothing was sent.");show("sdAmountView");break;
   case"invalid_address":wdToast("That address isn't valid for this coin. Nothing was sent.");show("sdAddrView");checkAddr();break;
   case"invalid_memo":wdToast("That destination tag isn't valid. Nothing was sent.");show("sdAddrView");checkAddr();break;
   case"unsupported_coin":wdToast("Sending "+c.symbol+" to outside wallets isn't available yet. Nothing was sent.");show("sdAddrView");checkAddr();break;
   case"unavailable":wdToast("Withdrawals to outside wallets are temporarily unavailable. Nothing was sent.");show("sdAddrView");checkAddr();break;
   case"limit_exceeded":wdToast("This is above the withdrawal limit. Try a smaller amount. Nothing was sent.");show("sdAmountView");break;
   case"internal_recipient":show("sdAddrView");checkAddr();wdToast("That is a Veltrix wallet. Review the recipient and send again.");break;
   default:wdToast("Withdrawal failed. Nothing was sent.");show("sdAddrView");checkAddr()
  }
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

/* A withdrawal changed status: refresh history and balance (a cancelled send returns its amount to the wallet). */
let txRefreshTimer=0;
function refreshMoneyViews(){clearTimeout(txRefreshTimer);txRefreshTimer=setTimeout(()=>{try{veltrixDB.refreshWallet().then(r=>{if(r)populateDashboard(r)}).catch(()=>{})}catch{}if(window.veltrixActivity)veltrixActivity.refreshTx()},300)}
window.addEventListener("veltrix-tx",refreshMoneyViews);
/* a deposit / withdrawal / transaction notification means money moved: refresh balance and history even if the history stream was missed */
window.addEventListener("veltrix-notif",e=>{const d=e.detail||{};if(d.type==="INSERT"&&d.row&&["deposit","withdrawal","transaction"].includes(d.row.topic))refreshMoneyViews()});

/* This device was logged out from another device (Linked devices): leave the dashboard at once. */
window.addEventListener("veltrix-revoked",()=>{try{closeProfileScreens()}catch{}document.body.classList.remove("wd-feature-open");document.getElementById("loginPassword").value="";showPage("loginPage");showMessage(loginMessage,"This device was logged out of your account. Sign in again to continue.","error")});
