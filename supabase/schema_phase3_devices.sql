-- Veltrix · Linked devices (real sign-in sessions, remote log-out)
-- Run in the Supabase SQL Editor AFTER schema.sql and schema_phase2.sql

create table public.devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  session_id  uuid not null,                 -- the Supabase auth session this device is signed in with
  name        text not null,
  platform    text,
  icon        text default 'desktop',
  created_at  timestamptz not null default now(),
  last_active timestamptz not null default now(),
  unique (user_id, session_id)
);
alter table public.devices enable row level security;
create policy "own devices read" on public.devices for select using (auth.uid() = user_id);
create policy "own devices rename" on public.devices for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke update on public.devices from authenticated, anon;
grant  update (name) on public.devices to authenticated;
revoke insert, delete on public.devices from authenticated, anon;

alter table public.devices replica identity full;
alter publication supabase_realtime add table public.devices;

-- is the caller's current session still a registered, un-revoked device?
create or replace function public.session_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices
                  where user_id = auth.uid()
                    and session_id = nullif(auth.jwt()->>'session_id','')::uuid)
$$;
grant execute on function public.session_ok() to authenticated;

-- called on every sign-in / page load: records this device (or refreshes its "last active")
create or replace function public.register_device(p_name text, p_platform text, p_icon text)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare sid uuid := nullif(auth.jwt()->>'session_id','')::uuid; did uuid;
begin
  if auth.uid() is null or sid is null then return null; end if;
  -- forget devices whose session no longer exists (expired / signed out)
  delete from public.devices d where d.user_id = auth.uid()
     and not exists (select 1 from auth.sessions s where s.id = d.session_id);
  insert into public.devices(user_id, session_id, name, platform, icon)
  values (auth.uid(), sid, left(p_name,80), left(p_platform,40), case when p_icon='phone' then 'phone' else 'desktop' end)
  on conflict (user_id, session_id) do update set last_active = now()
  returning id into did;
  return did;
end $$;
grant execute on function public.register_device(text,text,text) to authenticated;

-- log a device out immediately: kills its session (refresh tokens go with it) and removes it from the list
create or replace function public.revoke_device(p_id uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
declare sid uuid;
begin
  select session_id into sid from public.devices where id = p_id and user_id = auth.uid();
  if sid is null then raise exception 'device not found'; end if;
  delete from auth.sessions where id = sid and user_id = auth.uid();
  delete from public.devices where id = p_id and user_id = auth.uid();
end $$;
grant execute on function public.revoke_device(uuid) to authenticated;
revoke execute on function public.register_device(text,text,text), public.revoke_device(uuid), public.session_ok() from anon, public;

-- money and PIN functions now refuse a revoked session straight away
create or replace function public.wallet_convert(p_symbol text, p_amount numeric, p_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  if p_amount <= 0 or p_usd < 0 then raise exception 'invalid amount'; end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
  update profiles set usd_balance = usd_balance + p_usd where id = auth.uid();
end $$;

create or replace function public.wallet_send(p_symbol text, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  if p_amount <= 0 then raise exception 'invalid amount'; end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
end $$;

create or replace function public.pin_verify(p text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare r user_security%rowtype;
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  select * into r from user_security where user_id = auth.uid();
  if not found or r.pin_hash is null then return false; end if;
  if r.locked_until is not null and r.locked_until > now() then return false; end if;
  if crypt(p, r.pin_hash) = r.pin_hash then
    update user_security set failed = 0, locked_until = null where user_id = auth.uid();
    return true;
  end if;
  update user_security set failed = failed + 1,
         locked_until = case when failed + 1 >= 5 then now() + interval '30 seconds' else null end,
         failed = case when failed + 1 >= 5 then 0 else failed + 1 end
   where user_id = auth.uid();
  return false;
end $$;
