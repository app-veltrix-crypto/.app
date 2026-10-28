-- Veltrix · phase 8: one real wallet per user (12-word recovery phrase).
--   * The phrase is stored ENCRYPTED (pgcrypto, AES) with a key kept in Supabase Vault, never in plain text.
--   * Clients can never read the table. The phrase is released only by wallet_reveal(), and only after the
--     user's wallet PIN is verified on the server, with an escalating lock-out after wrong PINs.
--   * Public addresses (safe to show) are stored beside it as JSON.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run   (needs phases 2 and 3 already applied)

-- STEP 1 (run ONCE, then keep a safe backup of this key: if it is lost, stored phrases can no longer be decrypted):
--   select vault.create_secret(encode(gen_random_bytes(32),'hex'), 'wallet_phrase_key', 'Veltrix wallet phrase encryption key');

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.user_wallets (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  phrase_enc          bytea not null,
  addresses           jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  reveal_failed       int not null default 0,
  reveal_locks        int not null default 0,
  reveal_locked_until timestamptz
);
alter table public.user_wallets enable row level security;     -- no policies: clients can never read it
revoke all on public.user_wallets from anon, authenticated;

-- reads the encryption key from Vault; fails closed (nothing is stored) when the key has not been created
create or replace function public._wallet_key() returns text
language plpgsql security definer set search_path = public, extensions, vault as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'wallet_phrase_key' limit 1;
  if k is null or length(k) < 16 then raise exception 'wallet key not configured'; end if;
  return k;
end $$;
revoke all on function public._wallet_key() from public, anon, authenticated;

-- does this user have a wallet? (addresses only, never the phrase)
create or replace function public.wallet_info() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_wallets where user_id = auth.uid();
  if not found then return jsonb_build_object('exists', false); end if;
  return jsonb_build_object('exists', true, 'created_at', r.created_at, 'addresses', r.addresses);
end $$;

-- stores the phrase generated in the browser, once. A second call never overwrites an existing wallet.
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
  insert into user_wallets(user_id, phrase_enc, addresses)
  values (auth.uid(), pgp_sym_encrypt(p_phrase, k), p_addresses)
  on conflict (user_id) do nothing;
  get diagnostics n = row_count;
  select * into r from user_wallets where user_id = auth.uid();
  return jsonb_build_object('exists', true, 'created', n = 1, 'addresses', r.addresses);
end $$;

-- releases the phrase only to someone who proves the wallet PIN. 5 wrong PINs lock it for 15 min, then 30, 60 … up to 24 h.
create or replace function public.wallet_reveal(p text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype; s user_security%rowtype; k text; n int; mins int; until_ts timestamptz;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_wallets where user_id = auth.uid() for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_wallet'); end if;
  if r.reveal_locked_until is not null and r.reveal_locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', r.reveal_locked_until);
  end if;
  select * into s from user_security where user_id = auth.uid();
  if not found or s.pin_hash is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
  if p is null or p !~ '^[0-9]{4}$' or crypt(p, s.pin_hash) <> s.pin_hash then
    n := r.reveal_failed + 1;
    if n >= 5 then
      mins := least(15 * power(2, r.reveal_locks)::int, 1440);
      until_ts := now() + make_interval(mins => mins);
      update user_wallets set reveal_failed = 0, reveal_locks = r.reveal_locks + 1, reveal_locked_until = until_ts where user_id = auth.uid();
      return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', until_ts);
    end if;
    update user_wallets set reveal_failed = n where user_id = auth.uid();
    return jsonb_build_object('ok', false, 'reason', 'wrong', 'left', 5 - n);
  end if;
  update user_wallets set reveal_failed = 0, reveal_locks = 0, reveal_locked_until = null where user_id = auth.uid();
  k := public._wallet_key();
  return jsonb_build_object('ok', true, 'phrase', pgp_sym_decrypt(r.phrase_enc, k));
end $$;

revoke all on function public.wallet_info(), public.wallet_ensure(text, jsonb), public.wallet_reveal(text) from public, anon;
grant execute on function public.wallet_info(), public.wallet_ensure(text, jsonb), public.wallet_reveal(text) to authenticated;
