/* Veltrix · count badges: the number is centred in its circle, whatever the font or phone.
   Fonts draw digits with different side gaps and heights, so CSS alone can leave a number a pixel off.
   This finds where the digits are really drawn on screen (real baseline from the page + the digit shapes from a canvas
   using the badge's own font), compares that with the middle of the badge, and nudges the badge's inner padding by the
   difference - rounded to a whole device pixel - so no badge ever changes size. Covers the notification bell, the Messaging
   button and the unread counts in the conversation list. If the browser cannot measure, the CSS centring stays. */
(function(){
"use strict";
var SEL=".wd-bell-badge,.vm-badge,.vm-badge-n",ctx=null,pend=0,busy=false;
function c2d(){if(ctx)return ctx;try{ctx=document.createElement("canvas").getContext("2d")}catch(e){}return ctx}
function snap(n){var d=window.devicePixelRatio||1;return Math.round(n*d)/d}
function fit(el){
 var t=el.textContent;if(!t||!el.firstChild||el.firstChild.nodeType!==3)return;var x=c2d();if(!x)return;
 var r0=el.getBoundingClientRect();if(!r0.width||!r0.height)return;
 var cs=getComputedStyle(el),dpr=window.devicePixelRatio||1,
     sig=t+"|"+cs.fontSize+"|"+cs.fontWeight+"|"+cs.fontFamily+"|"+r0.width+"|"+r0.height+"|"+dpr;
 if(el.__bcSig===sig)return;
 var s=el.style;
 /* start from the plain CSS centring */
 s.paddingLeft=s.paddingRight=s.paddingTop=s.paddingBottom="";
 var pl=parseFloat(cs.paddingLeft)||0,pr=parseFloat(cs.paddingRight)||0,net=0,ok=false;
 x.font=cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily;x.textAlign="left";x.textBaseline="alphabetic";
 var m=x.measureText(t);
 if(m.actualBoundingBoxAscent==null||m.fontBoundingBoxAscent==null||!isFinite(m.width))return;
 /* measure -> nudge -> measure again (a few rounds), so rounding in the layout cannot leave a leftover offset */
 for(var i=0;i<4;i++){
  var rect=el.getBoundingClientRect(),rg=document.createRange();rg.selectNodeContents(el.firstChild);var tr=rg.getBoundingClientRect();
  if(!tr.width)return;
  var base=tr.top+m.fontBoundingBoxAscent,
      inkL=tr.left-m.actualBoundingBoxLeft,inkR=tr.left+m.actualBoundingBoxRight,
      inkT=base-m.actualBoundingBoxAscent,inkB=base+m.actualBoundingBoxDescent,
      dx=(rect.left+rect.width/2)-(inkL+inkR)/2,dy=(rect.top+rect.height/2)-(inkT+inkB)/2;   /* + = move right / down */
  if(Math.abs(dx)<=.5/dpr&&Math.abs(dy)<=.5/dpr){ok=true;break}
  if(Math.abs(dx)>3||Math.abs(dy)>3)break;           /* implausible measurement: stop */
  pl=Math.max(0,pl+dx);pr=Math.max(0,pr-dx);net+=2*dy;
  s.paddingLeft=pl.toFixed(2)+"px";s.paddingRight=pr.toFixed(2)+"px";
  s.paddingTop=Math.max(0,net).toFixed(2)+"px";s.paddingBottom=Math.max(0,-net).toFixed(2)+"px";
  if(i===3)ok=true}
 if(!ok){s.paddingLeft=s.paddingRight=s.paddingTop=s.paddingBottom=""}
 el.__bcSig=sig}
function scan(){pend=0;if(busy)return;busy=true;try{var l=document.querySelectorAll(SEL);for(var i=0;i<l.length;i++)fit(l[i])}catch(e){}busy=false}
function later(){if(!pend)pend=requestAnimationFrame(scan)}
function start(){
 new MutationObserver(function(ms){if(busy)return;for(var i=0;i<ms.length;i++){var t=ms[i].target,e=t.nodeType===1?t:t.parentNode;if(e&&e.closest&&(e.matches(SEL)||e.closest(SEL)||ms[i].addedNodes.length||ms[i].type==="attributes")){later();return}}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["hidden","class"]});
 if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){var l=document.querySelectorAll(SEL);for(var i=0;i<l.length;i++)l[i].__bcSig="";later()});
 window.addEventListener("pageshow",later);window.addEventListener("resize",later);later()}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
