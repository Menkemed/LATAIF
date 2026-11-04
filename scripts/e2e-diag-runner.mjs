// ════════════════════════════════════════════════════════════════════════════
// E2E-DIAGNOSE-RUNNER — eine Reihe E2E-Läufe nacheinander, mit Nachweisen statt Vermutungen.
//
// Je Lauf: voller Windows-Exit-Code (hex, nicht die 8-Bit-Kürzung von bash/timeout) und Signal, Node-Diagnosebericht bei
// fatalem Fehler/Signal, Dauer, Plattenplatz und NUR LESEND die Reste davor/danach (Test-Edge unter Temp\lataif-*, Testports,
// Test-Apps unter target\debug).
//
// Schutz der Produktion: jede lataif.exe AUSSERHALB von target\debug wird vor und nach jedem Lauf nur gelesen. Ist eine
// verschwunden, bricht die Reihe sofort ab (04.11.2026: die Produktions-App verschwand während eines Laufs).
//
// Absturz des Testtreibers: Exit 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN / Fast-Fail) ist ein harter Abbruch von node.exe
// selbst — ohne Ausgabe, ohne Node-Bericht, ohne Windows-Ereignis. Bisher 3 von ~95 Läufen (Node v24.15.0), immer beim
// Anbinden an die gerade startende App (CDP), die Wiederholung jedes Mal grün. Ursache ungeklärt (ausgeschlossen: ERP-Code im
// Prozess, CET/Shadow-Stack, fetch gegen flatternden Port). Der Runner kennzeichnet ihn als TREIBER_ABSTURZ und räumt die
// zurückgebliebenen Test-Apps (exakter Test-Pfad) ab. Freigabekriterien: docs/ai/acceptance-rules.md.
//
// Aufruf (im Prüfbaum): node scripts/e2e-diag-runner.mjs <ausgabe-ordner> <test1.e2e.mjs> [test2 ...]
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const [OUT, ...TESTS] = process.argv.slice(2);
if (!OUT || TESTS.length === 0) { console.error('Aufruf: node scripts/e2e-diag-runner.mjs <ausgabe-ordner> <test1.e2e.mjs> [...]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const SUM = join(OUT, 'summary.txt');
const TREIBER_ABSTURZ = 0xC0000409;
const helper = await import(pathToFileURL(join(process.cwd(), 'test', 'e2e', '_e2e-process.mjs')).href);
const ps = (cmd) => { try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim(); } catch (e) { return 'ERR ' + String(e.message).slice(0, 80); } };
const reste = () => ps(`$e=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*\\Temp\\lataif-*' }).Count; $p=@(Get-NetTCPConnection -State Listen -LocalPort 9223,9224,3011 -ErrorAction SilentlyContinue).Count; $a=@(Get-CimInstance Win32_Process -Filter "Name='lataif.exe' OR Name='lataif-e2e-client.exe'" | Where-Object { $_.ExecutablePath -like '*\\target\\debug\\*' }).Count; "edge=$e ports=$p testapps=$a"`);
const frei = () => ps(`'{0:N1}GB' -f ((Get-PSDrive C).Free / 1GB)`);
const log = (s) => { appendFileSync(SUM, s + '\n'); console.log(s); };
const fremde = () => ps(`@(Get-CimInstance Win32_Process -Filter "Name='lataif.exe'" | Where-Object { $_.ExecutablePath -notlike '*\\target\\debug\\*' } | ForEach-Object { $_.ProcessId }) -join ','`);
const testAppsAbraeumen = () => { try { helper.killTestImage('lataif.exe'); helper.killTestImage('lataif-e2e-client.exe'); } catch { /* weg */ } };

log(`START fremde lataif.exe: [${fremde()}]`);
let i = 0, rot = 0, treiber = 0;
for (const t of TESTS) {
  const vorFremd = fremde();
  i++;
  const name = `${String(i).padStart(2, '0')}-${basename(t, '.mjs')}`;
  const reportDir = join(OUT, name + '-report');
  mkdirSync(reportDir, { recursive: true });
  const logFile = join(OUT, name + '.log');
  const fd = openSync(logFile, 'w');
  const vor = reste();
  const t0 = Date.now();
  const r = await new Promise((res) => {
    const c = spawn(process.execPath, [
      '--report-on-fatalerror', '--report-on-signal', '--report-uncaught-exception', `--report-directory=${reportDir}`, t,
    ], { stdio: ['ignore', fd, fd], windowsHide: true });
    // Zeitgrenze: den EIGENEN Kindprozess beenden und warten, bis er weg ist — nie den nächsten Lauf daneben starten.
    const zeit = setTimeout(() => { try { c.kill(); } catch { /* weg */ } c.once('exit', () => res({ code: 'TIMEOUT', signal: null, pid: c.pid })); }, 50 * 60 * 1000);
    c.on('exit', (code, signal) => { clearTimeout(zeit); res({ code, signal, pid: c.pid }); });
    c.on('error', (e) => { clearTimeout(zeit); res({ code: 'SPAWN_ERROR ' + e.message, signal: null, pid: c.pid }); });
  });
  closeSync(fd);
  const nummer = typeof r.code === 'number' ? (r.code >>> 0) : null;
  const absturz = nummer === TREIBER_ABSTURZ;
  // Nach Zeitgrenze oder Treiberabsturz bleiben (abgekoppelt gestartete) Test-Apps stehen: nur über den Helfer (exakter Pfad).
  if (r.code === 'TIMEOUT' || absturz) testAppsAbraeumen();
  await new Promise((x) => setTimeout(x, 3000));
  const berichte = readdirSync(reportDir).length;
  const hex = nummer !== null ? '0x' + nummer.toString(16).toUpperCase() : '';
  let art = r.code === 0 ? 'GRUEN' : 'ROT';
  if (absturz) {
    // Ein Treiberabsturz zählt nur als solcher, wenn der Lauf bis dahin keinen eigenen Fehlschlag gemeldet hat.
    const text = readFileSync(logFile, 'utf8');
    art = /^\s+(x|✗) /m.test(text) ? 'ROT+TREIBER_ABSTURZ' : 'TREIBER_ABSTURZ';
    treiber++;
  } else if (r.code !== 0) rot++;
  log(`${name} ${art} code=${r.code} ${hex} signal=${r.signal} pid=${r.pid} ${Math.round((Date.now() - t0) / 1000)}s berichte=${berichte} | vorher ${vor} | nachher ${reste()} | C: ${frei()}`);
  const nachFremd = fremde();
  const weg = vorFremd.split(',').filter(Boolean).filter((p) => !nachFremd.split(',').includes(p));
  if (weg.length) { log(`ABBRUCH: fremde lataif.exe verschwunden während ${name}: ${weg.join(',')}`); break; }
}
log(`DIAG_DONE gruen=${TESTS.length - rot - treiber} rot=${rot} treiber_absturz=${treiber}`);
