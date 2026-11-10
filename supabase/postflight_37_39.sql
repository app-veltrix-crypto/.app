-- Veltrix · POSTFLIGHT for phases 37 + 38 + 39.  READ-ONLY (SELECTs only).  Run it after the three files, on the restored copy first.  Every "ok" column must be true.
-- Not executed by the author on any database.

-- 1) objects each phase should have created ------------------------------------------------------------------------------------------------------------
with need(phase, kind, name) as (values
 (37,'table','tx_auth_events'),(37,'fn','payout_signing_phrase'),(37,'fn','payout_set_details'),(37,'fn','_my_addr'),(37,'fn','_auth_event'),
 (38,'table','chain_policy'),(38,'table','chain_cursor'),(38,'table','send_allowlist'),(38,'table','_bk38_assets'),(38,'table','_bk38_transactions'),(38,'table','_bk38_chain_state'),
 (38,'view','v_chain_reconciliation'),(38,'view','v_phase38_balance_report'),(38,'view','v_phase38_internal_rows'),
 (38,'fn','record_chain_deposit'),(38,'fn','chain_cursor_get'),(38,'fn','chain_cursor_set'),(38,'fn','chain_deposits_open'),(38,'fn','chain_deposit_missing'),(38,'fn','payout_complete'),(38,'fn','payout_fail'),(38,'fn','payout_set_broadcast'),(38,'fn','payout_set_progress'),(38,'fn','_send_gate'),
 (39,'table','scan_lock'),(39,'table','scan_progress'),(39,'table','chain_health'),
 (39,'fn','scan_lock_acquire'),(39,'fn','scan_lock_release'),(39,'fn','scan_lock_holds'),(39,'fn','chain_cursor_set_fenced'),(39,'fn','scan_progress_get'),(39,'fn','scan_progress_set_fenced'),
 (39,'fn','chain_health_set'),(39,'fn','wallet_status_for'),(39,'fn','quote_context'),(39,'fn','payout_fail_mined'),(39,'fn','payout_failed_fee_missing'),(39,'fn','payout_set_failed_fee'),(39,'fn','chain_deposits_final'))
select phase, kind, name,
  case kind when 'fn' then exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname = need.name)
            else to_regclass('public.' || name) is not null end as ok
from need order by ok, phase, kind, name;

-- 2) the confirmation policy rows (edit with UPDATE if you disagree) and a trigger that gates sends
select * from public.chain_policy order by symbol;
select tgname, tgenabled from pg_trigger where tgname = 'transactions_send_gate' and not tgisinternal;

-- 3) nothing the clients must not touch is exposed: these tables must show NO privileges for anon / authenticated
select table_name, grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated')
  and table_name in ('tx_auth_events','scan_lock','scan_progress','chain_health','chain_cursor','chain_policy','_bk38_assets','_bk38_transactions','_bk38_chain_state');
-- (an empty result is the pass condition)
select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_can_run, has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_run
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('payout_signing_phrase','payout_set_details','payout_complete','payout_fail','payout_fail_mined','record_chain_deposit','chain_cursor_set','chain_cursor_set_fenced','scan_lock_acquire','quote_context','chain_health_set','apply_chain_balance','payout_set_failed_fee');
-- (every row must show false / false: these are service-role-only)

-- 4) the snapshots hold what existed before (row counts must be >= what preflight C4 showed)
select '_bk38_assets' as t, count(*) from public._bk38_assets union all select '_bk38_transactions', count(*) from public._bk38_transactions union all select '_bk38_chain_state', count(*) from public._bk38_chain_state;

-- 5) the kill switch must still be OFF until TESTING-REAL-MONEY.md says otherwise
select key, enabled from public.app_flags where key in ('auto_withdraw','send_allowlist_only');

-- 6) after the FIRST deposit-watch run: money that does not add up (an empty result is the pass condition; read MIGRATION.md §5 for what a non-zero drift means)
select * from public.v_chain_reconciliation where abs(drift) > 0;
select * from public.chain_health order by network;                      -- every network: ok = true, a recent checked_at
select * from public.v_phase38_balance_report where verdict like 'app balance ABOVE%' or verdict like 'NEVER READ%';
