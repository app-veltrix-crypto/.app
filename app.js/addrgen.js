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
 return {rows,unsupported:["TON","ADA","SUI","HBAR","DOT","BCH"]};
}
window.VeltrixAddr={deriveAll,_t:{b58,b58check,segwitV0,base32,crc16x,slip10,edPublic,B58,B58_XRP}};
})();
