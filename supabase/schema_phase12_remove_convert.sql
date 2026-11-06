-- Veltrix · phase 12 (OPTIONAL): the app no longer has a Convert feature or a dollar wallet.
-- Nothing here is required for the app to work — the app simply never calls wallet_convert any more.
-- Running it just removes the now-unused server function so it can't be called by anyone.
-- It does NOT delete any data (usd_balance column and old transaction rows are left untouched).
drop function if exists public.wallet_convert(text, numeric, numeric, text);
drop function if exists public.wallet_convert(text, numeric, numeric);
