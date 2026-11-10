// Run:  node --experimental-strip-types --no-warnings supabase/functions/payout-send/test/network-identity.test.mts     (no network, no database, no money)
// PHASE 40 — the WITHDRAWAL SIGNER proves the network identity itself (BTC, LTC, SOL, XRP, TRX), before signing and again before broadcasting.
// OFFLINE ONLY: the endpoints are fakes shaped like the documented answers. This proves the signer REFUSES a wrong network in these fakes; it does not prove a real endpoint answers this way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nodePrims } from "./nodeprims.mts";
import * as C from "../chains.ts";
import { ChainError, processOne, type Db } from "../core.ts";
import { identityAnswer, type Wrong } from "./identity-fixtures.mts";
import { GENESIS } from "../../_shared/netcheck.ts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.message || e)); process.exitCode = 1; });
const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const COINS = ["BTC", "LTC", "SOL", "XRP", "TRX"] as const;
const BTC_TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", LTC_TO = "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9";
const TO: Record<string, string> = { BTC: BTC_TO, LTC: LTC_TO, SOL: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk", XRP: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", TRX: "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy" };
const row = (sym: string) => ({ id: "x", user_id: "u", symbol: sym, amount: "0.001", to_address: TO[sym], payout_attempts: 1, phrase: ABANDON });

/** counts what the signer touches, and answers identity probes (optionally wrong); every other request is logged and answered 404 */
function net(wrong: Wrong = {}, opts: { unreachable?: boolean } = {}) {
  const calls: string[] = [], real = globalThis.fetch, state = { wrong: { ...wrong } as Wrong };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url), body = init?.body ? String(init.body) : "", tag = (init?.method || "GET") + " " + u + (body ? " " + body.slice(0, 60) : "");
    calls.push(tag);
    if (opts.unreachable) throw new Error("connect ECONNREFUSED");
    const id = identityAnswer(u, init, state.wrong); if (id) return id;
    if (u.endsWith("/v1/fees/recommended")) return new Response(JSON.stringify({ halfHourFee: 10 }), { status: 200 });
    if (u.endsWith("/tx") && init?.method === "POST") return new Response("deadbeef", { status: 200 });
    if (u.endsWith("/wallet/broadcasttransaction")) return new Response(JSON.stringify({ result: true }), { status: 200 });
    if (body.includes('"sendTransaction"')) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "SIG" }), { status: 200 });
    if (body.includes('"submit"')) return new Response(JSON.stringify({ result: { engine_result: "tesSUCCESS" } }), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { calls, state, restore: () => { globalThis.fetch = real; } };
}
const SENDERS = /\/utxo$|getBalance|getAccountInfo|getLatestBlockhash|account_info|"fee"|\/wallet\/getaccount|\/wallet\/createtransaction|\/v1\/fees|\/tx\b|sendTransaction|"submit"|broadcasttransaction/;
const nonIdentity = (calls: string[]) => calls.filter((c) => SENDERS.test(c));
/** prims that count every key derivation / signature */
const spyPrims = () => { const k = { derive: 0, sign: 0 }; const P: C.Prims = { ...nodePrims, secpPriv: (s, p) => (k.derive++, nodePrims.secpPriv(s, p)), secpSign: (a, b) => (k.sign++, nodePrims.secpSign(a, b)), edSign: async (a, b) => (k.sign++, nodePrims.edSign(a, b)) }; return { P, k }; };

for (const sym of COINS) {
  await ok(`${sym}: a WRONG network behind the endpoint is refused BEFORE any coin is read, any key is derived or anything is signed`, async () => {
    const t = net({ [sym]: true } as Wrong), { P, k } = spyPrims();
    try {
      await assert.rejects(C.makeOtherChains((_k) => "", P).prepare(row(sym)), (e: ChainError) => e.kind === "retry" && /Network identity check failed; nothing was signed/.test(e.message) && /Wrong network/i.test(e.message));
      assert.deepEqual(nonIdentity(t.calls), [], "no balance / coin / fee / build call was made: " + t.calls.join(" | "));
      assert.equal(k.derive, 0, "no key was derived"); assert.equal(k.sign, 0, "nothing was signed");
    } finally { t.restore(); }
  });

  await ok(`${sym}: an UNREACHABLE endpoint cannot be verified, so nothing is signed (retry later)`, async () => {
    const t = net({}, { unreachable: true }), { P, k } = spyPrims();
    try {
      await assert.rejects(C.makeOtherChains((_k) => "", P).prepare(row(sym)), (e: ChainError) => e.kind === "retry" && /nothing was signed/.test(e.message) && /Could not/i.test(e.message));
      assert.equal(k.derive + k.sign, 0);
    } finally { t.restore(); }
  });

  await ok(`${sym}: the BROADCAST step re-checks the network and sends NOTHING when it is wrong (definite: the hold can be released)`, async () => {
    const t = net({ [sym]: true } as Wrong);
    try {
      const chains = C.makeOtherChains((_k) => "", nodePrims);
      await assert.rejects(chains.broadcast({ hash: "ab".repeat(32), raw: "00", symbol: sym }), (e: ChainError) => e.kind === "definite" && /nothing was sent/.test(e.message) && /Wrong network/i.test(e.message));
      assert.deepEqual(nonIdentity(t.calls), [], "no send call was made: " + t.calls.join(" | "));
    } finally { t.restore(); }
  });

  await ok(`${sym}: on the right network the identity probes run and the broadcast proceeds to the network`, async () => {
    const t = net();
    try {
      const chains = C.makeOtherChains((_k) => "", nodePrims);
      const hash = sym === "SOL" ? "SIG" : "ab".repeat(32);
      await chains.broadcast({ hash, raw: sym === "TRX" ? JSON.stringify({ txID: hash }) : "00", symbol: sym });
      assert.ok(t.calls.some((c) => /block-height\/0|getGenesisHash|server_info|getblockbynum/.test(c)), "an identity probe ran: " + t.calls.join(" | "));
      assert.ok(nonIdentity(t.calls).length > 0, "the broadcast request itself was made");
      const iProbe = t.calls.findIndex((c) => /block-height\/0|getGenesisHash|server_info|getblockbynum/.test(c)), iSend = t.calls.findIndex((c) => SENDERS.test(c));
      assert.ok(iProbe >= 0 && iProbe < iSend, "the probe came BEFORE the send");
    } finally { t.restore(); }
  });
}

await ok("the check is NOT cached: two sends in a row each prove the network again, and a network that turns wrong between them is caught", async () => {
  const t = net(); const chains = C.makeOtherChains((_k) => "", nodePrims);
  try {
    await chains.broadcast({ hash: "ab".repeat(32), raw: "00", symbol: "BTC" });
    const probes1 = t.calls.filter((c) => /block-height\/0/.test(c)).length; assert.equal(probes1, 1);
    await chains.broadcast({ hash: "cd".repeat(32), raw: "00", symbol: "BTC" });
    assert.equal(t.calls.filter((c) => /block-height\/0/.test(c)).length, 2);
    t.state.wrong = { BTC: true };
    await assert.rejects(chains.broadcast({ hash: "ef".repeat(32), raw: "00", symbol: "BTC" }), (e: ChainError) => e.kind === "definite");
  } finally { t.restore(); }
});

await ok("a Bitcoin API that serves LITECOIN (and vice versa) is refused: the two coins cannot be mixed up through a swapped endpoint", async () => {
  const t = net({ BTC: true, LTC: true }), { P } = spyPrims();
  try { for (const s of ["BTC", "LTC"]) await assert.rejects(C.makeOtherChains((_k) => "", P).prepare(row(s)), (e: ChainError) => e.kind === "retry" && /Wrong network/.test(e.message)); } finally { t.restore(); }
});

await ok("XRP: a TEST network id (1) is refused; a stale validated ledger is refused", async () => {
  const t = net({ XRP: true });
  try { await assert.rejects(C.makeOtherChains((_k) => "", nodePrims).prepare(row("XRP")), (e: ChainError) => /network id 1, expected 0/.test(e.message)); } finally { t.restore(); }
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => String(url).includes("s1.ripple.com") && String(init?.body).includes("server_info") ? new Response(JSON.stringify({ result: { info: { validated_ledger: { seq: 5, age: 7200 } } } }), { status: 200 }) : new Response("nope", { status: 404 })) as typeof fetch;
  try { await assert.rejects(C.makeOtherChains((_k) => "", nodePrims).prepare(row("XRP")), (e: ChainError) => e.kind === "retry" && /stale/.test(e.message)); } finally { globalThis.fetch = real; }
});

await ok("the expected network follows the GENESIS_* / NETWORK_ID_XRP secrets (a deliberate test-network run), and the mainnet value is then refused", async () => {
  const custom = "ff".repeat(32), real = globalThis.fetch;
  const mk = (g: string) => (async (url: string, init?: RequestInit) => { const u = String(url); if (u.endsWith("/block-height/0")) return new Response(g, { status: 200 }); if (u.endsWith("/blocks/tip/height")) return new Response("10", { status: 200 }); return new Response("nope", { status: 404 }); }) as typeof fetch;
  const chains = C.makeOtherChains((k) => (k === "GENESIS_BTC" ? custom : ""), nodePrims);
  try {
    globalThis.fetch = mk(custom);
    await assert.rejects(chains.prepare(row("BTC")), (e: ChainError) => !/identity/.test(e.message));          // identity passed; it then fails later for lack of coins/fees
    globalThis.fetch = mk(GENESIS.BTC);
    await assert.rejects(chains.prepare(row("BTC")), (e: ChainError) => /identity check failed/.test(e.message) && /Wrong network/.test(e.message));
  } finally { globalThis.fetch = real; }
});

await ok("end to end through core.processOne: the network turns wrong after signing -> NOTHING is broadcast, the hold is released, nothing is left 'unclear'", async () => {
  const t = net(), seen: string[] = [];
  const db: Db = { async rpc(name, a) {
    seen.push(name);
    if (name === "payout_claim") return row("BTC");
    if (name === "payout_set_hash") { t.state.wrong = { BTC: true }; return true; }                      // the endpoint is swapped right after the hash is stored
    return true;
  } };
  // a fee + coins answer so prepare() can complete
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url); const id = identityAnswer(u, init, t.state.wrong); if (id) return id;
    if (u.endsWith("/v1/fees/recommended")) return new Response(JSON.stringify({ halfHourFee: 10 }), { status: 200 });
    if (u.endsWith("/utxo")) return new Response(JSON.stringify([{ txid: "aa".repeat(32), vout: 0, value: 500000, status: { confirmed: true } }]), { status: 200 });
    t.calls.push("SEND " + u + " " + (init?.method || "GET")); return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const chain = { ...C.makeOtherChains((_k) => "", nodePrims), sleep: async () => {} } as any;
    const r = await processOne(db, chain, "x", () => {}, 0);
    assert.equal(r, "refunded"); assert.ok(seen.includes("payout_fail")); assert.ok(!seen.includes("payout_flag"), "not left as 'unclear'");
    assert.ok(!t.calls.some((c) => c.startsWith("SEND") && /\/tx$/.test(c)), "the transaction was never posted: " + t.calls.join(" | "));
  } finally { globalThis.fetch = real; t.restore(); }
});

await ok("source: the signer's single entry points check the network before they dispatch to any coin", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "chains.ts"), "utf8");
  const pi = src.indexOf('requireNetwork(sym, "sign")'), pk = src.indexOf("switch (sym)", pi), bi = src.indexOf('requireNetwork(p.symbol, "broadcast")'), bk = src.indexOf("switch (p.symbol)", bi);
  assert.ok(pi > 0 && pk > pi && bi > 0 && bk > bi, "requireNetwork precedes both switches");
  assert.ok(!/\bGENESIS\b[^;]*=\s*["']/.test(src), "no hard-coded genesis literal inside chains.ts: it uses the shared constants");
});

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : `\nall ${n} network-identity checks ran — passed`);
