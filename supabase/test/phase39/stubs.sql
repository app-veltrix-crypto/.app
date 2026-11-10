-- Minimal stand-ins for the objects phase 39 touches (the real ones come from phases 2-38). Only for the local SQL test.
do $$ begin create role anon; exception when duplicate_object then null; end $$; do $$ begin create role authenticated; exception when duplicate_object then null; end $$; do $$ begin create role service_role; exception when duplicate_object then null; end $$;

create table public.profiles (id uuid primary key, full_name text);
create table public.assets (user_id uuid, symbol text, name text, amount numeric not null default 0, primary key (user_id, symbol));
create table public.asset_prices (symbol text primary key, usd numeric);
create table public.app_flags (key text primary key, enabled boolean not null default false);
create table public.user_wallets (user_id uuid primary key, addresses jsonb not null default '[]', created_at timestamptz default now());
create table public.wallet_addr_lookup (symbol text, norm text, user_id uuid, primary key (symbol, norm));
create table public.chain_policy (symbol text primary key, network text, required_confirmations int, reorg_watch_depth int default 0);
create table public.chain_state (user_id uuid, symbol text, network text, address text, last_balance numeric default 0, opening_balance numeric default 0, updated_at timestamptz default now(), primary key (user_id, symbol, address));
create table public.chain_cursor (key text primary key, height bigint not null, updated_at timestamptz not null default now());
create table public.transactions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, kind text not null, symbol text not null, amount numeric not null, status text not null,
  internal boolean not null default false, to_address text, from_address text, network text, tx_hash text, tx_output_ref text, block_number bigint, block_hash text,
  block_time timestamptz, confirmations int not null default 0, required_confirmations int, fee_actual numeric, fee_actual_at timestamptz, fee_symbol text,
  failure_kind text, cancel_reason text, reviewed_at timestamptz, last_checked_at timestamptz, payout_meta text, created_at timestamptz not null default now());
create or replace function public._coin_network(p text) returns text language sql immutable as $$ select case upper(p) when 'BTC' then 'Bitcoin' when 'ETH' then 'Ethereum' when 'USDT' then 'Ethereum (ERC-20)' end $$;
create or replace function public._valid_addr(p_symbol text, p_addr text) returns boolean language sql immutable as $$ select p_addr ~ '^(0x[0-9a-fA-F]{40}|bc1[a-z0-9]{20,60})$' $$;
create or replace function public._auto_supported(p text) returns boolean language sql immutable as $$ select upper(p) in ('BTC','ETH','USDT') $$;
create or replace function public._my_addr(p_user uuid, p_sym text) returns text language sql stable as $$
  select a->>'address' from public.user_wallets w, jsonb_array_elements(w.addresses) a where w.user_id = p_user and upper(a->>'symbol') = upper(p_sym) limit 1 $$;
create or replace function public._norm_addr(p_sym text, p_addr text) returns text language sql immutable as $$ select lower(p_addr) $$;
create or replace function public._display_name(n text) returns text language sql immutable as $$ select n $$;
create or replace function public._fmt_amount(n numeric) returns text language sql immutable as $$ select trim(trailing '.' from trim(trailing '0' from n::text)) $$;
create table public.pushed (user_id uuid, title text, body text);
create or replace function public.push_notification(u uuid, k text, t text, b text) returns void language sql as $$ insert into public.pushed values (u, t, b) $$;
-- the phase 38 function that phase 39 replaces (same signature)
create or replace function public.chain_deposits_open() returns jsonb language sql as $$ select '[]'::jsonb $$;
create or replace view public.v_chain_reconciliation as select 1 as x;
