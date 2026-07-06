// ═══════════════════════════════════════════════════════════
// LATAIF — B1 desktop orchestrator for the supplier-credit operation
// ═══════════════════════════════════════════════════════════
//
// Replaces the old local-write-first credit path. It NEVER writes a business row
// before the server's authoritative decision. Flow:
//   read local credit/expense state → plan (existing FIFO planner) → one B1
//   operation per credit (stable operationId for retry) → submit → on accepted
//   pull-and-apply the authoritative envelope locally (idempotent, no re-push).
//
// This module is desktop-only (it wires getDatabase / getSyncUrl / fetch). The
// pure protocol + apply live in b1-protocol.ts (shared with the e2e harness).

import { v5 as uuidv5 } from 'uuid';
import { getDatabase, saveDatabase } from '../db/database';
import { query, currentBranchId, currentUserId } from '../db/helpers';
import {
  enterTransaction,
  resetTransactionContext,
  consumePendingSave,
} from '../db/transaction-context';
import { planSupplierCreditExpenseAllocations } from '../finance/expenseCreditAllocation';
import { getSyncUrl, syncNow } from '../sync/sync-service';
import * as proto from './b1-protocol';
import { submitOperation, pullOperations, getOperationStatus, type HttpConfig } from './client';

const NS_B1_OP = 'b1c0ffee-5c48-5d8f-a288-56f1876c0781';

export type ApplyOutcome =
  | 'success'
  | 'conflict'
  | 'validation'
  | 'bootstrap'
  | 'offline'
  | 'unknown'
  | 'auth_error'
  | 'server_error';

export interface ApplyCreditResult {
  outcome: ApplyOutcome;
  message: string;
  appliedBhd?: number;
}

const toFils = (n: number) => Math.round((n || 0) * 1000);

function adapter(): proto.Db {
  const db = getDatabase();
  return {
    run: (sql, params) => db.run(sql, (params as never[]) ?? []),
    query: (sql, params) => query(sql, (params as unknown[]) ?? []),
  };
}

function buildHttp(): HttpConfig | null {
  const url = getSyncUrl();
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('lataif_sync_token') : null;
  if (!url || !token) return null;
  return { url, token, fetchFn: fetch.bind(globalThis) };
}

/** Deterministic operationId for an intent → identical intent reuses the id (so a
 * retry replays rather than double-spends). */
function operationIdFor(branchId: string, creditId: string, allocations: proto.AllocationInput[]): string {
  const name = `${branchId}|${creditId}|${allocations
    .slice()
    .sort((a, b) => a.expenseId.localeCompare(b.expenseId))
    .map((a) => `${a.expenseId}:${a.amountFils}`)
    .join(',')}`;
  return uuidv5(name, NS_B1_OP);
}

// ── load the same open credit/expense snapshot the legacy planner used ──
function loadPlan(supplierId: string, branchId: string, requestedFils: number) {
  const expenseRows = query(
    `SELECT e.id AS id, e.amount AS amount, e.paid_amount AS paid, e.created_at AS created_at,
            COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep
                      WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0) AS credit_paid
       FROM expenses e
      WHERE e.supplier_id = ? AND e.branch_id = ? AND e.status != 'CANCELLED'
      ORDER BY e.created_at ASC, e.id ASC`,
    [supplierId, branchId],
  );
  const openExpenses = expenseRows.map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at || ''),
    amountF: toFils(Number(r.amount) || 0),
    settledF: toFils(Number(r.paid) || 0) + toFils(Number(r.credit_paid) || 0),
  }));
  const creditRows = query(
    `SELECT id, amount, used_amount, created_at FROM supplier_credits
      WHERE supplier_id = ? AND branch_id = ? AND status = 'OPEN'
      ORDER BY created_at ASC, id ASC`,
    [supplierId, branchId],
  );
  const openCredits = creditRows.map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at || ''),
    totalF: toFils(Number(r.amount) || 0),
    usedF: toFils(Number(r.used_amount) || 0),
  }));
  return planSupplierCreditExpenseAllocations(openExpenses, openCredits, requestedFils);
}

/** Apply one accepted envelope to the local DB in a transaction; advance the
 * operations cursor only after a successful commit. */
function applyOneEnvelope(env: proto.Envelope, branchId: string, actor: string): void {
  const db = getDatabase();
  const dbApi = adapter();
  const now = new Date().toISOString();
  const shouldCommit = enterTransaction();
  try {
    if (shouldCommit) db.run('BEGIN IMMEDIATE');
    proto.applyEnvelope(dbApi, env, { now, actor, branchId });
    proto.writeOpCursor(dbApi, proto.canonicalToFils(env.serverSequence), now);
    if (shouldCommit) db.run('COMMIT');
  } catch (e) {
    if (shouldCommit) db.run('ROLLBACK');
    resetTransactionContext();
    throw e;
  }
  if (shouldCommit) {
    consumePendingSave();
    void saveDatabase();
  }
}

/** Pull every accepted operation for this branch and apply each exactly once,
 * advancing the cursor per applied envelope. Returns the count applied. */
export async function pullAndApplyOperations(http: HttpConfig): Promise<number> {
  const branchId = currentBranchId();
  const actor = (() => {
    try {
      return currentUserId();
    } catch {
      return 'server';
    }
  })();
  let applied = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const since = proto.readOpCursor(adapter());
    const res = await pullOperations(http, since, 200);
    if ('kind' in res) return applied; // offline / auth_error → stop, cursor unchanged
    if (res.operations.length === 0) break;
    for (const op of res.operations) {
      applyOneEnvelope(op.envelope, branchId, actor); // advances cursor on commit
      applied++;
    }
    if (!res.hasMore) break;
  }
  return applied;
}

/** Background-sync hook: drain the operations-pull if the server is configured.
 * Lets passive devices converge (B1 operation effects are NOT in sync_changelog).
 * Returns 0 when not configured / offline. */
export async function pullAndApplyOperationsAuto(): Promise<number> {
  const http = buildHttp();
  if (!http) return 0;
  try {
    return await pullAndApplyOperations(http);
  } catch {
    return 0;
  }
}

/**
 * The single store-facing entry point. Applies `requestedBhd` of the supplier's
 * credits to its open expenses entirely through the authoritative server path.
 */
export async function applySupplierCreditViaServer(
  supplierId: string,
  requestedBhd: number,
): Promise<ApplyCreditResult> {
  if (!supplierId) return { outcome: 'validation', message: 'No supplier selected.' };
  const requestedFils = toFils(requestedBhd);
  if (!(requestedFils > 0)) return { outcome: 'validation', message: 'Requested amount must be greater than zero.' };

  const http = buildHttp();
  if (!http) {
    return {
      outcome: 'offline',
      message: 'An internet connection to the sync server is required to apply Supplier Credit. No payment was recorded.',
    };
  }

  let branchId = 'branch-main';
  try {
    branchId = currentBranchId();
  } catch {
    /* default */
  }

  // ── plan locally (no writes) ──
  let plan: ReturnType<typeof loadPlan>;
  try {
    plan = loadPlan(supplierId, branchId, requestedFils);
  } catch (e) {
    return { outcome: 'validation', message: e instanceof Error ? e.message : String(e) };
  }
  const creditOps = proto.groupByCredit(plan.allocations);
  if (creditOps.length === 0) return { outcome: 'validation', message: 'Nothing to apply.' };

  const db = adapter();

  // ── submit one operation per credit, sequentially ──
  for (const op of creditOps) {
    const operationId = operationIdFor(branchId, op.creditId, op.allocations);

    // reuse a persisted payload on retry (stable id + bytes + hash), else build.
    const existing = proto.getOperation(db, operationId);
    let payload: unknown;
    if (existing && existing.status === 'accepted') {
      continue; // already accepted previously → will be applied via the pull below
    }
    if (existing?.payloadHash && existingPayload(operationId)) {
      payload = JSON.parse(existingPayload(operationId)!);
    } else {
      const built = proto.buildPayload(db, {
        operationId,
        branchId,
        creditId: op.creditId,
        nowIso: new Date().toISOString(),
        allocations: op.allocations,
      });
      payload = built;
      persistPending(operationId, branchId, built);
    }

    const outcome = await submitOperation(http, payload);
    switch (outcome.kind) {
      case 'accepted':
      case 'replayed':
        markStatus(operationId, 'accepted');
        break; // continue to next credit
      case 'conflict': {
        // apply any authoritative revision the server returned, then refresh.
        applyConflict(operationId, outcome.result);
        await refresh(http);
        return {
          outcome: 'conflict',
          message:
            'This Supplier Credit or Expense was changed on another device. The latest data has been loaded. Please review and try again.',
        };
      }
      case 'validation_rejected':
        markStatus(operationId, 'validation_rejected');
        return { outcome: 'validation', message: 'The request was rejected by the server. Please review and try again.' };
      case 'operation_id_reused':
        // our persisted payload diverged from a prior submission → treat as a
        // conflict and refresh; never auto-retry with a new id.
        await refresh(http);
        return {
          outcome: 'conflict',
          message: 'This operation was already submitted with different details. The latest data has been loaded. Please review and try again.',
        };
      case 'bootstrap_required':
        // push our full local snapshots so the server can reconstruct, then ask
        // the user to retry. Never seed from local payload.
        try {
          await syncNow();
        } catch {
          /* best effort */
        }
        return {
          outcome: 'bootstrap',
          message: 'Syncing the latest data to the server. Please try applying the Supplier Credit again in a moment.',
        };
      case 'unknown_commit_status': {
        const st = await getOperationStatus(http, operationId);
        if ('status' in st && st.status === 'accepted') {
          markStatus(operationId, 'accepted');
          break;
        }
        return {
          outcome: 'unknown',
          message: 'The server did not confirm the operation. Please check your connection and try again — no double payment will occur.',
        };
      }
      case 'offline':
        return {
          outcome: 'offline',
          message: 'The sync server is unreachable. No payment was recorded. Please check your connection and try again.',
        };
      case 'auth_error':
        return { outcome: 'auth_error', message: 'Your session is not authorised for the sync server. Please reconnect and try again.' };
      case 'server_error':
        return { outcome: 'server_error', message: 'The server reported an error. No payment was recorded. Please try again later.' };
    }
  }

  // ── all credits accepted → apply the authoritative envelopes locally ──
  await pullAndApplyOperations(http);
  return { outcome: 'success', message: 'Supplier credit applied.', appliedBhd: plan.appliedF / 1000 };
}

// ── small local-persistence helpers (desktop tx is managed by the caller of
//    applyOneEnvelope; these are quick single-row writes) ──

function existingPayload(operationId: string): string | null {
  const rows = query('SELECT payload_json FROM b1_operations WHERE operation_id = ?', [operationId]);
  if (rows.length === 0 || rows[0].payload_json == null) return null;
  return String(rows[0].payload_json);
}

function persistPending(operationId: string, branchId: string, payload: proto.OperationPayload): void {
  const now = new Date().toISOString();
  const json = JSON.stringify(payload);
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO b1_operations
       (operation_id, operation_type, branch_id, payload_hash, payload_json, status, server_sequence, result_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    [operationId, proto.OPERATION_TYPE, branchId, simpleHash(json), json, now, now],
  );
  void saveDatabase();
}

function markStatus(operationId: string, status: string): void {
  getDatabase().run('UPDATE b1_operations SET status = ?, updated_at = ? WHERE operation_id = ?', [
    status,
    new Date().toISOString(),
    operationId,
  ]);
}

function applyConflict(_operationId: string, result: Record<string, unknown>): void {
  try {
    proto.applyConflictRefresh(adapter(), result, new Date().toISOString());
    void saveDatabase();
  } catch {
    /* best effort */
  }
}

async function refresh(http: HttpConfig): Promise<void> {
  try {
    await syncNow();
  } catch {
    /* best effort */
  }
  try {
    await pullAndApplyOperations(http);
  } catch {
    /* best effort */
  }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
