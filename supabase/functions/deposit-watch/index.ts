// Veltrix · deposit-watch v3 — the SCHEDULED blockchain watcher + a read-only status call for the app.
// Deploy:  supabase functions deploy deposit-watch --no-verify-jwt   (the function checks the caller itself)
// Secrets: CRON_SECRET (SUPABASE_URL / SERVICE_ROLE are provided). RPC/API overrides, trace providers and network ids: see README.md and PHASE39.md.
// Schedule it every 30-60 s (Supabase Cron) with header  x-cron-secret: <CRON_SECRET>.
//   · with the cron secret  -> mode "scan": scans EVERY network (one lease per network, see watcher.ts) and mirrors every balance
//   · signed-in user        -> mode "user": NEVER scans. Returns that user's own balances, deposits, sends and the network health, read from the database.
// Both answer in the one format defined in contract.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import * as S from "./scan.ts";
import { runScan, userStatus, type Deps } from "./watcher.ts";
import { failResponse } from "./contract.ts";
import { EVM_CHAIN_ID, GENESIS } from "../_shared/netcheck.ts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "access-control-allow-methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";

const GECKO: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", USDT: "tether", BNB: "binancecoin", SOL: "solana", XRP: "ripple", USDC: "usd-coin", TRX: "tron", AVAX: "avalanche-2", SHIB: "shiba-inu", LINK: "chainlink", LTC: "litecoin" };
const cfg: S.Cfg = {
  rpc: { ETH: env("RPC_ETH") || "https://ethereum-rpc.publicnode.com", BNB: env("RPC_BNB") || "https://bsc-rpc.publicnode.com", AVAX: env("RPC_AVAX") || "https://avalanche-c-chain-rpc.publicnode.com",
         SOL: env("RPC_SOL") || "https://api.mainnet-beta.solana.com", XRP: env("RPC_XRP") || "https://s1.ripple.com:51234" },
  api: { BTC: env("API_BTC") || "https://mempool.space/api", LTC: env("API_LTC") || "https://litecoinspace.org/api", TRX: env("API_TRX") || "https://api.trongrid.io" },
  tokens: {   // the SAME contracts payout-send uses (override with TOKEN_* on a test network; the network check refuses a mismatch)
    USDT: { address: env("TOKEN_USDT") || "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: Number(env("TOKEN_DECIMALS_USDT") || 6) },
    USDC: { address: env("TOKEN_USDC") || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: Number(env("TOKEN_DECIMALS_USDC") || 6) },
    SHIB: { address: env("TOKEN_SHIB") || "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: Number(env("TOKEN_DECIMALS_SHIB") || 18) },
    LINK: { address: env("TOKEN_LINK") || "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: Number(env("TOKEN_DECIMALS_LINK") || 18) },
  },
  backfillBlocks: Number(env("DEPOSIT_BACKFILL_BLOCKS") || 300), maxBlocksPerRun: Number(env("DEPOSIT_MAX_BLOCKS_PER_RUN") || 40), required: {}, trongridKey: env("TRONGRID_API_KEY"),
  maxPagesPerRun: Number(env("DEPOSIT_MAX_PAGES_PER_RUN") || 5), traceBlocksPerRun: Number(env("DEPOSIT_TRACE_BLOCKS_PER_RUN") || 2000),
  blocksPerRunBy: { BNB: Number(env("DEPOSIT_MAX_BLOCKS_BNB") || 400), AVAX: Number(env("DEPOSIT_MAX_BLOCKS_AVAX") || 200), TRX: Number(env("DEPOSIT_MAX_BLOCKS_TRX") || 60) },
};
/* the TronGrid key goes ONLY to the TRON API (never to the BTC/LTC explorers), and TRON requests are paced: TronGrid allows ~15 requests/second per key
   and then suspends the key for ~30 s. One request per 90 ms keeps this scanner at ~11/s even when several run at once. */
const hdr = (u: string): Record<string, string> => (cfg.trongridKey && u.startsWith(cfg.api.TRX) ? { "TRON-PRO-API-KEY": cfg.trongridKey } : {});
/** shows in the scan answer (net._http_response.content), so you can SEE which code is deployed */
const BUILD = "2026-11-12-trx-lowmem";
let nextTrxSlot = 0;
const pace = async (u: string) => { if (!u.startsWith(cfg.api.TRX)) return; const at = Math.max(Date.now(), nextTrxSlot); nextTrxSlot = at + 90; const w = at - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); };
const fetchJson = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 120)}`);
  try { return JSON.parse(t); } catch { return t; }           // /blocks/tip/height and /block-height/0 return bare text
};
const net: S.Net = {
  get: async (u) => { await pace(u); return fetchJson(u, { headers: hdr(u) }); },
  post: async (u, b) => { await pace(u); return fetchJson(u, { method: "POST", headers: { "content-type": "application/json", ...hdr(u) }, body: JSON.stringify(b) }); },
  // XRP reports its errors INSIDE result (e.g. actNotFound); scan.ts checks for that. Everything else throws on a JSON-RPC error.
  rpc: async (u, method, params) => { const j = await fetchJson(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200)); return j.result; },
};
const traceMode = (k: string) => (["off", "trace_filter", "debug_trace"].includes(env("TRACE_MODE_" + k)) ? env("TRACE_MODE_" + k) : "auto") as "auto" | "off" | "trace_filter" | "debug_trace";
const cache = new Map<string, { at: number; v: any }>();      // identity / trace-probe answers live for a few minutes inside one isolate

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const db: Deps["db"] = {
    async rpc(name, args) { const { data, error } = await admin.rpc(name, args); if (error) throw new Error(`${name}: ${error.message}`); return data; },
    async wallets() { const { data, error } = await admin.from("user_wallets").select("user_id,addresses,test_expires_at,created_at"); if (error) throw new Error(error.message); return data || []; },
  };
  const secret = env("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") === secret) {
    const deps: Deps = { cfg, net, db, cache,
      expected: { chainId: { ETH: Number(env("CHAIN_ID_ETH") || EVM_CHAIN_ID.ETH), BNB: Number(env("CHAIN_ID_BNB") || EVM_CHAIN_ID.BNB), AVAX: Number(env("CHAIN_ID_AVAX") || EVM_CHAIN_ID.AVAX) },
        genesis: { BTC: env("GENESIS_BTC") || GENESIS.BTC, LTC: env("GENESIS_LTC") || GENESIS.LTC, SOL: env("GENESIS_SOL") || GENESIS.SOL, TRX: env("GENESIS_TRX") || GENESIS.TRX },
        xrpNetworkId: Number(env("NETWORK_ID_XRP") || 0) },
      trxInternal: env("TRX_INTERNAL") === "off" ? "off" : "auto",
      trace: { ETH: { mode: traceMode("ETH"), url: env("RPC_TRACE_ETH") }, BNB: { mode: traceMode("BNB"), url: env("RPC_TRACE_BNB") }, AVAX: { mode: traceMode("AVAX"), url: env("RPC_TRACE_AVAX") } },
      prices: async () => {
        try { const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(GECKO).join(",")}&vs_currencies=usd`, { signal: AbortSignal.timeout(12000) });
          if (!r.ok) return null; const p = await r.json(); const o: Record<string, number> = {}; for (const [sym, id] of Object.entries(GECKO)) if (p[id]?.usd > 0) o[sym] = p[id].usd; return o; } catch { return null; }
      } };
    try { return json({ build: BUILD, ...(await runScan(deps)) }); } catch (e) { return json(failResponse("scan", String((e as Error)?.message || e).slice(0, 200)), 500); }
  }
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(tok);
  if (error || !data.user) return json({ ...failResponse("user", "not signed in"), error: "not signed in" }, 401);
  return json(await userStatus({ db }, data.user.id));          // a database read. It does not scan, and it does not touch a blockchain.
}

// Any crash is ANSWERED with its reason (the app shows it) instead of an empty 500: the scheduler still gets a 500, a signed-in user gets a readable error in the normal format.
Deno.serve(async (req) => {
  try { return await handle(req); }
  catch (e) {
    const m = String((e as Error)?.message || e).slice(0, 200), cron = !!env("CRON_SECRET") && req.headers.get("x-cron-secret") === env("CRON_SECRET");
    console.error("deposit-watch crashed:", m);
    return json(failResponse(cron ? "scan" : "user", "deposit-watch crashed: " + m + " (check the function's secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically; the database needs schema_phase39)"), cron ? 500 : 200);
  }
});
