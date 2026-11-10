// Offline stand-ins: an in-memory database that behaves like the phase-39 SQL (leases, fenced writes, idempotent deposit recording) and a scriptable network.
import * as N from "../../_shared/netcheck.ts";
import type * as S from "../scan.ts";
import type { Deps } from "../watcher.ts";

export const clock = { t: Date.now() };
export function makeDb(wallets: any[], o: { open?: any[] } = {}) {
  const locks = new Map<string, { owner: string; until: number }>(), cursors = new Map<string, number>(), progress = new Map<string, any>(), recorded = new Map<string, any>();
  const calls: Array<[string, any]> = [], health = new Map<string, any>(), balances: any[] = [], missing: any[] = [];
  const holds = (n: string, w: string) => { const l = locks.get(n); return !!l && l.owner === w && l.until > clock.t; };
  const db: Deps["db"] & { locks: typeof locks; cursors: typeof cursors; progress: typeof progress; recorded: typeof recorded; calls: typeof calls; health: typeof health; balances: typeof balances; missing: typeof missing } = {
    locks, cursors, progress, recorded, calls, health, balances, missing,
    async wallets() { return wallets; },
    async rpc(name, a: any) {
      calls.push([name, a]);
      switch (name) {
        case "scan_lock_acquire": { const l = locks.get(a.p_name); if (l && l.until > clock.t && l.owner !== a.p_owner) return false; locks.set(a.p_name, { owner: a.p_owner, until: clock.t + a.p_secs * 1000 }); return true; }
        case "scan_lock_release": { const l = locks.get(a.p_name); if (l && l.owner === a.p_owner) l.until = clock.t - 1; return null; }
        case "chain_cursor_get": return cursors.has(a.p_key) ? cursors.get(a.p_key) : null;
        case "chain_cursor_set_fenced": if (!holds(a.p_lock, a.p_owner)) return false; cursors.set(a.p_key, a.p_height); return true;
        case "scan_progress_get_many": return Object.fromEntries(a.p_keys.filter((k: string) => progress.has(k)).map((k: string) => [k, progress.get(k)]));
        case "scan_progress_set_fenced": if (!holds(a.p_lock, a.p_owner)) return false; progress.set(a.p_key, a.p_state); return true;
        case "chain_deposits_open": return o.open ?? [];
        case "chain_deposits_final": return [];
        case "chain_deposit_missing": missing.push(a); return "pending";
        case "record_chain_deposit": { const k = [a.p_symbol, a.p_hash, a.p_ref, a.p_to].join("|"); if (recorded.has(k)) { recorded.get(k).seen++; return { ok: true, created: false }; } recorded.set(k, { ...a, seen: 1 }); return { ok: true, created: true }; }
        case "chain_health_set": health.set(a.p_network, a); return null;
        case "apply_chain_balance": balances.push(a); return a.p_balance;
        case "chain_deposit_notify_done": case "set_asset_price": return 0;
        case "wallet_status_for": return { balances: [{ symbol: "BTC", amount: 0.5 }], deposits: [{ id: "d1", symbol: "BTC", amount: 0.1, status: "confirming", confirmations: 1, required_confirmations: 3 }], sends: [], networks: {}, scanner: { lastRunAt: new Date(clock.t).toISOString(), ageSeconds: 5, ok: true } };
      }
      throw new Error("unexpected db call " + name);
    },
  };
  return db;
}

export const GEN = N.GENESIS;
export const baseCfg = (): S.Cfg => ({ rpc: { ETH: "eth", BNB: "bnb", AVAX: "avax", SOL: "sol", XRP: "xrp" }, api: { BTC: "https://btc", LTC: "https://ltc", TRX: "https://trx" },
  tokens: { USDT: { ...N.CANONICAL_TOKENS[1].USDT }, USDC: { ...N.CANONICAL_TOKENS[1].USDC }, SHIB: { ...N.CANONICAL_TOKENS[1].SHIB }, LINK: { ...N.CANONICAL_TOKENS[1].LINK } },
  backfillBlocks: 5, maxBlocksPerRun: 50, required: {}, maxPagesPerRun: 5 });
export const baseDeps = (db: Deps["db"], net: S.Net, extra: Partial<Deps> = {}): Deps => ({ cfg: baseCfg(), net, db, now: () => clock.t, uuid: () => crypto.randomUUID(),
  expected: { chainId: { ETH: 1, BNB: 56, AVAX: 43114 }, genesis: { BTC: GEN.BTC, LTC: GEN.LTC, SOL: GEN.SOL, TRX: GEN.TRX }, xrpNetworkId: 0 },
  trace: { ETH: { mode: "off", url: "" }, BNB: { mode: "off", url: "" }, AVAX: { mode: "off", url: "" } }, ...extra });
const hx = (n: number) => "0x" + n.toString(16);
/** a network where BTC and ETH answer like their mainnets (override any method) */
export function mainnetNet(o: { chainId?: number; btcGenesis?: string; btcTxs?: any[]; btcGate?: Promise<void>; ethTxs?: Record<number, any[]>; tip?: number } = {}): S.Net & { log: string[] } {
  const log: string[] = [], tip = o.tip ?? 100;
  const net = {
    log,
    async get(u: string) {
      log.push("GET " + u);
      if (u.endsWith("/block-height/0")) return o.btcGenesis ?? GEN.BTC;
      if (u.endsWith("/blocks/tip/height")) return 800000;
      if (/\/address\/[^/]+\/txs$/.test(u)) { if (o.btcGate) await o.btcGate; return o.btcTxs ?? []; }
      if (/\/txs\/chain\//.test(u)) return [];
      if (/\/address\/[^/]+$/.test(u)) return { chain_stats: { funded_txo_sum: 50_000_000, spent_txo_sum: 0 } };
      throw new Error("unexpected GET " + u);
    },
    async post(u: string) { log.push("POST " + u); throw new Error("unexpected POST " + u); },
    async rpc(_u: string, m: string, p: any[]) {
      log.push("RPC " + m);
      switch (m) {
        case "eth_chainId": return hx(o.chainId ?? 1);
        case "eth_blockNumber": return hx(tip);
        case "eth_getBlockByNumber": { const n = p[0] === "latest" ? tip : Number(BigInt(p[0])); return { number: hx(n), hash: "0xblk" + n, timestamp: hx(Math.floor(clock.t / 1000)), transactions: p[1] ? (o.ethTxs?.[n] ?? []) : [] }; }
        case "eth_getCode": return "0x6080";
        case "eth_call": { const t = Object.values(N.CANONICAL_TOKENS[1]).find((x) => x.address.toLowerCase() === p[0].to.toLowerCase()); return hx(t ? t.decimals : 18); }
        case "eth_getBalance": return hx(2e18);
        case "eth_getTransactionReceipt": return { status: "0x1" };
      }
      throw new Error("unexpected RPC " + m);
    },
  };
  return net;
}
export const ME = "0x1111111111111111111111111111111111111111", BTC_ADDR = "bc1qme";
export const wallets = (extra: any = {}) => [{ user_id: "u1", addresses: [{ symbol: "BTC", address: BTC_ADDR, network: "Bitcoin" }, { symbol: "ETH", address: ME, network: "Ethereum" }], created_at: new Date(clock.t - 3 * 86400_000).toISOString(), ...extra }];
export const btcTx = (id: string, h: number) => ({ txid: id, status: { confirmed: true, block_height: h, block_hash: "b" + h, block_time: Math.floor(clock.t / 1000) - 1000 }, vin: [{ prevout: { scriptpubkey_address: "bc1qsender" } }], vout: [{ scriptpubkey_address: BTC_ADDR, value: 10000 }] });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
