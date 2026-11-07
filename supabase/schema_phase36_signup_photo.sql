-- Veltrix · phase 36: the profile picture chosen at sign-up is saved on the server immediately.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run   (safe to run more than once)
--
-- Before: the sign-up photo only travelled in this browser's local storage until the first sign-in, so on the first dashboard it
-- was missing whenever the e-mail was confirmed in another browser/app, or the page was reloaded or storage was cleared.
-- Now: right after sign-up the app calls set_signup_photo(). It works before the e-mail is confirmed, and only accepts the photo
-- when the secret token the app put into that new account's sign-up data matches, so nobody can set another person's picture.

create or replace function public.set_signup_photo(p_user uuid, p_token text, p_image text) returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare ok boolean;
begin
  if p_user is null or p_token is null or length(p_token) < 16 then return false; end if;
  if p_image is null or p_image !~ '^data:image/(jpeg|png|webp|gif);base64,' or length(p_image) > 400000 then return false; end if;
  select true into ok
    from auth.users u join public.profiles p on p.id = u.id
   where u.id = p_user
     and u.raw_user_meta_data->>'photo_token' = p_token
     and u.created_at > now() - interval '2 days'
     and coalesce(p.profile_image, '') = '';
  if not coalesce(ok, false) then return false; end if;
  update public.profiles set profile_image = p_image where id = p_user;
  return true;
end $$;
revoke all on function public.set_signup_photo(uuid, text, text) from public;
grant execute on function public.set_signup_photo(uuid, text, text) to anon, authenticated;
