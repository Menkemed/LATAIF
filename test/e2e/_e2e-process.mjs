// ════════════════════════════════════════════════════════════════════════════
// E2E-PROZESS-ISOLATION — die EINE Stelle, an der ein Test einen Prozess beenden darf.
//
// Die Regel (dauerhaft, R6C): Ein Test beendet ausschließlich Prozesse, die er selbst gestartet
// hat — erkannt an der gespeicherten PID und/oder am EXAKTEN Pfad des Test-Programms. Nie nach
// Image-Namen: `taskkill /IM lataif.exe` träfe die installierte Produktions-App, mit der parallel
// gearbeitet wird. Die Produktions-App, ihre Prozesse, `E:\LATAIF\Data`, die Ports 3001/3443 und
// alle übrigen Produktionsressourcen werden von hier aus weder beendet noch verändert noch benutzt.
//
// Drei Wege, und jeder prüft vor dem Beenden, WESSEN Prozess es ist:
//
//   • `killTestImage(name)`  — Aufräumen nach exaktem Test-Pfad (auch Reste früherer Läufe).
//                              Ein Prozess gleichen Namens an einem anderen Pfad bleibt stehen.
//                              Ein Prozess, dessen Pfad nicht lesbar ist, gilt als FREMD.
//   • `killTestPid(pid)`     — eine gespeicherte PID, aber nur, wenn sie JETZT noch zum exakten
//                              Test-Pfad gehört (eine wiederverwendete PID ist nicht mehr unsere).
//   • `killOwnChild(child)`  — ein Kindprozess, den dieser Test selbst gestartet hat (z. B. ein
//                              Headless-Browser): seine PID stammt aus unserem eigenen `spawn`.
//
// `taskkill` steht NUR in dieser Datei. Das Gate `test/e2e-safety/process-isolation.test.ts`
// weist jeden anderen Beende-Aufruf in `test/e2e/` ab.
// ════════════════════════════════════════════════════════════════════════════
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Die einzigen Programme, die ein E2E-Test beenden darf — mit ihrem exakten Pfad. */
export const TEST_BINARIES = Object.freeze({
  'lataif.exe': join(REPO, 'src-tauri', 'target', 'debug', 'lataif.exe'),
  'lataif-e2e-client.exe': join(REPO, 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe'),
});

const norm = (p) => resolve(String(p)).toLowerCase();
const IMAGE = /^[A-Za-z0-9_.-]+\.exe$/;

/** Die PIDs, die dieser Prozess über `spawnTracked` gestartet hat — mit ihrem Programmpfad. */
const started = new Map();

function exactPathFor(image, binaries) {
  if (!IMAGE.test(String(image))) throw new Error(`[e2e-process] not an image name: ${image}`);
  const exact = binaries[image];
  if (!exact) throw new Error(`[e2e-process] ${image} is not a test binary — refusing to touch it`);
  return exact;
}

function ps(command) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Alle Prozesse dieses Image-Namens mit ihrem Programmpfad (leer, wenn nicht lesbar). Nur lesend. */
export function processesByImage(image) {
  if (!IMAGE.test(String(image))) throw new Error(`[e2e-process] not an image name: ${image}`);
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='${image}'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('|');
    return { pid: Number(l.slice(0, i)), path: l.slice(i + 1) || null };
  }).filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

/** Der Programmpfad genau einer PID — `null`, wenn es sie nicht gibt oder der Pfad nicht lesbar ist. */
export function pathOfPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const out = ps(`Get-CimInstance Win32_Process -Filter "ProcessId=${n}" | ForEach-Object { "$($_.ExecutablePath)" }`).trim();
  return out || null;
}

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  return ps(`Get-CimInstance Win32_Process -Filter "ProcessId=${n}" | ForEach-Object { $_.ProcessId }`).trim() === String(n);
}

function taskkillPid(pid) {
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* schon weg */ }
}

/** Die Test-Prozesse dieses Namens: exakt am Test-Pfad, sonst keiner. */
export function testProcesses(image, binaries = TEST_BINARIES) {
  const exact = norm(exactPathFor(image, binaries));
  return processesByImage(image).filter((p) => p.path && norm(p.path) === exact);
}

/** Alles andere mit demselben Namen — zum Beweis, dass es stehen bleibt. Nur lesend. */
export function foreignProcesses(image, binaries = TEST_BINARIES) {
  const exact = norm(exactPathFor(image, binaries));
  return processesByImage(image).filter((p) => !p.path || norm(p.path) !== exact);
}

/**
 * Beendet ausschließlich Prozesse am EXAKTEN Test-Pfad dieses Namens. Wirft nie; gibt die
 * beendeten PIDs zurück. Ein Name, der kein Test-Programm ist, wird abgewiesen (wirft).
 */
export function killTestImage(image, binaries = TEST_BINARIES) {
  const victims = testProcesses(image, binaries);
  for (const v of victims) taskkillPid(v.pid);
  for (const v of victims) started.delete(v.pid);
  return victims.map((v) => v.pid);
}

/**
 * Eine gespeicherte PID beenden — aber nur, wenn sie JETZT zu einem Test-Programm gehört.
 * `expectedPath` engt auf genau ein Test-Programm ein; ohne ihn genügt irgendeins der Liste.
 */
export function killTestPid(pid, expectedPath, binaries = TEST_BINARIES) {
  const live = pathOfPid(pid);
  if (!live) return false;
  const allowed = expectedPath ? [norm(expectedPath)] : Object.values(binaries).map(norm);
  if (!allowed.includes(norm(live))) return false;
  if (expectedPath && !Object.values(binaries).map(norm).includes(norm(expectedPath))) return false;
  taskkillPid(pid);
  started.delete(Number(pid));
  return true;
}

/** Ein Kindprozess DIESES Tests (eigenes `spawn`) — seine PID ist unsere. */
export function killOwnChild(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (child.exitCode !== null && child.exitCode !== undefined) return false;
  taskkillPid(child.pid);
  return true;
}

/** Startet ein Test-Programm und merkt sich PID und exakten Pfad. Andere Programme: Nein. */
export function spawnTracked(exe, args = [], opts = {}, binaries = TEST_BINARIES) {
  const allowed = Object.values(binaries).map(norm);
  if (!allowed.includes(norm(exe))) throw new Error(`[e2e-process] ${exe} is not a test binary — refusing to start it`);
  const child = spawn(exe, args, opts);
  if (Number.isInteger(child.pid)) started.set(child.pid, norm(exe));
  return child;
}

/** Beendet alle selbst gestarteten Test-Programme — jede PID nur, wenn ihr Pfad noch stimmt. */
export function killStarted(binaries = TEST_BINARIES) {
  const done = [];
  for (const [pid, path] of [...started.entries()]) {
    if (killTestPid(pid, path, binaries)) done.push(pid);
    started.delete(pid);
  }
  return done;
}

export function startedPids() {
  return [...started.keys()];
}

/** Für alte `tasklist`-Schleifen: der Name, wenn ein Test-Prozess dieses Namens läuft, sonst ''. */
export function tasklistTestImage(image, binaries = TEST_BINARIES) {
  return testProcesses(image, binaries).length > 0 ? String(image) : '';
}

export function isTestImageRunning(image, binaries = TEST_BINARIES) {
  return testProcesses(image, binaries).length > 0;
}

/** Wartet, bis kein Prozess am exakten Test-Pfad dieses Namens mehr läuft. */
export async function waitTestImageGone(image, binaries = TEST_BINARIES, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!isTestImageRunning(image, binaries)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !isTestImageRunning(image, binaries);
}

/** Wartet, bis diese PID weg ist. */
export async function waitPidGone(pid, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !pidAlive(pid);
}

/**
 * Headless-Browser eines Tests aufräumen: nur Prozesse, deren Befehlszeile die EIGENE
 * Profilkennung dieses Tests trägt (`lataif-…-e2e`). Ein bloßes „headless" oder ein Port reicht
 * nicht — das könnte ein fremder Browser sein.
 */
export function killTestBrowserByProfile(image, profileMarker) {
  if (!IMAGE.test(String(image))) throw new Error(`[e2e-process] not an image name: ${image}`);
  if (!/^lataif-[a-z0-9-]*e2e[a-z0-9-]*$/i.test(String(profileMarker))) {
    throw new Error(`[e2e-process] refusing a browser cleanup without the test's own profile marker (${profileMarker})`);
  }
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='${image}'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`);
  const victims = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('|');
    return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) };
  }).filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.cmd.includes(profileMarker));
  for (const v of victims) taskkillPid(v.pid);
  return victims.map((v) => v.pid);
}
