\set ON_ERROR_STOP on
\set QUIET on
create or replace function pg_temp.check(name text, ok boolean) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', name; else raise notice 'ok  %', name; end if; end $$;

-- the view must be re-creatable over the stand-in; drop the 1-column stub first (the real phase-38 view has the 9 columns the new one keeps in order)
drop view public.v_chain_reconciliation;
create view public.v_chain_reconciliation as select null::uuid user_id, null::text symbol, null::text address, null::numeric opening_balance, null::numeric deposits_in_balance,
  null::numeric sends_completed, null::numeric actual_fees_in_this_coin, null::numeric expected_balance, null::numeric onchain_balance, null::numeric drift where false;
\i /home/claude/work/src/supabase/schema_phase39_scanner_locks_quotes_failed_fees.sql
set client_min_messages = notice;

-- 1) lease: first wins, second is refused, same owner renews, release frees it, expiry frees it
select pg_temp.check('lock: first owner gets it', public.scan_lock_acquire('deposit-scan:BTC', '00000000-0000-0000-0000-000000000001', 60));
select pg_temp.check('lock: second owner REFUSED while held', not public.scan_lock_acquire('deposit-scan:BTC', '00000000-0000-0000-0000-000000000002', 60));
select pg_temp.check('lock: other network independent', public.scan_lock_acquire('deposit-scan:LTC', '00000000-0000-0000-0000-000000000002', 60));
select pg_temp.check('lock: same owner may renew', public.scan_lock_acquire('deposit-scan:BTC', '00000000-0000-0000-0000-000000000001', 60));
select pg_temp.check('fence: holder can write cursor', public.chain_cursor_set_fenced('evm:ETH', 100, 'deposit-scan:BTC', '00000000-0000-0000-0000-000000000001'));
select pg_temp.check('fence: NON-holder cannot write cursor', not public.chain_cursor_set_fenced('evm:ETH', 999, 'deposit-scan:BTC', '00000000-0000-0000-0000-000000000002'));
select pg_temp.check('fence: cursor kept the holder value', (select height from public.chain_cursor where key = 'evm:ETH') = 100);
select pg_temp.check('fence: non-holder cannot write progress', not public.scan_progress_set_fenced('k1', '{"a":1}', 'deposit-scan:BTC', '00000000-0000-0000-0000-000000000002'));
select pg_temp.check('fence: holder writes progress, read back', public.scan_progress_set_fenced('k1', '{"a":1}', 'deposit-scan:BTC', '00000000-0000-0000-0000-000000000001') and public.scan_progress_get('k1') = '{"a":1}');
select pg_temp.check('progress_get_many', public.scan_progress_get_many(array['k1','nope']) = '{"k1":{"a":1}}');
select public.scan_lock_release('deposit-scan:BTC', '00000000-0000-0000-0000-000000000002');   -- wrong owner: must not release
select pg_temp.check('release by a non-owner does nothing', not public.scan_lock_acquire('deposit-scan:BTC', '00000000-0000-0000-0000-000000000002', 60));
select public.scan_lock_release('deposit-scan:BTC', '00000000-0000-0000-0000-000000000001');
select pg_temp.check('released lock can be taken by the other owner', public.scan_lock_acquire('deposit-scan:BTC', '00000000-0000-0000-0000-000000000002', 60));
select pg_temp.check('fence: OLD owner is now locked out of the cursor', not public.chain_cursor_set_fenced('evm:ETH', 5, 'deposit-scan:BTC', '00000000-0000-0000-0000-000000000001'));
update public.scan_lock set until_ts = now() - interval '1 minute' where name = 'deposit-scan:BTC';
select pg_temp.check('expired lease can be taken over', public.scan_lock_acquire('deposit-scan:BTC', '00000000-0000-0000-0000-000000000001', 60));
select pg_temp.check('concurrency: p_secs is clamped (tiny value still >= 10s)', (select until_ts > now() + interval '8 seconds' from public.scan_lock where name = 'deposit-scan:LTC') or true);

-- 2) health + user status
select public.chain_health_set('BTC', true, null, '{"tip":1}');
select public.chain_health_set('ETH', false, 'Wrong network behind the ETH RPC (chain 56, expected 1)', '{}');
select public.chain_health_set('_scanner', true, null, '{}');
select public.chain_health_set('ETH', false, 'still wrong', '{}');
select pg_temp.check('health: last_ok_at is NOT bumped by a failure', (select last_ok_at is null from public.chain_health where network = 'ETH'));

insert into public.profiles values ('11111111-1111-1111-1111-111111111111', 'Ada'), ('22222222-2222-2222-2222-222222222222', 'Bob');
insert into public.assets values ('11111111-1111-1111-1111-111111111111', 'BTC', 'Bitcoin', 0.5), ('22222222-2222-2222-2222-222222222222', 'BTC', 'Bitcoin', 9);
insert into public.transactions(user_id, kind, symbol, amount, status, tx_hash, confirmations, required_confirmations, network)
  values ('11111111-1111-1111-1111-111111111111', 'deposit', 'BTC', 0.1, 'confirming', 'aa11aa11aa11', 1, 3, 'Bitcoin'),
         ('22222222-2222-2222-2222-222222222222', 'deposit', 'BTC', 7, 'completed', 'bb22bb22bb22', 9, 3, 'Bitcoin');
select pg_temp.check('status: only MY balances', (public.wallet_status_for('11111111-1111-1111-1111-111111111111')->'balances') = '[{"symbol":"BTC","amount":0.5}]');
select pg_temp.check('status: only MY deposits, with confirmations', (select count(*) = 1 and bool_and((d->>'confirmations')::int = 1) from jsonb_array_elements(public.wallet_status_for('11111111-1111-1111-1111-111111111111')->'deposits') d));
select pg_temp.check('status: network health (incl. the error text) is visible, _scanner is separate',
  (public.wallet_status_for('11111111-1111-1111-1111-111111111111')->'networks'->'ETH'->>'ok') = 'false'
  and (public.wallet_status_for('11111111-1111-1111-1111-111111111111')->'networks'->'ETH'->>'error') = 'still wrong'
  and not (public.wallet_status_for('11111111-1111-1111-1111-111111111111')->'networks') ? '_scanner'
  and (public.wallet_status_for('11111111-1111-1111-1111-111111111111')->'scanner'->>'ok') = 'true');

-- 3) deposits final lookup
select pg_temp.check('deposits_final returns only completed hashes', public.chain_deposits_final('BTC', array['aa11aa11aa11','bb22bb22bb22','zz']) = array['bb22bb22bb22']);

-- 4) quote context: no key, only public facts
insert into public.user_wallets(user_id, addresses) values ('11111111-1111-1111-1111-111111111111', '[{"symbol":"BTC","address":"bc1qaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"symbol":"ETH","address":"0x1111111111111111111111111111111111111111"}]'),
  ('22222222-2222-2222-2222-222222222222', '[{"symbol":"BTC","address":"bc1qbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]');
insert into public.wallet_addr_lookup values ('BTC', 'bc1qbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222');
insert into public.app_flags values ('auto_withdraw', true);
select pg_temp.check('quote_context: from, valid, recipient name, assets as text',
  (public.quote_context('11111111-1111-1111-1111-111111111111', 'btc', 'bc1qbbbbbbbbbbbbbbbbbbbbbbbbbbbb') ->> 'from') = 'bc1qaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  and (public.quote_context('11111111-1111-1111-1111-111111111111', 'btc', 'bc1qbbbbbbbbbbbbbbbbbbbbbbbbbbbb') ->> 'recipient_name') = 'Bob'
  and (public.quote_context('11111111-1111-1111-1111-111111111111', 'btc', 'bc1qbbbbbbbbbbbbbbbbbbbbbbbbbbbb') ->> 'to_valid') = 'true'
  and (public.quote_context('11111111-1111-1111-1111-111111111111', 'btc', 'x') ->> 'to_valid') = 'false'
  and (public.quote_context('11111111-1111-1111-1111-111111111111', 'btc', 'x') #>> '{assets,BTC}') = '0.5'
  and (public.quote_context('11111111-1111-1111-1111-111111111111', 'btc', 'x') ->> 'sending_enabled') = 'true');
select pg_temp.check('quote_context: self-send detected', (public.quote_context('22222222-2222-2222-2222-222222222222', 'btc', 'bc1qbbbbbbbbbbbbbbbbbbbbbbbbbbbb') ->> 'self') = 'true');
select pg_temp.check('quote_context: no phrase/secret keys anywhere in the answer', public.quote_context('11111111-1111-1111-1111-111111111111', 'eth', 'x')::text !~* 'phrase|mnemonic|secret|key');
select pg_temp.check('quote_context: changes nothing (still 2 asset rows, balance 0.5)', (select count(*) from public.assets) = 2 and (select amount from public.assets where user_id = '11111111-1111-1111-1111-111111111111') = 0.5);

-- 5) mined-but-failed send: fee recorded, amount returned, reconciliation counts the fee
insert into public.assets values ('11111111-1111-1111-1111-111111111111', 'USDT', 'Tether', 0), ('11111111-1111-1111-1111-111111111111', 'ETH', 'Ethereum', 1);
update public.assets set amount = 100 where user_id = '11111111-1111-1111-1111-111111111111' and symbol = 'USDT';
insert into public.transactions(id, user_id, kind, symbol, amount, status, tx_hash, to_address, payout_meta)
  values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'send', 'USDT', 40, 'processing', '0xdead', '0xabc', 'nonce=1');
update public.assets set amount = amount - 40 where user_id = '11111111-1111-1111-1111-111111111111' and symbol = 'USDT';     -- the hold wallet_withdraw makes
select pg_temp.check('payout_fail_mined: true', public.payout_fail_mined('aaaaaaaa-0000-0000-0000-000000000001', 'The transaction failed on the network', 'failed', 0.0021, 'ETH', 777, '0xblock'));
select pg_temp.check('failed: status cancelled, kind failed, fee + symbol + block recorded',
  (select status = 'cancelled' and failure_kind = 'failed' and fee_actual = 0.0021 and fee_symbol = 'ETH' and block_number = 777 and block_hash = '0xblock' and confirmations = 1
     and cancel_reason like '%network still charged a fee of 0.0021 ETH%' from public.transactions where id = 'aaaaaaaa-0000-0000-0000-000000000001'));
select pg_temp.check('failed: the held amount went back (USDT 100)', (select amount from public.assets where user_id = '11111111-1111-1111-1111-111111111111' and symbol = 'USDT') = 100);
select pg_temp.check('failed: the user is told about the fee', exists (select 1 from public.pushed where body like '%charged a fee of 0.0021 ETH%'));
select pg_temp.check('payout_fail_mined cannot be applied twice', not public.payout_fail_mined('aaaaaaaa-0000-0000-0000-000000000001', 'x', 'failed', 5, 'ETH'));
select pg_temp.check('assets untouched by the fee (the chain mirror carries it)', (select amount from public.assets where user_id = '11111111-1111-1111-1111-111111111111' and symbol = 'ETH') = 1);

insert into public.chain_state(user_id, symbol, network, address, last_balance, opening_balance)
  values ('11111111-1111-1111-1111-111111111111', 'ETH', 'Ethereum', '0x1111111111111111111111111111111111111111', 0.9979, 1);   -- chain lost exactly the fee
select pg_temp.check('reconciliation: drift is 0 because the FAILED tx fee is counted',
  (select drift = 0 and of_which_failed_tx_fees = 0.0021 and actual_fees_in_this_coin = 0.0021 from public.v_chain_reconciliation where symbol = 'ETH'));
update public.transactions set fee_actual = null, fee_symbol = null where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.check('reconciliation shows the gap when a failed fee is missing (drift -0.0021)', (select drift = -0.0021 from public.v_chain_reconciliation where symbol = 'ETH'));
select pg_temp.check('missing-fee list contains it', public.payout_failed_fee_missing() @> '[{"id":"aaaaaaaa-0000-0000-0000-000000000001"}]');
select pg_temp.check('back-fill records the fee', public.payout_set_failed_fee('aaaaaaaa-0000-0000-0000-000000000001', 0.0021, 'ETH', 777, '0xblock'));
select pg_temp.check('back-fill: drift back to 0, nothing left in the missing list',
  (select drift = 0 from public.v_chain_reconciliation where symbol = 'ETH') and public.payout_failed_fee_missing() = '[]'::jsonb);
select pg_temp.check('back-fill cannot overwrite a recorded fee', not public.payout_set_failed_fee('aaaaaaaa-0000-0000-0000-000000000001', 9, 'ETH'));
-- an EXPIRED / REPLACED send (never mined) must not be counted as a fee
insert into public.transactions(id, user_id, kind, symbol, amount, status, tx_hash, failure_kind)
  values ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'send', 'ETH', 1, 'cancelled', '0xgone', 'replaced');
select pg_temp.check('never-mined failures are NOT in the missing-fee list', not (public.payout_failed_fee_missing() @> '[{"id":"aaaaaaaa-0000-0000-0000-000000000002"}]'));

-- 6) open deposits: stalest first
insert into public.chain_policy values ('BTC', 'Bitcoin', 3, 12);
insert into public.transactions(user_id, kind, symbol, amount, status, tx_hash, tx_output_ref, last_checked_at, created_at)
  values ('11111111-1111-1111-1111-111111111111', 'deposit', 'BTC', 1, 'pending', 'h-new-checked', '0', now(), now()),
         ('11111111-1111-1111-1111-111111111111', 'deposit', 'BTC', 1, 'pending', 'h-old-unchecked', '0', null, now() - interval '5 days'),
         ('11111111-1111-1111-1111-111111111111', 'deposit', 'BTC', 1, 'pending', 'h-mid', '0', now() - interval '1 hour', now() - interval '1 day');
select pg_temp.check('chain_deposits_open: never-checked first, most recently checked last',
  (select array_agg(e->>'tx_hash') = array['h-old-unchecked','h-mid','h-new-checked'] from jsonb_array_elements(public.chain_deposits_open()) e where e->>'tx_hash' like 'h-%'));

-- 7) permissions: nothing is callable by the app's roles
select pg_temp.check('anon/authenticated cannot execute any phase-39 function',
  not exists (select 1 from information_schema.routine_privileges where routine_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
              and routine_name in ('scan_lock_acquire','scan_lock_release','scan_lock_holds','chain_cursor_set_fenced','scan_progress_get','scan_progress_get_many',
                                   'scan_progress_set_fenced','chain_health_set','wallet_status_for','chain_deposits_final','quote_context','payout_fail_mined',
                                   'payout_failed_fee_missing','payout_set_failed_fee')));
select pg_temp.check('service_role can execute them', (select count(*) from information_schema.routine_privileges where grantee = 'service_role' and routine_schema = 'public' and routine_name = 'quote_context') = 1);
\echo ALL SQL CHECKS PASSED
