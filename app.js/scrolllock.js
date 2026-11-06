/* Veltrix · scroll lock. While ANY section is open (full-screen page, bottom sheet, pop-up, dialog, viewer) the page
   behind it is frozen, so it can't move or scroll along with the open section. When the last one closes the page
   is put back exactly where it was. (The persistent offline notice is NOT a lock: the app stays usable under it.) */
(function(){
"use strict";
const SEL=[".wd-feature-page",".vm-page",".vm-viewer",".vm-dialog-backdrop",".vm-camera",
 ".wd-notification-filter-backdrop",".profile-ui-page",".profile-ui-edit-dialog",
 ".sd-sheet",".sx-back","#langSpinner"].join(",");
const root=document.documentElement;
let locked=false,y=0,t1=0,t2=0;
function isOpen(el){
  if(el.hidden)return false;
  const cs=getComputedStyle(el);
  if(cs.display==="none"||cs.visibility==="hidden"||parseFloat(cs.opacity)<.02)return false;
  const r=el.getBoundingClientRect();return r.width>0&&r.height>0;
}
function lock(){
  if(locked)return;locked=true;
  y=window.pageYOffset||root.scrollTop||document.body.scrollTop||0;
  const gap=window.innerWidth-root.clientWidth;                 /* desktop scrollbar width, so nothing shifts sideways */
  document.body.style.top=(-y)+"px";if(gap>0)document.body.style.paddingRight=gap+"px";
  root.classList.add("vx-locked");
}
function unlock(){
  if(!locked)return;locked=false;
  root.classList.remove("vx-locked");document.body.style.top="";document.body.style.paddingRight="";
  window.scrollTo({top:y,left:0,behavior:"instant"});
}
function check(){let open=false;try{open=[...document.querySelectorAll(SEL)].some(isOpen)}catch(e){}open?lock():unlock()}
function schedule(){
  if(!t1)t1=setTimeout(()=>{t1=0;check()},50);
  clearTimeout(t2);t2=setTimeout(check,420);                     /* second look once slide/fade animations have finished */
}
new MutationObserver(schedule).observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:["hidden","class","style"]});
["transitionend","animationend"].forEach(ev=>document.addEventListener(ev,schedule,true));
window.addEventListener("pageshow",schedule);
check();
})();
