// Veltrix · deposit-watch · DIAGNOSTIC: does YOUR RPC provider support the tracing that internal (contract-sent) ETH / BNB / AVAX deposits need?
//
//   RPC_ETH=https://…  RPC_TRACE_ETH=https://…  node --experimental-strip-types --no-warnings supabase/functions/deposit-watch/tools/check-evm-trace.mts  [ETH] [BNB] [AVAX]
//
// Run it on YOUR machine with the same URLs you set as Supabase secrets (RPC_ETH/BNB/AVAX and, if you use a separate tracing provider, RPC_TRACE_ETH/BNB/AVAX).
// It only READS (eth_chainId, eth_blockNumber, eth_getBlockByNumber, trace_filter, trace_transaction, debug_traceBlockByNumber). It sends nothing, signs nothing, writes nothing.
// It uses the SAME probe and the SAME scanning code as the deployed watcher (scan.ts), so "FULL" here means the watcher's own calls worked against your provider today.
// Optional positive control (strongly recommended, once per chain): a REAL historical transaction in which a contract paid native coin to an address:
//   CHECK_INTERNAL_TX_ETH=<tx hash>  CHECK_INTERNAL_TO_ETH=<the receiving address>      (same for _BNB / _AVAX)
// Find one in the chain's block explorer ("Internal Txns" tab of any contract call that paid someone). The tool then runs the production scanner over that block and
// requires it to report exactly that transfer. Exit code: 0 = every requested chain is FULL · 2 = at least one chain CANNOT be completely monitored · 1 = bad usage.
// The author could not run this against any real provider (no network was available). Every statement it prints is derived from the live answers of YOUR provider.
import { fileURLToPath } from "node:url";
import { probeTrace, scanEvmInternal, type Cfg, type Net, type TraceMode } from "../scan.ts";
import { checkEvm, EVM_CHAIN_ID } from "../../_shared/netcheck.ts";

export type Verdict = "FULL" | "PARTIAL" | "NOT_MONITORED";
export type TraceReport = { sym: string; mainUrl: string; traceUrl: string; verdict: Verdict; mode: TraceMode | null; lines: string[]; problems: string[]; historyBlocks: number | null };
const hexN = (n: number) => "0x" + n.toString(16), msg = (e: unknown) => String((e as Error)?.message || e).slice(0, 160), host = (u: string) => { try { return new URL(u).host; } catch { return "(invalid url)"; } };

export function httpNet(): Net {
  const j = async (url: string, init?: RequestInit) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) }), t = await r.text(); if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 120)}`); try { return JSON.parse(t); } catch { return t; } };
  return {
    get: (u) => j(u),
    post: (u, b) => j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }),
    rpc: async (u, method, params) => { const r: any = await j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 200)); return r.result; },
  };
}

/** how far back does tracing work on this endpoint? (catching up after an outage needs old blocks) -> the largest depth that answered, among a few probes */
async function historyDepth(net: Net, url: string, mode: TraceMode, tip: number, withTx: (n: number) => Promise<boolean>): Promise<number> {
  let best = 0;
  for (const depth of [50, 300, 2000, 10000]) {
    const n = tip - depth; if (n <= 0) break;
    try {
      if (mode === "trace_filter") { const r = await net.rpc(url, "trace_filter", [{ fromBlock: hexN(n), toBlock: hexN(n), count: 1 }]); if (!Array.isArray(r)) break; }
      else { const r = await net.rpc(url, "debug_traceBlockByNumber", [hexN(n), { tracer: "callTracer" }]); if (!Array.isArray(r)) break; if (!r.length && await withTx(n)) break; }
      best = depth;
    } catch { break; }
  }
  return best;
}

export async function diagnose(net: Net, sym: "ETH" | "BNB" | "AVAX", mainUrl: string, traceUrl: string, expectedChainId: number, control?: { tx: string; to: string }, backfillBlocks = 300): Promise<TraceReport> {
  const rep: TraceReport = { sym, mainUrl, traceUrl: traceUrl || mainUrl, verdict: "NOT_MONITORED", mode: null, lines: [], problems: [], historyBlocks: null };
  const say = (s: string) => rep.lines.push(s), bad = (s: string) => rep.problems.push(s);
  say(`main RPC  ${host(mainUrl)}${traceUrl && traceUrl !== mainUrl ? `    trace RPC  ${host(traceUrl)}` : "    (the same endpoint is used for tracing)"}`);
  const id = await checkEvm(net, sym, mainUrl, expectedChainId);
  if (!id.ok) { bad(id.error || "network check failed"); return rep; }
  say(`✔ main RPC is chain ${expectedChainId}, newest block ${id.detail.tip}, ${id.detail.ageSecs}s old`);
  const url = traceUrl || mainUrl;
  if (url !== mainUrl) { const t = await checkEvm(net, sym + " trace", url, expectedChainId); if (!t.ok) { bad("trace endpoint: " + (t.error || "network check failed")); return rep; } say(`✔ trace RPC is chain ${expectedChainId}, newest block ${t.detail.tip}`); }
  const tip = Number(id.detail.tip);
  const pr = await probeTrace(net, url);
  if (!pr.mode) { bad(pr.transient ? `the trace probe failed and does not prove "unsupported" (${pr.error || "?"}); run again` : `neither trace_filter nor debug_traceBlockByNumber (callTracer) is available on this endpoint${pr.error ? " (" + pr.error + ")" : ""}`); return rep; }
  rep.mode = pr.mode; say(`✔ the endpoint answers ${pr.mode === "trace_filter" ? "trace_filter" : "debug_traceBlockByNumber with the callTracer"}`);

  // a real read of recent data, shape-checked the way scan.ts uses it
  let shapeOk = false;
  try {
    if (pr.mode === "trace_filter") {
      const r: any[] = await net.rpc(url, "trace_filter", [{ fromBlock: hexN(Math.max(1, tip - 30)), toBlock: hexN(tip), count: 5 }]);
      if (!Array.isArray(r)) throw new Error("trace_filter did not return a list");
      if (r.length && !(r[0].action && r[0].blockNumber != null && r[0].transactionHash && r[0].blockHash)) throw new Error("trace_filter items lack action / blockNumber / transactionHash / blockHash");
      say(`✔ trace_filter over the last 30 blocks returned ${r.length} item(s) in the expected shape`);
      shapeOk = true;                                                                              // trace_filter itself works; what follows can only make the verdict PARTIAL
      const withTx = r.find((x) => x.transactionHash);
      if (withTx) {
        try { const tt = await net.rpc(url, "trace_transaction", [withTx.transactionHash]); if (!Array.isArray(tt)) throw new Error("it did not return a list"); say("✔ trace_transaction works (the scanner uses it to discard transfers that were rolled back)"); }
        catch (e) { bad("trace_transaction is not available (" + msg(e) + "). The scanner needs it to discard internal transfers that sit under a reverted call: a scan that meets one stops with an error instead of recording it"); }
      } else say("• trace_transaction was not exercised (no transaction in the sample)");
    } else {
      let found = false;
      for (let n = tip - 1; n > tip - 12 && !found; n--) {
        const b: any = await net.rpc(url, "eth_getBlockByNumber", [hexN(n), false]); if (!b || !(b.transactions || []).length) continue;
        const r: any[] = await net.rpc(url, "debug_traceBlockByNumber", [hexN(n), { tracer: "callTracer" }]);
        if (!Array.isArray(r) || r.length !== b.transactions.length) throw new Error(`debug_traceBlockByNumber returned ${Array.isArray(r) ? r.length : "no list"} traces for ${b.transactions.length} transactions`);
        const root = r[0]?.result ?? r[0]; if (!root || root.type == null) throw new Error("the traces carry no callTracer `type`: the callTracer is not the tracer in use");
        say(`✔ debug_traceBlockByNumber(callTracer) on block ${n}: ${r.length} trace(s), one per transaction, in the expected shape`); found = true; shapeOk = true;
      }
      if (!found) say("• no recent block with transactions was found to shape-check (unusual): run again");
    }
  } catch (e) { bad("shape check failed: " + msg(e)); }

  // how far back?
  try {
    rep.historyBlocks = await historyDepth(net, url, pr.mode, tip, async (n) => { const b: any = await net.rpc(mainUrl, "eth_getBlockByNumber", [hexN(n), false]); return !!b && (b.transactions || []).length > 0; });
    if (rep.historyBlocks >= backfillBlocks) say(`✔ tracing reaches at least ${rep.historyBlocks} blocks back (the watcher's first run looks back ${backfillBlocks})`);
    else { bad(`tracing does NOT reach ${backfillBlocks} blocks back (deepest that answered: ${rep.historyBlocks}). After an outage longer than that, or on the first run, older internal transfers cannot be read`); }
  } catch (e) { bad("history check failed: " + msg(e)); }

  // positive control: the PRODUCTION scanner over a real historical internal transfer
  if (control) {
    try {
      const rc: any = await net.rpc(mainUrl, "eth_getTransactionReceipt", [control.tx]); if (!rc?.blockNumber) throw new Error("the main RPC does not know that transaction");
      const n = Number(BigInt(rc.blockNumber)), cfg: Cfg = { rpc: { [sym]: mainUrl }, api: {}, tokens: {}, backfillBlocks: 0, maxBlocksPerRun: 1, required: {}, traceBlocksPerRun: 1 };
      const r = await scanEvmInternal(net, cfg, sym, [control.to], n, { mode: pr.mode, url }, { overlap: 0, maxBlocks: 1 });
      const hit = r.found.filter((f) => f.hash.toLowerCase() === control.tx.toLowerCase());
      if (hit.length) say(`✔ POSITIVE CONTROL: the production scanner found ${hit.length} internal transfer(s) in ${control.tx.slice(0, 12)}…: ${hit.map((f) => f.amount + " " + sym).join(", ")}`);
      else bad(`POSITIVE CONTROL FAILED: the production scanner did not report an internal transfer to ${control.to} in ${control.tx}. Either the transaction has no internal ${sym} transfer to that address, or this provider's tracing does not expose it`);
    } catch (e) { bad("positive control could not run: " + msg(e)); }
  } else say("• no positive control given (CHECK_INTERNAL_TX_" + sym + " / CHECK_INTERNAL_TO_" + sym + "): the shape of the answers was checked, but not against a real internal transfer");

  rep.verdict = rep.problems.length ? (shapeOk ? "PARTIAL" : "NOT_MONITORED") : "FULL";
  return rep;
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  FULL: "FULL — the checks above passed against this provider. (Still prove it once with a real contract-sent transfer: TESTING-REAL-MONEY.md §6.)",
  PARTIAL: "PARTIAL — tracing works but with the limits listed: internal transfers CANNOT be completely monitored.",
  NOT_MONITORED: "NOT MONITORED — internal (contract-sent) transfers CANNOT be monitored with this configuration. Only top-level transfers are seen; the balance mirror will still show such coins, and v_chain_reconciliation will show the drift.",
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = (k: string) => process.env[k] || "";
  const DEF: Record<string, string> = { ETH: "https://ethereum-rpc.publicnode.com", BNB: "https://bsc-rpc.publicnode.com", AVAX: "https://avalanche-c-chain-rpc.publicnode.com" };
  const want = (process.argv.slice(2).length ? process.argv.slice(2) : ["ETH", "BNB", "AVAX"]).map((s) => s.toUpperCase());
  if (want.some((s) => !DEF[s])) { console.error("usage: check-evm-trace.mts [ETH] [BNB] [AVAX]"); process.exit(1); }
  const net = httpNet(); let worst = 0;
  for (const s of want as ("ETH" | "BNB" | "AVAX")[]) {
    console.log(`\n=== ${s} ===`);
    const tx = env("CHECK_INTERNAL_TX_" + s), to = env("CHECK_INTERNAL_TO_" + s);
    const r = await diagnose(net, s, env("RPC_" + s) || DEF[s], env("RPC_TRACE_" + s), Number(env("CHAIN_ID_" + s) || EVM_CHAIN_ID[s]), tx && to ? { tx, to } : undefined, Number(env("DEPOSIT_BACKFILL_BLOCKS") || 300));
    r.lines.forEach((l) => console.log("  " + l)); r.problems.forEach((p) => console.log("  ✘ " + p)); console.log("  => " + VERDICT_TEXT[r.verdict]);
    if (r.verdict !== "FULL") worst = 2;
  }
  process.exit(worst);
}
