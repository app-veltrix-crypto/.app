-- Veltrix · phase 29: chat fixes + betting removed
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phase 28). Safe to run more than once.
--
-- PART 1 · CHAT
--   a) the admin's (and every other chat partner's) profile picture is available to the people they message
--   b) a message now carries its sender's name, @username and picture into the receiver's conversation
--   c) a user's app can safely re-save a message it already received (this used to be rejected by the database)
-- PART 2 · BETTING
--   Every open bet is cancelled and each player gets back exactly what they had locked, then all betting
--   functions are removed. The old bet records (table game_bets) are KEPT for your history.

-- ====================================================================== PART 1 · CHAT

-- a) profile lookup for the people you chat with: now also returns the admin account (name, @username, picture only)
create or replace function public.get_profiles(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into r from (
    select jsonb_build_object('id', id, 'name', coalesce(nullif(btrim(full_name),''),'Veltrix user'),
      'username', coalesce(profile_username,''),
      'photo', case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end) as x
    from public.profiles where id = any(p_ids[1:50]) and id <> auth.uid()
  ) s;
  return r;
end $$;
revoke execute on function public.get_profiles(uuid[]) from public, anon;
grant  execute on function public.get_profiles(uuid[]) to authenticated;

-- b) deliver a text message; the receiver's conversation also gets the sender's current name / @username / picture
create or replace function public.chat_send_real(p_to uuid, p_id text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); nm text; un text; ph text; cid text;
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
  select coalesce(nullif(btrim(full_name),''),'Veltrix user'),
         coalesce(profile_username,''),
         case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end
    into nm, un, ph from public.profiles where id = me;
  cid := 'real-' || me::text;
  mid := 'rx-' || left(p_id, 40) || '-' || substr(md5(me::text), 1, 6);
  perform set_config('veltrix.real_chat', '1', true);
  insert into public.conversations(user_id, contact_id, data)
  values (p_to, cid, jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,''))))
  on conflict (user_id, contact_id) do update
    set data = public.conversations.data
               || jsonb_strip_nulls(jsonb_build_object('name', nm, 'username', nullif(un,''), 'photo', nullif(ph,'')));
  insert into public.messages(id, user_id, contact_id, t, data)
  values (mid, p_to, cid, t,
    jsonb_build_object('id', mid, 'from', 'them', 't', t, 'type', 'text', 'text', txt))
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true, 'id', mid);
end $$;
revoke execute on function public.chat_send_real(uuid,text,text) from public, anon;
grant  execute on function public.chat_send_real(uuid,text,text) to authenticated;

-- c) the app saves with "upsert" (an INSERT that turns into an UPDATE when the row exists). The old guard rejected that
--    for received messages, which could make the receiving phone's saves fail. Re-saving a message that ALREADY exists
--    for this user (same id, same sender) is now allowed; brand-new messages "from them" are still refused.
create or replace function public.guard_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if coalesce(current_setting('veltrix.real_chat', true), '') = '1' then return new; end if;   -- set only inside chat_send_real
  if tg_op = 'INSERT' and coalesce(new.data->>'from','') <> 'me' then
    if exists (select 1 from public.messages m
               where m.id = new.id and m.user_id = new.user_id and (m.data->>'from') = (new.data->>'from')) then
      return new;
    end if;
    raise exception 'users can only send their own messages';
  end if;
  if tg_op = 'UPDATE' and (new.data->>'from') is distinct from (old.data->>'from') then
    raise exception 'sender cannot be changed';
  end if;
  return new;
end $$;

-- ====================================================================== PART 2 · REMOVE BETTING

-- cancel every open bet and give each player back exactly what they had locked (nothing is lost)
do $$
declare b public.game_bets%rowtype;
begin
  if to_regclass('public.game_bets') is not null and to_regprocedure('public._game_refund(public.game_bets)') is not null then
    for b in select * from public.game_bets where status in ('pending','active') for update loop
      perform public._game_refund(b);
      update public.game_bets set status = 'void', locked_c = false, locked_o = false where id = b.id;
    end loop;
  end if;
end $$;

-- remove the betting functions
drop function if exists public.game_bet_create(text,text,text,text,numeric,uuid,uuid);
drop function if exists public.game_bet_respond(uuid,boolean);
drop function if exists public.game_bet_withdraw(uuid);
drop function if exists public.game_bet_ready(uuid,int);
drop function if exists public.game_bet_sync(uuid);
drop function if exists public.game_bet_start(uuid);
drop function if exists public.game_bet_finish(uuid);
drop function if exists public.game_bet_sweep();
drop function if exists public._game_sweep();
drop function if exists public._game_note(uuid,text,text);
drop function if exists public._game_refund(public.game_bets);
drop function if exists public._game_pay(uuid,text,numeric);
drop function if exists public._game_hold(uuid,text,numeric);

-- check (should show 0 open bets and 0 still-locked stakes):
select count(*) filter (where status in ('pending','active')) as open_bets,
       count(*) filter (where locked_c or locked_o)           as still_locked
from public.game_bets;
