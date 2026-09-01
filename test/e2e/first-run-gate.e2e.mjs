// DATA-ROOT-B1a — die Erstlauf-Weiche, durch die echte Oberflaeche.
//
// Diese Suite ist die einzige, die KEINE vorbereitete Installation bekommt: sie startet mit einem
// wirklich leeren Kontrollverzeichnis, denn genau das ist ihr Thema. Bewiesen wird, was ein leerer
// Start tun darf und was nicht:
//
//   A  vor der Entscheidung entsteht NICHTS — kein Marker, kein Locator, keine Datenbank, keine
//      Server-DB, keine Kennung — und die Weiche ist sichtbar.
//   B  Schliessen und neu starten fuehrt wieder zur Weiche, immer noch ohne eine einzige Datei.
//   C  ein bewusster Klick auf "Set up new installation" legt genau eine Wurzel mit genau einer
//      Kennung an, startet neu, und der naechste Start ist eine gewoehnliche Installation.
//   D  drei Klicks in einem Tick legen trotzdem nur eine Wurzel an.
//
// Isolierte e2e-Kennung + AppData + Sync-Port (3011); die Produktion (3001) wird nie angefasst.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;

const RUN = join(os.tmpdir(), 'lataif-first-run-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

/** Alles, was im Kontrollverzeichnis liegt — die Antwort auf "wurde etwas angelegt?". */
const controlEntries = () => (existsSync(APP_DATA_DIR) ? readdirSync(APP_DATA_DIR).sort() : []);
const locator = () => {
  const p = join(APP_DATA_DIR, 'data-location.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
async function attach(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  // Was der Bildschirm sagt, ist der Beweis dafuer, was er TUT. Ohne die Weiche laeuft der ganze
  // Start durch — Datenbank im Speicher, Migrationen, Automatisierung, ein fehlschlagender Save —
  // und genau diese Spuren duerfen waehrend der Frage nicht auftauchen.
  c.logs = [];
  c.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      c.logs.push((m.params.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' '));
    }
  });
  await c.send('Runtime.enable');
  return c;
}
/** Spuren eines Datenbank-Starts im Protokoll der Seite. */
const dbTraces = (c) => c.logs.filter((l) => /\[Migration\]|\[Automation\] Handlers registered|\[DB\] save failed|\[DB\] Tauri file load/i.test(l));
let appProc;
/** Die App starten — OHNE vorbereitete Installation, das ist hier der Punkt. */
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv(), firstRun: true });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  return attach();
}
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
async function waitProcessGone(ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' }).Count"], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(400);
  }
  return false;
}
async function waitPortFree(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(500);
  }
  return false;
}

const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickSel = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const bodyText = (c) => c.ev('return (document.body.textContent || "").slice(0, 400);');
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor ' + sel);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('DATA-ROOT first run — an empty machine asks before it decides');
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
rmSync(APP_DATA_DIR, { recursive: true, force: true });
rmSync(WV2_DIR, { recursive: true, force: true });
mkdirSync(join(RUN, 'tmp'), { recursive: true });
ok(controlEntries().length === 0, 'the machine really starts empty');

// ── A) Vor der Entscheidung ─────────────────────────────────────────────────
let c = await startApp();
await waitFor(c, '[data-first-run-gate]', 60000);
ok(true, 'A the app comes up and shows the first-run gate');
ok(await exists(c, '[data-first-run-new]'), 'A …with "Set up new installation"');
ok(await exists(c, '[data-first-run-recover]'), 'A …and "Recover existing data location"');
{
  const t = await bodyText(c);
  ok(/nothing has been created/i.test(t), 'A …and it says that nothing was created');
  const entries = controlEntries();
  ok(!entries.includes('data-location.json'), `A no locator was written (${entries.join(',') || 'empty'})`);
  ok(!entries.includes('.lataif-data-root.json'), 'A no root marker');
  ok(!entries.includes('lataif.db'), 'A no business database');
  ok(!entries.includes('lataif_sync_server.db'), 'A no server database');
  ok(locator() === null, 'A …so there is no rootId either');
  // Und der Bildschirm hat auch nicht ANGEFANGEN, eine Datenbank aufzubauen: keine Migrationen,
  // keine Automatisierung, kein fehlgeschlagener Save. Ohne den Guard steht genau das im Protokoll.
  await sleep(2500);
  const traces = dbTraces(c);
  ok(traces.length === 0, `A the renderer never started a database while asking (${traces.slice(0, 2).join(' | ')})`);
}
// Der Wiederherstellungsweg darf geoeffnet werden und darf dabei nichts anfangen.
await clickSel(c, '[data-first-run-recover]');
await sleep(600);
ok(await exists(c, '[data-first-run-recover-panel]'), 'A the recovery path opens…');
ok(controlEntries().length === 0, 'A …and still nothing was created');
await clickSel(c, '[data-first-run-back]');
await sleep(400);
ok(await exists(c, '[data-first-run-new]'), 'A back leads to the gate again');

// ── B) Schliessen und neu starten ───────────────────────────────────────────
c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
ok(controlEntries().length === 0, 'B closing the app leaves the machine exactly as it was');
c = await startApp();
await waitFor(c, '[data-first-run-gate]', 60000);
ok(true, 'B the next start asks again');
ok(controlEntries().length === 0, 'B …and still nothing exists');

// ── D) Drei Klicks in einem Tick (vor C, damit C den ruhigen Fall zeigt) ────
await c.ev("const b=document.querySelector('[data-first-run-new]'); b.click(); b.click(); b.click(); return 1;");
await sleep(4000);
{
  const loc = locator();
  ok(loc !== null, 'D three clicks in one tick set up an installation');
  ok(typeof loc?.rootId === 'string' && loc.rootId.length > 0, `D …with exactly one rootId (${loc?.rootId})`);
  const roots = controlEntries().filter((f) => f === '.lataif-data-root.json');
  ok(roots.length === 1, 'D …and exactly one root marker');
  const marker = JSON.parse(readFileSync(join(APP_DATA_DIR, '.lataif-data-root.json'), 'utf8'));
  ok(marker.rootId === loc.rootId, 'D marker and locator name the same installation');
  ok(marker.bootstrapPending === false, 'D …and the bootstrap is complete, not half done');
}

// ── C) Der naechste Start ist eine gewoehnliche Installation ────────────────
const rootIdBefore = locator().rootId;
try { c.close(); } catch {}
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
c = await startApp();
{
  // Kein Weichen-Bildschirm mehr, und die App laeuft normal an (Onboarding oder Login).
  const end = Date.now() + 60000;
  let gate = true, shell = false;
  while (Date.now() < end) {
    gate = await exists(c, '[data-first-run-gate]');
    shell = await c.ev('return (document.body.textContent || "").length > 40;');
    if (!gate && shell) break;
    await sleep(400);
  }
  ok(!gate, 'C the second start does not ask again');
  ok(shell, 'C …the normal app comes up');
  ok(locator().rootId === rootIdBefore, 'C …on the same installation, with the same rootId');
  ok(existsSync(join(APP_DATA_DIR, 'lataif_sync_server.db')), 'C …and now the server database exists');
}

c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — first run gate e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('DATA_ROOT_FIRST_RUN_GATE_E2E_PROVED');
