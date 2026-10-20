-- Veltrix · Supabase schema, phase 2: chats, media, settings, PIN, admin
-- Run AFTER schema.sql, in: Supabase Dashboard → SQL Editor → New query → Run

create extension if not exists pgcrypto with schema extensions;

-- ---------- admin helper ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;
grant execute on function public.is_admin() to authenticated;

-- admins can read every profile (for the admin inbox user list)
create policy "admin read profiles" on public.profiles for select using (public.is_admin());

-- ---------- per-user settings (theme, language, notifications, devices, account mode …) ----------
create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  data    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy "own settings select" on public.user_settings for select using (auth.uid() = user_id);
create policy "own settings insert" on public.user_settings for insert with check (auth.uid() = user_id);
create policy "own settings update" on public.user_settings for update using (auth.uid() = user_id);

-- ---------- two-step verification PIN (hashed with bcrypt, checked on the server) ----------
create table public.user_security (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  pin_hash     text,
  failed       int not null default 0,
  locked_until timestamptz
);
alter table public.user_security enable row level security;   -- no policies: clients can never read it

create function public.pin_set(p text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p !~ '^[0-9]{4}$' then raise exception 'PIN must be 4 digits'; end if;
  insert into user_security(user_id, pin_hash, failed, locked_until)
  values (auth.uid(), crypt(p, gen_salt('bf')), 0, null)
  on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed = 0, locked_until = null;
end $$;

create function public.pin_verify(p text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare r user_security%rowtype;
begin
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

create function public.pin_clear(p text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.pin_verify(p) then return false; end if;
  update user_security set pin_hash = null where user_id = auth.uid();
  return true;
end $$;

revoke all on function public.pin_set(text), public.pin_verify(text), public.pin_clear(text) from public, anon;
grant execute on function public.pin_set(text), public.pin_verify(text), public.pin_clear(text) to authenticated;

-- ---------- chats ----------
create table public.conversations (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  contact_id text not null,
  data       jsonb not null default '{}'::jsonb,      -- name, read markers …
  primary key (user_id, contact_id)
);
create table public.messages (
  id         text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  contact_id text not null,
  t          bigint not null,
  data       jsonb not null,                           -- the whole message object
  foreign key (user_id, contact_id) references public.conversations(user_id, contact_id) on delete cascade
);
create index messages_conv_idx on public.messages (user_id, contact_id, t);

alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

create policy "conv own all"    on public.conversations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "conv admin all"  on public.conversations for all using (public.is_admin()) with check (public.is_admin());
create policy "msg own select"  on public.messages for select using (auth.uid() = user_id);
create policy "msg own insert"  on public.messages for insert with check (auth.uid() = user_id);
create policy "msg own update"  on public.messages for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "msg own delete"  on public.messages for delete using (auth.uid() = user_id);
create policy "msg admin all"   on public.messages for all using (public.is_admin()) with check (public.is_admin());

-- a normal user can only send messages as themselves ("me"); only admins can write support replies ("them")
create function public.guard_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if tg_op = 'INSERT' and coalesce(new.data->>'from','') <> 'me' then
    raise exception 'users can only send their own messages';
  end if;
  if tg_op = 'UPDATE' and (new.data->>'from') is distinct from (old.data->>'from') then
    raise exception 'sender cannot be changed';
  end if;
  return new;
end $$;
create trigger guard_message_trg before insert or update on public.messages
  for each row execute function public.guard_message();

-- live delivery
alter table public.messages      replica identity full;
alter table public.conversations replica identity full;
alter publication supabase_realtime add table public.messages, public.conversations;

-- ---------- chat media (voice notes, photos, videos, files) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-media', 'chat-media', false, 52428800)       -- 50 MB (raise on a paid plan)
on conflict (id) do nothing;

create policy "media read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'chat-media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "media upload own or admin" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "media update own or admin" on storage.objects for update to authenticated
  using (bucket_id = 'chat-media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "media delete own or admin" on storage.objects for delete to authenticated
  using (bucket_id = 'chat-media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ---------- make yourself an admin (replace the email, run once) ----------
-- update public.profiles set is_admin = true where email = 'you@example.com';
