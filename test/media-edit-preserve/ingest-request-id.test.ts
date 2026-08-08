// ════════════════════════════════════════════════════════════════════════════
// MEDIA — the ingest request id contract: every id JS hands to the Rust media
// core must satisfy `is_valid_request_id` (8..=80 chars, [A-Za-z0-9_-]).
// Run: node test/media-edit-preserve/ingest-request-id.test.ts
//
// This is the regression guard for a REAL defect found by the I1C UI E2E: the
// composed ids (`create:<tenant>:…`, `new:0`) contained ':' and were rejected
// with MEDIA_INGEST_INVALID_REQUEST, so NO desktop-side image ingest (create
// with photo, or adding a photo in the ProductDetail editor) could ever be
// prepared. The unit suites missed it because their fake gateway does not
// validate ids — so this test asserts the JS builders against the rule PARSED
// OUT OF ingest.rs itself, not against a copy of it.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  toIngestRequestId, isValidIngestRequestId, INGEST_REQUEST_ID_MIN, INGEST_REQUEST_ID_MAX,
} from '../../src/core/media/ingest-request-id.ts';
import { createRequestId, appendRequestId, cutoverRequestId } from '../../src/core/media/product-media-cutover.ts';
import { draftFromSrcs } from '../../src/core/media/product-edit-draft.ts';

let PASS = 0, FAIL = 0; const fails: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } }

// ── 1) the JS rule is EXACTLY the Rust rule (parsed from ingest.rs) ──────────
{
  const rs = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'media', 'ingest.rs'), 'utf8');
  const fn = rs.slice(rs.indexOf('fn is_valid_request_id'), rs.indexOf('fn is_valid_hash64'));
  const range = fn.match(/\((\d+)\.\.=(\d+)\)\.contains\(&id\.len\(\)\)/);
  ok(!!range, 'ingest.rs still bounds the request id length (rule found)');
  ok(range && Number(range[1]) === INGEST_REQUEST_ID_MIN && Number(range[2]) === INGEST_REQUEST_ID_MAX,
    `JS length bounds match Rust (${range?.[1]}..=${range?.[2]})`);
  ok(/is_ascii_alphanumeric\(\)\s*\|\|\s*c\s*==\s*b'-'\s*\|\|\s*c\s*==\s*b'_'/.test(fn),
    'Rust charset is still [A-Za-z0-9_-] (JS mirror is valid)');
}

// ── 2) the mapper is total, deterministic and always valid ──────────────────
{
  const nasty = [
    'create:tenant-1:branch-main:8046e9c0-836b-4efb-b2ad-84bb79a90b1e:stock_image:0',
    'new:0', 'new:7', 'a', '', 'x'.repeat(500),
    'tenant with spaces:branch/slash:id\\back:role:9',
    'ünïcödé:tenant:branch:product:role:1',
    'sql\'; DROP TABLE media_links; --:t:b:p:r:0',
    '../../escape:t:b:p:r:0',
  ];
  for (const raw of nasty) {
    const id = toIngestRequestId(raw);
    ok(isValidIngestRequestId(id), `mapped id is valid for input ${JSON.stringify(raw.slice(0, 28))} → ${JSON.stringify(id.slice(0, 28))}`);
    ok(id === toIngestRequestId(raw), 'mapping is deterministic (same input → same id)');
  }
  // path traversal / separators can never survive into a journal filename component
  ok(!/[./\\:]/.test(toIngestRequestId('../../escape:t:b:p:r:0')), 'no path separator or colon survives the mapping');
  // logically different inputs stay different even when the readable head is truncated
  const longA = 'create:' + 'a'.repeat(200) + ':X';
  const longB = 'create:' + 'a'.repeat(200) + ':Y';
  ok(toIngestRequestId(longA) !== toIngestRequestId(longB), 'truncated-but-different inputs do not collide (signature over the FULL input)');
}

// ── 3) every real builder produces an id the media core accepts ─────────────
{
  const T = 'tenant-1', B = 'branch-main', P = '8046e9c0-836b-4efb-b2ad-84bb79a90b1e', R = 'stock_image';
  for (const [name, id] of [
    ['createRequestId', createRequestId(T, B, P, R, 0)],
    ['createRequestId slot 7', createRequestId(T, B, P, R, 7)],
    ['appendRequestId', appendRequestId(T, B, P, R, 0)],
    ['cutoverRequestId', cutoverRequestId(T, B, P, R, 0)],
  ] as Array<[string, string]>) {
    ok(isValidIngestRequestId(id), `${name} satisfies the Rust ingest id rule`);
  }
  // the three namespaces stay distinct, and slots stay distinct
  const c0 = createRequestId(T, B, P, R, 0);
  ok(new Set([c0, appendRequestId(T, B, P, R, 0), cutoverRequestId(T, B, P, R, 0)]).size === 3, 'create/append/cutover remain three distinct identities');
  ok(c0 !== createRequestId(T, B, P, R, 1), 'slots remain distinct');
  ok(c0 !== createRequestId('tenant-2', B, P, R, 0) && c0 !== createRequestId(T, 'branch-2', P, R, 0), 'scope still qualifies the identity (tenant/branch)');
  ok(c0 === createRequestId(T, B, P, R, 0), 'create id is stable across calls (retry reuses the same id)');

  // the editor's new-image client id — this is the one that broke "add a photo while editing"
  const BATCH_A = `edit:${T}:${B}:${P}:${R}:11111111-1111-1111-1111-111111111111`;
  const BATCH_B = `edit:${T}:${B}:${P}:${R}:22222222-2222-2222-2222-222222222222`;
  const srcs = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'];
  const draft = draftFromSrcs(srcs, [], BATCH_A);
  ok(draft.ok, 'draftFromSrcs accepts two fresh data URLs');
  if (draft.ok) {
    const ids = draft.value.map((d) => (d.kind === 'new' ? d.clientId : ''));
    for (const id of ids) ok(isValidIngestRequestId(id), `editor new-image client id satisfies the Rust rule (${id})`);
    ok(new Set(ids).size === 2, 'the two draft slots get distinct ids');
    const again = draftFromSrcs(srcs, [], BATCH_A);
    ok(again.ok && JSON.stringify(again.value) === JSON.stringify(draft.value), 'the same draft + same batch reproduces the SAME ids (frozen-batch retry contract)');
    // A LATER edit of the SAME product (new batch) must NOT reuse the ids — the Rust journal binds an
    // ingest id to its content hash, so reuse with different bytes is a hard MEDIA_INGEST_REQUEST_CONFLICT.
    const later = draftFromSrcs(srcs, [], BATCH_B);
    const laterIds = later.ok ? later.value.map((d) => (d.kind === 'new' ? d.clientId : '')) : [];
    ok(laterIds.length === 2 && laterIds.every((x) => !ids.includes(x)), 'a NEW edit batch mints NEW new-image ids (a second add on the same product cannot conflict)');
    for (const id of laterIds) ok(isValidIngestRequestId(id), 'the second batch ids are valid too');
    // Two different PRODUCTS in the same tenant scope must not collide either.
    const otherProduct = draftFromSrcs(srcs, [], `edit:${T}:${B}:99999999-9999-9999-9999-999999999999:${R}:11111111-1111-1111-1111-111111111111`);
    const otherIds = otherProduct.ok ? otherProduct.value.map((d) => (d.kind === 'new' ? d.clientId : '')) : [];
    ok(otherIds.length === 2 && otherIds.every((x) => !ids.includes(x)), 'another product never reuses this product new-image ids');
  }
}

// ── 4) the store wires the batch id into the draft (the namespace is not optional in production) ──
{
  const store = readFileSync(join(process.cwd(), 'src', 'stores', 'productStore.ts'), 'utf8');
  ok(/draftFromSrcs\(editImages\.srcs, editImages\.resolved, batchId\)/.test(store), 'editProductWithMedia passes the edit batchId as the new-image id namespace');
  const idx = store.indexOf('const batchId = retryEditId'), draftIdx = store.indexOf('draftFromSrcs(editImages.srcs');
  ok(idx > 0 && draftIdx > idx, 'the batchId is resolved BEFORE the draft is built (retry keeps the frozen ids)');
}

console.log(`\nMEDIA ingest-request-id: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
