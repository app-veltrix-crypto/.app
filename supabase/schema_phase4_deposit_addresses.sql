-- Veltrix · phase 4: deposit addresses (one per coin) shown on the users' Deposit screen.
-- Only ADDRESSES are stored here. The recovery phrase is never stored.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
create table if not exists public.deposit_addresses (
  symbol          text primary key,
  network         text not null,
  address         text not null,
  derivation_path text,
  updated_at      timestamptz not null default now()
);
alter table public.deposit_addresses enable row level security;
drop policy if exists "deposit addr read"        on public.deposit_addresses;
drop policy if exists "deposit addr admin write" on public.deposit_addresses;
create policy "deposit addr read"        on public.deposit_addresses for select to authenticated using (true);
create policy "deposit addr admin write" on public.deposit_addresses for all    to authenticated using (public.is_admin()) with check (public.is_admin());
