// Run:  node --experimental-strip-types --no-warnings supabase/functions/deposit-watch/test/trx-internal.test.mts     (no network, no database, no money)
// PHASE 40 — TRX that a SMART CONTRACT pays to a watched address (an "internal transfer") is found by walking solidified blocks.
// OFFLINE ONLY: the TRON node is a fake shaped like the documented /walletsolidity/gettransactioninfobyblocknum answer. It does not prove a real TronGrid answers this way.
import assert from "node:assert/strict";
import * as S from "../scan.ts";
import { runScan } from "../watcher.ts";
import { clock, makeDb, baseDeps, baseCfg, GEN } from "./fakes.mts";
import { nodePrims as P } from "../../payout-send/test/nodeprims.mts";
import * as C from "../../payout-send/chains.ts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.stack || e)); process.exitCode = 1; });
const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ME = (await C.treasuryAddresses(P, ABANDON)).TRX;                                           // a real, valid TRON address (derived by the signer's own code)
const OTHER = (await C.treasuryAddresses(P, "legal winner thank year wave sausage worth useful legal winner thank yellow")).TRX;
const hexOf = (a: string) => Buffer.from(C.tronAddressBytes(a, P)).toString("hex");           // the signer's implementation: an INDEPENDENT cross-check of scan.ts
const CALLER_HEX = "41" + "ab".repeat(20);
const info = (id: string, block: number, internal: any[], extra: any = {}) => ({ id, blockNumber: block, blockTimeStamp: 1_700_000_000_000 + block * 3000, receipt: { result: "SUCCESS" }, internal_transactions: internal, ...extra });
const itx = (to: string, callValue: number | null, o: any = {}) => ({ caller_address: CALLER_HEX, transferTo_address: hexOf(to), callValueInfo: callValue == null ? [{}] : [{ callValue }], note: "63616c6c", ...o });

await ok("address codec: base58 <-> 21-byte hex agrees with the signer's own (checksum-verifying) implementation for several addresses, and rejects junk", async () => {
  for (const a of [ME, OTHER, "TTSFjEG3Lu9WkHdp4JrWYhbGP6K1REqnGQ"]) { assert.equal(S.tronHexOf(a), hexOf(a), a); assert.equal(await S.tronAddressOf(hexOf(a)), a, a); }
  assert.equal(S.tronHexOf("notanaddress0"), null); assert.equal(S.tronHexOf("1111"), null); assert.equal(S.tronHexOf(""), null);
});

await ok("a contract paying 2.5 TRX to the watched address is found: exact amount, hash, sender, block, time, 1 confirmation, a stable ref", async () => {
  const want = new Map([[hexOf(ME), ME]]);
  const f = await S.trxInternalFrom(want, [info("aa".repeat(32), 777, [itx(ME, 2_500_000)])], 777);
  assert.equal(f.length, 1); const d = f[0];
  assert.deepEqual([d.symbol, d.network, d.to, d.hash, d.amount, d.block, d.confirmations, d.failed], ["TRX", "TRON", ME, "aa".repeat(32), "2.5", 777, 1, false]);
  assert.equal(d.ref, `int:${CALLER_HEX}:2500000:0`); assert.equal(d.from, await S.tronAddressOf(CALLER_HEX)); assert.equal(d.blockTime, Math.floor((1_700_000_000_000 + 777 * 3000) / 1000));
});

await ok("NOT counted: rejected internal transfers, reverted / failed parents, TRC-10 values, zero values, transfers to other addresses, parents without internal transactions", async () => {
  const want = new Map([[hexOf(ME), ME]]), id = (c: string) => c.repeat(32);
  const infos = [
    info(id("01"), 5, [itx(ME, 1_000_000, { rejected: true })]),
    info(id("02"), 5, [itx(ME, 1_000_000)], { receipt: { result: "REVERT" } }),
    info(id("03"), 5, [itx(ME, 1_000_000)], { result: "FAILED", receipt: {} }),
    info(id("04"), 5, [{ ...itx(ME, 0), callValueInfo: [{ tokenId: "1002000", callValue: 77 }] }]),
    info(id("05"), 5, [itx(ME, null)]),
    info(id("06"), 5, [itx(OTHER, 9_000_000)]),
    info(id("07"), 5, []), { id: id("08"), blockNumber: 5 },
  ];
  assert.deepEqual(await S.trxInternalFrom(want, infos, 5), []);
  const mixed = await S.trxInternalFrom(want, [info(id("09"), 5, [{ ...itx(ME, 0), callValueInfo: [{ tokenId: "1002000", callValue: 77 }, { callValue: 3_000_000 }] }])], 5);
  assert.deepEqual(mixed.map((x) => x.amount), ["3"], "only the TRX part of a mixed callValueInfo counts");
});

await ok("two identical internal transfers inside one transaction are TWO deposits (distinct refs), not one; a different caller or amount has its own ref", async () => {
  const want = new Map([[hexOf(ME), ME]]);
  const f = await S.trxInternalFrom(want, [info("bb".repeat(32), 9, [itx(ME, 1_000_000), itx(ME, 1_000_000), itx(ME, 1_000_000, { caller_address: "41" + "cd".repeat(20) })])], 9);
  assert.equal(f.length, 3); assert.equal(new Set(f.map((x) => x.ref)).size, 3);
  assert.deepEqual(f.filter((x) => x.ref.startsWith(`int:${CALLER_HEX}`)).map((x) => x.ref.split(":").pop()), ["0", "1"]);
});

/** a fake solidity node: infos per block, a solid tip, call log, switchable failures */
function node(o: { tip: number; blocks?: Record<number, any>; failBlock?: number; err?: Error; nowBlock?: any }) {
  const log: string[] = [];
  const net: S.Net = {
    async get(u) { log.push("GET " + u); if (/\/v1\/accounts\/[^/?]+\/transactions/.test(u)) return { success: true, data: [], meta: {} }; if (/\/v1\/accounts\/[^/?]+\?only_confirmed/.test(u)) return { success: true, data: [{ balance: 5_000_000 }] }; throw new Error("unexpected GET " + u); },
    async rpc() { throw new Error("unexpected rpc"); },
    async post(u, b: any) {
      log.push("POST " + u + (b?.num != null ? " " + b.num : ""));
      if (o.err) throw o.err;
      if (u.endsWith("/wallet/getblockbynum")) return { blockID: GEN.TRX };
      if (u.endsWith("/walletsolidity/getnowblock")) return o.nowBlock ?? { block_header: { raw_data: { number: o.tip } } };
      if (u.endsWith("/walletsolidity/gettransactioninfobyblocknum")) { if (b.num === o.failBlock) throw new Error("429 rate limited"); return o.blocks?.[b.num] ?? {}; }
      throw new Error("unexpected POST " + u);
    },
  };
  return Object.assign(net, { log });
}
const cfg = (): S.Cfg => ({ ...baseCfg(), backfillBlocks: 10, maxBlocksPerRun: 5 });

await ok("scanTrxInternal: first run starts `backfillBlocks` behind the solid tip; reads at most the per-run block budget; the cursor is the last block READ; the next run continues at cursor+1 (no overlap, no gap)", async () => {
  const nd = node({ tip: 100, blocks: { 93: [info("c1".repeat(32), 93, [itx(ME, 4_000_000)])] } });
  const a = await S.scanTrxInternal(nd, cfg(), [ME], null);
  assert.deepEqual([a.next, a.tip, a.found.length], [94, 100, 1]);                                      // 90..94 (5 blocks)
  assert.deepEqual(nd.log.filter((l) => /byblocknum/.test(l)).map((l) => Number(l.split(" ").pop())).sort(), [90, 91, 92, 93, 94]);
  const b = await S.scanTrxInternal(nd, cfg(), [ME], a.next); assert.deepEqual([b.next, b.found.length], [99, 0]);
  nd.log.length = 0; const c = await S.scanTrxInternal(nd, cfg(), [ME], 99); assert.deepEqual([c.next, c.found.length], [100, 0]);
  nd.log.length = 0; const d = await S.scanTrxInternal(nd, cfg(), [ME], 100); assert.deepEqual([d.next, d.found.length], [100, 0]); assert.ok(!nd.log.some((l) => /byblocknum/.test(l)), "caught up: no block is read");
});

await ok("scanTrxInternal: only SOLIDIFIED blocks are read (walletsolidity endpoints), so no reorg handling is needed", async () => {
  const nd = node({ tip: 50, blocks: {} }); await S.scanTrxInternal(nd, cfg(), [ME], 44);
  assert.ok(nd.log.every((l) => !/\/wallet\/(?!getblockbynum)/.test(l)) && nd.log.some((l) => /walletsolidity\/getnowblock/.test(l)));
});

await ok("scanTrxInternal: an unreadable block stops the walk THERE (next run retries it); if the very first block is unreadable it throws; garbage answers throw", async () => {
  const nd = node({ tip: 100, failBlock: 93, blocks: { 91: [info("d1".repeat(32), 91, [itx(ME, 1_000_000)])] } });
  const a = await S.scanTrxInternal(nd, cfg(), [ME], 89);  assert.deepEqual([a.next, a.found.length], [92, 1], "blocks 90-92 were fine; 93 failed; the cursor must not pass it");
  await assert.rejects(S.scanTrxInternal(nd, cfg(), [ME], 92), /429/);
  await assert.rejects(S.scanTrxInternal(node({ tip: 100, blocks: { 91: { Error: "boom" } } }), cfg(), [ME], 90), /boom/);
  await assert.rejects(S.scanTrxInternal(node({ tip: 100, blocks: { 91: "<html>" as any } }), cfg(), [ME], 90), /unexpected answer/);
  await assert.rejects(S.scanTrxInternal(node({ tip: 0, nowBlock: {} }), cfg(), [ME], null), /no block number/);
});

// ------------------------------------------------------------------------------------------------ through the real watcher (leases, cursor, idempotent recording, reporting)
const wallet = [{ user_id: "u1", addresses: [{ symbol: "TRX", address: ME, network: "TRON" }], created_at: new Date(clock.t - 3 * 86400_000).toISOString() }];

await ok("WATCHER: a contract-sent TRX deposit is RECORDED once (ref int:…), the cursor `trxint:TRX` advances, a second run does not re-record, and a LOST cursor re-reads it harmlessly (still ONE row)", async () => {
  const db = makeDb(wallet), nd = node({ tip: 100, blocks: { 98: [info("e1".repeat(32), 98, [itx(ME, 6_000_000)])] } });
  const deps = baseDeps(db, nd, { trxInternal: "auto" }); deps.cfg = { ...deps.cfg, backfillBlocks: 5, maxBlocksPerRun: 50 };
  const r: any = await runScan(deps);
  assert.deepEqual(r.errors, [], r.errors.join(" | "));
  const rows = [...db.recorded.values()]; assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].p_symbol, rows[0].p_amount, rows[0].p_to, rows[0].p_hash, rows[0].p_confs, rows[0].p_user], ["TRX", "6", ME, "e1".repeat(32), 1, "u1"]);
  assert.match(rows[0].p_ref, /^int:41ab/);
  assert.equal(db.cursors.get("trxint:TRX"), 100);
  assert.equal((db.health.get("TRX") as any).p_detail.internalTransfers, "solidified-block walk");
  await runScan(deps); assert.equal(rows[0].seen, 1, "no second record: the cursor had moved on");
  db.cursors.set("trxint:TRX", 90); await runScan(deps);
  assert.equal(db.recorded.size, 1, "a lost cursor re-reads the block; the unique (hash, ref, address) key keeps ONE row"); assert.equal([...db.recorded.values()][0].seen, 2);
});

await ok("WATCHER: if recording fails, the cursor does NOT pass that block (nothing is marked as seen)", async () => {
  const db = makeDb(wallet), nd = node({ tip: 100, blocks: { 98: [info("e2".repeat(32), 98, [itx(ME, 1_000_000)])] } });
  const orig = db.rpc.bind(db); db.rpc = async (name: string, a: any) => { if (name === "record_chain_deposit") throw new Error("db down"); return orig(name, a); };
  const deps = baseDeps(db, nd, {}); deps.cfg = { ...deps.cfg, backfillBlocks: 5, maxBlocksPerRun: 50 };
  const r: any = await runScan(deps);
  assert.ok(r.errors.some((e: string) => /record TRX/.test(e))); assert.equal(db.cursors.get("trxint:TRX"), undefined, "cursor was not written");
});

await ok("WATCHER: a TRON API WITHOUT the solidity block endpoint -> an explicit WARNING 'NOT monitored', plain TRX scanning and balances still work, the cursor is not moved", async () => {
  const db = makeDb(wallet), nd = node({ tip: 100 }), post = nd.post.bind(nd);
  nd.post = async (u: string, b: any) => { if (/gettransactioninfobyblocknum|getnowblock/.test(u)) throw new Error("404 Not Found"); return post(u, b); };
  const r: any = await runScan(baseDeps(db, nd, {}));
  assert.ok(r.warnings.some((w: string) => /contract-sent \(internal\) TRX transfers could NOT be monitored/.test(w) && /does not serve/.test(w)), r.warnings.join(" | "));
  assert.equal((db.health.get("TRX") as any).p_detail.internalTransfers, "unsupported");
  assert.equal(db.balances.filter((b) => b.p_symbol === "TRX").length, 1, "the balance mirror still ran");
  assert.ok(nd.log.some((l) => /v1\/accounts\/.+\/transactions/.test(l)), "plain TRX transfers were still scanned"); assert.equal(db.cursors.get("trxint:TRX"), undefined);
});

await ok("WATCHER: a TRANSIENT failure (rate limit) is a lane ERROR (TRX shows not-ok), the saved position is kept, and the next healthy run catches up from it", async () => {
  const db = makeDb(wallet), nd = node({ tip: 100, blocks: { 96: [info("e3".repeat(32), 96, [itx(ME, 2_000_000)])] }, failBlock: 95 });
  db.cursors.set("trxint:TRX", 94);
  const deps = baseDeps(db, nd, {}); deps.cfg = { ...deps.cfg, maxBlocksPerRun: 50 };
  const r: any = await runScan(deps);
  assert.ok(r.errors.some((e: string) => /could NOT be monitored this run \(429/.test(e)), r.errors.join(" | ")); assert.equal((db.health.get("TRX") as any).p_ok, false);
  assert.equal(db.cursors.get("trxint:TRX"), 94, "block 95 failed first: cursor stays");
  (nd as any).post = node({ tip: 100, blocks: { 96: [info("e3".repeat(32), 96, [itx(ME, 2_000_000)])] } }).post; await runScan(deps);
  assert.equal(db.recorded.size, 1); assert.equal(db.cursors.get("trxint:TRX"), 100);
});

await ok("WATCHER: TRX_INTERNAL=off is REPORTED as a warning (never silent) and no block is read", async () => {
  const db = makeDb(wallet), nd = node({ tip: 100 }), r: any = await runScan(baseDeps(db, nd, { trxInternal: "off" }));
  assert.ok(r.warnings.some((w: string) => /NOT monitored: TRX_INTERNAL=off/.test(w))); assert.ok(!nd.log.some((l) => /byblocknum|getnowblock/.test(l)));
  assert.equal((db.health.get("TRX") as any).p_detail.internalTransfers, "off");
});

await ok("WATCHER: a WRONG TRON network is refused first: no block is read, nothing recorded (the identity check still gates the lane)", async () => {
  const db = makeDb(wallet), nd = node({ tip: 100, blocks: { 98: [info("e4".repeat(32), 98, [itx(ME, 1_000_000)])] } }), post = nd.post.bind(nd);
  nd.post = async (u: string, b: any) => (u.endsWith("/wallet/getblockbynum") ? { blockID: "00".repeat(32) } : post(u, b));
  const r: any = await runScan(baseDeps(db, nd, {}));
  assert.ok(r.errors.some((e: string) => /Wrong network behind the TRON/.test(e))); assert.equal(db.recorded.size, 0); assert.ok(!nd.log.some((l) => /byblocknum/.test(l)));
});

await ok("RATE LIMIT: when TronGrid suspends the key for a few seconds, the first block read waits it out once and retries - the run does not fail, the deposit is found", async () => {
  const nd = node({ tip: 100, blocks: { 93: [info("d1".repeat(32), 93, [itx(ME, 4_000_000)])] } }), post = nd.post.bind(nd); let hit = 0;
  nd.post = async (u: string, b: any) => { if (u.endsWith("/walletsolidity/gettransactioninfobyblocknum") && hit++ === 0) throw new Error('"Error":"The key exceeds the frequency limit(15), and the query server is suspended for 1 s"'); return post(u, b); };
  const a = await S.scanTrxInternal(nd, cfg(), [ME], null);
  assert.equal(a.found.length, 1); assert.equal(a.found[0].amount, "4"); assert.ok(hit > 5, "all blocks were read after the retry");
});

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : `\nall ${n} TRX internal-transfer checks ran — passed`);
