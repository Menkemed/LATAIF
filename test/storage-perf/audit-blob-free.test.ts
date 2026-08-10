// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §13/§14 — blob-free audit writes.
// Run: node test/storage-perf/audit-blob-free.test.ts
//
// Proves the audit serialiser drops inline base64 image payloads while keeping
// audit TRUTH: identity, change-detection and add/remove/replace semantics.
// No production DB, no Tauri, no base64 ever printed.
// ════════════════════════════════════════════════════════════════════════════

import {
  AUDIT_MEDIA_MARKER,
  describeInlineDataUrl,
  identityDigest64,
  isInlineDataUrl,
  serializeAuditValue,
  stripInlineMedia,
} from '../../src/core/audit/audit-value.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// ── deterministic payloads (never printed) ──────────────────────────────────
function b64(len: number, seed: number): string {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) { x = (x * 1103515245 + 12345) >>> 0; s += alpha[x % 64]; }
  // keep the length a multiple of 4 so it is a valid base64 body
  while (s.length % 4 !== 0) s += 'A';
  return s;
}
const IMG_A = `data:image/jpeg;base64,${b64(600000, 1)}`;
const IMG_B = `data:image/jpeg;base64,${b64(600000, 2)}`;
const IMG_A_COPY = IMG_A;
const IMG_PNG = `data:image/png;base64,${b64(4096, 3)}`;

// ── 1. detection ────────────────────────────────────────────────────────────
ok(isInlineDataUrl(IMG_A), 'detects an inline base64 data URL');
ok(isInlineDataUrl(IMG_PNG), 'detects a png data URL');
ok(!isInlineDataUrl('data:text/plain,hello'), 'a non-base64 data URL is not an inline blob');
ok(!isInlineDataUrl('https://example.invalid/a.jpg'), 'a http url is not an inline blob');
ok(!isInlineDataUrl('short'), 'a short string is not scanned');
ok(!isInlineDataUrl(null), 'null is not an inline blob');
ok(!isInlineDataUrl(42), 'a number is not an inline blob');

// ── 2. descriptor keeps identity ────────────────────────────────────────────
const dA = describeInlineDataUrl(IMG_A);
const dB = describeInlineDataUrl(IMG_B);
const dA2 = describeInlineDataUrl(IMG_A_COPY);
ok(dA[AUDIT_MEDIA_MARKER] === 'data-url', 'descriptor carries the marker');
ok(dA.mime === 'image/jpeg', 'descriptor keeps the mime type');
ok(dA.bytes === Math.floor(600000 * 3 / 4), 'descriptor reports the DECODED byte size');
ok(dA.digest.length === 16 && /^[0-9a-f]+$/.test(dA.digest), 'digest is 16 hex chars');
ok(dA.digest === dA2.digest, 'same image → same digest (unchanged is provably unchanged)');
ok(dA.digest !== dB.digest, 'different image → different digest (a change stays visible)');
ok(describeInlineDataUrl(IMG_PNG).mime === 'image/png', 'mime is not hard-coded to jpeg');

// digest determinism + discrimination (identity digest, not a crypto hash)
ok(identityDigest64('abc') === identityDigest64('abc'), 'digest is deterministic');
ok(identityDigest64('abc') !== identityDigest64('abd'), 'a one-character change changes the digest');
ok(identityDigest64('ab') !== identityDigest64('ba'), 'order matters');
ok(identityDigest64('').length === 16, 'digest is always 16 hex chars');
{
  // No collisions across a large deterministic corpus of realistic payloads.
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(identityDigest64(`data-${i}-${b64(64, i)}`));
  ok(seen.size === 5000, `5000 distinct payloads → 5000 distinct digests (got ${seen.size})`);
}

// ── 3. size: the whole point ────────────────────────────────────────────────
const serializedImage = serializeAuditValue(IMG_A)!;
ok(serializedImage.length < 200, `serialised image value is tiny (${serializedImage.length}B, was ${IMG_A.length}B)`);
ok(!serializedImage.includes('base64,'), 'serialised image value carries no base64 payload');
ok(serializedImage.includes(dA.digest), 'serialised image value carries the digest');

// ── 4. the products.images shape (a JSON STRING containing data URLs) ───────
const imagesColumn = JSON.stringify([IMG_A, IMG_B]);
const serializedColumn = serializeAuditValue(imagesColumn)!;
ok(!serializedColumn.includes('base64,'), 'stringified images column is stripped too');
ok(serializedColumn.length < 400, `stringified column collapses (${serializedColumn.length}B, was ${imagesColumn.length}B)`);
{
  const parsed = JSON.parse(serializedColumn) as Array<Record<string, unknown>>;
  ok(Array.isArray(parsed) && parsed.length === 2, 'slot count survives — a 2-image gallery is still 2 entries');
  ok(parsed[0].digest === dA.digest && parsed[1].digest === dB.digest, 'per-slot identity survives in order');
}

// ── 5. add / remove / replace stay legible ──────────────────────────────────
{
  const before = JSON.parse(serializeAuditValue(JSON.stringify([IMG_A]))!) as Array<Record<string, unknown>>;
  const afterAdd = JSON.parse(serializeAuditValue(JSON.stringify([IMG_A, IMG_B]))!) as Array<Record<string, unknown>>;
  const afterRemove = JSON.parse(serializeAuditValue(JSON.stringify([]))!) as unknown[];
  const afterReplace = JSON.parse(serializeAuditValue(JSON.stringify([IMG_B]))!) as Array<Record<string, unknown>>;
  ok(afterAdd.length === before.length + 1 && afterAdd[0].digest === before[0].digest, 'ADD: slot 0 unchanged, one appended');
  ok(afterRemove.length === 0, 'REMOVE-ALL: empty gallery is still an empty list');
  ok(afterReplace.length === 1 && afterReplace[0].digest !== before[0].digest, 'REPLACE: same slot, different identity');
}

// ── 6. everything that is NOT an image is untouched ─────────────────────────
ok(serializeAuditValue(null) === null, 'null stays null');
ok(serializeAuditValue(undefined) === null, 'undefined stays null');
ok(serializeAuditValue('Rolex Datejust 41') === 'Rolex Datejust 41', 'plain text is byte-identical');
ok(serializeAuditValue(0) === '0', 'zero is serialised as "0", not dropped');
ok(serializeAuditValue(false) === 'false', 'false is serialised');
ok(serializeAuditValue(12.75) === '12.75', 'decimals survive');
ok(serializeAuditValue('[]') === '[]', 'an empty images column stays "[]"');
ok(serializeAuditValue('{"movement":"Cal. 3235","diamonds":true}') === '{"movement":"Cal. 3235","diamonds":true}',
  'a legacy attribute JSON string is byte-identical');
{
  const attrs = { movement: 'Cal. 3235', diamonds: true, case_diameter_mm: 41, year: null };
  ok(serializeAuditValue(attrs) === JSON.stringify(attrs), 'a structured attribute object is byte-identical');
}
ok(serializeAuditValue('data:text/plain,hello') === 'data:text/plain,hello', 'a non-base64 data URL is left alone');
{
  // A malformed JSON string that merely mentions data: must not be mangled.
  const weird = 'not json but mentions data: and is quite long ................................';
  ok(serializeAuditValue(weird) === weird, 'a non-JSON string mentioning "data:" is untouched');
}

// ── 7. nested structures ────────────────────────────────────────────────────
{
  const row = { id: 'p1', brand: 'Rolex', purchase_price: 0, images: [IMG_A], notes: null };
  const outStr = serializeAuditValue(row)!;
  ok(!outStr.includes('base64,'), 'nested image inside a full row object is stripped');
  const out = JSON.parse(outStr) as Record<string, unknown>;
  ok(out.id === 'p1' && out.brand === 'Rolex', 'sibling fields survive');
  ok(out.purchase_price === 0, 'purchase_price 0 survives as a number, not dropped');
  ok(out.notes === null, 'explicit null survives');
  ok(Array.isArray(out.images) && (out.images as Array<Record<string, unknown>>)[0][AUDIT_MEDIA_MARKER] === 'data-url',
    'the image slot became a descriptor');
}
{
  // Identity is preserved for the no-image case: same object in, same object out.
  const clean = { a: 1, b: 'x', c: [1, 2, 3] };
  ok(stripInlineMedia(clean) === clean, 'an image-free value is returned by reference (no needless copy)');
}
{
  // A cyclic object must not hang the audit writer.
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  const res = serializeAuditValue(cyc);
  ok(typeof res === 'string' && res.length > 0, 'a cyclic value still produces a bounded audit string');
}

// ── 8. cost ─────────────────────────────────────────────────────────────────
{
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) serializeAuditValue(IMG_A);
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  ok(perCallMs < 50, `stripping a 600 KB payload stays cheap (${perCallMs.toFixed(1)} ms/call)`);
}

// ── 9. SINGLE-PC-STORAGE-I2 §18 — this slice migrates ONE image column, and says so ────────
//
// `repairs.images` (1.5 MB) and `purchase_inbox.images` (0.5 MB) hold inline base64 too, and are
// deliberately NOT part of this slice: they have their own writers, their own lifecycles and their
// own verification story. Quietly widening the migration to them would move data no one has proven
// safe to move. This asserts the SCOPE statically, so a later edit cannot broaden it by accident.
{
  const files = [
    'src/core/storage/legacy-media-plan.ts',
    'src/core/storage/legacy-media-migration.ts',
    'src/core/storage/legacy-media-wiring.ts',
    'src/core/storage/database-compaction.ts',
    'src/core/storage/changelog-retention.ts',
    'src/pages/settings/StorageMaintenancePanel.tsx',
  ];
  for (const f of files) {
    const src = readFileSync(join(REPO, f), 'utf8');
    ok(!/\brepairs\b/.test(src), `§18 ${f} never touches repairs`);
    ok(!/\bpurchase_inbox\b/.test(src), `§18 ${f} never touches purchase_inbox`);
  }
  // …and the one column it DOES migrate is named exactly once, in the planner and the writer.
  const plan = readFileSync(join(REPO, 'src/core/storage/legacy-media-plan.ts'), 'utf8');
  ok(/products/.test(plan) && /images/.test(plan), '§18 the slice migrates products.images and nothing else');
}

console.log(`\naudit-blob-free: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
