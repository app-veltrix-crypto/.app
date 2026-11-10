// Run:  node --experimental-strip-types supabase/functions/payout-quote/test/quote.test.mts      (no network, no database)
// OFFLINE ONLY: this proves the quotation arithmetic and its guarantees (read-only, never signs or broadcasts). It does not prove a real chain returns what these fakes return.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nodePrims as P } from "../../payout-send/test/nodeprims.mts";
import * as C from "../../payout-send/chains.ts";
import { buildQuote, evmAddressOk, fmt18, type QCfg, type QCtx } from "../quote.ts";
import { CANONICAL_TOKENS, EVM_CHAIN_ID, GENESIS } from "../../_shared/netcheck.ts";
import { identityAnswer } from "../../payout-send/test/identity-fixtures.mts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.message || e)); process.exitCode = 1; });
const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GWEI = 1_000_000_000n, ETH_TO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", BTC_TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", FROM_EVM = "0x" + "11".repeat(20);

const cfg = (): QCfg => ({
  rpc: { ETH: "eth", BNB: "bnb", AVAX: "avax", SOL: "sol", XRP: "xrp" }, api: { BTC: "https://btc", LTC: "https://ltc", TRX: "https://trx" },
  chainId: { ETH: 1, BNB: 56, AVAX: 43114 }, maxFeeGwei: { ETH: 60, BNB: 10, AVAX: 80 },
  tokens: { USDT: { ...CANONICAL_TOKENS[1].USDT }, USDC: { ...CANONICAL_TOKENS[1].USDC }, SHIB: { ...CANONICAL_TOKENS[1].SHIB }, LINK: { ...CANONICAL_TOKENS[1].LINK } },
  genesis: { BTC: GENESIS.BTC, LTC: GENESIS.LTC, SOL: GENESIS.SOL, TRX: GENESIS.TRX }, xrpNetworkId: 0, fixedRate: { BTC: 0, LTC: 0 }, maxRate: { BTC: 100, LTC: 100 }, maxFeeDropsXrp: 5000,
});
const ctx = (o: Partial<QCtx>): QCtx => ({ ok: true, symbol: "ETH", network: "Ethereum", from: FROM_EVM, to_valid: true, self: false, recipient_name: null, supported: true, sending_enabled: true, assets: {}, ...o });

/** a scriptable network; `calls` records every call so the tests can prove nothing was signed or broadcast */
function fakeNet(o: { chainId?: string; baseFee?: bigint; gas?: bigint | Error; utxos?: any[]; rate?: number } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async rpc(_u: string, m: string, p: unknown[]) {
      calls.push("rpc:" + m);
      switch (m) {
        case "eth_chainId": return o.chainId ?? "0x1";
        case "eth_getBlockByNumber": return { number: "0x64", timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16), baseFeePerGas: "0x" + (o.baseFee ?? 10n * GWEI).toString(16) };
        case "eth_gasPrice": return "0x" + (12n * GWEI).toString(16);
        case "eth_estimateGas": if (o.gas instanceof Error) throw o.gas; return "0x" + (o.gas ?? 21000n).toString(16);
        case "eth_getCode": return "0x6000";
        case "eth_call": return "0x6";
      }
      throw new Error("unexpected rpc " + m);
    },
    async get(u: string) {
      calls.push("GET " + u);
      if (u.endsWith("/block-height/0")) return GENESIS.BTC;
      if (u.endsWith("/blocks/tip/height")) return 800000;
      if (u.endsWith("/v1/fees/recommended")) return { halfHourFee: o.rate ?? 12 };
      if (/\/address\/[^/]+\/utxo$/.test(u)) return o.utxos ?? [];
      throw new Error("unexpected GET " + u);
    },
    async post(u: string) { calls.push("POST " + u); throw new Error("unexpected POST " + u); },
  };
}

await ok("EVM native: fee = gas x 1.2 x (2 x baseFee + 1 gwei); total, balance before/after are exact", async () => {
  const net = fakeNet({ baseFee: 10n * GWEI, gas: 21000n });
  const r = await buildQuote({ net, cfg: cfg(), ctx: ctx({ assets: { ETH: "1" } }), P }, { symbol: "ETH", amount: "0.5", to: ETH_TO });
  assert.ok(r.ok); const q = (r as any).quote;
  assert.equal(q.fee.symbol, "ETH"); assert.equal(q.fee.kind, "maximum");
  assert.equal(q.fee.amount, fmt18(25200n * 21n * GWEI));                                    // 0.0005292
  assert.equal(q.fee.amount, "0.0005292");
  assert.deepEqual(q.total, [{ symbol: "ETH", amount: "0.5005292" }]);
  assert.deepEqual(q.availableBefore, [{ symbol: "ETH", amount: "1" }]); assert.deepEqual(q.availableAfter, [{ symbol: "ETH", amount: "0.4994708" }]);
  assert.equal(q.canSend, true); assert.equal(q.sufficient, true); assert.equal(q.to, ETH_TO); assert.equal(q.amount, "0.5"); assert.equal(q.network, "Ethereum");
});

await ok("EVM token: fee is paid in the native coin; the token amount and the fee are shown separately", async () => {
  const net = fakeNet({ gas: 50000n });
  const r = await buildQuote({ net, cfg: cfg(), ctx: ctx({ symbol: "USDT", network: "Ethereum (ERC-20)", assets: { USDT: "100", ETH: "0.01" } }), P }, { symbol: "USDT", amount: "25.5", to: ETH_TO });
  assert.ok(r.ok); const q = (r as any).quote;
  assert.equal(q.fee.symbol, "ETH"); assert.equal(q.fee.amount, fmt18(60000n * 21n * GWEI));
  assert.deepEqual(q.total, [{ symbol: "USDT", amount: "25.5" }, { symbol: "ETH", amount: "0.00126" }]);
  assert.deepEqual(q.availableAfter, [{ symbol: "USDT", amount: "74.5" }, { symbol: "ETH", amount: "0.00874" }]);
  assert.equal(q.canSend, true);
});

await ok("token holder with no gas coin: not sendable, and the reason says which coin is missing", async () => {
  const r = await buildQuote({ net: fakeNet({ gas: 50000n }), cfg: cfg(), ctx: ctx({ symbol: "USDT", assets: { USDT: "100", ETH: "0" } }), P }, { symbol: "USDT", amount: "10", to: ETH_TO });
  const q = (r as any).quote; assert.equal(q.canSend, false); assert.equal(q.sufficient, false); assert.ok(q.reasons.some((x: string) => /needs about .* ETH to pay the network fee/.test(x)), q.reasons.join("|"));
});

await ok("insufficient balance and fee above the ceiling are refused with a clear reason", async () => {
  let r: any = await buildQuote({ net: fakeNet(), cfg: cfg(), ctx: ctx({ assets: { ETH: "0.0001" } }), P }, { symbol: "ETH", amount: "1", to: ETH_TO });
  assert.equal(r.quote.canSend, false); assert.ok(r.quote.reasons.some((x: string) => /does not hold enough ETH/.test(x)));
  r = await buildQuote({ net: fakeNet({ baseFee: 100n * GWEI }), cfg: cfg(), ctx: ctx({ assets: { ETH: "5" } }), P }, { symbol: "ETH", amount: "1", to: ETH_TO });
  assert.equal(r.quote.canSend, false); assert.ok(r.quote.reasons.some((x: string) => /above the ceiling/.test(x)));
});

await ok("a self-send, a send switched off, an invalid amount and a wallet with no address are all refused", async () => {
  let r: any = await buildQuote({ net: fakeNet(), cfg: cfg(), ctx: ctx({ self: true, assets: { ETH: "1" } }), P }, { symbol: "ETH", amount: "0.1", to: ETH_TO });
  assert.equal(r.quote.canSend, false); assert.ok(r.quote.reasons.some((x: string) => /own wallet/.test(x)));
  r = await buildQuote({ net: fakeNet(), cfg: cfg(), ctx: ctx({ sending_enabled: false, assets: { ETH: "1" } }), P }, { symbol: "ETH", amount: "0.1", to: ETH_TO }); assert.equal(r.quote.canSend, false);
  r = await buildQuote({ net: fakeNet(), cfg: cfg(), ctx: ctx({ assets: { ETH: "1" } }), P }, { symbol: "ETH", amount: "-1", to: ETH_TO }); assert.equal(r.ok, false); assert.equal(r.reason, "invalid_amount");
  r = await buildQuote({ net: fakeNet(), cfg: cfg(), ctx: ctx({ from: null }), P }, { symbol: "ETH", amount: "1", to: ETH_TO }); assert.equal(r.ok, false); assert.equal(r.reason, "no_wallet");
});

await ok("wrong network behind the RPC: no quote is produced (and no fee is guessed)", async () => {
  const r: any = await buildQuote({ net: fakeNet({ chainId: "0x38" }), cfg: cfg(), ctx: ctx({ assets: { ETH: "1" } }), P }, { symbol: "ETH", amount: "0.1", to: ETH_TO });
  assert.equal(r.ok, false); assert.equal(r.reason, "network"); assert.match(r.message, /Wrong network/);
});

await ok("token contract of another network is refused (mainnet USDT configured on BNB chain)", async () => {
  const c = cfg(); c.rpc.ETH = "bnbish";
  const r: any = await buildQuote({ net: fakeNet({ chainId: "0x38" }), cfg: { ...c, chainId: { ...c.chainId, ETH: 56 } }, ctx: ctx({ symbol: "USDT", assets: { USDT: "5", ETH: "1" } }), P }, { symbol: "USDT", amount: "1", to: ETH_TO });
  assert.equal(r.ok, false); assert.equal(r.reason, "network"); assert.match(r.message, /Token configuration|MAINNET|canonical/i);
});

await ok("EIP-55 checksums: the official vector passes, a flipped capital fails, all-lowercase is accepted", () => {
  assert.equal(evmAddressOk("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", P), true);
  assert.equal(evmAddressOk("0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed", P), false);          // one capital lowered
  assert.equal(evmAddressOk("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", P), true);
  assert.equal(evmAddressOk("0x" + "0".repeat(40), P), false); assert.equal(evmAddressOk("0x123", P), false);
});

await ok("Bitcoin: the quoted fee is EXACTLY the miner fee the signer's prepare() charges for the same coins and fee rate", async () => {
  const addrs = await C.treasuryAddresses(P, ABANDON), txidA = "aa".repeat(32), txidB = "bb".repeat(32);
  const utxos = [{ txid: txidA, vout: 1, value: 30000, status: { confirmed: true } }, { txid: txidB, vout: 0, value: 90000, status: { confirmed: true } }, { txid: "cc".repeat(32), vout: 0, value: 999999, status: { confirmed: false } }];
  const net = fakeNet({ utxos, rate: 12 });
  const r: any = await buildQuote({ net, cfg: cfg(), ctx: ctx({ symbol: "BTC", network: "Bitcoin", from: addrs.BTC, assets: { BTC: "0.001" } }), P }, { symbol: "BTC", amount: "0.0005", to: BTC_TO });
  assert.ok(r.ok, JSON.stringify(r)); const q = r.quote;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => { const u = String(url), js = (o: unknown) => new Response(JSON.stringify(o), { status: 200 }); const id = identityAnswer(u, init); if (id) return id;
    if (u.endsWith("/v1/fees/recommended")) return js({ halfHourFee: 12 }); if (u.endsWith(`/address/${addrs.BTC}/utxo`)) return js(utxos); return new Response("nope", { status: 404 }); }) as typeof fetch;
  try {
    const p = await C.makeOtherChains((_k) => "", P).prepare({ id: "x", user_id: "u", symbol: "BTC", amount: "0.0005", to_address: BTC_TO, payout_attempts: 1, phrase: ABANDON });
    assert.equal(q.fee.symbol, "BTC"); assert.equal(q.fee.amount, String(Number(p.fee)));            // same number the signer will pay and record
    assert.equal(Number(q.fee.amount), Number(p.fee));
  } finally { globalThis.fetch = realFetch; }
  assert.equal(q.canSend, true); assert.deepEqual(q.total, [{ symbol: "BTC", amount: fmt18(50000n * 10n ** 10n + BigInt(Math.round(Number(q.fee.amount) * 1e8)) * 10n ** 10n) }]);
  assert.ok(!net.calls.some((c) => /POST|sendRaw/i.test(c)));
});

await ok("Bitcoin: coins that do not cover amount + fee are reported, and an unconfirmed output is not counted", async () => {
  const net = fakeNet({ utxos: [{ txid: "aa".repeat(32), vout: 0, value: 10000, status: { confirmed: true } }, { txid: "bb".repeat(32), vout: 0, value: 9_999_999, status: { confirmed: false } }] });
  const r: any = await buildQuote({ net, cfg: cfg(), ctx: ctx({ symbol: "BTC", from: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", assets: { BTC: "0.0001" } }), P }, { symbol: "BTC", amount: "0.0005", to: BTC_TO });
  assert.equal(r.quote.canSend, false); assert.ok(r.quote.reasons.some((x: string) => /do not cover/.test(x)));
});

await ok("Bitcoin API serving another network's chain: refused", async () => {
  const net = fakeNet(); (net as any).get = async (u: string) => { if (u.endsWith("/block-height/0")) return GENESIS.LTC; throw new Error("x"); };
  const r: any = await buildQuote({ net, cfg: cfg(), ctx: ctx({ symbol: "BTC", from: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", assets: { BTC: "1" } }), P }, { symbol: "BTC", amount: "0.1", to: BTC_TO });
  assert.equal(r.ok, false); assert.equal(r.reason, "network");
});

await ok("a quote NEVER signs, broadcasts or writes: only read-only network calls were made", async () => {
  const net = fakeNet({ gas: 21000n });
  await buildQuote({ net, cfg: cfg(), ctx: ctx({ assets: { ETH: "1" } }), P }, { symbol: "ETH", amount: "0.1", to: ETH_TO });
  assert.ok(net.calls.length > 0); assert.ok(net.calls.every((c) => /^rpc:(eth_chainId|eth_getBlockByNumber|eth_gasPrice|eth_estimateGas|eth_getCode|eth_call)$/.test(c)), net.calls.join(","));
});

await ok("source scan: payout-quote contains no signing, key, broadcast or withdrawal code, and its only database call is quote_context", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), ".."), files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("quote.ts") && files.includes("index.ts"));
  const forbidden = [/sendRawTransaction/i, /sendTransaction/i, /secpSign/, /secpPriv/, /seedFromPhrase/, /buildP2wpkh/, /xrpSignAndHash/, /treasuryKeys/, /payout_signing_phrase/, /wallet_withdraw/, /payout_claim/, /payout_set_hash/, /payout_fail/, /payout_complete/, /\.from\(["']/, /service_role.*insert/i];
  const rpcs = new Set<string>();
  for (const f of files) {
    const code = readFileSync(join(dir, f), "utf8").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
    for (const re of forbidden) assert.ok(!re.test(code), `${f} contains ${re}`);
    for (const m of code.matchAll(/admin\.rpc\(\s*["']([a-z_0-9]+)["']/g)) rpcs.add(m[1]);
  }
  assert.deepEqual([...rpcs], ["quote_context"]);
});

console.log(`\n${n} quote checks ran`);
