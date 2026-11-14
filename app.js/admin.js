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
const MAX_MEDIA=500*1024*1024;
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
const stickerN=t=>{t=String(t||"").trim();if(!t)return 0;const n=(t.match(EMOJI_RE)||[]).length;return n>0&&n<=3&&!t.replace(EMOJI_RE,"").replace(/[\s\u200d\ufe0f]/g,"")?n:0};
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
   if(String(cid).indexOf("real-")===0)continue;                      /* private chats between two real users are not admin threads (the admin could otherwise "reply as" a real person) */
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
async function putBlob(id,blob){
 memBlobs.set(id,blob);const big=blob.size>2*1048576;let last=-1;
 try{await veltrixDB.media.put(activeUser.accountId,id,blob,big?p=>{const n=Math.min(99,Math.round(p*100));if(n!==last){last=n;progressToast("Sending "+n+"%")}}:null);if(big)toast("Sent");return true}
 catch(e){console.error(e);memBlobs.delete(id);toast(e&&e.status===413?"This file is larger than the server allows.":"Couldn't send this file. Check your connection and try again.");return false}
}
async function getBlob(id){if(memBlobs.has(id))return memBlobs.get(id);const o=ownerOf(id);if(!o)return null;const b=await veltrixDB.media.get(o,id);if(b)memBlobs.set(id,b);return b}
const STREAM=k=>k==="video"||k==="file";const sUrls=new Map();
/* videos and files stream straight from storage (they start at once and are never loaded whole into memory); photos and voice notes are small and are fetched as before */
async function mediaURL(id,kind,dlName){
 const local=memBlobs.get(id);
 if(local){if(urls.has(id))return urls.get(id);const u=URL.createObjectURL(local);urls.set(id,u);return u}
 if(STREAM(kind)){const key=id+(dlName?"|d":"");const c=sUrls.get(key);if(c&&c.exp>Date.now())return c.u;const u=await veltrixDB.media.url(ownerOf(id),id,dlName);if(u){sUrls.set(key,{u,exp:Date.now()+50*60*1000});return u}return null}
 if(urls.has(id))return urls.get(id);const b=await getBlob(id);if(!b)return null;const u=URL.createObjectURL(b);urls.set(id,u);return u}
async function delBlob(id){const o=ownerOf(id);memBlobs.delete(id);if(urls.has(id)){URL.revokeObjectURL(urls.get(id));urls.delete(id)}if(o)await veltrixDB.media.del(o,id)}

/* ---------- DOM ---------- */
const host=document.getElementById("adminApp");
if(!host)return;
host.innerHTML=`
<section class="vm-page" id="vmList" aria-label="Messages">
 <header class="vm-top"><h1>Messages</h1></header>
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
 <div class="vm-dock" id="vmDock">
 <div class="vm-stage" id="vmStage" hidden></div>
 <div class="vm-editing" id="vmEditing" hidden><div><small id="vmEditingLabel">Editing message</small><p id="vmEditingText"></p></div><button type="button" id="vmEditCancel" aria-label="Cancel editing">×</button></div>
 <div class="vm-bar">
  <div class="vm-field" id="vmField"><div class="vm-ta"><div class="vm-mirror" id="vmMirror" aria-hidden="true"></div><textarea id="vmText" rows="1" placeholder="Reply" aria-label="Type a reply"></textarea></div><button type="button" class="vm-ic" id="vmAttach" aria-label="Attach photo, video or file">${I.clip}</button></div>
  <div class="vm-field vm-recf" id="vmRecF" hidden><button type="button" class="vm-ic" id="vmRecCancel" aria-label="Cancel recording">${I.trash}</button><i class="vm-dot"></i><span id="vmRecT">0:00</span><em>Recording…</em></div>
  <button type="button" class="vm-send" id="vmSend" aria-label="Record voice message"><span class="m">${I.mic}</span><span class="s">${I.send}</span></button>
 </div>
 </div>
</section>
<div class="vm-viewer vv" id="vmViewer" hidden><button type="button" class="vm-ic" id="vmViewerX" aria-label="Close">${I.x}</button>
<div class="vv-stage" id="vvStage"><img alt="" hidden><video playsinline hidden></video></div>
<div class="vv-info"><div class="vv-author"><span class="vv-av" id="vvAv"></span><span class="vv-name" id="vvName"></span></div><p class="vv-cap" id="vvCap" hidden></p></div>
<div class="vv-bar" id="vvBar" hidden><div class="vv-prog" id="vvProg" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="vvFill"></i></div>
<div class="vv-ctl"><button type="button" id="vvPlay" aria-label="Pause"></button><span class="vv-time" id="vvTime">-0:00</span><span class="vv-sp"></span><button type="button" class="vv-speed" id="vvSpeed" aria-label="Playback speed">1x</button><button type="button" id="vvMute" aria-label="Sound"></button><button type="button" id="vvFs" aria-label="Full screen"></button></div></div></div>
<div class="vm-viewer vm-preview" id="vmPreview" hidden><button type="button" class="vm-ic" id="vmPreviewX" aria-label="Close">${I.x}</button><button type="button" class="vm-once vm-once-big" id="vmPreviewOnce" aria-label="One-time view">${I.once}</button><div class="vp-stage" id="vpStage"><img alt="" hidden><video playsinline preload="auto" hidden></video><span class="vp-spin" id="vpSpin" hidden></span><p class="vp-fail" id="vpFail" hidden>This video can't be previewed here. You can still send it.</p></div><div class="vv-bar vp-bar" id="vpBar" hidden><div class="vv-prog" id="vpProg" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="vpFill"></i></div><div class="vv-ctl"><button type="button" id="vpPlay" aria-label="Pause"></button><span class="vv-time" id="vpTime">-0:00</span><span class="vv-sp"></span><button type="button" id="vpMute" aria-label="Sound"></button></div></div><div class="vm-prevhint" id="vmPreviewHint"></div></div>
<div class="vm-dialog-backdrop" id="vmDialog" hidden><section class="vm-dialog" role="dialog" aria-modal="true" aria-labelledby="vmDialogTitle"><h2 id="vmDialogTitle">Message options</h2><p id="vmDialogText">Choose an action.</p><div class="vm-dialog-actions" id="vmDialogActions"></div><button type="button" class="vm-dialog-cancel" id="vmDialogCancel">Cancel</button></section></div>
<div class="vm-upload-menu" id="vmUploadMenu" hidden><button type="button" data-upload="image"><span class="vm-um-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 4.6-4.4a1.6 1.6 0 0 1 2.2 0L14 15.5l1.8-1.7a1.6 1.6 0 0 1 2.2 0L20.5 16"/></svg></span><span class="vm-um-t">Choose image</span></button><button type="button" data-upload="video"><span class="vm-um-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10.5 4.2-2.4a.6.6 0 0 1 .8.5v6.8a.6.6 0 0 1-.8.5L16 13.5"/></svg></span><span class="vm-um-t">Choose video</span></button><button type="button" data-upload="file"><span class="vm-um-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3.5H8a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/></svg></span><span class="vm-um-t">Browse files</span></button><button type="button" data-upload="cancel"><span class="vm-um-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/></svg></span><span class="vm-um-t">Cancel</span></button></div>
<div class="vm-toast" id="vmToast" role="status" aria-live="polite"></div>
<input type="file" id="vmFile" accept="image/*,video/*" multiple hidden>
<input type="file" id="vmImageFile" accept="image/*" multiple hidden>
<input type="file" id="vmVideoFile" accept="video/*" multiple hidden>
<input type="file" id="vmAnyFile" multiple hidden>`;
const el=id=>document.getElementById(id);
const L=el("vmList"),P=el("vmPick"),C=el("vmChat"),msgsEl=el("vmMsgs"),text=el("vmText"),sendBtn=el("vmSend");
let tt;function toast(m){const t=el("vmToast");t.textContent=m;t.classList.add("show");clearTimeout(tt);tt=setTimeout(()=>t.classList.remove("show"),2200)}
function progressToast(m){const t=el("vmToast");t.textContent=m;t.classList.add("show");clearTimeout(tt);tt=setTimeout(()=>t.classList.remove("show"),15000)}
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
 try{window.vxChatMenu&&window.vxChatMenu.onChat({admin:true,accountId:u.accountId,contactId:u.contactId,persona:u.contactName||"",support:u.contactId==="veltrix-support"})}catch(e){}
}
function closeChat(){try{window.vxChatMenu&&window.vxChatMenu.onChat(null)}catch(e){}clearStage();closePreview();closeViewer();if(recorder)cancelRec();stopPlayback();C.hidden=true;activeId=null;activeUser=null;divN=0;renderConvs()}
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
 {const sn=(!m.type||m.type==="text")?stickerN(m.text):0;if(sn)return `<div class="${cls} vm-sticker st${sn}" data-mid="${m.id}"><p>${escE(String(m.text).trim())}</p>${meta}</div>`}
 return `<div class="${cls}" data-mid="${m.id}"><p>${escE(m.text)}${m.edited?" <small class=\"vm-edited\">(edited)</small>":""}</p>${meta}</div>`;
}
/* Photos and videos show a shimmering placeholder (never the broken-image icon) until the real picture / first frame has loaded. */
function vmMediaWatch(n){const w=n.closest&&n.closest(".vm-mwrap");if(!w)return;w.classList.add("vm-mload");
 const vid=n.tagName==="VIDEO";let t=0;const done=()=>{clearTimeout(t);w.classList.remove("vm-mload");["load","error","loadeddata","canplay","seeked"].forEach(e=>n.removeEventListener(e,done))};
 (vid?["loadeddata","canplay","seeked","error"]:["load","error"]).forEach(e=>n.addEventListener(e,done));t=setTimeout(done,20000)}
function renderMsgs(forceBottom){
 stopPlayback();
 const c=store.convs[activeId],ms=c&&c.msgs||[];
 const near=msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight<140;
 let html="",last="";
 let divDone=false;for(const m of ms){const k=dayKey(m.t);if(k!==last){html+=`<div class="vm-day">${dayLabel(m.t)}</div>`;last=k}if(divN>0&&!divDone&&m.from==="me"&&m.t>divAt){divDone=true;html+=`<div class="vm-newdiv" id="vmNewDiv"><span>${divN} unread message${divN>1?"s":""}</span></div>`}html+=bubble(m)}
 msgsEl.innerHTML=html||`<div class="vm-hello">No messages yet 👋<br>Send a message, a voice note, a photo or a video.</div>`;
 msgsEl.querySelectorAll("[data-m]").forEach(async n=>{vmMediaWatch(n);const u=await mediaURL(n.dataset.m,n.tagName==="VIDEO"?"video":"image");if(u)n.src=n.tagName==="VIDEO"?u+"#t=0.1":u;else{const w=n.closest(".vm-mwrap");if(w)w.classList.remove("vm-mload");n.replaceWith(Object.assign(document.createElement("div"),{className:"vm-gone",textContent:"Media unavailable"}))}});
 if(forceBottom||near)requestAnimationFrame(()=>{const d=forceBottom&&document.getElementById("vmNewDiv");msgsEl.scrollTop=d?Math.max(0,d.offsetTop-70):msgsEl.scrollHeight});
}
/* the admin's own message (from:"me") — this is the call to replace with "POST reply to user" later */
async function addMsg(m,blob){
 const uid=activeId,usr=activeUser;if(!uid||!usr)return;
 m.id=newId();m.from="them";m.t=Date.now();
 if(blob&&!(await putBlob(m.id,blob)))return;
 mutate(()=>{const c=ensureThread(usr);if(c.rc&&c.rc.disappear)m.exp=m.t+864e5;c.msgs.push(m)});reads[uid]=Date.now();
 if(activeId===uid)renderMsgs(true);
}

/* text composer */
/* Dark theme inverts the page, which garbles emoji typed in a textarea (it can't hold styled pieces).
   A mirror layer renders the same text with emoji un-inverted; the textarea text is transparent in dark mode (see messaging.css). */
const mirror=el("vmMirror");
const HAS_EMOJI=new RegExp(EMOJI_RE.source,"u");
function syncMirror(){
 const emo=HAS_EMOJI.test(text.value),box=text.parentNode;
 if(box)box.classList.toggle("vm-emo",emo);
 if(!emo){mirror.textContent="";return}
 const cs=getComputedStyle(text),ms=mirror.style;
 if(cs.font)ms.font=cs.font;else{ms.fontFamily=cs.fontFamily;ms.fontSize=cs.fontSize;ms.fontWeight=cs.fontWeight;ms.fontStyle=cs.fontStyle}
 ms.lineHeight=cs.lineHeight;ms.letterSpacing=cs.letterSpacing;ms.wordSpacing=cs.wordSpacing;ms.textIndent=cs.textIndent;ms.tabSize=cs.tabSize;
 ms.overflowWrap=cs.overflowWrap;ms.wordBreak=cs.wordBreak;ms.whiteSpace=cs.whiteSpace;
 ms.padding=cs.paddingTop+" "+(parseFloat(cs.paddingRight)+(text.offsetWidth-text.clientWidth))+"px "+cs.paddingBottom+" "+cs.paddingLeft;
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
let vpAlt=null;
function vpFree(){if(vpAlt){URL.revokeObjectURL(vpAlt);vpAlt=null}}
function openPreview(i){previewIdx=i;const x=staged[i],v=el("vmPreview"),im=v.querySelector("img"),vd=v.querySelector("video");
 im.hidden=x.type!=="image";vd.hidden=x.type!=="video";vd.pause();vpReset();
 el("vpBar").hidden=x.type!=="video";
 if(x.type==="image"){im.src=x.url}
 else{
  /* spinner while loading. Phone files often have an empty/odd type and then fail to play, so on a failure it is tried once more as MP4
     (the same bytes, only the label changes). If it still cannot play, a clean note is shown - never the browser's default player. */
  vpWait(true);let retried=false;
  vd.onerror=()=>{if(!vd.getAttribute("src"))return;
   if(!retried){retried=true;vpFree();try{vpAlt=URL.createObjectURL(new Blob([x.file],{type:"video/mp4"}));vd.src=vpAlt;vd.play().catch(()=>{});return}catch(e){}}
   vpWait(false);el("vpFail").hidden=false;el("vpBar").hidden=true};
  vd.src=x.url;vd.play().catch(()=>{});
 }
 paintPreviewOnce();v.hidden=false}
function vpWait(on){const sp=el("vpSpin"),st=el("vpStage");if(!sp)return;sp.hidden=!on;st.classList.toggle("vp-wait",!!on)}
function vpReset(){const vd=el("vmPreview").querySelector("video");vd.controls=false;vd.muted=false;vd.playbackRate=1;el("vpFill").style.width="0";el("vpTime").textContent="-0:00";el("vpPlay").innerHTML=VVI.pause;el("vpMute").innerHTML=VVI.vol;el("vpFail").hidden=true;vpWait(false)}
function closePreview(){const v=el("vmPreview");if(!v||v.hidden)return;const vd=v.querySelector("video");vd.pause();vd.onerror=null;vd.removeAttribute("src");vpFree();v.querySelector("img").removeAttribute("src");vpWait(false);el("vpFail").hidden=true;v.hidden=true;previewIdx=-1}
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
  if(f.size>MAX_MEDIA){toast("“"+f.name+"” is larger than 500 MB");continue}
  const type=kindOf(f);staged.push({file:f,type,once:false,url:type==="file"?null:URL.createObjectURL(f)});
 }
 renderStage();
}
el("vmFile").addEventListener("change",onFiles);el("vmImageFile").addEventListener("change",onFiles);el("vmVideoFile").addEventListener("change",onFiles);el("vmAnyFile").addEventListener("change",onFiles);
const findMsg=id=>(store.convs[activeId]?.msgs||[]).find(x=>x.id===id);
function saveAs(u,name){const l=document.createElement("a");l.href=u;l.download=name||"download";document.body.appendChild(l);l.click();l.remove()}
let onceId=null;
const VVI={play:'<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/></svg>',pause:'<svg viewBox="0 0 24 24"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/></svg>',
 vol:'<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/></svg>',
 mute:'<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
 fs:'<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'};
const vvTime=t=>{t=Math.max(0,Math.floor(t||0));return Math.floor(t/60)+":"+String(t%60).padStart(2,"0")};
function vvWho(m){
 const u=activeUser||{};
 if(m&&m.from==="them")return{name:u.contactName||"Veltrix Support",photo:"app.assets/veltrix-support-logo.png",hue:210};
 return{name:u.name||"",photo:u.photo||"",hue:210}}
function openViewer(kind,url,m){
 const v=el("vmViewer"),im=v.querySelector(".vv-stage img"),vd=v.querySelector(".vv-stage video");im.hidden=kind!=="image";vd.hidden=kind!=="video";
 const w=vvWho(m),av=el("vvAv"),cap=String((m&&m.text)||"").trim();
 el("vvName").textContent=w.name;av.textContent="";const ini=document.createElement("span");ini.textContent=initials(w.name||"?");av.appendChild(ini);av.style.background="hsl("+w.hue+" 42% 34%)";
 if(w.photo){const ph=document.createElement("img");ph.alt="";ph.onerror=()=>ph.remove();ph.src=w.photo;av.appendChild(ph)}
 const c=el("vvCap");c.textContent=cap;c.hidden=!cap;
 el("vvBar").hidden=kind!=="video";vvReset();
 if(kind==="image")im.src=url;else{vd.onerror=()=>toast("This video format can't be played on this device. Tap download to save it.");vd.src=url;vd.play().catch(()=>{})}
 v.hidden=false}
function vvReset(){const vd=el("vmViewer").querySelector(".vv-stage video");vd.playbackRate=1;vd.muted=false;el("vvSpeed").textContent="1x";el("vvFill").style.width="0";el("vvTime").textContent="-0:00";el("vvPlay").innerHTML=VVI.pause;el("vvMute").innerHTML=VVI.vol;el("vvFs").innerHTML=VVI.fs;
 try{if(document.fullscreenElement)document.exitFullscreen()}catch(e){}}
function closeViewer(){const v=el("vmViewer");if(v.hidden)return;const vd=v.querySelector("video");vd.pause();vd.removeAttribute("src");v.querySelector(".vv-stage img").removeAttribute("src");vvReset();v.hidden=true;
 if(onceId){const id=onceId;onceId=null;delBlob(id);mutate(()=>{const m=findMsg(id);if(m)m.opened=true});renderMsgs(false);renderConvs()}}
msgsEl.addEventListener("click",async e=>{
 const dl=e.target.closest("[data-dl]");
 if(dl){const id=dl.dataset.dl,m=findMsg(id),u=m&&await mediaURL(id,m.type,m.type==="video"?(m.name||"video"):null);if(!m||!u)return toast("Media unavailable");
  saveAs(u,m.name||(m.type==="image"?"photo":"video"));mutate(()=>{const x=findMsg(id);if(x)x.adDl=true});renderMsgs(false);toast("Downloaded — tap to view");return}
 const vw=e.target.closest("[data-view]");
 if(vw){const m=findMsg(vw.dataset.view),u=m&&await mediaURL(vw.dataset.view,m.type);if(!m||!u)return toast("Media unavailable");openViewer(m.type,u,m);return}
 const oc=e.target.closest("[data-once-open]");
 if(oc){const m=findMsg(oc.dataset.onceOpen);if(!m||m.opened)return;const u=await mediaURL(m.id,m.type);if(!u){const id=m.id;mutate(()=>{const x=findMsg(id);if(x)x.opened=true});renderMsgs(false);return toast("Media unavailable")}onceId=m.id;openViewer(m.type,u,m);return}
 const a=e.target.closest("[data-file]");
 if(a){e.preventDefault();const m=findMsg(a.dataset.file),u=m&&await mediaURL(a.dataset.file,"file",m.name||"file");if(!u||!m)return toast("File unavailable");saveAs(u,m.name)}
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
(function(){const v=el("vmViewer"),vd=v.querySelector(".vv-stage video"),prog=el("vvProg");
 const upd=()=>{const d=vd.duration,t=vd.currentTime||0;el("vvFill").style.width=(d>0&&isFinite(d)?Math.min(100,t/d*100):0)+"%";el("vvTime").textContent="-"+vvTime(isFinite(d)?d-t:0);prog.setAttribute("aria-valuenow",String(Math.round(d>0&&isFinite(d)?t/d*100:0)))};
 const toggle=()=>{if(vd.paused)vd.play().catch(()=>{});else vd.pause()};
 vd.addEventListener("timeupdate",upd);vd.addEventListener("loadedmetadata",upd);vd.addEventListener("durationchange",upd);
 vd.addEventListener("play",()=>{el("vvPlay").innerHTML=VVI.pause;el("vvPlay").setAttribute("aria-label","Pause")});vd.addEventListener("pause",()=>{el("vvPlay").innerHTML=VVI.play;el("vvPlay").setAttribute("aria-label","Play")});
 vd.addEventListener("ended",()=>{el("vvPlay").innerHTML=VVI.play});
 vd.addEventListener("click",toggle);el("vvPlay").addEventListener("click",toggle);
 const speeds=[1,1.5,2,0.5];el("vvSpeed").addEventListener("click",()=>{const i=speeds.indexOf(vd.playbackRate),n=speeds[(i+1)%speeds.length];vd.playbackRate=n;el("vvSpeed").textContent=n+"x"});
 el("vvMute").addEventListener("click",()=>{vd.muted=!vd.muted;el("vvMute").innerHTML=vd.muted?VVI.mute:VVI.vol});
 el("vvFs").addEventListener("click",()=>{try{if(document.fullscreenElement){document.exitFullscreen();return}if(v.requestFullscreen)v.requestFullscreen();else if(vd.webkitEnterFullscreen)vd.webkitEnterFullscreen()}catch(e){}});
 let drag=false;const seek=e=>{const r=prog.getBoundingClientRect(),d=vd.duration;if(!(d>0&&isFinite(d)))return;vd.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*d;upd()};
 prog.addEventListener("pointerdown",e=>{drag=true;try{prog.setPointerCapture(e.pointerId)}catch(x){}seek(e)});prog.addEventListener("pointermove",e=>{if(drag)seek(e)});prog.addEventListener("pointerup",()=>{drag=false});prog.addEventListener("pointercancel",()=>{drag=false});
})();
el("vmViewer").addEventListener("click",e=>{if(e.target===e.currentTarget)closeViewer()});
/* Preview before sending: same custom player as the viewer (spinner while loading, tap to play/pause, slim progress + controls) */
(function(){const v=el("vmPreview"),vd=v.querySelector("video"),prog=el("vpProg");
 const upd=()=>{const d=vd.duration,t=vd.currentTime||0,ok=d>0&&isFinite(d);el("vpFill").style.width=(ok?Math.min(100,t/d*100):0)+"%";el("vpTime").textContent="-"+vvTime(ok?d-t:0);prog.setAttribute("aria-valuenow",String(Math.round(ok?t/d*100:0)))};
 const toggle=()=>{if(vd.paused)vd.play().catch(()=>{});else vd.pause()};
 vd.addEventListener("timeupdate",upd);vd.addEventListener("loadedmetadata",upd);vd.addEventListener("durationchange",upd);
 ["loadeddata","canplay","playing"].forEach(ev=>vd.addEventListener(ev,()=>{if(vd.readyState>=2)vpWait(false)}));
 vd.addEventListener("waiting",()=>{if(!vd.paused&&!vd.hidden&&vd.getAttribute("src"))vpWait(true)});
 vd.addEventListener("play",()=>{el("vpPlay").innerHTML=VVI.pause;el("vpPlay").setAttribute("aria-label","Pause")});
 vd.addEventListener("pause",()=>{el("vpPlay").innerHTML=VVI.play;el("vpPlay").setAttribute("aria-label","Play")});
 vd.addEventListener("ended",()=>{el("vpPlay").innerHTML=VVI.play});
 vd.addEventListener("click",toggle);el("vpPlay").addEventListener("click",toggle);
 el("vpMute").addEventListener("click",()=>{vd.muted=!vd.muted;el("vpMute").innerHTML=vd.muted?VVI.mute:VVI.vol});
 let drag=false;const seek=e=>{const r=prog.getBoundingClientRect(),d=vd.duration;if(!(d>0&&isFinite(d)))return;vd.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*d;upd()};
 prog.addEventListener("pointerdown",e=>{drag=true;try{prog.setPointerCapture(e.pointerId)}catch(x){}seek(e)});prog.addEventListener("pointermove",e=>{if(drag)seek(e)});prog.addEventListener("pointerup",()=>{drag=false});prog.addEventListener("pointercancel",()=>{drag=false});
})();

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
/* Disappearing messages (three-dot menu): while ON, every new message in this chat vanishes 24 hours after it is sent, on both sides */
window.vxDisappear={
 get(){const t=activeId&&store.convs[activeId];return !!(t&&t.rc&&t.rc.disappear)},
 set(on){const usr=activeUser;if(!usr)return;on=!!on;mutate(()=>{const t=ensureThread(usr);if(t.rc)t.rc.disappear=on});
  toast(on?"Disappearing messages on · new messages vanish after 24 hours":"Disappearing messages off")}
};

/* ---------- small public API (testing now, backend wiring later) ---------- */
window.VeltrixAdmin={
 /* Supply the app's recent users: an array of {id,name,photo?} or a function returning one (replaces the localStorage list). */
 setRecentUsers(listOrFn){recentProvider=listOrFn||null;if(!P.hidden)renderUsers()},
 refresh
};

/* ---------- start ---------- */
function gate(){return new Promise(res=>{
 const g=document.createElement("div");g.style.cssText="position:fixed;inset:0;z-index:9999;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;padding:24px";
 const f='padding:12px;border:1px solid #cfd0d6;border-radius:10px;font-size:14.5px;background:#fff;color:#111';
 g.innerHTML=`<form style="width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px"><h1 style="margin:0 0 4px;font-size:20px">Veltrix Admin</h1><input type="email" name="e" placeholder="Admin email" required autocomplete="username" style="${f}"><input type="password" name="p" placeholder="Password" required autocomplete="current-password" style="${f}"><button style="padding:12px;border:0;border-radius:10px;background:#111;color:#fff;font-size:14.5px">Sign in</button><p style="color:#e5484d;margin:0;font-size:12px;min-height:16px"></p></form>`;
 document.body.appendChild(g);const form=g.querySelector("form"),msg=g.querySelector("p");
 form.addEventListener("submit",async e=>{e.preventDefault();msg.textContent="";
  try{const a=await veltrixDB.signInOnly(form.e.value.trim().toLowerCase(),form.p.value);
   if(!a)return;if(!a.isAdmin){location.replace("index.html");return}
   g.remove();res()}catch{msg.textContent="The email address or password is incorrect."}})})}
function applyTheme(){const d=veltrixDB.pref.get("theme","dark")!=="light";
 if(d)document.documentElement.setAttribute("data-theme","dark");else document.documentElement.removeAttribute("data-theme");
 try{localStorage.setItem("veltrixTheme",d?"dark":"light")}catch{}}
async function startAdmin(){
 await veltrixDB.admin.start();dirCache=await veltrixDB.admin.directory();
 applyTheme();
 loadStore();renderConvs();
}
(async()=>{
 try{
  document.body.style.visibility="hidden";
  let a=null;try{a=await veltrixDB.restoreAccount()}catch(e){console.error(e)}
  if(a&&a.isAdmin)applyTheme();
  if(a&&!a.isAdmin){location.replace("index.html");return}       /* signed in but not an administrator: send them away before anything shows */
  if(window.__splash)window.__splash.release("boot");
  document.body.style.visibility="";
  if(!a)await gate();
  await startAdmin();
 }catch(e){console.error(e);toast("Couldn't load messages. Please refresh.")}
})();
})();
