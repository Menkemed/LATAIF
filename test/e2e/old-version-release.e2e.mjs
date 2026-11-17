// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER Phase 5B — Owner-Karte „Release old image versions" in der echten App auf einer ISOLIERTEN Datenkopie.
// Run: IM_SNAP=<Ordner mit lataif.db + tenant-1 (Kopie, ohne Zeiger)> node scripts/e2e-diag-runner.mjs <out> test/e2e/old-version-release.e2e.mjs
//
//   A  KOPIE     lataif.db + Medien der Quelle in den isolierten Testordner; Test-Owner-Passwort; ein Verkäufer-Konto.
//   B  RECHTE    Verkäufer: Freigabe abgewiesen (auch Probelauf); Owner ohne Grund/Sicherung: abgewiesen.
//   C  PROBELAUF Karte (Maus): alte Fassungen und gelöschte Fotos GETRENNT; Zahlen/Bytes = Planung aus der Kopie;
//                nichts geschrieben; Protokoll -dry.
//   D  RÜCKFRAGE Start nur mit Grund + Sicherungsname; App-Rückfrage nennt beide Teile; „Abbrechen" ändert nichts.
//   E  STOP      Lauf (Maus) → „Stop" mitten im Lauf → gespeicherter Teilstand, Wartungsmodus aus.
//   F  WEITER    neuer Probelauf + Start setzt fort bis zum Ende; erneuter Probelauf 0/0; Fachdaten unverändert;
//                der vorhandene GC-Scan zeigt genau die freigegebenen Dateien (gelöscht wird NICHTS).
// Prozess-Isolation: nur eigene PIDs am exakten Testpfad, Port 3011/9223, Datenordner com.lataif.app.e2e. Die Quelle
// wird nur gelesen; der Testordner wird am Ende gelöscht.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight, testSourceFromEnv } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { maus, tippe } from './_e2e-mouse.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const SALES_EMAIL = 'sales-ovr@e2e.test';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'ovr-owner-' + Math.random().toString(36).slice(2);
const BNAME = '2026-11-17_e2e-vor-bildbereinigung';
const T0 = Date.now();
const schritt = (s) => console.log(`      [${Math.round((Date.now() - T0) / 1000)}s] ${s}`);
const RUN = join(os.tmpdir(), 'lataif-oldver', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const MEDIA = join(APP_DATA_DIR, 'media');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht'); aufraeumen(); process.exit(1); }, 60 * 60 * 1000);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const seedx = (...a) => execFileSync(SEED, a, { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
/** Lesender Adapter: dieselbe Form wie sql.js (exec → [{columns, values}]) für die Planungsfunktionen des Kerns. */
function sqlJsForm(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    run() { throw new Error('nur lesen'); },
    exec(sql, params = []) {
      const st = db.prepare(sql); const rows = st.all(...params);
      const columns = st.columns().map((c) => c.name);
      return rows.length ? [{ columns, values: rows.map((r) => columns.map((c) => r[c])) }] : [];
    },
    close() { db.close(); },
  };
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
  on(f) { this.listeners.push(f); }
  async send(method, params = {}, ms = 120000) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`CDP ${method} > ${ms} ms`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr, ms = 120000) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, ms);
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
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO'; const p=HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)'; try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteAuf(pruefe, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (await pruefe()) return true; await sleep(400); } return pruefe(); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); } throw new Error('no invoke'); }
const SHELL = 'a[href="/settings"]';
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const text = (p, sel) => p.ev(`return document.querySelector(${S(sel)})?.textContent ?? null;`);
const attr = (p, sel) => p.ev(`const e=document.querySelector(${S(sel)}); return e ? Object.assign({}, e.dataset) : null;`);
async function zuDataRepairs(p) { await geh(p, '/dashboard'); await sleep(600); await geh(p, '/settings?tab=repairs'); await sleep(1500); }

async function starten(email) {
  let p = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(p);
  // immer frisch anmelden: die gemerkte Sitzung (lataif_session) gehört womöglich einem anderen Konto
  await p.ev('try { localStorage.removeItem("lataif_session"); } catch {} location.reload(); return 1;').catch(() => null);
  await sleep(3500); p.close(); p = await attachOnly(APP_CDP, 90000); await waitInvoke(p);
  // Rust setzt die E2E-Kennung nur beim Programmstart; nach dem Neuladen hier wieder setzen (nur E2E-Build)
  await p.ev('window.__LATAIF_E2E__ = true; return 1;');
  await waitFor(p, SHELL + ', input[type="password"]', 120000);
  if (!(await exists(p, SHELL))) {
    await setVal(p, 'input[type="email"]', email);
    await setVal(p, 'input[type="password"]', ONBOARD_PW);
    await p.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(p, SHELL, 120000);
  await warteAuf(async () => (await p.ev('return !!window.__lataifOldVersionRelease;')) === true, 30000);
  return p;
}
async function beenden(p) {
  const pid = startedPids().pop();
  p.close();
  await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe');
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** Inhalt aller Tabellen außer den vier Medien-Kerntabellen (Fachdaten, Verknüpfungen, Sync, Audit). */
// Anmeldung (letzter Login, Sitzung) und Hintergrund-Sync (gesendet-Markierung, Cursor) schreiben hier — kein Teil der Freigabe.
// sync_changelog wird stattdessen auf NEUE Einträge geprüft (changelogStand).
const FLUECHTIG = new Set(['sessions', 'users', 'user_branches', 'sync_cursor', 'sync_changelog']);
const changelogStand = () => S(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n, MAX(id) AS m FROM sync_changelog')[0]);
function fachTabellen() {
  const db = new DatabaseSync(BIZ_DB, { readOnly: true });
  try {
    const out = {};
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('media_objects','media_variants','media_blobs','media_blob_generations') ORDER BY name`).all()) {
      if (FLUECHTIG.has(name)) continue;
      const h = createHash('sha256'); for (const r of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate()) h.update(JSON.stringify(Object.values(r), (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : typeof v === 'bigint' ? String(v) : v)));
      out[name] = h.digest('hex').slice(0, 16);
    }
    return out;
  } finally { db.close(); }
}
const fachDiff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
const zaehle = () => ({
  deleted: dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM media_blob_generations WHERE gen_status = 'deleted'`)[0]?.n ?? 0,
  superseded: dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM media_blob_generations WHERE gen_status = 'superseded'`)[0]?.n ?? 0,
  gcPending: dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM media_blobs WHERE blob_status = 'gc_pending'`)[0]?.n ?? 0,
  objGeloescht: dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM media_objects WHERE deleted_at IS NOT NULL`)[0]?.n ?? 0,
});
function logEintraege() {
  const dir = join(APP_DATA_DIR, 'maintenance-logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => ({ name: f.replace(/\.jsonl$/, ''),
    zeilen: readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) }));
}
async function probelauf(p) {
  await zuDataRepairs(p);
  await waitFor(p, '[data-oldver-card]', 30000);
  ok(await maus(p, '[data-oldver-dry]') === 'OK', 'Probelauf gestartet (Maus)');
  await waitFor(p, '[data-oldver-dryresult]', 15 * 60 * 1000);
  return { erster: await attr(p, '[data-oldver-dryresult]'), tot: await attr(p, '[data-oldver-dead]'),
    owner: await attr(p, '[data-oldver-dead-owner]'), galerie: await attr(p, '[data-oldver-dead-gallery]'), text: await text(p, '[data-oldver-dryresult]') };
}

let primary = null;
try {
  const SNAP = testSourceFromEnv('IM_SNAP', ['lataif.db', 'tenant-1']);
  aufraeumen(); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));
  const quelleSha = sha(join(SNAP, 'lataif.db'));

  // ── A · frische Installation (Test-Owner), dann die Kopie einsetzen ─────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'OVR Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'OVR Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'OVR Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000); await sleep(1500);
  await beenden(primary); primary = null;
  seedx('seed-primary', SERVER_DB);
  const testHash = dbQ(BIZ_DB, 'SELECT password_hash AS h FROM users WHERE lower(email) = lower(?)', [OWNER_EMAIL])[0]?.h;
  for (const f of ['lataif.db', 'lataif.db-wal', 'lataif.db-shm']) rmSync(join(APP_DATA_DIR, f), { force: true });
  copyFileSync(join(SNAP, 'lataif.db'), BIZ_DB);
  rmSync(MEDIA, { recursive: true, force: true });
  cpSync(join(SNAP, 'tenant-1'), join(MEDIA, 'tenant-1'), { recursive: true });
  {
    const db = new DatabaseSync(BIZ_DB);
    db.prepare('UPDATE users SET password_hash = ? WHERE lower(email) = lower(?)').run(testHash, OWNER_EMAIL);
    const o = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(OWNER_EMAIL);
    const sales = { ...o, id: 'user-e2e-sales-ovr', email: SALES_EMAIL };
    if ('name' in sales) sales.name = 'OVR Sales';
    const cols = Object.keys(sales);
    db.prepare(`INSERT INTO users (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => sales[c]));
    // Rolle je Filiale (user_branches): dieselben Filialen wie der Owner, Rolle „sales"
    for (const ub of db.prepare('SELECT * FROM user_branches WHERE user_id = ?').all(o.id)) {
      const row = { ...ub, user_id: sales.id, role: 'sales' };
      const c2 = Object.keys(row);
      db.prepare(`INSERT INTO user_branches (${c2.map((c) => `"${c}"`).join(',')}) VALUES (${c2.map(() => '?').join(',')})`).run(...c2.map((c) => row[c]));
    }
    db.close();
  }
  ok(!existsSync(join(APP_DATA_DIR, 'data-location.json')) || readFileSync(join(APP_DATA_DIR, 'data-location.json'), 'utf8').includes(IDENT), 'A kein Datenort-Zeiger der Quelle im Testordner');
  // Erwartung aus der Kopie (derselbe Kern wie die App, nur lesend)
  const kern = await import(new URL('../../src/core/media/old-version-release.ts', import.meta.url).href);
  const ad = sqlJsForm(BIZ_DB);
  const altPlan = kern.planOldVersionRelease(ad); const totPlan = kern.planDeadMediaRelease(ad); ad.close();
  const ERW = {
    alt: altPlan.candidates.length, altBytes: altPlan.candidates.reduce((a, c) => a + c.bytes, 0),
    tot: totPlan.candidates.length, totDateien: totPlan.candidates.reduce((a, c) => a + c.blobs.length, 0), totBytes: totPlan.candidates.reduce((a, c) => a + c.bytes, 0),
    besitzerWeg: totPlan.candidates.filter((c) => c.kind === 'owner_deleted').length, galerie: totPlan.candidates.filter((c) => c.kind === 'removed_from_gallery').length,
  };
  console.log('      ERWARTET ' + S(ERW));
  ok(ERW.alt > 0 && ERW.tot > 0, 'A die Kopie hat alte Fassungen und gelöschte Fotos');
  const z0 = zaehle();

  // ── B · RECHTE ────────────────────────────────────────────────────────────────────────────────────
  primary = await starten(SALES_EMAIL);
  const vk = await primary.ev(`return await window.__lataifOldVersionRelease.run({ mode: 'dry-run' }).then((r) => r.refused?.code ?? 'LIEF').catch((e) => String(e));`);
  ok(vk === 'MIGRATION_NOT_OWNER', `B Verkäufer: auch der Probelauf wird abgewiesen (${vk})`);
  await beenden(primary); primary = null;
  primary = await starten(OWNER_EMAIL);
  const ohneNotiz = await primary.ev(`return await window.__lataifOldVersionRelease.run({ mode: 'apply' }).then((r) => r.refused?.code ?? 'LIEF').catch((e) => String(e));`);
  ok(ohneNotiz === 'MIGRATION_NOTE_REQUIRED' && S(zaehle()) === S(z0), `B Owner ohne Grund/Sicherung: abgewiesen, nichts geschrieben (${ohneNotiz})`);

  // ── C · PROBELAUF (Karte, Maus) ─────────────────────────────────────────────────────────────────────
  const fach0 = fachTabellen();   // Stand nach der Anmeldung (die App schreibt beim Start z. B. categories.updated_at)
  const cl0 = changelogStand();
  const d1 = await probelauf(primary);
  console.log('      PROBELAUF ' + S({ alt: d1.erster, tot: d1.tot, owner: d1.owner, galerie: d1.galerie }));
  ok(Number(d1.erster?.planned) === ERW.alt && Number(d1.erster?.bytes) === ERW.altBytes && Number(d1.erster?.unverified) === 0,
    `C alte Fassungen: ${d1.erster?.planned} / ${(Number(d1.erster?.bytes) / 1e6).toFixed(2)} MB = Planung, jede aktuelle Datei verifiziert`);
  ok(Number(d1.tot?.media) === ERW.tot && Number(d1.tot?.files) === ERW.totDateien && Number(d1.tot?.bytes) === ERW.totBytes,
    `C gelöschte Fotos GETRENNT: ${d1.tot?.media} Fotos, ${d1.tot?.files} Dateien, ${(Number(d1.tot?.bytes) / 1e6).toFixed(2)} MB = Planung`);
  ok(Number(d1.owner?.oldverDeadOwner ?? -1) === ERW.besitzerWeg && Number(d1.galerie?.oldverDeadGallery ?? 0) === ERW.galerie,
    `C getrennt nach Grund: gelöschte Artikel ${d1.owner?.oldverDeadOwner}, aus der Galerie gelöscht ${d1.galerie?.oldverDeadGallery ?? 0}`);
  { const d = fachDiff(fach0, fachTabellen()); ok(S(zaehle()) === S(z0) && d.length === 0 && changelogStand() === cl0, `C Probelauf ändert nichts, kein neuer Änderungseintrag (${d.join(',') || 'keine Tabelle'})`); }
  ok(logEintraege().some((l) => l.name.endsWith('-dry') && l.zeilen.some((z) => z.event === 'planned') && l.zeilen.some((z) => z.event === 'planned_media')), 'C Protokoll -dry mit beiden Teilen');

  // ── D · RÜCKFRAGE ────────────────────────────────────────────────────────────────────────────────────
  ok(String(await maus(primary, '[data-oldver-start]')).startsWith('GESPERRT'), 'D Start gesperrt ohne Grund und Sicherungsname');
  ok(await tippe(primary, '[data-repair-reason]', 'Bildspeicher e2e') === 'OK' && await tippe(primary, '[data-oldver-backup]', BNAME) === 'OK', 'D Grund und Sicherungsname getippt');
  ok(await maus(primary, '[data-oldver-start]') === 'OK', 'D Start geklickt');
  await waitFor(primary, '[data-app-confirm]', 15000);
  const frage = await text(primary, '[data-app-confirm]');
  ok(frage?.includes(String(ERW.alt)) && frage?.includes(String(ERW.tot)) && frage?.includes(BNAME), 'D App-Rückfrage nennt alte Fassungen, gelöschte Fotos und die Sicherung');
  ok(await maus(primary, '[data-app-confirm-cancel]') === 'OK', 'D Abbrechen geklickt');
  await sleep(1500);
  ok(S(zaehle()) === S(z0) && !logEintraege().some((l) => !l.name.endsWith('-dry')), 'D Abbrechen: nichts geschrieben, kein Lauf-Protokoll');

  // ── E · LAUF mit STOP ───────────────────────────────────────────────────────────────────────────────
  if (!(await exists(primary, '[data-oldver-dryresult]'))) await probelauf(primary);
  await tippe(primary, '[data-oldver-backup]', BNAME);
  ok(await maus(primary, '[data-oldver-start]') === 'OK', 'E Start geklickt');
  await waitFor(primary, '[data-app-confirm]', 15000);
  ok(await maus(primary, '[data-app-confirm-ok]') === 'OK', 'E Rückfrage bestätigt (Maus)');
  await warteAuf(async () => Number(await primary.ev('return window.__lataifOldVersionRelease.state().progress?.released ?? 0;')) >= 150, 10 * 60 * 1000);
  const stopKlick = await maus(primary, '[data-oldver-stop]');
  ok(stopKlick === 'OK', `E „Stop" mitten im Lauf geklickt (${stopKlick})`);
  await warteAuf(async () => (await primary.ev('return window.__lataifOldVersionRelease.state().running;')) === false, 10 * 60 * 1000);
  await waitFor(primary, '[data-oldver-result]', 30000);
  const r1 = await attr(primary, '[data-oldver-result]');
  const wart = await primary.ev(`return await window.__TAURI_INTERNALS__.invoke('maintenance_mode_status');`);
  const z1 = zaehle();
  console.log('      NACH STOP ' + S({ r1, z1 }));
  ok(r1?.stopped === 'true' && Number(r1?.released) > 0 && z1.deleted === Number(r1?.released) && z1.superseded === ERW.alt - z1.deleted && wart?.active === false,
    `E gestoppt: ${r1?.released} gespeichert (Platte: ${z1.deleted} deleted), Rest unverändert, Wartungsmodus aus`);

  // ── F · WIEDERAUFNAHME ──────────────────────────────────────────────────────────────────────────────
  const d2 = await probelauf(primary);
  ok(Number(d2.erster?.planned) === ERW.alt - z1.deleted && Number(d2.tot?.media) === ERW.tot, `F neuer Probelauf: ${d2.erster?.planned} alte Fassungen übrig, ${d2.tot?.media} gelöschte Fotos`);
  ok(await tippe(primary, '[data-repair-reason]', 'Bildspeicher e2e') === 'OK' && await tippe(primary, '[data-oldver-backup]', BNAME) === 'OK', 'F Grund und Sicherungsname neu getippt');
  ok(await maus(primary, '[data-oldver-start]') === 'OK', 'F Start geklickt');
  await waitFor(primary, '[data-app-confirm]', 15000);
  ok(await maus(primary, '[data-app-confirm-ok]') === 'OK', 'F Rückfrage bestätigt');
  await warteAuf(async () => (await primary.ev('return window.__lataifOldVersionRelease.state().running;')) === true, 60000);   // erst der Start …
  await warteAuf(async () => (await primary.ev('return window.__lataifOldVersionRelease.state().running;')) === false, 15 * 60 * 1000);   // … dann das Ende
  if (!(await warteAuf(() => exists(primary, '[data-oldver-result]'), 30000))) {
    console.log('      DIAG state ' + S(await primary.ev('const s = window.__lataifOldVersionRelease.state(); return { error: s.error, running: s.running, report: s.report && { released: s.report.released, stopCode: s.report.stopCode, dead: s.report.deadMedia?.media }, progress: s.progress };')));
    console.log('      DIAG msg ' + S(await text(primary, '[data-oldver-msg]')));
  }
  await waitFor(primary, '[data-oldver-result]', 5000);
  const r2 = await attr(primary, '[data-oldver-result]');
  const z2 = zaehle();
  console.log('      FERTIG ' + S({ r2, z2 }));
  ok(r2?.stopped === 'false' && Number(r2?.failed) === 0 && z2.deleted === ERW.alt && z2.superseded === 0 && z2.gcPending === ERW.totDateien && z2.objGeloescht - z0.objGeloescht === ERW.tot,
    `F fertig: ${z2.deleted} alte Fassungen, ${ERW.tot} gelöschte Fotos (${z2.gcPending} Dateien) freigegeben, 0 Fehler`);
  const d3 = await probelauf(primary);
  ok(Number(d3.erster?.planned) === 0 && Number(d3.tot?.media) === 0, 'F erneuter Probelauf: nichts mehr zu tun');
  { const d = fachDiff(fach0, fachTabellen()); ok(d.length === 0 && changelogStand() === cl0, `F Fachdaten, Verknüpfungen und Audit unverändert, kein neuer Änderungseintrag (${d.join(',') || 'keine Tabelle'})`); }
  const lauf = logEintraege().filter((l) => !l.name.endsWith('-dry'));
  ok(lauf.length === 2 && lauf.every((l) => l.zeilen[0]?.event === 'owner' && l.zeilen[0]?.backup === BNAME && l.zeilen[0]?.reason === 'Bildspeicher e2e'), 'F Protokolle: Grund und Sicherung je Lauf');
  // der vorhandene GC sieht genau die freigegebenen Dateien (nur Scan, nichts gelöscht)
  const scan = await primary.ev(`return await window.__TAURI_INTERNALS__.invoke('scan_unused_media', ${S({ email: OWNER_EMAIL, password: OWNER_PW })}).catch((e) => ({ err: String(e) }));`);
  const freiAufPlatte = dbQ(BIZ_DB, `SELECT g.storage_key AS k FROM media_blob_generations g WHERE g.gen_status = 'deleted'
     UNION SELECT g.storage_key FROM media_blobs b JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no WHERE b.blob_status = 'gc_pending'`)
    .filter((r) => existsSync(join(MEDIA, String(r.k)))).length;
  ok(!scan?.err && scan.orphanCount === freiAufPlatte, `F GC-Scan: ${scan?.orphanCount ?? scan?.err} unbenutzte Dateien = freigegeben und vorhanden (${freiAufPlatte}); nichts gelöscht`);
  ok(sha(join(SNAP, 'lataif.db')) === quelleSha, 'F Quelle unverändert (nur gelesen)');
  await beenden(primary); primary = null;
} catch (e) {
  FAIL++; fails.push(String(e)); console.log('  x ABBRUCH ' + String(e?.stack || e).slice(0, 600));
} finally {
  clearTimeout(WACHHUND);
  try { primary?.close(); } catch { /* zu */ }
  aufraeumen(); await waitTestImageGone('lataif.exe').catch(() => null);
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch { /* egal */ }
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* egal */ }
}
console.log(FAIL ? `\nFAIL — Owner-Karte Bildfassungen: ${PASS} passed, ${FAIL} failed` : `\nPASS — Owner-Karte Bildfassungen: ${PASS} passed, 0 failed`);
for (const f of fails) console.log('  - ' + f);
process.exit(FAIL ? 1 : 0);
