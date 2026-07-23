// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B1 — product media presentation controller.
//
// Framework-agnostic glue between the read-only ProductMediaResolver and a view
// layer that shows an ORDERED gallery. It owns the one thing React must not get
// wrong: the browser Object-URL lifecycle.
//
//   resolve → bytes/MIME → createObjectURL (in sortOrder) → revoke exactly once
//
// The controller is deliberately NOT a React hook (the same reason the reload/
// close orchestration lives in `core/lifecycle`): all the lifecycle-critical
// logic is here, testable under node with injected fakes, and the hook in
// `src/hooks` is a thin adapter over it.
//
// Guarantees proved by the 3B1 suite:
//   • a resolve for an OLD key never becomes the visible state once the key
//     changed (product / tenant / branch switch mid-flight)
//   • a late resolve that finishes AFTER dispose() revokes the URLs it just
//     created, immediately — nothing leaks
//   • every Object-URL created is revoked exactly once (on the next load, on
//     dispose, or right after a stale/late resolve)
//   • an integrity_error / conflict NEVER downgrades to the legacy column
//   • a resolver/read throw becomes a stable error state, never a crash
//
// STRICTLY READ-ONLY: no INSERT/UPDATE/DELETE, no productStore write, no
// products.images mutation, no Object-URL persisted to the store or SQLite.
// The DB is pinned through the existing lifecycle lease for the resolve, then
// released — exactly like every other media read path.
// ════════════════════════════════════════════════════════════════════════════

import type { MediaCommandGateway } from './gateway.ts';
import {
  ProductMediaResolver,
  type ProductMediaResolution,
} from './product-media-resolver.ts';

/** The scope a single presentation resolves for. A change in ANY field is a
 *  new gallery and invalidates whatever is currently shown. */
export interface PresentationKey {
  productId: string;
  tenantId: string;
  branchId: string;
  role?: string;
}

/** One displayable gallery entry — an Object-URL plus the ordering metadata the
 *  view needs. `url` is a blob: URL the controller owns and will revoke. */
export interface PresentationItem {
  url: string;
  mimeType: string;
  mediaId: string;
  sortOrder: number;
  isPrimary: boolean;
}

/**
 * What the view renders. `srcs` is the ordered list of `<img src>` strings for
 * the current key, regardless of source (media Object-URLs or legacy strings),
 * so the Hero/thumbnails/lightbox can consume one array uniformly.
 */
export type PresentationState =
  | { status: 'idle'; srcs: [] }
  | { status: 'loading'; srcs: [] }
  | { status: 'media'; srcs: string[]; items: PresentationItem[] }
  | { status: 'legacy'; srcs: string[] }
  | { status: 'empty'; srcs: [] }
  | { status: 'error'; code: string; srcs: [] };

export const IDLE_STATE: PresentationState = { status: 'idle', srcs: [] };

// ── read-only view selectors (fail-closed) ──────────────────────────────────
//
// The one rule the view must not get wrong: NEVER show `products.images`
// transiently while the resolve is in flight. These selectors encode it so the
// decision is unit-testable under node, without a React renderer.

/**
 * The `<img src>` list the read-only view should render for a state.
 *
 * Only a *concluded* media/legacy resolution yields images. `idle`, `loading`,
 * `empty` and `error` all yield `[]` — so nothing (least of all the legacy
 * column) flashes before the resolver has actually decided, and an
 * integrity_error/conflict never downgrades to legacy.
 */
export function presentationSrcs(state: PresentationState): string[] {
  return state.status === 'media' || state.status === 'legacy' ? state.srcs : [];
}

/**
 * Whether the view should show a loading placeholder (skeleton) rather than the
 * empty "no image" state. True only while a resolve is genuinely in flight for
 * an authorised key — not when the hook is idle because the key is missing.
 */
export function isResolvingMedia(state: PresentationState, hasAuthorisedKey: boolean): boolean {
  if (!hasAuthorisedKey) return false;
  return state.status === 'loading' || state.status === 'idle';
}

// ── dependencies ────────────────────────────────────────────────────────────

/** A pinned DB instance for the duration of one resolve. Mirrors the shape of
 *  `database.ts::DbLease` but declared locally so the controller can be tested
 *  without importing `database.ts`. */
export interface PresentationLease {
  readonly db: { run(sql: string, params?: unknown[]): void; exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> };
  release(): void;
}

export interface PresentationDeps {
  /** Only `readVerifiedMedia` is used — the resolver never writes. */
  gateway: Pick<MediaCommandGateway, 'readVerifiedMedia'>;
  /** Acquire a lease pinning the current DB instance for one resolve. Awaited;
   *  the production impl awaits any in-flight reload/reset swap first. */
  acquireLease: () => PresentationLease | Promise<PresentationLease>;
  /** Object-URL factory. Injected so tests can count create/revoke exactly.
   *  Production passes `URL.createObjectURL` / `URL.revokeObjectURL`. */
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** Emitted whenever the visible state changes. */
  onChange: (state: PresentationState) => void;
  /** Override for tests that inject a fake resolver; defaults to the real one. */
  resolverFactory?: (args: {
    dbProvider: () => PresentationLease['db'];
    gateway: Pick<MediaCommandGateway, 'readVerifiedMedia'>;
    tenantId: string;
    branchId: string;
    role?: string;
  }) => { resolveProductMedia(productId: string): Promise<ProductMediaResolution> };
}

// ── controller ──────────────────────────────────────────────────────────────

export class ProductMediaPresentationController {
  private readonly deps: PresentationDeps;
  /** Monotonic token. Every `load` bumps it; a resolve whose token is stale by
   *  the time it finishes is discarded (and any URLs it made are revoked). */
  private generation = 0;
  /** URLs backing the CURRENTLY displayed media state — revoked on the next
   *  successful load or on dispose. Empty for legacy/empty/error/idle. */
  private liveUrls: string[] = [];
  private disposed = false;
  private lastState: PresentationState = IDLE_STATE;

  constructor(deps: PresentationDeps) {
    this.deps = deps;
  }

  get state(): PresentationState {
    return this.lastState;
  }

  /**
   * Resolve and display the gallery for `key`. Safe to call repeatedly; only
   * the most recent call can win. A call for the same key still re-resolves
   * (the caller is expected to memoise the key and only call on real change).
   */
  async load(key: PresentationKey): Promise<void> {
    if (this.disposed) return;
    const token = ++this.generation;
    this.emit({ status: 'loading', srcs: [] });

    let lease: PresentationLease | null = null;
    let created: string[] = [];
    try {
      lease = await this.deps.acquireLease();
      // A swap/dispose may have happened while acquiring — bail before work.
      if (this.isStale(token)) {
        return;
      }
      const resolver = this.buildResolver(lease, key);
      const resolution = await resolver.resolveProductMedia(key.productId);

      if (this.isStale(token)) {
        // The key moved on (or we were disposed) while resolving. Whatever we
        // resolved is for a gallery nobody is looking at any more — drop it.
        // No URLs were created yet (creation happens below), so nothing to
        // revoke here; the guard exists so a slow resolve can't overwrite a
        // newer one.
        return;
      }

      const next = this.toState(resolution, key, (blob) => {
        const u = this.deps.createObjectURL(blob);
        created.push(u);
        return u;
      });

      // Re-check AFTER creating URLs: creation is synchronous, but dispose()
      // could have fired between the resolve await and here on a different
      // microtask. If we are stale now, the URLs we just made must not leak.
      if (this.isStale(token)) {
        this.revokeAll(created);
        created = [];
        return;
      }

      // We won. Retire the previous generation's URLs, then adopt ours.
      this.revokeAll(this.liveUrls);
      this.liveUrls = created;
      created = [];
      this.emit(next);
    } catch (e) {
      if (this.isStale(token)) {
        this.revokeAll(created);
        return;
      }
      this.revokeAll(created);
      const code = (e as { code?: string; message?: string })?.code
        ?? (e as { message?: string })?.message
        ?? 'MEDIA_PRESENTATION_FAILED';
      this.emit({ status: 'error', code, srcs: [] });
    } finally {
      lease?.release();
    }
  }

  /**
   * Drop the current gallery WITHOUT disposing: revoke every live URL, cancel
   * any in-flight resolve (a late result will see itself as stale and revoke
   * its own URLs), and return to idle. The controller stays usable and can
   * `load()` again later. Used when the view temporarily disables presentation
   * — e.g. entering edit mode, where the upload path owns the images instead.
   */
  clear(): void {
    if (this.disposed) return;
    if (this.lastState.status === 'idle' && this.liveUrls.length === 0) return;
    this.generation++;
    this.revokeAll(this.liveUrls);
    this.liveUrls = [];
    this.emit(IDLE_STATE);
  }

  /** Tear down: revoke every live URL exactly once and refuse further loads. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Bump so any in-flight resolve sees itself as stale and self-revokes.
    this.generation++;
    this.revokeAll(this.liveUrls);
    this.liveUrls = [];
    this.lastState = IDLE_STATE;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private isStale(token: number): boolean {
    return this.disposed || token !== this.generation;
  }

  private buildResolver(lease: PresentationLease, key: PresentationKey) {
    const factory = this.deps.resolverFactory
      ?? ((args) => new ProductMediaResolver(args));
    return factory({
      // Pin the LEASED instance for the whole resolve, never the ambient db.
      dbProvider: () => lease.db,
      gateway: this.deps.gateway,
      tenantId: key.tenantId,
      branchId: key.branchId,
      role: key.role,
    });
  }

  private toState(
    resolution: ProductMediaResolution,
    _key: PresentationKey,
    makeUrl: (blob: Blob) => string,
  ): PresentationState {
    switch (resolution.kind) {
      case 'media': {
        // The resolver already ordered items by sortOrder and verified exactly
        // one primary at slot 0; we preserve that order 1:1.
        const items: PresentationItem[] = resolution.items.map((it) => ({
          // Copy into a fresh, plain-ArrayBuffer-backed view: the bytes arrive
          // from the IPC bridge and their buffer may be a SharedArrayBuffer,
          // which `Blob`'s typing (and some browsers) reject.
          url: makeUrl(new Blob([new Uint8Array(it.bytes)], { type: it.mimeType })),
          mimeType: it.mimeType,
          mediaId: it.mediaId,
          sortOrder: it.sortOrder,
          isPrimary: it.isPrimary,
        }));
        return { status: 'media', srcs: items.map((i) => i.url), items };
      }
      case 'legacy':
        return { status: 'legacy', srcs: resolution.items };
      case 'none':
        return { status: 'empty', srcs: [] };
      case 'integrity_error':
      case 'conflict':
      case 'legacy_format_error':
        // Never a silent downgrade to legacy — a stable error state instead.
        return { status: 'error', code: resolution.code, srcs: [] };
    }
  }

  private revokeAll(urls: string[]): void {
    for (const u of urls) {
      try {
        this.deps.revokeObjectURL(u);
      } catch {
        // A double-revoke or an environment without URL support must never
        // throw out of teardown.
      }
    }
  }

  private emit(state: PresentationState): void {
    if (this.disposed && state.status !== 'idle') return;
    this.lastState = state;
    this.deps.onChange(state);
  }
}
