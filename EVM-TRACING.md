# EVM internal (contract-sent) deposits — exact RPC requirements for ETH, BNB and AVAX

**Honest status.** Whether *your* RPC provider supports tracing could **not** be confirmed from here: the build environment had no internet. What I can give you is (a) the exact requirement, (b) a diagnostic that asks your provider the same questions the deployed watcher asks, and (c) a watcher that **says so out loud** when tracing is missing. Until you have run the diagnostic and passed the positive control below, treat internal deposits on ETH / BNB / AVAX as **not confirmed**.

## 1. What an "internal" deposit is, and why a normal RPC cannot see it
A top-level transfer (`from` you → `to` Veltrix address) is visible in the block's transaction list. A deposit paid by a **contract** (exchange payout contract, forwarder, multisig, swap router, a Safe) is a *call inside another transaction*: the transaction's `to` is the contract, not your address. `eth_getBlockByNumber`, `eth_getTransactionByHash` and receipts never show it, and no event is emitted for a native-coin transfer. Only an **execution trace** shows it. Without tracing the coin does arrive on-chain, the balance mirror (`eth_getBalance`) will show it, but **no deposit row is recorded** and `v_chain_reconciliation` shows a drift. That is exactly what the watcher reports as a warning (below).

## 2. The exact methods (the watcher uses exactly these)
The watcher needs **one** of the two families, on a node that has them enabled for **recent blocks** (and, for catching up after an outage, for older ones):

| Mode | Methods called | Notes |
|---|---|---|
| `trace_filter` (Erigon/OpenEthereum/Nethermind/Reth style) | `trace_filter` with `{fromBlock, toBlock, toAddress:[…], count, after}` (paged); `trace_transaction(hash)` (to discard transfers under a reverted call) | Cheapest: filtered server-side by receiving address. |
| `debug_trace` (geth style) | `debug_traceBlockByNumber(block, {"tracer":"callTracer"})` — one answer per transaction, nested `calls[]` | One call per block; heavier. Needs the **callTracer** (not the default struct logger). |

Also required on whichever endpoint serves the trace: `eth_chainId` (identity check), `eth_blockNumber`, `eth_getBlockByNumber`. Mode is chosen automatically (`TRACE_MODE_<SYM>` = `auto` · `trace_filter` · `debug_trace` · `off`) by a probe that treats "method not found" as *unsupported* and any other failure as *temporary*.

Configuration (Supabase secrets): `RPC_ETH` / `RPC_BNB` / `RPC_AVAX` (main), optional `RPC_TRACE_ETH` / `RPC_TRACE_BNB` / `RPC_TRACE_AVAX` (a separate tracing provider; if unset the main RPC is used), `TRACE_MODE_<SYM>`, `DEPOSIT_TRACE_BLOCKS_PER_RUN` (default 2000 for trace_filter), `DEPOSIT_BACKFILL_BLOCKS` (default 300: how far back the very first run looks).

**Changed in this version:** a separate `RPC_TRACE_<SYM>` is now **identity-checked** (chain id, freshness) before anything it says is believed. Before, only the main RPC was. A trace endpoint on the wrong chain is now a red error for that chain and no trace call is sent to it.

## 3. How the watcher reports it (never silently)
* No tracing method on the endpoint → warning `"<SYM>: internal (contract-call) transfers are NOT monitored: this RPC has no trace_filter / debug_traceBlockByNumber. Set RPC_TRACE_<SYM> to a tracing provider."` and `chain_health.detail.internalTransfers` ≠ `"ok"`. Top-level transfers and balances still work.
* Probe failed for another reason → warning that it could not be proven; retried next run.
* Trace endpoint on the wrong chain / stale → **error** (the chain shows not-ok).
* `TRACE_MODE_<SYM>=off` → warning that it is disabled.
Read it with: `select network, ok, error, detail from chain_health;` (and the function response's `warnings`).

## 4. Confirm YOUR provider — run this (reads only; sends nothing)
```
RPC_ETH=https://…  RPC_TRACE_ETH=https://…   \
node --experimental-strip-types --no-warnings supabase/functions/deposit-watch/tools/check-evm-trace.mts ETH BNB AVAX
```
Needs Node 22+. Use the **same URLs as your Supabase secrets**. For each chain it checks, in order: chain id of the main RPC and of the trace RPC · which trace family answers · a real recent read parsed the way the watcher parses it · `trace_transaction` · **how far back tracing works** (50 / 300 / 2000 / 10000 blocks; compare with `DEPOSIT_BACKFILL_BLOCKS`) · optionally a **positive control**. Verdict per chain: `FULL`, `PARTIAL` (works with the listed limits) or `NOT MONITORED` (it says in words that internal transfers cannot be completely monitored). Exit code `0` only if every requested chain is FULL, `2` otherwise.

**Positive control (do it once per chain; it is what really proves it).** Find a real past transaction in which a contract paid native coin to some address (block explorer → a contract call → "Internal Txns" tab), then:
```
CHECK_INTERNAL_TX_ETH=0x<tx hash>  CHECK_INTERNAL_TO_ETH=0x<the receiving address>  RPC_ETH=… RPC_TRACE_ETH=…  node … check-evm-trace.mts ETH
```
It runs the **production scanner** over that block and requires it to report that exact transfer. Pick a *recent* transaction (older ones need archive-depth tracing, which the history test measures separately). Then finish with a live test: TESTING-REAL-MONEY.md §6.

## 4b. What "FULL" does and does not mean
FULL = every call the watcher makes worked on your provider *today* and the first-run look-back is covered. It is not a guarantee of future uptime, rate limits or plan changes; if the provider later returns "method not found" the watcher turns that into the warning above on the next run. Provider plans change; I deliberately do not list which providers include tracing: ask the tool.

## 5. If tracing is unavailable
State it to yourself plainly: **internal transfers cannot be completely monitored on that chain.** Options: (1) add a tracing provider and set `RPC_TRACE_<SYM>`; (2) accept the gap for private testing and only receive plain wallet-to-wallet transfers on that chain (the drift view will flag anything else); (3) never tell a user that a contract payout will be credited. There is no workaround that avoids tracing for native-coin contract payments.

## 6. Tests that exist (offline, fakes only)
`deposit-watch/test/evm-internal.test.mts` (14 checks: both families, reverted calls, paging, cursor) and `deposit-watch/test/trace-tool.test.mts` (9 checks: the diagnostic against local fake providers incl. no-tracing, no `trace_transaction`, shallow history, wrong chain, exit codes; and the trace-endpoint identity check in the watcher). They prove the code's logic, not any provider.
