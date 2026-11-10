# Which coins and tokens the wallet really supports (v4)

"Implemented" below means **the code exists for all four things** — own wallet address, deposit detection, balance, withdrawal — and its offline tests pass. **No coin below has been verified on a real blockchain by me**, so none may be called "fully functional" yet; the column "proven on-chain" is yours to tick in TESTING-REAL-MONEY.md §12.

## A. Fully implemented in code (wallet · deposit · balance · withdrawal) — NOT yet proven on-chain
| Coin | Network | Address from phrase | Deposit detection | Balance mirror | Withdrawal (own key, own fee) |
|---|---|---|---|---|---|
| BTC | Bitcoin | m/84'/0'/0'/0/0 (bc1…) | address history, paged | address balance | yes (UTXO, sender pays fee) |
| LTC | Litecoin | m/84'/2'/0'/0/0 (ltc1…) | same | same | yes |
| ETH | Ethereum | m/44'/60'/0'/0/0 | block scan, top-level | eth_getBalance | yes |
| SOL | Solana | m/44'/501'/0'/0' | signatures, paged | getBalance | yes |
| XRP | XRP Ledger | m/44'/144'/0'/0/0 | account_tx, paged | account_info | yes (see tag rules in §5 of the testing doc) |
| TRX | TRON | m/44'/195'/0'/0/0 | account transfers **+ contract-sent TRX (new, v4)** | account balance | yes |
| USDT, USDC, SHIB, LINK | **Ethereum (ERC-20) only**: the four canonical contracts, checked against the chain id | same address as ETH | `Transfer` logs to the address | `balanceOf` | yes; **fee is paid in ETH from the sender's own address** (an address with tokens but no ETH cannot send) |

## B. Implemented but with a known monitoring hole (partially) 
| Coin | Hole | What you see when it bites |
|---|---|---|
| ETH, BNB, AVAX | **Contract-sent (internal) deposits** are only found with a tracing RPC (EVM-TRACING.md). Not confirmed for your provider. | Warning in the watcher response + `chain_health.detail`; drift in `v_chain_reconciliation`. |
| TRX | Contract-sent TRX is read from `/walletsolidity/gettransactioninfobyblocknum` (new, v4, never run on a live node; needs a provider that serves it, ~28,800 requests/day per day of chain). TRX paid as staking/vote rewards or unfreeze withdrawals is a balance increase that is not a deposit and is **not** recorded. | Warning/error `contract-sent (internal) TRX … could NOT be monitored`; drift for reward/unfreeze credits. |
| BNB, AVAX | Native coin only (see C). | — |

## C. NOT supported (not implemented; the app must not advertise them)
| Token / standard | Why it is unsupported | What happens if someone sends one to a Veltrix address |
|---|---|---|
| **BEP-20** (USDT/USDC/etc. on BNB Smart Chain) | No token list, no log scan, no balance read, no transfer encoding for chain 56. Only native BNB is handled. | The tokens arrive at the user's same-format address but **are invisible to Veltrix**: not credited, not shown, not sendable from the app. Recoverable only by importing the recovery phrase into an external wallet. |
| **TRC-20** (USDT-TRON etc.) | TRON handling is native TRX only (+ now internal TRX). No TRC-20 `Transfer` event scan, no `balanceOf`, no `TriggerSmartContract` sending. | Same: invisible, not sendable from the app. |
| **SPL tokens** (USDC-SOL etc.) | Solana handling is native SOL only: no token accounts, no associated-token-account creation, no SPL transfer. | Same. |
| **Avalanche C-Chain tokens** (ERC-20 on chain 43114) | Only native AVAX. The ERC-20 machinery is bound to the Ethereum network. | Same. |
| ERC-20 tokens other than USDT, USDC, SHIB, LINK; ERC-20 on BNB/AVAX/other chains; XRP issued currencies; BTC/LTC tokens (ordinals, etc.); NFTs | Not implemented. | Same. |

**Why this matters for real money:** the deposit screen used to print `BNB Smart Chain (BEP-20)` and `TRON (TRC-20)` for the *native* coins, which invites exactly the token deposits above. **Fixed in v4:** the labels are now `BNB Smart Chain` and `TRON` (also for already-created wallets, because the screen normalizes the old stored text), and the deposit screen for BNB, TRX, SOL and AVAX now says: "<BEP-20 / TRC-20 / SPL / Avalanche> tokens are not supported and would not show in your wallet." The optional SQL `schema_phase40_network_labels.sql` makes the label on *new withdrawals* read `TRON` too (cosmetic; not run by me).
