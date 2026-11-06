-- Veltrix · phase 24: find real users by name + chat with them (and bet against them)
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phase 23)
-- Real users never appear in the default list: they are only returned when a name/username is typed (3+ letters).
-- Admin accounts are never returned (people reach the admin through the demo contacts).

alter table public.game_bets add column if not exists challenger_name text not null default '';

-- 1) search ----------------------------------------------------------------------
create or replace function public.search_users(p_q text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q text := lower(btrim(coalesce(p_q,''))); r jsonb;
begin
  if auth.uid() is null or not public.session_ok() then raise exception 'session revoked'; end if;
  q := regexp_replace(q, '^@+', '');
  if length(q) < 3 then return '[]'::jsonb; end if;
  q := replace(replace(replace(q, '\', ''), '%', ''), '_', '');
  select coalesce(jsonb_agg(x), '[]'::jsonb) into r from (
    select jsonb_build_object('id', id, 'name', coalesce(nullif(btrim(full_name),''),'Veltrix user'),
             'username', coalesce(profile_username,''),
             'photo', case when length(coalesce(profile_image,'')) < 120000 then coalesce(profile_image,'') else '' end) as x
    from public.profiles
    where id <> auth.uid() and not is_admin
      and (lower(full_name) like '%' || q || '%' or lower(coalesce(profile_username,'')) like '%' || replace(q,' ','') || '%')
    order by (lower(full_name) = q) desc, full_name
    limit 12) s;
  return r;
end $$;

-- 2) deliver a text message to another real user ----------------------------------------
-- The sender's own copy is saved by the app as before; this writes the recipient's copy.
create or replace function public.guard_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if coalesce(current_setting('veltrix.real_chat', true), '') = '1' then return new; end if;   -- set only inside chat_send_real
  if tg_op = 'INSERT' and coalesce(new.data->>'from','') <> 'me' then
    raise exception 'users can only send their own messages';
  end if;
  if tg_op = 'UPDATE' and (new.data->>'from') is distinct from (old.data->>'from') then
    raise exception 'sender cannot be changed';
  end if;
  return new;
end $$;

create or replace function public.chat_send_real(p_to uuid, p_id text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); nm text; cid text; t bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; txt text := left(coalesce(p_text,''), 4000);
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  if p_to is null or p_to = me or btrim(txt) = '' or coalesce(p_id,'') = '' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if not exists (select 1 from public.profiles where id = p_to and not is_admin) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select coalesce(nullif(btrim(full_name),''),'Veltrix user') into nm from public.profiles where id = me;
  cid := 'real-' || me::text;
  perform set_config('veltrix.real_chat', '1', true);                                   -- this transaction only
  insert into public.conversations(user_id, contact_id, data) values (p_to, cid, jsonb_build_object('name', nm))
  on conflict (user_id, contact_id) do update set data = jsonb_build_object('name', nm) || public.conversations.data;
  insert into public.messages(id, user_id, contact_id, t, data)
  values ('rx-' || left(p_id, 40) || '-' || substr(md5(me::text), 1, 6), p_to, cid, t,
          jsonb_build_object('id', 'rx-' || left(p_id, 40) || '-' || substr(md5(me::text), 1, 6), 'from', 'them', 't', t, 'type', 'text', 'text', txt))
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- 3) bets: a normal user may now also bet against another real user (peer passed explicitly) ----------------
create or replace function public.game_bet_create(p_contact text, p_persona text, p_mode text, p_symbol text, p_amount numeric, p_request uuid, p_peer uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); me_admin boolean; me_name text; cname text; peer uuid; sym text := upper(btrim(coalesce(p_symbol,''))); b public.game_bets%rowtype; mine boolean;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where request_id = p_request;
  if found then return jsonb_build_object('ok', true, 'id', b.id, 'replayed', true); end if;

  if coalesce(p_contact,'') = '' or p_contact = 'veltrix-support' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if p_mode not in ('escrow','free') then return jsonb_build_object('ok', false, 'reason', 'bad_mode'); end if;
  select is_admin, coalesce(nullif(btrim(full_name),''),'Veltrix user') into me_admin, me_name from public.profiles where id = me;
  if coalesce(me_admin,false) then
    peer := p_peer;
    if peer is null or peer = me or not exists (select 1 from public.profiles where id = peer) then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
    if exists (select 1 from public.profiles where id = peer and is_admin) then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
    cname := left(coalesce(nullif(btrim(p_persona),''), me_name), 60);                 -- the user sees the demo contact the admin plays as
  else
    if p_peer is not null then                                                          -- a real user chatting with another real user
      if p_peer = me or not exists (select 1 from public.profiles where id = p_peer and not is_admin) then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
      peer := p_peer;
    else
      select id into peer from public.profiles where is_admin order by created_at limit 1;
    end if;
    if peer is null then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
    cname := left(me_name, 60);
  end if;
  if exists (select 1 from public.game_bets where status in ('pending','active') and least(challenger_id,opponent_id) = least(me,peer) and greatest(challenger_id,opponent_id) = greatest(me,peer)) then
    return jsonb_build_object('ok', false, 'reason', 'already_open');
  end if;

  if p_mode = 'escrow' then
    if not public._supported_coin(sym) then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
    if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount, 8) or p_amount > 100000000000 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
    mine := public._game_hold(me, sym, p_amount);
    if not mine then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  else sym := null; p_amount := 0; mine := false; end if;

  insert into public.game_bets(request_id, challenger_id, opponent_id, contact_id, persona_name, challenger_name, mode, symbol, amount, locked_c)
  values (p_request, me, peer, p_contact, left(coalesce(p_persona,''),60), cname, p_mode, sym, p_amount, mine) returning * into b;
  return jsonb_build_object('ok', true, 'id', b.id);
end $$;

revoke execute on function public.search_users(text), public.chat_send_real(uuid,text,text) from public, anon;
grant  execute on function public.search_users(text), public.chat_send_real(uuid,text,text) to authenticated;
