// Veltrix · deposit-watch · TRANSACTION-LEVEL deposit scanners. One adapter per chain family. Each returns the INDIVIDUAL incoming transfers
// it can see for a set of watched addresses, with the real hash, sender, amount, block data and confirmations. Nothing here writes to the
// database and nothing here looks at balances; index.ts records the results with record_chain_deposit().
//
// The network is injected (`Net`) so the parsing can be tested offline with recorded-shape fixtures. NOTHING in this file has been run
// against a live chain by the author; see TESTING-REAL-MONEY.md for the tiny real-money checks that prove it.
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
export type Cfg = { rpc: Record<string, string>; api: Record<string, string>; tokens: Record<string, { address: string; decimals: number }>;
  backfillBlocks: number; maxBlocksPerRun: number; required: Record<string, number>; trongridKey?: string };

export function units(v: bigint, dec: number): string {
  const s = v.toString().padStart(dec + 1, "0"), i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, "");
  return i + (f ? "." + f : "");
}
const lc = (s: string) => s.toLowerCase();

// ------------------------------------------------------------------------------------------------------- BTC / LTC (mempool.space-style API)
// /address/:a/txs returns the newest mempool txs + the first 25 confirmed ones; ?after_txid pages further back. We read the first page only on
// every run (new deposits are always on it) and fetch /tx/:id for any watched deposit that is no longer on it (see recheck()).
export async function scanUtxo(net: Net, cfg: Cfg, sym: "BTC" | "LTC", addrs: string[]): Promise<Found[]> {
  const base = cfg.api[sym], tip = Number(await net.get(base + "/blocks/tip/height")), out: Found[] = [];
  for (const a of addrs) {
    const txs: any[] = await net.get(`${base}/address/${a}/txs`);
    for (const tx of txs) out.push(...utxoFrom(sym, a, tx, tip));
  }
  return out;
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
// Plain JSON-RPC has no "transactions of address X". We walk blocks from a cursor (every run re-reads the last `reorgOverlap` blocks, so a
// reorg inside that window is picked up; duplicates are harmless because record_chain_deposit is idempotent) and keep txs whose `to` is watched.
// Limitation: native coin moved by a CONTRACT call (internal transfer) has no top-level tx to our address and is NOT seen here.
export const REORG_OVERLAP = 12;
export async function scanEvmNative(net: Net, cfg: Cfg, sym: "ETH" | "BNB" | "AVAX", addrs: string[], cursor: number | null): Promise<{ found: Found[]; next: number }> {
  const url = cfg.rpc[sym], tip = Number(BigInt(await net.rpc(url, "eth_blockNumber", [])));
  const from = cursor == null ? Math.max(0, tip - cfg.backfillBlocks) : Math.max(0, cursor - REORG_OVERLAP);
  const to = Math.min(tip, from + cfg.maxBlocksPerRun - 1), want = new Set(addrs.map(lc)), found: Found[] = [];
  for (let n = from; n <= to; n++) {
    const b = await net.rpc(url, "eth_getBlockByNumber", ["0x" + n.toString(16), true]);
    if (!b) break;                                                                            // node does not have it yet: stop, retry next run
    for (const tx of b.transactions || []) {
      if (!tx.to || !want.has(lc(tx.to)) || BigInt(tx.value) === 0n) continue;
      let failed = false;
      try { const r = await net.rpc(url, "eth_getTransactionReceipt", [tx.hash]); failed = !!r && r.status === "0x0"; } catch { /* a missing receipt is re-checked on the next run */ }
      found.push({ symbol: sym, network: NETNAME[sym], to: addrs.find((a) => lc(a) === lc(tx.to))!, from: tx.from, hash: tx.hash, ref: "native",
        amount: units(BigInt(tx.value), 18), block: n, blockHash: b.hash, blockTime: Number(BigInt(b.timestamp)), confirmations: tip - n + 1, failed });
    }
  }
  return { found, next: to };
}
const NETNAME: Record<string, string> = { ETH: "Ethereum", BNB: "BNB Smart Chain", AVAX: "Avalanche C-Chain" };

/** one known EVM deposit (native or token): is it still in the canonical chain? Returns fresh block data, or null if the chain does not know it. */
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
export async function scanErc20(net: Net, cfg: Cfg, addrs: string[], cursor: number | null): Promise<{ found: Found[]; next: number }> {
  const url = cfg.rpc.ETH, tip = Number(BigInt(await net.rpc(url, "eth_blockNumber", [])));
  const from = cursor == null ? Math.max(0, tip - cfg.backfillBlocks) : Math.max(0, cursor - REORG_OVERLAP);
  const to = Math.min(tip, from + cfg.maxBlocksPerRun - 1), found: Found[] = [];
  if (!addrs.length) return { found, next: to };
  for (const [sym, tok] of Object.entries(cfg.tokens)) {
    const logs: any[] = await net.rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: tok.address, topics: [TRANSFER_TOPIC, null, addrs.map(pad)] }]);
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
  return { found, next: to };
}

// ------------------------------------------------------------------------------------------------------- Solana
// getSignaturesForAddress (finalized) -> getTransaction (jsonParsed). The amount is the change of THIS account's lamports; the sender is the
// fee payer (first signer). Only FINALIZED transfers are reported as confirmed; anything seen at `confirmed` is reported with confirmations 0.
export async function scanSol(net: Net, cfg: Cfg, addrs: string[], skip: Set<string>): Promise<Found[]> {
  const url = cfg.rpc.SOL, out: Found[] = [];
  for (const a of addrs) {
    const sigs: any[] = await net.rpc(url, "getSignaturesForAddress", [a, { limit: 25, commitment: "confirmed" }]);
    for (const s of sigs) {
      if (skip.has(s.signature)) continue;                                                   // already recorded as final: do not re-fetch
      const tx = await net.rpc(url, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (!tx) continue;
      const f = solFrom(a, s.signature, tx, s.confirmationStatus === "finalized"); if (f) out.push(f);
    }
  }
  return out;
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
// account_tx. delivered_amount (NOT Amount: a partial payment delivers less). Validated = final (confirmations 1).
export async function scanXrp(net: Net, cfg: Cfg, addrs: string[]): Promise<Found[]> {
  const out: Found[] = [];
  for (const a of addrs) {
    const r = await net.rpc(cfg.rpc.XRP, "account_tx", [{ account: a, ledger_index_min: -1, ledger_index_max: -1, limit: 50, forward: false }]);
    if (r.error === "actNotFound") continue;
    for (const t of r.transactions || []) { const f = xrpFrom(a, t); if (f) out.push(f); }
  }
  return out;
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
export async function scanTrx(net: Net, cfg: Cfg, addrs: string[]): Promise<Found[]> {
  const base = cfg.api.TRX, out: Found[] = [];
  for (const a of addrs) {
    const r = await net.get(`${base}/v1/accounts/${a}/transactions?only_to=true&limit=50&order_by=block_timestamp,desc`);
    for (const t of r.data || []) { const f = trxFrom(a, t); if (f) out.push(f); }
  }
  return out;
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
