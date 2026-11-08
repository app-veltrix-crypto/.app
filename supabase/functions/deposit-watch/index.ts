// Veltrix · deposit-watch v2 — TRANSACTION-LEVEL deposit tracking + balance mirroring.
// Deploy:  supabase functions deploy deposit-watch --no-verify-jwt   (the function checks the user itself)
// Secrets: CRON_SECRET (SUPABASE_URL / SERVICE_ROLE are provided). Optional RPC/API overrides: see README.md.
// One run =
//   1) live prices
//   2) scan each chain for INDIVIDUAL incoming transfers to Veltrix addresses and record each one (record_chain_deposit: idempotent, unique per tx output)
//   3) re-verify deposits that are not final yet (and recently final ones: reorg watch); a tx the chain stops knowing is marked only after 3 misses in a row
//   4) read the CONFIRMED on-chain balance of every address and mirror it (apply_chain_balance): shown = chain - sends in flight - deposits below policy
// A provider error never changes anything: a failed read is skipped, never treated as "gone" or "zero".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import * as S from "./scan.ts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "access-control-allow-methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";

const GECKO: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", USDT: "tether", BNB: "binancecoin", SOL: "solana", XRP: "ripple", USDC: "usd-coin", TRX: "tron", AVAX: "avalanche-2", SHIB: "shiba-inu", LINK: "chainlink", LTC: "litecoin" };
const NAME: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", USDT: "Tether", BNB: "BNB", SOL: "Solana", XRP: "XRP", USDC: "USDC", TRX: "TRON", AVAX: "Avalanche", SHIB: "Shiba Inu", LINK: "Chainlink", LTC: "Litecoin" };
const cfg: S.Cfg = {
  rpc: { ETH: env("RPC_ETH") || "https://ethereum-rpc.publicnode.com", BNB: env("RPC_BNB") || "https://bsc-rpc.publicnode.com", AVAX: env("RPC_AVAX") || "https://avalanche-c-chain-rpc.publicnode.com",
         SOL: env("RPC_SOL") || "https://api.mainnet-beta.solana.com", XRP: env("RPC_XRP") || "https://s1.ripple.com:51234" },
  api: { BTC: env("API_BTC") || "https://mempool.space/api", LTC: env("API_LTC") || "https://litecoinspace.org/api", TRX: env("API_TRX") || "https://api.trongrid.io" },
  tokens: {   // the SAME contracts payout-send uses (override with TOKEN_* on a test network)
    USDT: { address: env("TOKEN_USDT") || "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: Number(env("TOKEN_DECIMALS_USDT") || 6) },
    USDC: { address: env("TOKEN_USDC") || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: Number(env("TOKEN_DECIMALS_USDC") || 6) },
    SHIB: { address: env("TOKEN_SHIB") || "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: Number(env("TOKEN_DECIMALS_SHIB") || 18) },
    LINK: { address: env("TOKEN_LINK") || "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: Number(env("TOKEN_DECIMALS_LINK") || 18) },
  },
  backfillBlocks: Number(env("DEPOSIT_BACKFILL_BLOCKS") || 300), maxBlocksPerRun: Number(env("DEPOSIT_MAX_BLOCKS_PER_RUN") || 40), required: {}, trongridKey: env("TRONGRID_API_KEY"),
};
const hdr = (): Record<string, string> => (cfg.trongridKey ? { "TRON-PRO-API-KEY": cfg.trongridKey } : {});
const fetchJson = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 120)}`);
  try { return JSON.parse(t); } catch { return t; }           // /blocks/tip/height returns a bare number
};
const net: S.Net = {
  get: (u) => fetchJson(u, { headers: hdr() }),
  post: (u, b) => fetchJson(u, { method: "POST", headers: { "content-type": "application/json", ...hdr() }, body: JSON.stringify(b) }),
  // XRP reports its errors INSIDE result (e.g. actNotFound); scan.ts checks for that. Everything else throws on a JSON-RPC error.
  rpc: async (u, method, params) => { const j = await fetchJson(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200)); return j.result; },
};

// ---- balances (CONFIRMED balance, null when it could not be read) ----
async function balanceOf(sym: string, addr: string): Promise<string | null> {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const rpcdb = async (name: string, args: Record<string, unknown>) => { const { data, error } = await admin.rpc(name, args); if (error) throw new Error(`${name}: ${error.message}`); return data; };

  let onlyUser: string | null = null;
  const secret = env("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") === secret) onlyUser = null;
  else {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data, error } = await admin.auth.getUser(tok);
    if (error || !data.user) return json({ error: "not signed in" }, 401);
    onlyUser = data.user.id;
  }
  const stats = { scanned: 0, recorded: 0, created: 0, reorged: 0, missing: 0, dropped: 0, rechecked: 0, balances: 0, errors: [] as string[] };
  const err = (where: string, e: unknown) => { stats.errors.push(where + ": " + String((e as Error)?.message || e).slice(0, 160)); };

  // 1) prices
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(GECKO).join(",")}&vs_currencies=usd`, { signal: AbortSignal.timeout(12000) });
    if (r.ok) { const p = await r.json(); for (const [sym, id] of Object.entries(GECKO)) if (p[id] && p[id].usd > 0) await admin.rpc("set_asset_price", { p_symbol: sym, p_usd: p[id].usd }); }
  } catch (_) { /* keep previous prices */ }

  // 2) wallets. Scanning always covers EVERY wallet (chain cursors are shared); the balance step is limited to the caller in user mode.
  const { data: all, error: werr } = await admin.from("user_wallets").select("user_id,addresses,test_expires_at");
  if (werr) return json({ error: werr.message }, 500);
  const live = (all || []).filter((w: any) => !(w.test_expires_at && Date.parse(w.test_expires_at) <= Date.now()));
  const owner = new Map<string, string>();                      // "SYMBOL|addr" -> user_id
  const bySym: Record<string, string[]> = {};
  const key = (s: string, a: string) => s + "|" + (/^(0x|bc1|ltc1)/i.test(a) ? a.toLowerCase() : a);
  for (const w of live) for (const a of Array.isArray(w.addresses) ? w.addresses : []) {
    const sym = String(a.symbol || "").toUpperCase(); if (!sym || !a.address || !GECKO[sym]) continue;
    owner.set(key(sym, a.address), w.user_id); (bySym[sym] ||= []).push(a.address);
  }
  const known = new Set<string>();                               // final SOL deposits already recorded (lets SOL skip re-fetching)
  try { const { data } = await admin.from("transactions").select("tx_hash").eq("kind", "deposit").eq("status", "completed").eq("symbol", "SOL").order("created_at", { ascending: false }).limit(500); for (const r of data || []) if (r.tx_hash) known.add(r.tx_hash); } catch (_) { /* optional */ }

  let open: any[] = []; try { open = (await rpcdb("chain_deposits_open", {})) || []; } catch (e) { err("open", e); }
  const openKey = new Map<string, any>(open.map((d) => [d.symbol + "|" + d.tx_hash + "|" + d.ref, d]));

  const record = async (f: S.Found) => {
    const uid = owner.get(key(f.symbol, f.to)); if (!uid) return;
    const o = openKey.get(f.symbol + "|" + f.hash + "|" + f.ref);
    // a deposit that was in a block and now comes back with NO block (and no block hash to compare) counts as "missing", not as an instant demotion
    if (o && o.confirmations > 0 && f.confirmations === 0 && !f.blockHash) { await rpcdb("chain_deposit_missing", { p_id: o.id }); stats.missing++; return; }
    const r = await rpcdb("record_chain_deposit", { p_user: uid, p_symbol: f.symbol, p_network: f.network, p_to: f.to, p_from: f.from, p_hash: f.hash, p_ref: f.ref, p_amount: f.amount,
      p_block: f.block, p_block_hash: f.blockHash, p_block_time: f.blockTime ? new Date(f.blockTime * 1000).toISOString() : null, p_confs: f.confirmations, p_failed: f.failed, p_name: NAME[f.symbol] || null });
    stats.recorded++; if (r?.created) stats.created++; if (r?.reorg) stats.reorged++;
  };
  const scan = async (label: string, fn: () => Promise<S.Found[]>) => { try { const fs = await fn(); stats.scanned += fs.length; for (const f of fs) await record(f); } catch (e) { err(label, e); } };

  for (const sym of ["BTC", "LTC"] as const) if (bySym[sym]?.length) await scan(sym, () => S.scanUtxo(net, cfg, sym, bySym[sym]));
  for (const sym of ["ETH", "BNB", "AVAX"] as const) if (bySym[sym]?.length) {
    try {
      const ck = "evm:" + sym, cur = await rpcdb("chain_cursor_get", { p_key: ck }), r = await S.scanEvmNative(net, cfg, sym, bySym[sym], cur == null ? null : Number(cur));
      stats.scanned += r.found.length; for (const f of r.found) await record(f); await rpcdb("chain_cursor_set", { p_key: ck, p_height: r.next });
    } catch (e) { err(sym, e); }
  }
  {
    const evmAddrs = [...new Set(["USDT", "USDC", "SHIB", "LINK"].flatMap((s) => bySym[s] || []))];   // the four tokens share the user's ETH-style address
    if (evmAddrs.length) try {
      const ck = "erc20:ETH", cur = await rpcdb("chain_cursor_get", { p_key: ck }), r = await S.scanErc20(net, cfg, evmAddrs, cur == null ? null : Number(cur));
      stats.scanned += r.found.length; for (const f of r.found) await record(f); await rpcdb("chain_cursor_set", { p_key: ck, p_height: r.next });
    } catch (e) { err("ERC20", e); }
  }
  if (bySym.SOL?.length) await scan("SOL", () => S.scanSol(net, cfg, bySym.SOL, known));
  if (bySym.XRP?.length) await scan("XRP", () => S.scanXrp(net, cfg, bySym.XRP));
  if (bySym.TRX?.length) await scan("TRX", async () => {      // TronGrid lists block-included txs; the solidity node decides finality
    const fs = await S.scanTrx(net, cfg, bySym.TRX);
    for (const f of fs) { try { const r = await S.recheckTrx(net, cfg, f.hash); if (r) { f.confirmations = r.confirmations; f.failed = r.failed; } } catch (_) { /* stays pending */ } }
    return fs;
  });

  // 3) re-verify open / recently final deposits (reorg watch)
  for (const d of open) {
    try {
      let r: { confirmations: number; failed: boolean; block?: number; blockHash?: string; blockTime?: number | null } | null;
      if (d.symbol === "BTC" || d.symbol === "LTC") { const f = await S.recheckUtxo(net, cfg, d.symbol, d.tx_hash, d.to, d.ref); r = f && { confirmations: f.confirmations, failed: false, block: f.block ?? undefined, blockHash: f.blockHash ?? undefined, blockTime: f.blockTime }; }
      else if (d.symbol === "SOL") r = await S.recheckSol(net, cfg, d.tx_hash);
      else if (d.symbol === "XRP") r = await S.recheckXrp(net, cfg, d.tx_hash);
      else if (d.symbol === "TRX") r = await S.recheckTrx(net, cfg, d.tx_hash);
      else r = await S.recheckEvm(net, cfg, d.symbol, d.tx_hash, d.block_hash);
      stats.rechecked++;
      if (r === null) { const st = await rpcdb("chain_deposit_missing", { p_id: d.id }); stats.missing++; if (st === "dropped" || st === "reorged") stats.dropped++; continue; }
      const res = await rpcdb("record_chain_deposit", { p_user: d.user_id, p_symbol: d.symbol, p_network: d.network, p_to: d.to, p_from: d.from, p_hash: d.tx_hash, p_ref: d.ref, p_amount: d.amount,
        p_block: r.block ?? null, p_block_hash: r.blockHash ?? null, p_block_time: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null, p_confs: r.confirmations, p_failed: r.failed, p_name: null });
      if (res?.reorg) stats.reorged++;
    } catch (e) { err("recheck " + d.symbol, e); }          // a provider error never marks anything missing
  }
  try { await rpcdb("chain_deposit_notify_done", {}); } catch (e) { err("notify", e); }

  // 4) balances (the caller's own in user mode)
  await Promise.all(live.filter((w: any) => !onlyUser || w.user_id === onlyUser).flatMap((w: any) => (Array.isArray(w.addresses) ? w.addresses : []).map(async (a: any) => {
    const sym = String(a.symbol || "").toUpperCase(); if (!sym || !a.address || !GECKO[sym]) return;
    const bal = await balanceOf(sym, a.address); if (bal == null) { stats.errors.push("balance " + sym + " unreadable (skipped, not zeroed)"); return; }
    try { await rpcdb("apply_chain_balance", { p_user: w.user_id, p_symbol: sym, p_network: a.network || null, p_address: a.address, p_balance: bal, p_name: NAME[sym] || null }); stats.balances++; } catch (e) { err("apply " + sym, e); }
  })));
  return json({ ok: true, ...stats });
});
