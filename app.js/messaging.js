/* Veltrix messaging (demo). Self-contained: does not modify any existing script.
   - Message text/metadata: Supabase tables conversations + messages
   - Voice notes, photos and videos: Supabase Storage bucket "chat-media"
   - Users: 5,000 generated demo users below. Swap DEMO_USERS for your real users list/API later. */
(function(){
"use strict";
const NAMES="Ada Obi,Chinedu Okafor,Amara Nwosu,Tunde Bakare,Zainab Musa,Emeka Eze,Ngozi Adebayo,Ifeanyi Uche,Fatima Bello,Kelechi Onu,Seyi Adeyemi,Blessing Okon,David Mensah,Grace Tetteh,Samuel Boateng,Linda Osei,Kwame Asante,Esther Kamau,Brian Otieno,Wanjiku Njeri,Thabo Mokoena,Naledi Dlamini,Sipho Khumalo,Lerato Molefe,Amina Diallo,Moussa Traore,Aisha Camara,Youssef Haddad,Layla Mansour,Omar Farouk,Sofia Rossi,Lucas Martin,Emma Dubois,Noah Schmidt,Mia Fischer,Liam Walker,Olivia Brown,Ethan Clark,Ava Turner,Mason Lee,Isabella Garcia,Mateo Silva,Valentina Cruz,Arjun Mehta,Priya Sharma,Wei Chen,Mei Tanaka,Hiro Sato,Yuna Kim,Daniel Novak".split(",");
/* ---------- 5,000 demo users: every full name unique, every picture unique ---------- */
const USER_COUNT=5000;
const FIRST="Aaliyah,Abel,Abena,Adaeze,Adrian,Aiko,Akira,Alba,Alejandro,Alice,Amelie,Anders,Andile,Anika,Anton,Aroha,Astrid,Ayaan,Ayesha,Beatriz,Benedikt,Bilal,Bongani,Camila,Carlos,Chiamaka,Chloe,Cyrus,Dalia,Daniel,Darius,Deepa,Diego,Dmitri,Efua,Elena,Elif,Elijah,Emre,Esperanza,Farid,Felix,Freya,Gabriel,Gaurav,Giulia,Hana,Hannah,Hassan,Hiro,Hugo,Ibrahim,Idris,Ines,Ingrid,Isaac,Ivan,Jabu,Jana,Jasper,Jin,Joao,Kai,Kamal,Karina,Kasper,Kenji,Khadija,Kofi,Lars,Leila,Leon,Lina,Lorenzo,Luca,Lucia,Mahlet,Malik,Marco,Maria,Marta,Mei,Mira,Mohan,Nadia,Naveen,Nia,Nikolai,Nora,Oluwaseun,Omar,Oscar,Pablo,Paulo,Petra,Pierre,Rafael,Rahul,Rania,Rasmus,Reza,Rosa,Ruth,Sade,Salma,Santiago,Saoirse,Sara,Sven,Tariq,Teresa,Thiago,Tomas,Uche,Valeria,Vikram,Wanjiru,Xavier,Yara,Yuki,Zara,Zeynep,Ziad".split(",");
const LAST="Abbas,Adeleke,Aguilar,Ahmed,Akintola,Alvarez,Andersson,Bailey,Banerjee,Barros,Bianchi,Bose,Campos,Carvalho,Chaudhry,Chen,Choi,Costa,Dahl,Das,Delgado,Demir,Dlamini,Dupont,Eriksen,Fernandez,Ferrari,Garcia,Gomez,Gupta,Hansen,Hassan,Hoffmann,Hughes,Ibekwe,Ito,Jansen,Jovanovic,Kaya,Khan,Kim,Kowalski,Kruger,Kumar,Larsen,Lopez,Lund,Malik,Marques,Mbeki,Mendes,Moreno,Mueller,Murphy,Nakamura,Naidoo,Nguyen,Nielsen,Novak,Nwankwo,Okeke,Olsen,Ortega,Osei,Pereira,Petrov,Popov,Qureshi,Ramos,Reddy,Rivera,Rojas,Romano,Sahin,Sanchez,Santos,Sato,Silva,Singh,Soto,Suzuki,Tanaka,Tan,Torres,Varga,Vega,Wagner,Wang,Weber,Yamamoto,Yilmaz,Zhang,Zulu,Achebe,Banda,Cisse,Diop,Eze,Fofana,Gueye,Haile,Juma,Kamara,Lumumba,Mwangi,Ndlovu,Okoro,Phiri,Sow,Tesfaye".split(",");
const DEMO_USERS=(function(){
 const seen=new Set(),list=[];
 NAMES.forEach(n=>{seen.add(n.toLowerCase());list.push(n)});            /* keep the original 50, same order/ids */
 let a=987654321;const rnd=()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
 const combos=[];for(let i=0;i<FIRST.length;i++)for(let j=0;j<LAST.length;j++)combos.push(i*LAST.length+j);
 for(let i=combos.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));const t=combos[i];combos[i]=combos[j];combos[j]=t}
 for(let k=0;k<combos.length&&list.length<USER_COUNT;k++){const n=FIRST[Math.floor(combos[k]/LAST.length)]+" "+LAST[combos[k]%LAST.length];if(!seen.has(n.toLowerCase())){seen.add(n.toLowerCase());list.push(n)}}
 return list.map((name,i)=>({id:"demo-"+(i+1),name,n:i,hue:(i*47)%360,key:name.toLowerCase()}));
})();
/* Scattered order: shuffled randomly each time the app loads (not alphabetical). */
const USERS_SHUFFLED=(function(){const a=DEMO_USERS.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));const t=a[i];a[i]=a[j];a[j]=t}return a})();
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
 once:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-dasharray="3.2 3"/><path d="M10.2 9.6 12.6 8v8.2"/></svg>',
 dl:'<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
 x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
 doc:'<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v5h5"/></svg>',
 play:'<svg class="pl" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><svg class="pa" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
};
const $=(s,r)=>(r||document).querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
/* Emoji: the dark theme inverts the whole page, which turns emoji brown/odd. Wrap them so CSS can un-invert them. */
const EMOJI_RE=/(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)*)/gu;
const emoW=h=>String(h).replace(EMOJI_RE,'<span class="vm-emoji">$&</span>');
const escE=s=>emoW(esc(s));
const initials=n=>n.split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase();
/* ---------- Profile pictures: real photographs only ----------
   Every user gets a different photo. Sources (free photo services, no drawings or cartoons):
   - 270 portrait photos of people (randomuser.me + pravatar): each photo id used once
   - 1,000 mixed photos (picsum.photos): each photo id used once
   - the rest: photo searches by subject (man, woman, house, beach, city, dog...) from loremflickr.com,
     each user requesting their own numbered photo so no two users ask for the same one.
   Pictures are scattered randomly through the list. If a photo can't load, the user shows their initials. */
const PHOTO_PEOPLE=[];for(let k=0;k<100;k++){PHOTO_PEOPLE.push("https://randomuser.me/api/portraits/men/"+k+".jpg");PHOTO_PEOPLE.push("https://randomuser.me/api/portraits/women/"+k+".jpg")}
for(let k=1;k<=70;k++)PHOTO_PEOPLE.push("https://i.pravatar.cc/120?img="+k);
const PHOTO_MISC_COUNT=1000;                                   /* picsum photo ids 0..999 */
/* subject -> weight (people, houses, beach, cities and animals are the most common, like a normal user list) */
const SUBJECTS=[["man",6],["woman",6],["portrait",5],["house",4],["home",2],["beach",4],["city",4],["skyline",2],["dog",4],["puppy",2],["cat",3],["kitten",1],["horse",1],["bird",2],["flower",3],["mountain",2],["lake",1],["forest",1],["sunset",2],["car",3],["motorcycle",1],["bicycle",1],["food",2],["coffee",1],["pizza",1],["street",2],["bridge",1],["building",2],["park",1],["garden",1],["river",1],["island",1],["snow",1],["desert",1],["boat",1],["airplane",1],["train",1],["guitar",1],["football",2],["basketball",1],["camera",1],["castle",1],["village",1],["waterfall",1]];
const PIC_PLAN=(function(){
 const plan=[];
 for(let k=0;k<PHOTO_PEOPLE.length;k++)plan.push({t:"people",k});
 for(let k=0;k<PHOTO_MISC_COUNT;k++)plan.push({t:"photo",k});
 const rest=USER_COUNT-plan.length,wsum=SUBJECTS.reduce((x,y)=>x+y[1],0);
 let given=0;
 SUBJECTS.forEach((sj,si)=>{const n=si===SUBJECTS.length-1?rest-given:Math.round(rest*sj[1]/wsum);given+=n;for(let k=0;k<n;k++)plan.push({t:"subject",kw:sj[0],k:k+1})});
 let a=24681357;const rnd=()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
 for(let i=plan.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));const t=plan[i];plan[i]=plan[j];plan[j]=t}
 return plan;
})();
function avatarSrc(u){
 const pl=PIC_PLAN[u.n];
 if(pl.t==="people")return PHOTO_PEOPLE[pl.k];
 if(pl.t==="photo")return "https://picsum.photos/id/"+pl.k+"/120/120";
 return "https://loremflickr.com/120/120/"+pl.kw+"?lock="+pl.k;
}
/* a photo that fails to load is hidden and the user's initials show instead */
document.addEventListener("error",e=>{const t=e.target;if(t&&t.tagName==="IMG"&&t.dataset&&t.dataset.n&&t.parentElement&&t.parentElement.classList.contains("vm-av")){t.style.display="none";t.parentElement.classList.add("vm-avatar-fallback")}},true);
const av=(u,cls)=>u.support?`<span class="vm-av ${cls||""} vm-avatar-fallback" style="background:hsl(${u.hue} 42% 34%)"><span class="vm-avatar-initials">${esc(initials(u.name))}</span></span>`:`<span class="vm-av ${cls||""}" style="background:hsl(${u.hue} 42% 34%)"><img src="${avatarSrc(u)}" data-n="${u.n}" alt="" loading="lazy" decoding="async"><span class="vm-avatar-initials">${esc(initials(u.name))}</span></span>`;
const fmtT=t=>new Date(t).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
const fmtSize=b=>b<1024?b+" B":b<1048576?(b/1024).toFixed(0)+" KB":(b/1048576).toFixed(1)+" MB";
const fmtDur=s=>Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
const dayKey=t=>new Date(t).toDateString();
function dayLabel(t){const d=new Date(t),n=new Date(),y=new Date(Date.now()-864e5);return d.toDateString()===n.toDateString()?"Today":d.toDateString()===y.toDateString()?"Yesterday":d.toLocaleDateString(undefined,{day:"numeric",month:"long",year:"numeric"})}
function listTime(t){const d=new Date(t);if(d.toDateString()===new Date().toDateString())return fmtT(t);if(d.toDateString()===new Date(Date.now()-864e5).toDateString())return "Yesterday";return d.toLocaleDateString(undefined,{day:"2-digit",month:"2-digit",year:"2-digit"})}

/* ---------- storage ---------- */
let store={convs:{}},storeKey=null;
function accountId(){try{const a=typeof getAccount==="function"?getAccount():null;return a&&a.id?a.id:"guest"}catch{return "guest"}}
function loadStore(){store=veltrixDB.chat.store();if(!store.convs)store.convs={}}
function saveStore(){veltrixDB.chat.save()}
const memBlobs=new Map(),urls=new Map();
async function putBlob(id,blob){memBlobs.set(id,blob);try{await veltrixDB.media.put(accountId(),id,blob)}catch(e){console.error(e);toast("Couldn't upload this file. Please try again.")}}
async function getBlob(id){if(memBlobs.has(id))return memBlobs.get(id);const b=await veltrixDB.media.get(accountId(),id);if(b)memBlobs.set(id,b);return b}
async function mediaURL(id){if(urls.has(id))return urls.get(id);const b=await getBlob(id);if(!b)return null;const u=URL.createObjectURL(b);urls.set(id,u);return u}
async function delBlob(id){memBlobs.delete(id);if(urls.has(id)){URL.revokeObjectURL(urls.get(id));urls.delete(id)}await veltrixDB.media.del(accountId(),id)}

/* ---------- DOM ---------- */
const host=document.getElementById("dashboardPage");
if(!host)return;
const wrap=document.createElement("div");
wrap.innerHTML=`
<section class="vm-page" id="vmList" hidden aria-label="Messages">
 <header class="vm-top"><button type="button" class="vm-ic" id="vmBack" aria-label="Back to dashboard">${I.back}</button><h1>Messages</h1></header>
 <label class="vm-search">${I.search}<input type="search" id="vmSearch" placeholder="Search conversations" autocomplete="off" aria-label="Search conversations"></label>
 <div class="vm-scroll" id="vmConvs"></div>
 <button type="button" class="vm-fab" id="vmNew" aria-label="Start a new conversation">${I.plus}</button>
</section>
<section class="vm-page vm-over" id="vmPick" hidden aria-label="Start a new conversation">
 <header class="vm-top"><button type="button" class="vm-ic" id="vmPickBack" aria-label="Back to messages">${I.back}</button><div style="flex:1"><h1>New conversation</h1></div></header>
 <label class="vm-search">${I.search}<input type="search" id="vmPickSearch" placeholder="Search users" autocomplete="off" aria-label="Search users"></label>
 <div class="vm-scroll" id="vmUsers"></div>
</section>
<section class="vm-page vm-over" id="vmChat" hidden aria-label="Conversation">
 <header class="vm-head"><button type="button" class="vm-ic" id="vmChatBack" aria-label="Back to messages">${I.back}</button><div class="vm-body" id="vmChatWho"></div>
 </header>
 <div class="vm-msgs" id="vmMsgs"></div>
 <div class="vm-stage" id="vmStage" hidden></div>
 <div class="vm-editing" id="vmEditing" hidden><div><small id="vmEditingLabel">Editing message</small><p id="vmEditingText"></p></div><button type="button" id="vmEditCancel" aria-label="Cancel editing">×</button></div>
 <div class="vm-bar">
  <div class="vm-field" id="vmField"><div class="vm-ta"><div class="vm-mirror" id="vmMirror" aria-hidden="true"></div><textarea id="vmText" rows="1" placeholder="Message" aria-label="Type a message"></textarea></div><button type="button" class="vm-ic" id="vmAttach" aria-label="Attach photo, video or file">${I.clip}</button></div>
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
<input type="file" id="vmAnyFile" multiple hidden>`
while(wrap.firstChild)host.appendChild(wrap.firstChild);
const el=id=>document.getElementById(id);
const L=el("vmList"),P=el("vmPick"),C=el("vmChat"),msgsEl=el("vmMsgs"),text=el("vmText"),sendBtn=el("vmSend");
let tt;function toast(m){const t=el("vmToast");t.textContent=m;t.classList.add("show");clearTimeout(tt);tt=setTimeout(()=>t.classList.remove("show"),2200)}
let activeId=null;
/* "Veltrix Support": the contact an admin writes as when the admin starts the conversation (see admin.html). */
const SUPPORT_USER={id:"veltrix-support",name:"Veltrix Support",n:0,hue:225,key:"veltrix support",support:true};
const userById=id=>id===SUPPORT_USER.id?SUPPORT_USER:DEMO_USERS.find(u=>u.id===id);

/* ---------- conversation list ---------- */
/* Read receipts (WhatsApp style): c.adminReadAt = when the other side last opened this chat; c.userReadAt = when this user did.
   ✓✓ stay white until the other side opens the chat, then turn green. Incoming messages newer than userReadAt are "unread". */
const tickHTML=read=>`<b class="vm-tk${read?" read":""}">✓✓</b>`;
const unreadOf=c=>c&&c.msgs?c.msgs.filter(m=>m.from==="them"&&m.t>(c.userReadAt||0)).length:0;
let divN=0,divAt=0;
function preview(m,c){if(!m)return "";const t=m.once&&m.type==="image"?"📷 One-time photo":m.once&&m.type==="video"?"🎥 One-time video":m.type==="image"?"📷 Photo":m.type==="video"?"🎥 Video":m.type==="audio"?"🎤 Voice message ("+fmtDur(m.dur||0)+")":m.type==="file"?"📎 "+esc(m.name||"File"):esc(m.text);return (m.from==="me"?tickHTML(m.t<=((c&&c.adminReadAt)||0)):"")+emoW(t)}
function renderConvs(){
 const q=el("vmSearch").value.trim().toLowerCase();
 const rows=Object.entries(store.convs).filter(([id,c])=>c.msgs&&c.msgs.length&&userById(id)).map(([id,c])=>({u:userById(id),c,last:c.msgs[c.msgs.length-1],unread:unreadOf(c)}))
  .filter(r=>!q||r.u.name.toLowerCase().includes(q)).sort((a,b)=>b.last.t-a.last.t);
 el("vmConvs").innerHTML=rows.length?rows.map(r=>`<button type="button" class="vm-row${r.unread?" vm-unread":""}" data-uid="${r.u.id}">${av(r.u)}<span class="vm-body"><span class="vm-l1"><span class="vm-name">${esc(r.u.name)}</span><span class="vm-time">${listTime(r.last.t)}</span></span><span class="vm-l2"><div class="vm-prev">${preview(r.last,r.c)}</div>${r.unread?`<b class="vm-badge-n" aria-label="${r.unread} unread">${r.unread>9999?"9999+":r.unread}</b>`:""}</span></span></button>`).join("")
  :`<div class="vm-empty"><div class="vm-eic">${I.chat}</div><h2>${q?"No matches":"No conversations yet"}</h2><p>${q?"Try a different name.":"Tap the blue button to start a conversation with someone."}</p></div>`;
}
el("vmConvs").addEventListener("click",e=>{const r=e.target.closest("[data-uid]");if(r&&!r.dataset.longPressed)openChat(r.dataset.uid);delete r?.dataset.longPressed});
// Long-press a conversation row to manage the entire room.
function bindLongPress(container, selector, action){let timer, fired=false;container.addEventListener("pointerdown",e=>{const row=e.target.closest(selector);if(!row)return;fired=false;timer=setTimeout(()=>{fired=true;row.dataset.longPressed="1";action(row)},600)});["pointerup","pointerleave","pointercancel"].forEach(n=>container.addEventListener(n,()=>clearTimeout(timer)));container.addEventListener("contextmenu",e=>{const row=e.target.closest(selector);if(row){e.preventDefault();action(row)}})}
bindLongPress(el("vmConvs"),"[data-uid]",row=>{const uid=row.dataset.uid,u=userById(uid);if(u)showDialog("Delete conversation?",`Delete the complete conversation with ${u.name}? This cannot be undone.`,[{label:"Delete conversation",danger:true,run:()=>{delete store.convs[uid];saveStore();renderConvs();toast("Conversation deleted")}}])});
el("vmSearch").addEventListener("input",renderConvs);

function openList(){loadStore();{let ch=false;for(const id in store.convs){const c=store.convs[id],cu=userById(id);if(c&&cu&&!c.name){c.name=cu.name;ch=true}}if(ch)saveStore()}el("vmSearch").value="";renderConvs();L.hidden=false;document.body.classList.add("wd-feature-open")}
function closeList(){stopPlayback();L.hidden=true;updateBadge();document.body.classList.remove("wd-feature-open")}
el("vmBack").addEventListener("click",closeList);

/* The "Messaging" quick action (capture phase so the old "coming soon" toast never fires). */
host.addEventListener("click",e=>{const b=e.target.closest("#dashboardPage .wd-actions [data-action]");if(b&&(b.dataset.action==="Messaging"||/messaging/i.test(b.textContent))){e.stopPropagation();e.preventDefault();openList()}},true);

/* ---------- new conversation: user picker ---------- */
let pickList=[],pickShown=0,pickObs=null;
const PICK_BATCH=80;
const userRow=u=>`<button type="button" class="vm-row" data-uid="${u.id}">${av(u)}<span class="vm-body"><span class="vm-name">${esc(u.name)}</span><div class="vm-prev">${store.convs[u.id]&&store.convs[u.id].msgs&&store.convs[u.id].msgs.length?"Existing conversation":"Tap to start a conversation"}</div></span></button>`;
function pickMore(){
 const box=el("vmUsers"),old=box.querySelector(".vm-sentinel");if(old)old.remove();
 const next=pickList.slice(pickShown,pickShown+PICK_BATCH);pickShown+=next.length;
 box.insertAdjacentHTML("beforeend",next.map(userRow).join(""));
 if(pickShown<pickList.length){const s=document.createElement("div");s.className="vm-sentinel";s.style.height="1px";box.appendChild(s);if(pickObs)pickObs.observe(s)}
}
function renderUsers(){
 const q=el("vmPickSearch").value.trim().toLowerCase();
 pickList=q?USERS_SHUFFLED.filter(u=>u.key.includes(q)):USERS_SHUFFLED;pickShown=0;
 const box=el("vmUsers");box.scrollTop=0;
 if(!pickObs&&"IntersectionObserver"in window)pickObs=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting))pickMore()},{root:box,rootMargin:"800px"});
 box.innerHTML=pickList.length?"":`<div class="vm-empty"><h2>No users found</h2></div>`;
 if(pickList.length)pickMore();
}
el("vmNew").addEventListener("click",()=>{el("vmPickSearch").value="";renderUsers();P.hidden=false});
el("vmPickBack").addEventListener("click",()=>{P.hidden=true});
el("vmPickSearch").addEventListener("input",renderUsers);
el("vmUsers").addEventListener("click",e=>{const r=e.target.closest("[data-uid]");if(r){P.hidden=true;openChat(r.dataset.uid)}});

/* ---------- chat screen ---------- */
function openChat(uid){
 const u=userById(uid);if(!u)return;activeId=uid;editingId=null;el("vmEditing").hidden=true;
 {const c=store.convs[uid];divAt=(c&&c.userReadAt)||0;divN=unreadOf(c);markReadUser(uid)}
 el("vmChatWho").innerHTML=av(u,"vm-sm")+`<span class="vm-name">${esc(u.name)}</span>`;
 clearStage();text.value="";autosize();setMode();renderMsgs(true);C.hidden=false;
}
function closeChat(){clearStage();closePreview();closeViewer();if(recorder)cancelRec();stopPlayback();C.hidden=true;activeId=null;divN=0;renderConvs();updateBadge()}
el("vmChatBack").addEventListener("click",closeChat);

function bubble(m){
 const meta=`<span class="vm-meta">${fmtT(m.t)}${m.from==="me"?tickHTML(m.t<=((store.convs[activeId]&&store.convs[activeId].adminReadAt)||0)):""}</span>`,cls="vm-b "+(m.from==="me"?"me":"them");
 const sz=m.size?fmtSize(m.size):"";
 if((m.type==="image"||m.type==="video")&&m.once){
  const me=m.from==="me",label=(m.type==="image"?"Photo":"Video")+(m.opened?" · Opened":me?" · One-time view":" · Tap to view once");
  return `<div class="${cls}" data-mid="${m.id}"><button type="button" class="vm-oncecard${m.opened?" done":""}" ${!me&&!m.opened?`data-once-open="${m.id}"`:"disabled"}>${I.once}<span>${label}</span></button>${meta}</div>`}
 if(m.type==="image"||m.type==="video"){
  const dl=!!m.downloaded,isI=m.type==="image";
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
 let divDone=false;for(const m of ms){const k=dayKey(m.t);if(k!==last){html+=`<div class="vm-day">${dayLabel(m.t)}</div>`;last=k}if(divN>0&&!divDone&&m.from==="them"&&m.t>divAt){divDone=true;html+=`<div class="vm-newdiv" id="vmNewDiv"><span>${divN} unread message${divN>1?"s":""}</span></div>`}html+=bubble(m)}
 msgsEl.innerHTML=html||`<div class="vm-hello">Say hello 👋<br>Send a message, a voice note, a photo or a video.</div>`;
 msgsEl.querySelectorAll("[data-m]").forEach(async n=>{const u=await mediaURL(n.dataset.m);if(u)n.src=n.tagName==="VIDEO"?u+"#t=0.1":u;else n.replaceWith(Object.assign(document.createElement("div"),{className:"vm-gone",textContent:"Media unavailable"}))});
 if(forceBottom||near)requestAnimationFrame(()=>{const d=forceBottom&&document.getElementById("vmNewDiv");msgsEl.scrollTop=d?Math.max(0,d.offsetTop-70):msgsEl.scrollHeight});
}
async function addMsg(m,blob){
 const uid=activeId;if(!uid)return;
 m.id=Date.now().toString(36)+Math.random().toString(36).slice(2,7);m.from="me";m.t=Date.now();
 if(blob)await putBlob(m.id,blob);
 {const cv=store.convs[uid]=store.convs[uid]||{msgs:[]},cu=userById(uid);if(cu&&!cv.name)cv.name=cu.name;cv.msgs.push(m)}saveStore();
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
function sendText(){const v=text.value.trim();if(!v)return;if(editingId){const c=store.convs[activeId],m=c&&c.msgs.find(x=>x.id===editingId);if(m){m.text=v;m.edited=true;saveStore();renderMsgs(false);renderConvs();toast("Message updated")}editingId=null;el("vmEditing").hidden=true;text.value="";autosize();setMode();text.focus({preventScroll:true});return}text.value="";autosize();setMode();addMsg({type:"text",text:v});text.focus({preventScroll:true})}
function doSend(){if(editingId&&text.value.trim())sendText();else if(staged.length)sendStaged();else if(text.value.trim())sendText()}
sendBtn.addEventListener("click",()=>{if(recorder)stopRec(true);else if(staged.length||text.value.trim())doSend();else startRec()});

/* photos & videos */
el("vmAttach").addEventListener("click",()=>{const m=el("vmUploadMenu");m.hidden=false});
el("vmUploadMenu").addEventListener("click",e=>{const b=e.target.closest("[data-upload]");if(!b)return;el("vmUploadMenu").hidden=true;({image:"vmImageFile",video:"vmVideoFile",file:"vmAnyFile"}[b.dataset.upload]&&el(({image:"vmImageFile",video:"vmVideoFile",file:"vmAnyFile"})[b.dataset.upload]).click())});
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
 if(onceId){const m=findMsg(onceId);onceId=null;if(m){m.opened=true;delBlob(m.id);saveStore();renderMsgs(false);renderConvs()}}}
msgsEl.addEventListener("click",async e=>{
 const dl=e.target.closest("[data-dl]");
 if(dl){const m=findMsg(dl.dataset.dl),u=await mediaURL(dl.dataset.dl);if(!m||!u)return toast("Media unavailable");
  saveAs(u,m.name||(m.type==="image"?"photo":"video"));m.downloaded=true;saveStore();renderMsgs(false);toast("Downloaded — tap to view");return}
 const vw=e.target.closest("[data-view]");
 if(vw){const m=findMsg(vw.dataset.view),u=await mediaURL(vw.dataset.view);if(!m||!u)return toast("Media unavailable");openViewer(m.type,u);return}
 const oc=e.target.closest("[data-once-open]");
 if(oc){const m=findMsg(oc.dataset.onceOpen);if(!m||m.opened)return;const u=await mediaURL(m.id);if(!u){m.opened=true;saveStore();renderMsgs(false);return toast("Media unavailable")}onceId=m.id;openViewer(m.type,u);return}
 const a=e.target.closest("[data-file]");
 if(a){e.preventDefault();const u=await mediaURL(a.dataset.file),m=findMsg(a.dataset.file);if(!u||!m)return toast("File unavailable");saveAs(u,m.name)}
});
// Custom in-page dialogs; no browser prompt/confirm popups.
function showDialog(title,description,actions){el("vmDialogTitle").textContent=title;el("vmDialogText").textContent=description;el("vmDialogActions").innerHTML=actions.map((a,i)=>`<button type="button" data-dialog-action="${i}" class="${a.danger?"danger":""}">${esc(a.label)}</button>`).join("");el("vmDialog").hidden=false;el("vmDialogActions").querySelectorAll("button").forEach((b,i)=>b.addEventListener("click",()=>{el("vmDialog").hidden=true;actions[i].run()}))}
el("vmDialogCancel").addEventListener("click",()=>el("vmDialog").hidden=true);
el("vmDialog").addEventListener("click",e=>{if(e.target===el("vmDialog"))el("vmDialog").hidden=true});
let editingId=null;
function beginEdit(msg){if(msg.from!=="me"||msg.type!=="text")return toast("Only your text messages can be edited");editingId=msg.id;el("vmEditingLabel").textContent="Editing message";el("vmEditingText").innerHTML=escE(msg.text);el("vmEditing").hidden=false;text.value=msg.text;autosize();setMode();text.focus()}
el("vmEditCancel").addEventListener("click",()=>{editingId=null;el("vmEditing").hidden=true;text.value="";autosize();setMode()});
// Long-press (or right-click) a message to open the styled action sheet.
bindLongPress(msgsEl,".vm-b",row=>{const c=store.convs[activeId];if(!c)return;const msg=c.msgs.find(m=>m.id===row.dataset.mid);if(!msg)return;const actions=[];if(msg.from==="me"&&msg.type==="text")actions.push({label:"Edit message",run:()=>beginEdit(msg)});actions.push({label:"Delete message",danger:true,run:()=>{c.msgs=c.msgs.filter(m=>m!==msg);saveStore();renderMsgs(false);renderConvs();toast("Message deleted")}});showDialog("Message options",msg.from==="me"?"Edit this message or remove it from the conversation.":"Delete this message from your conversation.",actions)});
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

/* Mark this account's incoming messages as read (the other side then sees their ✓✓ turn green). */
function markReadUser(uid){const c=store.convs[uid];if(c&&unreadOf(c)){c.userReadAt=Date.now();saveStore()}updateBadge()}

/* Unread badge on the dashboard's Messaging icon (counts every unread incoming message of this account). */
const badge=document.createElement("i");badge.className="vm-badge";badge.hidden=true;badge.setAttribute("aria-label","Unread messages");
{const circle=host.querySelector('.wd-actions [data-action="Messaging"] .wd-circle');if(circle)circle.appendChild(badge)}
function totalUnread(){try{const o=veltrixDB.chat.store();return Object.values(o.convs||{}).reduce((n,c)=>n+unreadOf(c),0)}catch{return 0}}
function updateBadge(){const n=totalUnread();badge.textContent=n>9999?"9999+":String(n);badge.hidden=!n}
updateBadge();setInterval(updateBadge,2000);

/* Admin replies arrive live through Supabase realtime. */
const sig=id=>{const c=store.convs[id],m=c&&c.msgs||[],l=m[m.length-1];return m.length+":"+(l?l.id+(l.edited?"e":""):"")+":"+((c&&c.adminReadAt)||0)};
window.addEventListener("veltrix-chats",()=>{
 const before=activeId?sig(activeId):"";loadStore();
 if(!L.hidden)renderConvs();
 if(activeId&&!C.hidden){markReadUser(activeId);if(sig(activeId)!==before)renderMsgs(false)}
 updateBadge()});

/* Escape closes the top-most messaging layer */
document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;
 if(!el("vmPreview").hidden)closePreview();else if(!el("vmViewer").hidden)closeViewer();else if(!el("vmDialog").hidden)el("vmDialog").hidden=true;else if(!el("vmUploadMenu").hidden)el("vmUploadMenu").hidden=true;else if(!C.hidden)closeChat();else if(!P.hidden)P.hidden=true;else if(!L.hidden)closeList()});
})();
