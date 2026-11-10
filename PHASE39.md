# Veltrix — phase 39: deposit-watch v2, pre-PIN fee quote, scanner locks, failed-tx fees

**Nothing here has been applied to your database or run against a real blockchain.** The SQL was executed only on a throwaway local Postgres 16 with stand-in tables (`supabase/test/phase39/`). The 88 offline checks prove logic against fakes.

## 1. What changed (one line each)
| # | Change | Where |
|---|---|---|
| 1 | One response format (`version: 2`, modes `scan` / `user`). `credited`/`checked`/`failed` are gone. The app refreshes balance + history when deposits change, shows pending/confirming/completed, and shows the exact network error. | `deposit-watch/contract.ts`, `app.js/watchcontract.js`, `app.js/wallet.js` |
| 2 | Users' apps **never scan**. A signed-in call is a read of `wallet_status_for()`. The scheduled call (cron secret) scans. Per-network DB lease locks, fenced cursor/progress writes. | `deposit-watch/index.ts`, `watcher.ts`, phase 39 SQL |
| 3 | `payout-quote`: read-only quote before the PIN (coin, network, recipient, amount, fee, fee coin, total, balance before/after). The Proceed/PIN step stays disabled until a sendable quote loads. | `payout-quote/`, `app.js/script.js` |
| 4 | Paged, resumable sweeps for BTC, LTC, SOL, XRP, TRX with per-address checkpoints that advance only after everything found was recorded. | `deposit-watch/scan.ts` |
| 5 | EVM internal transfers via `trace_filter` or `debug_traceBlockByNumber`; each transfer recorded on its own (ref `int:<from>:<wei>:<n>`). | `scan.ts` |
| 6 | Mined-but-failed sends record the real fee (`payout_fail_mined`, back-filled later if unreadable); the reconciliation view counts it. | `payout-send/core.ts`, `chains.ts`, `index.ts`, SQL |
| 7 | Network identity checks (chain id / genesis / network id, RPC staleness, token contract + decimals). A failed check = no scan and no balance mirroring for that network. | `_shared/netcheck.ts` |

## 2. Deployment order (do not skip; nothing destructive)
1. **Backup**, then run `supabase/schema_phase39_scanner_locks_quotes_failed_fees.sql` on a Supabase *branch / restored copy* first. It is additive (new tables and functions) plus `create or replace` of the view `v_chain_reconciliation` (same columns, one appended) and `chain_deposits_open()`. It deletes and rewrites no data. Everything is granted to `service_role` only.
2. `supabase functions deploy payout-send`, `deposit-watch`, `payout-quote --no-verify-jwt` (quote and deposit-watch check the user themselves).
3. Deploy the front end (`index.html`, `app.js/*`, `app.css/*`).
4. **Cron: call `deposit-watch` every 30–60 s** with header `x-cron-secret: <CRON_SECRET>`. Overlapping runs are harmless (the second reports `busy`), but without the cron nobody scans: the app shows "scanner stale" after 3 minutes.
5. Check: `select * from chain_health;` and `select * from scan_lock;` then `select * from v_chain_reconciliation where abs(drift) > 0;`

**If the SQL is not installed**: deposit-watch refuses to scan (fails closed, tells you which function is missing); payout-send keeps working and falls back to the old `payout_fail` (fee not recorded).

## 3. New environment variables (all optional except the trace provider if you want internal transfers)
`RPC_TRACE_ETH|BNB|AVAX` (URL of an RPC that supports tracing), `TRACE_MODE_<SYM>` = `auto` (default, probes) | `trace_filter` | `debug` | `off`, `GENESIS_BTC|LTC|SOL|TRX`, `NETWORK_ID_XRP`, `CHAIN_ID_ETH|BNB|AVAX` (quote + signer), `DEPOSIT_MAX_PAGES_PER_RUN`, `DEPOSIT_TRACE_BLOCKS_PER_RUN`, `DEPOSIT_MAX_BLOCKS_BNB|AVAX`. Existing ones (`RPC_*`, `API_*`, `TOKEN_*`, `MAX_FEE_*`, `CRON_SECRET`) are unchanged. `payout-quote` should get the same RPC/API/ceiling secrets as `payout-send`.

## 4. EVM internal transfers: what your provider must offer
Contract-sent ETH/BNB/AVAX (a contract paying your address) leaves no log, only a trace. The scanner uses `trace_filter` (Erigon / Nethermind / OpenEthereum style) or `debug_traceBlockByNumber` with `callTracer` (Geth, Erigon, Alchemy/QuickNode/Chainstack "debug" add-ons). Standard public RPCs usually offer neither.
- Without a trace provider the scanner records **top-level** transfers only and reports a warning; it never invents a deposit from a balance increase. The balance mirror still shows the coins and `v_chain_reconciliation` shows the drift, which is the signal to add a provider.
- Alternatives if your provider has no tracing: a paid archive/trace node; an indexer that exposes internal transactions (Etherscan-family `txlistinternal`, Covalent, Moralis, Alchemy Transfers API) — a small adapter would be needed, **not built**; or running your own node.
- Trace progress uses its own cursor (`evmtrace:<SYM>`) so a trace outage can never make the main cursor skip internal transfers. To start tracing from a chosen block, set the first value by hand in the SQL editor (the existing phase 38 function): `select chain_cursor_set('evmtrace:ETH', <block>);`. Without it, tracing starts near the current tip.

## 5. Limits you should know
- The quote is information, not an authorisation: after the PIN, `payout-send` re-validates and recomputes the fee; its existing fee ceilings bound it. If the network fee moves between quote and send the final fee can differ (the history shows the actual fee).
- TRX internal (contract-sent) TRX transfers are not detected. SOL has no SPL tokens, TRX no TRC-20, BNB/AVAX no tokens (unchanged).
- `payout-send` checks the EVM chain id before signing; it does **not** yet check genesis hashes for BTC/LTC/SOL/XRP/TRX (the quote and the watcher do).
- Scanning depth is bounded per run (`DEPOSIT_MAX_PAGES_PER_RUN`); a very busy address takes several runs to finish its sweep and the response reports `unfinished > 0` meanwhile. Nothing is dropped; the checkpoint just has not advanced.
- Public RPCs will rate-limit. Use paid providers.

## 6. What still requires your DB deployment
Everything in §2 step 1; until then the new functions do not exist. Also: confirm the names of the existing phase 37/38 functions the new SQL calls (`record_chain_deposit`, `apply_chain_balance`, `chain_cursor_*`, `payout_fail`) match your deployed project (they do in this repository).

## 7. What still requires real blockchain testing
See `TESTING-REAL-MONEY.md` §6: deposits on each chain, an older deposit behind many newer ones (pagination), a contract-sent ETH transfer on a trace-capable RPC, a mined-but-failed transaction (fee recorded, balance reconciles), a wrong-network RPC refused, token contract/decimals checks, quote vs. actual fee.

## 8. Offline tests
`bash supabase/functions/run-tests.sh` (Node 22+, no network). SQL: `supabase/test/phase39/` (needs a scratch Postgres; `stubs.sql` then `test.sql`, edit the `\i` path in `test.sql`).
