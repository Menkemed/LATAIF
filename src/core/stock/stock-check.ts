// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1 — the desktop client for the SHARED stock-check contract.
//
// This module talks to the same Rust core (`sync::stock_check`) and therefore the same
// `stock_checks` table that `/api/stock-checks` writes from the phone. There is deliberately no
// local table, no cache and no reconciliation step: a verdict recorded on mobile is visible here
// because it is literally the same row, not a copy of one.
//
// Nothing here can change a product. The command it calls opens the business database read-only and
// only to prove the product exists — quantity, prices, status and media are unreachable from this
// path by construction.
// ════════════════════════════════════════════════════════════════════════════

export type StockCheckStatus = 'available' | 'not_available';

export interface StockCheck {
  check_id: string;
  product_id: string;
  status: StockCheckStatus;
  notes: string | null;
  checked_at: string;
  checked_by: string | null;
  checked_by_name: string | null;
  source: 'mobile' | 'desktop';
}

/** Mirrors the server-side cap and the v0019 CHECK constraint. */
export const MAX_STOCK_CHECK_NOTES = 500;

export const STOCK_CHECK_STATUSES: readonly StockCheckStatus[] = ['available', 'not_available'];

export function isStockCheckStatus(v: unknown): v is StockCheckStatus {
  return typeof v === 'string' && (STOCK_CHECK_STATUSES as readonly string[]).includes(v);
}

/**
 * Trim, treat blank as absent, and refuse an over-long note BEFORE the round trip.
 *
 * The backend enforces the same rule — this is not the guard, it is the fast feedback. Returning a
 * discriminated result rather than throwing keeps the caller's error handling to one branch.
 */
export function prepareNotes(raw: string): { ok: true; value: string | null } | { ok: false; reason: 'too_long' } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  if ([...trimmed].length > MAX_STOCK_CHECK_NOTES) return { ok: false, reason: 'too_long' };
  return { ok: true, value: trimmed };
}

/** Newest first — the order the backend already returns, asserted here so the UI cannot rely on luck. */
export function sortNewestFirst(checks: readonly StockCheck[]): StockCheck[] {
  return [...checks].sort((a, b) => {
    if (a.checked_at !== b.checked_at) return a.checked_at < b.checked_at ? 1 : -1;
    return a.check_id < b.check_id ? 1 : -1;
  });
}

/** The verdict that counts right now, or null when this item has never been checked. */
export function latestOf(checks: readonly StockCheck[]): StockCheck | null {
  return sortNewestFirst(checks)[0] ?? null;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke(cmd, args) as Promise<T>;
}

export async function listStockChecks(productId: string, limit = 20): Promise<StockCheck[]> {
  return invoke<StockCheck[]>('list_stock_checks', { productId, limit });
}

/**
 * Record one check. `requestId` makes a double-click idempotent: the backend returns the check it
 * already stored instead of inventing a second observation. A deliberate new check is a new call
 * with a new id, which is why the id is minted per invocation and never reused.
 */
export async function recordStockCheck(params: {
  productId: string;
  status: StockCheckStatus;
  notes: string | null;
  userId?: string;
  requestId: string;
}): Promise<StockCheck> {
  return invoke<StockCheck>('create_stock_check', {
    productId: params.productId,
    status: params.status,
    notes: params.notes,
    userId: params.userId || null,
    requestId: params.requestId,
  });
}

export async function latestStockChecks(productIds: string[]): Promise<Record<string, StockCheck>> {
  if (productIds.length === 0) return {};
  return invoke<Record<string, StockCheck>>('latest_stock_checks', { productIds });
}

/** Human label for a verdict. One place, so mobile and desktop wording cannot drift apart. */
export function stockCheckLabel(status: StockCheckStatus): string {
  return status === 'available' ? 'Available' : 'Not available';
}
