// Run:  node --experimental-strip-types --no-warnings supabase/functions/deposit-watch/test/trace-tool.test.mts     (no internet, no database; starts tiny LOCAL fake JSON-RPC servers)
// PHASE 40 — the EVM trace diagnostic (tools/check-evm-trace.mts) and the identity check of a separate trace endpoint.
// OFFLINE ONLY: the servers below imitate a trace_filter node, a debug_traceBlockByNumber node, a node with neither, a wrong-chain node and a node with shallow history. They prove the TOOL's logic;
// they say nothing about what any real provider supports (that is exactly what running the tool against your own URLs is for).
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { diagnose, httpNet, VERDICT_TEXT } from "../tools/check-evm-trace.mts";
import { runScan } from "../watcher.ts";
import { makeDb, mainnetNet, baseDeps, wallets, ME } from "./fakes.mts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.stack || e)); process.exitCode = 1; });
const TIP = 1000, hash = (b: number) => "0x" + b.toString(16).padStart(64, "0"), HEX = (x: number) => "0x" + x.toString(16);
const T = "0x" + "11".repeat(32), C_ = "0x" + "cc".repeat(20), EOA = "0x" + "ee".repeat(20), RECV = "0x" + "ab".repeat(20), ONE = "0xde0b6b3a7640000", INT_BLOCK = 900;
type Opt = { chainId?: number; mode: "trace_filter" | "debug" | "both" | "none"; depth?: number; noTraceTx?: boolean };

function server(o: Opt): Promise<{ url: string; close(): void }> {
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const { id, method, params } = JSON.parse(b), ok_ = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result })), err = (code: number, message: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
      const tooOld = (bn: number) => o.depth != null && TIP - bn > o.depth;
      const txsOf = (bn: number) => (bn === INT_BLOCK ? [T] : bn > TIP - 12 ? ["0x" + bn.toString(16).padStart(64, "a")] : []);
      switch (method) {
        case "eth_chainId": return ok_(HEX(o.chainId ?? 1));
        case "eth_blockNumber": return ok_(HEX(TIP));
        case "eth_getBlockByNumber": { const bn = params[0] === "latest" ? TIP : Number(BigInt(params[0])); return ok_({ number: HEX(bn), hash: hash(bn), timestamp: HEX(Math.floor(Date.now() / 1000) - 3), transactions: txsOf(bn) }); }
        case "eth_getTransactionReceipt": return ok_(params[0] === T ? { blockNumber: HEX(INT_BLOCK), blockHash: hash(INT_BLOCK), status: "0x1" } : null);
        case "trace_filter": {
          if (o.mode !== "trace_filter" && o.mode !== "both") return err(-32601, "the method trace_filter does not exist/is not available");
          const f = params[0], from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock)); if (tooOld(from)) return err(-32000, "historical state not available");
          const items: any[] = [];
          if (INT_BLOCK >= from && INT_BLOCK <= to) items.push({ type: "call", action: { callType: "call", from: C_, to: RECV, value: ONE }, blockNumber: INT_BLOCK, blockHash: hash(INT_BLOCK), transactionHash: T, transactionPosition: 0, traceAddress: [0] });
          if (995 >= from && 995 <= to) items.push({ type: "call", action: { callType: "call", from: C_, to: "0x" + "dd".repeat(20), value: ONE }, blockNumber: 995, blockHash: hash(995), transactionHash: "0x" + "99".repeat(32), transactionPosition: 0, traceAddress: [0] });
          const want = (f.toAddress || []).map((x: string) => x.toLowerCase()); return ok_(items.filter((x) => !want.length || want.includes(x.action.to.toLowerCase())).slice(f.after || 0, (f.after || 0) + (f.count || 500)));
        }
        case "trace_transaction": return o.noTraceTx ? err(-32601, "method not found") : ok_([]);
        case "debug_traceBlockByNumber": {
          if (o.mode !== "debug" && o.mode !== "both") return err(-32601, "the method debug_traceBlockByNumber does not exist/is not available");
          const bn = Number(BigInt(params[0])); if (tooOld(bn)) return err(-32000, "historical state not available");
          return ok_(txsOf(bn).map((h) => ({ txHash: h, result: { type: "CALL", from: EOA, to: C_, value: "0x0", calls: bn === INT_BLOCK ? [{ type: "CALL", from: C_, to: RECV, value: ONE }] : [] } })));
        }
      }
      err(-32601, "method not found");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: "http://127.0.0.1:" + (srv.address() as any).port, close: () => srv.close() })));
}
const net = httpNet();

await ok("a trace_filter provider: FULL; the report names the mode, the depth and that no positive control was given", async () => {
  const s = await server({ mode: "trace_filter" });
  try {
    const r = await diagnose(net, "ETH", s.url, "", 1); assert.equal(r.verdict, "FULL", r.problems.join(" | ")); assert.equal(r.mode, "trace_filter"); assert.ok(r.historyBlocks! >= 300);
    assert.ok(r.lines.some((l) => /trace_transaction works/.test(l))); assert.ok(r.lines.some((l) => /no positive control/.test(l)));
  } finally { s.close(); }
});

await ok("POSITIVE CONTROL through the PRODUCTION scanner (trace_filter): the real internal transfer is found; a wrong receiving address FAILS the control (PARTIAL)", async () => {
  const s = await server({ mode: "trace_filter" });
  try {
    const good = await diagnose(net, "ETH", s.url, "", 1, { tx: T, to: RECV }); assert.equal(good.verdict, "FULL", good.problems.join(" | ")); assert.ok(good.lines.some((l) => /POSITIVE CONTROL: .*1 ETH/.test(l)));
    const wrong = await diagnose(net, "ETH", s.url, "", 1, { tx: T, to: "0x" + "12".repeat(20) }); assert.equal(wrong.verdict, "PARTIAL"); assert.ok(wrong.problems.some((p) => /POSITIVE CONTROL FAILED/.test(p)));
  } finally { s.close(); }
});

await ok("a debug_traceBlockByNumber provider: FULL in debug_trace mode, positive control found through callTracer", async () => {
  const s = await server({ mode: "debug" });
  try { const r = await diagnose(net, "ETH", s.url, "", 1, { tx: T, to: RECV }); assert.equal(r.verdict, "FULL", r.problems.join(" | ")); assert.equal(r.mode, "debug_trace"); assert.ok(r.lines.some((l) => /POSITIVE CONTROL/.test(l))); } finally { s.close(); }
});

await ok("a provider with NEITHER method: NOT_MONITORED, and the verdict text says internal transfers cannot be completely monitored", async () => {
  const s = await server({ mode: "none" });
  try { const r = await diagnose(net, "BNB", s.url, "", 1); assert.equal(r.verdict, "NOT_MONITORED"); assert.equal(r.mode, null); assert.ok(r.problems.some((p) => /neither trace_filter nor debug_traceBlockByNumber/.test(p))); assert.match(VERDICT_TEXT[r.verdict], /CANNOT be monitored/); } finally { s.close(); }
});

await ok("trace_filter works but trace_transaction is missing: PARTIAL (the scanner needs it to drop rolled-back calls)", async () => {
  const s = await server({ mode: "trace_filter", noTraceTx: true });
  try { const r = await diagnose(net, "ETH", s.url, "", 1); assert.equal(r.verdict, "PARTIAL"); assert.ok(r.problems.some((p) => /trace_transaction/.test(p))); } finally { s.close(); }
});

await ok("shallow tracing history (only 100 blocks): PARTIAL, with the exact depth; a first run / outage longer than that cannot be recovered", async () => {
  const s = await server({ mode: "trace_filter", depth: 100 });
  try { const r = await diagnose(net, "ETH", s.url, "", 1); assert.equal(r.verdict, "PARTIAL"); assert.equal(r.historyBlocks, 50); assert.ok(r.problems.some((p) => /does NOT reach 300 blocks back \(deepest that answered: 50\)/.test(p))); } finally { s.close(); }
});

await ok("the WRONG chain behind the main RPC, or behind a separate trace RPC, is refused before any tracing is believed", async () => {
  const bsc = await server({ mode: "trace_filter", chainId: 56 }), eth = await server({ mode: "trace_filter" });
  try {
    const a = await diagnose(net, "ETH", bsc.url, "", 1); assert.equal(a.verdict, "NOT_MONITORED"); assert.ok(a.problems.some((p) => /Wrong network/.test(p)));
    const b = await diagnose(net, "ETH", eth.url, bsc.url, 1); assert.equal(b.verdict, "NOT_MONITORED"); assert.ok(b.problems.some((p) => /trace endpoint: .*Wrong network/.test(p)));
  } finally { bsc.close(); eth.close(); }
});

await ok("CLI: exit code 0 when FULL, 2 when internal transfers cannot be completely monitored, 1 for a bad chain name", async () => {
  const tool = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "check-evm-trace.mts"), good = await server({ mode: "trace_filter" }), none = await server({ mode: "none" });
  try {
    // async spawn: the fake servers live in THIS process, whose event loop must stay free to answer
    const run = (args: string[], env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => { const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", tool, ...args], { env: { ...process.env, ...env } }); let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d)); c.on("close", (status) => res({ status, stdout, stderr })); });
    const a = await run(["ETH"], { RPC_ETH: good.url }); assert.equal(a.status, 0, a.stdout + a.stderr); assert.match(a.stdout, /=> FULL/);
    const b = await run(["ETH"], { RPC_ETH: none.url }); assert.equal(b.status, 2); assert.match(b.stdout, /CANNOT be monitored/);
    assert.equal((await run(["DOGE"], {})).status, 1);
  } finally { good.close(); none.close(); }
});

// ------------------------------------------------------------------------------------------------ the WATCHER: a separate trace endpoint must be the intended chain
await ok("WATCHER: RPC_TRACE_ETH pointing at ANOTHER chain is an ERROR; no internal scan runs, its cursor is not created, nothing is recorded from it", async () => {
  const db = makeDb(wallets()), base = mainnetNet({ tip: 100 }), seen: string[] = [];
  const net2 = { ...base, rpc: async (u: string, m: string, p: any[]) => { seen.push(u + " " + m); if (u === "wrongtrace" && m === "eth_chainId") return "0x38"; if (u === "wrongtrace") throw new Error("must not be asked: " + m); return base.rpc(u, m, p); }, get: base.get, post: base.post } as any;
  const r: any = await runScan(baseDeps(db, net2, { trace: { ETH: { mode: "trace_filter", url: "wrongtrace" }, BNB: { mode: "off", url: "" }, AVAX: { mode: "off", url: "" } } }));
  assert.ok(r.errors.some((e: string) => /ETH: internal .*NOT monitored: the trace endpoint is not usable: .*Wrong network behind the ETH trace RPC address \(chain 56, expected 1\)/.test(e)), r.errors.join(" | "));
  assert.ok(!db.cursors.has("evmtrace:ETH")); assert.ok(!seen.some((s) => /wrongtrace (trace_filter|debug_traceBlockByNumber)/.test(s)), "no trace call reached the wrong chain");
  assert.equal((db.health.get("ETH") as any).p_ok, false); assert.ok(db.balances.some((b) => b.p_symbol === "ETH"), "top-level scanning and the balance mirror still ran");
  void ME;
});

console.log(process.exitCode ? "\nSOME CHECKS FAILED" : `\nall ${n} EVM trace tool checks ran — passed`);
