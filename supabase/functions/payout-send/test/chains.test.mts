// Run:  npx tsx test/chains.test.mts      (no network, no database needed)
import assert from "node:assert/strict";
import { nodePrims as P, ecdsaVerify } from "./nodeprims.mts";
import * as C from "../chains.ts";
import { ChainError, run, type Chain, type Db } from "../core.ts";
import { identityAnswer } from "./identity-fixtures.mts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.message || e)); process.exitCode = 1; });
const H = C.hex, U = C.unhex;

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

await ok("BIP173/350 addresses: encode + decode", () => {
  assert.equal(C.segwitEncodeV0("bc", U("751e76e8199196d454941c45d1b3a323f1433bd6")), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  const d = C.segwitDecode("bc", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")!; assert.equal(d.version, 0); assert.equal(H(d.program), "751e76e8199196d454941c45d1b3a323f1433bd6");
  const t = C.segwitDecode("bc", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0")!; assert.equal(t.version, 1); assert.equal(H(t.program), "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
  assert.equal(C.segwitDecode("bc", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd"), null);           // bech32 checksum on a v1 address
  assert.equal(C.segwitDecode("bc", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"), null);                                 // bad checksum
  assert.equal(C.segwitDecode("bc", "Bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3t4"), null);                                 // mixed case
  assert.equal(C.segwitDecode("ltc", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), null);                               // wrong network
});

await ok("legacy base58 addresses -> scripts (and checksum / network checks)", () => {
  assert.equal(H(C.scriptForAddress("BTC", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", P)), "76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac");
  assert.throws(() => C.scriptForAddress("BTC", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", P));       // one character changed
  assert.throws(() => C.scriptForAddress("LTC", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", P));       // a Bitcoin address is not a Litecoin address
  assert.equal(H(C.scriptForAddress("BTC", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", P)), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
  assert.equal(H(C.scriptForAddress("BTC", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", P)), "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
});

await ok("BIP143 native P2WPKH signature hash (official test vector)", () => {
  const rev = (h: string) => H(U(h).reverse());
  const utxos: C.Utxo[] = [
    { txid: rev("fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f"), vout: 0, value: 0n, sequence: 0xffffffee },
    { txid: rev("ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a"), vout: 1, value: 600000000n, sequence: 0xffffffff },
  ];
  const outs: C.TxOut[] = [
    { script: U("76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac"), value: 112340000n },
    { script: U("76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac"), value: 223450000n },
  ];
  assert.equal(H(C.bip143Digest(P, utxos, outs, 1, U("1d0f172a0ecb48aee1be1f2687d2963ae33f71a1"), 1, 17)), "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670");
});

await ok("treasury addresses for the standard test phrase match the published ones", async () => {
  const a = await C.treasuryAddresses(P, ABANDON);
  assert.equal(a.BTC, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");        // BIP84 test vector
  assert.equal(a.SOL, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");       // Phantom / Solana CLI default path
  console.log("      LTC", a.LTC, "\n      XRP", a.XRP, "\n      TRX", a.TRX);
});

await ok("SLIP-0010 ed25519 official vector", () => {
  const seed = U("000102030405060708090a0b0c0d0e0f");
  assert.equal(H(C.slip10(P, seed, [0])), "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
});

await ok("XRP: genesis account id round-trip + field order of the serialization", () => {
  assert.equal(H(C.xrpAccountId("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", P)), "b5f762798a53d543a014caf8b297cff8f2f937e8");   // contains a "4": catches the old alphabet typo
  const id = C.xrpAccountId("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", P); assert.equal(C.b58enc(C.cat(Uint8Array.of(0), id, P.sha256(P.sha256(C.cat(Uint8Array.of(0), id))).slice(0, 4)), C.B58_XRP), "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
  assert.throws(() => C.xrpAccountId("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi", P));
  const f = { sequence: 5, tag: 12345, lls: 99999999, amount: 1000000n, fee: 12n, pub: new Uint8Array(33).fill(2), account: new Uint8Array(20).fill(1), dest: new Uint8Array(20).fill(3) };
  const { blob, hash } = C.xrpSignAndHash(P, P.secpPriv(P.seedFromPhrase(ABANDON), "m/44'/144'/0'/0/0"), f);
  // read back the (type, field) headers and make sure they are strictly increasing, as the XRPL binary format requires
  let i = 0; const seen: number[] = [];
  const need = { 0x12: 2, 0x22: 4, 0x24: 4, 0x2e: 4, 0x20: 4, 0x61: 8, 0x68: 8 } as Record<number, number>;
  while (i < blob.length) {
    let t = blob[i] >> 4, fld = blob[i] & 15; i++; if (fld === 0) { fld = blob[i++]; }
    seen.push(t * 256 + fld);
    if (t === 7 || t === 8) { i += 1 + blob[i]; } else i += need[(t << 4) | (fld < 16 ? fld : 0)] ?? (t === 2 ? 4 : t === 6 ? 8 : 2);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), seen); assert.equal(seen.length, 11); assert.match(hash, /^[0-9A-F]{64}$/);
  assert.equal(C.xrpSerialize({ ...f }).length + 1 + 1 + 71 <= blob.length + 3, true);   // unsigned is shorter than signed by the signature field
});

await ok("TRON: the node's transaction is decoded and compared; a changed amount or recipient is caught", () => {
  const varint = (x: bigint) => { const o: number[] = []; while (x > 0x7fn) { o.push(Number(x & 0x7fn) | 0x80); x >>= 7n; } o.push(Number(x)); return Uint8Array.from(o); };
  const fld = (f: number, v: Uint8Array) => C.cat(varint(BigInt((f << 3) | 2)), varint(BigInt(v.length)), v), vf = (f: number, v: bigint) => C.cat(varint(BigInt(f << 3)), varint(v));
  const owner = C.cat(Uint8Array.of(0x41), new Uint8Array(20).fill(7)), to = C.cat(Uint8Array.of(0x41), new Uint8Array(20).fill(9));
  const transfer = C.cat(fld(1, owner), fld(2, to), vf(3, 1500000n));
  const any = C.cat(fld(1, new TextEncoder().encode("type.googleapis.com/protocol.TransferContract")), fld(2, transfer));
  const raw = C.cat(fld(1, Uint8Array.of(1, 2)), fld(4, new Uint8Array(8)), vf(8, 1700000060000n), fld(11, C.cat(vf(1, 1n), fld(2, any))), vf(14, 1700000000000n));
  const d = C.tronDecodeTransfer(H(raw)); assert.equal(d.amount, 1500000n); assert.equal(d.type, 1); assert.deepEqual(d.owner, owner); assert.deepEqual(d.to, to); assert.equal(d.expiration, 1700000060000n);
  assert.throws(() => C.tronDecodeTransfer(H(C.cat(raw, fld(11, new Uint8Array(0))))));       // two contracts: refused
  assert.throws(() => C.tronDecodeTransfer("0a02"));                                          // truncated
});

await ok("Solana message layout (3 keys, 1 transfer instruction, 12 bytes of data)", () => {
  const m = C.solMessage(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 1000000000n, new Uint8Array(32).fill(3));
  assert.equal(m.length, 3 + 1 + 96 + 32 + 1 + 1 + 3 + 1 + 12);
  assert.equal(H(m.slice(-12)), "0200000000ca9a3b00000000");               // transfer(2) + 1,000,000,000 lamports little-endian
  assert.equal(H(m.slice(0, 4)), "01000103");
});

await ok("Bitcoin: end-to-end prepare() with a fake network; the signed transaction verifies and the money adds up", async () => {
  const addrs = await C.treasuryAddresses(P, ABANDON);
  const realFetch = globalThis.fetch;
  const txidA = "aa".repeat(32), txidB = "bb".repeat(32);
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url), js = (o: unknown) => new Response(JSON.stringify(o), { status: 200 }), id = identityAnswer(u, init); if (id) return id;
    if (u.endsWith("/v1/fees/recommended")) return js({ halfHourFee: 12 });
    if (u.endsWith(`/address/${addrs.BTC}/utxo`)) return js([{ txid: txidA, vout: 1, value: 30000, status: { confirmed: true } }, { txid: txidB, vout: 0, value: 90000, status: { confirmed: true } }, { txid: "cc".repeat(32), vout: 0, value: 999999, status: { confirmed: false } }]);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  try {
    const chains = C.makeOtherChains((_k) => "", P);   // no treasury secret exists any more: the key comes from the sending user's row
    const p = await chains.prepare({ id: "x", user_id: "u", symbol: "BTC", amount: "0.00050000", to_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", payout_attempts: 1, phrase: ABANDON });
    const raw = U(p.raw); let i = 0; const rd = (k: number) => { const o = raw.slice(i, i + k); i += k; return o; };
    assert.equal(H(rd(4)), "02000000"); assert.equal(H(rd(2)), "0001");
    const nIn = rd(1)[0]; assert.equal(nIn, 1);                                           // the 90,000 output alone covers 50,000 + fee
    const ins: C.Utxo[] = []; for (let k = 0; k < nIn; k++) { const id = H(rd(32).reverse()), vout = new DataView(rd(4).buffer.slice(0)).getUint32(0, true); assert.equal(rd(1)[0], 0); const seq = new DataView(rd(4).buffer.slice(0)).getUint32(0, true); ins.push({ txid: id, vout, value: id === txidB ? 90000n : 30000n, sequence: seq }); }
    const nOut = rd(1)[0], outs: C.TxOut[] = []; for (let k = 0; k < nOut; k++) { const v = new DataView(rd(8).buffer.slice(0)).getBigUint64(0, true), l = rd(1)[0]; outs.push({ value: v, script: rd(l) }); }
    assert.equal(outs[0].value, 50000n); assert.equal(H(outs[0].script), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
    const sumIn = ins.reduce((a, x) => a + x.value, 0n), sumOut = outs.reduce((a, x) => a + x.value, 0n), fee = sumIn - sumOut;
    assert.ok(fee >= 12n * 141n && fee <= 12n * 200n, "fee " + fee);                      // ~141 vB * 12 sat/vB
    for (let k = 0; k < nIn; k++) {
      assert.equal(rd(1)[0], 2); const sl = rd(1)[0], sig = rd(sl), pl = rd(1)[0], pub = rd(pl);
      assert.equal(sig[sig.length - 1], 1); const rl = sig[3], r = BigInt("0x" + H(sig.slice(4, 4 + rl))), s = BigInt("0x" + H(sig.slice(6 + rl, 6 + rl + sig[5 + rl])));
      assert.ok(s <= C_N() / 2n, "low S");
      const h160 = P.ripemd160(P.sha256(pub)); assert.equal(C.segwitEncodeV0("bc", h160), addrs.BTC);
      assert.ok(ecdsaVerify(pub, C.bip143Digest(P, ins, outs, k, h160), r, s), "signature verifies");
    }
    assert.equal(H(rd(4)), "00000000"); assert.equal(i, raw.length);
    assert.match(p.hash, /^[0-9a-f]{64}$/);
    assert.equal(p.from, addrs.BTC);                                  // it spends from the SENDER's own address
    assert.equal(p.feeSymbol, "BTC"); assert.equal(Number(p.fee) * 1e8, Number(fee));   // and reports the fee it really pays
    // the unconfirmed 999,999-sat output was NOT used, and too-large / dust / bad requests are refused
    await assert.rejects(chains.prepare({ id: "x", user_id: "u", symbol: "BTC", amount: "5", to_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", payout_attempts: 1, phrase: ABANDON }), (e: ChainError) => e.kind === "definite" && /does not hold enough/.test(e.message));
    await assert.rejects(chains.prepare({ id: "x", user_id: "u", symbol: "BTC", amount: "0.000001", to_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", payout_attempts: 1, phrase: ABANDON }), (e: ChainError) => e.kind === "definite");
    await assert.rejects(chains.prepare({ id: "x", user_id: "u", symbol: "BTC", amount: "0.001", to_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", payout_attempts: 1, phrase: ABANDON }), (e: ChainError) => e.kind === "definite");
  } finally { globalThis.fetch = realFetch; }
});
function C_N() { return 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; }


await ok("NO TREASURY: each user signs with their own key, from their own address; no key = nothing is signed", async () => {
  const A = ABANDON, B = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const addrA = await C.treasuryAddresses(P, A), addrB = await C.treasuryAddresses(P, B);
  assert.notEqual(addrA.BTC, addrB.BTC);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url), js = (o: unknown) => new Response(JSON.stringify(o), { status: 200 }), id = identityAnswer(u, init); if (id) return id;
    if (u.endsWith("/v1/fees/recommended")) return js({ halfHourFee: 10 });
    if (u.endsWith("/utxo")) return js([{ txid: "dd".repeat(32), vout: 0, value: 200000, status: { confirmed: true } }]);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  try {
    const chains = C.makeOtherChains((_k) => "", P);
    const row = { id: "x", user_id: "u", symbol: "BTC", amount: "0.0005", to_address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", payout_attempts: 1 };
    assert.equal((await chains.prepare({ ...row, phrase: A })).from, addrA.BTC);
    assert.equal((await chains.prepare({ ...row, phrase: B })).from, addrB.BTC);
    await assert.rejects(chains.prepare(row), (e: ChainError) => e.kind === "retry" && /key is not available/.test(e.message));   // no phrase, no signature
    // an unconfirmed-only or empty wallet is refused BEFORE anything is signed or sent, and the user is told why
    globalThis.fetch = (async (url: string, init?: RequestInit) => identityAnswer(String(url), init) ?? (String(url).endsWith("/v1/fees/recommended") ? new Response(JSON.stringify({ halfHourFee: 10 }), { status: 200 }) : new Response("[]", { status: 200 }))) as typeof fetch;
    await assert.rejects(chains.prepare({ ...row, phrase: A }), (e: ChainError) => e.kind === "definite" && /does not hold enough BTC/.test(e.message));
  } finally { globalThis.fetch = realFetch; }
});

await ok("core: a slow chain (BTC) that is still waiting does not hold up other chains", async () => {
  const calls: string[] = [];
  const db: Db = { async rpc(name, a) {
    calls.push(name + ":" + (a.p_id ?? ""));
    if (name === "payout_release_stale") return 0;
    if (name === "payout_list_processing") return [{ id: "old", symbol: "BTC", tx_hash: "h", payout_meta: null, processing_at: new Date().toISOString(), created_at: new Date().toISOString() }];
    if (name === "payout_queue") return [{ id: "b2", symbol: "BTC" }, { id: "e1", symbol: "ETH" }, { id: "s1", symbol: "SOL" }];
    if (name === "payout_claim") return { id: a.p_id, symbol: String(a.p_id).startsWith("e") ? "ETH" : "SOL", amount: "1", to_address: "x", payout_attempts: 1 };
    if (name === "payout_set_hash") return true;
    return true;
  } };
  const chain: Chain = { lane: (s) => s, waitMs: () => 0, sleep: async () => {},
    prepare: async (r) => ({ hash: "h" + r.id, raw: "r", symbol: r.symbol }), broadcast: async () => {}, receipt: async (h) => (h === "h" ? "none" : "success") };
  const res = await run(db, chain, null, () => {});
  assert.deepEqual(res, { e1: "completed", s1: "completed" }); assert.ok(!calls.includes("payout_claim:b2"));
});

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : `\nall ${n} checks passed`);
