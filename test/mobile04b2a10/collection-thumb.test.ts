// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A10-I1 — collection thumbnail decision (pure logic + wiring contract)
// Run: node test/mobile04b2a10/collection-thumb.test.ts
//
// Proves decideCollectionThumb maps every (legacy, resolved-state, auth) combo to
// the right paint: legacy fast-path, media/legacy resolution → primary image, an
// in-flight resolve → skeleton (never a premature placeholder), and none/empty/
// error/unauthorised → placeholder (fail-closed, never a resurrected legacy). Plus
// a structural check that both WatchList thumbnail sites now use the shared
// resolver-backed component and that the Excel export was left untouched.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { decideCollectionThumb } from '../../src/core/media/collection-thumb.ts';
import type { PresentationState } from '../../src/core/media/presentation.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

const media = (srcs: string[]): PresentationState => ({ status: 'media', srcs, items: srcs.map((url, i) => ({ url, mimeType: 'image/jpeg', mediaId: `m${i}`, sortOrder: i, isPrimary: i === 0 })) });
const legacy = (srcs: string[]): PresentationState => ({ status: 'legacy', srcs });
const idle: PresentationState = { status: 'idle', srcs: [] };
const loading: PresentationState = { status: 'loading', srcs: [] };
const pending: PresentationState = { status: 'pending', srcs: [] };
const empty: PresentationState = { status: 'empty', srcs: [] };
const errorS: PresentationState = { status: 'error', code: 'X', srcs: [] };

// ── §1 legacy fast-path wins, even over a media resolution (resolver step 1) ──
{
  const d = decideCollectionThumb({ legacyFirst: 'data:image/png;base64,LEG', state: idle, hasAuthKey: true });
  ok(d.kind === 'image' && d.src === 'data:image/png;base64,LEG', 'non-empty legacy column → shown directly (fast path)');
  const d2 = decideCollectionThumb({ legacyFirst: 'LEG', state: media(['blob:med']), hasAuthKey: true });
  ok(d2.kind === 'image' && d2.src === 'LEG', 'legacy fast-path wins over a media state (matches resolver §1 cutover order)');
}

// ── §2 media-pipeline product (empty legacy) → resolver primary ──────────────
{
  const d = decideCollectionThumb({ legacyFirst: undefined, state: media(['blob:a', 'blob:b']), hasAuthKey: true });
  ok(d.kind === 'image' && d.src === 'blob:a', 'media resolution → primary (srcs[0])');
  const d2 = decideCollectionThumb({ legacyFirst: undefined, state: legacy(['data:leg0']), hasAuthKey: true });
  ok(d2.kind === 'image' && d2.src === 'data:leg0', 'resolver `legacy` status → its first src');
}

// ── §3 in-flight resolve → skeleton, never a premature placeholder ───────────
{
  for (const [name, st] of [['loading', loading], ['pending', pending], ['idle', idle]] as [string, PresentationState][]) {
    ok(decideCollectionThumb({ legacyFirst: undefined, state: st, hasAuthKey: true }).kind === 'skeleton', `${name} + authorised → skeleton`);
  }
}

// ── §4 concluded-none / error / unauthorised → placeholder (fail-closed) ─────
{
  ok(decideCollectionThumb({ legacyFirst: undefined, state: empty, hasAuthKey: true }).kind === 'placeholder', 'empty (deliberately no image) → placeholder, never legacy');
  ok(decideCollectionThumb({ legacyFirst: undefined, state: errorS, hasAuthKey: true }).kind === 'placeholder', 'error → placeholder, never a legacy downgrade');
  // No authorised scope: the hook stays idle → not "resolving" → placeholder.
  ok(decideCollectionThumb({ legacyFirst: undefined, state: idle, hasAuthKey: false }).kind === 'placeholder', 'unauthorised + no legacy → placeholder (no cross-scope read)');
}

// ── §5 wiring contract: WatchList uses the shared component at BOTH sites ─────
{
  const wl = readFileSync(join(repo, 'src/pages/watches/WatchList.tsx'), 'utf8');
  ok(/import \{ CollectionProductThumb \}/.test(wl), 'WatchList imports CollectionProductThumb');
  const uses = (wl.match(/<CollectionProductThumb/g) || []).length;
  ok(uses === 2, `WatchList renders CollectionProductThumb at both thumbnail sites (grid + delete-list), found ${uses}`);
  // The thumbnail sites no longer render `<img src={p.images[0]}>` directly.
  ok(!/<img src=\{p\.images\[0\]\}/.test(wl), 'no direct <img src={p.images[0]}> thumbnail remains in WatchList');
  // Scope derived ONCE (not per card).
  ok(/const mediaTenantId = useMemo/.test(wl) && /useAuthStore\(s => s\.session\?\.branchId\)/.test(wl), 'media scope (tenant+branch) derived once at the top');
  // MEDIA-CONSUMERS-EXPORT — the Excel export now resolves media-pipeline images
  // via the canonical resolver, not raw `p.images[0]`.
  ok(/import \{ buildCollectionWorkbookBuffer \}/.test(wl), 'WatchList export imports the workbook builder');
  ok(/import \{ resolvePrimaryImageForExport \}/.test(wl), 'WatchList export imports the primary-image resolver helper');
  ok(/buildCollectionWorkbookBuffer\(items,/.test(wl), 'export builds the workbook via buildCollectionWorkbookBuffer');
  ok(/resolveImage: resolvePrimaryImageForExport/.test(wl), 'image resolution is wired through resolvePrimaryImageForExport');
  // The obsolete raw-only image read is gone (no silent legacy-only fallback).
  ok(!/const src = p\.images\?\.\[0\] \|\| '';/.test(wl), 'export no longer falls back to a raw p.images[0]-only implementation');
}

// ── §6 component fast-paths legacy BEFORE mounting the resolver hook ─────────
{
  const cmp = readFileSync(join(repo, 'src/components/products/CollectionProductThumb.tsx'), 'utf8');
  ok(/useProductMediaPresentation/.test(cmp) && /decideCollectionThumb/.test(cmp), 'component uses the same resolver hook + the shared decision');
  const fastIdx = cmp.indexOf('if (legacyFirst)');
  const hookIdx = cmp.indexOf('function ResolvedThumb');
  ok(fastIdx > 0 && hookIdx > fastIdx, 'legacy fast-path returns before the hook-bearing ResolvedThumb (no resolve for the legacy catalog)');
}

console.log(`\nMOBILE-04B2A10-I1 collection-thumb: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
