-- Veltrix · Linked devices, part 2: one row per physical device
-- Run in the Supabase SQL Editor AFTER schema_phase3_devices.sql.
-- A device that signs in again is recognised by its device key: its row is UPDATED (new session, last active) instead of a new row being added.

alter table public.devices add column if not exists device_key text;
do $$ begin
  alter table public.devices add constraint devices_user_key_unique unique (user_id, device_key);
exception when duplicate_object then null; end $$;

drop function if exists public.register_device(text, text, text);

create or replace function public.register_device(p_key text, p_name text, p_platform text, p_icon text)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare
  sid uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  k   text := left(coalesce(nullif(p_key,''),'unknown'),64);
  old_sid uuid; did uuid;
begin
  if auth.uid() is null or sid is null then return null; end if;

  -- a row for this very session but a different key (created before device keys existed) is replaced by the keyed row below
  delete from public.devices where user_id = auth.uid() and session_id = sid and device_key is distinct from k;

  select session_id into old_sid from public.devices where user_id = auth.uid() and device_key = k;

  -- known device -> update it; new device -> add it
  insert into public.devices(user_id, session_id, device_key, name, platform, icon)
  values (auth.uid(), sid, k, left(p_name,80), left(p_platform,40), case when p_icon='phone' then 'phone' else 'desktop' end)
  on conflict (user_id, device_key) do update
     set session_id = excluded.session_id, last_active = now(), platform = excluded.platform
  returning id into did;

  -- this device's previous sign-in is replaced by the new one
  if old_sid is not null and old_sid <> sid then
    delete from auth.sessions where id = old_sid and user_id = auth.uid();
  end if;

  -- forget devices whose session no longer exists (signed out / expired)
  delete from public.devices d where d.user_id = auth.uid() and d.id <> did
     and not exists (select 1 from auth.sessions s where s.id = d.session_id);
  return did;
end $$;

revoke execute on function public.register_device(text,text,text,text) from anon, public;
grant  execute on function public.register_device(text,text,text,text) to authenticated;
