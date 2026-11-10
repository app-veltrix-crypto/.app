// Run: node --experimental-strip-types deposit-watch/test/pagination.test.mts      (no network, no database)
// Fixtures are SYNTHETIC (shaped like the documented API answers). They prove the paging / checkpoint LOGIC, not that a provider pages this way:
// the real-chain steps in TESTING-REAL-MONEY.md do that.
import assert from "node:assert/strict";
import * as S from "../scan.ts";
import { baseCfg } from "./fakes.mts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.stack || e)); process.exitCode = 1; });
/** a progress store that behaves like scan_progress: updates are applied between runs */
const store = () => { const m = new Map<string, any>(); return { m, p: { get: async (k: string) => m.get(k) ?? null } as S.Progress, apply: (u: S.ProgressUpdate[]) => u.forEach((x) => m.set(x.key, x.state)) }; };
const A = "bc1qme";
const tx = (i: number) => ({ txid: "t" + String(i).padStart(4, "0"), status: { confirmed: true, block_height: 1000 + i, block_hash: "bh" + i, block_time: 1_700_000_000 + i * 600 }, vin: [{ prevout: { scriptpubkey_address: "bc1qsender" } }], vout: [{ scriptpubkey_address: A, value: 1000 + i }] });

// ---------------- BTC / LTC
function esplora(history: ReturnType<typeof tx>[], pageSize = 25, calls: string[] = []): S.Net {   // history oldest -> newest
  const newest = () => [...history].reverse();
  return { async get(u: string) {
    calls.push(u.replace("https://btc", ""));
    if (u.endsWith("/blocks/tip/height")) return 5000;
    if (/\/address\/[^/]+\/txs$/.test(u)) return newest().slice(0, pageSize);
    const m = /\/txs\/chain\/(.+)$/.exec(u); if (m) { const i = newest().findIndex((t) => t.txid === m[1]); return i < 0 ? [] : newest().slice(i + 1, i + 1 + pageSize); }
    throw new Error("unexpected " + u); }, async post() { throw 0; }, async rpc() { throw 0; } };
}
const hist = (k: number) => Array.from({ length: k }, (_, i) => tx(i + 1));
await ok("BTC: 90 deposits, page size 25 — the OLD first-page read saw 25; the sweep finds all 90 (4 pages in one run)", async () => {
  const st = store(), r = await S.scanUtxo(esplora(hist(90)), baseCfg(), "BTC", [{ address: A }], st.p);
  assert.equal(new Set(r.found.map((f) => f.hash)).size, 90); assert.equal(r.unfinished, 0); st.apply(r.updates);
  assert.equal(st.m.get("utxo:BTC:" + A).checkpoint, "t0090"); assert.equal(st.m.get("utxo:BTC:" + A).resumeAfter, null);
});
await ok("BTC: a sweep longer than one run's page budget is RESUMED, loses nothing, and moves the checkpoint only when complete", async () => {
  const cfg = { ...baseCfg(), maxPagesPerRun: 1 }, st = store(), seen = new Set<string>(); let runs = 0;
  for (; runs < 10; runs++) {
    const r = await S.scanUtxo(esplora(hist(90)), cfg, "BTC", [{ address: A }], st.p); r.found.forEach((f) => seen.add(f.hash)); st.apply(r.updates);
    if (st.m.get("utxo:BTC:" + A)?.resumeAfter == null && st.m.get("utxo:BTC:" + A)?.checkpoint) break;
    assert.equal(st.m.get("utxo:BTC:" + A).checkpoint, null, "checkpoint not advanced while the sweep is unfinished");
  }
  assert.equal(seen.size, 90); assert.ok(runs >= 3, "took several runs: " + runs);
});
await ok("BTC: afterwards a run costs ONE request when nothing is new; new deposits appear on page 1 and stop at the checkpoint", async () => {
  const h = hist(60), st = store(); st.apply((await S.scanUtxo(esplora(h), baseCfg(), "BTC", [{ address: A }], st.p)).updates);
  let calls: string[] = []; let r = await S.scanUtxo(esplora(h, 25, calls), baseCfg(), "BTC", [{ address: A }], st.p);
  assert.equal(calls.filter((c) => c.includes("/txs")).length, 1, calls.join()); assert.equal(r.updates.length, 0);
  const h2 = [...h, tx(61), tx(62)]; calls = []; r = await S.scanUtxo(esplora(h2, 25, calls), baseCfg(), "BTC", [{ address: A }], st.p);
  assert.deepEqual(r.found.filter((f) => ["t0061", "t0062"].includes(f.hash)).length, 2); assert.equal(calls.filter((c) => c.includes("/txs/chain/")).length, 0, "checkpoint is on page 1: no older page read");
});
await ok("BTC: MORE THAN 25 new deposits since the last run (e.g. after downtime) — nothing is dropped", async () => {
  const h = hist(30), st = store(); st.apply((await S.scanUtxo(esplora(h), baseCfg(), "BTC", [{ address: A }], st.p)).updates);
  const h2 = [...h, ...Array.from({ length: 40 }, (_, i) => tx(31 + i))]; const r = await S.scanUtxo(esplora(h2), baseCfg(), "BTC", [{ address: A }], st.p);
  assert.equal(new Set(r.found.filter((f) => +f.hash.slice(1) > 30).map((f) => f.hash)).size, 40);
});
await ok("BTC: pages stop once they are older than the wallet (an imported wallet with a huge history is not read for ever)", async () => {
  const calls: string[] = [], st = store(), since = 1_700_000_000 + 440 * 600;
  const r = await S.scanUtxo(esplora(hist(500), 25, calls), baseCfg(), "BTC", [{ address: A, since }], st.p);
  assert.ok(calls.filter((c) => c.includes("/txs/chain/")).length <= 3, "a few pages, not 20: " + calls.length); assert.equal(r.unfinished, 0); assert.ok(r.found.some((f) => f.hash === "t0500"));
});
await ok("BTC: one failing address does not hide the others (error reported, its progress untouched)", async () => {
  const net = esplora(hist(3)), real = net.get.bind(net); net.get = async (u: string) => { if (u.includes("/address/bad/")) throw new Error("500"); return real(u); };
  const st = store(), r = await S.scanUtxo(net, baseCfg(), "BTC", [{ address: "bad" }, { address: A }], st.p);
  assert.equal(r.found.length, 3); assert.ok(r.errors[0].includes("500")); assert.ok(!r.updates.some((u) => u.key.endsWith(":bad")));
});

// ---------------- SOLANA
const solSigs = (k: number) => Array.from({ length: k }, (_, i) => ({ signature: "s" + String(k - i).padStart(4, "0"), confirmationStatus: "finalized", err: null, blockTime: 1_700_000_000 + (k - i) * 10 }));   // newest first
const solTx = (sig: string) => ({ slot: 9, blockTime: 1_700_000_000, transaction: { message: { accountKeys: [{ pubkey: "Payer", signer: true }, { pubkey: "Me", signer: false }] } }, meta: { err: null, preBalances: [5e9, 0], postBalances: [4e9, 1e9] } });
function solNet(total: () => number, gets: string[] = []): S.Net {
  return { async get() { throw 0; }, async post() { throw 0; }, async rpc(_u, m, p: any[]) {
    if (m === "getTransaction") { gets.push(p[0]); return solTx(p[0]); }
    if (m !== "getSignaturesForAddress") throw new Error(m);
    const o = p[1], all = solSigs(total());
    if (o.commitment === "confirmed") return all.slice(0, 25).filter(() => false);      // nothing unfinalized in this fixture
    let from = 0; if (o.before) from = all.findIndex((s) => s.signature === o.before) + 1;
    let to = all.length; if (o.until) to = all.findIndex((s) => s.signature === o.until);
    return all.slice(from, to < 0 ? all.length : to).slice(0, o.limit); } };
}
await ok("SOL: 250 incoming transfers — the OLD limit-25 read saw 25; the finalized sweep (100 per page, 1 page per run) finds all 250 across runs and then idles", async () => {
  const cfg = { ...baseCfg(), maxPagesPerRun: 1 }, st = store(), seen = new Set<string>(); const none = async () => new Set<string>();
  for (let i = 0; i < 8; i++) { const r = await S.scanSol(solNet(() => 250), cfg, [{ address: "Me" }], st.p, none); r.found.forEach((f) => seen.add(f.hash)); st.apply(r.updates); }
  assert.equal(seen.size, 250); assert.equal(st.m.get("sol:Me").checkpoint, "s0250"); assert.equal(st.m.get("sol:Me").resumeBefore, null);
  const gets: string[] = [], r = await S.scanSol(solNet(() => 250, gets), cfg, [{ address: "Me" }], st.p, none); assert.equal(gets.length, 0, "nothing new: no getTransaction at all"); assert.equal(r.updates.length, 0);
});
await ok("SOL: 130 NEW transfers since the checkpoint are all found (until = checkpoint, paged with before)", async () => {
  const cfg = baseCfg(), st = store(), none = async () => new Set<string>(); let total = 40;
  st.apply((await S.scanSol(solNet(() => total), cfg, [{ address: "Me" }], st.p, none)).updates); total = 170;
  const r = await S.scanSol(solNet(() => total), cfg, [{ address: "Me" }], st.p, none); assert.equal(new Set(r.found.map((f) => f.hash)).size, 130);
});
await ok("SOL: signatures already recorded as final are not fetched again; failed transactions are skipped without a fetch", async () => {
  const st = store(), gets: string[] = [], sigs = solSigs(3); sigs[0].err = { x: 1 } as any;
  const net = solNet(() => 3, gets), real = net.rpc.bind(net); net.rpc = async (u, m, p: any[]) => (m === "getSignaturesForAddress" && p[1].commitment === "finalized" && !p[1].before ? sigs : real(u, m, p));
  await S.scanSol(net, baseCfg(), [{ address: "Me" }], st.p, async () => new Set(["s0002"])); assert.deepEqual(gets, ["s0001"]);
});

// ---------------- XRP
const xrpTx = (i: number) => ({ validated: true, ledger_index: 100 + i, meta: { delivered_amount: String(1_000_000 + i), TransactionResult: "tesSUCCESS" }, tx: { TransactionType: "Payment", Destination: "rMe", Account: "rS", hash: "h" + i, date: 700_000_000 + i } });
function xrpNet(total: () => number, calls: any[] = []): S.Net {
  return { async get() { throw 0; }, async post() { throw 0; }, async rpc(_u, m, p: any[]) {
    if (m !== "account_tx") throw new Error(m); const q = p[0]; calls.push(q); const all = Array.from({ length: total() }, (_, i) => xrpTx(total() - i));   // newest first
    const lo = q.ledger_index_min < 0 ? 0 : q.ledger_index_min, rows = all.filter((t) => t.ledger_index >= lo && (q.ledger_index_max < 0 || t.ledger_index <= q.ledger_index_max));
    const off = q.marker ? q.marker.off : 0, page = rows.slice(off, off + q.limit);
    return { ledger_index_max: 100 + total(), transactions: page, marker: off + q.limit < rows.length ? { off: off + q.limit } : undefined, validated: true }; } };
}
await ok("XRP: 230 payments, 100 per page, 1 page per run — resumed with the marker; all found; the checkpoint is the pinned ledger; later runs ask only for new ledgers", async () => {
  const cfg = { ...baseCfg(), maxPagesPerRun: 1 }, st = store(), seen = new Set<string>();
  for (let i = 0; i < 4; i++) { const r = await S.scanXrp(xrpNet(() => 230), cfg, [{ address: "rMe" }], st.p); r.found.forEach((f) => seen.add(f.hash)); st.apply(r.updates); }
  assert.equal(seen.size, 230); const s = st.m.get("xrp:rMe"); assert.equal(s.marker, null); assert.equal(s.checkpoint, 330);
  const calls: any[] = []; const r = await S.scanXrp(xrpNet(() => 232, calls), cfg, [{ address: "rMe" }], st.p);
  assert.equal(calls[0].ledger_index_min, 328, "only ledgers from checkpoint-2"); const got = new Set(r.found.map((f) => f.hash)); assert.ok(got.has("H231") && got.has("H232") && got.size <= 5, [...got].join());
});
await ok("XRP: an account that does not exist yet is not an error and stores nothing", async () => {
  const net: S.Net = { async get() { throw 0; }, async post() { throw 0; }, async rpc() { return { error: "actNotFound" }; } };
  const r = await S.scanXrp(net, baseCfg(), [{ address: "rNew" }], store().p); assert.deepEqual([r.found.length, r.updates.length, r.errors.length], [0, 0, 0]);
});

// ---------------- TRON
const trxTx = (i: number) => ({ txID: "x" + String(i).padStart(4, "0"), blockNumber: i, block_timestamp: 1_700_000_000_000 + i * 60_000, ret: [{ contractRet: "SUCCESS" }], raw_data: { contract: [{ type: "TransferContract", parameter: { value: { to_address: "TMe", owner_address: "TS", amount: 1_000_000 } } }] } });
function trxNet(total: () => number, urls: string[] = []): S.Net {
  return { async post() { throw 0; }, async rpc() { throw 0; }, async get(u: string) {
    urls.push(u); const q = new URL(u).searchParams, min = Number(q.get("min_timestamp") || 0), off = Number(q.get("fingerprint") || 0);
    const rows = Array.from({ length: total() }, (_, i) => trxTx(total() - i)).filter((t) => t.block_timestamp >= min), page = rows.slice(off, off + 200);
    return { success: true, data: page, meta: off + 200 < rows.length ? { fingerprint: String(off + 200) } : {} }; } };
}
await ok("TRX: 450 incoming transfers, 200 per page — the OLD limit-50 read saw 50; fingerprint paging finds all 450; the checkpoint then limits the query with min_timestamp", async () => {
  const st = store(), r = await S.scanTrx(trxNet(() => 450), { ...baseCfg(), maxPagesPerRun: 9 }, [{ address: "TMe" }], st.p);
  assert.equal(new Set(r.found.map((f) => f.hash)).size, 450); st.apply(r.updates);
  const urls: string[] = [], r2 = await S.scanTrx(trxNet(() => 452, urls), baseCfg(), [{ address: "TMe" }], st.p); assert.ok(urls[0].includes("min_timestamp="));
  assert.ok(r2.found.some((f) => f.hash === "x0452") && r2.found.length < 20, "only the recent window: " + r2.found.length);
});
await ok("TRX: a sweep cut short by the page budget resumes from its fingerprint", async () => {
  const cfg = { ...baseCfg(), maxPagesPerRun: 1 }, st = store(), seen = new Set<string>();
  for (let i = 0; i < 4; i++) { const r = await S.scanTrx(trxNet(() => 450), cfg, [{ address: "TMe" }], st.p); r.found.forEach((f) => seen.add(f.hash)); st.apply(r.updates); }
  assert.equal(seen.size, 450); assert.equal(st.m.get("trx:TMe").fingerprint, null);
});

// ---------------- EVM log queries
await ok("ERC-20: a provider 'too many results' error splits the block range instead of losing logs; address lists are sent in batches of 100", async () => {
  const seenCalls: any[] = [], pad = (a: string) => "0x" + a.slice(2).padStart(64, "0"), ME = "0x" + "11".repeat(20);
  const mk = (bn: number) => ({ address: baseCfg().tokens.USDT.address, topics: [S.TRANSFER_TOPIC, pad("0x" + "22".repeat(20)), pad(ME)], data: "0x" + (1_000_000).toString(16).padStart(64, "0"), blockNumber: "0x" + bn.toString(16), blockHash: "0xb" + bn, transactionHash: "0xth" + bn, logIndex: "0x0" });
  const net: S.Net = { async get() { throw 0; }, async post() { throw 0; }, async rpc(_u, m, p: any[]) {
    if (m === "eth_blockNumber") return "0x64"; if (m === "eth_getBlockByNumber") return { hash: "0xb" + Number(BigInt(p[0])), timestamp: "0x65000000" };
    seenCalls.push(p[0]); const f = Number(BigInt(p[0].fromBlock)), t = Number(BigInt(p[0].toBlock)); if (p[0].address.toLowerCase() !== baseCfg().tokens.USDT.address.toLowerCase()) return [];
    if (t - f > 10) throw new Error('{"message":"query returned more than 10000 results, reduce the block range"}'); return [mk(f), mk(t)].filter((l, i, a) => a.findIndex((x) => x.blockNumber === l.blockNumber) === i); } };
  const r = await S.scanErc20(net, { ...baseCfg(), maxBlocksPerRun: 40 }, [ME], 80); assert.ok(r.found.length >= 2 && r.found.every((f) => f.symbol === "USDT"));
  assert.ok(seenCalls.length > 2, "the range was split");
  const many = Array.from({ length: 250 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0")); seenCalls.length = 0;
  await S.scanErc20({ ...net, rpc: async (_u, m, p: any[]) => (m === "eth_blockNumber" ? "0x64" : (seenCalls.push(p[0]), [])) }, baseCfg(), many, 80);
  assert.ok(seenCalls.every((c) => c.topics[2].length <= 100)); assert.equal(seenCalls.length, 4 * 3, "4 tokens x 3 batches");
});
await ok("EVM native: the cursor stops at the last block the node actually has (the old code jumped to the target and could skip blocks)", async () => {
  const net: S.Net = { async get() { throw 0; }, async post() { throw 0; }, async rpc(_u, m, p: any[]) { if (m === "eth_blockNumber") return "0x64"; const b = Number(BigInt(p[0])); return b > 95 ? null : { hash: "0xb" + b, timestamp: "0x1", transactions: [] }; } };
  const r = await S.scanEvmNative(net, baseCfg(), "ETH", ["0x" + "11".repeat(20)], 90, { overlap: 0 }); assert.equal(r.next, 95); assert.equal(r.tip, 100);
});
console.log(`\nall ${n} pagination checks ran` + (process.exitCode ? " — WITH FAILURES" : " — passed"));
