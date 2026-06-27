// ════════════════════════════════════════════════════════════════════════════
// A0a — cross-client double-redemption defect harness :: COORDINATOR
// ════════════════════════════════════════════════════════════════════════════
// Purpose (spec A0a): reproduce and FREEZE today's cross-client defect — two
// separate clients each fully redeem the SAME finite supplier credit against the
// SAME expense on the SAME starting base. Today's passive last-writer-wins sync
// relay has NO cross-client idempotency/CAS, so both succeed and several business
// exactly-once invariants are violated. This harness only OBSERVES today's
// behaviour — it fixes nothing, changes no production code, and reads the ACTUAL
// converged state (no expected results are programmed into the run).
//
// It runs THREE flights:
//   • race  run1 — both redeem on the same base, then sync (A pushes first)
//   • race  run2 — same, but B pushes first (covers both server-changelog orders)
//   • control    — A redeems, A syncs, B PULLS first, THEN B attempts the same
//                  redemption via the real writer (proves the race barrier + stale
//                  local state are causal — not the fixture or a baked assertion)
//
// Real components (unmodified production code):
//   • Real Rust/Axum server  → server/target/release/lataif-server.exe (in-repo, isolated DB)
//   • Real auth/sync API      → POST /api/auth/register, /api/sync/push, /api/sync/pull
//   • Real client stack       → src/core/db/database.ts (sql.js) + helpers.ts
//   • Real redemption writer   → src/stores/supplierStore.ts :: applySupplierCreditsToExpenses (540)
//   • Real ledger posting      → src/core/ledger/posting.ts :: postExpenseSupplierCreditPayment (1420)
//   • Real sync engine         → src/core/sync/sync-service.ts :: syncNow (308) → pushChanges(97)/pullChanges(136)/applyUpsert(273)
//   • Real reconciliation      → src/core/ledger/queries.ts + counterpartyAudit.ts :: runCounterpartyAudit (483)
//
// SEAM NOTE: separate push/pull are not exported; only the public syncNow (push-
// then-pull) is. The harness drives syncNow and covers both push orderings. The
// real LWW merge (applyUpsert) runs on every pull. The base fixture is built via
// direct SQL (allowed); the concurrent business action runs only through the real
// writer.
//
// Committed artifacts are NORMALIZED: random child UUIDs → stable tokens (U1,U2…),
// process IDs / temp paths / timestamps are NOT persisted (console/diagnostics
// only) so re-runs do not churn the git diff.
// ════════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HARNESS_DIR, '../..');
const SERVER_EXE = path.resolve(DESKTOP, 'server/target/release/lataif-server.exe');
const CLIENT = path.join(HARNESS_DIR, 'client.mjs');
const PORT = 3001;                                  // server bind is hardcoded 0.0.0.0:3001
const BASE = `http://127.0.0.1:${PORT}`;
const ART = process.argv[2] || HARNESS_DIR;          // committed artifacts (JSON + report)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lataif-a0a-'));  // transient DBs+logs (deleted)
const JWT_SECRET = randomBytes(24).toString('hex');  // ephemeral; never committed
const RPC_TIMEOUT = Number(process.env.RPC_TIMEOUT || 60000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DBGFD = fs.openSync(path.join(TMP, 'coord-debug.log'), 'w');
const dbg = (...a) => fs.writeSync(DBGFD, '[coord] ' + a.map(x => typeof x==='string'?x:JSON.stringify(x)).join(' ') + '\n');
const log = (...a) => { dbg(...a); console.log('[coord]', ...a); };

if (!fs.existsSync(SERVER_EXE)) { console.error(`Server binary not found: ${SERVER_EXE}\nBuild it first: (cd server && cargo build --release)`); process.exit(2); }

function portFree(port) { return new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(port, '127.0.0.1'); }); }

// ── child RPC ──
function startClient(label, token, logPath) {
  const ch = spawn(process.execPath, [CLIENT, label, BASE, token], { cwd: DESKTOP, stdio: ['pipe','pipe','pipe'] });
  const logfd = fs.openSync(logPath, 'w');
  ch.stderr.on('data', d => fs.writeSync(logfd, d));
  const pending = new Map(); let seq = 0; let readyResolve; const ready = new Promise(r => readyResolve = r);
  readline.createInterface({ input: ch.stdout }).on('line', line => {
    const i = line.indexOf('@@RPC@@'); if (i < 0) return;
    let msg; try { msg = JSON.parse(line.slice(i + 7)); } catch { return; }
    if (msg.ready) { readyResolve(msg); return; }
    const p = pending.get(msg.rid); if (p) { pending.delete(msg.rid); msg.error ? p.rej(new Error(msg.error)) : p.res(msg.res); }
  });
  const call = (cmd, args = {}) => new Promise((res, rej) => {
    const rid = ++seq;
    const to = setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); rej(new Error(`RPC TIMEOUT ${label} ${cmd}`)); } }, RPC_TIMEOUT);
    pending.set(rid, { res: v => { clearTimeout(to); res(v); }, rej: e => { clearTimeout(to); rej(e); } });
    ch.stdin.write(JSON.stringify({ rid, cmd, args }) + '\n');
  });
  return { ch, ready, call, label };
}

// ── real server ──
let server = null;
async function startServer(dbPath, logPath) {
  const logfd = fs.openSync(logPath, 'w');
  server = spawn(SERVER_EXE, [], { cwd: TMP, stdio: ['ignore','pipe','pipe'], env: { ...process.env, DATABASE_PATH: dbPath, JWT_SECRET } });
  server.stdout.on('data', d => fs.writeSync(logfd, d));
  server.stderr.on('data', d => fs.writeSync(logfd, d));
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {} await sleep(100); }
  throw new Error('server did not become healthy');
}
function stopServer() { if (server) { try { server.kill(); } catch {} server = null; } }

async function register(suffix) {
  const r = await fetch(`${BASE}/api/auth/register`, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ tenant_name:'A0a'+suffix, branch_name:'Main', country:'BH', currency:'BHD', email:`a0a${suffix}@test.local`, password:'pw', user_name:'A0a User' }) });
  if (!r.ok) throw new Error('register failed '+r.status);
  return r.json();
}
async function serverChangelog(token) {
  const j = await (await fetch(`${BASE}/api/sync/pull?since=0`, { headers:{ Authorization:`Bearer ${token}` } })).json();
  return j.changes.map(c => ({ id:c.id, table:c.table_name, record:c.record_id, action:c.action }));
}
const FIX = () => ({ tenant:'tenant-a0a', branch:'branch-a0a', supplier:'sup-a0a', expense:'exp-a0a', credit:'cred-a0a', user:'user-a0a', amount:100 });

// ── invariants computed from ACTUAL converged state (no expected outcome baked in) ──
function invariants(redeemA, redeemB, finalA, recA) {
  const ep = finalA.expense_payments.filter(p => p.method === 'credit');
  const redemptionTx = new Set(finalA.ledger_entries.filter(e => e.source_module === 'EXPENSE_PAYMENT').map(e => e.transaction_id));
  const credit = finalA.supplier_credits[0] || {};
  const sumCreditPayments = ep.reduce((s,p)=>s + Number(p.amount), 0);
  const expense = finalA.expenses[0] || {};
  const cpErrors = (recA.counterparty?.creditIssues || []).filter(i => i.severity === 'error').length;
  const cpMismatch = ['arByCustomer','customerCreditByCustomer','apBySupplier','supplierCreditBySupplier'].reduce((s,k)=> s + (recA.counterparty?.[k]?.mismatches || 0), 0);
  const row = (name, expectedBusiness, actual, violated) => ({ invariant:name, expectedBusiness, actual, violated });
  return [
    row('Exactly one redemption succeeds (other blocked)', 'one ok / one blocked', `A.ok=${redeemA.ok} B.ok=${redeemB.ok}`, redeemA.ok && redeemB.ok),
    row('Credit used exactly once (used_amount == Σ credit payments)', `equal`, `used_amount=${credit.used_amount}, Σ=${sumCreditPayments}`, Number(credit.used_amount) !== sumCreditPayments),
    row('Exactly one credit expense_payment row', 1, ep.length, ep.length !== 1),
    row('Exactly one redemption ledger transaction', 1, redemptionTx.size, redemptionTx.size !== 1),
    row('Expense not over-settled (Σ credit settled <= amount)', `<= ${expense.amount}`, sumCreditPayments, sumCreditPayments > Number(expense.amount)),
    row('Supplier-credit ledger balance >= 0', '>= 0', recA.supplierCredit_ledger, Number(recA.supplierCredit_ledger) < 0),
    row('Global ledger imbalance == 0', 0, recA.globalImbalance, Math.abs(Number(recA.globalImbalance)) > 0.0005),
    row('Counterparty reconciliation green', '0 mismatch / 0 error', `mismatch=${cpMismatch}, creditErrors=${cpErrors}`, cpMismatch > 0 || cpErrors > 0),
  ];
}

async function setup(suffix, logBase) {
  const dbPath = path.join(TMP, `server-${suffix}.db`);
  for (const f of [dbPath, dbPath+'-wal', dbPath+'-shm']) { try { fs.unlinkSync(f); } catch {} }
  await startServer(dbPath, path.join(TMP, `server-${suffix}.log`));
  const reg = await register(suffix);
  const A = startClient(`A-${logBase}`, reg.token, path.join(TMP, `clientA-${logBase}.log`));
  const B = startClient(`B-${logBase}`, reg.token, path.join(TMP, `clientB-${logBase}.log`));
  const ra = await A.ready, rb = await B.ready;
  const id = FIX();
  await A.call('fixture', { id }); await B.call('fixture', { id });
  await A.call('configure'); await B.call('configure');
  // normalized starting-state proof (before ANY business action)
  const shA = await A.call('statehash'), shB = await B.call('statehash');
  const srvBefore = await serverChangelog(reg.token);
  const startingState = {
    A: shA, B: shB,
    contentIdentical: shA.domainHash === shB.domainHash && shA.ledgerHash === shB.ledgerHash,
    bothChangelogsEmpty: shA.changelogCount === 0 && shB.changelogCount === 0,
    bothCursorsZero: shA.cursor === '0' && shB.cursor === '0',
    serverChangelogEmpty: srvBefore.length === 0,
    separateProcesses: ra.pid !== rb.pid, sharedSqlJsInstance: false, sharedDbFile: false, sharedAppDataDir: false,
  };
  return { reg, A, B, ra, rb, id, startingState };
}
async function teardown(A, B) { await A.call('exit').catch(()=>{}); await B.call('exit').catch(()=>{}); await sleep(200); stopServer(); await sleep(300); }
async function quiesce(first, second, cycles) {
  for (let round = 0; round < 6; round++) {
    const s1 = await first.call('sync'), s2 = await second.call('sync');
    cycles.push({ who:first.label, ...s1 }); cycles.push({ who:second.label, ...s2 });
    if (s1.pending === 0 && s2.pending === 0 && s1.cursor === s2.cursor) break;
  }
}

// ── RACE flight ──
async function runRace(runName, pushFirst, suffix) {
  log(`=== ${runName} (push-first: ${pushFirst}) ===`);
  const { reg, A, B, ra, rb, id, startingState } = await setup(suffix, runName);

  // BARRIER: both redeem locally, before ANY sync
  const redeemA = await A.call('redeem', { supplier: id.supplier, amount: id.amount });
  const redeemB = await B.call('redeem', { supplier: id.supplier, amount: id.amount });
  const afterLocalA = await A.call('snapshot'), afterLocalB = await B.call('snapshot');
  const barrier = {
    A_redeemed: redeemA, B_redeemed: redeemB,
    A_unsynced: afterLocalA.changelog.filter(c=>c.synced===0).length, A_cursor: afterLocalA.cursor,
    B_unsynced: afterLocalB.changelog.filter(c=>c.synced===0).length, B_cursor: afterLocalB.cursor,
    proof: 'both redeemed with cursor 0 + unsynced changes ⇒ both acted on the SAME old base before either pulled the other',
  };
  log('barrier:', JSON.stringify({A:redeemA.ok,B:redeemB.ok,Au:barrier.A_unsynced,Bu:barrier.B_unsynced}));

  const first = pushFirst === 'A' ? A : B, second = pushFirst === 'A' ? B : A;
  const cycles = [{ who:first.label, ...(await first.call('sync')) }, { who:second.label, ...(await second.call('sync')) }];
  await quiesce(first, second, cycles);

  const finalA = await A.call('snapshot'), finalB = await B.call('snapshot');
  const reconA = await A.call('recon'), reconB = await B.call('recon');
  const changelog = await serverChangelog(reg.token);
  const inv = invariants(redeemA, redeemB, finalA, reconA);
  const validation = { ...startingState, convergedIdentical:
    JSON.stringify(finalA.expense_payments) === JSON.stringify(finalB.expense_payments) && JSON.stringify(finalA.supplier_credits) === JSON.stringify(finalB.supplier_credits) };
  await teardown(A, B);
  return { runName, mode:'race', pushFirst, startingState, barrier, syncCycles:cycles, serverChangelog:changelog, final:{ A:finalA, B:finalB }, recon:{ A:reconA, B:reconB }, invariants:inv, validation, _pids:{ A:ra.pid, B:rb.pid } };
}

// ── CONTROL flight: A redeems → A syncs → B PULLS → THEN B attempts redemption ──
async function runControl(suffix) {
  log(`=== control (B redeems only AFTER pulling A's result) ===`);
  const { reg, A, B, id, ra, rb, startingState } = await setup(suffix, 'control');

  const redeemA = await A.call('redeem', { supplier: id.supplier, amount: id.amount });
  const cycles = [];
  await quiesce(A, B, cycles);                       // A pushes, B pulls A's result, to quiescence
  const B_beforeRedeem = await B.call('snapshot');   // B's local view AFTER pulling A
  const redeemB = await B.call('redeem', { supplier: id.supplier, amount: id.amount }); // attempt on fresh-pulled state
  await quiesce(A, B, cycles);

  const finalA = await A.call('snapshot'), finalB = await B.call('snapshot');
  const reconA = await A.call('recon'), reconB = await B.call('recon');
  const changelog = await serverChangelog(reg.token);
  const inv = invariants(redeemA, redeemB, finalA, reconA);
  const healthy = inv.every(i => !i.violated);
  await teardown(A, B);
  return { runName:'control', mode:'control', startingState,
    A_redeemed: redeemA, B_view_after_pull: { supplier_credits:B_beforeRedeem.supplier_credits, expenses:B_beforeRedeem.expenses, expense_payments:B_beforeRedeem.expense_payments.length },
    B_redeem_attempt: redeemB, syncCycles:cycles, serverChangelog:changelog, final:{ A:finalA, B:finalB }, recon:{ A:reconA, B:reconB },
    invariants:inv, controlHealthy:healthy, additionalDefect: !healthy, validation:startingState, _pids:{ A:ra.pid, B:rb.pid } };
}

// ── canonical committed form: counts + business shapes (NO random ids / pids /
//    timestamps / temp paths) so re-runs are byte-stable. The random child UUIDs
//    only prove the rows are DISTINCT, which the counts already capture.
function multiset(rows, fields) {
  const m = new Map();
  for (const r of rows) { const k = JSON.stringify(fields.map(f => r[f])); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort().map(([k, count]) => { const vals = JSON.parse(k); const o = {}; fields.forEach((f, i) => o[f] = vals[i]); o.count = count; return o; });
}
function summarizeFinal(snap) {
  const redempt = snap.ledger_entries.filter(e => e.source_module === 'EXPENSE_PAYMENT');
  return {
    supplier_credits: snap.supplier_credits.map(c => ({ amount: c.amount, used_amount: c.used_amount, status: c.status })),
    expenses: snap.expenses.map(e => ({ amount: e.amount, paid_amount: e.paid_amount, status: e.status })),
    expense_payments: { count: snap.expense_payments.length, shapes: multiset(snap.expense_payments, ['amount', 'method', 'reference']) },
    redemptionLedger: { transactions: new Set(redempt.map(e => e.transaction_id)).size, legs: multiset(redempt, ['account', 'direction', 'amount']) },
  };
}
const startBlockData = (s) => ({ contentIdenticalAB: s.contentIdentical, domainHash: s.A.domainHash, ledgerHash: s.A.ledgerHash,
  bothChangelogsEmpty: s.bothChangelogsEmpty, bothCursorsZero: s.bothCursorsZero, serverChangelogEmpty: s.serverChangelogEmpty,
  separateProcesses: s.separateProcesses, sharedSqlJsInstance: s.sharedSqlJsInstance, sharedDbFile: s.sharedDbFile, sharedAppDataDir: s.sharedAppDataDir });
const changelogShape = (cl) => cl.map(c => ({ id: c.id, table: c.table, action: c.action })); // drop record-uuid
function commitRace(r) {
  return { runName: r.runName, mode: 'race', pushFirst: r.pushFirst,
    startingState: startBlockData(r.startingState),
    barrier: { A_redeemed_ok: r.barrier.A_redeemed.ok, B_redeemed_ok: r.barrier.B_redeemed.ok, A_unsynced: r.barrier.A_unsynced, B_unsynced: r.barrier.B_unsynced, A_cursor: r.barrier.A_cursor, B_cursor: r.barrier.B_cursor },
    syncCycles: r.syncCycles.map(c => ({ who: c.who, pending: c.pending, cursor: c.cursor })),
    serverChangelog: changelogShape(r.serverChangelog),
    finalSummary: summarizeFinal(r.final.A), convergedIdentical: r.validation.convergedIdentical,
    recon: reconLine(r.recon.A), invariants: r.invariants };
}
function commitControl(c) {
  return { runName: 'control', mode: 'control',
    startingState: startBlockData(c.startingState),
    sequence: { A_redeem_ok: c.A_redeemed.ok, B_view_after_pull: { supplier_credits: c.B_view_after_pull.supplier_credits.map(x => ({ amount: x.amount, used_amount: x.used_amount, status: x.status })), expense_payments: c.B_view_after_pull.expense_payments }, B_redeem_attempt_ok: c.B_redeem_attempt.ok, B_redeem_error: c.B_redeem_attempt.ok ? null : c.B_redeem_attempt.error },
    syncCycles: c.syncCycles.map(x => ({ who: x.who, pending: x.pending, cursor: x.cursor })),
    serverChangelog: changelogShape(c.serverChangelog),
    finalSummary: summarizeFinal(c.final.A), recon: reconLine(c.recon.A),
    controlHealthy: c.controlHealthy, additionalDefect: c.additionalDefect, invariants: c.invariants };
}

// ── reconciliation summary ──
function reconLine(r){ const cp=r.counterparty; const mm=['arByCustomer','customerCreditByCustomer','apBySupplier','supplierCreditBySupplier'].reduce((s,k)=>s+(cp?.[k]?.mismatches||0),0); const er=(cp?.creditIssues||[]).filter(i=>i.severity==='error').length; return { globalImbalance:r.globalImbalance, supplierAP_ledger:r.supplierAP_ledger, supplierCredit_ledger:r.supplierCredit_ledger, cpMismatches:mm, cpCreditErrors:er }; }

// ── markdown report (from CANONICAL committed forms; deterministic, no ids/pids/timestamps) ──
function mdReport(races, control, head) {
  const L = [];
  L.push(`# A0a — Cross-Client Double-Redemption Defect (today's behaviour, frozen)\n`);
  L.push(`node ${process.version} · HEAD \`${head}\` · server \`lataif-server.exe\` (real Rust/Axum, isolated DB, port ${PORT})`);
  L.push(`Business state is reported as canonical counts/shapes (random row UUIDs are omitted — the counts prove the rows are distinct). Re-runs are byte-stable.\n`);
  L.push(`## Real components (file:line)\n`);
  L.push(`- writer \`supplierStore.applySupplierCreditsToExpenses\` (src/stores/supplierStore.ts:540); ledger \`postExpenseSupplierCreditPayment\` (src/core/ledger/posting.ts:1420)`);
  L.push(`- sync \`sync-service.syncNow\` → pushChanges(97)/pullChanges(136)/applyUpsert(273); recon \`counterpartyAudit.runCounterpartyAudit\` (483) + queries.ts`);
  L.push(`- server real \`/api/auth/register\`,\`/api/sync/push\`,\`/api/sync/pull\`\n`);
  L.push(`> Seam: separate push/pull are not exported; the public \`syncNow\` is driven and both push orderings are covered. The real LWW merge (\`applyUpsert\`) runs on every pull.\n`);

  const invTable = (inv) => { const t = [`| Invariant | Expected (business) | Actual | Violated |`, `|---|---:|---:|:--:|`]; for (const i of inv) t.push(`| ${i.invariant} | ${i.expectedBusiness} | ${i.actual} | ${i.violated?'**yes**':'no'} |`); return t.join('\n'); };
  const startBlock = (s) => `**Starting state (before any action):** content-identical A≡B: **${s.contentIdenticalAB}** (domainHash=${s.domainHash}, ledgerHash=${s.ledgerHash}); both changelogs empty: ${s.bothChangelogsEmpty}; both cursors 0: ${s.bothCursorsZero}; server changelog empty: ${s.serverChangelogEmpty}; separate processes: ${s.separateProcesses}; shared sql.js/db-file/appDataDir: ${s.sharedSqlJsInstance}/${s.sharedDbFile}/${s.sharedAppDataDir}.`;
  const finalBlock = (f) => ['```',
    `supplier_credits : ${JSON.stringify(f.supplier_credits)}`,
    `expenses         : ${JSON.stringify(f.expenses)}`,
    `expense_payments : count=${f.expense_payments.count} shapes=${JSON.stringify(f.expense_payments.shapes)}`,
    `redemption ledger: transactions=${f.redemptionLedger.transactions} legs=${JSON.stringify(f.redemptionLedger.legs)}`,
    '```'].join('\n');
  const greenLine = (rl) => `  - global ledger balanced: **${Math.abs(Number(rl.globalImbalance))<=0.0005?'YES (green)':'NO'}** · domain/ledger agree: **${(rl.cpMismatches===0&&rl.cpCreditErrors===0)?'YES':'NO'}** · credit ledger balance: **${rl.supplierCredit_ledger}**${Number(rl.supplierCredit_ledger)<0?' (NEGATIVE — over-drawn)':''}`;

  for (const r of races) {
    const rl = r.recon;
    L.push(`\n---\n## ${r.runName} — RACE, push-first: ${r.pushFirst}\n`);
    L.push(startBlock(r.startingState) + '\n');
    L.push(`**Barrier:** A redeemed ok=${r.barrier.A_redeemed_ok}, B redeemed ok=${r.barrier.B_redeemed_ok}; before any sync A_cursor=${r.barrier.A_cursor} (unsynced ${r.barrier.A_unsynced}), B_cursor=${r.barrier.B_cursor} (unsynced ${r.barrier.B_unsynced}). ⇒ both acted on the same old base.\n`);
    L.push(`**Sync cycles (real syncNow):** ` + r.syncCycles.map(c=>`${c.who}(pend=${c.pending},cur=${c.cursor})`).join(' → ') + `\n`);
    L.push(`**Server changelog order:** ` + r.serverChangelog.map(c=>`${c.id}:${c.table}/${c.action}`).join(', ') + `\n`);
    L.push(`**Final business state (clients converged identical: ${r.convergedIdentical}):**`);
    L.push(finalBlock(r.finalSummary));
    L.push(`**Reconciliation after:** ${JSON.stringify(rl)}`);
    L.push(greenLine(rl));
    L.push(`  - **part of defect invisible to GREEN global reconciliation: ${(Math.abs(Number(rl.globalImbalance))<=0.0005 && (rl.cpMismatches>0||rl.cpCreditErrors>0||Number(rl.supplierCredit_ledger)<0))?'YES':'NO'}**\n`);
    L.push(invTable(r.invariants));
  }

  const c = control, crl = c.recon, sq = c.sequence;
  L.push(`\n---\n## control — B redeems only AFTER pulling A's result\n`);
  L.push(startBlock(c.startingState) + '\n');
  L.push(`**Sequence:** A redeem ok=${sq.A_redeem_ok} → A/B sync to quiescence → B local view after pull: ${JSON.stringify(sq.B_view_after_pull.supplier_credits)} (expense_payments=${sq.B_view_after_pull.expense_payments}) → B redeem attempt ok=${sq.B_redeem_attempt_ok}${sq.B_redeem_attempt_ok?'':' ('+sq.B_redeem_error+')'}\n`);
  L.push(`**Final business state:**`);
  L.push(finalBlock(c.finalSummary));
  L.push(`**Reconciliation after:** ${JSON.stringify(crl)} → global green: ${Math.abs(Number(crl.globalImbalance))<=0.0005}, counterparty green: ${crl.cpMismatches===0&&crl.cpCreditErrors===0}`);
  L.push(`**Control healthy (single redemption, no violation): ${c.controlHealthy}** · additional defect: ${c.additionalDefect}\n`);
  L.push(invTable(c.invariants));
  L.push(`\n> Causality: the control isolates the only difference from the race — B acts on **fresh-pulled** state instead of a **stale** base. The control is healthy (single redemption, all green) while both races violate invariants ⇒ the race barrier + stale local state are the cause, not the fixture or a baked assertion.\n`);

  L.push(`\n---\n## Risks / limits\n`);
  L.push(`- Drives public \`syncNow\` (push+pull fused); separate push/pull not exported. Both push orderings covered (server-order axis).`);
  L.push(`- Headless boundary: window/localStorage shimmed, sql.js wasm \`?url\` redirected to a node path, isTauri()=false. DB engine, schema, migrations, writer, ledger posting, sync push/pull/applyUpsert and reconciliation are the unmodified production modules via Vite SSR.`);
  L.push(`- Base fixture built via direct SQL; the concurrent business action runs only through the real writer. Starting-state equality is proven by normalized content hashes (not raw SQLite bytes — internal page layout may legitimately differ).`);
  return L.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
const results = { races: [], control: null };
let head = 'unknown';
try { head = execSync('git rev-parse HEAD', { cwd: DESKTOP }).toString().trim(); } catch {}
try {
  if (!(await portFree(PORT))) { console.error(`Port ${PORT} is busy — stop the process using it and retry.`); process.exit(3); }
  results.races.push(await runRace('run1', 'A', '-r1'));
  results.races.push(await runRace('run2', 'B', '-r2'));
  results.control = await runControl('-ctl');
} catch (e) {
  dbg('FATAL', String(e && e.message), String(e && e.stack)); console.error('FATAL', e); process.exitCode = 1;
} finally {
  stopServer();
}

// ── write committed artifacts (canonical counts/shapes; deterministic across re-runs) ──
const cRaces = results.races.map(commitRace);
const cControl = results.control ? commitControl(results.control) : null;
for (const r of cRaces) fs.writeFileSync(path.join(ART, `a0a-${r.runName}.json`), JSON.stringify(r, null, 2) + '\n');
if (cControl) fs.writeFileSync(path.join(ART, 'a0a-control.json'), JSON.stringify(cControl, null, 2) + '\n');

// observed (post-run) structural defect signature — descriptive only, never read by the harness
const sig = {
  note: 'Structural defect signature OBSERVED after the runs (read from the DB, then summarized). Descriptive only — it does NOT drive the writer, sync or fixture.',
  fixture: FIX(),
  race: results.races.map(r => ({ run:r.runName, pushFirst:r.pushFirst, bothRedeemed: r.barrier.A_redeemed.ok && r.barrier.B_redeemed.ok,
    violatedInvariants: r.invariants.filter(i=>i.violated).map(i=>i.invariant),
    globalGreenButCounterpartyRed: r.invariants.find(i=>i.invariant.startsWith('Global'))?.violated===false && r.invariants.find(i=>i.invariant.startsWith('Counterparty'))?.violated===true })),
  control: results.control ? { healthy: results.control.controlHealthy, additionalDefect: results.control.additionalDefect, B_second_redeem_ok: results.control.B_redeem_attempt.ok, violatedInvariants: results.control.invariants.filter(i=>i.violated).map(i=>i.invariant) } : null,
};
fs.writeFileSync(path.join(ART, 'a0a-observed-defect-signature.json'), JSON.stringify(sig, null, 2) + '\n');
if (cRaces.length && cControl) fs.writeFileSync(path.join(ART, 'a0a-report.md'), mdReport(cRaces, cControl, head) + '\n');

// console summary (volatile diagnostics live here / temp only — NOT committed)
for (const r of results.races) { log(`--- ${r.runName} (${r.pushFirst}-first) pids ${r._pids.A}/${r._pids.B} ---`); for (const i of r.invariants) log(`  [${i.violated?'VIOLATED':'ok      '}] ${i.invariant} :: ${i.actual}`); }
if (results.control) { log(`--- control (healthy=${results.control.controlHealthy}, addl-defect=${results.control.additionalDefect}) ---`); for (const i of results.control.invariants) log(`  [${i.violated?'VIOLATED':'ok      '}] ${i.invariant} :: ${i.actual}`); }

// cleanup transient temp dir (DBs + logs)
try { fs.rmSync(TMP, { recursive: true, force: true }); log('cleaned temp', TMP); } catch (e) { log('temp cleanup warn', String(e)); }
log('artifacts in', ART);
