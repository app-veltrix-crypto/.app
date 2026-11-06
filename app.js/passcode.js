/* Passcode login. Once two-step verification is on, coming back to the app (opening it, locking after 30 s away, or logging out)
   shows this screen instead of email + password: the fingerprint prompt opens by itself and, if it is cancelled, the 4-digit
   two-step PIN unlocks the app. Accounts without two-step verification keep the normal email + password sign-in. */
(function(){
 "use strict";
 const $=id=>document.getElementById(id);
 const page=$("passcodePage");if(!page)return;
 const dots=[...$("pcDots").querySelectorAll("i")],msg=$("pcMsg");
 let code="",busy=false,tries=0,lockUntil=0,lockTimer=0;

 const wanted=()=>!!(window.veltrixTwoStep&&veltrixTwoStep.isOn());
 const visible=()=>!page.classList.contains("hidden");
 const locked=()=>Date.now()<lockUntil;

 function paint(){dots.forEach((d,i)=>d.classList.toggle("on",i<code.length));$("pcDots").setAttribute("aria-label",code.length+" of 4 digits entered")}
 function say(text,kind){msg.hidden=!text;msg.textContent=text||"";msg.classList.toggle("bad",kind==="bad"||kind==="error")}
 function pad(off){page.querySelectorAll("#pcPad button").forEach(b=>{if(b.id!=="pcFp")b.disabled=!!off})}
 function wrong(){const d=$("pcDots");d.classList.add("bad");d.classList.remove("shake");void d.offsetWidth;d.classList.add("shake");setTimeout(()=>{d.classList.remove("bad","shake");code="";paint()},420)}

 function startLock(){
  clearInterval(lockTimer);
  const tick=()=>{const s=Math.ceil((lockUntil-Date.now())/1000);
   if(s<=0){clearInterval(lockTimer);tries=0;pad(false);say("");return}
   pad(true);say(`Too many attempts. Try again in ${s}s.`,"bad")};
  tick();lockTimer=setInterval(tick,1000);
 }

 async function submit(){
  if(busy||code.length!==4||locked())return;
  busy=true;
  let r={ok:false,error:true};try{r=await veltrixDB.pin.check(code)}catch{}
  busy=false;
  if(r.ok){tries=0;code="";paint();say("");showDashboard();return}
  if(r.error){code="";paint();say("Couldn't check your passcode. Check your connection and try again.","bad");return}
  tries++;wrong();
  if(tries>=5){lockUntil=Date.now()+30000;startLock()}
  else say(`Incorrect passcode. ${5-tries} ${5-tries===1?"attempt":"attempts"} left.`,"bad");
 }
 function push(k){if(busy||locked()||code.length>=4)return;code+=k;paint();if(msg.classList.contains("bad")&&!locked())say("");if(code.length===4)setTimeout(submit,120)}
 function pop(){if(busy||locked()||!code)return;code=code.slice(0,-1);paint()}

 /* Keys react on pointerdown: the app blocks any tap that comes within 320 ms of the last one (double-tap zoom guard), which would
    swallow quickly typed digits if the keys waited for a click. A click that is not preceded by a press (keyboard) still works. */
 let lastDown=0;
 const act=b=>{if(b.dataset.k)push(b.dataset.k);else if(b.id==="pcDel")pop();else if(b.id==="pcFp")loginWithFingerprint()};
 $("pcPad").addEventListener("pointerdown",e=>{const b=e.target.closest("button");if(!b||b.disabled)return;e.preventDefault();lastDown=Date.now();act(b)});
 $("pcPad").addEventListener("click",e=>{const b=e.target.closest("button");if(!b||b.disabled||Date.now()-lastDown<700)return;act(b)});
 document.addEventListener("keydown",e=>{if(!visible()||e.ctrlKey||e.metaKey||e.altKey)return;
  if(/^[0-9]$/.test(e.key))push(e.key);else if(e.key==="Backspace")pop()});

 $("pcForgot").addEventListener("click",async()=>{
  const ok=await veltrixDialog({title:"Forgot passcode?",msg:"You will be signed out on this device. Sign in again with your email and password to continue.",ok:"Sign out",danger:true});
  if(!ok)return;
  const a=getAccount();try{await veltrixDB.signOut()}catch{}
  clearInterval(lockTimer);code="";tries=0;lockUntil=0;paint();say("");
  document.getElementById("loginPassword").value="";showPage("loginPage");
  if(a)document.getElementById("loginEmail").value=a.email||"";
 });

 function show(a){
  code="";busy=false;paint();say("");pad(false);
  $("pcFp").hidden=!(typeof fpReady==="function"&&fpReady(a));
  showPage("passcodePage");
  if(locked())startLock();
 }
 window.veltrixPasscode={wanted,visible,show,say};
})();
