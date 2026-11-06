/* Offline QR generator (byte mode, ECC level M, versions 1-14). window.VeltrixQR.render(el, text, {size}) */
(function(){
"use strict";
// [ecCodewordsPerBlock, [ [numBlocks, dataCodewordsPerBlock], ... ]] for level M, versions 1..14
var M=[null,[10,[[1,16]]],[16,[[1,28]]],[26,[[1,44]]],[18,[[2,32]]],[24,[[2,43]]],[16,[[4,27]]],[18,[[4,31]]],[22,[[2,38],[2,39]]],[22,[[3,36],[2,37]]],[26,[[4,43],[1,44]]],[30,[[1,50],[4,51]]],[22,[[6,36],[2,37]]],[22,[[8,37],[1,38]]],[24,[[4,40],[5,41]]]];
var ALIGN=[null,[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66]];
var EXP=new Array(512),LOG=new Array(256);
(function(){var x=1;for(var i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&256)x^=0x11d}for(i=255;i<512;i++)EXP[i]=EXP[i-255]})();
function mul(a,b){return a&&b?EXP[LOG[a]+LOG[b]]:0}
function rsGen(n){var g=[1];for(var i=0;i<n;i++){var ng=new Array(g.length+1).fill(0);for(var j=0;j<g.length;j++){ng[j]^=g[j];ng[j+1]^=mul(g[j],EXP[i])}g=ng}return g}
function rsEnc(data,n){var g=rsGen(n),r=new Array(n).fill(0);for(var i=0;i<data.length;i++){var f=data[i]^r[0];r.shift();r.push(0);if(f)for(var j=0;j<n;j++)r[j]^=mul(g[j+1],f)}return r}
function utf8(s){return Array.from(unescape(encodeURIComponent(s)),function(c){return c.charCodeAt(0)})}
function capacity(v){var t=0,b=M[v][1];for(var i=0;i<b.length;i++)t+=b[i][0]*b[i][1];return t}
function bchFormat(d){var r=d<<10;for(var i=14;i>=10;i--)if(r>>i&1)r^=0x537<<(i-10);return((d<<10)|r)^0x5412}
function bchVersion(v){var r=v<<12;for(var i=17;i>=12;i--)if(r>>i&1)r^=0x1f25<<(i-12);return(v<<12)|r}
function build(text){
  var bytes=utf8(text),v=1;
  while(v<=14&&capacity(v)<bytes.length+(v<10?2:3))v++;
  if(v>14)throw new Error("QR data too long");
  var cap=capacity(v),bits=[];
  function put(val,len){for(var i=len-1;i>=0;i--)bits.push(val>>i&1)}
  put(4,4);put(bytes.length,v<10?8:16);bytes.forEach(function(b){put(b,8)});
  put(0,Math.min(4,cap*8-bits.length));while(bits.length%8)bits.push(0);
  var data=[];for(var i=0;i<bits.length;i+=8){var b=0;for(var j=0;j<8;j++)b=b<<1|bits[i+j];data.push(b)}
  for(var pad=0;data.length<cap;pad^=1)data.push(pad?0x11:0xec);
  var ecLen=M[v][0],blocks=[],ecs=[],pos=0;
  M[v][1].forEach(function(g){for(var k=0;k<g[0];k++){var d=data.slice(pos,pos+g[1]);pos+=g[1];blocks.push(d);ecs.push(rsEnc(d,ecLen))}});
  var out=[],maxD=Math.max.apply(null,blocks.map(function(b){return b.length}));
  for(i=0;i<maxD;i++)blocks.forEach(function(b){if(i<b.length)out.push(b[i])});
  for(i=0;i<ecLen;i++)ecs.forEach(function(e){out.push(e[i])});
  var n=17+4*v,mod=[],fn=[];
  for(i=0;i<n;i++){mod.push(new Array(n).fill(false));fn.push(new Array(n).fill(false))}
  function set(r,c,val){mod[r][c]=!!val;fn[r][c]=true}
  function finder(r,c){for(var y=-1;y<=7;y++)for(var x=-1;x<=7;x++){var rr=r+y,cc=c+x;if(rr<0||cc<0||rr>=n||cc>=n)continue;set(rr,cc,y>=0&&y<=6&&x>=0&&x<=6&&(y===0||y===6||x===0||x===6||(y>=2&&y<=4&&x>=2&&x<=4)))}}
  finder(0,0);finder(0,n-7);finder(n-7,0);
  var al=ALIGN[v];
  al.forEach(function(r){al.forEach(function(c){if(fn[r][c])return;for(var y=-2;y<=2;y++)for(var x=-2;x<=2;x++)set(r+y,c+x,Math.max(Math.abs(y),Math.abs(x))!==1)})});
  for(i=8;i<n-8;i++){if(!fn[6][i])set(6,i,i%2===0);if(!fn[i][6])set(i,6,i%2===0)}
  set(n-8,8,true);
  for(i=0;i<9;i++){if(!fn[8][i])set(8,i,false);if(!fn[i][8])set(i,8,false)}
  for(i=0;i<8;i++){if(!fn[8][n-1-i])set(8,n-1-i,false);if(!fn[n-1-i][8])set(n-1-i,8,false)}
  if(v>=7){var vi=bchVersion(v);for(i=0;i<18;i++){var bit=vi>>i&1,a=Math.floor(i/3),b2=i%3+n-11;set(a,b2,bit);set(b2,a,bit)}}
  // place data
  var allBits=[];out.forEach(function(b){for(var k=7;k>=0;k--)allBits.push(b>>k&1)});
  var bi=0,up=true;
  for(var col=n-1;col>0;col-=2){if(col===6)col--;
    for(var t=0;t<n;t++){var row=up?n-1-t:t;
      for(var d=0;d<2;d++){var cc2=col-d;if(fn[row][cc2])continue;mod[row][cc2]=bi<allBits.length?allBits[bi]===1:false;bi++}}
    up=!up}
  var masks=[function(r,c){return(r+c)%2===0},function(r){return r%2===0},function(r,c){return c%3===0},function(r,c){return(r+c)%3===0},function(r,c){return(Math.floor(r/2)+Math.floor(c/3))%2===0},function(r,c){return(r*c)%2+(r*c)%3===0},function(r,c){return((r*c)%2+(r*c)%3)%2===0},function(r,c){return((r+c)%2+(r*c)%3)%2===0}];
  function withMask(m){
    var g=mod.map(function(row,r){return row.map(function(val,c){return fn[r][c]?val:val!==masks[m](r,c)})});
    var f=bchFormat(0<<3|m); // level M = 00
    function sf(r,c,bit){g[r][c]=!!bit}
    for(var k=0;k<=5;k++)sf(k,8,f>>k&1);sf(7,8,f>>6&1);sf(8,8,f>>7&1);sf(8,7,f>>8&1);for(k=9;k<15;k++)sf(8,14-k,f>>k&1);
    for(k=0;k<8;k++)sf(8,n-1-k,f>>k&1);for(k=8;k<15;k++)sf(n-15+k,8,f>>k&1);
    sf(n-8,8,true);
    return g}
  function penalty(g){var p=0,r,c,run,k;
    for(r=0;r<n;r++){run=1;for(c=1;c<n;c++){if(g[r][c]===g[r][c-1])run++;else{if(run>=5)p+=run-2;run=1}}if(run>=5)p+=run-2}
    for(c=0;c<n;c++){run=1;for(r=1;r<n;r++){if(g[r][c]===g[r-1][c])run++;else{if(run>=5)p+=run-2;run=1}}if(run>=5)p+=run-2}
    for(r=0;r<n-1;r++)for(c=0;c<n-1;c++)if(g[r][c]===g[r][c+1]&&g[r][c]===g[r+1][c]&&g[r][c]===g[r+1][c+1])p+=3;
    var pat=[1,0,1,1,1,0,1,0,0,0,0],pat2=pat.slice().reverse();
    function m(arr,at){return pat.every(function(x,i){return(arr[at+i]?1:0)===x})||pat2.every(function(x,i){return(arr[at+i]?1:0)===x})}
    for(r=0;r<n;r++)for(c=0;c<=n-11;c++){if(m(g[r],c))p+=40}
    for(c=0;c<n;c++){var col2=g.map(function(row){return row[c]});for(r=0;r<=n-11;r++)if(m(col2,r))p+=40}
    var dark=0;g.forEach(function(row){row.forEach(function(x){if(x)dark++})});p+=Math.floor(Math.abs(dark*20/(n*n)-10))*10;
    return p}
  var best=null,bp=1e9;for(var mk=0;mk<8;mk++){var g=withMask(mk),pp=penalty(g);if(pp<bp){bp=pp;best=g}}
  return best;
}
var RO=2.4,RI=1.4;
function svg(matrix,size,dark,light){
  var n=matrix.length,q=4,total=n+2*q,d="";
  var inFinder=function(r,c){return(r<7&&c<7)||(r<7&&c>=n-7)||(r>=n-7&&c<7)};
  for(var r=0;r<n;r++)for(var c=0;c<n;c++)if(matrix[r][c]&&!inFinder(r,c))d+="M"+(c+q)+" "+(r+q)+"h1v1h-1z";
  var f="";
  function rr(x,y,w,r){return "M"+(x+r)+" "+y+"h"+(w-2*r)+"a"+r+" "+r+" 0 0 1 "+r+" "+r+"v"+(w-2*r)+"a"+r+" "+r+" 0 0 1 -"+r+" "+r+"h-"+(w-2*r)+"a"+r+" "+r+" 0 0 1 -"+r+" -"+r+"v-"+(w-2*r)+"a"+r+" "+r+" 0 0 1 "+r+" -"+r+"z"}
  // Receive-crypto style ("extra-rounded" finder ring, square centre dot).
  [[0,0],[0,n-7],[n-7,0]].forEach(function(p){var x=p[1]+q,y=p[0]+q;
    f+='<path fill-rule="evenodd" fill="'+dark+'" d="'+rr(x,y,7,RO)+rr(x+1,y+1,5,RI)+'"/><rect x="'+(x+2)+'" y="'+(y+2)+'" width="3" height="3" fill="'+dark+'"/>'});
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+total+' '+total+'" width="'+size+'" height="'+size+'" preserveAspectRatio="xMidYMid meet"><rect width="'+total+'" height="'+total+'" fill="'+light+'"/><path d="'+d+'" fill="'+dark+'"/>'+f+'</svg>'}
window.VeltrixQR={
  matrix:build,
  render:function(el,text,opts){opts=opts||{};el.innerHTML=svg(build(text),opts.size||240,opts.dark||"#17181c",opts.light||"#ffffff");return el.firstChild}
};
})();
