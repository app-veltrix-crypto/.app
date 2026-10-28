# payout-send — automatic withdrawals to outside wallets (Binance, Bybit, any address)

**Status: NOT turned on. Nothing is sent automatically until you complete the checklist below.**
There is NO admin approval any more. Until the switch is on, an outside withdrawal is refused ("temporarily unavailable") and no money is held.

## What it does
User taps Send → enters an address that is not a Veltrix wallet → server checks PIN / address / balance / limits and **holds** the amount
→ the withdrawal is `queued` and this function sends it **from the treasury wallet** (the treasury pays the network fee) and records the transaction hash.
A request above your limits, for an unsupported coin, or while the switch is off is refused up front and nothing is held.

Coins that can be sent to outside wallets: ETH, USDT, USDC, SHIB, LINK (Ethereum), BNB (BNB Smart Chain), AVAX (Avalanche C-Chain). Other coins are refused for outside addresses (Veltrix-to-Veltrix sends work for every coin).

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
1. Run `schema_phase13_send_to_users.sql`, `schema_phase14_outside_withdrawals.sql`, then `schema_phase15_no_admin_approval.sql` in the SQL editor.
2. Create a NEW wallet used only as the treasury (any wallet app, 12 words). Its address is the same on Ethereum, BNB Chain and Avalanche.
3. `supabase secrets set TREASURY_MNEMONIC="…12 words…" CRON_SECRET="<long random string>"`
4. `supabase functions deploy payout-send --no-verify-jwt`
5. Schedule it every minute (retries, confirmations): Supabase → Integrations → Cron (or any scheduler) → POST
   `https://<project>.supabase.co/functions/v1/payout-send` with header `x-cron-secret: <CRON_SECRET>`.
6. There are no dollar limits: users can send any amount up to their balance.
   Fee ceilings in gwei are secrets: `MAX_FEE_GWEI_ETH` (60), `MAX_FEE_GWEI_BNB` (10), `MAX_FEE_GWEI_AVAX` (80).

## MUST DO before real money — test on a test network
The signing/broadcast code in `index.ts` could not be run against a blockchain while it was written. Prove it with test money first:
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
