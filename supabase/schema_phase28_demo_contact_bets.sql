-- Veltrix phase 28: restore bets against admin-operated demo chat personas.
-- Run AFTER schema_phase27_real_user_bets_and_chat.sql.
-- Regular users may challenge (a) the admin through a demo persona, or (b) another real user.
-- The verified Veltrix Support profile is never challengeable. Admin replies/acceptance happen
-- from the admin page because the pending bet's opponent_id is the admin's own account UUID.

create or replace function public.game_bet_create(
  p_contact text, p_persona text, p_mode text, p_symbol text, p_amount numeric,
  p_request uuid, p_peer uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); me_admin boolean; me_name text; peer uuid;
  sym text := upper(btrim(coalesce(p_symbol,'')));
  b public.game_bets%rowtype; mine boolean; cname text;
begin
  if me is null or not public.session_ok() then raise exception 'session revoked'; end if;
  perform public._game_sweep();
  select * into b from public.game_bets where request_id = p_request;
  if found then return jsonb_build_object('ok', true, 'id', b.id, 'replayed', true); end if;

  if coalesce(p_contact,'') = '' or p_contact = 'veltrix-support' then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if p_mode not in ('escrow','free') then return jsonb_build_object('ok', false, 'reason', 'bad_mode'); end if;
  select coalesce(is_admin,false), coalesce(nullif(btrim(full_name),''),'Veltrix user')
    into me_admin, me_name from public.profiles where id = me;

  if coalesce(me_admin,false) then
    -- Admin can challenge a real user from that user's real chat, using the admin's own wallet.
    if p_contact not like 'real-%' or p_peer is null or p_peer = me
       or not exists (select 1 from public.profiles where id = p_peer and not is_admin) then
      return jsonb_build_object('ok', false, 'reason', 'no_opponent');
    end if;
    peer := p_peer;
    cname := left(coalesce(nullif(btrim(p_persona),''), me_name),60);
  else
    if p_peer is null then
      -- A demo persona is operated by the admin. Challenge the admin's real account,
      -- not a generated/demo profile and not the verified Support profile.
      if p_contact like 'real-%' then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
      select id into peer from public.profiles where coalesce(is_admin,false) order by created_at limit 1;
      cname := left(coalesce(nullif(btrim(p_persona),''),'Veltrix player'),60);
    else
      -- Explicit real-user challenge. Do not allow an admin or self as the opponent.
      if p_contact not like 'real-%' or p_peer = me
         or not exists (select 1 from public.profiles where id = p_peer and not is_admin) then
        return jsonb_build_object('ok', false, 'reason', 'no_opponent');
      end if;
      peer := p_peer;
      cname := left(me_name,60);
    end if;
    if peer is null then return jsonb_build_object('ok', false, 'reason', 'no_opponent'); end if;
  end if;

  if exists (
    select 1 from public.game_bets where status in ('pending','active')
      and least(challenger_id,opponent_id) = least(me,peer)
      and greatest(challenger_id,opponent_id) = greatest(me,peer)
  ) then return jsonb_build_object('ok', false, 'reason', 'already_open'); end if;

  if p_mode = 'escrow' then
    if not public._supported_coin(sym) then return jsonb_build_object('ok', false, 'reason', 'unsupported_coin'); end if;
    if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount,8) or p_amount > 100000000000 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
    end if;
    mine := public._game_hold(me,sym,p_amount);
    if not mine then return jsonb_build_object('ok', false, 'reason', 'insufficient'); end if;
  else
    sym := null; p_amount := 0; mine := false;
  end if;

  insert into public.game_bets(request_id,challenger_id,opponent_id,contact_id,persona_name,
    challenger_name,mode,symbol,amount,locked_c)
  values (p_request,me,peer,p_contact,left(coalesce(p_persona,''),60),left(cname,60),p_mode,sym,p_amount,mine)
  returning * into b;
  return jsonb_build_object('ok',true,'id',b.id);
end $$;

revoke execute on function public.game_bet_create(text,text,text,text,numeric,uuid,uuid) from public, anon;
grant execute on function public.game_bet_create(text,text,text,text,numeric,uuid,uuid) to authenticated;
