// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §9/§10 — bulk legacy → gallery migration RUNNER.
//
// The cutover service already owns the per-product safety contract (decode all →
// import all N in order → verify the exact manifest → only THEN clear the legacy
// column durably). This module is deliberately thin: it decides WHICH products to
// run, enforces the pre-conditions a bulk maintenance action needs, reads back an
// INDEPENDENT verification per product, and reports.
//
// Batch contract: one bad product never stops the run. Its legacy column is left
// fully intact (the service refuses before creating any link), it is reported with
// a stable code, and every other product still migrates. The run is re-runnable at
// any time — already-migrated products are cheap no-ops.
//
// NEVER logs image bytes. Ids, counts and stable codes only.
// ════════════════════════════════════════════════════════════════════════════

import type { CutoverResult } from '../media/product-media-cutover.ts';
import { planLegacyMediaCutover, type LegacyMediaPlan, type LegacyMediaScope, type PlanRawDb } from './legacy-media-plan.ts';

export type MigrationOutcome = 'migrated' | 'already_migrated' | 'skipped' | 'failed' | 'verify_failed';

export interface MigrationItemReport {
  productId: string;
  outcome: MigrationOutcome;
  /** active links after the run (0 when skipped/failed) */
  imported: number;
  /** stable code — never a raw error dump, never image data */
  code?: string;
}

export interface MigrationReport {
  plan: LegacyMediaPlan;
  attempted: number;
  migrated: number;
  alreadyMigrated: number;
  skipped: number;
  failed: number;
  verifyFailed: number;
  /** bytes of `products.images` that are provably gone (only for verified products) */
  clearedColumnBytes: number;
  items: MigrationItemReport[];
}

export interface VerifyResult {
  ok: boolean;
  code?: string;
  activeLinks: number;
  legacyCleared: boolean;
}

export interface MigrationDeps {
  dbProvider: () => PlanRawDb;
  scope: LegacyMediaScope;
  /** Runs the REAL `ProductMediaCutoverService.ensureProductMediaCutover`. */
  cutoverProduct: (productId: string) => Promise<CutoverResult>;
  /**
   * Fail-closed pre-condition: a bulk migration only starts when a fresh, complete
   * backup snapshot demonstrably exists. Throws (or rejects) to refuse the run —
   * nothing is attempted, no product is touched.
   */
  requireBackup: () => Promise<void>;
  onProgress?: (done: number, total: number, productId: string) => void;
  /** Optional cooperative cancel — checked between products, never mid-product. */
  shouldStop?: () => boolean;
}

/**
 * Independent post-verification: re-reads the durable state instead of trusting
 * the service's own manifest gate. A product counts as migrated only when the
 * legacy column is empty AND the gallery holds exactly the expected number of
 * links, each resolvable down to an available generation of a present blob —
 * the same join a reader would use.
 */
export function verifyMigratedProduct(
  db: PlanRawDb,
  scope: LegacyMediaScope,
  productId: string,
  expectedImages: number,
): VerifyResult {
  const role = scope.role ?? 'stock_image';
  const legacyRes = db.exec(
    `SELECT p.images AS images FROM products p
       JOIN branches b ON b.id = p.branch_id AND b.tenant_id = ?
      WHERE p.id = ? AND p.branch_id = ?`,
    [scope.tenantId, productId, scope.branchId],
  );
  if (legacyRes.length === 0 || legacyRes[0].values.length === 0) {
    return { ok: false, code: 'VERIFY_PRODUCT_MISSING', activeLinks: 0, legacyCleared: false };
  }
  const rawImages = legacyRes[0].values[0][0];
  const legacyCleared = rawImages === null || rawImages === undefined || String(rawImages).trim() === '' || String(rawImages).trim() === '[]';

  const resolvable = db.exec(
    `SELECT COUNT(*) AS n
       FROM media_links l
       JOIN media_objects o
         ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id AND o.deleted_at IS NULL
       JOIN media_blobs b
         ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
        AND b.deleted_at IS NULL AND b.blob_status = 'present'
       JOIN media_blob_generations g
         ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
        AND g.generation_no = b.current_generation_no
        AND g.gen_status = 'available' AND g.deleted_at IS NULL
      WHERE l.tenant_id = ? AND l.scope_kind = 'branch' AND l.branch_id = ?
        AND l.entity_type = 'product' AND l.entity_id = ? AND l.media_role = ?
        AND l.deleted_at IS NULL`,
    [scope.tenantId, scope.branchId, productId, role],
  );
  const activeLinks = resolvable.length > 0 && resolvable[0].values.length > 0 ? Number(resolvable[0].values[0][0]) : 0;

  if (!legacyCleared) return { ok: false, code: 'VERIFY_LEGACY_NOT_CLEARED', activeLinks, legacyCleared };
  if (activeLinks !== expectedImages) return { ok: false, code: 'VERIFY_LINK_COUNT_MISMATCH', activeLinks, legacyCleared };
  return { ok: true, activeLinks, legacyCleared };
}

/**
 * Run the bulk migration. Refuses to start without the backup pre-condition; from
 * then on every product is independent — a failure is recorded, never propagated.
 */
export async function runLegacyMediaMigration(deps: MigrationDeps): Promise<MigrationReport> {
  await deps.requireBackup();

  const plan = planLegacyMediaCutover(deps.dbProvider(), deps.scope);
  const targets = plan.items.filter((i) => i.state === 'migratable');
  const items: MigrationItemReport[] = [];
  let migrated = 0, alreadyMigrated = 0, skipped = 0, failed = 0, verifyFailed = 0, clearedColumnBytes = 0;

  // Unsupported products are reported up front so the operator sees them in the
  // result, not only in the dry-run. They are never touched.
  for (const i of plan.items) {
    if (i.state === 'unsupported') {
      skipped++;
      items.push({ productId: i.productId, outcome: 'skipped', imported: 0, code: i.reason ?? 'LEGACY_UNSUPPORTED' });
    }
  }

  let done = 0;
  for (const target of targets) {
    if (deps.shouldStop?.()) break;
    let res: CutoverResult;
    try {
      res = await deps.cutoverProduct(target.productId);
    } catch (e) {
      failed++;
      items.push({ productId: target.productId, outcome: 'failed', imported: 0, code: stableCode(e) });
      done++;
      deps.onProgress?.(done, targets.length, target.productId);
      continue;
    }

    if (res.action === 'noop_no_legacy' || res.action === 'noop_already_migrated') {
      alreadyMigrated++;
      items.push({ productId: target.productId, outcome: 'already_migrated', imported: res.imported });
      done++;
      deps.onProgress?.(done, targets.length, target.productId);
      continue;
    }

    const v = verifyMigratedProduct(deps.dbProvider(), deps.scope, target.productId, target.legacyCount);
    if (!v.ok) {
      verifyFailed++;
      items.push({ productId: target.productId, outcome: 'verify_failed', imported: res.imported, code: v.code });
    } else {
      migrated++;
      clearedColumnBytes += target.legacyColumnBytes;
      items.push({ productId: target.productId, outcome: 'migrated', imported: res.imported });
    }
    done++;
    deps.onProgress?.(done, targets.length, target.productId);
  }

  return {
    plan,
    attempted: targets.length,
    migrated, alreadyMigrated, skipped, failed, verifyFailed,
    clearedColumnBytes,
    items,
  };
}

/** A stable, image-free code from an unknown throw. */
function stableCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && code.length > 0 && code.length <= 64) return code;
  const msg = e instanceof Error ? e.message : String(e);
  const first = msg.split(/[\s:]/)[0] ?? '';
  return /^[A-Z_]{4,64}$/.test(first) ? first : 'MEDIA_CUTOVER_FAILED';
}
