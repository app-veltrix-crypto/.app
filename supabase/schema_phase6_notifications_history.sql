-- Veltrix · phase 6: notifications, watchlist (price alerts) and transaction history
-- Run in the Supabase SQL Editor AFTER schema_phase5_link_login.sql.

-- =====================================================================  notifications
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  topic      text not null,
  title      text not null,
  body       text not null default '',
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_time on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists "own notifications read"   on public.notifications;
drop policy if exists "own notifications update" on public.notifications;
drop policy if exists "own notifications delete" on public.notifications;
create policy "own notifications read"   on public.notifications for select using (auth.uid() = user_id);
create policy "own notifications update" on public.notifications for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own notifications delete" on public.notifications for delete using (auth.uid() = user_id);
revoke insert, update on public.notifications from authenticated, anon;
grant  update (read) on public.notifications to authenticated;
alter table public.notifications replica identity full;
do $$ begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end $$;

-- Internal: store a notification unless the user switched that topic OFF in Settings > Notifications (everything is ON by default).
create or replace function public.push_notification(p_uid uuid, p_topic text, p_title text, p_body text, p_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare off boolean; nid uuid;
begin
  select coalesce((data->'veltrixNotif'->>p_topic) = 'false', false) into off from public.user_settings where user_id = p_uid;
  if coalesce(off,false) then return null; end if;
  insert into public.notifications(id, user_id, topic, title, body)
  values (coalesce(p_id, gen_random_uuid()), p_uid, p_topic, left(p_title,120), left(coalesce(p_body,''),600))
  returning id into nid;
  return nid;
end $$;
revoke execute on function public.push_notification(uuid,text,text,text,uuid) from public, anon, authenticated;

-- The app calls this for events that happen in the app (login, security, transfers, price alerts ...)
create or replace function public.notify_me(p_id uuid, p_topic text, p_title text, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_topic not in ('security','chat','transaction','withdrawal','deposit','price','login','promo','news') then raise exception 'unknown topic'; end if;
  return public.push_notification(auth.uid(), p_topic, p_title, p_body, p_id);
end $$;
revoke execute on function public.notify_me(uuid,text,text,text) from public, anon;
grant  execute on function public.notify_me(uuid,text,text,text) to authenticated;

-- New sign-up -> welcome notification
create or replace function public.notify_new_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.push_notification(new.id, 'security', 'Welcome to Veltrix', 'Your account was created successfully. You will receive alerts here for the topics you keep turned on in Settings > Notifications.');
  return new;
end $$;
drop trigger if exists notify_new_profile_trg on public.profiles;
create trigger notify_new_profile_trg after insert on public.profiles for each row execute function public.notify_new_profile();

-- =====================================================================  watchlist (price alerts)
create table if not exists public.watchlist (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  symbol     text not null,
  coin_id    text not null,
  name       text,
  base_price numeric not null,          -- the price the next alert is measured against (reset after every alert)
  created_at timestamptz not null default now(),
  primary key (user_id, symbol)
);
alter table public.watchlist enable row level security;
drop policy if exists "own watchlist" on public.watchlist;
create policy "own watchlist" on public.watchlist for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =====================================================================  transaction history
create table if not exists public.transactions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  wallet     text not null check (wallet in ('usd','crypto')),
  kind       text not null check (kind in ('send','convert_out','convert_in')),
  symbol     text not null,
  amount     numeric(30,10) not null,
  usd_value  numeric(20,2),
  status     text not null default 'completed',
  to_address text,
  network    text,
  reference  text,
  test       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists transactions_user_time on public.transactions (user_id, wallet, created_at desc);
alter table public.transactions enable row level security;
drop policy if exists "own transactions read"       on public.transactions;
drop policy if exists "own test transactions write" on public.transactions;
create policy "own transactions read" on public.transactions for select using (auth.uid() = user_id);
-- only demo ("test balance") rows can be written from the app; real ones are written by wallet_send / wallet_convert below
create policy "own test transactions write" on public.transactions for insert with check (auth.uid() = user_id and test = true);
revoke update, delete on public.transactions from authenticated, anon;

-- wallet_send now also records the transaction
drop function if exists public.wallet_send(text, numeric);
create or replace function public.wallet_send(p_symbol text, p_amount numeric, p_to text default null, p_net text default null, p_ref text default null, p_usd numeric default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  if p_amount <= 0 then raise exception 'invalid amount'; end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
  insert into transactions(user_id, wallet, kind, symbol, amount, usd_value, to_address, network, reference)
  values (auth.uid(), 'crypto', 'send', upper(p_symbol), p_amount, p_usd, left(p_to,200), left(p_net,80), left(p_ref,100));
end $$;
revoke execute on function public.wallet_send(text,numeric,text,text,text,numeric) from public, anon;
grant  execute on function public.wallet_send(text,numeric,text,text,text,numeric) to authenticated;

-- wallet_convert records one row in each wallet's history
drop function if exists public.wallet_convert(text, numeric, numeric);
create or replace function public.wallet_convert(p_symbol text, p_amount numeric, p_usd numeric, p_ref text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  if p_amount <= 0 or p_usd < 0 then raise exception 'invalid amount'; end if;
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
