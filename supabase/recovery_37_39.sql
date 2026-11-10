-- Veltrix · RECOVERY after phases 37 / 38 / 39.  EVERY STATEMENT BELOW IS COMMENTED OUT ON PURPOSE: pick ONE situation, read it, then uncomment only that block and run it on the RESTORED COPY first.
-- Nothing here is executed by default and the author has not executed any of it on any database.
-- The ONLY complete rollback is restoring the backup you took before phase 37 (Supabase Database > Backups, or pg_restore of your pg_dump). The blocks below are for PARTIAL recovery when you must keep the database running.

-- ============ R0. FIRST, in every situation: stop money movement and the scanner ============
-- update public.app_flags set enabled = false where key = 'auto_withdraw';          -- no new send is processed
-- (also disable the cron that calls deposit-watch, and the payout-send trigger/cron, in the Supabase dashboard)

-- ============ R1. displayed balances look WRONG after the first watcher run (the app now mirrors the chain) ============
-- The pre-migration numbers are in _pre37_assets (and _bk38_assets). Compare first; the chain is the truth for real coins, the old numbers include database-only credits:
-- select a.user_id, a.symbol, a.amount as now, b.amount as before_37, s.last_balance as chain from public.assets a
--   left join public._pre37_assets b on b.user_id = a.user_id and b.symbol = a.symbol left join public.chain_state s on s.user_id = a.user_id and s.symbol = a.symbol
--  where a.amount is distinct from b.amount order by a.symbol;
-- Put ONE user's old number back (only after you decided the old number was right; the next watcher run will overwrite it again unless the watcher is stopped, R0):
-- update public.assets a set amount = b.amount from public._pre37_assets b where a.user_id = b.user_id and a.symbol = b.symbol and a.user_id = '<USER-UUID>' and a.symbol = '<SYM>';

-- ============ R2. phase 39 caused a problem and you want phase 38 behaviour back (additive phase: no data was changed) ============
-- Stop the scanner and the quote function first (R0). Then the NEW objects can be removed; they hold only scanner state:
-- drop function if exists public.quote_context(uuid,text,text), public.wallet_status_for(uuid), public.chain_health_set(text,boolean,text,jsonb), public.scan_lock_acquire(text,uuid,int),
--   public.scan_lock_release(text,uuid), public.scan_lock_holds(text,uuid), public.chain_cursor_set_fenced(text,bigint,text,uuid), public.scan_progress_get(text), public.scan_progress_get_many(text[]),
--   public.scan_progress_set_fenced(text,jsonb,text,uuid), public.payout_fail_mined(uuid,text,text,numeric,text,bigint,text), public.payout_failed_fee_missing(),
--   public.payout_set_failed_fee(uuid,numeric,text,bigint,text), public.chain_deposits_final(text,text[]);
-- drop table if exists public.scan_lock, public.scan_progress, public.chain_health;
-- Then re-run the sections of schema_phase38_tx_tracking.sql that define public.chain_deposits_open() and public.v_chain_reconciliation (both are create-or-replace) to get their phase 38 versions back.
-- The deployed functions (deposit-watch, payout-quote, payout-send) of version 3 REQUIRE phase 39: redeploy the version-2 functions at the same time, or they will fail.

-- ============ R3. phase 38 caused a problem and you want phase 37 behaviour back ============
-- Deposit rows recorded by phase 38 (kind='deposit' with a tx_hash) are REAL records of real on-chain receipts: do not delete them. Restoring old function text:
-- (a) the phase 37 versions of apply_chain_balance / payout_complete / payout_fail are NOT in _pre37_functions (that snapshot is of the pre-37 text). Re-run schema_phase37_real_onchain.sql: its create-or-replace restores the 37 text of apply_chain_balance,
--     but payout_complete / payout_fail then stay at phase 38's text. This mixed state is NOT tested: prefer restoring the backup.
-- (b) the send gate trigger:   drop trigger if exists transactions_send_gate on public.transactions;

-- ============ R4. phase 37 caused a problem and you want the PRE-37 database back ============
-- Restore the backup. If you must repair in place instead, the exact old function text is in _pre37_functions:
-- select name, args, def from public._pre37_functions order by name;       -- copy each `def` into the SQL editor and run it; wallet_withdraw's NEW signature must be dropped first:
-- drop function if exists public.wallet_withdraw(text,numeric,text,text,uuid,text);                  -- confirm the new signature with: select pg_get_function_identity_arguments(oid) from pg_proc where proname='wallet_withdraw';
-- Old withdrawals signed with the SENDER'S own key can no longer be created once the old function is back; in-flight sends must be settled first (preflight C3).

-- ============ R5. a withdrawal is stuck (processing / unclear) ============
-- Do NOT edit balances by hand. Look first:
-- select id, symbol, amount, status, tx_hash, payout_note, confirmations, failure_kind, updated_at from public.transactions where id = '<TX-UUID>';
-- The chain is the authority: look the hash up in a block explorer. If it is on-chain, payout-send's reconcile will settle it; if the hash is NOT on-chain after the policy window,
-- payout_fail (service role, via payout-send) releases the hold. A manual release is a service-role call made only AFTER you proved on the explorer that nothing was mined:
--   select public.payout_fail('<TX-UUID>', '<reason>', true, 'dropped');     -- 3rd argument TRUE is required when a hash was stored (with FALSE the function refuses and returns false); it works only while status = 'processing'
-- It credits the held amount back to the sender and marks the row cancelled. It cannot be undone, so it is never run on a guess.
