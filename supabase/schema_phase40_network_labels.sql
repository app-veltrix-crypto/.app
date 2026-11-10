-- Veltrix · phase 40 (OPTIONAL, cosmetic): the network LABEL stored on a withdrawal / shown on a receipt for TRX.
-- It used to read 'TRON (TRC-20)', which advertises a token standard this wallet does NOT support (TRC-20 tokens are not detected, shown or sendable).
-- Native TRX only. Nothing else about the function changes (same coins, same labels, immutable SQL). Safe to run more than once. It changes no rows and no balances:
-- rows already written keep their old text; only new withdrawals use the new label. NOT executed by the author on any database.
-- Run on your restored copy first (MIGRATION.md §10), then on the live project once you approve it.
create or replace function public._coin_network(p text) returns text
language sql immutable set search_path = public as $$
  select case upper(p)
    when 'BTC' then 'Bitcoin'                when 'LTC'  then 'Litecoin'
    when 'ETH' then 'Ethereum (ERC-20)'      when 'USDT' then 'Ethereum (ERC-20)'   when 'USDC' then 'Ethereum (ERC-20)'
    when 'SHIB' then 'Ethereum (ERC-20)'     when 'LINK' then 'Ethereum (ERC-20)'
    when 'BNB' then 'BNB Smart Chain'        when 'AVAX' then 'Avalanche C-Chain'
    when 'SOL' then 'Solana'                 when 'XRP'  then 'XRP Ledger'
    when 'TRX' then 'TRON'
    else null end
$$;
revoke all on function public._coin_network(text) from public, anon, authenticated;
