/* Keeps the browser's own colours (address bar, status bar, task-bar title) identical to the screen the app is showing.
   It reads the real background colour at the top of the visible screen, turns it into the night-mode colour when night mode
   is on, and writes it to <meta name="theme-color">. It re-checks on every screen change, theme change and resize. */
(function(){
"use strict";
let meta=document.querySelector('meta[name="theme-color"]');
if(!meta){meta=document.createElement("meta");meta.name="theme-color";document.head.appendChild(meta)}
const clamp=x=>Math.max(0,Math.min(1,x));
const parse=s=>{const m=String(s).match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
const hex=a=>"#"+a.map(v=>Math.round(v).toString(16).padStart(2,"0")).join("");
/* night mode inverts the whole page (invert + hue-rotate 180°), so the browser colour must go through the same filter */
const night=c=>{const r=1-c.r/255,g=1-c.g/255,b=1-c.b/255;return[clamp(-.574*r+1.43*g+.144*b),clamp(.426*r+.43*g+.144*b),clamp(.426*r+1.43*g-.856*b)].map(x=>x*255)};
function topColor(){
  let el=document.elementFromPoint(Math.floor(innerWidth/2),2)||document.body;
  for(;el;el=el.parentElement){const c=parse(getComputedStyle(el).backgroundColor);if(c&&c.a>.95)return c}
  return{r:255,g:255,b:255,a:1};
}
/* Some browsers (newer iPhone Safari) ignore <meta theme-color> and take the colour of the fixed element touching the top edge.
   This invisible strip carries the same colour, so every browser ends up with the page colour. In night mode the strip gets the
   same inverse filter the app's own colour-protected parts use, so its stored colour and its shown colour are both the night colour. */
const strip=document.createElement("div");strip.id="veltrixChromeStrip";strip.setAttribute("aria-hidden","true");
strip.style.cssText="position:fixed;top:0;left:0;right:0;height:max(env(safe-area-inset-top,0px),3px);pointer-events:none;z-index:2147483000";
document.body?document.body.appendChild(strip):document.addEventListener("DOMContentLoaded",()=>document.body.appendChild(strip));
let last="";
function sync(){
  let c;try{c=topColor()}catch{c={r:255,g:255,b:255,a:1}}
  const isDark=document.documentElement.getAttribute("data-theme")==="dark";
  const out=hex(isDark?night(c):[c.r,c.g,c.b]);
  if(out!==last){last=out;meta.setAttribute("content",out);strip.style.background=out;strip.style.filter=isDark?"hue-rotate(180deg) invert(1)":"none"}
}
let t=null;const later=(ms=60)=>{clearTimeout(t);t=setTimeout(sync,ms)};
window.veltrixSyncChrome=()=>{sync();later(80);later(700)};
const start=()=>{
  const mo=new MutationObserver(()=>later());
  mo.observe(document.body,{attributes:true,attributeFilter:["class","hidden"],subtree:true});
  mo.observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
  window.addEventListener("resize",()=>later());
  window.addEventListener("veltrix-ready",()=>veltrixSyncChrome());
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)veltrixSyncChrome()});
  document.addEventListener("transitionend",()=>later(),true);
  veltrixSyncChrome();
};
if(document.body)start();else document.addEventListener("DOMContentLoaded",start);
})();
