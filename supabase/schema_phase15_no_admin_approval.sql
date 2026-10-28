-- Veltrix · phase 15: NO admin approval for withdrawals.
-- Run AFTER schema_phase14_outside_withdrawals.sql.
--
-- * A withdrawal to an outside address needs only the user's correct 2FA PIN (checked on the server). No admin step exists any more.
-- * A request is accepted ONLY if it can be sent automatically (switch ON, supported coin).
--   (no dollar limits: any amount up to the balance). Otherwise it is refused straight away and NO money is held. Nothing ever waits for an admin.
-- * A payout that never reached the network after 3 tries is cancelled and the money returned (safe: no transaction hash exists,
--   because the hash is always saved BEFORE anything is broadcast).
-- * A payout where it is UNCLEAR whether it was broadcast is still never refunded automatically (it could be double-paid).
-- * Withdrawals left "pending" by the old approval flow are cancelled and returned to the users' wallets.

create or replace function public.wallet_withdraw(p_symbol text, p_amount numeric, p_address text, p_pin text, p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid(); sym text := upper(btrim(coalesce(p_symbol,''))); addr text := btrim(coalesce(p_address,''));
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
  -- no dollar limits: any amount up to the user's balance can be sent
  st := 'queued';

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
      'Withdrawal processing',
      'Your withdrawal of ' || amt_txt || ' ' || sym || ' to ' || short || ' is being sent. Reference ' || ref || '.');
  exception when others then null; end;

  return jsonb_build_object('ok', true, 'replayed', false, 'id', tid, 'status', st, 'reference', ref, 'created_at', ts,
    'amount', p_amount, 'symbol', sym, 'usd_value', usdv, 'network', net);
end $$;
revoke execute on function public.wallet_withdraw(text,numeric,text,text,uuid) from public, anon;
grant  execute on function public.wallet_withdraw(text,numeric,text,text,uuid) to authenticated;

-- give a held amount back and tell the user (only for payouts that were DEFINITELY never broadcast)
create or replace function public._payout_cancel(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status in ('pending','queued','processing') and tx_hash is null for update;
  if not found then return; end if;
  update public.transactions set status = 'cancelled', cancel_reason = left(p_reason, 300), reviewed_at = now() where id = p_id;
  if not coalesce(t.test, false) then
    insert into public.assets(user_id, symbol, amount) values (t.user_id, t.symbol, t.amount)
    on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
  end if;
  begin
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal cancelled',
      'Your withdrawal of ' || public._fmt_amount(t.amount) || ' ' || t.symbol || ' to ' || left(coalesce(t.to_address,''), 10) || '… could not be sent and was returned to your wallet.');
  exception when others then null; end;
end $$;
revoke all on function public._payout_cancel(uuid,text) from public, anon, authenticated;

create or replace function public.payout_release_stale() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r record;
begin
  for r in select id, payout_attempts from public.transactions
            where kind = 'send' and not internal and status = 'processing' and tx_hash is null and processing_at < now() - interval '5 minutes' for update
  loop
    if r.payout_attempts >= 3 then
      perform public._payout_cancel(r.id, 'Could not be sent. The amount was returned to your wallet.');
    else
      update public.transactions set status = 'queued', payout_note = 'Retried after the previous attempt stopped before sending' where id = r.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.payout_defer(p_id uuid, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype;
begin
  select * into t from public.transactions where id = p_id and kind = 'send' and not internal and status = 'processing' and tx_hash is null for update;
  if not found then return null; end if;
  if t.payout_attempts >= 3 then
    perform public._payout_cancel(p_id, 'Could not be sent. The amount was returned to your wallet.');
    update public.transactions set payout_note = left(coalesce(p_note,''), 300) where id = p_id;
    return 'cancelled';
  end if;
  update public.transactions set status = 'queued', payout_note = left(coalesce(p_note,''), 300) where id = p_id;
  return 'queued';
end $$;
revoke all on function public.payout_release_stale(), public.payout_defer(uuid,text) from public, anon, authenticated;
grant execute on function public.payout_release_stale(), public.payout_defer(uuid,text) to service_role;

-- old approval flow: remove the admin decision function and return anything still waiting
drop function if exists public.admin_review_send(uuid,boolean,text);
select public._payout_cancel(id, 'Withdrawals no longer need approval. The amount was returned to your wallet.')
  from public.transactions where kind = 'send' and not internal and status = 'pending' and tx_hash is null;
