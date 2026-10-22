// RESTORE-SAFETY — the restore preview the owner sees before confirming, and the panel's gate.
//
//   §1 numbers appear ONLY where the backend determined them; "not determined" stays words
//   §2 the gate: confirm only after the preview was shown (or shown to have failed)
//   §3 the new refusals are explained, never leaked as codes
//   §4 the wiring: the panel loads the preview with the owner password, the command exists, nothing else

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeRestorePreview, canConfirmRestoreAfterPreview, sanitizeBackupError,
} from '../../src/pages/settings/backup-restore-panel-logic.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string) => readFileSync(join(repo, p), 'utf8');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

const base = {
  snapshotCreatedAt: '2026-10-20T10:00:00Z', snapshotAppVersion: '0.8.85', liveDbRead: true,
  records: [
    { table: 'products', lost: 2, returning: 1 },
    { table: 'invoices', lost: 0, returning: 0 },
    { table: 'repairs', lost: null, returning: null },
  ],
  fieldChangesCompared: false, photosVisibleAgain: 3, photosLeaving: 1, mediaFilesNotInSnapshot: 4,
  filesFilledIn: 2, filesStillMissing: 5, archiveFiles: 900, archiveBytes: 130 * 1024 * 1024,
  spaceNeededBytes: 200 * 1024 * 1024, spaceFreeBytes: 50 * 1024 * 1024 * 1024, archivesExisting: 1, archivesExistingBytes: 10 * 1024 * 1024,
};

// ── §1 ──
{
  const lines = describeRestorePreview(base, true);
  const all = lines.map((l) => l.text).join('\n');
  ok(/2 items added since the backup will be gone/.test(all) && lines.some((l) => l.tone === 'loss' && /2 items/.test(l.text)), '§1 lost records with their exact number');
  ok(/1 item deleted since the backup come back/.test(all), '§1 returning records');
  ok(!/invoice/.test(all), '§1 a zero says nothing');
  ok(/Not determined for: repairs\./.test(all) && !/\d+ repairs/.test(all), '§1 an undetermined table: words, no number');
  ok(/Changes inside existing records are not compared/.test(all), '§1 field changes are said to be not compared');
  ok(/3 gallery photo\(s\) removed since the backup become visible again/.test(all) && /1 gallery photo\(s\) added since the backup leave/.test(all), '§1 gallery both ways');
  ok(/2 photo file\(s\) the backup lacks are taken over/.test(all) && /5 photo file\(s\) .* stay missing/.test(all), '§1 fill-in and still-missing');
  ok(lines.some((l) => l.tone === 'keep' && /Nothing is deleted/.test(l.text) && /900 files/.test(l.text)), '§1 the archive is announced');
  ok(/Earlier restore archives: 1/.test(all) && /never deleted automatically/.test(all), '§1 existing archives');
  ok(/Disk space: needs about/.test(all), '§1 space ok');

  const unknown = describeRestorePreview({ ...base, liveDbRead: false, records: base.records.map((r) => ({ ...r, lost: null, returning: null })), photosVisibleAgain: null, photosLeaving: null, filesFilledIn: null, filesStillMissing: null, spaceFreeBytes: null }, false);
  const u = unknown.map((l) => l.text).join('\n');
  ok(/could not be read/.test(u) && /Gallery changes are not determined/.test(u) && /could not be determined — the restore will refuse/.test(u) && /Unsaved changes could not be written first/.test(u), '§1 everything unknown is said as unknown');
  ok(!/\b\d+ (items|clients|gallery|photo file)/.test(u), '§1 …and carries no invented number');

  const tight = describeRestorePreview({ ...base, spaceFreeBytes: 10 }, true).map((l) => l.text).join('\n');
  ok(/Not enough free disk space/.test(tight) && /will refuse to start/.test(tight), '§1 not enough space is announced');
}

// ── §2 ──
{
  ok(!canConfirmRestoreAfterPreview('snap', 'pw', false, 'none'), '§2 not before the preview');
  ok(!canConfirmRestoreAfterPreview('snap', 'pw', false, 'loading'), '§2 not while it loads');
  ok(canConfirmRestoreAfterPreview('snap', 'pw', false, 'loaded'), '§2 after the preview');
  ok(canConfirmRestoreAfterPreview('snap', 'pw', false, 'failed'), '§2 a failed preview does not lock the owner out');
  ok(!canConfirmRestoreAfterPreview('snap', '', false, 'loaded') && !canConfirmRestoreAfterPreview(null, 'pw', false, 'loaded') && !canConfirmRestoreAfterPreview('snap', 'pw', true, 'loaded'), '§2 the old conditions still hold');
}

// ── §3 ──
{
  const s = (c: string) => sanitizeBackupError(new Error(c));
  ok(/Not enough free disk space/.test(s('MEDIA_RESTORE_INSUFFICIENT_SPACE')) && !/MEDIA_/.test(s('MEDIA_RESTORE_INSUFFICIENT_SPACE')), '§3 space');
  ok(/could not be determined/.test(s('MEDIA_RESTORE_FREE_SPACE_UNKNOWN')), '§3 unknown space');
  ok(/restart the app once/.test(s('MEDIA_RESTORE_ROLLBACK_PRESENT')), '§3 unarchived earlier restore');
  ok(s('MEDIA_FILE_HASH_MISMATCH') === 'The selected backup could not be verified.', '§3 the old mapping is unchanged');
}

// ── §4 ──
{
  const panel = src('src/pages/settings/BackupRestorePanel.tsx');
  const wiring = src('src/core/lifecycle/restore-wiring.ts');
  const lib = src('src-tauri/src/lib.rs');
  ok(/previewRestoreSnapshot\(\{ snapshotId: confirmId, email: email\.trim\(\), password: confirmPw \}\)/.test(panel), '§4 the panel previews with the re-entered owner password');
  ok(/canConfirmRestoreAfterPreview\(confirmId, confirmPw, busy, previewState\)/.test(panel) && !/canConfirmRestore\(confirmId/.test(panel), '§4 the confirm button waits for the preview');
  ok(/kept as a pre-restore\s+archive/.test(panel) && !/This cannot be undone/.test(panel), '§4 the warning says the data is kept');
  ok(/invoke\('preview_restore_snapshot'/.test(wiring) && /saveDatabaseDurably\(\)/.test(wiring), '§4 the wiring saves first, then asks the command');
  ok(/fn preview_restore_snapshot\([\s\S]*?authorize_owner[\s\S]*?restore_preview::preview/.test(lib) && /preview_restore_snapshot,/.test(lib), '§4 the command is owner-gated and registered');
}

console.log(`\nrestore-preview panel: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('RESTORE_PREVIEW_PANEL_PROVED');
