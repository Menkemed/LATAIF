// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §9 — runtime wiring for the bulk legacy → gallery migration.
//
// Binds the pure planner/runner to the live app: the sql.js database, the real
// StockMediaOrchestrator, the real durable-clear, and the owner-verified backup
// pre-condition. Nothing here re-implements a rule — the safety contract lives in
// `ProductMediaCutoverService`, the batch policy in `legacy-media-migration`.
//
// NEVER runs automatically. There is no startup hook, no timer and no lazy
// trigger: the only caller is the owner-gated maintenance panel.
// ════════════════════════════════════════════════════════════════════════════

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query, currentBranchId } from '@/core/db/helpers';
import { getStockMediaOrchestrator } from '@/core/media/orchestrator';
import { ProductMediaCutoverService } from '@/core/media/product-media-cutover';
import { listRestoreSnapshots } from '@/core/lifecycle/restore-wiring';
import { isTransactionActive } from '@/core/db/transaction-context';
import { planLegacyMediaCutover, type LegacyMediaPlan, type LegacyMediaScope, type PlanRawDb } from './legacy-media-plan';
import { runLegacyMediaMigration, type MigrationReport } from './legacy-media-migration';
import { compactDatabase, measureCompaction, type CompactionStats } from './database-compaction';

export const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class StorageMaintenanceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'StorageMaintenanceError'; }
}

function rawDb(): PlanRawDb {
  return getDatabase() as unknown as PlanRawDb;
}

/** Resolve the active tenant/branch the same way every media caller does. */
export function currentMediaScope(): LegacyMediaScope {
  let branchId: string;
  try { branchId = currentBranchId(); } catch { branchId = ''; }
  const rows = branchId ? query('SELECT tenant_id FROM branches WHERE id = ?', [branchId]) : [];
  const tenantId = rows.length > 0 ? (rows[0].tenant_id as string | null) : null;
  if (!branchId || !tenantId) throw new StorageMaintenanceError('MEDIA_SCOPE_REQUIRED');
  return { tenantId, branchId, role: 'stock_image' };
}

/** Read-only dry run against the live database. */
export function planLegacyMediaMigration(): LegacyMediaPlan {
  return planLegacyMediaCutover(rawDb(), currentMediaScope());
}

/**
 * Fail-closed backup pre-condition. A bulk migration rewrites how every photo is
 * stored, so it only starts when the owner's credentials list a COMPLETE snapshot
 * that is recent enough to be a real fallback. `nowMs` is injected so the check is
 * testable and never depends on a clock inside the UI.
 */
export async function assertFreshBackup(
  owner: { email: string; password: string },
  nowMs: number,
  maxAgeMs = BACKUP_MAX_AGE_MS,
): Promise<void> {
  let snapshots;
  try {
    snapshots = await listRestoreSnapshots(owner);
  } catch {
    // Wrong credentials, no server, no snapshot store — all mean "cannot prove a
    // backup exists", which must refuse the run rather than continue.
    throw new StorageMaintenanceError('BACKUP_PRECONDITION_UNVERIFIABLE');
  }
  const fresh = (snapshots ?? []).filter((s) => {
    const t = Date.parse(s.createdAt);
    return Number.isFinite(t) && nowMs - t <= maxAgeMs && s.dbSizeBytes > 0;
  });
  if (fresh.length === 0) throw new StorageMaintenanceError('BACKUP_REQUIRED');
}

export interface RunMigrationOptions {
  owner: { email: string; password: string };
  nowMs: number;
  onProgress?: (done: number, total: number) => void;
  shouldStop?: () => boolean;
}

/**
 * Run the owner-gated bulk migration against the live database.
 *
 * Each product's images are imported through the durable orchestrator and only
 * then is its legacy column cleared — and that clear is a DURABLE save, so a
 * crash right after it can never resurrect the base64 payload.
 */
export async function runLegacyMediaMigrationLive(opts: RunMigrationOptions): Promise<MigrationReport> {
  const scope = currentMediaScope();
  const orchestrator = await getStockMediaOrchestrator();
  const service = new ProductMediaCutoverService({
    dbProvider: () => getDatabase() as unknown as never,
    orchestrator,
    tenantId: scope.tenantId,
    branchId: scope.branchId,
    role: scope.role,
    commitLegacyCleared: async (productId: string) => {
      getDatabase().run(`UPDATE products SET images = '[]' WHERE id = ?`, [productId]);
      await saveDatabaseDurably();
    },
  });

  return runLegacyMediaMigration({
    dbProvider: rawDb,
    scope,
    requireBackup: () => assertFreshBackup(opts.owner, opts.nowMs),
    cutoverProduct: (productId) => service.ensureProductMediaCutover(productId),
    onProgress: (done, total) => opts.onProgress?.(done, total),
    shouldStop: opts.shouldStop,
  });
}

/** Read-only page accounting for the maintenance panel. */
export function measureDatabaseCompaction(): ReturnType<typeof measureCompaction> {
  // Read-only page accounting: no owner check, because reading PRAGMA counters changes nothing.
  return measureCompaction({ db: getDatabase() as unknown as never });
}

/**
 * SINGLE-PC-STORAGE-I2 §3/§11 — prove the caller is the owner, or refuse.
 *
 * `verify_owner_credentials` runs the same `authorize_owner` primitive (bcrypt against the server
 * credentials) that every other owner-gated command uses. The verdict comes from the backend, so it
 * cannot be satisfied by re-enabling a button in the DOM — and because it is a DEDICATED command
 * rather than the auth side effect of a backup listing, what compaction requires cannot drift when
 * the listing's own requirements change.
 */
export async function assertOwnerCredentials(owner: { email: string; password: string }): Promise<void> {
  if (!owner.email.trim() || !owner.password) throw new StorageMaintenanceError('OWNER_VERIFICATION_FAILED');
  try {
    const core = await import('@tauri-apps/api/core');
    // SINGLE-PC-STORAGE-I2A §3 — the DEDICATED verification command, not a listing whose auth is a
    // side effect. It runs the same `authorize_owner` primitive every other owner-gated command
    // uses (bcrypt against the server credentials), and returns nothing on success.
    await core.invoke('verify_owner_credentials', { email: owner.email.trim(), password: owner.password });
  } catch {
    // Wrong credentials, a non-owner account, or no backend to ask — all mean the same thing here:
    // this caller has not been proven to be the owner, so the destructive action does not run.
    throw new StorageMaintenanceError('OWNER_VERIFICATION_FAILED');
  }
}

/**
 * Owner-triggered compaction (§18). Kept OUT of the migration itself so a
 * migration is never blocked by, and never silently followed by, a large
 * transient allocation — the operator decides when to reclaim the freed pages.
 *
 * §11 — the owner check is NOT decoration: VACUUM rewrites the entire database file. It was
 * previously reachable by anyone who could open the Danger Zone, which made the panel's own
 * two-key discipline (dry run, then owner-verified apply) inconsistent with the one button that
 * rewrites everything.
 */
export async function compactDatabaseLive(owner: { email: string; password: string }): Promise<CompactionStats> {
  await assertOwnerCredentials(owner);
  return compactDatabase({
    db: getDatabase() as unknown as never,
    isTransactionActive,
    saveDurably: () => saveDatabaseDurably(),
    freeBytes: probeFreeBytes,
  });
}

/**
 * §14 A / I2A §1 — free space on the volume that holds the database.
 *
 * Returns `null` when the platform could not produce a number. The caller treats that as a REFUSAL,
 * not as permission: `compactDatabase` raises `COMPACTION_FREE_SPACE_UNKNOWN` rather than starting a
 * rewrite whose precondition is unverified. Nothing here swallows a failure into a plausible-looking
 * value — a wrong number would be worse than no number.
 */
export async function probeFreeBytes(): Promise<number | null> {
  try {
    const core = await import('@tauri-apps/api/core');
    const v = await core.invoke('storage_free_bytes');
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    // The command is missing (older binary) or the OS refused to answer. Either way: unknown.
    return null;
  }
}
