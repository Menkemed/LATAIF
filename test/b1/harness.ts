// ═══════════════════════════════════════════════════════════
// LATAIF — B1 desktop end-to-end harness (real server + 2 sql.js clients)
// Run: node test/b1/harness.ts
// ═══════════════════════════════════════════════════════════

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import initSqlJs from 'sql.js';
import * as proto from '../../src/core/operations/b1-protocol.ts';
import { planSupplierCreditExpenseAllocations } from '../../src/core/finance/expenseCreditAllocation.ts';

// ── tiny test runner ──
let PASS = 0;
let FAIL = 0;
const failures: string[] = [];
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('ASSERT: ' + msg);
}
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAIL++;
    const m = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${m}`);
    console.log(`  ✗ ${name} — ${m}`);
  }
}

// ── server lifecycle ──
const BIN = join(
  process.cwd(),
  'server',
  'target',
  'debug',
  process.platform === 'win32' ? 'lataif-server.exe' : 'lataif-server',
);
let portCounter = 3101;

interface Server {
  url: string;
  kill: () => void;
}
async function startServer(): Promise<Server> {
  const port = portCounter++;
  const dir = mkdtempSync(join(tmpdir(), 'b1srv-'));
  const dbPath = join(dir, 'srv.db');
  const proc: ChildProcess = spawn(BIN, [], {
    env: { ...process.env, BIND_ADDR: `127.0.0.1:${port}`, DATABASE_PATH: dbPath, LATAIF_JWT_SECRET: 'b1-harness-jwt-secret' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  // wait for health
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
    if (i === 99) throw new Error('server did not start');
  }
  return {
    url,
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ── HTTP helpers ──
async function register(url: string, email: string): Promise<{ token: string; branchId: string; tenantId: string }> {
  const r = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_name: 'T',
      branch_name: 'B',
      user_name: 'U',
      email,
      password: 'pw',
      country: 'BH',
      currency: 'BHD',
    }),
  });
  const b = await r.json();
  return { token: b.token, branchId: b.branch_id, tenantId: b.tenant_id };
}
async function login(url: string, email: string): Promise<string> {
  const r = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw' }),
  });
  return (await r.json()).token;
}
async function syncPush(url: string, token: string, changes: unknown[]): Promise<Response> {
  return fetch(`${url}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ changes }),
  });
}
async function submitOp(url: string, token: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${url}/api/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function getStatus(url: string, token: string, opId: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${url}/api/operations/${opId}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}
async function pullOps(url: string, token: string, since: number, limit: number): Promise<Record<string, unknown>> {
  const r = await fetch(`${url}/api/operations/pull?since=${since}&limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.json();
}

// ── client (real sql.js DB + the REAL b1-protocol apply) ──
const CLIENT_SCHEMA = `
  CREATE TABLE supplier_credits (id TEXT PRIMARY KEY, branch_id TEXT, supplier_id TEXT, amount REAL, used_amount REAL DEFAULT 0, status TEXT, created_at TEXT);
  CREATE TABLE expenses (id TEXT PRIMARY KEY, branch_id TEXT, supplier_id TEXT, amount REAL, paid_amount REAL DEFAULT 0, status TEXT, created_at TEXT);
  CREATE TABLE expense_payments (id TEXT PRIMARY KEY, expense_id TEXT, amount REAL, method TEXT, paid_at TEXT, reference TEXT, note TEXT, created_at TEXT);
  CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, branch_id TEXT, entry_no INTEGER, transaction_id TEXT, occurred_at TEXT, recorded_at TEXT, account TEXT, direction TEXT, amount REAL, currency TEXT, counterparty_type TEXT, counterparty_id TEXT, source_module TEXT, source_id TEXT, metadata_json TEXT, created_by TEXT, created_at TEXT);
  CREATE TABLE ledger_sequence (branch_id TEXT PRIMARY KEY, next_no INTEGER, updated_at TEXT);
  CREATE TABLE authoritative_revisions (aggregate_type TEXT, aggregate_id TEXT, revision INTEGER DEFAULT 0, updated_at TEXT, PRIMARY KEY (aggregate_type, aggregate_id));
  CREATE TABLE b1_operations (operation_id TEXT PRIMARY KEY, operation_type TEXT, branch_id TEXT, payload_hash TEXT, payload_json TEXT, status TEXT, server_sequence INTEGER, result_json TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE b1_applied_envelopes (operation_id TEXT PRIMARY KEY, server_sequence INTEGER, applied_at TEXT);
  CREATE TABLE b1_op_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
`;

type SqlDb = Awaited<ReturnType<typeof initSqlJs>>['Database']['prototype'];

function makeClient(SQL: { Database: new () => SqlDb }, branchId: string) {
  const raw = new SQL.Database();
  raw.run(CLIENT_SCHEMA);
  const db: proto.Db = {
    run: (sql, params) => raw.run(sql, (params as never[]) ?? []),
    query: (sql, params) => {
      const res = raw.exec(sql, (params as never[]) ?? []);
      if (res.length === 0) return [];
      const { columns, values } = res[0];
      return values.map((row: unknown[]) => {
        const o: Record<string, unknown> = {};
        columns.forEach((c: string, i: number) => (o[c] = row[i]));
        return o;
      });
    },
  };
  // seed the same credit + expense the server was seeded with
  const now = '2026-06-30T10:00:00.000Z';
  db.run('INSERT INTO supplier_credits (id, branch_id, supplier_id, amount, used_amount, status, created_at) VALUES (?,?,?,?,?,?,?)', [
    'cred-1', branchId, 'sup-1', 100, 0, 'OPEN', now,
  ]);
  db.run('INSERT INTO expenses (id, branch_id, supplier_id, amount, paid_amount, status, created_at) VALUES (?,?,?,?,?,?,?)', [
    'exp-1', branchId, 'sup-1', 100, 0, 'PENDING', now,
  ]);
  function plan(reqFils: number) {
    const exp = db.query(
      "SELECT id, amount, paid_amount AS paid, created_at, COALESCE((SELECT SUM(amount) FROM expense_payments WHERE expense_id=expenses.id AND method='credit'),0) AS cp FROM expenses WHERE supplier_id='sup-1' AND status!='CANCELLED'",
    );
    const openE = exp.map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      amountF: proto.toFils(Number(r.amount)),
      settledF: proto.toFils(Number(r.paid)) + proto.toFils(Number(r.cp)),
    }));
    const cr = db.query("SELECT id, amount, used_amount, created_at FROM supplier_credits WHERE supplier_id='sup-1' AND status='OPEN'");
    const openC = cr.map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      totalF: proto.toFils(Number(r.amount)),
      usedF: proto.toFils(Number(r.used_amount)),
    }));
    return planSupplierCreditExpenseAllocations(openE, openC, reqFils);
  }
  function apply(envelope: proto.Envelope): void {
    raw.run('BEGIN');
    try {
      proto.applyEnvelope(db, envelope, { now: new Date().toISOString(), actor: 'u', branchId });
      proto.writeOpCursor(db, proto.canonicalToFils(envelope.serverSequence), new Date().toISOString());
      raw.run('COMMIT');
    } catch (e) {
      raw.run('ROLLBACK');
      throw e;
    }
  }
  return { db, raw, plan, apply, branchId };
}

// drive a full client pull-and-apply, return count applied
async function pullApply(url: string, token: string, client: ReturnType<typeof makeClient>): Promise<number> {
  let applied = 0;
  for (let g = 0; g < 100; g++) {
    const since = proto.readOpCursor(client.db);
    const res = await pullOps(url, token, since, 200);
    const ops = (res.operations as { serverSequence: string; envelope: proto.Envelope }[]) || [];
    if (ops.length === 0) break;
    for (const op of ops) {
      client.apply(op.envelope);
      applied++;
    }
    if (res.hasMore !== true) break;
  }
  return applied;
}

// build + submit one full-100 credit operation for a client
function buildFullOp(client: ReturnType<typeof makeClient>): { operationId: string; payload: proto.OperationPayload } {
  const p = client.plan(100_000);
  const grouped = proto.groupByCredit(p.allocations);
  assert(grouped.length === 1 && grouped[0].creditId === 'cred-1', 'plan is one credit cred-1');
  const operationId = randomUUID();
  const payload = proto.buildPayload(client.db, {
    operationId,
    branchId: client.branchId,
    creditId: 'cred-1',
    nowIso: new Date().toISOString(),
    allocations: grouped[0].allocations,
  });
  return { operationId, payload };
}

// assert the canonical accepted business end-state on a server (via a fresh
// admin client pull is implicit; here we assert through a client DB)
function assertClientEndState(client: ReturnType<typeof makeClient>): void {
  const cr = client.db.query("SELECT used_amount, status FROM supplier_credits WHERE id='cred-1'")[0];
  assert(proto.toFils(Number(cr.used_amount)) === 100_000, `credit used 100 (got ${cr.used_amount})`);
  assert(cr.status === 'USED', 'credit USED');
  const ex = client.db.query("SELECT status FROM expenses WHERE id='exp-1'")[0];
  assert(ex.status === 'PAID', 'expense PAID');
  const pays = client.db.query("SELECT id, amount, method FROM expense_payments WHERE expense_id='exp-1' AND method='credit'");
  assert(pays.length === 1, `exactly one credit payment (got ${pays.length})`);
  assert(proto.toFils(Number(pays[0].amount)) === 100_000, 'payment 100');
  const led = client.db.query('SELECT direction, account, amount, transaction_id, counterparty_type FROM ledger_entries');
  assert(led.length === 2, `exactly two ledger entries (got ${led.length})`);
  const txns = new Set(led.map((l) => l.transaction_id));
  assert(txns.size === 1, 'exactly one ledger transaction');
  const dr = led.find((l) => l.direction === 'DEBIT')!;
  const crL = led.find((l) => l.direction === 'CREDIT')!;
  assert(dr.account === 'ACCOUNTS_PAYABLE' && proto.toFils(Number(dr.amount)) === 100_000, 'DR AP 100');
  assert(crL.account === 'SUPPLIER_CREDIT' && proto.toFils(Number(crL.amount)) === 100_000, 'CR SUPPLIER_CREDIT 100');
  assert(led.every((l) => l.counterparty_type === 'SUPPLIER'), 'counterparty SUPPLIER');
  assert(!led.some((l) => String(l.account).includes('BANK') || String(l.account).includes('CASH')), 'no bank/cash leg');
  assert(proto.readRevision(client.db, proto.AGG_CREDIT, 'cred-1') === 1, 'credit revision 1');
  assert(proto.readRevision(client.db, proto.AGG_EXPENSE, 'exp-1') === 1, 'expense revision 1');
}

function ledgerKey(client: ReturnType<typeof makeClient>): string {
  return client.db
    .query('SELECT id, account, direction, amount FROM ledger_entries ORDER BY id')
    .map((l) => `${l.id}|${l.account}|${l.direction}|${l.amount}`)
    .join(';');
}
function paymentKey(client: ReturnType<typeof makeClient>): string {
  return client.db
    .query("SELECT id, amount FROM expense_payments WHERE method='credit' ORDER BY id")
    .map((p) => `${p.id}|${p.amount}`)
    .join(';');
}

// ── seed a server (credit + expense snapshots) ──
async function seedServer(url: string, token: string, branchId: string, opts: { withCredit?: boolean } = {}): Promise<void> {
  const changes: unknown[] = [
    { table_name: 'expenses', record_id: 'exp-1', action: 'insert', data: JSON.stringify({ id: 'exp-1', branch_id: branchId, supplier_id: 'sup-1', amount: 100, paid_amount: 0, status: 'PENDING' }) },
  ];
  if (opts.withCredit !== false) {
    changes.unshift({ table_name: 'supplier_credits', record_id: 'cred-1', action: 'insert', data: JSON.stringify({ id: 'cred-1', branch_id: branchId, supplier_id: 'sup-1', amount: 100, used_amount: 0, status: 'OPEN' }) });
  }
  const r = await syncPush(url, token, changes);
  assert(r.status === 200, `seed push 200 (got ${r.status})`);
}

// ── D1 helpers ──
// Assert that a legacy sync-push mutation is rejected by the B0 bridge with a stable code.
async function assertBlocked(url: string, token: string, changes: unknown[], code: string): Promise<void> {
  const r = await syncPush(url, token, changes);
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  assert(r.status === 409, `expected 409 block (got ${r.status}) for ${code}`);
  assert(body.error === code, `expected ${code} (got ${JSON.stringify(body)})`);
}
// Seed a server + drive one full-100 credit op to accepted → exp-1/cred-1 are now cut over
// (server projections + revisions materialised). Returns the applied client A.
async function seedAndCutover(
  SQL: { Database: new () => SqlDb },
  srv: Server,
  token: string,
  branchId: string,
): Promise<ReturnType<typeof makeClient>> {
  await seedServer(srv.url, token, branchId);
  const A = makeClient(SQL, branchId);
  const op = buildFullOp(A);
  const r = await submitOp(srv.url, token, op.payload);
  assert(r.status === 200 && r.body.status === 'accepted', `cutover accepted (got ${r.status}/${r.body.status})`);
  await pullApply(srv.url, token, A);
  assertClientEndState(A);
  return A;
}

// ═══════════════════════════════════ scenarios ═══════════════════════════════════
async function main(): Promise<void> {
  const SQL = (await initSqlJs()) as unknown as { Database: new () => SqlDb };
  console.log('B1 desktop end-to-end harness\n');

  // ── A-wins (and B conflicts), both converge over pull ──
  await scenario('A-wins → B conflict (STALE_REVISION) → both converge', async () => {
    const srv = await startServer();
    try {
      const email = `a${Date.now()}@x.com`;
      const reg = await register(srv.url, email);
      const tokenA = reg.token;
      const tokenB = await login(srv.url, email); // same user, 2nd device token
      await seedServer(srv.url, tokenA, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const B = makeClient(SQL, reg.branchId);

      const opA = buildFullOp(A);
      const opB = buildFullOp(B); // both at revision 0
      const rA = await submitOp(srv.url, tokenA, opA.payload);
      assert(rA.status === 200 && rA.body.status === 'accepted', `A accepted (got ${rA.status}/${rA.body.status})`);
      const rB = await submitOp(srv.url, tokenB, opB.payload);
      assert(rB.status === 200 && rB.body.status === 'conflict', `B conflict (got ${rB.status}/${rB.body.status})`);
      assert(rB.body.errorCode === 'STALE_REVISION', `B STALE_REVISION (got ${rB.body.errorCode})`);

      await pullApply(srv.url, tokenA, A);
      await pullApply(srv.url, tokenB, B);
      assertClientEndState(A);
      assertClientEndState(B);
      assert(ledgerKey(A) === ledgerKey(B), 'A and B converge on ledger ids');
      assert(paymentKey(A) === paymentKey(B), 'A and B converge on payment id');
      assert(proto.readOpCursor(A.db) === proto.readOpCursor(B.db), 'A and B converge on cursor');
    } finally {
      srv.kill();
    }
  });

  // ── B-wins (mirror) ──
  await scenario('B-wins → A conflict → both converge', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `b${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const B = makeClient(SQL, reg.branchId);
      const opA = buildFullOp(A);
      const opB = buildFullOp(B);
      const rB = await submitOp(srv.url, reg.token, opB.payload);
      assert(rB.body.status === 'accepted', 'B accepted');
      const rA = await submitOp(srv.url, reg.token, opA.payload);
      assert(rA.body.status === 'conflict' && rA.body.errorCode === 'STALE_REVISION', 'A conflict STALE_REVISION');
      await pullApply(srv.url, reg.token, A);
      await pullApply(srv.url, reg.token, B);
      assertClientEndState(A);
      assertClientEndState(B);
      assert(ledgerKey(A) === ledgerKey(B), 'converge ledger');
    } finally {
      srv.kill();
    }
  });

  // ── genuinely concurrent: exactly one accepted, one conflict, zero transient ──
  await scenario('concurrent submit → exactly 1 accepted / 1 conflict / 0 transient', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `c${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const B = makeClient(SQL, reg.branchId);
      const opA = buildFullOp(A);
      const opB = buildFullOp(B);
      const [rA, rB] = await Promise.all([submitOp(srv.url, reg.token, opA.payload), submitOp(srv.url, reg.token, opB.payload)]);
      const outcomes = [rA, rB].map((r) => r.body.status);
      const accepted = outcomes.filter((s) => s === 'accepted').length;
      const conflict = outcomes.filter((s) => s === 'conflict').length;
      const transient = [rA, rB].filter((r) => r.status === 503).length;
      assert(accepted === 1, `exactly one accepted (got ${accepted}): ${JSON.stringify(outcomes)}`);
      assert(conflict === 1, `exactly one conflict (got ${conflict})`);
      assert(transient === 0, `zero transient (got ${transient})`);
      // credit consumed exactly once on the server (via a pull on a fresh client)
      const V = makeClient(SQL, reg.branchId);
      await pullApply(srv.url, reg.token, V);
      assertClientEndState(V);
    } finally {
      srv.kill();
    }
  });

  // ── idempotent replay: same id + same payload → REPLAY_STORED, no new state ──
  await scenario('idempotent replay (REPLAY_STORED) — no extra writes', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const op = buildFullOp(A);
      const r1 = await submitOp(srv.url, reg.token, op.payload);
      assert(r1.body.status === 'accepted', 'first accepted');
      const r2 = await submitOp(srv.url, reg.token, op.payload);
      assert(r2.body.retryAction === 'REPLAY_STORED', `replay (got ${r2.body.retryAction})`);
      // exactly one operation delivered by the pull
      const pull = await pullOps(srv.url, reg.token, 0, 200);
      assert((pull.operations as unknown[]).length === 1, 'exactly one envelope on the server');
      // local idempotent apply: applying twice changes nothing
      await pullApply(srv.url, reg.token, A);
      const led1 = ledgerKey(A);
      const env = (pull.operations as { envelope: proto.Envelope }[])[0].envelope;
      A.apply(env); // second apply
      assert(ledgerKey(A) === led1, 'second local apply is a no-op');
      assertClientEndState(A);
    } finally {
      srv.kill();
    }
  });

  // ── operationId reuse: same id, different payload → OPERATION_ID_REUSED ──
  await scenario('operationId reuse (different hash) → OPERATION_ID_REUSED, original preserved', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `e${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const op = buildFullOp(A);
      await submitOp(srv.url, reg.token, op.payload);
      const reused = { ...op.payload, allocations: [{ ...op.payload.allocations[0], amountFils: '10000' }] };
      const r = await submitOp(srv.url, reg.token, reused);
      assert(r.body.errorCode === 'OPERATION_ID_REUSED', `reuse rejected (got ${r.body.errorCode})`);
      const st = await getStatus(srv.url, reg.token, op.operationId);
      assert(st.status === 'accepted', 'original op still accepted');
    } finally {
      srv.kill();
    }
  });

  // ── unknown commit status: response lost after commit → status query → apply once ──
  await scenario('unknown commit status → status query confirms accepted → apply once', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `f${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const op = buildFullOp(A);
      await submitOp(srv.url, reg.token, op.payload); // pretend the response was lost
      const st = await getStatus(srv.url, reg.token, op.operationId);
      assert(st.status === 'accepted' && st.envelope, 'status accepted with envelope');
      A.apply(st.envelope as proto.Envelope);
      assertClientEndState(A);
      // a later pull does NOT double-apply
      await pullApply(srv.url, reg.token, A);
      assertClientEndState(A);
    } finally {
      srv.kill();
    }
  });

  // ── operations-pull convergence: client B never submitted, learns via pull ──
  await scenario('operations-pull convergence (B never submitted) — apply once, no duplicate', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `g${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const B = makeClient(SQL, reg.branchId);
      const op = buildFullOp(A);
      await submitOp(srv.url, reg.token, op.payload);
      const n = await pullApply(srv.url, reg.token, B);
      assert(n === 1, `B applied exactly one (got ${n})`);
      assertClientEndState(B);
      const n2 = await pullApply(srv.url, reg.token, B); // re-pull from cursor
      assert(n2 === 0, 'B re-pull delivers no duplicate');
    } finally {
      srv.kill();
    }
  });

  // ── offline: server unreachable → submit fails, NO local mutation ──
  await scenario('offline (server unreachable) → no local mutation', async () => {
    const A = makeClient(SQL, 'b1');
    const op = buildFullOp(A);
    let threw = false;
    try {
      await fetch('http://127.0.0.1:9/api/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
        body: JSON.stringify(op.payload),
      });
    } catch {
      threw = true;
    }
    assert(threw, 'submit to a dead server throws (offline)');
    // no local apply happened
    assert(A.db.query("SELECT id FROM expense_payments WHERE method='credit'").length === 0, 'no local credit payment');
    assert(proto.readRevision(A.db, proto.AGG_CREDIT, 'cred-1') === 0, 'no revision change');
  });

  // ── bootstrap: server lacks the snapshot → FINANCE_NOT_BOOTSTRAPPED, no writes ──
  await scenario('bootstrap required (FINANCE_NOT_BOOTSTRAPPED) — no writes, no seeding', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `h${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId, { withCredit: false }); // expense only, NO credit snapshot
      const A = makeClient(SQL, reg.branchId);
      const op = buildFullOp(A);
      const r = await submitOp(srv.url, reg.token, op.payload);
      assert(r.status === 503, `transient 503 (got ${r.status})`);
      assert(r.body.errorCode === 'FINANCE_NOT_BOOTSTRAPPED', `bootstrap code (got ${r.body.errorCode})`);
      // nothing stored on the server
      const pull = await pullOps(srv.url, reg.token, 0, 200);
      assert((pull.operations as unknown[]).length === 0, 'no envelope created');
    } finally {
      srv.kill();
    }
  });

  // ═══════════ D1 — finance hardening: protected mutations, folds & idempotency ═══════════

  // 1) credit-settled expense DELETE via legacy sync → blocked
  await scenario('D1: credit-settled expense delete blocked (B0_PROTECTED_EXPENSE_CANCEL_DELETE)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1a${Date.now()}@x.com`);
      await seedAndCutover(SQL, srv, reg.token, reg.branchId);
      await assertBlocked(
        srv.url,
        reg.token,
        [{ table_name: 'expenses', record_id: 'exp-1', action: 'delete', data: JSON.stringify({}) }],
        'B0_PROTECTED_EXPENSE_CANCEL_DELETE',
      );
    } finally {
      srv.kill();
    }
  });

  // 2) credit-settled expense CANCEL via legacy sync → blocked
  await scenario('D1: credit-settled expense cancel blocked (B0_PROTECTED_EXPENSE_CANCEL_DELETE)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1b${Date.now()}@x.com`);
      await seedAndCutover(SQL, srv, reg.token, reg.branchId);
      await assertBlocked(
        srv.url,
        reg.token,
        [{ table_name: 'expenses', record_id: 'exp-1', action: 'update', data: JSON.stringify({ status: 'CANCELLED' }) }],
        'B0_PROTECTED_EXPENSE_CANCEL_DELETE',
      );
    } finally {
      srv.kill();
    }
  });

  // 3) supplier change on a credit-settled expense → blocked
  await scenario('D1: expense supplier change blocked (B0_SUPPLIER_CHANGE_LOCKED)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1c${Date.now()}@x.com`);
      await seedAndCutover(SQL, srv, reg.token, reg.branchId);
      await assertBlocked(
        srv.url,
        reg.token,
        [{ table_name: 'expenses', record_id: 'exp-1', action: 'update', data: JSON.stringify({ supplier_id: 'sup-2' }) }],
        'B0_SUPPLIER_CHANGE_LOCKED',
      );
    } finally {
      srv.kill();
    }
  });

  // 4) amount reduced below the settled credit → blocked (the server floor under the desktop guard)
  await scenario('D1: expense amount below settled credit blocked (B0_SETTLEMENT_OVERPAYMENT)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1d${Date.now()}@x.com`);
      await seedAndCutover(SQL, srv, reg.token, reg.branchId);
      await assertBlocked(
        srv.url,
        reg.token,
        [{ table_name: 'expenses', record_id: 'exp-1', action: 'update', data: JSON.stringify({ amount: 50 }) }],
        'B0_SETTLEMENT_OVERPAYMENT',
      );
    } finally {
      srv.kill();
    }
  });

  // 5) used supplier credit DELETE via legacy sync → blocked
  await scenario('D1: used supplier credit delete blocked (B0_PROTECTED_CREDIT_DELETE_REFUND)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1e${Date.now()}@x.com`);
      await seedAndCutover(SQL, srv, reg.token, reg.branchId);
      await assertBlocked(
        srv.url,
        reg.token,
        [{ table_name: 'supplier_credits', record_id: 'cred-1', action: 'delete', data: JSON.stringify({}) }],
        'B0_PROTECTED_CREDIT_DELETE_REFUND',
      );
    } finally {
      srv.kill();
    }
  });

  // 6) used supplier credit amount reduction via legacy sync → blocked
  await scenario('D1: used supplier credit amount reduction blocked (B0_PROTECTED_CREDIT_PAYMENT)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1f${Date.now()}@x.com`);
      await seedAndCutover(SQL, srv, reg.token, reg.branchId);
      await assertBlocked(
        srv.url,
        reg.token,
        [{ table_name: 'supplier_credits', record_id: 'cred-1', action: 'update', data: JSON.stringify({ amount: 50 }) }],
        'B0_PROTECTED_CREDIT_PAYMENT',
      );
    } finally {
      srv.kill();
    }
  });

  // 7) a legacy credit-method payment on the protected case → blocked
  await scenario('D1: legacy credit-payment mutation blocked (B0_PROTECTED_CREDIT_PAYMENT)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1g${Date.now()}@x.com`);
      await seedAndCutover(SQL, srv, reg.token, reg.branchId);
      await assertBlocked(
        srv.url,
        reg.token,
        [{ table_name: 'expense_payments', record_id: 'legacy-credit-pay', action: 'insert', data: JSON.stringify({ id: 'legacy-credit-pay', expense_id: 'exp-1', amount: 10, method: 'credit', reference: 'cred-1' }) }],
        'B0_PROTECTED_CREDIT_PAYMENT',
      );
    } finally {
      srv.kill();
    }
  });

  // 8) cash/bank/benefit payment on a partially-credit-settled (cut-over) expense still folds (200)
  await scenario('D1: cash payment compatible after cutover (folded, not blocked)', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1h${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      // partial credit apply: 60 of the 100 credit onto exp-1 → open remaining 40
      const p = A.plan(60_000);
      const grouped = proto.groupByCredit(p.allocations);
      const payload = proto.buildPayload(A.db, {
        operationId: randomUUID(),
        branchId: reg.branchId,
        creditId: 'cred-1',
        nowIso: new Date().toISOString(),
        allocations: grouped[0].allocations,
      });
      const rr = await submitOp(srv.url, reg.token, payload);
      assert(rr.status === 200 && rr.body.status === 'accepted', `partial credit accepted (got ${rr.status}/${rr.body.status})`);
      // a legacy cash payment of the remaining 40 must FOLD (not be blocked)
      const r = await syncPush(srv.url, reg.token, [
        { table_name: 'expense_payments', record_id: 'cash-pay-1', action: 'insert', data: JSON.stringify({ id: 'cash-pay-1', expense_id: 'exp-1', amount: 40, method: 'cash' }) },
        { table_name: 'expenses', record_id: 'exp-1', action: 'update', data: JSON.stringify({ paid_amount: 40, status: 'PAID' }) },
      ]);
      assert(r.status === 200, `cash payment folds after cutover (got ${r.status})`);
    } finally {
      srv.kill();
    }
  });

  // 9) operations-pull is idempotent across an app restart (cursor + applied-guard persist)
  await scenario('D1: operations-pull idempotent across app restart', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1i${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const op = buildFullOp(A);
      await submitOp(srv.url, reg.token, op.payload);
      const B = makeClient(SQL, reg.branchId);
      const n1 = await pullApply(srv.url, reg.token, B);
      assert(n1 === 1, `B applied one (got ${n1})`);
      // simulate an app restart: export B's DB bytes and reopen a fresh connection on them
      const bytes = B.raw.export();
      const SQLctor = SQL as unknown as { Database: new (data?: Uint8Array) => SqlDb };
      const reopened = new SQLctor.Database(bytes);
      const db2: proto.Db = {
        run: (sql, params) => reopened.run(sql, (params as never[]) ?? []),
        query: (sql, params) => {
          const res = reopened.exec(sql, (params as never[]) ?? []);
          if (res.length === 0) return [];
          const { columns, values } = res[0];
          return values.map((row: unknown[]) => {
            const o: Record<string, unknown> = {};
            columns.forEach((c: string, i: number) => (o[c] = row[i]));
            return o;
          });
        },
      };
      // cursor persisted → re-pull from the reopened DB delivers nothing new
      const since = proto.readOpCursor(db2);
      const res = await pullOps(srv.url, reg.token, since, 200);
      assert(((res.operations as unknown[]) || []).length === 0, 'no ops after restart (cursor survived)');
      // and the applied-envelope idempotency record survived the restart
      assert(db2.query('SELECT operation_id FROM b1_applied_envelopes').length === 1, 'applied-envelope record survived restart');
    } finally {
      srv.kill();
    }
  });

  // 10) a losing conflict leaves the loser's local DB clean, then converges on refresh
  await scenario('D1: conflict leaves loser local DB clean, refresh converges', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1j${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const B = makeClient(SQL, reg.branchId);
      await submitOp(srv.url, reg.token, buildFullOp(A).payload); // A wins
      const rB = await submitOp(srv.url, reg.token, buildFullOp(B).payload);
      assert(rB.body.status === 'conflict', `B conflict (got ${rB.body.status})`);
      // no local financial write happened on B before the authoritative accept
      assert(B.db.query("SELECT id FROM expense_payments WHERE expense_id='exp-1'").length === 0, 'B no local payment after conflict');
      assert(B.db.query('SELECT id FROM ledger_entries').length === 0, 'B no local ledger after conflict');
      assert(proto.readRevision(B.db, proto.AGG_CREDIT, 'cred-1') === 0, 'B credit revision still 0 after conflict');
      // refresh via pull → converges to the authoritative end state
      await pullApply(srv.url, reg.token, B);
      assertClientEndState(B);
    } finally {
      srv.kill();
    }
  });

  // 11) a validation/economic rejection (CREDIT_OVERDRAWN) leaves no server or local writes
  await scenario('D1: overdrawn rejection leaves no server/local writes', async () => {
    const srv = await startServer();
    try {
      const reg = await register(srv.url, `d1k${Date.now()}@x.com`);
      await seedServer(srv.url, reg.token, reg.branchId);
      const A = makeClient(SQL, reg.branchId);
      const op = buildFullOp(A);
      // ask for 150 out of a 100 credit → overdrawn (same proven mutation shape as the reuse test)
      const overdrawn = { ...op.payload, operationId: randomUUID(), allocations: [{ ...op.payload.allocations[0], amountFils: '150000' }] };
      const r = await submitOp(srv.url, reg.token, overdrawn);
      assert(r.body.status === 'conflict' || r.body.status === 'validation_rejected', `rejected (got ${r.body.status}/${r.body.errorCode})`);
      // nothing stored on the server, nothing applied locally
      const pull = await pullOps(srv.url, reg.token, 0, 200);
      assert((pull.operations as unknown[]).length === 0, 'no envelope created');
      assert(A.db.query("SELECT id FROM expense_payments WHERE method='credit'").length === 0, 'no local credit payment');
      assert(proto.readRevision(A.db, proto.AGG_CREDIT, 'cred-1') === 0, 'no local credit revision');
    } finally {
      srv.kill();
    }
  });

  console.log(`\nB1 e2e: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
