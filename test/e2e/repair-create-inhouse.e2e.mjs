// ════════════════════════════════════════════════════════════════════════════
// REPAIR CREATE + ADDITIONAL IN-HOUSE COST — die Anlegemaske in der echten Test-App (nur Primary).
// Run: node test/e2e/repair-create-inhouse.e2e.mjs
//
// Feldbefund: „Create Repair" tat nichts. Hier wird an der echten Maske bewiesen:
//   • ein fehlendes Pflichtfeld (Kunde, Problem) sagt, WAS fehlt — kein stiller Abbruch;
//   • Internal / External / Hybrid legen je genau EINE Reparatur an, die Detailseite öffnet sie;
//   • Internal ohne Zusatzkosten: Save / Edit / Ready → 0 zusätzliche eigene Kosten, keine Buchung;
//   • Internal mit 10 BHD echten Zusatzkosten → genau 10 BHD eigene Arbeit.
// Isoliert: com.lataif.app.e2e, Port 3011 — Produktion und E:\LATAIF\Data bleiben unberührt.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone } from './_e2e-process.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const RUN = join(os.tmpdir(), 'lataif-repair-create', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const info = (m) => console.log('  · ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht.'); aufraeumen(); process.exit(1); }, 30 * 60 * 1000);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(sql, params = []) {
  let db;
  try { db = new DatabaseSync(BIZ_DB, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk || daten[sp.name] !== undefined) continue;
    daten[sp.name] = /INT|REAL|NUM/.test(String(sp.type || '').toUpperCase()) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}
let WATCH = 'Watch';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const cat = db.prepare("SELECT name FROM categories WHERE id = 'cat-watch'").get();
    if (cat) WATCH = String(cat.name);
    else insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'rc-kunde', branch_id, first_name: 'Rana', last_name: 'Create', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'rc-werkstatt', branch_id, name: 'RC Werkstatt', active: 1, created_at: now, updated_at: now });
  } finally { db.close(); }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.events = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') this.events.push(`console.error: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
      if (m.method === 'Runtime.exceptionThrown') this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''}`.slice(0, 300));
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
async function attach() {
  spawnTracked(APP, [], { env: appEnv(), stdio: 'ignore', detached: true }).unref();
  const end = Date.now() + 120000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page');
  const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c;
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error(`waitFor ${sel} — Bildschirm: ${String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' ')}`);
}
async function warteBis(c, ausdruck, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); } return false; }
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const spuelen = (c) => c.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
async function ssPick(c, placeholder, optionId) {
  if (await klick(c, `[data-ss-trigger=${S(placeholder)}]`) !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 15000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`); await sleep(300);
  return 'OK';
}
const alleOk = (r) => { const b = r.filter((x) => x !== 'OK'); return b.length ? 'FELD:' + b.join(',') : 'OK'; };
const zeilen = () => Number(dbQ('SELECT COUNT(*) n FROM repairs')[0]?.n || 0);

// ── Die Maske, wie ein Mensch sie bedient ──
async function neueMaske(c) {
  await geh(c, '/tasks'); await sleep(500); await geh(c, '/repairs');
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Repair')", 30000))) return 'KEIN-KNOPF';
  await clickText(c, 'New Repair');
  return (await warteBis(c, "document.querySelector('[data-create-repair]')", 15000)) ? 'OK' : 'KEINE-MASKE';
}
async function ausfuellen(c, { kunde = true, issue = 'Service', typ = 'Internal' } = {}) {
  const r = [];
  if (kunde) r.push(await ssPick(c, 'Search clients by name, company, phone...', 'rc-kunde'));
  r.push(await clickText(c, WATCH)); await sleep(300);
  r.push(await setByLabel(c, 'BRAND', 'Rolex'));
  r.push(await setByLabel(c, 'NAME / MODEL', 'Datejust'));
  if (issue) r.push(await setVal(c, 'textarea[placeholder="Describe the issue or requested repair..."]', issue));
  if (typ !== 'Internal') { r.push(await clickText(c, typ)); await sleep(300); }
  return alleOk(r);
}
/** „Create Repair" klicken und festhalten, was danach zu sehen ist. */
async function anlegen(c) {
  await spuelen(c); const vorher = zeilen(); c.events.length = 0;
  const knopf = await c.ev(`const b=document.querySelector('[data-create-repair]'); return b ? (b.disabled ? 'disabled' : 'enabled') : 'missing';`);
  await klick(c, '[data-create-repair]');
  const zu = await warteBis(c, "!document.querySelector('[data-create-repair]')", 20000);
  await sleep(800); await spuelen(c);
  return {
    knopf, zu, vorher, nachher: zeilen(),
    pfad: await c.ev('return location.pathname;'),
    hinweis: await c.ev(`return document.querySelector('[data-save-error]')?.textContent || '';`),
    alerts: await c.ev('return JSON.stringify(window.__alerts || []);'),
    events: c.events.slice(),
  };
}
async function bearbeitenSpeichern(c, eigeneKosten) {
  if (await clickText(c, 'Edit') !== 'OK') return 'KEIN-EDIT';
  await waitFor(c, '[data-repair-save]', 10000);
  if (eigeneKosten !== undefined) { const r = await setByLabel(c, 'ADDITIONAL IN-HOUSE COST (BHD)', String(eigeneKosten)); if (r !== 'OK') return r; }
  await klick(c, '[data-repair-save]');
  return (await warteBis(c, "!document.querySelector('[data-repair-save]')", 20000)) ? 'OK' : 'SPEICHERN-HAENGT:' + (await c.ev(`return document.querySelector('[data-save-error]')?.textContent || '';`));
}
async function bisReady(c, id) {
  for (let i = 0; i < 6; i++) {
    await spuelen(c);
    const st = String(dbQ('SELECT status FROM repairs WHERE id = ?', [id])[0]?.status || '').toLowerCase();
    if (st === 'ready') return 'OK';
    if (!(await warteBis(c, "document.querySelector('[data-repair-advance]') && !document.querySelector('[data-repair-advance]').disabled", 15000))) return 'KEIN-WEITER:' + st;
    await klick(c, '[data-repair-advance]'); await sleep(600);
    if (await exists(c, '[data-app-confirm-ok]')) { await klick(c, '[data-app-confirm-ok]'); await sleep(400); }
    await warteBis(c, `true`, 1); await sleep(1200);
  }
  return 'NICHT-READY';
}
const eigeneArbeit = (id) => Number(dbQ(`SELECT COALESCE(SUM(e1.amount),0) t FROM ledger_entries e1
  WHERE e1.source_module = 'REPAIR_OWN_WORK' AND e1.direction = 'DEBIT' AND e1.reverses_entry_id IS NULL
    AND (e1.source_id = ? OR e1.source_id IN (SELECT id FROM repair_lines WHERE repair_id = ?))
    AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`, [id, id])[0]?.t || 0);
const ausgaben = (id) => Number(dbQ("SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'", [id])[0]?.t || 0);
const kopf = (id) => dbQ('SELECT repair_type, estimated_cost, actual_cost, internal_cost, status FROM repairs WHERE id = ?', [id])[0] || {};

let app = null;
try {
  aufraeumen(); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Einrichten: Onboarding, dann Kunde + Werkstatt säen ──
  app = await attach();
  await waitFor(app, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(app, '[data-first-run-new]')) { await klick(app, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(app, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(app, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(app, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'RC Co');
    await setVal(app, 'input[placeholder="e.g. Main Store"]', 'RC Branch');
    await clickText(app, 'Next'); await waitFor(app, 'input[placeholder="Full name"]');
    await setVal(app, 'input[placeholder="Full name"]', 'RC Admin');
    await setVal(app, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(app, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(app, 'Next'); await waitFor(app, 'input[placeholder="10"]');
    await setVal(app, 'input[placeholder="10"]', '10');
    await app.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(app, 'a[href="/settings"]', 60000);
  await spuelen(app).catch(() => null); await sleep(1200);
  app.close(); app = null; killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  seed();
  app = await attach();
  await waitFor(app, 'a[href="/settings"], input[type="password"]', 90000);
  if (!(await exists(app, 'a[href="/settings"]'))) {
    await setVal(app, 'input[type="email"]', OWNER_EMAIL);
    await setVal(app, 'input[type="password"]', ONBOARD_PW);
    await app.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(app, 'a[href="/settings"]', 90000);
  // Meldungen festhalten statt ein natives Fenster zu öffnen, das den Lauf anhält.
  await app.ev('window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); }; return 1;');

  // ── 1 Fehlende Pflichtangaben: der Knopf sagt, was fehlt ──
  ok(await neueMaske(app) === 'OK', 'MASKE „New Repair" öffnet');
  ok(await ausfuellen(app, { issue: '' }) === 'OK', 'PFLICHT Kunde + Artikel, Problem leer');
  let a = await anlegen(app);
  info(`ohne Problem: Knopf ${a.knopf}, Maske zu ${a.zu}, Zeilen ${a.vorher}→${a.nachher}, Hinweis „${a.hinweis}", alerts ${a.alerts}, Fehler ${S(a.events)}`);
  ok(a.knopf === 'enabled' && !a.zu && a.nachher === a.vorher && /issue/i.test(a.hinweis), `PFLICHT ohne Problem: nichts angelegt, die Maske nennt „Issue" (${a.hinweis || 'kein Hinweis'})`);
  ok(a.events.length === 0, `PFLICHT kein JS-Fehler (${S(a.events)})`);
  ok(await neueMaske(app) === 'OK' && await ausfuellen(app, { kunde: false }) === 'OK', 'PFLICHT Problem + Artikel, Kunde leer');
  a = await anlegen(app);
  ok(!a.zu && a.nachher === a.vorher && /client/i.test(a.hinweis), `PFLICHT ohne Kunde: nichts angelegt, die Maske nennt „Client" (${a.hinweis || 'kein Hinweis'})`);

  // ── 2 Internal, Zusatzkosten leer ──
  ok(await neueMaske(app) === 'OK' && await ausfuellen(app, { issue: 'Internal leer' }) === 'OK', 'INTERNAL Maske ausgefüllt, Zusatzkosten leer');
  a = await anlegen(app);
  const internal = dbQ("SELECT id FROM repairs WHERE issue_description = 'Internal leer'");
  ok(a.zu && a.nachher === a.vorher + 1 && internal.length === 1, `INTERNAL genau eine Reparatur angelegt (${a.vorher}→${a.nachher}; ${a.hinweis || 'kein Hinweis'}; ${S(a.events)})`);
  const iId = internal[0]?.id;
  ok(a.pfad === `/repairs/${iId}`, `INTERNAL die Detailseite öffnet die neue Reparatur (${a.pfad})`);
  ok(kopf(iId).repair_type === 'internal' && Number(kopf(iId).internal_cost || 0) === 0 && kopf(iId).estimated_cost === null, `INTERNAL 0 zusätzliche eigene Kosten (${S(kopf(iId))})`);
  ok(await warteBis(app, "document.body.innerText.includes('ADDITIONAL IN-HOUSE COST')", 10000), 'INTERNAL die Detailseite zeigt „Additional In-house Cost"');

  // ── 3 External ──
  ok(await neueMaske(app) === 'OK' && await ausfuellen(app, { issue: 'External neu', typ: 'External' }) === 'OK', 'EXTERNAL Maske ausgefüllt');
  ok(await ssPick(app, 'Pick: In-house OR a workshop / goldsmith', 'rc-werkstatt') === 'OK'
    && await setByLabel(app, 'WORKSHOP FEE (BHD, OPTIONAL)', '30') === 'OK' && await setByLabel(app, 'CHARGE TO CLIENT (BHD)', '90') === 'OK', 'EXTERNAL Werkstatt, Gebühr 30, Kunde 90');
  a = await anlegen(app);
  const ext = dbQ("SELECT id FROM repairs WHERE issue_description = 'External neu'");
  ok(a.zu && a.nachher === a.vorher + 1 && ext.length === 1 && a.pfad === `/repairs/${ext[0]?.id}`, `EXTERNAL genau eine Reparatur, Detailseite offen (${a.vorher}→${a.nachher}, ${a.pfad}; ${a.hinweis})`);
  ok(kopf(ext[0]?.id).repair_type === 'external' && Number(kopf(ext[0]?.id).estimated_cost) === 30, `EXTERNAL Art und Gebühr gespeichert (${S(kopf(ext[0]?.id))})`);

  // ── 4 Hybrid ──
  ok(await neueMaske(app) === 'OK' && await ausfuellen(app, { issue: 'Hybrid neu', typ: 'Hybrid' }) === 'OK', 'HYBRID Maske ausgefüllt');
  ok(await ssPick(app, 'Pick: In-house OR a workshop / goldsmith', 'rc-werkstatt') === 'OK'
    && await setByLabel(app, 'WORKSHOP FEE (BHD)', '20') === 'OK', 'HYBRID Werkstatt, Gebühr 20, eigene Zusatzkosten leer');
  a = await anlegen(app);
  const hyb = dbQ("SELECT id FROM repairs WHERE issue_description = 'Hybrid neu'");
  ok(a.zu && a.nachher === a.vorher + 1 && hyb.length === 1 && a.pfad === `/repairs/${hyb[0]?.id}`, `HYBRID genau eine Reparatur, Detailseite offen (${a.vorher}→${a.nachher}, ${a.pfad}; ${a.hinweis})`);
  ok(kopf(hyb[0]?.id).repair_type === 'hybrid' && Number(kopf(hyb[0]?.id).estimated_cost) === 20, `HYBRID Art und Gebühr 20 gespeichert (${S(kopf(hyb[0]?.id))})`);
  // Zur Kenntnis (Buchungslogik unverändert): die Aufnahme spiegelt bei Hybrid-Kundenreparaturen die Gebühr in `internal_cost`.
  info(`HYBRID eigene Kosten nach der Aufnahme: ${kopf(hyb[0]?.id).internal_cost} (Gebühr ${kopf(hyb[0]?.id).estimated_cost})`);

  // ── 5 Internal leer → Save / Edit / Ready → 0 ──
  await geh(app, '/repairs/' + iId); await sleep(1500);
  ok(await bearbeitenSpeichern(app) === 'OK', 'LEER Edit → Save ohne Änderung');
  await spuelen(app);
  ok(Number(kopf(iId).internal_cost || 0) === 0, `LEER nach Save 0 eigene Kosten (${S(kopf(iId))})`);
  const r5 = await bisReady(app, iId);
  ok(r5 === 'OK', `LEER bis Ready (${r5})`);
  await spuelen(app);
  ok(Number(kopf(iId).internal_cost || 0) === 0 && eigeneArbeit(iId) === 0 && ausgaben(iId) === 0,
    `LEER Ready: 0 eigene Kosten, keine Eigenleistung, keine Ausgabe (${S(kopf(iId))}, Eigenleistung ${eigeneArbeit(iId)}, Ausgaben ${ausgaben(iId)})`);

  // ── 6 Internal mit 10 BHD echten Zusatzkosten → genau 10 ──
  ok(await neueMaske(app) === 'OK' && await ausfuellen(app, { issue: 'Internal zehn' }) === 'OK', 'ZEHN Maske ausgefüllt');
  a = await anlegen(app);
  const zId = dbQ("SELECT id FROM repairs WHERE issue_description = 'Internal zehn'")[0]?.id;
  ok(!!zId && a.pfad === `/repairs/${zId}`, `ZEHN angelegt, Detailseite offen (${a.pfad})`);
  ok(await bearbeitenSpeichern(app, 10) === 'OK', 'ZEHN Edit → „Additional In-house Cost" 10 → Save');
  ok(await bisReady(app, zId) === 'OK', 'ZEHN bis Ready');
  await spuelen(app);
  ok(Number(kopf(zId).internal_cost) === 10 && Math.abs(eigeneArbeit(zId) - 10) < 0.0005 && ausgaben(zId) === 0,
    `ZEHN genau 10 BHD eigene Arbeit, keine Ausgabe/Zahlung (${S(kopf(zId))}, Eigenleistung ${eigeneArbeit(zId)}, Ausgaben ${ausgaben(zId)})`);

  // ── 7 Zur Kenntnis: 10 nur beim Anlegen geschätzt, ohne Edit direkt auf Ready ──
  ok(await neueMaske(app) === 'OK' && await ausfuellen(app, { issue: 'Internal geschaetzt' }) === 'OK'
    && await setByLabel(app, 'ESTIMATED ADDITIONAL IN-HOUSE COST (BHD, OPTIONAL)', '10') === 'OK', 'SCHAETZUNG Maske mit geschätzten 10');
  a = await anlegen(app);
  const sId = dbQ("SELECT id FROM repairs WHERE issue_description = 'Internal geschaetzt'")[0]?.id;
  ok(!!sId && a.pfad === `/repairs/${sId}`, `SCHAETZUNG angelegt, Detailseite offen (${a.pfad})`);
  ok(await bisReady(app, sId) === 'OK', 'SCHAETZUNG bis Ready (ohne Edit)');
  await spuelen(app);
  info(`SCHAETZUNG nach Ready ohne Edit: ${S(kopf(sId))}, Eigenleistung ${eigeneArbeit(sId)}, Ausgaben ${ausgaben(sId)}`);
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  try { app?.close(); } catch { /* zu */ }
  aufraeumen(); await waitTestImageGone('lataif.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* egal */ }
  clearTimeout(WACHHUND);
  console.log(`\nREPAIR create + additional in-house (real app): ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
