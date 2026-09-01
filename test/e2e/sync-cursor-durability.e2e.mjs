// SYNC-SAFETY-A1-F1 — der Pull-Wasserstand muss auf der Platte landen, nicht nur im Speicher.
//
// Die Geschaeftsdatenbank lebt waehrend des Betriebs vollstaendig im Arbeitsspeicher und wird als
// Ganzes zurueckgeschrieben. Ein Stand, den ein Lauf zwar in die Datenbank schreibt, aber nie
// speichert, ist beim naechsten Start wieder weg — und "kein Stand" bedeutet etwas anderes als
// "bewiesener Stand": beim naechsten Start koennte der Server inzwischen Historie haben, und dann
// entscheidet genau diese Zeile ueber Weitermachen statt Nachfragen.
//
// Geprueft wird deshalb an der DATEI, jedes Mal nachdem die App vollstaendig beendet wurde:
//
//   A  Erstkontakt mit leerem Log → Stand 0 steht auf der Platte.
//   B  Eine echte Aenderung dahinter → Wirkung UND Stand stehen gemeinsam auf der Platte.
//   C  Neustart → die Aenderung wird nicht noch einmal angewendet.
//
// Isolierte e2e-Kennung + AppData + Sync-Port (3011); die Produktion (3001) wird nie angefasst.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'e2e-owner-password-2026';

const RUN = join(os.tmpdir(), 'lataif-cursor-durability-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SRV_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

/** IMMER von der Datei lesen — der Punkt dieser Suite. */
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const cursorOnDisk = () => dbQ(BIZ_DB, 'SELECT server_fingerprint, last_sync_id FROM sync_cursor');
const serverHead = () => Number(dbQ(SRV_DB, 'SELECT COALESCE(MAX(id),0) m FROM sync_changelog')[0]?.m ?? 0);
const customerCount = (id) => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM customers WHERE id = ?', [id])[0]?.c ?? -1);

/** Eine echte fremde Aenderung im Log des Servers — nur waehrend die App STEHT. */
function serverChange(id) {
  const db = new DatabaseSync(SRV_DB);
  try {
    const row = db.prepare('SELECT tenant_id, branch_id FROM sync_changelog ORDER BY id DESC LIMIT 1').get();
    const tenant = row?.tenant_id ?? 'tenant-1';
    const branch = row?.branch_id ?? 'branch-main';
    db.prepare(`INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(
      tenant, branch, 'customers', id, 'insert',
      JSON.stringify({ id, branch_id: branch, first_name: 'Durable', last_name: 'Proof', created_at: 'x', updated_at: 'x' }),
      'self-desktop', new Date().toISOString(),
    );
  } finally { try { db.close(); } catch {} }
  return id;
}

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
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
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
/** Ein sauberes Ende: erst das kontrollierte Schliessen der App, dann der Prozess. */
async function stopApp(c) {
  try { await c.ev('window.close(); return 1;'); } catch {}
  await sleep(2500);
  try { c.close(); } catch {}
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
}

const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
const invoke = (c, cmd, args) => c.ev(`return await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)});`);
const invokeErr = (c, cmd, args) => c.ev(`try { await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return 'NO-ERROR'; } catch (e) { return String(e && e.message ? e.message : e); }`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor ' + sel);
}
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
/** Diesen Rechner zum Primary machen und den Sync auf den eigenen Server richten. */
async function configureSync(c) {
  const role = await invokeErr(c, 'primary_configure', { mode: 'primary', email: OWNER_EMAIL, password: OWNER_PW });
  if (role !== 'NO-ERROR') throw new Error('primary_configure: ' + role);
  const started = await invokeErr(c, 'sync_server_start', {});
  if (started !== 'NO-ERROR') throw new Error('sync_server_start: ' + started);
  const st = await invoke(c, 'sync_server_status', {});
  if (!st?.selfToken) throw new Error('no self token');
  await c.ev(`localStorage.setItem('lataif_sync_url', ${S(`http://127.0.0.1:${PORT}`)}); localStorage.setItem('lataif_sync_token', ${S(st.selfToken)}); return 1;`);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('SYNC cursor durability — what the run promised must be on disk');
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
rmSync(APP_DATA_DIR, { recursive: true, force: true });
rmSync(WV2_DIR, { recursive: true, force: true });
mkdirSync(join(RUN, 'tmp'), { recursive: true });

// ── Aufbau: eine gewoehnliche Installation, deren Eigentuemer eingerichtet ist ──
let c = await startApp();
await ensureSignedIn(c);
await stopApp(c);
{
  const seeder = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
  if (!existsSync(seeder)) throw new Error('e2e_scope_seed helper missing');
  execFileSync(seeder, ['seed', SRV_DB], { encoding: 'utf8', env: { ...process.env, E2E_OWNER_PW: OWNER_PW } });
}

// ── A) Erstkontakt mit leerem Log: Stand 0 muss auf der Platte stehen ────────
c = await startApp();
await ensureSignedIn(c);
ok(serverHead() === 0, `the server log really is empty at this point (head=${serverHead()})`);
await configureSync(c);
await c.ev('location.reload(); return 1;');
await sleep(2500);
c.close();
c = await attach();
await ensureSignedIn(c);
{
  // Auf den ersten Lauf warten — beobachtet an genau dem, was hier zur Debatte steht: der
  // Wasserstand muss WAEHREND des Laufs auf der Platte erscheinen, nicht erst irgendwann.
  const end = Date.now() + 90000;
  let onDisk = 0;
  while (Date.now() < end) {
    onDisk = cursorOnDisk().length;
    if (onDisk > 0) break;
    await sleep(1500);
  }
  ok(onDisk === 1, `the first sync run put its progress on disk while running (${onDisk})`);
}
await stopApp(c);
{
  const rows = cursorOnDisk();
  ok(rows.length === 1, `after a clean stop the recorded progress is ON DISK (${rows.length} row(s))`);
  ok(Number(rows[0]?.last_sync_id) === 0, `and it is the proven zero, not a missing row (${rows[0]?.last_sync_id})`);
  ok(String(rows[0]?.server_fingerprint || '').length === 32, 'bound to the server that answered');
}
const S_FP = String(cursorOnDisk()[0]?.server_fingerprint || '');

// ── B) Eine echte Aenderung dahinter: Wirkung UND Stand gemeinsam auf Platte ─
const id1 = serverChange('durable-' + Date.now());
const head1 = serverHead();
ok(head1 > 0, `the server now has a change to deliver (head=${head1})`);
c = await startApp();
await ensureSignedIn(c);
{
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (c.logs.some((l) => /Pushed \d+, pulled [1-9]/.test(l))) break;
    await sleep(1500);
  }
}
await stopApp(c);
{
  ok(customerCount(id1) === 1, `the change was applied exactly once and is on disk (${customerCount(id1)})`);
  const rows = cursorOnDisk();
  ok(rows.length === 1 && Number(rows[0].last_sync_id) === head1,
    `and the progress moved with it, on disk (${rows[0]?.last_sync_id} vs ${head1})`);
  ok(String(rows[0].server_fingerprint) === S_FP, 'still the same server');
}

// ── C) Neustart: nichts wird ein zweites Mal angewendet ─────────────────────
c = await startApp();
await ensureSignedIn(c);
await sleep(8000);
{
  const replay = c.logs.filter((l) => /were pushed by this database itself|recovery required/i.test(l));
  ok(replay.length === 0, `the restart did not reconstruct or replay anything (${replay.slice(0, 1).join('')})`);
}
await stopApp(c);
ok(customerCount(id1) === 1, 'the change is still there exactly once — no duplicate from a second pass');
{
  const rows = cursorOnDisk();
  ok(rows.length === 1 && Number(rows[0].last_sync_id) >= head1, `and the progress never went backwards (${rows[0]?.last_sync_id})`);
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — sync cursor durability e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('SYNC_FRESH_ZERO_CURSOR_DURABLE_PROVED');
console.log('SYNC_PULL_CURSOR_DISK_DURABILITY_PROVED');
