// Veltrix · payout-send · Bitcoin, Litecoin, Solana, XRP and TRON (the coins that are NOT on an Ethereum-style network).
// The treasury keys come from the SAME recovery phrase as the Ethereum treasury, with the same derivation paths the app uses for deposit addresses.
// Nothing in this file talks to a library that signs for us: the transaction formats are written out here so they can be read and tested
// (see test/chains.test.ts). All the money-safety rules live in core.ts; this file only has to answer three questions per coin:
//   prepare()   -> build + sign the transaction; throws ChainError("definite") if it can NEVER be sent, ("retry") if it cannot be sent right now
//   broadcast() -> hand it to the network; throws ChainError("definite") ONLY if the network explicitly refused it, anything else is "unclear"
//   receipt()   -> "success" (mined ok) | "failed" (mined as failed, or PROVABLY expired and can never be mined) | "none" (not yet)
import { ChainError, type MinedState, type Prepared, type Row } from "./core.ts";

export interface Prims {
  sha256(b: Uint8Array): Uint8Array;
  sha512(b: Uint8Array): Uint8Array;
  ripemd160(b: Uint8Array): Uint8Array;
  keccak256(b: Uint8Array): Uint8Array;
  hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array;
  seedFromPhrase(phrase: string): Uint8Array;                                   // BIP39 seed (64 bytes)
  secpPriv(seed: Uint8Array, path: string): Uint8Array;                         // BIP32 secp256k1 private key (32 bytes)
  secpPub(priv: Uint8Array, compressed: boolean): Uint8Array;
  secpSign(priv: Uint8Array, digest32: Uint8Array): { r: bigint; s: bigint; recid: number };   // must be canonical (low-S)
  edPub(seed32: Uint8Array): Promise<Uint8Array>;
  edSign(seed32: Uint8Array, msg: Uint8Array): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------------------------------- bytes + encodings
const te = new TextEncoder();
export const cat = (...a: Uint8Array[]): Uint8Array => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
export const le = (n: bigint | number, len: number) => { let v = BigInt(n); const o = new Uint8Array(len); for (let i = 0; i < len; i++) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
export const be = (n: bigint | number, len: number) => le(n, len).reverse();
const varint = (n: number) => n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? cat(Uint8Array.of(0xfd), le(n, 2)) : cat(Uint8Array.of(0xfe), le(n, 4));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const errText = (e: unknown) => String((e as Error)?.message || e).slice(0, 240);

export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const B58_XRP = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
export function b58enc(bytes: Uint8Array, alpha = B58): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = alpha[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = alpha[0] + s; }
  return s;
}
export function b58dec(str: string, alpha = B58): Uint8Array {
  let n = 0n; for (const ch of str) { const i = alpha.indexOf(ch); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  let z = 0; for (const ch of str) { if (ch === alpha[0]) z++; else break; }
  return Uint8Array.from([...new Array(z).fill(0), ...out]);
}

const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(v: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1;
  for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; }
  return c >>> 0;
}
const hrpExpand = (h: string) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0, bits = 0; const ret: number[] = [], maxv = (1 << to) - 1, maxAcc = (1 << (from + to - 1)) - 1;
  for (const v of data) { if (v < 0 || (v >> from) !== 0) return null; acc = ((acc << from) | v) & maxAcc; bits += from; while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); } }
  if (pad) { if (bits) ret.push((acc << (to - bits)) & maxv); } else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return ret;
}
export function segwitEncodeV0(hrp: string, prog: Uint8Array): string {
  const d = [0, ...convertBits([...prog], 8, 5, true)!], pm = polymod([...hrpExpand(hrp), ...d, 0, 0, 0, 0, 0, 0]) ^ 1;
  return hrp + "1" + [...d, ...[0, 1, 2, 3, 4, 5].map((i) => (pm >> (5 * (5 - i))) & 31)].map((x) => BECH[x]).join("");
}
/** BIP173 / BIP350 decoder. Returns the witness version and program, or null when the address is not valid for this hrp. */
export function segwitDecode(hrp: string, addr: string): { version: number; program: Uint8Array } | null {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const a = addr.toLowerCase(), pos = a.lastIndexOf("1");
  if (pos < 1 || pos + 7 > a.length || a.length > 90 || a.slice(0, pos) !== hrp) return null;
  const data: number[] = []; for (const ch of a.slice(pos + 1)) { const i = BECH.indexOf(ch); if (i < 0) return null; data.push(i); }
  const pm = polymod([...hrpExpand(hrp), ...data]), version = data[0];
  if (version > 16) return null;
  if (pm !== (version === 0 ? 1 : 0x2bc830a3)) return null;                 // v0 = bech32, v1+ = bech32m
  const prog = convertBits(data.slice(1, -6), 5, 8, false); if (!prog) return null;
  if (version === 0 && prog.length !== 20 && prog.length !== 32) return null;
  if (version === 1 && prog.length !== 32) return null;                       // taproot; other future versions are not supported
  if (version > 1) return null;
  return { version, program: Uint8Array.from(prog) };
}

/** exact decimal text -> integer units, no floating point; throws when there are more decimals than the coin has */
export function parseUnits(s: string, dec: number): bigint {
  const t = String(s).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("bad amount");
  const [i, f = ""] = t.split("."); if (f.length > dec) throw new Error("too many decimals");
  return BigInt(i + f.padEnd(dec, "0"));
}

// ---------------------------------------------------------------------------------------------------- http helpers
async function http(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> { return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); }
async function jget(url: string, init?: RequestInit): Promise<any> { const r = await http(url, init); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`); return await r.json(); }
async function jpost(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const r = await http(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`); return await r.json();
}
async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const r = await http(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) { const e: any = new Error(JSON.stringify(j.error).slice(0, 300)); e.rpc = j.error; throw e; } return j.result;
}

// ---------------------------------------------------------------------------------------------------- Bitcoin + Litecoin (native SegWit P2WPKH, BIP143)
const dsha = (P: Prims, b: Uint8Array) => P.sha256(P.sha256(b));
function derInt(x: bigint): Uint8Array { let h = x.toString(16); if (h.length % 2) h = "0" + h; let b: Uint8Array = unhex(h); if (b[0] & 0x80) b = cat(Uint8Array.of(0), b); return cat(Uint8Array.of(0x02, b.length), b); }
export const derSig = (r: bigint, s: bigint): Uint8Array => { const a = derInt(r), b = derInt(s); return cat(Uint8Array.of(0x30, a.length + b.length), a, b); };

export type Utxo = { txid: string; vout: number; value: bigint; sequence?: number };
export type TxOut = { script: Uint8Array; value: bigint };
export const p2wpkhScript = (h160: Uint8Array) => cat(Uint8Array.of(0x00, 0x14), h160);

/** script for a destination address, or throws (the address is checked here, including its checksum) */
export function scriptForAddress(sym: "BTC" | "LTC", addr: string, P: Prims): Uint8Array {
  const hrp = sym === "BTC" ? "bc" : "ltc";
  if (addr.toLowerCase().startsWith(hrp + "1")) {
    const d = segwitDecode(hrp, addr); if (!d) throw new Error("bad segwit address");
    return cat(Uint8Array.of(d.version === 0 ? 0x00 : 0x50 + d.version, d.program.length), d.program);
  }
  const raw = b58dec(addr); if (raw.length !== 25) throw new Error("bad length");
  const body = raw.slice(0, 21); if (!eq(dsha(P, body).slice(0, 4), raw.slice(21))) throw new Error("bad checksum");
  const v = body[0], h = body.slice(1);
  const p2pkh = sym === "BTC" ? 0x00 : 0x30, p2sh = sym === "BTC" ? [0x05] : [0x32, 0x05];
  if (v === p2pkh) return cat(Uint8Array.of(0x76, 0xa9, 0x14), h, Uint8Array.of(0x88, 0xac));
  if (p2sh.includes(v)) return cat(Uint8Array.of(0xa9, 0x14), h, Uint8Array.of(0x87));
  throw new Error("wrong network");
}

const DEFAULT_SEQ = 0xfffffffd;      // signals "replaceable", so a stuck payout could be fee-bumped by hand
const outpointOf = (u: Utxo) => cat(unhex(u.txid).reverse(), le(u.vout, 4));
const outBytesOf = (o: TxOut) => cat(le(o.value, 8), varint(o.script.length), o.script);
/** BIP143 signature hash of input `idx` (SIGHASH_ALL) for a P2WPKH output whose key hash is h160 */
export function bip143Digest(P: Prims, utxos: Utxo[], outs: TxOut[], idx: number, h160: Uint8Array, version = 2, locktime = 0): Uint8Array {
  const seq = (u: Utxo) => le(u.sequence ?? DEFAULT_SEQ, 4);
  const hashPrevouts = dsha(P, cat(...utxos.map(outpointOf))), hashSequence = dsha(P, cat(...utxos.map(seq))), hashOutputs = dsha(P, cat(...outs.map(outBytesOf)));
  const scriptCode = cat(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), h160, Uint8Array.of(0x88, 0xac)), u = utxos[idx];
  return dsha(P, cat(le(version, 4), hashPrevouts, hashSequence, outpointOf(u), scriptCode, le(u.value, 8), seq(u), hashOutputs, le(locktime, 4), le(1, 4)));
}
/** Builds and signs a transaction that spends P2WPKH outputs of one key. Returns the raw bytes and the transaction id. */
export function buildP2wpkh(P: Prims, priv: Uint8Array, utxos: Utxo[], outs: TxOut[]): { raw: Uint8Array; txid: string } {
  const pub = P.secpPub(priv, true), h160 = P.ripemd160(P.sha256(pub)), version = le(2, 4), locktime = le(0, 4);
  const witnesses = utxos.map((_, i) => {
    const { r, s } = P.secpSign(priv, bip143Digest(P, utxos, outs, i, h160)), sig = cat(derSig(r, s), Uint8Array.of(0x01));
    return cat(Uint8Array.of(0x02, sig.length), sig, Uint8Array.of(pub.length), pub);
  });
  const ins = cat(...utxos.map((u) => cat(outpointOf(u), Uint8Array.of(0x00), le(u.sequence ?? DEFAULT_SEQ, 4))));
  const core = cat(varint(utxos.length), ins, varint(outs.length), ...outs.map(outBytesOf));
  const raw = cat(version, Uint8Array.of(0x00, 0x01), core, ...witnesses, locktime);
  return { raw, txid: hex(dsha(P, cat(version, core, locktime)).reverse()) };
}

// ---------------------------------------------------------------------------------------------------- Solana (legacy message, System Program transfer)
export function solMessage(from: Uint8Array, to: Uint8Array, lamports: bigint, blockhash: Uint8Array): Uint8Array {
  const data = cat(le(2, 4), le(lamports, 8));                                             // SystemInstruction::Transfer
  return cat(Uint8Array.of(1, 0, 1), Uint8Array.of(3), from, to, new Uint8Array(32), blockhash,
    Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(2, 0, 1), Uint8Array.of(data.length), data);
}

// ---------------------------------------------------------------------------------------------------- XRP Ledger (Payment, binary format)
const xrpAmount = (drops: bigint) => be(0x4000000000000000n | drops, 8);
const vl = (b: Uint8Array) => { if (b.length > 192) throw new Error("too long"); return cat(Uint8Array.of(b.length), b); };
export function xrpSerialize(f: { sequence: number; tag?: number | null; lls: number; amount: bigint; fee: bigint; pub: Uint8Array; sig?: Uint8Array; account: Uint8Array; dest: Uint8Array }): Uint8Array {
  return cat(
    Uint8Array.of(0x12), be(0, 2),                                       // TransactionType = Payment
    Uint8Array.of(0x22), be(0x80000000, 4),                              // Flags = tfFullyCanonicalSig
    Uint8Array.of(0x24), be(f.sequence, 4),                              // Sequence
    ...(f.tag != null ? [Uint8Array.of(0x2e), be(f.tag, 4)] : []),       // DestinationTag
    Uint8Array.of(0x20, 0x1b), be(f.lls, 4),                             // LastLedgerSequence
    Uint8Array.of(0x61), xrpAmount(f.amount),                            // Amount
    Uint8Array.of(0x68), xrpAmount(f.fee),                               // Fee
    Uint8Array.of(0x73), vl(f.pub),                                      // SigningPubKey
    ...(f.sig ? [Uint8Array.of(0x74), vl(f.sig)] : []),                  // TxnSignature
    Uint8Array.of(0x81), vl(f.account),                                  // Account
    Uint8Array.of(0x83), vl(f.dest),                                     // Destination
  );
}
export function xrpSignAndHash(P: Prims, priv: Uint8Array, f: Parameters<typeof xrpSerialize>[0]): { blob: Uint8Array; hash: string } {
  const half = (b: Uint8Array) => P.sha512(b).slice(0, 32);
  const { r, s } = P.secpSign(priv, half(cat(Uint8Array.of(0x53, 0x54, 0x58, 0x00), xrpSerialize({ ...f, sig: undefined }))));
  const blob = xrpSerialize({ ...f, sig: derSig(r, s) });
  return { blob, hash: hex(half(cat(Uint8Array.of(0x54, 0x58, 0x4e, 0x00), blob))).toUpperCase() };
}
export function xrpAccountId(addr: string, P: Prims): Uint8Array {
  const raw = b58dec(addr, B58_XRP); if (raw.length !== 25 || raw[0] !== 0) throw new Error("bad XRP address");
  if (!eq(dsha(P, raw.slice(0, 21)).slice(0, 4), raw.slice(21))) throw new Error("bad checksum");
  return raw.slice(1, 21);
}

// ---------------------------------------------------------------------------------------------------- TRON (protobuf check of what the node built for us)
function pbRead(b: Uint8Array): Array<{ f: number; w: number; v: bigint | Uint8Array }> {
  const out: Array<{ f: number; w: number; v: bigint | Uint8Array }> = []; let i = 0;
  const vi = () => { let r = 0n, sh = 0n; for (;;) { if (i >= b.length) throw new Error("truncated"); const x = b[i++]; r |= BigInt(x & 0x7f) << sh; if (!(x & 0x80)) return r; sh += 7n; } };
  while (i < b.length) {
    const k = Number(vi()), f = k >> 3, w = k & 7;
    if (w === 0) out.push({ f, w, v: vi() });
    else if (w === 2) { const n = Number(vi()); if (i + n > b.length) throw new Error("truncated"); out.push({ f, w, v: b.slice(i, i + n) }); i += n; }
    else throw new Error("unexpected wire type");
  }
  return out;
}
/** Decodes a TRON raw_data and returns what it really does, so the caller can compare it with what was asked for. */
export function tronDecodeTransfer(rawHex: string): { type: number; owner: Uint8Array; to: Uint8Array; amount: bigint; expiration: bigint; contracts: number } {
  const top = pbRead(unhex(rawHex));
  const contracts = top.filter((x) => x.f === 11 && x.v instanceof Uint8Array);
  const exp = top.find((x) => x.f === 8 && x.w === 0);
  if (contracts.length !== 1 || !exp) throw new Error("unexpected transaction layout");
  const c = pbRead(contracts[0].v as Uint8Array), type = c.find((x) => x.f === 1), param = c.find((x) => x.f === 2 && x.v instanceof Uint8Array);
  if (!type || !param) throw new Error("no contract");
  const any = pbRead(param.v as Uint8Array), val = any.find((x) => x.f === 2 && x.v instanceof Uint8Array), url = any.find((x) => x.f === 1 && x.v instanceof Uint8Array);
  if (!val || !url || new TextDecoder().decode(url.v as Uint8Array) !== "type.googleapis.com/protocol.TransferContract") throw new Error("not a TRX transfer");
  const t = pbRead(val.v as Uint8Array), o = t.find((x) => x.f === 1), d = t.find((x) => x.f === 2), a = t.find((x) => x.f === 3);
  if (!o || !d || !a || !(o.v instanceof Uint8Array) || !(d.v instanceof Uint8Array) || typeof a.v !== "bigint") throw new Error("bad transfer");
  return { type: Number(type.v as bigint), owner: o.v, to: d.v, amount: a.v, expiration: exp.v as bigint, contracts: contracts.length };
}
export function tronAddressBytes(addr: string, P: Prims): Uint8Array {
  const raw = b58dec(addr); if (raw.length !== 25 || raw[0] !== 0x41) throw new Error("bad TRON address");
  if (!eq(dsha(P, raw.slice(0, 21)).slice(0, 4), raw.slice(21))) throw new Error("bad checksum");
  return raw.slice(0, 21);
}
const tronAddr = (b21: Uint8Array, P: Prims) => b58enc(cat(b21, dsha(P, b21).slice(0, 4)));

// ---------------------------------------------------------------------------------------------------- the treasury keys
export type Treasury = { BTC: Uint8Array; LTC: Uint8Array; XRP: Uint8Array; TRX: Uint8Array; SOL: Uint8Array };
export function treasuryKeys(P: Prims, phrase: string): Treasury {
  const seed = P.seedFromPhrase(phrase.trim().toLowerCase().replace(/\s+/g, " "));
  return { BTC: P.secpPriv(seed, "m/84'/0'/0'/0/0"), LTC: P.secpPriv(seed, "m/84'/2'/0'/0/0"), XRP: P.secpPriv(seed, "m/44'/144'/0'/0/0"), TRX: P.secpPriv(seed, "m/44'/195'/0'/0/0"), SOL: slip10(P, seed, [44, 501, 0, 0]) };
}
export function slip10(P: Prims, seed: Uint8Array, path: number[]): Uint8Array {
  let I = P.hmacSha512(te.encode("ed25519 seed"), seed), k = I.slice(0, 32), c = I.slice(32);
  for (const i of path) { I = P.hmacSha512(c, cat(Uint8Array.of(0), k, be((i | 0x80000000) >>> 0, 4))); k = I.slice(0, 32); c = I.slice(32); }
  return k;
}
export async function treasuryAddresses(P: Prims, phrase: string): Promise<Record<string, string>> {
  const k = treasuryKeys(P, phrase), h160 = (pub: Uint8Array) => P.ripemd160(P.sha256(pub));
  const xrpId = h160(P.secpPub(k.XRP, true));
  return {
    BTC: segwitEncodeV0("bc", h160(P.secpPub(k.BTC, true))),
    LTC: segwitEncodeV0("ltc", h160(P.secpPub(k.LTC, true))),
    XRP: b58enc(cat(Uint8Array.of(0), xrpId, dsha(P, cat(Uint8Array.of(0), xrpId)).slice(0, 4)), B58_XRP),
    TRX: tronAddr(cat(Uint8Array.of(0x41), P.keccak256(P.secpPub(k.TRX, false).slice(1)).slice(12)), P),
    SOL: b58enc(await P.edPub(k.SOL)),
  };
}

// ---------------------------------------------------------------------------------------------------- the five chains
export const OTHER_COINS = ["BTC", "LTC", "SOL", "XRP", "TRX"];
const DEC: Record<string, number> = { BTC: 8, LTC: 8, SOL: 9, XRP: 6, TRX: 6 };
const metaNum = (meta: string | null | undefined, key: string): number | null => { const m = new RegExp(key + "=(\\d+)").exec(meta || ""); return m ? Number(m[1]) : null; };

export function makeOtherChains(env: (k: string) => string, P: Prims) {
  const num = (k: string, d: number) => Number(env(k) || d);
  const API = {
    BTC: env("API_BTC") || "https://mempool.space/api", LTC: env("API_LTC") || "https://litecoinspace.org/api",
    SOL: env("RPC_SOL") || "https://api.mainnet-beta.solana.com", XRP: env("RPC_XRP") || "https://s1.ripple.com:51234",
    TRX: env("API_TRX") || "https://api.trongrid.io",
  };
  const tronHeaders: Record<string, string> = env("TRONGRID_API_KEY") ? { "TRON-PRO-API-KEY": env("TRONGRID_API_KEY") } : {};
  const phrase = () => { const p = env("TREASURY_MNEMONIC"); if (!p) throw new ChainError("retry", "Treasury is not configured"); return p; };
  let keys: Treasury | null = null;
  const K = () => keys ??= treasuryKeys(P, phrase());
  const amountOf = (row: Row): bigint => {
    let v: bigint; try { v = parseUnits(row.amount, DEC[row.symbol]); } catch { throw new ChainError("definite", "The amount has too many decimal places for this coin"); }
    if (v <= 0n) throw new ChainError("definite", "The amount is not valid"); return v;
  };

  // ---- BTC / LTC
  async function prepareUtxo(row: Row, sym: "BTC" | "LTC"): Promise<Prepared> {
    const value = amountOf(row), base = API[sym];
    let script: Uint8Array; try { script = scriptForAddress(sym, row.to_address, P); } catch { throw new ChainError("definite", "The wallet address is not valid for " + sym); }
    if (value < 546n) throw new ChainError("definite", "The amount is below the network's minimum");     // "dust": the network would refuse such an output
    const priv = K()[sym], h160 = P.ripemd160(P.sha256(P.secpPub(priv, true))), from = segwitEncodeV0(sym === "BTC" ? "bc" : "ltc", h160);
    // fee rate (sat/vB), never above the ceiling you set
    let rate = num("FEE_RATE_FIXED_" + sym, 0);
    if (!rate) {
      try { const f = await jget(base + "/v1/fees/recommended"); rate = Math.ceil(Number(f.halfHourFee)); if (!(rate >= 1)) throw new Error("bad fee"); }
      catch (e) { if (sym === "LTC") rate = 5; else throw new ChainError("retry", "Could not read the network fee: " + errText(e)); }
    }
    rate = Math.max(rate, 1);
    const ceiling = num("MAX_FEE_RATE_" + sym, sym === "BTC" ? 100 : 100);
    if (rate > ceiling) throw new ChainError("retry", `Network fees are above your ceiling (${ceiling} sat/vB); will retry`);
    // coins: confirmed outputs of the treasury only
    let all: any[]; try { all = await jget(`${base}/address/${from}/utxo`); } catch (e) { throw new ChainError("retry", "Could not read the treasury coins: " + errText(e)); }
    const utxos = all.filter((u) => u?.status?.confirmed && /^[0-9a-f]{64}$/.test(u.txid)).map((u) => ({ txid: u.txid as string, vout: Number(u.vout), value: BigInt(u.value) })).sort((a, b) => (a.value < b.value ? 1 : -1));
    const outSize = (s: Uint8Array) => 8 + 1 + s.length, change = p2wpkhScript(h160);
    const vsize = (nIn: number, withChange: boolean) => 11 + 69 * nIn + outSize(script) + (withChange ? outSize(change) : 0);
    const pick: Utxo[] = []; let sum = 0n, fee = 0n;
    for (const u of utxos) {
      if (pick.length >= 60) break;
      pick.push(u); sum += u.value; fee = BigInt(Math.ceil(vsize(pick.length, true) * rate));
      if (sum >= value + fee) break;
    }
    if (sum < value + fee) throw new ChainError("retry", `Treasury is short of ${sym} for the amount and fees; top it up`);
    const changeV = sum - value - fee, outs: TxOut[] = [{ script, value }];
    if (changeV >= 546n) outs.push({ script: change, value: changeV });      // smaller change is not worth an output: it goes to the miners
    let tx; try { tx = buildP2wpkh(P, priv, pick, outs); } catch (e) { throw new ChainError("retry", "Could not sign: " + errText(e)); }
    return { hash: tx.txid, raw: hex(tx.raw), symbol: sym };
  }
  async function broadcastUtxo(p: Prepared, sym: "BTC" | "LTC") {
    const base = API[sym];
    let r: Response;
    try { r = await http(base + "/tx", { method: "POST", headers: { "content-type": "text/plain" }, body: p.raw }, 20000); }
    catch (e) {
      // the request may or may not have arrived: look for the transaction before calling it unclear
      try { const g = await http(`${base}/tx/${p.hash}`, {}, 10000); if (g.ok) return; } catch (_) { /* fall through */ }
      throw new ChainError("unclear", errText(e));
    }
    if (r.ok) return;
    const t = (await r.text()).slice(0, 200);
    if (/already|known|in block chain|duplicate|txn-same/i.test(t)) return;
    if (r.status === 400) throw new ChainError("definite", "The network refused the transfer: " + t);
    try { const g = await http(`${base}/tx/${p.hash}`, {}, 10000); if (g.ok) return; } catch (_) { /* fall through */ }
    throw new ChainError("unclear", `${r.status} ${t}`);
  }
  async function receiptUtxo(hash: string, sym: "BTC" | "LTC"): Promise<MinedState> {
    const r = await http(`${API[sym]}/tx/${hash}/status`); if (r.status === 404) return "none";
    if (!r.ok) throw new Error("status " + r.status);
    return (await r.json()).confirmed ? "success" : "none";
  }

  // ---- SOL
  const solRent = 890880n;
  async function prepareSol(row: Row): Promise<Prepared> {
    const lamports = amountOf(row);
    let to: Uint8Array; try { to = b58dec(row.to_address); if (to.length !== 32) throw 0; } catch { throw new ChainError("definite", "The wallet address is not valid for SOL"); }
    const priv = K().SOL; let from: Uint8Array; try { from = await P.edPub(priv); } catch (e) { throw new ChainError("retry", "Could not derive the Solana key: " + errText(e)); }
    try {
      const bal = BigInt((await rpc(API.SOL, "getBalance", [b58enc(from), { commitment: "confirmed" }])).value);
      if (bal < lamports + 5000n + solRent) throw new ChainError("retry", "Treasury is short of SOL for the amount and fees; top it up");
      const dest = await rpc(API.SOL, "getAccountInfo", [row.to_address, { encoding: "base64", commitment: "confirmed" }]);
      if (!dest.value && lamports < solRent) throw new ChainError("definite", "The receiving Solana account is new; the first transfer must be at least 0.00089088 SOL");
    } catch (e) { if (e instanceof ChainError) throw e; throw new ChainError("retry", "Could not read the Solana network: " + errText(e)); }
    let bh: { blockhash: string; lastValidBlockHeight: number };
    try { bh = (await rpc(API.SOL, "getLatestBlockhash", [{ commitment: "confirmed" }])).value; } catch (e) { throw new ChainError("retry", "Could not read the Solana blockhash: " + errText(e)); }
    const msg = solMessage(from, to, lamports, b58dec(bh.blockhash));
    let sig: Uint8Array; try { sig = await P.edSign(priv, msg); } catch (e) { throw new ChainError("retry", "Could not sign: " + errText(e)); }
    return { hash: b58enc(sig), raw: btoa(String.fromCharCode(...cat(Uint8Array.of(1), sig, msg))), symbol: "SOL", meta: "lvbh=" + bh.lastValidBlockHeight };
  }
  async function broadcastSol(p: Prepared) {
    let sig: string;
    try { sig = await rpc(API.SOL, "sendTransaction", [p.raw, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]); }
    catch (e) {
      const code = (e as { rpc?: { code?: number } }).rpc?.code;
      if (code === -32002 || code === -32602) throw new ChainError("definite", "The network refused the transfer: " + errText(e));   // preflight failed: nothing was sent
      throw new ChainError("unclear", errText(e));
    }
    if (sig !== p.hash) throw new ChainError("unclear", "The network returned a different signature");
  }
  async function receiptSol(hash: string, meta?: string | null): Promise<MinedState> {
    const lvbh = metaNum(meta, "lvbh");
    const height = lvbh != null ? Number(await rpc(API.SOL, "getBlockHeight", [{ commitment: "finalized" }])) : 0;     // read BEFORE the status
    const v = (await rpc(API.SOL, "getSignatureStatuses", [[hash], { searchTransactionHistory: true }])).value?.[0];
    if (v) { if (v.err) return "failed"; return v.confirmationStatus === "finalized" ? "success" : "none"; }
    if (lvbh != null && height > lvbh) return "failed";                    // not found and its blockhash has expired for good: it can never be mined
    return "none";
  }

  // ---- XRP
  const xrp = (method: string, params: Record<string, unknown>) => rpc(API.XRP, method, [params]);
  async function prepareXrp(row: Row): Promise<Prepared> {
    const amount = amountOf(row); let dest: Uint8Array;
    try { dest = xrpAccountId(row.to_address, P); } catch { throw new ChainError("definite", "The wallet address is not valid for XRP"); }
    let tag: number | null = null;
    if (row.memo != null && String(row.memo) !== "") { if (!/^\d{1,10}$/.test(String(row.memo)) || Number(row.memo) > 4294967295) throw new ChainError("definite", "The destination tag is not valid"); tag = Number(row.memo); }
    const priv = K().XRP, pub = P.secpPub(priv, true), account = P.ripemd160(P.sha256(pub));
    const from = b58enc(cat(Uint8Array.of(0), account, dsha(P, cat(Uint8Array.of(0), account)).slice(0, 4)), B58_XRP);
    let sequence: number, balance: bigint, owners: number, resBase: bigint, resInc: bigint, feeDrops: bigint, ledger: number;
    try {
      const a = await xrp("account_info", { account: from, ledger_index: "current" });
      if (a.error === "actNotFound") throw new ChainError("retry", "The XRP treasury account is not activated; fund it first");
      if (!a.account_data) throw new Error(JSON.stringify(a).slice(0, 160));
      sequence = Number(a.account_data.Sequence); balance = BigInt(a.account_data.Balance); owners = Number(a.account_data.OwnerCount || 0);
      const si = await xrp("server_info", {}); const vl_ = si.info?.validated_ledger;
      if (!vl_) throw new Error("no validated ledger");
      resBase = BigInt(Math.round(Number(vl_.reserve_base_xrp) * 1e6)); resInc = BigInt(Math.round(Number(vl_.reserve_inc_xrp) * 1e6));
      const fe = await xrp("fee", {}); feeDrops = BigInt(Math.ceil(Number(fe.drops.open_ledger_fee) * 1.3)); ledger = Number(fe.ledger_current_index);
      if (!(ledger > 0) || feeDrops <= 0n) throw new Error("bad fee data");
      const d = await xrp("account_info", { account: row.to_address, ledger_index: "current" });
      if (d.error === "actNotFound" && amount < resBase) throw new ChainError("definite", `The receiving XRP account is new; the first payment must be at least ${Number(resBase) / 1e6} XRP`);
    } catch (e) { if (e instanceof ChainError) throw e; throw new ChainError("retry", "Could not read the XRP network: " + errText(e)); }
    const ceiling = BigInt(num("MAX_FEE_DROPS_XRP", 5000)); if (feeDrops > ceiling) throw new ChainError("retry", `Network fees are above your ceiling (${ceiling} drops); will retry`);
    if (balance < amount + feeDrops + resBase + resInc * BigInt(owners)) throw new ChainError("retry", "Treasury is short of XRP for the amount, fees and the account reserve; top it up");
    const lls = ledger + 40;
    const f = { sequence, tag, lls, amount, fee: feeDrops, pub, account, dest };
    let s; try { s = xrpSignAndHash(P, priv, f); } catch (e) { throw new ChainError("retry", "Could not sign: " + errText(e)); }
    return { hash: s.hash, raw: hex(s.blob).toUpperCase(), symbol: "XRP", meta: "lls=" + lls };
  }
  async function broadcastXrp(p: Prepared) {
    let r: any;
    try { r = await xrp("submit", { tx_blob: p.raw }); } catch (e) { throw new ChainError("unclear", errText(e)); }
    const code = String(r?.engine_result || "");
    if (/^(tes|ter|tec)/.test(code)) return;                               // applied / queued / will be claimed: the ledger decides
    if (/^(tem|tel)/.test(code)) throw new ChainError("definite", "The network refused the transfer: " + code);   // malformed / local refusal: never relayed
    throw new ChainError("unclear", code || "no engine result");           // tef..., or anything unknown
  }
  async function receiptXrp(hash: string, meta?: string | null): Promise<MinedState> {
    const lls = metaNum(meta, "lls");
    let validated = 0;
    if (lls != null) { const si = await xrp("server_info", {}); validated = Number(si.info?.validated_ledger?.seq || 0); }   // read BEFORE the lookup
    const t = await xrp("tx", { transaction: hash, binary: false });
    if (t.error === "txnNotFound") return lls != null && validated > lls ? "failed" : "none";   // expired and absent: it can never be applied
    if (t.error || !t.hash) throw new Error(String(t.error || "bad answer"));
    if (!t.validated) return "none";
    return t.meta?.TransactionResult === "tesSUCCESS" ? "success" : "failed";                     // a tec result moves no funds
  }

  // ---- TRX
  const trx = (path: string, body: unknown) => jpost(API.TRX + path, body, tronHeaders);
  async function prepareTrx(row: Row): Promise<Prepared> {
    const sun = amountOf(row); let to: Uint8Array;
    try { to = tronAddressBytes(row.to_address, P); } catch { throw new ChainError("definite", "The wallet address is not valid for TRX"); }
    const priv = K().TRX, owner = cat(Uint8Array.of(0x41), P.keccak256(P.secpPub(priv, false).slice(1)).slice(12)), from = tronAddr(owner, P);
    let tx: any;
    try {
      const acc = await trx("/wallet/getaccount", { address: from, visible: true });
      if (BigInt(acc.balance || 0) < sun + 3_000_000n) throw new ChainError("retry", "Treasury is short of TRX for the amount and fees; top it up");
      tx = await trx("/wallet/createtransaction", { owner_address: from, to_address: row.to_address, amount: Number(sun), visible: true });
    } catch (e) { if (e instanceof ChainError) throw e; throw new ChainError("retry", "Could not reach the TRON network: " + errText(e)); }
    if (!tx || tx.Error || !tx.txID || !tx.raw_data_hex) throw new ChainError("retry", "The TRON node did not build the transaction: " + String(tx?.Error || "").slice(0, 120));
    // never sign what a remote node built until it is proven to be exactly the transfer we asked for
    let d; try { d = tronDecodeTransfer(tx.raw_data_hex); } catch (e) { throw new ChainError("retry", "Unexpected transaction from the TRON node: " + errText(e)); }
    const idOk = hex(P.sha256(unhex(tx.raw_data_hex))) === String(tx.txID).toLowerCase();
    if (!idOk || d.type !== 1 || !eq(d.owner, owner) || !eq(d.to, to) || d.amount !== sun) throw new ChainError("retry", "The TRON node returned a different transaction than requested; not signed");
    const { r, s, recid } = P.secpSign(priv, unhex(tx.txID)), sig = hex(cat(be(r, 32), be(s, 32), Uint8Array.of(recid)));
    return { hash: String(tx.txID).toLowerCase(), raw: JSON.stringify({ ...tx, signature: [sig] }), symbol: "TRX", meta: "exp=" + d.expiration };
  }
  async function broadcastTrx(p: Prepared) {
    let r: any;
    try { r = await jpost(API.TRX + "/wallet/broadcasttransaction", JSON.parse(p.raw), tronHeaders); } catch (e) { throw new ChainError("unclear", errText(e)); }
    if (r?.result === true) return;
    const code = String(r?.code || "");
    if (code === "DUP_TRANSACTION_ERROR") return;
    if (/^(SIGERROR|BANDWITH_ERROR|TAPOS_ERROR|TOO_BIG_TRANSACTION_ERROR|TRANSACTION_EXPIRATION_ERROR|CONTRACT_VALIDATE_ERROR|CONTRACT_EXE_ERROR)$/.test(code))
      throw new ChainError("definite", "The network refused the transfer: " + code);
    throw new ChainError("unclear", code || "no answer");
  }
  async function receiptTrx(hash: string, meta?: string | null): Promise<MinedState> {
    const sol = await trx("/walletsolidity/gettransactioninfobyid", { value: hash });
    if (sol && sol.blockNumber) {
      const t = await trx("/walletsolidity/gettransactionbyid", { value: hash });
      return t?.ret?.[0]?.contractRet === "SUCCESS" ? "success" : "failed";
    }
    const full = await trx("/wallet/gettransactioninfobyid", { value: hash });
    if (full && full.blockNumber) return "none";                           // in a block, waiting to be solidified
    const exp = metaNum(meta, "exp");
    return exp != null && Date.now() > exp + 600_000 ? "failed" : "none";  // not in any block, and expired long ago: it can never be mined
  }

  return {
    handles: (sym: string) => OTHER_COINS.includes(String(sym).toUpperCase()),
    lane: (sym: string) => String(sym).toUpperCase(),
    waitMs: (sym: string) => ({ BTC: 0, LTC: 0, TRX: 0, SOL: 25000, XRP: 25000 } as Record<string, number>)[String(sym).toUpperCase()] ?? 0,
    async prepare(row: Row): Promise<Prepared> {
      const sym = String(row.symbol).toUpperCase();
      switch (sym) {
        case "BTC": case "LTC": return await prepareUtxo({ ...row, symbol: sym }, sym);
        case "SOL": return await prepareSol({ ...row, symbol: sym });
        case "XRP": return await prepareXrp({ ...row, symbol: sym });
        case "TRX": return await prepareTrx({ ...row, symbol: sym });
      }
      throw new ChainError("definite", "This coin can't be sent automatically");
    },
    async broadcast(p: Prepared) {
      switch (p.symbol) {
        case "BTC": case "LTC": return await broadcastUtxo(p, p.symbol);
        case "SOL": return await broadcastSol(p);
        case "XRP": return await broadcastXrp(p);
        case "TRX": return await broadcastTrx(p);
      }
      throw new ChainError("definite", "This coin can't be sent automatically");
    },
    async receipt(hash: string, symbol: string, meta?: string | null): Promise<MinedState> {
      switch (String(symbol).toUpperCase()) {
        case "BTC": return await receiptUtxo(hash, "BTC");
        case "LTC": return await receiptUtxo(hash, "LTC");
        case "SOL": return await receiptSol(hash, meta);
        case "XRP": return await receiptXrp(hash, meta);
        case "TRX": return await receiptTrx(hash, meta);
      }
      return "none";
    },
  };
}
