-- Veltrix · phase 33: disappearing messages (24 hours). Safe to run more than once.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phases 29 and 31)
-- Turning it on in a chat stamps every NEW message with an expiry time ("exp", 24 h after it is sent). The apps remove expired
-- messages on both sides; this file also adds the server-side parts: the switch for real-user chats (both people's copies),
-- delivery that keeps the setting (text + media), and a clean-up function so nothing survives if nobody has the app open.

-- 1) switch it on/off for BOTH people of a real-user chat
create or replace function public.chat_set_disappear(p_peer uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  if p_peer is null or p_peer = me then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if not exists (select 1 from public.profiles where id = p_peer) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  update public.conversations set data = data || jsonb_build_object('disappear', coalesce(p_on, false))
   where user_id = me and contact_id = 'real-' || p_peer::text;
  update public.conversations set data = data || jsonb_build_object('disappear', coalesce(p_on, false))
   where user_id = p_peer and contact_id = 'real-' || me::text;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.chat_set_disappear(uuid,boolean) from public, anon;
grant  execute on function public.chat_set_disappear(uuid,boolean) to authenticated;

-- 2) delivery of text / media to a real user now carries the setting (replaces the phase 29 and phase 31 versions)
create or replace function public.chat_send_real(p_to uuid, p_id text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); nm text; un text; ph text; cid text;
  t bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  txt text := left(coalesce(p_text,''), 4000);
  target_admin boolean; sender_admin boolean;
  mid text; dis boolean;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  if p_to is null or p_to = me or btrim(txt) = '' or coalesce(p_id,'') = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select coalesce(is_admin,false) into sender_admin from public.profiles where id = me;
  select coalesce(is_admin,false) into target_admin from public.profiles where id = p_to;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(sender_admin,false) and coalesce(target_admin,false) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select coalesce(nullif(btrim(full_name),''),'Veltrix user'),
         coalesce(profile_username,''),
         case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end
    into nm, un, ph from public.profiles where id = me;
  cid := 'real-' || me::text;
  select coalesce((select (data->>'disappear')::boolean from public.conversations where user_id = me and contact_id = 'real-' || p_to::text), false)
      or coalesce((select (data->>'disappear')::boolean from public.conversations where user_id = p_to and contact_id = cid), false)
    into dis;
  mid := 'rx-' || left(p_id, 40) || '-' || substr(md5(me::text), 1, 6);
  perform set_config('veltrix.real_chat', '1', true);
  insert into public.conversations(user_id, contact_id, data)
  values (p_to, cid, jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,''))) || case when dis then jsonb_build_object('disappear', true) else '{}'::jsonb end)
  on conflict (user_id, contact_id) do update
    set data = public.conversations.data
               || jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,''))) || case when dis then jsonb_build_object('disappear', true) else '{}'::jsonb end;
  insert into public.messages(id, user_id, contact_id, t, data)
  values (mid, p_to, cid, t,
    jsonb_build_object('id', mid, 'from', 'them', 't', t, 'type', 'text', 'text', txt) || case when dis then jsonb_build_object('exp', t + 86400000) else '{}'::jsonb end)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true, 'id', mid);
end $$;
revoke execute on function public.chat_send_real(uuid,text,text) from public, anon;
grant  execute on function public.chat_send_real(uuid,text,text) to authenticated;

create or replace function public.chat_send_real_media(p_to uuid, p_id text, p_msg jsonb) returns jsonb
language plpgsql security definer set search_path = public, storage as $$
declare
  me uuid := auth.uid(); nm text; un text; ph text; cid text; mid text;
  t bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  kind text := coalesce(p_msg->>'type','');
  target_admin boolean; sender_admin boolean; d jsonb; dis boolean;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  if p_to is null or p_to = me or coalesce(p_id,'') = '' or kind not in ('image','video','audio','file') then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'chat-media' and name = me::text || '/' || p_id) then
    return jsonb_build_object('ok', false, 'reason', 'no_file');
  end if;
  select coalesce(is_admin,false) into sender_admin from public.profiles where id = me;
  select coalesce(is_admin,false) into target_admin from public.profiles where id = p_to;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(sender_admin,false) and coalesce(target_admin,false) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select coalesce(nullif(btrim(full_name),''),'Veltrix user'), coalesce(profile_username,''),
         case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end
    into nm, un, ph from public.profiles where id = me;
  cid := 'real-' || me::text;
  select coalesce((select (data->>'disappear')::boolean from public.conversations where user_id = me and contact_id = 'real-' || p_to::text), false)
      or coalesce((select (data->>'disappear')::boolean from public.conversations where user_id = p_to and contact_id = cid), false)
    into dis;
  mid := 'rx-' || left(p_id, 40) || '-' || substr(md5(me::text), 1, 6);
  d := jsonb_strip_nulls(jsonb_build_object(
         'id', mid, 'from', 'them', 't', t, 'type', kind,
         'text', left(coalesce(p_msg->>'text',''), 4000),
         'name', left(coalesce(p_msg->>'name',''), 300),
         'mime', left(coalesce(p_msg->>'mime',''), 120),
         'size', coalesce((p_msg->>'size')::numeric, 0),
         'dur',  coalesce((p_msg->>'dur')::numeric, 0),
         'once', coalesce((p_msg->>'once')::boolean, false) and kind <> 'file',
         'mediaOwner', me::text, 'mediaId', p_id)) || case when dis then jsonb_build_object('exp', t + 86400000) else '{}'::jsonb end;
  perform set_config('veltrix.real_chat', '1', true);
  insert into public.conversations(user_id, contact_id, data)
  values (p_to, cid, jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,''))) || case when dis then jsonb_build_object('disappear', true) else '{}'::jsonb end)
  on conflict (user_id, contact_id) do update
    set data = public.conversations.data
               || jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,''))) || case when dis then jsonb_build_object('disappear', true) else '{}'::jsonb end;
  insert into public.messages(id, user_id, contact_id, t, data) values (mid, p_to, cid, t, d)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true, 'id', mid);
end $$;
revoke execute on function public.chat_send_real_media(uuid,text,jsonb) from public, anon;
grant  execute on function public.chat_send_real_media(uuid,text,jsonb) to authenticated;

-- 3) clean-up: removes every message whose expiry time has passed (the apps do this too while open)
create or replace function public.purge_expired_messages() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.messages
   where (data->>'exp') ~ '^[0-9]+$' and (data->>'exp')::numeric <= extract(epoch from clock_timestamp()) * 1000;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.purge_expired_messages() from public, anon;
grant  execute on function public.purge_expired_messages() to authenticated, service_role;

-- every 5 minutes, if the pg_cron extension is enabled on your project (Dashboard → Database → Extensions → pg_cron)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('veltrix-purge-expired', '*/5 * * * *', 'select public.purge_expired_messages()');
  end if;
end $$;
