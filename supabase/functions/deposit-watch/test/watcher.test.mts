// Run: node --experimental-strip-types deposit-watch/test/watcher.test.mts   (no network, no database)
// Synthetic fixtures + an in-memory database that mimics the phase-39 SQL (the SQL itself is tested in TESTING-PHASE39.md against real PostgreSQL).
import assert from "node:assert/strict";
import { runScan, userStatus } from "../watcher.ts";
import { clock, makeDb, mainnetNet, baseDeps, wallets, btcTx, sleep, BTC_ADDR, ME } from "./fakes.mts";
import W from "../../../../app.js/watchcontract.js";

let n = 0; const ok = (name: string, f: () => void | Promise<void>) => Promise.resolve().then(f).then(() => { n++; console.log("  ok  " + name); }, (e) => { console.log("FAIL  " + name + "\n      " + (e?.stack || e)); process.exitCode = 1; });

await ok("response contract: signed-in user gets version 2 / mode user, the frontend parser accepts it, and NO old field (checked/failed/credited) exists", async () => {
  const db = makeDb(wallets()), net = mainnetNet(), r: any = await userStatus({ db, now: () => clock.t }, "u1");
  assert.equal(r.version, 2); assert.equal(r.mode, "user"); assert.equal(r.ok, true);
  for (const old of ["checked", "failed", "credited"]) assert.ok(!(old in r), old + " must not exist");
  const p = W.parse(r); assert.equal(p.ok, true); assert.equal(p.wallet.balances[0].symbol, "BTC");
  assert.deepEqual(W.inProgress(p).map((x: any) => [x.status, x.confirmations, x.required]), [["confirming", 1, 3]]);
  assert.equal(net.log.length, 0, "a user call must not touch any blockchain");
  assert.deepEqual(db.calls.map((c) => c[0]), ["wallet_status_for"], "a user call is ONE database read: no scan, no lock, no cursor");
});
await ok("response contract: a SCAN response also parses as version 2 (but the app refuses it as a user answer); counters are the new names", async () => {
  const db = makeDb(wallets()), r: any = await runScan(baseDeps(db, mainnetNet()));
  assert.equal(r.version, 2); assert.equal(r.mode, "scan"); for (const k of ["scanned", "recorded", "created", "reorged", "missing", "dropped", "rechecked", "balancesUpdated", "unfinished"]) assert.equal(typeof r[k], "number", k);
  assert.ok(Array.isArray(r.errors) && Array.isArray(r.warnings) && Array.isArray(r.busy));
  assert.equal(W.parse(r).ok, false); assert.match(W.parse(r).error, /scan mode/);
  assert.equal(W.parse({ ok: true, version: 1, mode: "user" }).ok, false, "an old-format answer is rejected, not half-read");
});
await ok("frontend signature changes when a deposit gains a confirmation / completes, and when a balance changes; not otherwise", () => {
  const mk = (confs: number, st: string, bal: number) => W.parse({ ok: true, version: 2, mode: "user", wallet: { balances: [{ symbol: "BTC", amount: bal }], deposits: [{ id: "d1", status: st, confirmations: confs, symbol: "BTC" }], sends: [] }, networks: {}, scanner: { stale: false } });
  const a = W.signature(mk(1, "confirming", 1)); assert.equal(a, W.signature(mk(1, "confirming", 1)));
  assert.notEqual(a, W.signature(mk(2, "confirming", 1))); assert.notEqual(a, W.signature(mk(3, "completed", 1))); assert.notEqual(a, W.signature(mk(1, "confirming", 1.1)));
});
await ok("frontend shows the EXACT recorded blockchain error for networks the user holds; stale scanner is reported; unrelated networks are not", () => {
  const p = W.parse({ ok: true, version: 2, mode: "user", wallet: { balances: [{ symbol: "USDT", amount: 5 }], deposits: [], sends: [] },
    networks: { ERC20: { ok: false, error: "Wrong network behind the ETH RPC address (chain 56, expected 1)." }, BTC: { ok: false, error: "boom" }, SOL: { ok: true } }, scanner: { ageSeconds: 400, stale: true } });
  const t = W.problems(p, []).map((x: any) => x.message);
  assert.ok(t.some((m: string) => /Ethereum \(ERC-20 tokens\): Wrong network behind the ETH RPC address \(chain 56, expected 1\)/.test(m)));
  assert.ok(!t.some((m: string) => /boom/.test(m)), "the user holds no BTC");
  assert.ok(t.some((m: string) => /not updated for 7 minutes/.test(m)));
});

await ok("DUPLICATE SCANNER EXECUTION: a second run started while the first holds the leases scans nothing, records nothing, and reports the networks as busy", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const db = makeDb(wallets()), net = mainnetNet({ btcGate: gate, btcTxs: [btcTx("a".repeat(64), 799990)] });
  const A = runScan(baseDeps(db, net)); await sleep(20);
  const rb: any = await runScan(baseDeps(db, mainnetNet({ btcTxs: [btcTx("a".repeat(64), 799990)] })));
  assert.deepEqual(rb.busy, ["BTC"], "the network run A is still working on is skipped (ETH had already finished and been released)"); assert.equal(rb.recorded, 0); assert.equal(rb.scanned, 0); assert.equal(db.recorded.size, 0, "run B recorded nothing");
  release(); const ra: any = await A;
  assert.equal(ra.recorded, 1); assert.equal(ra.created, 1); assert.equal(db.recorded.size, 1);
  assert.equal(db.calls.filter((c) => c[0] === "scan_lock_acquire" && c[1].p_name === "deposit-scan:BTC").length, 2, "both runs asked; only one got it");
  assert.ok([...db.locks.values()].every((l) => l.until <= clock.t), "leases are released when a run ends");
});
await ok("a run that finished releases its lease, so the next scheduled run scans normally", async () => {
  const db = makeDb(wallets()); await runScan(baseDeps(db, mainnetNet()));
  const r: any = await runScan(baseDeps(db, mainnetNet())); assert.deepEqual(r.busy, []);
});
await ok("CONCURRENT CURSOR CONFLICT: a run that lost its lease cannot overwrite the cursor (fenced write refused, run stops, error says so)", async () => {
  const db = makeDb(wallets()); db.cursors.set("evm:ETH", 90);
  const net = mainnetNet(); const real = net.rpc.bind(net);
  net.rpc = async (u: string, m: string, p: any[]) => { if (m === "eth_getBlockByNumber" && p[1] === true) { for (const l of db.locks.values()) l.until = clock.t - 1; db.locks.set("deposit-scan:ETH", { owner: "someone-else", until: clock.t + 60_000 }); } return real(u, m, p); };
  const r: any = await runScan(baseDeps(db, net));
  assert.equal(db.cursors.get("evm:ETH"), 90, "the cursor kept the other run's value"); assert.ok(r.errors.some((e: string) => /lease lost/.test(e)));
  assert.equal(db.balances.filter((b) => b.p_symbol === "ETH").length, 0, "a run that lost its lease also stops before mirroring balances");
});
await ok("a progress write after the lease was lost is refused too (BTC sweep state)", async () => {
  const db = makeDb(wallets()), net = mainnetNet({ btcTxs: [btcTx("c".repeat(64), 799990)] }); const real = net.get.bind(net);
  net.get = async (u: string) => { const r = await real(u); if (/\/txs$/.test(u)) db.locks.set("deposit-scan:BTC", { owner: "x", until: clock.t + 60_000 }); return r; };
  const r: any = await runScan(baseDeps(db, net)); assert.equal(db.progress.size, 0); assert.ok(r.errors.some((e: string) => /lease lost/.test(e)));
});
await ok("cron overlap: lease expiry lets a crashed run's network be taken over by the next run", async () => {
  const db = makeDb(wallets()); db.locks.set("deposit-scan:BTC", { owner: "crashed", until: clock.t + 180_000 });
  assert.deepEqual(((await runScan(baseDeps(db, mainnetNet()))) as any).busy, ["BTC"]);
  clock.t += 181_000; assert.deepEqual(((await runScan(baseDeps(db, mainnetNet()))) as any).busy, []);
});

await ok("WRONG NETWORK (EVM): an ETH RPC that is really chain 56 is not scanned and its balance is NOT mirrored; the exact reason is stored for the app; BTC still works", async () => {
  const db = makeDb(wallets()), net = mainnetNet({ chainId: 56 }), r: any = await runScan(baseDeps(db, net));
  assert.ok(r.errors.some((e: string) => /Wrong network behind the ETH RPC address \(chain 56, expected 1\)/.test(e)));
  assert.ok(!net.log.includes("RPC eth_getBalance"), "no balance was even read from the wrong network"); assert.ok(!net.log.includes("RPC eth_getBlockByNumber"));
  assert.equal(db.balances.filter((b) => b.p_symbol === "ETH").length, 0); assert.equal(db.balances.filter((b) => b.p_symbol === "BTC").length, 1);
  assert.equal(db.health.get("ETH").p_ok, false); assert.match(db.health.get("ETH").p_error, /chain 56/); assert.equal(db.health.get("ERC20").p_ok, false, "tokens ride on the same network");
  assert.equal(db.health.get("BTC").p_ok, true);
});
await ok("WRONG NETWORK (BTC): an API whose genesis block is not Bitcoin's (a testnet) is refused", async () => {
  const db = makeDb(wallets()), r: any = await runScan(baseDeps(db, mainnetNet({ btcGenesis: "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943" })));
  assert.ok(r.errors.some((e: string) => /Wrong network behind the BTC API/.test(e))); assert.equal(db.balances.filter((b) => b.p_symbol === "BTC").length, 0);
});
await ok("a provider error never zeroes a balance: unreadable = skipped with an error, nothing applied", async () => {
  const db = makeDb(wallets()), net = mainnetNet(), real = net.get.bind(net);
  net.get = async (u: string) => { if (/\/address\/bc1qme$/.test(u)) throw new Error("503"); return real(u); };
  const r: any = await runScan(baseDeps(db, net)); assert.ok(r.errors.some((e: string) => /balance BTC unreadable/.test(e))); assert.equal(db.balances.filter((b) => b.p_symbol === "BTC").length, 0);
});
await ok("a healthy run mirrors balances for the verified networks and records health ok", async () => {
  const db = makeDb(wallets()), r: any = await runScan(baseDeps(db, mainnetNet())); assert.deepEqual(r.errors, []); assert.equal(r.balancesUpdated, 2);
  assert.equal(db.health.get("BTC").p_ok, true); assert.equal(db.health.get("_scanner").p_ok, true);
});

await ok("DEPOSIT EVENT RECONCILIATION: every on-chain transfer is recorded once, however many runs / overlaps see it; native and internal refs stay distinct; a failed one is recorded as failed", async () => {
  const db = makeDb(wallets()), tx = { hash: "0xt1", to: ME, from: "0xabc", value: "0xde0b6b3a7640000" }, tx2 = { hash: "0xt2", to: ME, from: "0xabc", value: "0x1" };
  const net = mainnetNet({ ethTxs: { 99: [tx], 100: [tx2] }, btcTxs: [btcTx("d".repeat(64), 799990)] });
  const real = net.rpc.bind(net); net.rpc = async (u: string, m: string, p: any[]) => (m === "eth_getTransactionReceipt" ? { status: p[0] === "0xt2" ? "0x0" : "0x1" } : real(u, m, p));
  const r1: any = await runScan(baseDeps(db, net)); const r2: any = await runScan(baseDeps(db, net));
  const keys = [...db.recorded.keys()]; assert.equal(keys.length, 3, keys.join(" ")); assert.equal(r1.created, 3); assert.equal(r2.created, 0, "second run: same events, nothing new");
  const byHash = (h: string) => [...db.recorded.values()].find((v) => v.p_hash === h);
  assert.equal(byHash("0xt1").p_amount, "1"); assert.equal(byHash("0xt1").p_ref, "native"); assert.equal(byHash("0xt1").p_failed, false);
  assert.equal(byHash("0xt2").p_failed, true, "a failed transfer is recorded as failed, not as money"); assert.ok(byHash("d".repeat(64)).seen >= 2);
  assert.ok(db.cursors.get("evm:ETH")! >= 100);
});
await ok("recording failure: if a deposit cannot be recorded, the cursor / sweep progress is NOT advanced (it will be read again), and the error is reported", async () => {
  const db = makeDb(wallets()), real = db.rpc.bind(db); db.rpc = async (nm: string, a: any) => { if (nm === "record_chain_deposit") throw new Error("db down"); return real(nm, a); };
  const r: any = await runScan(baseDeps(db, mainnetNet({ btcTxs: [btcTx("e".repeat(64), 799990)], ethTxs: { 100: [{ hash: "0xt9", to: ME, from: "0xabc", value: "0x5" }] } })));
  assert.equal(db.progress.size, 0); assert.ok(!db.cursors.has("evm:ETH")); assert.ok(r.errors.some((e: string) => /record .* db down/.test(e)));
});
await ok("without phase 39 installed the scan fails CLOSED with a clear message (no unlocked scanning)", async () => {
  const db = makeDb(wallets()), real = db.rpc.bind(db); db.rpc = async (nm: string, a: any) => { if (nm === "scan_lock_acquire") throw new Error("scan_lock_acquire: function not found"); return real(nm, a); };
  const net = mainnetNet(), r: any = await runScan(baseDeps(db, net)); assert.ok(r.errors.some((e: string) => /schema_phase39/.test(e))); assert.equal(net.log.length, 0);
});
console.log(`\nall ${n} watcher checks ran` + (process.exitCode ? " — WITH FAILURES" : " — passed"));
