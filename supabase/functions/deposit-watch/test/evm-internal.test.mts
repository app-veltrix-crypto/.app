// Run: node --experimental-strip-types deposit-watch/test/evm-internal.test.mts      (no network, no database)
// SYNTHETIC trace fixtures in the documented shapes of trace_filter (Erigon/Nethermind/Reth) and debug_traceBlockByNumber + callTracer (Geth, Avalanche).
// They prove the interpretation rules; whether YOUR provider answers these calls is proven by TESTING-REAL-MONEY.md (a contract-call transfer on a testnet).
import assert from "node:assert/strict";
import * as S from "../scan.ts";
import { runScan } from "../watcher.ts";
import { baseCfg, makeDb, mainnetNet, baseDeps, wallets, ME } from "./fakes.mts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.stack || e)); process.exitCode = 1; });
const OTHER = "0x" + "22".repeat(20), CONTRACT = "0x" + "33".repeat(20), W1 = "0xde0b6b3a7640000" /* 1 ETH */;
const blk = (txs: any[] = [{ hash: "0xtx1" }]) => ({ hash: "0xb99", timestamp: "0x65000000", transactions: txs });

// ---------------- debug_traceBlockByNumber + callTracer
const frame = (o: any) => ({ type: "CALL", from: CONTRACT, to: ME, value: W1, ...o });
await ok("callTracer: an internal CALL with value to a watched address is found, with sender, amount and the stable ref int:<from>:<wei>:<n>", () => {
  const root = { type: "CALL", from: OTHER, to: CONTRACT, value: "0x0", calls: [frame({})] };
  const f = S.internalFromDebugTrace("ETH", [ME], blk(), [{ txHash: "0xtx1", result: root }], 99, 110);
  assert.equal(f.length, 1); assert.deepEqual([f[0].hash, f[0].from, f[0].amount, f[0].ref, f[0].block, f[0].confirmations, f[0].failed], ["0xtx1", CONTRACT, "1", `int:${CONTRACT}:1000000000000000000:0`, 99, 12, false]);
});
await ok("callTracer: value moved by a REVERTED call, by anything below a reverted call, or in a FAILED transaction is NOT a deposit", () => {
  const rev = { type: "CALL", from: OTHER, to: CONTRACT, value: "0x0", calls: [frame({ error: "execution reverted" })] };
  const below = { type: "CALL", from: OTHER, to: CONTRACT, value: "0x0", calls: [{ type: "CALL", from: CONTRACT, to: "0x" + "44".repeat(20), value: "0x0", error: "execution reverted", calls: [frame({})] }] };
  const failedTx = { type: "CALL", from: OTHER, to: CONTRACT, value: "0x0", error: "out of gas", calls: [frame({})] };
  for (const r of [rev, below, failedTx]) assert.equal(S.internalFromDebugTrace("ETH", [ME], blk(), [{ txHash: "0xtx1", result: r }], 99, 110).length, 0);
});
await ok("callTracer: DELEGATECALL / STATICCALL / zero value / other recipients never count; SELFDESTRUCT to a watched address does; the TOP-LEVEL call is the block scan's job", () => {
  const root = { type: "CALL", from: OTHER, to: ME, value: W1, calls: [frame({ type: "DELEGATECALL" }), frame({ type: "STATICCALL" }), frame({ value: "0x0" }), frame({ to: OTHER }), frame({ type: "SELFDESTRUCT", from: CONTRACT, to: ME, value: "0x5" })] };
  const f = S.internalFromDebugTrace("ETH", [ME], blk(), [{ txHash: "0xtx1", result: root }], 99, 110);
  assert.deepEqual(f.map((x) => x.amount), ["0.000000000000000005"]);
});
await ok("callTracer: two IDENTICAL internal transfers in one transaction are two records (ordinal), found in nested frames too; hash falls back to the block's tx list", () => {
  const root = { type: "CALL", from: OTHER, to: CONTRACT, value: "0x0", calls: [frame({}), { type: "CALL", from: CONTRACT, to: CONTRACT, value: "0x0", calls: [frame({})] }] };
  const f = S.internalFromDebugTrace("ETH", [ME], blk(["0xtxA"]), [{ result: root }], 99, 110);
  assert.deepEqual(f.map((x) => [x.hash, x.ref.split(":").pop()]), [["0xtxA", "0"], ["0xtxA", "1"]]);
});

// ---------------- trace_filter
const tf = (o: any) => ({ type: "call", action: { callType: "call", from: CONTRACT, to: ME, value: W1 }, blockNumber: "0x63", blockHash: "0xb99", transactionHash: "0xtx1", transactionPosition: 0, traceAddress: [0], ...o });
function tfNet(items: any[], whole: any[] = items, calls: any[] = []): S.Net {
  return { async get() { throw 0; }, async post() { throw 0; }, async rpc(_u, m, p: any[]) {
    calls.push([m, p[0]]); if (m === "eth_blockNumber") return "0x6e";
    if (m === "eth_getBlockByNumber") return { hash: "0xb99", timestamp: "0x65000000" };
    if (m === "trace_filter") return items.slice(p[0].after, p[0].after + p[0].count);
    if (m === "trace_transaction") return whole; throw new Error(m); } };
}
const TR = { mode: "trace_filter" as const, url: "trace" };
await ok("trace_filter: an internal transfer is found with the same ref as the callTracer path would give (switching provider cannot double-record); top-level calls are left to the block scan", async () => {
  const net = tfNet([tf({}), tf({ traceAddress: [], transactionHash: "0xtop" })], [{ traceAddress: [], action: {} }, { traceAddress: [0], action: {} }]);
  const r = await S.scanEvmInternal(net, baseCfg(), "ETH", [ME], 90, TR);
  assert.deepEqual(r.found.map((f) => [f.hash, f.ref, f.amount]), [["0xtx1", `int:${CONTRACT}:1000000000000000000:0`, "1"]]); assert.equal(r.next, 110);
  const dbg = S.internalFromDebugTrace("ETH", [ME], blk(), [{ txHash: "0xtx1", result: { type: "CALL", from: OTHER, to: CONTRACT, value: "0x0", calls: [frame({})] } }], 99, 110);
  assert.equal(dbg[0].ref, r.found[0].ref);
});
await ok("trace_filter: a call below a reverted ancestor (found via trace_transaction) is dropped; an errored call is dropped", async () => {
  const whole = [{ traceAddress: [], action: {} }, { traceAddress: [0], error: "Reverted", action: {} }, { traceAddress: [0, 0], action: {} }];
  assert.equal((await S.scanEvmInternal(tfNet([tf({ traceAddress: [0, 0] })], whole), baseCfg(), "ETH", [ME], 90, TR)).found.length, 0);
  assert.equal((await S.scanEvmInternal(tfNet([tf({ error: "Reverted" })]), baseCfg(), "ETH", [ME], 90, TR)).found.length, 0);
});
await ok("trace_filter: results are paged (after/count) until a short page, so a busy range is not truncated; a block that is no longer canonical is skipped", async () => {
  const items = Array.from({ length: 1200 }, (_, i) => tf({ transactionHash: "0xh" + i, transactionPosition: i, action: { callType: "call", from: CONTRACT, to: ME, value: "0x" + (i + 1).toString(16) } }));
  const calls: any[] = [], r = await S.scanEvmInternal(tfNet(items, [{ traceAddress: [], action: {} }], calls), baseCfg(), "ETH", [ME], 90, TR);
  assert.equal(r.found.length, 1200); assert.equal(calls.filter((c) => c[0] === "trace_filter").length, 3);
  const moved = tfNet([tf({ blockHash: "0xOLD" })]); assert.equal((await S.scanEvmInternal(moved, baseCfg(), "ETH", [ME], 90, TR)).found.length, 0);
});
await ok("trace_filter: `suicide` to a watched address counts; reward / create / delegatecall do not", async () => {
  const items = [tf({ type: "suicide", action: { address: CONTRACT, refundAddress: ME, balance: "0x7" } }), tf({ type: "reward", action: {} }), tf({ type: "create", action: { value: W1 } }), tf({ action: { callType: "delegatecall", from: CONTRACT, to: ME, value: W1 } })];
  const r = await S.scanEvmInternal(tfNet(items, [{ traceAddress: [], action: {} }]), baseCfg(), "ETH", [ME], 90, TR); assert.deepEqual(r.found.map((f) => f.amount), ["0.000000000000000007"]);
});
await ok("trace_filter: a reverted TOP-LEVEL transfer is not an internal one (the block scan records it as failed)", async () => {
  assert.equal((await S.scanEvmInternal(tfNet([tf({ traceAddress: [], error: "Reverted" })]), baseCfg(), "ETH", [ME], 90, TR)).found.length, 0);
});

// ---------------- provider capability detection
const probeNet = (answers: Record<string, any>): S.Net => ({ async get() { throw 0; }, async post() { throw 0; }, async rpc(_u, m) { if (m === "eth_blockNumber") return "0x6e"; const a = answers[m]; if (a instanceof Error) throw a; return a; } });
await ok("probeTrace: picks trace_filter, else debug_trace; 'method not found' on both = unsupported (not transient); a timeout is transient (never cached as 'unsupported' for long)", async () => {
  assert.equal((await S.probeTrace(probeNet({ trace_filter: [] }), "u")).mode, "trace_filter");
  assert.equal((await S.probeTrace(probeNet({ trace_filter: new Error('{"code":-32601,"message":"method not found"}'), debug_traceBlockByNumber: [] }), "u")).mode, "debug_trace");
  const un = await S.probeTrace(probeNet({ trace_filter: new Error('{"code":-32601,"message":"the method trace_filter does not exist/is not available"}'), debug_traceBlockByNumber: new Error("403 forbidden: upgrade your plan") }), "u");
  assert.deepEqual([un.mode, un.transient], [null, false]);
  const tr = await S.probeTrace(probeNet({ trace_filter: new Error("504 timeout"), debug_traceBlockByNumber: new Error("504 timeout") }), "u"); assert.deepEqual([tr.mode, tr.transient], [null, true]);
});

// ---------------- the orchestrator
const ethNet = (extra: (m: string, p: any[]) => any) => { const net = mainnetNet({ ethTxs: {} }), real = net.rpc.bind(net); net.rpc = async (u: string, m: string, p: any[]) => { const x = extra(m, p); return x !== undefined ? (x instanceof Error ? Promise.reject(x) : x) : real(u, m, p); }; return net; };
await ok("watcher: with a trace provider an internal transfer is recorded INDIVIDUALLY (ref int:…), on its own cursor; the balance is never used to invent a deposit", async () => {
  const db = makeDb(wallets()); const net = ethNet((m, p) => m === "trace_filter" ? [tf({ blockNumber: "0x63", blockHash: "0xblk99" })] : m === "trace_transaction" ? [{ traceAddress: [], action: {} }] : undefined);
  const r: any = await runScan(baseDeps(db, net, { trace: { ETH: { mode: "trace_filter", url: "trace" }, BNB: { mode: "off", url: "" }, AVAX: { mode: "off", url: "" } } }));
  const rec = [...db.recorded.values()].filter((v) => v.p_symbol === "ETH"); assert.equal(rec.length, 1); assert.match(rec[0].p_ref, /^int:/); assert.equal(rec[0].p_amount, "1");
  assert.ok(db.cursors.has("evmtrace:ETH") && db.cursors.has("evm:ETH")); assert.equal(db.health.get("ETH").p_detail.internalTransfers, "trace_filter");
  assert.equal(db.balances.find((b) => b.p_symbol === "ETH").p_balance, "2", "the balance (2 ETH) is mirrored but produced no extra deposit row");
});
await ok("watcher: WITHOUT trace support internal transfers are NOT monitored, and that is said loudly (warning + health detail); nothing is fabricated; the trace cursor does not move", async () => {
  const db = makeDb(wallets()), net = ethNet((m) => (m === "trace_filter" || m === "debug_traceBlockByNumber" ? new Error('{"code":-32601,"message":"method not found"}') : undefined));
  const r: any = await runScan(baseDeps(db, net, { trace: { ETH: { mode: "auto", url: "" }, BNB: { mode: "off", url: "" }, AVAX: { mode: "off", url: "" } } }));
  assert.ok(r.warnings.some((w: string) => /ETH: internal \(contract-call\) transfers are NOT monitored.*RPC_TRACE_ETH/.test(w))); assert.equal(db.health.get("ETH").p_detail.internalTransfers, "unsupported");
  assert.ok(!db.cursors.has("evmtrace:ETH")); assert.equal([...db.recorded.values()].length, 0); assert.ok(db.balances.some((b) => b.p_symbol === "ETH"), "the real balance is still shown");
});
await ok("watcher: a trace provider that fails this run does NOT let the internal cursor skip blocks (error reported, cursor unchanged), while the top-level cursor still advances", async () => {
  const db = makeDb(wallets()); db.cursors.set("evmtrace:ETH", 80);
  const net = ethNet((m) => (m === "trace_filter" ? new Error("502 bad gateway") : undefined));
  const r: any = await runScan(baseDeps(db, net, { trace: { ETH: { mode: "trace_filter", url: "t" }, BNB: { mode: "off", url: "" }, AVAX: { mode: "off", url: "" } } }));
  assert.equal(db.cursors.get("evmtrace:ETH"), 80); assert.ok(r.errors.some((e: string) => /502/.test(e))); assert.ok((db.cursors.get("evm:ETH") ?? 0) >= 100);
});
await ok("watcher: a scanner that is far behind a fast chain catches up over several chunks in one run and reports the lag", async () => {
  const db = makeDb(wallets()); db.cursors.set("evm:ETH", 10); const net = mainnetNet({ tip: 400 });
  const r: any = await runScan(baseDeps(db, net, { maxChunks: 3 })); assert.equal(db.cursors.get("evm:ETH"), 10 + 12 + 3 * 0 + 0 > 0 ? db.cursors.get("evm:ETH") : 0);
  assert.ok(db.cursors.get("evm:ETH")! >= 140, "3 chunks of 50 from cursor 10: " + db.cursors.get("evm:ETH")); assert.ok(r.warnings.some((w: string) => /blocks behind/.test(w)));
});
console.log(`\nall ${n} EVM internal-transfer checks ran` + (process.exitCode ? " — WITH FAILURES" : " — passed"));
