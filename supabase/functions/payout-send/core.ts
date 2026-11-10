// Veltrix · payout-send · the SAFETY LOGIC (no blockchain code here, so it can be tested without a blockchain).
//
// The rules this file enforces, in order:
//   1. A payout is only ever picked up by payout_claim() (queued -> processing), one at a time (payout_lock).
//   0. NO TREASURY: every transaction is signed with the key of the user who sent it (row.phrase), from that user's own address.
//   2. Everything that can fail is done BEFORE broadcasting (checks, fee, balance, signing). Failing here means nothing was sent,
//      so the user's money is returned (definite) or the payout is retried later (retry).
//   3. The transaction hash is saved in the database BEFORE the transaction is broadcast. If that save fails, nothing is broadcast.
//   4. If the broadcast result is unclear (timeout, odd error) the money is NEVER refunded automatically — it stays held, and the
//      hash is looked up on the blockchain later. Only a receipt (mined ok / mined failed) or an admin can settle it.
//   5. A payout is marked completed only when the transaction is mined successfully.

export type Row = { id: string; user_id: string; symbol: string; amount: string; to_address: string; memo?: string | null; payout_attempts: number;
  /** the SENDING USER's recovery phrase, injected by index.ts for the duration of one prepare() call. Never stored, never logged. */
  phrase?: string };
export type Item = { id: string; symbol: string };

/** kind: "definite" = nothing was or will be sent · "retry" = not sent yet, try again later · "unclear" = may or may not have been sent */
export class ChainError extends Error {
  kind: "definite" | "retry" | "unclear";
  constructor(kind: "definite" | "retry" | "unclear", message: string) { super(message); this.kind = kind; }
}
/** meta: a short note stored together with the hash. Chains whose transactions EXPIRE (Solana, XRP) keep the expiry here, so a payout
 *  that was never mined can later be proven dead (and refunded) instead of waiting for a person. */
export type Prepared = { hash: string; raw: string; symbol: string; meta?: string;
  /** the address the transaction spends from (must equal the user's own address on file) and the network fee (an upper-bound estimate where the chain only knows the fee after mining) */
  from?: string; fee?: string; feeSymbol?: string };
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
  /** AFTER receipt() said "success": confirmations, block and the ACTUAL fee the chain charged. Chains that omit it can only use the legacy single-step completion. */
  detail?(hash: string, symbol: string, meta?: string | null): Promise<Detail | null>;
  /** why a payout counts as failed: \"failed\" (mined as failed) | \"expired\" (can never be mined any more) | \"replaced\" (its nonce was used by another transaction) */
  failKind?(hash: string): string;
  /** AFTER receipt() said "failed" because the transaction was MINED and failed: the network fee it still cost, and where it was mined. null = not readable right now. */
  failedDetail?(hash: string, symbol: string, meta?: string | null): Promise<Detail | null>;
}
export type Detail = { confirmations: number; block?: number; blockHash?: string; fee?: string; feeSymbol?: string };
export interface Db { rpc(name: string, args: Record<string, unknown>): Promise<any>; }
export type Log = (msg: string) => void;

const short = (s: string) => String(s || "").slice(0, 280);

/** receipt said "success". Record confirmations + the ACTUAL fee, and complete ONLY when the confirmation policy (kept in the database) is met. */
async function settle(db: Db, chain: Chain, id: string, hash: string, symbol: string, meta: string | null, log: Log): Promise<"completed" | "confirming"> {
  if (!chain.detail) { await db.rpc("payout_complete", { p_id: id, p_hash: hash }); return "completed"; }          // legacy chains (tests only)
  let d: Detail | null = null;
  try { d = await chain.detail(hash, symbol, meta); } catch (_) { d = null; }
  if (!d) return "confirming";                                                                                     // cannot prove depth yet: stay Confirming
  let p: { ready?: boolean } | null = null;
  try { p = await db.rpc("payout_set_progress", { p_id: id, p_confs: d.confirmations, p_block: d.block ?? null, p_block_hash: d.blockHash ?? null, p_fee: d.fee ?? null, p_fee_symbol: d.feeSymbol ?? null }); } catch (_) { p = null; }
  if (!p || !p.ready) return "confirming";
  const ok = await db.rpc("payout_complete", { p_id: id, p_hash: hash });
  if (ok === false) { log(`${id} completion refused by the database (policy not met?)`); return "confirming"; }
  return "completed";
}
const failArgs = (chain: Chain, hash: string) => ({ p_kind: chain.failKind ? chain.failKind(hash) : "failed" });
const failReason = (chain: Chain, hash: string) => ({ failed: "The transaction failed on the network", expired: "The transaction expired before it was mined and can never be mined", replaced: "The transaction was dropped or replaced by another transaction" } as Record<string, string>)[chain.failKind ? chain.failKind(hash) : "failed"] ?? "The transaction failed on the network";


/** A transaction that was MINED but failed still cost a real network fee. Read it, and settle the failure WITH the fee. Expired / replaced transactions were never
 *  mined, so they carry no fee and keep the plain payout_fail(). If the fee cannot be read right now the failure is still settled (the held amount returns) and the fee
 *  is filled in by reconcile() on a later run: it is never silently dropped. */
async function failWithFee(db: Db, chain: Chain, id: string, hash: string, symbol: string, meta: string | null, log: Log): Promise<void> {
  const kind = chain.failKind ? chain.failKind(hash) : "failed";
  if (kind !== "failed" || !chain.failedDetail) { await db.rpc("payout_fail", { p_id: id, p_reason: failReason(chain, hash), p_mined_failed: true, ...failArgs(chain, hash) }); return; }
  let d: Detail | null = null;
  try { d = await chain.failedDetail(hash, symbol, meta); } catch (_) { d = null; }
  try { await db.rpc("payout_fail_mined", { p_id: id, p_reason: failReason(chain, hash), p_kind: kind, p_fee: d?.fee ?? null, p_fee_symbol: d?.feeSymbol ?? null, p_block: d?.block ?? null, p_block_hash: d?.blockHash ?? null }); }
  catch (e) {                                                                                       // phase 39 not installed: the user's money must still come back
    log(`payout_fail_mined unavailable (${String((e as Error)?.message || e).slice(0, 80)}); settling without the fee`);
    await db.rpc("payout_fail", { p_id: id, p_reason: failReason(chain, hash), p_mined_failed: true, ...failArgs(chain, hash) }); return;
  }
  log(d?.fee ? `${id} failed on the network; fee ${d.fee} ${d.feeSymbol} recorded` : `${id} failed on the network; fee not readable yet, will be filled in later`);
}

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
  // sender address + network fee for the history (not critical: a failure here never stops the payout)
  try { if (prepared.from) await db.rpc("payout_set_details", { p_id: id, p_from: prepared.from, p_fee: prepared.fee ?? null, p_fee_symbol: prepared.feeSymbol ?? null }); } catch (_) { /* history detail only */ }
  try {
    await chain.broadcast(prepared);
  } catch (e) {
    const err = e as ChainError, msg = short(err.message);
    if (err.kind === "definite") { await db.rpc("payout_fail", { p_id: id, p_reason: msg, p_mined_failed: true }); log(`${id} refused by the network, returned to user: ${msg}`); return "refunded"; }
    await db.rpc("payout_flag", { p_id: id, p_note: "Broadcast result unclear (" + msg + "). Hash " + prepared.hash + " is being checked." });
    log(`${id} broadcast unclear, money stays held: ${msg}`); return "unclear";
  }
  try { await db.rpc("payout_set_broadcast", { p_id: id }); } catch (_) { /* label only: "Submitted" appears once the network accepted it */ }
  // RULE 5: wait for it to be mined
  const t0 = Date.now();
  for (;;) {
    let st: MinedState = "none";
    try { st = await chain.receipt(prepared.hash, row.symbol, prepared.meta ?? null); } catch (_) { /* keep waiting */ }
    if (st === "success") { const r = await settle(db, chain, id, prepared.hash, row.symbol, prepared.meta ?? null, log); if (r === "completed") { log(`${id} completed ${prepared.hash}`); return "completed"; } }
    if (st === "failed")  { await failWithFee(db, chain, id, prepared.hash, row.symbol, prepared.meta ?? null, log); log(`${id} FAILED on the network, returned to user`); return "refunded"; }
    if (Date.now() - t0 > waitMs) { log(`${id} sent, waiting for confirmation (${prepared.hash})`); return "sent_unconfirmed"; }
    await chain.sleep(3000);
  }
}

/** failed sends whose fee could not be read when they were settled: read it now */
async function backfillFailedFees(db: Db, chain: Chain, log: Log): Promise<void> {
  if (!chain.failedDetail) return;
  let list: { id: string; symbol: string; tx_hash: string; payout_meta: string | null }[] = [];
  try { list = (await db.rpc("payout_failed_fee_missing", {})) || []; } catch (_) { return; }       // phase 39 not installed yet: nothing to do
  for (const r of list) {
    try {
      const d = await chain.failedDetail(r.tx_hash, r.symbol, r.payout_meta);
      if (d?.fee && await db.rpc("payout_set_failed_fee", { p_id: r.id, p_fee: d.fee, p_fee_symbol: d.feeSymbol ?? null, p_block: d.block ?? null, p_block_hash: d.blockHash ?? null })) log(`${r.id} failed-transaction fee ${d.fee} ${d.feeSymbol} recorded`);
    } catch (_) { /* tried again next run */ }
  }
}

/** Re-check payouts that were broadcast but not yet seen as mined. Returns how many are still open, per lane. */
export async function reconcile(db: Db, chain: Chain, log: Log): Promise<Record<string, number>> {
  await db.rpc("payout_release_stale", {});
  const rows: { id: string; symbol: string; tx_hash: string; payout_meta: string | null; processing_at: string | null; created_at: string }[] = await db.rpc("payout_list_processing", {});
  const open: Record<string, number> = {};
  await backfillFailedFees(db, chain, log);
  const addOpen = (symbol: string) => { const l = chain.lane(symbol); open[l] = (open[l] || 0) + 1; };
  for (const r of rows) {
    let st: MinedState = "none";
    try { st = await chain.receipt(r.tx_hash, r.symbol, r.payout_meta); } catch (_) { addOpen(r.symbol); continue; }
    if (st === "success") { const o = await settle(db, chain, r.id, r.tx_hash, r.symbol, r.payout_meta, log); if (o === "completed") log(`${r.id} confirmed ${r.tx_hash}`); else addOpen(r.symbol); }
    else if (st === "failed") { await failWithFee(db, chain, r.id, r.tx_hash, r.symbol, r.payout_meta, log); log(`${r.id} failed, expired or replaced on the network, returned to user`); }
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
