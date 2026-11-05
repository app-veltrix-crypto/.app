-- Veltrix · phase 21: Settings → Security → View passwords (the user's own recovery phrase).
-- Run in: Supabase Dashboard → SQL Editor → New query → Run   (needs phase 8 and phase 9 already applied)
--
-- wallet_my_phrase() releases the recovery phrase to its OWNER only (auth.uid()), and only for a live, un-revoked session.
-- The phrase stays encrypted at rest (pgcrypto + the Vault key); it is decrypted only inside this function.
-- The app shows it only after the user has read the warnings and tapped Continue.

create or replace function public.wallet_my_phrase() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r user_wallets%rowtype;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_wallets where user_id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_wallet'); end if;
  return jsonb_build_object('ok', true, 'phrase', pgp_sym_decrypt(r.phrase_enc, public._wallet_key()));
end $$;

revoke all on function public.wallet_my_phrase() from public, anon;
grant execute on function public.wallet_my_phrase() to authenticated;
