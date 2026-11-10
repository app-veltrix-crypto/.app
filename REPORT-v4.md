# Veltrix — report on version 4 (follows your review of v3)

**Read this first.** Nothing here has touched a real blockchain, a real RPC provider, or your database: the build environment had no internet and no PostgreSQL. What I can state as fact is limited to *code that exists* and *offline tests against fakes* (9 test files, all passing: `bash supabase/functions/run-tests.sh`). **No cryptocurrency is claimed fully functional.** The financial rules are unchanged and untouched: the sender's own wallet funds every transaction, the sender pays the network fee, Veltrix contributes no treasury funds. The v3 implementation is preserved; v4 only adds and tightens (PHASE40.md lists every file).

## Your seven items
| # | Item | Result |
|---|---|---|
| 1 | TRON contract-sent TRX | **Implemented in code, offline-tested (13 checks), never run on a live TRON node.** Walks solidified blocks, reads `internal_transactions`, counts only TRX, skips rejected/reverted, duplicate-safe refs, own cursor, failures reported (warning if the API lacks the endpoint, error if transient, warning if switched off) — never silent. Assumptions only a live node can confirm are listed in PHASE40.md. |
| 2 | Signer-side network identity | **Done for BTC, LTC, SOL, XRP, TRX** in `payout-send/chains.ts`: checked before any coin is read or key derived and again right before broadcast, on the endpoint actually used, not cached, independent of the quote and watcher. 26 offline checks; mutation-tested (removing either check fails 13–14 tests). Proven only against fakes. EVM was already bound to the chain id (checked in `prepare`, and the signature itself is chain-bound); I did not add a pre-broadcast re-check there. |
| 3 | EVM internal deposits / tracing | Requirements documented exactly (EVM-TRACING.md). **I could not confirm your RPC provider supports tracing** (no internet). Instead: a diagnostic you run with your own URLs (`tools/check-evm-trace.mts`, exit code 2 + "internal transfers CANNOT be completely monitored" when it does not), plus a positive control on a real past internal transfer. **Found and fixed a gap:** a separate `RPC_TRACE_*` endpoint was not identity-checked; it is now. |
| 4 | Token support | TOKENS.md: fully implemented in code / partial / unsupported. Only USDT, USDC, SHIB, LINK **on Ethereum** exist as tokens. **BEP-20, TRC-20, SPL, Avalanche tokens are unsupported.** **Found and fixed:** the deposit screen labelled native BNB and TRX as "BEP-20" and "TRC-20" (inviting token deposits that would be invisible); labels corrected, plus an explicit "not supported" line on BNB/TRX/SOL/AVAX. |
| 5 | Migration 37 + 38 + 39 | Reviewed together statically (MIGRATION.md §8): strict order 37→38→39, no backward references; real prerequisites are wider than phase 37's header says (phases 3, 6, 8, 10 too); the destructive step is the first watcher run after 37; version skew between SQL and functions is the main hazard. Delivered: read-only `preflight_37_39.sql` / `postflight_37_39.sql`, `backup_before_37.sql` (tables + exact text of replaced functions), `recovery_37_39.sql` (all commented out). **Not executed anywhere; your live database was not touched.** |
| 6 | Real-money checklist | TESTING-REAL-MONEY.md rewritten: import, deposits, detection, balances, quotes, PIN, withdrawals, A→B, actual fees, confirmations, failed-transaction reconciliation, per-coin table, stop conditions. |
| 7 | This report | Below. |

## READY (exists, offline-tested; still unproven on-chain)
* Own-key signing and broadcast for BTC, LTC, ETH, BNB, AVAX, SOL, XRP, TRX and the four ERC-20 tokens; PIN gate and audit events; sender-pays-fee; no treasury path in the code.
* Signer network-identity verification for BTC/LTC/SOL/XRP/TRX (v4); chain-id binding for EVM.
* Transaction-level deposit tracking with confirmation policy, duplicate protection, leases/cursors, pagination (phases 38–39, v3).
* TRX contract-sent deposit scanning (v4), EVM internal-deposit scanning code (v3), trace diagnostic tool (v4).
* Failed-transaction fee recording and reconciliation view (phase 39, v3).
* Migration safety kit and full test checklist (v4).

## INCOMPLETE / KNOWN LIMITS
* **Nothing is chain-verified.** Every coin's row in TESTING-REAL-MONEY.md §13 is unticked.
* ETH/BNB/AVAX contract-sent deposits depend on a tracing provider I could not test; without it they are **not** monitored (the watcher says so).
* TRX: staking/vote reward and unfreeze credits are balance increases without a deposit record (drift will show them); contract-sent scanning needs a provider serving the solidity block endpoint and ~28,800 requests/day.
* Tokens: only four ERC-20 tokens on Ethereum; everything in TOKENS.md §C is unsupported. Tokens cannot be sent without ETH for gas in the same address.
* Optional label SQL for new withdrawals (`schema_phase40_network_labels.sql`) is not applied by anything; until you run it, new TRX withdrawal receipts still say "TRON (TRC-20)".
* Private-testing design remains: phrases are stored server-side and readable by the admin "Test wallets" screen; both must be removed before any public launch.
* Not re-run: the v3 PostgreSQL scratch tests (`supabase/test/phase39`) — no Postgres here.
* I fixed one intermittent v3 test (1 ms budget); nothing else in v3 behaviour changed except what PHASE40.md lists.

## REQUIRES YOUR PARTICIPATION
1. **Approve and run the migration** on a restored copy, then live, in the order of MIGRATION.md §8 (I ran nothing). Decide, from `preflight` C1, whether any database-only balance must be kept — the first watcher run replaces app balances with chain balances.
2. **Run the trace diagnostic** with your real RPC URLs, and a positive control per EVM chain.
3. **Provide/confirm providers:** a TRON API serving `walletsolidity/gettransactioninfobyblocknum` (TronGrid with a key), and tracing for ETH/BNB/AVAX if you want internal deposits.
4. **Deploy** the three functions with secrets, set the cron, keep `auto_withdraw=false` until TESTING §8.
5. **Spend real money** following TESTING-REAL-MONEY.md, with explorer evidence; send me any deviation (SQL output + explorer link).
6. Decide whether to run `schema_phase40_network_labels.sql` (cosmetic).

## Files changed or added in v4
`payout-send/chains.ts` · `deposit-watch/{scan,watcher,index}.ts` · `app.js/{addrgen,script}.js` · tests: `network-identity`, `trx-internal`, `trace-tool` (+ `identity-fixtures`, updated mocks in `chains`/`quote`/`deposits` tests) · `deposit-watch/tools/check-evm-trace.mts` · SQL: `preflight_37_39`, `backup_before_37`, `postflight_37_39`, `recovery_37_39`, `schema_phase40_network_labels` · docs: `REPORT-v4`, `PHASE40`, `EVM-TRACING`, `TOKENS`, `MIGRATION §8`, `TESTING-REAL-MONEY`, `payout-send/README`.
