// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C1 — durable existing-product media EDIT batch (planner).
//
// Turns a UI edit intent — the desired ordered gallery (keep existing / add new,
// with removals expressed by simply omitting a media) — into a deterministic,
// frozen `EditPlanEnvelope`. The envelope is the durable SSOT the coordinator
// applies atomically and recovery re-drives. The plan hash is content-derived,
// so the same edit always produces the same identity (idempotent) and any
// different edit under the same batch id is a typed conflict.
//
// INACTIVE: no ProductDetail / ImageUpload / productStore wiring. The UI has no
// reorder contract, so NO reorder is modelled — the desired list is add/keep in
// its given order with removals as omissions. Framework-agnostic + injected
// (hash function), so it is fully node-testable.
//
// NEVER logs image bytes / base64 / product ids.
// ════════════════════════════════════════════════════════════════════════════

import type {
  EditPlan,
  EditPlanEnvelope,
  EditBaselineLink,
  EditTargetSlot,
  ProductEditIntent,
} from './coordinator.ts';
import type { PrepareResult, RustStoredDescriptor } from './gateway.ts';

/** One desired gallery slot from the UI, in final order (index 0 = primary). */
export type EditDesiredSlot =
  /** Keep an existing gallery media (identified by its media id). */
  | { source: 'keep'; mediaId: string }
  /** A new image, already prepared+staged under `requestId`/`requestHash`. */
  | { source: 'new'; requestId: string; requestHash: string };

export interface BuildEditPlanArgs {
  batchId: string;
  tenantId: string;
  branchId: string | null;
  scopeKind: 'branch' | 'tenant';
  entityType: string;
  entityId: string;
  role: string;
  /** The gallery as read at freeze time (baseline), sorted 0..N-1. */
  baseline: EditBaselineLink[];
  /** The desired gallery in final order. */
  desired: EditDesiredSlot[];
  /** Prepared descriptors for every `source:'new'` slot, keyed by requestId. */
  prepared: Map<string, PrepareResult>;
  /** Optional product text/sync/audit half, applied in the same tx (3B2C2). */
  productEdit?: ProductEditIntent;
}

/** Storage-key format contract shared with the Rust core + coordinator. */
function storageKeyFor(scope: string, hash: string, extension: string): string {
  return `${scope}/${hash.slice(0, 2)}/${hash}.${extension}`;
}

function withKey(scope: string, d: RustStoredDescriptor): RustStoredDescriptor & { storage_key: string } {
  return { ...d, storage_key: storageKeyFor(scope, d.hash, d.extension) };
}

/**
 * Build + freeze the durable edit plan. `digestHex` computes the canonical plan
 * hash (sha-256 hex) — injected so the module stays pure and node-testable.
 *
 * Validation (fail closed, before anything durable):
 *   • a `keep` must reference a media present in the baseline;
 *   • a `new` must have a prepared descriptor;
 *   • at most one slot per media (no accidental duplicate);
 *   • N>0 ⇒ the plan yields exactly one primary at slot 0 (enforced downstream
 *     by the coordinator, but the target order already encodes it).
 */
export async function buildEditPlanEnvelope(
  args: BuildEditPlanArgs,
  digestHex: (input: string) => Promise<string>,
): Promise<EditPlanEnvelope> {
  const baseByMedia = new Map(args.baseline.map((b) => [b.mediaId, b]));
  const seen = new Set<string>();
  const target: EditTargetSlot[] = [];
  const newRenditions: EditPlanEnvelope['newRenditions'] = [];

  for (const slot of args.desired) {
    if (slot.source === 'keep') {
      const base = baseByMedia.get(slot.mediaId);
      if (!base) throw new Error('MEDIA_EDIT_KEEP_NOT_IN_BASELINE');
      if (seen.has(slot.mediaId)) throw new Error('MEDIA_EDIT_DUPLICATE_MEDIA');
      seen.add(slot.mediaId);
      target.push({ source: 'keep', mediaId: slot.mediaId, storedHash: base.storedHash });
    } else {
      const prep = args.prepared.get(slot.requestId);
      if (!prep) throw new Error('MEDIA_EDIT_NEW_NOT_PREPARED');
      const key = `new:${slot.requestId}`;
      if (seen.has(key)) throw new Error('MEDIA_EDIT_DUPLICATE_MEDIA');
      seen.add(key);
      target.push({ source: 'new', requestId: slot.requestId, requestHash: slot.requestHash, storedHash: prep.main_descriptor.hash });
      newRenditions.push({
        requestId: slot.requestId,
        main: withKey(args.tenantId, prep.main_descriptor),
        thumbnail: withKey(args.tenantId, prep.thumbnail_descriptor),
      });
    }
  }

  const baselineForHash = args.baseline
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((b) => [b.sortOrder, b.mediaId, b.storedHash, b.isPrimary ? 1 : 0]);
  const targetForHash = target.map((t, i) => [
    i,
    t.source === 'keep' ? `keep:${t.mediaId}` : `new:${t.requestId}`,
    t.storedHash,
  ]);
  const productForHash = args.productEdit
    ? { set: args.productEdit.set, baseline: args.productEdit.baseline, inv: args.productEdit.invalidateImageDerived, sync: args.productEdit.withSync, audit: args.productEdit.audit }
    : null;
  const canonical = JSON.stringify({
    scope: [args.tenantId, args.scopeKind, args.branchId, args.entityType, args.entityId, args.role],
    baseline: baselineForHash,
    target: targetForHash,
    productEdit: productForHash,
  });
  const planHash = await digestHex(canonical);

  const plan: EditPlan = {
    batchId: args.batchId,
    tenantId: args.tenantId,
    branchId: args.branchId,
    scopeKind: args.scopeKind,
    entityType: args.entityType,
    entityId: args.entityId,
    role: args.role,
    baseline: args.baseline.slice().sort((a, b) => a.sortOrder - b.sortOrder),
    target,
    ...(args.productEdit ? { productEdit: args.productEdit } : {}),
    planHash,
  };
  return { kind: 'edit_plan', version: 1, plan, newRenditions };
}
