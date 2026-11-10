-- Veltrix · PREFLIGHT for phases 37 + 38 + 39 (+ optional 40).  READ-ONLY: it contains only SELECTs. Safe on any database, including the live one.
-- Run it in the Supabase SQL editor of the RESTORED COPY first (MIGRATION.md §8). It answers three questions:
--   A. which of the phases are already applied?   B. is everything the three files DEPEND ON present?   C. what would phase 37/38 destroy or ignore (the numbers to read first)?
-- Not executed by the author on any database (no Postgres was available). If a query errors, that error is itself the finding: send it to me.

-- A) which phases are already applied (a marker object per phase) ------------------------------------------------------------------------------
select 'phase 37' as phase, to_regclass('public.tx_auth_events') is not null as applied
union all select 'phase 38', to_regclass('public.chain_policy') is not null and to_regclass('public.chain_cursor') is not null
union all select 'phase 39', to_regclass('public.scan_lock') is not null and to_regclass('public.chain_health') is not null
union all select 'phase 40 (optional label)', coalesce(public._coin_network('TRX') = 'TRON', false);

-- B) dependencies: every row must say present = true before you run anything ---------------------------------------------------------------------
with need(kind, name) as (values
  ('table','public.profiles'),('table','public.assets'),('table','public.transactions'),('table','public.chain_state'),('table','public.app_flags'),
  ('table','public.user_wallets'),('table','public.wallet_addr_lookup'),('table','public.asset_prices'),('table','public.user_security'),
  ('fn','_wallet_key'),('fn','session_ok'),('fn','pin_verify'),('fn','push_notification'),('fn','_norm_addr'),('fn','_display_name'),('fn','_fmt_amount'),
  ('fn','_valid_addr'),('fn','_auto_supported'),('fn','_coin_network'),('fn','wallet_withdraw'),('fn','wallet_transfer'),('fn','payout_claim'),('fn','payout_defer'),
  ('fn','payout_flag'),('fn','payout_set_hash'),('fn','apply_chain_balance')
)
select kind, name,
  case kind when 'table' then to_regclass(name) is not null
            else exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = need.name) end as present
from need order by present, kind, name;

select 'transactions.' || c as needed_column, exists (select 1 from information_schema.columns where table_schema='public' and table_name='transactions' and column_name=c) as present
from unnest(array['internal','tx_hash','payout_attempts','payout_note','network','reference','to_address','cancel_reason','reviewed_at','status','kind','symbol','amount','usd_value','wallet','user_id']) c order by present, c;

select 'extension ' || e as needed, exists (select 1 from pg_extension where extname = e) as present from unnest(array['pgcrypto']) e
union all select 'vault secret wallet_phrase_key', exists (select 1 from vault.decrypted_secrets where name = 'wallet_phrase_key')    -- fails if the Vault extension is absent: that is the finding
union all select 'app_flags row auto_withdraw', exists (select 1 from public.app_flags where key = 'auto_withdraw');

-- the CURRENT value of every kill switch (you want auto_withdraw = false while migrating)
select key, enabled from public.app_flags order by key;

-- C) what phase 37 / 38 would do to existing data -------------------------------------------------------------------------------------------------
-- C1. balances that exist only in the database (no address-level proof): the first deposit-watch run after phase 37 REPLACES assets.amount with the on-chain balance.
select a.user_id, a.symbol, a.amount as app_balance, coalesce(cs.last_balance, 0) as last_chain_balance_read, cs.updated_at as chain_read_at,
       case when cs.user_id is null then 'NEVER READ ON-CHAIN: will be set from the chain (possibly to 0)' when a.amount > cs.last_balance then 'app balance ABOVE chain: the excess disappears' else 'ok' end as verdict
from public.assets a left join public.chain_state cs on cs.user_id = a.user_id and cs.symbol = a.symbol
where a.amount > 0 and (cs.user_id is null or a.amount > cs.last_balance) order by a.symbol, a.amount desc;

-- C2. old database-only transfers and credits (kept untouched, but they explain C1)
select kind, internal, status, count(*) as rows, coalesce(sum(amount), 0) as total_amount from public.transactions where internal is true or (kind = 'deposit' and tx_hash is null) group by 1, 2, 3 order by 1, 2, 3;

-- C3. withdrawals that are mid-flight right now (finish or cancel them BEFORE migrating: the payout functions are replaced by phases 37/38)
select id, user_id, symbol, amount, status, payout_attempts, tx_hash, created_at from public.transactions where kind = 'send' and status in ('pending','processing','queued') order by created_at;

-- C4. size of the tables that get snapshotted (the snapshot costs this much disk)
select 'assets' as t, count(*) from public.assets union all select 'transactions', count(*) from public.transactions union all select 'chain_state', count(*) from public.chain_state;
