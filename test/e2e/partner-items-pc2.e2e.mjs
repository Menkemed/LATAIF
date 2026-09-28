// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — Geld gemeinsam gekaufter Artikel mit zwei echten, isolierten Anwendungen.
// Run: node test/e2e/partner-items-pc2.e2e.mjs
//
//   PC2 (ohne Geschäftsdatenbank) bedient die Partnerseite und den Einkauf; gebucht wird nur am
//   Primary. Geprüft: Beitrag mit VERLORENER Antwort (dieselbe Kennung, genau eine Buchung),
//   Kennungskonflikt, Abrechnung, zwei gleichzeitige Auszahlungen (genau eine), Kundenretoure auf
//   PC2 + Nachabrechnung (Rückforderung), Übernahme durch LATAIF, Verrechnung + Storno,
//   Partnerwechsel, Lieferantenrückgabe über den bestehenden Befehl, Hauptbuch ausgeglichen.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat
// oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'pi-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-pitems', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 100 * 60 * 1000);

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

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.events = [];
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params?.type || '')) {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''}`.slice(0, 400));
      }
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
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
/** Klick ohne Abbruch: 'OK' oder der Grund. */
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
/** Den Knopf `sel` in der Karte, die `karte` zeigt — die kleinste Umgebung mit genau diesem einen Knopf. */
const klickInKarte = (c, karte, sel) => c.ev(`const kand=[...document.querySelectorAll(${S(sel)})]; for (const x of kand) { let p=x; for(let i=0;i<12&&p;i++){ p=p.parentElement; if(!p) break; if ((p.innerText||'').includes(${S(karte)})) { if (p.querySelectorAll(${S(sel)}).length===1) { if (x.disabled) return 'DISABLED'; x.click(); return 'OK'; } break; } } } return 'NO-KARTE:'+${S(karte)};`);
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
const SHELL = 'a[href="/settings"]';
const alleOk = (r) => { const schlecht = r.filter((x) => x !== 'OK'); return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK'; };
const q = (sel) => `document.querySelector(${S(sel)})`;

// Der Beobachter: Fernaufträge, ihre Antworten, Datenbankgriffe, Kern-Aufrufe, Dialoge — und EINE
// verlorene Antwort auf Wunsch.
const BEOBACHTER = `
  if (window.__r6dInstalliert) { /* schon da */ } else {
  window.__r6dInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__invokes = []; window.__alerts = []; window.__dropNext = null;
  window.alert = (m) => { window.__alerts.push(String(m)); };
  window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); oe(...a); };
  const ow = console.warn;
  console.warn = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); ow(...a); };
  (function haken() {
    const t = window.__TAURI_INTERNALS__;
    if (t && t.invoke && !t.__r6d) {
      const oi = t.invoke.bind(t);
      t.invoke = (cmd, args, opts) => { window.__invokes.push(String(cmd)); return oi(cmd, args, opts); };
      t.__r6d = true;
    } else if (!t || !t.__r6d) setTimeout(haken, 30);
  })();
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); let auth = ''; try { const h = (a[1] && a[1].headers) || {}; auth = h.Authorization || h.authorization || ''; } catch (e) { auth = ''; } window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload, url, auth }); } catch (e) { /* kein lesbarer Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      // Die Anfrage GEHT hinaus und wird am Primary ausgeführt — nur die Antwort kommt nie an.
      window.__dropNext = null;
      const r0 = await of(...a);
      try { await r0.text(); } catch (e) { /* egal */ }
      window.__answers.push({ op: body.op, commandId: body.commandId, dropped: true });
      throw new TypeError('R6D: simulated lost response');
    }
    const r = await of(...a);
    if (body && body.op && !/\\.(get|list)$/.test(String(body.op))) {
      try {
        const j = await r.clone().json();
        window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, ok: !!(j && j.ok === true), error: (j && j.error) || null, replayed: !!(j && j.value && j.value.replayed) });
      } catch (e) { window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, unreadable: true }); }
    }
    return r;
  };
  }
`;
const DIALOGE_PRIMARY = 'window.__alerts = window.__alerts || []; window.alert = (m) => { window.__alerts.push(String(m)); }; window.confirm = () => true; return 1;';

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

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
// Datenbankgriffe und Kern-Aufrufe über ALLE Seiten des Laufs (ein Neuladen leert die Fensterlisten).
const ALLE_TREFFER = [], ALLE_AUFRUFE = [];
async function ernte(c) {
  try { ALLE_TREFFER.push(...(await treffer(c))); ALLE_AUFRUFE.push(...(await aufrufe(c))); } catch { /* Seite schon weg */ }
}
async function lade(c, route) {
  await ernte(c);
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
/** Am Primary frisch einsteigen: über eine andere Seite, damit die Zielseite neu lädt (frische Fassung). */
async function gehFrisch(p, route) {
  await geh(p, '/tasks');
  await sleep(700);
  await geh(p, route);
  await sleep(900);
}
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)) && !/^store\.|^page\.|^domain\.|^session\./.test(String(x.op)));
const antworten = (c) => c.ev('return JSON.stringify(window.__answers || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const aufrufe = (c) => c.ev('return JSON.stringify(window.__invokes || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const FEHLER_SEL = '[data-save-error],[data-gold-settle-error],[data-material-error],[data-gold-usage-error],[data-scrap-form-error]';
const fehlerText = (c, sel = FEHLER_SEL) => c.ev(`return [...document.querySelectorAll(${S(sel)})].map(e=>e.textContent).join(' | ');`).catch(() => '');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
let primary = null, client = null;

async function warteAuf(pruefe, runden = 40) {
  for (let i = 0; i < runden; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}

/**
 * Der Primary synchronisiert (Auto-LAN) mit seinem EIGENEN Sync-Server: alle 30 s schiebt er seine
 * Änderungen hoch und spielt sie als Echo wieder ein (applyUpsert → UPDATE → der Fassungs-Trigger
 * zählt +1). Das ist ein Hintergrundlauf, der mit der geprüften Buchung nichts zu tun hat — gemessen
 * im ersten Lauf: ohne Warten traf er zwischen „Seite geladen" und „Speichern" und machte die
 * gesehene Fassung alt (RECORD_CHANGED ohne fremde Änderung). Deshalb wird vor jedem Laden und vor
 * jedem Vergleich gewartet, bis der Primary nichts mehr zu schieben hat und sein Echo eingespielt ist.
 */
async function syncRuhe(t = 75000) {
  const end = Date.now() + t;
  let angestossen = false;
  while (Date.now() < end) {
    await spuelen(primary);
    const offen = zahl('SELECT COUNT(*) AS n FROM sync_changelog WHERE synced = 0');
    const stand = zahl('SELECT COALESCE(MAX(last_sync_id), 0) AS m FROM sync_cursor');
    const kopf = Number(dbQ(SERVER_DB, 'SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog')[0]?.m || 0);
    if (offen === 0 && stand >= kopf) return true;
    if (!angestossen) {
      // Nicht 30 s auf den Zeitgeber warten: derselbe Lauf über den Knopf „Sync Now" des Primary
      // (Einstellungen → Sync / Server). Nur dieser Knopf — nie „Disconnect".
      angestossen = true;
      await geh(primary, '/settings?tab=sync');
      if (await warteBis(primary, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sync Now')", 8000)) {
        await clickText(primary, 'Sync Now');
      }
    }
    await sleep(700);
  }
  console.log('      (sync) der Echo-Lauf des Primary kam nicht zur Ruhe');
  return false;
}

// ── Datenbank-Blick ──────────────────────────────────────────────────────────
const idSet = (t) => new Set(dbQ(BIZ_DB, `SELECT id FROM ${t}`).map((r) => r.id));
const neueZeilen = (t, vorher, where = '1=1', params = []) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE ${where}`, params).filter((r) => !vorher.has(r.id));
const zeile = (t, id) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE id = ?`, [id])[0] || {};
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
const ledgerMax = () => zahl('SELECT COALESCE(MAX(rowid), 0) AS m FROM ledger_entries');
const buchungenSeit = (row) => dbQ(BIZ_DB, 'SELECT account, direction, amount, source_module, transaction_id, reverses_entry_id FROM ledger_entries WHERE rowid > ? ORDER BY rowid', [row]);
const ledgerNorm = (rows) => S(rows.map((r) => [r.account, r.direction, Math.round(Number(r.amount) * 1000), r.source_module, r.reverses_entry_id ? 'R' : '']).map((x) => S(x)).sort());
const bestand21 = () => zahl("SELECT COALESCE(SUM(weight_grams), 0) AS g FROM precious_metals WHERE metal_type = 'gold' AND status = 'in_stock' AND karat = '21K'");
const spotSilber = () => Number(dbQ(BIZ_DB, "SELECT value FROM settings WHERE key = 'spot_price.silver'")[0]?.value ?? NaN);

// ══════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — die Welt des Laufs und die Nachweise
// ══════════════════════════════════════════════════════════════════════════════
const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const ITEMS = ['A', 'T', 'W', 'R'];
const PL = (x) => `pi-line-${x}`, LOT = (x) => `pi-lot-${x}`, PUR = (x) => `pi-pur-${x}`, PROD = (x) => `pi-prod-${x}`;
const INV_A = 'pi-inv-A', IL_A = 'pi-inv-A-l1';

function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const cat = (db.prepare('SELECT id FROM categories WHERE branch_id = ? LIMIT 1').get(branch_id) || {}).id || 'cat-watches';
    const now = new Date().toISOString();
    const alt = new Date(Date.now() - 20 * 86400000).toISOString();
    insert(db, 'partners', { id: 'pa-b', branch_id, name: 'PI Bashir', share_percentage: 0, active: 1, created_at: now, updated_at: now });
    insert(db, 'partners', { id: 'pa-c', branch_id, name: 'PI Chalid', share_percentage: 0, active: 1, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'pi-sup', branch_id, name: 'PI Lieferant', phone: '+973 1700 0999', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'pi-kunde', branch_id, first_name: 'PI', last_name: 'Kunde', phone: '+973 3600 0999', created_at: now, updated_at: now });
    for (const x of ITEMS) {
      const sold = x === 'A';
      insert(db, 'products', { id: PROD(x), branch_id, category_id: cat, brand: 'Rolex', name: `PI Sub ${x}`, sku: `PI-${x}`, quantity: sold ? 0 : 1,
        condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 1000, purchase_currency: 'BHD', stock_status: sold ? 'sold' : 'in_stock',
        tax_scheme: 'ZERO', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: alt, updated_at: alt });
      insert(db, 'purchases', { id: PUR(x), branch_id, purchase_number: `PI-PUR-${x}`, supplier_id: 'pi-sup', status: 'PAID', total_amount: 1000,
        paid_amount: 1000, remaining_amount: 0, purchase_date: alt.slice(0, 10), created_at: alt, updated_at: alt });
      insert(db, 'purchase_lines', { id: PL(x), purchase_id: PUR(x), product_id: PROD(x), quantity: 1, unit_price: 1000, line_total: 1000, position: 1, tax_scheme: 'ZERO', vat_rate: 0, vat_amount: 0 });
      insert(db, 'stock_lots', { id: LOT(x), branch_id, product_id: PROD(x), purchase_id: PUR(x), purchase_line_id: PL(x), unit_cost: 1000, qty_total: 1,
        qty_remaining: sold ? 0 : 1, status: sold ? 'EXHAUSTED' : 'ACTIVE', acquired_at: alt.slice(0, 10), created_at: alt });
      for (const [party, partner] of [['HOUSE', null], ['PARTNER', 'pa-b']]) {
        insert(db, 'item_participations', { id: `pi-ip-${x}-${party}`, branch_id, purchase_id: PUR(x), purchase_line_id: PL(x), product_id: PROD(x),
          party, partner_id: partner, share_bp: 5000, cost_share: 500, line_total: 1000, quantity: 1, created_at: alt, epoch_id: PL(x), from_il_rowid: 0, unit_cost: 1000 });
      }
    }
    insert(db, 'invoices', { id: INV_A, branch_id, invoice_number: 'PI-INV-A', customer_id: 'pi-kunde', status: 'FINAL', currency: 'BHD', net_amount: 1300,
      vat_rate_snapshot: 0, vat_amount: 0, gross_amount: 1300, tax_scheme_snapshot: 'ZERO', purchase_price_snapshot: 1000, sale_price_snapshot: 1300,
      margin_snapshot: 300, paid_amount: 1300, issued_at: now, created_at: now, updated_at: now, number_finalized_at: now });
    insert(db, 'invoice_lines', { id: IL_A, invoice_id: INV_A, product_id: PROD('A'), lot_id: LOT('A'), quantity: 1, unit_price: 1300, purchase_price_snapshot: 1000,
      vat_rate: 0, tax_scheme: 'ZERO', vat_amount: 0, line_total: 1300, position: 1 });
    insert(db, 'payments', { id: 'pi-pay-A', branch_id, invoice_id: INV_A, amount: 1300, method: 'cash', received_at: now, created_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

const mv = (line, kind, extra = '') => dbQ(BIZ_DB, `SELECT id, kind, amount, cancelled_at, partner_id FROM item_partner_movements WHERE purchase_line_id = ? AND kind = ? ${extra} ORDER BY rowid`, [line, kind]);
const offenA = async () => {
  // Der offene Betrag, wie ihn die Partnerseite am PC2 zeigt (vom Primary gelesen).
  return Number(await client.ev(`return document.querySelector('[data-partner-item="${PL('A')}"] [data-partner-item-open]')?.getAttribute('data-partner-item-open') ?? 'NaN';`));
};
async function partnerSeite(route = '/partners') {
  client = await lade(client, route);
  await waitFor(client, '[data-partner-items]', 60000);
}
async function aufklappen(line) {
  if (await exists(client, `[data-partner-item-expanded="${line}"]`)) return;
  await click(client, `[data-partner-item-toggle="${line}"]`);
  await waitFor(client, `[data-partner-item-expanded="${line}"]`, 10000);
}
async function beitragMaske(line, kind, betrag, methode) {
  await aufklappen(line);
  await click(client, kind === 'PAYOUT' ? `[data-partner-item-payout="${line}"]` : `[data-partner-item-contribute="${line}"]`);
  await waitFor(client, '[data-partner-item-save]', 10000);
  await setVal(client, '[data-partner-item-amount]', String(betrag));
  await click(client, `[data-partner-item-method="${methode}"]`);
  await sleep(200);
}
const direkt = (op, payload, commandId) => client.ev(`
  const vorlage = (window.__cmds || []).find((x) => x.auth);
  if (!vorlage) return JSON.stringify({ error: 'NO-AUTH' });
  const r = await fetch(vorlage.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: vorlage.auth },
    body: JSON.stringify({ op: ${S(op)}, commandId: ${S(commandId)}, payload: ${S(payload)} }) });
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  return JSON.stringify({ status: r.status, body: j });`).then((s) => JSON.parse(s));
const neueId = () => crypto.randomUUID();

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PI Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PI Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PI Admin');
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
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    // Die gespeicherte Sitzung gilt nach dem Säen nicht mehr — normal anmelden (Testpasswort des Laufs).
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await primary.ev(DIALOGE_PRIMARY);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }
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
  ok(true, 'CONNECT frischer PC2 ohne Datenbank, Anmeldung');
  await beobachterLegen();
  const LEDGER_BASIS = ledgerMax();

  // ── 1 Beitrag auf PC2 mit verlorener Antwort ─────────────────────────────
  await syncRuhe();
  await partnerSeite();
  ok(await exists(client, `[data-partner-item="${PL('A')}"]`), 'PC2 sieht die gemeinsam gekauften Artikel (vom Primary gelesen)');
  await beitragMaske(PL('A'), 'CONTRIBUTION', 400, 'bank');
  await client.ev(`window.__dropNext = 'partner_items.record_movement'; return 1;`);
  await click(client, '[data-partner-item-save]');
  const verloren = await warteBis(client, "document.querySelector('[data-save-error]')", 30000);
  await spuelen(primary);
  const nachErstem = mv(PL('A'), 'CONTRIBUTION');
  ok(verloren && nachErstem.length === 1 && Number(nachErstem[0].amount) === 400,
    `LOST Beitrag: Antwort verloren, die Maske meldet es; der Primary hat genau einmal gebucht (${nachErstem.length})`);
  await click(client, '[data-partner-item-save]');
  await warteBis(client, "!document.querySelector('[data-partner-item-save]')", 30000);
  await spuelen(primary);
  const cmdsBeitrag = (await kommandos(client)).filter((x) => x.op === 'partner_items.record_movement');
  const antw = (await antworten(client)).filter((x) => x.op === 'partner_items.record_movement');
  ok(mv(PL('A'), 'CONTRIBUTION').length === 1 && cmdsBeitrag.length === 2 && cmdsBeitrag[0].commandId === cmdsBeitrag[1].commandId
    && antw.some((a) => a.replayed), `LOST Wiederholung: dieselbe Kennung, Ergebnis wiedergegeben, keine zweite Buchung (${S(antw)})`);
  const beitragId = cmdsBeitrag[0].commandId;

  // ── 2 Kennungskonflikt ────────────────────────────────────────────────────
  {
    const r = await direkt('partner_items.record_movement', { ...cmdsBeitrag[0].payload, amount: 1 }, beitragId);
    await spuelen(primary);
    ok(r.status >= 400 && JSON.stringify(r.body).includes('COMMAND_ID_CONFLICT') && mv(PL('A'), 'CONTRIBUTION').length === 1,
      `CONFLICT dieselbe Kennung, anderer Inhalt → abgewiesen, nichts gebucht (${S(r).slice(0, 200)})`);
  }

  // ── 3 Abrechnung auf PC2 ──────────────────────────────────────────────────
  await partnerSeite();
  await aufklappen(PL('A'));
  await click(client, `[data-partner-item-settle="${IL_A}"]`);
  await warteBis(client, `document.querySelector('[data-partner-item-sale="${IL_A}"]')?.getAttribute('data-sale-state') === 'SETTLED'`, 30000);
  await spuelen(primary);
  const share = mv(PL('A'), 'PROFIT_SHARE');
  ok(share.length === 1 && Number(share[0].amount) === 150, `SETTLE auf PC2: Gewinn 300 → B 150 (${S(share)})`);
  ok(await offenA() === 550, `SETTLE Anspruch 400 + 150 = 550 am PC2 angezeigt (${await offenA()})`);

  // ── 4 Zwei gleichzeitige Auszahlungen der vollen 550 ──────────────────────
  {
    const pay = { purchaseLineId: PL('A'), partnerId: 'pa-b', kind: 'PAYOUT', amount: 550, method: 'cash', date: new Date().toISOString().slice(0, 10) };
    const [r1, r2] = await Promise.all([direkt('partner_items.record_movement', pay, neueId()), direkt('partner_items.record_movement', pay, neueId())]);
    await spuelen(primary);
    const ausz = mv(PL('A'), 'PAYOUT', 'AND cancelled_at IS NULL');
    const okZahl = [r1, r2].filter((r) => r.status === 200 && r.body && r.body.ok === true).length;
    ok(okZahl === 1 && ausz.length === 1 && Number(ausz[0].amount) === 550,
      `CONCURRENT zwei gleichzeitige Auszahlungen → genau eine (${S([r1.status, r2.status])}; ${JSON.stringify([r1.body?.error, r2.body?.error])})`);
    await partnerSeite();
    await aufklappen(PL('A'));
    ok(await c_disabled(`[data-partner-item-payout="${PL('A')}"]`), 'CONCURRENT danach bietet PC2 keine Auszahlung mehr an (offen 0)');
  }

  // ── 5 Kundenretoure auf PC2, Nachabrechnung auf PC2 ───────────────────────
  {
    client = await lade(client, `/invoices/${INV_A}`);
    const r = [await clickIncludes(client, 'Create Return')];
    await warteBis(client, "document.querySelector('[data-return-save]')", 15000);
    r.push(await client.ev("const h=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()==='UNIT PRICE (incl. VAT)'); if(!h) return 'NO-HEAD'; const cb=h.parentElement.parentElement.querySelector('input[type=checkbox]:not([disabled])'); if(!cb) return 'NO-BOX'; cb.click(); return 'OK';"));
    await sleep(250);
    r.push(await clickText(client, 'Cash'));
    r.push(await clickText(client, 'Back to Stock'));
    r.push(await clickText(client, 'Refund jetzt zahlen'));
    await sleep(300);
    await click(client, '[data-return-save]');
    await warteBis(client, "!document.querySelector('[data-return-save]')", 30000);
    await spuelen(primary);
    const st = dbQ(BIZ_DB, 'SELECT status, product_disposition FROM sales_returns WHERE invoice_id = ?', [INV_A]);
    ok(alleOk(r) === 'OK' && st.length === 1 && ['REFUNDED', 'APPROVED', 'CLOSED'].includes(st[0].status), `RETURN auf PC2 angelegt und erstattet (${alleOk(r)} ${S(st)})`);
    await partnerSeite();
    await aufklappen(PL('A'));
    ok(await client.ev(`return document.querySelector('[data-partner-item-sale="${IL_A}"]')?.getAttribute('data-sale-state');`) === 'NEEDS_CORRECTION',
      'RETURN die Abrechnung ist als nachzurechnen markiert');
    await click(client, `[data-partner-item-settle="${IL_A}"]`);
    await warteBis(client, `document.querySelector('[data-partner-item-sale="${IL_A}"]')?.getAttribute('data-sale-state') === 'SETTLED'`, 30000);
    await spuelen(primary);
    const korr = mv(PL('A'), 'PROFIT_CORRECTION');
    ok(korr.length === 1 && Number(korr[0].amount) === -150 && mv(PL('A'), 'PAYOUT', 'AND cancelled_at IS NULL').length === 1,
      `CORRECTION auf PC2: −150, die Auszahlung bleibt (${S(korr)})`);
    ok(await offenA() === -650, `CORRECTION Rückforderung am PC2: B schuldet 650 (${await offenA()})`);
  }

  // ── 6 Übernahme durch LATAIF auf PC2 (Artikel T), Beitrag vorher ──────────
  {
    await partnerSeite();
    await beitragMaske(PL('T'), 'CONTRIBUTION', 500, 'bank');
    await click(client, '[data-partner-item-save]');
    await warteBis(client, "!document.querySelector('[data-partner-item-save]')", 30000);
    await partnerSeite();
    await aufklappen(PL('T'));
    await click(client, `[data-partner-item-takeover="${PL('T')}"]`);
    await waitFor(client, '[data-ownership-modal="TAKEOVER"]', 10000);
    const wert = await client.ev(`return document.querySelector('[data-ownership-value]')?.getAttribute('data-ownership-value');`);
    await click(client, '[data-ownership-confirm]');
    await warteBis(client, "!document.querySelector('[data-ownership-modal]')", 30000);
    await spuelen(primary);
    const ueb = mv(PL('T'), 'TAKEOVER');
    const ende = dbQ(BIZ_DB, 'SELECT ended_at, ended_reason FROM item_participations WHERE purchase_line_id = ?', [PL('T')]);
    ok(wert === '1000.000' && ueb.length === 1 && ende.every((e) => e.ended_reason === 'TAKEOVER'),
      `TAKEOVER auf PC2 zum angezeigten Einstand 1000 (${wert}; ${S(ende)})`);
    ok(zahl('SELECT qty_remaining AS n FROM stock_lots WHERE id = ?', [LOT('T')]) === 1 && zahl('SELECT COUNT(*) AS n FROM purchases') === 4,
      'TAKEOVER kein Lagerzugang, kein neuer Einkauf');
  }

  // ── 7 Verrechnung auf PC2 und Storno (Erfassungsfehler) auf PC2 ───────────
  {
    await partnerSeite();
    ok(await exists(client, '[data-partner-items-offset="pa-b"]'), 'OFFSET PC2 bietet Verrechnen an (Guthaben T, Schuld A)');
    await click(client, '[data-partner-items-offset="pa-b"]');
    await waitFor(client, '[data-partner-offset-save]', 10000);
    await setVal(client, '[data-partner-offset-from]', PL('T'));
    await setVal(client, '[data-partner-offset-to]', PL('A'));
    await setVal(client, '[data-partner-offset-amount]', '500');
    await click(client, '[data-partner-offset-save]');
    await warteBis(client, "!document.querySelector('[data-partner-offset-save]')", 30000);
    await spuelen(primary);
    const off = dbQ(BIZ_DB, "SELECT purchase_line_id, amount FROM item_partner_movements WHERE kind = 'OFFSET' AND cancelled_at IS NULL");
    ok(off.length === 2 && off.some((o) => o.purchase_line_id === PL('T') && Number(o.amount) === -500) && off.some((o) => o.purchase_line_id === PL('A') && Number(o.amount) === 500),
      `OFFSET auf PC2: 500 von T gegen A (${S(off)})`);
    await partnerSeite();
    await aufklappen(PL('A'));
    const offId = dbQ(BIZ_DB, "SELECT id FROM item_partner_movements WHERE kind = 'OFFSET' AND purchase_line_id = ?", [PL('A')])[0]?.id;
    await click(client, `[data-partner-item-cancel="${offId}"]`);
    await sleep(1500);
    await spuelen(primary);
    ok(zahl("SELECT COUNT(*) AS n FROM item_partner_movements WHERE kind = 'OFFSET' AND cancelled_at IS NOT NULL") === 2, 'CANCEL auf PC2: das Verrechnungspaar gemeinsam zurückgenommen');
  }

  // ── 8 Partnerwechsel auf PC2 (Artikel W) ──────────────────────────────────
  {
    client = await lade(client, `/purchases/${PUR('W')}`);
    await waitFor(client, `[data-purchase-line-change="${PL('W')}"]`, 60000);
    await click(client, `[data-purchase-line-change="${PL('W')}"]`);
    await waitFor(client, '[data-ownership-modal="CHANGE"]', 10000);
    await setVal(client, '[data-ownership-partner="0"]', 'pa-b');
    await setVal(client, '[data-ownership-share="0"]', '30');
    await clickIncludes(client, 'Another partner');
    await sleep(200);
    await setVal(client, '[data-ownership-partner="1"]', 'pa-c');
    await setVal(client, '[data-ownership-share="1"]', '20');
    await sleep(200);
    await click(client, '[data-ownership-confirm]');
    await warteBis(client, "!document.querySelector('[data-ownership-modal]')", 30000);
    await spuelen(primary);
    const neu = dbQ(BIZ_DB, 'SELECT party, partner_id, share_bp, cost_share FROM item_participations WHERE purchase_line_id = ? AND ended_at IS NULL ORDER BY party, partner_id', [PL('W')]);
    ok(S(neu.map((r) => [r.party, r.partner_id, r.share_bp, Number(r.cost_share)])) === S([['HOUSE', null, 5000, 500], ['PARTNER', 'pa-b', 3000, 300], ['PARTNER', 'pa-c', 2000, 200]]),
      `CHANGE auf PC2: LATAIF 50 / B 30 / C 20 zum Einstand 1000 (${S(neu)})`);
    ok(ledgerMax() >= LEDGER_BASIS && dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM ledger_entries WHERE source_module = 'PARTNER_ITEM' AND rowid > ?", [LEDGER_BASIS]).length >= 0,
      'CHANGE keine Kassen-/Bankbuchung (siehe Hauptbuchprüfung am Ende)');
  }

  // ── 9 Lieferantenrückgabe auf PC2 (Artikel R) über den bestehenden Befehl ─
  {
    await partnerSeite();
    await beitragMaske(PL('R'), 'CONTRIBUTION', 400, 'bank');
    await click(client, '[data-partner-item-save]');
    await warteBis(client, "!document.querySelector('[data-partner-item-save]')", 30000);
    const zahlungenVorher = zahl('SELECT COUNT(*) AS n FROM purchase_payments');
    client = await lade(client, `/purchases/${PUR('R')}`);
    await waitFor(client, '[data-purchase-return-open]', 60000);
    const r = [await klick(client, '[data-purchase-return-open]')];
    await warteBis(client, "document.querySelector('[data-purchase-return-confirm]')", 10000);
    r.push(await klick(client, `[data-purchase-return-line="${PL('R')}"]`)); await sleep(200);
    r.push(await setVal(client, `[data-purchase-return-qty="${PL('R')}"]`, '1')); await sleep(100);
    r.push(await setVal(client, `[data-purchase-return-price="${PL('R')}"]`, '900')); await sleep(100);
    r.push(await klick(client, '[data-purchase-return-method="bank"]'));
    await sleep(200);
    r.push(await klick(client, '[data-purchase-return-confirm]'));
    await warteBis(client, "!document.querySelector('[data-purchase-return-confirm]')", 30000);
    await spuelen(primary);
    const ret = mv(PL('R'), 'SUPPLIER_RETURN');
    const cmds = (await kommandos(client)).filter((x) => x.op === 'purchases.return_to_supplier');
    ok(alleOk(r) === 'OK' && cmds.length === 1 && ret.length === 1 && Number(ret[0].amount) === -50,
      `SUPPLIER-RETURN auf PC2 über purchases.return_to_supplier: Erstattung 900, B trägt 50 (${alleOk(r)} ${S(ret)})`);
    ok(zahl('SELECT COUNT(*) AS n FROM purchase_payments') === zahlungenVorher, 'SUPPLIER-RETURN keine zusätzliche Lieferantenzahlung');
    await partnerSeite();
    ok(Number(await client.ev(`return document.querySelector('[data-partner-item="${PL('R')}"] [data-partner-item-open]')?.getAttribute('data-partner-item-open');`)) === 350,
      'SUPPLIER-RETURN B bekommt 350 zurück (am PC2 angezeigt)');
  }

  // ── 10 Hauptbuch, PC2 ohne Datenbank, Prozesse ───────────────────────────
  {
    await spuelen(primary);
    const tx = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
                              FROM ledger_entries WHERE rowid > ? GROUP BY transaction_id`, [LEDGER_BASIS]);
    ok(tx.length > 0 && tx.every((t) => Number(t.d) === 0), `LEDGER jede Buchung dieses Laufs ausgeglichen (${tx.length} Transaktionen)`);
    const partnerKonto = zahl("SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0),3) AS n FROM ledger_entries WHERE account = 'PARTNER_ITEM_BALANCE'");
    const domaene = zahl("SELECT ROUND(COALESCE(SUM(CASE kind WHEN 'PAYOUT' THEN -amount ELSE amount END),0),3) AS n FROM item_partner_movements WHERE cancelled_at IS NULL");
    ok(Math.abs(partnerKonto - domaene) < 0.0005, `LEDGER Partner-Ausgleichskonto = Partnerbewegungen (${partnerKonto} / ${domaene})`);
    ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 hat keine eigene Geschäftsdatenbank angelegt');
    ok((await treffer(client)).length === 0, 'SAFETY PC2 hat nie eine lokale Datenbank angefragt');
    const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
    ok(S(fremdVorher) === S(fremdNachher), 'ISOLATION fremde LATAIF-Prozesse unberührt');
  }
} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\npartner-items-pc2 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_ITEMS_PC2_E2E_PROVED');
process.exit(0);

async function c_disabled(sel) {
  return client.ev(`const e=document.querySelector(${S(sel)}); return !!(e && e.disabled);`);
}
