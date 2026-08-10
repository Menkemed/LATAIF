// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §9 — maintenance-panel preconditions + operator messages.
// Run: node test/storage-perf/storage-panel-logic.test.ts
//
// Covers the two things that decide whether a bulk migration may start at all —
// the fresh-backup gate and the code→text mapping the operator sees — without a
// browser: `assertFreshBackup` takes its snapshot source and its clock as
// arguments, and `explainStorageCode` is pure.
// ════════════════════════════════════════════════════════════════════════════

import { explainStorageCode, hasFreshBackup } from '../../src/pages/settings/storage-panel-logic.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// The REAL decision rule (the runtime wrapper only adds the Tauri call around it).
const backupIsFresh = hasFreshBackup;

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const ago = (h: number) => new Date(NOW - h * 3600000).toISOString();

// ── backup precondition ─────────────────────────────────────────────────────
ok(!backupIsFresh([], NOW), 'no snapshot at all → refuse');
ok(!backupIsFresh([{ createdAt: ago(48), dbSizeBytes: 1000 }], NOW), 'a two-day-old snapshot is not fresh enough');
ok(backupIsFresh([{ createdAt: ago(2), dbSizeBytes: 1000 }], NOW), 'a two-hour-old snapshot passes');
ok(backupIsFresh([{ createdAt: ago(23.9), dbSizeBytes: 1 }], NOW), 'just inside the 24h window passes');
ok(!backupIsFresh([{ createdAt: ago(24.1), dbSizeBytes: 1000 }], NOW), 'just outside the 24h window is refused');
ok(!backupIsFresh([{ createdAt: ago(1), dbSizeBytes: 0 }], NOW), 'an empty snapshot is not a backup');
ok(!backupIsFresh([{ createdAt: 'not-a-date', dbSizeBytes: 1000 }], NOW), 'an unparseable timestamp is refused, not trusted');
ok(backupIsFresh([{ createdAt: ago(72), dbSizeBytes: 10 }, { createdAt: ago(1), dbSizeBytes: 10 }], NOW),
  'one fresh snapshot among stale ones is enough');
ok(!backupIsFresh([{ createdAt: new Date(NOW + 3600000).toISOString(), dbSizeBytes: 10 }], NOW),
  'a snapshot dated in the future is refused (clock skew must not unlock the run)');

// ── operator messages ───────────────────────────────────────────────────────
const codes = [
  'BACKUP_REQUIRED', 'BACKUP_PRECONDITION_UNVERIFIABLE', 'MEDIA_SCOPE_REQUIRED',
  'LEGACY_ENTRY_BASE64_INVALID', 'LEGACY_ENTRY_NOT_A_DATA_URL', 'LEGACY_ENTRY_NOT_BASE64',
  'LEGACY_ENTRY_EMPTY', 'LEGACY_ENTRY_NOT_A_STRING', 'MEDIA_LEGACY_MALFORMED_JSON',
  'MEDIA_LEGACY_NOT_AN_ARRAY', 'MEDIA_LEGACY_NON_STRING_ELEMENT', 'VERIFY_LEGACY_NOT_CLEARED',
  'VERIFY_LINK_COUNT_MISMATCH', 'MEDIA_CUTOVER_INGEST_FAILED', 'MEDIA_CUTOVER_MANIFEST_MISMATCH',
  'MEDIA_CUTOVER_UNSUPPORTED_LEGACY', 'MEDIA_CUTOVER_LEGACY_FORMAT_ERROR', 'MEDIA_CUTOVER_FAILED',
  'COMPACTION_TRANSACTION_ACTIVE', 'COMPACTION_DB_TOO_LARGE',
];
for (const c of codes) {
  const text = explainStorageCode(c);
  ok(text !== c && text.length > 20, `${c} has a human explanation, not the raw code`);
}
ok(explainStorageCode(undefined).length > 0, 'an unknown code still yields a message');
ok(explainStorageCode('SOMETHING_NEW').includes('SOMETHING_NEW'), 'an unmapped code is surfaced verbatim, never swallowed');

// The failure texts must reassure that nothing was destroyed — that is the whole
// point of clearing the legacy column last.
for (const c of ['LEGACY_ENTRY_BASE64_INVALID', 'MEDIA_CUTOVER_INGEST_FAILED', 'MEDIA_CUTOVER_MANIFEST_MISMATCH', 'VERIFY_LEGACY_NOT_CLEARED']) {
  const t = explainStorageCode(c).toLowerCase();
  ok(t.includes('untouched') || t.includes('kept') || t.includes('still in place') || t.includes('nothing was lost'),
    `${c} tells the operator the originals survived`);
}
ok(!codes.some((c) => explainStorageCode(c).includes('base64,')), 'no message can leak image data');

console.log(`\nstorage-panel-logic: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
