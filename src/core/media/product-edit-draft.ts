// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C2 — pure draft/UI decisions for the product media edit.
//
// The ProductDetail edit UI cannot be unit-tested (no React test harness), so
// every DECISION it makes is extracted here as a pure function and node-tested:
//   • which draft items exist and how they map to a durable edit plan,
//   • the hard object-URL identity guard,
//   • the fail-closed "may images be edited?" gate,
//   • the product text diff (only changed columns),
//   • the post-result modal decision.
//
// HARD INVARIANT: an object URL (blob:) is ONLY a display source. It is never a
// media identity, never enters the edit plan, never lands in products.images,
// and a draft `new` image must carry a real data: URL — never an object URL.
//
// NEVER logs image bytes / base64 / product ids.
// ════════════════════════════════════════════════════════════════════════════

import type { EditDesiredSlot } from './product-media-edit.ts';

/** One image row in the editor, with a STABLE identity independent of its URL. */
export type ImageDraftItem =
  /** An existing gallery media (resolved). `displaySrc` is an object URL, shown
   *  only — the identity is `mediaId`. */
  | { kind: 'existing'; mediaId: string; displaySrc: string }
  /** A pre-cutover legacy image (its original data: URL). Present only until the
   *  product is cut over; the edit path refuses to plan while any remain. */
  | { kind: 'legacy'; dataUrl: string }
  /** A freshly added image: a client id + its data: URL (never an object URL). */
  | { kind: 'new'; clientId: string; dataUrl: string };

/** Resolver kinds the presentation controller can report. */
export type ResolverStatus = 'media' | 'legacy' | 'none' | 'pending' | 'conflict' | 'integrity_error';

export function isObjectUrl(s: string): boolean {
  return typeof s === 'string' && s.startsWith('blob:');
}

/**
 * Fail-closed gate: image editing is allowed ONLY when the gallery is fully
 * resolved and valid. `pending` / `conflict` / `integrity_error` block the save
 * so a half-loaded or broken gallery is never used as an edit baseline.
 */
export function canEditImages(status: ResolverStatus): boolean {
  return status === 'media' || status === 'legacy' || status === 'none';
}

/** The presentation-controller status (superset of resolver kinds). */
export type PresentationStatusLike = 'idle' | 'loading' | 'pending' | 'media' | 'legacy' | 'empty' | 'error';

/**
 * Map a presentation status to the resolver status the edit save uses. A final,
 * valid gallery (media/legacy/empty) maps to an editable status; anything still
 * in flight or broken (idle/loading/pending/error) maps to a NON-editable status
 * so the save fails closed. There is no path that maps to a legacy base64 write.
 */
export function presentationToResolverStatus(s: PresentationStatusLike): ResolverStatus {
  if (s === 'media') return 'media';
  if (s === 'legacy') return 'legacy';
  if (s === 'empty') return 'none';
  return 'pending'; // idle/loading/pending/error → fail closed
}

/** True when a ProductDetail edit save must be refused for this presentation
 *  status (loading/pending/conflict/integrity_error/idle/error). */
export function editSaveFailsClosed(s: PresentationStatusLike): boolean {
  return !canEditImages(presentationToResolverStatus(s));
}

/**
 * Reconstruct stable draft items from the flat `<img src>` list the ImageUpload
 * hands back (object URLs for kept existing images, data: URLs for freshly
 * added ones) plus the resolved gallery's (url → mediaId) map.
 *
 *   • a src that matches a resolved item's object URL → `existing` (its mediaId
 *     is the identity — the URL is only how we recognise it);
 *   • a data: URL → `new` (a stable content-independent client id per position;
 *     a retry with the same draft reproduces the same ids → same batch);
 *   • a data: URL that is a legacy image (pre-cutover) is also `new` from the
 *     gallery's point of view AFTER cutover, but before cutover the caller must
 *     not reach here (it cuts over first);
 *   • an UNKNOWN object URL (blob: not in the gallery) → fail closed: an object
 *     URL must never be treated as an upload or an identity.
 */
export type DraftFromSrcs = { ok: true; value: ImageDraftItem[] } | { ok: false; error: string };

export function draftFromSrcs(srcs: string[], resolved: Array<{ url: string; mediaId: string }>): DraftFromSrcs {
  const byUrl = new Map(resolved.map((r) => [r.url, r.mediaId]));
  const out: ImageDraftItem[] = [];
  for (let i = 0; i < srcs.length; i++) {
    const src = srcs[i];
    const mediaId = byUrl.get(src);
    if (mediaId) { out.push({ kind: 'existing', mediaId, displaySrc: src }); continue; }
    if (isObjectUrl(src)) return { ok: false, error: 'MEDIA_EDIT_UNKNOWN_OBJECT_URL' };
    if (src.startsWith('data:')) { out.push({ kind: 'new', clientId: `new:${i}`, dataUrl: src }); continue; }
    return { ok: false, error: 'MEDIA_EDIT_UNEXPECTED_SRC' };
  }
  return { ok: true, value: out };
}

export interface ImageEditInputs {
  desired: EditDesiredSlot[];
  /** The `new` draft items whose bytes must be prepared/staged, in draft order. */
  newImages: Array<{ clientId: string; dataUrl: string }>;
  /** Baseline media ids removed by this edit (implied by the kept set). */
  removedMediaIds: string[];
  /** Whether the target gallery differs from the baseline at all. */
  galleryChanged: boolean;
}

export type ImageEditBuild =
  | { ok: true; value: ImageEditInputs }
  | { ok: false; error: string };

/**
 * Turn the ordered draft into the durable-edit gallery inputs.
 *
 *   • an `existing` item keeps its media identity (mediaId) — its object URL is
 *     never used as identity or re-uploaded;
 *   • a `new` item becomes a `new` desired slot (requestId = clientId) and is
 *     queued for prepare/stage — it MUST carry a data: URL;
 *   • a `legacy` item means the product was not cut over yet → refuse (the
 *     caller must run ensureProductMediaCutover first, then rebuild the draft).
 *
 * `baselineMediaIds` (the current resolved gallery, in order) lets us report the
 * removed set and whether anything actually changed.
 */
export function buildImageEditInputs(draft: ImageDraftItem[], baselineMediaIds: string[]): ImageEditBuild {
  const desired: EditDesiredSlot[] = [];
  const newImages: Array<{ clientId: string; dataUrl: string }> = [];
  const keptMediaIds: string[] = [];
  const seenClient = new Set<string>();
  for (const item of draft) {
    if (item.kind === 'legacy') {
      return { ok: false, error: 'MEDIA_EDIT_LEGACY_NOT_CUTOVER' };
    }
    if (item.kind === 'existing') {
      desired.push({ source: 'keep', mediaId: item.mediaId });
      keptMediaIds.push(item.mediaId);
    } else {
      // new — the identity is the client id; the URL must be a real data: URL.
      if (!item.dataUrl || isObjectUrl(item.dataUrl) || !item.dataUrl.startsWith('data:')) {
        return { ok: false, error: 'MEDIA_EDIT_OBJECT_URL_AS_UPLOAD' };
      }
      if (seenClient.has(item.clientId)) return { ok: false, error: 'MEDIA_EDIT_DUPLICATE_CLIENT_ID' };
      seenClient.add(item.clientId);
      desired.push({ source: 'new', requestId: item.clientId, requestHash: '' /* filled after hashing */ });
      newImages.push({ clientId: item.clientId, dataUrl: item.dataUrl });
    }
  }
  const removedMediaIds = baselineMediaIds.filter((m) => !keptMediaIds.includes(m));
  // Changed iff the ordered kept-media differs from the baseline, or any new
  // image was added, or any baseline media was removed.
  const keptSameOrder = keptMediaIds.length === baselineMediaIds.length && keptMediaIds.every((m, i) => m === baselineMediaIds[i]);
  const galleryChanged = newImages.length > 0 || removedMediaIds.length > 0 || !keptSameOrder;
  return { ok: true, value: { desired, newImages, removedMediaIds, galleryChanged } };
}

export interface ProductTextDiff {
  /** Column → target value, only for columns that actually changed. */
  set: Array<[string, string | number | null]>;
  /** Baseline value of each changed column (parallel to `set`). */
  baseline: Array<string | number | null>;
}

/**
 * Diff the target column values against the baseline, keeping ONLY changed
 * columns. `columns` maps a db column → its baseline and target scalar value.
 * Comparison is by string form with NULL awareness (mirrors the coordinator's
 * convergence guard).
 */
export function diffProductText(columns: Array<{ col: string; baseline: string | number | null; target: string | number | null }>): ProductTextDiff {
  const set: Array<[string, string | number | null]> = [];
  const baseline: Array<string | number | null> = [];
  for (const c of columns) {
    const same = (c.baseline == null) === (c.target == null) && (c.baseline == null || String(c.baseline) === String(c.target));
    if (same) continue;
    set.push([c.col, c.target]);
    baseline.push(c.baseline);
  }
  return { set, baseline };
}

/** Whether the edit changes anything at all (text or gallery). */
export function editHasChanges(textSet: ProductTextDiff['set'], galleryChanged: boolean): boolean {
  return textSet.length > 0 || galleryChanged;
}

export type EditOutcome =
  | { status: 'edited' }
  | { status: 'edit_incomplete'; errorCode: string }
  | { status: 'edit_conflict'; errorCode: string }
  | { status: 'blocked'; errorCode: string };

export interface EditUiDecision {
  /** Close the editor as a full success. */
  closeEditor: boolean;
  /** Keep the draft so a retry reuses the same frozen batch. */
  retainDraft: boolean;
  message: EditOutcome['status'];
}

/**
 * The editor's close/keep-open decision. Only a durable success closes; any
 * incomplete/conflict/blocked outcome keeps the editor open and retains the
 * draft so the next save reuses the SAME frozen batch (no duplicates).
 */
export function decideEditUi(outcome: EditOutcome): EditUiDecision {
  if (outcome.status === 'edited') return { closeEditor: true, retainDraft: false, message: 'edited' };
  return { closeEditor: false, retainDraft: true, message: outcome.status };
}
