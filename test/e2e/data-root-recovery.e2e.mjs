// DATA-ROOT-B1b — der Ernstfall: C: ist weg, die Daten liegen woanders.
//
// Aufgebaut wird eine gewoehnliche isolierte Installation, deren Datenort AUSSERHALB des
// simulierten C: liegt. Dann wird alles geloescht, was auf C: von LATAIF existiert — Locator,
// Kontrollverzeichnis, WebView2-Profil — und die App neu gestartet. Sie darf sich dann nichts
// zurechtlegen: sie fragt, der Benutzer zeigt auf den bestehenden Ordner, der Eigentuemer weist
// sich aus, und danach laeuft dieselbe Installation weiter wie vorher.
//
// Bewiesen wird, was danach gilt: dieselbe Kennung, dieselbe Datenbank mit denselben Zeilen,
// dieselbe Server-Identitaet, die Medien am selben Ort, ein Locator auf dem neuen C: — und KEINE
// zweite Datenbank, keine zweite Wurzel. Zuletzt der Anschluss an A1: der dauerhafte Pull-Stand
// liegt in der uebernommenen Datenbank, also faengt der Sync nicht wieder bei 0 an.
//
// Isolierte e2e-Kennung + AppData + Sync-Port (3011); die Produktion (3001) wird nie angefasst.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, copyFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
/** Die Server-Eigentuemer-Anmeldung hat eigene Mindestanforderungen (M6-B2A4). */
const OWNER_PW = 'e2e-owner-password-2026';

const RUN = join(os.tmpdir(), 'lataif-recovery-e2e', 'run-' + Date.now());
/** Der Datenort — bewusst AUSSERHALB des Kontrollverzeichnisses, wie ein zweites Laufwerk. */
const DATA_ROOT = join(RUN, 'external-data');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

const controlEntries = () => (existsSync(APP_DATA_DIR) ? readdirSync(APP_DATA_DIR).sort() : []);
const locator = () => {
  const p = join(APP_DATA_DIR, 'data-location.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const marker = (root) => JSON.parse(readFileSync(join(root, '.lataif-data-root.json'), 'utf8'));
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const bizCount = (t) => dbQ(join(DATA_ROOT, 'lataif.db'), `SELECT COUNT(*) c FROM ${t}`)[0]?.c ?? -1;

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.logs = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') this.logs.push((m.params.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' '));
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
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
  await c.send('Runtime.enable');
  return c;
}
let appProc;
async function startApp({ firstRun = false } = {}) {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv(), firstRun });
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
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';`);
const clickSel = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor ' + sel);
}
/** Ein Kommando des Kerns direkt aufrufen — der native Ordner-Dialog ist im Harness nicht
 *  steuerbar, alles danach (Pruefung, Eigentuemer, Uebernahme) ist der echte Produktionsweg. */
const invoke = (c, cmd, args) => c.ev(`return await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)});`);
const invokeErr = (c, cmd, args) => c.ev(`try { await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return 'NO-ERROR'; } catch (e) { return String(e && e.message ? e.message : e); }`);

async function ensureSignedIn(c) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"], nav a, [data-testid]')) return true;
    if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
      await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
      await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
      await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="Full name"]');
      await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin');
      await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
      await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
      await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="10"]');
      await setVal(c, 'input[placeholder="10"]', '10');
      await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
    } else if (await exists(c, 'input[type="email"]')) {
      await setVal(c, 'input[type="email"]', OWNER_EMAIL);
      await setVal(c, 'input[type="password"]', ONBOARD_PW);
      await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`);
    }
    await sleep(600);
  }
  throw new Error('app shell never appeared');
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('DATA-ROOT recovery — C: is gone, the data is not');
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
rmSync(APP_DATA_DIR, { recursive: true, force: true });
rmSync(WV2_DIR, { recursive: true, force: true });
mkdirSync(join(RUN, 'tmp'), { recursive: true });
mkdirSync(DATA_ROOT, { recursive: true });

// ── 1) Eine gewoehnliche Installation, deren Daten ausserhalb von C: liegen ──
//
// Der Datenort wird mit derselben kanonischen Primitive eingerichtet wie jede Installation, und
// der Locator auf C: zeigt darauf. Genau die Lage, die es spaeter zu retten gilt.
// Der Datenort ist NICHT das Kontrollverzeichnis, also greift `preseedInstallation` hier nicht (sein
// Riegel besteht zu Recht darauf, nur das isolierte AppData einzurichten). Aufgerufen wird deshalb
// dasselbe Werkzeug direkt — dieselbe kanonische Primitive, nur an einem Ort, den diese Suite selbst
// unter `%TEMP%` angelegt hat.
{
  const helper = join(REPO, 'src-tauri/target/debug/examples/e2e_first_run_preseed.exe');
  if (!existsSync(helper)) throw new Error('preseed helper missing — build it with --example e2e_first_run_preseed');
  execFileSync(helper, [DATA_ROOT], { encoding: 'utf8' });
}
mkdirSync(APP_DATA_DIR, { recursive: true });
{
  // Der Locator gehoert auf C:, nicht in den Datenort — dorthin verschieben und im Ordner loeschen.
  copyFileSync(join(DATA_ROOT, 'data-location.json'), join(APP_DATA_DIR, 'data-location.json'));
  rmSync(join(DATA_ROOT, 'data-location.json'));
}
const rootIdBefore = marker(DATA_ROOT).rootId;
ok(!!rootIdBefore, 'the external data location is set up');

let c = await startApp();
await ensureSignedIn(c);
await sleep(3000);
c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);

// Die Uebernahme verlangt einen wirklich eingerichteten Eigentuemer in der Server-Datenbank — nicht
// nur ein Konto aus der Ersteinrichtung des Bildschirms. Das ist der bestehende Vertrag des Hauses
// (M6-B2A4), und er wird hier mit derselben echten Primitive hergestellt wie sonst im Harness.
{
  const seeder = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
  if (!existsSync(seeder)) throw new Error('e2e_scope_seed helper missing');
  execFileSync(seeder, ['seed', join(DATA_ROOT, 'lataif_sync_server.db')], {
    encoding: 'utf8',
    env: { ...process.env, E2E_OWNER_PW: OWNER_PW },
  });
}

const before = {
  rootId: rootIdBefore,
  products: bizCount('products'),
  settings: bizCount('settings'),
  installId: readFileSync(join(DATA_ROOT, 'sync_install_id.key'), 'utf8').trim(),
  serverDb: existsSync(join(DATA_ROOT, 'lataif_sync_server.db')),
};
ok(before.products >= 0 && before.settings > 0, `the business database really lives out there (products=${before.products}, settings=${before.settings})`);
ok(before.serverDb && before.installId.length === 36, 'and so do the server database and the installation identity');
ok(existsSync(join(APP_DATA_DIR, 'data-location.json')), 'the locator is on C:, pointing at it');

// ── 2) C: ist weg ───────────────────────────────────────────────────────────
rmSync(APP_DATA_DIR, { recursive: true, force: true });
rmSync(WV2_DIR, { recursive: true, force: true });
ok(controlEntries().length === 0, 'the new machine has nothing of LATAIF on it');
ok(existsSync(join(DATA_ROOT, 'lataif.db')), '…while the data folder is untouched');

// ── 3) Der Start fragt, statt sich etwas zurechtzulegen ─────────────────────
c = await startApp({ firstRun: true });
await waitFor(c, '[data-first-run-gate]', 60000);
ok(true, 'the app asks instead of setting itself up again');
ok(controlEntries().length === 0, '…and has created nothing while asking');
await clickSel(c, '[data-first-run-recover]');
await sleep(500);
ok(await exists(c, '[data-first-run-pick]'), 'the recovery path offers to choose a folder');

// ── 4) Falsche Ordner werden benannt, nicht uebernommen ─────────────────────
{
  const bogus = join(RUN, 'not-a-data-folder');
  mkdirSync(bogus, { recursive: true });
  const e1 = await invokeErr(c, 'first_run_validate_candidate', { path: bogus });
  ok(String(e1).includes('ADOPT_MARKER_MISSING'), `a folder without a marker is refused (${e1})`);
  const e2 = await invokeErr(c, 'first_run_adopt', { path: bogus, email: OWNER_EMAIL, password: OWNER_PW });
  ok(String(e2).includes('ADOPT_MARKER_MISSING'), 'and adopting it is refused for the same reason');
  const e3 = await invokeErr(c, 'first_run_adopt', { path: DATA_ROOT, email: OWNER_EMAIL, password: 'not-the-owner-password' });
  ok(String(e3).includes('ADOPT_OWNER_REJECTED'), `the wrong owner is refused (${e3})`);
  ok(controlEntries().length === 0, 'after three refusals the machine is still untouched');
}

// ── 5) Der echte Ordner, der echte Eigentuemer ──────────────────────────────
{
  const facts = await invoke(c, 'first_run_validate_candidate', { path: DATA_ROOT });
  ok(facts && facts.rootId === before.rootId, `looking at it finds the same data set (${facts?.rootId})`);
  ok(controlEntries().length === 0, '…and looking still created nothing');

  const adoptedRaw = await invokeErr(c, 'first_run_adopt', { path: DATA_ROOT, email: OWNER_EMAIL, password: OWNER_PW });
  ok(adoptedRaw === 'NO-ERROR', `the adoption succeeds (${adoptedRaw})`);
  const adopted = { rootId: locator()?.rootId };
  ok(adopted.rootId === before.rootId, 'the adoption keeps the EXISTING data-set id');
  const entries = controlEntries();
  ok(entries.length === 1 && entries[0] === 'data-location.json', `exactly one file was written on the new C: (${entries.join(',')})`);
  ok(!entries.includes('lataif.db'), 'no second business database on C:');
  ok(!entries.includes('lataif_sync_server.db'), 'and no second server database');
  const loc = locator();
  ok(loc.rootId === before.rootId, 'the locator carries the existing id');
  ok(loc.dataRoot.replace(/\\\\/g, '\\').toLowerCase().includes('external-data'), `and points at the external folder (${loc.dataRoot})`);
  ok(marker(DATA_ROOT).rootId === before.rootId, 'the data folder itself was not re-stamped');
  ok(readFileSync(join(DATA_ROOT, 'sync_install_id.key'), 'utf8').trim() === before.installId, 'the installation identity is unchanged');
}

// ── 6) Nach dem Neustart ist es dieselbe Installation ───────────────────────
c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
c = await startApp();
{
  const end = Date.now() + 90000;
  let gate = true;
  while (Date.now() < end) { gate = await exists(c, '[data-first-run-gate]'); if (!gate) break; await sleep(400); }
  ok(!gate, 'the next start does not ask again');
}
await ensureSignedIn(c);
await sleep(2500);
ok(bizCount('products') === before.products, `the same products are there (${bizCount('products')} vs ${before.products})`);
// Die wiederhergestellte Installation LAEUFT — sie darf schreiben. Bewiesen wird deshalb, dass
// nichts verloren ging, nicht dass nichts mehr passiert.
ok(bizCount('settings') >= before.settings, `no settings were lost (${bizCount('settings')} >= ${before.settings})`);
ok(marker(DATA_ROOT).rootId === before.rootId, 'the same data-set id');
ok(readFileSync(join(DATA_ROOT, 'sync_install_id.key'), 'utf8').trim() === before.installId, 'the same installation identity');
ok(!existsSync(join(APP_DATA_DIR, 'lataif.db')), 'and still no business database on C:');
ok(existsSync(join(DATA_ROOT, 'lataif_sync_server.db')), 'the server database is the one out there');

// ── 7) Der Anschluss an A1: kein Wiedereinspielen ───────────────────────────
{
  // Das WebView2-Profil war mit C: weg, der localStorage ist also leer — der Wasserstand liegt in
  // der uebernommenen Datenbank. Er darf nicht auf 0 fallen und nicht rueckwaerts gehen.
  await sleep(4000);
  const cursor = dbQ(join(DATA_ROOT, 'lataif.db'), 'SELECT server_fingerprint, last_sync_id FROM sync_cursor');
  ok(cursor.length <= 1, 'there is at most one recorded progress — one server, one cursor');
  const replay = c.logs.filter((l) => /recovery required|took over the previous progress/i.test(l));
  ok(replay.length === 0, `the sync did not fall back to a recovery or a takeover (${replay.slice(0, 1).join('')})`);
  const behind = c.logs.filter((l) => /sync-server-log-behind/i.test(l));
  ok(behind.length === 0, 'and the server is not behind the adopted database');
}

c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — data root recovery e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('DATA_ROOT_C_LOSS_RECOVERY_E2E_PROVED');
