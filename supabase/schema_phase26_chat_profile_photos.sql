-- Veltrix · phase 26: keep other users' profile pictures in chats
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phase 24; safe to run more than once)
--
-- The chat list re-fetches the name / @username / photo of the real users you chat with, so their
-- picture never disappears after a chat is closed or the app reloads. Same rules as search_users:
-- signed-in, valid session, admin accounts never returned, oversized photos skipped.
create or replace function public.get_profiles(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into r from (
    select jsonb_build_object('id', id, 'name', coalesce(nullif(btrim(full_name),''),'Veltrix user'),
             'username', coalesce(profile_username,''),
             'photo', case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end) as x
    from public.profiles
    where id = any(p_ids[1:50]) and id <> auth.uid() and not is_admin) s;
  return r;
end $$;
revoke execute on function public.get_profiles(uuid[]) from public, anon;
grant  execute on function public.get_profiles(uuid[]) to authenticated;
