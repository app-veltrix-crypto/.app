// Veltrix · payout-send · the SAFETY LOGIC (no blockchain code here, so it can be tested without a blockchain).
//
// The rules this file enforces, in order:
//   1. A payout is only ever picked up by payout_claim() (queued -> processing), one at a time (payout_lock).
//   2. Everything that can fail is done BEFORE broadcasting (checks, fee, balance, signing). Failing here means nothing was sent,
//      so the user's money is returned (definite) or the payout is retried later (retry).
//   3. The transaction hash is saved in the database BEFORE the transaction is broadcast. If that save fails, nothing is broadcast.
//   4. If the broadcast result is unclear (timeout, odd error) the money is NEVER refunded automatically — it stays held, and the
//      hash is looked up on the blockchain later. Only a receipt (mined ok / mined failed) or an admin can settle it.
//   5. A payout is marked completed only when the transaction is mined successfully.

export type Row = { id: string; user_id: string; symbol: string; amount: string; to_address: string; memo?: string | null; payout_attempts: number };
export type Item = { id: string; symbol: string };

/** kind: "definite" = nothing was or will be sent · "retry" = not sent yet, try again later · "unclear" = may or may not have been sent */
export class ChainError extends Error {
  kind: "definite" | "retry" | "unclear";
  constructor(kind: "definite" | "retry" | "unclear", message: string) { super(message); this.kind = kind; }
}
/** meta: a short note stored together with the hash. Chains whose transactions EXPIRE (Solana, XRP) keep the expiry here, so a payout
 *  that was never mined can later be proven dead (and refunded) instead of waiting for a person. */
export type Prepared = { hash: string; raw: string; symbol: string; meta?: string };
export type MinedState = "success" | "failed" | "none";

export interface Chain {
  /** validate + check balances/fees + sign. Throws ChainError("definite"|"retry"). Never broadcasts. */
  prepare(row: Row): Promise<Prepared>;
  /** broadcast the signed transaction. Throws ChainError("definite") only if the network explicitly refused it, otherwise "unclear". */
  broadcast(p: Prepared): Promise<void>;
  /** look the hash up on the blockchain. "failed" must mean: it was mined as failed, OR it can provably never be mined any more (expired). */
  receipt(hash: string, symbol: string, meta?: string | null): Promise<MinedState>;
  /** payouts on the same lane are sent one after the other (one nonce / one set of coins); different lanes never wait for each other */
  lane(symbol: string): string;
  /** how long to wait for the first confirmation before moving on (slow chains return 0 and are re-checked by the next run) */
  waitMs?(symbol: string): number;
  sleep(ms: number): Promise<void>;
}
export interface Db { rpc(name: string, args: Record<string, unknown>): Promise<any>; }
export type Log = (msg: string) => void;

const short = (s: string) => String(s || "").slice(0, 280);

export async function processOne(db: Db, chain: Chain, id: string, log: Log, waitMs = 45000): Promise<string> {
  const row: Row | null = await db.rpc("payout_claim", { p_id: id });
  if (!row) return "skipped";
  let prepared: Prepared;
  try {
    prepared = await chain.prepare(row);
  } catch (e) {
    const err = e as ChainError, msg = short(err.message);
    if (err.kind === "definite") { await db.rpc("payout_fail", { p_id: id, p_reason: msg, p_mined_failed: false }); log(`${id} not sent, returned to user: ${msg}`); return "refunded"; }
    if (err.kind === "retry")    { const to = await db.rpc("payout_defer", { p_id: id, p_note: msg }); log(`${id} will retry (${to}): ${msg}`); return "deferred"; }
    // an unexpected bug before anything was signed: nothing could have been sent
    const to = await db.rpc("payout_defer", { p_id: id, p_note: "Unexpected: " + msg }); log(`${id} unexpected error before signing (${to}): ${msg}`); return "deferred";
  }
  // RULE 3: the hash is stored first. If we cannot store it, we do not broadcast.
  let stored = false;
  try { stored = (await db.rpc("payout_set_hash", { p_id: id, p_hash: prepared.hash, p_meta: prepared.meta ?? null })) === true; } catch (_) { stored = false; }
  if (!stored) { log(`${id} could not record the hash, nothing broadcast; it will be retried`); return "not_recorded"; }  // payout_release_stale() requeues it
  try {
    await chain.broadcast(prepared);
  } catch (e) {
    const err = e as ChainError, msg = short(err.message);
    if (err.kind === "definite") { await db.rpc("payout_fail", { p_id: id, p_reason: msg, p_mined_failed: true }); log(`${id} refused by the network, returned to user: ${msg}`); return "refunded"; }
    await db.rpc("payout_flag", { p_id: id, p_note: "Broadcast result unclear (" + msg + "). Hash " + prepared.hash + " is being checked." });
    log(`${id} broadcast unclear, money stays held: ${msg}`); return "unclear";
  }
  // RULE 5: wait for it to be mined
  const t0 = Date.now();
  for (;;) {
    let st: MinedState = "none";
    try { st = await chain.receipt(prepared.hash, row.symbol, prepared.meta ?? null); } catch (_) { /* keep waiting */ }
    if (st === "success") { await db.rpc("payout_complete", { p_id: id, p_hash: prepared.hash }); log(`${id} completed ${prepared.hash}`); return "completed"; }
    if (st === "failed")  { await db.rpc("payout_fail", { p_id: id, p_reason: "The transaction failed on the network", p_mined_failed: true }); log(`${id} mined as FAILED, returned to user`); return "refunded"; }
    if (Date.now() - t0 > waitMs) { log(`${id} sent, waiting for confirmation (${prepared.hash})`); return "sent_unconfirmed"; }
    await chain.sleep(3000);
  }
}

/** Re-check payouts that were broadcast but not yet seen as mined. Returns how many are still open, per lane. */
export async function reconcile(db: Db, chain: Chain, log: Log): Promise<Record<string, number>> {
  await db.rpc("payout_release_stale", {});
  const rows: { id: string; symbol: string; tx_hash: string; payout_meta: string | null; processing_at: string | null; created_at: string }[] = await db.rpc("payout_list_processing", {});
  const open: Record<string, number> = {};
  const addOpen = (symbol: string) => { const l = chain.lane(symbol); open[l] = (open[l] || 0) + 1; };
  for (const r of rows) {
    let st: MinedState = "none";
    try { st = await chain.receipt(r.tx_hash, r.symbol, r.payout_meta); } catch (_) { addOpen(r.symbol); continue; }
    if (st === "success") { await db.rpc("payout_complete", { p_id: r.id, p_hash: r.tx_hash }); log(`${r.id} confirmed ${r.tx_hash}`); }
    else if (st === "failed") { await db.rpc("payout_fail", { p_id: r.id, p_reason: "The transaction failed on the network", p_mined_failed: true }); log(`${r.id} failed or expired on the network, returned to user`); }
    else {
      addOpen(r.symbol);
      const since = Date.parse(r.processing_at || r.created_at);
      if (Date.now() - since > 2 * 3600 * 1000) await db.rpc("payout_flag", { p_id: r.id, p_note: "Not found on the blockchain after 2 hours. Check hash " + r.tx_hash + " and settle with admin_resolve_payout()." });
    }
  }
  return open;
}

/** One run of the function. `items` = the payouts to send (a user's own, or the whole queue). A lane (one chain) with an earlier payout that is
 *  still waiting to be mined does not get a new one yet (keeps the treasury nonce / coins safe); the other lanes carry on. */
export async function run(db: Db, chain: Chain, items: Item[] | null, log: Log, budgetMs = 100000): Promise<Record<string, string>> {
  const t0 = Date.now(), results: Record<string, string> = {};
  const open = await reconcile(db, chain, log);
  const blocked = new Set<string>(Object.keys(open).filter((l) => open[l] > 0));
  for (const l of blocked) log(`lane ${l}: ${open[l]} earlier payout(s) still waiting to be mined; not sending new ones on it yet`);
  const list: Item[] = items ?? await db.rpc("payout_queue", {});
  for (const it of list) {
    if (Date.now() - t0 > budgetMs) break;
    const lane = chain.lane(it.symbol);
    if (blocked.has(lane)) continue;
    const r = await processOne(db, chain, it.id, log, chain.waitMs ? chain.waitMs(it.symbol) : 45000);
    results[it.id] = r;
    if (r === "sent_unconfirmed" || r === "unclear" || r === "not_recorded") blocked.add(lane);   // do not stack more transactions on top of an unsettled one
  }
  return results;
}
