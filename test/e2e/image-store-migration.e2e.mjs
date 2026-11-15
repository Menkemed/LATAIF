// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER — Größenklassen für neue Uploads + Migration bestehender Bilder (Generationswechsel).
// Run: IM_SNAP=<snap-Ordner einer Sicherung> node scripts/e2e-diag-runner.mjs <out> test/e2e/image-store-migration.e2e.mjs
//
//   A  NEU      Uhr/Schmuck/Accessory über den PC2-Fernweg, Schmuck über Mobile → Hauptbild ≤ 60/30/30/30 KB, Vorschau ≤ 10 KB.
//   B  KOPIE    der Sicherung vom 10.11.2026 (NUR lataif.db + Medien) in den isolierten Testordner; Test-Owner-Passwort in der KOPIE.
//   C  SICHERUNG echter Snapshot-Host, VOR der Migration.
//   D  S1 warm  Primary + PC2 laden alle Karten (alte Fassungen im RAM-Cache).
//   E  PROBELAUF voll: Vorhersage, keine Zeile geändert.
//   F  LAUF 1    kooperativer Abbruch nach 40; Karten an Primary und PC2 zeigen keine alte Fassung.
//   G  LAUF 2    harter Absturz (eigene PID) mitten im Lauf; danach ist jede aktuelle Generation lesbar.
//   H  LAUF 3    Wiederaufnahme bis zum Ende; 4. Lauf idempotent; IDs/Zuordnungen/Artikelzeilen/Changelog/Audit unverändert.
//   I  ERGEBNIS  Größen je Klasse, Integrität, DB-Größe, Medienordner.
//   J  PC2       products.get nennt die neuen Schlüssel, /api/media liefert die neue Datei, die alte nicht mehr; Karten aktuell.
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
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.'); aufraeumen(); process.exit(1); }, 90 * 60 * 1000);

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
/** Aktuelle Hauptbild-Hashes (verknüpfte Artikel) und alle superseded-Hashes. */
function hashMengen() {
  const cur = new Set(dbQ(BIZ_DB, `${CUR} JOIN media_objects o ON o.master_blob_id = b.blob_id AND o.deleted_at IS NULL
      JOIN media_links l ON l.media_id = o.media_id AND l.deleted_at IS NULL AND l.entity_type = 'product'`).map((r) => r.h));
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
    c.ev('return window.__lataifImageMigrationProgress || null;')
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
  await p.ev('window.confirm = () => true; return 1;');
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

  // ── D · PRIMARY + PC2 auf der Kopie; Karten einmal laden (S1-Cache warm mit den ALTEN Bildern) ─────
  primary = await primaryStarten();
  TOKEN = await serverToken();
  client = await pc2Verbinden();
  for (const c of [primary, client]) { await c.send('Network.enable', { maxPostDataSize: 65536 }); await c.dialogeAnnehmen(); }
  const warmP = await kartenPruefen(primary, 'D Primary vorher');
  const warmC = await kartenPruefen(client, 'D PC2 vorher');
  ok(warmP.n > 50 && warmP.veraltet === 0 && warmC.n > 50, `D Karten vorher geladen (Primary ${warmP.n}, PC2 ${warmC.n})`);
  // Feste Stichprobe über die ECHTE Planungsfunktion (nur lesend): je Klasse einige Blobs über ihrer Grenze. Der volle Bestand
  // wird außerhalb der App gemessen (derselbe Encoder im Release-Build; die Bitgleichheit prüft J).
  const eng = await import(new URL('../../src/core/media/image-store-migration.ts', import.meta.url).href);
  const ro = new DatabaseSync(BIZ_DB, { readOnly: true });
  const adapter = { exec(sql, params = []) { const rows = ro.prepare(sql).all(...params); if (!rows.length) return []; const cols = Object.keys(rows[0]); return [{ columns: cols, values: rows.map((r) => cols.map((c) => r[c])) }]; }, run() { throw new Error('read-only'); } };
  const planAll = eng.planImageStoreMigration(adapter); ro.close();
  const QUOTE = { watch: 20, jewelry: 20, accessory: 12, repair: 10, other: 4, thumbnail: 20 };
  const sample = []; const per = {};
  for (const p of planAll.plans) { const k = p.rendition === 'thumbnail' ? 'thumbnail' : p.usageClass; if ((per[k] ?? 0) < (QUOTE[k] ?? 0)) { per[k] = (per[k] ?? 0) + 1; sample.push(p); } }
  const IDS = S(sample.map((p) => p.blobId));
  MESS.stichprobe = { plaene: planAll.plans.length, uebersprungen: planAll.skipped.length, gewaehlt: per };
  ok(sample.length >= 60 && per.watch && per.jewelry && per.accessory && per.thumbnail, `D Stichprobe ${S(per)} aus ${planAll.plans.length} Plänen`);
  const probe = {};
  for (const [k, uc] of [['uhr', 'watch'], ['schmuck', 'jewelry'], ['accessory', 'accessory']]) {
    for (const p of sample.filter((x) => x.rendition === 'main' && x.usageClass === uc)) {
      const r = dbQ(BIZ_DB, `SELECT l.entity_id AS id, g.storage_key AS k FROM media_links l JOIN media_objects o ON o.media_id = l.media_id AND o.deleted_at IS NULL
        JOIN media_blobs b ON b.blob_id = o.master_blob_id JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
       WHERE l.deleted_at IS NULL AND l.entity_type = 'product' AND o.master_blob_id = ? LIMIT 1`, [p.blobId])[0];
      if (r) { const d = await befehl('products.get', { id: r.id }, TOKEN); probe[k] = { id: r.id, blobId: p.blobId, ziel: p.targetBytes, altKey: r.k, keys: d.j?.value?.mediaKeys ?? [] }; break; }
    }
  }
  ok(Object.keys(probe).length === 3 && Object.values(probe).every((p) => p.keys.includes(p.altKey)), 'D PC2 (products.get) nennt vorher die alten Schlüssel');

  // ── E · PROBELAUF (Stichprobe) ──────────────────────────────────────────────────────────────────
  const dig0 = await mig(primary, 'm.digest()');
  const gens0 = dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations')[0]?.n;
  let t = Date.now();
  const dry = await mig(primary, `m.run({ mode: 'dry-run', onlyBlobIds: ${IDS} })`);
  MESS.probelauf = { eligible: dry.report.eligible, skipped: dry.report.skipped, failed: dry.report.failed, vorherKB: KB(dry.report.bytesBefore), nachherKB: KB(dry.report.bytesAfter), sek: Math.round((Date.now() - t) / 1000), sekJeBlob: +((Date.now() - t) / 1000 / sample.length).toFixed(1) };
  console.log('      PROBELAUF ' + S(MESS.probelauf));
  ok(dry.report.eligible >= sample.length * 0.8 && dry.report.switched === 0, `E Probelauf: ${dry.report.eligible}/${sample.length} umstellbar, ${KB(dry.report.bytesBefore)} KB → ${KB(dry.report.bytesAfter)} KB`);
  ok(S(await mig(primary, 'm.digest()')) === S(dig0) && dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations')[0]?.n === gens0, 'E Probelauf ändert keine Zeile');
  ok(dry.journal.every((e) => !/name|brand|customer|@/.test(S(e))), 'E Protokoll ohne Namen/Kunden (nur Kennungen und Zahlen)');

  // ── E2 · VORBEDINGUNG: offene Aufnahmen/Edit-Pläne blockieren jedes Schreiben (fail-closed) ─────────
  let digF = dig0;
  const offen = dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM media_ingest_jobs WHERE state NOT IN ('ready','failed','quarantined','expired')")[0]?.n ?? 0;
  MESS.offeneJobs = offen;
  if (offen > 0) {
    const nein = await mig(primary, `m.run({ mode: 'apply', onlyBlobIds: ${IDS} })`).then((r) => 'LIEF: ' + S(r?.report?.switched)).catch((e) => String(e?.message ?? e));
    ok(/open media ingest job/.test(nein) && dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations')[0]?.n === gens0,
      `E2 ${offen} offene Edit-Pläne in der Kopie → Lauf abgewiesen, nichts geschrieben`);
    // Nur in der TESTKOPIE: die alten Pläne enden (entspricht der späteren Owner-Bereinigung); App dafür sauber geschlossen.
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

  // ── F · LAUF 1: kooperativer Abbruch nach 25 Umstellungen ─────────────────────────────────────────
  t = Date.now();
  const r1 = await mig(primary, `m.run({ mode: 'apply', stopAfter: 25, saveEvery: 10, onlyBlobIds: ${IDS} })`);
  ok(r1.report.stoppedEarly && r1.report.switched === 25, `F Abbruch nach ${r1.report.switched} Umstellungen (${Math.round((Date.now() - t) / 1000)} s)`);
  ok(S(await mig(primary, 'm.digest()')) === S(digF), 'F Objekte/Links/Varianten/Artikelzeilen/Changelog/Audit unverändert');
  await sleep(1500);
  const zwischenP = await kartenPruefen(primary, 'F Primary nach Teil-Migration');
  const zwischenC = await kartenPruefen(client, 'F PC2 nach Teil-Migration');
  ok(zwischenP.veraltet === 0 && zwischenC.veraltet === 0 && zwischenP.aktuell === warmP.aktuell && zwischenC.aktuell === warmC.aktuell,
    `F S1: alle Karten zeigen die aktuelle Fassung, keine die alte (Primary ${zwischenP.aktuell}/${zwischenP.n}, PC2 ${zwischenC.aktuell}/${zwischenC.n}; ${zwischenP.n - warmP.aktuell} Altbestand-Daten-URLs ohne Mediengeneration)`);

  // ── G · LAUF 2: HARTER ABSTURZ mitten im Lauf (Prozess beendet), Neustart, Integrität ───────────────
  await primary.ev(`window.__imRun = window.__lataifImageMigration.run({ mode: 'apply', saveEvery: 10, onlyBlobIds: ${IDS} }); return 1;`);
  await warteAuf(async () => Number(await primary.ev('return window.__lataifImageMigrationProgress?.switched ?? 0;')) >= 15, 900000);
  const vorKill = Number(await primary.ev('return window.__lataifImageMigrationProgress?.switched ?? 0;'));
  pid = startedPids().find((p) => p && pathOfPid(p)?.toLowerCase() === APP.toLowerCase()) ?? startedPids()[0];
  killTestPid(pid, APP);
  primary.close(); primary = null;
  await waitTestImageGone('lataif.exe');
  ok(true, `G Primary mitten im Lauf hart beendet (nach ${vorKill} Umstellungen dieses Laufs)`);
  const intKill = integritaet();
  ok(intKill.bad === 0 && intKill.missing <= intVorher.missing, `G nach dem Absturz: jede aktuelle Generation ist lesbar (fehlend ${intKill.missing} wie vorher ${intVorher.missing}, falsch ${intKill.bad})`);
  const nachKillGen2 = dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM media_blob_generations WHERE generation_no > 1')[0]?.n;
  primary = await primaryStarten();
  TOKEN = await serverToken();

  // ── H · LAUF 3: Wiederaufnahme bis zum Ende ───────────────────────────────────────────────────────
  const dig3 = await mig(primary, 'm.digest()');
  t = Date.now();
  const r3 = await mig(primary, `m.run({ mode: 'apply', saveEvery: 10, onlyBlobIds: ${IDS} })`);
  MESS.lauf3 = { gespeichertVorAbsturz: nachKillGen2, switched: r3.report.switched, failed: r3.report.failed, sek: Math.round((Date.now() - t) / 1000), skipped: r3.report.skipped, errors: r3.report.errors.map((e) => e.code) };
  console.log('      LAUF 3 ' + S(MESS.lauf3));
  ok(!r3.report.stoppedEarly && r3.report.eligible === r3.report.switched && r3.report.failed === 0, `H Wiederaufnahme: Rest umgestellt (${r3.report.switched}), Fehler ${r3.report.failed}`);
  const r4 = await mig(primary, `m.run({ mode: 'apply', onlyBlobIds: ${IDS} })`);
  ok(r4.report.switched === 0 && r4.report.eligible === 0, 'H vierter Lauf: nichts mehr zu tun (idempotent)');
  ok(S(await mig(primary, 'm.digest()')) === S(dig3), 'H Objekte/Links/Varianten/Artikelzeilen (pHash, Embedding)/Changelog/Audit unverändert');
  ok(['media_objects', 'media_links_active', 'media_variants', 'media_blobs', 'links_sig', 'objects_sig', 'variants_sig', 'products', 'products_media_sig'].every((k) => dig3[k] === dig0[k]),
    'H über alle Läufe und den Absturz hinweg: Medien-IDs und Zuordnungen identisch');
  await sleep(2000);

  // ── I · ERGEBNIS: Größen der Stichprobe, Integrität, Speicher ───────────────────────────────────────
  const stand = sample.map((p) => ({ p, c: dbQ(BIZ_DB, `SELECT b.current_generation_no AS gen, g.byte_size AS s FROM media_blobs b JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no WHERE b.blob_id = ?`, [p.blobId])[0] }));
  const um = stand.filter((x) => x.c.gen > 1);
  const zuGross = um.filter((x) => x.c.s > x.p.targetBytes);
  const jeKlasse = {};
  for (const x of um) { const k = x.p.rendition === 'thumbnail' ? 'vorschau' : x.p.usageClass; const o = (jeKlasse[k] ??= { n: 0, vorherKB: 0, nachherKB: 0, maxKB: 0 }); o.n++; o.vorherKB += x.p.currentBytes / 1000; o.nachherKB += x.c.s / 1000; o.maxKB = Math.max(o.maxKB, x.c.s / 1000); }
  for (const o of Object.values(jeKlasse)) { o.vorherKB = Math.round(o.vorherKB); o.nachherKB = Math.round(o.nachherKB); o.maxKB = +o.maxKB.toFixed(1); }
  MESS.nachher = { medien: ordnerGroesse(MEDIA), dbMB: +(statSync(BIZ_DB).size / 1e6).toFixed(1), integritaet: integritaet(), stichprobe: { umgestellt: um.length, nicht: stand.length - um.length, jeKlasse },
    generationen: dbQ(BIZ_DB, 'SELECT gen_status AS s, COUNT(*) AS n, ROUND(SUM(byte_size)/1e6,2) AS mb FROM media_blob_generations GROUP BY 1'), ausweis: klassen().ausweis };
  console.log('      NACHHER ' + S(MESS.nachher));
  ok(MESS.nachher.integritaet.bad === 0 && MESS.nachher.integritaet.missing === intVorher.missing, `I Integrität: jede aktuelle Generation stimmt (fehlend wie vorher: ${intVorher.missing})`);
  ok(zuGross.length === 0 && um.length === dry.report.eligible, `I Stichprobe: ${um.length} umgestellt = Vorhersage ${dry.report.eligible}, keine über ihrer Grenze (${S(jeKlasse)})`);
  ok((MESS.nachher.ausweis?.gen2 ?? 0) === 0, 'I Ausweis unverändert (Generation 1)');
  ok(MESS.nachher.dbMB - MESS.vorher.dbMB < 1.0, `I Datenbank wächst kaum (${MESS.vorher.dbMB} → ${MESS.nachher.dbMB} MB)`);

  // ── J · PC2 + Primary zeigen dieselbe aktuelle Generation ─────────────────────────────────────────
  for (const [k, p] of Object.entries(probe)) {
    const d = await befehl('products.get', { id: p.id }, TOKEN);
    const keys = d.j?.value?.mediaKeys ?? [];
    const curKey = dbQ(BIZ_DB, `SELECT g.storage_key AS k FROM media_blobs b JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no WHERE b.blob_id = ?`, [p.blobId])[0]?.k;
    const neuR = await fetch(`http://127.0.0.1:${PORT}/api/media?key=${encodeURIComponent(curKey)}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    const neuB = Buffer.from(await neuR.arrayBuffer());
    const altR = await fetch(`http://127.0.0.1:${PORT}/api/media?key=${encodeURIComponent(p.altKey)}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
    ok(keys.includes(curKey) && !keys.includes(p.altKey) && curKey !== p.altKey, `J ${k}: PC2 nennt den NEUEN Schlüssel, nicht mehr den alten`);
    ok(neuR.status === 200 && createHash('sha256').update(neuB).digest('hex') === sha256f(join(MEDIA, curKey)), `J ${k}: /api/media liefert die neue Datei (${neuB.length} B)`);
    ok(altR.status !== 200, `J ${k}: die alte Fassung wird nicht mehr ausgeliefert (${altR.status})`);
    ok(existsSync(join(MEDIA, p.altKey)), `J ${k}: die alte Datei liegt noch (keine Löschung)`);
    // Nachbau-Abgleich (nur wenn vorhanden): derselbe Encoder außerhalb der App muss bitgleich rechnen.
    if (process.env.IM_RECODE && existsSync(process.env.IM_RECODE)) {
      const out = join(RUN, `recode-${k}.jpg`);
      execFileSync(process.env.IM_RECODE, [join(SNAP, p.altKey), out, '1600', '320', String(p.ziel)], { encoding: 'utf8' });
      ok(sha256f(out) === sha256f(join(MEDIA, curKey)), `J ${k}: Nachbau-Encoder rechnet bitgleich mit dem App-Code`);
    }
  }
  client = await pc2Anmelden(client).catch(async () => { try { client?.close(); } catch { /* zu */ } return pc2Anmelden(await attachOnly(CLIENT_CDP)); });
  await client.send('Network.enable', { maxPostDataSize: 65536 }).catch(() => null);
  await primary.send('Network.enable', { maxPostDataSize: 65536 }); await primary.dialogeAnnehmen();
  const endeP = await kartenPruefen(primary, 'J Primary nachher');
  const endeC = await kartenPruefen(client, 'J PC2 nachher');
  ok(endeP.veraltet === 0 && endeC.veraltet === 0 && endeP.aktuell === warmP.aktuell && endeC.aktuell === warmC.aktuell,
    `J S1/S2: alle geladenen Karten zeigen die aktuelle Generation (Primary ${endeP.aktuell}/${endeP.n}, PC2 ${endeC.aktuell}/${endeC.n})`);

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
  const intRest = integritaet();
  ok(maxGen === 1 && intRest.bad === 0 && intRest.missing === intVorher.missing && intRest.n === intVorher.n, `L Stand vor der Migration zurück: nur Generation 1, alle Dateien stimmen (${S(intRest)})`);
  primary = await primaryStarten();
  const dr = await mig(primary, 'm.digest()');
  ok(['media_objects', 'media_links_active', 'media_variants', 'links_sig', 'products_media_sig'].every((k) => dr[k] === dig0[k]), 'L App startet auf dem wiederhergestellten Stand, Zuordnungen wie vorher');
  const rp = await kartenPruefen(primary, 'L Primary nach Wiederherstellung');
  ok(rp.n > 50 && rp.veraltet === 0 && rp.aktuell === warmP.aktuell, `L Karten zeigen wieder die Originale (${rp.aktuell}/${rp.n})`);
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
