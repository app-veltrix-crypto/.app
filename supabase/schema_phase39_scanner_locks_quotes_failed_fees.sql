-- Veltrix · phase 39: scanner leases + fenced cursors, resumable scan progress, network health, quote context, failed-transaction fees.
-- Run AFTER phase 38.  ADDITIVE ONLY: new tables, new functions, three `create or replace` of existing objects (chain_deposits_open — same signature,
-- v_chain_reconciliation — same columns plus one appended, nothing dropped). No row of any existing table is modified, deleted or rewritten.
-- Tested against a local PostgreSQL 16 with stand-in tables (see TESTING-PHASE39.md); NOT yet run against your Supabase project — run it on a branch/copy first.
--
-- What this adds
--   1. scan_lock  + scan_lock_acquire/release : a LEASE per network (name = 'deposit-scan:BTC' ...). Only the holder of the lease may scan that network.
--   2. chain_cursor_set_fenced / scan_progress_set_fenced : cursor and pagination state can be written ONLY by the current lease holder, so a run whose
--      lease expired (slow provider) can never overwrite the progress of the run that took over.
--   3. scan_progress : per-address pagination state (BTC/LTC/SOL/XRP/TRX) so a long history is swept completely, resumably, and never silently truncated.
--   4. chain_health : the result of the last network-identity check and scan of every network, shown to users as an accurate "can't reach / wrong network" notice.
--   5. wallet_status_for(user) : what the app reads instead of triggering a global scan (own balances, own deposits, own sends, network health).
--   6. quote_context(user, coin, address) : read-only facts for the fee-quotation function. It can NOT return a key, a phrase, or change anything.
--   7. payout_fail_mined / payout_failed_fee_missing / payout_set_failed_fee : a transaction that was MINED BUT FAILED still cost a real network fee;
--      it is recorded (fee_actual) and counted by the reconciliation view.
--   8. chain_deposits_open(): same result, now stalest-first, so a backlog of more than 300 watched deposits is rotated through instead of always rechecking the newest 300.

-- 1) leases ---------------------------------------------------------------------------------------------------------------------------
create table if not exists public.scan_lock (
  name        text primary key,
  owner       uuid not null,
  until_ts    timestamptz not null,
  acquired_at timestamptz not null default now()
);
alter table public.scan_lock enable row level security;  revoke all on public.scan_lock from anon, authenticated;

create or replace function public.scan_lock_acquire(p_name text, p_owner uuid, p_secs int default 180) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int; secs int := least(greatest(coalesce(p_secs, 180), 10), 900);
begin
  insert into public.scan_lock(name, owner, until_ts) values (p_name, p_owner, now() + make_interval(secs => secs))
  on conflict (name) do update
     set owner = excluded.owner, until_ts = excluded.until_ts,
         acquired_at = case when public.scan_lock.owner = excluded.owner then public.scan_lock.acquired_at else now() end
   where public.scan_lock.until_ts < now() or public.scan_lock.owner = excluded.owner;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.scan_lock_release(p_name text, p_owner uuid) returns void
language sql security definer set search_path = public as $$
  update public.scan_lock set until_ts = now() - interval '1 second' where name = p_name and owner = p_owner
$$;

create or replace function public.scan_lock_holds(p_name text, p_owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.scan_lock where name = p_name and owner = p_owner and until_ts > now())
$$;
revoke all on function public.scan_lock_acquire(text,uuid,int), public.scan_lock_release(text,uuid), public.scan_lock_holds(text,uuid) from public, anon, authenticated;
grant execute on function public.scan_lock_acquire(text,uuid,int), public.scan_lock_release(text,uuid), public.scan_lock_holds(text,uuid) to service_role;

-- 2) fenced cursor + progress writes -------------------------------------------------------------------------------------------------
-- returns false (and writes nothing) when the caller no longer holds the lease
create or replace function public.chain_cursor_set_fenced(p_key text, p_height bigint, p_lock text, p_owner uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.scan_lock_holds(p_lock, p_owner) then return false; end if;
  insert into public.chain_cursor(key, height) values (p_key, p_height)
  on conflict (key) do update set height = excluded.height, updated_at = now();
  return true;
end $$;

create table if not exists public.scan_progress (
  key        text primary key,                    -- e.g. 'utxo:BTC:bc1q…', 'sol:<address>', 'xrp:<address>', 'trx:<address>'
  state      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.scan_progress enable row level security;  revoke all on public.scan_progress from anon, authenticated;

create or replace function public.scan_progress_get(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$ select state from public.scan_progress where key = p_key $$;

-- one round trip for many addresses (the watcher reads them all at the start of a lane)
create or replace function public.scan_progress_get_many(p_keys text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(key, state), '{}'::jsonb) from public.scan_progress where key = any(p_keys)
$$;

create or replace function public.scan_progress_set_fenced(p_key text, p_state jsonb, p_lock text, p_owner uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.scan_lock_holds(p_lock, p_owner) then return false; end if;
  insert into public.scan_progress(key, state) values (p_key, p_state)
  on conflict (key) do update set state = excluded.state, updated_at = now();
  return true;
end $$;
revoke all on function public.chain_cursor_set_fenced(text,bigint,text,uuid), public.scan_progress_get(text), public.scan_progress_get_many(text[]),
                       public.scan_progress_set_fenced(text,jsonb,text,uuid) from public, anon, authenticated;
grant execute on function public.chain_cursor_set_fenced(text,bigint,text,uuid), public.scan_progress_get(text), public.scan_progress_get_many(text[]),
                          public.scan_progress_set_fenced(text,jsonb,text,uuid) to service_role;

-- 3) network health ------------------------------------------------------------------------------------------------------------------
create table if not exists public.chain_health (
  network    text primary key,                    -- BTC LTC ETH BNB AVAX SOL XRP TRX ERC20 and '_scanner' (the last run as a whole)
  ok         boolean not null,
  checked_at timestamptz not null default now(),
  last_ok_at timestamptz,
  error      text,
  detail     jsonb not null default '{}'::jsonb
);
alter table public.chain_health enable row level security;  revoke all on public.chain_health from anon, authenticated;

create or replace function public.chain_health_set(p_network text, p_ok boolean, p_error text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.chain_health(network, ok, checked_at, last_ok_at, error, detail)
  values (left(p_network, 20), coalesce(p_ok, false), now(), case when p_ok then now() end, left(p_error, 300), coalesce(p_detail, '{}'::jsonb))
  on conflict (network) do update set ok = excluded.ok, checked_at = now(),
         last_ok_at = case when excluded.ok then now() else public.chain_health.last_ok_at end,
         error = excluded.error, detail = excluded.detail
$$;
revoke all on function public.chain_health_set(text,boolean,text,jsonb) from public, anon, authenticated;
grant execute on function public.chain_health_set(text,boolean,text,jsonb) to service_role;

-- 4) what the app reads (called by deposit-watch in USER mode: a plain database read, no blockchain access, no scan) ----------------------
create or replace function public.wallet_status_for(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balances', coalesce((select jsonb_agg(jsonb_build_object('symbol', a.symbol, 'amount', a.amount) order by a.symbol)
                            from public.assets a where a.user_id = p_user), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc)
                            from (select t.id, t.symbol, t.amount, t.status, t.confirmations, t.required_confirmations, t.tx_hash, t.network,
                                         t.block_number, t.created_at
                                    from public.transactions t where t.user_id = p_user and t.kind = 'deposit'
                                    order by t.created_at desc limit 20) d), '[]'::jsonb),
    'sends',    coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc)
                            from (select t.id, t.symbol, t.amount, t.status, t.confirmations, t.required_confirmations, t.tx_hash, t.fee_actual, t.fee_symbol, t.created_at
                                    from public.transactions t where t.user_id = p_user and t.kind = 'send' and not t.internal
                                    order by t.created_at desc limit 20) s), '[]'::jsonb),
    'networks', coalesce((select jsonb_object_agg(h.network, jsonb_build_object('ok', h.ok, 'checkedAt', h.checked_at, 'lastOkAt', h.last_ok_at,
                                                                                'error', h.error, 'detail', h.detail))
                            from public.chain_health h where h.network <> '_scanner'), '{}'::jsonb),
    'scanner',  (select jsonb_build_object('lastRunAt', h.checked_at, 'ok', h.ok, 'ageSeconds', floor(extract(epoch from (now() - h.checked_at)))::int)
                   from public.chain_health h where h.network = '_scanner')
  )
$$;
revoke all on function public.wallet_status_for(uuid) from public, anon, authenticated;
grant execute on function public.wallet_status_for(uuid) to service_role;

-- which of these hashes are already COMPLETED deposits? (lets the scanners skip a per-transaction lookup for history they already hold)
create or replace function public.chain_deposits_final(p_symbol text, p_hashes text[]) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct t.tx_hash), '{}') from public.transactions t
   where t.kind = 'deposit' and t.symbol = upper(p_symbol) and t.status = 'completed' and t.tx_hash = any(p_hashes)
$$;
revoke all on function public.chain_deposits_final(text,text[]) from public, anon, authenticated;
grant execute on function public.chain_deposits_final(text,text[]) to service_role;

-- 5) quote context (fee-quotation function, service role): READ-ONLY, returns facts about the caller's own wallet, never a key ------------
create or replace function public.quote_context(p_user uuid, p_symbol text, p_to text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare sym text := upper(btrim(coalesce(p_symbol, ''))); addr text := btrim(coalesce(p_to, '')); l public.wallet_addr_lookup%rowtype;
        mine text; net text; is_self boolean := false; cp text := null;
begin
  net := public._coin_network(sym);
  if net is null then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
  mine := public._my_addr(p_user, sym);
  select * into l from public.wallet_addr_lookup where symbol = sym and norm = public._norm_addr(sym, addr);
  if found then
    is_self := (l.user_id = p_user);
    if not is_self then select public._display_name(full_name) into cp from public.profiles where id = l.user_id; end if;
  end if;
  return jsonb_build_object('ok', true, 'symbol', sym, 'network', net, 'from', mine,
    'to_valid', public._valid_addr(sym, addr), 'self', is_self, 'recipient_name', cp,
    'supported', public._auto_supported(sym),
    'sending_enabled', coalesce((select enabled from public.app_flags where key = 'auto_withdraw'), false),
    'assets', coalesce((select jsonb_object_agg(a.symbol, a.amount::text) from public.assets a where a.user_id = p_user), '{}'::jsonb));
end $$;
revoke all on function public.quote_context(uuid,text,text) from public, anon, authenticated;
grant execute on function public.quote_context(uuid,text,text) to service_role;

-- 6) mined-but-failed transactions: the network still charged a fee ------------------------------------------------------------------
-- Same effect as payout_fail() (the held amount goes back, status cancelled) PLUS the real fee, block and a truthful reason. The fee is not
-- deducted from assets here: the balance mirror follows the confirmed chain balance, which already lost the fee. What the fee changes is the
-- history (fee_actual) and the reconciliation view (below), which now counts it so that drift stays 0.
create or replace function public.payout_fail_mined(p_id uuid, p_reason text, p_kind text, p_fee numeric, p_fee_symbol text,
                                                    p_block bigint default null, p_block_hash text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; fs text; why text;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'processing' for update;
  if not found then return false; end if;
  fs := nullif(left(coalesce(p_fee_symbol, ''), 10), '');
  why := coalesce(p_reason, 'The transaction failed on the network')
         || case when p_fee is not null then '. The network still charged a fee of ' || public._fmt_amount(p_fee) || ' ' || coalesce(fs, t.symbol) || '.' else '' end;
  update public.transactions set status = 'cancelled', cancel_reason = left(why, 300), reviewed_at = now(),
         failure_kind = coalesce(left(p_kind, 20), 'failed'),
         fee_actual = p_fee, fee_actual_at = case when p_fee is not null then now() else fee_actual_at end,
         fee_symbol = coalesce(fs, fee_symbol),
         block_number = coalesce(p_block, block_number), block_hash = coalesce(p_block_hash, block_hash),
         confirmations = case when p_block is not null then greatest(confirmations, 1) else confirmations end,
         last_checked_at = now()
   where id = p_id;
  insert into public.assets(user_id, symbol, amount) values (t.user_id, t.symbol, t.amount)
  on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
  begin
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal not completed',
      'Your withdrawal of ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address, ''), 10)
      || '… failed on the network and the amount was returned to your wallet.'
      || case when p_fee is not null then ' The network charged a fee of ' || public._fmt_amount(p_fee) || ' ' || coalesce(fs, t.symbol) || '.' else '' end);
  exception when others then null; end;
  return true;
end $$;

-- failed sends whose fee could not be read at the time (provider error): the watcher fills them in later
create or replace function public.payout_failed_fee_missing() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at), '[]'::jsonb)
    from (select id, created_at, symbol, tx_hash, payout_meta from public.transactions
           where kind = 'send' and not internal and status = 'cancelled' and failure_kind = 'failed'
             and tx_hash is not null and fee_actual is null and created_at > now() - interval '14 days'
           order by created_at limit 50) q
$$;

create or replace function public.payout_set_failed_fee(p_id uuid, p_fee numeric, p_fee_symbol text, p_block bigint default null, p_block_hash text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; fs text;
begin
  if p_fee is null or p_fee < 0 then return false; end if;
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'cancelled' and failure_kind = 'failed' and fee_actual is null for update;
  if not found then return false; end if;
  fs := nullif(left(coalesce(p_fee_symbol, ''), 10), '');
  update public.transactions set fee_actual = p_fee, fee_actual_at = now(), fee_symbol = coalesce(fs, fee_symbol),
         block_number = coalesce(p_block, block_number), block_hash = coalesce(p_block_hash, block_hash),
         cancel_reason = left(coalesce(cancel_reason, 'The transaction failed on the network') || ' The network charged a fee of ' || public._fmt_amount(p_fee) || ' ' || coalesce(fs, t.symbol) || '.', 300)
   where id = p_id;
  return true;
end $$;
revoke all on function public.payout_fail_mined(uuid,text,text,numeric,text,bigint,text), public.payout_failed_fee_missing(),
                       public.payout_set_failed_fee(uuid,numeric,text,bigint,text) from public, anon, authenticated;
grant execute on function public.payout_fail_mined(uuid,text,text,numeric,text,bigint,text), public.payout_failed_fee_missing(),
                          public.payout_set_failed_fee(uuid,numeric,text,bigint,text) to service_role;

-- reconciliation: expected = opening + deposits - completed sends - ALL fees paid (completed sends AND mined-but-failed sends).
-- Same columns as before in the same order; the failed-fee part is appended as its own column so you can see it.
create or replace view public.v_chain_reconciliation as
select cs.user_id, cs.symbol, cs.address, cs.opening_balance,
       coalesce(dep.amt, 0) as deposits_in_balance,
       coalesce(snd.amt, 0) as sends_completed,
       coalesce(fee.amt, 0) as actual_fees_in_this_coin,
       cs.opening_balance + coalesce(dep.amt, 0) - coalesce(snd.amt, 0) - coalesce(fee.amt, 0) as expected_balance,
       cs.last_balance as onchain_balance,
       cs.last_balance - (cs.opening_balance + coalesce(dep.amt, 0) - coalesce(snd.amt, 0) - coalesce(fee.amt, 0)) as drift,
       coalesce(ff.amt, 0) as of_which_failed_tx_fees
  from public.chain_state cs
  left join lateral (select sum(amount) amt from public.transactions t where t.user_id = cs.user_id and t.symbol = cs.symbol and t.kind = 'deposit'
                       and not t.internal and t.to_address = cs.address and t.status in ('confirming','completed')) dep on true
  left join lateral (select sum(amount) amt from public.transactions t where t.user_id = cs.user_id and t.symbol = cs.symbol and t.kind = 'send'
                       and not t.internal and t.status = 'completed') snd on true
  left join lateral (select sum(fee_actual) amt from public.transactions t where t.user_id = cs.user_id and t.kind = 'send' and not t.internal
                       and (t.status = 'completed' or (t.status = 'cancelled' and t.failure_kind = 'failed' and t.tx_hash is not null))
                       and t.fee_symbol = cs.symbol and t.fee_actual is not null) fee on true
  left join lateral (select sum(fee_actual) amt from public.transactions t where t.user_id = cs.user_id and t.kind = 'send' and not t.internal
                       and t.status = 'cancelled' and t.failure_kind = 'failed' and t.tx_hash is not null
                       and t.fee_symbol = cs.symbol and t.fee_actual is not null) ff on true;
revoke all on public.v_chain_reconciliation from anon, authenticated;

-- 7) deposits that still need watching: STALEST FIRST, so a backlog bigger than the batch is rotated through (was: newest 300 forever) -----
create or replace function public.chain_deposits_open() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'user_id', t.user_id, 'symbol', t.symbol, 'tx_hash', t.tx_hash, 'ref', t.tx_output_ref,
           'to', t.to_address, 'amount', t.amount, 'from', t.from_address, 'network', t.network, 'block_hash', t.block_hash, 'block_number', t.block_number,
           'confirmations', t.confirmations, 'status', t.status) order by coalesce(t.last_checked_at, 'epoch'::timestamptz) asc), '[]'::jsonb)
    from (select * from public.transactions t0 where kind = 'deposit' and tx_hash is not null and tx_output_ref is not null
             and (status in ('pending','confirming')
               or (status = 'completed' and confirmations < coalesce((select reorg_watch_depth from public.chain_policy p where p.symbol = t0.symbol), 0)))
          order by coalesce(last_checked_at, 'epoch'::timestamptz) asc, created_at asc limit 300) t $$;
