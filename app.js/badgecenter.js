/* Veltrix · count badges: the number is centred in its circle, whatever the font or phone.
   Fonts draw digits with slightly different side gaps and heights, so pure CSS centring can leave a number a pixel off.
   This measures where the digits are really drawn (with the badge's own font) and shifts them to the exact middle using
   the badge's inner padding only - so no badge ever changes size. Covers the notification bell, the Messaging button and the
   unread counts in the conversation list. If the browser cannot measure, nothing changes and the CSS centring stays. */
(function(){
"use strict";
var SEL=".wd-bell-badge,.vm-badge,.vm-badge-n",BASE={"wd-bell-badge":4,"vm-badge":5,"vm-badge-n":6},ctx=null,pend=0;
function c2d(){if(ctx)return ctx;try{ctx=document.createElement("canvas").getContext("2d")}catch(e){}return ctx}
function baseOf(el){for(var k in BASE)if(el.classList.contains(k))return BASE[k];return 0}
function r1(n){return Math.round(n*10)/10}
function fit(el){
 var t=el.textContent;if(!t)return;var x=c2d();if(!x)return;
 var cs=getComputedStyle(el),sig=t+"|"+cs.fontSize+"|"+cs.fontWeight+"|"+cs.fontFamily;
 if(el.__bcSig===sig)return;
 x.font=cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily;x.textAlign="left";x.textBaseline="alphabetic";
 var m=x.measureText(t);
 if(m.actualBoundingBoxAscent==null||m.fontBoundingBoxAscent==null||!isFinite(m.width))return;
 /* sideways: middle of the drawn digits vs middle of the text box */
 var sx=-((m.actualBoundingBoxRight-m.actualBoundingBoxLeft)/2-m.width/2);
 /* up/down: middle of the drawn digits vs middle of the line (line-height 1 keeps the text box centred in the badge) */
 var sy=-((m.fontBoundingBoxAscent-m.fontBoundingBoxDescent)/2+(m.actualBoundingBoxDescent-m.actualBoundingBoxAscent)/2);
 if(Math.abs(sx)>3||Math.abs(sy)>3)return;           /* implausible measurement: leave the CSS centring alone */
 var b=baseOf(el),s=el.style;
 s.paddingLeft=r1(Math.max(0,b+sx))+"px";s.paddingRight=r1(Math.max(0,b-sx))+"px";
 s.paddingTop=r1(Math.max(0,2*sy))+"px";s.paddingBottom=r1(Math.max(0,-2*sy))+"px";
 el.__bcSig=sig}
function scan(){pend=0;try{var l=document.querySelectorAll(SEL);for(var i=0;i<l.length;i++)fit(l[i])}catch(e){}}
function later(){if(!pend)pend=requestAnimationFrame(scan)}
function start(){
 new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
 if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){var l=document.querySelectorAll(SEL);for(var i=0;i<l.length;i++)l[i].__bcSig="";later()});
 window.addEventListener("pageshow",later);later()}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
