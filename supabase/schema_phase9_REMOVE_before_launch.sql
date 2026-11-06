-- Run this BEFORE you publish the app: switches the admin phrase view off, removes it, and stops wallet expiry.
-- (Also delete app.js/admin-test-wallets.js from the admin page, and re-apply the PIN-protected reveal from schema_phase8_wallet.sql.)
update public.app_flags set enabled = false where key = 'test_wallet_view';
drop function if exists public.admin_test_wallet_phrase(uuid);
drop function if exists public.admin_test_wallets();
drop function if exists public.purge_expired_test_wallets();
update public.user_wallets set test_expires_at = null;
-- select cron.unschedule('purge-test-wallets');   -- only if you scheduled it
