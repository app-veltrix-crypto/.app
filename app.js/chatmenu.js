/* Chat header: the three-dot button (right side). It shows in chats with another person, exactly as before.
   In the verified Veltrix Support chat it shows ONLY for accounts with admin access (user app and admin page) and opens a small pop-up
   (same look as the disappearing-messages one) offering to switch to the admin dashboard / back to the user dashboard.
   It has no action yet - a new function will be attached here later: listen for the "vx-chat-menu" event
   (event.detail = { button, chat }) or set window.vxChatMenu.onClick = function(button, chat){...}.
   The chat screens call  window.vxChatMenu.onChat({...})  when a chat opens and  onChat(null)  when it closes. */
(function(){
"use strict";
const DOTS='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const CLOCK='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
let peer=null,pop=null,sw=null;
const SWAP='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';
/* true only for a signed-in account that has admin access */
function isAdminAccount(){try{const a=window.veltrixDB&&typeof window.veltrixDB.get==="function"?window.veltrixDB.get():null;return !!(a&&a.isAdmin)}catch(e){return false}}
function closePop(){if(pop){pop.remove();pop=null}}
/* Verified Veltrix Support chat, admin accounts only: the pop-up offers to switch between the user dashboard and the admin dashboard */
function switchTarget(){
 const onAdminPage=document.documentElement.classList.contains("admin-page");
 return onAdminPage?{url:"index.html",title:"Switch to user dashboard",sub:"Back to the user app"}
  :{url:"admin.html",title:"Switch to admin dashboard",sub:"Open the admin section"}}
function openSwitchPop(btn){
 const chat=document.getElementById("vmChat");if(!chat||!sw)return;
 if(pop){closePop();return}
 pop=document.createElement("div");pop.className="vxg-pop vxg-switch";pop.setAttribute("role","menu");
 pop.innerHTML='<button type="button" class="vxg-item" role="menuitem">'+SWAP+'<span class="vxg-t">'+sw.title+'<small>'+sw.sub+'</small></span></button>';
 chat.appendChild(pop);
 const cr=chat.getBoundingClientRect(),br=btn.getBoundingClientRect();
 pop.style.top=(br.bottom-cr.top+6)+"px";pop.style.right=Math.max(8,cr.right-br.right)+"px";
 const url=sw.url;
 pop.firstChild.addEventListener("click",e=>{e.stopPropagation();closePop();try{location.href=url}catch(err){console.error(err)}})}
function openPop(btn){
 const chat=document.getElementById("vmChat"),d=window.vxDisappear;if(!chat||!d)return;
 if(pop){closePop();return}
 const on=!!d.get();
 pop=document.createElement("div");pop.className="vxg-pop";pop.setAttribute("role","menu");
 pop.innerHTML='<button type="button" class="vxg-item" role="menuitemcheckbox" aria-checked="'+on+'">'+CLOCK+'<span class="vxg-t">Disappearing messages<small>'+(on?"On \u00b7 24 hours":"Off")+'</small></span><i class="vxg-sw"></i></button>';
 chat.appendChild(pop);
 const cr=chat.getBoundingClientRect(),br=btn.getBoundingClientRect();
 pop.style.top=(br.bottom-cr.top+6)+"px";pop.style.right=Math.max(8,cr.right-br.right)+"px";
 const it=pop.firstChild;
 it.addEventListener("click",e=>{e.stopPropagation();const now=it.getAttribute("aria-checked")!=="true";it.setAttribute("aria-checked",String(now));it.querySelector("small").textContent=now?"On \u00b7 24 hours":"Off";
  try{d.set(now)}catch(err){console.error(err)}setTimeout(closePop,260)})}
document.addEventListener("click",e=>{if(pop&&!pop.contains(e.target)&&!(e.target.closest&&e.target.closest(".vxg-menubtn")))closePop()},true);
document.addEventListener("keydown",e=>{if(e.key==="Escape")closePop()});
const $=(s,r)=>(r||document).querySelector(s);
function mountTab(){
 const chat=document.getElementById("vmChat"),head=chat&&$(".vm-head",chat);if(!head||$(".vxg-menubtn",head))return;
 head.insertAdjacentHTML("beforeend",'<button type="button" class="vm-ic vxg-menubtn" aria-label="More options" aria-haspopup="menu" hidden>'+DOTS+'</button>');
 $(".vxg-menubtn",head).addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;
  /* Verified Veltrix Support chat, admin account: the three dots open the "switch dashboard" pop-up */
  if(sw){try{openSwitchPop(b)}catch(err){console.error(err)}return}
  try{if(typeof api.onClick==="function")api.onClick(b,peer);else openPop(b)}catch(err){console.error(err)}
  try{document.dispatchEvent(new CustomEvent("vx-chat-menu",{detail:{button:b,chat:peer}}))}catch(err){}})}
function onChat(p){closePop();mountTab();sw=(p&&p.support&&(document.documentElement.classList.contains("admin-page")||isAdminAccount()))?switchTarget():null;peer=p&&!p.support?p:null;const chat=document.getElementById("vmChat"),btn=chat&&$(".vxg-menubtn",chat);if(btn)btn.hidden=sw?false:(!peer||!!peer.support||(!peer.real&&!peer.admin))}
const api={onChat,onClick:null};
window.vxChatMenu=api;
})();
