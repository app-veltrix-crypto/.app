/* Veltrix · shared skeleton loader.
   Every crypto list / detail view shows a shimmering placeholder (logo, name, price lines) until its real
   data AND its logos are ready, the same pattern used by big exchange apps. Load this BEFORE script.js. */
(function(){
"use strict";
/* logos the public icon set does not have (it has no Toncoin), bundled so they always show */
const TON_SVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><circle cx="28" cy="28" r="28" fill="#0098EA"/><path fill="#fff" d="M37.600 15.600H18.400c-3.500 0-5.700 3.800-3.900 6.900l11.800 20.500c.8 1.300 2.700 1.300 3.500 0L41.500 22.500c1.800-3.100-.4-6.900-3.900-6.900zM26.300 36.800l-2.600-5-6.200-11c-.4-.7.1-1.600 1-1.600h7.800v17.600zm11.600-16.600l-6.200 11-2.600 5V19.200h7.800c.9 0 1.400.9 1 1.600z"/></svg>';
window.VX_LOCAL_LOGOS={TON:"data:image/svg+xml;utf8,"+encodeURIComponent(TON_SVG)};
const loaded=new Set(),icon=s=>"https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/"+String(s||"").toLowerCase()+".svg";
const urls=c=>{const sym=String(c&&c.symbol||"").toUpperCase(),local=window.VX_LOCAL_LOGOS[sym],u=[];if(local)u.push(local);if(c&&c.image)u.push(c.image);u.push(icon(sym));return u};
const probe=u=>new Promise(res=>{if(loaded.has(u))return res(true);const i=new Image();i.onload=()=>{loaded.add(u);res(true)};i.onerror=()=>res(false);i.src=u});
/* true when every coin's logo has already been downloaded once (so nothing needs to wait) */
const cached=list=>(list||[]).every(c=>urls(c).some(u=>loaded.has(u)));
/* resolves when all logos are loaded (or failed, or maxMs passed) so rows never pop in half-drawn */
function logos(list,maxMs){
  if(cached(list))return Promise.resolve();
  const all=Promise.all((list||[]).map(async c=>{for(const u of urls(c)){if(await probe(u))return}}));
  return Promise.race([all,new Promise(r=>setTimeout(r,maxMs||1800))]);
}
const KIND={
  market:'<span class="vx vx-logo"></span><span class="vx-col"><span class="vx vx-l1"></span><span class="vx vx-l2"></span></span><span class="vx-col r"><span class="vx vx-r1"></span><span class="vx vx-r2"></span></span>',
  pick:'<span class="vx vx-logo"></span><span class="vx-col"><span class="vx vx-l1"></span><span class="vx vx-l2"></span></span><span class="vx-col r"><span class="vx vx-r1"></span><span class="vx vx-r2"></span></span>',
  tx:'<span class="vx vx-tile"></span><span class="vx-col"><span class="vx vx-l1"></span><span class="vx vx-l2"></span></span><span class="vx-col r"><span class="vx vx-r1"></span><span class="vx vx-r2"></span></span>'
};
function rows(n,kind){
  const k=KIND[kind]||KIND.market;
  return '<div class="vx-sr" role="status">Loading…</div>'+Array.from({length:n||7},()=>`<div class="vx-row vx-${kind||"market"}" aria-hidden="true">${k}</div>`).join("");
}
function fill(el,n,kind){if(!el)return;el.setAttribute("aria-busy","true");el.innerHTML=rows(n,kind)}
/* paints `paint()` now if the coins' logos are cached, otherwise shows the skeleton first and paints when ready */
function render(el,list,paint,kind,n){
  if(!el)return;const tok=el.__vx=(el.__vx||0)+1;
  if(cached(list)){el.removeAttribute("aria-busy");paint();return}
  fill(el,n||Math.min(8,Math.max(4,(list||[]).length)),kind);
  logos(list).then(()=>{if(el.__vx!==tok)return;el.removeAttribute("aria-busy");paint()});
}
window.vxSkeleton={rows,fill,render,logos,cached};
})();
