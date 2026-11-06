-- Veltrix · phase 31: let real users send photos, videos, voice notes and files to each other. Safe to run more than once.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run

-- 1) deliver a media message to another real user. The file itself is already uploaded by the sender to their own
--    folder in the chat-media bucket; the receiver's copy just points at it.
create or replace function public.chat_send_real_media(p_to uuid, p_id text, p_msg jsonb) returns jsonb
language plpgsql security definer set search_path = public, storage as $$
declare
  me uuid := auth.uid(); nm text; un text; ph text; cid text; mid text;
  t bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  kind text := coalesce(p_msg->>'type','');
  target_admin boolean; sender_admin boolean; d jsonb;
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
  mid := 'rx-' || left(p_id, 40) || '-' || substr(md5(me::text), 1, 6);
  d := jsonb_strip_nulls(jsonb_build_object(
         'id', mid, 'from', 'them', 't', t, 'type', kind,
         'text', left(coalesce(p_msg->>'text',''), 4000),
         'name', left(coalesce(p_msg->>'name',''), 300),
         'mime', left(coalesce(p_msg->>'mime',''), 120),
         'size', coalesce((p_msg->>'size')::numeric, 0),
         'dur',  coalesce((p_msg->>'dur')::numeric, 0),
         'once', coalesce((p_msg->>'once')::boolean, false) and kind <> 'file',
         'mediaOwner', me::text, 'mediaId', p_id));
  perform set_config('veltrix.real_chat', '1', true);
  insert into public.conversations(user_id, contact_id, data)
  values (p_to, cid, jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,''))))
  on conflict (user_id, contact_id) do update
    set data = public.conversations.data
               || jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,'')));
  insert into public.messages(id, user_id, contact_id, t, data) values (mid, p_to, cid, t, d)
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true, 'id', mid);
end $$;
revoke execute on function public.chat_send_real_media(uuid,text,jsonb) from public, anon;
grant  execute on function public.chat_send_real_media(uuid,text,jsonb) to authenticated;

-- 2) the receiver may read ONLY the files that were sent to them (never anyone's other files)
drop policy if exists "media read sent to me" on storage.objects;
create policy "media read sent to me" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and exists (
    select 1 from public.messages m
    where m.user_id = auth.uid()
      and m.data->>'mediaOwner' = (storage.foldername(name))[1]
      and m.data->>'mediaId'    = storage.filename(name)));
