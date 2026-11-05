/* Veltrix racer: small pseudo-3D driving engine for the "Race the clock" bets.
   Same track for every player. Steering = phone tilt (or arrow keys), gas/brake = hold bottom-left / bottom-right.
   Time is still measured by the server (game_bet_start -> game_bet_finish); this file only draws and drives. */
(function(){
"use strict";
const SEG=200,ROAD=2000,RUMBLE=3,FOV=100,CAMH=950,DRAW=110,LAPS=2,LAP_SEGS=520,TAIL=160;
const CAMD=1/Math.tan(FOV/2*Math.PI/180),MAXV=SEG*60,ACC=MAXV/4.2,BRK=-MAXV*1.1,DEC=-MAXV/5,OFFDEC=-MAXV/2,OFFLIM=MAXV/4,CENT=0.3;
const ease=(a,b,p)=>a+(b-a)*((-Math.cos(p*Math.PI)/2)+.5),lin=(a,b,p)=>a+(b-a)*p,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
/* ---- track (fixed layout, no randomness so both players race the same road) ---- */
function build(){
 const segs=[];let y=0;
 const add=(curve,yy)=>{const i=segs.length,y1=y;segs.push({i,y1,y2:yy,curve,spr:[]});y=yy};
 const road=(en,hold,lv,curve,dy)=>{const y0=y,end=y0+dy*SEG*0,tgt=y0+dy,n=en+hold+lv;
  for(let k=0;k<en;k++)add(ease(0,curve,k/en),ease(y0,tgt,k/n));
  for(let k=0;k<hold;k++)add(curve,ease(y0,tgt,(en+k)/n));
  for(let k=0;k<lv;k++)add(ease(curve,0,k/lv),ease(y0,tgt,(en+hold+k)/n))};
 for(let l=0;l<LAPS;l++){
  road(20,20,20,0,0);          road(25,40,25,2.2,0);      road(15,35,15,0,900);
  road(20,30,20,-3.4,0);       road(25,15,25,0,-900);     road(15,15,15,3.2,0);
  road(15,15,15,-3.2,0);       road(30,45,30,4.6,500);    road(20,25,20,0,-500);
  road(25,40,25,-2.6,0);       road(20,20,20,0,0);
 }
 const lap=segs.length/LAPS;
 for(let k=0;k<TAIL;k++)add(0,0);
 /* roadside scenery */
 segs.forEach((s,i)=>{
  if(i%9===0){const side=(i/9)%2?1:-1;s.spr.push({t:"tree",x:side*(1.5+((i*37)%5)*.22),s:1})}
  if(i%23===5){s.spr.push({t:"tree",x:-(2.2+((i*13)%4)*.3),s:1.25}); s.spr.push({t:"tree",x:2.4+((i*7)%4)*.3,s:1.1})}
  if(i%61===12)s.spr.push({t:"sign",x:-1.45,s:1});
  if(i%97===40)s.spr.push({t:"sign",x:1.45,s:1});
 });
 return {segs,lap,len:segs.length*SEG,finish:LAPS*lap*SEG};
}
const TRACK=build();
function proj(p,cx,cy,cz,W,H){
 p.cx=p.x-cx;p.cy=p.y-cy;p.cz=p.z-cz;p.sc=CAMD/p.cz;
 p.sx=Math.round(W/2+p.sc*p.cx*W/2);p.sy=Math.round(H/2-p.sc*p.cy*H/2);p.sw=Math.round(p.sc*ROAD*W/2)}
function poly(c,x1,y1,x2,y2,x3,y3,x4,y4,col){c.fillStyle=col;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.lineTo(x3,y3);c.lineTo(x4,y4);c.closePath();c.fill()}
const COL={
 a:{road:"#4a4d52",grass:"#4f6b3c",rum:"#d8332f",lane:"#d9dadc"},
 b:{road:"#43464b",grass:"#476338",rum:"#f4f4f4"}};
/* ---- scenery drawing ---- */
function sky(c,W,H,hz,off){
 const g=c.createLinearGradient(0,0,0,hz);g.addColorStop(0,"#2a3550");g.addColorStop(.6,"#566a8a");g.addColorStop(1,"#a6b4c4");c.fillStyle=g;c.fillRect(0,0,W,hz+2);
 /* storm clouds */
 c.fillStyle="rgba(24,30,46,.55)";for(let i=0;i<7;i++){const x=((i*W*.31-off*.06)%(W*1.6)+W*1.6)%(W*1.6)-W*.3;c.beginPath();c.ellipse(x,hz*.28+((i*17)%9)*4,W*.28,hz*.14,0,0,7);c.fill()}
 /* city skyline */
 const bw=W*.09,n=Math.ceil(W/bw)+3,sh=hz;
 for(let i=0;i<n;i++){const x=((i*bw-off*.25)%(n*bw)+n*bw)%(n*bw)-bw*1.2,h=hz*(.28+((i*53)%7)*.07);
  c.fillStyle=i%3?"#2c3a52":"#35455f";c.fillRect(x,sh-h,bw*.92,h);
  c.fillStyle="rgba(255,226,150,.55)";for(let wy=sh-h+6;wy<sh-8;wy+=11)for(let wx=x+5;wx<x+bw*.9-5;wx+=10)if(((wx*7+wy*3+i)|0)%5<2)c.fillRect(wx,wy,4,5)}
 /* hills */
 c.fillStyle="#3b5530";c.beginPath();c.moveTo(0,hz);for(let x=0;x<=W;x+=W/16)c.lineTo(x,hz-8-Math.sin((x-off*.5)/W*7)*7);c.lineTo(W,hz);c.closePath();c.fill()}
function tree(c,x,y,w,s){const h=w*1.9*s;c.fillStyle="#4d3a2a";c.fillRect(x-w*.05,y-h*.34,w*.1,h*.34);
 c.fillStyle="#2c5a2a";c.beginPath();c.ellipse(x,y-h*.62,w*.3,h*.34,0,0,7);c.fill();c.fillStyle="#37702f";c.beginPath();c.ellipse(x-w*.05,y-h*.7,w*.2,h*.24,0,0,7);c.fill()}
function sign(c,x,y,w){const h=w*1.1;c.fillStyle="#222";c.fillRect(x-w*.03,y-h,w*.06,h);c.fillStyle="#2f6bff";c.fillRect(x-w*.32,y-h*1.28,w*.64,h*.36);c.fillStyle="#fff";c.fillRect(x-w*.26,y-h*1.2,w*.52,h*.05);c.fillRect(x-w*.26,y-h*1.08,w*.34,h*.05)}
/* ---- the player's car, seen from behind ---- */
function car(c,cx,by,w,lean,bump,braking){
 c.save();c.translate(cx,by+bump);c.rotate(lean*.05);
 const h=w*.52;
 c.fillStyle="rgba(0,0,0,.35)";c.beginPath();c.ellipse(0,h*.03,w*.56,h*.1,0,0,7);c.fill();
 /* tyres */
 c.fillStyle="#0c0c0e";c.fillRect(-w*.5,-h*.34,w*.12,h*.34);c.fillRect(w*.38,-h*.34,w*.12,h*.34);
 /* lower body */
 let g=c.createLinearGradient(0,-h,0,0);g.addColorStop(0,"#2b2e35");g.addColorStop(1,"#101216");c.fillStyle=g;
 c.beginPath();c.moveTo(-w*.5,-h*.08);c.quadraticCurveTo(-w*.54,-h*.5,-w*.44,-h*.58);c.lineTo(w*.44,-h*.58);c.quadraticCurveTo(w*.54,-h*.5,w*.5,-h*.08);c.closePath();c.fill();
 /* cabin */
 c.fillStyle="#1a1d23";c.beginPath();c.moveTo(-w*.36,-h*.56);c.quadraticCurveTo(-w*.3,-h*.98,-w*.18,-h);c.lineTo(w*.18,-h);c.quadraticCurveTo(w*.3,-h*.98,w*.36,-h*.56);c.closePath();c.fill();
 g=c.createLinearGradient(0,-h,0,-h*.6);g.addColorStop(0,"#5d6b7e");g.addColorStop(1,"#2a3140");c.fillStyle=g;
 c.beginPath();c.moveTo(-w*.28,-h*.6);c.quadraticCurveTo(-w*.23,-h*.92,-w*.15,-h*.94);c.lineTo(w*.15,-h*.94);c.quadraticCurveTo(w*.23,-h*.92,w*.28,-h*.6);c.closePath();c.fill();
 /* orange stripes */
 c.fillStyle="#f5a31a";c.fillRect(-w*.17,-h*.57,w*.07,h*.2);c.fillRect(-w*.06,-h*.57,w*.07,h*.2);c.fillRect(w*.06,-h*.57,w*.07,h*.2);c.fillRect(w*.17,-h*.57,w*.07,h*.2);
 /* tail lights + plate */
 c.fillStyle=braking?"#ff2a2a":"#a3262a";c.fillRect(-w*.43,-h*.3,w*.2,h*.1);c.fillRect(w*.23,-h*.3,w*.2,h*.1);
 if(braking){c.fillStyle="rgba(255,40,40,.35)";c.fillRect(-w*.47,-h*.34,w*.28,h*.18);c.fillRect(w*.19,-h*.34,w*.28,h*.18)}
 c.fillStyle="#0b0c0f";c.fillRect(-w*.26,-h*.22,w*.52,h*.16);
 c.fillStyle="#f2f2f2";c.fillRect(-w*.12,-h*.2,w*.24,h*.09);c.fillStyle="#222";c.font="bold "+Math.round(w*.045)+"px sans-serif";c.textAlign="center";c.fillText("VELTRIX",0,-h*.125);
 c.fillStyle="#555";c.fillRect(-w*.3,-h*.06,w*.08,h*.07);c.fillRect(w*.22,-h*.06,w*.08,h*.07);
 c.restore()}
/* ---- game object ---- */
function create(canvas){
 const c=canvas.getContext("2d");let W=0,H=0,dpr=1;
 const st={pos:0,speed:0,x:0,steer:0,gas:false,brake:false,skyOff:0,t:0,crash:0};
 function size(){dpr=Math.min(window.devicePixelRatio||1,1.75);const r=canvas.getBoundingClientRect();W=Math.max(2,Math.round(r.width*dpr));H=Math.max(2,Math.round(r.height*dpr));canvas.width=W;canvas.height=H}
 function seg(z){return TRACK.segs[Math.floor(z/SEG)%TRACK.segs.length]}
 function step(dt,input){
  const sp=seg(st.pos),pct=st.speed/MAXV,dx=dt*2*pct;
  st.pos+=st.speed*dt;
  st.steer+=(input.steer-st.steer)*(1-Math.exp(-dt*7));
  st.x+=dx*st.steer*(st.speed>0?1:0);
  st.x-=dx*pct*sp.curve*CENT;
  if(input.gas&&!input.brake)st.speed+=ACC*dt;else if(input.brake)st.speed+=BRK*dt;else st.speed+=DEC*dt;
  if((st.x<-1||st.x>1)&&st.speed>OFFLIM)st.speed+=OFFDEC*dt;
  /* trees */
  const s2=seg(st.pos+SEG*2);for(const o of s2.spr){if(o.t==="tree"&&Math.abs(st.x-o.x)<.32&&st.speed>MAXV*.2){st.speed=MAXV*.12;st.crash=.35;o.hit=1}}
  st.speed=clamp(st.speed,0,MAXV);st.x=clamp(st.x,-2.4,2.4);st.brake=!!input.brake;
  if(st.crash>0)st.crash-=dt;
  st.skyOff+=sp.curve*pct*dt*900;st.t+=dt;
  return st.pos>=TRACK.finish}
function render(){
 if(!W)size();
 const segs=TRACK.segs,N=segs.length,pos=Math.min(st.pos,TRACK.len-SEG*DRAW-1),base=segs[Math.floor(pos/SEG)%N],bp=(pos%SEG)/SEG;
 const ps=segs[Math.floor((pos+CAMH*0+SEG*3)/SEG)%N],py=lin(base.y1,base.y2,bp);
 const hz=Math.round(H*.43);
 sky(c,W,H,hz,st.skyOff);
 c.fillStyle="#476338";c.fillRect(0,hz,W,H-hz);
 let x=0,dx=-(base.curve*bp),maxy=H;const vis=[];
 for(let n=0;n<DRAW;n++){
  const s=segs[(base.i+n)%N],p1={x:0,y:s.y1,z:(base.i+n)*SEG},p2={x:0,y:s.y2,z:(base.i+n+1)*SEG};
  const camX=st.x*ROAD-x,camY=py+CAMH,camZ=pos;
  proj(p1,camX,camY,camZ,W,H);proj(p2,camX-dx,camY,camZ,W,H);x+=dx;dx+=s.curve;
  if(p1.cz<=CAMD||p2.sy>=maxy||p2.sy>=p1.sy)continue;
  const k=((base.i+n)%(RUMBLE*2))<RUMBLE?COL.a:COL.b,lane=((base.i+n)%(RUMBLE*4))<RUMBLE*2;
  c.fillStyle=k.grass;c.fillRect(0,p2.sy,W,p1.sy-p2.sy);
  const r1=p1.sw/6,r2=p2.sw/6;
  poly(c,p1.sx-p1.sw-r1,p1.sy,p1.sx-p1.sw,p1.sy,p2.sx-p2.sw,p2.sy,p2.sx-p2.sw-r2,p2.sy,k.rum);
  poly(c,p1.sx+p1.sw+r1,p1.sy,p1.sx+p1.sw,p1.sy,p2.sx+p2.sw,p2.sy,p2.sx+p2.sw+r2,p2.sy,k.rum);
  poly(c,p1.sx-p1.sw,p1.sy,p1.sx+p1.sw,p1.sy,p2.sx+p2.sw,p2.sy,p2.sx-p2.sw,p2.sy,k.road);
  if(lane){const l1=p1.sw/30,l2=p2.sw/30;poly(c,p1.sx-l1,p1.sy,p1.sx+l1,p1.sy,p2.sx+l2,p2.sy,p2.sx-l2,p2.sy,"rgba(235,235,235,.8)")}
  /* finish line */
  const gi=base.i+n,fz=TRACK.finish/SEG;if(gi===fz||gi===fz+1){const q=gi===fz?"#f4f4f4":"#16181c";poly(c,p1.sx-p1.sw,p1.sy,p1.sx+p1.sw,p1.sy,p2.sx+p2.sw,p2.sy,p2.sx-p2.sw,p2.sy,q)}
  s.p1=p1;s.p2=p2;s.clip=maxy;maxy=p1.sy;vis.push(s)}
 for(let n=vis.length-1;n>=0;n--){const s=vis[n];
  for(const o of s.spr){if(o.hit)continue;const sc=s.p1.sc,sx=s.p1.sx+sc*o.x*ROAD*W/2,sy=s.p1.sy,w=sc*ROAD*W/2*.55*o.s;
   if(s.clip<sy)c.save(),c.beginPath(),c.rect(0,0,W,s.clip),c.clip();else c.save();
   (o.t==="tree"?tree:sign)(c,sx,sy,w,o.s);c.restore()}
  const gi=s.i,fz=TRACK.finish/SEG;
  if(gi===fz){const sc=s.p1.sc,a=s.p1.sx-s.p1.sw*1.12,b=s.p1.sx+s.p1.sw*1.12,y=s.p1.sy,h=s.p1.sw*.9;
   c.fillStyle="#222";c.fillRect(a-3,y-h,6,h);c.fillRect(b-3,y-h,6,h);
   const bh=h*.2,cw=(b-a)/18;for(let i=0;i<18;i++)for(let j=0;j<2;j++){c.fillStyle=(i+j)%2?"#111":"#fff";c.fillRect(a+i*cw,y-h-bh+j*bh/2,cw+1,bh/2)}}}
 /* car */
 const pct=st.speed/MAXV,cw=W*.4,cy=H-H*.065,bump=Math.sin(st.t*38)*pct*H*.0035+(st.crash>0?Math.sin(st.t*60)*H*.01:0);
 car(c,W/2+st.steer*W*.012,cy,cw,st.steer,bump,st.brake);
 /* speed lines */
 if(pct>.55){c.strokeStyle="rgba(255,255,255,"+((pct-.55)*.35)+")";c.lineWidth=dpr;for(let i=0;i<10;i++){const a=((st.t*3+i*.1)%1),r=Math.pow(a,2),ang=(i/10)*Math.PI*2;
   const cx0=W/2,cy0=hz,r1=r*W*.7,r2=r1+W*.05*a;c.beginPath();c.moveTo(cx0+Math.cos(ang)*r1,cy0+Math.sin(ang)*r1*.6);c.lineTo(cx0+Math.cos(ang)*r2,cy0+Math.sin(ang)*r2*.6);c.stroke()}}
}
 return {st,size,render,step,reset(){st.pos=0;st.speed=0;st.x=0;st.steer=0;st.skyOff=0;st.t=0;st.crash=0;TRACK.segs.forEach(s=>s.spr.forEach(o=>o.hit=0))},
  kmh(){return Math.round(st.speed/MAXV*212)},lap(){return Math.min(LAPS,Math.floor(st.pos/(TRACK.lap*SEG))+1)},laps:LAPS,progress(){return clamp(st.pos/TRACK.finish,0,1)}}
}
window.vxRacer={create,TRACK};
})();
