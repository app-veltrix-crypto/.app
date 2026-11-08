-- Veltrix · phase 38: TRANSACTION-LEVEL deposit tracking, confirmation policy, reorg handling, ACTUAL fees, backup + reconciliation.
-- Run AFTER phase 37.  NOT YET RUN against a real database by the author (no Postgres was available in the build environment):
-- run it in a Supabase BRANCH or on a copy first, and read MIGRATION.md before the real one.
--
-- What changes
--   1. Every incoming deposit is ONE row in `transactions` (kind='deposit') carrying the real tx hash, the output reference (vout / log index),
--      sender, receiving address, amount, block number + hash + time, confirmations, and a status:
--         pending (seen, not in a block / not final)  ->  confirming (in a block, below the confirmation policy)  ->  completed (policy met)
--         cancelled (the transaction failed)  ·  dropped (never confirmed, vanished)  ·  reorged (was in a block that was replaced and is gone)
--      A UNIQUE index on (symbol, tx_hash, tx_output_ref, to_address) makes a duplicate record impossible.
--   2. apply_chain_balance() NO LONGER invents deposits from balance increases. It only mirrors the balance:
--         displayed = on-chain balance - sends in flight - deposits that are in a block but below the confirmation policy.
--      Nothing is ever incremented, so a repeated or late event can never credit twice.
--   3. chain_policy holds the confirmation policy per coin (edit it with plain UPDATEs; no redeploy).
--   4. Sends record confirmations, block and the ACTUAL fee paid; a send is only marked completed when the policy is met (payout_complete checks it).
--   5. Backups (_bk38_*), opening balances, a reconciliation view and a pre-migration report.

-- 0) BACKUP (taken once; re-running this file never overwrites it) -------------------------------------------------------------------
create table if not exists public._bk38_assets      as select now() as bk_at, a.* from public.assets a;
create table if not exists public._bk38_transactions as select now() as bk_at, t.* from public.transactions t;
create table if not exists public._bk38_chain_state  as select now() as bk_at, c.* from public.chain_state c;
alter table public._bk38_assets enable row level security;  revoke all on public._bk38_assets from anon, authenticated;
alter table public._bk38_transactions enable row level security;  revoke all on public._bk38_transactions from anon, authenticated;
alter table public._bk38_chain_state enable row level security;  revoke all on public._bk38_chain_state from anon, authenticated;

-- 1) columns -------------------------------------------------------------------------------------------------------------------------
alter table public.transactions add column if not exists tx_output_ref        text;          -- BTC/LTC vout, EVM log index ('native' for plain transfers), '0' elsewhere
alter table public.transactions add column if not exists block_number         bigint;
alter table public.transactions add column if not exists block_hash           text;
alter table public.transactions add column if not exists block_time           timestamptz;   -- the BLOCKCHAIN's timestamp, not ours
alter table public.transactions add column if not exists confirmations        int not null default 0;
alter table public.transactions add column if not exists required_confirmations int;
alter table public.transactions add column if not exists reorg_count          int not null default 0;
alter table public.transactions add column if not exists missing_count        int not null default 0;   -- consecutive checks in which the chain did not know the tx
alter table public.transactions add column if not exists detected_at          timestamptz;
alter table public.transactions add column if not exists last_checked_at      timestamptz;
alter table public.transactions add column if not exists notified_done        boolean not null default false;
alter table public.transactions add column if not exists fee_actual           numeric;       -- what the chain really charged (sends only)
alter table public.transactions add column if not exists fee_actual_at        timestamptz;
alter table public.transactions add column if not exists broadcast_at         timestamptz;   -- set only AFTER the network accepted the broadcast
alter table public.transactions add column if not exists failure_kind         text;          -- failed | dropped | replaced | expired

create unique index if not exists transactions_chain_deposit_uniq
  on public.transactions (symbol, tx_hash, tx_output_ref, to_address)
  where kind = 'deposit' and tx_hash is not null and tx_output_ref is not null;
create index if not exists transactions_deposit_open on public.transactions (user_id, symbol)
  where kind = 'deposit' and status in ('pending','confirming');

alter table public.chain_state add column if not exists tracking_since  timestamptz;   -- deposits mined before this are already inside opening_balance
alter table public.chain_state add column if not exists opening_balance numeric(38,12) not null default 0;
-- existing addresses: everything up to the last balance read was handled by the old balance-increase logic
update public.chain_state set tracking_since = updated_at, opening_balance = last_balance where tracking_since is null;

-- 2) confirmation policy (change with UPDATE; no redeploy) ---------------------------------------------------------------------------
create table if not exists public.chain_policy (
  symbol text primary key, network text not null,
  required_confirmations int not null check (required_confirmations >= 1),
  reorg_watch_depth int not null default 0,          -- completed deposits are re-verified until they are this deep
  note text
);
alter table public.chain_policy enable row level security;  revoke all on public.chain_policy from anon, authenticated;
insert into public.chain_policy(symbol, network, required_confirmations, reorg_watch_depth, note) values
  ('BTC','Bitcoin',3,12,'blocks'),('LTC','Litecoin',6,24,'blocks'),
  ('ETH','Ethereum',12,64,'blocks'),('USDT','Ethereum (ERC-20)',12,64,'blocks'),('USDC','Ethereum (ERC-20)',12,64,'blocks'),
  ('SHIB','Ethereum (ERC-20)',12,64,'blocks'),('LINK','Ethereum (ERC-20)',12,64,'blocks'),
  ('BNB','BNB Smart Chain',15,64,'blocks'),('AVAX','Avalanche C-Chain',5,32,'blocks'),
  ('SOL','Solana',1,0,'1 = FINALIZED commitment'),('XRP','XRP Ledger',1,0,'1 = validated ledger'),('TRX','TRON',1,0,'1 = solidified block')
on conflict (symbol) do nothing;

create table if not exists public.chain_cursor (key text primary key, height bigint not null, updated_at timestamptz not null default now());
alter table public.chain_cursor enable row level security;  revoke all on public.chain_cursor from anon, authenticated;
create or replace function public.chain_cursor_get(p_key text) returns bigint language sql security definer set search_path = public as $$
  select height from public.chain_cursor where key = p_key $$;
create or replace function public.chain_cursor_set(p_key text, p_height bigint) returns void language sql security definer set search_path = public as $$
  insert into public.chain_cursor(key, height) values (p_key, p_height)
  on conflict (key) do update set height = excluded.height, updated_at = now() $$;

create or replace function public._deposit_status(p_confs int, p_required int, p_failed boolean) returns text language sql immutable as $$
  select case when p_failed then 'cancelled' when coalesce(p_confs,0) <= 0 then 'pending'
              when p_confs < p_required then 'confirming' else 'completed' end $$;

-- 3) record / update ONE incoming transaction (service role only) --------------------------------------------------------------------
-- Idempotent: the same (tx, output) can be reported any number of times. Confirmations never go DOWN for the same block (a lagging node must
-- not demote a deposit); they change only when the block hash changed (a real reorganisation) or the tx left its block.
create or replace function public.record_chain_deposit(
  p_user uuid, p_symbol text, p_network text, p_to text, p_from text, p_hash text, p_ref text, p_amount numeric,
  p_block bigint, p_block_hash text, p_block_time timestamptz, p_confs int, p_failed boolean default false, p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sym text := upper(p_symbol); pol public.chain_policy%rowtype; st public.chain_state%rowtype; d public.transactions%rowtype;
        mine text; px numeric; usdv numeric; newst text; confs int := greatest(coalesce(p_confs,0),0); created boolean := false; reorg boolean := false;
begin
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'bad_amount'); end if;
  if p_hash is null or length(p_hash) < 8 or p_ref is null then return jsonb_build_object('ok', false, 'reason', 'bad_hash'); end if;
  select * into pol from public.chain_policy where symbol = sym;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_policy'); end if;
  -- the receiving address must be this user's own address for this coin
  mine := public._my_addr(p_user, sym);
  if mine is null or (case when mine ~* '^(0x|bc1|ltc1)' then lower(mine) <> lower(p_to) else mine <> p_to end) then
    return jsonb_build_object('ok', false, 'reason', 'not_user_address');
  end if;
  select * into st from public.chain_state where user_id = p_user and symbol = sym and address = mine;
  if found and st.tracking_since is not null and p_block_time is not null and p_block_time < st.tracking_since then
    return jsonb_build_object('ok', true, 'skipped', 'before_tracking');                -- already inside the opening balance
  end if;

  select * into d from public.transactions
   where kind = 'deposit' and symbol = sym and tx_hash = p_hash and tx_output_ref = p_ref and to_address = mine for update;
  if not found then
    select usd into px from public.asset_prices where symbol = sym;
    usdv := case when px is null then null else round(p_amount * px, 2) end;
    newst := public._deposit_status(confs, pol.required_confirmations, coalesce(p_failed,false));
    begin
      insert into public.transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, from_address, network, reference,
          tx_hash, tx_output_ref, block_number, block_hash, block_time, confirmations, required_confirmations, detected_at, last_checked_at,
          notified_done, payout_note, created_at)
      values (p_user, 'crypto', 'deposit', sym, p_amount, usdv, newst, mine, left(p_from, 200), left(coalesce(p_network, pol.network), 80),
          'DP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10)), p_hash, p_ref, p_block, p_block_hash, p_block_time, confs,
          pol.required_confirmations, now(), now(), newst = 'completed', null, coalesce(p_block_time, now()))
      returning * into d;
      created := true;
    exception when unique_violation then
      select * into d from public.transactions where kind = 'deposit' and symbol = sym and tx_hash = p_hash and tx_output_ref = p_ref and to_address = mine for update;
    end;
    if created and newst <> 'cancelled' then
      begin perform public.push_notification(p_user, 'deposit',
        case when newst = 'completed' then 'Deposit confirmed' else 'Incoming deposit' end,
        public._fmt_amount(p_amount) || ' ' || sym || case when newst = 'completed' then ' was received and confirmed on the blockchain.'
          else ' was detected on the blockchain (' || confs || '/' || pol.required_confirmations || ' confirmations). It is added to your balance when confirmed.' end);
      exception when others then null; end;
      return jsonb_build_object('ok', true, 'id', d.id, 'status', newst, 'created', true);
    end if;
  end if;

  -- an existing row: move it forward, or back if the chain really changed
  newst := public._deposit_status(confs, pol.required_confirmations, coalesce(p_failed,false));
  if (p_block_hash is null or d.block_hash is null or d.block_hash = p_block_hash) and confs < d.confirmations and newst <> 'cancelled' then
    confs := d.confirmations; newst := public._deposit_status(confs, pol.required_confirmations, coalesce(p_failed,false));   -- same block (or a chain with no block hash) and fewer confirmations = a lagging node: ignore. Demotion happens only via a changed block hash or chain_deposit_missing().
  end if;
  if d.status = 'completed' and newst <> 'completed' then reorg := true; end if;
  update public.transactions set
      status = newst, confirmations = confs, required_confirmations = pol.required_confirmations,
      block_number = coalesce(p_block, block_number), block_hash = coalesce(p_block_hash, block_hash), block_time = coalesce(p_block_time, block_time),
      from_address = coalesce(from_address, left(p_from, 200)), missing_count = 0, last_checked_at = now(),
      reorg_count = reorg_count + case when reorg then 1 else 0 end,
      payout_note = case when reorg then 'Blockchain reorganisation: this deposit is no longer final. Balance follows the chain.' else payout_note end
   where id = d.id returning * into d;
  return jsonb_build_object('ok', true, 'id', d.id, 'status', newst, 'created', false, 'reorg', reorg);
end $$;
revoke all on function public.record_chain_deposit(uuid,text,text,text,text,text,text,numeric,bigint,text,timestamptz,int,boolean,text) from public, anon, authenticated;
grant execute on function public.record_chain_deposit(uuid,text,text,text,text,text,text,numeric,bigint,text,timestamptz,int,boolean,text) to service_role;

-- "the confirmation notification": sent once, the first time a deposit becomes completed after having been announced as incoming
create or replace function public.chain_deposit_notify_done() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id, user_id, symbol, amount from public.transactions
            where kind = 'deposit' and status = 'completed' and not notified_done and tx_hash is not null for update skip locked loop
    update public.transactions set notified_done = true where id = r.id;
    begin perform public.push_notification(r.user_id, 'deposit', 'Deposit confirmed', public._fmt_amount(r.amount) || ' ' || r.symbol || ' is confirmed on the blockchain and added to your balance.');
    exception when others then null; end;
    n := n + 1;
  end loop; return n;
end $$;
revoke all on function public.chain_deposit_notify_done() from public, anon, authenticated;
grant execute on function public.chain_deposit_notify_done() to service_role;

-- deposits that still need watching: not final, or final but not yet deeper than the reorg-watch depth
create or replace function public.chain_deposits_open() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'user_id', t.user_id, 'symbol', t.symbol, 'tx_hash', t.tx_hash, 'ref', t.tx_output_ref,
           'to', t.to_address, 'amount', t.amount, 'from', t.from_address, 'network', t.network, 'block_hash', t.block_hash, 'block_number', t.block_number, 'confirmations', t.confirmations, 'status', t.status)), '[]'::jsonb)
    from (select * from public.transactions t0 where kind = 'deposit' and tx_hash is not null and tx_output_ref is not null
             and (status in ('pending','confirming')
               or (status = 'completed' and confirmations < coalesce((select reorg_watch_depth from public.chain_policy p where p.symbol = t0.symbol), 0)))
          order by created_at desc limit 300) t $$;
revoke all on function public.chain_deposits_open() from public, anon, authenticated;
grant execute on function public.chain_deposits_open() to service_role;

-- the chain did not know this transaction at a re-check. One miss means nothing (flaky node); three in a row means it is gone.
create or replace function public.chain_deposit_missing(p_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; nxt text;
begin
  select * into t from public.transactions where id = p_id and kind = 'deposit' and status in ('pending','confirming','completed') for update;
  if not found then return null; end if;
  update public.transactions set missing_count = missing_count + 1, last_checked_at = now() where id = p_id returning * into t;
  if t.missing_count < 3 then return t.status; end if;
  nxt := case when t.block_hash is not null or t.status in ('confirming','completed') then 'reorged' else 'dropped' end;
  update public.transactions set status = nxt, confirmations = 0, reorg_count = reorg_count + case when nxt = 'reorged' then 1 else 0 end,
         payout_note = case when nxt = 'reorged' then 'This transaction was in a block that was replaced and is no longer on the chain.' else 'This transaction left the network without being confirmed.' end
   where id = p_id;
  return nxt;
end $$;
revoke all on function public.chain_deposit_missing(uuid) from public, anon, authenticated;
grant execute on function public.chain_deposit_missing(uuid) to service_role;

-- 4) balance mirror: NO invented deposits, never incremented ------------------------------------------------------------------------
drop function if exists public.apply_chain_balance(uuid,text,text,text,numeric,text);
create or replace function public.apply_chain_balance(p_user uuid, p_symbol text, p_network text, p_address text, p_balance numeric, p_name text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare st public.chain_state%rowtype; sym text := upper(p_symbol); held numeric; unsettled numeric; shown numeric; w public.user_wallets%rowtype;
begin
  if p_balance is null or p_balance < 0 then raise exception 'bad balance'; end if;
  select * into w from public.user_wallets where user_id = p_user;
  insert into chain_state(user_id, symbol, network, address, last_balance, tracking_since, opening_balance)
    values (p_user, sym, p_network, p_address, p_balance,
            case when coalesce(w.imported, false) then now() else coalesce(w.created_at, now()) end,
            case when coalesce(w.imported, false) then p_balance else 0 end)       -- an IMPORTED wallet may already hold coins: they are the opening balance
    on conflict (user_id, symbol, address) do nothing;
  select * into st from chain_state where user_id = p_user and symbol = sym and address = p_address for update;
  update chain_state set last_balance = p_balance, updated_at = now() where user_id = p_user and symbol = sym and address = p_address;

  -- sends in flight are subtracted ONLY while they are not yet in a block: once mined (confirmations >= 1) the confirmed chain balance already
  -- reflects them, and subtracting again would double-count for the whole confirmation window.
  select coalesce(sum(amount), 0) into held from transactions
   where user_id = p_user and symbol = sym and kind = 'send' and not internal and status in ('queued','processing') and coalesce(confirmations, 0) = 0;
  -- deposits that are in a block (so the confirmed balance already contains them) but below the confirmation policy are not shown yet
  select coalesce(sum(amount), 0) into unsettled from transactions
   where user_id = p_user and symbol = sym and kind = 'deposit' and not internal and to_address = p_address and status = 'confirming';
  shown := greatest(p_balance - held - unsettled, 0);
  if shown = 0 then delete from assets where user_id = p_user and symbol = sym;
  else insert into assets(user_id, symbol, name, amount) values (p_user, sym, p_name, shown)
       on conflict (user_id, symbol) do update set amount = excluded.amount; end if;
  return shown;
end $$;
revoke all on function public.apply_chain_balance(uuid,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.apply_chain_balance(uuid,text,text,text,numeric,text) to service_role;

-- 5) sends: broadcast moment, confirmations, ACTUAL fee, policy-gated completion ----------------------------------------------------
create or replace function public.payout_set_broadcast(p_id uuid) returns void language sql security definer set search_path = public as $$
  update public.transactions set broadcast_at = coalesce(broadcast_at, now()) where id = p_id and status = 'processing' $$;

create or replace function public.payout_set_progress(p_id uuid, p_confs int, p_block bigint, p_block_hash text, p_fee numeric, p_fee_symbol text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; req int;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'processing' for update;
  if not found then return jsonb_build_object('ok', false); end if;
  select required_confirmations into req from public.chain_policy where symbol = t.symbol;
  req := coalesce(req, 1);
  update public.transactions set confirmations = greatest(coalesce(p_confs, 0), 0), required_confirmations = req,
         block_number = coalesce(p_block, block_number), block_hash = coalesce(p_block_hash, block_hash), last_checked_at = now(),
         fee_actual = coalesce(p_fee, fee_actual), fee_actual_at = case when p_fee is not null then now() else fee_actual_at end,
         fee_symbol = coalesce(left(p_fee_symbol, 10), fee_symbol),
         broadcast_at = coalesce(broadcast_at, now())
   where id = p_id;
  return jsonb_build_object('ok', true, 'required', req, 'ready', coalesce(p_confs, 0) >= req);
end $$;
revoke all on function public.payout_set_broadcast(uuid), public.payout_set_progress(uuid,int,bigint,text,numeric,text) from public, anon, authenticated;
grant execute on function public.payout_set_broadcast(uuid), public.payout_set_progress(uuid,int,bigint,text,numeric,text) to service_role;

-- completion only when the confirmation policy is met (the function layer also checks; this is the second lock)
create or replace function public.payout_complete(p_id uuid, p_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; req int;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'processing' for update;
  if not found then return false; end if;
  select required_confirmations into req from public.chain_policy where symbol = t.symbol;
  if t.confirmations < coalesce(req, 1) then return false; end if;
  update public.transactions set status = 'completed', tx_hash = coalesce(p_hash, tx_hash), reviewed_at = now() where id = p_id;
  begin
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal confirmed',
      'Your ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address,''), 10) || '… is confirmed on the blockchain. Hash ' || left(coalesce(coalesce(p_hash, t.tx_hash),''), 12) || '…');
  exception when others then null; end;
  return true;
end $$;
revoke all on function public.payout_complete(uuid,text) from public, anon, authenticated;
grant execute on function public.payout_complete(uuid,text) to service_role;

-- payout_fail gets a reason KIND (failed | dropped | replaced | expired) so history can say what really happened
drop function if exists public.payout_fail(uuid, text, boolean);
create or replace function public.payout_fail(p_id uuid, p_reason text, p_mined_failed boolean default false, p_kind text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'processing' for update;
  if not found then return false; end if;
  if t.tx_hash is not null and not coalesce(p_mined_failed, false) then return false; end if;
  update public.transactions set status = 'cancelled', cancel_reason = left(coalesce(p_reason, 'Could not be sent'), 300), reviewed_at = now(),
         failure_kind = coalesce(left(p_kind, 20), 'failed') where id = p_id;
  insert into public.assets(user_id, symbol, amount) values (t.user_id, t.symbol, t.amount)
  on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
  begin
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal not completed',
      'Your withdrawal of ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address,''), 10) || '… did not go through and the amount was returned to your wallet.');
  exception when others then null; end;
  return true;
end $$;
revoke all on function public.payout_fail(uuid,text,boolean,text) from public, anon, authenticated;
grant execute on function public.payout_fail(uuid,text,boolean,text) to service_role;

-- 6) opening balances, reconciliation, pre-migration report (read-only views; SQL editor / service role only) ------------------------
create or replace view public.v_chain_reconciliation as
select cs.user_id, cs.symbol, cs.address, cs.opening_balance,
       coalesce(dep.amt, 0) as deposits_in_balance,
       coalesce(snd.amt, 0) as sends_completed,
       coalesce(fee.amt, 0) as actual_fees_in_this_coin,
       cs.opening_balance + coalesce(dep.amt, 0) - coalesce(snd.amt, 0) - coalesce(fee.amt, 0) as expected_balance,
       cs.last_balance as onchain_balance,
       cs.last_balance - (cs.opening_balance + coalesce(dep.amt, 0) - coalesce(snd.amt, 0) - coalesce(fee.amt, 0)) as drift
  from public.chain_state cs
  left join lateral (select sum(amount) amt from public.transactions t where t.user_id = cs.user_id and t.symbol = cs.symbol and t.kind = 'deposit'
                       and not t.internal and t.to_address = cs.address and t.status in ('confirming','completed')) dep on true
  left join lateral (select sum(amount) amt from public.transactions t where t.user_id = cs.user_id and t.symbol = cs.symbol and t.kind = 'send'
                       and not t.internal and t.status = 'completed') snd on true
  left join lateral (select sum(fee_actual) amt from public.transactions t where t.user_id = cs.user_id and t.kind = 'send' and not t.internal
                       and t.status = 'completed' and t.fee_symbol = cs.symbol and t.fee_actual is not null) fee on true;
revoke all on public.v_chain_reconciliation from anon, authenticated;

-- BEFORE migrating: which app balances exist only in the database? (compare the app balance with what the address really held at its last read)
create or replace view public.v_phase38_balance_report as
select a.user_id, a.symbol, a.amount as app_balance, cs.last_balance as onchain_at_last_read, cs.updated_at as last_read,
       a.amount - coalesce(cs.last_balance, 0) as db_only_excess,
       case when cs.user_id is null then 'NEVER READ FROM CHAIN: balance is database-only'
            when a.amount > cs.last_balance then 'app balance ABOVE chain: the excess is database-only and will disappear'
            when a.amount < cs.last_balance then 'app balance below chain (in-flight sends or unread deposit)'
            else 'matches' end as verdict
  from public.assets a left join public.chain_state cs on cs.user_id = a.user_id and cs.symbol = a.symbol;
revoke all on public.v_phase38_balance_report from anon, authenticated;

create or replace view public.v_phase38_internal_rows as
select id, user_id, kind, symbol, amount, counterparty_name, status, created_at from public.transactions where internal = true order by created_at;
revoke all on public.v_phase38_internal_rows from anon, authenticated;

-- 7) PRIVATE-TESTING GATE (optional, off by default) ---------------------------------------------------------------------------------
-- 'auto_withdraw' (phase 14) is ONE global switch: on = every account that passes the PIN check can send real coins. This adds a second,
-- narrower switch: when 'send_allowlist_only' is on, only accounts listed in send_allowlist may create a send at all. It does not bypass
-- anything: the PIN, the sender's own key and one-broadcast-per-request all still apply. A refused send raises an error, so nothing is held.
create table if not exists public.send_allowlist (user_id uuid primary key references public.profiles(id) on delete cascade, added_at timestamptz not null default now());
alter table public.send_allowlist enable row level security;  revoke all on public.send_allowlist from anon, authenticated;
insert into public.app_flags(key, enabled) values ('send_allowlist_only', false) on conflict (key) do nothing;

create or replace function public._send_gate() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'send' and not coalesce(new.internal, false)
     and coalesce((select enabled from public.app_flags where key = 'send_allowlist_only'), false)
     and not exists (select 1 from public.send_allowlist where user_id = new.user_id) then
    raise exception 'sending is not enabled for this account (private testing)';
  end if;
  return new;
end $$;
drop trigger if exists transactions_send_gate on public.transactions;
create trigger transactions_send_gate before insert on public.transactions for each row execute function public._send_gate();
