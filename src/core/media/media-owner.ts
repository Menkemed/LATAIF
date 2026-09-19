// ════════════════════════════════════════════════════════════════════════════
// MEDIA-S2 — the ONE owner contract of the generic media core.
//
// A medium belongs to an owner: `entityType + entityId + role`, in a branch (or tenant) context,
// with a security class. That is all the core needs to know. What an owner MEANS — a repair, a
// supplier, a document — stays with its business module; the core never reads business columns.
//
// The allowed owner types and their scope come from the single entity map `MEDIA_ENTITY_SCOPE`
// (the same map the schema's link triggers are generated from). Nothing here adds an owner type:
// a type the schema cannot hold (e.g. `customer`, see S1) is refused, not improvised.
//
// Security (S1 boundary, unchanged): `highly_sensitive` needs encryption-at-rest, which does not
// exist — the contract refuses it here already (and the schema would refuse it again). There is
// no silent downgrade to `sensitive`.
// ════════════════════════════════════════════════════════════════════════════
import { MEDIA_ENTITY_SCOPE } from '../db/media-schema.ts';

export type MediaSecurityClass = 'public' | 'internal' | 'sensitive' | 'highly_sensitive';

export interface MediaOwner {
  tenantId: string;
  scopeKind: 'branch' | 'tenant';
  /** Required for a branch-scoped owner; `null` for a tenant-scoped one. */
  branchId: string | null;
  entityType: string;
  entityId: string;
  role: string;
  securityClass: MediaSecurityClass;
}

export class MediaOwnerError extends Error {
  readonly code: 'MEDIA_OWNER_INVALID' | 'MEDIA_OWNER_TYPE_UNKNOWN' | 'MEDIA_OWNER_SCOPE_MISMATCH' | 'MEDIA_CLASS_REQUIRES_ENCRYPTION';
  constructor(code: MediaOwnerError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'MediaOwnerError';
  }
}

const CLASSES: readonly MediaSecurityClass[] = ['public', 'internal', 'sensitive', 'highly_sensitive'];
const ROLE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Validate the owner TYPE + scope + class — enough for an ingest whose owner row may not exist yet. */
export function assertOwnerKind(k: {
  tenantId: string; scopeKind: 'branch' | 'tenant'; branchId: string | null;
  entityType: string; role: string; securityClass?: MediaSecurityClass;
}): void {
  if (!k.tenantId || typeof k.role !== 'string' || !ROLE_RE.test(k.role)) {
    throw new MediaOwnerError('MEDIA_OWNER_INVALID', 'tenant and a lower-case role are required');
  }
  const e = MEDIA_ENTITY_SCOPE[k.entityType];
  if (!e) throw new MediaOwnerError('MEDIA_OWNER_TYPE_UNKNOWN', `no media owner type ${String(k.entityType)}`);
  if (k.scopeKind !== e.scope) {
    throw new MediaOwnerError('MEDIA_OWNER_SCOPE_MISMATCH', `${k.entityType} is ${e.scope}-scoped`);
  }
  if (k.scopeKind === 'branch' ? !k.branchId : k.branchId != null) {
    throw new MediaOwnerError('MEDIA_OWNER_SCOPE_MISMATCH', 'branch context does not match the scope');
  }
  const cls = k.securityClass ?? 'internal';
  if (!CLASSES.includes(cls)) throw new MediaOwnerError('MEDIA_OWNER_INVALID', `unknown security class ${String(cls)}`);
  if (cls === 'highly_sensitive') {
    throw new MediaOwnerError('MEDIA_CLASS_REQUIRES_ENCRYPTION', 'highly_sensitive media need encryption-at-rest, which does not exist yet');
  }
}

/** Validate a complete owner (type, scope, class AND a concrete entity id). */
export function assertMediaOwner(o: MediaOwner): void {
  assertOwnerKind(o);
  if (!o.entityId || typeof o.entityId !== 'string') throw new MediaOwnerError('MEDIA_OWNER_INVALID', 'entityId is required');
}

/** The id `bumpMediaOwnerRevision` scopes the owner row with (branch id, or tenant id). */
export function ownerScopeId(o: Pick<MediaOwner, 'scopeKind' | 'branchId' | 'tenantId'>): string {
  return o.scopeKind === 'branch' ? String(o.branchId) : o.tenantId;
}

/** Product media keep their product-only side effects (embedding); nothing else ever gets them. */
export function isProductOwner(o: Pick<MediaOwner, 'entityType'>): boolean {
  return o.entityType === 'product';
}
