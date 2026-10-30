-- Veltrix · phase 19: the wallet supports ONLY coins that can be sent to other wallets / other apps.
-- Run AFTER phases 13, 14, 17 and 18. Safe to run more than once.
--
-- Supported (can be sent outside):  BTC LTC ETH USDT USDC SHIB LINK BNB AVAX SOL XRP TRX
-- REMOVED completely:                DOGE TON ADA XLM BCH SUI HBAR DOT
--
-- To add a coin later, add it to _supported_coin() below AND to the app (cryptoFallback + send list in script.js, addrgen.js).

-- 1) the one list of supported coins
create or replace function public._supported_coin(p text) returns boolean
language sql immutable set search_path = public as $$
  select upper(coalesce(p,'')) in ('BTC','LTC','ETH','USDT','USDC','SHIB','LINK','BNB','AVAX','SOL','XRP','TRX')
$$;
revoke all on function public._supported_coin(text) from public, anon, authenticated;

-- 2) network + address rules: unsupported coins are now unknown (refused by every send path)
create or replace function public._coin_network(p text) returns text
language sql immutable set search_path = public as $$
  select case upper(p)
    when 'BTC' then 'Bitcoin'                when 'LTC'  then 'Litecoin'
    when 'ETH' then 'Ethereum (ERC-20)'      when 'USDT' then 'Ethereum (ERC-20)'   when 'USDC' then 'Ethereum (ERC-20)'
    when 'SHIB' then 'Ethereum (ERC-20)'     when 'LINK' then 'Ethereum (ERC-20)'
    when 'BNB' then 'BNB Smart Chain'        when 'AVAX' then 'Avalanche C-Chain'
    when 'SOL' then 'Solana'                 when 'XRP'  then 'XRP Ledger'
    when 'TRX' then 'TRON (TRC-20)'
    else null end
$$;

create or replace function public._valid_addr(p_symbol text, p_addr text) returns boolean
language sql immutable set search_path = public as $$
  select case upper(p_symbol)
    when 'BTC'  then p_addr ~ '^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$'
    when 'LTC'  then p_addr ~ '^(ltc1[a-z0-9]{25,62}|[LM][1-9A-HJ-NP-Za-km-z]{26,33})$'
    when 'ETH'  then p_addr ~ '^0x[a-fA-F0-9]{40}$'   when 'USDT' then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'USDC' then p_addr ~ '^0x[a-fA-F0-9]{40}$'   when 'SHIB' then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'LINK' then p_addr ~ '^0x[a-fA-F0-9]{40}$'   when 'BNB'  then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'AVAX' then p_addr ~ '^0x[a-fA-F0-9]{40}$'
    when 'SOL'  then p_addr ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    when 'XRP'  then p_addr ~ '^r[1-9A-HJ-NP-Za-km-z]{24,34}$'
    when 'TRX'  then p_addr ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'
    else false end
$$;

-- 3) a wallet (generated OR imported from a phrase that supports thousands of coins) only ever stores the supported coins
create or replace function public._wallet_only_supported() returns trigger
language plpgsql set search_path = public as $$
begin
  if jsonb_typeof(new.addresses) = 'array' then
    select coalesce(jsonb_agg(e), '[]'::jsonb) into new.addresses
      from jsonb_array_elements(new.addresses) e
     where public._supported_coin(e->>'symbol');
  end if;
  return new;
end $$;
revoke all on function public._wallet_only_supported() from public, anon, authenticated;
drop trigger if exists wallet_only_supported on public.user_wallets;
create trigger wallet_only_supported before insert or update of addresses on public.user_wallets
  for each row execute function public._wallet_only_supported();

-- 4) clean up what already exists
do $$
declare n int; r record;
begin
  -- addresses stored on existing wallets (the lookup table is rebuilt by its own trigger)
  update public.user_wallets set addresses = addresses where jsonb_typeof(addresses) = 'array';
  delete from public.wallet_addr_lookup where not public._supported_coin(symbol);
  delete from public.chain_state        where not public._supported_coin(symbol);
  delete from public.asset_prices       where not public._supported_coin(symbol);

  -- balances: empty rows are deleted. A row that still holds money is NEVER deleted automatically (that would destroy funds);
  -- the app hides it, and it is listed here so you can settle it with the owner.
  delete from public.assets where not public._supported_coin(symbol) and amount = 0;
  get diagnostics n = row_count;
  raise notice 'removed % empty balance rows of unsupported coins', n;
  for r in select user_id, symbol, amount from public.assets where not public._supported_coin(symbol) and amount <> 0 loop
    raise notice 'NON-ZERO balance of an unsupported coin: user % holds % %', r.user_id, r.amount, r.symbol;
  end loop;
end $$;
