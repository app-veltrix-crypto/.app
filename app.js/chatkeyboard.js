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
   While a conversation is open (and only then) the browser's VirtualKeyboard API reports the real keyboard rectangle for every panel,
   and the chat page is lifted by exactly that amount (--vk-lift, used by app.css/chatkeyboard.css).
   The browser reports that rectangle in plain screen pixels, but this app runs at a reduced page scale (see fixedsize.js), so the
   number is first converted to page pixels, and then CHECKED: the bottom of the chat page is compared with the top of the keyboard and
   corrected until they touch. So the typing area is never hidden behind the keyboard, and never floats above it.
   Browsers without the API, or where it reports no keyboard at all, keep the visual-viewport logic above unchanged. */
(function(){
"use strict";
var vk=navigator.virtualKeyboard;if(!vk||!("overlaysContent" in vk))return;
var root=document.documentElement,on=false,broken=false,near=true,gain=1,tries=0;
function chatEl(){return document.getElementById("vmChat")}
function chatOpen(){var c=chatEl();return !!(c&&!c.hidden)}
function msgs(){return document.getElementById("vmMsgs")}
function rect(){try{return vk.boundingRect||null}catch(e){return null}}
function kbH(){var r=rect();return r?Math.round(r.height):0}
/* page pixels per screen pixel (the page is laid out wider than the screen because of the page scale) */
function k(){var sw=(window.screen&&screen.width)||0,iw=window.innerWidth||0;return sw&&iw?iw/sw:1}
function lift(){
 var h=kbH();if(h<=0){root.style.removeProperty("--vk-lift");return 0}
 var v=Math.max(0,Math.min(window.innerHeight*.8,h*k()*gain));
 root.style.setProperty("--vk-lift",v.toFixed(1)+"px");return v}
/* compare the bottom of the chat page with the top of the keyboard and correct the amount until they meet */
function verify(){
 if(!on||!chatOpen())return;var r=rect(),c=chatEl();if(!r||!r.height||!c)return;
 var v=lift();if(v<=0)return;
 var d=c.getBoundingClientRect().bottom-r.top*k();          /* >0: page bottom is below the keyboard top (hidden); <0: gap */
 if(Math.abs(d)>1&&tries<5){tries++;gain=Math.max(.7,Math.min(1.5,gain*((v+d)/v)));lift();requestAnimationFrame(verify)}}
function settle(){tries=0;lift();requestAnimationFrame(verify)}
function set(v){if(v===on)return;try{vk.overlaysContent=v;on=v;root.classList.toggle("vm-vk",v);if(!v)root.style.removeProperty("--vk-lift")}catch(e){on=false;root.classList.remove("vm-vk");root.style.removeProperty("--vk-lift")}}
function sync(){set(chatOpen()&&!broken);if(on)settle()}
function toBottom(){var m=msgs();if(m)m.scrollTop=m.scrollHeight}
/* every change of the keyboard (letters, emoji, stickers, GIFs, closing): move the page, then keep the newest message in view */
try{vk.addEventListener("geometrychange",function(){if(!on)return;settle();if(!chatOpen()||!near)return;requestAnimationFrame(toBottom);setTimeout(toBottom,120)})}catch(e){}
window.addEventListener("resize",function(){if(on)settle()});
document.addEventListener("scroll",function(e){var m=msgs();if(m&&e.target===m)near=m.scrollHeight-m.scrollTop-m.clientHeight<160},true);
/* while the typing box is focused, re-check a few times as the keyboard animates; if the browser reports no keyboard at all, give control back to the old logic */
document.addEventListener("focusin",function(e){var t=e.target;if(!on||!t||!t.closest||!t.closest("#vmChat")||!/^(TEXTAREA|INPUT)$/.test(t.tagName))return;
 [120,350,700].forEach(function(d){setTimeout(function(){if(on)settle()},d)});
 setTimeout(function(){if(on&&document.activeElement===t&&kbH()===0){broken=true;set(false)}},1200)});
var pend=0;function later(){if(!pend)pend=requestAnimationFrame(function(){pend=0;sync()})}
new MutationObserver(later).observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:["hidden"]});
window.addEventListener("pageshow",later);
sync();
})();
