-- Veltrix · phase 7: admin approval of crypto sends
-- Run in the Supabase SQL Editor AFTER schema_phase6_notifications_history.sql.
--
-- How it works
--   * A user's send is recorded as status 'pending' and the amount is held (taken from the balance straight away).
--   * The admin sees pending sends in the admin page and either APPROVES (status -> 'completed')
--     or CANCELS with a reason (status -> 'cancelled', the held amount is returned to the user's balance).
--   * Either way the user gets a notification, and their history status changes automatically.

alter table public.transactions add column if not exists cancel_reason text;
alter table public.transactions add column if not exists reviewed_at   timestamptz;
alter table public.transactions add column if not exists reviewed_by   uuid;
create index if not exists transactions_pending on public.transactions (created_at desc) where status = 'pending';

-- admins can read every transaction (for the approvals list)
drop policy if exists "admin read transactions" on public.transactions;
create policy "admin read transactions" on public.transactions for select using (public.is_admin());

-- live updates: the admin badge and the user's history/balance refresh by themselves
alter table public.transactions replica identity full;
do $$ begin alter publication supabase_realtime add table public.transactions; exception when duplicate_object then null; end $$;

-- wallet_send now records the send as PENDING (funds are held, not lost)
create or replace function public.wallet_send(p_symbol text, p_amount numeric, p_to text default null, p_net text default null, p_ref text default null, p_usd numeric default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.session_ok() then raise exception 'session revoked'; end if;
  if p_amount <= 0 then raise exception 'invalid amount'; end if;
  update assets set amount = amount - p_amount
   where user_id = auth.uid() and symbol = upper(p_symbol) and amount >= p_amount;
  if not found then raise exception 'insufficient balance'; end if;
  delete from assets where user_id = auth.uid() and amount = 0;
  insert into transactions(user_id, wallet, kind, symbol, amount, usd_value, to_address, network, reference, status)
  values (auth.uid(), 'crypto', 'send', upper(p_symbol), p_amount, p_usd, left(p_to,200), left(p_net,80), left(p_ref,100), 'pending');
end $$;
revoke execute on function public.wallet_send(text,numeric,text,text,text,numeric) from public, anon;
grant  execute on function public.wallet_send(text,numeric,text,text,text,numeric) to authenticated;

-- Admin decision. p_approve = true -> completed; false -> cancelled (a reason is required, and is sent to the user).
create or replace function public.admin_review_send(p_id uuid, p_approve boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t public.transactions%rowtype; why text; short text;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select * into t from public.transactions where id = p_id and kind = 'send' for update;
  if not found then raise exception 'transaction not found'; end if;
  if t.status <> 'pending' then raise exception 'already reviewed'; end if;
  short := left(coalesce(t.to_address,''), 10) || case when length(coalesce(t.to_address,'')) > 10 then '…' else '' end;
  if p_approve then
    update public.transactions set status = 'completed', reviewed_at = now(), reviewed_by = auth.uid() where id = p_id;
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal approved',
      'Your withdrawal of ' || trim(trailing '.' from trim(trailing '0' from t.amount::text)) || ' ' || t.symbol || ' to ' || short || ' was approved and is now successful.');
  else
    why := left(trim(coalesce(p_reason,'')), 300);
    if why = '' then raise exception 'reason required'; end if;
    update public.transactions set status = 'cancelled', cancel_reason = why, reviewed_at = now(), reviewed_by = auth.uid() where id = p_id;
    -- give the held amount back (demo "test balance" rows never touched the server wallet)
    if not t.test then
      insert into public.assets(user_id, symbol, amount) values (t.user_id, t.symbol, t.amount)
      on conflict (user_id, symbol) do update set amount = public.assets.amount + excluded.amount;
    end if;
    perform public.push_notification(t.user_id, 'withdrawal', 'Withdrawal cancelled',
      'Your withdrawal of ' || trim(trailing '.' from trim(trailing '0' from t.amount::text)) || ' ' || t.symbol || ' to ' || short || ' was cancelled. Reason: ' || why);
  end if;
end $$;
revoke execute on function public.admin_review_send(uuid,boolean,text) from public, anon;
grant  execute on function public.admin_review_send(uuid,boolean,text) to authenticated;
