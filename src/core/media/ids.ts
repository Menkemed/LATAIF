// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B1 — Deterministic ID derivation for the DB coordinator.
//
// Every media entity is keyed by content or by the ingest_request_id, so the
// same request retried across restarts produces the same rows — no random
// UUIDs regenerated per attempt.
// ════════════════════════════════════════════════════════════════════════════

/** A logical blob is identified by the SHA-256 of its stored bytes. */
export function blobIdFor(hash: string): string {
  return `blob-${hash}`;
}

/**
 * The dedup token is what the schema's UNIQUE(tenant_id, dedup_token) actually
 * enforces — same content, same tenant, same row. We bind the tenant in as
 * well to make cross-tenant collisions structurally impossible, though the
 * primary key already includes tenant_id.
 */
export function dedupTokenFor(tenantId: string, hash: string): string {
  return `sha256:${tenantId}:${hash}`;
}

/**
 * A media object is stable per ingest request. Two prepare/commit rounds
 * targeting the same request converge to the same media_id.
 */
export function mediaIdFor(ingestRequestId: string): string {
  return `media-${ingestRequestId}`;
}

/** One thumbnail variant per media, keyed by role. */
export function variantIdFor(mediaId: string, variantType: string): string {
  return `variant-${mediaId}-${variantType}`;
}

/**
 * A link's identity binds (tenant, scope, entity, role, media). Two finalizes
 * of the same request against the same entity slot converge to the same link.
 */
export function linkIdFor(input: {
  tenantId: string;
  scopeKind: 'branch' | 'tenant';
  branchId: string | null;
  entityType: string;
  entityId: string;
  role: string;
  mediaId: string;
}): string {
  const scope = input.scopeKind === 'branch' ? input.branchId ?? '' : '_tenant_';
  return `link-${input.tenantId}-${scope}-${input.entityType}-${input.entityId}-${input.role}-${input.mediaId}`;
}
