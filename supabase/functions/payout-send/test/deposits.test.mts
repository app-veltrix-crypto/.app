// Run: node --experimental-strip-types test/deposits.test.mts    (no network, no database)
// FIXTURES ARE SYNTHETIC: shaped like the documented API answers, NOT recorded from a live chain. They prove the parsing and the safety rules,
// not that a provider really answers this way. The real-money steps in TESTING-REAL-MONEY.md prove that.
import assert from "node:assert/strict";
import { nodePrims as P } from "./nodeprims.mts";
import * as S from "../../deposit-watch/scan.ts";
import { run, type Chain, type Db } from "../core.ts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.message || e)); process.exitCode = 1; });
const cfg: S.Cfg = { rpc: { ETH: "e", BNB: "b", AVAX: "a", SOL: "s", XRP: "x" }, api: { BTC: "https://btc", LTC: "https://ltc", TRX: "https://trx" },
  tokens: { USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 } }, backfillBlocks: 5, maxBlocksPerRun: 50, required: {} };
const ME = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222";

await ok("ERC-20 Transfer topic0 = keccak256('Transfer(address,address,uint256)')", () => {
  assert.equal("0x" + Buffer.from(P.keccak256(new TextEncoder().encode("Transfer(address,address,uint256)"))).toString("hex"), S.TRANSFER_TOPIC);
});
await ok("units(): exact decimals, no floating point", () => {
  assert.equal(S.units(123456789n, 8), "1.23456789"); assert.equal(S.units(100000000n, 8), "1"); assert.equal(S.units(1n, 18), "0.000000000000000001"); assert.equal(S.units(5n, 6), "0.000005");
});
await ok("BTC: deposit parsed (hash, vout, sender, amount, block time, confirmations); pure change is NOT a deposit; unconfirmed = 0 confs", () => {
  const tx = { txid: "a".repeat(64), status: { confirmed: true, block_height: 100, block_hash: "b".repeat(64), block_time: 1700000000 },
    vin: [{ prevout: { scriptpubkey_address: "bc1qsender" } }], vout: [{ scriptpubkey_address: "bc1qother", value: 5000 }, { scriptpubkey_address: "bc1qme", value: 12345 }] };
  const f = S.utxoFrom("BTC", "bc1qme", tx, 102); assert.equal(f.length, 1);
  assert.deepEqual([f[0].hash, f[0].ref, f[0].from, f[0].amount, f[0].block, f[0].blockTime, f[0].confirmations], ["a".repeat(64), "1", "bc1qsender", "0.00012345", 100, 1700000000, 3]);
  const change = { ...tx, vin: [{ prevout: { scriptpubkey_address: "bc1qme" } }] }; assert.equal(S.utxoFrom("BTC", "bc1qme", change, 102).length, 0);
  const mem = { ...tx, status: { confirmed: false } }; assert.equal(S.utxoFrom("BTC", "bc1qme", mem, 102)[0].confirmations, 0);
});
await ok("ETH native: only txs TO a watched address with value; receipt status 0x0 => failed; cursor re-reads the last 12 blocks (reorg overlap)", async () => {
  const calls: string[] = [];
  const net: S.Net = { get: async () => 0, post: async () => 0, rpc: async (_u, m, p: any[]) => {
    calls.push(m + ":" + (p[0] ?? ""));
    if (m === "eth_blockNumber") return "0x64";                                       // tip 100
    if (m === "eth_getBlockByNumber") return p[0] === "0x61" ? { hash: "0xblk61", timestamp: "0x65000000", transactions: [
      { hash: "0xt1", to: ME.toUpperCase().replace("0X", "0x"), from: OTHER, value: "0xde0b6b3a7640000" }, { hash: "0xt2", to: OTHER, from: ME, value: "0x1" }, { hash: "0xt3", to: ME, from: OTHER, value: "0x0" }] } : { hash: "0xblk", timestamp: "0x1", transactions: [] };
    if (m === "eth_getTransactionReceipt") return { status: "0x1" };
    throw new Error(m);
  } };
  const r = await S.scanEvmNative(net, cfg, "ETH", [ME], 97);
  assert.equal(r.found.length, 1); assert.deepEqual([r.found[0].hash, r.found[0].amount, r.found[0].block, r.found[0].confirmations, r.found[0].ref, r.found[0].failed], ["0xt1", "1", 97, 4, "native", false]);
  assert.equal(r.next, 100); assert.ok(calls.includes("eth_getBlockByNumber:0x55"), "cursor 97 - 12 = block 85 (0x55) is re-read");
});
await ok("ERC-20: log parsed (sender, amount in token decimals, log index); NFT-style 4-topic and removed logs ignored; zero amount ignored", async () => {
  const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
  const good = { address: cfg.tokens.USDT.address, topics: [S.TRANSFER_TOPIC, pad(OTHER), pad(ME)], data: "0x" + (2_500_000).toString(16).padStart(64, "0"), blockNumber: "0x60", blockHash: "0xbh", transactionHash: "0xth", logIndex: "0x7" };
  const logs = [good, { ...good, removed: true }, { ...good, topics: [...good.topics, pad("0x01")] }, { ...good, data: "0x" + "0".repeat(64), logIndex: "0x8" }];
  const net: S.Net = { get: async () => 0, post: async () => 0, rpc: async (_u, m) => m === "eth_blockNumber" ? "0x64" : m === "eth_getLogs" ? logs : { hash: "0xbh", timestamp: "0x65000000" } };
  const r = await S.scanErc20(net, cfg, [ME], 90);
  assert.equal(r.found.length, 1); assert.deepEqual([r.found[0].symbol, r.found[0].amount, r.found[0].from, r.found[0].ref, r.found[0].confirmations], ["USDT", "2.5", OTHER, "log7", 5]);
});
await ok("EVM recheck: a receipt whose block is no longer canonical is reported as NOT FOUND (reorg) instead of confirmed", async () => {
  const mk = (canonical: boolean): S.Net => ({ get: async () => 0, post: async () => 0, rpc: async (_u, m) => m === "eth_getTransactionReceipt" ? { blockHash: "0xold", blockNumber: "0x10", status: "0x1" }
    : m === "eth_blockNumber" ? "0x20" : { hash: canonical ? "0xold" : "0xnew", timestamp: "0x1" } });
  assert.equal((await S.recheckEvm(mk(true), cfg, "ETH", "0xh", null))!.confirmations, 17);
  assert.equal(await S.recheckEvm(mk(false), cfg, "ETH", "0xh", null), null);
});
await ok("SOL: amount = this account's lamport change, sender = signer, failed flag, finalized => 1 confirmation", () => {
  const tx = { slot: 55, blockTime: 1700000001, transaction: { message: { accountKeys: [{ pubkey: "Payer", signer: true }, { pubkey: "Me", signer: false }] } }, meta: { err: null, preBalances: [10_000_000, 0], postBalances: [8_999_995, 1_000_000] } };
  const f = S.solFrom("Me", "sig", tx, true)!; assert.deepEqual([f.amount, f.from, f.confirmations, f.failed, f.block], ["0.001", "Payer", 1, false, 55]);
  assert.equal(S.solFrom("Me", "sig", tx, false)!.confirmations, 0);
  assert.equal(S.solFrom("Payer", "sig", tx, true), null, "a negative balance change is not a deposit");
});
await ok("XRP: uses delivered_amount (partial payments), ignores issued currencies and payments to others; tec result => failed", () => {
  const t = { validated: true, tx: { TransactionType: "Payment", Destination: "rMe", Account: "rSender", hash: "ab12", Amount: "999999999", date: 100 }, meta: { delivered_amount: "2500000", TransactionResult: "tesSUCCESS" }, ledger_index: 900 };
  const f = S.xrpFrom("rMe", t)!; assert.deepEqual([f.amount, f.from, f.hash, f.confirmations, f.failed], ["2.5", "rSender", "AB12", 1, false]);
  assert.equal(S.xrpFrom("rMe", { ...t, meta: { delivered_amount: { currency: "USD", value: "5" }, TransactionResult: "tesSUCCESS" } }), null);
  assert.equal(S.xrpFrom("rOther", t), null);
  assert.equal(S.xrpFrom("rMe", { ...t, meta: { delivered_amount: "2500000", TransactionResult: "tecPATH_DRY" } })!.failed, true);
});
await ok("TRX: TransferContract to the watched address parsed; other contract types ignored", () => {
  const t = { txID: "cd".repeat(32), blockNumber: 70, block_timestamp: 1700000000000, ret: [{ contractRet: "SUCCESS" }], raw_data: { contract: [{ type: "TransferContract", parameter: { value: { to_address: "TMe", owner_address: "TFrom", amount: 3_000_000 } } }] } };
  const f = S.trxFrom("TMe", t)!; assert.deepEqual([f.amount, f.from, f.blockTime, f.confirmations], ["3", "TFrom", 1700000000, 0]); assert.equal(S.trxFrom("TMe", t, true)!.confirmations, 1);
  assert.equal(S.trxFrom("TMe", { ...t, raw_data: { contract: [{ type: "TriggerSmartContract", parameter: { value: {} } }] } }), null);
});

// ---- core: completion is gated by the confirmation policy, the actual fee is recorded, failure kinds are passed on
function fakeDb(required: number) {
  const calls: Array<[string, any]> = [];
  const db: Db = { async rpc(name, args) { calls.push([name, args]);
    if (name === "payout_claim") return { id: args.p_id, user_id: "u", symbol: "ETH", amount: "1", to_address: "0xabc", payout_attempts: 0 };
    if (name === "payout_set_hash") return true;
    if (name === "payout_set_progress") return { ok: true, required, ready: args.p_confs >= required };
    if (name === "payout_complete") return true;
    if (name === "payout_queue" || name === "payout_list_processing") return [];
    return null; } };
  return { db, calls };
}
const mkChain = (confs: number, fail?: string): Chain => ({
  async prepare(row) { return { hash: "0xhash", raw: "raw", symbol: row.symbol, from: "0xme", fee: "0.001", feeSymbol: "ETH" }; },
  async broadcast() {}, async receipt() { return fail ? "failed" : "success"; }, lane: () => "ETH", sleep: async () => {}, waitMs: () => 0,
  async detail() { return { confirmations: confs, block: 7, blockHash: "0xb", fee: "0.00042", feeSymbol: "ETH" }; }, failKind: () => fail ?? "failed" });
await ok("core: 1 of 12 confirmations => NOT completed (stays Confirming), the ACTUAL fee is stored; 12 of 12 => completed", async () => {
  let f = fakeDb(12); let r = await run(f.db, mkChain(1), [{ id: "t1", symbol: "ETH" }], () => {});
  assert.equal(r.t1, "sent_unconfirmed"); assert.ok(!f.calls.some((c) => c[0] === "payout_complete")); assert.equal(f.calls.find((c) => c[0] === "payout_set_progress")![1].p_fee, "0.00042");
  assert.ok(f.calls.some((c) => c[0] === "payout_set_broadcast"), "broadcast moment recorded only after the network accepted it");
  f = fakeDb(12); r = await run(f.db, mkChain(12), [{ id: "t2", symbol: "ETH" }], () => {}); assert.equal(r.t2, "completed"); assert.ok(f.calls.some((c) => c[0] === "payout_complete"));
});
await ok("core: a replaced/expired transaction is failed with its KIND and a truthful reason", async () => {
  const f = fakeDb(12); const r = await run(f.db, mkChain(0, "replaced"), [{ id: "t3", symbol: "ETH" }], () => {}); assert.equal(r.t3, "refunded");
  const c = f.calls.find((x) => x[0] === "payout_fail")![1]; assert.equal(c.p_kind, "replaced"); assert.match(c.p_reason, /dropped or replaced/);
});

// ---- address derivation: EVM (the coins whose derivation had no published-vector test before)
await ok("EVM address for the standard test phrase at m/44'/60'/0'/0/0 equals the published 0x9858EfFD…aEda94 (same path the app and payout-send use)", () => {
  const seed = P.seedFromPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  const pub = P.secpPub(P.secpPriv(seed, "m/44'/60'/0'/0/0"), false), addr = "0x" + Buffer.from(P.keccak256(pub.slice(1)).slice(12)).toString("hex");
  assert.equal(addr.toLowerCase(), "0x9858effd232b4033e47d90003d41ec34ecaeda94");
});
console.log(`\nall ${n} deposit/settlement checks ran` + (process.exitCode ? " — WITH FAILURES" : " — passed"));
