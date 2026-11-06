-- Veltrix · phase 30: fix "QR code expired" on link login. Safe to run more than once.
-- Run in the Supabase SQL Editor, then redeploy the function:  supabase functions deploy link-login

create extension if not exists pgcrypto with schema extensions;

-- Checks email + code. Raises a specific reason (no_account / no_code / expired / used / locked);
-- returns null only for a wrong code (so the wrong-try counter is kept); returns the user id when correct.
create or replace function public.consume_link_code(p_email text, p_code text) returns uuid
language plpgsql security definer set search_path = public, auth, extensions as $$
declare uid uuid; r public.link_codes%rowtype; e text := lower(trim(p_email));
begin
  select id into uid from public.profiles where lower(trim(email)) = e limit 1;
  if uid is null then select id into uid from auth.users where lower(trim(email)) = e limit 1; end if;
  if uid is null then raise exception 'no_account'; end if;
  select * into r from public.link_codes where user_id = uid order by created_at desc limit 1 for update;
  if not found then raise exception 'no_code'; end if;
  if r.used_at is not null then raise exception 'used'; end if;
  if r.expires_at < now() then raise exception 'expired'; end if;
  if r.attempts >= 5 then raise exception 'locked'; end if;
  if r.code_hash = encode(digest(upper(trim(p_code)), 'sha256'), 'hex') then
    update public.link_codes set used_at = now() where id = r.id;
    return uid;
  end if;
  update public.link_codes set attempts = attempts + 1 where id = r.id;
  return null;
end $$;
revoke execute on function public.consume_link_code(text,text) from anon, authenticated, public;
grant  execute on function public.consume_link_code(text,text) to service_role;

-- If sign-in fails after the code was accepted, the Edge Function gives the code back so the scan can be retried.
create or replace function public.release_link_code(p_user uuid) returns void
language sql security definer set search_path = public as $$
  update public.link_codes set used_at = null
   where id = (select id from public.link_codes where user_id = p_user order by created_at desc limit 1)
     and expires_at > now();
$$;
revoke execute on function public.release_link_code(uuid) from anon, authenticated, public;
grant  execute on function public.release_link_code(uuid) to service_role;
