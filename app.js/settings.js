/* Settings sub-sections: language, two-step verification (4-digit PIN), linked devices, notifications. */
(function(){
 const $=id=>document.getElementById(id);
 const get=(k,d)=>veltrixDB.pref.get(k,d);
 const set=(k,v)=>veltrixDB.pref.set(k,v);
 const toast=m=>{try{wdToast(m)}catch{}};
 /* ---- notification gate used by the rest of the app ---- */
 const TOPICS=[["security","Security alerts","Sign-ins, PIN and account protection"],["chat","Chat messages","New messages and mentions"],["transaction","Transaction alerts","Wallet activity"],["withdrawal","Withdrawal alerts","Funds sent from your wallet"],["deposit","Deposit alerts","Funds received in your wallet"],["price","Price alerts","Big moves in coins you follow"],["login","Login activity","New device and location logins"],["promo","Promotions & offers","Deals, rewards and campaigns"],["news","News & updates","Product news and announcements"]];
 const prefs=()=>Object.assign({},...TOPICS.map(t=>({[t[0]]:true})),get("veltrixNotif",{}));
 /* The voice setting is saved in the account, which isn't loaded on the login screen. So the choice is also kept on this device,
   and the voice stays silent everywhere (login included) whenever it is OFF. */
 const VKEY="veltrixAIVoiceDevice";
 const devVoice=()=>{try{return localStorage.getItem(VKEY)}catch{return null}};
 const setDevVoice=on=>{try{localStorage.setItem(VKEY,on?"on":"off")}catch{}};
 const voiceOn=()=>{const a=veltrixDB.get&&veltrixDB.get();if(a)return get("veltrixAIVoice",true)!==false;return devVoice()!=="off"};
 window.addEventListener("veltrix-ready",()=>{const a=veltrixDB.get&&veltrixDB.get();if(a)setDevVoice(get("veltrixAIVoice",true)!==false);if(!voiceOn()&&"speechSynthesis" in window)window.speechSynthesis.cancel()});
 window.veltrixSpeak=function(message){if(!voiceOn()||!("speechSynthesis" in window)||!message)return false;try{window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(String(message));u.lang="en-NG";u.rate=1;u.pitch=1;window.speechSynthesis.speak(u);return true}catch{return false}};
 window.veltrixNotify=function(topic,msg,title){if(prefs()[topic]===false)return false;toast(msg);if(window.veltrixActivity)veltrixActivity.push(topic,msg,title);if(voiceOn()&&["security","chat","transaction","withdrawal","deposit","login"].includes(topic))window.veltrixSpeak(msg);return true};
 /* ---- navigation ---- */
 const stack=[];
 const pages=["twoStepPage","pinPage","devicesPage","linkQrPage","deviceEditPage","notifPage"];
 function openPage(id){const el=$(id);el.hidden=false;el.scrollTop=0;stack.push(id)}
 function back(){const id=stack.pop();if(id)$(id).hidden=true;if(id==="phrasePage")phraseWipe();if(id==="phrasePwPage")phrasePwClear();if(id==="resetPwPage")resetClear()}
 function closeAll(){while(stack.length)$(stack.pop()).hidden=true;phraseWipe();phrasePwClear();resetClear()}
 window.veltrixSettingsClose=closeAll;
 document.querySelectorAll("[data-sx-back]").forEach(b=>b.addEventListener("click",()=>{const top=stack[stack.length-1];if(top==="pinPage"){pinCancel();return}back()}));
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&stack.length&&!document.querySelector(".sx-dlg:not([hidden])")){if(stack[stack.length-1]==="pinPage")pinCancel();else back()}});
 ["settingsLogout","logoutButton"].forEach(id=>{const b=$(id);if(b)b.addEventListener("click",closeAll)});
 /* ---- generic dialog ---- */
 function dialog(o){return new Promise(res=>{
  const d=document.createElement("div");d.className="profile-ui-edit-dialog sx-dlg";
  d.innerHTML=`<div class="profile-ui-dialog-card" role="dialog" aria-modal="true"><h2></h2><p class="sx-dlg-msg" style="margin:0;font-size:12px;color:#7b7d85;line-height:1.5"></p>${o.input?'<input maxlength="40" autocomplete="off" style="margin-top:12px">':''}<div class="profile-ui-dialog-actions"><button type="button" data-n>${o.cancel||"Cancel"}</button><button type="button" data-y${o.danger?' style="background:#e5484d"':""}>${o.ok||"OK"}</button></div></div>`;
  d.querySelector("h2").textContent=o.title;const m=d.querySelector(".sx-dlg-msg");if(o.msg)m.textContent=o.msg;else m.remove();
  const inp=d.querySelector("input");if(inp)inp.value=o.value||"";
  const done=v=>{d.remove();res(v)};
  d.querySelector("[data-n]").onclick=()=>done(null);
  d.querySelector("[data-y]").onclick=()=>{if(inp){const v=inp.value.trim();if(!v){inp.focus();return}done(v)}else done(true)};
  d.addEventListener("click",e=>{if(e.target===d)done(null)});
  document.body.appendChild(d);if(inp)setTimeout(()=>{inp.focus();try{const n=inp.value.length;inp.setSelectionRange(n,n)}catch{}},40);
 })}
 window.veltrixDialog=dialog;
 /* ---- two-step verification ---- */
 const sw=$("twoStepSwitch");let pinMode="create";
 const tfa=()=>get("veltrixTwoStep",{on:false});
 function paintTfa(){const on=!!tfa().on;sw.checked=on;$("twoStepState").textContent=on?"On":"Off"}
  $("settingsTwoStep").addEventListener("click",()=>{paintTfa();openPage("twoStepPage")});
 $("twoStepTrusted").addEventListener("click",()=>openDevices());
 sw.addEventListener("click",e=>{e.preventDefault();openPin(tfa().on?"verify":"create")});
 const boxes=id=>[...$(id).querySelectorAll("input")];
 const val=id=>boxes(id).map(i=>i.value).join("");
 function wire(id,next){const bs=boxes(id);bs.forEach((b,i)=>{
  b.addEventListener("input",()=>{b.value=b.value.replace(/\D/g,"").slice(-1);b.classList.toggle("filled",!!b.value);if(b.value&&i<3)bs[i+1].focus();else if(b.value&&next)next();check()});
  b.addEventListener("keydown",e=>{if(e.key==="Backspace"&&!b.value&&i>0){bs[i-1].value="";bs[i-1].classList.remove("filled");bs[i-1].focus();check()}});
  b.addEventListener("paste",e=>{const t=(e.clipboardData.getData("text")||"").replace(/\D/g,"").slice(0,4);if(!t)return;e.preventDefault();bs.forEach((x,j)=>{x.value=t[j]||"";x.classList.toggle("filled",!!x.value)});(bs[Math.min(t.length,3)]).focus();if(t.length===4&&next)next();check()});
 })}
 wire("pinA",()=>{if(pinMode==="create")boxes("pinB")[0].focus()});wire("pinB");
 function check(){
  const a=val("pinA"),b=val("pinB"),len=a.length===4,match=len&&a===b;
  $("pinChecks").querySelector('[data-c="len"]').classList.toggle("ok",len);
  $("pinChecks").querySelector('[data-c="match"]').classList.toggle("ok",match);
  $("pinSave").disabled=pinMode==="create"?!match:!len;
  $("pinError").hidden=true;$("pinA").classList.remove("bad");
 }
 function openPin(mode){
  pinMode=mode;["pinA","pinB"].forEach(id=>boxes(id).forEach(i=>{i.value="";i.classList.remove("filled")}));
  const c=mode==="create";
  $("pinTitle").textContent=c?"Create PIN":"Enter PIN";
  $("pinIntro").textContent=c?"Create a 4-digit PIN to turn on two-step verification.":"Enter your 4-digit PIN to turn off two-step verification.";
  $("pinBWrap").hidden=!c;$("pinSave").textContent=c?"Save":"Turn off";
  check();openPage("pinPage");setTimeout(()=>boxes("pinA")[0].focus(),120);
 }
 function pinCancel(){back();paintTfa()}
 /* API used by the Send flow */
 window.veltrixTwoStep={isOn:()=>!!tfa().on,verify:async p=>!!tfa().on&&await veltrixDB.pin.verify(String(p)),setup:()=>openPin("create")};
 $("pinSave").addEventListener("click",async()=>{
  const a=val("pinA");if(a.length!==4)return;
  if(pinMode==="create"){if(a!==val("pinB"))return;try{await veltrixDB.pin.set(a)}catch{toast("Couldn't save your PIN. Please try again.");return}set("veltrixTwoStep",{on:true});back();paintTfa();veltrixNotify("security","Two-step verification turned on")}
  else{if(!(await veltrixDB.pin.clear(a))){$("pinError").textContent="Incorrect PIN. Try again.";$("pinError").hidden=false;$("pinA").classList.add("bad");return}
   set("veltrixTwoStep",{on:false});back();paintTfa();veltrixNotify("security","Two-step verification turned off")}
 });

 /* ---- security: reset password, view passwords (recovery phrase) ---- */
 const rp1=$("resetPw1"),rp2=$("resetPw2"),rpin=[...$("resetPin").querySelectorAll("input")],rpinVal=()=>rpin.map(i=>i.value).join("");
 function resetCheck(){const a=rp1.value,b=rp2.value,len=a.length>=6,match=len&&a===b,c=$("resetChecks");
  c.querySelector('[data-c="len"]').classList.toggle("ok",len);c.querySelector('[data-c="match"]').classList.toggle("ok",match);
  $("resetSave").disabled=!(match&&rpinVal().length===4);$("resetError").hidden=true;$("resetPin").classList.remove("bad")}
 function resetClear(){rpin.forEach(i=>{i.value="";i.classList.remove("filled")});rp1.value="";rp2.value="";rp1.type="password";rp2.type="password";
  document.querySelectorAll("#resetPwPage .password-toggle").forEach(b=>{b.innerHTML=EYE_ICON;b.setAttribute("aria-pressed","false")});resetCheck()}
 [rp1,rp2].forEach(i=>i.addEventListener("input",resetCheck));
 rpin.forEach((b,i)=>{
  b.addEventListener("input",()=>{b.value=b.value.replace(/\D/g,"").slice(-1);b.classList.toggle("filled",!!b.value);if(b.value&&i<3)rpin[i+1].focus();else if(b.value)rp1.focus();resetCheck()});
  b.addEventListener("keydown",e=>{if(e.key==="Backspace"&&!b.value&&i>0){rpin[i-1].value="";rpin[i-1].classList.remove("filled");rpin[i-1].focus();resetCheck()}});
  b.addEventListener("paste",e=>{const t=(e.clipboardData.getData("text")||"").replace(/\D/g,"").slice(0,4);if(!t)return;e.preventDefault();rpin.forEach((x,j)=>{x.value=t[j]||"";x.classList.toggle("filled",!!x.value)});rpin[Math.min(t.length,3)].focus();resetCheck()});
 });
 $("settingsSecurity").addEventListener("click",()=>openPage("securityPage"));
 $("securityReset").addEventListener("click",async()=>{
  if(!tfa().on){
   const ok=await dialog({title:"Turn on two-step verification",msg:"To reset your password you first need to turn on two-step verification and create your 4-digit PIN.",ok:"Turn on"});
   if(ok)openPin("create");return}
  resetClear();openPage("resetPwPage");setTimeout(()=>rpin[0].focus(),150)});
 $("resetSave").addEventListener("click",async()=>{
  if(rp1.value.length<6||rp1.value!==rp2.value)return;
  if(rpinVal().length!==4)return;
  const btn=$("resetSave");btn.disabled=true;btn.textContent="Updating…";
  try{const c=await veltrixDB.pin.check(rpinVal());
   if(!c.ok){rpin.forEach(i=>{i.value="";i.classList.remove("filled")});$("resetPin").classList.add("bad");rpin[0].focus();
    $("resetError").textContent=c.error?"Couldn't check your PIN. Check your connection and try again.":"Incorrect 2FA PIN. Try again.";$("resetError").hidden=false;btn.disabled=true;return}
   await veltrixDB.setPassword(rp1.value);back();veltrixNotify("security","Your password was updated")}
  catch(e){const m=String((e&&e.message)||"");
   $("resetError").textContent=/different from the old|same_password/i.test(m)?"Choose a password you haven't used before.":/reauth|recent/i.test(m)?"For your security, log out and sign in again, then try again.":"Couldn't update your password. Please try again.";
   $("resetError").hidden=false;btn.disabled=false}
  finally{btn.textContent="Update password"}
 });
 const WARN=[["Your phrase controls your wallet","Anyone who has these words can take everything in your wallet. Keep them to yourself."],["Never share it","Veltrix will never ask for your phrase. Do not send it in chat, email or a screenshot, and do not give it to anyone, even if they say they are support."],["Make sure you are alone","Check that nobody can see your screen or camera, then write the words down on paper and keep them somewhere safe."]];
 let wi=0;
 function paintWarn(){$("pwTitle").textContent=WARN[wi][0];$("pwText").textContent=WARN[wi][1];[...$("pwSteps").children].forEach((d,i)=>d.classList.toggle("on",i===wi));$("pwNext").textContent=wi<WARN.length-1?"Next":"I understand, continue"}
 /* The app password must be confirmed BEFORE the warnings and the recovery phrase can be reached. */
 const ppw=$("phrasePw"),pgo=$("phrasePwGo"),perr=$("phrasePwError");let pTries=0,pLock=0,pBusy=false;
 function phrasePwClear(){if(!ppw)return;ppw.value="";ppw.type="password";perr.hidden=true;pgo.disabled=true;pgo.textContent="Continue";pBusy=false;
  document.querySelectorAll("#phrasePwPage .password-toggle").forEach(b=>{b.innerHTML=EYE_ICON;b.setAttribute("aria-pressed","false")})}
 ppw.addEventListener("input",()=>{perr.hidden=true;pgo.disabled=!ppw.value||pBusy});
 ppw.addEventListener("keydown",e=>{if(e.key==="Enter"&&!pgo.disabled)pgo.click()});
 $("securityPhrase").addEventListener("click",()=>{phrasePwClear();openPage("phrasePwPage");setTimeout(()=>ppw.focus(),150)});
 pgo.addEventListener("click",async()=>{
  if(pBusy||!ppw.value)return;
  const wait=Math.ceil((pLock-Date.now())/1000);
  if(wait>0){perr.textContent=`Too many attempts. Try again in ${wait}s.`;perr.hidden=false;return}
  pBusy=true;pgo.disabled=true;pgo.textContent="Checking…";
  let r={ok:false,error:true};try{r=await veltrixDB.verifyPassword(ppw.value)}catch{}
  pBusy=false;pgo.textContent="Continue";
  if(r.ok){pTries=0;back();wi=0;paintWarn();openPage("phraseWarnPage");return}
  ppw.value="";pgo.disabled=true;
  if(r.error){perr.textContent="Couldn't check your password. Check your connection and try again."}
  else{pTries++;if(pTries>=5){pLock=Date.now()+30000;pTries=0;perr.textContent="Too many attempts. Try again in 30s."}else perr.textContent="Incorrect password. Try again."}
  perr.hidden=false;ppw.focus();
 });
 $("pwNext").addEventListener("click",()=>{if(wi<WARN.length-1){wi++;paintWarn();return}back();openPhrase()});
 let words=null,shown=true;
 function paintPhrase(note){
  const g=$("rpGrid");
  if(!words){g.className="rp-grid empty";g.textContent=note||"";return}
  g.className="rp-grid"+(shown?"":" blur");
  g.replaceChildren(...words.map((w,i)=>{const r=document.createElement("span"),n=document.createElement("b"),t=document.createElement("em");n.textContent=i+1;t.textContent=w;r.append(n,t);return r}));
  $("rpToggleText").textContent=shown?"Hide":"Unhide";
 }
 function phraseWipe(){words=null;shown=true;const g=$("rpGrid");if(g){g.replaceChildren();g.className="rp-grid empty"}$("rpError").hidden=true}
 async function openPhrase(){
  words=null;shown=true;$("rpError").hidden=true;paintPhrase("Loading…");openPage("phrasePage");
  try{
   let r=await veltrixDB.wallet.myPhrase();
   if(r&&r.reason==="no_wallet"&&window.veltrixWallet){paintPhrase("Setting up your wallet…");try{await veltrixWallet.ensure()}catch{}r=await veltrixDB.wallet.myPhrase()}
   if(!r||!r.ok||!r.phrase){paintPhrase(r&&r.reason==="no_wallet"?(window.veltrixWallet&&veltrixWallet.waitingForPassword()?"Sign in with your password once to finish importing your wallet, then open this page again.":"Your wallet isn't ready yet. Please try again in a moment."):"Couldn't load your recovery phrase.");return}
   words=String(r.phrase).trim().split(/\s+/);paintPhrase();
  }catch(e){console.error("recovery phrase",e);paintPhrase("Couldn't load your recovery phrase. Make sure schema_phase21_security_phrase.sql has been run in Supabase.")}
 }
 $("rpToggle").addEventListener("click",()=>{if(!words)return;shown=!shown;paintPhrase()});
 $("rpCopy").addEventListener("click",async()=>{if(!words)return;try{await navigator.clipboard.writeText(words.join(" "));toast("Recovery phrase copied")}catch{toast("Copy not supported")}});
 document.addEventListener("visibilitychange",()=>{if(document.hidden&&words&&shown){shown=false;paintPhrase()}});
 /* ---- linked devices ---- */
 const ICON={desktop:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>'};
 function detect(){const u=navigator.userAgent;
  const br=/Edg\//.test(u)?"Microsoft Edge":/OPR\//.test(u)?"Opera":/SamsungBrowser/.test(u)?"Samsung Internet":/Firefox\//.test(u)?"Firefox":/Chrome\//.test(u)?"Google Chrome":/Safari\//.test(u)?"Safari":"Browser";
  const os=/Windows/.test(u)?"Windows":/Android/.test(u)?"Android":/iPhone|iPad|iPod/.test(u)?"iOS":/Mac OS/.test(u)?"macOS":/Linux/.test(u)?"Linux":"Unknown OS";
  return{name:`${br} (${os})`,os,icon:/Android|iPhone|iPad|iPod/.test(u)?"phone":"desktop"}}
 let devList=[],devErr="";
 async function refreshDevices(){devErr="";try{await veltrixDB.devices.register();devList=await veltrixDB.devices.list()}catch(e){devErr=(e&&e.message)||"unknown error";console.error("Could not load devices",e)}}
 const when=t=>{try{return new Date(t).toLocaleString(undefined,{month:"long",day:"numeric",hour:"numeric",minute:"2-digit"})}catch{return""}};
 const esc2=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
 function paintDevices(){const d=devList;if(devErr){$("deviceList").innerHTML=`<p style="padding:16px;line-height:1.5">Couldn't load your devices (${esc2(devErr)}). Make sure schema_phase3_devices.sql has been run in Supabase.</p>`;return}$("deviceList").innerHTML=d.map(x=>`<button type="button" class="sx-dev" data-id="${esc2(x.id)}"><span class="sx-dev-ic">${ICON[x.icon]||ICON.desktop}</span><span class="sx-grow"><strong>${esc2(x.name)}${x.current?" · This device":""}</strong><small>Last active ${esc2(when(x.last))}</small></span></button>`).join("")}
 let devPoll=null;
 async function openDevices(){paintDevices();openPage("devicesPage");await refreshDevices();paintDevices();
  clearInterval(devPoll);devPoll=setInterval(async()=>{if($("devicesPage").hidden){clearInterval(devPoll);return}await refreshDevices();paintDevices()},20000)}
 $("settingsDevices").addEventListener("click",openDevices);
 let editing=null;
 $("deviceList").addEventListener("click",e=>{const b=e.target.closest(".sx-dev");if(!b)return;editing=b.dataset.id;paintEdit();openPage("deviceEditPage")});
 function paintEdit(){const x=devList.find(z=>z.id===editing);if(!x)return;$("deviceBigIcon").innerHTML=ICON[x.icon]||ICON.desktop;$("deviceName").textContent=x.name;$("deviceLast").textContent=when(x.last);$("devicePlatform").textContent=x.name}
 $("deviceRename").addEventListener("click",async()=>{const x=devList.find(z=>z.id===editing);if(!x)return;const v=await dialog({title:"Rename device",value:x.name,input:true,ok:"Save"});if(v){try{await veltrixDB.devices.rename(x.id,v);x.name=v;paintEdit();paintDevices()}catch{toast("Couldn't rename this device. Please try again.")}}});
 $("deviceLogout").addEventListener("click",async()=>{const x=devList.find(z=>z.id===editing);if(!x)return;
  const ok=await dialog({title:"Log out of this device?",msg:x.current?"You will be signed out of Veltrix on this device.":`${x.name} will be signed out of your account straight away.`,ok:"Log out",danger:true});if(!ok)return;
  if(x.current){closeAll();$("settingsLogout").click();return}
  try{await veltrixDB.devices.revoke(x.id);devList=devList.filter(z=>z.id!==x.id);back();paintDevices();veltrixNotify("security","Device logged out")}
  catch{toast("Couldn't log out that device. Please try again.")}});
 /* invite friends: the QR (and the copyable link) simply hold the website address, so a friend can scan it with
    any QR scanner, land on the site and register. Change the address here if the domain ever changes. */
 const INVITE_URL="https://veltrixweb3.online";
 $("linkDeviceBtn").addEventListener("click",()=>{
  const t=$("linkQrImage");t.replaceChildren();VeltrixQR.render(t,INVITE_URL,{size:240});
  $("linkCode").textContent=INVITE_URL;$("linkCode").dataset.raw=INVITE_URL;
  openPage("linkQrPage");
 });
 $("copyLinkCode").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(INVITE_URL);toast("Invite link copied")}catch{toast("Copy not supported")}});
 /* ---- notifications ---- */
 function paintNotif(){const p=prefs();$("notifTopicList").innerHTML=TOPICS.map(t=>`<div class="sx-card"><span class="sx-grow"><strong>${t[1]}</strong><small>${t[2]}</small></span><label class="sx-switch"><input type="checkbox" data-t="${t[0]}" aria-label="${t[1]}"${p[t[0]]?" checked":""}><i></i></label></div>`).join("");const v=$("aiVoiceToggle");if(v)v.checked=voiceOn()}
 $("settingsNotifications").addEventListener("click",()=>{paintNotif();openPage("notifPage")});
 $("notifTopicList").addEventListener("change",e=>{const i=e.target.closest("input[data-t]");if(!i)return;const p=prefs();p[i.dataset.t]=i.checked;set("veltrixNotif",p)});
 $("aiVoiceToggle").addEventListener("change",e=>{set("veltrixAIVoice",e.target.checked);setDevVoice(e.target.checked);if(e.target.checked)window.veltrixSpeak("AI voice assistant enabled.");else if("speechSynthesis" in window)window.speechSynthesis.cancel()});
 // Try to speak immediately when the login screen loads. Browsers may block autoplay audio;
 // if blocked, retry on the first interaction without requiring the user to focus a field.
 const loginGuide=()=>window.veltrixSpeak("Welcome to Veltrix. Enter your email address and password to log in, or use fingerprint login if you have enabled it on this device.");
 let loginGuided=false;const tryLoginGuide=()=>{if(loginGuided||!$("loginPage")||$("loginPage").classList.contains("hidden"))return;loginGuided=!!loginGuide();};
 if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>setTimeout(tryLoginGuide,250),{once:true});else setTimeout(tryLoginGuide,250);
 ["pointerdown","keydown","touchstart"].forEach(ev=>document.addEventListener(ev,()=>{if(!loginGuided)tryLoginGuide()},{once:true,passive:true}));
 const loginPage=$("loginPage");if(loginPage)loginPage.addEventListener("click",e=>{if(!loginGuided&&e.target.closest("#loginForm,#fingerprintLoginButton"))tryLoginGuide()});

 /* ---- day & night mode ---- */
 const themeRow=$("settingsTheme");
 const SUN='<svg viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',MOON='<svg viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
 function paintTheme(){const dark=document.documentElement.getAttribute("data-theme")==="dark";$("themeSwitch").classList.toggle("on",dark);themeRow.setAttribute("aria-checked",String(dark));$("themeState").textContent=dark?"Night mode is on":"Day mode is on";$("themeIcon").innerHTML=dark?MOON:SUN;
  if(window.veltrixSyncChrome)veltrixSyncChrome()}
 themeRow.addEventListener("click",()=>{const dark=document.documentElement.getAttribute("data-theme")!=="dark";
  if(dark)document.documentElement.setAttribute("data-theme","dark");else document.documentElement.removeAttribute("data-theme");
  veltrixDB.pref.set("theme",dark?"dark":"light");try{localStorage.setItem("veltrixTheme",dark?"dark":"light")}catch{}paintTheme()});
 window.addEventListener("veltrix-ready",()=>{if(!(veltrixDB.get&&veltrixDB.get()))return;const d=veltrixDB.pref.get("theme","dark")!=="light";if(d)document.documentElement.setAttribute("data-theme","dark");else document.documentElement.removeAttribute("data-theme");try{localStorage.setItem("veltrixTheme",d?"dark":"light")}catch{}paintTheme()});
 paintTheme();
 /* ---- support team (WhatsApp) ---- */
 const SUPPORT_WHATSAPP="";/* <-- put your support number here, digits only with country code, e.g. "2348012345678" */
 $("settingsSupport").addEventListener("click",async()=>{
  const ok=await dialog({title:"Contact support team?",msg:"Do you want to proceed and contact the support team on WhatsApp?",ok:"Proceed",cancel:"Cancel"});
  if(!ok)return;
  const url="https://wa.me/"+SUPPORT_WHATSAPP.replace(/\D/g,"")+"?text="+encodeURIComponent("Hello Veltrix Support, I need some help.");
  if(!window.open(url,"_blank","noopener"))location.href=url;
 });
 /* hook existing success toasts to the notification settings */
 const old=window.wdToast;
})();
