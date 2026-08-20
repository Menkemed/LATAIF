// D3 — Das Backup gilt erst als vorhanden, wenn die Kopie am ZIEL nachweislich stimmt.
// Run: node test/d3/pre-destructive-destination-verify.test.ts
//
// Vorher schrieb `runPreDestructiveBackup` die Prüfsumme der QUELLBYTES ins Manifest. Die sagt
// nichts darüber aus, ob am Ziel dasselbe angekommen ist: ein abgeschnittener Schreibvorgang
// (volle Platte, ausgehängtes Laufwerk, stiller IO-Fehler) wäre erst beim Restore aufgefallen —
// lange nachdem die destruktive Aktion die Originale gelöscht hat.
//
// Getestet wird echtes Verhalten über die injizierbaren IO-Deps: ein Fake-Dateisystem, das den
// Schreibvorgang gezielt verfälscht, plus `runGuardedReset` mit einem Reset-Spion. Fasst NIE
// echte App-Daten an.

import { createHash } from 'node:crypto';
import {
  runPreDestructiveBackup,
  type BackupFsDeps,
} from '../../src/core/settings/pre-destructive-backup.ts';
import { runGuardedReset } from '../../src/core/settings/safe-purge.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++; else fail.push(msg);
}

const SRC = { 'lataif.db': 'die echte Datenbank', 'lataif_sync_server.db': 'der Sync-Server' };
const enc = (s: string) => new TextEncoder().encode(s);

/** `damage` greift beim Schreiben ein: null = Datei landet gar nicht, sonst die verfälschten Bytes. */
type Damage = (path: string, bytes: Uint8Array) => Uint8Array | null;

function makeDeps(damage?: Damage, unreadable?: string): { deps: BackupFsDeps; fs: Map<string, Uint8Array> } {
  const fs = new Map<string, Uint8Array>();
  for (const [name, text] of Object.entries(SRC)) fs.set(`/data/${name}`, enc(text));

  const deps: BackupFsDeps = {
    dataRoot: async () => '/data',
    backupsRoot: async () => '/backups',
    join: async (...parts) => parts.join('/'),
    exists: async (p) => fs.has(p),
    readFile: async (p) => {
      if (unreadable && p.endsWith(unreadable)) throw new Error('EIO');
      const b = fs.get(p);
      if (!b) throw new Error(`ENOENT ${p}`);
      return b;
    },
    writeFile: async (p, data) => {
      const out = damage ? damage(p, data) : data;
      if (out === null) return; // Schreibvorgang schluckt die Datei stillschweigend
      fs.set(p, out);
    },
    mkdir: async () => {},
    sha256: async (d) => createHash('sha256').update(d).digest('hex'),
    appVersion: async () => '0.8.45',
    nowIso: () => '2026-08-20T12:00:00.000Z',
  };
  return { deps, fs };
}

async function threw(fn: () => Promise<unknown>): Promise<Error | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
}

/** Der komplette Guard-Pfad mit Reset-Spion — beantwortet die einzige Frage, die zählt. */
async function resetReached(deps: BackupFsDeps): Promise<{ reset: number; err: Error | null }> {
  let reset = 0;
  const err = await threw(() =>
    runGuardedReset({
      syncConfigured: false,
      lanMode: 'off',
      backup: () => runPreDestructiveBackup('factory-reset', deps),
      reset: async () => { reset++; },
      onBlocked: () => {},
    })
  );
  return { reset, err };
}

// ── 1. Happy-Path — Ziel stimmt, der Reset darf laufen ──────────────────
{
  const { deps, fs } = makeDeps();
  const res = await runPreDestructiveBackup('factory-reset', deps);
  check(res.files.length === 2, 'happy: beide Quelldateien wurden gesichert');
  check(
    res.files.every((f) => typeof f.sha256 === 'string' && f.sha256.length === 64),
    'happy: jede Datei traegt eine Pruefsumme'
  );
  const dst = fs.get('/backups/pre_destructive_2026-08-20T12-00-00-000Z/lataif.db');
  check(
    dst !== undefined && new TextDecoder().decode(dst) === SRC['lataif.db'],
    'happy: am Ziel liegen die richtigen Bytes'
  );
  check(fs.has(res.manifestPath), 'happy: das Manifest liegt am Ziel');

  const { reset, err } = await resetReached(makeDeps().deps);
  check(err === null, 'happy: der Guard wirft nicht');
  check(reset === 1, 'happy: resetDatabase() wird genau einmal erreicht');
}

// ── 2. Abgeschnittene Kopie ─────────────────────────────────────────────
{
  const { deps } = makeDeps((p, b) => (p.endsWith('lataif.db') ? b.slice(0, 3) : b));
  const { reset, err } = await resetReached(deps);
  check(err !== null && /Größe weicht ab/.test(err.message), 'truncate: Groessenabweichung wird erkannt');
  check(err !== null && /lataif\.db/.test(err.message), 'truncate: die Fehlermeldung nennt die Datei');
  check(reset === 0, 'truncate: resetDatabase() wird NICHT erreicht');
}

// ── 3. Gleiche Länge, andere Bytes — nur der Hash verrät es ─────────────
{
  const { deps } = makeDeps((p, b) => {
    if (!p.endsWith('lataif.db')) return b;
    const c = new Uint8Array(b); c[0] ^= 0xff; return c;
  });
  const { reset, err } = await resetReached(deps);
  check(err !== null && /Prüfsumme weicht ab/.test(err.message), 'bitflip: Hash-Mismatch wird erkannt');
  check(reset === 0, 'bitflip: resetDatabase() wird NICHT erreicht');
}

// ── 4. Schreibvorgang schluckt die Datei ────────────────────────────────
{
  const { deps } = makeDeps((p, b) => (p.endsWith('lataif.db') ? null : b));
  const { reset, err } = await resetReached(deps);
  check(err !== null && /Zieldatei fehlt/.test(err.message), 'missing: fehlende Zieldatei wird erkannt');
  check(reset === 0, 'missing: resetDatabase() wird NICHT erreicht');
}

// ── 5. Ziel nicht lesbar ────────────────────────────────────────────────
{
  const { deps } = makeDeps(undefined, 'pre_destructive_2026-08-20T12-00-00-000Z/lataif.db');
  const { reset, err } = await resetReached(deps);
  check(err !== null && /nicht lesbar/.test(err.message), 'unreadable: Lesefehler bricht ab');
  check(reset === 0, 'unreadable: resetDatabase() wird NICHT erreicht');
}

// ── 6. Auch das Manifest wird verifiziert ───────────────────────────────
{
  const { deps } = makeDeps((p, b) => (p.endsWith('manifest.json') ? b.slice(0, 10) : b));
  const { reset, err } = await resetReached(deps);
  check(err !== null && /manifest\.json/.test(err.message), 'manifest: ein kaputtes Manifest bricht ab');
  check(reset === 0, 'manifest: resetDatabase() wird NICHT erreicht');
}

// ── 7. Die Pruefsumme stammt aus den ZURUECKGELESENEN Bytes ─────────────
// Beweis: ein Fake-FS, das beim Zurueck-Lesen etwas anderes liefert als geschrieben wurde, muss
// auffliegen — waere weiter die Quelle gehasht worden, bliebe es unbemerkt.
{
  const { deps } = makeDeps();
  const real = deps.readFile.bind(deps);
  deps.readFile = async (p: string) =>
    p.includes('pre_destructive_') && p.endsWith('lataif.db') ? enc('etwas ganz anderes!!') : real(p);
  const { reset, err } = await resetReached(deps);
  check(err !== null, 'readback: eine abweichende Ruecklesung fliegt auf');
  check(reset === 0, 'readback: resetDatabase() wird NICHT erreicht');
}

console.log(`\nD3 pre-destructive destination-verify: ${pass}/${pass + fail.length} checks passed`);
if (fail.length) {
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ all D3 destination-verify checks green');
