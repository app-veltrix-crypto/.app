-- PHASE 41 — lock the two scanner-position functions.
-- chain_cursor_get / chain_cursor_set (phase 38) were created without a REVOKE, so any signed-in (or even signed-out) app user could call them
-- and overwrite the scanner's saved block position. Only the server (service_role) may use them. Safe to run more than once.
revoke all on function public.chain_cursor_get(text), public.chain_cursor_set(text, bigint) from public, anon, authenticated;
grant execute on function public.chain_cursor_get(text), public.chain_cursor_set(text, bigint) to service_role;
