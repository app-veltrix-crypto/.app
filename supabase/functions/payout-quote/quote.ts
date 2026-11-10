// Veltrix · payout-quote · the PRE-AUTHORISATION FEE QUOTATION (pure logic; the network is injected so it is tested offline).
//
// What it does: reads PUBLIC chain data (fee rates, gas estimate, the sender's public coins) and the caller's own public address and balances, and answers:
//   coin, network, recipient, amount, estimated network fee, fee currency, total expected deduction, available balance before and after.
// What it can NOT do, by construction: it is never given a key, a recovery phrase or a database write path; it has no signing code and no broadcast code
// (test/quote.test.mts scans this folder for them); it creates no withdrawal and deducts nothing. The actual transaction is validated again and its fee
// RECALCULATED by payout-send after the PIN: this quote is information for the person, not an authorisation, and nothing here is trusted by the signer.
import { checkEvm, checkTokens, checkUtxoApi, checkSol, checkXrp, checkTron, type NNet } from "../_shared/netcheck.ts";
import { parseUnits, planUtxoSpend, scriptForAddress, xrpAccountId, tronAddressBytes, b58dec, type Prims } from "../payout-send/chains.ts";

export type QCfg = {
  rpc: Record<string, string>; api: Record<string, string>; chainId: Record<string, number>; maxFeeGwei: Record<string, number>;
  tokens: Record<string, { address: string; decimals: number }>; genesis: { BTC: string; LTC: string; SOL: string; TRX: string }; xrpNetworkId: number;
  fixedRate: Record<string, number>; maxRate: Record<string, number>; maxFeeDropsXrp: number;
};
export type QCtx = { ok: boolean; reason?: string; symbol: string; network: string; from: string | null; to_valid: boolean; self: boolean; recipient_name: string | null;
  supported: boolean; sending_enabled: boolean; assets: Record<string, string> };
export type QInput = { symbol: string; amount: string; to: string; memo?: string | null };
export type Amt = { symbol: string; amount: string };
export type Quote = {
  symbol: string; network: string; from: string | null; to: string; memo: string | null; recipientName: string | null; amount: string;
  fee: Amt & { kind: "maximum" | "estimate" | "exact"; note: string };
  total: Amt[]; availableBefore: Amt[]; availableAfter: Amt[];
  sufficient: boolean; canSend: boolean; reasons: string[]; warnings: string[]; quotedAt: string;
};
export type QuoteResult = { ok: true; quote: Quote } | { ok: false; reason: string; message: string };
class QErr extends Error { reason: string; constructor(reason: string, m: string) { super(m); this.reason = reason; } }
const emsg = (e: unknown) => String((e as { shortMessage?: string; message?: string })?.shortMessage || (e as Error)?.message || e).slice(0, 200);
const S18 = 10n ** 18n;
const DEC: Record<string, number> = { BTC: 8, LTC: 8, SOL: 9, XRP: 6, TRX: 6, ETH: 18, BNB: 18, AVAX: 18 };
const to18 = (v: bigint, dec: number) => v * 10n ** BigInt(18 - dec);
export function fmt18(v: bigint): string {                                        // signed exact decimal
  const neg = v < 0n, a = neg ? -v : v, s = a.toString().padStart(19, "0"), i = s.slice(0, -18), f = s.slice(-18).replace(/0+$/, "");
  return (neg ? "-" : "") + i + (f ? "." + f : "");
}
const dec18 = (s: string | undefined) => { try { return parseUnits(String(s ?? "0"), 18); } catch { return 0n; } };

/** EIP-55: all-lowercase / all-uppercase are accepted (as ethers does); a mixed-case address must carry a correct checksum */
export function evmAddressOk(addr: string, P: Prims): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || /^0x0{40}$/i.test(addr)) return false;
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const h = [...P.keccak256(new TextEncoder().encode(body.toLowerCase()))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return [...body].every((c, i) => !/[a-f]/i.test(c) || (parseInt(h[i], 16) >= 8) === (c === c.toUpperCase()));
}

export async function buildQuote(d: { net: NNet; cfg: QCfg; ctx: QCtx; P: Prims; now?: () => number }, input: QInput): Promise<QuoteResult> {
  const { net, cfg, ctx, P } = d, sym = String(input.symbol || "").toUpperCase(), memo = input.memo ? String(input.memo) : null;
  if (!ctx.ok) return { ok: false, reason: ctx.reason || "unsupported_coin", message: "This coin is not supported" };
  const reasons: string[] = [], warnings: string[] = [];
  const isTok = !!cfg.tokens[sym], nativeKey = isTok ? "ETH" : sym, dec = isTok ? cfg.tokens[sym].decimals : (DEC[sym] ?? 0);
  let value: bigint;
  try { value = parseUnits(String(input.amount), dec); } catch { return { ok: false, reason: "invalid_amount", message: "The amount is not valid for this coin" }; }
  if (value <= 0n) return { ok: false, reason: "invalid_amount", message: "The amount is not valid" };
  if (!ctx.supported) reasons.push("This coin can't be sent automatically");
  if (!ctx.sending_enabled) reasons.push("Sending is switched off at the moment");
  if (!ctx.to_valid) reasons.push("That address isn't valid for this coin");
  if (ctx.self) reasons.push("You can't send to your own wallet");
  if (!ctx.from) return { ok: false, reason: "no_wallet", message: "Your wallet has no address for this coin" };
  const from = ctx.from;

  let feeAtoms = 0n, feeSym = nativeKey, feeDec = DEC[nativeKey] ?? 18, kind: "maximum" | "estimate" | "exact" = "maximum", note = "", reserve = 0n;   // reserve = coins that must stay in the wallet (rent / reserve), 18-dec
  try {
    if (["ETH", "BNB", "AVAX"].includes(nativeKey)) {
      const url = cfg.rpc[nativeKey], h = await checkEvm(net, nativeKey, url, cfg.chainId[nativeKey]);
      if (!h.ok) throw new QErr("network", h.error!);
      if (isTok) { const th = await checkTokens(net, url, cfg.chainId[nativeKey], { [sym]: cfg.tokens[sym] }); if (!th.ok) throw new QErr("network", th.error!); }
      if (!evmAddressOk(input.to, P)) reasons.push("The wallet address is not valid (check its spelling / capital letters)");
      const blk = await net.rpc(url, "eth_getBlockByNumber", ["latest", false]);
      let gasPrice: bigint | null = null; try { gasPrice = BigInt(await net.rpc(url, "eth_gasPrice", [])); } catch { /* optional */ }
      const feeCap = blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) * 2n + 1_000_000_000n : gasPrice;       // the same rule the signer's provider applies: 2 x base fee + 1 gwei
      if (!feeCap) throw new QErr("fee", "Network fee unavailable");
      if (feeCap > BigInt(cfg.maxFeeGwei[nativeKey]) * 1_000_000_000n) reasons.push(`Network fees are above the ceiling (${cfg.maxFeeGwei[nativeKey]} gwei); a send would wait and retry`);
      const hex = (x: bigint) => "0x" + x.toString(16), to = input.to.toLowerCase();
      const tx = isTok ? { from, to: cfg.tokens[sym].address, data: "0xa9059cbb" + to.slice(2).padStart(64, "0") + value.toString(16).padStart(64, "0"), value: "0x0" } : { from, to, data: "0x", value: hex(value) };
      let gas: bigint;
      try { gas = BigInt(await net.rpc(url, "eth_estimateGas", [tx])); }
      catch (e) {
        if (/insufficient funds|exceeds balance|transfer amount exceeds/i.test(emsg(e))) { gas = isTok ? 65000n : 21000n; warnings.push("The fee uses a standard gas figure because the wallet cannot cover this transfer"); }
        else if (/revert|execution|rejected|invalid/i.test(emsg(e))) { gas = isTok ? 65000n : 21000n; reasons.push("The network would reject this transfer: " + emsg(e)); }
        else throw new QErr("fee", "Could not estimate the network fee: " + emsg(e));
      }
      gas = gas * 120n / 100n;                                                                       // the signer's 20 % safety margin
      feeAtoms = gas * feeCap; feeDec = 18;
      note = "This is the most the network can charge. The amount actually charged is usually lower, and the exact fee is shown in your history once it is confirmed.";
    } else if (sym === "BTC" || sym === "LTC") {
      const base = cfg.api[sym], h = await checkUtxoApi(net, sym, base, cfg.genesis[sym]);
      if (!h.ok) throw new QErr("network", h.error!);
      let script: Uint8Array | null = null; try { script = scriptForAddress(sym, input.to, P); } catch { reasons.push("The wallet address is not valid for " + sym); }
      if (value < 546n) reasons.push("The amount is below the network's minimum");
      let rate = cfg.fixedRate[sym] || 0;
      if (!rate) { try { const f = await net.get(base + "/v1/fees/recommended"); rate = Math.ceil(Number(f.halfHourFee)); if (!(rate >= 1)) throw new Error("bad fee"); } catch (e) { if (sym === "LTC") rate = 5; else throw new QErr("fee", "Could not read the network fee: " + emsg(e)); } }
      rate = Math.max(rate, 1);
      if (rate > cfg.maxRate[sym]) reasons.push(`Network fees are above the ceiling (${cfg.maxRate[sym]} sat/vB); a send would wait and retry`);
      let all: any[]; try { all = await net.get(`${base}/address/${from}/utxo`); } catch (e) { throw new QErr("fee", "Could not read your wallet's coins: " + emsg(e)); }
      const utxos = all.filter((u) => u?.status?.confirmed && /^[0-9a-f]{64}$/.test(u.txid)).map((u) => ({ txid: u.txid as string, vout: Number(u.vout), value: BigInt(u.value) })).sort((a, b) => (a.value < b.value ? 1 : -1));
      const plan = planUtxoSpend(utxos, value, script ? script.length : 22, rate);
      feeAtoms = plan.enough ? plan.minerFee : plan.fee; feeDec = 8;                                 // identical to what prepare() will sign
      if (!plan.enough) reasons.push(`Your wallet's confirmed coins do not cover the amount plus the network fee`);
      note = `Fee rate ${rate} sat/vB for the coins this transfer would spend.`; kind = "estimate";
    } else if (sym === "SOL") {
      const url = cfg.rpc.SOL, h = await checkSol(net, url, cfg.genesis.SOL); if (!h.ok) throw new QErr("network", h.error!);
      try { const k = b58dec(input.to); if (k.length !== 32) throw 0; } catch { reasons.push("The wallet address is not valid for SOL"); }
      feeAtoms = 5000n; feeDec = 9; kind = "exact"; note = "Solana charges a fixed 0.000005 SOL per transfer.";
      reserve = to18(890880n, 9);
      const dest = await net.rpc(url, "getAccountInfo", [input.to, { encoding: "base64", commitment: "confirmed" }]).catch(() => null);
      if (dest && !dest.value && value < 890880n) reasons.push("The receiving Solana account is new; the first transfer must be at least 0.00089088 SOL");
    } else if (sym === "XRP") {
      const url = cfg.rpc.XRP, h = await checkXrp(net, url, cfg.xrpNetworkId); if (!h.ok) throw new QErr("network", h.error!);
      try { xrpAccountId(input.to, P); } catch { reasons.push("The wallet address is not valid for XRP"); }
      if (memo != null && (!/^\d{1,10}$/.test(memo) || Number(memo) > 4294967295)) reasons.push("The destination tag is not valid");
      const x = (m: string, p: Record<string, unknown>) => net.rpc(url, m, [p]);
      const acc = await x("account_info", { account: from, ledger_index: "current" });
      if (acc.error === "actNotFound") throw new QErr("fee", "Your XRP account is not activated yet (it needs the minimum XRP reserve first)");
      const si = (await x("server_info", {})).info?.validated_ledger, fe = await x("fee", {});
      if (!si || !fe?.drops) throw new QErr("fee", "Could not read the XRP network fee");
      const resBase = BigInt(Math.round(Number(si.reserve_base_xrp) * 1e6)), resInc = BigInt(Math.round(Number(si.reserve_inc_xrp) * 1e6));
      feeAtoms = BigInt(Math.ceil(Number(fe.drops.open_ledger_fee) * 1.3)); feeDec = 6;
      if (feeAtoms > BigInt(cfg.maxFeeDropsXrp)) reasons.push(`Network fees are above the ceiling (${cfg.maxFeeDropsXrp} drops); a send would wait and retry`);
      reserve = to18(resBase + resInc * BigInt(acc.account_data?.OwnerCount || 0), 6);
      const dest = await x("account_info", { account: input.to, ledger_index: "current" });
      if (dest.error === "actNotFound" && value < resBase) reasons.push(`The receiving XRP account is new; the first payment must be at least ${Number(resBase) / 1e6} XRP`);
      note = "The fee (in drops) is the current network fee with a 30 % margin; the XRP reserve stays in your wallet.";
    } else if (sym === "TRX") {
      const base = cfg.api.TRX, h = await checkTron(net, base, cfg.genesis.TRX); if (!h.ok) throw new QErr("network", h.error!);
      try { tronAddressBytes(input.to, P); } catch { reasons.push("The wallet address is not valid for TRX"); }
      const res = await net.post(base + "/wallet/getaccountresource", { address: from, visible: true }).catch(() => ({}));
      const free = Number(res.freeNetLimit || 0) - Number(res.freeNetUsed || 0), staked = Number(res.NetLimit || 0) - Number(res.NetUsed || 0);
      const dest = await net.post(base + "/wallet/getaccount", { address: input.to, visible: true }).catch(() => null);
      const newAcct = !!dest && Object.keys(dest).length === 0;
      feeAtoms = (free + staked >= 270 ? 0n : 270_000n) + (newAcct ? 1_000_000n : 0n); feeDec = 6; kind = "estimate"; reserve = to18(3_000_000n, 6);
      note = "TRON uses free bandwidth when you have it; otherwise it burns about 0.27 TRX" + (newAcct ? ", plus 1 TRX to activate a new receiving account" : "") + ". The sender must keep about 3 TRX spare.";
    } else throw new QErr("unsupported_coin", "This coin can't be sent automatically");
  } catch (e) {
    if (e instanceof QErr) return { ok: false, reason: e.reason, message: e.message };
    return { ok: false, reason: "network", message: "Could not reach the network: " + emsg(e) };
  }

  // the arithmetic, exact (18-decimal integers) -----------------------------------------------------------------------------------------------
  const amount18 = to18(value, dec), fee18 = to18(feeAtoms, feeDec), sameCoin = feeSym === sym;
  const bal = (s: string) => dec18(ctx.assets[s]);
  const total: Amt[] = sameCoin ? [{ symbol: sym, amount: fmt18(amount18 + fee18) }] : [{ symbol: sym, amount: fmt18(amount18) }, { symbol: feeSym, amount: fmt18(fee18) }];
  const before: Amt[] = sameCoin ? [{ symbol: sym, amount: fmt18(bal(sym)) }] : [{ symbol: sym, amount: fmt18(bal(sym)) }, { symbol: feeSym, amount: fmt18(bal(feeSym)) }];
  const after: Amt[] = sameCoin ? [{ symbol: sym, amount: fmt18(bal(sym) - amount18 - fee18) }] : [{ symbol: sym, amount: fmt18(bal(sym) - amount18) }, { symbol: feeSym, amount: fmt18(bal(feeSym) - fee18) }];
  let sufficient = true;
  if (bal(sym) < amount18 + (sameCoin ? fee18 + reserve : 0n)) { sufficient = false; reasons.push(sameCoin ? `Your wallet does not hold enough ${sym} for the amount plus the network fee${reserve ? " and the required reserve" : ""}` : `Your wallet does not hold enough ${sym}`); }
  if (!sameCoin && bal(feeSym) < fee18) { sufficient = false; reasons.push(`Your wallet needs about ${fmt18(fee18)} ${feeSym} to pay the network fee`); }
  if (reserve && sameCoin) warnings.push(`About ${fmt18(reserve)} ${sym} must stay in your wallet (network reserve).`);
  return { ok: true, quote: { symbol: sym, network: ctx.network, from, to: input.to, memo, recipientName: ctx.recipient_name, amount: fmt18(amount18),
    fee: { amount: fmt18(fee18), symbol: feeSym, kind, note }, total, availableBefore: before, availableAfter: after, sufficient, canSend: reasons.length === 0, reasons, warnings, quotedAt: new Date((d.now ?? Date.now)()).toISOString() } };
}
