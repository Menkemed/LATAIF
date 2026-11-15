// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — überholte Galerie-Bearbeitungen (TAG-WCH-004, CAR-OGJ-001): der echte Ausführungsweg auf
// einer ISOLIERTEN Kopie der Sicherung vom 14.11.2026.
// Run: node scripts/e2e-diag-runner.mjs <out> test/e2e/superseded-edit-plans.e2e.mjs
//
//   P1 KOPIE      lataif.db + kompletter Medienordner (inkl. .ingest-journal) der Sicherung in den Testordner;
//                 Test-Passwort + ein Test-Benutzer „Sales“ NUR in der Kopie. Keine Schlüssel, kein Locator.
//   P2 SICHERUNG  scripts/maint/manuelle-sicherung.mjs bei geschlossener Test-App auf zwei Ziele (E/F-Ersatz),
//                 danach `pruefen` beider Sicherungen.
//   P3 KEIN OWNER Sales: Karte nicht da; der Mutationspfad weist ab; nichts geändert.
//   P4 OWNER      Settings → Data Repairs: Karte → Prüfen (live: DB + Rust-Journal) → Sicherungsname → App-Rückfrage
//                 → Abbruch. Zwischen Prüfen und Abbruch wird ein Job verändert → genau der wird atomar verweigert.
//                 Erneut prüfen → abbrechen → Beweis „unverändert“ + Nachkontrolle. Wiederholungsaufruf: nichts.
//   P5 PLATTE     nach dem Schließen: beide Jobs failed/MEDIA_EDIT_PLAN_SUPERSEDED, 2 Audit-Zeilen; Preise, Medien,
//                 Zuordnungen, Generationen unverändert; kein Changelog-Eintrag für Artikel/Medien.
//   P6 NEUSTART   Karte noch da (Embedding steht aus, AI im Test nicht eingerichtet), Nachkontrolle: beide Kandidaten.
//   P7 RÜCKWEG    Zurückspielen der geprüften Sicherung → Datenordner exakt die Sicherung → App startet, beide offen.
//
// PROZESS-ISOLATION: nur eigene PIDs am EXAKTEN Testpfad, Port 3011, CDP 9223, Datenordner com.lataif.app.e2e.
// Produktion (E:\LATAIF\Data, Ports 3001/3443) wird nie berührt; die Sicherung auf F: wird nur GELESEN.
// Testkopie und Testsicherungen werden am Ende gelöscht.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { maus, tippe } from './_e2e-mouse.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readFileSync, copyFileSync, cpSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const SALES_EMAIL = 'e2e-sales@lataif.test';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'sup-owner-' + Math.random().toString(36).slice(2);
const T0 = Date.now();
const schritt = (s) => console.log(`      [${Math.round((Date.now() - T0) / 1000)}s] ${s}`);
const SRC = process.env.SUP_SRC || 'F:/LATAIF-Backups/2026-11-14_vor-v0.8.103';
const RUN = join(os.tmpdir(), 'lataif-superseded', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const MEDIA = join(APP_DATA_DIR, 'media');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const SICHERUNG = join(process.cwd(), 'scripts', 'maint', 'manuelle-sicherung.mjs');
const BNAME = 'e2e-vor-galerie-wartung';
const TAG_JOB = 'job-edit:gallery-edit:tenant-1:branch-main:753561c6-6dc4-4a18-8aba-d20047610e31:stock_image:eeba8daf-baa2-4521-9e29-9940dfc24822';
const CAR_JOB = 'job-edit:gallery-edit:tenant-1:branch-main:b34529ca-7c4b-42bc-9a1e-57eb95548266:stock_image:fdbf065c-d042-4533-b2ff-e0095074345b';
const PIDS = ['753561c6-6dc4-4a18-8aba-d20047610e31', 'b34529ca-7c4b-42bc-9a1e-57eb95548266'];

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht.'); aufraeumen(); process.exit(1); }, 40 * 60 * 1000);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
function tabHash(t) { return h(S(dbQ(BIZ_DB, `SELECT * FROM ${t} ORDER BY rowid`))); }
const MEDIA_TABLES = ['media_links', 'media_objects', 'media_variants', 'media_blobs', 'media_blob_generations'];
function preise() { return dbQ(BIZ_DB, `SELECT id, sku, purchase_price, planned_sale_price, min_sale_price, notes, attributes FROM products WHERE id IN (?, ?) ORDER BY id`, PIDS); }
function jobs() { return dbQ(BIZ_DB, `SELECT job_id, state, error_code, error_detail_safe, request_hash, result_json FROM media_ingest_jobs WHERE job_id IN (?, ?) ORDER BY job_id`, [CAR_JOB, TAG_JOB]); }
function sicherungsSkript(...a) {
  try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [SICHERUNG, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }; }
  catch (e) { let out = null; try { out = JSON.parse(String(e.stdout || e.stderr)); } catch { out = { raw: String(e.stdout || e.stderr).slice(0, 300) }; } return { code: e.status ?? 1, out }; }
}
function baum(dir) {
  const hh = createHash('sha256');
  const rec = (d, rel) => { for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, n.name); if (n.isDirectory()) rec(p, rel + '/' + n.name); else { hh.update(rel + '/' + n.name); hh.update(readFileSync(p)); } } };
  rec(dir, '');
  return hh.digest('hex').slice(0, 16);
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.listeners = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method) for (const f of this.listeners) { try { f(m); } catch { /* egal */ } }
    });
  }
  async send(method, params = {}, ms = 120000) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`CDP ${method} > ${ms} ms`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}
async function attachOnly(cdpPort, budget = 60000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c;
}
async function attach(cdpPort, exe, env) { spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref(); return attachOnly(cdpPort, 120000); }
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO'; const p=HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)'; try { seen = String(await c.ev('return document.body.innerText.slice(0,400);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteAuf(pruefe, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (await pruefe()) return true; await sleep(400); } return pruefe(); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); } throw new Error('no invoke'); }
const SHELL = 'a[href="/settings"], nav';
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const bridge = (c, expr) => c.ev(`const m = window.__lataifSupersededEditPlans; if (!m) return { keineBruecke: true }; return await (${expr});`);

async function anmelden(p, email) {
  await waitFor(p, 'a[href="/settings"], input[type="password"]', 120000);
  if (await exists(p, 'input[type="password"]')) {
    await setVal(p, 'input[type="email"]', email);
    await setVal(p, 'input[type="password"]', ONBOARD_PW);
    await p.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(p, 'a[href="/settings"], [data-sidebar], main', 120000);
  await warteAuf(async () => (await p.ev('return !!window.__lataifSupersededEditPlans;')) === true, 30000);
}
async function starten(email = OWNER_EMAIL) {
  const p = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(p);
  await anmelden(p, email);
  return p;
}
async function schliessen(p) {
  await spuelen(p).catch(() => null);
  const pid = startedPids().pop();
  p.close();
  await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe');
}
async function zuDataRepairs(p) {
  await geh(p, '/dashboard'); await sleep(600);
  await geh(p, '/settings?tab=repairs'); await sleep(1200);
}
const verdict = (p, sku) => p.ev(`return document.querySelector('[data-superseded-verdict="${sku}"]')?.getAttribute('data-verdict') ?? null;`);
const text = (p, sel) => p.ev(`return document.querySelector(${S(sel)})?.textContent ?? null;`);

let primary = null;
try {
  if (!existsSync(join(SRC, 'lataif.db')) || !existsSync(join(SRC, 'media', '.ingest-journal'))) throw new Error('Sicherung nicht gefunden: ' + SRC);
  aufraeumen(); await waitTestImageGone('lataif.exe');
  for (const d of [RUN, join(RUN, 'tmp'), join(RUN, 'E'), join(RUN, 'F')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── EINRICHTEN (frische Test-Installation) ───────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'SUP Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'SUP Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'SUP Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, 'a[href="/settings"]', 60000);
  await sleep(1500);
  await schliessen(primary); primary = null;
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  // ── P1 KOPIE ────────────────────────────────────────────────────────────────
  const testHash = dbQ(BIZ_DB, 'SELECT password_hash AS h FROM users WHERE lower(email) = lower(?)', [OWNER_EMAIL])[0]?.h;
  for (const f of ['lataif.db', 'lataif.db-wal', 'lataif.db-shm']) rmSync(join(APP_DATA_DIR, f), { force: true });
  copyFileSync(join(SRC, 'lataif.db'), BIZ_DB);
  rmSync(MEDIA, { recursive: true, force: true });
  cpSync(join(SRC, 'media'), MEDIA, { recursive: true });
  {
    const db = new DatabaseSync(BIZ_DB);
    db.prepare('UPDATE users SET password_hash = ? WHERE lower(email) = lower(?)').run(testHash, OWNER_EMAIL);
    // Test-Benutzer „Sales“ als Kopie der Owner-Zeile (nur in der Kopie), Rolle SALES
    const u = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(OWNER_EMAIL);
    const nu = { ...u, id: 'user-e2e-sales', email: SALES_EMAIL, name: 'E2E Sales' };
    db.prepare(`INSERT INTO users (${Object.keys(nu).join(',')}) VALUES (${Object.keys(nu).map(() => '?').join(',')})`).run(...Object.values(nu));
    const ub = db.prepare('SELECT * FROM user_branches WHERE user_id = ?').get(u.id);
    const nub = { ...ub, user_id: 'user-e2e-sales', role: 'SALES', ...(('id' in ub) ? { id: 'ub-e2e-sales' } : {}) };
    db.prepare(`INSERT INTO user_branches (${Object.keys(nub).join(',')}) VALUES (${Object.keys(nub).map(() => '?').join(',')})`).run(...Object.values(nub));
    db.close();
  }
  ok(!existsSync(join(APP_DATA_DIR, 'openai.key')), 'P1 keine Schlüssel aus der Sicherung im Testordner (AI im Test aus)');
  ok(!existsSync(join(APP_DATA_DIR, 'data-location.json')) || readFileSync(join(APP_DATA_DIR, 'data-location.json'), 'utf8').includes(IDENT), 'P1 kein Datenort-Zeiger aus der Sicherung im Testordner');
  const vorher = { media: Object.fromEntries(MEDIA_TABLES.map((t) => [t, tabHash(t)])), preise: preise(), jobs: jobs(),
    changelogMax: Number(dbQ(BIZ_DB, 'SELECT COALESCE(MAX(rowid),0) AS n FROM sync_changelog')[0]?.n ?? 0),
    auditMedia: Number(dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM audit_log WHERE module = 'Media'`)[0]?.n ?? 0) };
  ok(vorher.jobs.length === 2 && vorher.jobs.every((j) => j.state === 'accepted'), 'P1 Kopie: beide Jobs accepted');

  // ── P2 SICHERUNG (geschlossene Test-App) ────────────────────────────────────
  const sich = sicherungsSkript('sichern', '--quelle', APP_DATA_DIR, '--ziel', join(RUN, 'E'), '--ziel', join(RUN, 'F'), '--name', BNAME, '--ruhe-sekunden', '3', '--nur-pfad', APP);
  ok(sich.code === 0 && sich.out.ok && sich.out.ziele?.length === 2, `P2 Sicherung auf E/F-Ersatz (${sich.out.dateien} Dateien, ${sich.out.medien} Medien, DBs ${S(sich.out.integritaet)})`);
  const pe = sicherungsSkript('pruefen', '--sicherung', join(RUN, 'E', BNAME)).out;
  const pf = sicherungsSkript('pruefen', '--sicherung', join(RUN, 'F', BNAME)).out;
  ok(pe.ok && pf.ok && pe.dateien === pf.dateien, `P2 beide Sicherungen geprüft, fehlerfrei (${pe.dateien} Dateien)`);
  ok(sicherungsSkript('sichern', '--quelle', APP_DATA_DIR, '--ziel', join(RUN, 'E'), '--name', BNAME, '--ruhe-sekunden', '1', '--nur-pfad', APP).code !== 0, 'P2 zweiter Lauf mit gleichem Namen: verweigert (nichts überschrieben)');
  const sicherungBaum = baum(join(RUN, 'F', BNAME, 'Data'));

  // ── P3 KEIN OWNER ───────────────────────────────────────────────────────────
  primary = await starten(SALES_EMAIL);
  await zuDataRepairs(primary);
  ok(!(await exists(primary, '[data-superseded-card]')), 'P3 Sales: keine Wartungskarte');
  const insp0 = await bridge(primary, `m.run({ mode: 'inspect' })`);
  const fp0 = Object.fromEntries((insp0?.inspected ?? []).filter((v) => v.status === 'closable').map((v) => [v.jobId, v.fingerprint]));
  ok(Object.keys(fp0).length === 2, 'P3 Prüfung (live) erkennt beide als abbrechbar');
  const rSales = await bridge(primary, `m.run(${S({ mode: 'close', fingerprints: fp0, reason: 'e2e sales', backupRef: BNAME })})`);
  ok(rSales?.refused?.code === 'SUPERSEDED_NOT_OWNER', `P3 Mutationspfad mit Sales-Sitzung: abgewiesen (${rSales?.refused?.code})`);
  ok(dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM media_ingest_jobs WHERE job_id IN (?, ?) AND state = 'accepted'`, [CAR_JOB, TAG_JOB])[0]?.n === 2, 'P3 nichts geändert');
  await bridge(primary, 'm.e2eLogout()');
  await anmelden(primary, OWNER_EMAIL);

  // ── P4 OWNER: der echte Weg über die Karte ──────────────────────────────────
  await zuDataRepairs(primary);
  await waitFor(primary, '[data-superseded-card]', 30000);
  ok(await exists(primary, '[data-superseded-row="TAG-WCH-004"]') && await exists(primary, '[data-superseded-row="CAR-OGJ-001"]'), 'P4 Karte zeigt beide Vorgänge');
  ok((await text(primary, '[data-superseded-row="TAG-WCH-004"]'))?.includes('open'), 'P4 Zustand: offen');
  ok(String(await maus(primary, '[data-superseded-close]')).startsWith('GESPERRT'), 'P4 „Close“ gesperrt ohne Prüfung/Grund/Sicherungsname');
  ok(await tippe(primary, '[data-repair-reason]', 'superseded phone gallery edits (e2e)') === 'OK', 'P4 Grund getippt');
  ok(await maus(primary, '[data-superseded-check]') === 'OK', 'P4 „Check now“ geklickt');
  await warteAuf(async () => (await verdict(primary, 'TAG-WCH-004')) && (await verdict(primary, 'CAR-OGJ-001')), 60000);
  ok(await verdict(primary, 'TAG-WCH-004') === 'closable' && await verdict(primary, 'CAR-OGJ-001') === 'closable', 'P4 Prüfung: beide abbrechbar');
  ok(String(await maus(primary, '[data-superseded-close]')).startsWith('GESPERRT'), 'P4 „Close“ noch gesperrt ohne Sicherungsnamen');
  ok(await tippe(primary, '[data-superseded-backup]', BNAME) === 'OK', 'P4 Sicherungsname getippt');
  // Veränderung NACH der Prüfung → genau dieser Job muss verweigert werden
  ok(await bridge(primary, `m.e2eTouch(${S(TAG_JOB)}, 1)`) === true, 'P4 TAG-WCH-004 nach der Prüfung verändert');
  ok(await maus(primary, '[data-superseded-close]') === 'OK', 'P4 „Close“ geklickt');
  await waitFor(primary, '[data-app-confirm]', 15000);
  const frage = await text(primary, '[data-app-confirm]');
  ok(frage?.includes('TAG-WCH-004') && frage?.includes('CAR-OGJ-001') && frage?.includes(BNAME), 'P4 App-Rückfrage nennt beide Artikel und die Sicherung');
  ok(await maus(primary, '[data-app-confirm-ok]') === 'OK', 'P4 Rückfrage bestätigt (Maus)');
  await waitFor(primary, '[data-superseded-msg]', 60000);
  const st1 = dbQ(BIZ_DB, 'SELECT 1').length >= 0 && await bridge(primary, `m.run({ mode: 'control' })`);
  const s1 = Object.fromEntries((st1?.control?.cases ?? []).map((c) => [c.sku, c.jobState]));
  ok(s1['TAG-WCH-004'] === 'accepted' && s1['CAR-OGJ-001'] === 'failed', `P4 veränderter Job atomar verweigert, der andere abgebrochen (${S(s1)})`);
  ok(/refused|differs/.test((await text(primary, '[data-superseded-msg]')) ?? ''), 'P4 Meldung: verweigert, bitte erneut prüfen');
  ok((await primary.ev(`return document.querySelector('[data-superseded-proof]')?.getAttribute('data-unchanged');`)) === 'true', 'P4 Beweis nach Lauf 1: unverändert');
  ok(await bridge(primary, `m.e2eTouch(${S(TAG_JOB)}, -1)`) === true, 'P4 Veränderung zurückgenommen');
  ok(await maus(primary, '[data-superseded-check]') === 'OK', 'P4 erneut geprüft');
  await warteAuf(async () => (await verdict(primary, 'TAG-WCH-004')) === 'closable', 60000);
  ok(await verdict(primary, 'TAG-WCH-004') === 'closable' && await verdict(primary, 'CAR-OGJ-001') === 'already_closed', 'P4 erneute Prüfung: TAG abbrechbar, CAR schon abgebrochen');
  ok(await maus(primary, '[data-superseded-close]') === 'OK', 'P4 „Close“ erneut');
  await waitFor(primary, '[data-app-confirm]', 15000);
  ok(await maus(primary, '[data-app-confirm-ok]') === 'OK', 'P4 Rückfrage bestätigt');
  await warteAuf(async () => /Done/.test((await text(primary, '[data-superseded-msg]')) ?? ''), 60000);
  ok(/Done/.test((await text(primary, '[data-superseded-msg]')) ?? ''), 'P4 Meldung: erledigt');
  ok((await primary.ev(`return document.querySelector('[data-superseded-proof]')?.getAttribute('data-unchanged');`)) === 'true', 'P4 Beweis: Artikel/Preise, Bilder, Zuordnungen, Generationen, andere Jobs, sync_changelog unverändert');
  const ctl = await primary.ev(`return [...document.querySelectorAll('[data-superseded-control-row]')].map(e=>[e.getAttribute('data-superseded-control-row'), e.getAttribute('data-candidate')]);`);
  ok(ctl?.length === 2 && ctl.every(([, c]) => c === 'true'), `P4 Nachkontrolle: beide wieder Embedding-Kandidaten (${S(ctl)})`);
  ok((await primary.ev(`return document.querySelector('[data-superseded-control]')?.getAttribute('data-migration-blocked');`)) === '', 'P4 Bildmigration nicht mehr blockiert');
  const nochmal = await bridge(primary, `m.run(${S({ mode: 'close', fingerprints: fp0, reason: 'again', backupRef: BNAME })})`);
  ok(nochmal?.closed?.every((x) => x.status === 'already_closed') && nochmal?.proof?.auditAdded === 0, 'P4 Wiederholungsaufruf: already_closed, keine Audit-Zeile');

  // ── P5 PLATTE ───────────────────────────────────────────────────────────────
  await schliessen(primary); primary = null;
  const j5 = jobs();
  ok(j5.every((j) => j.state === 'failed' && j.error_code === 'MEDIA_EDIT_PLAN_SUPERSEDED' && JSON.parse(j.error_detail_safe).backupRef === BNAME), 'P5 auf der Platte: beide failed / MEDIA_EDIT_PLAN_SUPERSEDED mit Sicherungsname');
  ok(j5.every((j, i) => j.result_json === vorher.jobs[i].result_json && j.request_hash === vorher.jobs[i].request_hash), 'P5 gespeicherte Pläne unverändert');
  const aud = dbQ(BIZ_DB, `SELECT entity_id, changed_by, new_value FROM audit_log WHERE module = 'Media' AND entity_type = 'media_ingest_jobs'`);
  ok(aud.length === vorher.auditMedia + 2 && aud.every((a) => a.changed_by === 'user-owner'), `P5 genau zwei Audit-Zeilen, vom Owner (${aud.length})`);
  ok(S(preise()) === S(vorher.preise), 'P5 Preise, Notizen, Attribute beider Artikel unverändert');
  ok(MEDIA_TABLES.every((t) => tabHash(t) === vorher.media[t]), 'P5 Medien, Zuordnungen, Varianten, Blobs, Generationen unverändert');
  const neuCl = dbQ(BIZ_DB, `SELECT table_name, record_id FROM sync_changelog WHERE rowid > ?`, [vorher.changelogMax]);
  ok(!neuCl.some((r) => /^media_|^products$/.test(String(r.table_name)) || PIDS.includes(String(r.record_id))), `P5 sync_changelog: kein Eintrag für Artikel/Medien (${neuCl.length} andere: ${S([...new Set(neuCl.map((r) => r.table_name))])})`);

  // ── P6 NEUSTART: Karte für die Nachkontrolle ────────────────────────────────
  primary = await starten(OWNER_EMAIL);
  await zuDataRepairs(primary);
  await waitFor(primary, '[data-superseded-card]', 30000);
  ok((await text(primary, '[data-superseded-row="CAR-OGJ-001"]'))?.includes('closed as superseded'), 'P6 nach Neustart: Karte da, „closed as superseded“, Bildabgleich ausstehend');
  ok(await maus(primary, '[data-superseded-control-run]') === 'OK', 'P6 „Check image matching“ geklickt');
  await waitFor(primary, '[data-superseded-control]', 30000);
  const ctl6 = await primary.ev(`return [...document.querySelectorAll('[data-superseded-control-row]')].map(e=>e.getAttribute('data-candidate'));`);
  ok(ctl6?.length === 2 && ctl6.every((c) => c === 'true'), 'P6 beide Artikel stehen für Embedding/Bildbeschreibung an');
  await schliessen(primary); primary = null;

  // ── P7 RÜCKWEG über die geprüfte Sicherung ──────────────────────────────────
  const rw = sicherungsSkript('zurueckspielen', '--sicherung', join(RUN, 'F', BNAME), '--ziel', APP_DATA_DIR, '--beiseite', join(RUN, 'beiseite'), '--bestaetigen', BNAME, '--nur-pfad', APP);
  ok(rw.code === 0 && rw.out.ok, `P7 Zurückspielen aus der Sicherung (${S(rw.out).slice(0, 160)})`);
  ok(baum(APP_DATA_DIR) === sicherungBaum, 'P7 Datenordner exakt der Stand der Sicherung');
  ok(jobs().every((j) => j.state === 'accepted'), 'P7 beide Jobs wieder accepted');
  primary = await starten(OWNER_EMAIL);
  await zuDataRepairs(primary);
  await waitFor(primary, '[data-superseded-card]', 30000);
  ok((await text(primary, '[data-superseded-row="TAG-WCH-004"]'))?.includes('open') && (await text(primary, '[data-superseded-row="CAR-OGJ-001"]'))?.includes('open'), 'P7 App startet, Karte zeigt beide wieder offen');
  await schliessen(primary); primary = null;
} catch (e) {
  FAIL++; fails.push('Ausnahme: ' + String(e?.stack ?? e).slice(0, 600)); console.log('  x Ausnahme: ' + String(e?.stack ?? e).slice(0, 900));
} finally {
  try { primary?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null);
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch { /* egal */ }
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* egal */ }
  clearTimeout(WACHHUND);
  console.log(`\nSUPERSEDED-EDIT-PLANS E2E: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log('  - ' + f); }
  process.exit(FAIL ? 1 : 0);
}
