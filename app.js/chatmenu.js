/* Chat header: the three-dot button (right side). It shows in chats with another person, exactly as before.
   It has no action yet - a new function will be attached here later: listen for the "vx-chat-menu" event
   (event.detail = { button, chat }) or set window.vxChatMenu.onClick = function(button, chat){...}.
   The chat screens call  window.vxChatMenu.onChat({...})  when a chat opens and  onChat(null)  when it closes. */
(function(){
"use strict";
const DOTS='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const CLOCK='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
let peer=null,pop=null;
function closePop(){if(pop){pop.remove();pop=null}}
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
  try{if(typeof api.onClick==="function")api.onClick(b,peer);else openPop(b)}catch(err){console.error(err)}
  try{document.dispatchEvent(new CustomEvent("vx-chat-menu",{detail:{button:b,chat:peer}}))}catch(err){}})}
function onChat(p){closePop();mountTab();peer=p&&!p.support?p:null;const chat=document.getElementById("vmChat"),btn=chat&&$(".vxg-menubtn",chat);if(btn)btn.hidden=!peer||!!peer.support||(!peer.real&&!peer.admin)}
const api={onChat,onClick:null};
window.vxChatMenu=api;
})();
