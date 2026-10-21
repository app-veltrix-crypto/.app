/* Veltrix deposit-address generator (TEST WALLET use).
   window.VeltrixAddr.deriveAll(phrase) -> {rows:[{symbol,network,address,derivation_path}], unsupported:[symbols]}
   Needs ethers v6 (UMD) for BIP39/BIP32 + hashing. Everything runs in the browser; the phrase is never sent anywhere. */
(function(){
"use strict";
const B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_XRP="rpshnaf39wBUDNEGHJKLMNPQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const BECH="qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const cat=(...a)=>{const o=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let p=0;for(const x of a){o.set(x,p);p+=x.length}return o};
const E=()=>window.ethers;
const u8=h=>E().getBytes(h);
const sha256=b=>u8(E().sha256(b)),rmd160=b=>u8(E().ripemd160(b)),keccak=b=>u8(E().keccak256(b));
const hash160=b=>rmd160(sha256(b));

function b58(bytes,alpha){let n=0n;for(const b of bytes)n=n*256n+BigInt(b);let s="";while(n>0n){s=alpha[Number(n%58n)]+s;n/=58n}for(const b of bytes){if(b)break;s=alpha[0]+s}return s}
function b58check(payload,alpha){return b58(cat(payload,sha256(sha256(payload)).slice(0,4)),alpha||B58)}

function convbits(data,from,to,pad){let acc=0,bits=0;const out=[],max=(1<<to)-1,maxAcc=(1<<(from+to-1))-1;
 for(const v of data){acc=((acc<<from)|v)&maxAcc;bits+=from;while(bits>=to){bits-=to;out.push((acc>>bits)&max)}}
 if(pad&&bits)out.push((acc<<(to-bits))&max);return out}
function polymod(v){const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let c=1;
 for(const x of v){const b=c>>>25;c=((c&0x1ffffff)<<5)^x;for(let i=0;i<5;i++)if((b>>i)&1)c^=G[i]}return c}
function segwitV0(hrp,prog){ // BIP173 bech32, witness version 0
 const d=[0,...convbits(prog,8,5,true)],hx=[];
 for(const ch of hrp)hx.push(ch.charCodeAt(0)>>5);hx.push(0);for(const ch of hrp)hx.push(ch.charCodeAt(0)&31);
 const pm=polymod([...hx,...d,0,0,0,0,0,0])^1,chk=[];for(let i=0;i<6;i++)chk.push((pm>>(5*(5-i)))&31);
 return hrp+"1"+[...d,...chk].map(x=>BECH[x]).join("")}

function base32(bytes){const A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let bits=0,v=0,s="";
 for(const b of bytes){v=(v<<8)|b;bits+=8;while(bits>=5){s+=A[(v>>>(bits-5))&31];bits-=5}v&=(1<<bits)-1}
 if(bits)s+=A[(v<<(5-bits))&31];return s}
function crc16x(b){let c=0;for(const x of b){c^=x<<8;for(let i=0;i<8;i++)c=(c&0x8000)?((c<<1)^0x1021):(c<<1);c&=0xffff}return c}

/* ed25519 (SLIP-0010, all-hardened path) via WebCrypto */
async function hmac512(key,data){const k=await crypto.subtle.importKey("raw",key,{name:"HMAC",hash:"SHA-512"},false,["sign"]);return new Uint8Array(await crypto.subtle.sign("HMAC",k,data))}
async function slip10(seed,path){let I=await hmac512(new TextEncoder().encode("ed25519 seed"),seed),k=I.slice(0,32),c=I.slice(32);
 for(const i of path){const d=new Uint8Array(37);d.set(k,1);new DataView(d.buffer).setUint32(33,(i|0x80000000)>>>0);I=await hmac512(c,d);k=I.slice(0,32);c=I.slice(32)}return k}
async function edPublic(priv){const pk8=cat(Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]),priv);
 const key=await crypto.subtle.importKey("pkcs8",pk8,{name:"Ed25519"},true,["sign"]),jwk=await crypto.subtle.exportKey("jwk",key);
 const s=jwk.x.replace(/-/g,"+").replace(/_/g,"/"),bin=atob(s+"=".repeat((4-s.length%4)%4));return Uint8Array.from(bin,c=>c.charCodeAt(0))}


/* ---------- BLAKE2b (RFC 7693), used by Cardano, Sui and Polkadot ---------- */
const M64=(1n<<64n)-1n;
const B2IV=[0x6a09e667f3bcc908n,0xbb67ae8584caa73bn,0x3c6ef372fe94f82bn,0xa54ff53a5f1d36f1n,0x510e527fade682d1n,0x9b05688c2b3e6c1fn,0x1f83d9abfb41bd6bn,0x5be0cd19137e2179n];
const B2S=[[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],[11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],[7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],[9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],[2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],[12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],[13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],[6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],[10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0]];
const rotr=(x,n)=>((x>>BigInt(n))|(x<<BigInt(64-n)))&M64;
function blake2b(input,outlen){
 const h=B2IV.slice();h[0]^=0x01010000n^BigInt(outlen);
 const blocks=Math.max(1,Math.ceil(input.length/128));
 for(let bi=0;bi<blocks;bi++){
  const last=bi===blocks-1,chunk=input.slice(bi*128,bi*128+128),blk=new Uint8Array(128);blk.set(chunk);
  const m=[];for(let i=0;i<16;i++){let w=0n;for(let j=7;j>=0;j--)w=(w<<8n)|BigInt(blk[i*8+j]);m.push(w)}
  const t=BigInt(last?input.length:(bi+1)*128);
  const v=h.concat(B2IV);v[12]^=t&M64;v[13]^=t>>64n;if(last)v[14]^=M64;
  const G=(a,b,c,d,x,y)=>{v[a]=(v[a]+v[b]+x)&M64;v[d]=rotr(v[d]^v[a],32);v[c]=(v[c]+v[d])&M64;v[b]=rotr(v[b]^v[c],24);
   v[a]=(v[a]+v[b]+y)&M64;v[d]=rotr(v[d]^v[a],16);v[c]=(v[c]+v[d])&M64;v[b]=rotr(v[b]^v[c],63)};
  for(let r=0;r<12;r++){const s=B2S[r%10];
   G(0,4,8,12,m[s[0]],m[s[1]]);G(1,5,9,13,m[s[2]],m[s[3]]);G(2,6,10,14,m[s[4]],m[s[5]]);G(3,7,11,15,m[s[6]],m[s[7]]);
   G(0,5,10,15,m[s[8]],m[s[9]]);G(1,6,11,12,m[s[10]],m[s[11]]);G(2,7,8,13,m[s[12]],m[s[13]]);G(3,4,9,14,m[s[14]],m[s[15]])}
  for(let i=0;i<8;i++)h[i]^=v[i]^v[i+8]}
 const out=new Uint8Array(64);for(let i=0;i<8;i++)for(let j=0;j<8;j++)out[i*8+j]=Number((h[i]>>BigInt(8*j))&0xffn);
 return out.slice(0,outlen)}

/* ---------- Ed25519 base-point multiplication (needed for Cardano's extended keys) ---------- */
const P25=(1n<<255n)-19n;
const mod=(a,m=P25)=>{const r=a%m;return r>=0n?r:r+m};
function powm(b,e,m=P25){let r=1n;b=mod(b,m);while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n}return r}
const inv=a=>powm(a,P25-2n);
const D25=mod(-121665n*inv(121666n));
function edAdd(p,q){const[x1,y1,z1,t1]=p,[x2,y2,z2,t2]=q;
 const A=mod((y1-x1)*(y2-x2)),B=mod((y1+x1)*(y2+x2)),C=mod(2n*D25*t1*t2),D=mod(2n*z1*z2);
 const E=B-A,F=D-C,G=D+C,H=B+A;return[mod(E*F),mod(G*H),mod(F*G),mod(E*H)]}
const GY=mod(4n*inv(5n));
function recoverX(y){const y2=y*y%P25,x2=mod((y2-1n)*inv(D25*y2+1n));let x=powm(x2,(P25+3n)/8n);
 if(mod(x*x-x2)!==0n)x=x*powm(2n,(P25-1n)/4n)%P25;if(x&1n)x=P25-x;return x}
const GX=recoverX(GY),BASE=[GX,GY,1n,mod(GX*GY)];
function edMulBase(k){let r=[0n,1n,1n,0n],q=BASE;while(k>0n){if(k&1n)r=edAdd(r,q);q=edAdd(q,q);k>>=1n}
 const zi=inv(r[2]),x=mod(r[0]*zi),y=mod(r[1]*zi),out=new Uint8Array(32);let v=y|((x&1n)<<255n);
 for(let i=0;i<32;i++){out[i]=Number(v&0xffn);v>>=8n}return out}
const leInt=b=>{let n=0n;for(let i=b.length-1;i>=0;i--)n=(n<<8n)|BigInt(b[i]);return n};
const leBytes=(n,len)=>{const o=new Uint8Array(len);for(let i=0;i<len;i++){o[i]=Number(n&0xffn);n>>=8n}return o};

/* ---------- Cardano (CIP-1852 / Icarus, BIP32-Ed25519 "V2" derivation) ---------- */
const hmacS=(k,d)=>u8(E().computeHmac("sha512",k,d));
const idxLE=i=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,i>>>0,true);return b};
function adaChild(k,idx){ // k = {l,r,c} (32 bytes each)
 const hard=idx>=0x80000000,ib=idxLE(idx);let Z,CC;
 if(hard){Z=hmacS(k.c,cat(Uint8Array.of(0),k.l,k.r,ib));CC=hmacS(k.c,cat(Uint8Array.of(1),k.l,k.r,ib))}
 else{const A=edMulBase(leInt(k.l));Z=hmacS(k.c,cat(Uint8Array.of(2),A,ib));CC=hmacS(k.c,cat(Uint8Array.of(3),A,ib))}
 const zl=leInt(Z.slice(0,28)),zr=leInt(Z.slice(32,64));
 return{l:leBytes(zl*8n+leInt(k.l),32),r:leBytes((zr+leInt(k.r))&((1n<<256n)-1n),32),c:CC.slice(32,64)}}
function adaMaster(entropyHex){const x=u8(E().pbkdf2("0x",entropyHex,4096,96,"sha512"));
 const l=x.slice(0,32);l[0]&=0xf8;l[31]&=0x1f;l[31]|=0x40;return{l,r:x.slice(32,64),c:x.slice(64,96)}}
function adaPub(path,master){let k=master;for(const i of path)k=adaChild(k,i);return edMulBase(leInt(k.l))}
function bech32(hrp,bytes){const d=convbits(bytes,8,5,true),hx=[];
 for(const ch of hrp)hx.push(ch.charCodeAt(0)>>5);hx.push(0);for(const ch of hrp)hx.push(ch.charCodeAt(0)&31);
 const pm=polymod([...hx,...d,0,0,0,0,0,0])^1,chk=[];for(let i=0;i<6;i++)chk.push((pm>>(5*(5-i)))&31);
 return hrp+"1"+[...d,...chk].map(x=>BECH[x]).join("")}
const H_=0x80000000;
function cardanoAddress(entropyHex){const m=adaMaster(entropyHex);
 const pay=adaPub([1852+H_,1815+H_,0+H_,0,0],m),stk=adaPub([1852+H_,1815+H_,0+H_,2,0],m);
 return bech32("addr",cat(Uint8Array.of(0x01),blake2b(pay,28),blake2b(stk,28)))}

/* ---------- Bitcoin Cash (CashAddr) ---------- */
function cashPoly(v){const G=[0x98f2bc8e61n,0x79b76d99e2n,0xf33e5fb3c4n,0xae2eabe2a8n,0x1e4f43e470n];let c=1n;
 for(const d of v){const c0=c>>35n;c=((c&0x07ffffffffn)<<5n)^BigInt(d);for(let i=0;i<5;i++)if((c0>>BigInt(i))&1n)c^=G[i]}return c^1n}
function cashaddr(h160){const pre="bitcoincash",data=convbits(cat(Uint8Array.of(0),h160),8,5,true);
 const pv=[...[...pre].map(ch=>ch.charCodeAt(0)&31),0,...data,0,0,0,0,0,0,0,0],cs=cashPoly(pv),chk=[];
 for(let i=0;i<8;i++)chk.push(Number((cs>>BigInt(5*(7-i)))&31n));
 return pre+":"+[...data,...chk].map(x=>BECH[x]).join("")}

/* ---------- TON (wallet v4r2, bounce-free "UQ…" address) ---------- */
const TON_CODE_HASH="feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0",TON_CODE_DEPTH=7;
function tonAddress(pub){const data=new Uint8Array(41);new DataView(data.buffer).setUint32(4,698983191);data.set(pub,8);data[40]=0x40;
 const dh=sha256(cat(Uint8Array.of(0,81),data)),ch=u8("0x"+TON_CODE_HASH),dep=Uint8Array.of(0,TON_CODE_DEPTH,0,0);
 const h=sha256(cat(Uint8Array.of(2,1,0x34),dep,ch,dh)),raw=cat(Uint8Array.of(0x51,0),h),c=crc16x(raw);
 return btoa(String.fromCharCode(...cat(raw,Uint8Array.of(c>>8,c&255)))).replace(/\+/g,"-").replace(/\//g,"_")}

async function deriveAll(phrase){
 const ethers=E();if(!ethers)throw new Error("Wallet library failed to load. Check your connection and refresh.");
 const clean=String(phrase||"").trim().toLowerCase().replace(/\s+/g," ");
 let m;try{m=ethers.Mnemonic.fromPhrase(clean)}catch{throw new Error("That is not a valid recovery phrase (check the words, spelling and word count).")}
 const seedHex=m.computeSeed(),root=ethers.HDNodeWallet.fromSeed(seedHex),seed=u8(seedHex);
 const pub=p=>u8(root.derivePath(p).publicKey);              // 33-byte compressed key
 const rows=[],add=(syms,network,address,path)=>syms.forEach(s=>rows.push({symbol:s,network,address,derivation_path:path}));
 let p;
 p="m/44'/60'/0'/0/0";const evm=root.derivePath(p).address;
 add(["ETH","USDT","USDC","SHIB","LINK"],"Ethereum (ERC-20)",evm,p);
 add(["BNB"],"BNB Smart Chain (BEP-20)",evm,p);
 add(["AVAX"],"Avalanche C-Chain",evm,p);
 p="m/84'/0'/0'/0/0";add(["BTC"],"Bitcoin (native SegWit, bc1…)",segwitV0("bc",hash160(pub(p))),p);
 p="m/84'/2'/0'/0/0";add(["LTC"],"Litecoin (native SegWit, ltc1…)",segwitV0("ltc",hash160(pub(p))),p);
 p="m/44'/3'/0'/0/0";add(["DOGE"],"Dogecoin",b58check(cat(Uint8Array.of(0x1e),hash160(pub(p)))),p);
 p="m/44'/144'/0'/0/0";add(["XRP"],"XRP Ledger",b58check(cat(Uint8Array.of(0x00),hash160(pub(p))),B58_XRP),p);
 p="m/44'/195'/0'/0/0";{const unc=u8(ethers.SigningKey.computePublicKey(pub(p),false)).slice(1);
  add(["TRX"],"TRON (TRC-20)",b58check(cat(Uint8Array.of(0x41),keccak(unc).slice(12))),p)}
 p="m/44'/501'/0'/0'";add(["SOL"],"Solana",b58(await edPublic(await slip10(seed,[44,501,0,0])),B58),p);
 p="m/44'/148'/0'";{const pk=await edPublic(await slip10(seed,[44,148,0])),pl=cat(Uint8Array.of(0x30),pk),c=crc16x(pl);
  add(["XLM"],"Stellar",base32(cat(pl,Uint8Array.of(c&255,c>>8))),p)}
 p="m/44'/145'/0'/0/0";add(["BCH"],"Bitcoin Cash (CashAddr)",cashaddr(hash160(pub(p))),p);
 p="m/1852'/1815'/0'/0/0";add(["ADA"],"Cardano (Shelley, addr1…)",cardanoAddress(m.entropy),p);
 p="m/44'/784'/0'/0'/0'";{const pk=await edPublic(await slip10(seed,[44,784,0,0,0]));
  add(["SUI"],"Sui","0x"+[...blake2b(cat(Uint8Array.of(0),pk),32)].map(x=>x.toString(16).padStart(2,"0")).join(""),p)}
 p="m/44'/354'/0'/0'/0'";{const pk=await edPublic(await slip10(seed,[44,354,0,0,0])),pre=cat(new TextEncoder().encode("SS58PRE"),Uint8Array.of(0),pk);
  add(["DOT"],"Polkadot (ed25519, SS58)",b58(cat(Uint8Array.of(0),pk,blake2b(pre,64).slice(0,2)),B58),p)}
 p="m/44'/607'/0'";add(["TON"],"TON (wallet v4r2)",tonAddress(await edPublic(await slip10(seed,[44,607,0]))),p);
 p="m/44'/3030'/0'/0/0";add(["HBAR"],"Hedera (EVM-alias address, 0x…)",root.derivePath(p).address,p);
 return {rows,unsupported:[]};
}
window.VeltrixAddr={deriveAll,_t:{blake2b,edMulBase,cardanoAddress,cashaddr,tonAddress,b58,b58check,segwitV0,base32,crc16x,slip10,edPublic,B58,B58_XRP}};
})();
