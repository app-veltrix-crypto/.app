// Test-only: what a MAINNET endpoint answers to the signer's network-identity probes (default endpoint URLs), with optional "wrong network" switches.
// Shapes follow the documented answers of mempool.space / Solana JSON-RPC / rippled / TronGrid. Synthetic: no real network is involved.
import { GENESIS } from "../../_shared/netcheck.ts";
export type Wrong = Partial<Record<"BTC" | "LTC" | "SOL" | "XRP" | "TRX", boolean>>;
export const WRONG_SOL_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";           // a different cluster's genesis hash (devnet)
const txt = (t: string) => new Response(t, { status: 200 }), js = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
/** the answer to an identity probe, or null when the request is not one (the caller's own router then handles it) */
export function identityAnswer(url: string, init?: RequestInit, wrong: Wrong = {}): Response | null {
  const u = String(url), body = init?.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return null; } })() : null;
  if (u.endsWith("/block-height/0")) return txt(u.includes("litecoinspace") ? (wrong.LTC ? GENESIS.BTC : GENESIS.LTC) : (wrong.BTC ? GENESIS.LTC : GENESIS.BTC));
  if (u.endsWith("/blocks/tip/height")) return txt("850000");
  if (u.includes("api.mainnet-beta.solana.com") && body?.method === "getGenesisHash") return js({ jsonrpc: "2.0", id: 1, result: wrong.SOL ? WRONG_SOL_GENESIS : GENESIS.SOL });
  if (u.includes("api.mainnet-beta.solana.com") && body?.method === "getHealth") return js({ jsonrpc: "2.0", id: 1, result: "ok" });
  if (u.includes("s1.ripple.com") && body?.method === "server_info") return js({ result: { status: "success", info: { ...(wrong.XRP ? { network_id: 1 } : {}), validated_ledger: { seq: 90000000, age: 3, reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } });
  if (u.endsWith("/wallet/getblockbynum") && body?.num === 0) return js({ blockID: wrong.TRX ? "0000000000000000" + "ab".repeat(24) : GENESIS.TRX });
  return null;
}
