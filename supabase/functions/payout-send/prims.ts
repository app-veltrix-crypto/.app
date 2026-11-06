// Veltrix · payout-send · the cryptographic building blocks chains.ts needs, taken from ethers (already used by index.ts).
import { ethers } from "https://esm.sh/ethers@6.13.4";
import type { Prims } from "./chains.ts";

const b = (x: string) => ethers.getBytes(x);
const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

export const prims: Prims = {
  sha256: (x) => b(ethers.sha256(x)),
  sha512: (x) => b(ethers.sha512(x)),
  ripemd160: (x) => b(ethers.ripemd160(x)),
  keccak256: (x) => b(ethers.keccak256(x)),
  hmacSha512: (k, d) => b(ethers.computeHmac("sha512", k, d)),
  seedFromPhrase: (phrase) => b(ethers.Mnemonic.fromPhrase(phrase).computeSeed()),
  secpPriv: (seed, path) => b(ethers.HDNodeWallet.fromSeed(seed).derivePath(path).privateKey),
  secpPub: (priv, compressed) => b(ethers.SigningKey.computePublicKey(priv, compressed)),
  secpSign: (priv, digest) => {
    const sig = new ethers.SigningKey(priv).sign(digest);
    let s = BigInt(sig.s), recid = sig.yParity;
    if (s > N / 2n) { s = N - s; recid ^= 1; }                       // canonical (low-S) — ethers already does this; kept as a guard
    return { r: BigInt(sig.r), s, recid };
  },
  edPub: async (seed32) => {
    const key = await crypto.subtle.importKey("pkcs8", pkcs8(seed32), { name: "Ed25519" }, true, ["sign"]);
    const x = (await crypto.subtle.exportKey("jwk", key)).x as string, s = x.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));
  },
  edSign: async (seed32, msg) => {
    const key = await crypto.subtle.importKey("pkcs8", pkcs8(seed32), { name: "Ed25519" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("Ed25519", key, msg));
  },
};

function pkcs8(seed: Uint8Array): Uint8Array {
  const head = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const o = new Uint8Array(head.length + 32); o.set(head); o.set(seed, head.length); return o;
}
