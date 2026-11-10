// Run:  node --experimental-strip-types supabase/functions/payout-send/test/failed-fee.test.mts     (no network, no database)
// OFFLINE ONLY: proves the settlement logic. Whether a real chain's receipt exposes the fee the way the fake does must be confirmed on a real chain.
import assert from "node:assert/strict";
import { processOne, reconcile, type Chain, type Db, type Detail, type Prepared } from "../core.ts";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.message || e)); process.exitCode = 1; });
const row = { id: "p1", user_id: "u1", symbol: "SOL", amount: "1", to_address: "x", payout_attempts: 1 };

function fakeDb(o: { missing?: any[]; processing?: any[]; failMinedThrows?: boolean } = {}) {
  const calls: Array<[string, any]> = [];
  const db: Db & { calls: typeof calls } = { calls, async rpc(name, a) {
    calls.push([name, a]);
    switch (name) {
      case "payout_claim": return row;
      case "payout_set_hash": return true;
      case "payout_fail_mined": if (o.failMinedThrows) throw new Error("function payout_fail_mined does not exist"); return true;
      case "payout_failed_fee_missing": return o.missing ?? [];
      case "payout_list_processing": return o.processing ?? [];
      case "payout_set_failed_fee": return true;
      default: return true;
    }
  } };
  return db;
}
function fakeChain(o: { receipt: "failed" | "success" | "none"; kind?: string; detail?: Detail | null | Error; noFailedDetail?: boolean }): Chain {
  const c: Chain = {
    async prepare(): Promise<Prepared> { return { hash: "H1", raw: "00", symbol: "SOL", from: "me", fee: "0.000005", feeSymbol: "SOL" }; },
    async broadcast() {}, async receipt() { return o.receipt; }, lane: (s) => s, sleep: async () => {}, failKind: () => o.kind ?? "failed",
  };
  if (!o.noFailedDetail) c.failedDetail = async () => { if (o.detail instanceof Error) throw o.detail; return o.detail === undefined ? { confirmations: 1, block: 77, blockHash: "BH", fee: "0.000005", feeSymbol: "SOL" } : o.detail; };
  return c;
}
const names = (db: { calls: Array<[string, any]> }) => db.calls.map((c) => c[0]);
const call = (db: { calls: Array<[string, any]> }, nm: string) => db.calls.find((c) => c[0] === nm)?.[1];

await ok("mined-but-failed: the actual fee is recorded together with the failure (and the user's held amount returns)", async () => {
  const db = fakeDb(), r = await processOne(db, fakeChain({ receipt: "failed" }), "p1", () => {}, 1000);
  assert.equal(r, "refunded"); const a = call(db, "payout_fail_mined");
  assert.ok(a); assert.equal(a.p_fee, "0.000005"); assert.equal(a.p_fee_symbol, "SOL"); assert.equal(a.p_block, 77); assert.equal(a.p_kind, "failed");
  assert.ok(!names(db).includes("payout_fail"));
});

await ok("fee not readable yet: the failure is still settled at once (money returns) with a null fee", async () => {
  for (const detail of [null, new Error("rpc down")] as const) {
    const db = fakeDb(); await processOne(db, fakeChain({ receipt: "failed", detail }), "p1", () => {}, 1000);
    const a = call(db, "payout_fail_mined"); assert.ok(a, "settled"); assert.equal(a.p_fee, null);
  }
});

await ok("reconcile later backfills the missing fee exactly once it can be read", async () => {
  const db = fakeDb({ missing: [{ id: "p1", symbol: "SOL", tx_hash: "H1", payout_meta: null }] });
  await reconcile(db, fakeChain({ receipt: "failed" }), () => {});
  const a = call(db, "payout_set_failed_fee"); assert.ok(a); assert.equal(a.p_id, "p1"); assert.equal(a.p_fee, "0.000005"); assert.equal(a.p_fee_symbol, "SOL");
  const db2 = fakeDb({ missing: [{ id: "p1", symbol: "SOL", tx_hash: "H1", payout_meta: null }] });                       // still unreadable: nothing written, nothing thrown
  await reconcile(db2, fakeChain({ receipt: "failed", detail: null }), () => {}); assert.ok(!names(db2).includes("payout_set_failed_fee"));
});

await ok("never-mined failures (expired / replaced) cost no fee: plain payout_fail, no fee lookup", async () => {
  for (const kind of ["expired", "replaced"]) {
    let looked = false; const ch = fakeChain({ receipt: "failed", kind }); ch.failedDetail = async () => { looked = true; return null; };
    const db = fakeDb(); await processOne(db, ch, "p1", () => {}, 1000);
    assert.ok(names(db).includes("payout_fail")); assert.ok(!names(db).includes("payout_fail_mined")); assert.equal(looked, false);
  }
});

await ok("a chain that cannot report a failed fee still settles with the plain payout_fail", async () => {
  const db = fakeDb(); await processOne(db, fakeChain({ receipt: "failed", noFailedDetail: true }), "p1", () => {}, 1000);
  assert.ok(names(db).includes("payout_fail")); assert.ok(!names(db).includes("payout_fail_mined"));
});

await ok("phase 39 not installed (payout_fail_mined throws): falls back to payout_fail, so the user's money still comes back", async () => {
  const db = fakeDb({ failMinedThrows: true }), logs: string[] = [];
  const r = await processOne(db, fakeChain({ receipt: "failed" }), "p1", (m) => logs.push(m), 1000);
  assert.equal(r, "refunded"); assert.ok(names(db).includes("payout_fail")); assert.ok(logs.some((l) => /unavailable/.test(l)));
});

await ok("reconcile settles a failed payout it finds in 'processing' with the fee", async () => {
  const db = fakeDb({ processing: [{ id: "p9", symbol: "SOL", tx_hash: "H9", payout_meta: null, processing_at: new Date().toISOString(), created_at: new Date().toISOString() }] });
  await reconcile(db, fakeChain({ receipt: "failed" }), () => {});
  const a = call(db, "payout_fail_mined"); assert.ok(a); assert.equal(a.p_id, "p9"); assert.equal(a.p_fee, "0.000005");
});

console.log(`\n${n} failed-fee checks ran`);
