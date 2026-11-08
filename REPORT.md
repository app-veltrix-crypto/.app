# Veltrix — completion report (real-blockchain functions)

**Read this first.** In the build environment there was **no network and no Postgres**. So: **nothing below was run against a real blockchain, a real RPC/API provider or a real database.** What *was* run: the offline tests (23 checks, all passing) — `node --experimental-strip-types supabase/functions/payout-send/test/chains.test.mts` (11, the earlier round, re-run) and `.../deposits.test.mts` (12, new). The new tests use **synthetic fixtures** shaped like documented API answers. "Implemented" below means "code written and unit-tested offline", never "proven on-chain".

## A. Already completed (found in the code, read and re-checked)
- No treasury in the send path: key comes from `payout_signing_phrase()` (service role only, only for a PIN-authorised `processing` send with no hash; each release logged in `tx_auth_events`); signing address must equal the user's address on file or nothing is sent.
- PIN checked server-side in `wallet_withdraw`; one request id = one transaction; atomic balance hold.
- Veltrix→Veltrix is a normal on-chain send (`wallet_transfer` only wraps `wallet_withdraw`).
- Hash stored before broadcast; unclear broadcast keeps funds held (never auto-refunded); expiry-proof failure for SOL/XRP/TRX.
- BTC/LTC/SOL/XRP/TRX transaction building with published test vectors; EVM path (not tested offline — it needs ethers).

## B. Newly implemented in this round
1. **Transaction-level deposits** (`deposit-watch/scan.ts`, `index.ts`, phase 38 SQL): one `transactions` row per incoming output with hash, output ref, sender, receiving address, exact amount, block number/hash/**blockchain** time, confirmations, required confirmations, status `pending → confirming → completed | cancelled | dropped | reorged`. Unique index on `(symbol, tx_hash, tx_output_ref, to_address)`.
2. **Confirmation policy** table `chain_policy` (editable). Displayed balance excludes deposits that are in a block but below policy.
3. **Reorg/duplicate safety:** idempotent `record_chain_deposit`; EVM scan re-reads the last 12 blocks every run; open + recently-final deposits are re-verified; a tx the chain no longer knows is demoted only after **3 consecutive misses**; a lagging node can't lower confirmations.
4. **No balance-increase deposits any more:** `apply_chain_balance` only mirrors the balance.
5. **Actual fees:** after mining, `fee_actual` is read from the chain (EVM receipt gasUsed×effectivePrice, BTC/LTC `fee`, SOL `meta.fee`, XRP `Fee`, TRX `fee`). History shows estimated fee (max), actual fee, total deducted, confirmations, block.
6. **Policy-gated completion:** a send becomes `completed` only when confirmations ≥ policy (checked in the function layer *and* in `payout_complete`). Internal transfers inherit this.
7. **Statuses:** Pending · Broadcasting · Submitted (`broadcast_at`, set only after the network accepted it) · Confirming (n/N) · Confirmed · Failed · Dropped · Replaced · Expired.
8. **EVM replaced/dropped detection** (nonce consumed by another tx, tx unknown to node, 15+ min old).
9. **Private-testing gate** (optional): `send_allowlist` + `send_allowlist_only` flag (trigger refuses sends from other accounts).
10. **Backups/reconciliation:** `_bk38_*` snapshots, `opening_balance`, `v_chain_reconciliation`, `v_phase38_balance_report`.
11. Fixed during review: mined-but-unconfirmed sends were going to be subtracted twice from the displayed balance; now only unmined sends are held.

## C. Verified against actual blockchains
**None.** Verified offline only: address derivation vectors (BTC, LTC, XRP, TRX, SOL, EVM `0x9858…aEda94`), BIP143/SLIP-0010 vectors, a Bitcoin transaction built and signature-verified, per-user key isolation, ERC-20 Transfer topic hash, the parsers in `scan.ts`, and the settlement logic in `core.ts`. **Not verified at all:** EVM `index.ts` (ethers), every RPC/API call, broadcast, receipts, fee reads, the SQL.

## D. Cryptocurrencies fully functional
**None can be claimed.** Nothing has a real transaction behind it. After the matrix in TESTING-REAL-MONEY.md is ticked for a coin, that coin can be called verified.

## E. Per-coin status (code present ≠ proven)
| Coin | Derive | Balance | Deposit tx scan | Build/sign | Broadcast | Fee (est → actual) | Confirm monitor | Gaps |
|---|---|---|---|---|---|---|---|---|
| ETH | ✔ vector | RPC | block walk | ✔ code | ✔ code | max → receipt | ✔ | contract-sent ETH (internal tx) not seen |
| USDT/USDC/SHIB/LINK | ✔ | `balanceOf` | `eth_getLogs` | ✔ code | ✔ code | max (ETH) → receipt | ✔ | need ETH for gas; Ethereum mainnet only; contracts fixed |
| BNB / AVAX | ✔ | RPC | block walk | ✔ code | ✔ code | max → receipt | ✔ | native only (no BEP-20/AVAX tokens); internal tx not seen |
| BTC / LTC | ✔ vector | API | address txs | ✔ **tested offline** | ✔ code | est → `fee` | ✔ | only confirmed UTXOs spent (a 2nd send waits); mempool eviction not detected (flagged after 2 h) |
| SOL | ✔ vector | RPC | signatures+tx | ✔ layout test | ✔ code | flat 5000 lamports → `meta.fee` | finalized | SOL only (no SPL tokens); priority fees unused |
| XRP | ✔ vector | RPC | `account_tx` | ✔ field order test | ✔ code | est → `Fee` | validated | destination tag **not stored on deposits** |
| TRX | ✔ vector | API | TronGrid | ✔ decode test | ✔ code | **no pre-send estimate** → `fee` | solidified | TRX only (no TRC-20) |
Everything above is **partial until proven**.

## F. Remaining bugs / limitations (honest list)
1. **Estimated fee is not shown before the PIN.** It is computed at signing time (after authorization). A pre-authorization quote endpoint was **not built**.
2. Block-walk EVM scanning on public RPCs will hit rate limits; use paid RPCs (`RPC_ETH` etc.). If the cron is down longer than `DEPOSIT_MAX_BLOCKS_PER_RUN` × runs, the scan catches up gradually; the first run only looks back `DEPOSIT_BACKFILL_BLOCKS` (300).
3. Deposits that arrive as contract-internal transfers are not tx-recorded; the balance mirror still shows the coins and `v_chain_reconciliation` will show drift.
4. Mirror vs. record race: between a scan and a balance read (≤ one cron cycle) a deposit changing state can make the displayed balance briefly off; it self-corrects next run.
5. SOL scan reads 25 signatures per address; heavy traffic on one address could push older deposits off that page (open ones are re-checked by hash).
6. BTC/LTC: a long-pending unconfirmed deposit that leaves the first 25-tx page is only tracked by hash via the recheck; address-history paging is not implemented.
7. Imported wallets are credited (phase 37 decision; `credit_imported` no longer applies).
8. Private-testing design: phrases are stored server-side and the admin "Test wallets" screen can read them — to be removed in the production hardening you will request.
9. The whole SQL (phase 37 + 38) is untested against your schema.
10. `auto_withdraw` rows with a PIN-authorised send still queue under one lane per network: one stuck tx delays others on that network.

## G. Migration + backup → MIGRATION.md.  Short version: backup → read `v_phase38_balance_report` → 37 → 38 on a branch → real.

## H. Secrets / environment
Required: `CRON_SECRET`. Provided by Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Vault key for `_wallet_key()` (phase 8/9 set-up, unchanged).
Strongly recommended (paid providers): `RPC_ETH`, `RPC_BNB`, `RPC_AVAX`, `RPC_SOL`, `RPC_XRP`, `API_BTC`, `API_LTC`, `API_TRX` + `TRONGRID_API_KEY`.
Optional: `DEPOSIT_BACKFILL_BLOCKS` (300), `DEPOSIT_MAX_BLOCKS_PER_RUN` (40), fee ceilings `MAX_FEE_GWEI_ETH|BNB|AVAX`, `MAX_FEE_RATE_BTC|LTC`, `MAX_FEE_DROPS_XRP`, `TOKEN_*` overrides. Confirmation policy lives in the **database** (`chain_policy`), not in env.

## I. Enabling private testing — and exactly how `auto_withdraw` works
`app_flags(key='auto_withdraw')` is one global boolean, checked in **two** places: `wallet_withdraw` (off ⇒ returns `unavailable`, nothing held, nothing queued) and `payout_claim` (off ⇒ returns null, nothing is signed even if rows are queued). It is a master on/off kill switch, **not** an authorization bypass: with it on, the PIN, the sender's own key, address/amount/coin checks and one-broadcast-per-request all still apply. Because it is global, add the optional gate to limit it to your accounts:
```sql
insert into send_allowlist(user_id) values ('<your user id>'), ('<second test user id>');
update app_flags set enabled = true where key = 'send_allowlist_only';
update app_flags set enabled = true where key = 'auto_withdraw';   -- kill switch: set false
```

## J. First real deposit and withdrawal → TESTING-REAL-MONEY.md (sections 1–2).

## K. Still requires your real-wallet testing
Everything on-chain: each cell of the matrix in TESTING-REAL-MONEY.md §4, plus: EVM send path, ERC-20 sends with real gas, XRP tag handling, SOL first-transfer rent rule, a deliberate stuck/replaced transaction, and a reorg-sensitive case (cannot be forced; watch `reorg_count`).
