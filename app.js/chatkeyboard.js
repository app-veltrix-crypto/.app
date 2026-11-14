/* Veltrix · keyboard fix for the messaging rooms (user app + admin page).
   Problem: when the keyboard opens, the phone browser can scroll the page up (header slides away) or leave the typing bar
   hidden behind the keyboard. Fix: follow the visible area (window.visualViewport) and size the chat page to it. */
(function(){
"use strict";
var vv=window.visualViewport,root=document.documentElement,raf=0,near=true,wasKb=false,lastH=0;
function msgs(){return document.getElementById("vmMsgs")}
function chatOpen(){var c=document.getElementById("vmChat");return !!(c&&!c.hidden)}
function toBottom(){var m=msgs();if(!m)return;m.scrollTop=m.scrollHeight}
function apply(){
 raf=0;
 var h=vv?vv.height:window.innerHeight,top=vv?vv.offsetTop:0,full=window.innerHeight;
 var kb=(full-h>60)||top>1;
 if(kb){root.classList.add("vm-kb");root.style.setProperty("--vv-top",Math.max(0,top)+"px");root.style.setProperty("--vv-h",h+"px")}
 else{root.classList.remove("vm-kb");root.style.removeProperty("--vv-top");root.style.removeProperty("--vv-h")}
 /* the browser may also have scrolled the page itself: put it back so nothing slides */
 if((window.pageYOffset||root.scrollTop)&&root.classList.contains("vx-locked")===false){try{window.scrollTo(0,0)}catch(e){}}
 /* if you were reading the newest messages, keep them in view above the typing bar */
 if(chatOpen()&&(kb!==wasKb||Math.abs(h-lastH)>1)&&near){requestAnimationFrame(toBottom);setTimeout(toBottom,120)}
 wasKb=kb;lastH=h}
function schedule(){if(!raf)raf=requestAnimationFrame(apply)}
if(vv){vv.addEventListener("resize",schedule);vv.addEventListener("scroll",schedule)}
window.addEventListener("resize",schedule);window.addEventListener("orientationchange",function(){setTimeout(schedule,250)});
/* remember whether the person is at the bottom of the conversation (scroll events don't bubble, so listen in the capture phase) */
document.addEventListener("scroll",function(e){var m=msgs();if(m&&e.target===m)near=m.scrollHeight-m.scrollTop-m.clientHeight<160},true);
/* when the typing box is tapped the keyboard animates in: re-check a few times while it moves */
document.addEventListener("focusin",function(e){var t=e.target;if(!t||!t.closest||!t.closest(".vm-page"))return;
 if(!/^(TEXTAREA|INPUT)$/.test(t.tagName))return;[0,80,200,400,700].forEach(function(d){setTimeout(schedule,d)})});
document.addEventListener("focusout",function(){[100,350].forEach(function(d){setTimeout(schedule,d)})});
apply();
})();

/* The typing area floats over the conversation (transparent container): tell the message list how tall it is
   so the newest message is never hidden behind it, and keep the newest message in view when it grows. */
(function(){
 if(!window.ResizeObserver)return;
 var dock=null,ro=null;
 function bind(){
  var d=document.getElementById("vmDock");if(!d||d===dock)return;
  dock=d;if(ro)ro.disconnect();
  ro=new ResizeObserver(function(){
   var c=document.getElementById("vmChat"),m=document.getElementById("vmMsgs");if(!c||!dock)return;
   var h=Math.ceil(dock.getBoundingClientRect().height);if(!h)return;
   var stick=m&&m.scrollHeight-m.scrollTop-m.clientHeight<200;
   c.style.setProperty("--vm-dock-h",h+"px");
   if(stick&&m)requestAnimationFrame(function(){m.scrollTop=m.scrollHeight})});
  ro.observe(dock)}
 bind();
 new MutationObserver(bind).observe(document.documentElement,{childList:true,subtree:true})
})();

/* The typing area always sits directly on top of the keyboard, whatever the keyboard is showing (letters, emoji, stickers, GIFs).
   Some browsers do not resize the page when the emoji / sticker panel opens, which dropped the typing area to the bottom of the screen.
   While a conversation is open (and only then) the browser's VirtualKeyboard API reports the real keyboard height for every panel,
   and app.css/chatkeyboard.css lifts the chat page by exactly that amount. Browsers without the API, or where it reports nothing,
   keep the visual-viewport logic above unchanged. */
(function(){
"use strict";
var vk=navigator.virtualKeyboard;if(!vk||!("overlaysContent" in vk))return;
var root=document.documentElement,on=false,broken=false,near=true;
function chatOpen(){var c=document.getElementById("vmChat");return !!(c&&!c.hidden)}
function msgs(){return document.getElementById("vmMsgs")}
function kbH(){try{return vk.boundingRect?Math.round(vk.boundingRect.height):0}catch(e){return 0}}
function set(v){if(v===on)return;try{vk.overlaysContent=v;on=v;root.classList.toggle("vm-vk",v)}catch(e){on=false;root.classList.remove("vm-vk")}}
function sync(){set(chatOpen()&&!broken)}
function toBottom(){var m=msgs();if(m)m.scrollTop=m.scrollHeight}
/* keep the newest message in view above the typing area while the keyboard moves */
try{vk.addEventListener("geometrychange",function(){if(!on||!chatOpen()||!near)return;requestAnimationFrame(toBottom);setTimeout(toBottom,120)})}catch(e){}
document.addEventListener("scroll",function(e){var m=msgs();if(m&&e.target===m)near=m.scrollHeight-m.scrollTop-m.clientHeight<160},true);
/* safety net: if the typing box is focused but the browser reports no keyboard at all, give control back to the old logic */
document.addEventListener("focusin",function(e){var t=e.target;if(!on||!t||!t.closest||!t.closest("#vmChat")||!/^(TEXTAREA|INPUT)$/.test(t.tagName))return;
 setTimeout(function(){if(on&&document.activeElement===t&&kbH()===0){broken=true;set(false)}},1000)});
var pend=0;function later(){if(!pend)pend=requestAnimationFrame(function(){pend=0;sync()})}
new MutationObserver(later).observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:["hidden"]});
window.addEventListener("pageshow",later);
sync();
})();
