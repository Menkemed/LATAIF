// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5B — Artikel und Kommission anlegen, vom zweiten Rechner, MIT Bild.
// Run: node test/e2e/r5b-create-parity.e2e.mjs
//
// Dieselbe Anlegemaske wie am Primary, auf einem Rechner OHNE Datenbank:
//
//   /collection   „New Item"          → Bild in die Zwischenablage → products.create
//   /consignments „New Consignment"   → Bild in die Zwischenablage → consignments.create
//
// Bewiesen wird: genau ein Artikel (und genau eine Kommission), alle Eingaben kommen an, die
// Filiale und die Nummer bestimmt der Primary, das Bild liegt im Medienspeicher (nicht als Text in
// der Zeile) und ist auf beiden Rechnern sichtbar, eine verlorene Antwort erzeugt nichts doppelt,
// und die Kommission vom zweiten Rechner hat DIESELBE Wirkung wie die an der Maske des Primary.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r5b-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5b-create', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);
const PHOTO = join(RUN, 'r5b-photo.png');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif-e2e-client.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  process.exit(1);
}, 25 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env,
  APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'),
  LATAIF_E2E_SYNC_PORT: String(PORT),
});
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}

/** Ein echtes Foto — ein PNG, das der Browser dekodieren und die Maske verkleinern kann. */
function writePhoto(file) {
  const w = 96, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 5) & 0xff; raw[o + 1] = (y * 7) & 0xff; raw[o + 2] = 140;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

const killImage = (n) => { try { execFileSync('taskkill', ['/F', '/IM', n, '/T'], { stdio: 'ignore' }); } catch { /* war nicht da */ } };
const killAll = () => { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); };
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const o = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!o.includes(name)) return; } catch { return; }
    await sleep(300);
  }
}
async function attachOnly(cdpPort, budget = 60000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attach(cdpPort, exe, env) {
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
/** Ein Feld über seine Beschriftung — so, wie ein Mensch es findet. */
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL'; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
/** Ein Foto in die Bildauswahl der offenen Maske legen — über den Dateidialog-Weg des Browsers. */
async function fotoWaehlen(c, file) {
  await c.send('DOM.enable', {});
  const { root } = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"]' });
  if (!nodeIds || nodeIds.length === 0) return 'KEIN-FELD';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] });
  return 'OK';
}
const SHELL = 'a[href="/settings"]';

/** Der Beobachter — er lebt im TEST und liegt vor dem ersten Skript der Seite. */
const BEOBACHTER = `
  if (window.__r4bInstalliert) { /* schon da */ } else {
  window.__r4bInstalliert = true;
  window.__cmds = [];
  window.__staged = [];
  window.__killNext = false;
  window.__killed = 0;
  window.__dbHits = [];
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => {
    const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/Database not initialized/.test(t)) merke(t);
    oe(...a);
  };
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/\\/api\\/staging\\/media$/.test(url)) window.__staged.push(Date.now());
    if (/\\/api\\/command$/.test(url)) {
      try {
        const body = JSON.parse((a[1] && a[1].body) || '{}');
        window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload });
      } catch (e) { /* kein lesbarer Rumpf */ }
      if (window.__killNext) {
        window.__killNext = false;
        window.__killed++;
        const r = await of(...a);          // der Primary bekommt sie WIRKLICH
        try { await r.text(); } catch (e) { /* egal */ }
        throw new TypeError('the answer was lost after the primary had written');
      }
    }
    return of(...a);
  };
  }
`;

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
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`)
    .run(...nutzbar.map((k) => daten[k]));
}

function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    // Eine eigene Kategorie ohne Pflichtattribute — die Pflichtfeldregel des Hauses gilt trotzdem:
    // Marke und Name sind hier Pflicht.
    insert(db, 'categories', { id: 'cat-r5b', branch_id, name: 'R5B Plain', icon: 'watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'r5b-cons', branch_id, first_name: 'Nadia', last_name: 'Einlieferer', company: 'R5B Co', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch (e) { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const ablagen = (c) => c.ev('return (window.__staged || []).length;');
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  writePhoto(PHOTO);
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary ────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5B Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5B Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5B Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  primary.close(); primary = null;
  killImage('lataif.exe'); await waitGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 90000);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }
  const HAUS = dbQ(BIZ_DB, 'SELECT id FROM branches LIMIT 1')[0]?.id;

  // ── Der Client: echter Weg, kein Kniff ────────────────────────────────
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await click(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await click(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await click(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  ok(true, 'CONNECT frischer Rechner, echter Klick auf „Connect", Anmeldung — dann die normale Anwendung');
  await beobachterLegen();
  client = await lade(client, '/collection');
  await waitFor(client, SHELL, 45000);
  ok(await client.ev('return Array.isArray(window.__cmds);') === true, 'SETUP der Beobachter liegt vor dem ersten Skript der Seite');

  /** Die Artikelmaske öffnen und so ausfüllen, wie ein Mensch es tut. */
  async function artikelMaske(c, marke, name) {
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Item')", 40000);
    if (await clickText(c, 'New Item') !== 'OK') return 'KEIN-KNOPF';
    if (!(await warteBis(c, "document.querySelector('[data-create-product]')", 15000))) return 'KEINE-MASKE';
    if (await clickText(c, 'R5B Plain') !== 'OK') return 'KEINE-KATEGORIE';
    await sleep(400);
    const r = [
      await setByLabel(c, 'BRAND', marke),
      await setByLabel(c, 'NAME / MODEL', name),
      await setByLabel(c, 'PURCHASE PRICE (BHD)', '300'),
      await setByLabel(c, 'SALE PRICE (BHD)', '900'),
    ];
    if (r.some((x) => x !== 'OK')) return 'FELD:' + r.join(',');
    if (await fotoWaehlen(c, PHOTO) !== 'OK') return 'KEIN-FOTOFELD';
    if (!(await warteBis(c, "[...document.querySelectorAll('img')].some(i=>/^data:image\\/jpeg/.test(i.src))", 15000))) return 'KEIN-VORSCHAUBILD';
    return 'OK';
  }
  const artikel = (name) => dbQ(BIZ_DB, 'SELECT * FROM products WHERE name = ?', [name]);
  const bilder = (pid) => dbQ(BIZ_DB, 'SELECT media_id, sort_order, is_primary FROM media_links WHERE entity_id = ? AND deleted_at IS NULL', [pid ?? '']);

  // ══════════════════════════════════════════════════════════════════════
  // §9 ARTIKEL ANLEGEN, MIT BILD
  // ══════════════════════════════════════════════════════════════════════
  let artikelId = '';
  {
    ok(await artikelMaske(client, 'Omega', 'R5B Seamaster') === 'OK', 'ARTIKEL die normale Anlegemaske, mit echtem Foto');
    await click(client, '[data-create-product]');
    const zu = await warteBis(client, "!document.querySelector('[data-create-product]')", 45000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(zu, `ARTIKEL die Maske schliesst nach dem Anlegen (Hinweis: ${String(fehler).slice(0, 160) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'products.create', `ARTIKEL genau EINE Buchung: ${cmds.map((x) => x.op).join(',') || 'keine'}`);
    const p = cmds[0]?.payload || {};
    ok(Array.isArray(p.stagingIds) && p.stagingIds.length === 1 && /^[0-9a-f]{64}$/.test(p.stagingIds[0]),
      `ARTIKEL der Auftrag nennt das Bild nur als Inhaltskennung (${S(p.stagingIds)})`);
    ok(!('images' in p) && !('sku' in p) && !('stockStatus' in p) && !('branchId' in p),
      `ARTIKEL …keine Bilddaten, keine Nummer, kein Bestandsstatus, keine Filiale im Rumpf (${Object.keys(p).join(',')})`);
    ok(await ablagen(client) === 1, 'ARTIKEL das Foto ging EINMAL in die Zwischenablage');
    await spuelen(primary);
    const a = artikel('R5B Seamaster');
    ok(a.length === 1, `ARTIKEL genau EIN Artikel am Primary (${a.length})`);
    artikelId = String(a[0]?.id || '');
    ok(a[0]?.brand === 'Omega' && Number(a[0]?.purchase_price) === 300 && Number(a[0]?.planned_sale_price) === 900
      && a[0]?.category_id === 'cat-r5b', `ARTIKEL alle Eingaben stehen da (${a[0]?.brand}/${a[0]?.purchase_price}/${a[0]?.planned_sale_price})`);
    ok(a[0]?.branch_id === HAUS, `ARTIKEL die Filiale bestimmt der Primary (${a[0]?.branch_id})`);
    ok(String(a[0]?.sku || '').length > 0, `ARTIKEL die Nummer vergibt der Primary (${a[0]?.sku})`);
    ok(Number(a[0]?.quantity) === 1 && a[0]?.stock_status === 'in_stock' && a[0]?.source_type === 'OWN',
      `ARTIKEL Menge und Bestand wie am Primary (${a[0]?.quantity}/${a[0]?.stock_status}/${a[0]?.source_type})`);
    ok(a[0]?.images === '[]', 'ARTIKEL kein Bild als Text in der Zeile — die Galerie gehört dem Medienspeicher');
    const b = bilder(artikelId);
    ok(b.length === 1 && Number(b[0]?.is_primary) === 1, `ARTIKEL genau EIN Bild, als Hauptbild verknüpft (${S(b)})`);
    const lose = dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM stock_lots WHERE product_id = ?', [artikelId])[0];
    ok(Number(lose?.n) === 0, `ARTIKEL kein Los — wie beim Anlegen am Primary (${lose?.n})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');

    // Das Bild ist auf BEIDEN Rechnern sichtbar.
    client = await lade(client, '/collection/' + artikelId);
    const pc2Bild = await warteBis(client, "[...document.querySelectorAll('img')].some(i=>i.complete && i.naturalWidth>0 && !/^data:/.test(i.src))", 30000);
    ok(pc2Bild, 'ARTIKEL PC2 zeigt das Bild aus dem Medienspeicher des Primary');
    await primary.ev(`history.pushState({}, '', ${S('/collection/' + artikelId)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
    const pBild = await warteBis(primary, "[...document.querySelectorAll('img')].some(i=>i.complete && i.naturalWidth>0 && !/^data:/.test(i.src))", 30000);
    ok(pBild, 'ARTIKEL …und der Primary zeigt dasselbe');
  }

  // ── Verlorene Antwort beim Artikel ──
  {
    client = await lade(client, '/collection');
    ok(await artikelMaske(client, 'Omega', 'R5B Constellation') === 'OK', 'VERLOREN die Maske, noch einmal');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-create-product]');
    const gemeldet = await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000);
    ok(gemeldet, 'VERLOREN die Maske meldet den offenen Ausgang, statt Erfolg zu behaupten');
    ok(await exists(client, '[data-create-product]'), 'VERLOREN …und bleibt offen — der Vorsatz ist nicht verbraucht');
    await click(client, '[data-create-product]');
    const zu = await warteBis(client, "!document.querySelector('[data-create-product]')", 45000);
    ok(zu, 'VERLOREN der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'products.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `VERLOREN zwei Anfragen, DIESELBE Kennung, derselbe Rumpf (${c.length})`);
    await spuelen(primary);
    const a = artikel('R5B Constellation');
    ok(a.length === 1 && bilder(a[0]?.id).length === 1,
      `VERLOREN genau ein Artikel und genau ein Bild (${a.length}/${bilder(a[0]?.id).length})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §10 KOMMISSION ANLEGEN, MIT BILD
  // ══════════════════════════════════════════════════════════════════════
  /** Die Kommissionsmaske — auf welchem Rechner auch immer. */
  async function kommissionsMaske(c, marke, name, sku) {
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Consignment')", 40000);
    if (await clickText(c, 'New Consignment') !== 'OK') return 'KEIN-KNOPF';
    if (!(await warteBis(c, "document.querySelector('[data-cn-create]')", 15000))) return 'KEINE-MASKE';
    await click(c, '[data-ss-trigger="Search clients..."]');
    await sleep(500);
    await click(c, '[data-ss-option="r5b-cons"]');
    await sleep(300);
    await click(c, '[data-cn-cat="cat-r5b"]');
    await sleep(400);
    const r = [
      await setByLabel(c, 'BRAND', marke),
      await setByLabel(c, 'NAME / MODEL', name),
      await setByLabel(c, 'SKU / REFERENCE', sku),
      await setByLabel(c, 'AGREED PRICE (BHD)', '1000'),
    ];
    if (r.some((x) => x !== 'OK')) return 'FELD:' + r.join(',');
    if (await fotoWaehlen(c, PHOTO) !== 'OK') return 'KEIN-FOTOFELD';
    if (!(await warteBis(c, "[...document.querySelectorAll('img')].some(i=>/^data:image\\/jpeg/.test(i.src))", 15000))) return 'KEIN-VORSCHAUBILD';
    return 'OK';
  }
  const kommission = (sku) => {
    const p = dbQ(BIZ_DB, 'SELECT * FROM products WHERE sku = ?', [sku]);
    const k = p[0] ? dbQ(BIZ_DB, 'SELECT * FROM consignments WHERE product_id = ?', [p[0].id]) : [];
    return { p, k };
  };
  const OHNE = /^(id|rowid)$|_id$|_at$|number|^notes?$|description|reference|created_by|^sku$|^name$|^brand$|^image_/;
  const norm = (row) => S(Object.fromEntries(Object.entries(row || {}).filter(([k]) => !OHNE.test(k))));

  {
    client = await lade(client, '/consignments');
    ok(await kommissionsMaske(client, 'Cartier', 'R5B Tank', 'R5B-CN-001') === 'OK', 'KOMMISSION die normale Kommissionsmaske, mit echtem Foto');
    await click(client, '[data-cn-create]');
    const zu = await warteBis(client, "!document.querySelector('[data-cn-create]')", 45000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(zu, `KOMMISSION die Maske schliesst nach dem Anlegen (Hinweis: ${String(fehler).slice(0, 160) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'consignments.create',
      `KOMMISSION genau EINE Buchung — kein products.create davor: ${cmds.map((x) => x.op).join(',') || 'keine'}`);
    const pl = cmds[0]?.payload || {};
    ok(pl.product?.sku === 'R5B-CN-001' && Array.isArray(pl.stagingIds) && pl.stagingIds.length === 1
      && pl.payout?.model === 'percent' && pl.agreedPrice === 1000,
      `KOMMISSION der Rumpf trägt die Eingaben der Maske und das Bild als Kennung (${S({ sku: pl.product?.sku, bilder: pl.stagingIds?.length, payout: pl.payout })})`);
    ok(!('purchasePrice' in (pl.product || {})) && !('stockStatus' in (pl.product || {})) && !('quantity' in (pl.product || {})),
      'KOMMISSION …und nichts, was die Kommission fest setzt');
    await spuelen(primary);
    const { p, k } = kommission('R5B-CN-001');
    ok(p.length === 1 && k.length === 1, `KOMMISSION genau EIN Artikel und genau EINE Kommission (${p.length}/${k.length})`);
    ok(k[0]?.product_id === p[0]?.id && k[0]?.consignor_id === 'r5b-cons', 'KOMMISSION die Kommission hängt an genau diesem Artikel und Einlieferer');
    ok(p[0]?.stock_status === 'consignment' && p[0]?.source_type === 'CONSIGNMENT' && Number(p[0]?.quantity) === 1,
      `KOMMISSION Bestand und Eigentum wie beim Kommissionseingang (${p[0]?.stock_status}/${p[0]?.source_type}/${p[0]?.quantity})`);
    ok(Math.abs(Number(p[0]?.purchase_price) - 850) < 0.001, `KOMMISSION der erwartete Einstand aus dem Modell (${p[0]?.purchase_price})`);
    ok(p[0]?.images === '[]' && bilder(p[0]?.id).length === 1, `KOMMISSION das Bild im Medienspeicher, nicht als Text (${p[0]?.images}/${bilder(p[0]?.id).length})`);
    // Die Fassung zählt Änderungen der Zeile — ob sie am Primary genauso steht, prüft der
    // Vergleich unten (PARITAET), nicht eine hier geratene Zahl.
    ok(k[0]?.status === 'active' && Number(k[0]?.revision) >= 1 && k[0]?.branch_id === HAUS,
      `KOMMISSION Status, Fassung und Filiale (${k[0]?.status}/${k[0]?.revision}/${k[0]?.branch_id})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ── Verlorene Antwort bei der Kommission ──
  {
    client = await lade(client, '/consignments');
    ok(await kommissionsMaske(client, 'Cartier', 'R5B Ballon', 'R5B-CN-002') === 'OK', 'VERLOREN-K die Kommissionsmaske, noch einmal');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-cn-create]');
    const gemeldet = await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000);
    ok(gemeldet, 'VERLOREN-K die Maske meldet den offenen Ausgang');
    ok(await exists(client, '[data-cn-create]'), 'VERLOREN-K …und bleibt offen');
    await click(client, '[data-cn-create]');
    const zu = await warteBis(client, "!document.querySelector('[data-cn-create]')", 45000);
    ok(zu, 'VERLOREN-K der zweite Versuch kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'consignments.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `VERLOREN-K zwei Anfragen, DIESELBE Kennung, derselbe Rumpf (${c.length})`);
    await spuelen(primary);
    const { p, k } = kommission('R5B-CN-002');
    ok(p.length === 1 && k.length === 1 && bilder(p[0]?.id).length === 1,
      `VERLOREN-K genau eine Kombination aus Artikel, Kommission und Bild (${p.length}/${k.length}/${bilder(p[0]?.id).length})`);
  }

  // ── Dieselbe Kommission an der Maske des Primary: dieselbe Wirkung ──
  {
    await primary.ev(`history.pushState({}, '', '/consignments'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
    // Ein anderer Name, damit die Duplikatsfrage der Maske nicht dazwischen kommt — Name, Marke und
    // Nummer sind im Vergleich ohnehin ausgenommen.
    ok(await kommissionsMaske(primary, 'Cartier', 'R5B Santos', 'R5B-CN-003') === 'OK', 'PARITAET die Kommissionsmaske des Primary, mit demselben Foto');
    await click(primary, '[data-cn-create]');
    ok(await warteBis(primary, "!document.querySelector('[data-cn-create]')", 45000), 'PARITAET der Primary legt sie über seine eigene Maske an');
    let lokal = { p: [], k: [] };
    for (let i = 0; i < 30; i++) {
      await spuelen(primary);
      await sleep(400);
      lokal = kommission('R5B-CN-003');
      if (lokal.p.length === 1 && lokal.k.length === 1 && bilder(lokal.p[0]?.id).length === 1) break;
    }
    const fern = kommission('R5B-CN-001');
    ok(lokal.p.length === 1 && lokal.k.length === 1, `PARITAET am Primary genau ein Artikel und eine Kommission (${lokal.p.length}/${lokal.k.length})`);
    ok(norm(lokal.p[0]) === norm(fern.p[0]), `PARITAET der Artikel: Primary-Maske == PC2 (${norm(lokal.p[0])} / ${norm(fern.p[0])})`);
    ok(norm(lokal.k[0]) === norm(fern.k[0]), `PARITAET die Kommission: Primary-Maske == PC2 (${norm(lokal.k[0])} / ${norm(fern.k[0])})`);
    ok(S(bilder(lokal.p[0]?.id).map((b) => [b.sort_order, b.is_primary])) === S(bilder(fern.p[0]?.id).map((b) => [b.sort_order, b.is_primary])),
      'PARITAET …und die Galerie: ein Hauptbild, dieselbe Ordnung');
    const mk = (pid) => dbQ(BIZ_DB,
      `SELECT g.stored_blob_hash AS h FROM media_links l
         JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
         JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
         JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
        WHERE l.entity_id = ? AND l.deleted_at IS NULL`, [pid ?? ''])[0]?.h;
    const hl = mk(lokal.p[0]?.id), hf = mk(fern.p[0]?.id);
    ok(!!hl && hl === hf, `PARITAET dieselben Bildbytes auf beiden Wegen (${String(hl).slice(0, 12)} / ${String(hf).slice(0, 12)})`);
  }

  // ── Primary == PC2 nach frischem Lesen ──
  {
    client = await lade(client, '/consignments');
    await warteBis(client, "document.body.innerText.includes('Nadia')", 30000);
    client = await lade(client, '/collection');
    const sicht = await warteBis(client, "document.body.innerText.includes('R5B Seamaster') && document.body.innerText.includes('R5B Constellation')", 30000);
    ok(sicht, 'FRISCH PC2 liest dieselben Artikel, die der Primary führt');
    ok((await treffer(client)).length === 0, 'LOKAL …weiterhin kein Griff zur lokalen Datenbank');
  }

  // ── Der Client besitzt weiterhin nichts ────────────────────────────────
  {
    const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
    ok(verboten.length === 0, `LOKAL kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5b: product + consignment create, with media: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5B_MEDIA_PIPELINE_REUSED');
console.log('CENTRAL_UI_R5B_PRODUCT_CREATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5B_CONSIGNMENT_CREATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5B_NO_LOCAL_CLIENT_WRITE_PROVED');
