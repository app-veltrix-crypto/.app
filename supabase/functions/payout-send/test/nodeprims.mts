// Test-only crypto for chains.ts, built on Node's built-ins + a small BigInt secp256k1, so the code can be checked against published test vectors.
import crypto from "node:crypto";
import type { Prims } from "../chains.ts";

export const P_ = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N_ = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const mod = (a: bigint, m = P_) => ((a % m) + m) % m;
const inv = (a: bigint, m = P_) => { let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return mod(s0, m); };
type Pt = [bigint, bigint] | null;
const add = (a: Pt, b: Pt): Pt => {
  if (!a) return b; if (!b) return a;
  if (a[0] === b[0]) { if (mod(a[1] + b[1]) === 0n) return null; const l = mod(3n * a[0] * a[0] * inv(2n * a[1])); const x = mod(l * l - 2n * a[0]); return [x, mod(l * (a[0] - x) - a[1])]; }
  const l = mod((b[1] - a[1]) * inv(b[0] - a[0])); const x = mod(l * l - a[0] - b[0]); return [x, mod(l * (a[0] - x) - a[1])];
};
const mul = (k: bigint, p: Pt = [GX, GY]): Pt => { let r: Pt = null, q = p; while (k > 0n) { if (k & 1n) r = add(r, q); q = add(q, q); k >>= 1n; } return r; };
const big = (b: Uint8Array) => BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));
const bytes32 = (n: bigint) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
const ser = (p: Pt, compressed: boolean) => compressed ? Uint8Array.from([p![1] % 2n ? 3 : 2, ...bytes32(p![0])]) : Uint8Array.from([4, ...bytes32(p![0]), ...bytes32(p![1])]);

export function ecdsaVerify(pub: Uint8Array, digest: Uint8Array, r: bigint, s: bigint): boolean {
  let Q: Pt; if (pub[0] === 4) Q = [big(pub.slice(1, 33)), big(pub.slice(33))]; else { const x = big(pub.slice(1)); let y = modpow(mod(x ** 3n + 7n), (P_ + 1n) / 4n); if ((y % 2n === 1n) !== (pub[0] === 3)) y = P_ - y; Q = [x, y]; }
  const z = big(digest), w = inv(s, N_), R = add(mul(mod(z * w, N_)), mul(mod(r * w, N_), Q));
  return !!R && mod(R[0], N_) === r;
}
function modpow(b: bigint, e: bigint, m = P_) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }

// keccak-256 (not SHA3-256): used for TRON addresses
function keccak256(msg: Uint8Array): Uint8Array {
  const RC = [0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n];
  const R = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]], M = (1n << 64n) - 1n, rot = (x: bigint, n: number) => n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M : x;
  const rate = 136, padded = new Uint8Array(Math.ceil((msg.length + 1) / rate) * rate); padded.set(msg); padded[msg.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const A: bigint[][] = Array.from({ length: 5 }, () => new Array(5).fill(0n));
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) { let w = 0n; for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(padded[off + i * 8 + j]); A[i % 5][Math.floor(i / 5)] ^= w; }
    for (let r = 0; r < 24; r++) {
      const C = A.map((c) => c[0] ^ c[1] ^ c[2] ^ c[3] ^ c[4]), D = C.map((_, x) => C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
      const B: bigint[][] = Array.from({ length: 5 }, () => new Array(5).fill(0n));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rot(A[x][y], R[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ (~B[(x + 1) % 5][y] & M & B[(x + 2) % 5][y]);
      A[0][0] ^= RC[r];
    }
  }
  const out = new Uint8Array(32); for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((A[i][0] >> BigInt(8 * j)) & 0xffn);
  return out;
}

const h = (alg: string, b: Uint8Array) => new Uint8Array(crypto.createHash(alg).update(b).digest());
const pkcs8 = (seed: Uint8Array) => Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);

export const nodePrims: Prims = {
  sha256: (b) => h("sha256", b), sha512: (b) => h("sha512", b), ripemd160: (b) => h("ripemd160", b), keccak256,
  hmacSha512: (k, d) => new Uint8Array(crypto.createHmac("sha512", k).update(d).digest()),
  seedFromPhrase: (p) => new Uint8Array(crypto.pbkdf2Sync(p.normalize("NFKD"), "mnemonic", 2048, 64, "sha512")),
  secpPriv: (seed, path) => {
    const I = crypto.createHmac("sha512", "Bitcoin seed").update(seed).digest(); let k = big(I.subarray(0, 32)), c = I.subarray(32);
    for (const part of path.split("/").slice(1)) {
      const hard = part.endsWith("'"), i = (Number(part.replace("'", "")) + (hard ? 0x80000000 : 0)) >>> 0, idx = Buffer.alloc(4); idx.writeUInt32BE(i);
      const data = hard ? Buffer.concat([Buffer.from([0]), bytes32(k), idx]) : Buffer.concat([Buffer.from(ser(mul(k), true)), idx]);
      const J = crypto.createHmac("sha512", c).update(data).digest(); k = (big(J.subarray(0, 32)) + k) % N_; c = J.subarray(32);
    }
    return bytes32(k);
  },
  secpPub: (priv, compressed) => ser(mul(big(priv)), compressed),
  secpSign: (priv, digest) => {
    const d = big(priv), z = big(digest);
    for (;;) {
      const k = big(crypto.randomBytes(32)) % N_; if (!k) continue; const R = mul(k)!, r = mod(R[0], N_); if (!r) continue;
      let s = mod(inv(k, N_) * (z + r * d), N_), recid = Number(R[1] & 1n); if (!s) continue;
      if (s > N_ / 2n) { s = N_ - s; recid ^= 1; }
      return { r, s, recid };
    }
  },
  edPub: async (seed) => { const x = crypto.createPublicKey(crypto.createPrivateKey({ key: pkcs8(seed), format: "der", type: "pkcs8" })).export({ format: "jwk" }).x as string; return new Uint8Array(Buffer.from(x, "base64url")); },
  edSign: async (seed, msg) => new Uint8Array(crypto.sign(null, msg, crypto.createPrivateKey({ key: pkcs8(seed), format: "der", type: "pkcs8" }))),
};
