-- Veltrix · phase 37: REAL ON-CHAIN MODE (private testing). Run AFTER phases 13, 14, 15, 17, 18, 19 (and 21).
--
-- What this changes
--   1. NO TREASURY. An outgoing transaction is signed by the payout-send function with the SENDING USER's own wallet key and leaves the
--      user's own deposit address. The sender pays the network fee. (payout_signing_phrase() below is the only way the function gets a key.)
--   2. Veltrix-to-Veltrix sends are ordinary on-chain transactions to the recipient's real address. wallet_transfer() is now only a wrapper
--      around wallet_withdraw(); nothing is moved between two database balances any more.
--   3. The balance shown in the app MIRRORS the confirmed on-chain balance of the user's address, minus amounts that are in flight
--      (queued / processing sends). Imported wallets are credited too (the old 'credit_imported' switch no longer applies: the app balance can
--      no longer drift away from what the address really holds).
--   4. Every PIN decision and every use of a signing key is written to tx_auth_events (server-only table).
--   5. History gets the sender address and the network fee (an ESTIMATE of the maximum fee, recorded when the transaction is signed).
--
-- PRIVATE-TESTING ONLY: the phrase is stored server-side (encrypted with the Vault key) so the backend can sign for the user, and the admin
-- screen "Test wallets" can still read phrases. Both are removed/hardened in the separate production-hardening step.
--
-- Switch (kill switch): update public.app_flags set enabled = true  where key = 'auto_withdraw';   -- allow sending
--                       update public.app_flags set enabled = false where key = 'auto_withdraw';   -- stop all sending at once

-- 1) bookkeeping ---------------------------------------------------------------------------------------------------------------
alter table public.transactions add column if not exists from_address text;
alter table public.transactions add column if not exists fee_estimate numeric;
alter table public.transactions add column if not exists fee_symbol   text;

create table if not exists public.tx_auth_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid not null,
  tx_id       uuid,
  request_id  uuid,
  event       text not null,           -- pin_ok | bad_pin | locked | no_pin | accepted | signing_key_used
  symbol      text,
  amount      numeric,
  to_address  text
);
create index if not exists tx_auth_events_user on public.tx_auth_events (user_id, created_at desc);
alter table public.tx_auth_events enable row level security;       -- no policies: clients can never read or write it
revoke all on public.tx_auth_events from anon, authenticated;

create or replace function public._auth_event(p_user uuid, p_tx uuid, p_req uuid, p_event text, p_sym text, p_amt numeric, p_to text) returns void
language sql security definer set search_path = public as $$
  insert into public.tx_auth_events(user_id, tx_id, request_id, event, symbol, amount, to_address)
  values (p_user, p_tx, p_req, p_event, p_sym, p_amt, left(p_to, 200))
$$;
revoke all on function public._auth_event(uuid,uuid,uuid,text,text,numeric,text) from public, anon, authenticated;

-- the user's own address for a coin (server-only helper)
create or replace function public._my_addr(p_user uuid, p_sym text) returns text
language sql stable security definer set search_path = public as $$
  select a->>'address' from public.user_wallets w, jsonb_array_elements(w.addresses) a
   where w.user_id = p_user and upper(a->>'symbol') = upper(p_sym) limit 1
$$;
revoke all on function public._my_addr(uuid,text) from public, anon, authenticated;

-- 2) the ONLY door to a signing key ---------------------------------------------------------------------------------------------
-- Released to the service role only, only for a send that the owner already authorised with the PIN (it exists, is 'processing', and has no
-- hash yet = it has not been signed/broadcast), and every release is logged. Never exposed to the app.
create or replace function public.payout_signing_phrase(p_user uuid, p_tx uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t public.transactions%rowtype; w public.user_wallets%rowtype;
begin
  select * into t from public.transactions
   where id = p_tx and user_id = p_user and kind = 'send' and not internal and status = 'processing' and tx_hash is null;
  if not found then return null; end if;
  select * into w from public.user_wallets where user_id = p_user;
  if not found then return null; end if;
  perform public._auth_event(p_user, p_tx, t.request_id, 'signing_key_used', t.symbol, t.amount, t.to_address);
  return jsonb_build_object('phrase', pgp_sym_decrypt(w.phrase_enc, public._wallet_key()), 'address', public._my_addr(p_user, t.symbol));
end $$;
revoke all on function public.payout_signing_phrase(uuid,uuid) from public, anon, authenticated;
grant execute on function public.payout_signing_phrase(uuid,uuid) to service_role;

create or replace function public.payout_set_details(p_id uuid, p_from text, p_fee numeric, p_fee_symbol text) returns void
language sql security definer set search_path = public as $$
  update public.transactions set from_address = left(p_from, 200), fee_estimate = p_fee, fee_symbol = left(p_fee_symbol, 10)
   where id = p_id and status = 'processing'
$$;
revoke all on function public.payout_set_details(uuid,text,numeric,text) from public, anon, authenticated;
grant execute on function public.payout_set_details(uuid,text,numeric,text) to service_role;

-- 3) wallet_withdraw: the one send function (outside wallets AND other Veltrix users) --------------------------------------------
drop function if exists public.wallet_withdraw(text,numeric,text,text,uuid);
create or replace function public.wallet_withdraw(p_symbol text, p_amount numeric, p_address text, p_pin text, p_request uuid, p_memo text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid(); sym text := upper(btrim(coalesce(p_symbol,''))); addr text := btrim(coalesce(p_address,''));
  memo_v text := nullif(btrim(coalesce(p_memo,'')), '');
  net text; sec public.user_security%rowtype; prev public.transactions%rowtype; l public.wallet_addr_lookup%rowtype;
  cp_id uuid; cp_name text; px numeric; usdv numeric;
  ref text; tid uuid; ts timestamptz := now(); amt_txt text; short text;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  if p_request is null then raise exception 'request id required'; end if;

  -- the same request id can never create (or send) a second transaction: the PIN authorisation is consumed by this one request
  select * into prev from public.transactions where user_id = me and request_id = p_request;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'id', prev.id, 'status', prev.status, 'reference', prev.reference,
      'created_at', prev.created_at, 'amount', prev.amount, 'symbol', prev.symbol, 'usd_value', prev.usd_value, 'network', prev.network,
      'to_name', prev.counterparty_name);
  end if;

  net := public._coin_network(sym);
  if net is null then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount, 8) or p_amount > 100000000000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;
  if sym in ('USDT','USDC','XRP','TRX') and p_amount <> trunc(p_amount, 6) then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
  if sym in ('BTC','LTC') and p_amount < 0.00001 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
  if not public._valid_addr(sym, addr) then return jsonb_build_object('ok', false, 'reason', 'invalid_address'); end if;

  if memo_v is not null then
    if sym <> 'XRP' or memo_v !~ '^[0-9]{1,10}$' or memo_v::bigint > 4294967295 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_memo');
    end if;
    memo_v := (memo_v::bigint)::text;
  end if;

  -- 2FA PIN, on the server; every decision is recorded
  select * into sec from public.user_security where user_id = me;
  if not found or sec.pin_hash is null then
    perform public._auth_event(me, null, p_request, 'no_pin', sym, p_amount, addr);
    return jsonb_build_object('ok', false, 'reason', 'no_pin');
  end if;
  if sec.locked_until is not null and sec.locked_until > now() then
    perform public._auth_event(me, null, p_request, 'locked', sym, p_amount, addr);
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', ceil(extract(epoch from (sec.locked_until - now())))::int);
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' or not public.pin_verify(p_pin) then
    perform public._auth_event(me, null, p_request, 'bad_pin', sym, p_amount, addr);
    return jsonb_build_object('ok', false, 'reason', 'bad_pin');
  end if;
  perform public._auth_event(me, null, p_request, 'pin_ok', sym, p_amount, addr);

  -- a recipient that is another Veltrix user is a normal on-chain send to THEIR address; only remember who it is for the history
  select * into l from public.wallet_addr_lookup where symbol = sym and norm = public._norm_addr(sym, addr);
  if found then
    if l.user_id = me then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
    cp_id := l.user_id;
    select public._display_name(full_name) into cp_name from public.profiles where id = l.user_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('withdraw:' || me::text, 0));
  select * into prev from public.transactions where user_id = me and request_id = p_request;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'id', prev.id, 'status', prev.status, 'reference', prev.reference,
      'created_at', prev.created_at, 'amount', prev.amount, 'symbol', prev.symbol, 'usd_value', prev.usd_value, 'network', prev.network,
      'to_name', prev.counterparty_name);
  end if;

  select usd into px from public.asset_prices where symbol = sym;
  usdv := case when px is null then null else round(p_amount * px, 2) end;

  if not coalesce((select enabled from public.app_flags where key = 'auto_withdraw'), false) then
    return jsonb_build_object('ok', false, 'reason', 'unavailable');
  end if;
  if not public._auto_supported(sym) then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;

  -- "available" = the mirrored on-chain balance minus what is already in flight. The check and the hold are ONE statement.
  update public.assets set amount = amount - p_amount where user_id = me and symbol = sym and amount >= p_amount;
  if not found then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  delete from public.assets where user_id = me and symbol = sym and amount = 0;

  ref := 'WD-' || upper(substr(md5(gen_random_uuid()::text), 1, 12));
  insert into public.transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, from_address, network, reference,
                                  request_id, memo, counterparty_id, counterparty_name, created_at)
  values (me, 'crypto', 'send', sym, p_amount, usdv, 'queued', left(addr, 200), public._my_addr(me, sym), net, ref,
          p_request, memo_v, cp_id, cp_name, ts)
  returning id into tid;
  perform public._auth_event(me, tid, p_request, 'accepted', sym, p_amount, addr);

  amt_txt := public._fmt_amount(p_amount);
  short := coalesce(cp_name, left(addr, 10) || case when length(addr) > 10 then '…' else '' end);
  begin
    perform public.push_notification(me, 'withdrawal', 'Sending ' || sym,
      'Your ' || amt_txt || ' ' || sym || ' to ' || short || ' is being sent on the blockchain. Reference ' || ref || '.');
  exception when others then null; end;

  return jsonb_build_object('ok', true, 'replayed', false, 'id', tid, 'status', 'queued', 'reference', ref, 'created_at', ts,
    'amount', p_amount, 'symbol', sym, 'usd_value', usdv, 'network', net, 'to_name', cp_name);
end $$;
revoke execute on function public.wallet_withdraw(text,numeric,text,text,uuid,text) from public, anon;
grant  execute on function public.wallet_withdraw(text,numeric,text,text,uuid,text) to authenticated;

-- wallet_transfer: kept so the app's "send to a Veltrix user" path keeps working, but it NO LONGER moves database balances.
create or replace function public.wallet_transfer(p_symbol text, p_amount numeric, p_address text, p_pin text, p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); sym text := upper(btrim(coalesce(p_symbol,''))); l public.wallet_addr_lookup%rowtype;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select * into l from public.wallet_addr_lookup where symbol = sym and norm = public._norm_addr(sym, coalesce(p_address, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'recipient_not_found'); end if;
  if l.user_id = me then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  return public.wallet_withdraw(sym, p_amount, p_address, p_pin, p_request, null);
end $$;
revoke execute on function public.wallet_transfer(text,numeric,text,text,uuid) from public, anon;
grant  execute on function public.wallet_transfer(text,numeric,text,text,uuid) to authenticated;

-- 4) deposits + balances: the app balance mirrors the confirmed chain balance ---------------------------------------------------
-- Called by deposit-watch (service role) with the CONFIRMED on-chain balance of one address. A provider error never reaches this function.
--   * an increase since the last read is recorded once as a deposit (chain_state.last_balance makes a repeated read harmless);
--   * assets.amount is then SET to (on-chain balance - amounts of sends still queued/processing), never incremented.
create or replace function public.apply_chain_balance(p_user uuid, p_symbol text, p_network text, p_address text, p_balance numeric, p_name text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare st public.chain_state%rowtype; delta numeric := 0; px numeric; usdv numeric; ref text; sym text := upper(p_symbol); held numeric; shown numeric;
begin
  if p_balance is null or p_balance < 0 then raise exception 'bad balance'; end if;
  insert into chain_state(user_id, symbol, network, address, last_balance) values (p_user, sym, p_network, p_address, 0)
    on conflict (user_id, symbol, address) do nothing;
  select * into st from chain_state where user_id = p_user and symbol = sym and address = p_address for update;

  if p_balance > st.last_balance then
    delta := p_balance - st.last_balance;
    select usd into px from asset_prices where symbol = sym;
    usdv := case when px is null then null else round(delta * px, 2) end;
    ref  := 'DP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, network, reference, payout_note)
      values (p_user, 'crypto', 'deposit', sym, delta, usdv, 'completed', p_address, left(p_network, 80), ref,
              'Detected on the blockchain as a confirmed balance increase');
    perform public.push_notification(p_user, 'deposit', 'Deposit received',
      trim(trailing '.' from trim(trailing '0' from delta::text)) || ' ' || sym || ' was received and confirmed on the blockchain.');
  end if;
  update chain_state set last_balance = p_balance, updated_at = now() where user_id = p_user and symbol = sym and address = p_address;

  select coalesce(sum(amount), 0) into held from transactions
   where user_id = p_user and symbol = sym and kind = 'send' and not internal and status in ('queued','processing');
  shown := greatest(p_balance - held, 0);
  if shown = 0 then
    delete from assets where user_id = p_user and symbol = sym;
  else
    insert into assets(user_id, symbol, name, amount) values (p_user, sym, p_name, shown)
      on conflict (user_id, symbol) do update set amount = excluded.amount;
  end if;
  return delta;
end $$;
revoke all on function public.apply_chain_balance(uuid,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.apply_chain_balance(uuid,text,text,text,numeric,text) to service_role;

-- 5) the treasury no longer exists in the send path. Nothing to configure; TREASURY_MNEMONIC is ignored and can be unset:
--      supabase secrets unset TREASURY_MNEMONIC
