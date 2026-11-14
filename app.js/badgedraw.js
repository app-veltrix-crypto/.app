/* Veltrix · count badges: the number is drawn dead-centre in its circle, on any font or phone.
   Text centring in CSS depends on each font's internal spacing, so digits can sit 1-3px off (and differently on
   Android and iPhone). So the badge's number is painted by this script onto a small canvas using the badge's own font,
   placed by the real outline of the digits (their exact left/right/top/bottom), and used as the badge's background image.
   The real text stays in the page (invisible) so sizing, screen readers and the rest of the app work as before.
   Covers the notification bell and the dashboard Messaging button (the unread counts inside the conversation list are left as they were). */
(function(){
"use strict";
var SEL=".wd-bell-badge,.vm-badge",pend=0,busy=false;
function paint(el){
 var t=el.textContent;if(!t)return;
 var cs=getComputedStyle(el),r=el.getBoundingClientRect(),
     W=r.width-(parseFloat(cs.borderLeftWidth)||0)-(parseFloat(cs.borderRightWidth)||0),
     H=r.height-(parseFloat(cs.borderTopWidth)||0)-(parseFloat(cs.borderBottomWidth)||0);
 if(!(W>0)||!(H>0))return;
 var d=Math.max(2,Math.ceil(window.devicePixelRatio||1)),
     sig=t+"|"+cs.fontSize+"|"+cs.fontWeight+"|"+cs.fontFamily+"|"+W+"|"+H+"|"+d;
 if(el.__bcSig===sig)return;
 var cv=document.createElement("canvas");cv.width=Math.ceil(W*d);cv.height=Math.ceil(H*d);
 var x=cv.getContext("2d");if(!x)return;
 x.scale(d,d);x.font=cs.fontStyle+" "+cs.fontWeight+" "+cs.fontSize+" "+cs.fontFamily;
 x.textAlign="left";x.textBaseline="alphabetic";x.fillStyle="#fff";
 var m=x.measureText(t);if(m.actualBoundingBoxAscent==null||!isFinite(m.width))return;
 var px=W/2-(m.actualBoundingBoxRight-m.actualBoundingBoxLeft)/2+m.actualBoundingBoxLeft,   /* digits' left edge -> centre */
     py=H/2+(m.actualBoundingBoxAscent-m.actualBoundingBoxDescent)/2;                      /* digits' top/bottom -> centre */
 x.fillText(t,px,py);
 var s=el.style;
 s.backgroundImage="url("+cv.toDataURL("image/png")+")";s.backgroundRepeat="no-repeat";s.backgroundPosition="0 0";s.backgroundSize=(cv.width/d)+"px "+(cv.height/d)+"px";s.backgroundOrigin="padding-box";
 s.color="transparent";s.webkitTextFillColor="transparent";
 el.__bcSig=sig}
function scan(){pend=0;if(busy)return;busy=true;try{var l=document.querySelectorAll(SEL);for(var i=0;i<l.length;i++)paint(l[i])}catch(e){}busy=false}
function later(){if(!pend)pend=requestAnimationFrame(scan)}
function start(){
 new MutationObserver(function(){if(!busy)later()}).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["hidden","class"]});
 if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){var l=document.querySelectorAll(SEL);for(var i=0;i<l.length;i++)l[i].__bcSig="";later()});
 window.addEventListener("pageshow",later);window.addEventListener("resize",later);later()}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
