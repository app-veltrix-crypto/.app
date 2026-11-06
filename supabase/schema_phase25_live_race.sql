-- Veltrix · phase 25: LIVE head-to-head race (both cars on the same screen at the same time)
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phase 23/24)
-- What changes: each player picks one of 5 cars and presses Continue ("ready"). When BOTH are ready the server sets one shared GO time
-- (7 s ahead). Both phones count down to that moment, race together, and each finish is timed from the shared GO time by the SERVER clock.
-- Money rules are unchanged: escrow on create/accept, winner = fastest time, tie = refund.

alter table public.game_bets add column if not exists c_car smallint;
alter table public.game_bets add column if not exists o_car smallint;
alter table public.game_bets add column if not exists go_at timestamptz;

-- housekeeping (replaces the phase 23 version; the old "challenger plays first" rules are gone)
create or replace function public._game_sweep() returns void
language plpgsql security definer set search_path = public as $$
declare b public.game_bets%rowtype;
begin
  for b in select * from public.game_bets where status = 'pending' and expires_at < now() for update skip locked loop
    perform public._game_refund(b);
    update public.game_bets set status = 'expired', locked_c = false, locked_o = false where id = b.id;
  end loop;
  -- accepted but the two players never both got ready (or never raced): cancel and refund both
  for b in select * from public.game_bets where status = 'active' and c_finish is null and o_finish is null
           and ((go_at is null and accepted_at < now() - interval '10 minutes') or (go_at is not null and go_at < now() - interval '10 minutes')) for update skip locked loop
    perform public._game_refund(b);
    update public.game_bets set status = 'void', locked_c = false, locked_o = false where id = b.id;
  end loop;
  -- one finished, the other never did (3 min after the first finish): the finisher wins
  for b in select * from public.game_bets where status = 'active' and ((c_finish is not null) <> (o_finish is not null))
           and coalesce(c_finish, o_finish) < now() - interval '3 minutes' for update skip locked loop
    if b.mode = 'escrow' then perform public._game_pay(case when b.c_finish is not null then b.challenger_id else b.opponent_id end, b.symbol, b.amount * 2); end if;
    update public.game_bets set status = 'finished', winner_id = case when b.c_finish is not null then b.challenger_id else b.opponent_id end, locked_c = false, locked_o = false where id = b.id;
  end loop;
end $$;

-- a player picked a car and is ready; the second "ready" sets the shared GO time
create or replace function public.game_bet_ready(p_id uuid, p_car int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where id = p_id and me in (challenger_id, opponent_id) for update;
  if not found or b.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  if p_car is null or p_car < 0 or p_car > 4 then return jsonb_build_object('ok', false, 'reason', 'bad_car'); end if;
  if me = b.challenger_id then
    if b.c_car is null then update public.game_bets set c_car = p_car where id = p_id; end if;
  else
    if b.o_car is null then update public.game_bets set o_car = p_car where id = p_id; end if;
  end if;
  select * into b from public.game_bets where id = p_id;
  if b.c_car is not null and b.o_car is not null and b.go_at is null then
    update public.game_bets set go_at = now() + interval '7 seconds' where id = p_id returning * into b;
  end if;
  return jsonb_build_object('ok', true, 'go_at', b.go_at);
end $$;

-- the phone asks for the server clock + the shared GO time, so both countdowns line up
create or replace function public.game_bet_sync(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select * into b from public.game_bets where id = p_id and me in (challenger_id, opponent_id);
  if not found or b.status <> 'active' or b.go_at is null then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  return jsonb_build_object('ok', true, 'now', now(), 'go_at', b.go_at);
end $$;

-- marks that this player's run has begun (the time itself is measured from the shared GO time)
create or replace function public.game_bet_start(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where id = p_id and me in (challenger_id, opponent_id) for update;
  if not found or b.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  if b.go_at is null then return jsonb_build_object('ok', false, 'reason', 'wait'); end if;
  if me = b.challenger_id then
    if b.c_start is null then update public.game_bets set c_start = now() where id = p_id; end if;
  else
    if b.o_start is null then update public.game_bets set o_start = now() where id = p_id; end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- finish: time = server now() minus the shared GO time. When both have finished, the faster one wins.
create or replace function public.game_bet_finish(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b public.game_bets%rowtype; ms int; pot numeric; w uuid; sym text;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  select * into b from public.game_bets where id = p_id and me in (challenger_id, opponent_id) for update;
  if not found or b.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  if b.go_at is null then return jsonb_build_object('ok', false, 'reason', 'bad_state'); end if;
  ms := greatest(4000, (extract(epoch from (now() - b.go_at)) * 1000)::int);        -- floor: a real run cannot be faster than 4 s
  if me = b.challenger_id then
    if b.c_start is null or b.c_finish is not null then return jsonb_build_object('ok', false, 'reason', 'bad_state'); end if;
    update public.game_bets set c_finish = now(), c_ms = ms where id = p_id;
  else
    if b.o_start is null or b.o_finish is not null then return jsonb_build_object('ok', false, 'reason', 'bad_state'); end if;
    update public.game_bets set o_finish = now(), o_ms = ms where id = p_id;
  end if;
  select * into b from public.game_bets where id = p_id;
  if b.c_finish is null or b.o_finish is null then return jsonb_build_object('ok', true, 'ms', ms, 'done', false); end if;

  if b.c_ms = b.o_ms then                                                            -- exact tie: everyone gets their stake back
    perform public._game_refund(b);
    update public.game_bets set status = 'void', locked_c = false, locked_o = false where id = p_id;
    return jsonb_build_object('ok', true, 'ms', ms, 'done', true, 'winner', null);
  end if;
  w := case when b.c_ms < b.o_ms then b.challenger_id else b.opponent_id end;
  pot := b.amount * 2; sym := b.symbol;
  if b.mode = 'escrow' then
    perform public._game_pay(w, sym, pot);
    perform public._game_note(w, 'You won the race', 'You won ' || trim(trailing '.' from trim(trailing '0' from to_char(pot, 'FM999999999999990.00000000'))) || ' ' || sym || '. It is in your wallet.');
  end if;
  update public.game_bets set status = 'finished', winner_id = w, locked_c = false, locked_o = false where id = p_id;
  return jsonb_build_object('ok', true, 'ms', ms, 'done', true, 'winner', w);
end $$;

revoke execute on function public._game_sweep() from public, anon, authenticated;
revoke execute on function public.game_bet_ready(uuid,int), public.game_bet_sync(uuid), public.game_bet_start(uuid), public.game_bet_finish(uuid) from public, anon;
grant execute on function public.game_bet_ready(uuid,int), public.game_bet_sync(uuid), public.game_bet_start(uuid), public.game_bet_finish(uuid) to authenticated;
