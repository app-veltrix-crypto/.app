/* Veltrix racer 3D: real WebGL scene (no libraries) for the "Race the clock" bets.
   Driving rules/physics come from racer.js (same track, same collisions); this file only draws: lit houses, trees, textured road,
   hills, fog, sky and a modelled car with spinning wheels. create(canvas) throws if WebGL isn't available so game.js can fall back. */
(function(){
"use strict";
const SIM=window.vxRacer;if(!SIM||!SIM.TRACK)return;
const TRACK=SIM.TRACK,SEGS=TRACK.segs,NS0=SEGS.length,LEAD=24,NS=NS0+LEAD;   /* NS counts the 24 straight run-in segments before the start */
const K=0.00395,YS=1.5/200,HALF=6,KERB=6.9,FLAT=22,EMB=44,G=-1.2,CH=100,FIN=Math.round(TRACK.finish/200)+LEAD;
const FOGC=[.34,.27,.44];   /* dusk haze */
const rnd=i=>{const s=Math.sin(i*127.1+311.7)*43758.5453;return s-Math.floor(s)};
const lerp=(a,b,t)=>a+(b-a)*t,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
/* ---------- matrices ---------- */
const mul=(a,b)=>{const o=new Array(16);for(let i=0;i<4;i++)for(let j=0;j<4;j++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+j]*b[i*4+k];o[i*4+j]=s}return o};
const T4=(x,y,z)=>[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1],S4=(x,y,z)=>[x,0,0,0,0,y,0,0,0,0,z,0,0,0,0,1];
const RY=a=>{const c=Math.cos(a),s=Math.sin(a);return[c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]};
const RX=a=>{const c=Math.cos(a),s=Math.sin(a);return[1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1]};
const RZ=a=>{const c=Math.cos(a),s=Math.sin(a);return[c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1]};
const persp=(f,a,n,fa)=>{const t=1/Math.tan(f/2),nf=1/(n-fa);return[t/a,0,0,0,0,t,0,0,0,0,(fa+n)*nf,-1,0,0,2*fa*n*nf,0]};
function lookAt(e,c,u){let zx=e[0]-c[0],zy=e[1]-c[1],zz=e[2]-c[2],l=Math.hypot(zx,zy,zz);zx/=l;zy/=l;zz/=l;
 let xx=u[1]*zz-u[2]*zy,xy=u[2]*zx-u[0]*zz,xz=u[0]*zy-u[1]*zx;l=Math.hypot(xx,xy,xz);xx/=l;xy/=l;xz/=l;
 const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
 return[xx,yx,zx,0,xy,yy,zy,0,xz,yz,zz,0,-(xx*e[0]+xy*e[1]+xz*e[2]),-(yx*e[0]+yy*e[1]+yz*e[2]),-(zx*e[0]+zy*e[1]+zz*e[2]),1]}
/* ---------- mesh builder: interleaved p3 n3 c4 uv2 ---------- */
function MB(){this.a=[]}
MB.prototype.vert=function(p,n,c,u){this.a.push(p[0],p[1],p[2],n[0],n[1],n[2],c[0],c[1],c[2],c.length>3?c[3]:1,u?u[0]:0,u?u[1]:0)};
MB.prototype.tri=function(p0,p1,p2,c,hint,u0,u1,u2){
 const ax=p1[0]-p0[0],ay=p1[1]-p0[1],az=p1[2]-p0[2],bx=p2[0]-p0[0],by=p2[1]-p0[1],bz=p2[2]-p0[2];
 let nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;const l=Math.hypot(nx,ny,nz)||1;nx/=l;ny/=l;nz/=l;
 if(hint&&nx*hint[0]+ny*hint[1]+nz*hint[2]<0){nx=-nx;ny=-ny;nz=-nz}
 const n=[nx,ny,nz];this.vert(p0,n,c,u0);this.vert(p1,n,c,u1);this.vert(p2,n,c,u2)};
MB.prototype.quad=function(p0,p1,p2,p3,c,hint,u0,u1,u2,u3){this.tri(p0,p1,p2,c,hint,u0,u1,u2);this.tri(p0,p2,p3,c,hint,u0,u2,u3)};
MB.prototype.box=function(cx,y0,cz,sx,sy,sz,c){const x0=cx-sx/2,x1=cx+sx/2,z0=cz-sz/2,z1=cz+sz/2,y1=y0+sy;
 this.quad([x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1],c,[0,1,0]);
 this.quad([x0,y0,z0],[x0,y1,z0],[x0,y1,z1],[x0,y0,z1],c,[-1,0,0]);this.quad([x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0],c,[1,0,0]);
 this.quad([x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],c,[0,0,-1]);this.quad([x0,y0,z1],[x0,y1,z1],[x1,y1,z1],[x1,y0,z1],c,[0,0,1])};
MB.prototype.cone=function(cx,y0,cz,r,h,n,c0,c1,r2){r2=r2||0;const L=Math.hypot(h,r-r2);
 for(let i=0;i<n;i++){const a0=i/n*6.2832,a1=(i+1)/n*6.2832,ca0=Math.cos(a0),sa0=Math.sin(a0),ca1=Math.cos(a1),sa1=Math.sin(a1);
  const n0=[ca0*h/L,(r-r2)/L,sa0*h/L],n1=[ca1*h/L,(r-r2)/L,sa1*h/L];
  const b0=[cx+ca0*r,y0,cz+sa0*r],b1=[cx+ca1*r,y0,cz+sa1*r],t0=[cx+ca0*r2,y0+h,cz+sa0*r2],t1=[cx+ca1*r2,y0+h,cz+sa1*r2];
  this.vert(b0,n0,c0);this.vert(b1,n1,c0);this.vert(t1,n1,c1);this.vert(b0,n0,c0);this.vert(t1,n1,c1);this.vert(t0,n0,c1)}};
MB.prototype.ell=function(cx,cy,cz,rx,ry,rz,c0,c1,lat,lon){lat=lat||5;lon=lon||8;
 const P=(i,j)=>{const th=i/lat*Math.PI,ph=j/lon*6.2832,x=Math.sin(th)*Math.cos(ph),y=Math.cos(th),z=Math.sin(th)*Math.sin(ph);
  const f=(y+1)/2,c=[lerp(c0[0],c1[0],f),lerp(c0[1],c1[1],f),lerp(c0[2],c1[2],f)];return{p:[cx+x*rx,cy+y*ry,cz+z*rz],n:[x/rx*Math.max(rx,rz),y/ry*Math.max(rx,rz),z/rz*Math.max(rx,rz)],c}};
 for(let i=0;i<lat;i++)for(let j=0;j<lon;j++){const A=P(i,j),B=P(i+1,j),C=P(i+1,j+1),D=P(i,j+1);
  for(const t of[[A,B,C],[A,C,D]])for(const q of t)this.vert(q.p,q.n,q.c)}};
/* append a prebuilt local geometry with yaw/scale/translate and a colour tint */
function place(dst,src,tx,ty,tz,yaw,s,tint){const c=Math.cos(yaw),sn=Math.sin(yaw),a=src.a;tint=tint||1;
 for(let i=0;i<a.length;i+=12){const x=a[i]*s,y=a[i+1]*s,z=a[i+2]*s,nx=a[i+3],nz=a[i+5];
  dst.a.push(tx+x*c+z*sn,ty+y,tz-x*sn+z*c,nx*c+nz*sn,a[i+4],-nx*sn+nz*c,a[i+6]*tint,a[i+7]*tint,a[i+8]*tint,a[i+9],a[i+10],a[i+11])}}
/* ---------- world path ---------- */
const PX=new Float32Array(NS+1),PZ=new Float32Array(NS+1),PY=new Float32Array(NS+1),PH=new Float32Array(NS+1);
(function(){let x=0,z=0,h=0;for(let i=0;i<NS;i++){const sg=SEGS[Math.max(0,i-LEAD)];PX[i]=x;PZ[i]=z;PH[i]=h;PY[i]=sg.y1*YS;const c=(i<LEAD?0:sg.curve)*K,hm=h-c/2;x+=Math.sin(hm);z+=Math.cos(hm);h-=c}
 PX[NS]=x;PZ[NS]=z;PH[NS]=h;PY[NS]=SEGS[NS0-1].y2*YS})();
function frame(i){i=clamp(i,0,NS);const h=PH[i];return{x:PX[i],y:PY[i],z:PZ[i],h,rx:-Math.cos(h),rz:Math.sin(h),fx:Math.sin(h),fz:Math.cos(h)}}
function sample(s){s=clamp(s,0,NS-.001);const i=Math.floor(s),t=s-i,h=lerp(PH[i],PH[i+1],t);
 return{x:lerp(PX[i],PX[i+1],t),y:lerp(PY[i],PY[i+1],t),z:lerp(PZ[i],PZ[i+1],t),h,rx:-Math.cos(h),rz:Math.sin(h),fx:Math.sin(h),fz:Math.cos(h),slope:PY[Math.min(NS,i+1)]-PY[i]}}
const terr=(d,y)=>{const a=Math.abs(d);if(a<=FLAT)return y;if(a>=EMB)return G;let t=(a-FLAT)/(EMB-FLAT);t=t*t*(3-2*t);return y+(G-y)*t};
const pt=(f,d,y)=>[f.x+f.rx*d,y,f.z+f.rz*d];
function roadDist(x,z){let m=1e9;for(let i=0;i<=NS;i+=2){const dx=PX[i]-x,dz=PZ[i]-z,d=dx*dx+dz*dz;if(d<m)m=d}return Math.sqrt(m)}
/* ---------- local tree geometry ---------- */
function pineGeo(){const m=new MB();m.cone(0,0,0,.24,1.8,6,[.3,.2,.12],[.25,.17,.1],.18);
 m.cone(0,1.1,0,2.0,2.8,8,[.1,.27,.12],[.14,.36,.15]);m.cone(0,2.7,0,1.55,2.5,8,[.11,.3,.13],[.16,.4,.17]);m.cone(0,4.1,0,1.05,2.3,8,[.13,.34,.15],[.2,.46,.2]);return m}
function roundGeo(){const m=new MB();m.cone(0,0,0,.3,2.5,6,[.32,.22,.14],[.26,.18,.11],.2);
 m.ell(0,3.3,0,1.9,1.6,1.9,[.1,.26,.1],[.2,.45,.17]);m.ell(.9,3.9,.3,1.4,1.2,1.4,[.12,.3,.11],[.24,.5,.18]);m.ell(-.8,3.6,-.5,1.3,1.2,1.3,[.1,.28,.11],[.21,.47,.17]);return m}
function signGeo(){const m=new MB();m.box(0,0,0,.09,2.4,.09,[.3,.3,.32]);m.box(0,2.0,0,1.5,.8,.08,[.15,.35,.85]);m.box(0,2.25,.05,1.2,.08,.02,[.95,.95,.95]);m.box(0,2.05,.05,.8,.08,.02,[.95,.95,.95]);return m}
const PINE=pineGeo(),ROUND=roundGeo(),SIGN=signGeo();
/* ---------- houses ---------- */
const WALLS={a:[[.86,.8,.7],[.78,.72,.64],.9&&[.9,.88,.84],[.72,.56,.48]],b:[[.72,.78,.84],[.82,.84,.86],[.62,.67,.74],[.78,.8,.72]],c:[[.55,.58,.65],[.66,.62,.56]]};
function houseGeo(kind,seed){
 const m=new MB(),pick=a=>a[Math.floor(rnd(seed*3.1)*a.length)];
 const cfg={a:{w:9,d:7+rnd(seed)*3,fl:2},b:{w:11,d:15+rnd(seed)*4,fl:4+Math.floor(rnd(seed+1)*3)},c:{w:10,d:10,fl:8+Math.floor(rnd(seed+2)*4)}}[kind];
 const wall=pick(WALLS[kind]),w=cfg.w,d=cfg.d,H=cfg.fl*3+(kind==="a"?.6:1),base=-(1-G);   /* body goes down into the slope */
 const top=H,bot=-14;
 m.box(0,bot,0,w,top-bot,d,wall);
 const glass=[.14,.2,.28],warm=[.82,.7,.42];
 const win=(face,u,y,wd,hh,c)=>{ // face: 0 front(-x) 1 +z 2 -z 3 back(+x)
  if(face===0)m.quad([-w/2-.04,y-hh/2,u-wd/2],[-w/2-.04,y+hh/2,u-wd/2],[-w/2-.04,y+hh/2,u+wd/2],[-w/2-.04,y-hh/2,u+wd/2],c,[-1,0,0]);
  else if(face===1)m.quad([u-wd/2,y-hh/2,d/2+.04],[u+wd/2,y-hh/2,d/2+.04],[u+wd/2,y+hh/2,d/2+.04],[u-wd/2,y+hh/2,d/2+.04],c,[0,0,1]);
  else if(face===2)m.quad([u-wd/2,y-hh/2,-d/2-.04],[u-wd/2,y+hh/2,-d/2-.04],[u+wd/2,y+hh/2,-d/2-.04],[u+wd/2,y-hh/2,-d/2-.04],c,[0,0,-1])};
 const sp=kind==="a"?2.9:2.6,ww=kind==="a"?1.2:1.15,wh=kind==="a"?1.45:1.5;
 for(let f=0;f<cfg.fl;f++){const y=1.0+f*3+1.0;
  const cols=Math.max(1,Math.floor((d-1)/sp));for(let k=0;k<cols;k++){const u=-d/2+(d/cols)*(k+.5);
   if(!(f===0&&k===Math.floor(cols/2)))win(0,u,y,ww,wh,rnd(seed*7+f*13+k)<.18?warm:glass)}
  const rows=Math.max(1,Math.floor((w-1)/sp));for(let k=0;k<rows;k++){const u=-w/2+(w/rows)*(k+.5);
   win(1,u,y,ww,wh,rnd(seed*5+f*11+k)<.15?warm:glass);win(2,u,y,ww,wh,rnd(seed*9+f*3+k)<.15?warm:glass)}}
 m.box(-w/2-.04,0,0,.05,2.1,1.0,[.34,.2,.12]);
 if(kind==="a"){const rc=pick([[.5,.22,.17],[.32,.32,.36],[.42,.27,.2]]),rh=2.7,o=.5,x0=-w/2-o,x1=w/2+o,z0=-d/2-o,z1=d/2+o;
  m.quad([x0,top,z0],[x0,top,z1],[0,top+rh,z1],[0,top+rh,z0],rc,[-rh,w/2+o,0]);m.quad([x1,top,z1],[x1,top,z0],[0,top+rh,z0],[0,top+rh,z1],rc,[rh,w/2+o,0]);
  m.tri([-w/2,top,-d/2],[w/2,top,-d/2],[0,top+rh,-d/2],wall,[0,0,-1]);m.tri([-w/2,top,d/2],[0,top+rh,d/2],[w/2,top,d/2],wall,[0,0,1]);
  m.box(w*.2,top+rh*.5,d*.15,.7,rh*.9,.7,[.4,.25,.2])}
 else m.box(0,top,0,w+.5,.5,d+.5,[.3,.3,.33]);
 return{m,w,d};
}
/* ---------- world build (CPU, once) ---------- */
let WORLD=null;
function buildWorld(){
 const chunks=[];const nch=Math.ceil(NS/CH);
 for(let c=0;c<nch;c++)chunks.push({road:new MB(),grass:new MB(),plain:new MB()});
 const UP=[0,1,0];
 for(let i=0;i<NS;i++){const a=frame(i),b=frame(i+1),C=chunks[Math.floor(i/CH)];
  C.road.quad(pt(a,-HALF,a.y),pt(a,HALF,a.y),pt(b,HALF,b.y),pt(b,-HALF,b.y),[1,1,1],UP,[0,i/8],[1,i/8],[1,(i+1)/8],[0,(i+1)/8]);
  const kc=Math.floor(i/3)%2?[.9,.9,.9]:[.78,.12,.1];
  C.plain.quad(pt(a,-KERB,a.y+.035),pt(a,-HALF,a.y+.035),pt(b,-HALF,b.y+.035),pt(b,-KERB,b.y+.035),kc,UP);
  C.plain.quad(pt(a,HALF,a.y+.035),pt(a,KERB,a.y+.035),pt(b,KERB,b.y+.035),pt(b,HALF,b.y+.035),kc,UP);
  const mow=Math.floor(i/6)%2?1:.88,gc=[.34*mow,.52*mow,.23*mow];
  for(const sg of[-1,1]){
   const ds=[KERB,FLAT,28.7,35.3,EMB];
   for(let k=0;k<ds.length-1;k++){const d0=sg*ds[k],d1=sg*ds[k+1];
    const pa0=pt(a,d0,terr(d0,a.y)),pa1=pt(a,d1,terr(d1,a.y)),pb0=pt(b,d0,terr(d0,b.y)),pb1=pt(b,d1,terr(d1,b.y));
    C.grass.quad(pa0,pa1,pb1,pb0,gc,UP,[ds[k]/6,i/6],[ds[k+1]/6,i/6],[ds[k+1]/6,(i+1)/6],[ds[k]/6,(i+1)/6])}}}
 /* start + finish lines, finish gate */
 for(const [line,col] of[[LEAD+3,.9],[FIN,1]]){const a=frame(line),b=frame(line+1),C=chunks[Math.floor(Math.min(line,NS-1)/CH)];
  for(let q=0;q<12;q++)for(let r=0;r<2;r++){const d0=-HALF+q,d1=d0+1,f0=r/2,f1=(r+1)/2,y=a.y+.02,y2=lerp(a.y,b.y,1)+.02;
   const cc=(q+r)%2?[.08,.08,.08]:[.96,.96,.96];
   C.plain.quad(pt({x:lerp(a.x,b.x,f0),z:lerp(a.z,b.z,f0),rx:a.rx,rz:a.rz},d0,lerp(y,y2,f0)),pt({x:lerp(a.x,b.x,f0),z:lerp(a.z,b.z,f0),rx:a.rx,rz:a.rz},d1,lerp(y,y2,f0)),pt({x:lerp(a.x,b.x,f1),z:lerp(a.z,b.z,f1),rx:a.rx,rz:a.rz},d1,lerp(y,y2,f1)),pt({x:lerp(a.x,b.x,f1),z:lerp(a.z,b.z,f1),rx:a.rx,rz:a.rz},d0,lerp(y,y2,f1)),cc,UP)}}
 const gate=new MB(),banner=new MB();{const f=frame(FIN),H0=f.y,hh=H0+7.2;
  const post=(d)=>{const p=pt(f,d,0);const g=new MB();g.box(0,H0-.2,0,.7,7.4,.7,[.2,.2,.24]);place(gate,g,p[0],0,p[2],f.h,1)};
  post(-HALF-1.6);post(HALF+1.6);
  const L=pt(f,-HALF-1.6,0),R=pt(f,HALF+1.6,0),y0=H0+5.2,y1=H0+7.2,n=[f.fx,0,f.fz];
  banner.quad([L[0],y0,L[2]],[R[0],y0,R[2]],[R[0],y1,R[2]],[L[0],y1,L[2]],[1,1,1],n,[1,1],[0,1],[0,0],[1,0]);
  banner.quad([L[0],y0,L[2]],[L[0],y1,L[2]],[R[0],y1,R[2]],[R[0],y0,R[2]],[1,1,1],[-n[0],0,-n[2]],[0,0],[0,1],[1,1],[1,0])}
 /* houses first (so trees can avoid them), then trees, signs */
 const occ=[],ctrees=[],hiddenO=[];
 const free=(x,z,r)=>{for(const o of occ){const dx=o[0]-x,dz=o[1]-z;if(dx*dx+dz*dz<(o[2]+r)*(o[2]+r))return false}return true};
 let hi=0;
 for(let i=24;i<NS-TAIL_SAFE();i+=19+Math.floor(rnd(i)*7)){
  const side=(hi++%2)?1:-1,t=rnd(i*1.7),kind=t<.55?"a":t<.85?"b":"c",lat=kind==="a"?17+rnd(i+3)*1.5:kind==="b"?27:32;
  const f=sample(i+.5),d=side*lat,x=f.x+f.rx*d,z=f.z+f.rz*d;
  const g=houseGeo(kind,i),rad=Math.hypot(g.w,g.d)/2+1.5;
  if(roadDist(x,z)<lat-2||!free(x,z,rad))continue;
  const y=terr(d,f.y),yaw=side<0?f.h:f.h+Math.PI,C=chunks[Math.floor(i/CH)];
  /* house local base is at y=0 = terrain height; body extends below to hide the slope */
  place(C.plain,g.m,x,y,z,yaw,1);occ.push([x,z,rad])}
 /* collision trees (same list racer.js collides with) */
 for(let i0=0;i0<NS0;i0++){const i=i0+LEAD;for(const o of SEGS[i0].spr){
  const f=sample(i+.5);
  if(o.t==="tree"){const d=o.x*HALF,x=f.x+f.rx*d,z=f.z+f.rz*d,y=terr(d,f.y);
   if(roadDist(x,z)<Math.abs(d)-1.5||!free(x,z,1.6)){o.hit=1;o.hidden=1;hiddenO.push(o);continue}
   const kind=rnd(i*5.3+o.x)<.5?"pine":"round",sc=(.75+rnd(i*2.1)*.7)*(o.s||1)*.9;
   ctrees.push({o,i,kind,x,y,z,yaw:rnd(i*9.7)*6.28,sc,d})}
  else if(o.t==="sign"){const d=o.x*HALF*1.12,x=f.x+f.rx*d,z=f.z+f.rz*d,y=terr(d,f.y);
   if(roadDist(x,z)>=Math.abs(d)-1.5)place(chunks[Math.floor(i/CH)].plain,SIGN,x,y,z,f.h+(d<0?Math.PI/2:-Math.PI/2),1)}}}
 /* decorative forest: no collision, merged into the chunks */
 for(let i=2;i<NS;i+=3){for(const side of[-1,1]){
  const r=rnd(i*3.3+side*17);if(r<.25)continue;
  const lat=12+rnd(i*1.9+side)*30,d=side*lat,f=sample(i+rnd(i)*2),x=f.x+f.rx*d,z=f.z+f.rz*d;
  if(roadDist(x,z)<lat-1.5||!free(x,z,2.4))continue;
  const kind=rnd(i*4.1+side)<.55?"pine":"round",sc=.8+rnd(i*7.7+side)*.9,y=terr(d,f.y);
  place(chunks[Math.floor(i/CH)].plain,kind==="pine"?PINE:ROUND,x,y,z,rnd(i+side)*6.28,sc,.82+rnd(i*2.7)*.3);occ.push([x,z,1.8*sc])}}
 const lamps=[],LAMP=new MB();LAMP.box(0,0,0,.16,7.2,.16,[.2,.2,.24]);LAMP.box(0,7.15,0,.7,.12,.35,[.4,.4,.45]);
 for(let i=LEAD+8;i<NS-30;i+=26){const f=sample(i),C=chunks[Math.floor(i/CH)];for(const sd of[-1,1]){const d=sd*(KERB+2.3);place(C.plain,LAMP,f.x+f.rx*d,f.y,f.z+f.rz*d,0,1);lamps.push({i,x:f.x+f.rx*d,y:f.y+7.1,z:f.z+f.rz*d,pool:[f.x+f.rx*sd*3.2,f.y+.05,f.z+f.rz*sd*3.2]})}}
 /* huge ground + distant hills / city ring */
 const ground=new MB();{const s=7000,cx=0,cz=0;ground.quad([cx-s,G,cz-s],[cx+s,G,cz-s],[cx+s,G,cz+s],[cx-s,G,cz+s],[.3,.46,.21],[0,1,0],[-s/10,-s/10],[s/10,-s/10],[s/10,s/10],[-s/10,s/10])}
 const ring=new MB();{const N=64,R=1150,top=[.5,.58,.66],bot=[.62,.69,.76];
  for(let k=0;k<N;k++){const a0=k/N*6.2832,a1=(k+1)/N*6.2832,h=a=>60+45*Math.sin(a*3+1)+30*Math.sin(a*7+2)+18*Math.sin(a*13);
   const P=(a,y)=>[Math.cos(a)*R,y,Math.sin(a)*R];ring.quad(P(a0,-80),P(a1,-80),P(a1,h(a1)),P(a0,h(a0)),top,[0,1,0]);
   ring.tri(P(a0,-80),P(a1,-80),P(a1,-10),bot,[0,1,0]);}
  for(let k=0;k<70;k++){const a=rnd(k*3.7)*6.2832,r=640+rnd(k*5.1)*180,w=26+rnd(k*2.2)*34,h=40+rnd(k*8.8)*95,sh=.88+rnd(k)*.18;
   const c=[.47*sh,.53*sh,.6*sh],g=new MB();g.box(0,-30,0,w,h+30,w*(.7+rnd(k+1)*.5),[c[0],c[1],c[2]]);
   for(let q=0;q<g.a.length;q+=12){const ny=g.a[q+4],nx=Math.abs(g.a[q+3]);const f=ny>.5?1.12:nx>.5?.92:.84;g.a[q+6]*=f;g.a[q+7]*=f;g.a[q+8]*=f}
   place(ring,g,Math.cos(a)*r,0,Math.sin(a)*r,a,1)}}
 return{chunks,ctrees,hiddenO,gate,banner,ground,ring,lamps};
}
function TAIL_SAFE(){return 170}
/* ---------- the five cars (looks only: every car drives exactly the same so bets stay fair) ---------- */
const CARS=[
 {paint:[.62,.025,.04],stripe:[.95,.95,.95],wing:1,h:1,w:1},
 {paint:[.03,.2,.15],stripe:[.95,.78,.2],wing:0,h:.96,w:1.03},
 {paint:[.85,.3,.03],stripe:[.04,.04,.05],wing:2,h:1.03,w:.97},
 {paint:[.03,.03,.04],stripe:[.75,.75,.8],wing:0,h:1,w:1},
 {paint:[.62,.68,.78],stripe:[.1,.28,.8],wing:1,h:1.02,w:1}];
/* ---------- the car (modelled once, local coords: +z forward, +x left, y up) ---------- */
const cr=(a,b,c,d,t)=>.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t);
function crAt(arr,t){const n=arr.length,i=Math.floor(clamp(t,0,n-1.001)),f=t-i,g=k=>arr[clamp(k,0,n-1)];return cr(g(i-1),g(i),g(i+1),g(i+2),f)}
function loft(mb,st,N,col,exp,roofCol,glassCol,ringsPer){
 const S=st.length,Z=st.map(s=>s[0]),YB=st.map(s=>s[1]),YT=st.map(s=>s[2]),W=st.map(s=>s[3]);
 const rings=[];const R=(S-1)*ringsPer;
 for(let r=0;r<=R;r++){const t=r/R*(S-1),z=crAt(Z,t),yb=crAt(YB,t),yt=crAt(YT,t),w=Math.max(.02,crAt(W,t)),yc=(yb+yt)/2,hh=(yt-yb)/2,ring=[];
  for(let k=0;k<N;k++){const th=k/N*6.2832,c=Math.cos(th),s=Math.sin(th),px=Math.sign(c)*Math.pow(Math.abs(c),2/exp),py=Math.sign(s)*Math.pow(Math.abs(s),2/exp);ring.push([w*px,yc+hh*py,z])}
  rings.push(ring)}
 const nrm=[];for(let r=0;r<=R;r++){nrm.push(new Array(N));for(let k=0;k<N;k++)nrm[r][k]=[0,0,0]}
 const addN=(r,k,n)=>{const q=nrm[r][k];q[0]+=n[0];q[1]+=n[1];q[2]+=n[2]};
 for(let r=0;r<R;r++)for(let k=0;k<N;k++){const k2=(k+1)%N,A=rings[r][k],B=rings[r][k2],C=rings[r+1][k2],D=rings[r+1][k];
  const ux=B[0]-A[0],uy=B[1]-A[1],uz=B[2]-A[2],vx=D[0]-A[0],vy=D[1]-A[1],vz=D[2]-A[2];let n=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];
  const cx=(A[0]+B[0]+C[0]+D[0])/4,cy=(A[1]+B[1]+C[1]+D[1])/4;const ycen=(rings[r][0][1]+rings[r][N/2][1])/2;
  if(n[0]*(cx)+n[1]*(cy-ycen)<0)n=[-n[0],-n[1],-n[2]];
  addN(r,k,n);addN(r,k2,n);addN(r+1,k2,n);addN(r+1,k,n)}
 const colAt=(n,y)=>{if(!roofCol)return col;const f=clamp((n[1]-.35)/.4,0,1);return[lerp(glassCol[0],roofCol[0],f),lerp(glassCol[1],roofCol[1],f),lerp(glassCol[2],roofCol[2],f)]};
 const V=(r,k)=>{const n=nrm[r][k],l=Math.hypot(n[0],n[1],n[2])||1;return{p:rings[r][k],n:[n[0]/l,n[1]/l,n[2]/l]}};
 for(let r=0;r<R;r++)for(let k=0;k<N;k++){const k2=(k+1)%N,a=V(r,k),b=V(r,k2),c=V(r+1,k2),d=V(r+1,k);
  for(const t of[[a,b,c],[a,c,d]])for(const q of t)mb.vert(q.p,q.n,colAt(q.n))}
 /* end caps */
 for(const[r,s]of[[0,-1],[R,1]]){const cen=[0,0,0];for(const p of rings[r]){cen[0]+=p[0]/N;cen[1]+=p[1]/N;cen[2]+=p[2]/N}
  for(let k=0;k<N;k++){const k2=(k+1)%N;const n=[0,0,s];mb.vert(cen,n,col);mb.vert(rings[r][k],n,col);mb.vert(rings[r][k2],n,col)}}
 return{rings,Z,YB,YT,W,R,S}
}
function buildCar(v){
 const body=new MB(),paint=v.paint;
 const bst=[[-2.26,.4,.74,.86],[-2.2,.34,.88,.94],[-1.9,.29,.96,.99],[-1.2,.26,.99,1.0],[-.3,.25,.97,1.0],[.7,.26,.94,.99],[1.4,.29,.85,.97],[1.9,.31,.72,.92],[2.2,.34,.6,.78],[2.29,.4,.52,.5]];
 const B=loft(body,bst.map(q=>[q[0],q[1],q[2]*v.h,q[3]*v.w]),28,paint,3.4,null,null,5);
 const cst=[[-1.38,.9,1.02,.76],[-1.1,.9,1.26,.76],[-.6,.9,1.43,.77],[.1,.9,1.46,.77],[.62,.9,1.32,.75],[1.1,.9,1.02,.7]];
 const cab=new MB();const C=loft(cab,cst.map(q=>[q[0],q[1],q[2]*v.h,q[3]*v.w]),24,paint,3,paint,[.05,.07,.1],5);
 /* stripes */
 const stripes=new MB(),OR=v.stripe;
 const topY=(L,z,d,off)=>{const Zs=L.Z;let t=0;const n=Zs.length;for(let i=0;i<n-1;i++)if(z>=Zs[i]&&z<=Zs[i+1]){t=i+(z-Zs[i])/(Zs[i+1]-Zs[i]);break}
  const yb=crAt(L.YB,t),yt=crAt(L.YT,t),w=crAt(L.W,t),yc=(yb+yt)/2,hh=(yt-yb)/2,q=Math.min(1,Math.abs(d)/w);return yc+hh*Math.pow(Math.max(0,1-Math.pow(q,3.4)),1/3.4)+.006};
 const strip=(src,z0,z1,d0,d1,n,exp)=>{for(let i=0;i<n;i++){const za=lerp(z0,z1,i/n),zb=lerp(z0,z1,(i+1)/n);
   for(const s of[-1,1]){const e0=s*d0,e1=s*d1;stripes.quad([e0,topY(src,za,e0),za],[e1,topY(src,za,e1),za],[e1,topY(src,zb,e1),zb],[e0,topY(src,zb,e0),zb],OR,[0,1,0])}}};
 for(const dd of[[.1,.3],[.4,.6]]){strip(B,-2.1,-1.35,dd[0],dd[1],8);strip(B,1.35,2.1,dd[0],dd[1],8);strip(C,-.95,.75,dd[0],dd[1],14)}
 /* details: lights, diffuser, spoiler, exhaust, plate */
 const det=new MB();
 det.box(0,.3,-2.22,1.5,.16,.14,[.03,.03,.035]);                       /* diffuser */
 det.box(0,.99,-2.02,1.5,.035,.26,[.05,.05,.06]); /* lip spoiler */
 if(v.wing){const wy=1.08+v.wing*.06;det.box(0,wy,-2.1,1.95,.05,.42,[.02,.02,.025]);for(const q of[-1,1]){det.box(q*.62,.98,-2.08,.05,wy-.95,.3,[.02,.02,.025]);det.box(q*.98,wy-.06,-2.1,.04,.2,.44,[.02,.02,.025])}}
 for(const s of[-1,1]){det.cone(s*.55,.34,-2.36,.07,.2,10,[.7,.72,.75],[.5,.52,.55],.065)}
 const dg=new MB();for(const s of[-1,1]){const g=new MB();g.cone(0,0,0,.07,.2,10,[.7,.72,.75],[.5,.52,.55],.065)}
 /* exhaust tubes along z: rotate cone (built along y) so it points back */
 const ex=new MB();for(const s of[-1,1]){const g=new MB();g.cone(0,0,0,.06,.14,10,[.72,.74,.78],[.45,.47,.5],.055);
  for(let q=0;q<g.a.length;q+=12){const y=g.a[q+1],z=g.a[q+2];g.a[q+1]=z;g.a[q+2]=-y;const ny=g.a[q+4],nz=g.a[q+5];g.a[q+4]=nz;g.a[q+5]=-ny}
  place(ex,g,s*.56,.4,-2.2,0,.8)}
 const lights=new MB();
 for(const s of[-1,1])lights.box(s*.66,.7,-2.3,.46,.11,.05,[1,1,1]);
 lights.box(0,.72,-2.3,.82,.035,.05,[1,1,1]);
 const head=new MB();for(const s of[-1,1])head.box(s*.68,.6,2.3,.42,.09,.05,[1,.97,.85]);
 const plate=new MB();plate.quad([-.27,.45,-2.31],[-.27,.6,-2.31],[.27,.6,-2.31],[.27,.45,-2.31],[1,1,1],[0,0,-1],[1,1],[1,0],[0,0],[0,1]);
 /* wheels (axis along x) */
 const tire=new MB(),rim=new MB(),RT=.36,WT=.27;
 {const n=22;for(let i=0;i<n;i++){const a0=i/n*6.2832,a1=(i+1)/n*6.2832,c0=Math.cos(a0),s0=Math.sin(a0),c1=Math.cos(a1),s1=Math.sin(a1),tc=[.035,.035,.04];
   const q=(a,b,c)=>[a,b,c];
   tire.quad(q(-WT/2,s0*RT,c0*RT),q(WT/2,s0*RT,c0*RT),q(WT/2,s1*RT,c1*RT),q(-WT/2,s1*RT,c1*RT),tc,[0,s0+s1,c0+c1]);
   for(const sx of[-1,1])tire.quad(q(sx*WT/2,s0*.25,c0*.25),q(sx*WT/2,s0*RT,c0*RT),q(sx*WT/2,s1*RT,c1*RT),q(sx*WT/2,s1*.25,c1*.25),[.05,.05,.055],[sx,0,0])}
  for(const sx of[-1,1]){const x=sx*(WT/2+.004);
   rim.quad([x,-.01,-.01],[x,.01,-.01],[x,.01,.01],[x,-.01,.01],[.6,.62,.66],[sx,0,0]);
   for(let sp=0;sp<5;sp++){const a=sp/5*6.2832,aw=.34,r0=.05,r1=.25;
    const P=(r,aa)=>[x,Math.sin(aa)*r,Math.cos(aa)*r];rim.quad(P(r0,a-aw*.35),P(r1,a-aw*.5),P(r1,a+aw*.5),P(r0,a+aw*.35),[.74,.76,.8],[sx,0,0])}
   const n2=20;for(let i=0;i<n2;i++){const a0=i/n2*6.2832,a1=(i+1)/n2*6.2832,P=(r,aa)=>[x,Math.sin(aa)*r,Math.cos(aa)*r];
    rim.quad(P(.22,a0),P(.265,a0),P(.265,a1),P(.22,a1),[.8,.82,.86],[sx,0,0])}}}
 const shadow=new MB();shadow.quad([-1.5,.02,-2.9],[1.5,.02,-2.9],[1.5,.02,2.9],[-1.5,.02,2.9],[0,0,0,.55],[0,1,0],[0,0],[1,0],[1,1],[0,1]);
 return{body,cab,stripes,det,ex,lights,head,plate,tire,rim,shadow};
}
/* ---------- textures drawn on a canvas ---------- */
function cvs(w,h){const c=document.createElement("canvas");c.width=w;c.height=h;return c}
function roadTex(){const c=cvs(512,256),x=c.getContext("2d");x.fillStyle="#1f2027";x.fillRect(0,0,512,256);
 for(let i=0;i<9000;i++){const v=22+Math.random()*34|0;x.fillStyle="rgba("+v+","+v+","+(v+4)+","+(.25+Math.random()*.3)+")";x.fillRect(Math.random()*512,Math.random()*256,1+Math.random()*2,1+Math.random()*2)}
 for(let i=0;i<6;i++){x.fillStyle="rgba(20,20,22,.08)";x.fillRect(190+Math.random()*30,0,34+Math.random()*20,256)}
 x.fillStyle="#e8e8e8";x.fillRect(14,0,7,256);x.fillRect(491,0,7,256);x.fillStyle="#ececec";x.fillRect(253,0,6,128);return c}
function grassTex(){const c=cvs(128,128),x=c.getContext("2d");x.fillStyle="#6a8f4d";x.fillRect(0,0,128,128);
 for(let i=0;i<2600;i++){const g=100+Math.random()*80|0;x.fillStyle="rgba("+(g*.55|0)+","+g+","+(g*.4|0)+","+(.2+Math.random()*.4)+")";x.fillRect(Math.random()*128,Math.random()*128,1,2+Math.random()*3)}return c}
function plateTex(){const c=cvs(128,32),x=c.getContext("2d");x.fillStyle="#f3f3f0";x.fillRect(0,0,128,32);x.fillStyle="#1d3b8a";x.fillRect(0,0,12,32);x.fillStyle="#111";x.font="bold 20px sans-serif";x.textAlign="center";x.textBaseline="middle";x.fillText("VX 2026",70,17);return c}
function bannerTex(){const c=cvs(256,64),x=c.getContext("2d");for(let i=0;i<32;i++)for(let j=0;j<8;j++){x.fillStyle=(i+j)%2?"#111":"#fff";x.fillRect(i*8,j*8,8,8)}
 x.fillStyle="#2f6bff";x.fillRect(60,12,136,40);x.fillStyle="#fff";x.font="bold 30px sans-serif";x.textAlign="center";x.textBaseline="middle";x.fillText("FINISH",128,33);return c}
function shadowTex(){const c=cvs(64,64),x=c.getContext("2d"),g=x.createRadialGradient(32,32,2,32,32,32);g.addColorStop(0,"rgba(0,0,0,1)");g.addColorStop(.6,"rgba(0,0,0,.55)");g.addColorStop(1,"rgba(0,0,0,0)");x.fillStyle=g;x.fillRect(0,0,64,64);return c}
function glowTex(){const c=cvs(64,64),x=c.getContext("2d"),g=x.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,"rgba(255,255,255,1)");g.addColorStop(.25,"rgba(255,255,255,.45)");g.addColorStop(.6,"rgba(255,255,255,.1)");g.addColorStop(1,"rgba(255,255,255,0)");x.fillStyle=g;x.fillRect(0,0,64,64);return c}
function streakTex(){const c=cvs(32,128),x=c.getContext("2d"),g=x.createLinearGradient(0,0,0,128);g.addColorStop(0,"rgba(255,255,255,0)");g.addColorStop(1,"rgba(255,255,255,.9)");x.fillStyle=g;x.fillRect(0,0,32,128);x.globalCompositeOperation="destination-in";const h=x.createLinearGradient(0,0,32,0);h.addColorStop(0,"rgba(0,0,0,0)");h.addColorStop(.5,"rgba(0,0,0,1)");h.addColorStop(1,"rgba(0,0,0,0)");x.fillStyle=h;x.fillRect(0,0,32,128);return c}
/* ---------- shaders ---------- */
const VS="attribute vec3 p;attribute vec3 n;attribute vec4 c;attribute vec2 u;uniform mat4 vp;uniform mat4 md;uniform vec3 eye;varying vec3 vN;varying vec3 vP;varying vec4 vC;varying vec2 vU;varying float vD;"
 +"void main(){vec4 w=md*vec4(p,1.);vP=w.xyz;vN=mat3(md)*n;vC=c;vU=u;vD=0.;gl_Position=vp*w;}";
const FS="#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n"
 +"varying vec3 vN;varying vec3 vP;varying vec4 vC;varying vec2 vU;varying float vD;uniform sampler2D tx;uniform vec3 sunD,sunC,skyA,gndA,eye,fogC,mul,rf;uniform float fogD,unlit,spec,shin;"
 +"void main(){vec4 t=texture2D(tx,vU);vec3 b=vC.rgb*t.rgb*mul;vec3 col;if(unlit>.5){col=b;}else{vec3 n=normalize(vN);vec3 v=normalize(eye-vP);if(dot(n,v)<0.)n=-n;"
 +"float nd=max(dot(n,sunD),0.);vec3 amb=mix(gndA,skyA,n.y*.5+.5);col=b*(amb+sunC*nd);"
 +"if(spec>0.){vec3 h=normalize(sunD+v);col+=sunC*spec*pow(max(dot(n,h),0.),shin)*step(.0,nd);float fr=pow(1.-max(dot(n,v),0.),4.);col+=rf*spec*fr*(.35+.9*t.r);}}"
 +"float dd=length(vP-eye);float f=1.-exp(-fogD*fogD*dd*dd);col=mix(col,fogC,clamp(f,0.,1.));gl_FragColor=vec4(col,vC.a*t.a);}";
const SVS="attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,.9999,1.);}";
const SFS="precision mediump float;varying vec2 uv;uniform float hz,asp,yaw;"
 +"float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}"
 +"float nz(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}"
 +"float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*nz(p);p*=2.03;a*=.5;}return s;}"
 +"void main(){float t=clamp((uv.y-hz)/(1.-hz+.001),0.,1.);vec3 top=vec3(.05,.1,.3),mid=vec3(.34,.22,.5),hor=vec3(.95,.5,.52);"
 +"vec3 c=mix(hor,mid,smoothstep(0.,.35,t));c=mix(c,top,smoothstep(.25,1.,t));"
 +"vec2 p=vec2((uv.x-.5)*asp*1.7+yaw*1.3,t*2.4);float cl=fbm(p*vec2(1.3,2.4)+vec2(0.,1.7));float m=smoothstep(.4,.76,cl)*smoothstep(0.,.14,t);"
 +"c=mix(c,vec3(.3,.18,.4)+.32*vec3(.9,.45,.45)*cl*(1.-t*.6),m*.85);if(uv.y<hz)c=hor;gl_FragColor=vec4(c,1.);}";
/* ---------- create ---------- */
function create(canvas){
 const sim=SIM.create(document.createElement("canvas"));          /* physics only; its own 2D drawing is never used */
 const gl=canvas.getContext("webgl",{antialias:true,alpha:false,powerPreference:"high-performance"})||canvas.getContext("experimental-webgl");
 if(!gl)throw new Error("no webgl");
 if(!WORLD)WORLD=buildWorld();
 const sh=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s};
 const prog=(v,f,attrs)=>{const p=gl.createProgram();gl.attachShader(p,sh(gl.VERTEX_SHADER,v));gl.attachShader(p,sh(gl.FRAGMENT_SHADER,f));attrs.forEach((a,i)=>gl.bindAttribLocation(p,i,a));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));return p};
 const P=prog(VS,FS,["p","n","c","u"]),SP=prog(SVS,SFS,["p"]);
 const U={};["vp","md","eye","sunD","sunC","skyA","gndA","fogC","mul","fogD","unlit","spec","shin","tx","rf"].forEach(k=>U[k]=gl.getUniformLocation(P,k));
 const SU={hz:gl.getUniformLocation(SP,"hz"),asp:gl.getUniformLocation(SP,"asp"),yaw:gl.getUniformLocation(SP,"yaw")};
 const aniso=gl.getExtension("EXT_texture_filter_anisotropic")||gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
 const bufs=[],texs=[];
 const mk=(mb)=>{if(!mb||!mb.a.length)return null;const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(mb.a),gl.STATIC_DRAW);bufs.push(b);return{b,n:mb.a.length/12}};
 const tex=(c,rep)=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  if(c){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,c)}else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  if(c){gl.generateMipmap(gl.TEXTURE_2D);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR)}else gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);const w=rep?gl.REPEAT:gl.CLAMP_TO_EDGE;gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,w);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,w);
  if(aniso&&c)gl.texParameterf(gl.TEXTURE_2D,aniso.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(8,gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));texs.push(t);return t};
 const WHITE=tex(null,false),ROAD=tex(roadTex(),true),GRASS=tex(grassTex(),true),PLATE=tex(plateTex(),false),BANNER=tex(bannerTex(),false),SHAD=tex(shadowTex(),false),GLOW=tex(glowTex(),false),STREAK=tex(streakTex(),false);
 const gch=WORLD.chunks.map(c=>({road:mk(c.road),grass:mk(c.grass),plain:mk(c.plain)}));
 const gGround=mk(WORLD.ground),gRing=mk(WORLD.ring),gGate=mk(WORLD.gate),gBanner=mk(WORLD.banner);
 const gPine=mk(PINE),gRound=mk(ROUND);
 const gcs=CARS.map(v=>{const c=buildCar(v),o={};for(const k in c)o[k]=mk(c[k]);return o});
 const mq=new MB();mq.quad([-.5,-.5,0],[.5,-.5,0],[.5,.5,0],[-.5,.5,0],[1,1,1],[0,0,1],[0,1],[1,1],[1,0],[0,0]);const gQuad=mk(mq);
 const mf=new MB();mf.quad([-.5,0,-.5],[.5,0,-.5],[.5,0,.5],[-.5,0,.5],[1,1,1],[0,1,0],[0,0],[1,0],[1,1],[0,1]);const gFlat=mk(mf);
 const mfl=new MB();mfl.quad([-60,0,-60],[60,0,-60],[60,0,60],[-60,0,60],[.1,.1,.13],[0,1,0]);const gFloor=mk(mfl);
 gl.enableVertexAttribArray(0);gl.enableVertexAttribArray(1);gl.enableVertexAttribArray(2);gl.enableVertexAttribArray(3);
 const skyBuf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,skyBuf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);bufs.push(skyBuf);
 const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const state={mul:[1,1,1],unlit:0,spec:0,shin:20,fog:.0056};
 function draw(m,model,t,o){if(!m)return;o=o||{};gl.uniformMatrix4fv(U.md,false,new Float32Array(model||I));
  gl.uniform1f(U.unlit,o.unlit||0);gl.uniform1f(U.spec,o.spec||0);gl.uniform1f(U.shin,o.shin||20);gl.uniform3fv(U.mul,o.mul||[1,1,1]);gl.uniform1f(U.fogD,o.fog==null?state.fog:o.fog);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,t||WHITE);gl.bindBuffer(gl.ARRAY_BUFFER,m.b);
  gl.vertexAttribPointer(0,3,gl.FLOAT,false,48,0);gl.vertexAttribPointer(1,3,gl.FLOAT,false,48,12);gl.vertexAttribPointer(2,4,gl.FLOAT,false,48,24);gl.vertexAttribPointer(3,2,gl.FLOAT,false,48,40);gl.drawArrays(gl.TRIANGLES,0,m.n)}
 let W=0,H=0,dpr=1;
 function size(){dpr=Math.min(window.devicePixelRatio||1,2);const r=canvas.getBoundingClientRect();let w=Math.max(2,Math.round(r.width*dpr)),h=Math.max(2,Math.round(r.height*dpr));
  const lim=1250000;if(w*h>lim){const k=Math.sqrt(lim/(w*h));w=Math.round(w*k);h=Math.round(h*k)}W=w;H=h;canvas.width=W;canvas.height=H;gl.viewport(0,0,W,H)}
 /* camera state (smoothed) */
 const cam={x:0,y:0,z:0,h:0,init:false,lastT:0,steerV:0,carH:0,spin:0,shake:0};
 const falls=new Map();
 const GQ=[],FL=[];cam.me=0;cam.opp=null;cam.show=null;
 /* draws one car + queues its glow sprites (tail/head lights, road streaks, under-glow) */
 function drawCar(c,show){const car=mul(T4(c.px,c.py+(c.bump||0),c.pz),mul(RY(c.h),mul(RX(-(c.pitch||0)*.9),RZ(c.lean||0)))),g=c.g;
  draw(g.body,car,null,{spec:1.5,shin:48});draw(g.cab,car,null,{spec:1.7,shin:70});draw(g.stripes,car,null,{spec:.4,shin:30});draw(g.det,car,null,{spec:.3,shin:20});draw(g.ex,car,null,{spec:.8,shin:30});
  draw(g.lights,car,null,{unlit:1,mul:c.brake?[2.2,.3,.3]:[1.3,.1,.14]});draw(g.head,car,null,{unlit:1,mul:[1.4,1.35,1.1]});draw(g.plate,car,PLATE,{});
  for(const[wx,wz,front]of[[.93,1.38,1],[-.93,1.38,1],[.93,-1.32,0],[-.93,-1.32,0]]){const wm=mul(car,mul(T4(wx,.36,wz),mul(RY(front?c.sw||0:0),RX(-(c.spin||0)))));draw(g.tire,wm,null,{spec:.1,shin:8});draw(g.rim,wm,null,{spec:.9,shin:30})}
  const W3=(x,y,z)=>[car[0]*x+car[4]*y+car[8]*z+car[12],car[1]*x+car[5]*y+car[9]*z+car[13],car[2]*x+car[6]*y+car[10]*z+car[14]];
  const tc=c.brake?[1,.12,.1]:[.7,.05,.06];
  for(const q of[-1,1]){GQ.push({p:W3(q*.66,.72,-2.32),s:c.brake?3.4:2.1,c:tc,n:1});GQ.push({p:W3(q*.68,.62,2.32),s:2.6,c:[.9,.9,.8],n:1})}
  if(!show){const f=[Math.sin(c.h),Math.cos(c.h)];
   FL.push({p:[c.px-f[0]*6.6,c.py,c.pz-f[1]*6.6],h:c.h,w:2.4,l:9,t:STREAK,c:c.brake?[.9,.08,.08]:[.5,.04,.05]});
   FL.push({p:[c.px,c.py,c.pz],h:c.h,w:6,l:8,t:GLOW,c:[.05,.14,.55]})}
  else FL.push({p:[c.px,c.py,c.pz],h:0,w:11,l:11,t:GLOW,c:[.14,.2,.5]})}
 function flush(view,eye){gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
  const rr=[view[0],view[4],view[8]],uu=[view[1],view[5],view[9]];
  for(const q of FL)draw(gFlat,mul(T4(q.p[0],q.p[1]+.04,q.p[2]),mul(RY(q.h),S4(q.w,1,q.l))),q.t,{unlit:1,mul:q.c,fog:0});
  for(const q of GQ){let p=q.p;if(q.n){const dx=eye[0]-p[0],dy=eye[1]-p[1],dz=eye[2]-p[2],l=Math.hypot(dx,dy,dz)||1;p=[p[0]+dx/l*.4,p[1]+dy/l*.4,p[2]+dz/l*.4]}
   const k=q.s;draw(gQuad,[rr[0]*k,rr[1]*k,rr[2]*k,0,uu[0]*k,uu[1]*k,uu[2]*k,0,0,0,1,0,p[0],p[1],p[2],1],GLOW,{unlit:1,mul:q.c,fog:0})}
  gl.disable(gl.BLEND);gl.depthMask(true);GQ.length=0;FL.length=0}
 /* garage preview used by the car-select screen */
 function renderShow(){const sh=cam.show,a=sh.ang,d=sh.d||7.6,asp=W/H,eye=[Math.sin(a)*d,1.55,Math.cos(a)*d];
  const fovy=clamp(2*Math.atan(Math.tan(.5)/asp),.4,1.2),view=lookAt(eye,[0,.62,0],[0,1,0]),vp=mul(persp(fovy,asp,.3,300),view);
  gl.clearColor(.03,.03,.045,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.useProgram(P);
  gl.uniformMatrix4fv(U.vp,false,new Float32Array(vp));gl.uniform3fv(U.eye,eye);gl.uniform3fv(U.sunD,[.4,.75,.5]);gl.uniform3fv(U.sunC,[1,.95,1]);gl.uniform3fv(U.skyA,[.42,.44,.6]);gl.uniform3fv(U.gndA,[.12,.12,.16]);gl.uniform3fv(U.fogC,[.03,.03,.045]);gl.uniform3fv(U.rf,[.5,.5,.8]);gl.uniform1i(U.tx,0);
  state.fog=.045;draw(gFloor,null,null,{spec:1,shin:20});drawCar({g:gcs[sh.i],px:0,py:0,pz:0,h:0},1);flush(view,eye);state.fog=.0056}
 /* little track map for the HUD */
 function mapDraw(c,w,h,mePos,oppPos){
  if(!cam.mb){let a=1e9,b=-1e9,d=1e9,e=-1e9;for(let i=LEAD;i<=FIN;i+=3){a=Math.min(a,PX[i]);b=Math.max(b,PX[i]);d=Math.min(d,PZ[i]);e=Math.max(e,PZ[i])}cam.mb=[a,b,d,e]}
  const[a,b,d,e]=cam.mb,k=Math.min((w-24)/Math.max(1,b-a),(h-24)/Math.max(1,e-d)),ox=(w-(b-a)*k)/2,oy=(h-(e-d)*k)/2,X=i=>ox+(PX[i]-a)*k,Y=i=>h-(oy+(PZ[i]-d)*k);
  c.clearRect(0,0,w,h);c.lineWidth=4;c.lineJoin="round";c.strokeStyle="rgba(255,255,255,.85)";c.beginPath();for(let i=LEAD;i<=FIN;i+=3)i===LEAD?c.moveTo(X(i),Y(i)):c.lineTo(X(i),Y(i));c.stroke();
  const dot=(p,col)=>{const i=clamp(Math.round(p/200)+LEAD,LEAD,FIN);c.fillStyle=col;c.beginPath();c.arc(X(i),Y(i),6,0,7);c.fill()};
  if(oppPos!=null)dot(oppPos,"#3aa0ff");dot(mePos,"#ffd21a")}
 function render(){
  if(!W)size();const st=sim.st,now=performance.now();let dt=cam.lastT?(now-cam.lastT)/1000:.016;cam.lastT=now;dt=clamp(dt,.001,.1);
  if(cam.show){renderShow();return}
  const pct=st.speed/(200*60),s=st.pos/200+LEAD,fr=sample(s),lat=st.x*HALF;
  const px=fr.x+fr.rx*lat,py=fr.y,pz=fr.z+fr.rz*lat;
  cam.steerV+=(st.steer-cam.steerV)*(1-Math.exp(-dt*8));
  const wantH=fr.h-cam.steerV*.11*clamp(pct*1.6,0,1);
  if(!cam.init){cam.h=fr.h;cam.carH=wantH;cam.init=true}
  const dh=a=>{while(a>Math.PI)a-=6.2832;while(a<-Math.PI)a+=6.2832;return a};
  cam.carH+=dh(wantH-cam.carH)*(1-Math.exp(-dt*10));
  cam.h+=dh(fr.h-cam.h)*(1-Math.exp(-dt*3.2));
  const cf=[Math.sin(cam.h),Math.cos(cam.h)],DIST=6.4+pct*.9,HT=2.05+pct*.12;
  const tx=px-cf[0]*DIST,tz=pz-cf[1]*DIST,ty=py+HT;
  if(cam.x===0&&cam.z===0&&cam.y===0||!cam.ready){cam.x=tx;cam.y=ty;cam.z=tz;cam.ready=1}
  const kh=1-Math.exp(-dt*9),kv=1-Math.exp(-dt*5);cam.x+=(tx-cam.x)*kh;cam.z+=(tz-cam.z)*kh;cam.y+=(ty-cam.y)*kv;
  cam.shake=(st.crash>0?Math.sin(now*.09)*.12:0)+Math.sin(now*.031)*.012*pct;
  const eye=[cam.x,cam.y+cam.shake,cam.z];
  const look=[px+cf[0]*9,py+.6,pz+cf[1]*9];
  const asp=W/H,fovy=clamp(2*Math.atan(Math.tan(32*Math.PI/180)/asp),50*Math.PI/180,84*Math.PI/180)+pct*7*Math.PI/180;
  const view=lookAt(eye,look,[0,1,0]),proj=persp(fovy,asp,.3,2400),vp=mul(proj,view);
  gl.clearColor(FOGC[0],FOGC[1],FOGC[2],1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  /* sky */
  gl.disable(gl.DEPTH_TEST);gl.useProgram(SP);
  const fw=[eye[0]+Math.sin(cam.h)*4000,eye[1],eye[2]+Math.cos(cam.h)*4000,1];
  const hy=(vp[1]*fw[0]+vp[5]*fw[1]+vp[9]*fw[2]+vp[13])/(vp[3]*fw[0]+vp[7]*fw[1]+vp[11]*fw[2]+vp[15]);
  gl.uniform1f(SU.hz,clamp((hy+1)/2,-.5,1.2));gl.uniform1f(SU.asp,asp);gl.uniform1f(SU.yaw,cam.h);
  gl.bindBuffer(gl.ARRAY_BUFFER,skyBuf);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);gl.disableVertexAttribArray(1);gl.disableVertexAttribArray(2);gl.disableVertexAttribArray(3);gl.drawArrays(gl.TRIANGLES,0,3);
  gl.enableVertexAttribArray(1);gl.enableVertexAttribArray(2);gl.enableVertexAttribArray(3);
  /* world */
  gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.useProgram(P);
  gl.uniformMatrix4fv(U.vp,false,new Float32Array(vp));gl.uniform3fv(U.eye,eye);
  gl.uniform3fv(U.sunD,[.3,.7,-.5]);gl.uniform3fv(U.sunC,[.3,.28,.5]);gl.uniform3fv(U.skyA,[.3,.27,.5]);gl.uniform3fv(U.gndA,[.1,.09,.14]);gl.uniform3fv(U.fogC,FOGC);gl.uniform3fv(U.rf,[.95,.5,.62]);gl.uniform1i(U.tx,0);
  draw(gRing,T4(eye[0],0,eye[2]),null,{unlit:1,fog:0,mul:[.42,.32,.55]});
  draw(gGround,null,GRASS);
  const ci=Math.floor(s/CH);
  for(let c=Math.max(0,ci-1);c<=Math.min(gch.length-1,ci+3);c++){const g=gch[c];draw(g.road,null,ROAD,{spec:1.5,shin:30,mul:[1.5,1.5,1.7]});draw(g.grass,null,GRASS);draw(g.plain,null,null)}
  draw(gGate,null,null);draw(gBanner,null,BANNER,{unlit:0});
  /* collision trees (can be knocked over) */
  for(const t of WORLD.ctrees){if(t.i<s-30||t.i>s+330)continue;
   let m=mul(T4(t.x,t.y,t.z),mul(RY(t.yaw),S4(t.sc,t.sc,t.sc)));
   if(t.o.hit&&!t.o.hidden){let f=falls.get(t);if(!f){f={t0:now};falls.set(t,f)}const k=clamp((now-f.t0)/650,0,1),ease=1-Math.pow(1-k,3);
    const ang=Math.sign(t.d)*(ease*1.45);const fh=sample(t.i+.5).h;m=mul(T4(t.x,t.y,t.z),mul(RY(fh),mul(RZ(ang),mul(RY(t.yaw-fh),S4(t.sc,t.sc,t.sc)))))}
   draw(t.kind==="pine"?gPine:gRound,m,null)}
  /* cars (you + the opponent, same scene) */
  const pitch=Math.atan(fr.slope),lean=-cam.steerV*.045*clamp(pct*1.4,0,1)-(st.crash>0?Math.sin(now*.05)*.03:0);
  const bump=Math.sin(now*.045)*pct*.012+(st.crash>0?Math.sin(now*.08)*.04:0);
  cam.spin+=st.speed/200*dt/.36;
  const shd=[];
  drawCar({g:gcs[cam.me],px,py,pz,h:cam.carH,pitch,lean,bump,spin:cam.spin,sw:cam.steerV*.4,brake:st.brake});shd.push([px,py,pz,cam.carH]);
  const o=cam.opp;if(o){const of=sample(o.pos/200+LEAD),ol=o.x*HALF,ox=of.x+of.rx*ol,oz=of.z+of.rz*ol,oh=of.h-o.steer*.11*clamp(o.speed/12000*1.6,0,1);
   o.cs=(o.cs||0)+o.speed/200*dt/.36;drawCar({g:gcs[o.car||0],px:ox,py:of.y,pz:oz,h:oh,pitch:Math.atan(of.slope),lean:-o.steer*.045,spin:o.cs,sw:o.steer*.4,brake:o.brake});shd.push([ox,of.y,oz,oh])}
  for(const L of WORLD.lamps){if(L.i<s-8||L.i>s+150)continue;GQ.push({p:[L.x,L.y,L.z],s:3.4,c:[1,.78,.45]});FL.push({p:L.pool,h:0,w:15,l:15,t:GLOW,c:[.4,.28,.13]})}
  gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  for(const q of shd)draw(gcs[0].shadow,mul(T4(q[0],q[1],q[2]),RY(q[3])),SHAD,{unlit:1,fog:0});
  gl.disable(gl.BLEND);gl.depthMask(true);flush(view,eye);
 }
 /* the draw order puts the shadow last; it is a flat quad just above the road so it also sits under the car */
 function reset(lane){sim.reset();if(lane!=null)sim.st.x=lane;if(cam.opp)cam.opp.cs=0;cam.init=false;cam.ready=0;cam.spin=0;cam.steerV=0;falls.clear();WORLD.hiddenO.forEach(o=>{o.hit=1})}
 function dispose(){try{bufs.forEach(b=>gl.deleteBuffer(b));texs.forEach(t=>gl.deleteTexture(t));gl.deleteProgram(P);gl.deleteProgram(SP);const e=gl.getExtension("WEBGL_lose_context");e&&e.loseContext()}catch(_){}}
 reset();size();render();                                      /* test render: any GL/shader problem throws here and game.js falls back */
 const err=gl.getError();if(err&&err!==gl.NO_ERROR&&err!==gl.CONTEXT_LOST_WEBGL)console.warn("gl error",err);
 return{st:sim.st,showroom(i,ang,d){cam.show=i==null?null:{i,ang,d}},setMe(i){cam.me=i|0},setOpp(o){cam.opp=o},map:mapDraw,snap(){cam.init=false;cam.ready=0},size:()=>{size()},render,step:(dt,i)=>sim.step(dt,i),reset,dispose,kmh:()=>sim.kmh(),lap:()=>sim.lap(),laps:sim.laps,progress:()=>sim.progress()};
}
window.vxRacer3D={create};
})();
