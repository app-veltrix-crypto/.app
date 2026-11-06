-- Veltrix · phase 34: QR "link device" login that works with the database ONLY.
-- Run this whole file once in the Supabase SQL Editor. Safe to run again.
--
-- Why: the app showed "Could not reach the server" because QR login depended on a separate Edge Function
-- (link-login) that is not deployed / not reachable. This file removes that dependency: the app now calls the
-- database function link_login(email, code), which checks the one-time code and returns a sign-in token.
--
-- Flow
--   Phone A (owner)  Settings > Linked devices > Link a device  -> create_link_code()  -> QR = email + one-time code
--   Phone B (scans)  link_login(email, code) -> token -> supabase.auth.verifyOtp(token_hash, "magiclink")
--                    Phone B leaves whatever account it was in (leave_this_device + local sign-out) and is signed
--                    in to the scanned account. It stays listed as a "linked device" for 30 minutes.
-- You do NOT need to deploy supabase/functions/link-login any more.

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables / columns ----------
alter table public.devices add column if not exists linked     boolean not null default false;
alter table public.devices add column if not exists expires_at timestamptz;

create table if not exists public.link_codes (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  code_hash          text not null,
  created_by_session uuid,
  expires_at         timestamptz not null,
  used_at            timestamptz,
  attempts           int not null default 0,
  created_at         timestamptz not null default now()
);
alter table public.link_codes enable row level security;
revoke all on public.link_codes from anon, authenticated;

-- ---------- linked devices expire after 30 minutes ----------
create or replace function public.purge_expired_devices() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then return; end if;
  delete from auth.sessions
   where id in (select session_id from public.devices
                 where user_id = auth.uid() and expires_at is not null and expires_at < now());
  delete from public.devices where user_id = auth.uid() and expires_at is not null and expires_at < now();
end $$;
revoke execute on function public.purge_expired_devices() from anon, public;
grant  execute on function public.purge_expired_devices() to authenticated;

create or replace function public.register_linked_device(p_key text, p_name text, p_platform text, p_icon text)
returns timestamptz language plpgsql security definer set search_path = public, auth as $$
declare
  sid uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  k   text := left(coalesce(nullif(p_key,''),'linked'),64);
  exp timestamptz := now() + interval '30 minutes';   -- <-- linked-session length
begin
  if auth.uid() is null or sid is null then return null; end if;
  perform public.purge_expired_devices();
  insert into public.devices(user_id, session_id, device_key, name, platform, icon, linked, expires_at)
  values (auth.uid(), sid, k, left(p_name,80), left(p_platform,40), case when p_icon='phone' then 'phone' else 'desktop' end, true, exp)
  on conflict (user_id, device_key) do update
     set session_id = excluded.session_id, last_active = now(), linked = true, expires_at = exp;
  return exp;
end $$;
revoke execute on function public.register_linked_device(text,text,text,text) from anon, public;
grant  execute on function public.register_linked_device(text,text,text,text) to authenticated;

-- ---------- the account owner asks for a one-time code to put in the QR (valid 2 minutes) ----------
create or replace function public.create_link_code() returns text
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(12);
  c text := ''; i int;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'not allowed'; end if;
  if exists (select 1 from public.devices where user_id = auth.uid() and linked
                and session_id = nullif(auth.jwt()->>'session_id','')::uuid) then
    raise exception 'linked devices cannot link other devices';
  end if;
  for i in 0..11 loop c := c || substr(alphabet, (get_byte(bytes,i) % 32) + 1, 1); end loop;
  delete from public.link_codes where user_id = auth.uid();
  insert into public.link_codes(user_id, code_hash, created_by_session, expires_at)
  values (auth.uid(), encode(extensions.digest(c,'sha256'),'hex'),
          nullif(auth.jwt()->>'session_id','')::uuid, now() + interval '2 minutes');
  return c;
end $$;
revoke execute on function public.create_link_code() from anon, public;
grant  execute on function public.create_link_code() to authenticated;

-- ---------- THE FIX: the scanning phone calls this (no Edge Function). Never raises, so wrong-try counting is kept ----------
create or replace function public.link_login(p_email text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  e   text := lower(trim(coalesce(p_email,'')));
  c   text := upper(trim(coalesce(p_code,'')));
  uid uuid; r public.link_codes%rowtype; uemail text; th text;
  bad jsonb := jsonb_build_object('error','This QR code is invalid or has expired. Ask for a new one.','reason','invalid');
begin
  if e = '' or length(e) > 200 or c !~ '^[A-Z2-9]{12}$' then return bad; end if;

  select id into uid from public.profiles where lower(trim(email)) = e limit 1;
  if uid is null then select id into uid from auth.users where lower(trim(email)) = e limit 1; end if;
  if uid is null then return bad; end if;                         -- same answer as a bad code (no account probing)

  select * into r from public.link_codes where user_id = uid order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('error','No active link code for that account. Ask for a new QR code.','reason','no_code'); end if;
  if r.used_at is not null then return jsonb_build_object('error','This QR code was already used. Ask for a new one.','reason','used'); end if;
  if r.expires_at < now()  then return jsonb_build_object('error','This QR code has expired. Ask for a new one.','reason','expired'); end if;
  if r.attempts >= 5       then return jsonb_build_object('error','Too many wrong attempts. Ask for a new QR code.','reason','locked'); end if;

  if r.code_hash <> encode(digest(c,'sha256'),'hex') then
    update public.link_codes set attempts = attempts + 1 where id = r.id;
    return jsonb_build_object('error','This QR code is not valid. Ask for a new one.','reason','wrong');
  end if;

  select email into uemail from auth.users where id = uid;
  if uemail is null then return jsonb_build_object('error','Could not find the account. Try again.','reason','user'); end if;

  update public.link_codes set used_at = now() where id = r.id;   -- single use

  -- Create the one-time sign-in token exactly like Supabase Auth's own magic link does, and hand back its hash.
  th := encode(digest(gen_random_bytes(32),'sha256'),'hex');
  begin
    if to_regclass('auth.one_time_tokens') is not null then
      delete from auth.one_time_tokens where user_id = uid and token_type = 'recovery_token';
      insert into auth.one_time_tokens(user_id, token_type, token_hash, relates_to)
      values (uid, 'recovery_token', th, uemail);
    end if;
    update auth.users set recovery_token = th, recovery_sent_at = now() where id = uid;   -- older Auth versions read these
  exception when others then
    update public.link_codes set used_at = null where id = r.id;  -- give the code back so the scan can be retried
    return jsonb_build_object('error','Could not start the sign-in. Try again.','reason','mint','detail',sqlerrm);
  end;

  return jsonb_build_object('token_hash', th);
end $$;
revoke execute on function public.link_login(text,text) from public;
grant  execute on function public.link_login(text,text) to anon, authenticated;

-- ---------- the scanning phone leaves the account it was in (so it is not left listed there) ----------
create or replace function public.leave_this_device() returns void
language plpgsql security definer set search_path = public, auth as $$
declare sid uuid := nullif(auth.jwt()->>'session_id','')::uuid;
begin
  if auth.uid() is null or sid is null then return; end if;
  delete from public.devices where user_id = auth.uid() and session_id = sid;
  delete from auth.sessions  where id = sid and user_id = auth.uid();
end $$;
revoke execute on function public.leave_this_device() from anon, public;
grant  execute on function public.leave_this_device() to authenticated;

-- ---------- internal helpers from earlier phases are no longer called by the app; lock them down ----------
do $$ begin
  if to_regprocedure('public.consume_link_code(text,text)') is not null then
    revoke execute on function public.consume_link_code(text,text) from anon, authenticated, public;
  end if;
end $$;

-- make the API see the new functions right away
notify pgrst, 'reload schema';

-- ---------- quick self-check (read the result: every row should say true) ----------
select 'link_login exists'        as test, to_regprocedure('public.link_login(text,text)') is not null as ok
union all select 'leave_this_device exists', to_regprocedure('public.leave_this_device()') is not null
union all select 'create_link_code exists',  to_regprocedure('public.create_link_code()') is not null
union all select 'session_ok exists',        to_regprocedure('public.session_ok()') is not null
union all select 'auth.one_time_tokens present (or legacy columns used)',
  to_regclass('auth.one_time_tokens') is not null
  or exists (select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='recovery_sent_at');
