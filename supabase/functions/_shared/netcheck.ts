// Veltrix · shared · NETWORK IDENTITY CHECKS. Used by deposit-watch (before any scan or balance is mirrored) and by payout-quote.
// A public RPC / API address that is mistyped, replaced by a provider, or pointed at a TEST network still answers happily with
// "balances". Showing those as the user's real balance would be a fabricated balance, so every network is proven to be the intended one first:
//   EVM (ETH/BNB/AVAX)  eth_chainId == expected, and the newest block is not stale
//   BTC / LTC           the genesis block hash (/block-height/0) == mainnet genesis
//   SOL                 getGenesisHash == mainnet genesis (and getHealth is ok)
//   XRP                 server_info.network_id == 0 (rippled omits the field on mainnet) and a recent validated ledger
//   TRX                 block 0's id == mainnet genesis
//   ERC-20 tokens       the configured contract is the canonical contract for that chain id, holds code, and decimals() matches
// Nothing here writes anything. The network is injected so it can be tested without a network.
export type NNet = {
  get(url: string): Promise<any>;
  rpc(url: string, method: string, params: unknown[]): Promise<any>;
  post(url: string, body: unknown): Promise<any>;
};
export type Health = { ok: boolean; error?: string; detail: Record<string, unknown> };

export const GENESIS = {
  BTC: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  LTC: "12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2",
  SOL: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  TRX: "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc",
} as const;
export const EVM_CHAIN_ID = { ETH: 1, BNB: 56, AVAX: 43114 } as const;
/** the canonical token contracts, per chain id (only chain 1 is listed: tokens are Ethereum-mainnet tokens in this app) */
export const CANONICAL_TOKENS: Record<number, Record<string, { address: string; decimals: number }>> = {
  1: {
    USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    SHIB: { address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: 18 },
    LINK: { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
  },
};

const lc = (s: string) => String(s || "").toLowerCase();
const msg = (e: unknown) => String((e as Error)?.message || e).slice(0, 200);
const fail = (error: string, detail: Record<string, unknown> = {}): Health => ({ ok: false, error, detail });
const good = (detail: Record<string, unknown> = {}): Health => ({ ok: true, detail });

export async function checkEvm(net: NNet, key: string, url: string, expectedChainId: number, opts: { maxStaleSecs?: number; now?: () => number } = {}): Promise<Health> {
  let cid: number;
  try { cid = Number(BigInt(await net.rpc(url, "eth_chainId", []))); } catch (e) { return fail(`Could not reach the ${key} network: ${msg(e)}`); }
  if (cid !== expectedChainId) return fail(`Wrong network behind the ${key} RPC address (chain ${cid}, expected ${expectedChainId}). Balances from it are NOT shown.`, { chainId: cid, expectedChainId });
  const maxStale = opts.maxStaleSecs ?? 600, nowS = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  try {
    const b = await net.rpc(url, "eth_getBlockByNumber", ["latest", false]);
    if (!b || b.timestamp == null) return fail(`The ${key} RPC returned no latest block`, { chainId: cid });
    const age = nowS - Number(BigInt(b.timestamp));
    if (age > maxStale) return fail(`The ${key} RPC is stale: its newest block is ${Math.round(age / 60)} minutes old`, { chainId: cid, tip: Number(BigInt(b.number)), ageSecs: age });
    return good({ chainId: cid, tip: Number(BigInt(b.number)), ageSecs: age });
  } catch (e) { return fail(`Could not read the newest ${key} block: ${msg(e)}`, { chainId: cid }); }
}

/** the four ERC-20 contracts must belong to this chain id: canonical on chain 1; on any other chain they must have been set explicitly (a test network) */
export async function checkTokens(net: NNet, url: string, chainId: number, tokens: Record<string, { address: string; decimals: number }>): Promise<Health> {
  const canon = CANONICAL_TOKENS[chainId], problems: string[] = [], seen: Record<string, unknown> = {};
  for (const [sym, t] of Object.entries(tokens)) {
    const main = CANONICAL_TOKENS[1][sym];
    if (canon) {
      if (!canon[sym] || lc(canon[sym].address) !== lc(t.address)) { problems.push(`${sym}: ${t.address} is not the canonical ${sym} contract for chain ${chainId}`); continue; }
      if (canon[sym].decimals !== t.decimals) { problems.push(`${sym}: configured decimals ${t.decimals}, canonical ${canon[sym].decimals}`); continue; }
    } else if (main && lc(main.address) === lc(t.address)) { problems.push(`${sym}: the Ethereum MAINNET contract ${t.address} is configured on chain ${chainId}. Set TOKEN_${sym} to this network's contract`); continue; }
    try {
      const code = await net.rpc(url, "eth_getCode", [t.address, "latest"]);
      if (!code || code === "0x") { problems.push(`${sym}: no contract at ${t.address} on chain ${chainId}`); continue; }
      const dec = Number(BigInt(await net.rpc(url, "eth_call", [{ to: t.address, data: "0x313ce567" }, "latest"])));
      if (dec !== t.decimals) { problems.push(`${sym}: the contract reports ${dec} decimals, configured ${t.decimals}`); continue; }
      seen[sym] = { decimals: dec };
    } catch (e) { problems.push(`${sym}: could not verify the contract (${msg(e)})`); }
  }
  return problems.length ? fail("Token configuration does not match this network: " + problems.join("; "), { chainId, tokens: seen }) : good({ chainId, tokens: seen });
}

export async function checkUtxoApi(net: NNet, sym: "BTC" | "LTC", base: string, expectedGenesis: string): Promise<Health> {
  let g: unknown;
  try { g = await net.get(`${base}/block-height/0`); } catch (e) { return fail(`Could not reach the ${sym} network: ${msg(e)}`); }
  if (lc(String(g).trim()) !== lc(expectedGenesis)) return fail(`Wrong network behind the ${sym} API address (genesis ${String(g).slice(0, 16)}…). Balances from it are NOT shown.`, { genesis: String(g).slice(0, 64) });
  try { const tip = Number(await net.get(`${base}/blocks/tip/height`)); if (!(tip > 0)) return fail(`The ${sym} API returned no chain tip`); return good({ tip, genesis: "ok" }); }
  catch (e) { return fail(`Could not read the ${sym} chain tip: ${msg(e)}`); }
}

export async function checkSol(net: NNet, url: string, expectedGenesis: string): Promise<Health> {
  let g: string;
  try { g = await net.rpc(url, "getGenesisHash", []); } catch (e) { return fail(`Could not reach the Solana network: ${msg(e)}`); }
  if (g !== expectedGenesis) return fail(`Wrong network behind the Solana RPC address (genesis ${String(g).slice(0, 12)}…). Balances from it are NOT shown.`, { genesis: String(g) });
  try { const h = await net.rpc(url, "getHealth", []); if (h !== "ok") return fail(`The Solana node reports itself unhealthy (${String(h).slice(0, 40)})`); } catch (e) { return fail(`The Solana node is not healthy: ${msg(e)}`); }
  return good({ genesis: "ok" });
}

export async function checkXrp(net: NNet, url: string, expectedNetworkId: number, opts: { maxStaleSecs?: number } = {}): Promise<Health> {
  let r: any;
  try { r = await net.rpc(url, "server_info", [{}]); } catch (e) { return fail(`Could not reach the XRP Ledger: ${msg(e)}`); }
  const info = r?.info; if (!info) return fail("The XRP server returned no server_info");
  const id = info.network_id == null ? 0 : Number(info.network_id);                                 // rippled omits network_id on mainnet
  if (id !== expectedNetworkId) return fail(`Wrong network behind the XRP server (network id ${id}, expected ${expectedNetworkId}). Balances from it are NOT shown.`, { networkId: id });
  const v = info.validated_ledger; if (!v) return fail("The XRP server has no validated ledger yet");
  const age = Number(v.age); if (Number.isFinite(age) && age > (opts.maxStaleSecs ?? 600)) return fail(`The XRP server is stale: its newest validated ledger is ${Math.round(age / 60)} minutes old`, { networkId: id, ledger: v.seq });
  return good({ networkId: id, ledger: Number(v.seq) });
}

export async function checkTron(net: NNet, base: string, expectedGenesis: string): Promise<Health> {
  let b: any;
  try { b = await net.post(`${base}/wallet/getblockbynum`, { num: 0 }); } catch (e) { return fail(`Could not reach the TRON network: ${msg(e)}`); }
  const id = String(b?.blockID || "");
  if (lc(id) !== lc(expectedGenesis)) return fail(`Wrong network behind the TRON API address (genesis ${id.slice(0, 16)}…). Balances from it are NOT shown.`, { genesis: id });
  return good({ genesis: "ok" });
}
