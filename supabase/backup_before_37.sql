-- Veltrix · SNAPSHOT to take immediately BEFORE phase 37 (restored copy first; the live project only after your approval).
-- Adds only new tables named _pre37_*; changes no existing object, row or balance. Safe to run twice (it never overwrites an existing snapshot).
-- Why it exists: phase 38 snapshots assets/transactions/chain_state only when phase 38 runs, i.e. AFTER phase 37 has already replaced functions, and the destructive step (the first
-- deposit-watch run) comes after both. This snapshot also keeps the EXACT text of every function the three phases replace, so the old behaviour can be restored without guessing.
-- A snapshot inside the same database is NOT a backup: take the Supabase backup / pg_dump first (MIGRATION.md §8 step 2). Not executed by the author on any database.
create table if not exists public._pre37_assets       as select now() as bk_at, a.* from public.assets a;
create table if not exists public._pre37_transactions as select now() as bk_at, t.* from public.transactions t;
create table if not exists public._pre37_chain_state  as select now() as bk_at, c.* from public.chain_state c;
create table if not exists public._pre37_app_flags    as select now() as bk_at, f.* from public.app_flags f;
create table if not exists public._pre37_functions    as
  select now() as bk_at, p.proname as name, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('wallet_withdraw','wallet_transfer','apply_chain_balance','payout_complete','payout_fail','payout_set_hash','payout_claim','payout_defer','payout_flag','chain_deposits_open','_coin_network');
do $$ declare t text; begin
  foreach t in array array['_pre37_assets','_pre37_transactions','_pre37_chain_state','_pre37_app_flags','_pre37_functions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop; end $$;
-- what was captured (compare with preflight C4):
select '_pre37_assets' as t, count(*) from public._pre37_assets union all select '_pre37_transactions', count(*) from public._pre37_transactions
union all select '_pre37_chain_state', count(*) from public._pre37_chain_state union all select '_pre37_functions (expect 11 or more rows)', count(*) from public._pre37_functions;
