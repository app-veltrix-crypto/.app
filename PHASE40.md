# Phase 40 — what changed in v4 (on top of the v3 you reviewed; nothing removed)

| # | Change | Files |
|---|---|---|
| 1 | **TRX contract-sent deposits** are detected (new lane `trxint:TRX` walking *solidified* blocks, reading `internal_transactions`; only TRX, rejected / reverted skipped; duplicate-safe `int:<caller>:<sun>:<n>` refs; own cursor; failures are reported, never silent). | `deposit-watch/scan.ts` (`scanTrxInternal`, `trxInternalFrom`, `tronHexOf`, `tronAddressOf`), `watcher.ts`, `index.ts` |
| 2 | **The withdrawal signer verifies the network itself** for BTC, LTC, SOL, XRP, TRX: before any coin is read or key derived (`retry`, nothing signed) and again immediately before broadcast (`definite`, nothing sent). Not cached. Uses the endpoint that will actually be used to read coins and broadcast. | `payout-send/chains.ts` |
| 3 | A separate `RPC_TRACE_<SYM>` endpoint is **identity-checked** before it is believed (it was not before). Diagnostic tool for your provider. | `deposit-watch/watcher.ts`, `deposit-watch/tools/check-evm-trace.mts`, `EVM-TRACING.md` |
| 4 | Deposit screen no longer labels native BNB/TRX as BEP-20/TRC-20 and warns that BEP-20/TRC-20/SPL/Avalanche tokens are unsupported. Optional SQL label. | `app.js/addrgen.js`, `app.js/script.js`, `supabase/schema_phase40_network_labels.sql`, `TOKENS.md` |
| 5 | Migration safety kit (read-only preflight/postflight, pre-37 snapshot incl. old function text, recovery runbook). | `supabase/preflight_37_39.sql`, `backup_before_37.sql`, `postflight_37_39.sql`, `recovery_37_39.sql`, `MIGRATION.md §8` |
| 6 | Test fix: a v3 settlement test used a 1 ms budget and failed intermittently; the budget argument was removed (15 consecutive reruns clean). | `payout-send/test/deposits.test.mts` |

## New settings (all optional)
| Secret | Default | Meaning |
|---|---|---|
| `TRX_INTERNAL` | on | `off` disables contract-sent TRX scanning (a warning says so) |
| `DEPOSIT_MAX_BLOCKS_TRX` | 120 | solidified blocks read per chunk (TRON makes ~20 blocks/min) |
| `GENESIS_BTC/LTC/SOL/TRX`, `NETWORK_ID_XRP` | mainnet | now also honoured by the **signer** (they were already honoured by the quote and watcher). Set them only for a deliberate test-network run, in all three functions' secrets. |

To start TRX internal scanning from a chosen block instead of ~300 blocks (~15 minutes) back: `select chain_cursor_set('trxint:TRX', <solidified block number>);`

## What was added to the offline tests
`payout-send/test/network-identity.test.mts` (26 checks: every coin × wrong network / unreachable / broadcast re-check / right network; not cached; end-to-end refund through `processOne`; env overrides; structural order) · `deposit-watch/test/trx-internal.test.mts` (13) · `deposit-watch/test/trace-tool.test.mts` (9). I mutation-tested the first two (deleting the new checks makes 13–14 tests fail). Total offline suite: 9 files, all passing — `bash supabase/functions/run-tests.sh`.

## Limits of those tests
They use fakes shaped like the documented answers. They cannot show that TronGrid really serves `walletsolidity/gettransactioninfobyblocknum` the way assumed, that `callValueInfo` without a `tokenId` is always TRX, or that a block with no transactions answers `[]`/`{}`. Those are the assumptions to check in §6 of the testing doc.

## Balance-service warning ("Can't reach the balance service right now…")
The app asks the `deposit-watch` function for the user's wallet status every ~20 s. This exact sentence used to appear for ANY failure of that call. Now the app shows the real cause (and keeps it in `veltrixWallet.lastStatusError` and the browser console), and the function answers a crash with its reason instead of an empty 500.
| What the app now says | Meaning | Fix |
|---|---|---|
| "…not deployed on this project (404)" | the function does not exist | `supabase functions deploy deposit-watch --no-verify-jwt` |
| "…refused the request (401). …--no-verify-jwt" | the gateway rejects the user's token | redeploy with `--no-verify-jwt` |
| "Your session expired…" | the function ran, the user is signed out | sign in again |
| "…failed (503/500: <reason>)" | the function crashed or cannot start | Dashboard → Edge Functions → deposit-watch → Logs |
| "Could not read your wallet status … (is schema_phase39 installed?)" | the function runs but the database lacks phase 39 | MIGRATION.md §8 |
| "Can't reach the balance service…" (original text) | no answer at all: offline / blocked / DNS | check the connection |
Quick phone test: open `https://<project-ref>.supabase.co/functions/v1/deposit-watch` in a browser. A healthy, deployed function answers `{"ok":false … "error":"not signed in"}`. `NOT_FOUND` = not deployed; `Invalid JWT` = redeploy with `--no-verify-jwt`.
