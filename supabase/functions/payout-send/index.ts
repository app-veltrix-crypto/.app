// Veltrix · payout-send — sends queued transactions (outside wallets AND other Veltrix users) ON-CHAIN, signed with the SENDING USER's own wallet key,
// from the user's own address. The sender pays the network fee. There is NO treasury.
// Coins handled here: ETH, USDT, USDC, SHIB, LINK (Ethereum), BNB (BNB Smart Chain), AVAX (Avalanche C-Chain) — in this file —
// and BTC, LTC, SOL, XRP, TRX — in chains.ts. Other coins are refused for outside addresses (there is no admin approval). READ README.md IN THIS FOLDER BEFORE TURNING IT ON.
//
// Deploy:  supabase functions deploy payout-send --no-verify-jwt        (the function checks the user itself)
// Secrets: supabase secrets set CRON_SECRET=<long random string>        (TREASURY_MNEMONIC is no longer used)
//          (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically)
// The safety logic lives in core.ts (tested against a real database). This file only talks to the blockchain.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { ethers } from "https://esm.sh/ethers@6.13.4";
import { Chain, ChainError, Detail, Item, Prepared, Row, MinedState, run } from "./core.ts";
import { makeOtherChains } from "./chains.ts";
import { prims } from "./prims.ts";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "access-control-allow-methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";

// ---- networks (override any of these with secrets to run against a TEST network first: see README) ----
type Net = { key: "ETH" | "BNB" | "AVAX"; rpc: string; chainId: number; maxFeeGwei: number };
const NETS: Record<string, Net> = {
  ETH:  { key: "ETH",  rpc: env("RPC_ETH")  || "https://ethereum-rpc.publicnode.com",            chainId: Number(env("CHAIN_ID_ETH")  || 1),     maxFeeGwei: Number(env("MAX_FEE_GWEI_ETH")  || 60) },
  BNB:  { key: "BNB",  rpc: env("RPC_BNB")  || "https://bsc-rpc.publicnode.com",                 chainId: Number(env("CHAIN_ID_BNB")  || 56),    maxFeeGwei: Number(env("MAX_FEE_GWEI_BNB")  || 10) },
  AVAX: { key: "AVAX", rpc: env("RPC_AVAX") || "https://avalanche-c-chain-rpc.publicnode.com",   chainId: Number(env("CHAIN_ID_AVAX") || 43114), maxFeeGwei: Number(env("MAX_FEE_GWEI_AVAX") || 80) },
};
const NATIVE: Record<string, Net> = { ETH: NETS.ETH, BNB: NETS.BNB, AVAX: NETS.AVAX };
const TOKENS: Record<string, { address: string; decimals: number }> = {   // all on the Ethereum network
  USDT: { address: env("TOKEN_USDT") || "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: Number(env("TOKEN_DECIMALS_USDT") || 6) },
  USDC: { address: env("TOKEN_USDC") || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: Number(env("TOKEN_DECIMALS_USDC") || 6) },
  SHIB: { address: env("TOKEN_SHIB") || "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: Number(env("TOKEN_DECIMALS_SHIB") || 18) },
  LINK: { address: env("TOKEN_LINK") || "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: Number(env("TOKEN_DECIMALS_LINK") || 18) },
};
const netFor = (sym: string): Net | null => NATIVE[sym] || (TOKENS[sym] ? NETS.ETH : null);

const providers: Record<string, ethers.JsonRpcProvider> = {};
const provider = (n: Net) => providers[n.key] ??= new ethers.JsonRpcProvider(n.rpc, n.chainId, { staticNetwork: true });
const erc20 = new ethers.Interface(["function transfer(address to, uint256 value) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const nextNonce: Record<string, number> = {};            // nonce bookkeeping inside one run
let pendingNonce: { key: string; nonce: number } | null = null;
const evmKinds = new Map<string, string>();               // hash -> failure kind for core.ts
const errText = (e: unknown) => String((e as { shortMessage?: string; message?: string })?.shortMessage || (e as Error)?.message || e).slice(0, 240);

// the wallet of the user who is sending (same path the app uses for the user's ETH / BNB / AVAX address)
function senderWallet(phrase: string | undefined) {
  if (!phrase) throw new ChainError("retry", "The sender's wallet key is not available");
  return ethers.HDNodeWallet.fromPhrase(phrase.trim().toLowerCase().replace(/\s+/g, " "), undefined, "m/44'/60'/0'/0/0");
}
const feeStr = (wei: bigint) => ethers.formatUnits(wei, 18);

const evm = {
  async prepare(row: Row): Promise<Prepared> {
    const sym = String(row.symbol).toUpperCase(), net = netFor(sym);
    if (!net) throw new ChainError("definite", "This coin can't be sent automatically");
    // 1) the address and the amount (nothing is sent if either is wrong)
    let to: string;
    try { to = ethers.getAddress(row.to_address); } catch { throw new ChainError("definite", "The wallet address is not valid (check its spelling / capital letters)"); }
    if (to === ethers.ZeroAddress) throw new ChainError("definite", "The wallet address is not valid");
    const tok = TOKENS[sym], decimals = tok ? tok.decimals : 18;
    let value: bigint;
    try { value = ethers.parseUnits(String(row.amount).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""), decimals); }
    catch { throw new ChainError("definite", "The amount has too many decimal places for this coin"); }
    if (value <= 0n) throw new ChainError("definite", "The amount is not valid");

    // 2) the network and the sender's wallet
    const wallet = senderWallet(row.phrase), p = provider(net), from = wallet.address;
    try {
      const cid = Number(BigInt(await p.send("eth_chainId", [])));
      if (cid !== net.chainId) throw new ChainError("retry", `Wrong network behind the ${net.key} RPC address (chain ${cid}, expected ${net.chainId})`);
    } catch (e) { if (e instanceof ChainError) throw e; throw new ChainError("retry", "Could not reach the network: " + errText(e)); }

    // 3) fees (never above the ceiling you set)
    let fee;
    try { fee = await p.getFeeData(); } catch (e) { throw new ChainError("retry", "Could not read network fees: " + errText(e)); }
    const feeCap = fee.maxFeePerGas ?? fee.gasPrice;
    if (!feeCap) throw new ChainError("retry", "Network fee unavailable");
    if (feeCap > ethers.parseUnits(String(net.maxFeeGwei), "gwei")) throw new ChainError("retry", `Network fees are above your ceiling (${net.maxFeeGwei} gwei); will retry`);

    // 4) the transaction itself
    let txTo = to, data = "0x", txValue = value;
    if (tok) {
      txTo = ethers.getAddress(tok.address); data = erc20.encodeFunctionData("transfer", [to, value]); txValue = 0n;
      try {
        if ((await p.getCode(txTo)) === "0x") throw new ChainError("retry", `Token contract not found on this network (${sym})`);
        const bal = BigInt((await p.call({ to: txTo, data: erc20.encodeFunctionData("balanceOf", [from]) })));
        if (bal < value) throw new ChainError("definite", `Your wallet does not hold enough ${sym}. Nothing was sent.`);
      } catch (e) { if (e instanceof ChainError) throw e; throw new ChainError("retry", "Could not read your token balance: " + errText(e)); }
    }
    let gas: bigint;
    try { gas = (await p.estimateGas({ from, to: txTo, data, value: txValue })) * 120n / 100n; }
    catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "CALL_EXCEPTION" || code === "UNPREDICTABLE_GAS_LIMIT") throw new ChainError("definite", "The network rejected this transfer: " + errText(e));
      throw new ChainError("retry", "Could not estimate the network fee: " + errText(e));
    }
    let nativeBal: bigint;
    try { nativeBal = await p.getBalance(from); } catch (e) { throw new ChainError("retry", "Could not read your wallet balance: " + errText(e)); }
    if (nativeBal < txValue + gas * feeCap) throw new ChainError("definite", tok
      ? `Your wallet needs some ${net.key} to pay the network fee (about ${feeStr(gas * feeCap)} ${net.key}). Nothing was sent.`
      : `Your wallet does not hold enough ${net.key} for the amount plus the network fee (about ${feeStr(gas * feeCap)} ${net.key}). Nothing was sent.`);

    let nonce: number;
    const nk = `${net.key}:${from.toLowerCase()}`;   // nonces belong to ONE address on ONE network
    try { nonce = Math.max(await p.getTransactionCount(from, "pending"), nextNonce[nk] ?? 0); }
    catch (e) { throw new ChainError("retry", "Could not read your account nonce: " + errText(e)); }

    const req = fee.maxFeePerGas
      ? { type: 2, chainId: net.chainId, nonce, to: txTo, data, value: txValue, gasLimit: gas, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
      : { type: 0, chainId: net.chainId, nonce, to: txTo, data, value: txValue, gasLimit: gas, gasPrice: fee.gasPrice! };
    let raw: string, hash: string;
    try { raw = await wallet.signTransaction(req); hash = ethers.Transaction.from(raw).hash!; }
    catch (e) { throw new ChainError("retry", "Could not sign: " + errText(e)); }
    pendingNonce = { key: nk, nonce };
    return { hash, raw, symbol: sym, from, fee: feeStr(gas * feeCap), feeSymbol: net.key, meta: `nonce=${nonce};from=${from};t=${Date.now()}` };   // fee = MAXIMUM estimate; the actual fee is read from the receipt
  },

  async broadcast(pr: Prepared): Promise<void> {
    const net = netFor(pr.symbol)!, p = provider(net);
    try {
      await p.broadcastTransaction(pr.raw);
    } catch (e) {
      const code = (e as { code?: string })?.code, msg = errText(e);
      if (/already known|known transaction/i.test(msg)) { /* it is already in the network's queue: that is fine */ }
      else if (code === "INSUFFICIENT_FUNDS") throw new ChainError("definite", "The network refused the transfer: " + msg);
      else throw new ChainError("unclear", msg);       // timeouts, nonce messages, anything else: it might or might not be out there
    }
    if (pendingNonce) nextNonce[pendingNonce.key] = pendingNonce.nonce + 1;
  },

  async receipt(hash: string, symbol: string, meta?: string | null): Promise<MinedState> {
    const net = netFor(String(symbol).toUpperCase()); if (!net) return "none";
    const p = provider(net), r = await p.getTransactionReceipt(hash);
    if (r) return r.status === 1 ? "success" : (evmKinds.set(hash, "failed"), "failed");
    // No receipt. It is provably DEAD only when: it is 15+ minutes old, no node knows it any more, and the account's confirmed nonce has moved
    // past ITS nonce (another transaction used that nonce). Order matters: nonce first, then look for the receipt again.
    const m = /nonce=(\d+);from=(0x[0-9a-fA-F]{40});t=(\d+)/.exec(meta || "");
    if (!m || Date.now() - Number(m[3]) < 15 * 60_000) return "none";
    const count = await p.getTransactionCount(m[2], "latest");
    if (count <= Number(m[1])) return "none";
    if (await p.getTransactionReceipt(hash)) return "none";                  // it was mined meanwhile: the next check reports it
    if (await p.getTransaction(hash)) return "none";                         // still known to the node (mempool): not dead
    evmKinds.set(hash, "replaced"); return "failed";
  },
  async detail(hash: string, symbol: string): Promise<Detail | null> {
    const net = netFor(String(symbol).toUpperCase()); if (!net) return null;
    const r = await provider(net).getTransactionReceipt(hash); if (!r || r.status !== 1) return null;
    return { confirmations: await r.confirmations(), block: r.blockNumber, blockHash: r.blockHash, fee: ethers.formatUnits(r.fee, 18), feeSymbol: net.key };   // gasUsed x effectiveGasPrice
  },
};

// every coin goes to the chain code that owns it; EVM payouts share one lane per network, each other coin has its own lane.
// getKey(row) returns the SENDING USER's phrase and the address on file for that coin (or null). Before anything is returned for broadcasting,
// the address the transaction spends from must equal that address, so funds can only ever leave the address the user sees in the app.
const other = makeOtherChains(env, prims);
const sameAddr = (a: string, b: string) => (/^(0x|bc1|ltc1)/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
function makeChain(getKey: (row: Row) => Promise<{ phrase: string; address: string | null } | null>): Chain {
  return {
    async prepare(row) {
      const k = await getKey(row);
      if (!k) throw new ChainError("retry", "The sender's wallet key is not available");
      const r = { ...row, phrase: k.phrase };
      const pr = other.handles(row.symbol) ? await other.prepare(r) : await evm.prepare(r);
      if (!pr.from || !k.address || !sameAddr(pr.from, k.address)) throw new ChainError("definite", "The signing address does not match your wallet address on file. Nothing was sent.");
      return pr;
    },
    broadcast: (p) => other.handles(p.symbol) ? other.broadcast(p) : evm.broadcast(p),
    receipt: (hash, symbol, meta) => other.handles(symbol) ? other.receipt(hash, symbol, meta) : evm.receipt(hash, symbol, meta),
    detail: (hash, symbol, meta) => other.handles(symbol) ? other.detail(hash, symbol) : evm.detail(hash, symbol),
    failKind: (hash) => evmKinds.get(hash) ?? other.failKind(hash),
    lane: (symbol) => other.handles(symbol) ? other.lane(symbol) : (netFor(String(symbol).toUpperCase())?.key ?? "OTHER"),
    waitMs: (symbol) => other.handles(symbol) ? other.waitMs(symbol) : 45000,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const db = { async rpc(name: string, args: Record<string, unknown>) { const { data, error } = await admin.rpc(name, args); if (error) throw new Error(`${name}: ${error.message}`); return data; } };

  // who is calling? (a) the scheduler with the secret: the whole queue  (b) a signed-in user: only their own payout
  let body: { id?: string; action?: string } = {}; try { body = await req.json(); } catch { /* none */ }
  let items: Item[] | null = null;
  const secret = env("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") === secret) {
    items = null;
  } else {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data, error } = await admin.auth.getUser(tok);
    if (error || !data.user) return json({ error: "not signed in" }, 401);
    const id = String(body.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad id" }, 400);
    const { data: row } = await admin.from("transactions").select("user_id,status,symbol").eq("id", id).maybeSingle();
    if (!row || row.user_id !== data.user.id) return json({ error: "not found" }, 404);
    items = [{ id, symbol: String(row.symbol) }];
  }

  const owner = crypto.randomUUID();
  const got = await db.rpc("payout_lock_acquire", { p_owner: owner, p_secs: 150 });
  if (got !== true) return json({ ok: true, busy: true });                                              // another run is working; it will pick the queue up
  const log: string[] = [];
  try {
    // the key of the sender, fetched from the database only for a send the owner already authorised with the PIN (it is logged there)
    const chain = makeChain(async (row) => {
      const k = await db.rpc("payout_signing_phrase", { p_user: row.user_id, p_tx: row.id });
      return k && k.phrase ? { phrase: String(k.phrase), address: k.address ? String(k.address) : null } : null;
    });
    const results = await run(db, chain, items, (m) => { log.push(m); console.log("[payout]", m); });
    return json({ ok: true, results });
  } catch (e) {
    console.error("[payout] run failed", errText(e));
    return json({ ok: false, error: "run failed" }, 500);
  } finally {
    try { await db.rpc("payout_lock_release", { p_owner: owner }); } catch (_) { /* the lock expires by itself */ }
  }
});
