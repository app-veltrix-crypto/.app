-- =====================================================================================================================
-- VELTRIX · BACKEND SELF-TEST  v1
-- Paste this WHOLE file into Supabase -> SQL Editor -> Run (one run). Read the result grid from the top.
--
-- HOW IT IS BUILT TO BE SAFE
--   * Part 1 (sections A, B, I) only READS: structure, permissions, live data.
--   * Part 2 (sections C to H) creates 3 fake users (@veltrix-selftest.invalid) and runs the real functions as those users
--     (wallet import, PIN, withdrawals, deposits, confirmations, fees, failures, refunds).
--     EVERYTHING in Part 2 happens inside one block that is ALWAYS rolled back at the end, so no fake user, balance,
--     transaction, flag change or notification is ever saved. The only things left behind are temp objects that vanish
--     when your SQL session closes.
--   * Nothing here broadcasts to any blockchain. Chain data is simulated by calling the same server functions the
--     deposit-watch and payout-send functions call.
--
-- WHAT IT CANNOT PROVE (needs the real-money test in TESTING-REAL-MONEY.md)
--   * That the 12-word phrase derives the right address for each coin (that maths runs in the browser, in addrgen.js).
--     This script proves the database stores, encrypts, validates and looks up whatever addresses the app sends.
--   * That the edge functions (deposit-watch, payout-quote, payout-send) reach the chains and sign correctly.
--
-- Result colours: FAIL = must fix before real money. WARN = read it and decide. INFO = a fact. PASS = fine.
-- =====================================================================================================================

drop table if exists pg_temp.vt_results;
create temp table vt_results (seq int generated always as identity, section text, test text, status text, detail text);

-- ---------- helpers (temp, vanish with the session) ----------
create or replace function pg_temp.vt(res jsonb, sec text, tst text, st text, det text default null)
returns jsonb language sql as $f$
  select res || jsonb_build_array(jsonb_build_object('s', sec, 't', tst, 'st', st, 'd', left(coalesce(det, ''), 500)))
$f$;

create or replace function pg_temp.vtb(res jsonb, sec text, tst text, ok boolean, det text default null)
returns jsonb language sql as $f$
  select pg_temp.vt(res, sec, tst, case when coalesce(ok, false) then 'PASS' else 'FAIL' end, det)
$f$;

create or replace function pg_temp.vtw(res jsonb, sec text, tst text, ok boolean, det text default null)
returns jsonb language sql as $f$
  select pg_temp.vt(res, sec, tst, case when coalesce(ok, false) then 'PASS' else 'WARN' end, det)
$f$;

-- fake but format-valid addresses for every supported coin; t = one lowercase letter (a, b, c)
create or replace function pg_temp.mk_addrs(t text) returns jsonb language sql as $f$
  select jsonb_build_array(
    jsonb_build_object('symbol','BTC' ,'network','Bitcoin'          ,'address','bc1q'  || repeat(t, 38)),
    jsonb_build_object('symbol','LTC' ,'network','Litecoin'         ,'address','ltc1q' || repeat(t, 38)),
    jsonb_build_object('symbol','ETH' ,'network','Ethereum'         ,'address','0x'    || repeat(t, 40)),
    jsonb_build_object('symbol','USDT','network','Ethereum'         ,'address','0x'    || repeat(t, 40)),
    jsonb_build_object('symbol','USDC','network','Ethereum'         ,'address','0x'    || repeat(t, 40)),
    jsonb_build_object('symbol','SHIB','network','Ethereum'         ,'address','0x'    || repeat(t, 40)),
    jsonb_build_object('symbol','LINK','network','Ethereum'         ,'address','0x'    || repeat(t, 40)),
    jsonb_build_object('symbol','BNB' ,'network','BNB Smart Chain'  ,'address','0x'    || repeat(t, 40)),
    jsonb_build_object('symbol','AVAX','network','Avalanche C-Chain','address','0x'   || repeat(t, 40)),
    jsonb_build_object('symbol','SOL' ,'network','Solana'           ,'address',repeat(upper(t), 44)),
    jsonb_build_object('symbol','XRP' ,'network','XRP Ledger'       ,'address','r'     || repeat(upper(t), 30)),
    jsonb_build_object('symbol','TRX' ,'network','TRON'             ,'address','T'     || repeat(upper(t), 33)),
    jsonb_build_object('symbol','DOGE','network','Dogecoin'         ,'address','D'     || repeat(upper(t), 33))   -- unsupported: must be dropped
  )
$f$;

-- run a SELECT expression as a signed-in app user (role "authenticated", with a live device session)
create or replace function pg_temp.call_as(u uuid, s uuid, expr text) returns jsonb language plpgsql as $f$
declare outv jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'session_id', s)::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  execute 'select to_jsonb(v) from (select ' || expr || ' as v) q' into outv;
  reset role;
  return outv;
end $f$;

-- run any statement as that user (for permission tests and void functions)
create or replace function pg_temp.exec_as(u uuid, s uuid, stmt text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'session_id', s)::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  execute stmt;
  reset role;
end $f$;

-- the withdrawal call exactly as the app makes it
create or replace function pg_temp.wd(u uuid, s uuid, sym text, amt numeric, addr text, pin text, req uuid, memo text default null)
returns jsonb language sql as $f$
  select pg_temp.call_as(u, s, format('public.wallet_withdraw(%L, %L::numeric, %L, %L, %L::uuid, %L)', sym, amt, addr, pin, req, memo))
$f$;

create or replace function pg_temp.held(u uuid, sym text) returns numeric language sql as $f$
  select coalesce(sum(amount), 0) from public.transactions
   where user_id = u and symbol = sym and kind = 'send' and not internal and status in ('queued','processing')
$f$;

create or replace function pg_temp.bal(u uuid, sym text) returns numeric language sql as $f$
  select coalesce((select amount from public.assets where user_id = u and symbol = sym), 0)
$f$;

-- =====================================================================================================================
do $vt$
declare
  res jsonb := '[]'::jsonb;
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid();
  sa uuid := gen_random_uuid(); sb uuid := gen_random_uuid(); sc uuid := gen_random_uuid();
  pa text := 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  pb text := 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  ltc_a text; ltc_b text; btc_a text; eth_a text;
  ext_ltc text := 'ltc1q' || repeat('z', 38);
  ext_eth text := '0x' || repeat('d', 40);
  r jsonb; r2 jsonb; r3 jsonb;
  n int; n2 int; nreq int; nreq_btc int;
  x numeric; x2 numeric; px numeric;
  tt text; tt2 text; bo boolean;
  rq uuid; rq1 uuid;
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid;
  h1 text; h3 text; h4 text;
  hd text; hd2 text; hd3 text; hd4 text; hd5 text;
  o1 uuid := gen_random_uuid(); o2 uuid := gen_random_uuid();
  trow public.transactions%rowtype;
  i int;
  b2 boolean; b3 boolean; b4 boolean;
begin
  -- ===================================================================================================================
  -- A. STRUCTURE  (read-only)
  -- ===================================================================================================================
  select string_agg(nm, ', ') into tt from unnest(array[
      'assets','profiles','transactions','user_wallets','wallet_addr_lookup','user_security','devices','notifications',
      'chain_state','asset_prices','chain_policy','chain_cursor','chain_health','scan_lock','scan_progress','send_allowlist',
      'tx_auth_events','app_flags','app_settings','payout_mutex','v_chain_reconciliation','v_phase38_balance_report','v_phase38_internal_rows'
    ]) nm where to_regclass('public.' || nm) is null;
  res := pg_temp.vtb(res, 'A Structure', 'every table and view the wallet needs exists', tt is null, coalesce('MISSING: ' || tt, '23 objects present'));

  select string_agg(nm, ', ') into tt from unnest(array[
      'wallet_withdraw','wallet_transfer','wallet_import','wallet_ensure','wallet_info','wallet_my_phrase','wallet_resolve_recipient',
      'pin_set','pin_verify','pin_clear','session_ok','is_admin','_valid_addr','_coin_network','_auto_supported','_supported_coin',
      '_norm_addr','_my_addr','_wallet_key','_auth_event','_send_gate','apply_chain_balance','record_chain_deposit',
      'chain_deposit_missing','chain_deposits_open','chain_deposits_final','chain_deposit_notify_done','chain_cursor_get',
      'chain_cursor_set','chain_cursor_set_fenced','payout_queue','payout_claim','payout_signing_phrase','payout_set_details',
      'payout_set_hash','payout_set_broadcast','payout_set_progress','payout_complete','payout_fail','payout_fail_mined',
      'payout_defer','payout_release_stale','payout_list_processing','payout_failed_fee_missing','payout_set_failed_fee',
      'scan_lock_acquire','scan_lock_release','scan_lock_holds','scan_progress_get','scan_progress_get_many',
      'scan_progress_set_fenced','chain_health_set','wallet_status_for','quote_context','push_notification','_fmt_amount','_display_name'
    ]) nm where not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = nm);
  res := pg_temp.vtb(res, 'A Structure', 'every database function the app and the edge functions call exists', tt is null, coalesce('MISSING: ' || tt, '56 functions present'));

  select string_agg(q.proname || ' x' || q.cnt, ', ') into tt from (
    select p.proname, count(*) cnt from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname in ('wallet_withdraw','wallet_transfer','wallet_import','payout_fail','payout_complete',
           'payout_set_hash','apply_chain_balance','record_chain_deposit','payout_claim','wallet_send')
     group by p.proname having count(*) > 1) q;
  res := pg_temp.vtb(res, 'A Structure', 'no old duplicate versions of the money functions are left behind', tt is null, coalesce('DUPLICATES (old signatures): ' || tt, 'one version each'));

  select count(*) into n from pg_trigger where not tgisinternal and tgenabled <> 'D'
     and tgname in ('transactions_send_gate','wallet_lookup_sync','wallet_only_supported','on_auth_user_created');
  res := pg_temp.vtb(res, 'A Structure', 'the 4 safety triggers exist and are enabled', n = 4, n || ' of 4');

  select string_agg(nm, ', ') into tt from unnest(array['transactions_chain_deposit_uniq','transactions_request_once']) nm where to_regclass('public.' || nm) is null;
  res := pg_temp.vtb(res, 'A Structure', 'unique indexes that stop double deposits and double withdrawals exist', tt is null, coalesce('MISSING: ' || tt, 'present'));

  select string_agg(sym, ', ') into tt from unnest(array['BTC','LTC','ETH','USDT','USDC','SHIB','LINK','BNB','AVAX','SOL','XRP','TRX']) sym
   where not (public._supported_coin(sym) and public._auto_supported(sym) and public._coin_network(sym) is not null
              and exists (select 1 from public.chain_policy p where p.symbol = sym and p.required_confirmations >= 1));
  res := pg_temp.vtb(res, 'A Structure', 'all 12 coins are supported, sendable, named by network and have a confirmation policy', tt is null, coalesce('PROBLEM COINS: ' || tt, '12 of 12'));

  res := pg_temp.vtb(res, 'A Structure', 'an unsupported coin (DOGE) is refused everywhere',
        not public._supported_coin('DOGE') and public._coin_network('DOGE') is null and not public._valid_addr('DOGE', 'D' || repeat('A', 33)), null);

  select string_agg(sym, ', ') into tt from unnest(array['BTC','LTC','ETH','USDT','USDC','SHIB','LINK','BNB','AVAX','SOL','XRP','TRX']) sym
   where not public._valid_addr(sym, (select e->>'address' from jsonb_array_elements(pg_temp.mk_addrs('a')) e where e->>'symbol' = sym));
  res := pg_temp.vtb(res, 'A Structure', 'a well-formed address is accepted for each coin', tt is null, coalesce('REJECTED: ' || tt, '12 of 12'));

  res := pg_temp.vtb(res, 'A Structure', 'an Ethereum-style address is refused for BTC, LTC, SOL, XRP and TRX',
        not public._valid_addr('BTC', ext_eth) and not public._valid_addr('LTC', ext_eth) and not public._valid_addr('SOL', ext_eth)
        and not public._valid_addr('XRP', ext_eth) and not public._valid_addr('TRX', ext_eth), null);
  res := pg_temp.vtb(res, 'A Structure', 'a Bitcoin address is refused for ETH, XRP and TRX, and an empty address is refused everywhere',
        not public._valid_addr('ETH', 'bc1q' || repeat('a', 38)) and not public._valid_addr('XRP', 'bc1q' || repeat('a', 38))
        and not public._valid_addr('TRX', 'bc1q' || repeat('a', 38)) and not public._valid_addr('LTC', '') and not public._valid_addr('ETH', ''), null);

  select string_agg(p.symbol || '=' || p.required_confirmations, ' ' order by p.symbol) into tt from public.chain_policy p;
  res := pg_temp.vt(res, 'A Structure', 'confirmation policy per coin (blocks needed before money counts)', 'INFO', tt);

  -- ===================================================================================================================
  -- B. SECURITY  (read-only)
  -- ===================================================================================================================
  select string_agg(distinct p.proname, ', ') into tt
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public'
     and p.proname = any (array['payout_signing_phrase','payout_set_details','payout_complete','payout_fail','payout_fail_mined','payout_claim',
        'payout_queue','payout_list_processing','payout_set_hash','payout_set_broadcast','payout_set_progress','payout_defer','payout_flag',
        'payout_release_stale','payout_lock_acquire','payout_lock_release','payout_failed_fee_missing','payout_set_failed_fee',
        'record_chain_deposit','apply_chain_balance','chain_cursor_get','chain_cursor_set','chain_cursor_set_fenced','chain_deposit_missing',
        'chain_deposit_notify_done','chain_deposits_open','chain_deposits_final','chain_health_set','scan_lock_acquire','scan_lock_release',
        'scan_lock_holds','scan_progress_get','scan_progress_get_many','scan_progress_set_fenced','wallet_status_for','quote_context',
        'set_asset_price','_auth_event','_my_addr','_wallet_key','_payout_cancel','wallet_send'])
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  res := pg_temp.vtb(res, 'B Security', 'server-only money/signing functions cannot be run by app users', tt is null,
        coalesce('APP USERS CAN RUN: ' || tt || '  (fix: revoke all on function ... from public, anon, authenticated)', 'none exposed'));

  select string_agg(distinct p.proname, ', ') into tt
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public'
     and p.proname = any (array['payout_signing_phrase','payout_claim','payout_complete','payout_fail','payout_fail_mined','record_chain_deposit',
        'apply_chain_balance','payout_set_hash','payout_set_progress','payout_queue','chain_health_set','scan_lock_acquire','quote_context','wallet_status_for'])
     and not has_function_privilege('service_role', p.oid, 'execute');
  res := pg_temp.vtb(res, 'B Security', 'the server (service_role) CAN run the functions the edge functions need', tt is null, coalesce('service_role blocked from: ' || tt, 'ok'));

  select string_agg(nm, ', ') into tt from unnest(array['wallet_withdraw','wallet_transfer','wallet_import','wallet_ensure','wallet_info',
        'wallet_my_phrase','wallet_resolve_recipient','pin_set','pin_verify','pin_clear']) nm
   where not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                      where s.nspname = 'public' and p.proname = nm and has_function_privilege('authenticated', p.oid, 'execute')
                        and not has_function_privilege('anon', p.oid, 'execute'));
  res := pg_temp.vtb(res, 'B Security', 'the app functions work for signed-in users and are closed to signed-out visitors', tt is null, coalesce('WRONG: ' || tt, '10 of 10'));

  select string_agg(tb || ' (' || rl || ')', ', ') into tt from unnest(array['user_wallets','wallet_addr_lookup','tx_auth_events','scan_lock','scan_progress',
        'chain_health','chain_cursor','chain_policy','chain_state','asset_prices','app_flags','app_settings','payout_mutex','send_allowlist']) tb,
        unnest(array['anon','authenticated']) rl
   where has_table_privilege(rl, 'public.' || tb, 'select,insert,update,delete');
  res := pg_temp.vtb(res, 'B Security', 'app users have no direct access to wallet, signing, scanner or settings tables', tt is null, coalesce('EXPOSED: ' || tt, 'none exposed'));

  select string_agg(c.relname, ', ') into tt from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = any (array['user_wallets','wallet_addr_lookup','tx_auth_events','scan_lock','scan_progress','chain_health',
        'chain_cursor','chain_policy','chain_state','asset_prices','app_flags','app_settings','payout_mutex','send_allowlist','user_security',
        'transactions','assets','profiles','devices','notifications']) and not c.relrowsecurity;
  res := pg_temp.vtb(res, 'B Security', 'row-level security is ON for every money and wallet table', tt is null, coalesce('RLS OFF: ' || tt, '20 tables'));

  res := pg_temp.vtb(res, 'B Security', 'a user cannot edit their own USD balance or admin flag directly',
        not has_column_privilege('authenticated', 'public.profiles', 'usd_balance', 'update') and not has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'update'), null);

  res := pg_temp.vtb(res, 'B Security', 'the old database-only wallet_send is closed to app users',
        not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'wallet_send'
                     and has_function_privilege('authenticated', p.oid, 'execute')), null);

  res := pg_temp.vtb(res, 'B Security', 'database-only crypto->USD conversion (wallet_convert) is closed to app users',
        not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'wallet_convert'
                     and has_function_privilege('authenticated', p.oid, 'execute')),
        'wallet_convert is still callable by any signed-in user. The app does not call it, and because balances now mirror the chain, it would let a user get USD credit while the coins stay on-chain. FIX: revoke execute on function public.wallet_convert(text,numeric,numeric,text) from authenticated;');

  select string_agg(p.proname, ', ') into tt from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.prosecdef and p.proconfig is null and p.prorettype <> 'trigger'::regtype::oid;
  res := pg_temp.vtw(res, 'B Security', 'every security-definer function pins its search_path', tt is null, coalesce('NOT PINNED: ' || tt, 'all pinned'));

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname in ('admin_test_wallet_phrase','admin_test_wallets');
  res := pg_temp.vtw(res, 'B Security', 'private-testing admin screen that can read recovery phrases is removed', n = 0,
        'admin_test_wallet_phrase / admin_test_wallets still exist (admin only). Fine for your private test; drop them before any public launch: run schema_phase9_REMOVE_before_launch.sql');

  select enabled into bo from public.app_flags where key = 'test_wallet_view';
  res := pg_temp.vtw(res, 'B Security', 'the admin "view recovery phrase" switch is OFF', not coalesce(bo, false), 'app_flags test_wallet_view = ' || coalesce(bo::text, 'row missing (off)'));

  select string_agg(key || '=' || enabled, ', ' order by key) into tt from public.app_flags;
  res := pg_temp.vt(res, 'B Security', 'switches right now (auto_withdraw = sending on)', 'INFO', tt);

  select count(*) into n from public.app_settings where key in ('auto_max_usd_per_tx','auto_max_usd_per_day');
  res := pg_temp.vtw(res, 'B Security', 'a per-transaction / per-day USD sending limit is enforced', false,
        'wallet_withdraw (phase 37) no longer applies the limits stored in app_settings (' || n || ' rows are still there but unused). Nothing caps one withdrawal. For early real-money tests keep amounts tiny and keep send_allowlist_only ON.');

  begin
    tt := public._wallet_key();
    res := pg_temp.vtb(res, 'B Security', 'the encryption key for stored phrases is readable by the server (Vault)', length(tt) >= 16, 'key length ok (value not shown)');
  exception when others then
    res := pg_temp.vt(res, 'B Security', 'the encryption key for stored phrases is readable by the server (Vault)', 'FAIL', sqlerrm);
  end;

  -- ===================================================================================================================
  -- I. LIVE DATA  (read-only; real rows in your database)
  -- ===================================================================================================================
  select count(*) into n from public.user_wallets;
  res := pg_temp.vt(res, 'I Live data', 'wallets in the database', 'INFO', n::text);

  begin
    select count(*) into n from (select extensions.pgp_sym_decrypt(phrase_enc, public._wallet_key()) p from public.user_wallets) q
     where p is null or p !~ '^[a-z]+( [a-z]+){11}$|^[a-z]+( [a-z]+){23}$';
    res := pg_temp.vtb(res, 'I Live data', 'every stored phrase decrypts and is a 12 or 24 word phrase (nothing is shown)', n = 0, n || ' wallet(s) fail');
  exception when others then
    res := pg_temp.vt(res, 'I Live data', 'every stored phrase decrypts (wrong or missing Vault key?)', 'FAIL', sqlerrm);
  end;

  select count(*) into n from public.user_wallets w, jsonb_array_elements(w.addresses) e where not public._valid_addr(e->>'symbol', e->>'address');
  res := pg_temp.vtb(res, 'I Live data', 'every stored wallet address is well-formed for its coin', n = 0, n || ' bad address(es)');

  select count(*) into n from public.user_wallets w
   where (select count(distinct upper(e->>'symbol')) from jsonb_array_elements(w.addresses) e where public._supported_coin(e->>'symbol')) < 12;
  res := pg_temp.vtw(res, 'I Live data', 'every wallet has an address for all 12 coins', n = 0, n || ' wallet(s) are missing a coin');

  select count(*) into n from (select w.user_id from public.user_wallets w, jsonb_array_elements(w.addresses) e
     where upper(e->>'symbol') in ('ETH','USDT','USDC','SHIB','LINK','BNB','AVAX') group by w.user_id having count(distinct lower(e->>'address')) > 1) q;
  res := pg_temp.vtb(res, 'I Live data', 'ETH, BNB, AVAX and the tokens share one address per wallet', n = 0, n || ' wallet(s) differ');

  select count(*) into n from (
      select w.user_id, upper(e->>'symbol') sy, public._norm_addr(e->>'symbol', e->>'address') nm from public.user_wallets w, jsonb_array_elements(w.addresses) e
      except select user_id, symbol, norm from public.wallet_addr_lookup) q;
  select count(*) into n2 from (
      select user_id, symbol, norm from public.wallet_addr_lookup
      except select w.user_id, upper(e->>'symbol'), public._norm_addr(e->>'symbol', e->>'address') from public.user_wallets w, jsonb_array_elements(w.addresses) e) q;
  res := pg_temp.vtb(res, 'I Live data', 'the address lookup table matches the wallets exactly (send-to-Veltrix-user relies on it)', n = 0 and n2 = 0, n || ' missing, ' || n2 || ' stale');

  select count(*) into n from public.user_wallets w left join public.user_security s on s.user_id = w.user_id where s.pin_hash is null;
  res := pg_temp.vtw(res, 'I Live data', 'every wallet owner has a PIN (without one they cannot send)', n = 0, n || ' wallet owner(s) have no PIN');

  select count(*) into n from public.v_phase38_balance_report where verdict like 'app balance ABOVE%' or verdict like 'NEVER READ%';
  select string_agg(distinct symbol, ', ') into tt from public.v_phase38_balance_report where verdict like 'app balance ABOVE%' or verdict like 'NEVER READ%';
  res := pg_temp.vtb(res, 'I Live data', 'no app balance exists that has no coin behind it (database-only money)', n = 0,
        n || ' balance row(s) not backed by the chain' || coalesce(' (' || tt || ')', '') || '. Run: select * from v_phase38_balance_report where verdict like ''app balance ABOVE%'' or verdict like ''NEVER READ%'';');

  select count(*) into n from public.v_chain_reconciliation where abs(drift) > 0;
  res := pg_temp.vtw(res, 'I Live data', 'on-chain balance = opening + deposits - sends - fees for every address (drift = 0)', n = 0,
        n || ' address(es) drift. Run: select * from v_chain_reconciliation where abs(drift) > 0;');

  select count(*) into n from public.assets a where not public._supported_coin(a.symbol) and a.amount > 0;
  res := pg_temp.vtw(res, 'I Live data', 'no balance is held in an unsupported coin', n = 0, n || ' row(s)');

  select count(*) into n from public.transactions where kind = 'deposit' and tx_hash is null;
  res := pg_temp.vtw(res, 'I Live data', 'every deposit row has a blockchain transaction hash', n = 0, n || ' deposit row(s) have no hash (credited before real on-chain tracking, or database-only)');

  select count(*) into n from public.transactions where internal;
  select count(*) into n2 from public.transactions where internal and created_at > now() - interval '30 days';
  res := pg_temp.vtw(res, 'I Live data', 'no database-only (internal) transfers in the last 30 days', n2 = 0, n || ' internal row(s) in total, ' || n2 || ' in the last 30 days');

  select count(*) into n from public.transactions where kind = 'send' and not internal and status = 'completed'
     and required_confirmations is not null and confirmations < required_confirmations;
  res := pg_temp.vtb(res, 'I Live data', 'no send is shown Confirmed before its required confirmations', n = 0, n || ' send(s)');

  select count(*) into n from public.transactions where kind = 'deposit' and status = 'completed' and required_confirmations is not null and confirmations < required_confirmations
     and (reorg_count = 0);
  res := pg_temp.vtw(res, 'I Live data', 'no deposit is credited before its required confirmations', n = 0, n || ' deposit(s)');

  select count(*) into n from public.transactions where kind = 'send' and not internal and status = 'processing' and tx_hash is null and processing_at < now() - interval '10 minutes';
  res := pg_temp.vtw(res, 'I Live data', 'no send is stuck "processing" without a hash for 10+ minutes', n = 0, n || ' stuck (payout_release_stale will retry them)');

  select count(*) into n from public.transactions where kind = 'send' and not internal and status = 'processing' and tx_hash is not null and created_at < now() - interval '3 hours';
  res := pg_temp.vtw(res, 'I Live data', 'no broadcast send has been waiting 3+ hours for confirmation', n = 0, n || ' waiting: check each hash on an explorer, then follow recovery_37_39.sql R5');

  select count(*) into n from public.transactions where kind = 'send' and not internal and status = 'queued' and created_at < now() - interval '10 minutes';
  res := pg_temp.vtw(res, 'I Live data', 'no send has been queued for 10+ minutes', n = 0, n || ' queued (is auto_withdraw on and payout-send running?)');

  select count(*) into n from public.chain_health where network <> '_scanner' and not ok;
  select string_agg(network, ', ') into tt from public.chain_health where network <> '_scanner' and not ok;
  res := pg_temp.vtb(res, 'I Live data', 'every blockchain connection reports healthy', n = 0, coalesce('PROBLEM: ' || tt || '. Run: select network, error from chain_health where not ok;', 'all ok'));

  select count(*) into n from public.chain_health where network <> '_scanner' and (last_ok_at is null or last_ok_at < now() - interval '5 minutes');
  res := pg_temp.vtw(res, 'I Live data', 'every network was confirmed healthy in the last 5 minutes', n = 0, n || ' network(s) stale (is the deposit-watch cron running?)');

  select floor(extract(epoch from (now() - checked_at)))::int into n from public.chain_health where network = '_scanner';
  res := pg_temp.vtw(res, 'I Live data', 'the deposit scanner ran in the last 3 minutes', n is not null and n <= 180, coalesce(n::text || ' seconds ago', 'never ran'));

  select count(*) into n from auth.users where email like '%@veltrix-selftest.invalid';
  res := pg_temp.vtb(res, 'I Live data', 'no leftover fake test accounts', n = 0, n::text);

  -- ===================================================================================================================
  -- SANDBOX: everything below runs on fake users and is ROLLED BACK at the end
  -- ===================================================================================================================
  begin
    insert into auth.users(id, email, aud, role) values
      (ua, 'a-' || ua || '@veltrix-selftest.invalid', 'authenticated', 'authenticated'),
      (ub, 'b-' || ub || '@veltrix-selftest.invalid', 'authenticated', 'authenticated'),
      (uc, 'c-' || uc || '@veltrix-selftest.invalid', 'authenticated', 'authenticated');
    select count(*) into n from public.profiles where id in (ua, ub, uc);
    res := pg_temp.vtb(res, 'C Wallet', 'signing up creates a profile automatically', n = 3, n || ' of 3');
    insert into public.devices(user_id, session_id, name) values (ua, sa, 'selftest'), (ub, sb, 'selftest'), (uc, sc, 'selftest');

    -- ================================================================================================================
    -- C. WALLET: PIN, import/create, storage, lookup
    -- ================================================================================================================
    begin
      perform pg_temp.exec_as(ua, sa, $$select public.pin_set('1234')$$);
      perform pg_temp.exec_as(ub, sb, $$select public.pin_set('5678')$$);
      res := pg_temp.vtb(res, 'C Wallet', 'a PIN can be set', (select count(*) from public.user_security where user_id in (ua, ub) and pin_hash is not null) = 2, null);
      res := pg_temp.vtb(res, 'C Wallet', 'the PIN is stored hashed, never as digits',
            (select bool_and(pin_hash <> '1234' and pin_hash <> '5678' and length(pin_hash) > 20) from public.user_security where user_id in (ua, ub)), null);
      r  := pg_temp.call_as(ua, sa, $$public.pin_verify('1234')$$);
      r2 := pg_temp.call_as(ua, sa, $$public.pin_verify('0000')$$);
      r3 := pg_temp.call_as(ua, sa, $$public.pin_verify('1234')$$);
      res := pg_temp.vtb(res, 'C Wallet', 'pin_verify: right PIN true, wrong PIN false, right PIN again true', r = 'true'::jsonb and r2 = 'false'::jsonb and r3 = 'true'::jsonb, r::text || ' ' || r2::text || ' ' || r3::text);
    exception when others then
      reset role; res := pg_temp.vt(res, 'C Wallet', 'PIN set / verify', 'FAIL', sqlerrm);
    end;

    begin
      r := pg_temp.call_as(ua, sa, format('public.wallet_import(%L, %L::jsonb)', pa, pg_temp.mk_addrs('a')::text));
      res := pg_temp.vtb(res, 'C Wallet', 'wallet_import accepts a phrase and 13 addresses and keeps exactly the 12 supported coins',
            r->>'ok' = 'true' and r->>'created' = 'true' and jsonb_array_length(r->'addresses') = 12
            and not exists (select 1 from jsonb_array_elements(r->'addresses') e where e->>'symbol' = 'DOGE'), left(r::text, 200));
      r := pg_temp.call_as(ub, sb, format('public.wallet_ensure(%L, %L::jsonb)', pb, pg_temp.mk_addrs('b')::text));
      res := pg_temp.vtb(res, 'C Wallet', 'wallet_ensure (generated phrase path) stores a new wallet', r->>'created' = 'true' and jsonb_array_length(r->'addresses') = 12, left(r::text, 200));
    exception when others then
      reset role; res := pg_temp.vt(res, 'C Wallet', 'wallet creation', 'FAIL', sqlerrm);
    end;

    ltc_a := public._my_addr(ua, 'LTC'); ltc_b := public._my_addr(ub, 'LTC'); btc_a := public._my_addr(ua, 'BTC'); eth_a := public._my_addr(ua, 'ETH');

    begin
      select position('abandon' in encode(phrase_enc, 'escape')) = 0 and octet_length(phrase_enc) > 40 into bo from public.user_wallets where user_id = ua;
      res := pg_temp.vtb(res, 'C Wallet', 'the phrase is stored encrypted (the words do not appear in the stored bytes)', bo, null);
      r  := pg_temp.call_as(ua, sa, 'public.wallet_my_phrase()');
      r2 := pg_temp.call_as(ub, sb, 'public.wallet_my_phrase()');
      res := pg_temp.vtb(res, 'C Wallet', 'each owner gets back exactly their own phrase and nobody else''s (decrypt round-trip)',
            r->>'phrase' = pa and r2->>'phrase' = pb, 'phrases match: ' || (r->>'phrase' = pa and r2->>'phrase' = pb)::text);
      r := pg_temp.call_as(ua, sa, 'public.wallet_info()');
      res := pg_temp.vtb(res, 'C Wallet', 'wallet_info returns the address list and never the phrase', r->>'exists' = 'true' and jsonb_array_length(r->'addresses') = 12 and not jsonb_exists(r, 'phrase'), null);
      r := pg_temp.call_as(ua, sa, format('public.wallet_import(%L, %L::jsonb)', 'zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra zebra zoo', pg_temp.mk_addrs('c')::text));
      r2 := pg_temp.call_as(ua, sa, 'public.wallet_my_phrase()');
      res := pg_temp.vtb(res, 'C Wallet', 'a second import can never overwrite an existing wallet', r->>'created' = 'false' and r2->>'phrase' = pa, null);
      select count(*) into n from public.wallet_addr_lookup where user_id = ua;
      res := pg_temp.vtb(res, 'C Wallet', 'the lookup table is filled automatically (12 rows for the wallet)', n = 12, n::text);
    exception when others then
      reset role; res := pg_temp.vt(res, 'C Wallet', 'phrase storage and read-back', 'FAIL', sqlerrm);
    end;

    begin
      r := pg_temp.call_as(uc, sc, format('public.wallet_import(%L, %L::jsonb)', 'one two three', pg_temp.mk_addrs('c')::text));
      r2 := pg_temp.call_as(uc, sc, format('public.wallet_import(%L, %L::jsonb)', 'Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', pg_temp.mk_addrs('c')::text));
      res := pg_temp.vtb(res, 'C Wallet', 'a phrase that is not 12 or 24 lowercase words is refused', r->>'reason' = 'invalid_phrase' and r2->>'reason' = 'invalid_phrase', r::text);
      r := pg_temp.call_as(uc, sc, format('public.wallet_import(%L, %L::jsonb)', pa, pg_temp.mk_addrs('a')::text));
      res := pg_temp.vtb(res, 'C Wallet', 'the same wallet cannot be imported into a second account', r->>'reason' = 'already_registered', r::text);
      select count(*) into n from public.user_wallets where user_id = uc;
      res := pg_temp.vtb(res, 'C Wallet', 'a refused import stores nothing', n = 0, n::text);
    exception when others then
      reset role; res := pg_temp.vt(res, 'C Wallet', 'refused imports', 'FAIL', sqlerrm);
    end;

    begin
      r  := pg_temp.call_as(ub, sb, format('public.wallet_resolve_recipient(%L, %L)', 'LTC', upper(ltc_a)));
      r2 := pg_temp.call_as(ub, sb, format('public.wallet_resolve_recipient(%L, %L)', 'LTC', ltc_b));
      r3 := pg_temp.call_as(ub, sb, format('public.wallet_resolve_recipient(%L, %L)', 'LTC', ext_ltc));
      res := pg_temp.vtb(res, 'C Wallet', 'wallet_resolve_recipient: finds another Veltrix user (any letter case), flags your own address, ignores strangers',
            r->>'found' = 'true' and coalesce(r->>'self', 'false') <> 'true' and r2->>'self' = 'true' and r3->>'found' = 'false', left(r::text, 160));
    exception when others then
      reset role; res := pg_temp.vt(res, 'C Wallet', 'recipient lookup', 'FAIL', sqlerrm);
    end;

    -- permission behaviour as a real signed-in user
    begin
      perform pg_temp.exec_as(ub, sb, 'select 1 from public.user_wallets limit 1');
      res := pg_temp.vt(res, 'C Wallet', 'an app user cannot read the wallets table', 'FAIL', 'the select was allowed');
    exception when insufficient_privilege then reset role; res := pg_temp.vt(res, 'C Wallet', 'an app user cannot read the wallets table', 'PASS', null);
              when others then reset role; res := pg_temp.vt(res, 'C Wallet', 'an app user cannot read the wallets table', 'FAIL', sqlerrm);
    end;

    -- ================================================================================================================
    -- D. WITHDRAWALS (the full gate list), all on LTC
    -- ================================================================================================================
    perform public.apply_chain_balance(ua, 'LTC', 'Litecoin', ltc_a, 1.0, 'Litecoin');
    res := pg_temp.vtb(res, 'D Withdrawal', 'a confirmed on-chain balance of 1 LTC shows as 1 LTC in the app', pg_temp.bal(ua, 'LTC') = 1.0, pg_temp.bal(ua, 'LTC')::text);
    select required_confirmations into nreq from public.chain_policy where symbol = 'LTC';
    select required_confirmations into nreq_btc from public.chain_policy where symbol = 'BTC';

    insert into public.app_flags(key, enabled) values ('auto_withdraw', false) on conflict (key) do update set enabled = false;
    insert into public.app_flags(key, enabled) values ('send_allowlist_only', false) on conflict (key) do update set enabled = false;

    begin  -- D1 kill switch
      rq := gen_random_uuid();
      r := pg_temp.wd(ua, sa, 'LTC', 0.1, ext_ltc, '1234', rq);
      select count(*) into n from public.transactions where user_id = ua;
      select string_agg(event, ',') into tt from public.tx_auth_events where request_id = rq;
      res := pg_temp.vtb(res, 'D Withdrawal', 'sending switched OFF: refused, nothing queued, balance untouched, no signing key used',
            r->>'reason' = 'unavailable' and n = 0 and pg_temp.bal(ua, 'LTC') = 1.0 and coalesce(tt, '') not like '%signing_key_used%', r::text || ' events=' || coalesce(tt, ''));
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'kill switch', 'FAIL', sqlerrm);
    end;

    update public.app_flags set enabled = true where key = 'auto_withdraw';

    begin  -- D2 wrong PIN
      rq := gen_random_uuid();
      r := pg_temp.wd(ua, sa, 'LTC', 0.1, ext_ltc, '9999', rq);
      select count(*) into n from public.transactions where user_id = ua;
      select string_agg(event, ',') into tt from public.tx_auth_events where request_id = rq;
      res := pg_temp.vtb(res, 'D Withdrawal', 'wrong PIN: refused, nothing queued, balance untouched, logged as bad_pin',
            r->>'reason' = 'bad_pin' and n = 0 and pg_temp.bal(ua, 'LTC') = 1.0 and tt like '%bad_pin%', r::text || ' events=' || coalesce(tt, ''));
      r := pg_temp.wd(ua, sa, 'LTC', 0.1, ext_ltc, 'abcd', gen_random_uuid());
      res := pg_temp.vtb(res, 'D Withdrawal', 'a PIN that is not 4 digits is refused cleanly', r->>'reason' = 'bad_pin', r::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'wrong PIN', 'FAIL', sqlerrm);
    end;

    begin  -- D3 address checks
      r  := pg_temp.wd(ua, sa, 'LTC', 0.1, 'not-an-address', '1234', gen_random_uuid());
      r2 := pg_temp.wd(ua, sa, 'LTC', 0.1, ext_eth, '1234', gen_random_uuid());
      r3 := pg_temp.wd(ua, sa, 'LTC', 0.1, '', '1234', gen_random_uuid());
      res := pg_temp.vtb(res, 'D Withdrawal', 'invalid, wrong-network and empty addresses are refused before anything moves',
            r->>'reason' = 'invalid_address' and r2->>'reason' = 'invalid_address' and r3->>'reason' = 'invalid_address' and pg_temp.bal(ua, 'LTC') = 1.0, r::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'address checks', 'FAIL', sqlerrm);
    end;

    begin  -- D4 amount checks
      select string_agg(coalesce(pg_temp.wd(ua, sa, 'LTC', v, ext_ltc, '1234', gen_random_uuid())->>'reason', '?'), ',') into tt
        from unnest(array[0::numeric, -1, 0.123456789, 1000000000000, 0.000001]) v;
      res := pg_temp.vtb(res, 'D Withdrawal', 'zero, negative, 9-decimal, absurdly large and below-minimum amounts are all refused',
            tt = 'invalid_amount,invalid_amount,invalid_amount,invalid_amount,invalid_amount' and pg_temp.bal(ua, 'LTC') = 1.0, tt);
      r := pg_temp.wd(ua, sa, 'DOGE', 0.1, 'D' || repeat('A', 33), '1234', gen_random_uuid());
      r2 := pg_temp.wd(ua, sa, '', 0.1, ext_ltc, '1234', gen_random_uuid());
      res := pg_temp.vtb(res, 'D Withdrawal', 'an unsupported or empty coin is refused', r->>'reason' = 'unsupported_coin' and r2->>'reason' = 'unsupported_coin', r::text);
      r := pg_temp.wd(ua, sa, 'LTC', 0.1, ext_ltc, '1234', gen_random_uuid(), '123');
      r2 := pg_temp.wd(ua, sa, 'XRP', 0.1, 'r' || repeat('X', 30), '1234', gen_random_uuid(), 'abc');
      res := pg_temp.vtb(res, 'D Withdrawal', 'a memo/destination tag is refused for coins that have none, and bad tags are refused for XRP', r->>'reason' = 'invalid_memo' and r2->>'reason' = 'invalid_memo', r::text || ' ' || r2::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'amount / coin / memo checks', 'FAIL', sqlerrm);
    end;

    begin  -- D5 insufficient
      r := pg_temp.wd(ua, sa, 'LTC', 5, ext_ltc, '1234', gen_random_uuid());
      select count(*) into n from public.transactions where user_id = ua;
      res := pg_temp.vtb(res, 'D Withdrawal', 'more than the balance: refused, nothing queued, balance untouched', r->>'reason' = 'insufficient' and n = 0 and pg_temp.bal(ua, 'LTC') = 1.0, r::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'insufficient balance', 'FAIL', sqlerrm);
    end;

    begin  -- D6 a real withdrawal to an outside wallet
      rq1 := gen_random_uuid();
      r := pg_temp.wd(ua, sa, 'LTC', 0.25, ext_ltc, '1234', rq1);
      t1 := (r->>'id')::uuid;
      select * into trow from public.transactions where id = t1;
      select string_agg(event, ',' order by id) into tt from public.tx_auth_events where request_id = rq1;
      res := pg_temp.vtb(res, 'D Withdrawal', 'correct send: accepted and queued with a WD- reference', r->>'ok' = 'true' and r->>'status' = 'queued' and trow.status = 'queued' and trow.reference like 'WD-%', r::text);
      res := pg_temp.vtb(res, 'D Withdrawal', 'R1: the send is recorded as leaving the SENDER''S OWN address', trow.from_address = ltc_a and trow.kind = 'send' and trow.to_address = ext_ltc, 'from=' || coalesce(trow.from_address, 'null'));
      res := pg_temp.vtb(res, 'D Withdrawal', 'the amount is held: balance drops by exactly the amount', pg_temp.bal(ua, 'LTC') = 0.75, pg_temp.bal(ua, 'LTC')::text);
      res := pg_temp.vtb(res, 'D Withdrawal', 'an outside send is not database-only and has no Veltrix recipient', not trow.internal and trow.counterparty_id is null and trow.tx_hash is null, null);
      res := pg_temp.vtb(res, 'D Withdrawal', 'PIN audit trail: pin_ok then accepted, and no signing key used yet', tt like '%pin_ok%' and tt like '%accepted%' and tt not like '%signing_key_used%', tt);
      select usd into px from public.asset_prices where symbol = 'LTC';
      res := pg_temp.vtw(res, 'D Withdrawal', 'USD value is amount x the server price (not a client number)', px is not null and trow.usd_value = round(0.25 * px, 2),
            'price=' || coalesce(px::text, 'none in asset_prices') || ' usd_value=' || coalesce(trow.usd_value::text, 'null'));
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'successful withdrawal', 'FAIL', sqlerrm);
    end;

    begin  -- D7 replay / double tap
      r := pg_temp.wd(ua, sa, 'LTC', 0.25, ext_ltc, '1234', rq1);
      select count(*) into n from public.transactions where user_id = ua and request_id = rq1;
      res := pg_temp.vtb(res, 'D Withdrawal', 'double tap with the same request id: same transaction returned, balance not debited twice, still ONE row',
            r->>'replayed' = 'true' and (r->>'id')::uuid = t1 and n = 1 and pg_temp.bal(ua, 'LTC') = 0.75, r::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'replay protection', 'FAIL', sqlerrm);
    end;

    begin  -- D8 balance refresh must not give the held coins back
      perform public.apply_chain_balance(ua, 'LTC', 'Litecoin', ltc_a, 1.0, 'Litecoin');
      res := pg_temp.vtb(res, 'D Withdrawal', 'a balance refresh from the chain does NOT resurrect coins that are being sent (no double spend)', pg_temp.bal(ua, 'LTC') = 1.0 - pg_temp.held(ua, 'LTC'), pg_temp.bal(ua, 'LTC')::text);
    exception when others then res := pg_temp.vt(res, 'D Withdrawal', 'refresh while sending', 'FAIL', sqlerrm);
    end;

    begin  -- D9 self
      r := pg_temp.wd(ua, sa, 'LTC', 0.1, ltc_a, '1234', gen_random_uuid());
      res := pg_temp.vtb(res, 'D Withdrawal', 'sending to your own Veltrix address is refused', r->>'reason' = 'self' and pg_temp.bal(ua, 'LTC') = 1.0 - pg_temp.held(ua, 'LTC'), r::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'self send', 'FAIL', sqlerrm);
    end;

    begin  -- D10 A -> B is a real on-chain send, not a database move
      r := pg_temp.wd(ua, sa, 'LTC', 0.1, ltc_b, '1234', gen_random_uuid());
      t2 := (r->>'id')::uuid;
      select * into trow from public.transactions where id = t2;
      select count(*) into n from public.transactions where user_id = ub;
      res := pg_temp.vtb(res, 'D Withdrawal', 'send to another Veltrix user: queued as an ordinary on-chain send to THEIR address, recipient name remembered',
            r->>'ok' = 'true' and trow.to_address = ltc_b and trow.counterparty_id = ub and r->>'to_name' is not null and not trow.internal and trow.from_address = ltc_a, left(r::text, 200));
      res := pg_temp.vtb(res, 'D Withdrawal', 'the recipient''s balance and history are NOT touched by the database (no database-only transfer)', pg_temp.bal(ub, 'LTC') = 0 and n = 0, 'B balance=' || pg_temp.bal(ub, 'LTC')::text || ' B rows=' || n);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'send to Veltrix user', 'FAIL', sqlerrm);
    end;

    begin  -- D11 wallet_transfer wrapper
      r  := pg_temp.call_as(ua, sa, format('public.wallet_transfer(%L, %L::numeric, %L, %L, %L::uuid)', 'LTC', 0.05, ltc_b, '1234', gen_random_uuid()));
      t3 := (r->>'id')::uuid;
      r2 := pg_temp.call_as(ua, sa, format('public.wallet_transfer(%L, %L::numeric, %L, %L, %L::uuid)', 'LTC', 0.05, ext_ltc, '1234', gen_random_uuid()));
      r3 := pg_temp.call_as(ua, sa, format('public.wallet_transfer(%L, %L::numeric, %L, %L, %L::uuid)', 'LTC', 0.05, ltc_a, '1234', gen_random_uuid()));
      res := pg_temp.vtb(res, 'D Withdrawal', 'wallet_transfer: works for a Veltrix address, refuses a stranger and refuses yourself',
            r->>'ok' = 'true' and r2->>'reason' = 'recipient_not_found' and r3->>'reason' = 'self', r::text || ' | ' || r2::text || ' | ' || r3::text);
      res := pg_temp.vtb(res, 'D Withdrawal', 'balance = chain balance - everything in flight (3 sends held)', pg_temp.bal(ua, 'LTC') = 1.0 - pg_temp.held(ua, 'LTC') and pg_temp.held(ua, 'LTC') = 0.40, pg_temp.bal(ua, 'LTC')::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'wallet_transfer', 'FAIL', sqlerrm);
    end;

    begin  -- D12 private-testing allow-list
      update public.app_flags set enabled = true where key = 'send_allowlist_only';
      begin
        r := pg_temp.wd(ua, sa, 'LTC', 0.01, ext_ltc, '1234', gen_random_uuid());
        res := pg_temp.vt(res, 'D Withdrawal', 'allow-list ON: an account that is not listed cannot send', 'FAIL', 'the send went through: ' || r::text);
      exception when others then
        reset role;
        res := pg_temp.vtb(res, 'D Withdrawal', 'allow-list ON: an account that is not listed cannot send (and nothing is held)', sqlerrm like '%not enabled%' and pg_temp.bal(ua, 'LTC') = 1.0 - pg_temp.held(ua, 'LTC'), sqlerrm);
      end;
      insert into public.send_allowlist(user_id) values (ua);
      r := pg_temp.wd(ua, sa, 'LTC', 0.01, ext_ltc, '1234', gen_random_uuid());
      t4 := (r->>'id')::uuid;
      res := pg_temp.vtb(res, 'D Withdrawal', 'allow-list ON: a listed account can send', r->>'ok' = 'true', r::text);
      update public.app_flags set enabled = false where key = 'send_allowlist_only';
      r := pg_temp.wd(ua, sa, 'LTC', 0.02, ext_ltc, '1234', gen_random_uuid());
      t5 := (r->>'id')::uuid;
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'allow-list gate', 'FAIL', sqlerrm);
    end;

    begin  -- D13 PIN lock-out
      for i in 1..5 loop
        r2 := pg_temp.wd(ub, sb, 'LTC', 0.1, ext_ltc, '0000', gen_random_uuid());
      end loop;
      r := pg_temp.wd(ub, sb, 'LTC', 0.1, ext_ltc, '5678', gen_random_uuid());
      res := pg_temp.vtb(res, 'D Withdrawal', '5 wrong PINs lock the account: even the right PIN is refused during the lock', r2->>'reason' = 'bad_pin' and r->>'reason' = 'locked' and (r->>'seconds')::int > 0, r::text);
      update public.user_security set failed = 0, locked_until = null where user_id = ub;
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'PIN lock-out', 'FAIL', sqlerrm);
    end;

    begin  -- D14 pin_clear / no PIN
      perform pg_temp.exec_as(uc, sc, $$select public.pin_set('1111')$$);
      r  := pg_temp.call_as(uc, sc, $$public.pin_clear('9999')$$);
      r2 := pg_temp.call_as(uc, sc, $$public.pin_clear('1111')$$);
      r3 := pg_temp.wd(uc, sc, 'LTC', 0.1, ext_ltc, '1111', gen_random_uuid());
      res := pg_temp.vtb(res, 'D Withdrawal', 'pin_clear needs the right PIN, and an account with no PIN cannot send', r = 'false'::jsonb and r2 = 'true'::jsonb and r3->>'reason' = 'no_pin', r::text || ' ' || r2::text || ' ' || r3::text);
    exception when others then reset role; res := pg_temp.vt(res, 'D Withdrawal', 'pin_clear / no PIN', 'FAIL', sqlerrm);
    end;

    begin  -- D15 quotes create nothing
      select count(*) into n from public.transactions where user_id = ua;
      r  := public.quote_context(ua, 'LTC', ltc_b);
      r2 := public.quote_context(ua, 'LTC', 'garbage');
      r3 := public.quote_context(ua, 'DOGE', 'x');
      select count(*) into n2 from public.transactions where user_id = ua;
      res := pg_temp.vtb(res, 'D Withdrawal', 'fee-quote context: knows the sender''s own address, the recipient, the balance, and creates NO transaction row',
            r->>'ok' = 'true' and r->>'from' = ltc_a and r->>'to_valid' = 'true' and r->>'self' = 'false' and r->>'recipient_name' is not null
            and r2->>'to_valid' = 'false' and r3->>'ok' = 'false' and n = n2, left(r::text, 200));
    exception when others then res := pg_temp.vt(res, 'D Withdrawal', 'quote_context', 'FAIL', sqlerrm);
    end;

    -- ================================================================================================================
    -- E. PAYOUT LIFE-CYCLE (what payout-send does), then failure and refund paths
    -- ================================================================================================================
    h1 := md5('h1' || ua::text) || md5('h1b' || ua::text);
    h3 := md5('h3' || ua::text) || md5('h3b' || ua::text);
    h4 := md5('h4' || ua::text) || md5('h4b' || ua::text);

    begin
      r := public.payout_queue();
      res := pg_temp.vtb(res, 'E Payout', 'payout_queue lists the new send', exists (select 1 from jsonb_array_elements(r) e where e->>'id' = t1::text), null);
      r := public.payout_claim(t1);
      select * into trow from public.transactions where id = t1;
      res := pg_temp.vtb(res, 'E Payout', 'payout_claim moves queued -> processing and hands over the amount as exact text', r->>'status' = 'processing' and (r->>'amount')::numeric = 0.25 and trow.status = 'processing' and trow.payout_attempts = 1, left(r::text, 120));
      r2 := public.payout_claim(t1);
      res := pg_temp.vtb(res, 'E Payout', 'a second claim of the same send returns nothing (cannot be sent twice)', r2 is null, null);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'queue and claim', 'FAIL', sqlerrm);
    end;

    begin
      r  := public.payout_signing_phrase(ua, t1);
      r2 := public.payout_signing_phrase(ub, t1);
      r3 := public.payout_signing_phrase(ua, t2);
      select count(*) into n from public.tx_auth_events where tx_id = t1 and event = 'signing_key_used';
      res := pg_temp.vtb(res, 'E Payout', 'R1: the signing key released for a send is the SENDER''S phrase and the SENDER''S address', r->>'phrase' = pa and r->>'address' = ltc_a, 'phrase and address match the sender: ' || (r->>'phrase' = pa and r->>'address' = ltc_a)::text);
      res := pg_temp.vtb(res, 'E Payout', 'the key is not released for another user''s send, nor for a send that is still only queued', r2 is null and r3 is null, null);
      res := pg_temp.vtb(res, 'E Payout', 'every key release is logged (signing_key_used)', n = 1, n::text);
      perform public.payout_set_details(t1, ltc_a, 0.0001, 'LTC');
      select * into trow from public.transactions where id = t1;
      res := pg_temp.vtb(res, 'E Payout', 'payout_set_details records the from-address and the maximum fee estimate', trow.from_address = ltc_a and trow.fee_estimate = 0.0001 and trow.fee_symbol = 'LTC', null);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'signing key release', 'FAIL', sqlerrm);
    end;

    begin
      begin
        bo := public.payout_set_hash(t1, 'zz-not-a-hash');
        res := pg_temp.vt(res, 'E Payout', 'a malformed transaction hash is rejected', 'FAIL', 'accepted');
      exception when others then
        res := pg_temp.vtb(res, 'E Payout', 'a malformed transaction hash is rejected', sqlerrm like '%bad hash%', sqlerrm);
      end;
      bo := public.payout_set_hash(t1, h1, 'selftest');
      r  := public.payout_signing_phrase(ua, t1);
      res := pg_temp.vtb(res, 'E Payout', 'a good hash is stored, and after that the signing key can never be released again', bo and r is null, null);
      perform public.payout_set_broadcast(t1);
      r := public.payout_list_processing();
      res := pg_temp.vtb(res, 'E Payout', 'a broadcast send appears in the processing list for confirmation tracking', exists (select 1 from jsonb_array_elements(r) e where e->>'id' = t1::text), null);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'hash and broadcast', 'FAIL', sqlerrm);
    end;

    begin
      x := pg_temp.bal(ua, 'LTC');
      r := public.payout_set_progress(t1, 2, 100, 'blockhash1', 0.0001, 'LTC');
      bo := public.payout_complete(t1, h1);
      select status into tt from public.transactions where id = t1;
      res := pg_temp.vtb(res, 'E Payout', 'R: a send is NOT Confirmed before the required confirmations (2 of ' || nreq || ')', r->>'ready' = 'false' and bo = false and tt = 'processing', r::text || ' complete=' || bo::text);
      r := public.payout_set_progress(t1, nreq, 100, 'blockhash1', 0.0001, 'LTC');
      bo := public.payout_complete(t1, h1);
      select * into trow from public.transactions where id = t1;
      res := pg_temp.vtb(res, 'E Payout', 'at the required confirmations the send becomes Confirmed, with the real fee recorded',
            r->>'ready' = 'true' and bo and trow.status = 'completed' and trow.fee_actual = 0.0001 and trow.confirmations = nreq and trow.tx_hash = h1, 'status=' || trow.status);
      res := pg_temp.vtb(res, 'E Payout', 'completing a send never touches the balance again (no refund, no second debit)', pg_temp.bal(ua, 'LTC') = x, null);
      res := pg_temp.vtb(res, 'E Payout', 'completing twice is harmless', public.payout_complete(t1, h1) = false, null);
      perform public.apply_chain_balance(ua, 'LTC', 'Litecoin', ltc_a, 1.0 - 0.25 - 0.0001, 'Litecoin');
      select count(*) into n from public.v_chain_reconciliation where user_id = ua and symbol = 'LTC' and abs(drift) > 0;
      res := pg_temp.vtb(res, 'E Payout', 'reconciliation: after the chain shows amount + fee gone, drift is exactly 0 and the app balance mirrors chain minus in-flight',
            n = 0 and pg_temp.bal(ua, 'LTC') = (1.0 - 0.25 - 0.0001) - pg_temp.held(ua, 'LTC'), 'drift rows=' || n || ' balance=' || pg_temp.bal(ua, 'LTC')::text);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'confirmation tracking', 'FAIL', sqlerrm);
    end;

    begin  -- A -> B completes; B then sees its own deposit with the SAME hash
      perform public.payout_claim(t3);
      perform public.payout_set_details(t3, ltc_a, 0.0001, 'LTC');
      bo := public.payout_set_hash(t3, h3, 'selftest');
      perform public.payout_set_progress(t3, nreq, 200, 'blockhash3', 0.0001, 'LTC');
      bo := public.payout_complete(t3, h3);
      perform public.apply_chain_balance(ub, 'LTC', 'Litecoin', ltc_b, 0, 'Litecoin');
      r := public.record_chain_deposit(ub, 'LTC', 'Litecoin', ltc_b, ltc_a, h3, '0', 0.05, 200, 'blockhash3', now(), 1);
      perform public.apply_chain_balance(ub, 'LTC', 'Litecoin', ltc_b, 0.05, 'Litecoin');
      res := pg_temp.vtb(res, 'E Payout', 'A to B: B sees an incoming deposit but it is NOT in B''s balance until it has the required confirmations', r->>'status' = 'confirming' and pg_temp.bal(ub, 'LTC') = 0, r::text || ' B balance=' || pg_temp.bal(ub, 'LTC')::text);
      r := public.record_chain_deposit(ub, 'LTC', 'Litecoin', ltc_b, ltc_a, h3, '0', 0.05, 200, 'blockhash3', now(), nreq);
      perform public.apply_chain_balance(ub, 'LTC', 'Litecoin', ltc_b, 0.05, 'Litecoin');
      select count(*) into n from public.transactions where user_id = ub and kind = 'deposit' and tx_hash = h3;
      select count(*) into n2 from public.transactions where user_id in (ua, ub) and internal;
      res := pg_temp.vtb(res, 'E Payout', 'A to B: at full confirmations B has exactly ONE deposit row with A''s hash and B''s balance rises by the amount', r->>'status' = 'completed' and n = 1 and pg_temp.bal(ub, 'LTC') = 0.05 and (select tx_hash from public.transactions where id = t3) = h3, 'B balance=' || pg_temp.bal(ub, 'LTC')::text);
      res := pg_temp.vtb(res, 'E Payout', 'A to B moved no database-only money (no internal rows)', n2 = 0, n2::text);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'A to B on-chain transfer', 'FAIL', sqlerrm);
    end;

    begin  -- failure path 1: never sent
      perform public.payout_claim(t2);
      x := pg_temp.bal(ua, 'LTC');
      bo := public.payout_fail(t2, 'selftest: could not be sent');
      select * into trow from public.transactions where id = t2;
      x2 := pg_temp.bal(ua, 'LTC');
      res := pg_temp.vtb(res, 'E Payout', 'FAILED BEFORE SENDING: cancelled, the exact amount (0.10) is returned, reason and failure kind recorded', bo and trow.status = 'cancelled' and x2 = x + 0.10 and trow.failure_kind = 'failed' and trow.cancel_reason is not null, 'refund=' || (x2 - x)::text);
      bo := public.payout_fail(t2, 'again');
      res := pg_temp.vtb(res, 'E Payout', 'failing the same send twice never refunds twice', bo = false and pg_temp.bal(ua, 'LTC') = x2, null);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'failure before sending', 'FAIL', sqlerrm);
    end;

    begin  -- failure path 2: sent, outcome unclear, then mined-failed with a real fee
      perform public.payout_claim(t4);
      bo := public.payout_set_hash(t4, h4, 'selftest');
      x := pg_temp.bal(ua, 'LTC');
      bo := public.payout_fail(t4, 'unclear');
      select status into tt from public.transactions where id = t4;
      res := pg_temp.vtb(res, 'E Payout', 'UNCLEAR (hash stored, outcome unknown): the money stays HELD, it is not refunded', bo = false and tt = 'processing' and pg_temp.bal(ua, 'LTC') = x, 'status=' || tt);
      bo := public.payout_fail_mined(t4, 'reverted on chain', 'failed', 0.0002, 'LTC', 123, 'blockhash4');
      select * into trow from public.transactions where id = t4;
      res := pg_temp.vtb(res, 'E Payout', 'MINED BUT FAILED: cancelled, amount returned, the real network fee is recorded and shown',
            bo and trow.status = 'cancelled' and pg_temp.bal(ua, 'LTC') = x + 0.01 and trow.fee_actual = 0.0002 and trow.fee_symbol = 'LTC' and trow.cancel_reason like '%fee%', coalesce(trow.cancel_reason, ''));
      bo := public.payout_fail_mined(t4, 'again', 'failed', 0.0002, 'LTC');
      res := pg_temp.vtb(res, 'E Payout', 'a mined-failed send cannot be refunded twice', bo = false and pg_temp.bal(ua, 'LTC') = x + 0.01, null);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'failure after sending', 'FAIL', sqlerrm);
    end;

    begin  -- retry paths
      perform public.payout_claim(t5);
      tt := public.payout_defer(t5, 'provider busy');
      select status into tt2 from public.transactions where id = t5;
      res := pg_temp.vtb(res, 'E Payout', 'a temporary problem puts the send back in the queue (not lost, not refunded)', tt = 'queued' and tt2 = 'queued', tt || '/' || tt2);
      perform public.payout_claim(t5);
      update public.transactions set processing_at = now() - interval '10 minutes' where id = t5;
      n := public.payout_release_stale();
      select status into tt2 from public.transactions where id = t5;
      res := pg_temp.vtb(res, 'E Payout', 'a send stuck 5+ minutes with no hash is released back to the queue', n >= 1 and tt2 = 'queued', 'released=' || n || ' status=' || tt2);
    exception when others then res := pg_temp.vt(res, 'E Payout', 'retry paths', 'FAIL', sqlerrm);
    end;

    begin
      perform pg_temp.exec_as(ua, sa, format('select public.admin_resolve_payout(%L::uuid, %L, %L, %L)', t5, 'refund', null, 'selftest'));
      res := pg_temp.vt(res, 'E Payout', 'a normal user cannot force-complete or refund a payout', 'FAIL', 'allowed');
    exception when others then
      reset role; res := pg_temp.vtb(res, 'E Payout', 'a normal user cannot force-complete or refund a payout', sqlerrm like '%not allowed%', sqlerrm);
    end;

    begin
      perform pg_temp.exec_as(ua, sa, format('select public.admin_test_wallet_phrase(%L::uuid)', ub));
      res := pg_temp.vt(res, 'E Payout', 'a normal user cannot read another user''s phrase through the admin function', 'FAIL', 'allowed');
    exception when others then
      reset role; res := pg_temp.vtb(res, 'E Payout', 'a normal user cannot read another user''s phrase through the admin function', sqlerrm like '%admin only%' or sqlerrm like '%does not exist%', sqlerrm);
    end;

    -- ================================================================================================================
    -- F. DEPOSITS (what deposit-watch does), on BTC
    -- ================================================================================================================
    hd := md5('d1' || ua::text) || md5('d1b' || ua::text);
    hd2 := md5('d2' || ua::text) || md5('d2b' || ua::text);
    hd3 := md5('d3' || ua::text) || md5('d3b' || ua::text);
    hd4 := md5('d4' || ua::text) || md5('d4b' || ua::text);
    hd5 := md5('d5' || ua::text) || md5('d5b' || ua::text);
    perform public.apply_chain_balance(ua, 'BTC', 'Bitcoin', btc_a, 0, 'Bitcoin');

    begin
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, '1SenderSenderSenderSenderSender12', hd, '0', 0.5, 800000, 'bh1', now(), 0);
      select count(*) into n from public.transactions where user_id = ua and kind = 'deposit' and tx_hash = hd;
      res := pg_temp.vtb(res, 'F Deposit', 'a new incoming transaction is recorded once as Pending with 0 confirmations', r->>'ok' = 'true' and r->>'created' = 'true' and r->>'status' = 'pending' and n = 1, r::text);
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, '1SenderSenderSenderSenderSender12', hd, '0', 0.5, 800000, 'bh1', now(), 0);
      r2 := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, '1SenderSenderSenderSenderSender12', hd, '0', 0.5, 800000, 'bh1', now(), 0);
      select count(*) into n from public.transactions where user_id = ua and kind = 'deposit' and tx_hash = hd;
      res := pg_temp.vtb(res, 'F Deposit', 'the watcher running again and again NEVER creates a second row for the same transaction', r->>'created' = 'false' and r2->>'created' = 'false' and n = 1, 'rows=' || n);
      select * into trow from public.transactions where user_id = ua and kind = 'deposit' and tx_hash = hd;
      res := pg_temp.vtb(res, 'F Deposit', 'the deposit row keeps hash, exact amount, sender, our address and block details', trow.amount = 0.5 and trow.to_address = btc_a and trow.from_address like '1Sender%' and trow.block_number = 800000 and trow.required_confirmations = nreq_btc, 'required=' || coalesce(trow.required_confirmations::text, 'null'));
    exception when others then res := pg_temp.vt(res, 'F Deposit', 'deposit detection', 'FAIL', sqlerrm);
    end;

    begin
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd, '0', 0.5, 800000, 'bh1', now(), nreq_btc - 1);
      perform public.apply_chain_balance(ua, 'BTC', 'Bitcoin', btc_a, 0.5, 'Bitcoin');
      res := pg_temp.vtb(res, 'F Deposit', 'below the required depth: shown as Confirming and NOT yet in the balance', r->>'status' = 'confirming' and pg_temp.bal(ua, 'BTC') = 0, r::text || ' balance=' || pg_temp.bal(ua, 'BTC')::text);
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd, '0', 0.5, 800000, 'bh1', now(), nreq_btc);
      perform public.apply_chain_balance(ua, 'BTC', 'Bitcoin', btc_a, 0.5, 'Bitcoin');
      res := pg_temp.vtb(res, 'F Deposit', 'at the required depth: Completed and the balance rises by exactly the deposit', r->>'status' = 'completed' and pg_temp.bal(ua, 'BTC') = 0.5, r::text);
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd, '0', 0.5, 800000, 'bh1', now(), 1);
      res := pg_temp.vtb(res, 'F Deposit', 'a lagging provider reporting fewer confirmations for the same block does not demote a completed deposit', r->>'status' = 'completed', r::text);
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd, '0', 0.5, 800001, 'bh-OTHER', now(), 0);
      select * into trow from public.transactions where user_id = ua and kind = 'deposit' and tx_hash = hd;
      res := pg_temp.vtb(res, 'F Deposit', 'a REAL reorg (different block) demotes the deposit, counts it, and leaves a note', r->>'reorg' = 'true' and trow.status = 'pending' and trow.reorg_count = 1 and trow.payout_note is not null, r::text);
    exception when others then res := pg_temp.vt(res, 'F Deposit', 'confirmation depth / reorg', 'FAIL', sqlerrm);
    end;

    begin
      r  := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', 'bc1q' || repeat('z', 38), 'x1234567', hd2, '0', 0.1, 1, 'b', now(), 1);
      r2 := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd2, '0', 0, 1, 'b', now(), 1);
      r3 := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', 'short', '0', 0.1, 1, 'b', now(), 1);
      res := pg_temp.vtb(res, 'F Deposit', 'a payment to an address that is not the user''s, a zero amount, or a bad hash is refused',
            r->>'reason' = 'not_user_address' and r2->>'reason' = 'bad_amount' and r3->>'reason' = 'bad_hash', r::text || r2::text || r3::text);
      r := public.record_chain_deposit(ua, 'DOGE', 'Dogecoin', btc_a, 'x1234567', hd2, '0', 0.1, 1, 'b', now(), 1);
      res := pg_temp.vtb(res, 'F Deposit', 'a deposit in an unsupported coin is refused', r->>'reason' = 'no_policy', r::text);
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd2, '0', 0.1, 1, 'b', now() - interval '2 days', 1);
      select count(*) into n from public.transactions where user_id = ua and tx_hash = hd2;
      res := pg_temp.vtb(res, 'F Deposit', 'coins that were already in an imported wallet before tracking began are NOT counted as a deposit (they are the opening balance)', r->>'skipped' = 'before_tracking' and n = 0, r::text);
    exception when others then res := pg_temp.vt(res, 'F Deposit', 'deposit refusals', 'FAIL', sqlerrm);
    end;

    begin
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd3, '0', 0.2, null, null, now(), 0);
      select id into t1 from public.transactions where user_id = ua and kind = 'deposit' and tx_hash = hd3;
      r2 := public.chain_deposits_open();
      res := pg_temp.vtb(res, 'F Deposit', 'open (pending/confirming) deposits are listed for re-checking', exists (select 1 from jsonb_array_elements(r2) e where e->>'id' = t1::text), null);
      tt := public.chain_deposit_missing(t1); tt2 := public.chain_deposit_missing(t1);
      res := pg_temp.vtb(res, 'F Deposit', 'a deposit the chain does not know yet is only flagged after 3 misses (not dropped on the first)', tt = 'pending' and tt2 = 'pending', tt || ',' || tt2);
      tt := public.chain_deposit_missing(t1);
      res := pg_temp.vtb(res, 'F Deposit', 'after 3 misses an unconfirmed deposit is marked dropped', tt = 'dropped', tt);
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd4, '0', 0.3, 800010, 'bh4', now(), nreq_btc);
      select id into t2 from public.transactions where user_id = ua and kind = 'deposit' and tx_hash = hd4;
      tt := public.chain_deposit_missing(t2); tt := public.chain_deposit_missing(t2); tt := public.chain_deposit_missing(t2);
      res := pg_temp.vtb(res, 'F Deposit', 'a deposit that was in a block and then vanishes is marked reorged', tt = 'reorged', tt);
      r := public.record_chain_deposit(ua, 'BTC', 'Bitcoin', btc_a, 'x1234567', hd5, '0', 0.1, 800020, 'bh5', now(), nreq_btc);
      select count(*) into n from unnest(public.chain_deposits_final('BTC', array[hd5, hd3])) h where h = hd5;
      select count(*) into n2 from unnest(public.chain_deposits_final('BTC', array[hd5, hd3])) h where h = hd3;
      res := pg_temp.vtb(res, 'F Deposit', 'chain_deposits_final reports completed deposits only', n = 1 and n2 = 0, null);
      n := public.chain_deposit_notify_done();
      res := pg_temp.vtb(res, 'F Deposit', 'deposit-confirmed notification sweep runs', n is not null, n::text);
    exception when others then res := pg_temp.vt(res, 'F Deposit', 'deposit bookkeeping', 'FAIL', sqlerrm);
    end;

    -- ================================================================================================================
    -- G. SCANNER LOCKS, CURSORS, HEALTH, STATUS
    -- ================================================================================================================
    begin
      bo := public.scan_lock_acquire('vt-selftest', o1, 60);
      b2 := public.scan_lock_acquire('vt-selftest', o2, 60);
      b3 := public.scan_lock_holds('vt-selftest', o1);
      b4 := public.scan_lock_holds('vt-selftest', o2);
      res := pg_temp.vtb(res, 'G Scanner', 'one scanner can take the lock, a second one cannot', bo and not b2 and b3 and not b4, null);
      b2 := public.chain_cursor_set_fenced('vt:cursor', 5, 'vt-selftest', o2);
      b3 := public.chain_cursor_set_fenced('vt:cursor', 5, 'vt-selftest', o1);
      res := pg_temp.vtb(res, 'G Scanner', 'only the lock holder can move the saved scan position', not b2 and b3 and public.chain_cursor_get('vt:cursor') = 5, null);
      b2 := public.scan_progress_set_fenced('vt:prog', '{"a":1}'::jsonb, 'vt-selftest', o2);
      b3 := public.scan_progress_set_fenced('vt:prog', '{"a":1}'::jsonb, 'vt-selftest', o1);
      res := pg_temp.vtb(res, 'G Scanner', 'only the lock holder can save scan progress', not b2 and b3 and (public.scan_progress_get('vt:prog'))->>'a' = '1', null);
      perform public.scan_lock_release('vt-selftest', o1);
      b2 := public.scan_lock_acquire('vt-selftest', o2, 60);
      res := pg_temp.vtb(res, 'G Scanner', 'after release the other scanner can take over', b2, null);
    exception when others then res := pg_temp.vt(res, 'G Scanner', 'locks and cursors', 'FAIL', sqlerrm);
    end;

    begin
      perform public.chain_health_set('ZTEST', true, null, '{"x":1}'::jsonb);
      perform public.chain_health_set('ZTEST', false, 'boom', '{}'::jsonb);
      select ok, error into bo, tt from public.chain_health where network = 'ZTEST';
      select count(*) into n from public.chain_health where network = 'ZTEST' and last_ok_at is not null;
      res := pg_temp.vtb(res, 'G Scanner', 'chain_health_set records a failure and remembers the last good time', bo = false and tt = 'boom' and n = 1, null);
      r := public.wallet_status_for(ua);
      res := pg_temp.vtb(res, 'G Scanner', 'wallet_status_for returns balances, deposits, sends, networks and scanner age',
            jsonb_exists(r, 'balances') and jsonb_exists(r, 'deposits') and jsonb_exists(r, 'sends') and jsonb_exists(r, 'networks') and jsonb_exists(r, 'scanner'), left(r::text, 120));
    exception when others then res := pg_temp.vt(res, 'G Scanner', 'health and status', 'FAIL', sqlerrm);
    end;

    -- ================================================================================================================
    -- H. WHAT AN APP USER MUST NOT BE ABLE TO DO (run as a real signed-in user)
    -- ================================================================================================================
    begin
      select count(*) into n from public.assets where user_id = ua;
      r := pg_temp.call_as(ub, sb, format('(select count(*) from public.assets where user_id = %L::uuid)', ua));
      r2 := pg_temp.call_as(ub, sb, format('(select count(*) from public.transactions where user_id = %L::uuid)', ua));
      r3 := pg_temp.call_as(ua, sa, format('(select count(*) from public.assets where user_id = %L::uuid)', ua));
      res := pg_temp.vtb(res, 'H App user limits', 'a user sees only their own balances and history (never another user''s)', r = '0'::jsonb and r2 = '0'::jsonb and (r3 #>> '{}')::int = n and n > 0, 'B sees A assets=' || r::text || ' tx=' || r2::text);
    exception when others then reset role; res := pg_temp.vt(res, 'H App user limits', 'data isolation', 'FAIL', sqlerrm);
    end;

    begin
      perform pg_temp.exec_as(ua, sa, format('update public.assets set amount = amount + 100 where user_id = %L::uuid', ua));
      res := pg_temp.vt(res, 'H App user limits', 'a user cannot edit their own crypto balance', 'FAIL', 'update allowed');
    exception when insufficient_privilege then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot edit their own crypto balance', 'PASS', null);
              when others then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot edit their own crypto balance', 'FAIL', sqlerrm);
    end;

    begin
      perform pg_temp.exec_as(ua, sa, format('update public.profiles set usd_balance = 999999 where id = %L::uuid', ua));
      res := pg_temp.vt(res, 'H App user limits', 'a user cannot edit their own USD balance', 'FAIL', 'update allowed');
    exception when insufficient_privilege then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot edit their own USD balance', 'PASS', null);
              when others then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot edit their own USD balance', 'FAIL', sqlerrm);
    end;

    begin
      perform pg_temp.exec_as(ua, sa, format('insert into public.transactions(user_id, wallet, kind, symbol, amount, status) values (%L::uuid, %L, %L, %L, 5, %L)', ua, 'crypto', 'deposit', 'LTC', 'completed'));
      res := pg_temp.vt(res, 'H App user limits', 'a user cannot write a fake deposit into their own history', 'FAIL', 'insert allowed');
    exception when insufficient_privilege then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot write a fake deposit into their own history', 'PASS', null);
              when others then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot write a fake deposit into their own history', 'FAIL', sqlerrm);
    end;

    begin
      perform pg_temp.exec_as(ua, sa, format('select public.payout_signing_phrase(%L::uuid, %L::uuid)', ua, t5));
      res := pg_temp.vt(res, 'H App user limits', 'a user cannot call the signing-key function', 'FAIL', 'allowed');
    exception when insufficient_privilege then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot call the signing-key function', 'PASS', null);
              when others then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot call the signing-key function', 'FAIL', sqlerrm);
    end;

    begin
      perform pg_temp.exec_as(ua, sa, format('select public.apply_chain_balance(%L::uuid, %L, %L, %L, 100, %L)', ua, 'LTC', 'Litecoin', ltc_a, 'Litecoin'));
      res := pg_temp.vt(res, 'H App user limits', 'a user cannot credit themselves through the balance function', 'FAIL', 'allowed');
    exception when insufficient_privilege then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot credit themselves through the balance function', 'PASS', null);
              when others then reset role; res := pg_temp.vt(res, 'H App user limits', 'a user cannot credit themselves through the balance function', 'FAIL', sqlerrm);
    end;

    begin
      set local role anon;
      perform public.wallet_withdraw('LTC', 0.1, ext_ltc, '1234', gen_random_uuid());
      reset role;
      res := pg_temp.vt(res, 'H App user limits', 'a signed-out visitor cannot call wallet_withdraw', 'FAIL', 'allowed');
    exception when insufficient_privilege then reset role; res := pg_temp.vt(res, 'H App user limits', 'a signed-out visitor cannot call wallet_withdraw', 'PASS', null);
              when others then reset role; res := pg_temp.vt(res, 'H App user limits', 'a signed-out visitor cannot call wallet_withdraw', 'FAIL', sqlerrm);
    end;

    begin
      delete from public.devices where user_id = ua;
      r := pg_temp.wd(ua, sa, 'LTC', 0.1, ext_ltc, '1234', gen_random_uuid());
      res := pg_temp.vt(res, 'H App user limits', 'a signed-out / revoked device session cannot withdraw', 'FAIL', 'allowed: ' || r::text);
    exception when others then
      reset role; res := pg_temp.vtb(res, 'H App user limits', 'a signed-out / revoked device session cannot withdraw', sqlerrm like '%session revoked%', sqlerrm);
    end;

    raise exception 'vt_rollback';          -- <- everything done above in this block is thrown away
  exception when others then
    reset role;
    if sqlerrm <> 'vt_rollback' then
      res := pg_temp.vt(res, 'Z Test run', 'the test sandbox stopped early; later checks did not run', 'FAIL', sqlerrm);
    end if;
  end;

  insert into pg_temp.vt_results(section, test, status, detail)
  select je.e->>'s', je.e->>'t', je.e->>'st', je.e->>'d' from jsonb_array_elements(res) with ordinality as je(e, o) order by je.o;
end
$vt$;

-- ===== RESULT GRID: first row is the summary, then FAIL, WARN, INFO, PASS =====
select status, section, test, detail
from (
  select 0 as g, 0 as seq, 'SUMMARY' as status, '0 Summary' as section,
         'PASS ' || count(*) filter (where status = 'PASS') || '  |  FAIL ' || count(*) filter (where status = 'FAIL')
         || '  |  WARN ' || count(*) filter (where status = 'WARN') || '  |  INFO ' || count(*) filter (where status = 'INFO') as test,
         case when count(*) filter (where status = 'FAIL') = 0 then 'no FAIL rows' else 'send me every FAIL and WARN row' end as detail
    from pg_temp.vt_results
  union all
  select case status when 'FAIL' then 1 when 'WARN' then 2 when 'INFO' then 3 else 4 end, seq, status, section, test, detail
    from pg_temp.vt_results
) q
order by g, seq;
