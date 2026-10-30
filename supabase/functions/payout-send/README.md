# payout-send — automatic withdrawals to outside wallets (Binance, Bybit, any address)

**Status: NOT turned on. Nothing is sent automatically until you complete the checklist below.**
There is NO admin approval any more. Until the switch is on, an outside withdrawal is refused ("temporarily unavailable") and no money is held.

## What it does
User taps Send → enters an address that is not a Veltrix wallet → server checks PIN / address / balance / limits and **holds** the amount
→ the withdrawal is `queued` and this function sends it **from the treasury wallet** (the treasury pays the network fee) and records the transaction hash.
A request above your limits, for an unsupported coin, or while the switch is off is refused up front and nothing is held.

Coins that can be sent to outside wallets:
- Ethereum-style (`index.ts`): ETH, USDT, USDC, SHIB, LINK (Ethereum), BNB (BNB Smart Chain), AVAX (Avalanche C-Chain)
- Added in phase 18 (`chains.ts`): **BTC** (native SegWit, sends to `bc1…`, `1…`, `3…`), **LTC** (`ltc1…`, `L…`, `M…`), **SOL**, **XRP** (with optional destination tag), **TRX**

These are the ONLY coins the wallet supports. DOGE, TON, ADA, XLM, BCH, SUI, HBAR and DOT were removed completely (phase 19) because they cannot be sent to outside wallets. A recovery phrase that supports thousands of coins is narrowed down to the coins above.

## Why a treasury wallet
A user's own deposit address usually holds no gas coin, and money received from another Veltrix user only exists in the ledger. So payouts come
from one treasury wallet that **you** fund (and refill from the user deposit addresses, which you can sweep with their phrases in Admin).
Keep only what you need in it.

## Safety rules built in (tested against a real database)
- the 2FA PIN is checked on the server; an app that skips it cannot withdraw
- amount is held first; one withdrawal at a time per user; per-send and per-day dollar limits (below)
- the transaction hash is saved **before** broadcasting; if it cannot be saved nothing is broadcast
- if it is unclear whether a broadcast happened, the money stays held and is **never** refunded automatically; the hash is looked up later
- refund only when the network explicitly refused it, nothing was sent, or it was mined as failed
- completed only after the transaction is mined successfully
- one payout at a time (treasury nonce); fees above your ceiling postpone the payout; after 3 tries that never reached the network it is cancelled and the money returned automatically
- kill switch: `update public.app_flags set enabled = false where key = 'auto_withdraw';`

## Set-up (in this order)
1. Run `schema_phase13_send_to_users.sql`, `schema_phase14_outside_withdrawals.sql`, `schema_phase15_no_admin_approval.sql`, then `schema_phase18_more_coins.sql`, then `schema_phase19_sendable_coins_only.sql` in the SQL editor.
   **Run phase 18 BEFORE deploying this version of the function** (the function calls `payout_queue()` and the new `payout_set_hash()`).
2. Create a NEW wallet used only as the treasury (any wallet app, 12 words). Its address is the same on Ethereum, BNB Chain and Avalanche.
3. `supabase secrets set TREASURY_MNEMONIC="…12 words…" CRON_SECRET="<long random string>"`
4. `supabase functions deploy payout-send --no-verify-jwt`
   Then ask it where the treasury lives, and fund **each** address with the coin it pays out (see "Funding the treasury" below):
   `curl -X POST https://<project>.supabase.co/functions/v1/payout-send -H "x-cron-secret: <CRON_SECRET>" -H "content-type: application/json" -d '{"action":"addresses"}'`
5. Schedule it every minute (retries, confirmations): Supabase → Integrations → Cron (or any scheduler) → POST
   `https://<project>.supabase.co/functions/v1/payout-send` with header `x-cron-secret: <CRON_SECRET>`.
6. There are no dollar limits: users can send any amount up to their balance.
   Fee ceilings are secrets: `MAX_FEE_GWEI_ETH` (60), `MAX_FEE_GWEI_BNB` (10), `MAX_FEE_GWEI_AVAX` (80), `MAX_FEE_RATE_BTC` / `MAX_FEE_RATE_LTC` (100 sat/vB), `MAX_FEE_DROPS_XRP` (5000 drops).

## Funding the treasury (important)
A user's balance is a number in the database; the real coins sit on their deposit addresses. An outside withdrawal is paid from the treasury, so **the treasury
must hold the coin being sent, plus its network fee**: ETH/BNB/AVAX for gas, BTC/LTC for amount + fee, SOL (keep ~0.001 SOL spare for the account's rent), XRP (the
account reserve, currently 1 XRP + 0.2 per owned object, can't be spent), TRX (keep a few TRX spare for fees). When it is short the payout WAITS and is retried
(and after 3 tries is cancelled and returned to the user), so top it up before users hit it.

## The five new chains: how they behave
| coin | how it is sent | counts as done | counted as failed (money returned) |
|---|---|---|---|
| BTC / LTC | native SegWit transaction from the treasury's confirmed coins; fee = the network's "half hour" rate, never above the ceiling; change goes back to the treasury | 1 confirmation | the network explicitly refuses it. A transaction that simply never confirms is NOT refunded automatically — settle it with `admin_resolve_payout` |
| SOL | System-program transfer, recent blockhash | finalized | rejected before sending, executed with an error, or not found once its blockhash has expired for good (provable) |
| XRP | Payment with the user's destination tag and `LastLedgerSequence` | validated ledger, `tesSUCCESS` | rejected as malformed, a `tec…` result (no funds move), or not found after `LastLedgerSequence` has passed (provable) |
| TRX | native transfer built by TronGrid; **the function decodes it and refuses to sign anything that is not exactly the requested transfer** | solidified, `SUCCESS` | the node explicitly refuses it, it failed, or it is in no block 10 minutes after it expired (provable) |

Each coin has its own lane: a Bitcoin payout that waits for its confirmation does not hold up Ethereum, Solana, etc. (only payouts of the SAME coin queue behind each other).
Recipients that do not exist yet: XRP needs the first payment to be at least the base reserve (1 XRP) and Solana at least 0.00089088 SOL. Smaller amounts are refused up front and returned.

Providers (override with secrets to use your own): `API_BTC` (mempool.space/api), `API_LTC` (litecoinspace.org/api), `RPC_SOL` (api.mainnet-beta.solana.com),
`RPC_XRP` (s1.ripple.com:51234), `API_TRX` (api.trongrid.io; add `TRONGRID_API_KEY` for higher limits). The public Solana endpoint is rate-limited: use a paid RPC for real traffic.
`FEE_RATE_FIXED_BTC` / `FEE_RATE_FIXED_LTC` (sat/vB) skip the fee lookup. Litecoin falls back to 5 sat/vB if its fee lookup fails; Bitcoin waits instead.

## MUST DO before real money — test on a test network
The signing/broadcast code in `index.ts` and `chains.ts` could not be run against a blockchain while it was written. `test/chains.test.mts` checks the transaction
formats against published test vectors (BIP143 signature hash, BIP84/SLIP-0010 wallet addresses, bech32/bech32m, signature validity) and the lane logic
(`node test/chains.test.mts`), but only a real network can prove the rest. Prove it with test money first. Test networks that work by changing a secret only:
`RPC_SOL` = a devnet URL, `RPC_XRP` = `https://s.altnet.rippletest.net:51234`, `API_TRX` = `https://api.shasta.trongrid.io`. Bitcoin and Litecoin addresses are mainnet-only here
(their address prefixes differ on test networks), so test those with a tiny real amount (for example 0.0001 BTC / 0.01 LTC) before anything larger.
For the Ethereum-style coins:
1. Set secrets to a test network, e.g. Sepolia: `RPC_ETH=<sepolia rpc url>`, `CHAIN_ID_ETH=11155111`, and a test token:
   `TOKEN_USDT=<test ERC-20 address>`, `TOKEN_DECIMALS_USDT=6`. Fund the treasury with test ETH and test tokens.
2. Turn the switch on, withdraw a small ETH amount to a second test address, then a token amount. Check: status goes queued → processing → completed,
   the hash shows in the transaction details and on the network's explorer, the amount arrived, the user got "Withdrawal sent".
3. Test the unhappy paths: withdraw to a mistyped mixed-case address (must be refused), withdraw with the treasury empty (must wait, then be cancelled and refunded after 3 tries),
   set a very low `MAX_FEE_GWEI_ETH` (must wait, not send).
4. Only then remove the test secrets (`supabase secrets unset RPC_ETH CHAIN_ID_ETH TOKEN_USDT TOKEN_DECIMALS_USDT`), fund the treasury with a SMALL amount and try one real send.

## When something is stuck
Only one case ever needs a person: it is UNCLEAR whether a transaction was broadcast (the money stays held and is never refunded automatically, to avoid paying twice).
A withdrawal that stays `processing` for a long time has a note (`payout_note`) saying why. Look at its hash on the blockchain explorer, then in the SQL editor
(as an admin user) settle it:
- it did arrive:      `select admin_resolve_payout('<transaction id>', 'complete', '<tx hash>');`
- it never left:      `select admin_resolve_payout('<transaction id>', 'refund', null, 'Could not be sent');`
Never refund a payout whose hash is still on its way — it may still confirm.
