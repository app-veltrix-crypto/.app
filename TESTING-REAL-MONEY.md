# Veltrix — real-money test checklist (v4)  ·  private testing, your own wallets, amounts you can afford to lose

**Nothing in this repository has been broadcast to a real chain by the author.** Every box is **unchecked until you tick it** with evidence (explorer link + SQL output). Do one coin at a time, cheapest first (LTC, TRX, SOL), tiny amounts. If anything differs from this list, **stop**, keep the SQL output and the explorer link, and send them to me; do not "fix" balances by hand.

Financial rules being tested — the test fails if any is violated: **(R1)** every send is signed with the *sender's own* wallet key and leaves the sender's own address; **(R2)** the sender pays the network fee out of their own funds; **(R3)** Veltrix never contributes treasury funds (there is no treasury key: if a send ever leaves from an address that is not the sender's, stop).

Evidence log: keep a note per step: date, coin, amount, tx hash, explorer URL, the SQL result. §13 is the summary.

## 0. Preconditions (once)
- [ ] Database migrated on a restored copy first, then live: **MIGRATION.md §8** (preflight → backup_before_37 → 37 → 38 → 39 → postflight all green).
- [ ] Functions `deposit-watch`, `payout-quote`, `payout-send` deployed **after** the SQL; secrets set (README of each); cron on `deposit-watch` every 30–60 s with `x-cron-secret`.
- [ ] `auto_withdraw = false` (sending OFF) until §8. Kill switch: `update app_flags set enabled=false where key='auto_withdraw';`
- [ ] `select * from chain_policy;` shows the confirmations you want (change with `update chain_policy set required_confirmations=… where symbol=…`).
- [ ] Two Veltrix accounts **A** and **B**, each with a PIN. `select id, email from auth.users;`
- [ ] Optional private gate: `insert into send_allowlist(user_id) values ('<A>'),('<B>'); update app_flags set enabled=true where key='send_allowlist_only';`
- [ ] **Networks proven before any money moves** (§2).

## 1. Wallet importation
The app derives **one address per coin at index 0** (BTC m/84'/0'/0'/0/0 · LTC m/84'/2'/0'/0/0 · ETH/BNB/AVAX/ERC-20 m/44'/60'/0'/0/0 · XRP m/44'/144'/0'/0/0 · TRX m/44'/195'/0'/0/0 · SOL m/44'/501'/0'/0'). Coins at other indexes/paths of the same phrase are **not seen**.
1. [ ] Import a **new empty** phrase you generated for the test (not your main wallet). read the addresses in the app (Receive screen for each coin), and `select user_id, addresses from user_wallets where user_id='<A>';`.
2. [ ] Compare **each** address with the same phrase imported into an independent wallet (e.g. Ian Coleman's BIP39 tool **offline**, or a hardware wallet). Every coin you will test must match character for character. A mismatch = stop; that coin's address would not be the one your other wallet shows.
3. [ ] Importing the same phrase into a second Veltrix account is **refused** (one account per phrase).
4. [ ] The phrase is stored encrypted: `select user_id, octet_length(phrase_enc) from user_wallets;` shows only encrypted bytes (never text); the signer reads it only through `payout_signing_phrase()` (service role). *(Private-testing only: the admin "Test wallets" screen can read phrases; remove before any public launch.)*
5. [ ] After import the app balance is **0** (it mirrors the chain; there is no credit for importing).
6. [ ] If the imported wallet already holds coins: the balance appears only after the first watcher run; those coins are the `opening_balance`, **not** a deposit row (expected).

## 2. Network & provider proof (no money moves)
- [ ] `select network, ok, last_ok_at, error, detail from chain_health order by network;` → every network `ok = true`, `last_ok_at` within a minute.
- [ ] **EVM tracing:** run `check-evm-trace.mts` (EVM-TRACING.md §4) for ETH, BNB, AVAX with your real URLs. Write down the verdict per chain: ETH ☐ FULL/PARTIAL/NOT · BNB ☐ · AVAX ☐. Where it is not FULL, internal deposits on that chain are **not** monitored — accept that knowingly.
- [ ] **TRX internal scanning:** `select detail->>'internalTransfers' from chain_health where network='TRX';` → `solidified-block walk` (not `unsupported`/`error`/`off`). If `unsupported`, your TRON API does not serve `/walletsolidity/gettransactioninfobyblocknum`.
- [ ] **Wrong-network refusal (on the copy/branch, never live):** point `API_BTC` at the Litecoin API → a send attempt fails with `Network identity check failed; nothing was signed`, no row leaves `processing` with a hash, balance unchanged. Repeat for LTC, SOL (devnet RPC), XRP (testnet URL), TRX (a different chain's API).
- [ ] Token contracts: `select ok, error from chain_health where network='ETH';` → `ok = true` and no token problem in `error` (the check verifies each contract is the canonical one for chain 1, has code, and the decimals match).

## 3. Real deposits (external wallet → Veltrix A)
For each coin: send a tiny amount from an external wallet **you control** to A's address shown in the app (read the network line on the screen).
- [ ] The address you paid equals A's address in `user_wallets`.
- [ ] Tokens: only **USDT/USDC/SHIB/LINK on Ethereum**. Do **not** send BEP-20/TRC-20/SPL/Avalanche tokens (TOKENS.md §C): they would not be seen.
- [ ] XRP: once **with** and once **without** a destination tag (the deposit address is shared per wallet: record what happens).
- [ ] SOL: a first transfer to a brand-new account must be ≥ 0.00089088 SOL (rent).

## 4. Deposit detection
1. Within ~1 minute: the app history shows **Incoming deposit — Pending** (0 confirmations) or **Confirming (n/N)**.
2. `select status, tx_hash, tx_output_ref, from_address, to_address, amount, block_number, block_time, confirmations, required_confirmations from transactions where kind='deposit' order by created_at desc limit 5;`
   - [ ] `tx_hash` = explorer hash · [ ] `amount` = what the explorer shows **for that output** (not the wallet total) · [ ] `from_address` = sender · [ ] `to_address` = A's address · [ ] `block_time` = explorer time.
3. [ ] Let cron run many times: still **exactly one** row per `(tx_hash, tx_output_ref, to_address)`: `select tx_hash, tx_output_ref, count(*) from transactions where kind='deposit' group by 1,2 having count(*)>1;` → empty.
4. [ ] **Outage catch-up:** stop the cron 10 minutes, deposit, restart → found once. (EVM native: only within `DEPOSIT_MAX_BLOCKS_PER_RUN` × runs.)
5. [ ] **Pagination (LTC/TRX are cheap):** one deposit, then 30+ small later transactions, stop and restart cron → the OLD deposit is still there once.
6. [ ] **Contract-sent deposits (only where §2 says monitored):**
   - TRX: have a small contract/forwarder pay A's TRX address; a row with `tx_output_ref like 'int:%'` appears once, `confirmations = 1`.
   - ETH/BNB/AVAX: same with a forwarder contract; a row `int:…` appears once. On a chain whose §2 verdict is not FULL: expect the **warning** and **no** row, and the balance mirror to show the coin with a drift: confirm that this is what you see.
7. [ ] A transaction below the policy depth shows "Added to your balance after N confirmations".

## 5. Actual balance updates
- [ ] While the deposit is `pending`/`confirming` the app balance **does not include it**; it rises only when the row is `completed`.
- [ ] App balance = on-chain confirmed balance − sends in flight − deposits below policy: compare with the explorer: `select a.symbol, a.amount, s.last_balance from assets a join chain_state s using (user_id, symbol) where a.user_id='<A>';`
- [ ] `select * from v_chain_reconciliation where user_id='<A>' and symbol='<COIN>';` → `drift` ≈ 0 (a small positive drift is expected only for sends made before phase 38).
- [ ] Open the app in two browsers at once: no extra scans (`scan_lock` shows one holder per network; function logs show no per-browser scan).

## 6. Fee quotations (before any PIN)
- [ ] The quote screen shows a fee **before** the PIN step, in the coin the sender pays it in (token sends: ETH).
- [ ] **No** `transactions` row exists until the PIN step: `select count(*) from transactions where user_id='<A>' and created_at > now() - interval '5 minutes' and kind='send';`
- [ ] Quote for an amount larger than the balance / for an invalid address / for an address of the wrong network is refused with a clear message.
- [ ] Wrong network behind the quote endpoint (branch only): the quote refuses rather than inventing a fee.
- [ ] After the send: actual fee ≤ quoted maximum (EVM), and equals it for BTC/LTC/SOL when the network did not move (§10).

## 7. PIN authorization
- [ ] Correct PIN → `select event, created_at from tx_auth_events where user_id='<A>' order by id desc limit 10;` shows `pin_ok`, `accepted`, `signing_key_used` for that send only.
- [ ] Wrong PIN → `bad_pin`, nothing queued, balance unchanged; repeated wrong PINs are throttled.
- [ ] Double tap / flaky-network resend of the same request → **one** transaction.
- [ ] Kill switch off (`auto_withdraw=false`) → the send is refused and no key is used (`signing_key_used` absent).
- [ ] Allow-list on and user not listed → refused.

## 8. Real withdrawals (A → your external wallet)  — turn sending on only now
`update app_flags set enabled=true where key='auto_withdraw';`
1. [ ] Send a small amount to **your own external address**; enter the PIN.
2. [ ] Status moves Pending → Broadcasting → Submitted → Confirming (n/N) → Confirmed (some steps may be too quick to see).
3. [ ] The external wallet receives **exactly** the amount; the explorer hash = `transactions.tx_hash`.
4. [ ] **R1:** the explorer shows the sending address = A's deposit address (never another address). **R3:** no other address of yours/Veltrix's pays anything.
5. [ ] A's address on-chain decreased by amount + fee (**R2**). Token sends: tokens decreased by the amount and **ETH** by the fee.
6. [ ] Withdrawal of the **whole** balance and of more than the balance behave as the app says (refused before signing, nothing broadcast).
7. [ ] XRP to an address that requires a destination tag; SOL to a new account below rent: refused with a clear message.

## 9. Veltrix-to-Veltrix on-chain transfer (A → B)
- [ ] A pastes **B's real deposit address** for the coin and sends a small amount (PIN).
- [ ] A's row becomes Confirmed only at policy depth; **B gets its own `deposit` row with the same hash**; B's balance rises only when B's row is `completed`.
- [ ] No database-only movement: `select * from v_phase38_internal_rows;` shows no new rows; `select count(*) from transactions where internal` unchanged.
- [ ] The fee was paid by A (A's on-chain decrease = amount + fee); B received exactly the amount; nothing came from any other address.

## 10. Actual transaction fees
- [ ] `select fee_estimate, fee_actual, fee_symbol, status from transactions where id='<tx>';` → `fee_actual` equals the explorer's fee (read from the receipt/transaction, not estimated) and ≤ `fee_estimate` where the estimate is a maximum.
- [ ] `v_chain_reconciliation.drift` ≈ 0 after the send settles.
- [ ] Record: coin, quoted fee, actual fee, difference (§13).

## 11. Transaction confirmations
- [ ] Confirmations in `transactions.confirmations` track the explorer; status flips to `completed` only when `confirmations ≥ required_confirmations`.
- [ ] A send is never shown Confirmed earlier than that.
- [ ] Re-check of completed deposits within `reorg_watch_depth`: no change expected (a reorg cannot be provoked on purpose; record "not tested").

## 12. Failed transaction reconciliation
Each case must end with: the sender's money returned **or** the on-chain outcome recorded; no double debit; no credit without a chain transaction; `drift` ≈ 0.
- [ ] **Rejected before signing** (wrong network behind the endpoint — branch only): status returns/never leaves queued, `Network identity check failed; nothing was signed`, balance intact.
- [ ] **Nothing sent** (broadcast endpoint down on a branch): the row is `cancelled` (`failure_kind`), the held amount is back in `assets`, `tx_hash` explained in `cancel_reason`; the explorer shows no such hash.
- [ ] **Mined but failed (EVM):** e.g. an ERC-20 transfer with too small a gas limit on a **testnet**: the user gets the amount back, the history shows the **real fee** (`fee_actual`), `payout_fail_mined` recorded it, `drift` ≈ 0 (`of_which_failed_tx_fees` > 0).
- [ ] **Unclear** (hash stored, outcome unknown): the row stays held (not refunded), is retried by reconciliation, and after the window is flagged for you — verify on an explorer, then follow `recovery_37_39.sql` R5. Never by editing `assets`.
- [ ] **Dropped / replaced / expired** (`failure_kind`): recorded with that kind, money returned.
- [ ] After each case: `select * from v_chain_reconciliation where abs(drift) > 0;` → explain every row or send it to me.

## 13. Per-coin result table (tick only with chain evidence)
| Coin | wallet match | deposit seen | confirmations | balance update | quote | withdrawal | actual fee = explorer | A→B | contract-sent deposit |
|---|---|---|---|---|---|---|---|---|---|
| LTC | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |
| BTC | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |
| SOL | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |
| XRP | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |
| TRX | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| ETH | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ (tracing) |
| BNB | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ (tracing) |
| AVAX | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ (tracing) |
| USDT / USDC / SHIB / LINK (ETH gas) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | n/a |

A coin may be called **fully functional only when its whole row is ticked.**

## 14. Stop immediately if
A send leaves an address that is not the sender's · a fee is taken from anyone but the sender · a balance rises without a chain transaction · a deposit row appears twice · `chain_health` shows a wrong-network error and a send still goes out · `drift` grows and you cannot explain it. Then: `update app_flags set enabled=false where key='auto_withdraw';`, stop the cron, keep the evidence, send it to me.
