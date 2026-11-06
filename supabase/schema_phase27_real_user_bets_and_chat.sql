-- Veltrix phase 27: real-user-only challenges and two-way real-user/admin messaging.
-- Run AFTER schema_phase26_chat_profile_photos.sql in Supabase SQL Editor.
-- Safe to re-run. Does not alter wallet balances or existing bet records.

-- Keep profile photos available to chat clients when stored as data URLs.
create or replace function public.search_users(p_q text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q text := lower(btrim(coalesce(p_q,''))); r jsonb;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'session revoked'; end if;
  q := regexp_replace(q, '^@+', '');
  if length(q) < 3 then return '[]'::jsonb; end if;
  q := replace(replace(replace(q, '\\', ''), '%', ''), '_', '');
  select coalesce(jsonb_agg(x), '[]'::jsonb) into r from (
    select jsonb_build_object('id', id, 'name', coalesce(nullif(btrim(full_name),''),'Veltrix user'),
      'username', coalesce(profile_username,''),
      'photo', case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end) as x
    from public.profiles
    where id <> auth.uid() and not is_admin
      and (lower(full_name) like '%' || q || '%' or lower(coalesce(profile_username,'')) like '%' || replace(q,' ','') || '%')
    order by (lower(full_name) = q) desc, full_name limit 12
  ) s;
  return r;
end $$;

create or replace function public.get_profiles(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into r from (
    select jsonb_build_object('id', id, 'name', coalesce(nullif(btrim(full_name),''),'Veltrix user'),
      'username', coalesce(profile_username,''),
      'photo', case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end) as x
    from public.profiles where id = any(p_ids[1:50]) and id <> auth.uid() and not is_admin
  ) s;
  return r;
end $$;
revoke execute on function public.search_users(text), public.get_profiles(uuid[]) from public, anon;
grant execute on function public.search_users(text), public.get_profiles(uuid[]) to authenticated;

-- A normal account may message another real account OR the admin account.
-- Admin replies to a real account are also delivered into that account's real-<admin-id> conversation.
-- The authenticated caller is always the sender; clients cannot spoof another sender.
create or replace function public.chat_send_real(p_to uuid, p_id text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); nm text; cid text;
  t bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  txt text := left(coalesce(p_text,''), 4000);
  target_admin boolean; sender_admin boolean;
  mid text;
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
  select coalesce(nullif(btrim(full_name),''),'Veltrix user') into nm from public.profiles where id = me;
  cid := 'real-' || me::text;
  mid := 'rx-' || left(p_id, 40) || '-' || substr(md5(me::text), 1, 6);
  perform set_config('veltrix.real_chat', '1', true);
  insert into public.conversations(user_id, contact_id, data)
  values (p_to, cid, jsonb_build_object('name', nm))
  on conflict (user_id, contact_id) do update
    set data = jsonb_build_object('name', nm) || public.conversations.data;
  insert into public.messages(id, user_id, contact_id, t, data)
  values (mid, p_to, cid, t,
    jsonb_build_object('id', mid, 'from', 'them', 't', t, 'type', 'text', 'text', txt))
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true, 'id', mid);
end $$;
revoke execute on function public.chat_send_real(uuid,text,text) from public, anon;
grant execute on function public.chat_send_real(uuid,text,text) to authenticated;

-- Real-user-only betting. No fallback to the admin/demo opponent is permitted.
-- Both regular users and admins must explicitly target a real, non-admin profile.
create or replace function public.game_bet_create(
  p_contact text, p_persona text, p_mode text, p_symbol text, p_amount numeric,
  p_request uuid, p_peer uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); me_admin boolean; me_name text; peer uuid;
  sym text := upper(btrim(coalesce(p_symbol,'')));
  b public.game_bets%rowtype; mine boolean;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where request_id = p_request;
  if found then return jsonb_build_object('ok', true, 'id', b.id, 'replayed', true); end if;
  if coalesce(p_contact,'') = '' or p_contact = 'veltrix-support' then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if p_mode not in ('escrow','free') then return jsonb_build_object('ok', false, 'reason', 'bad_mode'); end if;
  if p_peer is null or p_peer = me or not exists (
    select 1 from public.profiles where id = p_peer and not is_admin
  ) then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
  select coalesce(is_admin,false), coalesce(nullif(btrim(full_name),''),'Veltrix user')
    into me_admin, me_name from public.profiles where id = me;
  peer := p_peer;
  if coalesce(me_admin,false) then
    -- Admin challenges must originate from a real user's chat, not a demo persona.
    if p_contact not like 'real-%' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  else
    -- Regular users can only challenge an explicitly selected real user.
    if p_contact not like 'real-%' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  end if;
  if exists (select 1 from public.game_bets where status in ('pending','active')
    and least(challenger_id,opponent_id) = least(me,peer)
    and greatest(challenger_id,opponent_id) = greatest(me,peer)) then
    return jsonb_build_object('ok', false, 'reason', 'already_open');
  end if;
  if p_mode = 'escrow' then
    if not public._supported_coin(sym) then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
    if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount, 8) or p_amount > 100000000000 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
    end if;
    mine := public._game_hold(me, sym, p_amount);
    if not mine then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  else
    sym := null; p_amount := 0; mine := false;
  end if;
  insert into public.game_bets(request_id, challenger_id, opponent_id, contact_id, persona_name,
    challenger_name, mode, symbol, amount, locked_c)
  values (p_request, me, peer, p_contact, left(coalesce(p_persona,''),60), left(me_name,60),
    p_mode, sym, p_amount, mine) returning * into b;
  return jsonb_build_object('ok', true, 'id', b.id);
end $$;
revoke execute on function public.game_bet_create(text,text,text,text,numeric,uuid,uuid) from public, anon;
grant execute on function public.game_bet_create(text,text,text,text,numeric,uuid,uuid) to authenticated;
