-- Veltrix · phase 13: REAL transfers between Veltrix users (send crypto to another user's wallet address).
-- Run in: Supabase Dashboard → SQL Editor → New query → Run   (needs phases 2, 3, 5, 6, 7, 8 and 10 already applied)
--
-- How it works
--   * Every user already has a receiving address per coin (user_wallets.addresses, shown on the Deposit screen).
--   * When someone sends a coin to an address that belongs to another Veltrix user, wallet_transfer() moves the
--     amount between the two users' balances in ONE database transaction: either everything happens or nothing does.
--   * The server (not the app) verifies the 2FA PIN, checks the balance, finds the recipient, works out the USD value,
--     writes BOTH users' transaction history and sends BOTH notifications (respecting each user's notification settings).
--   * The same request id can never move money twice (a retry after a bad connection just returns the first result).
--   * Sends to addresses that do NOT belong to a Veltrix user keep working exactly as before (pending admin approval).
-- Nothing is deleted. The old wallet_send() is only tightened so it can't be used for a Veltrix user's address.

-- 0) FIX: pin_verify() could never record a wrong PIN. Its UPDATE assigned the column "failed" twice, which Postgres rejects,
--    so a wrong PIN raised an error instead of counting towards the 5-try lock (the lock only existed in the app, where it can be
--    bypassed). Same rules as before — 5 wrong PINs lock it for 30 seconds — but it now actually works on the server.
create or replace function public.pin_verify(p text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare r user_security%rowtype;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_security where user_id = auth.uid() for update;
  if not found or r.pin_hash is null then return false; end if;
  if r.locked_until is not null and r.locked_until > now() then return false; end if;
  if p is not null and crypt(p, r.pin_hash) = r.pin_hash then
    update user_security set failed = 0, locked_until = null where user_id = auth.uid();
    return true;
  end if;
  update user_security
     set failed       = case when r.failed + 1 >= 5 then 0 else r.failed + 1 end,
         locked_until = case when r.failed + 1 >= 5 then now() + interval '30 seconds' else null end
   where user_id = auth.uid();
  return false;
end $$;
revoke all on function public.pin_verify(text) from public, anon;
grant execute on function public.pin_verify(text) to authenticated;

-- 1) history: remember who the other side of an internal transfer was, and make retries safe
alter table public.transactions add column if not exists internal          boolean not null default false;
alter table public.transactions add column if not exists counterparty_id   uuid;
alter table public.transactions add column if not exists counterparty_name text;
alter table public.transactions add column if not exists request_id        uuid;
create unique index if not exists transactions_request_once on public.transactions (user_id, request_id) where request_id is not null;

-- 2) address book: which user owns which receiving address (server-only; kept in step with user_wallets automatically)
create table if not exists public.wallet_addr_lookup (
  symbol  text not null,
  norm    text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  address text not null,
  network text,
  primary key (symbol, norm)
);
create index if not exists wallet_addr_lookup_user on public.wallet_addr_lookup (user_id);
alter table public.wallet_addr_lookup enable row level security;      -- no policies: clients can never read it
revoke all on public.wallet_addr_lookup from anon, authenticated;

-- Canonical form used to compare a typed address with a stored one. Only formats that are case-insensitive by design
-- are lower-cased (0x… hex, bech32 bc1/ltc1/addr1, Bitcoin Cash); every other format must match exactly.
create or replace function public._norm_addr(p_symbol text, p_addr text) returns text
language sql immutable set search_path = public as $$
  select case
    when upper(p_symbol) = 'BCH'                                                    then regexp_replace(lower(btrim(p_addr)), '^bitcoincash:', '')
    when upper(p_symbol) in ('BTC','LTC','ADA')                                     then lower(btrim(p_addr))
    when upper(p_symbol) in ('ETH','USDT','USDC','SHIB','LINK','BNB','AVAX','HBAR','SUI') then lower(btrim(p_addr))
    else btrim(p_addr)
  end
$$;

create or replace function public._wallet_lookup_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.wallet_addr_lookup where user_id = new.user_id;
  if jsonb_typeof(new.addresses) = 'array' then
    insert into public.wallet_addr_lookup(symbol, norm, user_id, address, network)
    select upper(e->>'symbol'), public._norm_addr(e->>'symbol', e->>'address'), new.user_id, e->>'address', e->>'network'
      from jsonb_array_elements(new.addresses) e
     where coalesce(e->>'symbol','') <> '' and coalesce(e->>'address','') <> ''
    on conflict (symbol, norm) do nothing;
  end if;
  return new;
end $$;
revoke all on function public._wallet_lookup_sync() from public, anon, authenticated;
drop trigger if exists wallet_lookup_sync on public.user_wallets;
create trigger wallet_lookup_sync after insert or update of addresses on public.user_wallets
  for each row execute function public._wallet_lookup_sync();

-- fill it for every wallet that already exists
insert into public.wallet_addr_lookup(symbol, norm, user_id, address, network)
select upper(e->>'symbol'), public._norm_addr(e->>'symbol', e->>'address'), w.user_id, e->>'address', e->>'network'
  from public.user_wallets w, jsonb_array_elements(w.addresses) e
 where jsonb_typeof(w.addresses) = 'array' and coalesce(e->>'symbol','') <> '' and coalesce(e->>'address','') <> ''
on conflict (symbol, norm) do nothing;

-- 3) small helpers
create or replace function public._fmt_amount(p numeric) returns text
language sql immutable set search_path = public as $$
  select case when position('.' in p::text) > 0 then trim(trailing '.' from trim(trailing '0' from p::text)) else p::text end
$$;

-- "Jane Doe" -> "Jane D."  (what the other person is shown; never the e-mail)
create or replace function public._display_name(p text) returns text
language sql immutable set search_path = public as $$
  select case
    when btrim(coalesce(p,'')) = '' then 'Veltrix user'
    when array_length(regexp_split_to_array(btrim(p), '\s+'), 1) = 1 then left(btrim(p), 40)
    else left((regexp_split_to_array(btrim(p), '\s+'))[1], 30) || ' '
         || upper(left((regexp_split_to_array(btrim(p), '\s+'))[array_length(regexp_split_to_array(btrim(p), '\s+'), 1)], 1)) || '.'
  end
$$;
revoke all on function public._norm_addr(text,text), public._fmt_amount(numeric), public._display_name(text) from public, anon, authenticated;

-- 4) "who owns this address?"  (used by the app to show the recipient's name BEFORE the user confirms)
create or replace function public.wallet_resolve_recipient(p_symbol text, p_address text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare l public.wallet_addr_lookup%rowtype; w public.user_wallets%rowtype; nm text;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select * into l from public.wallet_addr_lookup
   where symbol = upper(btrim(coalesce(p_symbol,''))) and norm = public._norm_addr(p_symbol, coalesce(p_address,''));
  if not found then return jsonb_build_object('found', false); end if;
  if l.user_id = auth.uid() then return jsonb_build_object('found', true, 'self', true); end if;
  select * into w from public.user_wallets where user_id = l.user_id;
  if not found or (w.test_expires_at is not null and w.test_expires_at <= now()) then return jsonb_build_object('found', false); end if;
  select full_name into nm from public.profiles where id = l.user_id;
  return jsonb_build_object('found', true, 'self', false, 'name', public._display_name(nm));
end $$;
revoke execute on function public.wallet_resolve_recipient(text,text) from public, anon;
grant  execute on function public.wallet_resolve_recipient(text,text) to authenticated;

-- 5) THE transfer. Always returns {ok:true,...} or {ok:false, reason:...}; it only RAISES for a revoked session or a bug.
--    (Wrong-PIN attempts are counted and must stay counted, which is why they are returned rather than raised.)
create or replace function public.wallet_transfer(p_symbol text, p_amount numeric, p_address text, p_pin text, p_request uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  me      uuid := auth.uid();
  sym     text := upper(btrim(coalesce(p_symbol, '')));
  sec     public.user_security%rowtype;
  l       public.wallet_addr_lookup%rowtype;
  w       public.user_wallets%rowtype;
  prev    public.transactions%rowtype;
  nm      text;  my_name text;  to_name text;
  px      numeric;  usdv numeric;
  ref     text;  amt_txt text;  ts timestamptz := now();
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  if p_request is null then raise exception 'request id required'; end if;

  -- a retry of a transfer that already went through: return the first result, move nothing
  select * into prev from public.transactions where user_id = me and request_id = p_request;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'reference', prev.reference, 'created_at', prev.created_at,
      'to_name', prev.counterparty_name, 'amount', prev.amount, 'symbol', prev.symbol, 'usd_value', prev.usd_value,
      'network', prev.network, 'status', prev.status);
  end if;

  -- amount: positive, at most 8 decimals, sane size
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount, 8) or p_amount > 100000000000 or sym !~ '^[A-Z0-9]{2,10}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  -- 2FA PIN, checked here on the server (5 wrong tries lock it for 30 s, same rule as everywhere else)
  select * into sec from public.user_security where user_id = me;
  if not found or sec.pin_hash is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
  if sec.locked_until is not null and sec.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', ceil(extract(epoch from (sec.locked_until - now())))::int);
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' or not public.pin_verify(p_pin) then
    return jsonb_build_object('ok', false, 'reason', 'bad_pin');
  end if;

  -- who gets it?
  select * into l from public.wallet_addr_lookup where symbol = sym and norm = public._norm_addr(sym, coalesce(p_address, ''));
  if not found then return jsonb_build_object('ok', false, 'reason', 'recipient_not_found'); end if;
  if l.user_id = me then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  select * into w from public.user_wallets where user_id = l.user_id;
  if not found or (w.test_expires_at is not null and w.test_expires_at <= now()) then
    return jsonb_build_object('ok', false, 'reason', 'recipient_not_found');
  end if;

  -- serialise transfers between the same two people (always in the same order, so two opposite transfers can't deadlock)
  perform pg_advisory_xact_lock(hashtextextended(least(me, l.user_id)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(me, l.user_id)::text, 0));

  -- the same request may have been finished by a parallel call while we waited for the lock: return that result, move nothing
  select * into prev from public.transactions where user_id = me and request_id = p_request;
  if found then
    return jsonb_build_object('ok', true, 'replayed', true, 'reference', prev.reference, 'created_at', prev.created_at,
      'to_name', prev.counterparty_name, 'amount', prev.amount, 'symbol', prev.symbol, 'usd_value', prev.usd_value,
      'network', prev.network, 'status', prev.status);
  end if;

  -- take it from the sender: the balance check and the subtraction are ONE statement, so it can never go below zero
  select name into nm from public.assets where user_id = me and symbol = sym;
  update public.assets set amount = amount - p_amount where user_id = me and symbol = sym and amount >= p_amount;
  if not found then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  delete from public.assets where user_id = me and symbol = sym and amount = 0;

  -- give it to the recipient
  insert into public.assets(user_id, symbol, name, amount) values (l.user_id, sym, nm, p_amount)
  on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;

  -- value in dollars comes from the SERVER's price table, never from the app
  select usd into px from public.asset_prices where symbol = sym;
  usdv := case when px is null then null else round(p_amount * px, 2) end;

  select public._display_name(full_name) into my_name from public.profiles where id = me;
  select public._display_name(full_name) into to_name from public.profiles where id = l.user_id;
  ref := 'TR-' || upper(substr(md5(gen_random_uuid()::text), 1, 12));

  insert into public.transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, network, reference,
                                  internal, counterparty_id, counterparty_name, request_id, created_at)
  values (me, 'crypto', 'send', sym, p_amount, usdv, 'completed', l.address, l.network, ref, true, l.user_id, to_name, p_request, ts);
  insert into public.transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, network, reference,
                                  internal, counterparty_id, counterparty_name, request_id, created_at)
  values (l.user_id, 'crypto', 'deposit', sym, p_amount, usdv, 'completed', l.address, l.network, ref, true, me, my_name, null, ts);

  -- notifications (each user's own notification settings decide whether it is stored). A notification problem must never undo a transfer.
  amt_txt := public._fmt_amount(p_amount);
  begin
    perform public.push_notification(me, 'withdrawal', 'Sent ' || sym,
      'You sent ' || amt_txt || ' ' || sym || ' to ' || to_name || '. Reference ' || ref || '.');
  exception when others then null; end;
  begin
    perform public.push_notification(l.user_id, 'deposit', 'Received ' || sym,
      my_name || ' sent you ' || amt_txt || ' ' || sym || '. Reference ' || ref || '.');
  exception when others then null; end;

  return jsonb_build_object('ok', true, 'replayed', false, 'reference', ref, 'created_at', ts, 'to_name', to_name,
    'amount', p_amount, 'symbol', sym, 'usd_value', usdv, 'network', l.network, 'status', 'completed');
end $$;
revoke execute on function public.wallet_transfer(text,numeric,text,text,uuid) from public, anon;
grant  execute on function public.wallet_transfer(text,numeric,text,text,uuid) to authenticated;

-- 6) the old "send to an outside address" function can no longer be used for a Veltrix user's address
--    (those must go through wallet_transfer, otherwise the money would be taken and never arrive).
create or replace function public.wallet_send(p_symbol text, p_amount numeric, p_to text default null, p_net text default null, p_ref text default null, p_usd numeric default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  if p_amount <= 0 then raise exception 'invalid amount'; end if;
  if exists (select 1 from public.wallet_addr_lookup
              where symbol = upper(btrim(coalesce(p_symbol,''))) and norm = public._norm_addr(p_symbol, coalesce(p_to,''))) then
    raise exception 'internal recipient: use wallet_transfer';
  end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
  insert into transactions(user_id, wallet, kind, symbol, amount, usd_value, to_address, network, reference, status)
  values (auth.uid(), 'crypto', 'send', upper(p_symbol), p_amount, p_usd, left(p_to,200), left(p_net,80), left(p_ref,100), 'pending');
end $$;
revoke execute on function public.wallet_send(text,numeric,text,text,text,numeric) from public, anon;
grant  execute on function public.wallet_send(text,numeric,text,text,text,numeric) to authenticated;
