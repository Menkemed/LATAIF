// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U2/R1 — boot-scheduled backup wiring + panel logic (headless).
// Run: node test/mobile04b2a12u2/backup-workflow.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { scheduleBackupSnapshotWith, type BackupRuntimeDeps } from '../../src/core/lifecycle/restore-wiring.ts';
import {
  sanitizeBackupError, formatBytes, canRunOwnerAction, canConfirmRestore,
} from '../../src/pages/settings/backup-restore-panel-logic.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } };

function deps(overrides: Partial<BackupRuntimeDeps> = {}) {
  const order: string[] = [];
  const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const d: BackupRuntimeDeps = {
    invoke: async (cmd, args) => { order.push('invoke:' + cmd); invokes.push({ cmd, args }); return { scheduled: true }; },
    pauseAutoSync: () => order.push('pauseAutoSync'),
    resumeAutoSync: () => order.push('resumeAutoSync'),
    stopMobileDrainPoller: () => order.push('stopMobileDrainPoller'),
    armMobileDrainPoller: () => order.push('armMobileDrainPoller'),
    waitForSyncIdle: async () => order.push('waitForSyncIdle'),
    saveDatabaseDurably: async () => order.push('saveDatabaseDurably'),
    relaunch: async () => order.push('relaunch'),
    setStatus: (s) => order.push('status:' + (s ? s.kind : 'null')),
    ...overrides,
  };
  return { d, order, invokes };
}
const OWNER = { email: 'o@x', password: 'pw' };

// ── §1 happy path: block → idle → FLUSH → SCHEDULE (intent) → relaunch ──
await (async () => {
  const { d, order, invokes } = deps();
  await scheduleBackupSnapshotWith(OWNER, d);
  ok(order.join(',') === 'status:scheduling,pauseAutoSync,stopMobileDrainPoller,waitForSyncIdle,saveDatabaseDurably,invoke:schedule_backup_snapshot,relaunch',
    'exact order (block→idle→flush→schedule→relaunch): ' + order.join(','));
  ok(invokes.length === 1 && invokes[0].cmd === 'schedule_backup_snapshot', 'schedules (never a direct create)');
  ok(invokes[0].args?.email === 'o@x' && invokes[0].args?.password === 'pw', 'owner credentials passed');
  ok(order.indexOf('saveDatabaseDurably') < order.indexOf('invoke:schedule_backup_snapshot'), 'durable flush BEFORE the intent (no intent before a good flush)');
  ok(!order.includes('resumeAutoSync'), 'no resume on the happy path');
})();

// ── §2 FLUSH failure (before the intent): resume + re-arm poller, NO schedule, NO relaunch ──
await (async () => {
  const { d, order, invokes } = deps({ saveDatabaseDurably: async () => { throw new Error('flush failed'); } });
  let threw = false;
  try { await scheduleBackupSnapshotWith(OWNER, d); } catch { threw = true; }
  ok(threw, 'a flush failure rejects');
  ok(invokes.length === 0, 'NO intent written when the flush fails');
  ok(order.includes('resumeAutoSync') && order.includes('armMobileDrainPoller'), 'writers resumed + poller re-armed');
  ok(!order.includes('relaunch'), 'no relaunch on a flush failure');
})();

// ── §3 SCHEDULE failure after a successful flush: no intent, resume, no relaunch ──
await (async () => {
  const { d, order } = deps({ invoke: async () => { throw new Error('OWNER auth failed'); } });
  let threw = false;
  try { await scheduleBackupSnapshotWith(OWNER, d); } catch { threw = true; }
  ok(threw, 'a schedule failure after the flush rejects');
  ok(order.includes('saveDatabaseDurably') && order.includes('resumeAutoSync'), 'flush happened, then writers resumed (no durable intent)');
  ok(!order.includes('relaunch'), 'no relaunch when the schedule fails after the flush');
})();

// ── §4 relaunch failure AFTER the intent is durable: fail-closed — no resume ──
await (async () => {
  const { d, order, invokes } = deps({ relaunch: async () => { throw new Error('relaunch failed'); } });
  let threw = false;
  try { await scheduleBackupSnapshotWith(OWNER, d); } catch { threw = true; }
  ok(threw && invokes.length === 1, 'the intent was scheduled before the relaunch failed');
  ok(!order.includes('resumeAutoSync'), 'fail-closed after a durable intent: no resume');
})();

// ── §4 panel logic: sanitisation never leaks internals; guards + formatting ──
await (async () => {
  ok(sanitizeBackupError(new Error('MEDIA_PATH_OUTSIDE_ROOT: C:/x/y')) === 'The selected backup could not be verified.', 'path/verify errors sanitised');
  ok(sanitizeBackupError(new Error('OWNER auth bad')) === 'Owner authorization failed.', 'owner errors sanitised');
  ok(!/C:|\/x\/|HASH|OUTSIDE/.test(sanitizeBackupError(new Error('MEDIA_FILE_HASH_MISMATCH /a/b'))), 'no path/hash/code leaks in the message');
  ok(formatBytes(512) === '512 B' && formatBytes(2048) === '2.0 KB' && formatBytes(3 * 1024 * 1024) === '3.0 MB', 'byte formatting');
  ok(!canRunOwnerAction('', 'pw', false) && !canRunOwnerAction('o', '', false) && !canRunOwnerAction('o', 'pw', true) && canRunOwnerAction('o', 'pw', false), 'owner-action gate (creds + not busy)');
  ok(!canConfirmRestore(null, 'pw', false) && !canConfirmRestore('id', '', false) && !canConfirmRestore('id', 'pw', true) && canConfirmRestore('id', 'pw', false), 'restore-confirm gate (id + pw + not busy)');
})();

console.log(`\nMOBILE-04B2A12-U2 backup-workflow: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
