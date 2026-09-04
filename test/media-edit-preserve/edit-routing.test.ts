// ════════════════════════════════════════════════════════════════════════════
// MEDIA-EDIT-PRESERVE — structural guard on the ProductDetail save routing.
// Run: node test/media-edit-preserve/edit-routing.test.ts
//
// ProductDetail cannot be unit-tested (no React harness), so this pins the
// DECISION that fixes the bug, at the source level: a save that did not change
// an image must go through the gallery-safe text-only path, and only a real
// image edit may reconcile the durable gallery. It also pins the invariant that
// the text-only store action never touches media at all. These are exactly the
// assertions whose absence let the photo-deletion regression ship.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } }

// ── ProductDetail.tsx: the media-dirty gate + routing ────────────────────────
{
  const pd = readFileSync(join(repo, 'src/pages/watches/ProductDetail.tsx'), 'utf8');

  ok(/const \[imagesDirty, setImagesDirty\] = useState\(false\)/.test(pd), 'imagesDirty state exists (default clean)');

  // ImageUpload onChange is the ONLY place a user marks images dirty.
  ok(/<ImageUpload[\s\S]*?onChange=\{[\s\S]*?setImagesDirty\(true\)/.test(pd), 'ImageUpload onChange marks imagesDirty=true');

  // Entering edit and cancelling both RESET the dirty flag → a fresh edit
  // session starts text-only until an image is actually touched.
  // Entering the editor no longer seeds at click time — seeding is the guarded effect's sole job, so a
  // gallery that is not final yet can never produce a half-seeded draft.
  ok(!/onClick=\{\(\) => \{[\s\S]{0,400}?media\.status === 'media'\) setForm/.test(pd), 'the Edit button does NOT seed images at click time (only the authoritative seed effect does)');
  ok(/onClick=\{\(\) => \{ setEditing\(false\); setImagesDirty\(false\)/.test(pd), 'Cancel resets imagesDirty(false)');

  // handleSave routes on imagesDirty: dirty → editProductWithMedia (reconcile),
  // clean → editProductTextDurably (gallery-safe).
  const save = pd.slice(pd.indexOf('async function handleSave'), pd.indexOf('function labelFor'));
  ok(/if \(imagesDirty\) \{/.test(save), 'handleSave branches on imagesDirty');
  ok(/editProductWithMedia\(id, textPayload, \{ srcs:/.test(save), 'dirty branch calls editProductWithMedia with the reconcile args');
  ok(/\} else \{[\s\S]*editProductTextDurably\(id, textPayload\)/.test(save), 'clean branch calls editProductTextDurably (no gallery args)');
  // The text-only call passes NO srcs/resolved/status — it cannot reconcile.
  ok(!/editProductTextDurably\([^)]*srcs/.test(save), 'editProductTextDurably is never handed a gallery/srcs argument');
  ok(/setImagesDirty\(false\);\s*\n\s*setDraftSeeded\(false\);\s*\n\s*setEditing\(false\)/.test(save), 'a successful save resets BOTH the dirty flag and the seed proof');

  // ── MEDIA-EDIT-PRESERVE-R2 — the authoritative-seed contract ──
  // The seed effect runs only on a FINAL gallery and only while the user has not touched the images,
  // and it is the ONLY writer of `draftSeeded` — that is what makes "this draft came from the real
  // gallery" provable rather than a length heuristic.
  ok(/const \[draftSeeded, setDraftSeeded\] = useState\(false\)/.test(pd), 'draftSeeded state exists (default: not seeded)');
  ok(/const mediaAuthoritative = !editSaveFailsClosed\(media\.status\)/.test(pd), 'authoritative = the SAME rule the durable save uses (editSaveFailsClosed), not a local heuristic');
  ok(/if \(!editing \|\| !mediaAuthoritative \|\| imagesDirty\) return;/.test(pd), 'the seed effect requires editing + AUTHORITATIVE gallery + not-dirty');
  const seedEffect = pd.slice(pd.indexOf('if (!editing || !mediaAuthoritative || imagesDirty) return;'), pd.indexOf('}, [editing, imagesDirty, media, mediaAuthoritative, draftSeeded]);'));
  ok(/setDraftSeeded\(true\)/.test(seedEffect), 'draftSeeded is set INSIDE the guarded seed effect (seed and proof are inseparable)');
  ok((pd.match(/setDraftSeeded\(true\)/g) || []).length === 1, 'nothing else in the page can claim the draft was seeded');
  // Photo controls are locked until the draft is seeded → imagesDirty cannot even become true before it.
  ok(/<ImageUpload[\s\S]*?disabled=\{!draftSeeded\}/.test(pd), 'ImageUpload is disabled until the draft is seeded from the final gallery');
  ok(/!draftSeeded && \([\s\S]*?Images loading/.test(pd), 'a clear "Images loading…" state is shown while photo editing is locked');
  // Entering/leaving the editor always resets the proof.
  ok(/setImagesDirty\(false\);\s*\n\s*setDraftSeeded\(false\);\s*\n\s*setEditing\(true\);/.test(pd), 'Edit resets imagesDirty AND draftSeeded');
  ok(/setEditing\(false\); setImagesDirty\(false\); setDraftSeeded\(false\);/.test(pd), 'Cancel resets imagesDirty AND draftSeeded');
  // ── the E2E-only seed hold must stay inert in production ──
  // It may ONLY delay the seed, must be gated on the marker that solely the `e2e` Rust build stamps,
  // and must never fake gallery data or claim the draft was seeded.
  const hold = pd.slice(pd.indexOf('const w = window as unknown as'), pd.indexOf('if (media.status === \'media\') {'));
  ok(/w\.__LATAIF_E2E__ && w\.__e2eHoldGallerySeed/.test(hold), 'the seed hold requires the e2e build marker AND an explicit automation flag');
  ok(/return;/.test(hold) && !/setDraftSeeded|setForm|media\.items|media\.srcs/.test(hold), 'the hold ONLY returns early — it never seeds, fakes media or sets draftSeeded');
  const rs = readFileSync(join(repo, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const inject = rs.indexOf('window.__LATAIF_E2E__ = true');
  ok(inject > 0, 'the e2e marker injection exists in the Rust setup');
  ok(/#\[cfg\(feature = "e2e"\)\]\s*\{[\s\S]{0,300}?window\.__LATAIF_E2E__ = true/.test(rs), 'the marker is injected ONLY under #[cfg(feature = "e2e")] — a production build never sets it');

  // Fail-closed save guard: dirty images without a seeded draft must never reconcile.
  const saveGuard = pd.slice(pd.indexOf('if (imagesDirty) {'), pd.indexOf('editProductWithMedia(id, textPayload'));
  ok(/if \(!draftSeeded\) \{[\s\S]*MEDIA_EDIT_GALLERY_NOT_READY[\s\S]*return;/.test(saveGuard), 'save fails closed when images are dirty but the draft was never seeded');
  ok(saveGuard.indexOf('!draftSeeded') < saveGuard.indexOf('presentationToResolverStatus'), 'the guard runs BEFORE any reconcile input is built');
}

// ── productStore.ts: editProductTextDurably must not touch media at all ───────
{
  const store = readFileSync(join(repo, 'src/stores/productStore.ts'), 'utf8');
  // Der Anker ist die IMPLEMENTIERUNG, nicht die Deklaration im Interface — und er muss etwas
  // Substantielles einschliessen: ein leerer Ausschnitt liesse die drei Verbote unten stumm
  // durchgehen (genau das passierte, als C1 die Aktion in `runExclusive` einwickelte).
  const fn = store.slice(store.indexOf('editProductTextDurably: (id, data, opts)'), store.indexOf('updateProduct: (id, data) =>'));
  ok(fn.length > 200, `editProductTextDurably implementation found (${fn.length} Zeichen)`);
  ok(/applyProductTextEditDurably\(/.test(fn), 'text path calls the gallery-safe orchestrator method');
  // Forbid the RECONCILIATION call surface (function calls), not the word
  // "media_links" which legitimately appears in the explanatory comment.
  ok(!/draftFromSrcs|buildImageEditInputs|applyEditDurably\(|prepareAndRegisterEdit\(|editProductWithMedia\(/.test(fn), 'text path references NO gallery reconciliation surface');
  ok(!/\bimages\b\s*:/.test(fn), 'text path never writes an images column');
  ok(/invalidateImageDerived: false/.test(fn), 'text path does NOT invalidate the derived image fields');

  // Coordinator + orchestrator expose the gallery-safe method, and it lives
  // OUTSIDE any media_links mutation.
  const coord = readFileSync(join(repo, 'src/core/media/coordinator.ts'), 'utf8');
  ok(/applyProductTextEditDurably\(input: \{/.test(coord), 'coordinator.applyProductTextEditDurably exists');
  const cfn = coord.slice(coord.indexOf('applyProductTextEditDurably(input: {'), coord.indexOf('applyProductTextEditDurably(input: {') + 1400);
  ok(!/media_links/.test(cfn), 'coordinator text-edit method never references media_links');
  ok(/MEDIA_EDIT_BASELINE_CHANGED/.test(cfn), 'coordinator text-edit method keeps the baseline conflict guard');

  const orch = readFileSync(join(repo, 'src/core/media/orchestrator.ts'), 'utf8');
  ok(/async applyProductTextEditDurably\(input: \{/.test(orch), 'orchestrator.applyProductTextEditDurably exists');
  const ofn = orch.slice(orch.indexOf('async applyProductTextEditDurably'), orch.indexOf('async applyProductTextEditDurably') + 900);
  ok(/saveDurably\(\)/.test(ofn), 'orchestrator text-edit method checkpoints durably');
}

console.log(`\nMEDIA-EDIT-PRESERVE edit-routing: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
