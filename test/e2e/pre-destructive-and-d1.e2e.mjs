// v0.8.46 LIVE — die zwei Verträge dieses Release, durch die ECHTE Desktop-UI.
//
//   1. D1: der Überzahlungs-Backfill unter `/ledger-backfill`. Rechnung 100 BD, historische
//      Zahlung 120 BD → höchstens 100 gegen ACCOUNTS_RECEIVABLE, 20 als Kundenguthaben. Zweiter
//      Lauf über denselben Button ändert nichts.
//   2. Pre-destructive: der Factory Reset in der Danger Zone. Erst der ECHTE Backup-I/O-Fehler
//      (der Backup-Root ist eine Datei statt eines Ordners) — der Reset muss blockiert bleiben und
//      die Datenbank vollständig erhalten. Dann der Happy Path: `pre_destructive_*` entsteht, die
//      Kopien liegen am Ziel, ihre Prüfsummen stimmen gegen die tatsächlichen Bytes auf der Platte,
//      und ERST danach ist die Datenbank zurückgesetzt.
//
// Der enge Verification-Mismatch (Schreiben gelingt, Kopie ist trotzdem falsch) lässt sich auf
// einem echten Dateisystem nicht ehrlich erzwingen — der bleibt dem Injektionstest
// `test/d3/pre-destructive-destination-verify.test.ts` überlassen.
//
// Isoliert: e2e-Identität `com.lataif.app.e2e`, eigenes AppData, eigener Sync-Port 3011. Die
// Produktionsinstallation wird nie geöffnet — weder lesend noch schreibend.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { e2ePreflight } from './_e2e-preflight.mjs';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223;
const PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const FE_PW = 'admin';

const RUN = join(os.tmpdir(), 'lataif-predestr-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const BACKUPS = join(APP_DATA_DIR, 'backups');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const close = (a, b) => Math.abs(a - b) < 0.005;

function bizRows(sql, params = []) {
  let db; try { db = new DatabaseSync(BIZ_DB); return db.prepare(sql).all(...params); } catch { return []; } finally { try { db?.close(); } catch {} }
}
function bizExec(fn) { const db = new DatabaseSync(BIZ_DB); try { return fn(db); } finally { db.close(); } }
const bizNum = (sql, p = []) => { const r = bizRows(sql, p); return r.length ? Number(Object.values(r[0])[0]) : -1; };

// ── app process ──
let appProc;
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: isoEnv() });
  appProc = spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  const end = Date.now() + 90000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* not up */ }
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  return page.webSocketDebuggerUrl;
}
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch { /* gone */ } }
function killAllApp() {
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch { /* none */ }
}
async function waitPortFree(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true; await sleep(500);
  }
  return false;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  closeWs() { try { this.ws.close(); } catch { /* closed */ } }
}
const S = (v) => JSON.stringify(v);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickText = (c, label) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(label)}); const e=b[b.length-1]; if(!e) return 'NO'; if(e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }
async function waitInvoke(c) { const end = Date.now() + 90000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
const goto = (c, path) => c.ev(`history.pushState({},'',${S(path)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);

async function frontendLogin(c) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) break;
    if (await exists(c, 'nav a, a[href="/settings"], [data-testid]')) return;
    await sleep(300);
  }
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 20000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co'); await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin'); await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await setVal(c, 'input[placeholder="Choose a password"]', FE_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10'); await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL); await setVal(c, 'input[type="password"]', FE_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`);
  }
  await waitFor(c, 'nav a, a[href="/settings"], [data-testid]', 60000);
}

// ── Fixture: EINE Rechnung über 100 BD mit EINER historischen Zahlung über 120 BD ──
const INV = 'e2e-inv-1', PAY = 'e2e-pay-1', CUST = 'e2e-cust-1';
function seedOverpaidInvoice() {
  const now = new Date().toISOString();
  bizExec((db) => {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const user = db.prepare('SELECT id FROM users LIMIT 1').get();
    if (!branch || !user) throw new Error('fixture: the app did not seed a branch/user');
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, created_at, updated_at)
                VALUES (?, ?, 'Over', 'Payer', ?, ?)`).run(CUST, branch.id, now, now);
    db.prepare(`INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, currency,
                  net_amount, vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot,
                  paid_amount, issued_at, created_at, updated_at, created_by)
                VALUES (?, ?, 'E2E-0001', ?, 'FINAL', 'BHD', 100, 0, 0, 100, 'ZERO', 120, ?, ?, ?, ?)`)
      .run(INV, branch.id, CUST, now, now, now, user.id);
    // Die historische Zahlung: 120 BD auf eine Rechnung über 100 BD, noch ohne Ledger-Buchung.
    db.prepare(`INSERT INTO payments (id, branch_id, invoice_id, amount, method, received_at, created_at, created_by)
                VALUES (?, ?, ?, 120, 'cash', ?, ?, ?)`).run(PAY, branch.id, INV, now, now, user.id);
  });
}

const legs = () => bizRows(`SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'PAYMENT' AND source_id = ?`, [PAY]);
const legSum = (account, direction) => legs().filter((l) => l.account === account && l.direction === direction).reduce((s, l) => s + Number(l.amount), 0);
const credits = () => bizRows(`SELECT amount, status FROM customer_credits WHERE source_type = 'overpayment' AND source_id = ?`, [PAY]);

/** Den Backfill über den echten Button unter /ledger-backfill auslösen. */
async function runBackfillViaUi(c) {
  await goto(c, '/ledger-backfill');
  await sleep(1500);
  const r = await clickText(c, 'Invoice-Payments');
  await sleep(4000); // der Save ist entprellt — dem Schreiber Zeit lassen, bevor der Prozess faellt
  return r;
}

/** Settings → Danger Zone öffnen und den Factory-Reset-Dialog bis zum scharfen Button führen. */
async function armFactoryReset(c) {
  // D3b sperrt den Reset, solange Sync/LAN konfiguriert ist. Die e2e-Instanz startet als
  // provisionierter Primary — ohne dieses Abschalten prüfte der Test nur die Sperre und nie den
  // Backup-Pfad dahinter.
  await turnSyncOff(c);
  await goto(c, '/settings');
  await sleep(1500);
  await c.ev(`const b=[...document.querySelectorAll('button,div,span')].find(x=>x.textContent.trim()==='Danger Zone'); if(b) b.click(); return 1;`);
  await sleep(1200);
  const opened = await clickText(c, 'Factory Reset');
  await waitFor(c, 'input[placeholder="Type RESET"]', 20000);
  await setVal(c, 'input[placeholder="Type RESET"]', 'RESET');
  await sleep(400);
  return opened;
}

// Was der D3b-Guard sieht: `isFactoryResetBlocked` liest Sync/LAN ausschliesslich aus localStorage.
// Solange dort etwas steht, ist der Factory Reset per Vertrag GESPERRT — dann waere ein "die DB ist
// noch da"-Check wertlos, weil gar nichts versucht wurde. Deshalb wird der Zustand hier gelesen,
// bewusst abgeschaltet und der Dialogtext danach unterschieden.
const guardState = (c) => c.ev(
  "return { lan: localStorage.getItem('lataif_lan_mode'), url: localStorage.getItem('lataif_sync_url'), token: localStorage.getItem('lataif_sync_token') };"
);
const turnSyncOff = (c) => c.ev(
  "localStorage.removeItem('lataif_lan_mode'); localStorage.removeItem('lataif_sync_url'); localStorage.removeItem('lataif_sync_token'); return 1;"
);
const bodyText = (c) => c.ev('return document.body.innerText;');

const backupDirs = () => (existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((n) => n.startsWith('pre_destructive_')) : []);
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  await waitPortFree(PORT);
  for (const p of [APP_DATA_DIR, WV2_DIR, RUN]) { try { rmSync(p, { recursive: true, force: true }); } catch { /* fresh */ } }
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server DB seeded as an owner-provisioned Primary');

  // ── boot 1: die App legt ihre Business-DB an, danach die Fixture pflanzen ──
  let ws = await startApp(); let c = new CDP(ws);
  await waitInvoke(c); await frontendLogin(c); await sleep(2500);
  c.closeWs(); killApp(); await sleep(1500);
  ok(existsSync(BIZ_DB), 'the app created its business database');

  seedOverpaidInvoice();
  ok(bizNum('SELECT COUNT(*) n FROM payments WHERE id = ?', [PAY]) === 1, 'fixture: one historical payment of 120 BD on a 100 BD invoice');
  ok(legs().length === 0, 'fixture: that payment has no ledger entries yet');

  // ════════════════════════════════════════════════════════════════════════
  // D1 — der Backfill über den echten Button
  // ════════════════════════════════════════════════════════════════════════
  ws = await startApp(); c = new CDP(ws);
  await waitInvoke(c); await frontendLogin(c); await sleep(2000);
  ok(await runBackfillViaUi(c) === 'OK', 'D1 the Invoice-Payments backfill button is reachable and clicks');
  c.closeWs(); killApp(); await sleep(1500);

  const arAfter = legSum('ACCOUNTS_RECEIVABLE', 'CREDIT');
  const ccAfter = legSum('CUSTOMER_CREDIT', 'CREDIT');
  const legCount = legs().length;
  const credAfter = credits();
  ok(close(arAfter, 100), `D1 exactly 100 BD is credited against receivables (${arAfter})`);
  ok(arAfter <= 100.005, 'D1 receivables are never credited beyond what was open — no negative AR');
  ok(close(ccAfter, 20), `D1 the 20 BD excess is booked to CUSTOMER_CREDIT (${ccAfter})`);
  ok(credAfter.length === 1, `D1 exactly one customer_credits row for this payment (${credAfter.length})`);
  ok(credAfter.length === 1 && close(Number(credAfter[0].amount), 20), 'D1 …carrying exactly 20 BD');
  ok(credAfter.length === 1 && credAfter[0].status === 'OPEN', 'D1 …and it is redeemable (OPEN)');
  const debits = legs().filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + Number(l.amount), 0);
  ok(close(debits, arAfter + ccAfter), `D1 the entry balances: debits ${debits} = credits ${arAfter + ccAfter}`);

  // ── zweiter Lauf über denselben Weg: nichts darf sich verdoppeln ──
  ws = await startApp(); c = new CDP(ws);
  await waitInvoke(c); await frontendLogin(c); await sleep(2000);
  ok(await runBackfillViaUi(c) === 'OK', 'D1 the backfill runs a second time through the same button');
  c.closeWs(); killApp(); await sleep(1500);

  ok(legs().length === legCount, `D1 idempotent: no additional ledger entry (${legs().length} vs ${legCount})`);
  ok(close(legSum('ACCOUNTS_RECEIVABLE', 'CREDIT'), 100), 'D1 idempotent: receivables unchanged at 100 BD');
  ok(credits().length === 1, `D1 idempotent: still exactly one customer credit (${credits().length})`);
  ok(credits().length === 1 && close(Number(credits()[0].amount), 20), 'D1 idempotent: still exactly 20 BD');

  // ════════════════════════════════════════════════════════════════════════
  // Pre-destructive — ECHTER Backup-I/O-Fehler blockiert den Reset
  // ════════════════════════════════════════════════════════════════════════
  const productsBefore = bizNum('SELECT COUNT(*) n FROM invoices');
  try { rmSync(BACKUPS, { recursive: true, force: true }); } catch { /* none yet */ }
  // Eine DATEI dort, wo der Backup-Root ein Ordner sein muss → mkdir scheitert real.
  writeFileSync(BACKUPS, 'not a directory');
  ok(existsSync(BACKUPS) && !readdirSync(APP_DATA_DIR).includes('backups/'), 'the backups root is now a file — every mkdir there must fail');

  ws = await startApp(); c = new CDP(ws);
  await waitInvoke(c); await frontendLogin(c); await sleep(2000);
  await armFactoryReset(c);
  const g1 = await guardState(c);
  ok(!g1.lan && !g1.url && !g1.token, `BACKUP FAILURE: sync/LAN is off, so the reset is NOT merely blocked (${JSON.stringify(g1)})`);
  const beforeClick = await bodyText(c);
  ok(!/blockiert/i.test(beforeClick), 'BACKUP FAILURE: the dialog does not show the D3b block banner');
  ok(await clickText(c, 'Factory Reset') === 'OK', 'BACKUP FAILURE: the armed Factory Reset button clicks');
  await sleep(6000);
  const after = await bodyText(c);
  // Das ist der Beweis, dass wirklich VERSUCHT wurde: die Meldung stammt aus dem catch von
  // handleReset und kann nur entstehen, nachdem das Backup geworfen hat.
  ok(/Reset abgebrochen/i.test(after), `BACKUP FAILURE: the dialog reports the abort ("${(after.match(/Reset abgebrochen[^\n]*/) || [''])[0].slice(0, 110)}")`);
  ok(!/blockiert/i.test(after), 'BACKUP FAILURE: …as an abort, not as the sync/LAN block');
  c.closeWs(); killApp(); await sleep(1500);

  ok(existsSync(BIZ_DB), 'BACKUP FAILURE: the database file still exists');
  ok(bizNum('SELECT COUNT(*) n FROM invoices') === productsBefore, 'BACKUP FAILURE: the invoice is untouched');
  ok(legs().length === legCount, 'BACKUP FAILURE: the ledger is untouched');
  ok(credits().length === 1, 'BACKUP FAILURE: the customer credit is untouched');
  ok(bizNum('SELECT COUNT(*) n FROM payments WHERE id = ?', [PAY]) === 1, 'BACKUP FAILURE: the payment is untouched');

  // ════════════════════════════════════════════════════════════════════════
  // Pre-destructive — Happy Path: Backup verifiziert, ERST danach Reset
  // ════════════════════════════════════════════════════════════════════════
  rmSync(BACKUPS, { force: true });                       // die blockierende Datei weg
  ok(!existsSync(BACKUPS), 'the blocking file is removed — the backup root can be created again');
  const dbBytesBefore = readFileSync(BIZ_DB).length;

  ws = await startApp(); c = new CDP(ws);
  await waitInvoke(c); await frontendLogin(c); await sleep(2000);
  await armFactoryReset(c);
  const g2 = await guardState(c);
  ok(!g2.lan && !g2.url && !g2.token, 'HAPPY: sync/LAN is off — the D3b block is not what we are measuring');
  ok(await clickText(c, 'Factory Reset') === 'OK', 'HAPPY: the armed Factory Reset button clicks');
  await sleep(9000);   // Backup schreiben + verifizieren + Reset + reload
  c.closeWs(); killApp(); await sleep(2000);

  const dirs = backupDirs();
  ok(dirs.length === 1, `HAPPY: exactly one pre_destructive_* folder was created (${dirs.length})`);
  if (dirs.length === 1) {
    const dir = join(BACKUPS, dirs[0]);
    const manifestPath = join(dir, 'manifest.json');
    ok(existsSync(manifestPath), 'HAPPY: the manifest is there');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    ok(manifest.action === 'factory-reset', `HAPPY: the manifest names the action (${manifest.action})`);
    ok(Array.isArray(manifest.files) && manifest.files.length >= 1, `HAPPY: the manifest lists the copied files (${manifest.files?.length})`);
    const names = (manifest.files ?? []).map((f) => f.name);
    ok(names.includes('lataif.db'), 'HAPPY: the business database is among them');

    let hashOk = 0, sizeOk = 0;
    for (const f of manifest.files ?? []) {
      const p = join(dir, f.name);
      if (!existsSync(p)) continue;
      if (readFileSync(p).length === f.size) sizeOk++;
      if (sha256File(p) === f.sha256) hashOk++;
    }
    ok(sizeOk === (manifest.files ?? []).length, `HAPPY: every copy has the recorded size (${sizeOk}/${manifest.files?.length})`);
    ok(hashOk === (manifest.files ?? []).length, `HAPPY: every copy hashes to the recorded checksum ON DISK (${hashOk}/${manifest.files?.length})`);

    // Der Beweis, dass gesichert wurde, BEVOR gelöscht wurde: die Kopie trägt noch die Daten.
    const copied = join(dir, 'lataif.db');
    let inBackup = -1;
    try { const bdb = new DatabaseSync(copied); inBackup = Number(Object.values(bdb.prepare('SELECT COUNT(*) n FROM invoices').get())[0]); bdb.close(); } catch { /* unreadable */ }
    ok(inBackup === productsBefore, `HAPPY: the backup copy still contains the invoice (${inBackup})`);
    ok(readFileSync(copied).length === dbBytesBefore, 'HAPPY: …and is byte-for-byte the size of the live database before the reset');
  }

  // …und erst danach ist die Datenbank wirklich zurückgesetzt.
  const liveInvoices = bizNum('SELECT COUNT(*) n FROM invoices');
  ok(liveInvoices <= 0, `HAPPY: the live database no longer holds the invoice (${liveInvoices})`);
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\nv0.8.46 pre-destructive + D1 LIVE: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
