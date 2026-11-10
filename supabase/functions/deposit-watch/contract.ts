// Veltrix · deposit-watch · THE ONE RESPONSE FORMAT (version 2), shared by the scheduled scan and the signed-in user call.
// The app reads it with app.js/watchcontract.js, which implements the same shape (tests load both and check they agree).
//
//   { ok, version: 2, mode: "scan" | "user", now,
//     scanned, recorded, created, reorged, missing, dropped, rechecked, balancesUpdated, unfinished,   // counters (scan mode; 0 in user mode)
//     errors: string[], warnings: string[], busy: string[],                                            // this run's problems / networks another run was already scanning
//     networks: { [BTC|LTC|ETH|BNB|AVAX|SOL|XRP|TRX|ERC20]: { ok, checkedAt, lastOkAt, error, detail } },
//     scanner: { lastRunAt, ageSeconds, ok, stale } | null,
//     wallet?: { balances: [{symbol, amount}], deposits: [...], sends: [...] } }                       // user mode only: the caller's OWN data
//
// The old fields checked / failed / credited are gone on purpose; nothing may depend on them.
export const WATCH_VERSION = 2;
export const SCANNER_STALE_SECS = 180;
export const SYMBOL_NETWORK: Record<string, string> = { BTC: "BTC", LTC: "LTC", ETH: "ETH", BNB: "BNB", AVAX: "AVAX", SOL: "SOL", XRP: "XRP", TRX: "TRX", USDT: "ERC20", USDC: "ERC20", SHIB: "ERC20", LINK: "ERC20" };
export type NetStatus = { ok: boolean; checkedAt: string | null; lastOkAt: string | null; error: string | null; detail?: Record<string, unknown> };
export type WatchResponse = {
  ok: boolean; version: 2; mode: "scan" | "user"; now: string;
  scanned: number; recorded: number; created: number; reorged: number; missing: number; dropped: number; rechecked: number; balancesUpdated: number; unfinished: number;
  errors: string[]; warnings: string[]; busy: string[]; networks: Record<string, NetStatus>;
  scanner: { lastRunAt: string | null; ageSeconds: number | null; ok: boolean | null; stale: boolean } | null;
  wallet?: { balances: { symbol: string; amount: string | number }[]; deposits: any[]; sends: any[] };
  error?: string;
};
export const emptyResponse = (mode: "scan" | "user", nowMs = Date.now()): WatchResponse => ({ ok: true, version: 2, mode, now: new Date(nowMs).toISOString(), scanned: 0, recorded: 0, created: 0,
  reorged: 0, missing: 0, dropped: 0, rechecked: 0, balancesUpdated: 0, unfinished: 0, errors: [], warnings: [], busy: [], networks: {}, scanner: null });

/** the answer to a signed-in user: a plain database read (wallet_status_for), never a scan */
export function userResponse(st: any, nowMs = Date.now()): WatchResponse {
  const r = emptyResponse("user", nowMs), sc = st?.scanner;
  r.networks = st?.networks || {};
  r.scanner = sc ? { lastRunAt: sc.lastRunAt ?? null, ageSeconds: sc.ageSeconds ?? null, ok: sc.ok ?? null, stale: sc.ageSeconds == null || Number(sc.ageSeconds) > SCANNER_STALE_SECS } : null;
  r.wallet = { balances: st?.balances || [], deposits: st?.deposits || [], sends: st?.sends || [] };
  return r;
}
export const failResponse = (mode: "scan" | "user", message: string, nowMs = Date.now()): WatchResponse => ({ ...emptyResponse(mode, nowMs), ok: false, error: message, errors: [message] });
