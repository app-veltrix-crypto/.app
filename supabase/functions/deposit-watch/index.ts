// Veltrix · deposit-watch — reads the REAL on-chain balance of every wallet address and credits exact increases.
// Deploy:  supabase functions deploy deposit-watch --no-verify-jwt   (the function checks the user itself)
// Secrets: supabase secrets set CRON_SECRET=<any long random string>   (SUPABASE_URL / SERVICE_ROLE are provided automatically)
// Called by (a) the signed-in app every ~20 s for ITS OWN user, and (b) optionally a cron with header x-cron-secret for everyone.
// Only CONFIRMED balances are read. A provider error NEVER changes anything (it is skipped, not treated as 0).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "access-control-allow-methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });

const GECKO: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", USDT: "tether", BNB: "binancecoin", SOL: "solana", XRP: "ripple", USDC: "usd-coin", DOGE: "dogecoin", TRX: "tron", TON: "the-open-network", ADA: "cardano", AVAX: "avalanche-2", SHIB: "shiba-inu", LINK: "chainlink", XLM: "stellar", BCH: "bitcoin-cash", SUI: "sui", HBAR: "hedera-hashgraph", LTC: "litecoin", DOT: "polkadot" };
const NAME: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", USDT: "Tether", BNB: "BNB", SOL: "Solana", XRP: "XRP", USDC: "USDC", DOGE: "Dogecoin", TRX: "TRON", TON: "Toncoin", ADA: "Cardano", AVAX: "Avalanche", SHIB: "Shiba Inu", LINK: "Chainlink", XLM: "Stellar", BCH: "Bitcoin Cash", SUI: "Sui", HBAR: "Hedera", LTC: "Litecoin", DOT: "Polkadot" };

// exact decimal string from an integer amount + decimals (no floating point)
function units(v: bigint, dec: number): string {
  const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(dec + 1, "0");
  const i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, "");
  return (neg ? "-" : "") + i + (f ? "." + f : "");
}
const get = async (url: string, init?: RequestInit) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) }); return r; };
const rpc = async (url: string, method: string, params: unknown[]) => {
  const r = await get(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
};

const EVM: Record<string, string> = { ETH: "https://ethereum-rpc.publicnode.com", BNB: "https://bsc-rpc.publicnode.com", AVAX: "https://avalanche-c-chain-rpc.publicnode.com" };
// ERC-20 on Ethereum (contract, decimals)
const ERC20: Record<string, [string, number]> = {
  USDT: ["0xdAC17F958D2ee523a2206206994597C13D831ec7", 6], USDC: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6],
  SHIB: ["0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", 18], LINK: ["0x514910771AF9Ca656af840dff83E8264EcF986CA", 18],
};

// returns the confirmed balance as a decimal string, or null when it could not be read
async function balanceOf(sym: string, addr: string): Promise<string | null> {
  try {
    if (sym === "BTC" || sym === "LTC") {
      const base = sym === "BTC" ? "https://mempool.space/api" : "https://litecoinspace.org/api";
      const j = await (await get(`${base}/address/${addr}`)).json();
      return units(BigInt(j.chain_stats.funded_txo_sum) - BigInt(j.chain_stats.spent_txo_sum), 8);
    }
    if (sym === "DOGE") {
      const r = await get(`https://api.blockcypher.com/v1/doge/main/addrs/${addr}/balance`); const j = await r.json();
      if (j.balance == null) return null; return units(BigInt(j.balance), 8);
    }
    if (sym === "BCH") {
      const a = addr.replace(/^bitcoincash:/, ""); const j = await (await get(`https://api.blockchair.com/bitcoin-cash/dashboards/address/${a}`)).json();
      const d = j.data && (j.data[a] || j.data["bitcoincash:" + a] || Object.values(j.data)[0]) as any; if (!d) return null;
      return units(BigInt(d.address.balance), 8);
    }
    if (EVM[sym]) { const hex = await rpc(EVM[sym], "eth_getBalance", [addr, "latest"]); return units(BigInt(hex), 18); }
    if (ERC20[sym]) {
      const [c, dec] = ERC20[sym]; const data = "0x70a08231" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
      const hex = await rpc(EVM.ETH, "eth_call", [{ to: c, data }, "latest"]); return units(BigInt(hex), dec);
    }
    if (sym === "SOL") { const res = await rpc("https://api.mainnet-beta.solana.com", "getBalance", [addr, { commitment: "finalized" }]); return units(BigInt(res.value), 9); }
    if (sym === "TRX") {
      const j = await (await get(`https://api.trongrid.io/v1/accounts/${addr}?only_confirmed=true`)).json();
      if (!j.success) return null; return units(BigInt((j.data && j.data[0] && j.data[0].balance) || 0), 6);
    }
    if (sym === "XRP") {
      const r = await rpc("https://s1.ripple.com:51234", "account_info", [{ account: addr, ledger_index: "validated" }]);
      if (r.error === "actNotFound") return "0"; if (!r.account_data) return null; return units(BigInt(r.account_data.Balance), 6);
    }
    if (sym === "XLM") {
      const r = await get(`https://horizon.stellar.org/accounts/${addr}`); if (r.status === 404) return "0"; const j = await r.json();
      const n = (j.balances || []).find((b: any) => b.asset_type === "native"); return n ? String(n.balance).replace(/0+$/, "").replace(/\.$/, "") || "0" : "0";
    }
    if (sym === "TON") { const j = await (await get(`https://toncenter.com/api/v2/getAddressBalance?address=${encodeURIComponent(addr)}`)).json(); if (!j.ok) return null; return units(BigInt(j.result), 9); }
    if (sym === "SUI") { const r = await rpc("https://fullnode.mainnet.sui.io:443", "suix_getBalance", [addr]); return units(BigInt(r.totalBalance), 9); }
    if (sym === "ADA") {
      const j = await (await get("https://api.koios.rest/api/v1/address_info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ _addresses: [addr] }) })).json();
      if (!Array.isArray(j)) return null; return j.length ? units(BigInt(j[0].balance), 6) : "0";
    }
    if (sym === "HBAR") {
      const r = await get(`https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${addr}`); if (r.status === 404) return "0"; const j = await r.json();
      return units(BigInt(j.balance.balance), 8);
    }
  } catch (_) { return null; }
  return null; // DOT (no key-free provider) and anything unknown: not watched yet
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let onlyUser: string | null = null;
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") === secret) onlyUser = null;
  else {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data, error } = await admin.auth.getUser(tok);
    if (error || !data.user) return json({ error: "not signed in" }, 401);
    onlyUser = data.user.id;
  }

  // 1) live prices -> asset_prices (used for history values and to validate conversions)
  try {
    const ids = Object.values(GECKO).join(",");
    const r = await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    if (r.ok) { const p = await r.json(); for (const [sym, id] of Object.entries(GECKO)) if (p[id] && p[id].usd > 0) await admin.rpc("set_asset_price", { p_symbol: sym, p_usd: p[id].usd }); }
  } catch (_) { /* keep the previous prices */ }

  // 2) balances
  let q = admin.from("user_wallets").select("user_id,addresses,test_expires_at");
  if (onlyUser) q = q.eq("user_id", onlyUser);
  const { data: wallets, error } = await q;
  if (error) return json({ error: error.message }, 500);

  let credited = 0, checked = 0, failed = 0;
  for (const w of wallets || []) {
    if (w.test_expires_at && Date.parse(w.test_expires_at) <= Date.now()) continue;
    const rows = Array.isArray(w.addresses) ? w.addresses : [];
    await Promise.all(rows.map(async (a: any) => {
      const sym = String(a.symbol || "").toUpperCase(); if (!sym || !a.address) return;
      const bal = await balanceOf(sym, a.address); checked++;
      if (bal == null) { failed++; return; }
      const { data: d, error: e } = await admin.rpc("apply_chain_balance", { p_user: w.user_id, p_symbol: sym, p_network: a.network || null, p_address: a.address, p_balance: bal, p_name: NAME[sym] || null });
      if (e) { failed++; console.error("apply_chain_balance", sym, e.message); return; }
      if (Number(d) > 0) credited++;
    }));
  }
  return json({ ok: true, checked, credited, failed });
});
