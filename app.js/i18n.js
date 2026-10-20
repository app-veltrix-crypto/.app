/* App language: English by default. Choosing a language translates every visible text, placeholder, label and tooltip. */
(function(){
 const LANGS=[["en","English","English","en"],["ha","Hausa","Hausa","ha"],["yo","Yorùbá","Yoruba","yo"],["ig","Igbo","Igbo","ig"],["af","Afrikaans","Afrikaans","af"],["sq","Shqip","Albanian","sq"],["am","አማርኛ","Amharic","am"],["ar","العربية","Arabic","ar"],["az","Azərbaycan dili","Azerbaijani","az"],["bn","বাংলা","Bangla","bn"],["bg","Български","Bulgarian","bg"],["ca","Català","Catalan","ca"],["zh-CN","简体中文","Simplified Chinese","zh-CN"],["zh-TW","繁體中文","Traditional Chinese","zh-TW"],["hr","Hrvatski","Croatian","hr"],["cs","Čeština","Czech","cs"],["da","Dansk","Danish","da"],["nl","Nederlands","Dutch","nl"],["fil","Filipino","Filipino","tl"],["fi","Suomi","Finnish","fi"],["fr","Français","French","fr"],["de","Deutsch","German","de"],["el","Ελληνικά","Greek","el"],["he","עברית","Hebrew","iw"],["hi","हिन्दी","Hindi","hi"],["hu","Magyar","Hungarian","hu"],["id","Bahasa Indonesia","Indonesian","id"],["it","Italiano","Italian","it"],["ja","日本語","Japanese","ja"],["ko","한국어","Korean","ko"],["ms","Bahasa Melayu","Malay","ms"],["ne","नेपाली","Nepali","ne"],["fa","فارسی","Persian","fa"],["pl","Polski","Polish","pl"],["pt","Português","Portuguese","pt"],["ro","Română","Romanian","ro"],["ru","Русский","Russian","ru"],["sr","Српски","Serbian","sr"],["sw","Kiswahili","Swahili","sw"],["sv","Svenska","Swedish","sv"],["ta","தமிழ்","Tamil","ta"],["th","ไทย","Thai","th"],["tr","Türkçe","Turkish","tr"],["uk","Українська","Ukrainian","uk"],["ur","اردو","Urdu","ur"],["vi","Tiếng Việt","Vietnamese","vi"],["zu","isiZulu","Zulu","zu"],["es","Español","Spanish","es"]];
 const KEY="veltrixLang",ATTRS=["placeholder","aria-label","title","alt"];
 const SKIP="script,style,code,textarea,input,select,svg,canvas,video,[translate=no],.notranslate,#assetList,#vmMsgs,#vmConvs,#settingsDisplayName,#settingsUsername,.profile-ui-field-copy small,#depositAddress,#marketDetailSymbol,#marketDetailPrice,#totalAssets";
 let lang="en";const MEM={};
 let cache={},busy=false,pending=new Set(),timer=null,running=0;
 const info=c=>LANGS.find(l=>l[0]===c)||LANGS[0];
 const loadCache=()=>{cache=MEM[lang]||(MEM[lang]={})};
 const saveCache=()=>{MEM[lang]=cache};
 const worth=t=>/\p{L}{2,}/u.test(t);
 const nodeRec=new WeakMap(),attrRec=new WeakMap();
 function skipped(el){return !el||!!el.closest(SKIP)}
 function setText(n,txt){busy=true;n.nodeValue=txt;busy=false}
 function applyNode(n){
  let rec=nodeRec.get(n);const cur=n.nodeValue;
  if(rec&&cur!==rec.shown)rec=null;               // app changed the text itself: new original
  if(!rec){if(!worth(cur)||skipped(n.parentElement))return;rec={orig:cur,shown:cur};nodeRec.set(n,rec)}
  const m=rec.orig.match(/^(\s*)([\s\S]*?)(\s*)$/),core=m[2];
  const out=lang==="en"?rec.orig:(cache[core]!=null?m[1]+cache[core]+m[3]:(pending.add(core),rec.orig));
  if(n.nodeValue!==out)setText(n,out);rec.shown=out;
 }
 function applyAttrs(el){
  if(skipped(el))return;
  for(const a of ATTRS){if(!el.hasAttribute(a))continue;
   let r=attrRec.get(el);if(!r){r={};attrRec.set(el,r)}
   let rec=r[a];const cur=el.getAttribute(a);if(rec&&cur!==rec.shown)rec=null;
   if(!rec){if(!worth(cur))continue;rec=r[a]={orig:cur,shown:cur}}
   const out=lang==="en"?rec.orig:(cache[rec.orig]!=null?cache[rec.orig]:(pending.add(rec.orig),rec.orig));
   if(cur!==out){busy=true;el.setAttribute(a,out);busy=false}rec.shown=out;
  }
 }
 function walk(root){
  if(root.nodeType===3){applyNode(root);return}
  if(root.nodeType!==1&&root.nodeType!==9)return;
  const el=root.nodeType===1?root:document.body;
  if(root.nodeType===1)applyAttrs(root);
  el.querySelectorAll("[placeholder],[aria-label],[title],[alt]").forEach(applyAttrs);
  const tw=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while(n=tw.nextNode())applyNode(n);
 }
 async function gtRaw(text,tl){
  const url="https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl="+encodeURIComponent(tl)+"&dt=t&q="+encodeURIComponent(text);
  const r=await fetch(url);if(!r.ok)throw 0;const j=await r.json();return j[0].map(x=>x[0]).join("")
 }
 async function gt(text){return gtRaw(text,info(lang)[3])}
 /* Translate many strings per request (joined by line breaks); fall back to single requests if the split doesn't line up. */
 async function gtBatch(items,tl){
  const clean=items.map(t=>t.replace(/\s*\n\s*/g," "));
  try{
   const out=(await gtRaw(clean.join("\n"),tl)).split("\n");
   while(out.length>clean.length&&out[out.length-1]==="")out.pop();
   if(out.length===clean.length)return out;
  }catch{}
  return Promise.all(clean.map(t=>gtRaw(t,tl).catch(()=>null)))
 }
 function makeBatches(list){
  const bs=[];let cur=[],len=0;
  for(const t of list){
   const l=encodeURIComponent(t).length+3;
   if(cur.length&&(len+l>1400||cur.length>=30)){bs.push(cur);cur=[];len=0}
   cur.push(t);len+=l;
  }
  if(cur.length)bs.push(cur);return bs;
 }
 async function flush(){
  if(lang==="en"||!pending.size)return;
  const my=lang,tl=info(lang)[3],list=[...pending].filter(t=>cache[t]==null);pending.clear();
  const batches=makeBatches(list);let i=0;running++;
  const work=async()=>{while(i<batches.length){const bt=batches[i++];try{const o=await gtBatch(bt,tl);if(my!==lang)return;bt.forEach((t,k)=>{if(o[k])cache[t]=o[k]})}catch{}}};
  await Promise.all(Array.from({length:Math.min(8,batches.length)},work));
  running--;if(my!==lang)return;saveCache();walk(document.body);
 }
 function schedule(){clearTimeout(timer);timer=setTimeout(flush,60)}
 let rq=0;
 const mo=new MutationObserver(ms=>{
  if(busy)return;cancelAnimationFrame(rq);
  rq=requestAnimationFrame(()=>{ms.forEach(m=>{if(m.type==="characterData")applyNode(m.target);else if(m.type==="attributes")applyAttrs(m.target);else m.addedNodes.forEach(n=>walk(n))});schedule()});
 });
 function start(){mo.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTRS})}
 /* Full-screen loading spinner: blocks all taps while a language is being applied. */
 const spin=document.createElement("div");spin.id="langSpinner";spin.hidden=true;spin.setAttribute("role","status");spin.setAttribute("aria-live","polite");spin.setAttribute("aria-label","Applying language");
 spin.innerHTML='<div class="lang-spinner-ring"></div>';
 document.body.appendChild(spin);
 let spinTok=0,spinFail=null;
 const showSpin=()=>{spin.hidden=false;document.body.classList.add("lang-loading");clearTimeout(spinFail);spinFail=setTimeout(hideSpin,12000)};
 function hideSpin(){clearTimeout(spinFail);spin.hidden=true;document.body.classList.remove("lang-loading")}
 function setLang(c){
  lang=c;veltrixDB.pref.set("lang",c);
  document.documentElement.lang=info(c)[3]==="iw"?"he":c;loadCache();pending.clear();
  const tok=++spinTok;
  walk(document.body);paintList();
  if(c!=="en"&&pending.size){
   showSpin();clearTimeout(timer);
   flush().catch(()=>{}).finally(()=>{if(tok===spinTok)hideSpin()});
  }else{hideSpin();schedule()}
 }
 window.veltrixSetLanguage=setLang;
 /* language sheet */
 const sheet=document.getElementById("langSheet"),back=document.getElementById("languageBack"),list=document.getElementById("langList");
 function paintList(){list.innerHTML=LANGS.map(l=>`<button type="button" class="sx-lang-row${l[0]===lang?" sel":""}" role="radio" aria-checked="${l[0]===lang}" data-c="${l[0]}"><span class="sx-radio"></span><span><b>${l[1]}</b><small>${l[0]==="en"?"(default)":l[2]}</small></span></button>`).join("")}
 function open(){paintList();back.hidden=false;sheet.setAttribute("aria-hidden","false");requestAnimationFrame(()=>requestAnimationFrame(()=>{sheet.classList.add("open");back.classList.add("show")}));document.body.style.overflow="hidden"}
 function close(){sheet.classList.remove("open");back.classList.remove("show");sheet.setAttribute("aria-hidden","true");document.body.style.overflow="";setTimeout(()=>{if(!sheet.classList.contains("open"))back.hidden=true},350)}
 document.getElementById("settingsLanguage").addEventListener("click",open);
 document.getElementById("langClose").addEventListener("click",close);back.addEventListener("click",close);
 list.addEventListener("click",e=>{const b=e.target.closest(".sx-lang-row");if(!b)return;setLang(b.dataset.c);setTimeout(close,250)});
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sheet.classList.contains("open"))close()});
 loadCache();paintList();start();
 window.addEventListener("veltrix-ready",()=>{const c=veltrixDB.pref.get("lang","en");if(c!==lang)setLang(c)});
 if(lang!=="en"){document.documentElement.lang=info(lang)[3]==="iw"?"he":lang;walk(document.body);
  if(pending.size&&window.__splash){window.__splash.hold("i18n");flush().catch(()=>{}).finally(()=>window.__splash.release("i18n"))}else schedule()}
})();
