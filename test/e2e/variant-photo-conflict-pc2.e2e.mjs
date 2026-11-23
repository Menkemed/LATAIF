// ════════════════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN — letzter Sicherheitsfix: eine OFFENE Artikelmaske überschreibt nie ein inzwischen per „Merge photos"
// verknüpftes gemeinsames Bild. Primary und PC2 nebeneinander, echte Maus.
// Run: node test/e2e/variant-photo-conflict-pc2.e2e.mjs
//   (nach `npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e-client.conf.json`,
//    Kopie nach lataif-e2e-client.exe, dann `… --config src-tauri/tauri.e2e.conf.json`, und den Beispielen)
//
//   P  Maske am PRIMARY offen (Variante B, neues Foto gewählt) — PC2 führt „Merge photos" aus (A-Bild → B).
//      Speichern am Primary: nichts gespeichert, klare Meldung, Maske lädt die echte Galerie (mit dem gemeinsamen Bild);
//      danach dasselbe Foto erneut: gespeichert, das gemeinsame Bild bleibt an A und B.
//   O  Maske am PC2 offen (Variante C, neues Foto gewählt) — der PRIMARY führt „Merge photos" aus (A-Bild → C).
//      Speichern am PC2: abgewiesen (bestehende Standprüfung), das gemeinsame Bild bleibt; neu öffnen, speichern: klappt.
//   Mit LATAIF_E2E_OLD_PC2=1 läuft nur O — für den alten PC2 v0.8.101 (im Probe-Checkout, Client aus dem Tag).
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am
// EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { maus, mausText, tippe } from './_e2e-mouse.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const NUR_ALTER_PC2 = process.env.LATAIF_E2E_OLD_PC2 === '1';
const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'vk-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-vkconflict', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.'); aufraeumen(); process.exit(1); }, 30 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env, APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'), LATAIF_E2E_SYNC_PORT: String(PORT),
});
function dbQ(sql, params = []) {
  let db;
  try { db = new DatabaseSync(BIZ_DB, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const zahl = (sql, p = []) => Number(dbQ(sql, p)[0]?.n ?? -1);
const galerie = (pid) => dbQ(`SELECT media_id FROM media_links WHERE entity_type='product' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order`, [pid]).map((r) => r.media_id);
const medien = () => zahl('SELECT COUNT(*) AS n FROM media_objects');
const dateien = () => zahl('SELECT COUNT(*) AS n FROM media_blob_generations');
const verweise = (mid) => zahl(`SELECT COUNT(*) AS n FROM media_links WHERE media_id = ? AND deleted_at IS NULL`, [mid]);

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
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
  const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); await c.send('DOM.enable'); return c;
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
async function warteBis(c, ausdruck, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); } return false; }
async function warteAuf(pruefe, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (pruefe()) return true; await sleep(400); } return pruefe(); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); } throw new Error('no invoke'); }
const SHELL = 'a[href="/settings"]';
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1500); }
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const q = (sel) => `document.querySelector(${S(sel)})`;
const alleOk = (r) => (r.every((x) => x === 'OK') ? 'OK' : r.join(' | '));
/** Markiert das Element, das ein JS-Ausdruck findet, und klickt es mit der echten Maus. */
async function mausAuf(c, findeJs, name) {
  const da = await c.ev(`document.querySelectorAll('[data-e2e-ziel]').forEach(x=>x.removeAttribute('data-e2e-ziel')); const e=(()=>{ ${findeJs} })(); if(!e) return false; e.setAttribute('data-e2e-ziel','1'); return true;`);
  if (!da) return 'FEHLT:' + name;
  return maus(c, '[data-e2e-ziel]');
}
const chipIn = (box, text) => `const b=document.querySelector(${S(box)}); return b ? [...b.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}) : null;`;
/** Tippt mit der echten Tastatur in das Eingabefeld, das ein JS-Ausdruck findet. */
async function tippeIn(c, findeJs, wert, name) {
  const da = await c.ev(`document.querySelectorAll('[data-e2e-feld]').forEach(x=>x.removeAttribute('data-e2e-feld')); const e=(()=>{ ${findeJs} })(); if(!e) return false; e.setAttribute('data-e2e-feld','1'); return true;`);
  if (!da) return 'FEHLT:' + name;
  return tippe(c, '[data-e2e-feld]', wert);
}
const inputUnterLabel = (label) => `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop(); return l ? l.parentElement.querySelector('input,textarea') : null;`;

// Fernaufträge mitschreiben, Dialoge abfangen.
const HAKEN = `
  if (!window.__vkHaken) {
    window.__vkHaken = true; window.__cmds = []; window.__alerts = [];
    window.alert = (m) => { window.__alerts.push(String(m)); };
    window.confirm = () => true;
    const of = window.fetch;
    window.fetch = async (...a) => {
      let url = ''; try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
      if (/\\/api\\/command$/.test(url)) { try { const b = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: b.op }); } catch (e) { /* egal */ } }
      return of(...a);
    };
  }
`;
async function hakenLegen(c) {
  await c.send('Page.enable', {});
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: HAKEN });
  await c.ev(HAKEN + ' return 1;');
}
const befehle = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));

// ── Testbilder: echte, verschiedene PNG-Dateien ─────────────────────────────
function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function pngFile(name, rgb) {
  const w = 64, h = 48; const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const ring = Math.abs(Math.hypot(x - 32, (y - 24) * 1.3) - 16) < 4; raw[o] = ring ? 200 : rgb[0]; raw[o + 1] = ring ? 160 : rgb[1]; raw[o + 2] = ring ? 60 : rgb[2]; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const p = join(RUN, name); writeFileSync(p, png); return p;
}
// Die Bilder der Bearbeitungsmaske (Galerie + neu gewählte); das ERSTE Dateifeld dort fügt hinzu.
const MASKE = '[data-product-images]';
const maskenBilder = (c) => c.ev(`return document.querySelectorAll(${S(MASKE + ' img')}).length;`);
async function fotoWaehlen(c, path) {
  const vorher = await maskenBilder(c);
  for (let versuch = 0; versuch < 2; versuch++) {
    const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(MASKE + ' input[type=file][accept="image/*"]')})`, returnByValue: false });
    if (!r.result?.objectId) return 'KEIN-DATEIFELD';
    await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] });
    const end = Date.now() + 15000;
    while (Date.now() < end) { if ((await maskenBilder(c)) > vorher) return 'OK'; await sleep(400); }
    await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [] });
    await sleep(500);
  }
  return 'FOTO-NICHT-UEBERNOMMEN';
}
/** Artikel öffnen, „Edit" (echte Maus), warten bis die Fotos aus der echten Galerie stammen. */
async function bearbeiten(c, pid, bilder) {
  await gehFrisch(c, `/collection/${pid}`);
  if (!(await warteBis(c, `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Edit')`, 30000))) return 'KEIN-EDIT';
  const r = await mausText(c, 'Edit');
  if (r !== 'OK') return 'EDIT:' + r;
  if (!(await warteBis(c, `document.querySelector('[data-product-images="ready"]') && document.querySelectorAll(${S(MASKE + ' img')}).length === ${bilder}`, 30000))) {
    return 'GALERIE-NICHT-BEREIT:' + await maskenBilder(c);
  }
  return 'OK';
}
async function speichern(c) { return maus(c, '[data-save-product]'); }
const fehlerText = (c) => c.ev(`return document.querySelector('[data-save-error]')?.textContent || '';`);
const maskeZu = (c) => warteBis(c, `!document.querySelector('[data-save-product]')`, 40000);
/** „Merge photos" im Modell-Abschnitt von `vonPid`: Bild `pick` auf genau `ziele` (echte Maus). */
async function mergePhotos(c, vonPid, pick, ziele) {
  await gehFrisch(c, `/collection/${vonPid}`);
  const r = [];
  r.push((await warteBis(c, q('[data-model-merge-photos]'), 30000)) ? 'OK' : 'KEIN-MERGE-KNOPF');
  r.push(await maus(c, '[data-model-merge-photos]'));
  r.push((await warteBis(c, q(`[data-merge-pick="${pick}"]`), 20000)) ? 'OK' : 'KEINE-BILDER');
  r.push(await mausAuf(c, `return document.querySelector('[data-merge-pick="${pick}"] input');`, 'Bildwahl'));
  await sleep(500);
  // Nur die gewünschten Ziele angehakt lassen.
  const haken = JSON.parse(await c.ev(`return JSON.stringify([...document.querySelectorAll('[data-merge-target]')].map(x=>({ id: x.getAttribute('data-merge-target'), an: x.checked, frei: !x.disabled })));`));
  for (const h of haken) {
    if (h.frei && h.an !== ziele.includes(h.id)) r.push(await maus(c, `[data-merge-target="${h.id}"]`));
  }
  r.push(await maus(c, '[data-merge-open-confirm]'));
  r.push((await warteBis(c, q('[data-merge-ack]'), 10000)) ? 'OK' : 'KEINE-BESTAETIGUNG');
  r.push(await maus(c, '[data-merge-ack]'));
  r.push(await maus(c, '[data-merge-confirm]'));
  r.push((await warteBis(c, q('[data-merge-done]'), 30000)) ? 'OK' : 'KEIN-ERGEBNIS');
  await mausText(c, 'Close').catch(() => null); await sleep(600);
  return alleOk(r);
}

// ── Testdaten: drei Varianten eines Modells, eigene Kategorie, ohne Fotos (die kommen über die echte Maske) ──────
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
const A = 'vk-a', B = 'vk-b', C = 'vk-c', MODELL = 'model-vk-e2e';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'cat-vk', branch_id, name: 'Variant Bracelets', icon: 'Gem', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    for (const [id, sku] of [[A, 'VK-16'], [B, 'VK-17'], [C, 'VK-18']]) {
      insert(db, 'products', { id, branch_id, category_id: 'cat-vk', brand: 'Cartier', name: 'Love Bracelet', sku, condition: 'Pre-Owned', scope_of_delivery: '[]',
        purchase_price: 2500, purchase_currency: 'BHD', planned_sale_price: 4000, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 1,
        images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, unit_cost: 2500, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
      db.prepare('INSERT INTO product_models (product_id, model_key) VALUES (?, ?)').run(id, MODELL);
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));
  console.log(NUR_ALTER_PC2 ? '  (nur Teil O — alter PC2)' : '  (Teile P und O)');
  const FOTO = { a: pngFile('a.png', [240, 236, 228]), b: pngFile('b.png', [222, 232, 242]), c: pngFile('c.png', [236, 242, 226]), c2: pngFile('c2.png', [250, 220, 220]), d: pngFile('d.png', [210, 250, 230]) };

  // ── Einrichten ───────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'VK Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'VK Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'VK Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null); await sleep(1200);
  const onboardingPid = startedPids().pop();
  primary.close(); primary = null;
  await closeTestWindow(onboardingPid, APP); await waitTestImageGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await hakenLegen(primary);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ } await sleep(500); }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await klick(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await klick(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  await hakenLegen(client);
  ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SETUP PC2 ohne Geschäftsdatenbank, angemeldet');
  ok(zahl(`SELECT COUNT(*) AS n FROM product_models WHERE model_key = ?`, [MODELL]) === 3, 'SETUP drei Varianten in einem Modell');

  // A und C bekommen ihr eigenes Foto über die echte Maske am Primary (B bleibt ohne Foto).
  for (const [pid, foto] of [[A, FOTO.a], [C, FOTO.c]]) {
    const r = [await bearbeiten(primary, pid, 0)];
    r.push(await fotoWaehlen(primary, foto));
    r.push(await speichern(primary));
    r.push((await maskeZu(primary)) ? 'OK' : 'MASKE-OFFEN:' + await fehlerText(primary));
    r.push((await warteAuf(() => galerie(pid).length === 1, 20000)) ? 'OK' : 'KEIN-BILD');
    ok(alleOk(r) === 'OK', `SETUP ${pid} hat ein eigenes Foto (echte Maus) (${alleOk(r)})`);
  }
  const fa = galerie(A)[0], ownC = galerie(C)[0];

  // ── P  Maske am PRIMARY offen, PC2 führt „Merge photos" aus ────────────────────────────────────────────
  if (!NUR_ALTER_PC2) {
    const r0 = [await bearbeiten(primary, B, 0)];
    r0.push(await fotoWaehlen(primary, FOTO.b));
    r0.push(await tippeIn(primary, inputUnterLabel('SALE PRICE (BHD)'), '4400', 'Sale'));
    ok(alleOk(r0) === 'OK' && await primary.ev(`return document.querySelector('[data-product-images]')?.getAttribute('data-product-images-dirty');`) === '1',
      `P1 Primary: Maske von B offen, neues Foto gewählt und Preis 4400 getippt, noch nicht gespeichert (${alleOk(r0)})`);
    const rm = await mergePhotos(client, A, fa, [B]);
    ok(rm === 'OK' && await warteAuf(() => galerie(B).join() === fa, 20000) && galerie(C).join() === ownC,
      `P2 PC2: „Merge photos" (echte Maus) verknüpft das A-Bild mit B, C unverändert (${rm})`);
    await sleep(2500);   // der Primary lädt B neu (geänderter Stand) — die Eingabe muss stehen bleiben
    const preisFeld = () => primary.ev(`const l=[...document.querySelectorAll('label')].find(x=>x.textContent.trim()==='SALE PRICE (BHD)'); return l ? l.parentElement.querySelector('input').value : null;`);
    ok(await preisFeld() === '4400', `P2b das Neuladen von B lässt die getippte Eingabe stehen (Feld: ${await preisFeld()})`);
    const m0 = medien(), d0 = dateien();
    const rs = await speichern(primary);
    const meldung = (await warteBis(primary, q('[data-save-error]'), 20000)) ? await fehlerText(primary) : '';
    ok(rs === 'OK' && /changed elsewhere while this form was open/i.test(meldung) && /Nothing was saved/i.test(meldung),
      `P3 Primary speichert auf altem Stand: klare Meldung, nichts gespeichert („${meldung.slice(0, 90)}…")`);
    await sleep(1500);
    ok(galerie(B).join() === fa && galerie(A).join() === fa && verweise(fa) === 2, 'P4 das gemeinsame Bild bleibt an A und B (zwei aktive Verweise)');
    ok(medien() === m0 && dateien() === d0 && Number(dbQ('SELECT planned_sale_price AS p FROM products WHERE id = ?', [B])[0]?.p) === 4000,
      `P5 nichts gespeichert: kein neues Medium, keine Datei, Preis unverändert (${medien()}/${m0}, ${dateien()}/${d0})`);
    const liste = await primary.ev(`return JSON.stringify({ felder: [...document.querySelectorAll('[data-edit-pending-field]')].map(x=>x.getAttribute('data-edit-pending-field')), fotos: document.querySelector('[data-edit-pending-photos]')?.getAttribute('data-edit-pending-photos') || '' });`);
    ok(/plannedSalePrice/.test(liste) && /"fotos":"1"/.test(liste), `P6 Hinweis: der Preis und 1 neues Foto sind als ungespeichert aufgeführt (${liste})`);
    const neu = await warteBis(primary, `document.querySelector('[data-product-images="ready"]') && document.querySelector('[data-product-images]').getAttribute('data-product-images-dirty') === '1' && document.querySelectorAll(${S(MASKE + ' img')}).length === 2`, 30000);
    ok(neu && await preisFeld() === '4400' && await exists(primary, '[data-save-product]'),
      'P6b die Maske zeigt die echte Galerie (gemeinsames Bild) mit dem wartenden neuen Foto dahinter, der Preis steht noch');
    const r1 = [await speichern(primary)];
    r1.push((await maskeZu(primary)) ? 'OK' : 'MASKE-OFFEN:' + await fehlerText(primary));
    r1.push((await warteAuf(() => galerie(B).length === 2, 20000)) ? 'OK' : 'NICHT-GESPEICHERT');
    ok(alleOk(r1) === 'OK' && galerie(B)[0] === fa && galerie(A).join() === fa && verweise(fa) === 2
      && Number(dbQ('SELECT planned_sale_price AS p FROM products WHERE id = ?', [B])[0]?.p) === 4400,
      `P7 ein Klick auf Save übernimmt alles: B = gemeinsames Bild + neues Foto, Preis 4400, A unverändert (${alleOk(r1)})`);
    ok((await befehle(client)).some((x) => x.op === 'product_models.merge_photos'), 'P8 PC2 hat über den Primary gemerged (product_models.merge_photos)');
    // Dasselbe Foto entfernen und erneut wählen (ImageUpload leert das Dateifeld nach dem Einlesen).
    const r2 = [await bearbeiten(primary, B, 2), await fotoWaehlen(primary, FOTO.d)];
    r2.push(await mausAuf(primary, `return [...document.querySelectorAll(${S(MASKE + ' .relative')})].pop()?.querySelector('button:not([title])');`, 'Entfernen'));
    r2.push((await warteBis(primary, `document.querySelectorAll(${S(MASKE + ' img')}).length === 2`, 10000)) ? 'OK' : 'NICHT-ENTFERNT');
    r2.push(await fotoWaehlen(primary, FOTO.d));
    ok(alleOk(r2) === 'OK' && await maskenBilder(primary) === 3, `P9 dieselbe Datei nach dem Entfernen erneut gewählt: wird übernommen (${alleOk(r2)})`);
    await mausText(primary, 'Cancel').catch(() => null); await sleep(800);
  }

  // ── V  „Add variant" am PC2 mit dem Modellfoto: ein Auftrag, Zuordnung + derselbe Medienverweis ────────────────────
  if (!NUR_ALTER_PC2) {
    const vorher = new Set(dbQ('SELECT id FROM products').map((x) => x.id));
    const m0 = medien(), d0 = dateien();
    await gehFrisch(client, `/collection/${A}`);
    const r = [(await warteBis(client, q('[data-model-add-variant]'), 30000)) ? 'OK' : 'KEIN-KNOPF'];
    r.push(await maus(client, '[data-model-add-variant]'));
    r.push((await warteBis(client, q('[data-variant-hint]'), 30000)) ? 'OK' : 'KEIN-VARIANTEN-MODUS');
    const reuse = await client.ev(`return !!document.querySelector('[data-variant-reuse-photo] input')?.checked;`);
    r.push(await mausAuf(client, chipIn('#new-field-taxScheme', 'Margin'), 'Margin'));
    r.push(await tippeIn(client, inputUnterLabel('SALE PRICE (BHD)'), '4100', 'Sale'));
    r.push(await maus(client, '[data-create-product]'));
    const zu = await warteBis(client, `!document.querySelector('#new-field-categoryId')`, 60000);
    let neu = null;
    await warteAuf(() => { neu = dbQ('SELECT id FROM products').map((x) => x.id).find((id) => !vorher.has(id)) || null; return !!neu; }, 30000);
    if (!zu || !neu) console.log('      Maske: ' + S(await client.ev(`return document.body.innerText.slice(0, 400);`)));
    await warteAuf(() => !!neu && galerie(neu).length === 1, 15000);
    ok(alleOk(r) === 'OK' && reuse && zu && !!neu && zahl(`SELECT COUNT(*) AS n FROM product_models WHERE product_id = ? AND model_key = ?`, [neu, MODELL]) === 1,
      `V1 PC2 „Add variant" (echte Maus): angelegt und dem Modell zugeordnet (${alleOk(r)}, Modellfoto vorgewählt: ${reuse})`);
    ok(!!neu && galerie(neu).join() === fa && medien() === m0 && dateien() === d0,
      `V2 das Modellfoto wird verwendet — dasselbe Medium, keine neue Datei (${neu ? galerie(neu).join() : '-'}; ${medien()}/${m0}, ${dateien()}/${d0})`);
    ok((await befehle(client)).filter((x) => x.op === 'products.create').length === 1, 'V3 EIN Auftrag products.create (mit der Variante im Rumpf)');
  }

  // ── O  Maske am PC2 offen, der PRIMARY führt „Merge photos" aus ────────────────────────────────────────
  {
    const r0 = [await bearbeiten(client, C, 1)];
    r0.push(await fotoWaehlen(client, FOTO.c2));
    if (!NUR_ALTER_PC2) r0.push(await tippeIn(client, inputUnterLabel('SALE PRICE (BHD)'), '4500', 'Sale'));
    ok(alleOk(r0) === 'OK', `O1 PC2: Maske von C offen, neues Foto gewählt${NUR_ALTER_PC2 ? '' : ', Preis 4500 getippt'} (${alleOk(r0)})`);
    const rm = await mergePhotos(primary, A, fa, [C]);
    ok(rm === 'OK' && await warteAuf(() => galerie(C).join() === [fa, ownC].join(), 20000), `O2 Primary: „Merge photos" (echte Maus) — C zeigt das gemeinsame Bild vorn (${rm})`);
    const m0 = medien(), vorC = galerie(C).join();
    const rs = await speichern(client);
    const meldung = (await warteBis(client, q('[data-save-error]'), 30000)) ? await fehlerText(client) : '';
    await sleep(1500);
    ok(rs === 'OK' && /changed after this form was opened|changed elsewhere while this form was open/i.test(meldung) && /not saved|Nothing was saved/i.test(meldung)
      && galerie(C).join() === vorC && verweise(fa) >= 2,
      `O3 PC2 speichert auf altem Stand: abgewiesen (bestehende Standprüfung), das gemeinsame Bild bleibt („${meldung.slice(0, 90)}")`);
    ok(medien() === m0 && Number(dbQ('SELECT planned_sale_price AS p FROM products WHERE id = ?', [C])[0]?.p) === 4000, `O4 nichts gespeichert (${medien()}/${m0})`);
    let r1;
    if (NUR_ALTER_PC2) {
      // Alter PC2 (v0.8.101): bisheriger Weg — schließen, neu öffnen, erneut wählen.
      await mausText(client, 'Cancel').catch(() => null); await sleep(800);
      r1 = [await bearbeiten(client, C, 2), await fotoWaehlen(client, FOTO.c2), await speichern(client)];
    } else {
      // Neuer PC2: die Maske hat neu geladen, Preis und neues Foto stehen noch — EIN Klick auf Save.
      const preisC = () => client.ev(`const l=[...document.querySelectorAll('label')].find(x=>x.textContent.trim()==='SALE PRICE (BHD)'); return l ? l.parentElement.querySelector('input').value : null;`);
      const bereit = await warteBis(client, `document.querySelector('[data-product-images="ready"]') && document.querySelector('[data-product-images]').getAttribute('data-product-images-dirty') === '1' && document.querySelectorAll(${S(MASKE + ' img')}).length === 3`, 30000);
      const liste = await client.ev(`return [...document.querySelectorAll('[data-edit-pending-field]')].map(x=>x.getAttribute('data-edit-pending-field')).join(',');`);
      ok(bereit && await preisC() === '4500' && /plannedSalePrice/.test(liste),
        `O4b PC2: aktuelle Galerie (gemeinsam + eigen) mit wartendem neuen Foto, Preis 4500 steht, als ungespeichert aufgeführt (${liste})`);
      r1 = [await speichern(client)];
    }
    r1.push((await maskeZu(client)) ? 'OK' : 'MASKE-OFFEN:' + await fehlerText(client));
    r1.push((await warteAuf(() => galerie(C).length === 3, 30000)) ? 'OK' : 'NICHT-GESPEICHERT');
    ok(alleOk(r1) === 'OK' && galerie(C)[0] === fa && galerie(C)[1] === ownC && galerie(A).join() === fa
      && (NUR_ALTER_PC2 || Number(dbQ('SELECT planned_sale_price AS p FROM products WHERE id = ?', [C])[0]?.p) === 4500),
      `O5 gespeichert: C = gemeinsames + eigenes + neues Bild${NUR_ALTER_PC2 ? '' : ', Preis 4500'}, A unverändert (${alleOk(r1)})`);
    ok((await befehle(client)).filter((x) => x.op === 'products.update').length >= 2, 'O6 PC2 speichert über products.update (Primary == PC2)');
  }
  ok(zahl(`SELECT COUNT(*) AS n FROM product_models WHERE model_key = ?`, [MODELL]) === (NUR_ALTER_PC2 ? 3 : 4), 'ENDE die Gruppierung ist vollständig (A, B, C und ggf. die neue Variante)');
  ok((await client.ev('return window.__alerts.length;')) === 0 && (await primary.ev('return window.__alerts.length;')) === 0, 'ENDE keine Fehler-Dialoge');
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nVARIANT-PHOTO-CONFLICT PC2${NUR_ALTER_PC2 ? ' (alter PC2)' : ''}: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
