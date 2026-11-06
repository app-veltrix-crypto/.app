-- Veltrix · phase 23: head-to-head "Race the clock" bets (real escrow or free play)
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phase 22)
-- Escrow rule: challenger's stake is locked when the bet is created, opponent's when they accept.
-- Money only moves inside these functions; the app can never write to game_bets directly.

create table if not exists public.game_bets (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid unique,
  game          text not null default 'race',
  challenger_id uuid not null references public.profiles(id) on delete cascade,
  opponent_id   uuid not null references public.profiles(id) on delete cascade,
  contact_id    text not null,                    -- the chat contact (demo persona) the bet was opened from
  persona_name  text not null default '',         -- display name of that persona
  mode          text not null check (mode in ('escrow','free')),
  symbol        text,
  amount        numeric(30,10) not null default 0 check (amount >= 0),
  locked_c      boolean not null default false,   -- challenger stake currently held
  locked_o      boolean not null default false,   -- opponent stake currently held
  status        text not null default 'pending' check (status in ('pending','active','finished','cancelled','expired','void')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '3 minutes',
  accepted_at   timestamptz,
  c_start timestamptz, c_finish timestamptz, c_ms int,
  o_start timestamptz, o_finish timestamptz, o_ms int,
  winner_id     uuid,
  check (challenger_id <> opponent_id)
);
create index if not exists game_bets_c on public.game_bets (challenger_id, created_at desc);
create index if not exists game_bets_o on public.game_bets (opponent_id, created_at desc);
alter table public.game_bets enable row level security;
drop policy if exists "bets read own" on public.game_bets;
create policy "bets read own" on public.game_bets for select using (auth.uid() in (challenger_id, opponent_id));
revoke insert, update, delete on public.game_bets from authenticated, anon;
do $$ begin alter publication supabase_realtime add table public.game_bets; exception when duplicate_object then null; end $$;

-- helpers --------------------------------------------------------------------
create or replace function public._game_hold(p_user uuid, p_sym text, p_amt numeric) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.assets set amount = amount - p_amt where user_id = p_user and symbol = p_sym and amount >= p_amt;
  if not found then return false; end if;
  delete from public.assets where user_id = p_user and symbol = p_sym and amount = 0;
  return true;
end $$;

create or replace function public._game_pay(p_user uuid, p_sym text, p_amt numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.assets(user_id, symbol, name, amount) values (p_user, p_sym, p_sym, p_amt)
  on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
end $$;

-- gives each side back what they locked
create or replace function public._game_refund(b public.game_bets) returns void
language plpgsql security definer set search_path = public as $$
begin
  if b.mode = 'escrow' then
    if b.locked_c then perform public._game_pay(b.challenger_id, b.symbol, b.amount); end if;
    if b.locked_o then perform public._game_pay(b.opponent_id,   b.symbol, b.amount); end if;
  end if;
end $$;

create or replace function public._game_note(p_uid uuid, p_title text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  begin perform public.push_notification(p_uid, 'deposit', p_title, p_body); exception when others then null; end;
end $$;

-- housekeeping: runs inside every call below, so stale bets always clean themselves up
create or replace function public._game_sweep() returns void
language plpgsql security definer set search_path = public as $$
declare b public.game_bets%rowtype;
begin
  for b in select * from public.game_bets where status = 'pending' and expires_at < now() for update skip locked loop
    perform public._game_refund(b);
    update public.game_bets set status = 'expired', locked_c = false, locked_o = false where id = b.id;
  end loop;
  -- accepted but the challenger never played: cancel and refund both
  for b in select * from public.game_bets where status = 'active' and c_finish is null and accepted_at < now() - interval '10 minutes' for update skip locked loop
    perform public._game_refund(b);
    update public.game_bets set status = 'void', locked_c = false, locked_o = false where id = b.id;
  end loop;
  -- challenger finished but the opponent never played: opponent forfeits
  for b in select * from public.game_bets where status = 'active' and c_finish is not null and o_finish is null and c_finish < now() - interval '10 minutes' for update skip locked loop
    if b.mode = 'escrow' then perform public._game_pay(b.challenger_id, b.symbol, b.amount * 2); end if;
    update public.game_bets set status = 'finished', winner_id = b.challenger_id, locked_c = false, locked_o = false where id = b.id;
  end loop;
end $$;

-- 1) challenger creates a bet ---------------------------------------------------
-- A normal user bets against the admin (who answers as the demo contact); the admin passes the user they are talking to.
-- The verified "Veltrix Support" chat can never be bet against.
create or replace function public.game_bet_create(p_contact text, p_persona text, p_mode text, p_symbol text, p_amount numeric, p_request uuid, p_peer uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); me_admin boolean; peer uuid; sym text := upper(btrim(coalesce(p_symbol,''))); b public.game_bets%rowtype; mine boolean;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where request_id = p_request;
  if found then return jsonb_build_object('ok', true, 'id', b.id, 'replayed', true); end if;

  if coalesce(p_contact,'') = '' or p_contact = 'veltrix-support' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if p_mode not in ('escrow','free') then return jsonb_build_object('ok', false, 'reason', 'bad_mode'); end if;
  select is_admin into me_admin from public.profiles where id = me;
  if coalesce(me_admin,false) then
    peer := p_peer;
    if peer is null or peer = me or not exists (select 1 from public.profiles where id = peer) then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
    if exists (select 1 from public.profiles where id = peer and is_admin) then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  else
    select id into peer from public.profiles where is_admin order by created_at limit 1;
    if peer is null then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
  end if;
  -- one open bet per pair at a time
  if exists (select 1 from public.game_bets where status in ('pending','active') and least(challenger_id,opponent_id) = least(me,peer) and greatest(challenger_id,opponent_id) = greatest(me,peer)) then
    return jsonb_build_object('ok', false, 'reason', 'already_open');
  end if;

  if p_mode = 'escrow' then
    if not public._supported_coin(sym) then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
    if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount, 8) or p_amount > 100000000000 then return jsonb_build_object('ok', false, 'reason', 'invalid_amount'); end if;
    mine := public._game_hold(me, sym, p_amount);
    if not mine then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  else sym := null; p_amount := 0; mine := false; end if;

  insert into public.game_bets(request_id, challenger_id, opponent_id, contact_id, persona_name, mode, symbol, amount, locked_c)
  values (p_request, me, peer, p_contact, left(coalesce(p_persona,''),60), p_mode, sym, p_amount, mine) returning * into b;
  return jsonb_build_object('ok', true, 'id', b.id);
end $$;

-- 2) opponent accepts or declines --------------------------------------------------
create or replace function public.game_bet_respond(p_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where id = p_id for update;
  if not found or b.opponent_id <> me then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if b.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'gone', 'status', b.status); end if;
  if p_accept then
    if b.mode = 'escrow' then
      if not public._game_hold(me, b.symbol, b.amount) then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
    end if;
    update public.game_bets set status = 'active', accepted_at = now(), locked_o = (b.mode = 'escrow') where id = b.id;
    return jsonb_build_object('ok', true, 'status', 'active');
  end if;
  perform public._game_refund(b);
  update public.game_bets set status = 'cancelled', locked_c = false, locked_o = false where id = b.id;
  return jsonb_build_object('ok', true, 'status', 'cancelled');
end $$;

-- challenger withdraws a bet that has not been accepted yet
create or replace function public.game_bet_withdraw(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select * into b from public.game_bets where id = p_id and challenger_id = me for update;
  if not found or b.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  perform public._game_refund(b);
  update public.game_bets set status = 'cancelled', locked_c = false, locked_o = false where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- 3) the race: the SERVER clock measures each run ----------------------------------
create or replace function public.game_bet_start(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where id = p_id and me in (challenger_id, opponent_id) for update;
  if not found or b.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  if me = b.challenger_id then
    if b.c_start is not null then return jsonb_build_object('ok', false, 'reason', 'already_played'); end if;
    update public.game_bets set c_start = now() where id = p_id;
  else
    if b.c_finish is null then return jsonb_build_object('ok', false, 'reason', 'wait'); end if;   -- challenger plays first
    if b.o_start is not null then return jsonb_build_object('ok', false, 'reason', 'already_played'); end if;
    update public.game_bets set o_start = now() where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.game_bet_finish(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype; ms int; pot numeric; w uuid; sym text;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select * into b from public.game_bets where id = p_id and me in (challenger_id, opponent_id) for update;
  if not found or b.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  if me = b.challenger_id then
    if b.c_start is null or b.c_finish is not null then return jsonb_build_object('ok', false, 'reason', 'bad_state'); end if;
    ms := greatest(4000, (extract(epoch from (now() - b.c_start)) * 1000)::int);     -- floor: a real run cannot be faster than 4 s
    update public.game_bets set c_finish = now(), c_ms = ms where id = p_id;
    return jsonb_build_object('ok', true, 'ms', ms, 'done', false);
  end if;
  if b.o_start is null or b.o_finish is not null then return jsonb_build_object('ok', false, 'reason', 'bad_state'); end if;
  ms := greatest(4000, (extract(epoch from (now() - b.o_start)) * 1000)::int);
  update public.game_bets set o_finish = now(), o_ms = ms where id = p_id;

  -- both have run: decide
  if b.c_ms = ms then                                         -- exact tie: everyone gets their stake back
    perform public._game_refund(b);
    update public.game_bets set status = 'void', locked_c = false, locked_o = false where id = p_id;
    return jsonb_build_object('ok', true, 'ms', ms, 'done', true, 'winner', null);
  end if;
  w := case when b.c_ms < ms then b.challenger_id else b.opponent_id end;
  pot := b.amount * 2; sym := b.symbol;
  if b.mode = 'escrow' then
    perform public._game_pay(w, sym, pot);                    -- straight into the winner's wallet for that coin
    perform public._game_note(w, 'You won the race', 'You won ' || trim(trailing '.' from trim(trailing '0' from to_char(pot, 'FM999999999999990.00000000'))) || ' ' || sym || '. It is in your wallet.');
  end if;
  update public.game_bets set status = 'finished', winner_id = w, locked_c = false, locked_o = false where id = p_id;
  return jsonb_build_object('ok', true, 'ms', ms, 'done', true, 'winner', w);
end $$;

-- lets the app clean up stale bets when it opens
create or replace function public.game_bet_sweep() returns void
language plpgsql security definer set search_path = public as $$
begin if auth.uid() is not null then perform public._game_sweep(); end if; end $$;

revoke execute on function public._game_hold(uuid,text,numeric), public._game_pay(uuid,text,numeric), public._game_refund(public.game_bets), public._game_note(uuid,text,text), public._game_sweep() from public, anon, authenticated;
revoke execute on function public.game_bet_create(text,text,text,text,numeric,uuid,uuid), public.game_bet_respond(uuid,boolean), public.game_bet_withdraw(uuid),
  public.game_bet_start(uuid), public.game_bet_finish(uuid), public.game_bet_sweep() from public, anon;
grant execute on function public.game_bet_create(text,text,text,text,numeric,uuid,uuid), public.game_bet_respond(uuid,boolean), public.game_bet_withdraw(uuid),
  public.game_bet_start(uuid), public.game_bet_finish(uuid), public.game_bet_sweep() to authenticated;
