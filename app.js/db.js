/* Veltrix · Supabase data layer.
   Everything the app stores lives in the Supabase database / storage: account, wallet, settings, PIN, chats, media.
   The only thing the browser keeps is the Supabase sign-in token (set keepSignedIn:false in supabase-config.js to
   hold it in memory only, which signs the user out on every page refresh). */
(function(){
"use strict";
const cfg=window.VELTRIX_SUPABASE||{};
const memStore=(()=>{const m=new Map();return{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>{m.set(k,v)},removeItem:k=>{m.delete(k)}}})();
/* Linked sessions (signed in by scanning another account's QR) must leave NOTHING behind: while linkedMode is on, the
   sign-in token lives in memory only, so closing or refreshing the page signs that device out. */
let linkedMode=false;
const authStore={
  getItem:k=>linkedMode?memStore.getItem(k):localStorage.getItem(k),
  setItem:(k,v)=>{if(linkedMode)memStore.setItem(k,v);else localStorage.setItem(k,v)},
  removeItem:k=>{memStore.removeItem(k);try{localStorage.removeItem(k)}catch{}}
};
const sb=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:cfg.keepSignedIn!==false,autoRefreshToken:true,
  storage:cfg.keepSignedIn===false?memStore:authStore}});
let linkExpiryTimer=null,linkSuppress=false;
const fire=n=>window.dispatchEvent(new Event(n));

/* ================= account / wallet ================= */
let cache=null,prefs={},prefTimer=null,pendingImage=null;
const toAccount=(p,assets)=>({
  id:p.id,email:p.email,fullName:p.full_name,location:p.location||"",dateOfBirth:p.date_of_birth||"",
  profileImage:p.profile_image||"",profileAbout:p.profile_about||"",profileUsername:p.profile_username||"",
  profilePhone:p.profile_phone||"",profileLinks:p.profile_links||"",fingerprintEnabled:!!p.fingerprint_enabled,
  isAdmin:!!p.is_admin,createdAt:p.created_at,
  assets:(assets||[]).map(a=>({symbol:a.symbol,name:a.name||undefined,amount:Number(a.amount)}))
});
const toRow=a=>({full_name:a.fullName,location:a.location||null,date_of_birth:a.dateOfBirth||null,
  profile_image:a.profileImage||null,profile_about:a.profileAbout||"",profile_username:a.profileUsername||"",
  profile_phone:a.profilePhone||"",profile_links:a.profileLinks||"",fingerprint_enabled:!!a.fingerprintEnabled});

async function load(){
  const {data:{session}}=await sb.auth.getSession();
  if(!session){cache=null;return null}
  const uid=session.user.id;
  const [p,a,s]=await Promise.all([
    sb.from("profiles").select("*").eq("id",uid).single(),
    sb.from("assets").select("symbol,name,amount").eq("user_id",uid),
    sb.from("user_settings").select("data").eq("user_id",uid).maybeSingle()
  ]);
  if(p.error)throw p.error;
  cache=toAccount(p.data,a.data);
  prefs=(s.data&&s.data.data)||{};
  if(!cache.profileImage){const img=pendingImage||takePhoto(cache.email);
    if(img){cache.profileImage=img;pendingImage=null;if(await saveProfileNow())stashPhoto(cache.email,null)}}
  return cache;
}
async function reloadWallet(){const uid=cache&&cache.id;if(!uid)return null;
  const a=await sb.from("assets").select("symbol,name,amount").eq("user_id",uid);
  if(!a.error){cache.assets=a.data.map(x=>({symbol:x.symbol,name:x.name||undefined,amount:Number(x.amount)}))}
  return cache}

async function saveProfileNow(){if(!cache)return false;
  for(let i=0;i<3;i++){
    const {data,error}=await sb.from("profiles").update(toRow(cache)).eq("id",cache.id).select("id");
    if(!error&&data&&data.length)return true;
    console.error("Profile save failed",error||"no rows were updated");
    await new Promise(r=>setTimeout(r,500*(i+1)));
  }
  return false}
/* The photo chosen at sign-up is kept (per email) until it has really been saved to the profile, so it also survives
   the "confirm your email" step and a page reload. */
const PHOTO_KEY="veltrixPendingPhoto";
function stashPhoto(email,img){try{if(img)localStorage.setItem(PHOTO_KEY,JSON.stringify({e:String(email||"").toLowerCase(),i:img,t:Date.now()}));else localStorage.removeItem(PHOTO_KEY)}catch{}}
function takePhoto(email){try{const j=JSON.parse(localStorage.getItem(PHOTO_KEY)||"null");if(!j)return null;if(Date.now()-j.t>7*864e5){localStorage.removeItem(PHOTO_KEY);return null}return j.e===String(email||"").toLowerCase()?j.i:null}catch{return null}}
let pushTimer=null;
function push(){clearTimeout(pushTimer);pushTimer=setTimeout(async()=>{
  if(!cache)return;
  const {error}=await sb.from("profiles").update(toRow(cache)).eq("id",cache.id);
  if(error)console.error("Profile save failed",error);
},400)}

/* ================= settings (replaces every old localStorage setting) ================= */
const pref={
  get(k,d){return Object.prototype.hasOwnProperty.call(prefs,k)?prefs[k]:d},
  set(k,v){prefs[k]=v;clearTimeout(prefTimer);prefTimer=setTimeout(async()=>{
    if(!cache)return;
    const {error}=await sb.from("user_settings").upsert({user_id:cache.id,data:prefs,updated_at:new Date().toISOString()});
    if(error)console.error("Settings save failed",error);
  },400)}
};

/* ================= chat sync (shared by the user app and the admin page) =================
   data = { <userId>: { convs: { <contactId>: { ...meta, msgs:[...] } } } }
   The UI code keeps editing these objects and calls save(); save() works out what changed and writes only that. */
function ChatSync(scopeUid){
  this.scope=scopeUid||null;this.data={};this.snap={};this.timer=null;this.chan=null;this.evT=null;this.saving=Promise.resolve();
  this.qd=false;this.flushing=0;this.pulling=false;this.stopped=false;this.poll=null;this.relT=null;this.lastFull=Date.now();
}
const metaOf=c=>{const m={};for(const k in c)if(k!=="msgs")m[k]=c[k];return m};
async function fetchAll(table,scope,order){
  const out=[];for(let from=0;;from+=1000){
    let q=sb.from(table).select("*");if(scope)q=q.eq("user_id",scope);if(order)q=q.order(order);
    const {data,error}=await q.range(from,from+999);if(error)throw error;out.push(...data);if(data.length<1000)break}
  return out}
ChatSync.prototype.ensure=function(uid,cid){
  const u=this.data[uid]||(this.data[uid]={convs:{}});
  const c=u.convs[cid]||(u.convs[cid]={msgs:[]});if(!Array.isArray(c.msgs))c.msgs=[];
  const s=(this.snap[uid]||(this.snap[uid]={}));s[cid]=s[cid]||{meta:"{}",msgs:{}};return c};
ChatSync.prototype.load=async function(){
  this.lastFull=Date.now();
  const [cv,ms]=await Promise.all([fetchAll("conversations",this.scope),fetchAll("messages",this.scope,"t")]);
  this.data={};this.snap={};
  for(const r of cv){const c=this.ensure(r.user_id,r.contact_id);Object.assign(c,r.data||{});c.msgs=[];this.snap[r.user_id][r.contact_id].meta=JSON.stringify(metaOf(c))}
  for(const r of ms){const c=this.ensure(r.user_id,r.contact_id);c.msgs.push(r.data);this.snap[r.user_id][r.contact_id].msgs[r.data.id]=JSON.stringify(r.data)}
  for(const uid in this.data)for(const cid in this.data[uid].convs){const s=this.snap[uid][cid];if(s.meta==null)s.meta=JSON.stringify(metaOf(this.data[uid].convs[cid]))}
};
ChatSync.prototype.save=function(){const me=this;me.qd=true;clearTimeout(me.timer);me.timer=setTimeout(()=>{me.qd=false;me.flushing++;me.saving=me.saving.then(()=>me.flush()).catch(e=>console.error("Chat save failed",e)).then(()=>{me.flushing--})},150)};
ChatSync.prototype.dirty=function(){return this.qd||this.flushing>0};
ChatSync.prototype.flush=async function(){
  const convUp=[],msgUp=[],msgDel=[],convDel=[],media=[];
  for(const uid in this.data){
    const convs=this.data[uid].convs,s=this.snap[uid]||(this.snap[uid]={});
    for(const cid in convs){
      const c=convs[cid],sc=s[cid]||(s[cid]={meta:null,msgs:{}}),meta=JSON.stringify(metaOf(c));
      if(meta!==sc.meta){convUp.push({user_id:uid,contact_id:cid,data:metaOf(c)});sc.meta=meta}
      const seen={};
      for(const m of c.msgs){if(!m||!m.id)continue;seen[m.id]=1;const j=JSON.stringify(m);
        if(sc.msgs[m.id]!==j){msgUp.push({id:m.id,user_id:uid,contact_id:cid,t:Math.round(m.t||Date.now()),data:m});sc.msgs[m.id]=j}}
      for(const id in sc.msgs)if(!seen[id]){msgDel.push(id);try{if(JSON.parse(sc.msgs[id]).type!=="text")media.push(uid+"/"+id)}catch{}delete sc.msgs[id]}
    }
    for(const cid in s)if(!convs[cid]){for(const id in s[cid].msgs){try{if(JSON.parse(s[cid].msgs[id]).type!=="text")media.push(uid+"/"+id)}catch{}}convDel.push([uid,cid]);delete s[cid]}
  }
  if(convUp.length){const {error}=await sb.from("conversations").upsert(convUp);if(error)throw error}
  for(let i=0;i<msgUp.length;i+=200){const {error}=await sb.from("messages").upsert(msgUp.slice(i,i+200));if(error)throw error}
  if(msgDel.length){const {error}=await sb.from("messages").delete().in("id",msgDel);if(error)throw error}
  for(const [u,c] of convDel){const {error}=await sb.from("conversations").delete().eq("user_id",u).eq("contact_id",c);if(error)throw error}
  if(media.length)sb.storage.from("chat-media").remove(media).catch(()=>{});
};
ChatSync.prototype.emit=function(){const me=this;clearTimeout(me.evT);me.evT=setTimeout(()=>fire(me.scope?"veltrix-chats":"veltrix-admin-chats"),60)};
ChatSync.prototype.subscribeChan=function(){
  const me=this,f=me.scope?{filter:"user_id=eq."+me.scope}:{};
  const ch=sb.channel("chats-"+(me.scope||"admin")+"-"+Math.random().toString(36).slice(2,7))
   .on("postgres_changes",{event:"*",schema:"public",table:"messages",...f},p=>{
     if(p.eventType==="DELETE"){const o=p.old||{};
       outer:for(const uid in me.data)for(const cid in me.data[uid].convs){const c=me.data[uid].convs[cid],i=c.msgs.findIndex(m=>m&&m.id===o.id);
         if(i>=0){c.msgs.splice(i,1);delete me.snap[uid][cid].msgs[o.id];break outer}}
     }else{const r=p.new,c=me.ensure(r.user_id,r.contact_id),i=c.msgs.findIndex(m=>m&&m.id===r.data.id);
       if(i>=0)c.msgs[i]=r.data;else{c.msgs.push(r.data);c.msgs.sort((a,b)=>(a.t||0)-(b.t||0))}
       me.snap[r.user_id][r.contact_id].msgs[r.data.id]=JSON.stringify(r.data)}
     me.emit()})
   .on("postgres_changes",{event:"*",schema:"public",table:"conversations",...f},p=>{
     if(p.eventType==="DELETE"){const o=p.old||{};if(me.data[o.user_id]){delete me.data[o.user_id].convs[o.contact_id];if(me.snap[o.user_id])delete me.snap[o.user_id][o.contact_id]}}
     else{const r=p.new,c=me.ensure(r.user_id,r.contact_id),msgs=c.msgs;for(const k in c)delete c[k];Object.assign(c,r.data||{});c.msgs=msgs;me.snap[r.user_id][r.contact_id].meta=JSON.stringify(metaOf(c))}
     me.emit()})
   .subscribe(st=>{
     /* the live connection dropped (phone slept, network changed...): reconnect and catch up instead of silently going deaf */
     if(me.stopped||me.chan!==ch)return;
     if(st==="CHANNEL_ERROR"||st==="TIMED_OUT"||st==="CLOSED"){clearTimeout(me.relT);me.relT=setTimeout(()=>{me.relisten();me.pull(true)},3000)}});
  me.chan=ch;
};
ChatSync.prototype.relisten=function(){const me=this;if(me.stopped)return;const old=me.chan;me.chan=null;if(old){try{sb.removeChannel(old)}catch(e){}}me.subscribeChan()};
ChatSync.prototype.listen=function(){const me=this;me.stopped=false;me.subscribeChan();me.startPoll()};
/* Safety net for the live connection: every few seconds (and whenever the app returns to the screen or the network comes back)
   check whether the server has messages this device doesn't have, and merge them in. Never overwrites anything still waiting to be saved. */
const stable=o=>JSON.stringify(o,(k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.keys(v).sort().reduce((a,x)=>(a[x]=v[x],a),{}):v);
ChatSync.prototype.startPoll=function(){const me=this;if(me.poll)return;
  me.poll=setInterval(()=>{if(!document.hidden)me.pull(false)},4000);
  me.onVis=()=>{if(!document.hidden){me.relisten();me.pull(true)}};
  me.onOnline=()=>{me.relisten();me.pull(true)};
  document.addEventListener("visibilitychange",me.onVis);window.addEventListener("online",me.onOnline)};
ChatSync.prototype.pull=async function(force){
  const me=this;if(me.stopped||me.pulling||me.dirty())return;me.pulling=true;
  try{
    let known=0;for(const u in me.snap)for(const c in me.snap[u])known+=Object.keys(me.snap[u][c].msgs||{}).length;
    if(!force&&Date.now()-me.lastFull<30000){
      let q=sb.from("messages").select("id",{count:"exact",head:true});if(me.scope)q=q.eq("user_id",me.scope);
      const {count,error}=await q;if(error||count==null||count===known)return}
    const [cv,ms]=await Promise.all([fetchAll("conversations",me.scope),fetchAll("messages",me.scope,"t")]);
    if(me.stopped||me.dirty())return;
    me.lastFull=Date.now();
    let changed=false;const touched=new Set(),srv=new Set();
    for(const r of cv){const c=me.ensure(r.user_id,r.contact_id),s=me.snap[r.user_id][r.contact_id],tmp=Object.assign({},r.data||{});
      if(JSON.stringify(metaOf(c))===s.meta&&stable(metaOf(c))!==stable(tmp)){const m=c.msgs;for(const k in c)delete c[k];Object.assign(c,tmp);c.msgs=m;s.meta=JSON.stringify(metaOf(c));changed=true}}
    for(const r of ms){const d=r.data;if(!d||!d.id)continue;srv.add(d.id);
      const c=me.ensure(r.user_id,r.contact_id),s=me.snap[r.user_id][r.contact_id],i=c.msgs.findIndex(m=>m&&m.id===d.id);
      if(i<0){c.msgs.push(d);s.msgs[d.id]=JSON.stringify(d);touched.add(c);changed=true}
      else if(s.msgs[d.id]!==undefined&&JSON.stringify(c.msgs[i])===s.msgs[d.id]&&stable(c.msgs[i])!==stable(d)){c.msgs[i]=d;s.msgs[d.id]=JSON.stringify(d);changed=true}}
    for(const u in me.data)for(const cid in me.data[u].convs){const c=me.data[u].convs[cid],s=me.snap[u]&&me.snap[u][cid];if(!s)continue;
      for(const id in s.msgs)if(!srv.has(id)){const i=c.msgs.findIndex(m=>m&&m.id===id);
        if(i<0||JSON.stringify(c.msgs[i])===s.msgs[id]){if(i>=0)c.msgs.splice(i,1);delete s.msgs[id];changed=true}}}
    for(const c of touched)c.msgs.sort((a,b)=>(a.t||0)-(b.t||0));
    if(changed)me.emit();
  }catch(e){console.warn("Chat refresh failed",e)}finally{me.pulling=false}
};
ChatSync.prototype.stop=function(){this.stopped=true;clearInterval(this.poll);this.poll=null;clearTimeout(this.relT);if(this.onVis){document.removeEventListener("visibilitychange",this.onVis);window.removeEventListener("online",this.onOnline);this.onVis=null}
  if(this.chan){const c=this.chan;this.chan=null;try{sb.removeChannel(c)}catch(e){}}clearTimeout(this.timer);this.data={};this.snap={}};

let mine=null,adminSync=null;
const chat={
  async start(uid){if(mine)mine.stop();mine=new ChatSync(uid);await mine.load();mine.listen();return mine},
  /* the signed-in user's own chats, in the shape the messaging screen uses: { convs:{ contactId:{ name, msgs:[…] } } } */
  store(){if(!mine)return{convs:{}};return mine.data[mine.scope]||(mine.data[mine.scope]={convs:{}})},
  save(){if(mine)mine.save()},
  stop(){if(mine){mine.stop();mine=null}}
};

/* ================= media (voice notes, photos, videos, files) ================= */
const MIME_BY_EXT={mp4:"video/mp4",m4v:"video/mp4",mov:"video/quicktime",webm:"video/webm",mkv:"video/x-matroska","3gp":"video/3gpp",avi:"video/x-msvideo",mp3:"audio/mpeg",m4a:"audio/mp4",ogg:"audio/ogg",wav:"audio/wav",jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",pdf:"application/pdf"};
const mimeOf=blob=>{const t=(blob&&blob.type||"").toLowerCase();if(t)return t;const e=String(blob&&blob.name||"").split(".").pop().toLowerCase();return MIME_BY_EXT[e]||"application/octet-stream"};
const media={
  /* Uploads with real progress (onProgress(0..1)) and automatic retries on a dropped connection. Resolves only when the server has the whole file. */
  put(uid,id,blob,onProgress){
    return new Promise((resolve,reject)=>{
      let tries=0;
      const retry=err=>{if(++tries<4)setTimeout(attempt,1500*tries);else reject(err)};
      async function attempt(){
        let token;try{const {data}=await sb.auth.getSession();token=data.session.access_token}catch{return reject(Object.assign(new Error("not signed in"),{status:401}))}
        const x=new XMLHttpRequest();
        x.open("POST",cfg.url+"/storage/v1/object/chat-media/"+uid+"/"+encodeURIComponent(id));
        x.setRequestHeader("Authorization","Bearer "+token);x.setRequestHeader("apikey",cfg.anonKey);
        x.setRequestHeader("x-upsert","true");x.setRequestHeader("cache-control","max-age=3600");x.setRequestHeader("Content-Type",mimeOf(blob));
        if(onProgress)x.upload.onprogress=e=>{if(e.lengthComputable)onProgress(e.loaded/e.total)};
        x.onload=()=>{if(x.status>=200&&x.status<300)resolve();else if(x.status>=500||x.status===408||x.status===429)retry(Object.assign(new Error("server "+x.status),{status:x.status}));else reject(Object.assign(new Error(x.responseText||("status "+x.status)),{status:x.status}))};
        x.onerror=()=>retry(Object.assign(new Error("network"),{status:0}));x.ontimeout=x.onerror;
        x.send(blob);
      }
      attempt();
    });
  },
  async get(uid,id){const {data,error}=await sb.storage.from("chat-media").download(uid+"/"+id);return error?null:data},
  /* A streaming link: videos start playing at once (the browser fetches only what it needs) and big files are never loaded into memory. download:"name" makes the browser save it as a file. */
  async url(uid,id,download){const {data,error}=await sb.storage.from("chat-media").createSignedUrl(uid+"/"+id,3600,download?{download:download}:undefined);return error||!data?null:data.signedUrl},
  async del(uid,id){try{await sb.storage.from("chat-media").remove([uid+"/"+id])}catch{}}
};

/* ================= admin ================= */
const admin={
  async start(){if(adminSync)adminSync.stop();adminSync=new ChatSync(null);await adminSync.load();adminSync.listen();return adminSync},
  raw(){return adminSync?adminSync.data:{}},
  save(){if(adminSync)adminSync.save()},
  async directory(){const out={};
    for(let from=0;;from+=1000){const {data,error}=await sb.from("profiles").select("id,full_name,email,profile_image,created_at").range(from,from+999);
      if(error)throw error;for(const p of data)out[p.id]={name:p.full_name||p.email||"User",photo:p.profile_image||"",t:Date.parse(p.created_at)||0};
      if(data.length<1000)break}
    return out}
};

/* ================= PIN (verified on the server) ================= */
const pin={
  async set(p){const {error}=await sb.rpc("pin_set",{p});if(error)throw error},
  async verify(p){const {data,error}=await sb.rpc("pin_verify",{p});return !error&&data===true},
  /* like verify(), but tells a wrong PIN apart from a connection problem (used by the passcode login) */
  async check(p){const {data,error}=await sb.rpc("pin_verify",{p});if(error)return{ok:false,error:true};return{ok:data===true}},
  async clear(p){const {data,error}=await sb.rpc("pin_clear",{p});return !error&&data===true}
};

/* ================= account wallet (TEST BUILD: the phrase is stored encrypted; the ADMIN can read it) ================= */
const wallet={
  async info(){const {data,error}=await sb.rpc("wallet_info");if(error)throw error;return data||{exists:false}},
  /* who owns this address? -> {found,self,name}. Only used to show the recipient before the user confirms. */
  async resolve(symbol,address){const {data,error}=await sb.rpc("wallet_resolve_recipient",{p_symbol:symbol,p_address:address});if(error)throw error;return data||{found:false}},
  /* real transfer to another Veltrix user. The SERVER checks the PIN, the balance and the recipient and moves the money in one step.
     Returns {ok:true,...} or {ok:false,reason}. Reusing the same request id can never move the money twice. */
  async transfer(symbol,amount,address,pin,requestId){const {data,error}=await sb.rpc("wallet_transfer",{p_symbol:symbol,p_amount:String(amount),p_address:address,p_pin:String(pin),p_request:requestId});if(error)throw error;return data||{ok:false,reason:"error"}},
  /* withdrawal to an OUTSIDE wallet (Binance, Bybit …). The server checks PIN, address, balance and limits and holds the amount.
     status "queued" = being sent automatically, "pending" = waiting for the admin. Same request id = never held twice. */
  async withdraw(symbol,amount,address,pin,requestId,memo){const args={p_symbol:symbol,p_amount:String(amount),p_address:address,p_pin:String(pin),p_request:requestId};if(memo)args.p_memo=String(memo);const {data,error}=await sb.rpc("wallet_withdraw",args);if(error)throw error;return data||{ok:false,reason:"error"}},
  /* ask the payout function to send a queued withdrawal now (it also runs on a schedule, so a failure here is harmless) */
  async sendQueued(id){try{await sb.functions.invoke("payout-send",{body:{id}})}catch{}},
  /* the signed-in user's own recovery phrase (Settings → Security → View passwords) */
  async myPhrase(){const {data,error}=await sb.rpc("wallet_my_phrase");if(error)throw error;return data||{ok:false,reason:"error"}},
  async importPhrase(phrase,addresses){const {data,error}=await sb.rpc("wallet_import",{p_phrase:phrase,p_addresses:addresses});if(error)throw error;return data},
  async ensure(phrase,addresses){const {data,error}=await sb.rpc("wallet_ensure",{p_phrase:phrase,p_addresses:addresses});if(error)throw error;return data},
  /* admin only */
  async testList(){const {data,error}=await sb.rpc("admin_test_wallets");if(error)throw error;return data||[]},
  async testPhrase(uid){const {data,error}=await sb.rpc("admin_test_wallet_phrase",{p_user:uid});if(error)throw error;return data}
};

/* ================= linked devices (one row per signed-in session; revoking kills that session) ================= */
let mySession=null,devChan=null,devTimer=null;
sb.auth.onAuthStateChange((ev,s)=>{mySession=s;if(ev==="SIGNED_OUT"&&cache&&!linkSuppress){cache=null;prefs={};chat.stop();stopDeviceWatch();fire("veltrix-revoked")}});
function curSid(){try{const t=mySession&&mySession.access_token;if(!t)return null;return JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).session_id||null}catch{return null}}
/* A random id that identifies THIS browser/phone, so signing in again updates its row instead of adding a new one.
   (The only thing kept in the browser besides the sign-in token; it contains no user data.) */
let memKey=null;
function deviceKey(){if(linkedMode)return memKey||(memKey=Math.random().toString(36).slice(2)+Date.now().toString(36)+Math.random().toString(36).slice(2));try{let k=localStorage.getItem("veltrixDeviceKey");if(!k){k=crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);localStorage.setItem("veltrixDeviceKey",k)}return k}catch{return memKey||(memKey=Math.random().toString(36).slice(2)+Date.now().toString(36))}}
function detectDevice(){const u=navigator.userAgent;
  const br=/Edg\//.test(u)?"Microsoft Edge":/OPR\//.test(u)?"Opera":/SamsungBrowser/.test(u)?"Samsung Internet":/Firefox\//.test(u)?"Firefox":/Chrome\//.test(u)?"Google Chrome":/Safari\//.test(u)?"Safari":"Browser";
  const os=/Windows/.test(u)?"Windows":/Android/.test(u)?"Android":/iPhone|iPad|iPod/.test(u)?"iOS":/Mac OS/.test(u)?"macOS":/Linux/.test(u)?"Linux":"Unknown OS";
  return{name:br+" ("+os+")",os,icon:/Android|iPhone|iPad|iPod/.test(u)?"phone":"desktop"}}
let notifChan=null,txChan=null;
function stopDeviceWatch(){clearInterval(devTimer);devTimer=null;if(devChan){sb.removeChannel(devChan);devChan=null}if(notifChan){sb.removeChannel(notifChan);notifChan=null}if(txChan){sb.removeChannel(txChan);txChan=null}}
function startNotifWatch(uid){
  if(notifChan){sb.removeChannel(notifChan);notifChan=null}
  notifChan=sb.channel("notif-"+uid).on("postgres_changes",{event:"*",schema:"public",table:"notifications",filter:"user_id=eq."+uid},p=>{
    window.dispatchEvent(new CustomEvent("veltrix-notif",{detail:{type:p.eventType,row:p.new&&p.new.id?p.new:null,old:p.old||null}}))}).subscribe()}
/* a new history row (money received from another user) or a withdrawal changing status: tell the app so history and balance refresh at once */
function startTxWatch(uid){
  if(txChan){sb.removeChannel(txChan);txChan=null}
  txChan=sb.channel("tx-"+uid).on("postgres_changes",{event:"*",schema:"public",table:"transactions",filter:"user_id=eq."+uid},p=>{
    window.dispatchEvent(new CustomEvent("veltrix-tx",{detail:{row:p.new||null,old:p.old||null}}))}).subscribe()}
function startDeviceWatch(uid){stopDeviceWatch();startNotifWatch(uid);startTxWatch(uid);
  devChan=sb.channel("devices-"+uid).on("postgres_changes",{event:"DELETE",schema:"public",table:"devices",filter:"user_id=eq."+uid},p=>{
    const o=p.old||{};if(o.session_id&&o.session_id===curSid()){veltrixDB.signOut().then(()=>fire("veltrix-revoked"))}}).subscribe();
  devTimer=setInterval(()=>devices.register(),5*60*1000)}
const devices={
  async register(){const d=detectDevice();const {error}=await sb.rpc("register_device",{p_key:deviceKey(),p_name:d.name,p_platform:d.os,p_icon:d.icon});if(error){console.error("Device registration failed",error);throw error}},
  async list(){const {data,error}=await sb.from("devices").select("*").order("last_active",{ascending:false});if(error)throw error;const sid=curSid();
    return data.map(x=>({id:x.id,name:x.name,platform:x.platform,icon:x.icon,last:Date.parse(x.last_active),current:x.session_id===sid,linked:!!x.linked,expires:x.expires_at?Date.parse(x.expires_at):0}))},
  async rename(id,name){const {error}=await sb.from("devices").update({name}).eq("id",id);if(error)throw error},
  async revoke(id){const {error}=await sb.rpc("revoke_device",{p_id:id});if(error)throw error}
};

/* ================= notifications, watchlist, transaction history ================= */
const uuid=()=>crypto.randomUUID?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==="x"?r:(r&3|8)).toString(16)});
const notif={
  async list(){const {data,error}=await sb.from("notifications").select("*").order("created_at",{ascending:false}).limit(300);if(error)throw error;return data||[]},
  /* the server checks the user's Notification settings; returns null when that topic is switched off */
  async push(topic,title,body,id){const {data,error}=await sb.rpc("notify_me",{p_id:id||uuid(),p_topic:topic,p_title:title,p_body:body});if(error)throw error;return data},
  async remove(id){const {error}=await sb.from("notifications").delete().eq("id",id);if(error)throw error},
  async markRead(id){const {error}=await sb.from("notifications").update({read:true}).eq("id",id);if(error)throw error},
  async markAllRead(){const {error}=await sb.from("notifications").update({read:true}).eq("read",false);if(error)throw error},
  uuid
};
const watch={
  async list(){const {data,error}=await sb.from("watchlist").select("symbol,coin_id,name,base_price");if(error)throw error;return data||[]},
  async add(r){const {error}=await sb.from("watchlist").upsert({user_id:cache.id,symbol:r.symbol,coin_id:r.coin_id,name:r.name||null,base_price:r.base_price});if(error)throw error},
  async remove(symbol){const {error}=await sb.from("watchlist").delete().eq("symbol",symbol);if(error)throw error},
  async rebase(symbol,price){const {error}=await sb.from("watchlist").update({base_price:price}).eq("symbol",symbol);if(error)throw error}
};
const tx={
  async list(wallet,limit){let q=sb.from("transactions").select("*").eq("wallet",wallet).order("created_at",{ascending:false});if(limit)q=q.limit(limit);const {data,error}=await q;if(error)throw error;return data||[]}
};

/* ================= link a device by QR ================= */
function endLinkedSession(){clearTimeout(linkExpiryTimer);linkExpiryTimer=null}
const link={
  /* on the account that SHOWS the QR: a fresh one-time code (valid ~2 minutes) tied to this account */
  async create(){const {data,error}=await sb.rpc("create_link_code");if(error)throw error;return {email:cache&&cache.email,code:data}},
  /* on the device that SCANS: the server checks email + code; only if both are right is the device signed in */
  async login(email,code){
    let res,j={};
    try{res=await fetch(cfg.url+"/functions/v1/link-login",{method:"POST",headers:{"Content-Type":"application/json",apikey:cfg.anonKey,Authorization:"Bearer "+cfg.anonKey},body:JSON.stringify({email,code})});j=await res.json().catch(()=>({}))}
    catch{throw new Error("Could not reach the server. Check your connection and try again.")}
    if(!res.ok||!j.token_hash){
      const st=res.status;
      throw new Error(j.error||(st===404?"The link service isn't available on the server yet.":st===401||st===403?"The server rejected the request. Please try again.":st>=500?"Server error. Please try again in a moment.":"This QR code is invalid or has expired. Ask for a new one."))}
    /* verified: now (and only now) leave the current account on this device and switch to the linked one */
    linkSuppress=true;
    try{
      cache=null;prefs={};chat.stop();stopDeviceWatch();if(adminSync){adminSync.stop();adminSync=null}
      try{await sb.auth.signOut({scope:"local"})}catch{}
      linkedMode=true;
      try{Object.keys(localStorage).filter(k=>k.startsWith("sb-")).forEach(k=>localStorage.removeItem(k))}catch{}
      const {error}=await sb.auth.verifyOtp({token_hash:j.token_hash,type:"magiclink"});
      if(error){linkedMode=false;throw new Error("Sign-in failed. Ask for a new QR code.")}
      const a=await load();if(!a){linkedMode=false;throw new Error("Sign-in failed. Ask for a new QR code.")}
      let exp=0;try{const d=detectDevice();const {data:ex,error:e2}=await sb.rpc("register_linked_device",{p_key:deviceKey(),p_name:d.name,p_platform:d.os,p_icon:d.icon});if(e2)throw e2;exp=ex?Date.parse(ex):0}
      catch(e){console.error("Linked device registration failed",e);await sb.auth.signOut({scope:"local"}).catch(()=>{});linkedMode=false;cache=null;throw new Error("Could not register this device. Ask for a new QR code.")}
      startDeviceWatch(a.id);
      try{await chat.start(a.id)}catch(e){console.error("Chats could not be loaded",e)}
      if(exp){clearTimeout(linkExpiryTimer);linkExpiryTimer=setTimeout(async()=>{try{await sb.rpc("purge_expired_devices")}catch{}await veltrixDB.signOut();fire("veltrix-revoked")},Math.max(1000,exp-Date.now()))}
      fire("veltrix-ready");
      return a;
    }finally{linkSuppress=false}
  }
};

async function boot(){const a=await load();if(a){try{await devices.register()}catch{}startDeviceWatch(a.id);try{await chat.start(a.id)}catch(e){console.error("Chats could not be loaded",e)}}else chat.stop();fire("veltrix-ready");return a}

window.veltrixDB={
  client:sb,pref,chat,media,admin,pin,wallet,devices,notif,watch,tx,deviceInfo:detectDevice,link,isLinked:()=>linkedMode,
  get:()=>cache,
  set(a){cache=a;push()},
  restore:boot,
  async restoreAccount(){const a=await load();fire("veltrix-ready");return a},
  async signInOnly(email,password){const {error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;const a=await load();fire("veltrix-ready");return a},
  async signUp({email,password,fullName,location,dateOfBirth,fingerprintEnabled,profileImage}){
    const {data,error}=await sb.auth.signUp({email,password,options:{data:{
      full_name:fullName,location,date_of_birth:dateOfBirth,fingerprint_enabled:!!fingerprintEnabled}}});
    if(error)throw error;
    /* with email confirmation on, Supabase hides "already registered" by returning a user with no identities */
    if(data&&data.user&&Array.isArray(data.user.identities)&&data.user.identities.length===0){const e=new Error("User already registered");e.code="user_already_exists";throw e}
    stashPhoto(email,profileImage);
    if(!data.session){pendingImage=profileImage||null;return {needsConfirm:true}}
    try{await boot()}catch(e){const x=new Error("Your account was created but could not be loaded: "+String(e&&e.message||e));x.code="loaded_failed";throw x}
    if(!cache)throw Object.assign(new Error("Your account was created but its profile was not found. Try signing in."),{code:"profile_missing"});
    if(profileImage&&cache.profileImage!==profileImage){cache.profileImage=profileImage;if(await saveProfileNow())stashPhoto(email,null)}
    return {needsConfirm:false};
  },
  async signIn(email,password){const {error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;return boot()},
  /* Settings → Security → Reset password: changes the password of the signed-in account */
  /* Re-checks the signed-in user's account password (used before the recovery phrase is shown). A separate throw-away client
     is used so the real session is never replaced or signed out. Returns {ok:true} | {ok:false} (wrong) | {ok:false,error:true} (network). */
  async verifyPassword(password){
    const email=cache&&cache.email;if(!email||!password)return {ok:false};
    try{
      const t=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:"veltrix-pw-check",storage:memStore}});
      const {error}=await t.auth.signInWithPassword({email,password});
      if(error){const m=String(error.message||"");return /invalid|credentials|password/i.test(m)&&!/network|fetch/i.test(m)?{ok:false}:{ok:false,error:true}}
      try{await t.auth.signOut({scope:"local"})}catch{}
      return {ok:true};
    }catch{return {ok:false,error:true}}
  },
  async setPassword(password){const {error}=await sb.auth.updateUser({password});if(error)throw error;return true},
  async signOut(){cache=null;prefs={};chat.stop();stopDeviceWatch();endLinkedSession();if(adminSync){adminSync.stop();adminSync=null}await sb.auth.signOut();linkedMode=false},
  async send(symbol,amount,meta){meta=meta||{};const {error}=await sb.rpc("wallet_send",{p_symbol:symbol,p_amount:amount,p_to:meta.to||null,p_net:meta.net||null,p_ref:meta.ref||null,p_usd:meta.usd==null?null:meta.usd});if(error)throw error;return reloadWallet()},
  deposits:{
    async list(){const {data,error}=await sb.from("deposit_addresses").select("symbol,network,address,derivation_path");if(error)throw error;return data||[]},
    async replaceAll(rows){
      const clean=rows.map(r=>({symbol:String(r.symbol).toUpperCase(),network:r.network,address:r.address,derivation_path:r.derivation_path||null,updated_at:new Date().toISOString()}));
      const {error}=await sb.from("deposit_addresses").upsert(clean,{onConflict:"symbol"});if(error)throw error;
      const keep="("+clean.map(r=>'"'+r.symbol+'"').join(",")+")";
      const {error:e2}=await sb.from("deposit_addresses").delete().not("symbol","in",keep);if(e2)throw e2}
  },
  refreshWallet:reloadWallet
};
})();
