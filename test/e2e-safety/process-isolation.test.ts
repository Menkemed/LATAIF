// ════════════════════════════════════════════════════════════════════════════
// E2E-PROZESS-ISOLATION — die dauerhafte Test-Invariante und ihr gezielter Beweis.
// Run: node test/e2e-safety/process-isolation.test.ts
//
// Die Regel: Ein E2E-Harness beendet NIE pauschal `lataif.exe` oder alle Prozesse dieses Namens.
// Er beendet ausschließlich, was er selbst gestartet hat — erkannt an der gespeicherten PID
// und/oder am exakten Pfad des Test-Programms. Die installierte Produktions-App und ihre Prozesse,
// `E:\LATAIF\Data`, die Ports 3001/3443 und alle übrigen Produktionsressourcen werden weder beendet
// noch verändert noch benutzt.
//
//   §1 GATE (statisch, jede Datei unter test/e2e/): kein Beende-Aufruf außerhalb des Helfers, kein
//      Image-Name, kein Produktionspfad, kein Produktionsport, keine Schreib-API auf Produktions-AppData.
//   §2 HARNESS (echte Prozesse): ein Köder gleichen Namens an einem ANDEREN Pfad überlebt jede
//      Aufräumroutine; der Prozess am Test-Pfad wird beendet; eine PID, die nicht (mehr) zum
//      Test-Pfad gehört, wird nicht angefasst; fremde `lataif.exe` (die Produktion) bleiben stehen.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const E2E = join(repo, 'test', 'e2e');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kommentare raus (Zeilen- und Blockkommentare), Zeichenketten bleiben — für die Code-Prüfungen. */
function ohneKommentare(s: string): string {
  let out = ''; let i = 0; let q: string | null = null;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c; i++;
  }
  return out;
}
/** Nur die Zeichenketten eines Quelltexts. */
function nurZeichenketten(code: string): string[] {
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
}
/** Der Quelltext ohne Zeichenketten und ohne Kommentare — für Zahlen-Literale. */
function ohneZeichenketten(code: string): string {
  return code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

const HELPER = '_e2e-process.mjs';
const PREFLIGHT = '_e2e-preflight.mjs';
const CONTROL = 'production-isolation-control.mjs';
const dateien = readdirSync(E2E).filter((f) => f.endsWith('.mjs')).sort();

// ══ §1 GATE ════════════════════════════════════════════════════════════════
{
  ok(dateien.length >= 50 && dateien.includes(HELPER), `GATE die E2E-Dateien sind gefunden, der Helfer ist dabei (${dateien.length})`);
  const helper = readFileSync(join(E2E, HELPER), 'utf8');
  const hc = ohneKommentare(helper);
  ok((hc.match(/'taskkill'/g) ?? []).length === 1 && /execFileSync\('taskkill', \['\/F', '\/T', '\/PID', String\(pid\)\]/.test(hc),
    'GATE der Helfer ruft taskkill genau EINMAL und nur mit /PID');
  ok(!/\/IM\b|IMAGENAME|Stop-Process|process\.kill\(/.test(hc), 'GATE der Helfer beendet nie nach Image-Namen');
  ok(!/killTestBrowserByProfile|CommandLine/.test(hc), 'GATE der Helfer beendet nie nach Befehlszeile (auch keinen Browser)');
  {
    const own = hc.slice(hc.indexOf('export function killOwnChild'), hc.indexOf('export function spawnTracked'));
    ok(/isAbsolute\(from\)/.test(own) && own.indexOf('pathOfPid(child.pid)') > 0 && own.indexOf('pathOfPid(child.pid)') < own.indexOf('taskkillPid(child.pid)')
      && /norm\(live\) !== norm\(from\)/.test(own), 'GATE killOwnChild prüft Identität (absoluter Startpfad == laufender Pfad) VOR dem Beenden — nie eine bloße PID');
    const pid = hc.slice(hc.indexOf('export function killTestPid'), hc.indexOf('export function killOwnChild'));
    ok(pid.indexOf('pathOfPid(pid)') > 0 && pid.indexOf('pathOfPid(pid)') < pid.indexOf('taskkillPid(pid)'), 'GATE killTestPid prüft den exakten Test-Pfad VOR dem Beenden');
    const img = hc.slice(hc.indexOf('export function killTestImage'), hc.indexOf('export function killTestPid'));
    ok(/testProcesses\(image, binaries\)/.test(img), 'GATE Reste früherer Läufe nur am exakten Test-Pfad (testProcesses)');
  }
  ok(/TEST_BINARIES = Object\.freeze\(\{\s*'lataif\.exe': join\(REPO, 'src-tauri', 'target', 'debug', 'lataif\.exe'\),\s*'lataif-e2e-client\.exe': join\(REPO, 'src-tauri', 'target', 'debug', 'lataif-e2e-client\.exe'\),\s*\}\)/.test(hc),
    'GATE die einzigen beendbaren Programme sind die zwei Test-Pfade unter target/debug');

  const verstoesse: string[] = [];
  const prodDateien: string[] = [];
  for (const f of dateien) {
    if (f === HELPER) continue;
    const roh = readFileSync(join(E2E, f), 'utf8');
    const code = ohneKommentare(roh);
    const nackt = ohneZeichenketten(code);
    const strs = nurZeichenketten(code);
    // (a) kein Beende-Aufruf außerhalb des Helfers
    if (/['"`]taskkill['"`]|\btaskkill\b/.test(code)) verstoesse.push(`${f}: taskkill`);
    if (/Stop-Process|IMAGENAME|['"]\/IM['"]|\bpskill\b|wmic[^'"]*delete|process\.kill\(|\.kill\(\s*['"]SIG/.test(code)) verstoesse.push(`${f}: Beende-Aufruf nach Name/Signal`);
    if (/killTestBrowserByProfile|\.kill\(/.test(code)) verstoesse.push(`${f}: Beenden ohne Identitätsprüfung (Befehlszeile oder child.kill)`);
    // (b) kein Produktions-Datenort
    if (/E:[\\/]{1,2}LATAIF/i.test(roh.replace(/\/\/.*$/gm, ''))) verstoesse.push(`${f}: E:\\LATAIF`);
    // (c) keine Produktionsports — außer der Wächter-Konstante des Preflights
    const zahlen = (nackt.match(/\b(3001|3443)\b/g) ?? []).length;
    const erlaubt = f === PREFLIGHT ? (nackt.match(/export const PROD_PORT = 3001;/g) ?? []).length : 0;
    if (zahlen > erlaubt) verstoesse.push(`${f}: Port 3001/3443 als Wert`);
    if (strs.some((s) => /:(3001|3443)\b|LocalPort (3001|3443)|PORT[=: ]+(3001|3443)/.test(s)) && f !== CONTROL) verstoesse.push(`${f}: Port 3001/3443 in einer Adresse`);
    // (d) Produktions-AppData nur lesend
    const prodIdent = /['"`]com\.lataif\.app['"`]/;
    if (prodIdent.test(code)) {
      prodDateien.push(f);
      const namen = [...code.matchAll(/const\s+(\w+)\s*=\s*[^;\n]*(?:com\.lataif\.app['"`]|\bPROD_\w+)/g)].map((m) => m[1]);
      const alle = [...new Set([...namen, 'PROD_IDENT'])];
      for (const n of alle) {
        const w = new RegExp(`\\b(rmSync|unlinkSync|writeFileSync|appendFileSync|copyFileSync|renameSync|mkdirSync|rmdirSync|cpSync|truncateSync|preseedInstallation)\\([^)]*\\b${n}\\b`);
        if (w.test(code)) verstoesse.push(`${f}: Schreib-API auf ${n}`);
        const d = new RegExp(`new DatabaseSync\\(\\s*${n}\\b(?![^)]*readOnly)`);
        if (d.test(code)) verstoesse.push(`${f}: Datenbank ${n} schreibbar geöffnet`);
        const e = new RegExp(`APPDATA\\s*:\\s*[^,}]*\\b${n}\\b`);
        if (e.test(code)) verstoesse.push(`${f}: Umgebung zeigt auf ${n}`);
      }
    }
    // (e) wer die Test-App startet, räumt über den Helfer auf
    if (/spawn(?:Tracked)?\(\s*(APP|CLIENT_APP)\b/.test(code) && !/from '\.\/_e2e-process\.mjs'/.test(code)) verstoesse.push(`${f}: startet die App ohne den Prozess-Helfer`);
  }
  ok(verstoesse.length === 0, `GATE keine Datei unter test/e2e verletzt die Isolation (${verstoesse.join(' · ') || 'keine'})`);
  ok(prodDateien.every((f) => f !== HELPER), `GATE Produktions-AppData taucht nur lesend auf (${prodDateien.length} Dateien geprüft)`);

  // Die Kontrolle mit laufender Produktion darf lesen — und beendet nichts.
  const control = ohneKommentare(readFileSync(join(E2E, CONTROL), 'utf8'));
  ok(!/taskkill|Stop-Process|killTest|killOwn|process\.kill/.test(control), 'GATE die Produktions-Kontrolle beendet keinen Prozess');

  // Die Selbstprobe des Gates: ein bewusst verbotener Text wird erkannt.
  const probe = ohneKommentare("execFileSync('taskkill', ['/F', '/IM', 'lataif.exe', '/T']);");
  ok(/\btaskkill\b/.test(probe) && /['"]\/IM['"]/.test(probe), 'GATE die Selbstprobe: ein pauschales taskkill /IM würde erkannt');
  ok(!/\btaskkill\b/.test(ohneKommentare('// taskkill /IM lataif.exe in einem Kommentar ist kein Aufruf\nconst x = 1;')), 'GATE die Selbstprobe: ein Kommentar ist kein Aufruf');
  ok((ohneZeichenketten(ohneKommentare("const PORT = 3001;")).match(/\b3001\b/g) ?? []).length === 1, 'GATE die Selbstprobe: PORT = 3001 würde erkannt');
}

// ══ §2 HARNESS — echte Prozesse, ein Köder gleichen Namens ═══════════════════
if (process.platform !== 'win32') {
  ok(false, 'HARNESS läuft nur unter Windows — hier gibt es keinen Beweis');
} else {
  const helper = await import(pathToFileURL(join(E2E, HELPER)).href);
  const tmp = join(os.tmpdir(), 'lataif-e2e-isolation-' + process.pid + '-' + Date.now());
  const testDir = join(tmp, 'test'), decoyDir = join(tmp, 'decoy');
  mkdirSync(testDir, { recursive: true }); mkdirSync(decoyDir, { recursive: true });
  const TEST_EXE = join(testDir, 'lataif.exe');
  const DECOY_EXE = join(decoyDir, 'lataif.exe');
  copyFileSync(process.execPath, TEST_EXE);
  copyFileSync(process.execPath, DECOY_EXE);
  const BIN = Object.freeze({ 'lataif.exe': TEST_EXE });
  const warte = ['-e', 'setInterval(() => {}, 1e9)'];
  const kinder: Array<ReturnType<typeof spawn>> = [];
  const starte = (exe: string) => { const c = spawn(exe, warte, { stdio: 'ignore', windowsHide: true }); kinder.push(c); return c; };

  // Die Welt vor dem Test: was sonst `lataif.exe` heißt (eine laufende Produktion), nur gelesen.
  const fremdVorher = helper.processesByImage('lataif.exe')
    .filter((p: { path: string | null }) => !p.path || !p.path.toLowerCase().startsWith(tmp.toLowerCase()))
    .map((p: { pid: number }) => p.pid).sort();

  try {
    const decoy = starte(DECOY_EXE);
    const test = starte(TEST_EXE);
    await sleep(800);
    ok(helper.pidAlive(decoy.pid) && helper.pidAlive(test.pid), 'HARNESS Köder und Test-Prozess laufen, beide heißen lataif.exe');
    const t = helper.testProcesses('lataif.exe', BIN).map((p: { pid: number }) => p.pid);
    ok(t.length === 1 && t[0] === test.pid, `HARNESS als Test-Prozess gilt nur der exakte Pfad (${JSON.stringify(t)})`);
    ok(helper.foreignProcesses('lataif.exe', BIN).some((p: { pid: number }) => p.pid === decoy.pid), 'HARNESS der Köder gilt als fremd');

    // Eine gespeicherte PID, die nicht zum Test-Pfad gehört, wird nicht angefasst.
    ok(helper.killTestPid(decoy.pid, undefined, BIN) === false, 'HARNESS killTestPid weist die PID des Köders ab');
    ok(helper.killTestPid(decoy.pid, DECOY_EXE, BIN) === false, 'HARNESS …auch wenn der Aufrufer dessen Pfad als „erwartet" nennt');
    await sleep(300);
    ok(helper.pidAlive(decoy.pid), 'HARNESS der Köder lebt nach killTestPid');

    // Aufräumen nach Image-Namen gibt es nicht — nur nach exaktem Test-Pfad.
    const weg = helper.killTestImage('lataif.exe', BIN);
    ok(weg.length === 1 && weg[0] === test.pid, `HARNESS killTestImage beendet genau den Test-Prozess (${JSON.stringify(weg)})`);
    ok(await helper.waitPidGone(test.pid, 10000), 'HARNESS der Test-Prozess ist weg');
    ok(helper.pidAlive(decoy.pid), 'HARNESS der Köder gleichen Namens an einem anderen Pfad ÜBERLEBT die Aufräumroutine');
    ok(!helper.isTestImageRunning('lataif.exe', BIN) && helper.tasklistTestImage('lataif.exe', BIN) === '', 'HARNESS die Warteschleifen sehen nur den Test-Pfad');
    ok(await helper.waitTestImageGone('lataif.exe', BIN, 3000), 'HARNESS waitTestImageGone wartet nicht auf den Köder');

    // Kein fremdes Programm lässt sich als Test-Programm ausgeben.
    let t1 = false; try { helper.killTestImage('notepad.exe', BIN); } catch { t1 = true; }
    ok(t1, 'HARNESS ein Name, der kein Test-Programm ist, wird abgewiesen');
    let t2 = false; try { helper.spawnTracked(DECOY_EXE, warte, { stdio: 'ignore' }, BIN); } catch { t2 = true; }
    ok(t2, 'HARNESS spawnTracked startet nichts außer einem Test-Programm');

    // Selbst gestartet und gemerkt: killStarted beendet genau diese PID (pfadgeprüft).
    const tracked = helper.spawnTracked(TEST_EXE, warte, { stdio: 'ignore', windowsHide: true }, BIN);
    kinder.push(tracked);
    await sleep(800);
    ok(helper.startedPids().includes(tracked.pid), 'HARNESS die gestartete PID ist gemerkt');
    const beendet = helper.killStarted(BIN);
    ok(beendet.length === 1 && beendet[0] === tracked.pid, `HARNESS killStarted beendet die gemerkte PID (${JSON.stringify(beendet)})`);
    ok(await helper.waitPidGone(tracked.pid, 10000) && helper.pidAlive(decoy.pid), 'HARNESS …und nur sie — der Köder lebt');

    // Eine gemerkte PID, die inzwischen weg ist (oder einem anderen gehören könnte), wird nicht beendet.
    const kurz = helper.spawnTracked(TEST_EXE, warte, { stdio: 'ignore', windowsHide: true }, BIN);
    kinder.push(kurz);
    await sleep(600);
    helper.killOwnChild(kurz);
    await helper.waitPidGone(kurz.pid, 10000);
    ok(helper.killStarted(BIN).length === 0, 'HARNESS eine gemerkte, aber verschwundene PID wird nicht mehr angefasst');

    // Der Browser-Aufräumer verlangt die eigene Profilkennung.
    let t3 = false; try { helper.killTestBrowserByProfile('msedge.exe', 'headless'); } catch { t3 = true; }
    ok(t3, 'HARNESS ein Browser-Aufräumen ohne eigene Profilkennung (nur „headless") wird abgewiesen');

    // Die Standard-Liste zeigt ausschließlich auf die zwei Test-Pfade des Repos.
    const std = Object.entries(helper.TEST_BINARIES as Record<string, string>);
    ok(std.length === 2 && std.every(([k, p]) => p.toLowerCase() === join(repo, 'src-tauri', 'target', 'debug', k).toLowerCase()),
      'HARNESS TEST_BINARIES = target/debug/lataif.exe + lataif-e2e-client.exe, sonst nichts');
  } finally {
    for (const c of kinder) { try { helper.killOwnChild(c); } catch { /* weg */ } }
    await sleep(600);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* der Start räumt auf */ }
  }

  // Die Welt danach: jede fremde `lataif.exe` von vorher lebt noch (die Produktion bleibt stehen).
  const fremdNachher = helper.processesByImage('lataif.exe').map((p: { pid: number }) => p.pid);
  ok(fremdVorher.every((pid: number) => fremdNachher.includes(pid)),
    `HARNESS jede fremde lataif.exe von vorher läuft noch (${fremdVorher.length} geprüft${fremdVorher.length ? ': ' + fremdVorher.join(',') : ''})`);
  ok(!existsSync(tmp), 'HARNESS die Köder- und Test-Kopien sind aufgeräumt');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — e2e process isolation: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('E2E_PROCESS_ISOLATION_INVARIANT_PROVED');
