/* Veltrix – true emoji colours in dark mode (see the TRUE EMOJI COLOURS block at the end of messaging.css).
   1) moves every messaging screen/overlay into the browser top layer while dark mode is on, so the page-wide
      invert filter does not touch it (CSS then re-applies the invert to everything except emoji);
   2) wraps any emoji that is not already wrapped (names, previews, header, toasts…) in <span class="vm-emoji">.
   Browsers without popover/backdrop-filter support simply keep the previous behaviour. */
(function(){
 "use strict";
 var root=document.documentElement;
 var okPop=typeof HTMLElement!=="undefined"&&typeof HTMLElement.prototype.showPopover==="function";
 var okBf=!!(window.CSS&&CSS.supports&&(CSS.supports("backdrop-filter","blur(1px)")||CSS.supports("-webkit-backdrop-filter","blur(1px)")));
 var SEL=".vm-page,.vm-viewer,.vm-toast,.vm-dialog-backdrop,.vm-upload-menu,.vm-camera";
 var EMO=/(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)*)/gu;
 var HAS=new RegExp(EMO.source,"u");
 var SKIP={TEXTAREA:1,INPUT:1,SCRIPT:1,STYLE:1,SELECT:1,OPTION:1};
 function dark(){return root.getAttribute("data-theme")==="dark"}
 function z(el){var v=parseInt(getComputedStyle(el).zIndex,10);return isNaN(v)?0:v}
 function open(el){try{return el.matches(":popover-open")}catch(e){return false}}
 function shown(el){return !el.hidden}
 function sync(el){
  if(!okPop||!okBf||el.nodeType!==1)return;
  try{
   if(!dark()){if(el.hasAttribute("popover")){if(open(el))el.hidePopover();el.removeAttribute("popover")}return}
   if(!el.hasAttribute("popover"))el.setAttribute("popover","manual");
   var vis=shown(el),isOpen=open(el);
   if(vis&&!isOpen){
    /* top layer stacks by the order of opening: keep the app's z-index order (re-open the ones that must sit above) */
    var zi=z(el),above=[].filter.call(document.querySelectorAll(SEL),function(o){return o!==el&&open(o)&&z(o)>zi}).sort(function(a,b){return z(a)-z(b)});
    el.showPopover();
    above.forEach(function(o){o.hidePopover();o.showPopover()});
   }else if(!vis&&isOpen)el.hidePopover();
  }catch(e){}
 }
 function syncAll(){[].forEach.call(document.querySelectorAll(SEL),sync)}
 function wrap(node){
  if(!node||!node.nodeType)return;
  var w=document.createTreeWalker(node,NodeFilter.SHOW_TEXT,{acceptNode:function(t){
   var p=t.parentNode;if(!p||SKIP[p.tagName]||!HAS.test(t.nodeValue)||!p.closest||!p.closest(SEL))return NodeFilter.FILTER_REJECT;
   if(p.closest&&p.closest(".vm-emoji,[contenteditable=true],.vm-mirror"))return NodeFilter.FILTER_REJECT;
   return NodeFilter.FILTER_ACCEPT}}),list=[],n;
  if(node.nodeType===3){if(HAS.test(node.nodeValue)&&node.parentNode&&node.parentNode.closest&&node.parentNode.closest(SEL)&&!SKIP[node.parentNode.tagName]&&!(node.parentNode.closest&&node.parentNode.closest(".vm-emoji,.vm-mirror")))list.push(node)}
  else while((n=w.nextNode()))list.push(n);
  list.forEach(function(t){
   var s=t.nodeValue,f=document.createDocumentFragment(),last=0,m;EMO.lastIndex=0;
   while((m=EMO.exec(s))){
    if(m.index>last)f.appendChild(document.createTextNode(s.slice(last,m.index)));
    var sp=document.createElement("span");sp.className="vm-emoji";sp.textContent=m[0];f.appendChild(sp);last=m.index+m[0].length}
   if(last<s.length)f.appendChild(document.createTextNode(s.slice(last)));
   t.parentNode.replaceChild(f,t)});
 }
 function start(){
  if(okPop&&okBf)root.classList.add("vm-tl");
  syncAll();wrap(document.body);
  var mo=new MutationObserver(function(ms){
   var themeChanged=false,todo=[],texts=[];
   ms.forEach(function(m){
    if(m.type==="attributes"){
     if(m.target===root){themeChanged=true;return}
     if(m.target.matches&&m.target.matches(SEL))todo.push(m.target);
    }else if(m.type==="childList"){
     m.addedNodes.forEach(function(n){
      if(n.nodeType!==1&&n.nodeType!==3)return;
      if(n.nodeType===1){
       if(n.matches(SEL))todo.push(n);
       else if(!n.closest(".vm-msgs,.vm-scroll"))n.querySelectorAll&&n.querySelectorAll(SEL).forEach(function(x){todo.push(x)});
      }
      texts.push(n)});
    }else if(m.type==="characterData")texts.push(m.target);
   });
   if(themeChanged)syncAll();else todo.forEach(sync);
   texts.forEach(wrap);
  });
  mo.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["hidden","class","style","data-theme"]});
 }
 if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
