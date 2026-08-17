// ════════════════════════════════════════════════════════════════════════════
// v0.8.44 — the Backup & Restore surface, checked at the source.
// Run: npx tsx test/dataroot/backup-ui-contract.test.ts
//
// Three things a person actually complained about, each of which is a property of the rendered page
// and none of which needs a browser to verify:
//
//   1. the legacy "Export Backup" / "Restore from Backup" pair is gone. The restore half wrote the
//      uploaded file into localStorage, which the desktop app never reads — it loads the database
//      from disk in the data root. It could only ever say "Restore successful! Reloading…" and
//      change nothing, which is worse than having no restore button at all;
//   2. the snapshot list sits under its own heading, directly beneath the button that loads it —
//      not, as before, after the media-cleanup box where it read as part of it;
//   3. the timestamp says which clock it is, because the folder on disk is UTC and the row was
//      local, three hours apart on this installation with nothing to explain the gap.
//
// Source order is exactly the right thing to assert for (2): what the reader sees is the order the
// JSX is written in, and a DOM test would prove the same thing more slowly.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { formatSnapshotTime } from '../../src/pages/settings/backup-restore-panel-logic.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  x ${msg}`); }
}

const settings = readFileSync('src/pages/settings/SettingsPage.tsx', 'utf8');
const panel = readFileSync('src/pages/settings/BackupRestorePanel.tsx', 'utf8');

/** Strip comments so a comment ABOUT the removed feature is not mistaken for the feature. */
const code = (src: string) =>
  src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

// ── 1. the legacy pair is gone ──────────────────────────────────────────────
const settingsCode = code(settings);
ok(!/Export Backup/.test(settingsCode), 'no "Export Backup" control in the Danger Zone any more');
ok(!/Restore from Backup/.test(settingsCode), 'no "Restore from Backup" control either');
ok(!/Upload Backup File/.test(settingsCode), 'and no file picker for a .db upload');
ok(!/function handleBackup/.test(settingsCode), 'the legacy export handler is gone');
ok(!/function handleRestore/.test(settingsCode), 'the legacy restore handler is gone');
ok(
  !/localStorage\.setItem\(\s*'lataif_db_v2'/.test(settingsCode),
  'nothing in Settings writes the database into localStorage — that path never restored anything',
);
// The dangerous one specifically: no UI may claim a restore it cannot perform.
ok(!/Restore successful/.test(settingsCode), 'no success message for a restore that did nothing');

// What must still be there: the canonical surface, and the factory reset that lives next to it.
ok(/<BackupRestorePanel \/>/.test(settingsCode), 'the canonical Backup & Restore panel is still mounted');
ok(/<DataLocationPanel \/>/.test(settingsCode), 'and the data-location panel');
ok(/function handleReset/.test(settingsCode), 'the factory reset was not collateral damage');
ok(/createPreDestructiveBackup/.test(settingsCode), 'and it still takes its safety copy first');

// The browser/dev fallback inside the DB layer may stay — it is not a production desktop control.
const db = readFileSync('src/core/db/database.ts', 'utf8');
ok(/lataif_db_v2/.test(db), 'the browser fallback storage key still exists where it belongs');

// ── 2. the snapshot list is its own section, in the right place ─────────────
const iLoad = panel.indexOf('data-testid="brp-load"');
const iList = panel.indexOf('data-testid="brp-list-section"');
const iHeading = panel.indexOf('Available snapshots');
const iLocation = panel.indexOf('>Backup location<');
const iGc = panel.indexOf('>Unused media cleanup<');
ok(iList > 0 && iHeading > 0, 'the list has its own section with an "Available snapshots" heading');
ok(iLoad < iList, 'it comes after the button that loads it');
ok(iList < iLocation, 'and before the backup-location box');
ok(iList < iGc, 'and — the actual complaint — before the media-cleanup box, not inside it');
ok(panel.indexOf('data-testid="brp-restore"') > iList, 'the Restore button is still on every row');
ok(/data-snapshot-id=\{s\.snapshotId\}/.test(panel), 'and still carries the id it will restore');

// ── 3. the time says which clock ────────────────────────────────────────────
const t = formatSnapshotTime('2026-08-17T17:13:30.067Z');
ok(/local time/.test(t), `the row names the timezone it is showing (${t})`);
ok(!/^Invalid/.test(t), 'and it is a real formatted time');
ok(formatSnapshotTime('not-a-date') === 'not-a-date', 'an unparsable value is passed through, not faked');
ok(/formatSnapshotTime\(s\.createdAt\)/.test(panel), 'the row actually uses it');
ok(/data-testid="brp-row-id"/.test(panel), 'and the opaque snapshot id is shown, so disk and screen match up');

console.log(`\nbackup-ui-contract: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
