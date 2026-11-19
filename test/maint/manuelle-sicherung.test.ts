// Manuelle Vollsicherung (scripts/maint/manuelle-sicherung.mjs) — nur in einem Sandbox-Ordner unter %TEMP%.
// Kein produktiver Pfad, keine produktive App. Die Prozessprüfung wird auf eine EIGENE Köder-exe in der Sandbox
// beschränkt (`--nur-pfad`), damit eine laufende echte App die Probe weder stört noch von ihr berührt wird.
// Hinweis: startet kurz eine Köder-`lataif.exe` (Kopie von node.exe) in %TEMP% — nicht parallel zu E2E laufen lassen.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'scripts', 'maint', 'manuelle-sicherung.mjs');
let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

const box = mkdtempSync(join(tmpdir(), 'lataif-sicherung-test-'));
const DATA = join(box, 'Data');
const E = join(box, 'E'), F = join(box, 'F');
const DECOY = join(box, 'bin', 'lataif.exe');

function run(args: string[]): { code: number; out: any } {
  try {
    const s = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: JSON.parse(s) };
  } catch (e: any) {
    const txt = String(e.stdout || '') || String(e.stderr || '');
    let out: any = null; try { out = JSON.parse(txt); } catch { out = { raw: txt }; }
    return { code: e.status ?? 1, out };
  }
}
function treeHash(root: string): string {
  const h = createHash('sha256');
  const rec = (d: string, rel: string) => { for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, n.name); const r = `${rel}/${n.name}`;
    if (n.isDirectory()) rec(p, r); else { h.update(r); h.update(readFileSync(p)); }
  } };
  rec(root, '');
  return h.digest('hex');
}

function seed(): void {
  mkdirSync(join(DATA, 'media', 'tenant-1', 'aa'), { recursive: true });
  mkdirSync(join(DATA, 'media', '.ingest-journal'), { recursive: true });
  mkdirSync(join(DATA, 'mobile-upload-staging', 'tenant-1'), { recursive: true });
  mkdirSync(join(DATA, 'command-staging'), { recursive: true });
  const a = new DatabaseSync(join(DATA, 'lataif.db'));
  a.exec(`CREATE TABLE media_ingest_jobs (job_id TEXT PRIMARY KEY, state TEXT); INSERT INTO media_ingest_jobs VALUES ('j1','accepted'),('j2','accepted');`);
  a.close();
  const s = new DatabaseSync(join(DATA, 'lataif_sync_server.db'));
  s.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (x); INSERT INTO t VALUES (1),(2),(3);`);
  // bewusst offen lassen → -wal mit Inhalt liegt neben der DB (wie im Betrieb); Verbindung wird gleich geschlossen,
  // aber ohne Checkpoint (wal_autocheckpoint=0)
  s.close();
  writeFileSync(join(DATA, 'media', 'tenant-1', 'aa', 'aa11.jpg'), Buffer.alloc(5000, 7));
  writeFileSync(join(DATA, 'media', '.ingest-journal', 'tenant-1__req1.json'), '{"x":1}');
  writeFileSync(join(DATA, 'mobile-upload-staging', 'tenant-1', 'm.jpg'), Buffer.alloc(300, 3));
  writeFileSync(join(DATA, 'sync_jwt_secret.key'), 'secret');
  writeFileSync(join(DATA, '.lataif-data-root.json'), '{}');
  mkdirSync(E); mkdirSync(F);
  writeFileSync(join(box, 'data-location.json'), '{"dataRoot":"SANDBOX"}');
}

async function main(): Promise<void> {
  seed();
  const base = ['--quelle', DATA, '--ziel', E, '--ziel', F, '--ruhe-sekunden', '1', '--nur-pfad', DECOY];
  const name = '2026-11-16_test-sicherung';
  const dataBefore = treeHash(DATA);

  // ── sichern ────────────────────────────────────────────────────────────────
  const r1 = run(['sichern', ...base, '--name', name, '--locator', join(box, 'data-location.json')]);
  ok(r1.code === 0 && r1.out.ok && r1.out.ziele.length === 2, `Sicherung auf zwei Ziele (${JSON.stringify(r1.out).slice(0, 160)})`);
  ok(r1.out.dateien >= 7 && r1.out.medien === 2 && r1.out.integritaet['lataif.db'] === 'ok' && r1.out.integritaet['lataif_sync_server.db'] === 'ok', 'alle Dateien, Medien inkl. Journal, beide Datenbanken integer');
  for (const z of [E, F]) {
    ok(existsSync(join(z, name, 'Data', 'media', '.ingest-journal', 'tenant-1__req1.json')) && existsSync(join(z, name, 'MANIFEST-sha256.json')) && existsSync(join(z, name, 'WIEDERHERSTELLUNG.md')), `${z.slice(-1)}: Journal, Manifest, Anleitung vorhanden`);
    ok(existsSync(join(z, name, '_locator', 'data-location.json')) && !existsSync(join(z, name, 'Data', 'data-location.json')), `${z.slice(-1)}: Locator getrennt in _locator/`);
    ok(!existsSync(join(z, `${name}.unfertig`)), `${z.slice(-1)}: kein halbfertiger Ordner`);
  }
  ok(treeHash(DATA) === dataBefore, 'Quelle nur gelesen (unverändert)');
  const eHash = treeHash(join(E, name));

  // ── nie überschreiben ───────────────────────────────────────────────────────
  const r2 = run(['sichern', ...base, '--name', name]);
  ok(r2.code !== 0 && /nicht überschrieben/.test(r2.out.abbruch ?? ''), 'gleicher Name: abgewiesen, nicht überschrieben');
  ok(treeHash(join(E, name)) === eHash, 'bestehende Sicherung unverändert');

  // ── pruefen ─────────────────────────────────────────────────────────────────
  ok(run(['pruefen', '--sicherung', join(E, name)]).out.ok === true && run(['pruefen', '--sicherung', join(F, name)]).out.ok === true, 'Prüfen: beide Sicherungen fehlerfrei');
  // Manipulation in einer KOPIE der Sicherung (die Sicherung selbst bleibt heil)
  const bad = join(box, 'bad');
  execFileSync(process.execPath, ['-e', `require('node:fs').cpSync(${JSON.stringify(join(E, name))}, ${JSON.stringify(bad)}, { recursive: true })`]);
  writeFileSync(join(bad, 'Data', 'media', 'tenant-1', 'aa', 'aa11.jpg'), Buffer.alloc(5000, 8));
  writeFileSync(join(bad, 'Data', 'extra.txt'), 'x');
  rmSync(join(bad, 'Data', 'mobile-upload-staging', 'tenant-1', 'm.jpg'));
  const pb = run(['pruefen', '--sicherung', bad]).out;
  ok(pb.ok === false && pb.abweichungen.some((x: string) => x.startsWith('verändert')) && pb.abweichungen.some((x: string) => x.startsWith('zusätzlich')) && pb.abweichungen.some((x: string) => x.startsWith('fehlt')), 'Prüfen erkennt verändert / zusätzlich / fehlt');

  // ── App läuft → Abbruch ─────────────────────────────────────────────────────
  mkdirSync(dirname(DECOY), { recursive: true });
  copyFileSync(process.execPath, DECOY);
  const decoy = spawn(DECOY, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const r3 = run(['sichern', ...base, '--name', '2026-11-16_test-laeuft']);
  ok(r3.code !== 0 && /App läuft/.test(r3.out.abbruch ?? ''), 'laufende App (genau diese exe): Abbruch');
  const r3b = run(['zurueckspielen', '--sicherung', join(E, name), '--ziel', DATA, '--beiseite', join(box, 'beiseite-x'), '--bestaetigen', name, '--nur-pfad', DECOY]);
  ok(r3b.code !== 0 && /App läuft/.test(r3b.out.abbruch ?? '') && treeHash(DATA) === dataBefore, 'Zurückspielen bei laufender App: Abbruch, nichts angefasst');
  decoy.kill(); // nur die eigene PID
  await new Promise((r) => setTimeout(r, 500));
  ok(!existsSync(join(E, '2026-11-16_test-laeuft')), 'keine Sicherung angelegt');

  // ── Ruhe verletzt → Abbruch ────────────────────────────────────────────────
  // schreibt laufend weiter, solange die Sicherung läuft (wie eine noch offene App)
  let tick = 0;
  const writer = setInterval(() => writeFileSync(join(DATA, 'media', 'tenant-1', 'aa', 'neu.jpg'), `x${tick++}`), 250);
  const r4 = await new Promise<{ code: number; out: any }>((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, 'sichern', '--quelle', DATA, '--ziel', E, '--ruhe-sekunden', '2', '--nur-pfad', DECOY, '--name', '2026-11-16_test-unruhig'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; });
    p.on('close', (code) => { let out: any = null; try { out = JSON.parse(o); } catch { out = { raw: o }; } resolve({ code: code ?? 1, out }); });
  });
  clearInterval(writer);
  ok(r4.code !== 0 && /nicht ruhig/.test(r4.out.abbruch ?? '') && !existsSync(join(E, '2026-11-16_test-unruhig')), 'Quelle während der Ruheprüfung verändert: Abbruch, keine Sicherung');
  rmSync(join(DATA, 'media', 'tenant-1', 'aa', 'neu.jpg'), { force: true });
  ok(treeHash(DATA) === dataBefore, 'Sandbox wieder am Ausgangsstand');

  // ── Zurückspielen ───────────────────────────────────────────────────────────
  // „Wartung“ simulieren: Job abgebrochen, neue Datei, eine Datei weg
  { const a = new DatabaseSync(join(DATA, 'lataif.db')); a.exec(`UPDATE media_ingest_jobs SET state = 'failed'`); a.close(); }
  writeFileSync(join(DATA, 'media', 'tenant-1', 'aa', 'spaeter.jpg'), 'later');
  rmSync(join(DATA, 'mobile-upload-staging', 'tenant-1', 'm.jpg'));
  const changed = treeHash(DATA);
  ok(changed !== dataBefore, 'Sandbox verändert (wie nach der Wartung)');
  const rw = run(['zurueckspielen', '--sicherung', join(E, name), '--ziel', DATA, '--beiseite', join(box, 'beiseite-1'), '--bestaetigen', 'falsch-xxxx', '--nur-pfad', DECOY]);
  ok(rw.code !== 0 && /bestaetigen/.test(rw.out.abbruch ?? '') && treeHash(DATA) === changed, 'falsche Bestätigung: nichts zurückgespielt');
  const rbad = run(['zurueckspielen', '--sicherung', bad, '--ziel', DATA, '--beiseite', join(box, 'beiseite-2'), '--bestaetigen', name, '--nur-pfad', DECOY]);
  ok(rbad.code !== 0 && /nicht fehlerfrei/.test(rbad.out.abbruch ?? '') && treeHash(DATA) === changed && !existsSync(join(box, 'beiseite-2')), 'beschädigte Sicherung: nichts zurückgespielt');
  mkdirSync(join(box, 'beiseite-3'));
  const rex = run(['zurueckspielen', '--sicherung', join(E, name), '--ziel', DATA, '--beiseite', join(box, 'beiseite-3'), '--bestaetigen', name, '--nur-pfad', DECOY]);
  ok(rex.code !== 0 && /existiert bereits/.test(rex.out.abbruch ?? '') && treeHash(DATA) === changed, 'Beiseite-Ordner existiert: abgewiesen');
  const rr = run(['zurueckspielen', '--sicherung', join(F, name), '--ziel', DATA, '--beiseite', join(box, 'beiseite-4'), '--bestaetigen', name, '--nur-pfad', DECOY]);
  ok(rr.code === 0 && rr.out.ok, `Zurückspielen aus F: (${JSON.stringify(rr.out).slice(0, 120)})`);
  ok(treeHash(DATA) === dataBefore, 'Datenordner danach EXAKT der Stand der Sicherung (auch die spätere Datei ist weg)');
  ok(treeHash(join(box, 'beiseite-4')) === changed, 'der vorherige Stand liegt vollständig in --beiseite');
  ok(!existsSync(join(DATA, 'data-location.json')) && !existsSync(join(DATA, '_locator')), 'Locator nie in den Datenordner geschrieben');
  { const a = new DatabaseSync(join(DATA, 'lataif.db'), { readOnly: true }); ok(a.prepare(`SELECT COUNT(*) n FROM media_ingest_jobs WHERE state='accepted'`).get()!.n === 2, 'nach dem Rückweg: Jobs wieder accepted'); a.close(); }
  ok(treeHash(join(E, name)) === eHash, 'Sicherung durch das Zurückspielen nicht verändert');

  // ── Zurückspielen in einen VÖLLIG LEEREN Datenordner (z. B. neuer Rechner) ─────────────────────
  // Vorher: --beiseite entstand erst mit der ersten kopierten Datei → bei leerem Ziel ENOENT, nichts zurückgespielt.
  {
    const leer = join(box, 'leer-data');
    mkdirSync(leer);
    const rl = run(['zurueckspielen', '--sicherung', join(E, name), '--ziel', leer, '--beiseite', join(box, 'beiseite-leer'), '--bestaetigen', name, '--nur-pfad', DECOY]);
    ok(rl.code === 0 && rl.out.ok && rl.out.zielWarLeer === true && rl.out.beiseiteDateien === 0,
      `leerer Zielordner: zurückgespielt (${JSON.stringify(rl.out).slice(0, 160)})`);
    ok(treeHash(leer) === dataBefore, 'leerer Zielordner: danach EXAKT der Stand der Sicherung');
    ok(existsSync(join(box, 'beiseite-leer')) && readdirSync(join(box, 'beiseite-leer')).length === 0, 'leerer Zielordner: --beiseite angelegt und leer (es gab nichts zu sichern)');
    ok(!existsSync(join(leer, 'data-location.json')) && !existsSync(join(leer, '_locator')), 'leerer Zielordner: Locator nicht geschrieben');
    // Die Schutzregeln gelten unverändert auch für das leere Ziel.
    const leer2 = join(box, 'leer-data-2'); mkdirSync(leer2);
    const rlx = run(['zurueckspielen', '--sicherung', join(E, name), '--ziel', leer2, '--beiseite', join(box, 'beiseite-leer'), '--bestaetigen', name, '--nur-pfad', DECOY]);
    ok(rlx.code !== 0 && /existiert bereits/.test(rlx.out.abbruch ?? '') && readdirSync(leer2).length === 0, 'leeres Ziel, --beiseite existiert: abgewiesen, nichts geschrieben');
    const rlb = run(['zurueckspielen', '--sicherung', join(E, name), '--ziel', leer2, '--beiseite', join(box, 'beiseite-leer-2'), '--bestaetigen', 'falsch-xxxx', '--nur-pfad', DECOY]);
    ok(rlb.code !== 0 && /bestaetigen/.test(rlb.out.abbruch ?? '') && readdirSync(leer2).length === 0 && !existsSync(join(box, 'beiseite-leer-2')), 'leeres Ziel, falsche Bestätigung: abgewiesen, nichts angelegt');
    const rlf = run(['zurueckspielen', '--sicherung', join(E, name), '--ziel', join(box, 'gibt-es-nicht'), '--beiseite', join(box, 'beiseite-leer-3'), '--bestaetigen', name, '--nur-pfad', DECOY]);
    ok(rlf.code !== 0 && /Datenordner fehlt/.test(rlf.out.abbruch ?? '') && !existsSync(join(box, 'beiseite-leer-3')), 'fehlender Zielordner: weiterhin abgewiesen');
    ok(treeHash(join(E, name)) === eHash, 'Sicherung auch durch das Zurückspielen ins leere Ziel nicht verändert');
  }

  rmSync(box, { recursive: true, force: true });
  console.log(`\nMANUELLE-SICHERUNG: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); try { rmSync(box, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
