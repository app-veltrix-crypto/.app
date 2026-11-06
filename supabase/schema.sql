-- Veltrix · Supabase schema (phase 1: accounts, profiles, wallet)
-- Run in: Supabase Dashboard → SQL Editor → New query → Run

create table public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text not null,
  full_name           text not null default '',
  location            text,
  date_of_birth       date,
  profile_image       text,              -- data URL for now; move to Storage later
  profile_about       text default '',
  profile_username    text default '',
  profile_phone       text default '',
  profile_links       text default '',
  fingerprint_enabled boolean not null default false,
  usd_balance         numeric(20,2) not null default 0 check (usd_balance >= 0),
  is_admin            boolean not null default false,
  created_at          timestamptz not null default now()
);

create table public.assets (
  user_id uuid not null references public.profiles(id) on delete cascade,
  symbol  text not null,
  name    text,
  amount  numeric(30,10) not null check (amount >= 0),
  primary key (user_id, symbol)
);

-- Create the profile row automatically when someone signs up
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, location, date_of_birth, fingerprint_enabled)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    new.raw_user_meta_data->>'location',
    nullif(new.raw_user_meta_data->>'date_of_birth','')::date,
    coalesce((new.raw_user_meta_data->>'fingerprint_enabled')::boolean,false)
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row Level Security: users only ever see/modify their own rows
alter table public.profiles enable row level security;
alter table public.assets   enable row level security;

create policy "own profile read"   on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);
create policy "own assets read"    on public.assets   for select using (auth.uid() = user_id);

-- Clients may edit profile details but NEVER balance / admin flag / assets directly
revoke update on public.profiles from authenticated, anon;
grant  update (full_name, location, date_of_birth, profile_image, profile_about,
               profile_username, profile_phone, profile_links, fingerprint_enabled)
       on public.profiles to authenticated;
revoke insert, update, delete on public.assets from authenticated, anon;

-- Wallet changes go through these functions only (atomic + checked)
create function public.wallet_convert(p_symbol text, p_amount numeric, p_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_amount <= 0 or p_usd < 0 then raise exception 'invalid amount'; end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
  update profiles set usd_balance = usd_balance + p_usd where id = auth.uid();
end $$;

create function public.wallet_send(p_symbol text, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_amount <= 0 then raise exception 'invalid amount'; end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
end $$;

revoke all on function public.wallet_convert(text,numeric,numeric) from public, anon;
revoke all on function public.wallet_send(text,numeric)            from public, anon;
grant execute on function public.wallet_convert(text,numeric,numeric) to authenticated;
grant execute on function public.wallet_send(text,numeric)            to authenticated;
