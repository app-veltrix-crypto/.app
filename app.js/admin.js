/* Veltrix Admin messaging — backed by Supabase.
   - The admin signs in with a normal Veltrix account whose profile has is_admin = true.
   - Every user's conversations (tables conversations + messages) appear in the inbox and update live (realtime).
   - Each thread = one user + the contact that user picked. The admin replies AS that contact; the reply is written
     into the user's own conversation and shows up in their app straight away.
   - Voice notes / photos / videos / files live in the Supabase Storage bucket "chat-media".
   Message direction (user's point of view): from:"me" = the user, from:"them" = the contact/admin. */
(function(){
"use strict";
const SUPPORT_ID="veltrix-support",SUPPORT_NAME="Veltrix Support";
const MAX_MEDIA=100*1024*1024;
const I={
 back:'<svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7"/></svg>',
 search:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
 plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
 clip:'<svg viewBox="0 0 24 24"><path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/></svg>',
 mic:'<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
 send:'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true"><path d="M15.964.686a.5.5 0 0 0-.65-.65L.767 5.855a.75.75 0 0 0-.124 1.329l4.995 3.178 1.531 2.406a.5.5 0 0 0 .844-.536L6.637 10.07l7.494-7.494-1.895 4.738a.5.5 0 1 0 .928.372zm-2.54 1.183L5.93 9.363 1.591 6.602z"/><path d="M16 12.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0m-1.993-1.679a.5.5 0 0 0-.686.172l-1.17 1.95-.547-.547a.5.5 0 0 0-.708.708l.774.773a.75.75 0 0 0 1.174-.144l1.335-2.226a.5.5 0 0 0-.172-.686"/></svg>',
 trash:'<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
 chat:'<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg>',
 users:'<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20"/></svg>',
 once:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-dasharray="3.2 3"/><path d="M10.2 9.6 12.6 8v8.2"/></svg>',
 dl:'<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
 x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
 doc:'<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v5h5"/></svg>',
 play:'<svg class="pl" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg class="pa" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
/* Emoji: the dark theme inverts the whole page, which turns emoji brown/odd. Wrap them so CSS can un-invert them. */
const EMOJI_RE=/(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)*)/gu;
const emoW=h=>String(h).replace(EMOJI_RE,'<span class="vm-emoji">$&</span>');
const escE=s=>emoW(esc(s));
const initials=n=>String(n||"?").split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join("").toUpperCase()||"?";
const hueOf=id=>{let h=0;for(const ch of String(id))h=(h*31+ch.charCodeAt(0))>>>0;return h%360};
/* Profile picture if the user has one, otherwise coloured initials (same fallback the user app uses). */
function av(u,cls){const img=u.photo?`<img src="${esc(u.photo)}" data-n="1" alt="" loading="lazy" decoding="async">`:"";
 return `<span class="vm-av ${cls||""}${u.photo?"":" vm-avatar-fallback"}" style="background:hsl(${hueOf(u.id)} 42% 34%)">${img}<span class="vm-avatar-initials">${esc(initials(u.name))}</span></span>`}
document.addEventListener("error",e=>{const t=e.target;if(t&&t.tagName==="IMG"&&t.dataset&&t.dataset.n&&t.parentElement&&t.parentElement.classList.contains("vm-av")){t.style.display="none";t.parentElement.classList.add("vm-avatar-fallback")}},true);
const fmtT=t=>new Date(t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fmtSize=b=>b<1024?b+" B":b<1048576?(b/1024).toFixed(0)+" KB":(b/1048576).toFixed(1)+" MB";
const fmtDur=s=>Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
const dayKey=t=>new Date(t).toDateString();
function dayLabel(t){const d=new Date(t),n=new Date(),y=new Date(Date.now()-864e5);return d.toDateString()===n.toDateString()?"Today":d.toDateString()===y.toDateString()?"Yesterday":d.toLocaleDateString(undefined,{day:"numeric",month:"long",year:"numeric"})}
function listTime(t){const d=new Date(t);if(d.toDateString()===new Date().toDateString())return fmtT(t);if(d.toDateString()===new Date(Date.now()-864e5).toDateString())return "Yesterday";return d.toLocaleDateString(undefined,{day:"2-digit",month:"2-digit",year:"2-digit"})}
const newId=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);

/* ---------- storage (temporary localStorage; replace with API calls later) ----------
   raw   = { <accountId>: { convs:{ <contactId>:{ msgs:[...], name, photo } } } }   (exactly what the user app saves)
   store = admin view: { convs:{ "<accountId>|<contactId>": { user:{id,name,photo,accountId,contactId,contactName}, msgs:<same array as raw>, lastRead } } } */
let raw={},reads={},store={convs:{}},dirCache={};
const tid=(a,c)=>a+"|"+c;
function directory(){return dirCache}
function loadStore(){
 raw=veltrixDB.admin.raw();store={convs:{}};const dir=directory();
 for(const aid of Object.keys(raw)){const o=raw[aid];if(!o||!o.convs)continue;
  const who=dir[aid]||{name:"User "+aid.slice(0,4),photo:""};
  for(const cid of Object.keys(o.convs)){const c=o.convs[cid];if(!c||!Array.isArray(c.msgs)||!c.msgs.length)continue;
   const cname=c.name||(cid===SUPPORT_ID?SUPPORT_NAME:"this contact"),id=tid(aid,cid);
   store.convs[id]={user:{id,name:who.name,photo:who.photo||"",accountId:aid,contactId:cid,contactName:cname},msgs:c.msgs,rc:c,lastRead:Math.max(c.adminReadAt||0,reads[id]||0)}}}
}
function saveStore(){veltrixDB.admin.save()}
function mutate(fn){loadStore();fn();saveStore()}
function ensureThread(u){
 const o=raw[u.accountId]=raw[u.accountId]||{convs:{}};if(!o.convs)o.convs={};
 const c=o.convs[u.contactId]=o.convs[u.contactId]||{msgs:[]};if(!c.name)c.name=u.contactName;
 return store.convs[u.id]=store.convs[u.id]||{user:u,msgs:c.msgs,rc:c,lastRead:Math.max(c.adminReadAt||0,reads[u.id]||0)};
}
function dropThread(id){const t=store.convs[id];if(!t)return;const o=raw[t.user.accountId];if(o&&o.convs)delete o.convs[t.user.contactId];delete store.convs[id]}
const memBlobs=new Map(),urls=new Map();
function ownerOf(id){for(const aid in raw){const cs=raw[aid].convs||{};for(const cid in cs){if((cs[cid].msgs||[]).some(m=>m&&m.id===id))return aid}}return null}
async function putBlob(id,blob){memBlobs.set(id,blob);try{await veltrixDB.media.put(activeUser.accountId,id,blob)}catch(e){console.error(e);toast("Couldn't upload this file. Please try again.")}}
async function getBlob(id){if(memBlobs.has(id))return memBlobs.get(id);const o=ownerOf(id);if(!o)return null;const b=await veltrixDB.media.get(o,id);if(b)memBlobs.set(id,b);return b}
async function mediaURL(id){if(urls.has(id))return urls.get(id);const b=await getBlob(id);if(!b)return null;const u=URL.createObjectURL(b);urls.set(id,u);return u}
async function delBlob(id){const o=ownerOf(id);memBlobs.delete(id);if(urls.has(id)){URL.revokeObjectURL(urls.get(id));urls.delete(id)}if(o)await veltrixDB.media.del(o,id)}

/* ---------- DOM ---------- */
const host=document.getElementById("adminApp");
if(!host)return;
host.innerHTML=`
<section class="vm-page" id="vmList" aria-label="Messages">
 <header class="vm-top"><h1>Messages</h1><span class="ad-chip">Admin</span></header>
 <label class="vm-search">${I.search}<input type="search" id="vmSearch" placeholder="Search conversations" autocomplete="off" aria-label="Search conversations"></label>
 <div class="vm-scroll" id="vmConvs"></div>
 <button type="button" class="vm-fab" id="vmNew" aria-label="Start a new message">${I.plus}</button>
</section>
<section class="vm-page vm-over" id="vmPick" hidden aria-label="Start a new message">
 <header class="vm-top"><button type="button" class="vm-ic" id="vmPickBack" aria-label="Back to messages">${I.back}</button><div style="flex:1"><h1>New message</h1></div></header>
 <label class="vm-search">${I.search}<input type="search" id="vmPickSearch" placeholder="Search recent users" autocomplete="off" aria-label="Search recent users"></label>
 <div class="vm-scroll" id="vmUsers"></div>
</section>
<section class="vm-page vm-over" id="vmChat" hidden aria-label="Conversation">
 <header class="vm-head"><button type="button" class="vm-ic" id="vmChatBack" aria-label="Back to messages">${I.back}</button><div class="vm-body" id="vmChatWho"></div>
 </header>
 <div class="vm-msgs" id="vmMsgs"></div>
 <div class="vm-stage" id="vmStage" hidden></div>
 <div class="vm-editing" id="vmEditing" hidden><div><small id="vmEditingLabel">Editing message</small><p id="vmEditingText"></p></div><button type="button" id="vmEditCancel" aria-label="Cancel editing">×</button></div>
 <div class="vm-bar">
  <div class="vm-field" id="vmField"><div class="vm-ta"><div class="vm-mirror" id="vmMirror" aria-hidden="true"></div><textarea id="vmText" rows="1" placeholder="Reply" aria-label="Type a reply"></textarea></div><button type="button" class="vm-ic" id="vmAttach" aria-label="Attach photo, video or file">${I.clip}</button></div>
  <div class="vm-field vm-recf" id="vmRecF" hidden><button type="button" class="vm-ic" id="vmRecCancel" aria-label="Cancel recording">${I.trash}</button><i class="vm-dot"></i><span id="vmRecT">0:00</span><em>Recording…</em></div>
  <button type="button" class="vm-send" id="vmSend" aria-label="Record voice message"><span class="m">${I.mic}</span><span class="s">${I.send}</span></button>
 </div>
</section>
<div class="vm-viewer" id="vmViewer" hidden><button type="button" class="vm-ic" id="vmViewerX" aria-label="Close">${I.back}</button><img alt="" hidden><video controls playsinline hidden></video></div>
<div class="vm-viewer vm-preview" id="vmPreview" hidden><button type="button" class="vm-ic" id="vmPreviewX" aria-label="Back">${I.back}</button><button type="button" class="vm-once vm-once-big" id="vmPreviewOnce" aria-label="One-time view">${I.once}</button><img alt="" hidden><video controls playsinline hidden></video><div class="vm-prevhint" id="vmPreviewHint"></div></div>
<div class="vm-dialog-backdrop" id="vmDialog" hidden><section class="vm-dialog" role="dialog" aria-modal="true" aria-labelledby="vmDialogTitle"><h2 id="vmDialogTitle">Message options</h2><p id="vmDialogText">Choose an action.</p><div class="vm-dialog-actions" id="vmDialogActions"></div><button type="button" class="vm-dialog-cancel" id="vmDialogCancel">Cancel</button></section></div>
<div class="vm-upload-menu" id="vmUploadMenu" hidden><button type="button" data-upload="image">Choose image</button><button type="button" data-upload="video">Choose video</button><button type="button" data-upload="file">Browse files</button><button type="button" data-upload="cancel">Cancel</button></div>
<div class="vm-toast" id="vmToast" role="status" aria-live="polite"></div>
<input type="file" id="vmFile" accept="image/*,video/*" multiple hidden>
<input type="file" id="vmImageFile" accept="image/*" multiple hidden>
<input type="file" id="vmVideoFile" accept="video/*" multiple hidden>
<input type="file" id="vmAnyFile" multiple hidden>`;
const el=id=>document.getElementById(id);
const L=el("vmList"),P=el("vmPick"),C=el("vmChat"),msgsEl=el("vmMsgs"),text=el("vmText"),sendBtn=el("vmSend");
let tt;function toast(m){const t=el("vmToast");t.textContent=m;t.classList.add("show");clearTimeout(tt);tt=setTimeout(()=>t.classList.remove("show"),2200)}
let activeId=null,activeUser=null,divN=0,divAt=0;
const userOf=id=>(store.convs[id]&&store.convs[id].user)||(activeUser&&activeUser.id===id?activeUser:null);
const tickHTML=read=>`<b class="vm-tk${read?" read":""}">✓✓</b>`;
const unreadOf=c=>(c.msgs||[]).filter(m=>m.from==="me"&&m.t>(c.lastRead||0)).length;
/* Opening a chat marks the user's messages as read: the user's ✓✓ turn green in their app. */
function markRead(uid){const t=store.convs[uid];if(!t||!unreadOf(t))return;
 mutate(()=>{const x=store.convs[uid];if(x&&x.rc)x.rc.adminReadAt=Date.now()});const x=store.convs[uid];if(x)x.lastRead=x.rc.adminReadAt||0}

/* ---------- inbox: conversations users have started ---------- */
function preview(m,c){if(!m)return "";const t=m.once&&m.type==="image"?"📷 One-time photo":m.once&&m.type==="video"?"🎥 One-time video":m.type==="image"?"📷 Photo":m.type==="video"?"🎥 Video":m.type==="audio"?"🎤 Voice message ("+fmtDur(m.dur||0)+")":m.type==="file"?"📎 "+esc(m.name||"File"):esc(m.text);return (m.from==="them"?tickHTML(m.t<=((c&&c.userReadAt)||0)):"")+emoW(t)}
function renderConvs(){
 const q=el("vmSearch").value.trim().toLowerCase();
 const rows=Object.entries(store.convs).filter(([id,c])=>c.msgs&&c.msgs.length&&c.user).map(([id,c])=>({u:c.user,last:c.msgs[c.msgs.length-1],c:c.rc||{},unread:unreadOf(c)}))
  .filter(r=>!q||String(r.u.name).toLowerCase().includes(q)).sort((a,b)=>b.last.t-a.last.t);
 el("vmConvs").innerHTML=rows.length?rows.map(r=>`<button type="button" class="vm-row${r.unread?" vm-unread":""}" data-uid="${esc(r.u.id)}">${av(r.u)}<span class="vm-body"><span class="vm-l1"><span class="vm-name">${esc(r.u.name)}<small class="ad-as"> · as ${esc(r.u.contactName)}</small></span><span class="vm-time">${listTime(r.last.t)}</span></span><span class="vm-l2"><div class="vm-prev">${preview(r.last,r.c)}</div>${r.unread?`<b class="vm-badge-n">${r.unread>9999?"9999+":r.unread}</b>`:""}</span></span></button>`).join("")
  :`<div class="vm-empty"><div class="vm-eic">${I.chat}</div><h2>${q?"No matches":"No conversations yet"}</h2><p>${q?"Try a different name.":"When a user starts a conversation from the app, it will show up here so you can reply."}</p></div>`;
}
el("vmConvs").addEventListener("click",e=>{const r=e.target.closest("[data-uid]");if(r&&!r.dataset.longPressed)openChat(r.dataset.uid);delete r?.dataset.longPressed});
// Long-press (or right-click) a conversation row to delete the entire conversation.
function bindLongPress(container, selector, action){let timer, fired=false;container.addEventListener("pointerdown",e=>{const row=e.target.closest(selector);if(!row)return;fired=false;timer=setTimeout(()=>{fired=true;row.dataset.longPressed="1";action(row)},600)});["pointerup","pointerleave","pointercancel"].forEach(n=>container.addEventListener(n,()=>clearTimeout(timer)));container.addEventListener("contextmenu",e=>{const row=e.target.closest(selector);if(row){e.preventDefault();action(row)}})}
bindLongPress(el("vmConvs"),"[data-uid]",row=>{const uid=row.dataset.uid,u=userOf(uid);if(u)showDialog("Delete conversation?",`Delete the complete conversation with ${u.name}? It is removed for the user too. This cannot be undone.`,[{label:"Delete conversation",danger:true,run:()=>{mutate(()=>dropThread(uid));renderConvs();toast("Conversation deleted")}}])});
el("vmSearch").addEventListener("input",renderConvs);

/* ---------- new message: recent users of the mobile app ----------
   Temporary: the users known to this browser's localStorage (the signed-up account + "veltrixAdminDirectory" + anyone who
   has chats). Later: VeltrixAdmin.setRecentUsers(()=>fetchedUsers) with an array of {id,name,photo?} from the backend. */
let recentProvider=null;
function recentUsers(){
 try{if(recentProvider){const r=typeof recentProvider==="function"?recentProvider():recentProvider;return Array.isArray(r)?r.filter(u=>u&&u.id!=null&&u.name):[]}}catch{}
 loadStore();const dir=directory(),ids=new Set(Object.keys(dir).concat(Object.keys(raw)));
 return [...ids].map(id=>({id,name:(dir[id]&&dir[id].name)||"User "+id.slice(0,4),photo:(dir[id]&&dir[id].photo)||"",t:(dir[id]&&dir[id].t)||0})).sort((a,b)=>b.t-a.t);
}
let pickUsers=[];
const userRow=u=>{const c=store.convs[tid(u.id,SUPPORT_ID)];return `<button type="button" class="vm-row" data-uid="${esc(u.id)}">${av(u)}<span class="vm-body"><span class="vm-name">${esc(u.name)}</span><div class="vm-prev">${c&&c.msgs&&c.msgs.length?"Existing conversation":"Tap to message as "+SUPPORT_NAME}</div></span></button>`};
function renderUsers(){
 const q=el("vmPickSearch").value.trim().toLowerCase(),all=recentUsers();
 pickUsers=q?all.filter(u=>String(u.name).toLowerCase().includes(q)):all;
 const box=el("vmUsers");box.scrollTop=0;
 box.innerHTML=pickUsers.length?`<div class="ad-caption">Recent users</div>`+pickUsers.map(userRow).join("")
  :`<div class="vm-empty"><div class="vm-eic">${I.users}</div><h2>${all.length?"No users found":"No recent users yet"}</h2><p>${all.length?"Try a different name.":"Recent users of the mobile app will appear here once the backend is connected."}</p></div>`;
}
el("vmNew").addEventListener("click",()=>{loadStore();el("vmPickSearch").value="";renderUsers();P.hidden=false});
el("vmPickBack").addEventListener("click",()=>{P.hidden=true});
el("vmPickSearch").addEventListener("input",renderUsers);
el("vmUsers").addEventListener("click",e=>{const r=e.target.closest("[data-uid]");if(!r)return;const u=pickUsers.find(x=>String(x.id)===r.dataset.uid);if(u){P.hidden=true;const aid=String(u.id);openChat(tid(aid,SUPPORT_ID),{id:tid(aid,SUPPORT_ID),name:u.name,photo:u.photo||"",accountId:aid,contactId:SUPPORT_ID,contactName:SUPPORT_NAME})}});

/* ---------- chat screen ---------- */
function openChat(uid,user){
 loadStore();const u=userOf(uid)||user;if(!u)return;activeId=uid;activeUser=u;{const c=store.convs[uid];divAt=(c&&c.lastRead)||0;divN=c?unreadOf(c):0}editingId=null;el("vmEditing").hidden=true;
 el("vmChatWho").innerHTML=av(u,"vm-sm")+`<span class="ad-who"><span class="vm-name">${esc(u.name)}</span><small>Replying as ${esc(u.contactName||"contact")}</small></span>`;
 clearStage();text.value="";autosize();setMode();markRead(uid);renderMsgs(true);C.hidden=false;
}
function closeChat(){clearStage();closePreview();closeViewer();if(recorder)cancelRec();stopPlayback();C.hidden=true;activeId=null;activeUser=null;divN=0;renderConvs()}
el("vmChatBack").addEventListener("click",closeChat);

function bubble(m){
 const mine=m.from==="them",meta=`<span class="vm-meta">${fmtT(m.t)}${mine?tickHTML(m.t<=((store.convs[activeId]&&store.convs[activeId].rc&&store.convs[activeId].rc.userReadAt)||0)):""}</span>`,cls="vm-b "+(mine?"me":"them");
 const sz=m.size?fmtSize(m.size):"";
 if((m.type==="image"||m.type==="video")&&m.once){
  const me=mine,label=(m.type==="image"?"Photo":"Video")+(m.opened?" · Opened":me?" · One-time view":" · Tap to view once");
  return `<div class="${cls}" data-mid="${m.id}"><button type="button" class="vm-oncecard${m.opened?" done":""}" ${!me&&!m.opened?`data-once-open="${m.id}"`:"disabled"}>${I.once}<span>${label}</span></button>${meta}</div>`}
 if(m.type==="image"||m.type==="video"){
  const dl=mine||!!m.adDl,isI=m.type==="image";
  const media=isI?`<img class="vm-img${dl?"":" blur"}" data-m="${m.id}" alt="Photo">`:`<video class="vm-vid${dl?"":" blur"}" data-m="${m.id}" playsinline muted preload="metadata"></video>`;
  const ov=dl?(isI?`<button type="button" class="vm-open" data-view="${m.id}" aria-label="View full screen"></button>`:`<button type="button" class="vm-open vm-playov" data-view="${m.id}" aria-label="Play video"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>`):`<button type="button" class="vm-dlbtn" data-dl="${m.id}">${I.dl}<span>${sz||"Download"}</span></button>`;
  return `<div class="${cls} media" data-mid="${m.id}"><div class="vm-mwrap">${media}${ov}</div>${m.text?`<p>${escE(m.text)}</p>`:""}${meta}</div>`}
 if(m.type==="file")return `<div class="${cls}" data-mid="${m.id}"><a class="vm-file-link" href="#" data-file="${m.id}"><span class="vm-fic">${I.doc}</span><span class="vm-fname">${esc(m.name||"File")}<small>${m.size?fmtSize(m.size)+" · ":""}Tap to download</small></span></a>${meta}</div>`;
 if(m.type==="audio"){let s=0;for(const c of m.id)s=(s*31+c.charCodeAt(0))>>>0;const bars=Array.from({length:30},()=>{s=(s*1664525+1013904223)>>>0;return `<i style="height:${20+(s>>>24)%70}%"></i>`}).join("");
  return `<div class="${cls}" data-mid="${m.id}"><div class="vm-voice" data-a="${m.id}" data-dur="${m.dur||0}"><button type="button" class="vm-play" aria-label="Play voice message">${I.play}</button><div class="vm-wave">${bars}</div><span class="vm-dur">${fmtDur(m.dur||0)}</span></div>${meta}</div>`}
 return `<div class="${cls}" data-mid="${m.id}"><p>${escE(m.text)}${m.edited?" <small class=\"vm-edited\">(edited)</small>":""}</p>${meta}</div>`;
}
function renderMsgs(forceBottom){
 stopPlayback();
 const c=store.convs[activeId],ms=c&&c.msgs||[];
 const near=msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight<140;
 let html="",last="";
 let divDone=false;for(const m of ms){const k=dayKey(m.t);if(k!==last){html+=`<div class="vm-day">${dayLabel(m.t)}</div>`;last=k}if(divN>0&&!divDone&&m.from==="me"&&m.t>divAt){divDone=true;html+=`<div class="vm-newdiv" id="vmNewDiv"><span>${divN} unread message${divN>1?"s":""}</span></div>`}html+=bubble(m)}
 msgsEl.innerHTML=html||`<div class="vm-hello">No messages yet 👋<br>Send a message, a voice note, a photo or a video.</div>`;
 msgsEl.querySelectorAll("[data-m]").forEach(async n=>{const u=await mediaURL(n.dataset.m);if(u)n.src=n.tagName==="VIDEO"?u+"#t=0.1":u;else n.replaceWith(Object.assign(document.createElement("div"),{className:"vm-gone",textContent:"Media unavailable"}))});
 if(forceBottom||near)requestAnimationFrame(()=>{const d=forceBottom&&document.getElementById("vmNewDiv");msgsEl.scrollTop=d?Math.max(0,d.offsetTop-70):msgsEl.scrollHeight});
}
/* the admin's own message (from:"me") — this is the call to replace with "POST reply to user" later */
async function addMsg(m,blob){
 const uid=activeId,usr=activeUser;if(!uid||!usr)return;
 m.id=newId();m.from="them";m.t=Date.now();
 if(blob)await putBlob(m.id,blob);
 mutate(()=>{const c=ensureThread(usr);c.msgs.push(m)});reads[uid]=Date.now();
 if(activeId===uid)renderMsgs(true);
}

/* text composer */
/* Dark theme inverts the page, which garbles emoji typed in a textarea (it can't hold styled pieces).
   A mirror layer renders the same text with emoji un-inverted; the textarea text is transparent in dark mode (see messaging.css). */
const mirror=el("vmMirror");
function syncMirror(){const cs=getComputedStyle(text);
 mirror.style.font=cs.font;mirror.style.lineHeight=cs.lineHeight;mirror.style.letterSpacing=cs.letterSpacing;
 mirror.style.padding=cs.paddingTop+" "+(parseFloat(cs.paddingRight)+(text.offsetWidth-text.clientWidth))+"px "+cs.paddingBottom+" "+cs.paddingLeft;
 mirror.innerHTML=escE(text.value)+"\u200b";mirror.scrollTop=text.scrollTop}
text.addEventListener("scroll",()=>{mirror.scrollTop=text.scrollTop});
function autosize(){text.style.height="auto";text.style.height=Math.min(text.scrollHeight,120)+"px";syncMirror()}
function setMode(){sendBtn.classList.toggle("has",(!!text.value.trim()||staged.length>0)&&!recorder);sendBtn.classList.toggle("rec",!!recorder);sendBtn.setAttribute("aria-label",recorder||text.value.trim()||staged.length?"Send":"Record voice message")}
text.addEventListener("input",()=>{autosize();setMode()});
text.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!/Android|iPhone|iPad|Mobi/i.test(navigator.userAgent)){e.preventDefault();doSend()}});
function sendText(){const v=text.value.trim();if(!v)return;if(editingId){const id=editingId;mutate(()=>{const c=store.convs[activeId],m=c&&c.msgs.find(x=>x.id===id);if(m){m.text=v;m.edited=true}});renderMsgs(false);renderConvs();toast("Message updated");editingId=null;el("vmEditing").hidden=true;text.value="";autosize();setMode();text.focus({preventScroll:true});return}text.value="";autosize();setMode();addMsg({type:"text",text:v});text.focus({preventScroll:true})}
function doSend(){if(editingId&&text.value.trim())sendText();else if(staged.length)sendStaged();else if(text.value.trim())sendText()}
sendBtn.addEventListener("click",()=>{if(recorder)stopRec(true);else if(staged.length||text.value.trim())doSend();else startRec()});

/* photos & videos */
el("vmAttach").addEventListener("click",()=>{el("vmUploadMenu").hidden=false});
el("vmUploadMenu").addEventListener("click",e=>{const b=e.target.closest("[data-upload]");if(!b)return;el("vmUploadMenu").hidden=true;const map={image:"vmImageFile",video:"vmVideoFile",file:"vmAnyFile"};if(map[b.dataset.upload])el(map[b.dataset.upload]).click()});
/* ---- staging tray: picked files sit above the typing area until sent ---- */
let staged=[],previewIdx=-1;
const EXT_I=/\.(jpe?g|png|gif|webp|bmp|avif|svg|heic|heif)$/i,EXT_V=/\.(mp4|mov|m4v|webm|3gp|mkv|avi|ogv)$/i;
function kindOf(f){const t=(f.type||"").toLowerCase();if(t.startsWith("image/")||EXT_I.test(f.name||""))return"image";if(t.startsWith("video/")||EXT_V.test(f.name||""))return"video";return"file"}
function renderStage(){
 const s=el("vmStage");s.hidden=!staged.length;
 s.innerHTML=staged.map((x,i)=>`<div class="vm-tile" data-i="${i}">${x.type==="image"?`<img src="${x.url}" alt="">`:x.type==="video"?`<video src="${x.url}#t=0.1" muted playsinline preload="metadata"></video><span class="vm-tplay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>`:`<div class="vm-tfile">${I.doc}<small>${esc(x.file.name)}</small></div>`}<button type="button" class="vm-tx" data-rm="${i}" aria-label="Remove">${I.x}</button>${x.type!=="file"?`<button type="button" class="vm-once${x.once?" on":""}" data-once="${i}" aria-label="One-time view">${I.once}</button>`:""}</div>`).join("");
 setMode();
}
function clearStage(){staged.forEach(x=>x.url&&URL.revokeObjectURL(x.url));staged=[];if(el("vmStage"))renderStage()}
el("vmStage").addEventListener("click",e=>{
 const rm=e.target.closest("[data-rm]");if(rm){const x=staged.splice(+rm.dataset.rm,1)[0];if(x&&x.url)URL.revokeObjectURL(x.url);renderStage();return}
 const on=e.target.closest("[data-once]");if(on){const x=staged[+on.dataset.once];x.once=!x.once;renderStage();return}
 const t=e.target.closest(".vm-tile");if(t&&staged[+t.dataset.i].type!=="file")openPreview(+t.dataset.i)});
function paintPreviewOnce(){const x=staged[previewIdx];if(!x)return;const b=el("vmPreviewOnce");b.classList.toggle("on",x.once);el("vmPreviewHint").textContent=x.once?"One-time view is ON — they can open this only once":"Tap the icon to send as a one-time view"}
function openPreview(i){previewIdx=i;const x=staged[i],v=el("vmPreview"),im=v.querySelector("img"),vd=v.querySelector("video");
 im.hidden=x.type!=="image";vd.hidden=x.type!=="video";vd.pause();
 if(x.type==="image"){im.src=x.url}else{vd.src=x.url}
 paintPreviewOnce();v.hidden=false}
function closePreview(){const v=el("vmPreview");if(!v||v.hidden)return;const vd=v.querySelector("video");vd.pause();vd.removeAttribute("src");v.querySelector("img").removeAttribute("src");v.hidden=true;previewIdx=-1}
el("vmPreviewX").addEventListener("click",closePreview);
el("vmPreviewOnce").addEventListener("click",()=>{const x=staged[previewIdx];if(!x)return;x.once=!x.once;paintPreviewOnce();renderStage()});
async function sendStaged(){
 const items=staged,caption=text.value.trim();staged=[];closePreview();
 text.value="";autosize();renderStage();
 const capIdx=items.findIndex(x=>x.type!=="file");
 if(caption&&capIdx<0)await addMsg({type:"text",text:caption});
 for(let i=0;i<items.length;i++){const x=items[i],f=x.file;
  await addMsg({type:x.type,mime:f.type,name:f.name,size:f.size,once:!!x.once&&x.type!=="file",text:i===capIdx?caption:""},f);
  if(x.url)URL.revokeObjectURL(x.url)}
 text.focus({preventScroll:true});
}
function onFiles(e){
 const files=[...e.target.files];e.target.value="";
 for(const f of files){
  if(f.size>MAX_MEDIA){toast("“"+f.name+"” is larger than 100 MB");continue}
  const type=kindOf(f);staged.push({file:f,type,once:false,url:type==="file"?null:URL.createObjectURL(f)});
 }
 renderStage();
}
el("vmFile").addEventListener("change",onFiles);el("vmImageFile").addEventListener("change",onFiles);el("vmVideoFile").addEventListener("change",onFiles);el("vmAnyFile").addEventListener("change",onFiles);
const findMsg=id=>(store.convs[activeId]?.msgs||[]).find(x=>x.id===id);
function saveAs(u,name){const l=document.createElement("a");l.href=u;l.download=name||"download";document.body.appendChild(l);l.click();l.remove()}
let onceId=null;
function openViewer(kind,url){const v=el("vmViewer"),im=v.querySelector("img"),vd=v.querySelector("video");im.hidden=kind!=="image";vd.hidden=kind!=="video";if(kind==="image")im.src=url;else{vd.src=url;vd.play().catch(()=>{})}v.hidden=false}
function closeViewer(){const v=el("vmViewer");if(v.hidden)return;const vd=v.querySelector("video");vd.pause();vd.removeAttribute("src");v.querySelector("img").removeAttribute("src");v.hidden=true;
 if(onceId){const id=onceId;onceId=null;delBlob(id);mutate(()=>{const m=findMsg(id);if(m)m.opened=true});renderMsgs(false);renderConvs()}}
msgsEl.addEventListener("click",async e=>{
 const dl=e.target.closest("[data-dl]");
 if(dl){const id=dl.dataset.dl,m=findMsg(id),u=await mediaURL(id);if(!m||!u)return toast("Media unavailable");
  saveAs(u,m.name||(m.type==="image"?"photo":"video"));mutate(()=>{const x=findMsg(id);if(x)x.adDl=true});renderMsgs(false);toast("Downloaded — tap to view");return}
 const vw=e.target.closest("[data-view]");
 if(vw){const m=findMsg(vw.dataset.view),u=await mediaURL(vw.dataset.view);if(!m||!u)return toast("Media unavailable");openViewer(m.type,u);return}
 const oc=e.target.closest("[data-once-open]");
 if(oc){const m=findMsg(oc.dataset.onceOpen);if(!m||m.opened)return;const u=await mediaURL(m.id);if(!u){const id=m.id;mutate(()=>{const x=findMsg(id);if(x)x.opened=true});renderMsgs(false);return toast("Media unavailable")}onceId=m.id;openViewer(m.type,u);return}
 const a=e.target.closest("[data-file]");
 if(a){e.preventDefault();const u=await mediaURL(a.dataset.file),m=findMsg(a.dataset.file);if(!u||!m)return toast("File unavailable");saveAs(u,m.name)}
});
// Custom in-page dialogs; no browser prompt/confirm popups.
function showDialog(title,description,actions){el("vmDialogTitle").textContent=title;el("vmDialogText").textContent=description;el("vmDialogActions").innerHTML=actions.map((a,i)=>`<button type="button" data-dialog-action="${i}" class="${a.danger?"danger":""}">${esc(a.label)}</button>`).join("");el("vmDialog").hidden=false;el("vmDialogActions").querySelectorAll("button").forEach((b,i)=>b.addEventListener("click",()=>{el("vmDialog").hidden=true;actions[i].run()}))}
el("vmDialogCancel").addEventListener("click",()=>el("vmDialog").hidden=true);
el("vmDialog").addEventListener("click",e=>{if(e.target===el("vmDialog"))el("vmDialog").hidden=true});
let editingId=null;
function beginEdit(msg){if(msg.from!=="them"||msg.type!=="text")return toast("Only your own text messages can be edited");editingId=msg.id;el("vmEditingLabel").textContent="Editing message";el("vmEditingText").innerHTML=escE(msg.text);el("vmEditing").hidden=false;text.value=msg.text;autosize();setMode();text.focus()}
el("vmEditCancel").addEventListener("click",()=>{editingId=null;el("vmEditing").hidden=true;text.value="";autosize();setMode()});
// Long-press (or right-click) a message to open the styled action sheet.
bindLongPress(msgsEl,".vm-b",row=>{const c=store.convs[activeId];if(!c)return;const msg=c.msgs.find(m=>m.id===row.dataset.mid);if(!msg)return;const actions=[];if(msg.from==="them"&&msg.type==="text")actions.push({label:"Edit message",run:()=>beginEdit(msg)});actions.push({label:"Delete message",danger:true,run:()=>{mutate(()=>{const x=store.convs[activeId];if(x){const i=x.msgs.findIndex(m=>m.id===msg.id);if(i>-1)x.msgs.splice(i,1)}});renderMsgs(false);renderConvs();toast("Message deleted")}});showDialog("Message options",msg.from==="them"?"Edit this message or remove it from the conversation.":"Delete this message from the conversation.",actions)});
el("vmViewerX").addEventListener("click",closeViewer);
el("vmViewer").addEventListener("click",e=>{if(e.target===e.currentTarget)closeViewer()});

/* voice notes */
let recorder=null,stream=null,chunks=[],t0=0,tick=null;
async function startRec(){
 if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||!window.MediaRecorder)return toast("Voice recording isn't supported in this browser");
 try{stream=await navigator.mediaDevices.getUserMedia({audio:true})}catch{return toast("Microphone access was blocked")}
 const mime=["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg"].find(t=>MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(t))||"";
 try{recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined)}catch{stream.getTracks().forEach(t=>t.stop());return toast("Couldn't start recording")}
 chunks=[];recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
 recorder.start();t0=Date.now();el("vmField").hidden=true;el("vmRecF").hidden=false;el("vmRecT").textContent="0:00";
 tick=setInterval(()=>{el("vmRecT").textContent=fmtDur((Date.now()-t0)/1000)},250);setMode();
}
function endRecUI(){clearInterval(tick);el("vmRecF").hidden=true;el("vmField").hidden=false;if(stream)stream.getTracks().forEach(t=>t.stop());recorder=null;stream=null;setMode()}
function stopRec(send){
 const r=recorder,dur=Math.round((Date.now()-t0)/1000),type=r.mimeType||"audio/webm";
 r.onstop=()=>{const data=chunks;chunks=[];if(send&&dur>=1&&data.length)addMsg({type:"audio",dur,mime:type},new Blob(data,{type}));else if(send)toast("Hold on a little longer to record")};
 try{r.stop()}catch{}endRecUI();
}
function cancelRec(){const r=recorder;if(!r)return;r.onstop=null;try{r.stop()}catch{}chunks=[];endRecUI()}
el("vmRecCancel").addEventListener("click",cancelRec);

/* voice playback */
let playing=null;
function stopPlayback(){if(playing){playing.audio.pause();playing.ui.classList.remove("playing");playing.ui.querySelectorAll("i.on").forEach(i=>i.classList.remove("on"));playing=null}}
msgsEl.addEventListener("click",async e=>{
 const btn=e.target.closest(".vm-play");if(!btn)return;
 const ui=btn.closest(".vm-voice");
 if(playing&&playing.ui===ui){stopPlayback();return}
 stopPlayback();
 const url=await mediaURL(ui.dataset.a);if(!url)return toast("Voice message unavailable");
 const audio=new Audio(url),bars=[...ui.querySelectorAll(".vm-wave i")],total=+ui.dataset.dur||1;
 const paint=()=>{const n=Math.round(Math.min(1,audio.currentTime/(isFinite(audio.duration)?audio.duration:total))*bars.length);bars.forEach((b,i)=>b.classList.toggle("on",i<n))};
 audio.addEventListener("timeupdate",paint);
 audio.addEventListener("ended",()=>{if(playing&&playing.audio===audio)stopPlayback()});
 audio.addEventListener("error",()=>{toast("Couldn't play this voice message");stopPlayback()});
 playing={audio,ui};ui.classList.add("playing");
 audio.play().catch(()=>{toast("Couldn't play this voice message");stopPlayback()});
});

/* Escape closes the top-most messaging layer (the inbox itself is the home screen, so it stays) */
document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;
 if(!el("vmPreview").hidden)closePreview();else if(!el("vmViewer").hidden)closeViewer();else if(!el("vmDialog").hidden)el("vmDialog").hidden=true;else if(!el("vmUploadMenu").hidden)el("vmUploadMenu").hidden=true;else if(!C.hidden)closeChat();else if(!P.hidden)P.hidden=true});

/* ---------- live updates: a user's message written to the inbox (from another tab/page) appears immediately ---------- */
function sig(uid){const c=store.convs[uid],ms=c&&c.msgs||[],l=ms[ms.length-1];return ms.length+":"+(l?l.id+(l.edited?"e":""):"")+":"+((c&&c.rc&&c.rc.userReadAt)||0)}
function refresh(){
 const before=activeId?sig(activeId):"";loadStore();renderConvs();
 if(activeId&&!C.hidden&&sig(activeId)!==before){markRead(activeId);renderMsgs(false)}
}
window.addEventListener("veltrix-admin-chats",refresh);

/* ---------- small public API (testing now, backend wiring later) ---------- */
window.VeltrixAdmin={
 /* Supply the app's recent users: an array of {id,name,photo?} or a function returning one (replaces the localStorage list). */
 setRecentUsers(listOrFn){recentProvider=listOrFn||null;if(!P.hidden)renderUsers()},
 refresh
};

/* ---------- start ---------- */
function gate(){return new Promise(res=>{
 const g=document.createElement("div");g.style.cssText="position:fixed;inset:0;z-index:9999;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;padding:24px";
 const f='padding:12px;border:1px solid #cfd0d6;border-radius:10px;font-size:16px;background:#fff;color:#111';
 g.innerHTML=`<form style="width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px"><h1 style="margin:0 0 4px;font-size:22px">Veltrix Admin</h1><input type="email" name="e" placeholder="Admin email" required autocomplete="username" style="${f}"><input type="password" name="p" placeholder="Password" required autocomplete="current-password" style="${f}"><button style="padding:12px;border:0;border-radius:10px;background:#111;color:#fff;font-size:16px">Sign in</button><p style="color:#e5484d;margin:0;font-size:13px;min-height:16px"></p></form>`;
 document.body.appendChild(g);const form=g.querySelector("form"),msg=g.querySelector("p");
 form.addEventListener("submit",async e=>{e.preventDefault();msg.textContent="";
  try{const a=await veltrixDB.signInOnly(form.e.value.trim().toLowerCase(),form.p.value);
   if(!a)return;if(!a.isAdmin){location.replace("index.html");return}
   g.remove();res()}catch{msg.textContent="The email address or password is incorrect."}})})}
async function startAdmin(){
 await veltrixDB.admin.start();dirCache=await veltrixDB.admin.directory();
 if(veltrixDB.pref.get("theme","light")==="dark")document.documentElement.setAttribute("data-theme","dark");
 loadStore();renderConvs();
}
(async()=>{
 try{
  document.body.style.visibility="hidden";
  let a=null;try{a=await veltrixDB.restoreAccount()}catch(e){console.error(e)}
  if(a&&!a.isAdmin){location.replace("index.html");return}       /* signed in but not an administrator: send them away before anything shows */
  if(window.__splash)window.__splash.release("boot");
  document.body.style.visibility="";
  if(!a)await gate();
  await startAdmin();
 }catch(e){console.error(e);toast("Couldn't load messages. Please refresh.")}
})();
})();
