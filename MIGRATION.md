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
