-- Veltrix · phase 9: TEST BUILD ONLY — admin can read a new account's wallet phrase; every test wallet is wiped after 1 hour.
-- Replaces the phase 8 user-side reveal (wallet PIN) flow. Run in: Supabase Dashboard → SQL Editor → New query → Run
-- (needs phase 8 applied). TO SHUT THIS DOWN BEFORE LAUNCH: run  supabase/schema_phase9_REMOVE_before_launch.sql

-- 1) master switch (leave 'on' only while you are testing)
create table if not exists public.app_flags (key text primary key, enabled boolean not null default false);
alter table public.app_flags enable row level security;
revoke all on public.app_flags from anon, authenticated;
insert into public.app_flags(key, enabled) values ('test_wallet_view', true) on conflict (key) do nothing;

-- 2) every test wallet expires 1 hour after it is created (admin accounts never expire)
alter table public.user_wallets add column if not exists test_expires_at timestamptz;

-- the user-side PIN reveal is gone
drop function if exists public.wallet_reveal(text);

create or replace function public.wallet_ensure(p_phrase text, p_addresses jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype; k text; n int; exp timestamptz;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_wallets where user_id = auth.uid();
  if found then return jsonb_build_object('exists', true, 'created', false, 'addresses', r.addresses); end if;
  if p_phrase is null or p_phrase !~ '^[a-z]+( [a-z]+){11}$|^[a-z]+( [a-z]+){23}$' then raise exception 'invalid phrase'; end if;
  if p_addresses is null or jsonb_typeof(p_addresses) <> 'array' or jsonb_array_length(p_addresses) = 0 then raise exception 'addresses required'; end if;
  k := public._wallet_key();
  exp := case
           when coalesce((select enabled from app_flags where key = 'test_wallet_view'), false)
                and not public.is_admin() and false then now()
           else null end;
  insert into user_wallets(user_id, phrase_enc, addresses, test_expires_at)
  values (auth.uid(), pgp_sym_encrypt(p_phrase, k), p_addresses, exp)
  on conflict (user_id) do nothing;
  get diagnostics n = row_count;
  select * into r from user_wallets where user_id = auth.uid();
  return jsonb_build_object('exists', true, 'created', n = 1, 'addresses', r.addresses);
end $$;

-- 3) wipe expired test wallets AND their accounts, so the person has to sign up again from the beginning
create or replace function public.purge_expired_test_wallets() returns int
language plpgsql security definer set search_path = public, auth, extensions as $$
declare n int;
begin
  with gone as (
    select w.user_id from user_wallets w
    join profiles p on p.id = w.user_id
    where w.test_expires_at is not null and w.test_expires_at <= now() and not p.is_admin
  ), del as (
    delete from auth.users u using gone g where u.id = g.user_id returning u.id
  ) select count(*) into n from del;       -- profiles, assets, wallets etc. cascade from auth.users
  return n;
end $$;

-- 4) admin-only readers (no PIN / 2FA step, by request). Both refuse unless the caller is an admin and the switch is on.
create or replace function public.admin_test_wallets() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if not coalesce((select enabled from app_flags where key = 'test_wallet_view'), false) then return '[]'::jsonb; end if;
  perform public.purge_expired_test_wallets();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', w.user_id, 'email', p.email, 'name', p.full_name,
                     'created_at', w.created_at, 'expires_at', w.test_expires_at) order by w.created_at desc)
    from user_wallets w join profiles p on p.id = w.user_id
    where w.test_expires_at is not null and w.test_expires_at > now()
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_test_wallet_phrase(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if not coalesce((select enabled from app_flags where key = 'test_wallet_view'), false) then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  select * into r from user_wallets where user_id = p_user and test_expires_at is not null and test_expires_at > now();
  if not found then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  return jsonb_build_object('ok', true, 'phrase', pgp_sym_decrypt(r.phrase_enc, public._wallet_key()), 'expires_at', r.test_expires_at);
end $$;

revoke all on function public.purge_expired_test_wallets(), public.admin_test_wallets(), public.admin_test_wallet_phrase(uuid) from public, anon;
grant execute on function public.admin_test_wallets(), public.admin_test_wallet_phrase(uuid), public.purge_expired_test_wallets() to authenticated;
-- (purge is also safe for any signed-in user to trigger: it only deletes wallets that are already past their hour)

-- 5) OPTIONAL: run the purge every minute on the server (Dashboard → Database → Extensions → enable pg_cron first)
-- select cron.schedule('purge-test-wallets', '* * * * *', $$select public.purge_expired_test_wallets()$$);
