// ═══════════════════════════════════════════════════════════
// LATAIF — B1 client-side protocol for APPLY_SUPPLIER_CREDIT_TO_EXPENSES
// ═══════════════════════════════════════════════════════════
//
// PURE + self-contained: NO desktop imports (no React, no Tauri, no stores).
// Takes a tiny `Db` interface so the SAME code runs in the desktop (sql.js via
// getDatabase) AND in the Node e2e harness (sql.js directly) — one authoritative
// client apply, never two divergent implementations.
//
// It owns: exact BHD↔fils money (canonical i64 decimal strings, protocol v4),
// the payload contract (one credit, N expense allocations), idempotent local
// apply of an accepted operation envelope (mutations + ledger), and the small
// local persistence (authoritative revisions, operation rows, applied-envelope
// guard, operations-pull cursor).
//
// It does NOT do HTTP (see client.ts) and it NEVER enqueues a legacy sync change
// (apply is suppression-by-design — direct writes only, no trackChange).

// ── tiny DB port (sql.js-compatible; the caller owns the transaction) ──
export interface Db {
  run(sql: string, params?: unknown[]): void;
  query(sql: string, params?: unknown[]): Record<string, unknown>[];
}

export const AGG_CREDIT = 'SUPPLIER_CREDIT_BALANCE';
export const AGG_EXPENSE = 'EXPENSE_SETTLEMENT';
export const OPERATION_TYPE = 'APPLY_SUPPLIER_CREDIT_TO_EXPENSES';
export const PROTOCOL_VERSION = 4;
const SOURCE_MODULE = 'B1_APPLY_SUPPLIER_CREDIT_TO_EXPENSES';

// ── exact money: BHD real → integer fils → canonical i64 decimal string ──

/** BHD number → integer fils (exact, round-to-nearest-fil). */
export function toFils(bhd: number): number {
  return Math.round((bhd || 0) * 1000);
}
/** Integer fils → canonical i64 decimal string (no sign, no leading zero). */
export function filsToCanonical(fils: number): string {
  if (!Number.isInteger(fils) || fils < 0) {
    throw new Error(`filsToCanonical: not a non-negative integer fils: ${fils}`);
  }
  return String(fils);
}
/** Canonical i64 decimal string → integer fils. */
export function canonicalToFils(s: string | undefined | null): number {
  if (typeof s !== 'string' || s.length === 0 || !/^[0-9]+$/.test(s)) {
    throw new Error(`canonicalToFils: not a canonical i64 string: ${String(s)}`);
  }
  if (s.length > 1 && s[0] === '0') throw new Error(`canonicalToFils: leading zero: ${s}`);
  return Number(s);
}
/** Integer fils → BHD number. */
export function filsToBhd(fils: number): number {
  return fils / 1000;
}

/** Frozen business-timestamp format `YYYY-MM-DDThh:mm:ss.sssZ`. */
export function businessTimestamp(nowIso: string): string {
  // nowIso is a full ISO string; normalise to millisecond precision + Z.
  const d = new Date(nowIso);
  return d.toISOString().replace(/\.\d+Z$/, (m) => m).replace(/Z$/, 'Z');
}

// ── payload contract (one credit, many expense allocations) ──

export interface AllocationInput {
  expenseId: string;
  amountFils: number; // integer fils
}

export interface OperationPayload {
  protocolVersion: number;
  operationType: string;
  operationId: string;
  businessTimestamp: string;
  branchId: string;
  creditId: string;
  expectedCreditRevision: string;
  allocations: { expenseId: string; amountFils: string; expectedExpenseRevision: string }[];
}

/**
 * Build the canonical payload for ONE credit. `expectedCreditRevision` and each
 * `expectedExpenseRevision` come from the local authoritative_revisions table
 * (default "0" for a not-yet-cut-over aggregate). Allocations are sorted
 * deterministically by expenseId; a duplicate expense is rejected.
 */
export function buildPayload(
  db: Db,
  args: {
    operationId: string;
    branchId: string;
    creditId: string;
    nowIso: string;
    allocations: AllocationInput[];
  },
): OperationPayload {
  const seen = new Set<string>();
  const allocs = [...args.allocations]
    .map((a) => {
      if (seen.has(a.expenseId)) throw new Error(`buildPayload: duplicate expense ${a.expenseId}`);
      seen.add(a.expenseId);
      if (!(Number.isInteger(a.amountFils) && a.amountFils > 0)) {
        throw new Error(`buildPayload: amountFils must be a positive integer: ${a.amountFils}`);
      }
      return a;
    })
    .sort((a, b) => a.expenseId.localeCompare(b.expenseId))
    .map((a) => ({
      expenseId: a.expenseId,
      amountFils: filsToCanonical(a.amountFils),
      expectedExpenseRevision: filsToCanonical(readRevision(db, AGG_EXPENSE, a.expenseId)),
    }));

  return {
    protocolVersion: PROTOCOL_VERSION,
    operationType: OPERATION_TYPE,
    operationId: args.operationId,
    businessTimestamp: businessTimestamp(args.nowIso),
    branchId: args.branchId,
    creditId: args.creditId,
    expectedCreditRevision: filsToCanonical(readRevision(db, AGG_CREDIT, args.creditId)),
    allocations: allocs,
  };
}

/** Group a flat FIFO allocation plan into one operation per credit. */
export function groupByCredit(
  allocations: { creditId: string; expenseId: string; amountF: number }[],
): { creditId: string; allocations: AllocationInput[] }[] {
  const byCredit = new Map<string, Map<string, number>>();
  for (const a of allocations) {
    if (!byCredit.has(a.creditId)) byCredit.set(a.creditId, new Map());
    const m = byCredit.get(a.creditId)!;
    m.set(a.expenseId, (m.get(a.expenseId) || 0) + a.amountF);
  }
  // deterministic credit order
  return [...byCredit.keys()].sort().map((creditId) => ({
    creditId,
    allocations: [...byCredit.get(creditId)!.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([expenseId, amountFils]) => ({ expenseId, amountFils })),
  }));
}

// ── authoritative revisions (separate table; never hidden in free JSON) ──

export function readRevision(db: Db, aggType: string, aggId: string): number {
  const rows = db.query(
    'SELECT revision FROM authoritative_revisions WHERE aggregate_type = ? AND aggregate_id = ?',
    [aggType, aggId],
  );
  if (rows.length === 0) return 0;
  return Number(rows[0].revision) || 0;
}

export function writeRevision(db: Db, aggType: string, aggId: string, revision: number, now: string): void {
  const exists = db.query(
    'SELECT 1 AS x FROM authoritative_revisions WHERE aggregate_type = ? AND aggregate_id = ?',
    [aggType, aggId],
  ).length > 0;
  if (exists) {
    db.run(
      'UPDATE authoritative_revisions SET revision = ?, updated_at = ? WHERE aggregate_type = ? AND aggregate_id = ?',
      [revision, now, aggType, aggId],
    );
  } else {
    db.run(
      'INSERT INTO authoritative_revisions (aggregate_type, aggregate_id, revision, updated_at) VALUES (?, ?, ?, ?)',
      [aggType, aggId, revision, now],
    );
  }
}

// ── operation rows (idempotency / retry / restart-recovery) ──

export interface OperationRow {
  operationId: string;
  operationType: string;
  branchId: string;
  payloadHash: string;
  status: string; // pending | accepted | conflict | validation_rejected | transient | reused
  serverSequence: number | null;
  resultJson: string | null;
}

export function upsertOperation(db: Db, row: OperationRow, now: string): void {
  const exists = db.query('SELECT 1 AS x FROM b1_operations WHERE operation_id = ?', [row.operationId]).length > 0;
  if (exists) {
    db.run(
      `UPDATE b1_operations SET status = ?, server_sequence = ?, result_json = ?, payload_hash = ?, updated_at = ?
       WHERE operation_id = ?`,
      [row.status, row.serverSequence, row.resultJson, row.payloadHash, now, row.operationId],
    );
  } else {
    db.run(
      `INSERT INTO b1_operations
         (operation_id, operation_type, branch_id, payload_hash, status, server_sequence, result_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.operationId, row.operationType, row.branchId, row.payloadHash, row.status, row.serverSequence, row.resultJson, now, now],
    );
  }
}

export function getOperation(db: Db, operationId: string): OperationRow | null {
  const rows = db.query(
    `SELECT operation_id, operation_type, branch_id, payload_hash, status, server_sequence, result_json
       FROM b1_operations WHERE operation_id = ?`,
    [operationId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    operationId: String(r.operation_id),
    operationType: String(r.operation_type),
    branchId: String(r.branch_id),
    payloadHash: String(r.payload_hash ?? ''),
    status: String(r.status),
    serverSequence: r.server_sequence == null ? null : Number(r.server_sequence),
    resultJson: r.result_json == null ? null : String(r.result_json),
  };
}

// ── operations-pull cursor (survives restarts; advanced only after apply) ──

export function readOpCursor(db: Db): number {
  const rows = db.query("SELECT value FROM b1_op_meta WHERE key = 'pull_cursor'");
  if (rows.length === 0) return 0;
  return Number(rows[0].value) || 0;
}

export function writeOpCursor(db: Db, cursor: number, now: string): void {
  const exists = db.query("SELECT 1 AS x FROM b1_op_meta WHERE key = 'pull_cursor'").length > 0;
  if (exists) {
    db.run("UPDATE b1_op_meta SET value = ?, updated_at = ? WHERE key = 'pull_cursor'", [String(cursor), now]);
  } else {
    db.run("INSERT INTO b1_op_meta (key, value, updated_at) VALUES ('pull_cursor', ?, ?)", [String(cursor), now]);
  }
}

// ── idempotent local apply of an accepted operation envelope ──

export interface Envelope {
  operationId: string;
  serverSequence: string;
  operationType: string;
  branchId: string;
  mutationCount: number;
  mutations: {
    ordinal: number;
    action: string;
    table: string;
    recordId: string;
    recordRevision: string;
    payload: Record<string, unknown>;
  }[];
  ledger: {
    transactionId: string;
    entries: {
      id: string;
      entryNo: string;
      account: string;
      direction: string;
      amountFils: string;
      counterpartyType: string;
      counterpartyId: string;
    }[];
  };
  result: Record<string, unknown>;
}

export interface ApplyResult {
  applied: boolean; // false if it was already applied (idempotent no-op)
  operationId: string;
}

/**
 * Apply one accepted operation envelope to the local DB. Idempotent: a second
 * call for the same `operationId` is a no-op (returns applied=false). NEVER calls
 * trackChange — these are authoritative server rows, not local edits. The CALLER
 * must wrap this in a local transaction.
 */
export function applyEnvelope(db: Db, env: Envelope, ctx: { now: string; actor: string; branchId: string }): ApplyResult {
  // idempotency guard — keyed on the server operationId (apply-once across both
  // the submit response AND the operations-pull).
  if (db.query('SELECT 1 AS x FROM b1_applied_envelopes WHERE operation_id = ?', [env.operationId]).length > 0) {
    return { applied: false, operationId: env.operationId };
  }

  const muts = [...(env.mutations || [])].sort((a, b) => a.ordinal - b.ordinal);
  for (const m of muts) {
    const p = m.payload || {};
    if (m.table === 'supplier_credits') {
      const used = filsToBhd(canonicalToFils(p.usedAmountFils as string));
      const status = String(p.status ?? 'OPEN');
      const exists = db.query('SELECT 1 AS x FROM supplier_credits WHERE id = ?', [m.recordId]).length > 0;
      if (exists) {
        db.run('UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?', [used, status, m.recordId]);
      } else {
        // robust fallback: materialise from the authoritative snapshot
        db.run(
          `INSERT INTO supplier_credits (id, branch_id, supplier_id, amount, used_amount, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [m.recordId, ctx.branchId, String(p.supplierId ?? ''), filsToBhd(canonicalToFils(p.amountFils as string)), used, status, ctx.now],
        );
      }
      writeRevision(db, AGG_CREDIT, m.recordId, canonicalToFils(m.recordRevision), ctx.now);
    } else if (m.table === 'expenses') {
      // settlement status only — paid_amount stays cash-only (the operation never
      // changes it; creditPaidFils is captured by expense_payments + revision).
      const status = String(p.status ?? 'PENDING');
      const exists = db.query('SELECT 1 AS x FROM expenses WHERE id = ?', [m.recordId]).length > 0;
      if (exists) {
        db.run("UPDATE expenses SET status = ? WHERE id = ? AND status != 'CANCELLED'", [status, m.recordId]);
      }
      writeRevision(db, AGG_EXPENSE, m.recordId, canonicalToFils(m.recordRevision), ctx.now);
    } else if (m.table === 'expense_payments') {
      const exists = db.query('SELECT 1 AS x FROM expense_payments WHERE id = ?', [m.recordId]).length > 0;
      if (!exists) {
        const amt = filsToBhd(canonicalToFils(p.amountFils as string));
        const paidAt = ctx.now.includes('T') ? ctx.now.split('T')[0] : ctx.now;
        db.run(
          `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, reference, note, created_at)
           VALUES (?, ?, ?, 'credit', ?, ?, 'Applied from supplier credit (operation)', ?)`,
          [m.recordId, String(p.expenseId ?? ''), amt, paidAt, String(p.creditId ?? ''), ctx.now],
        );
      }
    }
    // unknown tables are ignored (forward-compat); this slice has exactly the 3.
  }

  // ledger — exactly the server's deterministic effects, applied once. Entry IDs
  // are the dedup key; entry_no is a LOCAL display ordinal (the server's per-branch
  // entry_no is not reused to avoid colliding with local cash/bank entries).
  applyLedger(db, env, ctx);

  db.run('INSERT INTO b1_applied_envelopes (operation_id, server_sequence, applied_at) VALUES (?, ?, ?)', [
    env.operationId,
    canonicalToFils(env.serverSequence),
    ctx.now,
  ]);

  // record/refresh the local operation row (self-submitted ops were created at
  // submit time; pulled ops get a row here too).
  const existsOp = db.query('SELECT 1 AS x FROM b1_operations WHERE operation_id = ?', [env.operationId]).length > 0;
  if (existsOp) {
    db.run('UPDATE b1_operations SET status = ?, server_sequence = ?, updated_at = ? WHERE operation_id = ?', [
      'accepted',
      canonicalToFils(env.serverSequence),
      ctx.now,
      env.operationId,
    ]);
  }

  return { applied: true, operationId: env.operationId };
}

function nextLocalEntryNo(db: Db, branchId: string, now: string): number {
  const exists = db.query('SELECT next_no FROM ledger_sequence WHERE branch_id = ?', [branchId]);
  let n: number;
  if (exists.length === 0) {
    n = 1;
    db.run('INSERT INTO ledger_sequence (branch_id, next_no, updated_at) VALUES (?, ?, ?)', [branchId, n + 1, now]);
  } else {
    n = Number(exists[0].next_no) || 1;
    db.run('UPDATE ledger_sequence SET next_no = ?, updated_at = ? WHERE branch_id = ?', [n + 1, now, branchId]);
  }
  return n;
}

function applyLedger(db: Db, env: Envelope, ctx: { now: string; actor: string; branchId: string }): void {
  for (const e of env.ledger?.entries ?? []) {
    if (db.query('SELECT 1 AS x FROM ledger_entries WHERE id = ?', [e.id]).length > 0) continue; // already applied
    const entryNo = nextLocalEntryNo(db, ctx.branchId, ctx.now);
    db.run(
      `INSERT INTO ledger_entries
         (id, branch_id, entry_no, transaction_id, occurred_at, recorded_at, account, direction, amount, currency,
          counterparty_type, counterparty_id, source_module, source_id, metadata_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BHD', ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.id,
        ctx.branchId,
        entryNo,
        env.ledger.transactionId,
        ctx.now,
        ctx.now,
        e.account,
        e.direction,
        filsToBhd(canonicalToFils(e.amountFils)),
        e.counterpartyType,
        e.counterpartyId,
        SOURCE_MODULE,
        env.operationId,
        JSON.stringify({ operationId: env.operationId }),
        ctx.actor,
        ctx.now,
      ],
    );
  }
}

// ── apply a server-provided authoritative snapshot after a conflict ──

/**
 * On conflict the server may return current authoritative snapshots/revisions in
 * the result. Apply them so the next attempt sees the latest revisions. This is a
 * best-effort refresh; if the server returns only the conflict detail, the caller
 * should run a normal sync + operations-pull instead.
 */
export function applyConflictRefresh(db: Db, result: Record<string, unknown>, now: string): void {
  // The conflict result carries { aggregate, currentRevision, creditId?/expenseId? }.
  const agg = result.aggregate;
  const rev = result.currentRevision;
  if (typeof agg === 'string' && typeof rev === 'string') {
    const id = (result.creditId as string) || (result.expenseId as string);
    if (id) writeRevision(db, agg, id, canonicalToFils(rev), now);
  }
}
