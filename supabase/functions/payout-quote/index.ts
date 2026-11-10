// Veltrix · payout-quote — the fee quotation shown BEFORE the PIN. Read-only: no key, no phrase, no signing, no broadcast, no withdrawal, no deduction.
// Deploy:  supabase functions deploy payout-quote --no-verify-jwt     (the function checks the signed-in user itself; it has no cron mode)
// Secrets: the same RPC_* / API_* / CHAIN_ID_* / TOKEN_* / MAX_FEE_* secrets as payout-send, so the quote is computed against the same networks and ceilings.
// The only database call is quote_context() (public address, balances, flags). The actual send is re-validated and its fee recalculated by payout-send.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { buildQuote, type QCfg } from "./quote.ts";
import { prims } from "../payout-send/prims.ts";
import { EVM_CHAIN_ID, GENESIS } from "../_shared/netcheck.ts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";
const num = (k: string, d: number) => Number(env(k) || d);
const cfg: QCfg = {
  rpc: { ETH: env("RPC_ETH") || "https://ethereum-rpc.publicnode.com", BNB: env("RPC_BNB") || "https://bsc-rpc.publicnode.com", AVAX: env("RPC_AVAX") || "https://avalanche-c-chain-rpc.publicnode.com",
         SOL: env("RPC_SOL") || "https://api.mainnet-beta.solana.com", XRP: env("RPC_XRP") || "https://s1.ripple.com:51234" },
  api: { BTC: env("API_BTC") || "https://mempool.space/api", LTC: env("API_LTC") || "https://litecoinspace.org/api", TRX: env("API_TRX") || "https://api.trongrid.io" },
  chainId: { ETH: num("CHAIN_ID_ETH", EVM_CHAIN_ID.ETH), BNB: num("CHAIN_ID_BNB", EVM_CHAIN_ID.BNB), AVAX: num("CHAIN_ID_AVAX", EVM_CHAIN_ID.AVAX) },
  maxFeeGwei: { ETH: num("MAX_FEE_GWEI_ETH", 60), BNB: num("MAX_FEE_GWEI_BNB", 10), AVAX: num("MAX_FEE_GWEI_AVAX", 80) },
  tokens: {
    USDT: { address: env("TOKEN_USDT") || "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: num("TOKEN_DECIMALS_USDT", 6) },
    USDC: { address: env("TOKEN_USDC") || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: num("TOKEN_DECIMALS_USDC", 6) },
    SHIB: { address: env("TOKEN_SHIB") || "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: num("TOKEN_DECIMALS_SHIB", 18) },
    LINK: { address: env("TOKEN_LINK") || "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: num("TOKEN_DECIMALS_LINK", 18) },
  },
  genesis: { BTC: env("GENESIS_BTC") || GENESIS.BTC, LTC: env("GENESIS_LTC") || GENESIS.LTC, SOL: env("GENESIS_SOL") || GENESIS.SOL, TRX: env("GENESIS_TRX") || GENESIS.TRX },
  xrpNetworkId: num("NETWORK_ID_XRP", 0),
  fixedRate: { BTC: num("FEE_RATE_FIXED_BTC", 0), LTC: num("FEE_RATE_FIXED_LTC", 0) }, maxRate: { BTC: num("MAX_FEE_RATE_BTC", 100), LTC: num("MAX_FEE_RATE_LTC", 100) },
  maxFeeDropsXrp: num("MAX_FEE_DROPS_XRP", 5000),
};
const fetchJson = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 120)}`);
  try { return JSON.parse(t); } catch { return t; }
};
const net = {
  get: (u: string) => fetchJson(u, env("TRONGRID_API_KEY") && u.includes("trongrid") ? { headers: { "TRON-PRO-API-KEY": env("TRONGRID_API_KEY") } } : undefined),
  post: (u: string, b: unknown) => fetchJson(u, { method: "POST", headers: { "content-type": "application/json", ...(env("TRONGRID_API_KEY") ? { "TRON-PRO-API-KEY": env("TRONGRID_API_KEY") } : {}) }, body: JSON.stringify(b) }),
  rpc: async (u: string, method: string, params: unknown[]) => { const j = await fetchJson(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200)); return j.result; },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(tok);
  if (error || !data.user) return json({ ok: false, reason: "not_signed_in", message: "not signed in" }, 401);
  let b: { symbol?: string; amount?: string; address?: string; memo?: string | null } = {}; try { b = await req.json(); } catch { /* none */ }
  const symbol = String(b.symbol || ""), address = String(b.address || "").trim();
  if (!symbol || !address || !b.amount) return json({ ok: false, reason: "bad_request", message: "symbol, amount and address are required" }, 400);
  const { data: ctx, error: cerr } = await admin.rpc("quote_context", { p_user: data.user.id, p_symbol: symbol, p_to: address });     // the ONLY database call
  if (cerr || !ctx) return json({ ok: false, reason: "context", message: "Could not read your wallet details" }, 500);
  try { return json(await buildQuote({ net, cfg, ctx, P: prims }, { symbol, amount: String(b.amount), to: address, memo: b.memo ?? null })); }
  catch (e) { return json({ ok: false, reason: "error", message: String((e as Error)?.message || e).slice(0, 160) }, 500); }
});
