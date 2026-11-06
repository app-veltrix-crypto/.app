-- Veltrix · phase 14: withdrawals to OUTSIDE wallets (Binance, Bybit, any other app or wallet), with optional automatic on-chain sending.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run   (needs phases 2–10 and 13 already applied)
--
-- What changes
--   * wallet_withdraw() is the ONE way to send to an outside address. The SERVER checks the 2FA PIN, the address format for that
--     coin, the balance and the limits, then holds the amount. (The old wallet_send() let a modified app skip the PIN, so it is switched off.)
--   * Where the money goes next:
--       - auto sending OFF (the default), coin not supported, amount above a limit, or price unknown  ->  status "pending": the admin
--         approves or cancels in Admin → Approvals, exactly as before;
--       - auto sending ON and within limits  ->  status "queued": the payout-send edge function sends it on-chain from the TREASURY
--         wallet and records the transaction hash. See supabase/functions/payout-send/README.md before you switch it on.
--   * If an automatic send definitely did not leave the treasury, the held amount is returned to the user. If it is unclear whether it
--     did, the money stays held and is NEVER refunded automatically (that could pay twice) — an admin settles it with admin_resolve_payout().
--   * Nothing is sent automatically until you run:  update public.app_flags set enabled = true where key = 'auto_withdraw';

-- 1) bookkeeping
alter table public.transactions add column if not exists tx_hash          text;
alter table public.transactions add column if not exists processing_at    timestamptz;
alter table public.transactions add column if not exists payout_attempts  int not null default 0;
alter table public.transactions add column if not exists payout_note      text;
create index if not exists transactions_queued on public.transactions (created_at) where status in ('queued','processing');

create table if not exists public.app_flags (key text primary key, enabled boolean not null default false);
alter table public.app_flags enable row level security;
revoke all on public.app_flags from anon, authenticated;
insert into public.app_flags(key, enabled) values ('auto_withdraw', false) on conflict (key) do nothing;

create table if not exists public.app_settings (key text primary key, num numeric not null);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
-- automatic sending only happens up to these dollar amounts; anything bigger waits for admin approval
insert into public.app_settings(key, num) values ('auto_max_usd_per_tx', 500), ('auto_max_usd_per_day', 2000) on conflict (key) do nothing;

-- only one automatic payout may run at a time (the treasury wallet has a single nonce counter)
create table if not exists public.payout_mutex (id int primary key check (id = 1), owner uuid, until_ts timestamptz);
alter table public.payout_mutex enable row level security;
revoke all on public.payout_mutex from anon, authenticated;

-- 2) per-coin rules (the network is decided HERE, never taken from the app)
create or replace function public._coin_network(p text) returns text
language sql immutable set search_path = public as $$
  select case upper(p)
    when 'BTC' then 'Bitcoin'                when 'LTC'  then 'Litecoin'            when 'BCH'  then 'Bitcoin Cash'
    when 'ETH' then 'Ethereum (ERC-20)'      when 'USDT' then 'Ethereum (ERC-20)'   when 'USDC' then 'Ethereum (ERC-20)'
    when 'SHIB' then 'Ethereum (ERC-20)'     when 'LINK' then 'Ethereum (ERC-20)'
    when 'BNB' then 'BNB Smart Chain'        when 'AVAX' then 'Avalanche C-Chain'   when 'HBAR' then 'Hedera (EVM address)'
    when 'SOL' then 'Solana'                 when 'XRP'  then 'XRP Ledger'         when 'DOGE' then 'Dogecoin'
    when 'TRX' then 'TRON (TRC-20)'          when 'TON'  then 'TON'                 when 'ADA'  then 'Cardano'
    when 'XLM' then 'Stellar'                when 'SUI'  then 'Sui'                 when 'DOT'  then 'Polkadot'
    else null end
$$;

-- same address rules as the Send screen, checked on the server
create or replace function public._valid_addr(p_symbol text, p_addr text) returns boolean
language sql immutable set search_path = public as $$
  select case upper(p_symbol)
    when 'BTC'  then p_addr ~ '^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$'
    when 'LTC'  then p_addr ~ '^(ltc1[a-z0-9]{25,62}|[LM][1-9A-HJ-NP-Za-km-z]{26,33})$'
    when 'BCH'  then p_addr ~* '^(bitcoincash:)?[qp][a-z0-9]{41}$'
    when 'ETH'  then p_addr ~ '^0x[a-fA-F0-9]{40}$'   when 'USDT' then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'USDC' then p_addr ~ '^0x[a-fA-F0-9]{40}$'   when 'SHIB' then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'LINK' then p_addr ~ '^0x[a-fA-F0-9]{40}$'   when 'BNB'  then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'AVAX' then p_addr ~ '^0x[a-fA-F0-9]{40}$'   when 'HBAR' then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'SUI'  then p_addr ~ '^0x[a-fA-F0-9]{64}$'
    when 'SOL'  then p_addr ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    when 'XRP'  then p_addr ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'
    when 'DOGE' then p_addr ~ '^[DA9][1-9A-HJ-NP-Za-km-z]{33}$'
    when 'TRX'  then p_addr ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'
    when 'TON'  then p_addr ~ '^(EQ|UQ)[A-Za-z0-9_-]{46}$'
    when 'ADA'  then p_addr ~ '^addr1[a-z0-9]{50,110}$'
    when 'XLM'  then p_addr ~ '^G[A-Z2-7]{55}$'
    when 'DOT'  then p_addr ~ '^1[1-9A-HJ-NP-Za-km-z]{46,47}$'
    else false end
$$;

-- coins the edge function can send on its own (Ethereum, BNB Smart Chain and Avalanche C-Chain families)
create or replace function public._auto_supported(p text) returns boolean
language sql immutable set search_path = public as $$
  select upper(p) in ('ETH','USDT','USDC','SHIB','LINK','BNB','AVAX')
$$;
revoke all on function public._coin_network(text), public._valid_addr(text,text), public._auto_supported(text) from public, anon, authenticated;

-- 3) the withdrawal request. Returns {ok:true,...} or {ok:false, reason:...}; raises only for a revoked session.
create or replace function public.wallet_withdraw(p_symbol text, p_amount numeric, p_address text, p_pin text, p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid(); sym text := upper(btrim(coalesce(p_symbol,''))); addr text := btrim(coalesce(p_address,''));
  net text; sec public.user_security%rowtype; prev public.transactions%rowtype; nm text;
  px numeric; usdv numeric; day_usd numeric; max_tx numeric; max_day numeric; auto boolean := false;
  st text; ref text; tid uuid; ts timestamptz := now(); amt_txt text; short text;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  if p_request is null then raise exception 'request id required'; end if;

  select * into prev from public.transactions where user_id = me and request_id = p_request;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'id', prev.id, 'status', prev.status, 'reference', prev.reference,
      'created_at', prev.created_at, 'amount', prev.amount, 'symbol', prev.symbol, 'usd_value', prev.usd_value, 'network', prev.network);
  end if;

  net := public._coin_network(sym);
  if net is null then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount, 8) or p_amount > 100000000000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;
  -- USDT and USDC only exist with 6 decimals on the blockchain, so a smaller piece than 0.000001 can never be sent
  if sym in ('USDT','USDC') and p_amount <> trunc(p_amount, 6) then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
  if not public._valid_addr(sym, addr) then return jsonb_build_object('ok', false, 'reason', 'invalid_address'); end if;

  -- 2FA PIN, on the server
  select * into sec from public.user_security where user_id = me;
  if not found or sec.pin_hash is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
  if sec.locked_until is not null and sec.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', ceil(extract(epoch from (sec.locked_until - now())))::int);
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' or not public.pin_verify(p_pin) then
    return jsonb_build_object('ok', false, 'reason', 'bad_pin');
  end if;

  -- an address that belongs to a Veltrix user must use wallet_transfer (instant, and the money really arrives)
  if exists (select 1 from public.wallet_addr_lookup where symbol = sym and norm = public._norm_addr(sym, addr)) then
    return jsonb_build_object('ok', false, 'reason', 'internal_recipient');
  end if;

  -- one withdrawal at a time per user, so the daily limit below cannot be raced
  perform pg_advisory_xact_lock(hashtextextended('withdraw:' || me::text, 0));
  select * into prev from public.transactions where user_id = me and request_id = p_request;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'id', prev.id, 'status', prev.status, 'reference', prev.reference,
      'created_at', prev.created_at, 'amount', prev.amount, 'symbol', prev.symbol, 'usd_value', prev.usd_value, 'network', prev.network);
  end if;

  select usd into px from public.asset_prices where symbol = sym;
  usdv := case when px is null then null else round(p_amount * px, 2) end;

  -- automatic or admin approval?
  if coalesce((select enabled from public.app_flags where key = 'auto_withdraw'), false)
     and public._auto_supported(sym) and usdv is not null then
    select num into max_tx  from public.app_settings where key = 'auto_max_usd_per_tx';
    select num into max_day from public.app_settings where key = 'auto_max_usd_per_day';
    select coalesce(sum(usd_value), 0) into day_usd from public.transactions
     where user_id = me and kind = 'send' and not internal and created_at > now() - interval '24 hours'
       and status in ('pending','queued','processing','completed');
    auto := usdv <= coalesce(max_tx, 0) and (day_usd + usdv) <= coalesce(max_day, 0);
  end if;
  st := case when auto then 'queued' else 'pending' end;

  -- hold the amount: the balance check and the subtraction are ONE statement
  select name into nm from public.assets where user_id = me and symbol = sym;
  update public.assets set amount = amount - p_amount where user_id = me and symbol = sym and amount >= p_amount;
  if not found then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  delete from public.assets where user_id = me and symbol = sym and amount = 0;

  ref := 'WD-' || upper(substr(md5(gen_random_uuid()::text), 1, 12));
  insert into public.transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, network, reference, request_id, created_at)
  values (me, 'crypto', 'send', sym, p_amount, usdv, st, left(addr, 200), net, ref, p_request, ts)
  returning id into tid;

  amt_txt := public._fmt_amount(p_amount);
  short := left(addr, 10) || case when length(addr) > 10 then '…' else '' end;
  begin
    perform public.push_notification(me, 'withdrawal',
      case when auto then 'Withdrawal processing' else 'Withdrawal pending' end,
      case when auto then 'Your withdrawal of ' || amt_txt || ' ' || sym || ' to ' || short || ' is being sent. Reference ' || ref || '.'
                     else 'Your withdrawal of ' || amt_txt || ' ' || sym || ' to ' || short || ' is waiting for approval. Reference ' || ref || '.' end);
  exception when others then null; end;

  return jsonb_build_object('ok', true, 'replayed', false, 'id', tid, 'status', st, 'reference', ref, 'created_at', ts,
    'amount', p_amount, 'symbol', sym, 'usd_value', usdv, 'network', net);
end $$;
revoke execute on function public.wallet_withdraw(text,numeric,text,text,uuid) from public, anon;
grant  execute on function public.wallet_withdraw(text,numeric,text,text,uuid) to authenticated;

-- the old function trusted the app to have checked the PIN: nobody may call it any more
revoke execute on function public.wallet_send(text,numeric,text,text,text,numeric) from public, anon, authenticated;

-- 4) functions used ONLY by the payout-send edge function (service role) -----------------------------------------------------
create or replace function public.payout_lock_acquire(p_owner uuid, p_secs int default 150) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.payout_mutex(id, owner, until_ts) values (1, p_owner, now() + make_interval(secs => p_secs))
  on conflict (id) do update set owner = excluded.owner, until_ts = excluded.until_ts
    where public.payout_mutex.until_ts < now() or public.payout_mutex.owner = excluded.owner;
  get diagnostics n = row_count;
  return n = 1;
end $$;
create or replace function public.payout_lock_release(p_owner uuid) returns void
language sql security definer set search_path = public as $$
  update public.payout_mutex set until_ts = now() - interval '1 second' where id = 1 and owner = p_owner
$$;

-- queued -> processing (only while the switch is ON). Returns the row, or null.
create or replace function public.payout_claim(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype;
begin
  if not coalesce((select enabled from public.app_flags where key = 'auto_withdraw'), false) then return null; end if;
  update public.transactions set status = 'processing', processing_at = now(), payout_attempts = payout_attempts + 1
   where id = p_id and kind = 'send' and not internal and status = 'queued' returning * into t;
  if not found then return null; end if;
  -- the amount goes out as TEXT so no digit is ever lost or turned into 1e-7 on the way to the blockchain
  return to_jsonb(t) || jsonb_build_object('amount', t.amount::text);
end $$;

create or replace function public.payout_list_queued() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(id order by created_at), '[]'::jsonb)
    from (select id, created_at from public.transactions where kind = 'send' and not internal and status = 'queued' order by created_at limit 20) q
$$;
-- sent but not yet seen as mined: the function re-checks these
create or replace function public.payout_list_processing() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by created_at), '[]'::jsonb)
    from (select id, created_at, processing_at, symbol, tx_hash from public.transactions
           where kind = 'send' and not internal and status = 'processing' and tx_hash is not null order by created_at limit 20) q
$$;

-- "processing" with NO transaction hash for 5+ minutes means the function stopped before it ever signed or sent anything
-- (the hash is always recorded BEFORE broadcasting), so it is safe to try again later. After 3 tries it goes to the admin.
create or replace function public.payout_release_stale() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.transactions
     set status = case when payout_attempts >= 3 then 'pending' else 'queued' end,
         payout_note = 'Retried after the previous attempt stopped before sending'
   where kind = 'send' and not internal and status = 'processing' and tx_hash is null
     and processing_at < now() - interval '5 minutes';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.payout_set_hash(p_id uuid, p_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_hash is null or p_hash !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'bad hash'; end if;
  update public.transactions set tx_hash = p_hash where id = p_id and status = 'processing' and tx_hash is null;
  return found;
end $$;

create or replace function public.payout_complete(p_id uuid, p_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype;
begin
  update public.transactions set status = 'completed', tx_hash = coalesce(p_hash, tx_hash), reviewed_at = now()
   where id = p_id and kind = 'send' and not internal and status = 'processing' returning * into t;
  if not found then return false; end if;
  begin
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal sent',
      'Your withdrawal of ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address,''), 10) || '… was sent. Hash ' || left(coalesce(t.tx_hash,''), 12) || '…');
  exception when others then null; end;
  return true;
end $$;

-- DEFINITELY not sent (or mined as failed): give the held amount back. Refuses if a transaction hash exists unless p_mined_failed is true
-- (the function passes true only when the node explicitly rejected the transaction or the receipt shows it failed).
create or replace function public.payout_fail(p_id uuid, p_reason text, p_mined_failed boolean default false) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'processing' for update;
  if not found then return false; end if;
  if t.tx_hash is not null and not coalesce(p_mined_failed, false) then return false; end if;
  update public.transactions set status = 'cancelled', cancel_reason = left(coalesce(p_reason, 'Could not be sent'), 300), reviewed_at = now() where id = p_id;
  insert into public.assets(user_id, symbol, amount) values (t.user_id, t.symbol, t.amount)
  on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
  begin
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal cancelled',
      'Your withdrawal of ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address,''), 10) || '… could not be sent and was returned to your wallet.');
  exception when others then null; end;
  return true;
end $$;

-- not sent YET (for example network fees too high, treasury short of gas): retry later, and after 3 tries hand it to the admin
create or replace function public.payout_defer(p_id uuid, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; nxt text;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'processing' and tx_hash is null for update;
  if not found then return null; end if;
  nxt := case when t.payout_attempts >= 3 then 'pending' else 'queued' end;
  update public.transactions set status = nxt, payout_note = left(coalesce(p_note,''), 300) where id = p_id;
  return nxt;
end $$;

-- unclear whether it was sent: leave it held, with a note, for the admin
create or replace function public.payout_flag(p_id uuid, p_note text) returns void
language sql security definer set search_path = public as $$
  update public.transactions set payout_note = left(coalesce(p_note,''), 300) where id = p_id and status = 'processing'
$$;

revoke all on function public.payout_lock_acquire(uuid,int), public.payout_lock_release(uuid), public.payout_claim(uuid), public.payout_list_queued(),
  public.payout_list_processing(), public.payout_set_hash(uuid,text), public.payout_complete(uuid,text), public.payout_fail(uuid,text,boolean),
  public.payout_defer(uuid,text), public.payout_flag(uuid,text), public.payout_release_stale() from public, anon, authenticated;
grant execute on function public.payout_lock_acquire(uuid,int), public.payout_lock_release(uuid), public.payout_claim(uuid), public.payout_list_queued(),
  public.payout_list_processing(), public.payout_set_hash(uuid,text), public.payout_complete(uuid,text), public.payout_fail(uuid,text,boolean),
  public.payout_defer(uuid,text), public.payout_flag(uuid,text), public.payout_release_stale() to service_role;

-- 5) admin: settle a payout that is stuck in "processing" or "queued" (see the README).  'complete' needs the transaction hash.
create or replace function public.admin_resolve_payout(p_id uuid, p_action text, p_hash text default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status in ('processing','queued') for update;
  if not found then raise exception 'not found or already settled'; end if;
  if p_action = 'complete' then
    if coalesce(p_hash,'') = '' then raise exception 'hash required'; end if;
    update public.transactions set status = 'completed', tx_hash = left(p_hash, 200), reviewed_at = now(), reviewed_by = auth.uid() where id = p_id;
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal sent',
      'Your withdrawal of ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address,''), 10) || '… was sent.');
  elsif p_action = 'refund' then
    update public.transactions set status = 'cancelled', cancel_reason = left(coalesce(nullif(btrim(p_reason),''), 'Could not be sent'), 300), reviewed_at = now(), reviewed_by = auth.uid() where id = p_id;
    insert into public.assets(user_id, symbol, amount) values (t.user_id, t.symbol, t.amount)
    on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal cancelled',
      'Your withdrawal of ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address,''), 10) || '… was cancelled and returned to your wallet.');
  else
    raise exception 'action must be complete or refund';
  end if;
end $$;
revoke execute on function public.admin_resolve_payout(uuid,text,text,text) from public, anon;
grant  execute on function public.admin_resolve_payout(uuid,text,text,text) to authenticated;
