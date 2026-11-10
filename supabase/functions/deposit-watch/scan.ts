// Veltrix · deposit-watch · TRANSACTION-LEVEL deposit scanners. One adapter per chain family. Each returns the INDIVIDUAL incoming transfers
// it can see for a set of watched addresses, with the real hash, sender, amount, block data and confirmations. Nothing here writes to the
// database and nothing here looks at balances; watcher.ts records the results with record_chain_deposit().
//
// The network is injected (`Net`) so the parsing can be tested offline with recorded-shape fixtures. NOTHING in this file has been run
// against a live chain by the author; see TESTING-REAL-MONEY.md for the tiny real-money checks that prove it.
//
// PHASE 39 — HISTORY IS NEVER TRUNCATED. The old adapters read "the first 25 / 50 transactions" of each address. A busy address (or a backlog after
// downtime) could push an older deposit off that page and it would silently never be seen. Every adapter now keeps a CHECKPOINT per address (the newest
// item it has fully processed) and pages backwards, from the newest item, until it reaches that checkpoint (or the end of the history). A sweep that
// needs more pages than one run is allowed to spend is RESUMED by the next run from a stored position; the checkpoint only moves forward when a sweep
// is COMPLETE, and watcher.ts stores it only after every found transfer was recorded. Recording is idempotent, so re-reading is always harmless.
export type Net = {
  get(url: string): Promise<any>;                                   // GET -> parsed JSON (throws on non-2xx)
  rpc(url: string, method: string, params: unknown[]): Promise<any>; // JSON-RPC -> result (throws on error)
  post(url: string, body: unknown): Promise<any>;                    // POST JSON -> parsed JSON
};
export type Found = {
  symbol: string; network: string; to: string; from: string | null; hash: string; ref: string; amount: string;   // amount = exact decimal string
  block: number | null; blockHash: string | null; blockTime: number | null /* unix s */; confirmations: number; failed: boolean;
};
export type Watched = { symbol: string; address: string };
/** an address to watch; `since` (unix seconds) lets a sweep stop once it is older than the wallet itself (nothing earlier can be a deposit) */
export type WatchAddr = { address: string; since?: number | null };
export type Cfg = { rpc: Record<string, string>; api: Record<string, string>; tokens: Record<string, { address: string; decimals: number }>;
  backfillBlocks: number; maxBlocksPerRun: number; required: Record<string, number>; trongridKey?: string;
  /** pages one address may cost in one run (default 5); a longer history is finished by the next runs */
  maxPagesPerRun?: number;
  /** per-network override of maxBlocksPerRun (fast chains such as BNB need far more blocks per minute than Ethereum) */
  blocksPerRunBy?: Record<string, number>;
  /** blocks per run when a trace_filter provider is used (one request covers the whole range) */
  traceBlocksPerRun?: number };
/** the stored position of a sweep (JSON) per address key, supplied by watcher.ts */
export type Progress = { get(key: string): Promise<any | null> };
export type ProgressUpdate = { key: string; state: unknown };
export type SweepResult = { found: Found[]; updates: ProgressUpdate[]; unfinished: number; errors: string[] };
const newSweep = (): SweepResult => ({ found: [], updates: [], unfinished: 0, errors: [] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 160);
const shortA = (a: string) => (a.length > 16 ? a.slice(0, 8) + "…" + a.slice(-4) : a);
const pagesPerRun = (cfg: Cfg) => Math.max(1, cfg.maxPagesPerRun ?? 5);

export function units(v: bigint, dec: number): string {
  const s = v.toString().padStart(dec + 1, "0"), i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, "");
  return i + (f ? "." + f : "");
}
const lc = (s: string) => s.toLowerCase();
const hexN = (n: number) => "0x" + n.toString(16);

/** run `fn` over `items` with at most `n` in flight; results keep the input order */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}

// ------------------------------------------------------------------------------------------------------- BTC / LTC (mempool.space / Esplora-style API)
// GET /address/:a/txs                      -> the newest mempool txs + the first page (25) of confirmed ones, newest first
// GET /address/:a/txs/chain/:last_seen_txid -> the next page of confirmed txs, older than last_seen_txid
// A sweep reads page 1, then older pages until the stored CHECKPOINT txid shows up, a page is empty (= the start of the history), or the pages are older
// than the wallet. The checkpoint txid is the newest CONFIRMED tx of the last complete sweep. (If a reorg removed it, the sweep simply runs to the end of
// the history once and then sets a new one: slower, never wrong.)
export type UtxoState = { checkpoint: string | null; resumeAfter: string | null; newest: string | null };
export async function scanUtxo(net: Net, cfg: Cfg, sym: "BTC" | "LTC", addrs: WatchAddr[], progress: Progress): Promise<SweepResult> {
  const base = cfg.api[sym], tip = Number(await net.get(base + "/blocks/tip/height")), res = newSweep(), maxP = pagesPerRun(cfg);
  for (const w of addrs) {
    const a = w.address, key = `utxo:${sym}:${a}`;
    try {
      const st: UtxoState = { checkpoint: null, resumeAfter: null, newest: null, ...((await progress.get(key)) || {}) };
      const first: any[] = await net.get(`${base}/address/${a}/txs`);
      for (const tx of first) res.found.push(...utxoFrom(sym, a, tx, tip));
      const confirmed = first.filter((t) => t?.status?.confirmed);
      const older = (t: any) => w.since != null && t?.status?.block_time != null && Number(t.status.block_time) < w.since;
      let newest: string | null, cursor: string | null, done = false;
      if (st.resumeAfter != null) { newest = st.newest; cursor = st.resumeAfter; }                                 // continue an unfinished sweep
      else {
        newest = confirmed[0]?.txid ?? st.checkpoint; cursor = confirmed.length ? confirmed[confirmed.length - 1].txid : null;
        if (!confirmed.length || (st.checkpoint && confirmed.some((t) => t.txid === st.checkpoint)) || older(confirmed[confirmed.length - 1])) done = true;
      }
      for (let pages = 0; !done && cursor && pages < maxP; pages++) {
        const p: any[] = await net.get(`${base}/address/${a}/txs/chain/${cursor}`);
        for (const tx of p) res.found.push(...utxoFrom(sym, a, tx, tip));
        if (!p.length || (st.checkpoint && p.some((t) => t.txid === st.checkpoint)) || older(p[p.length - 1])) { done = true; break; }
        cursor = p[p.length - 1].txid;
      }
      const next: UtxoState = done ? { checkpoint: newest, resumeAfter: null, newest: null } : { checkpoint: st.checkpoint, resumeAfter: cursor, newest };
      if (!done) res.unfinished++;
      if (!same(next, { checkpoint: st.checkpoint, resumeAfter: st.resumeAfter, newest: st.newest })) res.updates.push({ key, state: next });
    } catch (e) { res.errors.push(`${sym} ${shortA(a)}: ${errMsg(e)}`); }      // this address keeps its old progress and is retried; the others carry on
  }
  return res;
}
export function utxoFrom(sym: "BTC" | "LTC", addr: string, tx: any, tip: number): Found[] {
  const conf = !!tx.status?.confirmed, h = conf ? Number(tx.status.block_height) : null;
  const senders = [...new Set((tx.vin || []).map((i: any) => i.prevout?.scriptpubkey_address).filter(Boolean))] as string[];
  const res: Found[] = [];
  (tx.vout || []).forEach((o: any, n: number) => {
    if (o.scriptpubkey_address !== addr || !(o.value > 0)) return;
    if (senders.includes(addr) && senders.length === 1) return;                              // pure change back to ourselves is not a deposit
    res.push({ symbol: sym, network: sym === "BTC" ? "Bitcoin" : "Litecoin", to: addr, from: senders.length ? senders.join(",") : null, hash: tx.txid, ref: String(n),
      amount: units(BigInt(o.value), 8), block: h, blockHash: conf ? String(tx.status.block_hash || "") || null : null,
      blockTime: conf ? Number(tx.status.block_time) || null : null, confirmations: conf ? Math.max(1, tip - h! + 1) : 0, failed: false });
  });
  return res;
}
/** one known deposit: still on chain? (null = the chain does not know it) */
export async function recheckUtxo(net: Net, cfg: Cfg, sym: "BTC" | "LTC", hash: string, addr: string, ref: string): Promise<Found | null> {
  const base = cfg.api[sym];
  let tx: any; try { tx = await net.get(`${base}/tx/${hash}`); } catch (e) { if (/404|not found/i.test(String((e as Error).message))) return null; throw e; }
  const tip = Number(await net.get(base + "/blocks/tip/height"));
  return utxoFrom(sym, addr, tx, tip).find((f) => f.ref === ref) ?? null;
}

// ------------------------------------------------------------------------------------------------------- EVM native (ETH / BNB / AVAX)
// Plain JSON-RPC has no "transactions of address X". We walk blocks from a cursor (every run re-reads the last `overlap` blocks, so a reorg inside that
// window is picked up; duplicates are harmless because record_chain_deposit is idempotent) and keep txs whose `to` is watched.
//
// INTERNAL TRANSFERS (native coin moved by a CONTRACT call: a multisig payout, an exchange's batch sender, a router...) have no top-level tx to our address.
// Only an execution TRACE shows them. Two trace APIs are supported, whichever the provider offers (see probeTrace):
//   trace_filter            (Erigon / Nethermind / Reth / OpenEthereum-style): ONE request lists every call into the watched addresses for a whole block range
//   debug_traceBlockByNumber with the callTracer (Geth-style, Avalanche C-Chain): one request per block
// Each internal transfer is recorded INDIVIDUALLY with ref `int:<sender>:<wei>:<n>` (n = its order among identical transfers inside that transaction), which is
// identical whichever API produced it, so switching providers can never record the same transfer twice. Only transfers whose whole call path succeeded count:
// a reverted call (or a call below a reverted call) moved nothing. Without a trace provider internal transfers are NOT seen — see README / PHASE39.md.
// NOTHING is ever derived from a balance increase.
export const REORG_OVERLAP = 12;
export type TraceMode = "trace_filter" | "debug_trace";
export type TraceCfg = { mode: TraceMode; url: string };
export type EvmScanOpts = { overlap?: number; maxBlocks?: number };
export type EvmScan = { found: Found[]; next: number; tip: number };
const NETNAME: Record<string, string> = { ETH: "Ethereum", BNB: "BNB Smart Chain", AVAX: "Avalanche C-Chain" };

export async function scanEvmNative(net: Net, cfg: Cfg, sym: "ETH" | "BNB" | "AVAX", addrs: string[], cursor: number | null, opts: EvmScanOpts = {}): Promise<EvmScan> {
  const url = cfg.rpc[sym], tip = Number(BigInt(await net.rpc(url, "eth_blockNumber", [])));
  const from = cursor == null ? Math.max(0, tip - cfg.backfillBlocks) : Math.max(0, cursor - (opts.overlap ?? REORG_OVERLAP));
  const per = opts.maxBlocks ?? cfg.blocksPerRunBy?.[sym] ?? cfg.maxBlocksPerRun;
  const to = Math.min(tip, from + per - 1), want = new Set(addrs.map(lc)), found: Found[] = [];
  const nums: number[] = []; for (let n = from; n <= to; n++) nums.push(n);
  const blocks = await mapLimit(nums, 6, (n) => net.rpc(url, "eth_getBlockByNumber", ["0x" + n.toString(16), true]));
  let last = cursor ?? from;                                                                  // the newest block that was actually read (a node may not have `to` yet)
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i], b = blocks[i];
    if (!b) break;                                                                            // node does not have it yet: stop here, retry from here next run
    last = n;
    for (const tx of b.transactions || []) {
      if (!tx.to || !want.has(lc(tx.to)) || BigInt(tx.value) === 0n) continue;
      let failed = false;
      try { const r = await net.rpc(url, "eth_getTransactionReceipt", [tx.hash]); failed = !!r && r.status === "0x0"; } catch { /* a missing receipt is re-checked on the next run */ }
      found.push({ symbol: sym, network: NETNAME[sym], to: addrs.find((a) => lc(a) === lc(tx.to))!, from: tx.from, hash: tx.hash, ref: "native",
        amount: units(BigInt(tx.value), 18), block: n, blockHash: b.hash, blockTime: Number(BigInt(b.timestamp)), confirmations: tip - n + 1, failed });
    }
  }
  return { found, next: last, tip };
}

/** INTERNAL transfers only (top-level transfers are scanEvmNative's job). Its own cursor, so a trace-provider outage can never make the main cursor skip them. */
export async function scanEvmInternal(net: Net, cfg: Cfg, sym: "ETH" | "BNB" | "AVAX", addrs: string[], cursor: number | null, trace: TraceCfg, opts: EvmScanOpts = {}): Promise<EvmScan> {
  const url = cfg.rpc[sym], tip = Number(BigInt(await net.rpc(url, "eth_blockNumber", [])));
  const from = cursor == null ? Math.max(0, tip - cfg.backfillBlocks) : Math.max(0, cursor - (opts.overlap ?? REORG_OVERLAP));
  if (trace.mode === "trace_filter") { const r = await scanEvmTraceFilter(net, cfg, sym, addrs, tip, from, trace); return { ...r, found: r.found.filter((f) => f.ref !== "native") }; }
  const per = opts.maxBlocks ?? cfg.blocksPerRunBy?.[sym] ?? cfg.maxBlocksPerRun, to = Math.min(tip, from + per - 1), found: Found[] = [];
  const nums: number[] = []; for (let n = from; n <= to; n++) nums.push(n);
  const got = await mapLimit(nums, 4, async (n) => {                                          // header + one callTracer run per block, a few at a time
    const b = await net.rpc(url, "eth_getBlockByNumber", ["0x" + n.toString(16), false]);
    if (!b) return null;
    return { b, tr: (b.transactions || []).length ? await net.rpc(trace.url, "debug_traceBlockByNumber", ["0x" + n.toString(16), { tracer: "callTracer" }]) : [] };
  });
  let last = cursor ?? from;
  for (let i = 0; i < nums.length; i++) { const g = got[i]; if (!g) break; last = nums[i]; found.push(...internalFromDebugTrace(sym, addrs, g.b, g.tr, nums[i], tip)); }
  return { found, next: last, tip };
}

/** pure: the internal native transfers to watched addresses inside one block's callTracer output */
export function internalFromDebugTrace(sym: string, addrs: string[], block: any, traces: any[], n: number, tip: number): Found[] {
  const want = new Set(addrs.map(lc)), out: Found[] = [];
  (traces || []).forEach((entry: any, i: number) => {
    const tx0 = block.transactions?.[i], root = entry?.result ?? entry, hash = entry?.txHash ?? (typeof tx0 === "string" ? tx0 : tx0?.hash);
    if (!root || !hash || root.error) return;                                                  // a failed transaction moved nothing
    const seen = new Map<string, number>();
    const walk = (f: any) => {
      for (const c of f.calls || []) {
        if (c.error) continue;                                                                 // a failed call and everything below it was rolled back
        const type = String(c.type || "").toUpperCase(), to = c.to ? lc(c.to) : "";
        let v = 0n; try { v = BigInt(c.value || "0x0"); } catch { /* no value */ }
        if ((type === "CALL" || type === "SELFDESTRUCT") && v > 0n && want.has(to)) {          // DELEGATECALL / CALLCODE / STATICCALL never transfer value
          const k = `${hash}|${lc(c.from)}|${v}|${to}`, ord = seen.get(k) ?? 0; seen.set(k, ord + 1);
          out.push({ symbol: sym, network: NETNAME[sym], to: addrs.find((a) => lc(a) === to)!, from: c.from ?? null, hash, ref: `int:${lc(c.from)}:${v}:${ord}`,
            amount: units(v, 18), block: n, blockHash: block.hash, blockTime: Number(BigInt(block.timestamp)), confirmations: tip - n + 1, failed: false });
        }
        walk(c);
      }
    };
    walk(root);
  });
  return out;
}

const TRACE_PAGE = 500, TRACE_ADDR_BATCH = 100;
async function scanEvmTraceFilter(net: Net, cfg: Cfg, sym: "ETH" | "BNB" | "AVAX", addrs: string[], tip: number, from: number, trace: TraceCfg): Promise<EvmScan> {
  const url = cfg.rpc[sym], per = cfg.traceBlocksPerRun ?? 2000, to = Math.min(tip, from + per - 1), want = new Set(addrs.map(lc));
  const items: any[] = [];
  for (let i = 0; i < addrs.length; i += TRACE_ADDR_BATCH) {
    for (let after = 0, guard = 0; ; after += TRACE_PAGE, guard++) {
      const r: any[] = await net.rpc(trace.url, "trace_filter", [{ fromBlock: hexN(from), toBlock: hexN(to), toAddress: addrs.slice(i, i + TRACE_ADDR_BATCH), after, count: TRACE_PAGE }]);
      items.push(...(r || []));
      if (!r || r.length < TRACE_PAGE) break;                                                  // a short page is the last page
      if (guard > 200) throw new Error("trace_filter returned too many results for this block range");
    }
  }
  items.sort((x, y) => (Number(BigInt(x.blockNumber)) - Number(BigInt(y.blockNumber))) || ((x.transactionPosition ?? 0) - (y.transactionPosition ?? 0)) || cmpPath(x.traceAddress, y.traceAddress));
  const found: Found[] = [], heads: Record<string, any> = {}, flat: Record<string, any[]> = {}, seen = new Map<string, number>();
  const head = async (num: string) => (heads[num] ??= await net.rpc(url, "eth_getBlockByNumber", [num, false]));
  for (const it of items) {
    const t = String(it.type || ""), a = it.action || {};
    let toAddr = "", fromAddr: string | null = null, v = 0n;
    if (t === "call" && a.callType === "call") { toAddr = lc(a.to || ""); fromAddr = a.from ?? null; v = BigInt(a.value || "0x0"); }
    else if (t === "suicide") { toAddr = lc(a.refundAddress || ""); fromAddr = a.address ?? null; v = BigInt(a.balance || "0x0"); }
    else continue;                                                                             // reward / create / delegatecall / callcode do not credit a watched address
    if (v <= 0n || !want.has(toAddr)) continue;
    const path: number[] = it.traceAddress || [], top = t === "call" && path.length === 0;
    if (!top && it.error) continue;
    const b = await head(it.blockNumber);
    if (!b || lc(b.hash) !== lc(it.blockHash)) continue;                                       // the block moved while we looked: the next run sees the new truth
    const n = Number(BigInt(it.blockNumber)), mine = addrs.find((x) => lc(x) === toAddr)!;
    let ref = "native", failed = false;
    if (top) failed = !!it.error;                                                              // same as the block walk: a reverted top-level transfer is recorded as failed
    else {
      // a call below a reverted call also moved nothing: look at the whole transaction trace (rare, so one extra request is fine)
      const tr = (flat[it.transactionHash] ??= await net.rpc(trace.url, "trace_transaction", [it.transactionHash]));
      const dead = (tr || []).some((x: any) => x.error && isPrefix(x.traceAddress || [], path));
      if (dead) continue;
      const k = `${it.transactionHash}|${lc(fromAddr || "")}|${v}|${toAddr}`, ord = seen.get(k) ?? 0; seen.set(k, ord + 1);
      ref = `int:${lc(fromAddr || "")}:${v}:${ord}`;
    }
    found.push({ symbol: sym, network: NETNAME[sym], to: mine, from: fromAddr, hash: it.transactionHash, ref, amount: units(v, 18), block: n, blockHash: b.hash,
      blockTime: Number(BigInt(b.timestamp)), confirmations: tip - n + 1, failed });
  }
  return { found, next: to, tip };
}
const cmpPath = (a: number[] = [], b: number[] = []) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1); } return 0; };
const isPrefix = (pre: number[], full: number[]) => pre.length <= full.length && pre.every((x, i) => x === full[i]);

/** Which trace API (if any) does this endpoint offer? `transient` = the answers were errors that do not prove "unsupported" (timeout, 5xx): ask again later. */
const UNSUPPORTED = /method not found|not supported|not available|does not exist|unsupported|disabled|-32601|-32600|not whitelisted|forbidden|\b40[135]\b|upgrade|plan|tier|not enabled|invalid method|unknown method/i;
export async function probeTrace(net: Net, url: string): Promise<{ mode: TraceMode | null; transient: boolean; error?: string }> {
  let tip: number;
  try { tip = Number(BigInt(await net.rpc(url, "eth_blockNumber", []))); } catch (e) { return { mode: null, transient: true, error: errMsg(e) }; }
  let unsupported = 0, last = "";
  try {
    const r = await net.rpc(url, "trace_filter", [{ fromBlock: hexN(Math.max(0, tip - 1)), toBlock: hexN(tip), toAddress: ["0x0000000000000000000000000000000000000001"], count: 1 }]);
    if (Array.isArray(r)) return { mode: "trace_filter", transient: false };
  } catch (e) { last = errMsg(e); if (UNSUPPORTED.test(last)) unsupported++; }
  try {
    const r = await net.rpc(url, "debug_traceBlockByNumber", [hexN(Math.max(0, tip - 1)), { tracer: "callTracer" }]);
    if (Array.isArray(r)) return { mode: "debug_trace", transient: false };
  } catch (e) { last = errMsg(e); if (UNSUPPORTED.test(last)) unsupported++; }
  return { mode: null, transient: unsupported < 2, error: last };
}

/** one known EVM deposit (native, internal or token): is it still in the canonical chain? Returns fresh block data, or null if the chain does not know it. */
export async function recheckEvm(net: Net, cfg: Cfg, sym: string, hash: string, knownBlockHash: string | null): Promise<{ block: number; blockHash: string; blockTime: number | null; confirmations: number; failed: boolean } | null> {
  const chain = cfg.tokens[sym] ? "ETH" : sym, url = cfg.rpc[chain];
  const r = await net.rpc(url, "eth_getTransactionReceipt", [hash]);
  if (!r || !r.blockHash) return null;
  const tip = Number(BigInt(await net.rpc(url, "eth_blockNumber", []))), n = Number(BigInt(r.blockNumber));
  const b = await net.rpc(url, "eth_getBlockByNumber", [r.blockNumber, false]);
  if (!b || lc(b.hash) !== lc(r.blockHash)) return null;                                      // receipt belongs to a block that is no longer canonical
  void knownBlockHash;
  return { block: n, blockHash: b.hash, blockTime: Number(BigInt(b.timestamp)), confirmations: Math.max(1, tip - n + 1), failed: r.status === "0x0" };
}

// ------------------------------------------------------------------------------------------------------- ERC-20 (Ethereum): Transfer(address,address,uint256) logs
// keccak256("Transfer(address,address,uint256)") — the well-known topic0 of every ERC-20 / ERC-721 Transfer event:
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => "0x" + lc(a).replace(/^0x/, "").padStart(64, "0");
const LOG_ADDR_BATCH = 100;                                                                   // providers cap the size of a topic list: ask for the addresses in batches
const RANGE_ERR = /range|limit|too many|10000|exceed|response size|more than/i;
async function getLogsSafe(net: Net, url: string, p: { fromBlock: number; toBlock: number; address: string; topics: unknown[] }, depth = 0): Promise<any[]> {
  try { return (await net.rpc(url, "eth_getLogs", [{ fromBlock: hexN(p.fromBlock), toBlock: hexN(p.toBlock), address: p.address, topics: p.topics }])) || []; }
  catch (e) {
    if (!RANGE_ERR.test(errMsg(e)) || p.fromBlock >= p.toBlock || depth >= 8) throw e;      // "too many results": ask for each half of the block range instead
    const mid = Math.floor((p.fromBlock + p.toBlock) / 2);
    return [...await getLogsSafe(net, url, { ...p, toBlock: mid }, depth + 1), ...await getLogsSafe(net, url, { ...p, fromBlock: mid + 1 }, depth + 1)];
  }
}
export async function scanErc20(net: Net, cfg: Cfg, addrs: string[], cursor: number | null, opts: { overlap?: number; maxBlocks?: number } = {}): Promise<EvmScan> {
  const url = cfg.rpc.ETH, tip = Number(BigInt(await net.rpc(url, "eth_blockNumber", [])));
  const from = cursor == null ? Math.max(0, tip - cfg.backfillBlocks) : Math.max(0, cursor - (opts.overlap ?? REORG_OVERLAP));
  const to = Math.min(tip, from + (opts.maxBlocks ?? cfg.blocksPerRunBy?.ERC20 ?? cfg.maxBlocksPerRun) - 1), found: Found[] = [];
  if (!addrs.length) return { found, next: to, tip };
  for (const [sym, tok] of Object.entries(cfg.tokens)) {
    const logs: any[] = [];
    for (let i = 0; i < addrs.length; i += LOG_ADDR_BATCH) logs.push(...await getLogsSafe(net, url, { fromBlock: from, toBlock: to, address: tok.address, topics: [TRANSFER_TOPIC, null, addrs.slice(i, i + LOG_ADDR_BATCH).map(pad)] }));
    const times: Record<string, number> = {};
    for (const l of logs) {
      if (l.removed || l.topics?.length !== 3 || lc(l.address) !== lc(tok.address)) continue;      // topics.length 4 = an NFT Transfer, not ours
      const toAddr = "0x" + l.topics[2].slice(26), mine = addrs.find((a) => lc(a) === lc(toAddr)); if (!mine) continue;
      const amount = BigInt(l.data); if (amount === 0n) continue;
      const bn = Number(BigInt(l.blockNumber));
      if (times[l.blockHash] == null) { const b = await net.rpc(url, "eth_getBlockByNumber", [l.blockNumber, false]); times[l.blockHash] = b && lc(b.hash) === lc(l.blockHash) ? Number(BigInt(b.timestamp)) : -1; }
      if (times[l.blockHash] < 0) continue;                                                    // the block moved while we looked: next run sees the new truth
      found.push({ symbol: sym, network: "Ethereum (ERC-20)", to: mine, from: "0x" + l.topics[1].slice(26), hash: l.transactionHash, ref: "log" + Number(BigInt(l.logIndex)),
        amount: units(amount, tok.decimals), block: bn, blockHash: l.blockHash, blockTime: times[l.blockHash], confirmations: tip - bn + 1, failed: false });
    }
  }
  return { found, next: to, tip };
}

// ------------------------------------------------------------------------------------------------------- Solana
// Two reads per address:
//   (A) the 25 newest signatures at `confirmed` commitment, only those that are NOT yet finalized: shows an incoming transfer as Pending right away.
//   (B) a FINALIZED sweep: getSignaturesForAddress(before = <resume position>, until = <checkpoint signature>, limit 100) page by page, newest first, until a page
//       is empty (= nothing older than the checkpoint is left). The checkpoint is the newest FINALIZED signature of the last complete sweep.
// The amount is the change of THIS account's lamports; the sender is the fee payer (first signer). Failed transactions (err != null) moved nothing and are skipped.
export type SolState = { checkpoint: string | null; resumeBefore: string | null; newest: string | null };
const SOL_PAGE = 100;
export async function scanSol(net: Net, cfg: Cfg, addrs: WatchAddr[], progress: Progress, isFinal: (hashes: string[]) => Promise<Set<string>>): Promise<SweepResult> {
  const url = cfg.rpc.SOL, res = newSweep(), maxP = pagesPerRun(cfg);
  const handle = async (a: string, sigs: any[], seen: Set<string>) => {
    const fresh = sigs.filter((s) => s && !s.err && !seen.has(s.signature)); fresh.forEach((s) => seen.add(s.signature));
    const done = fresh.length ? await isFinal(fresh.map((s) => s.signature)) : new Set<string>();
    for (const s of fresh) {
      if (done.has(s.signature)) continue;                                                    // already recorded as final: do not re-fetch
      const tx = await net.rpc(url, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: s.confirmationStatus === "finalized" ? "finalized" : "confirmed" }]);
      if (!tx) continue;
      const f = solFrom(a, s.signature, tx, s.confirmationStatus === "finalized"); if (f) res.found.push(f);
    }
  };
  for (const w of addrs) {
    const a = w.address, key = `sol:${a}`, seen = new Set<string>();
    try {
      const st: SolState = { checkpoint: null, resumeBefore: null, newest: null, ...((await progress.get(key)) || {}) };
      const recent: any[] = await net.rpc(url, "getSignaturesForAddress", [a, { limit: 25, commitment: "confirmed" }]);
      await handle(a, (recent || []).filter((s) => s.confirmationStatus !== "finalized"), seen);
      let before: string | null = st.resumeBefore, newest = st.newest, done = false, firstPage = st.resumeBefore == null;
      for (let pages = 0; !done && pages < maxP; pages++) {
        const p: any = { limit: SOL_PAGE, commitment: "finalized" }; if (before) p.before = before; if (st.checkpoint) p.until = st.checkpoint;
        const page: any[] = (await net.rpc(url, "getSignaturesForAddress", [a, p])) || [];
        if (!page.length) { done = true; break; }
        if (firstPage) { newest = page[0].signature; firstPage = false; }
        await handle(a, page, seen);
        before = page[page.length - 1].signature;
        const bt = page[page.length - 1].blockTime; if (w.since != null && bt != null && Number(bt) < w.since) done = true;
      }
      const next: SolState = done ? { checkpoint: newest ?? st.checkpoint, resumeBefore: null, newest: null } : { checkpoint: st.checkpoint, resumeBefore: before, newest };
      if (!done) res.unfinished++;
      if (!same(next, { checkpoint: st.checkpoint, resumeBefore: st.resumeBefore, newest: st.newest })) res.updates.push({ key, state: next });
    } catch (e) { res.errors.push(`SOL ${shortA(a)}: ${errMsg(e)}`); }
  }
  return res;
}
export function solFrom(addr: string, sig: string, tx: any, finalized: boolean): Found | null {
  const keys: any[] = tx.transaction?.message?.accountKeys || [], i = keys.findIndex((k) => (k.pubkey ?? k) === addr);
  if (i < 0 || !tx.meta) return null;
  const delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
  if (delta <= 0n) return null;
  const payer = keys.find((k) => k.signer)?.pubkey ?? null;
  return { symbol: "SOL", network: "Solana", to: addr, from: payer, hash: sig, ref: "0", amount: units(delta, 9), block: Number(tx.slot), blockHash: null,
    blockTime: tx.blockTime ?? null, confirmations: finalized ? 1 : 0, failed: !!tx.meta.err };
}
export async function recheckSol(net: Net, cfg: Cfg, hash: string): Promise<{ confirmations: number; failed: boolean } | null> {
  const v = (await net.rpc(cfg.rpc.SOL, "getSignatureStatuses", [[hash], { searchTransactionHistory: true }])).value?.[0];
  if (!v) return null; return { confirmations: v.confirmationStatus === "finalized" ? 1 : 0, failed: !!v.err };
}

// ------------------------------------------------------------------------------------------------------- XRP
// account_tx, paged with `marker`. delivered_amount (NOT Amount: a partial payment delivers less). Validated = final (confirmations 1).
// A fresh sweep asks only for ledgers from (checkpoint - 2) up to the newest validated ledger, and follows `marker` until there is none. The ledger_index_max of
// the FIRST page is pinned for the rest of the sweep (as the XRPL docs advise) and becomes the next checkpoint once the sweep is complete.
export type XrpState = { checkpoint: number | null; marker: unknown | null; pinMax: number | null; min: number | null };
export async function scanXrp(net: Net, cfg: Cfg, addrs: WatchAddr[], progress: Progress): Promise<SweepResult> {
  const res = newSweep(), maxP = pagesPerRun(cfg);
  for (const w of addrs) {
    const a = w.address, key = `xrp:${a}`;
    try {
      const st: XrpState = { checkpoint: null, marker: null, pinMax: null, min: null, ...((await progress.get(key)) || {}) };
      const resume = st.marker != null;
      const min = resume ? (st.min ?? -1) : st.checkpoint != null ? Math.max(-1, st.checkpoint - 2) : -1;
      let pin = resume ? st.pinMax : null, marker: unknown | null = resume ? st.marker : null, done = false, gone = false;
      for (let pages = 0; !done && pages < maxP; pages++) {
        const params: Record<string, unknown> = { account: a, ledger_index_min: min, ledger_index_max: pin ?? -1, limit: 100, forward: false };
        if (marker != null) params.marker = marker;
        const r = await net.rpc(cfg.rpc.XRP, "account_tx", [params]);
        if (r.error === "actNotFound") { gone = true; done = true; break; }                // the account does not exist yet: nothing to find, nothing to store
        if (r.error) throw new Error(String(r.error));
        if (pin == null) pin = Number(r.ledger_index_max);
        for (const t of r.transactions || []) { const f = xrpFrom(a, t); if (f) res.found.push(f); }
        if (!r.marker) { done = true; break; }
        marker = r.marker;
        const last = (r.transactions || []).at(-1), d = (last?.tx || last?.tx_json)?.date;
        if (w.since != null && d != null && Number(d) + 946684800 < w.since) done = true;
      }
      if (gone) continue;
      const next: XrpState = done ? { checkpoint: pin, marker: null, pinMax: null, min: null } : { checkpoint: st.checkpoint, marker, pinMax: pin, min };
      if (!done) res.unfinished++;
      if (!same(next, st)) res.updates.push({ key, state: next });
    } catch (e) { res.errors.push(`XRP ${shortA(a)}: ${errMsg(e)}`); }
  }
  return res;
}
export function xrpFrom(addr: string, t: any): Found | null {
  const tx = t.tx || t.tx_json, meta = t.meta; if (!tx || tx.TransactionType !== "Payment" || tx.Destination !== addr) return null;
  const d = meta?.delivered_amount; if (typeof d !== "string") return null;                   // issued currencies (objects) are not XRP
  const ok = meta.TransactionResult === "tesSUCCESS";
  return { symbol: "XRP", network: "XRP Ledger", to: addr, from: tx.Account, hash: String(tx.hash || t.hash).toUpperCase(), ref: "0",
    amount: units(BigInt(d), 6), block: Number(t.ledger_index ?? tx.ledger_index ?? 0) || null, blockHash: null,
    blockTime: tx.date != null ? Number(tx.date) + 946684800 : null, confirmations: t.validated ? 1 : 0, failed: !ok };
}
export async function recheckXrp(net: Net, cfg: Cfg, hash: string): Promise<{ confirmations: number; failed: boolean } | null> {
  const t = await net.rpc(cfg.rpc.XRP, "tx", [{ transaction: hash, binary: false }]);
  if (t.error === "txnNotFound") return null; if (t.error) throw new Error(String(t.error));
  return { confirmations: t.validated ? 1 : 0, failed: t.meta?.TransactionResult !== "tesSUCCESS" };
}

// ------------------------------------------------------------------------------------------------------- TRON (TronGrid)
// /v1/accounts/:a/transactions?only_to=true&limit=200 paged with the `fingerprint` TronGrid returns in meta. A fresh sweep asks for block_timestamp >=
// (checkpoint - 15 min) and follows the fingerprint until there is none; the checkpoint is the newest block_timestamp of the first page of the last complete sweep.
// (Plain TRX payments only. TRX paid by a smart contract is NOT in this list: scanTrxInternal() below reads it from the solidified blocks.)
export type TrxState = { checkpoint: number | null; fingerprint: string | null; min: number | null; newest: number | null };
const TRX_OVERLAP_MS = 15 * 60_000;
export async function scanTrx(net: Net, cfg: Cfg, addrs: WatchAddr[], progress: Progress): Promise<SweepResult> {
  const base = cfg.api.TRX, res = newSweep(), maxP = pagesPerRun(cfg);
  for (const w of addrs) {
    const a = w.address, key = `trx:${a}`;
    try {
      const st: TrxState = { checkpoint: null, fingerprint: null, min: null, newest: null, ...((await progress.get(key)) || {}) };
      const resume = st.fingerprint != null;
      const min = resume ? st.min : st.checkpoint != null ? st.checkpoint - TRX_OVERLAP_MS : w.since != null ? w.since * 1000 : null;
      let fp: string | null = resume ? st.fingerprint : null, newest = resume ? st.newest : null, done = false, first = !resume;
      for (let pages = 0; !done && pages < maxP; pages++) {
        const r = await net.get(`${base}/v1/accounts/${a}/transactions?only_to=true&limit=200&order_by=block_timestamp,desc` + (min != null ? `&min_timestamp=${min}` : "") + (fp ? `&fingerprint=${encodeURIComponent(fp)}` : ""));
        if (r && r.success === false) throw new Error("TronGrid: " + String(r.error || "request failed").slice(0, 100));
        const data: any[] = r?.data || [];
        if (first) { first = false; newest = data.reduce((m: number | null, t: any) => (t.block_timestamp != null && (m == null || Number(t.block_timestamp) > m) ? Number(t.block_timestamp) : m), null); }
        for (const t of data) { const f = trxFrom(a, t); if (f) res.found.push(f); }
        fp = r?.meta?.fingerprint ?? null;
        if (!fp || !data.length) { done = true; break; }
      }
      const next: TrxState = done ? { checkpoint: newest ?? st.checkpoint, fingerprint: null, min: null, newest: null } : { checkpoint: st.checkpoint, fingerprint: fp, min, newest };
      if (!done) res.unfinished++;
      if (!same(next, st)) res.updates.push({ key, state: next });
    } catch (e) { res.errors.push(`TRX ${shortA(a)}: ${errMsg(e)}`); }
  }
  return res;
}
/** TronGrid's account endpoint lists a tx once it is in a block; it carries no solidified flag, so confirmations come from the solidity node (see recheckTrx). */
export function trxFrom(addr: string, t: any, solid = false): Found | null {
  const c = t.raw_data?.contract?.[0]; if (!c || c.type !== "TransferContract") return null;
  const v = c.parameter?.value; if (!v || v.to_address !== addr || !(Number(v.amount) > 0)) return null;
  return { symbol: "TRX", network: "TRON", to: addr, from: v.owner_address ?? null, hash: t.txID, ref: "0", amount: units(BigInt(v.amount), 6),
    block: t.blockNumber ?? null, blockHash: null, blockTime: t.block_timestamp ? Math.floor(Number(t.block_timestamp) / 1000) : null,
    confirmations: solid ? 1 : 0, failed: t.ret?.[0]?.contractRet != null && t.ret[0].contractRet !== "SUCCESS" };
}
export async function recheckTrx(net: Net, cfg: Cfg, hash: string): Promise<{ confirmations: number; failed: boolean } | null> {
  const sol = await net.post(cfg.api.TRX + "/walletsolidity/gettransactioninfobyid", { value: hash });
  if (sol && sol.blockNumber) { const t = await net.post(cfg.api.TRX + "/walletsolidity/gettransactionbyid", { value: hash }); return { confirmations: 1, failed: t?.ret?.[0]?.contractRet !== "SUCCESS" }; }
  const full = await net.post(cfg.api.TRX + "/wallet/gettransactioninfobyid", { value: hash });
  return full && full.blockNumber ? { confirmations: 0, failed: false } : null;
}

// ------------------------------------------------------------------------------------------------------- TRON: TRX moved by a SMART CONTRACT (internal transfers)  — phase 40
// The account endpoint above lists only TransferContract (a plain TRX payment). When a contract pays TRX to a watched address (an exchange payout contract, a
// forwarder, a multisig, a swap) the money arrives as an INTERNAL transaction of a TriggerSmartContract: it never appears in that list. It is read here by walking
// the SOLIDIFIED blocks (irreversible, so no reorg handling is needed) and looking at `internal_transactions` in each transaction's info:
//   POST /walletsolidity/getnowblock                          -> the newest solidified block number
//   POST /walletsolidity/gettransactioninfobyblocknum {num}   -> one info per transaction in that block; internal_transactions[] = { caller_address, transferTo_address (hex),
//                                                                callValueInfo:[{callValue, tokenId?}], rejected, note }
// Only TRX is counted (a callValueInfo entry WITHOUT a tokenId); TRC-10 / TRC-20 are not (this app supports neither). Rejected internal transfers and every transfer of a
// transaction that did not end in SUCCESS are skipped. Its own cursor (`trxint:TRX`), so top-level scanning can never move it. NOT run against a live node by the author.
const B58A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** base58check TRON address -> its 21-byte hex ("41…"), lowercase; null when it does not decode to 25 bytes starting with 0x41 */
export function tronHexOf(addr: string): string | null {
  let v = 0n; for (const ch of addr) { const d = B58A.indexOf(ch); if (d < 0) return null; v = v * 58n + BigInt(d); }
  let h = v.toString(16); if (h.length % 2) h = "0" + h;
  const lead = [...addr].findIndex((c) => c !== "1"); h = "00".repeat(lead < 0 ? addr.length : lead) + h;
  return h.length === 50 && h.startsWith("41") ? h.slice(0, 42) : null;
}
/** 21-byte hex ("41…") -> base58check TRON address */
export async function tronAddressOf(hex21: string): Promise<string> {
  const b = Uint8Array.from(hex21.match(/../g) ?? [], (x) => parseInt(x, 16));
  const sha = async (x: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", x));
  const chk = (await sha(await sha(b))).slice(0, 4), all = new Uint8Array(25); all.set(b); all.set(chk, 21);
  let v = 0n; for (const x of all) v = v * 256n + BigInt(x);
  let out = ""; while (v > 0n) { out = B58A[Number(v % 58n)] + out; v /= 58n; }
  return out;
}
const hex41 = (h: unknown): string => { const x = lc(String(h || "")).replace(/^0x/, ""); return x.length === 40 ? "41" + x : x; };

/** pure: the internal TRX transfers to watched addresses inside ONE solidified block's transaction infos */
export async function trxInternalFrom(want: Map<string, string>, infos: unknown, n: number): Promise<Found[]> {
  const list: any[] = Array.isArray(infos) ? infos : [];
  const out: Found[] = [];
  for (const info of list) {
    const id = info?.id; if (!id || !Array.isArray(info.internal_transactions) || !info.internal_transactions.length) continue;
    if (info.result === "FAILED" || (info.receipt?.result != null && info.receipt.result !== "SUCCESS")) continue;          // reverted / out of energy: every internal transfer was rolled back
    const seen = new Map<string, number>();
    for (const it of info.internal_transactions) {
      if (it?.rejected) continue;
      const to = hex41(it.transferTo_address), mine = want.get(to); if (!mine) continue;
      let sun = 0n; for (const cv of it.callValueInfo || []) if (cv && (cv.tokenId == null || cv.tokenId === "") && cv.callValue != null) { try { sun += BigInt(cv.callValue); } catch { /* not a number */ } }
      if (sun <= 0n) continue;
      const caller = hex41(it.caller_address), k = `${id}|${caller}|${sun}|${to}`, ord = seen.get(k) ?? 0; seen.set(k, ord + 1);
      out.push({ symbol: "TRX", network: "TRON", to: mine, from: caller.length === 42 ? await tronAddressOf(caller) : null, hash: String(id), ref: `int:${caller}:${sun}:${ord}`, amount: units(sun, 6),
        block: info.blockNumber != null ? Number(info.blockNumber) : n, blockHash: null, blockTime: info.blockTimeStamp ? Math.floor(Number(info.blockTimeStamp) / 1000) : null,
        confirmations: 1, failed: false });                                                                                 // solidified = the policy's "1 confirmation"
    }
  }
  return out;
}

/** Walk solidified blocks (cursor = the last block fully read). Throws when a node cannot serve even the first block, so the caller can report that internal transfers are NOT monitored. */
export async function scanTrxInternal(net: Net, cfg: Cfg, addrs: string[], cursor: number | null, opts: { maxBlocks?: number } = {}): Promise<EvmScan> {
  const base = cfg.api.TRX, now = await net.post(base + "/walletsolidity/getnowblock", {}), tip = Number(now?.block_header?.raw_data?.number);
  if (!Number.isFinite(tip) || tip <= 0) throw new Error("the TRON solidity node returned no block number" + (now?.Error ? ": " + String(now.Error).slice(0, 80) : ""));
  const want = new Map<string, string>(); for (const a of addrs) { const h = tronHexOf(a); if (h) want.set(h, a); }
  const from = cursor == null ? Math.max(0, tip - cfg.backfillBlocks) : cursor + 1;
  if (from > tip) return { found: [], next: cursor ?? tip, tip };
  const per = opts.maxBlocks ?? cfg.blocksPerRunBy?.TRX ?? cfg.maxBlocksPerRun, to = Math.min(tip, from + per - 1);
  const nums: number[] = []; for (let n = from; n <= to; n++) nums.push(n);
  const got = await mapLimit(nums, 4, async (n) => { try { return { ok: true as const, r: await net.post(base + "/walletsolidity/gettransactioninfobyblocknum", { num: n }) }; } catch (e) { return { ok: false as const, e }; } });
  const found: Found[] = []; let last = cursor ?? from - 1;
  for (let i = 0; i < nums.length; i++) {
    const g = got[i];
    if (!g.ok) { if (last < from) throw g.e; break; }                                                                       // stop at the first unreadable block: it is read again next run
    const r = g.r;
    if (r && !Array.isArray(r) && typeof r === "object" && Object.keys(r).length && (r as any).Error) throw new Error("TRON node: " + String((r as any).Error).slice(0, 100));
    if (!Array.isArray(r) && !(r && typeof r === "object" && Object.keys(r).length === 0)) throw new Error("unexpected answer for block " + nums[i]);   // [] or {} = a block without transactions; anything else is not an answer
    found.push(...await trxInternalFrom(want, r, nums[i])); last = nums[i];
  }
  return { found, next: last, tip };
}
