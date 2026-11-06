-- Veltrix · phase 18: outside withdrawals for BTC, LTC, SOL, XRP and TRX (on top of ETH, USDT, USDC, SHIB, LINK, BNB, AVAX).
-- Run AFTER schema_phase15_no_admin_approval.sql (and phases 16/17), BEFORE deploying the new payout-send function.
--
--   * _auto_supported() now includes the five new coins, so wallet_withdraw() accepts them and queues them for payout-send.
--   * XRP gets an optional DESTINATION TAG (Binance, Bybit and other exchanges will not credit an XRP deposit without one).
--     wallet_withdraw() has a new optional last argument p_memo; the app passes it only for XRP.
--   * Transaction hashes now have a different shape per chain (Bitcoin/Litecoin/TRON: 64 hex, XRP: 64 HEX capitals, Solana: base58),
--     so payout_set_hash() checks the shape that belongs to the coin instead of insisting on "0x…".
--   * payout_meta: a small per-payout note the function needs to PROVE a payout can never land (Solana: last valid block height,
--     XRP: last ledger sequence). It is separate from payout_note, which is only text for humans.
--   * payout_queue(): like payout_list_queued() but also returns the coin, so a slow chain (Bitcoin) no longer holds up the others.

-- 1) bookkeeping
alter table public.transactions add column if not exists memo         text;
alter table public.transactions add column if not exists payout_meta  text;

-- 2) coins the payout-send function can send on its own
create or replace function public._auto_supported(p text) returns boolean
language sql immutable set search_path = public as $$
  select upper(p) in ('ETH','USDT','USDC','SHIB','LINK','BNB','AVAX','BTC','LTC','SOL','XRP','TRX')
$$;
revoke all on function public._auto_supported(text) from public, anon, authenticated;

-- 3) the withdrawal request (phase 15 version + destination tag + per-coin amount rules)
drop function if exists public.wallet_withdraw(text,numeric,text,text,uuid);
create or replace function public.wallet_withdraw(p_symbol text, p_amount numeric, p_address text, p_pin text, p_request uuid, p_memo text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid(); sym text := upper(btrim(coalesce(p_symbol,''))); addr text := btrim(coalesce(p_address,''));
  memo_v text := nullif(btrim(coalesce(p_memo,'')), '');
  net text; sec public.user_security%rowtype; prev public.transactions%rowtype; nm text;
  px numeric; usdv numeric;
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
  -- these coins only exist with 6 decimals on the blockchain, so a smaller piece can never be sent
  if sym in ('USDT','USDC','XRP','TRX') and p_amount <> trunc(p_amount, 6) then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
  -- Solana has 9 decimals, we keep the app's 8
  -- Bitcoin / Litecoin: below this the network treats an output as "dust" and refuses it
  if sym in ('BTC','LTC') and p_amount < 0.00001 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
  if not public._valid_addr(sym, addr) then return jsonb_build_object('ok', false, 'reason', 'invalid_address'); end if;

  -- destination tag: XRP only, a whole number from 0 to 4294967295
  if memo_v is not null then
    if sym <> 'XRP' or memo_v !~ '^[0-9]{1,10}$' or memo_v::bigint > 4294967295 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_memo');
    end if;
    memo_v := (memo_v::bigint)::text;     -- no leading zeros
  end if;

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

  -- one withdrawal at a time per user
  perform pg_advisory_xact_lock(hashtextextended('withdraw:' || me::text, 0));
  select * into prev from public.transactions where user_id = me and request_id = p_request;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'id', prev.id, 'status', prev.status, 'reference', prev.reference,
      'created_at', prev.created_at, 'amount', prev.amount, 'symbol', prev.symbol, 'usd_value', prev.usd_value, 'network', prev.network);
  end if;

  select usd into px from public.asset_prices where symbol = sym;
  usdv := case when px is null then null else round(p_amount * px, 2) end;

  -- there is no admin approval: a withdrawal is either sent automatically or refused BEFORE any money is held
  if not coalesce((select enabled from public.app_flags where key = 'auto_withdraw'), false) then
    return jsonb_build_object('ok', false, 'reason', 'unavailable');
  end if;
  if not public._auto_supported(sym) then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
  st := 'queued';

  -- hold the amount: the balance check and the subtraction are ONE statement
  select name into nm from public.assets where user_id = me and symbol = sym;
  update public.assets set amount = amount - p_amount where user_id = me and symbol = sym and amount >= p_amount;
  if not found then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  delete from public.assets where user_id = me and symbol = sym and amount = 0;

  ref := 'WD-' || upper(substr(md5(gen_random_uuid()::text), 1, 12));
  insert into public.transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, network, reference, request_id, memo, created_at)
  values (me, 'crypto', 'send', sym, p_amount, usdv, st, left(addr, 200), net, ref, p_request, memo_v, ts)
  returning id into tid;

  amt_txt := public._fmt_amount(p_amount);
  short := left(addr, 10) || case when length(addr) > 10 then '…' else '' end;
  begin
    perform public.push_notification(me, 'withdrawal', 'Withdrawal processing',
      'Your withdrawal of ' || amt_txt || ' ' || sym || ' to ' || short || ' is being sent. Reference ' || ref || '.');
  exception when others then null; end;

  return jsonb_build_object('ok', true, 'replayed', false, 'id', tid, 'status', st, 'reference', ref, 'created_at', ts,
    'amount', p_amount, 'symbol', sym, 'usd_value', usdv, 'network', net);
end $$;
revoke execute on function public.wallet_withdraw(text,numeric,text,text,uuid,text) from public, anon;
grant  execute on function public.wallet_withdraw(text,numeric,text,text,uuid,text) to authenticated;

-- 4) functions used ONLY by the payout-send edge function (service role)
-- the hash shape depends on the chain; the optional meta is stored in the same statement as the hash
drop function if exists public.payout_set_hash(uuid, text);
create or replace function public.payout_set_hash(p_id uuid, p_hash text, p_meta text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select symbol into s from public.transactions where id = p_id;
  if s is null then return false; end if;
  if p_hash is null or not (case upper(s)
      when 'BTC'  then p_hash ~ '^[0-9a-f]{64}$'
      when 'LTC'  then p_hash ~ '^[0-9a-f]{64}$'
      when 'TRX'  then p_hash ~ '^[0-9a-f]{64}$'
      when 'XRP'  then p_hash ~ '^[0-9A-F]{64}$'
      when 'SOL'  then p_hash ~ '^[1-9A-HJ-NP-Za-km-z]{80,90}$'
      else p_hash ~ '^0x[0-9a-fA-F]{64}$' end) then
    raise exception 'bad hash';
  end if;
  update public.transactions set tx_hash = p_hash, payout_meta = left(p_meta, 200)
   where id = p_id and status = 'processing' and tx_hash is null;
  return found;
end $$;

create or replace function public.payout_list_processing() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by created_at), '[]'::jsonb)
    from (select id, created_at, processing_at, symbol, tx_hash, payout_meta from public.transactions
           where kind = 'send' and not internal and status = 'processing' and tx_hash is not null order by created_at limit 40) q
$$;

-- the queue with the coin of each payout: [{id, symbol}, ...]
create or replace function public.payout_queue() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'symbol', symbol) order by created_at), '[]'::jsonb)
    from (select id, symbol, created_at from public.transactions where kind = 'send' and not internal and status = 'queued' order by created_at limit 40) q
$$;

revoke all on function public.payout_set_hash(uuid,text,text), public.payout_list_processing(), public.payout_queue() from public, anon, authenticated;
grant execute on function public.payout_set_hash(uuid,text,text), public.payout_list_processing(), public.payout_queue() to service_role;
