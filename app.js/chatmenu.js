/* Chat header: the three-dot button (right side). It shows in chats with another person, exactly as before.
   It has no action yet - a new function will be attached here later: listen for the "vx-chat-menu" event
   (event.detail = { button, chat }) or set window.vxChatMenu.onClick = function(button, chat){...}.
   The chat screens call  window.vxChatMenu.onChat({...})  when a chat opens and  onChat(null)  when it closes. */
(function(){
"use strict";
const DOTS='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
let peer=null;
const $=(s,r)=>(r||document).querySelector(s);
function mountTab(){
 const chat=document.getElementById("vmChat"),head=chat&&$(".vm-head",chat);if(!head||$(".vxg-menubtn",head))return;
 head.insertAdjacentHTML("beforeend",'<button type="button" class="vm-ic vxg-menubtn" aria-label="More options" aria-haspopup="menu" hidden>'+DOTS+'</button>');
 $(".vxg-menubtn",head).addEventListener("click",e=>{e.stopPropagation();const b=e.currentTarget;
  try{if(typeof api.onClick==="function")api.onClick(b,peer)}catch(err){console.error(err)}
  try{document.dispatchEvent(new CustomEvent("vx-chat-menu",{detail:{button:b,chat:peer}}))}catch(err){}})}
function onChat(p){mountTab();peer=p&&!p.support?p:null;const chat=document.getElementById("vmChat"),btn=chat&&$(".vxg-menubtn",chat);if(btn)btn.hidden=!peer||!!peer.support||(!peer.real&&!peer.admin)}
const api={onChat,onClick:null};
window.vxChatMenu=api;
})();
