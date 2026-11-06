-- Veltrix · phase 10: REAL deposits. No simulated balances, history or prices any more.
--   * The deposit-watch edge function reads each user's own on-chain addresses and calls apply_chain_balance().
--   * When an address's confirmed balance goes UP, exactly the difference is added to that asset, a 'deposit' row is
--     written to the history and a notification is sent. Balance going down (an admin payout) is just recorded.
--   * Live prices are stored server-side so wallet_convert can refuse a made-up price.
-- Run in: SQL Editor, AFTER phases 8 and 9.

-- 1) history: allow deposits, remove every simulated ("test") row and the client's right to write them
alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check check (kind in ('send','convert_out','convert_in','deposit'));
drop policy if exists "own test transactions write" on public.transactions;
delete from public.transactions where test = true;

-- 2) last balance seen per address (so only the DIFFERENCE is ever credited)
create table if not exists public.chain_state (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  symbol       text not null,
  network      text,
  address      text not null,
  last_balance numeric(38,12) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (user_id, symbol, address)
);
alter table public.chain_state enable row level security;
revoke all on public.chain_state from anon, authenticated;

-- 3) live prices written by the edge function
create table if not exists public.asset_prices (
  symbol     text primary key,
  usd        numeric not null,
  updated_at timestamptz not null default now()
);
alter table public.asset_prices enable row level security;
revoke all on public.asset_prices from anon, authenticated;

-- 4) credit a deposit (service role only: called by the edge function, never by the browser)
create or replace function public.apply_chain_balance(p_user uuid, p_symbol text, p_network text, p_address text, p_balance numeric, p_name text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare st public.chain_state%rowtype; delta numeric := 0; px numeric; usdv numeric; ref text; sym text := upper(p_symbol);
begin
  if p_balance is null or p_balance < 0 then raise exception 'bad balance'; end if;
  insert into chain_state(user_id, symbol, network, address, last_balance) values (p_user, sym, p_network, p_address, 0)
    on conflict (user_id, symbol, address) do nothing;
  select * into st from chain_state where user_id = p_user and symbol = sym and address = p_address for update;
  if p_balance > st.last_balance then
    delta := p_balance - st.last_balance;
    insert into assets(user_id, symbol, name, amount) values (p_user, sym, p_name, delta)
      on conflict (user_id, symbol) do update set amount = assets.amount + excluded.amount;
    select usd into px from asset_prices where symbol = sym;
    usdv := case when px is null then null else round(delta * px, 2) end;
    ref  := 'DP-' || upper(substr(md5(gen_random_uuid()::text), 1, 10));
    insert into transactions(user_id, wallet, kind, symbol, amount, usd_value, status, to_address, network, reference)
      values (p_user, 'crypto', 'deposit', sym, delta, usdv, 'completed', p_address, left(p_network, 80), ref);
    perform public.push_notification(p_user, 'deposit', 'Deposit received',
      trim(trailing '.' from trim(trailing '0' from delta::text)) || ' ' || sym || ' was received and added to your assets.');
  end if;
  update chain_state set last_balance = p_balance, updated_at = now() where user_id = p_user and symbol = sym and address = p_address;
  return delta;
end $$;
revoke all on function public.apply_chain_balance(uuid,text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.apply_chain_balance(uuid,text,text,text,numeric,text) to service_role;

create or replace function public.set_asset_price(p_symbol text, p_usd numeric) returns void
language sql security definer set search_path = public as $$
  insert into asset_prices(symbol, usd, updated_at) values (upper(p_symbol), p_usd, now())
  on conflict (symbol) do update set usd = excluded.usd, updated_at = now() where p_usd > 0;
$$;
revoke all on function public.set_asset_price(text,numeric) from public, anon, authenticated;
grant execute on function public.set_asset_price(text,numeric) to service_role;

-- 5) conversion: the amount credited can never be more than amount x the server's fresh live price
create or replace function public.wallet_convert(p_symbol text, p_amount numeric, p_usd numeric, p_ref text default null)
returns void language plpgsql security definer set search_path = public as $$
declare px numeric;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  if p_amount <= 0 or p_usd < 0 then raise exception 'invalid amount'; end if;
  select usd into px from asset_prices where symbol = upper(p_symbol) and updated_at > now() - interval '10 minutes';
  if px is null then raise exception 'price unavailable'; end if;
  if p_usd > p_amount * px * 1.03 then raise exception 'price changed'; end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
  update profiles set usd_balance = usd_balance + p_usd where id = auth.uid();
  insert into transactions(user_id, wallet, kind, symbol, amount, usd_value, reference) values
    (auth.uid(), 'crypto', 'convert_out', upper(p_symbol), p_amount, p_usd, left(p_ref,100)),
    (auth.uid(), 'usd',    'convert_in',  upper(p_symbol), p_usd,    p_usd, left(p_ref,100));
end $$;
revoke execute on function public.wallet_convert(text,numeric,numeric,text) from public, anon;
grant  execute on function public.wallet_convert(text,numeric,numeric,text) to authenticated;
