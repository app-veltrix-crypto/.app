# payout-send — REAL on-chain sending, signed with the SENDING USER's own wallet (private-testing build)

**No treasury. No simulated sends.** Every send (to an outside wallet like Trust Wallet / Binance / MetaMask, or to another Veltrix user) is a real
blockchain transaction, signed by this function with the sender's own key and paid for by the sender's own address (amount + network fee).
Nothing leaves until you flip the switch below.

## Flow
1. User taps Send → `wallet_withdraw()` (database) checks the 2FA PIN **on the server**, address format, coin/network, and that the *available*
   balance covers the amount, then holds it and queues the send. Each PIN decision is written to `tx_auth_events`. The same request id can never
   create a second send.
2. This function claims the send (`queued → processing`) and fetches the sender's key through `payout_signing_phrase()` (service role only, only for a
   PIN-authorised send that has not been signed yet; each release is logged).
3. It builds and signs the transaction, and **refuses to continue unless the signing address equals the user's own address on file**.
4. The hash is stored **before** broadcast; then it broadcasts. If it is unclear whether it went out, the amount stays held (never auto-refunded).
5. It reports `completed` only when the network has mined it successfully. A refused/failed/expired transaction is returned to the user.
6. `deposit-watch` (every ~20 s) re-reads the confirmed on-chain balance; the app balance is **set** to `on-chain balance − sends still in flight`.

Statuses in history: Pending (queued) · Broadcasting (signing/sending) · Confirming (hash known) · Confirmed · Failed.

## Coins (real derivation + balance read + signing + broadcast)
ETH, USDT, USDC, SHIB, LINK (Ethereum) · BNB (BNB Smart Chain) · AVAX (Avalanche C-Chain) · BTC, LTC (native SegWit) · SOL · XRP (destination tag) · TRX.
Token sends (USDT/USDC/SHIB/LINK) need a little ETH **in the sender's own address** for gas; the app says so if it is missing.

## Set-up (in this order)
1. SQL editor, in order if not yet run: phases 13, 14, 15, 17, 18, 19, 21, then **`schema_phase37_real_onchain.sql`**.
   ⚠ After phase 37 the app balance follows the chain: any balance that exists only in the database (old DB-only transfers, old credits) will drop to what the address really holds.
2. `supabase secrets set CRON_SECRET="<long random string>"`   (`TREASURY_MNEMONIC` is no longer read — `supabase secrets unset TREASURY_MNEMONIC`)
3. `supabase functions deploy payout-send --no-verify-jwt` and `supabase functions deploy deposit-watch --no-verify-jwt`
4. Schedule both every minute (Supabase → Integrations → Cron) with header `x-cron-secret: <CRON_SECRET>`.
5. Turn sending on:  `update public.app_flags set enabled = true where key = 'auto_withdraw';`   Kill switch: set it to `false`.

### Optional secrets
RPC/API providers (defaults are free public endpoints; use paid ones for real traffic): `RPC_ETH`, `RPC_BNB`, `RPC_AVAX`, `API_BTC`, `API_LTC`, `RPC_SOL`, `RPC_XRP`, `API_TRX`, `TRONGRID_API_KEY`.
Fee ceilings (a send waits and retries instead of overpaying): `MAX_FEE_GWEI_ETH` (60) `MAX_FEE_GWEI_BNB` (10) `MAX_FEE_GWEI_AVAX` (80) `MAX_FEE_RATE_BTC` / `MAX_FEE_RATE_LTC` (100 sat/vB) `MAX_FEE_DROPS_XRP` (5000).
Test networks: `RPC_ETH` + `CHAIN_ID_ETH=11155111` (+ `TOKEN_*` addresses), `RPC_SOL` (devnet), `RPC_XRP=https://s.altnet.rippletest.net:51234`, `API_TRX=https://api.shasta.trongrid.io`.
There are no amount limits. The checks that remain: sufficient real funds incl. fee, valid address for the chosen coin/network, correct PIN, one broadcast per request, correct nonce per address.

## Verified so far (offline only — NO blockchain was touched)
`node test/chains.test.mts` (no network needed): published address/signature test vectors (BIP173/350, BIP143, SLIP-0010, XRP, TRON decode), Bitcoin transaction built
and signature-verified from a user's own phrase, **two different users produce two different sending addresses**, **no phrase = nothing is signed**, empty wallet is refused before signing.
**Not yet run against a real chain:** the EVM path (`index.ts`), broadcasting, receipts, deposit detection, the SQL in phase 37. Prove each with a testnet or a tiny real amount first.

## UPDATE — phase 38 (see ../../../REPORT.md)
Completion now needs the confirmation policy (`chain_policy`), the ACTUAL fee is read after mining, `deposit-watch` is transaction-level (see its scan.ts), statuses add Submitted / Dropped / Replaced / Expired. The 'Known limits' below about balance-only deposits, first-confirmation completion and max-estimate fees describe the OLD behaviour and are superseded; the rest still applies. Run the new offline tests with `node --experimental-strip-types test/deposits.test.mts`.

## Known limits
- Deposits are detected from the confirmed **balance** increase (one history row per increase, no sender hash, no confirmation counter). Transaction-level indexing is not built.
- Confirmation count is not shown; "Confirmed" means the first confirmation (EVM/BTC/LTC), finalized (SOL), validated (XRP), solidified (TRX).
- The fee shown is the maximum estimate recorded at signing time, not the exact mined fee.
- Sends on the same network are processed one after another (one lane per network), so one stuck transaction delays others on that network.
- A balance can be overstated for up to ~20 s right after a send is mined, until the next balance read.
- Private-testing only: phrases are stored server-side (encrypted with the Vault key) and the admin "Test wallets" screen can read them. Remove both before public launch.

## When something is stuck
Only one case needs a person: it is UNCLEAR whether a transaction was broadcast. Check its hash on the explorer, then (as admin):
- it arrived: `select admin_resolve_payout('<transaction id>', 'complete', '<tx hash>');`
- it never left: `select admin_resolve_payout('<transaction id>', 'refund', null, 'Could not be sent');`

## Phase 39 additions
- Mined-but-failed sends: `failedDetail` (SOL/XRP/TRX/EVM) reads the fee; `core.ts` settles through `payout_fail_mined` (falls back to `payout_fail` if phase 39 is absent); `reconcile()` back-fills fees that could not be read.
- `planUtxoSpend` is shared by `prepare()` and the `payout-quote` function, so the quoted BTC/LTC fee is the fee that is signed.
- Offline tests: `test/failed-fee.test.mts` (plus the existing two). Run all with `bash supabase/functions/run-tests.sh`.


## Network identity (v4)
For BTC, LTC, SOL, XRP and TRX the signer proves the network itself: before any coin is read or key derived (`retry`: nothing signed) and again right before broadcast (`definite`: nothing sent), on the same endpoint it will use. Genesis hash (BTC/LTC/SOL/TRX) or network id + fresh validated ledger (XRP); expected values follow `GENESIS_*` / `NETWORK_ID_XRP`. EVM coins were already bound to the chain id in `prepare()` and by the signature itself. Tests: `test/network-identity.test.mts`. See PHASE40.md.
