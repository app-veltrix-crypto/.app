#!/usr/bin/env bash
# Runs every OFFLINE test (no network, no database, no money). Needs Node 22+.   Usage:  bash supabase/functions/run-tests.sh
# These prove the LOGIC against fakes. They do NOT prove anything about a real blockchain, RPC provider or your Supabase project (see PHASE39.md §6-7).
set -u; cd "$(dirname "$0")"; fail=0
for t in payout-send/test/chains.test.mts payout-send/test/deposits.test.mts payout-send/test/failed-fee.test.mts payout-quote/test/quote.test.mts \
         deposit-watch/test/watcher.test.mts deposit-watch/test/pagination.test.mts deposit-watch/test/evm-internal.test.mts \
         payout-send/test/network-identity.test.mts deposit-watch/test/trx-internal.test.mts deposit-watch/test/trace-tool.test.mts; do
  echo "== $t"; out=$(node --experimental-strip-types --no-warnings "$t" 2>&1); code=$?; echo "$out" | grep -E "^FAIL|checks? ran|passed|^ +[0-9]+ " | tail -3
  if [ $code -ne 0 ] || echo "$out" | grep -q "^FAIL"; then echo "$out" | tail -25; fail=1; fi
done
[ $fail -eq 0 ] && echo "ALL OFFLINE TESTS PASSED" || { echo "SOME TESTS FAILED"; exit 1; }
