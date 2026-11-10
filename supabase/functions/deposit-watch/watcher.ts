// Veltrix · deposit-watch · the SCAN ORCHESTRATOR (no Deno, no network library: everything is injected, so it is tested offline).
//
// One scan = one pass over every network, each network (a "lane") guarded by its own database LEASE (scan_lock_acquire):
//   lease -> prove the network is the right one -> scan new transfers (paged, resumable) -> record each one -> re-verify open deposits -> mirror balances
// Two scheduled runs that overlap never work on the same network: the second finds the lease taken and skips that lane (reported in `busy`).
// Every cursor / progress write is FENCED by the lease, so even a run that was too slow and lost its lease cannot overwrite the run that took over.
// A network that fails its identity check is not scanned and its balances are NOT mirrored (nothing from a wrong network is ever shown as a balance).
// Signed-in users never reach this file's scan: userStatus() is a database read.
import * as S from "./scan.ts";
import * as N from "../_shared/netcheck.ts";
import { emptyResponse, failResponse, userResponse, type WatchResponse } from "./contract.ts";

export const NAME: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", USDT: "Tether", BNB: "BNB", SOL: "Solana", XRP: "XRP", USDC: "USDC", TRX: "TRON", AVAX: "Avalanche", SHIB: "Shiba Inu", LINK: "Chainlink", LTC: "Litecoin" };
const TOKENS = ["USDT", "USDC", "SHIB", "LINK"];
type Lane = { key: string; syms: string[] };
export const LANES: Lane[] = [
  { key: "BTC", syms: ["BTC"] }, { key: "LTC", syms: ["LTC"] }, { key: "ETH", syms: ["ETH", ...TOKENS] }, { key: "BNB", syms: ["BNB"] },
  { key: "AVAX", syms: ["AVAX"] }, { key: "SOL", syms: ["SOL"] }, { key: "XRP", syms: ["XRP"] }, { key: "TRX", syms: ["TRX"] },
];
const LAG_WARN: Record<string, number> = { ETH: 100, BNB: 1500, AVAX: 600 };                       // roughly 20 minutes of blocks

export type WalletRow = { user_id: string; addresses: any; test_expires_at?: string | null; created_at?: string | null };
export type Db = { rpc(name: string, args: Record<string, unknown>): Promise<any>; wallets(): Promise<WalletRow[]> };
export type TraceSetting = { mode: "auto" | "off" | "trace_filter" | "debug_trace"; url: string };
export type Deps = {
  cfg: S.Cfg; net: S.Net; db: Db;
  expected: { chainId: Record<"ETH" | "BNB" | "AVAX", number>; genesis: { BTC: string; LTC: string; SOL: string; TRX: string }; xrpNetworkId: number };
  trace: Record<"ETH" | "BNB" | "AVAX", TraceSetting>;
  /** contract-sent TRX: "auto" (default) walks solidified blocks; "off" disables it (a warning says so) */
  trxInternal?: "auto" | "off";
  prices?: () => Promise<Record<string, number> | null>;
  now?: () => number; uuid?: () => string; budgetMs?: number; priceMinSecs?: number; leaseSecs?: number; maxChunks?: number;
  cache?: Map<string, { at: number; v: any }>;                                                       // identity / probe answers, kept for a few minutes per isolate
};
class LostLease extends Error {}
const msg = (e: unknown) => String((e as Error)?.message || e).slice(0, 160);
const lcIf = (s: string, a: string) => (/^(0x|bc1|ltc1)/i.test(a) ? a.toLowerCase() : a);
const keyOf = (s: string, a: string) => s + "|" + lcIf(s, a);

/** the confirmed on-chain balance, or null when it could not be read (never "0" for an error) */
export async function balanceOf(net: S.Net, cfg: S.Cfg, sym: string, addr: string): Promise<string | null> {
  try {
    if (sym === "BTC" || sym === "LTC") { const j = await net.get(`${cfg.api[sym]}/address/${addr}`); return S.units(BigInt(j.chain_stats.funded_txo_sum) - BigInt(j.chain_stats.spent_txo_sum), 8); }
    if (sym === "ETH" || sym === "BNB" || sym === "AVAX") return S.units(BigInt(await net.rpc(cfg.rpc[sym], "eth_getBalance", [addr, "latest"])), 18);
    if (cfg.tokens[sym]) { const t = cfg.tokens[sym], data = "0x70a08231" + addr.toLowerCase().replace("0x", "").padStart(64, "0"); return S.units(BigInt(await net.rpc(cfg.rpc.ETH, "eth_call", [{ to: t.address, data }, "latest"])), t.decimals); }
    if (sym === "SOL") return S.units(BigInt((await net.rpc(cfg.rpc.SOL, "getBalance", [addr, { commitment: "finalized" }])).value), 9);
    if (sym === "TRX") { const j = await net.get(`${cfg.api.TRX}/v1/accounts/${addr}?only_confirmed=true`); if (!j.success) return null; return S.units(BigInt((j.data && j.data[0] && j.data[0].balance) || 0), 6); }
    if (sym === "XRP") { const r = await net.rpc(cfg.rpc.XRP, "account_info", [{ account: addr, ledger_index: "validated" }]); if (r.error === "actNotFound") return "0"; if (!r.account_data) return null; return S.units(BigInt(r.account_data.Balance), 6); }
  } catch (_) { return null; }
  return null;
}

/** a signed-in user: read their own wallet state. NO blockchain access, NO scan. */
export async function userStatus(deps: Pick<Deps, "db" | "now">, userId: string): Promise<WatchResponse> {
  const now = (deps.now ?? Date.now)();
  try { return userResponse(await deps.db.rpc("wallet_status_for", { p_user: userId }), now); }
  catch (e) { return failResponse("user", "Could not read your wallet status: " + msg(e) + " (is schema_phase39 installed?)", now); }
}

export async function runScan(deps: Deps): Promise<WatchResponse> {
  const { cfg, net, db } = deps, now = deps.now ?? Date.now, uuid = deps.uuid ?? (() => crypto.randomUUID());
  const t0 = now(), deadline = t0 + (deps.budgetMs ?? 110_000), leaseSecs = deps.leaseSecs ?? 180, cache = deps.cache ?? new Map();
  const resp = emptyResponse("scan", t0), err = (where: string, e: unknown) => { resp.errors.push(where + ": " + (typeof e === "string" ? e : msg(e))); };
  const rpcdb = async (name: string, args: Record<string, unknown>) => db.rpc(name, args);
  const cached = async <T>(k: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => { const c = cache.get(k); if (c && now() - c.at < ttlMs) return c.v; const v = await fn(); cache.set(k, { at: now(), v }); return v; };

  // wallets ---------------------------------------------------------------------------------------------------------------------------
  let rows: WalletRow[];
  try { rows = await db.wallets(); } catch (e) { return failResponse("scan", "could not read wallets: " + msg(e), t0); }
  const live = rows.filter((w) => !(w.test_expires_at && Date.parse(w.test_expires_at) <= t0));
  const owner = new Map<string, string>(), watch: Record<string, S.WatchAddr[]> = {}, targets: { user: string; sym: string; addr: string; net: string | null }[] = [];
  for (const w of live) for (const a of Array.isArray(w.addresses) ? w.addresses : []) {
    const sym = String(a.symbol || "").toUpperCase(); if (!sym || !a.address || !NAME[sym]) continue;
    const since = w.created_at ? Math.floor(Date.parse(w.created_at) / 1000) - 86400 : null;      // a day of margin; record_chain_deposit has the final say
    owner.set(keyOf(sym, a.address), w.user_id); (watch[sym] ||= []).push({ address: a.address, since: Number.isFinite(since as number) ? since : null });
    targets.push({ user: w.user_id, sym, addr: a.address, net: a.network || null });
  }
  let open: any[] = []; try { open = (await rpcdb("chain_deposits_open", {})) || []; } catch (e) { err("open", e); }
  const openKey = new Map<string, any>(open.map((d) => [d.symbol + "|" + d.tx_hash + "|" + d.ref, d]));

  // prices: at most once per priceMinSecs, by one run at a time -------------------------------------------------------------------------------
  if (deps.prices) try {
    const me = uuid();
    if (await rpcdb("scan_lock_acquire", { p_name: "deposit-scan:prices", p_owner: me, p_secs: 60 }) === true) {
      try {
        const at = Number(await rpcdb("chain_cursor_get", { p_key: "prices:at" }) ?? 0);
        if (t0 / 1000 - at >= (deps.priceMinSecs ?? 120)) {
          const p = await deps.prices();
          if (p) { for (const [sym, usd] of Object.entries(p)) if (usd > 0) await rpcdb("set_asset_price", { p_symbol: sym, p_usd: usd }); await rpcdb("chain_cursor_set_fenced", { p_key: "prices:at", p_height: Math.floor(t0 / 1000), p_lock: "deposit-scan:prices", p_owner: me }); }
        }
      } finally { try { await rpcdb("scan_lock_release", { p_name: "deposit-scan:prices", p_owner: me }); } catch (_) { /* expires */ } }
    }
  } catch (_) { /* keep previous prices */ }

  let ran = 0;
  // one lane ----------------------------------------------------------------------------------------------------------------------------
  const runLane = async (lane: Lane) => {
    const syms = lane.syms.filter((s) => watch[s]?.length), openHere = open.filter((d) => lane.syms.includes(d.symbol));
    if (!syms.length && !openHere.length) return;
    const lock = "deposit-scan:" + lane.key, me = uuid();
    let got: unknown;
    try { got = await rpcdb("scan_lock_acquire", { p_name: lock, p_owner: me, p_secs: leaseSecs }); }
    catch (e) { err(lane.key, "could not take the scan lease (" + msg(e) + "). Is schema_phase39 installed? Nothing was scanned."); return; }
    if (got !== true) { resp.busy.push(lane.key); return; }
    ran++;
    const fence = async (ok: Promise<unknown>) => { if ((await ok) !== true) throw new LostLease(); };
    const setCursor = (k: string, h: number) => fence(rpcdb("chain_cursor_set_fenced", { p_key: k, p_height: h, p_lock: lock, p_owner: me }));
    const laneErrors: string[] = [], laneWarn: string[] = [], detail: Record<string, unknown> = {};
    const lerr = (e: unknown) => { const t = typeof e === "string" ? e : msg(e); laneErrors.push(t); err(lane.key, t); };
    const recordAll = async (fs: S.Found[]): Promise<number> => {
      let failed = 0; resp.scanned += fs.length;
      for (const f of fs) {
        try {
          const uid = owner.get(keyOf(f.symbol, f.to)); if (!uid) continue;
          const o = openKey.get(f.symbol + "|" + f.hash + "|" + f.ref);
          if (o && o.confirmations > 0 && f.confirmations === 0 && !f.blockHash) { await rpcdb("chain_deposit_missing", { p_id: o.id }); resp.missing++; continue; }
          const r = await rpcdb("record_chain_deposit", { p_user: uid, p_symbol: f.symbol, p_network: f.network, p_to: f.to, p_from: f.from, p_hash: f.hash, p_ref: f.ref, p_amount: f.amount,
            p_block: f.block, p_block_hash: f.blockHash, p_block_time: f.blockTime ? new Date(f.blockTime * 1000).toISOString() : null, p_confs: f.confirmations, p_failed: f.failed, p_name: NAME[f.symbol] || null });
          resp.recorded++; if (r?.created) resp.created++; if (r?.reorg) resp.reorged++;
        } catch (e) { failed++; lerr(`record ${f.symbol} ${f.hash.slice(0, 10)}: ${msg(e)}`); }
      }
      return failed;
    };
    const progress = async (addrs: S.WatchAddr[], prefix: string): Promise<S.Progress> => {
      const keys = addrs.map((a) => prefix + a.address), all: Record<string, any> = {};
      for (let i = 0; i < keys.length; i += 200) Object.assign(all, (await rpcdb("scan_progress_get_many", { p_keys: keys.slice(i, i + 200) })) || {});
      return { get: async (k) => all[k] ?? null };
    };
    /** record what a sweep found, THEN (only if everything was recorded) store its progress */
    const finishSweep = async (r: S.SweepResult) => {
      const failed = await recordAll(r.found);
      r.errors.forEach(lerr); resp.unfinished += r.unfinished;
      if (failed) return;                                                                         // nothing is marked as seen; the next run reads it again
      for (const u of r.updates) await fence(rpcdb("scan_progress_set_fenced", { p_key: u.key, p_state: u.state, p_lock: lock, p_owner: me }));
    };
    const isFinal = (sym: string) => async (hashes: string[]) => { const s = new Set<string>(); for (let i = 0; i < hashes.length; i += 200) for (const h of (await rpcdb("chain_deposits_final", { p_symbol: sym, p_hashes: hashes.slice(i, i + 200) })) || []) s.add(h); return s; };
    const maxChunks = deps.maxChunks ?? 6;
    /** a cursor-driven range scan, in chunks, until caught up or out of time */
    const chase = async (ckey: string, run: (cur: number | null, first: boolean) => Promise<S.EvmScan>, label: string) => {
      const stored = await rpcdb("chain_cursor_get", { p_key: ckey });
      let cur: number | null = stored == null ? null : Number(stored), last: S.EvmScan | null = null;
      for (let i = 0; i < maxChunks && now() < deadline; i++) {
        const r = await run(cur, i === 0); last = r;
        if (await recordAll(r.found)) return { last, stalled: true };                              // do not advance past something that failed to record
        await setCursor(ckey, r.next);
        if (r.next >= r.tip || (cur != null && r.next <= cur && i > 0)) break;
        cur = r.next;
      }
      if (last) detail[label] = { cursor: last.next, tip: last.tip, lag: Math.max(0, last.tip - last.next) };
      return { last, stalled: false };
    };

    try {
      // 1) is this really the intended network? ---------------------------------------------------------------------------------------------
      const check = await verify(lane.key);
      let tokenCheck: N.Health | null = null;
      if (lane.key === "ETH") tokenCheck = check.ok ? await cached("tokens", 600_000, () => N.checkTokens(net, cfg.rpc.ETH, deps.expected.chainId.ETH, cfg.tokens)) : { ok: false, error: check.error, detail: {} };
      await rpcdb("chain_health_set", { p_network: lane.key, p_ok: check.ok, p_error: check.error ?? null, p_detail: check.detail });
      if (tokenCheck) await rpcdb("chain_health_set", { p_network: "ERC20", p_ok: tokenCheck.ok, p_error: tokenCheck.error ?? null, p_detail: tokenCheck.detail });
      if (!check.ok) { lerr(check.error || "network check failed"); return; }                    // wrong / unreachable network: no scan, no balances
      Object.assign(detail, check.detail);
      const tokensOk = !tokenCheck || tokenCheck.ok; if (tokenCheck && !tokenCheck.ok) lerr(tokenCheck.error || "token check failed");

      // 2) scan -----------------------------------------------------------------------------------------------------------------------------
      try {
        if (lane.key === "BTC" || lane.key === "LTC") { const a = watch[lane.key] || []; if (a.length) await finishSweep(await S.scanUtxo(net, cfg, lane.key, a, await progress(a, `utxo:${lane.key}:`))); }
        else if (lane.key === "ETH" || lane.key === "BNB" || lane.key === "AVAX") {
          const sym = lane.key as "ETH" | "BNB" | "AVAX", addrs = (watch[sym] || []).map((w) => w.address);
          if (addrs.length) {
            const c1 = await chase("evm:" + sym, (cur, first) => S.scanEvmNative(net, cfg, sym, addrs, cur, { overlap: first ? S.REORG_OVERLAP : 0 }), "native");
            void c1;
            const tr = await traceFor(sym);
            detail.internalTransfers = tr.mode ?? (tr.transient ? "unknown" : "unsupported");
            if (tr.mode) await chase("evmtrace:" + sym, (cur, first) => S.scanEvmInternal(net, cfg, sym, addrs, cur, { mode: tr.mode!, url: deps.trace[sym].url || cfg.rpc[sym] }, { overlap: first ? S.REORG_OVERLAP : 0 }), "internal");
            else {
              const bad = /trace endpoint is not usable/.test(tr.error || ""), w = `${sym}: internal (contract-call) transfers are NOT monitored: ${bad ? tr.error : tr.transient ? "the trace probe failed (" + (tr.error || "?") + ")" : "this RPC has no trace_filter / debug_traceBlockByNumber"}. Set RPC_TRACE_${sym} to a tracing provider.`;
              if (bad) lerr(w); else { laneWarn.push(w); resp.warnings.push(w); }
            }
          }
          if (lane.key === "ETH" && tokensOk) {
            const ea = [...new Set(TOKENS.flatMap((s) => (watch[s] || []).map((w) => w.address)))];
            if (ea.length) await chase("erc20:ETH", (cur, first) => S.scanErc20(net, cfg, ea, cur, { overlap: first ? S.REORG_OVERLAP : 0 }), "erc20");
          }
          const lag = Number((detail.native as any)?.lag ?? 0); if (lag > (LAG_WARN[sym] ?? 100)) { const w = `${sym}: the scanner is ${lag} blocks behind the chain; new deposits show up late until it catches up`; laneWarn.push(w); resp.warnings.push(w); }
        }
        else if (lane.key === "SOL") { const a = watch.SOL || []; if (a.length) await finishSweep(await S.scanSol(net, cfg, a, await progress(a, "sol:"), isFinal("SOL"))); }
        else if (lane.key === "XRP") { const a = watch.XRP || []; if (a.length) await finishSweep(await S.scanXrp(net, cfg, a, await progress(a, "xrp:"))); }
        else if (lane.key === "TRX") {
          const a = watch.TRX || [];
          if (a.length) {
            const r = await S.scanTrx(net, cfg, a, await progress(a, "trx:")), done = await isFinal("TRX")(r.found.map((f) => f.hash));
            await S.mapLimit(r.found.filter((f) => !done.has(f.hash)), 5, async (f) => { try { const v = await S.recheckTrx(net, cfg, f.hash); if (v) { f.confirmations = v.confirmations; f.failed = v.failed; } } catch (_) { /* stays pending */ } });
            await finishSweep(r);
          }
          // contract-sent TRX (internal transfers): its own cursor, and it can NEVER hide the plain-transfer results above. When it cannot run, that is REPORTED, never silent.
          if (a.length) {
            if (deps.trxInternal === "off") { const w = "TRX: contract-sent (internal) TRX transfers are NOT monitored: TRX_INTERNAL=off. Plain TRX transfers are."; laneWarn.push(w); resp.warnings.push(w); detail.internalTransfers = "off"; }
            else {
              try {
                await chase("trxint:TRX", (cur) => S.scanTrxInternal(net, cfg, a.map((w) => w.address), cur), "internal");
                detail.internalTransfers = "solidified-block walk";
              } catch (e) {
                if (e instanceof LostLease) throw e;
                const t = msg(e), unsupported = /\b(404|405|501)\b|not found|not support|unsupported|does not exist|no block number/i.test(t);
                detail.internalTransfers = unsupported ? "unsupported" : "error";
                const w = `TRX: contract-sent (internal) TRX transfers could NOT be monitored this run (${t}). ${unsupported ? "This TRON API does not serve /walletsolidity/gettransactioninfobyblocknum: use a provider that does (TronGrid with an API key does)." : "It is retried every run from the saved position."} Plain TRX transfers are still scanned.`;
                if (unsupported) { laneWarn.push(w); resp.warnings.push(w); } else lerr(w);
              }
            }
          }
        }
      } catch (e) { if (e instanceof LostLease) throw e; lerr(msg(e)); }

      // 3) re-verify open / recently final deposits (reorg watch). Stalest first (the database sorts them), a bounded number per run. -----------
      for (const d of openHere.slice(0, 120)) {
        if (now() > deadline) break;
        if (TOKENS.includes(d.symbol) && !tokensOk) continue;
        try {
          let r: { confirmations: number; failed: boolean; block?: number; blockHash?: string; blockTime?: number | null } | null;
          if (d.symbol === "BTC" || d.symbol === "LTC") { const f = await S.recheckUtxo(net, cfg, d.symbol, d.tx_hash, d.to, d.ref); r = f && { confirmations: f.confirmations, failed: false, block: f.block ?? undefined, blockHash: f.blockHash ?? undefined, blockTime: f.blockTime }; }
          else if (d.symbol === "SOL") r = await S.recheckSol(net, cfg, d.tx_hash);
          else if (d.symbol === "XRP") r = await S.recheckXrp(net, cfg, d.tx_hash);
          else if (d.symbol === "TRX") r = await S.recheckTrx(net, cfg, d.tx_hash);
          else r = await S.recheckEvm(net, cfg, d.symbol, d.tx_hash, d.block_hash);
          resp.rechecked++;
          if (r === null) { const st = await rpcdb("chain_deposit_missing", { p_id: d.id }); resp.missing++; if (st === "dropped" || st === "reorged") resp.dropped++; continue; }
          const res = await rpcdb("record_chain_deposit", { p_user: d.user_id, p_symbol: d.symbol, p_network: d.network, p_to: d.to, p_from: d.from, p_hash: d.tx_hash, p_ref: d.ref, p_amount: d.amount,
            p_block: r.block ?? null, p_block_hash: r.blockHash ?? null, p_block_time: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null, p_confs: r.confirmations, p_failed: r.failed, p_name: null });
          if (res?.reorg) resp.reorged++;
        } catch (e) { lerr("recheck " + d.symbol + ": " + msg(e)); }                              // a provider error never marks anything missing
      }

      // 4) balances: only for a verified network ----------------------------------------------------------------------------------------------
      const mine = targets.filter((t) => lane.syms.includes(t.sym) && !(TOKENS.includes(t.sym) && !tokensOk));
      await S.mapLimit(mine, 6, async (t) => {
        if (now() > deadline) return;
        const bal = await balanceOf(net, cfg, t.sym, t.addr);
        if (bal == null) { lerr(`balance ${t.sym} unreadable (skipped, not zeroed)`); return; }
        try { await rpcdb("apply_chain_balance", { p_user: t.user, p_symbol: t.sym, p_network: t.net, p_address: t.addr, p_balance: bal, p_name: NAME[t.sym] || null }); resp.balancesUpdated++; } catch (e) { lerr("apply " + t.sym + ": " + msg(e)); }
      });
      await rpcdb("chain_health_set", { p_network: lane.key, p_ok: laneErrors.length === 0, p_error: laneErrors[0] ?? null, p_detail: { ...detail, warnings: laneWarn } });
    } catch (e) {
      if (e instanceof LostLease) err(lane.key, "lease lost to another run; stopped without writing further progress");
      else { err(lane.key, e); try { await rpcdb("chain_health_set", { p_network: lane.key, p_ok: false, p_error: msg(e), p_detail: detail }); } catch (_) { /* best effort */ } }
    } finally { try { await rpcdb("scan_lock_release", { p_name: lock, p_owner: me }); } catch (_) { /* the lease expires by itself */ } }
  };

  const verify = (key: string): Promise<N.Health> => cached("id:" + key, 120_000, async () => {
    const c = deps.cfg, e = deps.expected;
    switch (key) {
      case "BTC": case "LTC": return N.checkUtxoApi(net, key, c.api[key], e.genesis[key]);
      case "ETH": case "BNB": case "AVAX": return N.checkEvm(net, key, c.rpc[key], e.chainId[key], { now });
      case "SOL": return N.checkSol(net, c.rpc.SOL, e.genesis.SOL);
      case "XRP": return N.checkXrp(net, c.rpc.XRP, e.xrpNetworkId);
      case "TRX": return N.checkTron(net, c.api.TRX, e.genesis.TRX);
    }
    return { ok: false, error: "unknown network " + key, detail: {} };
  });
  const traceFor = async (sym: "ETH" | "BNB" | "AVAX"): Promise<{ mode: S.TraceMode | null; transient: boolean; error?: string }> => {
    const t = deps.trace[sym];
    if (t.mode === "off") return { mode: null, transient: false, error: "disabled" };
    // a SEPARATE trace endpoint (RPC_TRACE_<SYM>) is a second network connection: prove it is the intended chain and fresh BEFORE anything it says is believed (phase 40)
    if (t.url && t.url !== cfg.rpc[sym]) {
      const h = await cached("id:trace:" + sym, 120_000, () => N.checkEvm(net, sym + " trace", t.url, deps.expected.chainId[sym], { now }));
      if (!h.ok) return { mode: null, transient: false, error: "the trace endpoint is not usable: " + (h.error || "network check failed") };
    }
    if (t.mode !== "auto") return { mode: t.mode, transient: false };
    const url = t.url || cfg.rpc[sym], c = cache.get("trace:" + sym);
    if (c && now() - c.at < (c.v.mode ? 600_000 : c.v.transient ? 60_000 : 1_800_000)) return c.v;
    const v = await S.probeTrace(net, url); cache.set("trace:" + sym, { at: now(), v }); return v;
  };

  await Promise.all(LANES.map(runLane));
  try { await rpcdb("chain_deposit_notify_done", {}); } catch (e) { err("notify", e); }
  if (ran > 0 || resp.errors.length) {
    try { await rpcdb("chain_health_set", { p_network: "_scanner", p_ok: resp.errors.length === 0, p_error: resp.errors[0] ?? null,
      p_detail: { scanned: resp.scanned, recorded: resp.recorded, created: resp.created, balancesUpdated: resp.balancesUpdated, unfinished: resp.unfinished, busy: resp.busy, ms: now() - t0 } }); } catch (_) { /* best effort */ }
  }
  resp.ok = true;
  return resp;
}
