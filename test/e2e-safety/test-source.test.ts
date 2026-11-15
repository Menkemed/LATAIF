// E2E-Testquelle (test/e2e/_e2e-preflight.mjs `testSourceFromEnv`): eine Sicherungskopie nur ausdrücklich aus der
// Umgebung; ohne Angabe Abbruch; ein lebender Datenordner wird abgewiesen; unvollständige Kopie abgewiesen.
// Run: node test/e2e-safety/test-source.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testSourceFromEnv } from '../e2e/_e2e-preflight.mjs';

let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log('  ✗ ' + m); } };
const err = (f: () => unknown): string => { try { f(); return ''; } catch (e) { return String((e as Error).message); } };

const box = mkdtempSync(join(tmpdir(), 'lataif-testsource-'));
try {
  const snap = join(box, 'snap-1'); mkdirSync(join(snap, 'tenant-1'), { recursive: true }); writeFileSync(join(snap, 'lataif.db'), 'x');
  const live = join(box, 'Data'); mkdirSync(join(live, 'tenant-1'), { recursive: true }); writeFileSync(join(live, 'lataif.db'), 'x'); writeFileSync(join(live, '.lataif-data-root.json'), '{}');
  const live2 = join(box, 'Data2'); mkdirSync(join(live2, 'tenant-1'), { recursive: true }); writeFileSync(join(live2, 'lataif.db'), 'x'); writeFileSync(join(live2, 'data-location.json'), '{}');
  const half = join(box, 'half'); mkdirSync(half); writeFileSync(join(half, 'lataif.db'), 'x');

  ok(/fehlt — die Testkopie muss ausdrücklich angegeben werden/.test(err(() => testSourceFromEnv('X_SNAP', ['lataif.db'], {}))), 'ohne Angabe: Abbruch (kein Standardpfad)');
  ok(/fehlt/.test(err(() => testSourceFromEnv('X_SNAP', ['lataif.db'], { X_SNAP: '   ' }))), 'leere Angabe: Abbruch');
  ok(/keinen Ordner/.test(err(() => testSourceFromEnv('X_SNAP', ['lataif.db'], { X_SNAP: join(box, 'gibt-es-nicht') }))), 'nicht vorhandener Ordner: Abbruch');
  ok(/LEBENDER Datenordner/.test(err(() => testSourceFromEnv('X_SNAP', ['lataif.db', 'tenant-1'], { X_SNAP: live }))), 'lebender Datenordner (.lataif-data-root.json): abgewiesen');
  ok(/LEBENDER Datenordner/.test(err(() => testSourceFromEnv('X_SNAP', ['lataif.db', 'tenant-1'], { X_SNAP: live2 }))), 'lebender Datenordner (data-location.json): abgewiesen');
  ok(/fehlt: tenant-1/.test(err(() => testSourceFromEnv('X_SNAP', ['lataif.db', 'tenant-1'], { X_SNAP: half }))), 'unvollständige Kopie: abgewiesen');
  ok(testSourceFromEnv('X_SNAP', ['lataif.db', 'tenant-1'], { X_SNAP: snap }) === snap, 'gültige Sicherungskopie: angenommen');
} finally {
  rmSync(box, { recursive: true, force: true });
}

console.log(`\nE2E-TEST-SOURCE: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
