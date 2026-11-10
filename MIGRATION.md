# Veltrix — database migration (phase 37 → 38), backup and balance reconciliation

**Status: the SQL has NOT been executed by the author.** No Postgres or network was available while it was written. Run it on a Supabase *branch* or a restored copy first.

## 1. What can change or be lost
| Thing | What happens | Can it be lost? |
|---|---|---|
| `assets.amount` that exists only in the database (old DB-only transfers, old credits, imported-wallet credits) | From phase 37 on, the next deposit-watch run **sets** `assets.amount = on-chain balance − sends in flight − deposits below policy`. Anything above that disappears from the app. | **Yes — this is the destructive step.** It happens on the first watcher run after phase 37 (phase 38 keeps the same rule). |
| `transactions` rows with `internal = true` (old database-only transfers) | Untouched. Labelled "Completed (internal ledger)" in the app. | No |
| Old deposit rows (`DP-…`, created from balance increases) | Untouched. They have no hash, so the new unique index ignores them. | No |
| `chain_state` | Gains `tracking_since` and `opening_balance`; existing rows get `opening_balance = last_balance`. | No |
| `payout_complete`, `payout_fail`, `apply_chain_balance` | Replaced (signature of `payout_fail` gains an optional `p_kind`). | Old versions are gone; see the backups below. |

## 2. Before anything: look at what would change
In the SQL editor (it runs as owner; clients cannot read these views):
```sql
select * from public.v_phase38_balance_report where verdict like 'app balance ABOVE%' or verdict like 'NEVER READ%';
select * from public.v_phase38_internal_rows;
```
`db_only_excess` is the amount that exists only in the database for that user/coin. If it is non-zero and you want it kept, **stop** — there is no on-chain coin behind it. (View exists only after phase 38 is applied; to run it *before*, apply only section 6 of the file on the copy, or compare `assets` with `chain_state.last_balance` by hand.)

## 3. Backup
1. Supabase dashboard → Database → Backups (point-in-time if available), **or** `pg_dump "$DATABASE_URL" -Fc -f veltrix_before_38.dump` from your machine.
2. The migration also snapshots `assets`, `transactions` and `chain_state` into `_bk38_*` tables **once** (re-running never overwrites them). Restore example for balances: `update assets a set amount = b.amount from _bk38_assets b where a.user_id=b.user_id and a.symbol=b.symbol;` (only if you decide the old numbers were right).
3. The phrase vault key (`_wallet_key()` / Vault) is **not** in these tables; back it up separately. Without it stored phrases cannot be decrypted.

## 4. Order
1. Phases 13, 14, 15, 17, 18, 19, 21 (if not already run) → `schema_phase37_real_onchain.sql` → `schema_phase38_tx_tracking.sql`.
2. Deploy `deposit-watch` and `payout-send` (README), keep `auto_withdraw = false` until step 5 of TESTING-REAL-MONEY.md.
3. Let deposit-watch run once; then check `select * from v_chain_reconciliation where abs(drift) > 0;`.

## 5. No false balances — how that is enforced
* Nothing is ever incremented from an event: the displayed balance is **assigned** from the confirmed chain balance (`apply_chain_balance`), so a duplicate event cannot credit twice.
* A deposit below the confirmation policy is subtracted from the displayed balance until it is final (`status='confirming'`).
* Deposits mined before `chain_state.tracking_since` are treated as part of `opening_balance` (they were already credited by the old logic) and are **not** recorded again.
* `v_chain_reconciliation`: `expected = opening + deposits in balance − completed sends − actual fees paid in that coin`; `drift ≠ 0` means something is unexplained (an internal contract transfer, a fee recorded only as an estimate on an old send, a deposit older than `tracking_since`, or a bug). It never changes balances by itself.

## 6. Known gaps in the migration
* Sends made before phase 38 have `fee_estimate` but no `fee_actual`, so the reconciliation view under-counts their fees (small positive drift).
* Imported wallets: `opening_balance` is the balance at the first watcher read after import; anything the wallet received before then is not a "deposit" in history.

## 7. Phase 39 (scanner locks, fee quote, failed-tx fees) — see PHASE39.md
Additive: new tables `scan_lock`, `scan_progress`, `chain_health`, new functions, and `create or replace` of `v_chain_reconciliation` (same columns + `of_which_failed_tx_fees`) and `chain_deposits_open()`. No rows are updated or deleted, and `assets` is not touched. **Status: executed only on a local scratch Postgres with stand-in tables, never on your project.** Run it on a branch/restored copy first, after the backup in §3. Rollback: the old view/function definitions are in `schema_phase38_tx_tracking.sql`; the new tables can be dropped.

## 8. Phases 37 + 38 + 39 together — review, order, and the rehearsal on a restored copy (v4)
**Status: static review only. No Postgres was available, so none of this SQL has been executed by me, and I have not touched your database.** The procedure below is for you to run, first on a restored copy, and on the live project only after you approve each step.

### 8.1 Findings of the review
* **Order is strictly 37 → 38 → 39, and no file refers to a later one** (I checked every function, table and column each file uses against the files after it: 37 uses nothing from 38/39; 38 uses nothing from 39). Phase 40 (labels) is optional and independent.
* **Real prerequisites are wider than the header of phase 37 says** (it lists 13, 14, 15, 17, 18, 19, 21). The three files also need objects from phase 3 (`session_ok`, `pin_verify`), 6 (`push_notification`), 8 (`_wallet_key`, `user_wallets`, the Vault secret `wallet_phrase_key`, pgcrypto), 10 (`chain_state`, `asset_prices`), 13 (`_norm_addr`, `_display_name`, `_fmt_amount`, `wallet_addr_lookup`, `transactions.internal`), 14 (`tx_hash`, `payout_*`, `_valid_addr`, `_auto_supported`), 19 (`_coin_network`). `preflight_37_39.sql` checks every one of these and prints which are missing.
* **The three phases are not equally safe.** 39 is additive. 37 and 38 *replace* functions (`wallet_withdraw`, `wallet_transfer`, `apply_chain_balance`, `payout_complete`, `payout_fail`, with new signatures: old callers break), 38 backfills `chain_state` (`opening_balance = last_balance`) and adds a trigger on `transactions`. **None of them changes `assets` by itself — the destructive step is the first `deposit-watch` run after 37**, which sets `assets.amount` to the on-chain balance. Anything above it (database-only credits, old internal transfers, imported-wallet credits) disappears from the app.
* **Version skew is the real danger.** Deploying the v3 functions on a database that stops at 37 or 38 (or the v2 functions on a database at 39) fails at runtime: `payout_fail`'s signature changes in 38; the watcher calls the 39 lease/health functions; the quote calls `quote_context`. Apply all three SQL files **before** deploying v3 functions, and leave the scanner cron and `auto_withdraw` off until the end.
* Phase 38's own snapshot (`_bk38_*`) is taken *after* phase 37 has already replaced functions, so it cannot restore them; `backup_before_37.sql` (new) snapshots the tables **and the exact text of the functions being replaced**.
* A snapshot inside the same database is not a backup. Take the Supabase backup / `pg_dump` too, and back up the Vault key separately (§3.3).

### 8.2 Procedure (every step on the restored copy first)
1. **Restore a copy of your real database** as a new Supabase project (Dashboard → Database → Backups → restore to a new project) or `pg_dump -Fc` → `pg_restore` into a scratch project. Use the copy's own URL and keys; point **no** function, cron or app at the live project while rehearsing. Confirm the copy has a recent `select count(*) from transactions;` equal to live.
2. Take the real backup of the *live* project (Dashboard backup or `pg_dump`) — before the live run, not only before the rehearsal. Back up the Vault key.
3. On the copy, SQL editor: run **`preflight_37_39.sql`**. Every row of section B must be `present = true`; read section C (C1 = balances that would disappear, C3 = sends in flight: settle or cancel them first). Stop and send me anything missing.
4. Set the switches off: `update app_flags set enabled=false where key='auto_withdraw';` and disable the deposit-watch cron.
5. Run **`backup_before_37.sql`**, then `schema_phase37_real_onchain.sql`, then `schema_phase38_tx_tracking.sql`, then `schema_phase39_scanner_locks_quotes_failed_fees.sql` (and, optionally, `schema_phase40_network_labels.sql`). One file at a time; read each result; stop at the first error and send it to me.
6. Run **`postflight_37_39.sql`**: section 1 all `ok = true`; sections 3 (empty / all `false`) and 5 (`auto_withdraw` still false) are the security checks.
7. Deploy the v3 functions **to the copy's project** with the copy's secrets, run `deposit-watch` **once by hand**, then re-run `postflight` section 6 and `preflight` C1. Compare each user's app balance with the chain: the numbers that moved are exactly what the live run will do to your users. Decide before the live run whether any database-only credit must be preserved (there is no on-chain coin behind it).
8. Rehearse a recovery: pick one scenario of **`recovery_37_39.sql`** (R1 balance restore from `_pre37_assets`, R2 drop phase 39, R5 stuck send) and run it on the copy.
9. Only then: schedule a quiet window, repeat steps 2–6 on live with `auto_withdraw = false` and the cron off, deploy functions, run the watcher once by hand, check, enable the cron, and follow TESTING-REAL-MONEY.md before enabling sends.

### 8.3 Recovery in one paragraph
The only complete rollback is the backup from step 2. `recovery_37_39.sql` (everything commented out on purpose) covers partial cases: restore one user's old balance from `_pre37_assets`; remove the additive phase 39 objects; restore the old text of replaced functions from `_pre37_functions`; release a stuck send by the one supported function (`payout_fail` with proof from a block explorer). Mixed states (e.g. 38 reverted but 39 kept) are **untested** — prefer restoring the backup.

### 8.4 What I could not do
Run any of it. If a statement errors on your database, that is the finding: paste the error and I will fix the file.
