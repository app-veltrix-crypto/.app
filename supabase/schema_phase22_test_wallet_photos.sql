-- Veltrix · phase 22: show profile pictures in the admin "Test wallets" list.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run   (after phase 11; safe to run more than once)
--
-- Same function as phase 11, with one extra field ('photo' = the user's profile_image) added to each row.
-- Nothing else changes: same admin-only check, same switch, same rows, same order.
create or replace function public.admin_test_wallets() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if not coalesce((select enabled from app_flags where key = 'test_wallet_view'), false) then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', w.user_id, 'email', p.email, 'name', p.full_name,
                     'photo', p.profile_image,
                     'created_at', w.created_at, 'expires_at', null) order by w.created_at desc)
    from user_wallets w join profiles p on p.id = w.user_id
  ), '[]'::jsonb);
end $$;
