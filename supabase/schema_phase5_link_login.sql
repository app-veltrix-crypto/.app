-- Veltrix · phase 5: sign in on another device by scanning a QR code
-- Run in the Supabase SQL Editor AFTER schema_phase3b_device_dedupe.sql.
-- Then deploy the Edge Function in supabase/functions/link-login (see the README comment in index.ts).
--
-- How it works
--   1. The account owner opens Settings > Linked devices > Link a device. The app asks create_link_code() for a
--      one-time code (valid 2 minutes). Only a SHA-256 hash of it is stored. The QR holds: email + that code.
--   2. Another phone scans the QR inside the Veltrix scanner and sends email + code to the link-login Edge Function.
--   3. consume_link_code() checks them (max 5 wrong tries, single use, 2-minute expiry). If correct, the function
--      returns a one-time sign-in token and the scanning phone is signed into that account, in MEMORY ONLY.
--   4. That phone is listed in the account's devices as a "linked device" for 30 minutes. When the 30 minutes pass,
--      its session is deleted and it disappears from the list automatically.

create extension if not exists pgcrypto with schema extensions;

-- ---- devices: mark linked ones and give them an expiry ----
alter table public.devices add column if not exists linked     boolean not null default false;
alter table public.devices add column if not exists expires_at timestamptz;

-- ---- one-time link codes (no client access at all; only the functions below touch this table) ----
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

-- ---- remove linked devices whose time is up (kills their session, which also removes the row via the app's device cleanup) ----
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

-- ---- a session is only valid while its device row exists and has not expired ----
create or replace function public.session_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices
                  where user_id = auth.uid()
                    and session_id = nullif(auth.jwt()->>'session_id','')::uuid
                    and (expires_at is null or expires_at > now()))
$$;

-- ---- normal device registration now also clears expired linked devices ----
create or replace function public.register_device(p_key text, p_name text, p_platform text, p_icon text)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare
  sid uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  k   text := left(coalesce(nullif(p_key,''),'unknown'),64);
  old_sid uuid; did uuid;
begin
  if auth.uid() is null or sid is null then return null; end if;
  perform public.purge_expired_devices();
  delete from public.devices where user_id = auth.uid() and session_id = sid and device_key is distinct from k;
  select session_id into old_sid from public.devices where user_id = auth.uid() and device_key = k;
  insert into public.devices(user_id, session_id, device_key, name, platform, icon)
  values (auth.uid(), sid, k, left(p_name,80), left(p_platform,40), case when p_icon='phone' then 'phone' else 'desktop' end)
  on conflict (user_id, device_key) do update
     set session_id = excluded.session_id, last_active = now(), platform = excluded.platform
  returning id into did;
  if old_sid is not null and old_sid <> sid then
    delete from auth.sessions where id = old_sid and user_id = auth.uid();
  end if;
  delete from public.devices d where d.user_id = auth.uid() and d.id <> did
     and not exists (select 1 from auth.sessions s where s.id = d.session_id);
  return did;
end $$;
revoke execute on function public.register_device(text,text,text,text) from anon, public;
grant  execute on function public.register_device(text,text,text,text) to authenticated;

-- ---- registration for a device signed in by QR: always flagged "linked" and expires after 30 minutes ----
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

-- ---- the account owner asks for a one-time code to put in the QR ----
create or replace function public.create_link_code() returns text
language plpgsql security definer set search_path = public, auth, extensions as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(12);
  c text := ''; i int;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'not allowed'; end if;
  -- a device that is itself signed in by QR cannot hand out more links
  if exists (select 1 from public.devices where user_id = auth.uid() and linked
                and session_id = nullif(auth.jwt()->>'session_id','')::uuid) then
    raise exception 'linked devices cannot link other devices';
  end if;
  for i in 0..11 loop c := c || substr(alphabet, (get_byte(bytes,i) % 32) + 1, 1); end loop;
  delete from public.link_codes where user_id = auth.uid();            -- only one live code per account
  insert into public.link_codes(user_id, code_hash, created_by_session, expires_at)
  values (auth.uid(), encode(extensions.digest(c,'sha256'),'hex'),
          nullif(auth.jwt()->>'session_id','')::uuid, now() + interval '2 minutes');
  return c;
end $$;
revoke execute on function public.create_link_code() from anon, public;
grant  execute on function public.create_link_code() to authenticated;

-- ---- called ONLY by the Edge Function (service role): checks email + code, single use ----
create or replace function public.consume_link_code(p_email text, p_code text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; r public.link_codes%rowtype;
begin
  select id into uid from public.profiles where lower(email) = lower(trim(p_email));
  if uid is null then return null; end if;
  select * into r from public.link_codes where user_id = uid order by created_at desc limit 1 for update;
  if not found or r.used_at is not null or r.expires_at < now() or r.attempts >= 5 then return null; end if;
  if r.code_hash = encode(extensions.digest(upper(trim(p_code)),'sha256'),'hex') then
    update public.link_codes set used_at = now() where id = r.id;
    return uid;
  end if;
  update public.link_codes set attempts = attempts + 1 where id = r.id;
  return null;
end $$;
revoke execute on function public.consume_link_code(text,text) from anon, authenticated, public;
grant  execute on function public.consume_link_code(text,text) to service_role;
