# Veltrix — real-money test procedure (you authorize every step; use amounts you can afford to lose)

Nothing in this repository has been broadcast to a real chain by the author. Every box below is **unchecked until you tick it**.
Use your own wallets only. Start with the cheapest chain and a **tiny** amount; do one coin at a time.

## 0. Preconditions (once)
- [ ] Phases 37 + 38 applied (MIGRATION.md), both functions deployed, cron every minute with `x-cron-secret`.
- [ ] `select * from chain_policy;` shows the confirmation policy you want (edit with `update chain_policy set required_confirmations = … where symbol = …`).
- [ ] Two Veltrix accounts (A and B), each with a PIN. Note their user ids: `select id, email from auth.users;`
- [ ] Optional private gate: `insert into send_allowlist(user_id) values ('<A id>'),('<B id>'); update app_flags set enabled = true where key='send_allowlist_only';`
- [ ] Sending ON: `update app_flags set enabled = true where key = 'auto_withdraw';`  (kill switch: set `false`)

## 1. Deposit (external wallet → Veltrix A)  — start with LTC or TRX or SOL (cheap fees)
1. In A's app copy the deposit address for the coin. Send a tiny amount from your external wallet.
2. Within ~1 minute the app history should show **Incoming deposit / Pending** (0 conf) or **Confirming (n/N)**.
3. In the SQL editor: `select status, tx_hash, tx_output_ref, from_address, to_address, amount, block_number, block_time, confirmations, required_confirmations from transactions where kind='deposit' order by created_at desc limit 5;`
   - [ ] `tx_hash` equals the hash in your external wallet / the explorer
   - [ ] `amount` equals what the explorer shows **for that output** (not the wallet's total)
   - [ ] `from_address` equals the sender; `to_address` equals A's address; `block_time` matches the explorer
4. Wait for the policy depth. [ ] status becomes `completed`; [ ] the app balance rises **only then** (before that it must not include this deposit).
5. Run it again / let cron run several times: [ ] still exactly **one** row for that tx (`select count(*) … group by tx_hash, tx_output_ref`).
6. [ ] `select * from v_chain_reconciliation where user_id = '<A>' and symbol = '<COIN>';` → `drift` ≈ 0.

## 2. Withdrawal (Veltrix A → your external wallet)
1. In A's app, send a small amount to your external address; enter the correct PIN. Note the **estimated fee** shown.
2. Watch the status: Pending → Broadcasting → Submitted → Confirming (n/N) → Confirmed. [ ] each step appears (some may be too quick to see).
3. [ ] The external wallet receives the amount; [ ] the explorer hash equals `transactions.tx_hash`.
4. [ ] `fee_actual` equals the fee on the explorer (it is read from the receipt/transaction, not estimated); [ ] it is ≤ the estimate.
5. [ ] Total deducted on A's address = amount + actual fee (token sends: fee is paid in ETH — keep a little ETH in A's address).
6. [ ] `select event, created_at from tx_auth_events where user_id='<A>' order by id desc limit 10;` shows `pin_ok`, `accepted`, `signing_key_used`.
7. Wrong-PIN check: [ ] a wrong PIN logs `bad_pin` and nothing is queued.
8. Double-submit check: [ ] sending the same request twice (flaky network / double tap) creates ONE transaction.

## 3. Veltrix A → Veltrix B (on-chain)
1. In A's app paste B's deposit address for the coin and send a small amount.
2. [ ] A's row says Confirmed only after the policy depth; [ ] B gets a **deposit** row with the same hash; [ ] B's balance rises only after B's row is `completed`.
3. [ ] No database-only movement: `select * from v_phase38_internal_rows` shows no new rows.

## 4. Per-coin matrix (tick when proven with a real transaction)
| Coin | deposit seen | confirmations counted | withdrawal | actual fee | A→B |
|---|---|---|---|---|---|
| LTC / BTC / SOL / XRP / TRX | ☐ | ☐ | ☐ | ☐ | ☐ |
| ETH / BNB / AVAX | ☐ | ☐ | ☐ | ☐ | ☐ |
| USDT / USDC / SHIB / LINK (need ETH for gas) | ☐ | ☐ | ☐ | ☐ | ☐ |

## 5. Things to try deliberately
- [ ] Send **below** your deposit policy depth and confirm the app shows "Added to your balance after N confirmations".
- [ ] XRP: deposit **with** and **without** a destination tag; send **to** an address that needs a tag.
- [ ] SOL: first transfer to a brand-new account must be ≥ 0.00089088 SOL (rent).
- [ ] Stop the cron for 10 minutes, deposit, restart: [ ] the deposit is found (EVM native: only if within `DEPOSIT_MAX_BLOCKS_PER_RUN`× runs; see report F).

If anything differs, copy the SQL output and the explorer link to me; do not "fix" balances by hand in the database.
