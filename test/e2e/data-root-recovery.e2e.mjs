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
/** Eine echte fremde Aenderung im Log des Servers — nur schreiben, waehrend die App STEHT. */
function serverChange(id) {
  const db = new DatabaseSync(join(DATA_ROOT, 'lataif_sync_server.db'));
  try {
    const row = db.prepare('SELECT tenant_id, branch_id FROM sync_changelog ORDER BY id DESC LIMIT 1').get();
    const tenant = row?.tenant_id ?? 'tenant-1';
    const branch = row?.branch_id ?? 'branch-main';
    db.prepare(`INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      tenant, branch, 'customers', id, 'insert',
      JSON.stringify({ id, branch_id: branch, first_name: 'Recovered', last_name: 'Customer', created_at: 'x', updated_at: 'x' }),
      'self-desktop', new Date().toISOString(),
    );
  } finally { try { db.close(); } catch {} }
  return id;
}
/** Eine beliebige fremde Zeile im Log des Servers — nur schreiben, waehrend die App STEHT. */
function serverRow(table, recordId, action, payload) {
  const db = new DatabaseSync(join(DATA_ROOT, 'lataif_sync_server.db'));
  try {
    const row = db.prepare('SELECT tenant_id, branch_id FROM sync_changelog ORDER BY id DESC LIMIT 1').get();
    const tenant = row?.tenant_id ?? 'tenant-1';
    const branch = row?.branch_id ?? 'branch-main';
    db.prepare(`INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      tenant, branch, table, recordId, action,
      JSON.stringify(typeof payload === 'function' ? payload(branch) : payload),
      'self-desktop', new Date().toISOString(),
    );
  } finally { try { db.close(); } catch {} }
  return recordId;
}
const serverHead = () => Number(dbQ(join(DATA_ROOT, "lataif_sync_server.db"), "SELECT COALESCE(MAX(id),0) m FROM sync_changelog")[0]?.m ?? 0);
const cursorOnDisk = () => dbQ(join(DATA_ROOT, "lataif.db"), "SELECT server_fingerprint, last_sync_id FROM sync_cursor");
/** Ein sauberes Ende: erst das kontrollierte Schliessen, dann der Prozess. */
async function stopApp(x) {
  try { await x.ev('window.close(); return 1;'); } catch {}
  await sleep(2500);
  try { x.close(); } catch {}
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
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

let before = {
  cursor: 0,
  fingerprint: "",
  rootId: rootIdBefore,
  products: bizCount('products'),
  settings: bizCount('settings'),
  installId: readFileSync(join(DATA_ROOT, 'sync_install_id.key'), 'utf8').trim(),
  serverDb: existsSync(join(DATA_ROOT, 'lataif_sync_server.db')),
};
ok(before.products >= 0 && before.settings > 0, `the business database really lives out there (products=${before.products}, settings=${before.settings})`);
ok(before.serverDb && before.installId.length === 36, 'and so do the server database and the installation identity');
ok(existsSync(join(APP_DATA_DIR, 'data-location.json')), 'the locator is on C:, pointing at it');

// Einen echten Wasserstand herstellen: Rolle setzen, Server starten, Sync auf den eigenen Server
// richten, den Erstkontakt abwarten und dann EINE echte Aenderung anwenden lassen.
{
  c = await startApp();
  await ensureSignedIn(c);
  const role = await invokeErr(c, 'primary_configure', { mode: 'primary', email: OWNER_EMAIL, password: OWNER_PW });
  ok(role === 'NO-ERROR', `this machine becomes the primary (${role})`);
  const started = await invokeErr(c, 'sync_server_start', {});
  ok(started === 'NO-ERROR', `and runs its server (${started})`);
  const st = await invoke(c, 'sync_server_status', {});
  await c.ev(`localStorage.setItem('lataif_sync_url', ${S(`http://127.0.0.1:${PORT}`)}); localStorage.setItem('lataif_sync_token', ${S(st.selfToken)}); return 1;`);
  await c.ev('location.reload(); return 1;');
  await sleep(2500);
  c.close(); c = await attach(); await ensureSignedIn(c);
  {
    const end = Date.now() + 90000;
    while (Date.now() < end) { if (cursorOnDisk().length > 0) break; await sleep(1500); }
  }
  ok(cursorOnDisk().length === 1, "the first contact recorded a durable progress");
  await stopApp(c);

  // Jetzt eine ECHTE, WIEDEREINSPIEL-EMPFINDLICHE Historie — genau die Form des Vorfalls: eine
  // Position wird belegt, wieder freigegeben und von einer ANDEREN Zeile erneut belegt. In der
  // richtigen Reihenfolge einmal angewandt ergibt das genau eine Zeile. Wird dieselbe Historie
  // spaeter von vorne wiederholt, laeuft der erste Schritt in `UNIQUE(repair_id, position)` —
  // der Batch faellt zurueck, der Stand bleibt stehen, und ab da stirbt jeder Pull an derselben
  // Stelle. Das ist der Fehler, den A1 verhindert.
  const R = 'rep-' + Date.now();
  const NOW_S = new Date().toISOString();
  const line = (id, extra) => (branch) => ({
    id, branch_id: branch, repair_id: R, position: 1, cost_amount: 0,
    status: 'OPEN', created_at: NOW_S, updated_at: NOW_S, ...extra,
  });
  const CUST = 'cust-' + R;
  serverRow('customers', CUST, 'insert', (branch) => ({
    id: CUST, branch_id: branch, first_name: 'Repair', last_name: 'Owner', created_at: NOW_S, updated_at: NOW_S,
  }));
  serverRow('repairs', R, 'insert', (branch) => ({
    id: R, branch_id: branch, repair_number: 'RPR-' + R, status: 'RECEIVED',
    customer_id: CUST, issue_description: 'replay-sensitive fixture', received_at: NOW_S,
    created_at: NOW_S, updated_at: NOW_S,
  }));
  serverRow('repair_lines', R + '-A', 'insert', line(R + '-A', { description: 'first holder' }));
  serverRow('repair_lines', R + '-A', 'delete', {});
  serverRow('repair_lines', R + '-B', 'insert', line(R + '-B', { description: 'took the freed position' }));
  const head = serverHead();
  c = await startApp();
  await ensureSignedIn(c);
  {
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      if (Number(cursorOnDisk()[0]?.last_sync_id ?? 0) >= head) break;
      await sleep(1500);
    }
  }
  await stopApp(c);
  const held = dbQ(join(DATA_ROOT, "lataif.db"), "SELECT id FROM repair_lines WHERE repair_id = ?", [R]);
  ok(held.length === 1 && held[0].id === R + '-B',
    `the replay-sensitive history applied in order leaves exactly one line, the later one (${held.map((h) => h.id).join(',')})`);
  before.repair = R;
}

// Der Stand VOR dem Verlust, von der Platte gelesen.
const cur0 = cursorOnDisk();
before.cursor = Number(cur0[0]?.last_sync_id ?? 0);
before.fingerprint = String(cur0[0]?.server_fingerprint ?? "");
ok(before.cursor > 0 && before.fingerprint.length === 32,
  `a real progress N=${before.cursor} for server ${before.fingerprint.slice(0, 8)}… is on disk before the loss`);

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

// ── 7) Der Anschluss an A1: mit echten Zahlen ───────────────────────────────
{
  // Das WebView2-Profil war mit C: weg, der localStorage ist also leer. Der Wasserstand liegt in
  // der uebernommenen Datenbank — und genau von dort muss weitergemacht werden.
  await sleep(4000);
  const cur = cursorOnDisk();
  ok(cur.length === 1, `exactly one recorded progress — one server, one cursor (${cur.length})`);
  const N = Number(cur[0]?.last_sync_id ?? -1);
  ok(N === before.cursor, `the progress is unchanged by the adoption (${N} vs ${before.cursor})`);
  ok(String(cur[0]?.server_fingerprint) === before.fingerprint, "and it still belongs to the same server");
  ok(!(await c.ev("return !!localStorage.getItem('lataif_sync_last_id');")),
    "the fresh browser holds no authoritative cursor of its own");

  // Jetzt bekommt der Pull echte Arbeit: EINE Aenderung hinter N.
  await stopApp(c);
  const newId = serverChange('after-adopt-' + Date.now());
  const head = serverHead();
  ok(head === N + 1, `the server has exactly one change beyond the progress (${N} → ${head})`);
  c = await startApp();
  await ensureSignedIn(c);
  {
    const end2 = Date.now() + 120000;
    while (Date.now() < end2) {
      if (Number(cursorOnDisk()[0]?.last_sync_id ?? 0) >= head) break;
      await sleep(1500);
    }
  }
  await stopApp(c);
  const applied = Number(dbQ(join(DATA_ROOT, "lataif.db"), "SELECT COUNT(*) c FROM customers WHERE id = ?", [newId])[0]?.c ?? 0);
  ok(applied === 1, `the one change beyond N was applied exactly once (${applied})`);
  const after = cursorOnDisk();
  ok(after.length === 1 && Number(after[0].last_sync_id) === head,
    `and the progress moved forward to it, on disk (${N} → ${after[0]?.last_sync_id})`);
  ok(Number(after[0].last_sync_id) > N, "never backwards");

  // Und der Weg dorthin war der normale: kein Wiedereinspielen, keine Rekonstruktion, kein Raten.
  const replay = c.logs.filter((l) => /recovery required|were pushed by this database itself/i.test(l));
  ok(replay.length === 0, `no replay, no reconstruction (${replay.slice(0, 1).join("")})`);
  const behind = c.logs.filter((l) => /sync-server-log-behind/i.test(l));
  ok(behind.length === 0, "and the server is not behind the adopted database");
  // Die Zeilen von vor dem Verlust wurden NICHT erneut angewendet: sonst gaebe es sie doppelt.
  const dupes = dbQ(join(DATA_ROOT, "lataif.db"), "SELECT id, COUNT(*) n FROM customers GROUP BY id HAVING n > 1");
  ok(dupes.length === 0, `no customer was created twice (${dupes.length})`);
  // Und die wiedereinspiel-empfindliche Historie von vor dem Verlust blieb, wie sie war: haette
  // der Pull sie noch einmal von vorne angeboten, waere der erste Schritt in den eindeutigen
  // Index gelaufen — der Batch zurueck, der Stand stehen, die neue Aenderung nie angewandt.
  const lines = dbQ(join(DATA_ROOT, "lataif.db"), "SELECT id FROM repair_lines WHERE repair_id = ?", [before.repair]);
  ok(lines.length === 1 && lines[0].id === before.repair + '-B',
    `the pre-loss history was not replayed — its one line still stands (${lines.map((l) => l.id).join(',')})`);
  const stall = c.logs.filter((l) => /apply failed at change/i.test(l));
  ok(stall.length === 0, `and no batch died on the unique index (${stall.slice(0, 1).join("")})`);
}
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — data root recovery e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('DATA_ROOT_C_LOSS_RECOVERY_E2E_PROVED');
