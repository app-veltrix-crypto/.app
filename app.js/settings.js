/* Settings sub-sections: language, two-step verification (4-digit PIN), linked devices, notifications. */
(function(){
 const $=id=>document.getElementById(id);
 const get=(k,d)=>veltrixDB.pref.get(k,d);
 const set=(k,v)=>veltrixDB.pref.set(k,v);
 const toast=m=>{try{wdToast(m)}catch{}};
 /* ---- notification gate used by the rest of the app ---- */
 const TOPICS=[["security","Security alerts","Sign-ins, PIN and account protection"],["chat","Chat messages","New messages and mentions"],["transaction","Transaction alerts","Conversions and wallet activity"],["withdrawal","Withdrawal alerts","Funds sent from your wallet"],["deposit","Deposit alerts","Funds received in your wallet"],["price","Price alerts","Big moves in coins you follow"],["login","Login activity","New device and location logins"],["promo","Promotions & offers","Deals, rewards and campaigns"],["news","News & updates","Product news and announcements"]];
 const prefs=()=>Object.assign({},...TOPICS.map(t=>({[t[0]]:true})),get("veltrixNotif",{}));
 window.veltrixNotify=function(topic,msg,title){if(prefs()[topic]===false)return false;toast(msg);if(window.veltrixActivity)veltrixActivity.push(topic,msg,title);return true};
 /* ---- navigation ---- */
 const stack=[];
 const pages=["twoStepPage","pinPage","devicesPage","linkQrPage","deviceEditPage","notifPage"];
 function openPage(id){const el=$(id);el.hidden=false;el.scrollTop=0;stack.push(id)}
 function back(){const id=stack.pop();if(id)$(id).hidden=true;if(id==="linkQrPage")linkQrDone()}
 function closeAll(){while(stack.length)$(stack.pop()).hidden=true}
 document.querySelectorAll("[data-sx-back]").forEach(b=>b.addEventListener("click",()=>{const top=stack[stack.length-1];if(top==="pinPage"){pinCancel();return}back()}));
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&stack.length&&!document.querySelector(".sx-dlg:not([hidden])")){if(stack[stack.length-1]==="pinPage")pinCancel();else back()}});
 ["settingsLogout","logoutButton"].forEach(id=>{const b=$(id);if(b)b.addEventListener("click",closeAll)});
 /* ---- generic dialog ---- */
 function dialog(o){return new Promise(res=>{
  const d=document.createElement("div");d.className="profile-ui-edit-dialog sx-dlg";
  d.innerHTML=`<div class="profile-ui-dialog-card" role="dialog" aria-modal="true"><h2></h2><p class="sx-dlg-msg" style="margin:0;font-size:13px;color:#7b7d85;line-height:1.5"></p>${o.input?'<input maxlength="40" autocomplete="off" style="margin-top:12px">':''}<div class="profile-ui-dialog-actions"><button type="button" data-n>${o.cancel||"Cancel"}</button><button type="button" data-y${o.danger?' style="background:#e5484d"':""}>${o.ok||"OK"}</button></div></div>`;
  d.querySelector("h2").textContent=o.title;const m=d.querySelector(".sx-dlg-msg");if(o.msg)m.textContent=o.msg;else m.remove();
  const inp=d.querySelector("input");if(inp)inp.value=o.value||"";
  const done=v=>{d.remove();res(v)};
  d.querySelector("[data-n]").onclick=()=>done(null);
  d.querySelector("[data-y]").onclick=()=>{if(inp){const v=inp.value.trim();if(!v){inp.focus();return}done(v)}else done(true)};
  d.addEventListener("click",e=>{if(e.target===d)done(null)});
  document.body.appendChild(d);if(inp)setTimeout(()=>{inp.focus();inp.select()},40);
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
 function paintDevices(){const d=devList;if(devErr){$("deviceList").innerHTML=`<p style="padding:16px;line-height:1.5">Couldn't load your devices (${esc2(devErr)}). Make sure schema_phase3_devices.sql has been run in Supabase.</p>`;return}$("deviceList").innerHTML=d.map(x=>`<button type="button" class="sx-dev" data-id="${esc2(x.id)}"><span class="sx-dev-ic">${ICON[x.icon]||ICON.desktop}</span><span class="sx-grow"><strong>${esc2(x.name)}${x.current?" · This device":""}${x.linked?" · Linked":""}</strong><small>${x.linked&&x.expires?"Linked session ends "+esc2(when(x.expires)):"Last active "+esc2(when(x.last))}</small></span></button>`).join("")}
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
 /* link a device: QR in the same card style as the receive-crypto QR.
    The QR carries this account's email + a one-time code (valid 2 minutes, replaced automatically). */
 let linkTimer=null,linkTick=null,linkGen=0;
 function linkQrDone(){clearTimeout(linkTimer);clearInterval(linkTick);linkGen++}
 async function showLinkQr(){
  const gen=++linkGen,t=$("linkQrImage");clearTimeout(linkTimer);clearInterval(linkTick);
  $("linkCode").textContent="…";
  try{
   const {email,code}=await veltrixDB.link.create();
   if(gen!==linkGen)return;
   $("linkCode").textContent=code.replace(/(.{4})(?=.)/g,"$1-");$("linkCode").dataset.raw=code;
   t.replaceChildren();VeltrixQR.render(t,"veltrix://link?e="+encodeURIComponent(email)+"&c="+code,{size:240});
   const end=Date.now()+2*60*1000;
   const tick=()=>{const left=Math.max(0,Math.round((end-Date.now())/1000));const el=$("linkExpiry");if(el)el.textContent="New code in "+Math.floor(left/60)+":"+String(left%60).padStart(2,"0")};
   tick();linkTick=setInterval(tick,1000);
   linkTimer=setTimeout(()=>{if(!$("linkQrPage").hidden)showLinkQr()},end-Date.now());
  }catch(e){
   if(gen!==linkGen)return;t.textContent="Couldn't create a link code. Make sure schema_phase5_link_login.sql has been run in Supabase.";console.error("link code",e);
  }
 }
 $("linkDeviceBtn").addEventListener("click",()=>{
  if(veltrixDB.isLinked&&veltrixDB.isLinked()){toast("A device signed in by QR can't link other devices");return}
  const t=$("linkQrImage");t.replaceChildren();
  if(!$("linkExpiry")){const p=document.createElement("p");p.id="linkExpiry";p.style.cssText="margin:8px 0 0;font-size:12px;color:#7b7d85;text-align:center";$("linkCode").parentElement.insertAdjacentElement("afterend",p)}
  openPage("linkQrPage");showLinkQr();
 });
 $("copyLinkCode").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("linkCode").dataset.raw||$("linkCode").textContent);toast("Link code copied")}catch{toast("Copy not supported")}});
 /* ---- notifications ---- */
 const NT_GROUPS=[["Account & security",["security","login"]],["Money",["transaction","deposit","withdrawal","price"]],["Messages & updates",["chat","promo","news"]]];
 function ntCount(){const p=prefs(),on=TOPICS.filter(t=>p[t[0]]).length,el=$("ntCount");if(el)el.textContent=on+" of "+TOPICS.length+" topics on"}
 function paintNotif(){const p=prefs(),ic=k=>(window.veltrixActivity&&veltrixActivity.topicSvg)?veltrixActivity.topicSvg(k):"";
  $("notifTopicList").innerHTML=NT_GROUPS.map(g=>`<div class="nt-label">${g[0]}</div><div class="nt-group">${g[1].map(k=>{const t=TOPICS.find(x=>x[0]===k);return `<div class="nt-row"><span class="nt-ic t-${k}">${ic(k)}</span><span class="sx-grow"><strong>${t[1]}</strong><small>${t[2]}</small></span><label class="sx-switch"><input type="checkbox" data-t="${k}" aria-label="${t[1]}"${p[k]?" checked":""}><i></i></label></div>`}).join("")}</div>`).join("");
  ntCount()}
 $("settingsNotifications").addEventListener("click",()=>{paintNotif();openPage("notifPage")});
 $("notifTopicList").addEventListener("change",e=>{const i=e.target.closest("input[data-t]");if(!i)return;const p=prefs();p[i.dataset.t]=i.checked;set("veltrixNotif",p);ntCount()});

 /* ---- day & night mode ---- */
 const themeRow=$("settingsTheme");
 const SUN='<svg viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',MOON='<svg viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
 function paintTheme(){const dark=document.documentElement.getAttribute("data-theme")==="dark";$("themeSwitch").classList.toggle("on",dark);themeRow.setAttribute("aria-checked",String(dark));$("themeState").textContent=dark?"Night mode is on":"Day mode is on";$("themeIcon").innerHTML=dark?MOON:SUN;
  if(window.veltrixSyncChrome)veltrixSyncChrome()}
 themeRow.addEventListener("click",()=>{const dark=document.documentElement.getAttribute("data-theme")!=="dark";
  if(dark)document.documentElement.setAttribute("data-theme","dark");else document.documentElement.removeAttribute("data-theme");
  veltrixDB.pref.set("theme",dark?"dark":"light");paintTheme()});
 window.addEventListener("veltrix-ready",()=>{if(veltrixDB.pref.get("theme","light")==="dark")document.documentElement.setAttribute("data-theme","dark");else document.documentElement.removeAttribute("data-theme");paintTheme()});
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
