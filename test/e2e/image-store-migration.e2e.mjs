// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER — Größenklassen für neue Uploads + Migration bestehender Bilder (Generationswechsel).
// Run: IM_SNAP=<snap-Ordner einer Sicherung> node scripts/e2e-diag-runner.mjs <out> test/e2e/image-store-migration.e2e.mjs
//
//   A  NEU      Uhr/Schmuck/Accessory über den PC2-Fernweg, Schmuck über Mobile → Hauptbild ≤ 60/30/30/30 KB, Vorschau ≤ 10 KB.
//   B  KOPIE    einer geprüften Vollsicherung (NUR lataif.db + Medien) in den isolierten Testordner; Test-Owner-Passwort in der KOPIE.
//   C  SICHERUNG echter Snapshot-Host, VOR der Migration.
//   D  BESTAND  Primary + PC2 laden alle Karten; Bestandsübersicht und Plan über den VOLLEN Bestand (keine Stichprobe).
//   E2 OFFEN    offene Edit-Pläne der Kopie blockieren den Lauf (fail-closed, Wartungsmodus danach aus); dann in der KOPIE beendet.
//   E  KARTE    Owner-Karte (Maus): Zählen, Probelauf über ALLE Bilder (Vorhersage je Bild im Protokoll), keine Zeile geändert.
//   F  LAUF 1    Start über die Karte (App-Rückfrage, Maus); WÄHREND des Laufs: PC2-Auftrag, Ablage und Handy-Upload → 503
//                MAINTENANCE_ACTIVE, Lesen geht; „Stop" → Paket gespeichert, keine Waise, Wartungsmodus aus.
//   G  LAUF 2    harter Absturz (eigene PID) mitten im Lauf; danach jede aktuelle Generation lesbar, Wartungsmodus weg.
//   H  LAUF 3    Wiederaufnahme über die Karte bis zum Ende; Waisen aus dem Absturz übernommen; 4. Lauf idempotent;
//                IDs/Zuordnungen/Artikelzeilen/Changelog/Audit unverändert; Probelauf = Ergebnis (jedes Bild, Byte für Byte).
//   I  ERGEBNIS  Größen je Klasse (alle ≤ Grenze), Integrität, aktuelle Bilddaten vorher/nachher, Platte, superseded.
//   J  PC2       für JEDEN Artikel der v0.8.101-Leseweg: products.get → mediaKeys → /api/media = aktuelle Datei; Karten aktuell.
//   K  GC        nur Probelauf: keine Waise, superseded bleibt geschützt; NICHTS wird gelöscht.
//   L  RESTORE   echter Restore-Host aus der Sicherung von C → Stand vor der Migration, App startet, Karten = Originale.
//
// PROZESS-ISOLATION wie alle Zwei-Rechner-Läufe: nur eigene PIDs am EXAKTEN Testpfad, Ports 3011/9223/9224, Datenordner
// com.lataif.app.e2e(.client). Produktion (E:\LATAIF\Data, Ports 3001/3443) wird nie berührt; die Sicherung wird nur GELESEN.
// Die Testkopie wird am Ende immer gelöscht.
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight, testSourceFromEnv } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids, killTestPid, pathOfPid } from './_e2e-process.mjs';
import { maus, tippe } from './_e2e-mouse.mjs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, copyFileSync, cpSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'im-owner-' + Math.random().toString(36).slice(2);
const N = Number(process.env.CC_N || 90);
const T0 = Date.now();
const schritt = (s) => console.log(`      [${Math.round((Date.now() - T0) / 1000)}s] ${s}`);

const RUN = join(os.tmpdir(), 'lataif-imgstore', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = []; const MESS = {};
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
// Voller Bestand: zwei Probeläufe + Lauf über ~900 Bilder dauern im Testbuild deutlich länger als die frühere Stichprobe.
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.'); aufraeumen(); process.exit(1); }, 170 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env, APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'), LATAIF_E2E_SYNC_PORT: String(PORT),
});
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
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
  /** Ein Browser-Dialog (alert/confirm) blockiert jede Auswertung — er wird angenommen und protokolliert. */
  async dialogeAnnehmen() {
    await this.send('Page.enable', {});
    this.on((m) => { if (m.method === 'Page.javascriptDialogOpening') { console.log('      DIALOG: ' + String(m.params.message).slice(0, 160)); void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null); } });
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
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
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
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');

// ── Zählung: Primary-IPC (ipc.localhost/<cmd>) und PC2-Netz (/api/media, /api/command products.get) über CDP ──
function zaehler(c) {
  const z = { mediaRead: 0, apiMedia: 0, productsGet: 0, ipcAll: 0 };
  c.on((m) => {
    if (m.method !== 'Network.requestWillBeSent') return;
    const r = m.params.request; const u = String(r?.url || '');
    if (r?.method === 'OPTIONS') return;   // CORS-Vorabanfrage: keine Übertragung
    if (/ipc\.localhost\//.test(u)) { z.ipcAll++; if (/ipc\.localhost\/media_read_verified(_raw)?(\?|$)/.test(u)) z.mediaRead++; }
    if (/\/api\/media\?key=/.test(u)) z.apiMedia++;
    if (/\/api\/command$/.test(u) && r.postData) { try { if (JSON.parse(r.postData).op === 'products.get') z.productsGet++; } catch { /* egal */ } }
  });
  return z;
}
const snap = (z) => ({ ...z });
const diff = (a, b) => ({ mediaRead: b.mediaRead - a.mediaRead, apiMedia: b.apiMedia - a.apiMedia, productsGet: b.productsGet - a.productsGet });

// ── Seite: Karten, sichtbare Karten, geladene Bilder ─────────────────────────
const KARTEN = `
  window.__ccBoxes = () => [...document.querySelectorAll('[data-page-scroll] div')].filter((d) => d.style.height === '180px');
  window.__ccVisible = () => { const sc = document.querySelector('[data-page-scroll]'); if (!sc) return []; const R = sc.getBoundingClientRect();
    return window.__ccBoxes().filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > R.top && r.top < R.bottom; }); };
  window.__ccLoaded = (b) => { const i = b.querySelector('img'); return !!(i && i.complete && i.naturalWidth > 0); };
  window.__ccState = () => { const all = window.__ccBoxes(); const vis = window.__ccVisible();
    return { cards: all.length, blob: all.filter((b) => /^blob:/.test(b.querySelector('img')?.src || '')).length,
      skeleton: all.filter((b) => !b.querySelector('img') && b.querySelector('div[aria-hidden]')).length,
      visible: vis.length, visibleLoaded: vis.filter(window.__ccLoaded).length }; };
`;
async function karten(c) { await c.ev(KARTEN + ' return 1;'); return c.ev('return window.__ccState();'); }
/** Wartet im Seitentakt (requestAnimationFrame) bis alle sichtbaren Karten ein geladenes Bild haben; liefert ms ab Start. */
const BIS_SICHTBAR_GELADEN = (vorher) => `
  ${KARTEN}
  const t0 = performance.now();
  ${vorher}
  let first = -1;
  return await new Promise((res) => { const tick = () => {
    const vis = window.__ccVisible(); const t = performance.now() - t0;
    if (vis.length > 0 && first < 0) first = { ms: Math.round(t), loaded: vis.filter(window.__ccLoaded).length, of: vis.length };
    if (vis.length > 0 && vis.every(window.__ccLoaded)) return res({ ms: Math.round(t), first, visible: vis.length });
    if (t > 30000) return res({ ms: -1, first, visible: vis.length, loaded: vis.filter(window.__ccLoaded).length });
    requestAnimationFrame(tick); }; tick(); });
`;
async function kalt(c) { await geh(c, '/tasks'); await sleep(800); return c.ev(BIS_SICHTBAR_GELADEN(`history.pushState({}, '', '/collection'); window.dispatchEvent(new PopStateEvent('popstate'));`)); }
async function nachUntenScrollen(c) {
  await c.ev(KARTEN + ' return 1;');
  for (let i = 0; i < 300; i++) {
    const fertig = await c.ev(`const sc=document.querySelector('[data-page-scroll]'); sc.scrollTop += sc.clientHeight * 0.8; await new Promise(r=>setTimeout(r,250)); return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;`);
    if (fertig) break;
  }
  await warteAuf(async () => { const s = await karten(c); return s.skeleton === 0; }, 240000);
  await c.ev(`document.querySelector('[data-page-scroll]').scrollTop = 0; return 1;`); await sleep(500);
}
/** Karte mit dem Namen `name`: die Bytes des gezeigten Bilds (SHA-256). */
const kartenBildSha = (c, name) => c.ev(`
  ${KARTEN}
  const box = window.__ccBoxes().find((b) => (b.parentElement?.textContent || '').includes(${S(name)}));
  const img = box?.querySelector('img'); if (!img) return 'KEIN-BILD';
  const buf = await (await fetch(img.src)).arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');`);
const kategorieKlick = (c, name) => c.ev(`const g=[...document.querySelectorAll('div')].find(d=>d.children.length>1 && [...d.children].some(x=>x.textContent.trim()==='Category') && d.querySelector('button')); const root=g||document;
  const b=[...root.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(name)}).pop(); if(!b) return 'NO:'+${S(name)}; b.click(); return 'OK';`);

// ── Spuren: Zeilen aller Tabellen, Dateien der Datenordner (ohne WebView-Profil), Browser-Speicher ──
function zeilen(file) {
  const out = {};
  for (const t of dbQ(file, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) out[t.name] = dbQ(file, `SELECT COUNT(*) c FROM "${t.name}"`)[0]?.c;
  return out;
}
function dateien(dir) {
  const out = [];
  const walk = (d) => { let l = []; try { l = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of l) { const p = join(d, e.name); if (e.isDirectory()) { if (!/EBWebView|logs?$/i.test(e.name)) walk(p); } else out.push(relative(dir, p)); } };
  walk(dir); return out.sort();
}
const browserSpeicher = (c) => c.ev(`const dbs = indexedDB.databases ? (await indexedDB.databases()).map(d=>d.name).sort() : []; return JSON.stringify({ ls: Object.keys(localStorage).sort(), ss: Object.keys(sessionStorage).sort(), idb: dbs, caches: (await caches.keys()).sort() });`);

function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk) continue;
    if (daten[sp.name] !== undefined) continue;
    const t = String(sp.type || '').toUpperCase();
    daten[sp.name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}

// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER — Teil B (Migration) arbeitet auf einer KOPIE der Sicherung vom 10.11.2026 im isolierten
// Test-Datenordner. Kopiert werden NUR lataif.db und der Medienordner — nie data-location.json, nie die
// Server-DB der Produktion (die Test-Server-DB mit Test-Owner bleibt). In der KOPIE wird das Passwort des
// Owners auf das Test-Passwort gesetzt (sonst wäre keine Anmeldung möglich); sonst wird nichts verändert.
// ════════════════════════════════════════════════════════════════════════════
// Die Testkopie kommt NUR ausdrücklich aus IM_SNAP (ein `snap-…`-Ordner einer Sicherung) — kein Standardpfad.
// Geprüft wird beim Start (`testSourceFromEnv`): ohne Angabe, bei einem lebenden Datenordner oder einer
// unvollständigen Kopie bricht die Suite ab, bevor irgendetwas gestartet wird.
let SNAP = '';
const MEDIA = join(APP_DATA_DIR, 'media');
const BACKUP_DIR = join(RUN, 'backups', 'snap-vor-migration');
const sha256f = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const seedx = (...a) => execFileSync(SEED, a, { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const CUR = `SELECT b.blob_id, g.generation_no AS gen, g.storage_key AS k, g.stored_blob_hash AS h, g.byte_size AS s
  FROM media_blobs b JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no`;
/** Jede AKTUELLE Generation: Datei vorhanden, Größe und SHA-256 stimmen. */
function integritaet() {
  let missing = 0, bad = 0; const rows = dbQ(BIZ_DB, CUR);
  for (const r of rows) { const p = join(MEDIA, String(r.k)); if (!existsSync(p)) { missing++; continue; } if (statSync(p).size !== Number(r.s) || sha256f(p) !== r.h) bad++; }
  return { n: rows.length, missing, bad };
}
function ordnerGroesse(dir) { let n = 0, b = 0; const w = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (!e.name.startsWith('.')) w(p); } else { n++; b += statSync(p).size; } } }; if (existsSync(dir)) w(dir); return { dateien: n, mb: +(b / 1e6).toFixed(1) }; }
const KB = (b) => Math.round(Number(b) / 100) / 10;
/** Größen je Klasse (aktuelle Generation der verknüpften Hauptbilder und Vorschauen). */
function klassen() {
  const m = dbQ(BIZ_DB, `SELECT l.entity_type AS et, l.media_role AS role, o.security_class AS sc,
      CASE l.entity_type WHEN 'product' THEN (SELECT category_id FROM products p WHERE p.id = l.entity_id) WHEN 'repair' THEN (SELECT item_category_id FROM repairs r WHERE r.id = l.entity_id) ELSE NULL END AS cat,
      g.byte_size AS s, b.current_generation_no AS gen
    FROM media_links l JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id AND o.deleted_at IS NULL
    JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
    JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
   WHERE l.deleted_at IS NULL`);
  const t = dbQ(BIZ_DB, `SELECT g.byte_size AS s FROM media_variants v
    JOIN media_objects o ON o.tenant_id = v.tenant_id AND o.media_id = v.media_id AND o.deleted_at IS NULL
    JOIN media_links l ON l.tenant_id = o.tenant_id AND l.media_id = o.media_id AND l.deleted_at IS NULL
    JOIN media_blobs b ON b.tenant_id = v.tenant_id AND b.blob_id = v.blob_id
    JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
   WHERE v.deleted_at IS NULL AND v.variant_type = 'thumbnail' AND o.security_class IN ('internal','public')`);
  const J = new Set(['cat-gold-jewelry', 'cat-branded-gold-jewelry', 'cat-original-gold-jewelry']);
  const cls = (r) => (r.sc !== 'internal' && r.sc !== 'public') ? 'ausweis' : r.et === 'repair' ? 'reparatur' : r.et !== 'product' ? r.et
    : r.cat === 'cat-watch' ? 'uhr' : J.has(r.cat) ? 'schmuck' : r.cat === 'cat-accessory' ? 'accessory' : 'sonstige';
  const out = {};
  for (const r of m) { const k = cls(r); const o = (out[k] ??= { n: 0, mb: 0, max: 0, ueber30: 0, ueber60: 0, gen2: 0 }); o.n++; o.mb += Number(r.s) / 1e6; o.max = Math.max(o.max, Number(r.s)); if (r.s > 30000) o.ueber30++; if (r.s > 60000) o.ueber60++; if (r.gen > 1) o.gen2++; }
  out.vorschau = { n: t.length, mb: t.reduce((a, r) => a + Number(r.s), 0) / 1e6, max: Math.max(0, ...t.map((r) => Number(r.s))), ueber10: t.filter((r) => r.s > 10000).length };
  for (const o of Object.values(out)) { o.mb = +o.mb.toFixed(2); o.maxKB = KB(o.max); delete o.max; }
  return out;
}
/** Aktuelle Hauptbild- UND Vorschau-Hashes (verknüpfte Artikel; die Karten zeigen seit v0.8.104 die Vorschau) und alle superseded-Hashes. */
function hashMengen() {
  const cur = new Set([
    ...dbQ(BIZ_DB, `${CUR} JOIN media_objects o ON o.master_blob_id = b.blob_id AND o.deleted_at IS NULL
      JOIN media_links l ON l.media_id = o.media_id AND l.deleted_at IS NULL AND l.entity_type = 'product'`).map((r) => r.h),
    ...dbQ(BIZ_DB, `${CUR} JOIN media_variants v ON v.blob_id = b.blob_id AND v.deleted_at IS NULL AND v.variant_type = 'thumbnail'
      JOIN media_links l ON l.media_id = v.media_id AND l.deleted_at IS NULL AND l.entity_type = 'product'`).map((r) => r.h),
  ]);
  const alt = new Set(dbQ(BIZ_DB, `SELECT stored_blob_hash AS h FROM media_blob_generations WHERE gen_status = 'superseded'`).map((r) => r.h));
  return { cur, alt };
}
const KARTEN_SHAS = `${KARTEN}
  const out = [];
  for (const b of window.__ccBoxes()) { const i = b.querySelector('img'); if (!i || !i.src || !(i.complete && i.naturalWidth > 0)) continue;
    const buf = await (await fetch(i.src)).arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', buf);
    out.push([...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('')); }
  return out;`;
/** Sammlung öffnen, ganz nach unten (alle Karten laden), gezeigte Bilder gegen die DB prüfen. */
async function kartenPruefen(c, label) {
  await geh(c, '/tasks'); await sleep(600); await geh(c, '/collection');
  await waitFor(c, '[data-page-scroll]', 60000); await sleep(1500);
  await nachUntenScrollen(c).catch(() => null);
  const shas = await c.ev(KARTEN_SHAS);
  const { cur, alt } = hashMengen();
  const aktuell = shas.filter((h) => cur.has(h)).length, veraltet = shas.filter((h) => alt.has(h) && !cur.has(h)).length;
  schritt(`${label}: ${shas.length} Karten geprüft, aktuell=${aktuell}, veraltet=${veraltet}`);
  return { n: shas.length, aktuell, veraltet };
}
/** Migrationsaufrufe dauern länger als die übliche CDP-Grenze (120 s): eigene Grenze 30 min. */
async function mig(c, expr) {
  const expression = `(async () => { const m = window.__lataifImageMigration; if (!m) return { kein: true }; return await ${expr}; })()`;
  const t0 = Date.now();
  const tick = setInterval(() => {
    c.ev('return window.__lataifImageMigration?.state()?.progress || null;')
      .then((p) => schritt(`  Migration läuft ${Math.round((Date.now() - t0) / 1000)} s: ${S(p)}`)).catch(() => null);
  }, 60000);
  let r;
  try { r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 1800000); } finally { clearInterval(tick); }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}
async function primaryStarten() {
  const p = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(p);
  await waitFor(p, SHELL + ', input[type="password"]', 120000);
  if (!(await exists(p, SHELL))) {
    await setVal(p, 'input[type="email"]', OWNER_EMAIL);
    await setVal(p, 'input[type="password"]', ONBOARD_PW);
    await p.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(p, SHELL, 120000);
  // Die App-Rückfrage (ConfirmHost) bleibt ECHT: die Karte wird mit der Maus bestätigt.
  await p.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  const end = Date.now() + 60000; let oben = false;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ } await sleep(500); }
  ok(oben, 'Primary antwortet auf dem Netz');
  await warteAuf(async () => (await p.ev('return !!window.__lataifImageMigration;')) === true, 30000);
  return p;
}
const api = async (pfad, body, token) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${pfad}`, { signal: AbortSignal.timeout(90000), method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, j };
};
const befehl = (op, payload, token) => api('/api/command', { op, commandId: randomUUID(), payload }, token);
const serverToken = async () => (await api('/api/auth/login', { email: OWNER_EMAIL, password: OWNER_PW })).j?.token;
async function pc2Verbinden() {
  const c0 = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(c0);
  await c0.ev('localStorage.clear(); return 1;');
  await c0.ev('location.reload(); return 1;'); await sleep(3500);
  c0.close(); let c = await attachOnly(CLIENT_CDP);
  await waitFor(c, '[data-first-run-gate]', 90000);
  await klick(c, '[data-first-run-connect]');
  await waitFor(c, '[data-first-run-server]', 20000);
  await setVal(c, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(c, '[data-first-run-connect-go]');
  await sleep(3500);
  c.close(); c = await attachOnly(CLIENT_CDP);
  return pc2Anmelden(c);
}
async function pc2Anmelden(c) {
  await waitFor(c, 'input[type="password"], ' + SHELL, 90000);
  if (!(await exists(c, SHELL))) {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', OWNER_PW);
    await klick(c, '[data-client-signin]');
    await waitFor(c, SHELL, 90000);
  }
  await c.ev('window.confirm = () => true; return 1;');
  return c;
}
/** Ein Foto-ähnliches Testbild (Rauschen + Formen), groß genug, dass jede Klasse verkleinern muss. */
const grossesFoto = (c, seed) => c.ev(`const w=1800,h=1350; const cv=document.createElement('canvas'); cv.width=w; cv.height=h; const g=cv.getContext('2d');
  const img=g.createImageData(w,h); const d=img.data; let s=(${seed}*7919+13)|0;
  for(let y=0;y<h;y++){ for(let x=0;x<w;x++){ s=(Math.imul(s,1103515245)+12345)|0; const n=(s>>>27); const i=(y*w+x)*4;
    d[i]=(x*255/w+n)&255; d[i+1]=(y*255/h+n*2)&255; d[i+2]=((x+y)*128/w+n*3)&255; d[i+3]=255; } }
  g.putImageData(img,0,0); g.fillStyle='#fff'; g.font='bold 120px Arial'; g.fillText('IM ${seed}', 80, 200);
  return cv.toDataURL('image/jpeg', 0.85).split(',')[1];`);
const MAIN_THUMB = `SELECT gm.byte_size AS main, gt.byte_size AS thumb FROM media_links l
  JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
  JOIN media_blobs bm ON bm.tenant_id = o.tenant_id AND bm.blob_id = o.master_blob_id
  JOIN media_blob_generations gm ON gm.tenant_id = bm.tenant_id AND gm.blob_id = bm.blob_id AND gm.generation_no = bm.current_generation_no
  JOIN media_variants v ON v.tenant_id = o.tenant_id AND v.media_id = o.media_id AND v.variant_type = 'thumbnail'
  JOIN media_blobs bt ON bt.tenant_id = v.tenant_id AND bt.blob_id = v.blob_id
  JOIN media_blob_generations gt ON gt.tenant_id = bt.tenant_id AND gt.blob_id = bt.blob_id AND gt.generation_no = bt.current_generation_no
 WHERE l.entity_type = 'product' AND l.entity_id = ? AND l.deleted_at IS NULL`;

const BNAME = '2026-11-16_e2e-vor-bildmigration';
const SICHERUNG = join(process.cwd(), 'scripts', 'maint', 'manuelle-sicherung.mjs');
/** Das Vollsicherungs-Skript des Runbooks (sichern / pruefen / zurueckspielen), JSON-Ausgabe. */
function sicherungsSkript(...a) {
  try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [SICHERUNG, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }; }
  catch (e) { let out = null; try { out = JSON.parse(String(e.stdout || e.stderr)); } catch { out = { raw: String(e.stdout || e.stderr).slice(0, 300) }; } return { code: e.status ?? 1, out }; }
}
/** Fingerabdruck eines ganzen Ordners (Pfade + Inhalte). */
function baum(dir) {
  const hh = createHash('sha256');
  const rec = (d, rel) => { for (const n of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, n.name); if (n.isDirectory()) rec(p, rel + '/' + n.name); else { hh.update(rel + '/' + n.name); hh.update(readFileSync(p)); } } };
  rec(dir, '');
  return hh.digest('hex').slice(0, 16);
}
/** Aktuelle Generationen nur der VERKNÜPFTEN Bilder (Haupt + Vorschau): Datei da, Größe und SHA-256 stimmen. */
function integritaetVerknuepft() {
  const rows = dbQ(BIZ_DB, `${CUR} WHERE b.blob_id IN (
      SELECT o.master_blob_id FROM media_objects o JOIN media_links l ON l.media_id = o.media_id AND l.deleted_at IS NULL WHERE o.deleted_at IS NULL
      UNION SELECT v.blob_id FROM media_variants v JOIN media_objects o ON o.media_id = v.media_id AND o.deleted_at IS NULL
        JOIN media_links l ON l.media_id = v.media_id AND l.deleted_at IS NULL WHERE v.deleted_at IS NULL)`);
  let missing = 0, bad = 0;
  for (const r of rows) { const p = join(MEDIA, String(r.k)); if (!existsSync(p)) { missing++; continue; } if (statSync(p).size !== Number(r.s) || sha256f(p) !== r.h) bad++; }
  return { n: rows.length, missing, bad };
}
async function zuDataRepairs(p) { await geh(p, '/dashboard'); await sleep(600); await geh(p, '/settings?tab=repairs'); await sleep(1500); }
const text = (p, sel) => p.ev(`return document.querySelector(${S(sel)})?.textContent ?? null;`);
/** Die Wartungsprotokolle im Test-Datenordner (maintenance-logs/*.jsonl), Zeile für Zeile. */
function logEintraege() {
  const dir = join(APP_DATA_DIR, 'maintenance-logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => ({ name: f.replace(/\.jsonl$/, ''),
    zeilen: readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) }));
}
/** Bilddateien im Medienordner, die KEINE Generation (gespeicherte DB auf der Platte) nennt. */
function waisen() {
  const ref = new Set(dbQ(BIZ_DB, 'SELECT storage_key AS k FROM media_blob_generations').map((r) => String(r.k).split('\\').join('/')));
  const out = [];
  const w = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) w(p); } else if (/\.(jpg|jpeg|png|webp)$/i.test(e.name)) { const rel = relative(MEDIA, p).split('\\').join('/'); if (!ref.has(rel)) out.push(rel); } } };
  if (existsSync(MEDIA)) w(MEDIA);
  return out;
}

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  SNAP = testSourceFromEnv('IM_SNAP', ['lataif.db', 'tenant-1']);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── EINRICHTEN (frische Installation, Test-Owner) ─────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'IM Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'IM Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'IM Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await sleep(1500);
  let pid = startedPids().pop();
  primary.close(); primary = null;
  await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe');
  seedx('seed-primary', SERVER_DB);

  // ── A · NEUE UPLOADS: Uhr / Schmuck / Accessory über den PC2-Fernweg, Schmuck über Mobile ─────────
  primary = await primaryStarten();
  let TOKEN = await serverToken();
  ok(!!TOKEN, 'A Anmeldung am Primary-Server');
  const kats = dbQ(BIZ_DB, `SELECT id FROM categories WHERE id IN ('cat-watch','cat-gold-jewelry','cat-accessory')`).map((r) => r.id);
  ok(kats.length === 3, `A Kategorien vorhanden (${kats.join(',')})`);
  const neu = {};
  for (const [i, cat] of ['cat-watch', 'cat-gold-jewelry', 'cat-accessory'].entries()) {
    const b64 = await grossesFoto(primary, 100 + i);
    const st = await api('/api/staging/media', { mime: 'image/jpeg', dataBase64: b64 }, TOKEN);
    // Pflichtfelder aus der WIRKSAMEN Kategorie-Definition (die App schreibt sie beim Start): Auswahl = erste Option, Zahl = 1, Text = 'IM'.
    const def = JSON.parse(dbQ(BIZ_DB, 'SELECT attributes AS a FROM categories WHERE id = ?', [cat])[0]?.a || '[]');
    const attributes = Object.fromEntries(def.filter((x) => x.required).map((x) => [x.key, x.type === 'number' ? 1 : x.type === 'boolean' ? true : x.options?.length ? (x.type === 'multiselect' ? [x.options[0]] : x.options[0]) : 'IM']));
    const r = await befehl('products.create', { categoryId: cat, brand: 'IM', name: `IM Neu ${cat}`, attributes, stagingIds: [st.j?.stagingId] }, TOKEN);
    neu[cat] = { id: r.j?.value?.productId, quelle: Math.round(b64.length * 0.75) };
    ok(r.status === 200 && r.j?.ok, `A ${cat}: über PC2-Fernweg angelegt (${r.status} ${r.j?.ok ? "" : S(r.j).slice(0, 220)})`);
  }
  // Mobile (Handy-Neuanlage, Schmuck)
  {
    const br = dbQ(BIZ_DB, 'SELECT id, tenant_id FROM branches LIMIT 1')[0] || {};
    await primary.ev(`try{ await window.__TAURI_INTERNALS__.invoke('mobile_runtime_scope_configure', ${S({ email: OWNER_EMAIL, password: OWNER_PW, tenantId: br.tenant_id, branchId: br.id })}); return 1; }catch(e){ return String(e); }`);
    const b64 = await grossesFoto(primary, 200);
    const ent = 'im-mobile-' + Date.now();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ protocol_version: 1, upload_event_id: 'im-ev-' + Date.now(), entity_id: ent, mode: 'collection', metadata: { brand: 'IM', name: 'IM Mobile Schmuck', categoryId: 'cat-gold-jewelry' }, images: [{ mime: 'image/jpeg', data_base64: b64 }] }) });
    ok(r.status === 201 || r.status === 200, `A Mobile-Upload angenommen (${r.status})`);
    let da = await warteAuf(async () => dbQ(BIZ_DB, MAIN_THUMB, [ent]).length > 0, 20000);
    if (!da) { await primary.ev('location.reload(); return 1;').catch(() => null); await sleep(4000); primary.close(); primary = await attachOnly(APP_CDP); await waitFor(primary, SHELL, 90000); da = await warteAuf(async () => dbQ(BIZ_DB, MAIN_THUMB, [ent]).length > 0, 60000); }
    neu.mobile = { id: ent };
    ok(da, 'A Mobile: am Primary übernommen');
  }
  await sleep(2500);
  const grenzen = { 'cat-watch': 60000, 'cat-gold-jewelry': 30000, 'cat-accessory': 30000, mobile: 30000 };
  MESS.neu = {};
  for (const [k, v] of Object.entries(neu)) {
    const r = dbQ(BIZ_DB, MAIN_THUMB, [v.id])[0];
    MESS.neu[k] = r ? { hauptKB: KB(r.main), vorschauKB: KB(r.thumb) } : null;
    ok(r && r.main <= grenzen[k] && r.thumb <= 10000, `A ${k}: Hauptbild ${r ? KB(r.main) : '?'} KB ≤ ${grenzen[k] / 1000} KB, Vorschau ${r ? KB(r.thumb) : '?'} KB ≤ 10 KB`);
  }
  pid = startedPids().pop();
  primary.close(); primary = null;
  await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe');

  // ── B · KOPIE DER SICHERUNG VOM 10.11. EINSETZEN (nur lataif.db + Medien) ─────────────────────────
  const testHash = dbQ(BIZ_DB, 'SELECT password_hash AS h FROM users WHERE lower(email) = lower(?)', [OWNER_EMAIL])[0]?.h;
  for (const f of ['lataif.db', 'lataif.db-wal', 'lataif.db-shm']) rmSync(join(APP_DATA_DIR, f), { force: true });
  copyFileSync(join(SNAP, 'lataif.db'), BIZ_DB);
  rmSync(MEDIA, { recursive: true, force: true });
  cpSync(join(SNAP, 'tenant-1'), join(MEDIA, 'tenant-1'), { recursive: true });
  { const db = new DatabaseSync(BIZ_DB); db.prepare('UPDATE users SET password_hash = ? WHERE lower(email) = lower(?)').run(testHash, OWNER_EMAIL); db.close(); }
  ok(!existsSync(join(APP_DATA_DIR, 'data-location.json')) || readFileSync(join(APP_DATA_DIR, 'data-location.json'), 'utf8').includes('com.lataif.app.e2e'), 'B kein Datenort-Zeiger aus der Sicherung im Testordner');
  MESS.vorher = { medien: ordnerGroesse(MEDIA), dbMB: +(statSync(BIZ_DB).size / 1e6).toFixed(1), integritaet: integritaet(), klassen: klassen(),
    konsignation: dbQ(BIZ_DB, `SELECT COUNT(DISTINCT l.entity_id) AS n FROM media_links l JOIN products p ON p.id = l.entity_id WHERE l.deleted_at IS NULL AND p.source_type = 'CONSIGNMENT'`)[0]?.n ?? 'n/a' };
  console.log('      VORHER ' + S(MESS.vorher));
  const intVorher = MESS.vorher.integritaet;

  // ── C · ECHTE SICHERUNG VOR DER MIGRATION (Snapshot-Host) ─────────────────────────────────────────
  const bout = seedx('backup', APP_DATA_DIR, BACKUP_DIR, new Date().toISOString());
  ok(/^BACKUP_OK/.test(bout), `C Sicherung vor der Migration (${bout})`);
  // Die VOLLSICHERUNG des Runbooks (der offizielle Rückweg): ganzer Datenordner 1:1, bei geschlossener Test-App.
  mkdirSync(join(RUN, 'voll'), { recursive: true });   // das Skript legt nie einen Zielordner an
  const voll = sicherungsSkript('sichern', '--quelle', APP_DATA_DIR, '--ziel', join(RUN, 'voll'), '--name', BNAME, '--ruhe-sekunden', '1', '--nur-pfad', APP);
  if (!voll.out?.ok) console.log('      VOLLSICHERUNG ' + S(voll).slice(0, 400));
  const vollPruef = sicherungsSkript('pruefen', '--sicherung', join(RUN, 'voll', BNAME)).out;
  const vollBaum = existsSync(join(RUN, 'voll', BNAME, 'Data')) ? baum(join(RUN, 'voll', BNAME, 'Data')) : '';
  ok(voll.code === 0 && voll.out?.ok && vollPruef?.ok && vollPruef.anzahlAbweichungen === 0, `C Vollsicherung (manuelle-sicherung.mjs) vor der Migration: ${voll.out?.dateien} Dateien, geprüft`);

  // ── D · PRIMARY + PC2 auf der Kopie; Karten einmal laden (S1-Cache warm mit den ALTEN Bildern) ─────
  primary = await primaryStarten();
  TOKEN = await serverToken();
  client = await pc2Verbinden();
  for (const c of [primary, client]) { await c.send('Network.enable', { maxPostDataSize: 65536 }); await c.dialogeAnnehmen(); }
  const warmP = await kartenPruefen(primary, 'D Primary vorher');
  const warmC = await kartenPruefen(client, 'D PC2 vorher');
  ok(warmP.n > 50 && warmP.veraltet === 0 && warmC.n > 50 && warmP.aktuell >= warmP.n * 0.9 && warmC.aktuell >= warmC.n * 0.9,
    `D Karten vorher geladen und als aktuelle Fassung erkannt (Primary ${warmP.aktuell}/${warmP.n}, PC2 ${warmC.aktuell}/${warmC.n})`);
  // VOLLER Bestand über die ECHTE Planungsfunktion (nur lesend) — keine Stichprobe mehr.
  const eng = await import(new URL('../../src/core/media/image-store-migration.ts', import.meta.url).href);
  const leser = () => { const ro = new DatabaseSync(BIZ_DB, { readOnly: true }); return { ro, a: { exec(sql, params = []) { const rows = ro.prepare(sql).all(...params); if (!rows.length) return []; const cols = Object.keys(rows[0]); return [{ columns: cols, values: rows.map((r) => cols.map((c) => r[c])) }]; }, run() { throw new Error('read-only'); } } }; };
  let L0 = leser(); const planAll = eng.planImageStoreMigration(L0.a); const invAll = eng.inventoryImageStore(L0.a); L0.ro.close();
  MESS.bestand = invAll;
  MESS.plan = { plaene: planAll.plans.length, haupt: planAll.plans.filter((p) => p.rendition === 'main').length, vorschau: planAll.plans.filter((p) => p.rendition === 'thumbnail').length, uebersprungen: planAll.skipped.length };
  console.log('      BESTAND ' + S(MESS.bestand) + ' PLAN ' + S(MESS.plan));
  ok(invAll.balanced && planAll.plans.length > 500, `D Bestand stimmt in sich (${invAll.blobsPresent} Dateien), Plan über den vollen Bestand: ${planAll.plans.length}`);
  const probe = {};
  for (const [k, uc] of [['uhr', 'watch'], ['schmuck', 'jewelry'], ['accessory', 'accessory']]) {
    for (const p of planAll.plans.filter((x) => x.rendition === 'main' && x.usageClass === uc)) {
      const r = dbQ(BIZ_DB, `SELECT l.entity_id AS id, g.storage_key AS k FROM media_links l JOIN media_objects o ON o.media_id = l.media_id AND o.deleted_at IS NULL
        JOIN media_blobs b ON b.blob_id = o.master_blob_id JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
       WHERE l.deleted_at IS NULL AND l.entity_type = 'product' AND o.master_blob_id = ? LIMIT 1`, [p.blobId])[0];
      if (r) { const d = await befehl('products.get', { id: r.id }, TOKEN); probe[k] = { id: r.id, blobId: p.blobId, ziel: p.targetBytes, altKey: r.k, keys: d.j?.value?.mediaKeys ?? [] }; break; }
    }
  }
  ok(Object.keys(probe).length === 3 && Object.values(probe).every((p) => p.keys.includes(p.altKey)), 'D PC2 (products.get) nennt vorher die alten Schlüssel');
  const dig0 = await mig(primary, 'm.digest()');
  const gens0 = dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations')[0]?.n;
  const waisenVorher = waisen().length;
  MESS.waisenVorher = waisenVorher;
  const aktuellVorher =dbQ(BIZ_DB, `SELECT COUNT(*) AS n, SUM(g.byte_size) AS b FROM media_blobs b JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no WHERE b.blob_status = 'present'`)[0];

  // ── E2 · VORBEDINGUNG: offene Aufnahmen/Edit-Pläne blockieren jedes Schreiben (fail-closed) ─────────
  let digF = dig0;
  const offen = dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM media_ingest_jobs WHERE state NOT IN ('ready','failed','quarantined','expired')")[0]?.n ?? 0;
  MESS.offeneJobs = offen;
  if (offen > 0) {
    const nein = await mig(primary, `m.run({ mode: 'apply', reason: 'e2e', backupRef: ${S(BNAME)} })`).then((r) => r?.report ? 'LIEF: ' + S(r.report.switched) : S(r?.refused ?? r)).catch((e) => String(e?.message ?? e));
    const nachher = await primary.ev(`return await window.__TAURI_INTERNALS__.invoke('maintenance_mode_status');`);
    ok(/open media ingest job/.test(nein) && dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations')[0]?.n === gens0 && nachher?.active === false,
      `E2 ${offen} offene Edit-Pläne in der Kopie → Lauf abgewiesen, nichts geschrieben, Wartungsmodus wieder aus (${nein.slice(0, 80)})`);
    // Nur in der TESTKOPIE: die alten Pläne enden (entspricht der Owner-Wartung vom 16.11.); App dafür sauber geschlossen.
    pid = startedPids().find((p) => p && pathOfPid(p)?.toLowerCase() === APP.toLowerCase());
    primary.close(); primary = null;
    await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe');
    { const db = new DatabaseSync(BIZ_DB); db.prepare("UPDATE media_ingest_jobs SET state = 'failed', error_code = 'E2E_STALE_EDIT_PLAN' WHERE state NOT IN ('ready','failed','quarantined','expired')").run(); db.close(); }
    primary = await primaryStarten();
    TOKEN = await serverToken();
    await primary.send('Network.enable', { maxPostDataSize: 65536 }); await primary.dialogeAnnehmen();
    const warm2 = await kartenPruefen(primary, 'E2 Primary neu, Karten wieder warm');
    digF = await mig(primary, 'm.digest()');
    ok(warm2.n > 50 && warm2.veraltet === 0, `E2 Primary nach Neustart: Karten mit den alten Fassungen geladen (${warm2.n})`);
  }

  // ── E · OWNER-KARTE: Zählen + Probelauf über ALLE Bilder (Maus) ─────────────────────────────────
  await zuDataRepairs(primary);
  await waitFor(primary, '[data-imgmig-card]', 30000);
  ok(String(await maus(primary, '[data-imgmig-start]')).startsWith('GESPERRT'), 'E „Start" gesperrt ohne Probelauf/Grund/Sicherungsname');
  ok(await maus(primary, '[data-imgmig-count]') === 'OK', 'E „Count images" geklickt');
  await waitFor(primary, '[data-imgmig-inventory]', 120000);
  const invKarte = await primary.ev(`const e=document.querySelector('[data-imgmig-inventory]'); return { total: Number(e.dataset.total), balanced: e.dataset.balanced };`);
  ok(invKarte.total === invAll.blobsPresent && invKarte.balanced === 'true', `E Karte zählt ${invKarte.total} Dateien, Summen stimmen`);
  let t = Date.now();
  ok(await maus(primary, '[data-imgmig-dry]') === 'OK', 'E Probelauf gestartet (Maus)');
  await waitFor(primary, '[data-imgmig-dryresult]', 45 * 60 * 1000);
  const dryKarte = await primary.ev(`const e=document.querySelector('[data-imgmig-dryresult]'); return { eligible: Number(e.dataset.eligible), total: Number(e.dataset.total), failed: Number(e.dataset.failed), text: e.textContent };`);
  const dryLog = logEintraege().find((l) => l.name.endsWith('-dry') && l.zeilen.some((z) => z.event === 'report'));
  const vorhersage = new Map((dryLog?.zeilen ?? []).filter((z) => z.event === 'planned').map((z) => [z.blobId, z.toBytes]));
  const dryRep = dryLog?.zeilen.find((z) => z.event === 'report')?.report;
  MESS.probelauf = { eligible: dryKarte.eligible, total: dryKarte.total, failed: dryKarte.failed, vorherMB: +(dryRep?.bytesBefore / 1e6).toFixed(2), nachherMB: +(dryRep?.bytesAfter / 1e6).toFixed(2), sek: Math.round((Date.now() - t) / 1000), skipped: dryRep?.skipped, byClass: dryRep?.byClass };
  console.log('      PROBELAUF ' + S(MESS.probelauf));
  ok(dryKarte.total === planAll.plans.length && dryKarte.eligible === vorhersage.size && dryKarte.eligible > 0, `E Probelauf über alle ${dryKarte.total} Bilder: ${dryKarte.eligible} umstellbar, Vorhersage je Bild im Protokoll (${vorhersage.size})`);
  ok(S(await mig(primary, 'm.digest()')) === S(digF) && dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations')[0]?.n === gens0 && waisen().length === waisenVorher, 'E Probelauf ändert keine Zeile und legt keine Datei an');
  ok((dryLog?.zeilen ?? []).every((z) => !/brand|customer|@|password/i.test(S(z))), 'E Protokoll ohne Namen/Kunden (nur Kennungen und Zahlen)');

  copyFileSync(BIZ_DB, join(RUN, 'vorher-migration.db'));   // Stand direkt vor dem ersten echten Lauf (für den Nachweis in H)

  // ── F · LAUF 1 über die Karte; Wartungsmodus prüfen; „Stop" ───────────────────────────────────────
  ok(await tippe(primary, '[data-repair-reason]', 'Bildspeicher e2e') === 'OK', 'F Grund getippt');
  ok(await tippe(primary, '[data-imgmig-backup]', BNAME) === 'OK', 'F Sicherungsname getippt');
  ok(await maus(primary, '[data-imgmig-start]') === 'OK', 'F „Start image migration" geklickt (Maus)');
  await waitFor(primary, '[data-app-confirm]', 15000);
  const frage = await text(primary, '[data-app-confirm]');
  ok(frage?.includes(String(dryKarte.eligible)) && frage?.includes(BNAME) && /second computer/i.test(frage ?? ''), 'F App-Rückfrage nennt Anzahl, Sicherung und den Wartungsmodus');
  ok(await maus(primary, '[data-app-confirm-ok]') === 'OK', 'F Rückfrage bestätigt (Maus)');
  t = Date.now();
  await warteAuf(async () => Number(await primary.ev('return window.__lataifImageMigration.state().progress?.switched ?? 0;')) >= 40, 30 * 60 * 1000);
  {
    const stat = await primary.ev(`return await window.__TAURI_INTERNALS__.invoke('maintenance_mode_status');`);
    const st = await api('/api/staging/media', { mime: 'image/jpeg', dataBase64: await grossesFoto(primary, 300) }, TOKEN);
    const cmd = await befehl('products.update', { id: probe.uhr.id, patch: { notes: 'e2e wartung' } }, TOKEN);
    const mob = await fetch(`http://127.0.0.1:${PORT}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ protocol_version: 1, upload_event_id: 'im-wart-' + Date.now(), entity_id: 'im-wart-' + Date.now(), mode: 'collection', metadata: { brand: 'IM', name: 'IM Wartung' }, images: [] }) });
    const mobJ = await mob.json().catch(() => ({}));
    const lesen = await befehl('products.get', { id: probe.uhr.id }, TOKEN);
    MESS.wartung = { status: stat, ablage: [st.status, st.j?.error], auftrag: [cmd.status, cmd.j?.error, cmd.j?.outcome], handy: [mob.status, mobJ?.error, mob.headers.get('retry-after')], lesen: lesen.status };
    console.log('      WARTUNGSMODUS ' + S(MESS.wartung));
    ok(stat?.active === true, 'F während des Laufs: Wartungsmodus aktiv');
    ok(st.status === 503 && st.j?.error === 'MAINTENANCE_ACTIVE', `F PC2-Ablage (Foto) abgewiesen: ${st.status}`);
    ok(cmd.status === 503 && cmd.j?.error === 'MAINTENANCE_ACTIVE' && cmd.j?.outcome === 'not_executed', `F PC2-Auftrag abgewiesen, nicht ausgeführt: ${cmd.status}`);
    ok(mob.status === 503 && mobJ?.error === 'MAINTENANCE_ACTIVE' && mob.headers.get('retry-after') === '120', `F Handy-Upload abgewiesen (503 = das Handy versucht es später erneut): ${mob.status}`);
    ok(lesen.status === 200 && lesen.j?.ok, 'F Lesen (products.get) geht während des Laufs');
  }
  ok(await maus(primary, '[data-imgmig-stop]') === 'OK', 'F „Stop" geklickt (Maus)');
  await waitFor(primary, '[data-imgmig-result][data-stopped="true"]', 120000);
  const r1 = await primary.ev(`const e=document.querySelector('[data-imgmig-result]'); return { switched: Number(e.dataset.switched), failed: Number(e.dataset.failed), text: e.textContent };`);
  ok(r1.switched >= 40 && r1.failed === 0, `F angehalten nach ${r1.switched} Umstellungen (${Math.round((Date.now() - t) / 1000)} s)`);
  const stat1 = await primary.ev(`return await window.__TAURI_INTERNALS__.invoke('maintenance_mode_status');`);
  const cmd1 = await befehl('products.update', { id: 'gibt-es-nicht-' + Date.now(), patch: { notes: 'x' } }, TOKEN);
  ok(stat1?.active === false && cmd1.status !== 503 && cmd1.j?.error !== 'MAINTENANCE_ACTIVE', `F nach dem Halt: Wartungsmodus aus, PC2-Aufträge werden wieder angenommen (${cmd1.status} ${cmd1.j?.error ?? ''})`);
  ok(waisen().length === waisenVorher, `F nach „Stop": keine neue Datei ohne Generation (${waisen().length - waisenVorher})`);
  ok(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations WHERE generation_no > 1')[0]?.n === r1.switched, 'F alles Umgestellte steht auf der Platte (gespeichert)');
  ok(S(await mig(primary, 'm.digest()')) === S(digF), 'F Objekte/Links/Varianten/Artikelzeilen/Changelog/Audit unverändert');
  const runLog = logEintraege().find((l) => !l.name.endsWith('-dry') && l.zeilen.some((z) => z.event === 'owner'));
  ok(runLog && runLog.zeilen.find((z) => z.event === 'owner')?.backup === BNAME && runLog.zeilen.filter((z) => z.event === 'switched').length === r1.switched,
    `F Protokolldatei maintenance-logs/${runLog?.name}.jsonl: Owner, Sicherung, ${r1.switched} Umstellungen`);
  await sleep(1500);
  const zwischenP = await kartenPruefen(primary, 'F Primary nach Teil-Migration');
  const zwischenC = await kartenPruefen(client, 'F PC2 nach Teil-Migration');
  ok(zwischenP.veraltet === 0 && zwischenC.veraltet === 0 && zwischenP.aktuell === warmP.aktuell && zwischenC.aktuell === warmC.aktuell,
    `F alle Karten zeigen die aktuelle Fassung, keine die alte (Primary ${zwischenP.aktuell}/${zwischenP.n}, PC2 ${zwischenC.aktuell}/${zwischenC.n})`);

  // ── G · LAUF 2: HARTER ABSTURZ mitten im Lauf (Prozess beendet), Neustart, Integrität ───────────────
  await primary.ev(`window.__imRun = window.__lataifImageMigration.run({ mode: 'apply', reason: 'e2e absturz', backupRef: ${S(BNAME)} }); return 1;`);
  await warteAuf(async () => Number(await primary.ev('return window.__lataifImageMigration.state().progress?.switched ?? 0;')) >= 15, 900000);
  const vorKill = Number(await primary.ev('return window.__lataifImageMigration.state().progress?.switched ?? 0;'));
  pid = startedPids().find((p) => p && pathOfPid(p)?.toLowerCase() === APP.toLowerCase()) ?? startedPids()[0];
  killTestPid(pid, APP);
  primary.close(); primary = null;
  await waitTestImageGone('lataif.exe');
  ok(true, `G Primary mitten im Lauf hart beendet (nach ${vorKill} Umstellungen dieses Laufs)`);
  const intKill = integritaet();
  ok(intKill.bad === 0 && intKill.missing <= intVorher.missing, `G nach dem Absturz: jede aktuelle Generation ist lesbar (fehlend ${intKill.missing} wie vorher ${intVorher.missing}, falsch ${intKill.bad})`);
  const waisenKill = { length: waisen().length - waisenVorher };
  const nachKillGen2 = dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations WHERE generation_no > 1')[0]?.n;
  ok(waisenKill.length <= 10, `G höchstens ein Paket (10) Dateien ohne gespeicherte Generation (${waisenKill.length})`);
  primary = await primaryStarten();
  TOKEN = await serverToken();
  const stat2 = await primary.ev(`return await window.__TAURI_INTERNALS__.invoke('maintenance_mode_status');`);
  ok(stat2?.active === false, 'G nach dem Neustart: kein Wartungsmodus mehr (nur im Speicher)');

  // ── H · LAUF 3: Wiederaufnahme über die Karte bis zum Ende ─────────────────────────────────────────
  const dig3 = await mig(primary, 'm.digest()');
  await zuDataRepairs(primary);
  await waitFor(primary, '[data-imgmig-card]', 30000);
  ok(await maus(primary, '[data-imgmig-dry]') === 'OK', 'H Probelauf vor der Wiederaufnahme (Maus)');
  await waitFor(primary, '[data-imgmig-dryresult]', 45 * 60 * 1000);
  const rest = await primary.ev(`const e=document.querySelector('[data-imgmig-dryresult]'); return { total: Number(e.dataset.total), eligible: Number(e.dataset.eligible) };`);
  ok(rest.total === planAll.plans.length - nachKillGen2,`H Probelauf: es bleiben ${rest.total} Bilder (vorher ${dryKarte.total}, schon umgestellt ${nachKillGen2})`);
  ok(await tippe(primary, '[data-repair-reason]', 'Bildspeicher e2e Fortsetzung') === 'OK' && await tippe(primary, '[data-imgmig-backup]', BNAME) === 'OK', 'H Grund + Sicherung getippt');
  ok(await maus(primary, '[data-imgmig-start]') === 'OK', 'H Start (Maus)');
  await waitFor(primary, '[data-app-confirm]', 15000);
  ok(await maus(primary, '[data-app-confirm-ok]') === 'OK', 'H Rückfrage bestätigt');
  t = Date.now();
  await waitFor(primary, '[data-imgmig-result][data-stopped="false"]', 45 * 60 * 1000);
  const r3 = await primary.ev(`const e=document.querySelector('[data-imgmig-result]'); return { switched: Number(e.dataset.switched), failed: Number(e.dataset.failed) };`);
  MESS.lauf3 = { gespeichertVorAbsturz: nachKillGen2, waisenNachAbsturz: waisenKill.length, switched: r3.switched, failed: r3.failed, sek: Math.round((Date.now() - t) / 1000) };
  console.log('      LAUF 3 ' + S(MESS.lauf3));
  ok(r3.failed === 0 && r3.switched === rest.eligible, `H Wiederaufnahme: Rest umgestellt (${r3.switched} = Vorhersage ${rest.eligible}), Fehler ${r3.failed}`);
  ok(waisen().length === waisenVorher, `H die Dateien aus dem Absturz wurden übernommen: keine neue Datei ohne Generation (${waisen().length - waisenVorher})`);
  const r4 = await mig(primary, `m.run({ mode: 'apply', reason: 'e2e idempotent', backupRef: ${S(BNAME)} })`);
  ok(r4.report?.switched === 0 && r4.report?.eligible === 0 && r4.report?.failed === 0, `H vierter Lauf: nichts mehr zu tun (idempotent; ${r4.report?.total} Bilder bleiben über der Grenze, weil < 10 % Ersparnis)`);
  ok(S(await mig(primary, 'm.digest()')) === S(dig3), 'H Objekte/Links/Varianten/Artikelzeilen (pHash, Embedding)/Changelog/Audit unverändert');
  ok(['media_objects', 'media_links_active', 'media_variants', 'media_blobs', 'links_sig', 'objects_sig', 'variants_sig', 'products', 'products_media_sig', 'sync_changelog', 'audit_log'].every((k) => dig3[k] === dig0[k]),
    'H über alle Läufe und den Absturz hinweg: Medien-IDs, Zuordnungen, Artikel, Changelog und Audit identisch');
  // Probelauf = Ergebnis: jedes vorhergesagte Bild steht jetzt mit GENAU der vorhergesagten Größe da.
  const jetzt = new Map(dbQ(BIZ_DB, `SELECT b.blob_id AS id, b.current_generation_no AS gen, g.byte_size AS s FROM media_blobs b JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no`).map((r) => [r.id, r]));
  const abweichend = [...vorhersage].filter(([id, bytes]) => jetzt.get(id)?.gen !== 2 || Number(jetzt.get(id)?.s) !== Number(bytes));
  const umgestellt = dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations WHERE generation_no > 1')[0]?.n;
  ok(abweichend.length === 0 && umgestellt === vorhersage.size, `H Probelauf = Ergebnis: ${vorhersage.size} vorhergesagt, ${umgestellt} umgestellt, ${abweichend.length} abweichend`);
  {
    // Derselbe Nachweis wie nach der produktiven Migration (Runbook D): nur Generationen und Zeiger geändert.
    const { vergleiche } = await import(new URL('../../scripts/maint/bildmigration-vergleich.mjs', import.meta.url).href);
    const v = vergleiche(join(RUN, 'vorher-migration.db'), BIZ_DB);
    MESS.nachweis = { ok: v.ok, umgestellt: v.umgestellt, aktuellMB: [+(v.aktuelleBilddatenBytes.vorher / 1e6).toFixed(2), +(v.aktuelleBilddatenBytes.nachher / 1e6).toFixed(2)], supersededMB: +(v.supersededBytes / 1e6).toFixed(2), fehler: v.fehler };
    ok(v.ok && v.umgestellt === umgestellt, `H Nachweis-Skript (bildmigration-vergleich): ok, ${v.umgestellt} umgestellt, ${S(v.fehler)}`);
  }
  await sleep(2000);

  // ── I · ERGEBNIS: Größen je Klasse, Integrität, Speicher ─────────────────────────────────────────────
  const plaeneById = new Map(planAll.plans.map((p) => [p.blobId, p]));
  const zuGross = [...plaeneById.values()].filter((p) => Number(jetzt.get(p.blobId)?.s) > p.targetBytes && jetzt.get(p.blobId)?.gen > 1);
  const aktuellNachher = dbQ(BIZ_DB, `SELECT COUNT(*) AS n, SUM(g.byte_size) AS b FROM media_blobs b JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no WHERE b.blob_status = 'present'`)[0];
  MESS.nachher = { medien: ordnerGroesse(MEDIA), dbMB: +(statSync(BIZ_DB).size / 1e6).toFixed(1), integritaet: integritaet(), klassen: klassen(),
    aktuelleBilddatenMB: { vorher: +(aktuellVorher.b / 1e6).toFixed(2), nachher: +(aktuellNachher.b / 1e6).toFixed(2) },
    generationen: dbQ(BIZ_DB, 'SELECT gen_status AS s, COUNT(*) AS n, ROUND(SUM(byte_size)/1e6,2) AS mb FROM media_blob_generations GROUP BY 1') };
  console.log('      NACHHER ' + S(MESS.nachher));
  ok(MESS.nachher.integritaet.bad === 0 && MESS.nachher.integritaet.missing === intVorher.missing, `I Integrität: jede aktuelle Generation stimmt (fehlend wie vorher: ${intVorher.missing})`);
  ok(zuGross.length === 0, `I kein umgestelltes Bild über seiner Grenze (${zuGross.length})`);
  const kl = MESS.nachher.klassen;
  ok((kl.uhr?.ueber60 ?? 0) === 0 && (kl.schmuck?.ueber30 ?? 0) <= (MESS.vorher.klassen.schmuck?.ueber30 ?? 0) && (kl.vorschau?.ueber10 ?? 0) <= (MESS.vorher.klassen.vorschau?.ueber10 ?? 0), `I Klassen nach der Migration: ${S({ uhr: kl.uhr, schmuck: kl.schmuck, accessory: kl.accessory, reparatur: kl.reparatur, vorschau: kl.vorschau })}`);
  ok((kl.ausweis?.gen2 ?? 0) === 0, 'I Ausweis unverändert (Generation 1)');
  ok(MESS.nachher.dbMB - MESS.vorher.dbMB < 1.0, `I Datenbank wächst kaum (${MESS.vorher.dbMB} → ${MESS.nachher.dbMB} MB)`);
  ok(MESS.nachher.medien.mb >= MESS.vorher.medien.mb, `I Platte: alte Fassungen bleiben, der Medienordner wächst (${MESS.vorher.medien.mb} → ${MESS.nachher.medien.mb} MB)`);

  // ── J · PC2 (Leseweg v0.8.101) für JEDEN Artikel + Karten an Primary und PC2 ───────────────────────────
  {
    const ids = dbQ(BIZ_DB, `SELECT DISTINCT entity_id AS id FROM media_links WHERE entity_type = 'product' AND deleted_at IS NULL ORDER BY entity_id`).map((r) => r.id);
    let schluessel = 0, ok200 = 0, falsch = 0, fehltSoll = 0;
    for (const id of ids) {
      const d = await befehl('products.get', { id }, TOKEN);
      const keys = d.j?.value?.mediaKeys ?? [];
      const soll = dbQ(BIZ_DB, `${CUR} JOIN media_objects o ON o.master_blob_id = b.blob_id AND o.deleted_at IS NULL JOIN media_links l ON l.media_id = o.media_id AND l.deleted_at IS NULL AND l.entity_type = 'product' WHERE l.entity_id = ?`, [id]).map((r) => r.k);
      if (soll.some((k) => !keys.includes(k))) fehltSoll++;
      for (const k of keys) {
        schluessel++;
        const res = await fetch(`http://127.0.0.1:${PORT}/api/media?key=${encodeURIComponent(k)}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
        const b = Buffer.from(await res.arrayBuffer());
        if (res.status === 200 && existsSync(join(MEDIA, k)) && createHash('sha256').update(b).digest('hex') === sha256f(join(MEDIA, k))) ok200++; else falsch++;
      }
    }
    MESS.pc2Leseweg = { artikel: ids.length, schluessel, ok200, falsch, fehltSoll };
    console.log('      PC2-LESEWEG ' + S(MESS.pc2Leseweg));
    ok(ids.length > 300 && falsch === 0 && fehltSoll === 0 && ok200 === schluessel, `J v0.8.101-Leseweg für alle ${ids.length} Artikel: ${ok200}/${schluessel} Bildschlüssel liefern die aktuelle Datei, keiner fehlt`);
    for (const [k, p] of Object.entries(probe)) {
      const altR = await fetch(`http://127.0.0.1:${PORT}/api/media?key=${encodeURIComponent(p.altKey)}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
      ok(altR.status !== 200 && existsSync(join(MEDIA, p.altKey)), `J ${k}: die alte Fassung wird nicht mehr ausgeliefert (${altR.status}), die Datei liegt noch`);
    }
  }
  client = await pc2Anmelden(client).catch(async () => { try { client?.close(); } catch { /* zu */ } return pc2Anmelden(await attachOnly(CLIENT_CDP)); });
  await client.send('Network.enable', { maxPostDataSize: 65536 }).catch(() => null);
  await primary.send('Network.enable', { maxPostDataSize: 65536 }); await primary.dialogeAnnehmen();
  const endeP = await kartenPruefen(primary, 'J Primary nachher');
  const endeC = await kartenPruefen(client, 'J PC2 nachher');
  ok(endeP.veraltet === 0 && endeC.veraltet === 0 && endeP.aktuell === warmP.aktuell && endeC.aktuell === warmC.aktuell,
    `J alle geladenen Karten zeigen die aktuelle Generation (Primary ${endeP.aktuell}/${endeP.n}, PC2 ${endeC.aktuell}/${endeC.n})`);

  // ── K · MEDIEN-GC (nur Probelauf): die alten Fassungen sind geschützt, nichts wird gelöscht ───────────
  const gc = await primary.ev(`try { return await window.__TAURI_INTERNALS__.invoke('scan_unused_media', ${S({ email: OWNER_EMAIL, password: OWNER_PW })}); } catch (e) { return { err: String(e) }; }`);
  MESS.gc = gc?.err ? gc : { referenziert: gc.referencedCount, waisen: gc.orphanCount, waisenMB: +(gc.orphanBytes / 1e6).toFixed(2), fehlend: gc.missingReferencedCount, quarantaene: gc.quarantinedCount };
  console.log('      GC-PROBELAUF ' + S(MESS.gc));
  ok(!gc?.err && gc.orphanCount === 0 && gc.referencedCount > 0, `K GC-Probelauf: keine Waise durch die Migration (superseded-Fassungen bleiben geschützt): ${S(MESS.gc)}`);

  // ── L · WIEDERHERSTELLUNG aus der Test-Sicherung (echter Restore-Host) ──────────────────────────────
  pid = startedPids().find((p) => p && pathOfPid(p)?.toLowerCase() === APP.toLowerCase());
  try { client?.close(); } catch { /* zu */ } client = null;
  primary.close(); primary = null;
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  const ident = join(RUN, 'identitaet'); mkdirSync(ident, { recursive: true });
  const mitnehmen = readdirSync(APP_DATA_DIR, { withFileTypes: true }).filter((e) => e.isFile() && !/^lataif(_sync_server)?\.db/.test(e.name)).map((e) => e.name);
  for (const f of mitnehmen) copyFileSync(join(APP_DATA_DIR, f), join(ident, f));
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); mkdirSync(APP_DATA_DIR, { recursive: true });
  for (const f of mitnehmen) copyFileSync(join(ident, f), join(APP_DATA_DIR, f));
  const rout = seedx('restore', APP_DATA_DIR, BACKUP_DIR);
  ok(/^RESTORE_OK/.test(rout), `L Wiederherstellung (${rout})`);
  const maxGen = dbQ(BIZ_DB, 'SELECT MAX(generation_no) AS m FROM media_blob_generations')[0]?.m;
  const intRest = integritaetVerknuepft();
  MESS.appRestore = { alle: integritaet(), verknuepft: intRest };
  // Die App-Sicherung nimmt (wie immer) nur die verknüpften Bilder mit — historische Dateien entfernter Fotos nicht.
  ok(maxGen === 1 && intRest.bad === 0 && intRest.missing === 0, `L App-Sicherung: Stand vor der Migration zurück, nur Generation 1, jedes verknüpfte Bild stimmt (${S(MESS.appRestore)})`);
  primary = await primaryStarten();
  const dr = await mig(primary, 'm.digest()');
  ok(['media_objects', 'media_links_active', 'media_variants', 'links_sig', 'products_media_sig'].every((k) => dr[k] === dig0[k]), 'L App startet auf dem wiederhergestellten Stand, Zuordnungen wie vorher');
  const rp = await kartenPruefen(primary, 'L Primary nach Wiederherstellung');
  ok(rp.n > 50 && rp.veraltet === 0 && rp.aktuell === warmP.aktuell, `L Karten zeigen wieder die Originale (${rp.aktuell}/${rp.n})`);

  // ── L2 · RÜCKWEG DES RUNBOOKS: Vollsicherung zurückspielen → Datenordner EXAKT wie vor der Migration ─────
  pid = startedPids().find((p) => p && pathOfPid(p)?.toLowerCase() === APP.toLowerCase());
  primary.close(); primary = null;
  await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe');
  const rw = sicherungsSkript('zurueckspielen', '--sicherung', join(RUN, 'voll', BNAME), '--ziel', APP_DATA_DIR, '--beiseite', join(RUN, 'beiseite-voll'), '--bestaetigen', BNAME, '--nur-pfad', APP);
  ok(rw.code === 0 && rw.out?.ok, `L2 Vollsicherung zurückgespielt (${S(rw.out).slice(0, 160)})`);
  ok(vollBaum && baum(APP_DATA_DIR) === vollBaum, 'L2 Datenordner Datei für Datei exakt der Stand vor der Migration (auch historische Fotos, keine Protokolle der Läufe)');
  const intVoll = integritaet();
  ok(dbQ(BIZ_DB, 'SELECT MAX(generation_no) AS m FROM media_blob_generations')[0]?.m === 1 && intVoll.bad === 0 && intVoll.missing === intVorher.missing && intVoll.n === intVorher.n,
    `L2 nur Generation 1, alle Dateien wie vorher (${S(intVoll)})`);
  primary = await primaryStarten();
  const rv = await kartenPruefen(primary, 'L2 Primary nach dem Rückweg');
  ok(rv.n > 50 && rv.veraltet === 0 && rv.aktuell === warmP.aktuell, `L2 App startet, Karten zeigen die Originale (${rv.aktuell}/${rv.n})`);
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  console.log('\nMESSWERTE ' + JSON.stringify(MESS, null, 1));
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  // Die Testkopie (mit Produktionsdaten) wird IMMER entfernt.
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch { /* bleibt */ }
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nIMAGE STORE MIGRATION: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
