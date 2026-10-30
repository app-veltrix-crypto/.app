-- Veltrix · phase 17: import an existing wallet (recovery phrase) when creating an account.
-- Run AFTER phases 13 and 14.
--
-- * wallet_import(): like wallet_ensure(), but for a phrase the user already owns. The phrase is stored encrypted exactly like a generated one.
--   A wallet (any of its addresses) can belong to ONE account only: importing a phrase that is already on another account is refused.
-- * IMPORTANT, read this: the person who imports a phrase still holds the keys to those addresses and can move the coins on the
--   blockchain at any moment. Crediting the app balance for coins they can still spend themselves would let them spend twice.
--   So by default coins that are on (or sent to) an IMPORTED wallet are NOT credited to the app balance.
--   Turn crediting on ONLY if you also sweep imported wallets to your treasury (or accept the risk):
--       update public.app_flags set enabled = true where key = 'credit_imported';

alter table public.user_wallets add column if not exists imported boolean not null default false;
insert into public.app_flags(key, enabled) values ('credit_imported', false) on conflict (key) do nothing;

create or replace function public.wallet_import(p_phrase text, p_addresses jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype; k text; a jsonb; n int; taken boolean;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_wallets where user_id = auth.uid();
  if found then return jsonb_build_object('ok', true, 'exists', true, 'created', false, 'addresses', r.addresses); end if;
  if p_phrase is null or p_phrase !~ '^[a-z]+( [a-z]+){11}$|^[a-z]+( [a-z]+){23}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phrase');
  end if;
  if p_addresses is null or jsonb_typeof(p_addresses) <> 'array' or jsonb_array_length(p_addresses) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phrase');
  end if;
  -- the same wallet on two accounts would be credited twice
  taken := false;
  for a in select * from jsonb_array_elements(p_addresses) loop
    if exists (select 1 from public.wallet_addr_lookup
                where symbol = upper(a->>'symbol') and norm = public._norm_addr(upper(a->>'symbol'), a->>'address') and user_id <> auth.uid()) then
      taken := true; exit;
    end if;
  end loop;
  if taken then return jsonb_build_object('ok', false, 'reason', 'already_registered'); end if;
  k := public._wallet_key();
  begin
    insert into user_wallets(user_id, phrase_enc, addresses, imported)
    values (auth.uid(), pgp_sym_encrypt(p_phrase, k), p_addresses, true)
    on conflict (user_id) do nothing;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already_registered');
  end;
  get diagnostics n = row_count;
  select * into r from user_wallets where user_id = auth.uid();
  return jsonb_build_object('ok', true, 'exists', true, 'created', n = 1, 'addresses', r.addresses);
end $$;
revoke execute on function public.wallet_import(text,jsonb) from public, anon;
grant  execute on function public.wallet_import(text,jsonb) to authenticated;

-- deposits: skip imported wallets while the switch is off
create or replace function public.apply_chain_balance(p_user uuid, p_symbol text, p_network text, p_address text, p_balance numeric, p_name text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare imp boolean; st public.chain_state%rowtype; delta numeric := 0; px numeric; usdv numeric; ref text; sym text := upper(p_symbol);
begin
  if p_balance is null or p_balance < 0 then raise exception 'bad balance'; end if;
  -- coins on an IMPORTED wallet are not credited unless the 'credit_imported' switch is on (see the top of this file)
  select w.imported into imp from user_wallets w where w.user_id = p_user;
  if coalesce(imp, false) and not coalesce((select enabled from app_flags where key = 'credit_imported'), false) then return 0; end if;
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
