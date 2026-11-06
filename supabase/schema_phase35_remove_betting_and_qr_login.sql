-- Veltrix · phase 35: REMOVE the betting game and the "scan to log in" (QR link-login) feature from the database.
-- Run this whole file ONCE in: Supabase Dashboard → SQL Editor → New query → Run.  Safe to run again.
--
-- What it removes
--   A) BETTING / RACE GAME   table game_bets, every game_bet_* and _game_* function, the "You won the race" notifications
--   B) SCAN-TO-LOG-IN        table link_codes, create_link_code / consume_link_code / release_link_code / link_login /
--                            register_linked_device / leave_this_device / purge_expired_devices, the devices columns
--                            "linked" and "expires_at", and any device rows that were signed in by QR
--   C) OLD REMOVED FEATURES  wallet_convert (convert feature), wallet_reveal (replaced by wallet_my_phrase),
--                            admin_review_send (admin send-approval, removed in phase 15)
--
-- What it does NOT touch (all still used by the app): profiles, assets, wallets, deposits, withdrawals/payouts, send to users,
-- chat + media, disappearing messages, notifications, watchlist, transactions (history is kept), devices (the normal
-- "Linked devices" list and remote log-out), PIN, test wallets, app_flags / app_settings.
--
-- Money safety: before the betting table is dropped, any stake still locked in an open bet is paid back to its owner.

-- ============================================================ A) BETTING
do $$
declare b record;
begin
  if to_regclass('public.game_bets') is not null then
    for b in select * from public.game_bets where status in ('pending','active') and mode = 'escrow' and (locked_c or locked_o) loop
      if b.locked_c then
        insert into public.assets(user_id, symbol, name, amount) values (b.challenger_id, b.symbol, b.symbol, b.amount)
        on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
      end if;
      if b.locked_o then
        insert into public.assets(user_id, symbol, name, amount) values (b.opponent_id, b.symbol, b.symbol, b.amount)
        on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
      end if;
    end loop;
  end if;
end $$;

-- every betting function (all versions / argument lists) -- they must go BEFORE the table
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (left(p.proname, 9) = 'game_bet_' or left(p.proname, 6) = '_game_')
  loop
    execute 'drop function if exists ' || r.sig;
  end loop;
end $$;

drop table if exists public.game_bets cascade;
delete from public.notifications where title = 'You won the race';

-- ============================================================ B) SCAN-TO-LOG-IN
-- B1. the two everyday device functions must stop depending on the QR columns/functions FIRST
create or replace function public.session_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices
                  where user_id = auth.uid()
                    and session_id = nullif(auth.jwt()->>'session_id','')::uuid)
$$;
grant execute on function public.session_ok() to authenticated;

create or replace function public.register_device(p_key text, p_name text, p_platform text, p_icon text)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare
  sid uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  k   text := left(coalesce(nullif(p_key,''),'unknown'),64);
  old_sid uuid; did uuid;
begin
  if auth.uid() is null or sid is null then return null; end if;
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

-- B2. sign out and forget every device that was signed in by QR
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='devices' and column_name='linked') then
    delete from auth.sessions where id in (select session_id from public.devices where linked = true);
    delete from public.devices where linked = true;
  end if;
end $$;

-- B3. QR functions, table and columns
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('create_link_code','consume_link_code','release_link_code','link_login',
                                'register_linked_device','leave_this_device','purge_expired_devices')
  loop
    execute 'drop function if exists ' || r.sig;
  end loop;
end $$;

drop table if exists public.link_codes cascade;
alter table public.devices drop column if exists linked;
alter table public.devices drop column if exists expires_at;

-- ============================================================ C) OTHER FEATURES YOU ADDED AND LATER REMOVED
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('wallet_convert','wallet_reveal','admin_review_send')
  loop
    execute 'drop function if exists ' || r.sig;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ============================================================ CHECK (every row should say true / 0)
select 'betting table gone'            as test, to_regclass('public.game_bets') is null as ok
union all select 'qr link_codes table gone',    to_regclass('public.link_codes') is null
union all select 'no game functions left',      not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (left(p.proname,9)='game_bet_' or left(p.proname,6)='_game_'))
union all select 'session_ok still exists',     to_regprocedure('public.session_ok()') is not null
union all select 'register_device still exists',to_regprocedure('public.register_device(text,text,text,text)') is not null
union all select 'revoke_device still exists',  to_regprocedure('public.revoke_device(uuid)') is not null
union all select 'wallet_send still exists',    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='wallet_send')
union all select 'chat_send_real still exists', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='chat_send_real');
