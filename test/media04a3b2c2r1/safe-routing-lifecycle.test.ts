// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C2-R1 — safe edit routing decisions
// Run: node test/media04a3b2c2r1/safe-routing-lifecycle.test.ts
//
// The NEW R1 logic is the routing map that guarantees a ProductDetail edit save
// can only reach the durable C2 path or a fail-closed refusal — never the old
// base64/object-URL updateProduct image path. Pure + node-tested here.
//
// The edit-PREVIEW object-URL lifecycle (revoke-exactly-once on re-resolve /
// dispose, late/stale resolve never overwrites the newer state) is the
// presentation controller's contract, already proven by the MEDIA-04A-3B1
// suite; R1 only keeps that controller ACTIVE during edit (enabled = key, not
// !editing) so the existing preview URLs stay valid — a ProductDetail wiring
// fact, not separately node-testable without a React renderer.
// ════════════════════════════════════════════════════════════════════════════

import {
  canEditImages, presentationToResolverStatus, editSaveFailsClosed,
  type PresentationStatusLike,
} from '../../src/core/media/product-edit-draft.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  x ${m}`); } }

const ALL: PresentationStatusLike[] = ['idle', 'loading', 'pending', 'media', 'legacy', 'empty', 'error'];

// Final, valid galleries map to an editable resolver status.
ok(presentationToResolverStatus('media') === 'media', 'media → media');
ok(presentationToResolverStatus('legacy') === 'legacy', 'legacy → legacy');
ok(presentationToResolverStatus('empty') === 'none', 'empty → none');
ok(!editSaveFailsClosed('media') && !editSaveFailsClosed('legacy') && !editSaveFailsClosed('empty'), 'final states do NOT fail closed (durable edit proceeds)');

// Every non-final / broken status refuses the save (fail closed) — there is no
// mapping that yields a legacy base64 write.
for (const s of ['idle', 'loading', 'pending', 'error'] as PresentationStatusLike[]) {
  ok(!canEditImages(presentationToResolverStatus(s)), `'${s}' not editable`);
  ok(editSaveFailsClosed(s), `'${s}' → save fails closed`);
}

// The routing codomain is exactly {media, legacy, none, pending} — every status
// is either an editable resolver status or the fail-closed 'pending'. No path
// reaches the removed updateProduct image write.
ok(ALL.every(s => ['media', 'legacy', 'none', 'pending'].includes(presentationToResolverStatus(s))), 'routing codomain contains no base64/legacy-write path');

console.log('');
if (FAIL > 0) { console.log(`MEDIA-04A-3B2C2-R1 safe-routing: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
console.log(`MEDIA-04A-3B2C2-R1 safe-routing: ${PASS}/${PASS} checks passed`);
