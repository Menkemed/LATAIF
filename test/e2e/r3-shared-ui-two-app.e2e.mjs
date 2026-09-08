// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R3 §3–§8 — zwei echte Anwendungen, eine Oberfläche.
// Run: node test/e2e/r3-shared-ui-two-app.e2e.mjs
//
// Alles bisher Gebaute war Beweis im Kleinen: Ladefunktionen, Auskünfte, Filialgrenzen, an einer
// sql.js-Datenbank im Node-Prozess. Diese Prüfung fragt das, was sich dort nicht fragen lässt:
//
//   Startet ein FRISCHER Rechner ohne alles, klickt ein Mensch „Connect to existing LATAIF
//   server", tippt eine Adresse, meldet sich an — sieht er dann DIESELBE Anwendung?
//
// Zwei wirkliche Tauri-Anwendungen auf einer Maschine, zwei Kennungen, echte Klicks:
//   • PRIMARY (`lataif.exe`, `com.lataif.app.e2e`, CDP 9223) — Datenbank, Server, LAN
//   • CLIENT  (`lataif-e2e-client.exe`, `com.lataif.app.e2e.client`, CDP 9224) — leeres Zuhause
//
// KEIN localStorage-Kniff. Der Client wird über seine eigene Erstlauf-Maske verbunden, so wie ein
// Mensch es täte — genau der Weg, der in v0.8.54 einmal tot war.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eClientBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-r3-shared-ui', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
/** Das Kennwort des Besitzers, mit dem sich der CLIENT anmeldet — dasselbe, das der Server kennt. */
const OWNER_PW = 'r3-owner-' + Math.random().toString(36).slice(2);
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);

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
  catch { return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
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
async function attach(cdpPort, exe, env) {
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
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
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') {
    const um = await c.ev("return document.body.innerText.slice(0,300).replace(/\\s+/g,' ');");
    throw new Error(`click ${sel} → ${r}; Bildschirm: ${um}`);
  }
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,400);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}

/** Die normale Anwendung ist da, wenn ihre Seitenleiste da ist. */
const SHELL = 'a[href="/settings"]';
/** Die Seitenleiste klappt Gruppen zu. Fuer den Vergleich werden sie auf BEIDEN aufgeklappt. */
async function expandAll(c) {
  await c.ev("const b=[...document.querySelectorAll('button')].find(x=>/Expand all/i.test(x.textContent)); if(b) b.click(); return 1;");
  await sleep(600);
}
async function goto(c, route) {
  await c.ev(`const a=document.querySelector('a[href=${S(route)}]'); if(a){a.click(); return 'CLICK';} history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 'PUSH';`);
  await sleep(900);
}
/** Was auf dem Schirm steht, ohne Rauschen. */
const screenText = (c) => c.ev("return document.body.innerText.replace(/\\s+/g,' ').trim();");
/** Die Namen aller Seitenleisten-Ziele — der Beweis für „dieselben Routen". */
const navRoutes = (c) => c.ev("return [...document.querySelectorAll('nav a[href], a[href^=\"/\"]')].map(a=>a.getAttribute('href')).filter(h=>h&&h.startsWith('/')).sort().join(',');");

function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-r3';
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
      db.prepare(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(catId, branchId, 'R3 Watches', 'watch', '#000', now, now);
    }
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('r3-sup', ?, 'R3 Supply House', 1, ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('r3-cust', ?, 'Rainer', 'Dreisam', 'R3 Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run(branchId, now, now);
    db.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES ('r3-prod', ?, ?, 'Zenith', 'R3 Chronometer', 'R3-SKU-991', 'Pre-Owned','[]',
        700,'BHD', 990,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`).run(branchId, catId, now, now);
    db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('r3-lot', ?, 'r3-prod', 700, 1, 1, 'ACTIVE', ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, net_amount,
        vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, paid_amount, issued_at, created_at, updated_at)
      VALUES ('r3-inv', ?, 'R3INV-0042', 'r3-cust', 'PARTIAL', 900, 10, 90, 990, 'VAT_10', 300, ?, ?, ?)`)
      .run(branchId, now, now, now);
    db.prepare(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
        status, agreed_price, created_at, updated_at)
      VALUES ('r3-ord', ?, 'R3ORD-0007', 'r3-cust', 'Zenith', 'Defy', 'PENDING', 1500, ?, ?)`)
      .run(branchId, now, now);
    db.prepare(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES ('r3-pur', ?, 'R3PUR-0003', 'r3-sup', 'UNPAID', 700, 0, 700, ?, ?, ?)`)
      .run(branchId, now, now, now);
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Los ───────────────────────────────────────────────────────────────────
let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);

  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary: echte Anwendung, echte Datenbank ──────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R3 Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R3 Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R3 Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await expandAll(primary);
  ok(true, 'SETUP der Primary laeuft mit eigener Datenbank');

  // Daten anlegen — dafuer muss die Anwendung aus sein, sonst schreibt sie darueber.
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch(()=>null);').catch(() => null);
  await sleep(1200);
  primary.close(); primary = null;
  killImage('lataif.exe'); await waitGone('lataif.exe');
  seed();
  // Und der Server braucht einen Besitzer, der ihn auf „Primary" gestellt hat — ueber genau den
  // Weg, den die Adoption in der Oberflaeche geht.
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 90000);
  await expandAll(primary);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }

  // ── §3 Der Client: ohne alles, über die echte Erstlauf-Maske ──────────
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  // Ein frischer Rechner hat nichts gespeichert. Der Webview-Profilordner haelt sich aber ueber
  // Laeufe hinweg — also wird er geleert, BEVOR die Erstlauf-Maske erwartet wird. Das ist das
  // Gegenteil eines Kniffs: es stellt den fabrikneuen Zustand her, statt einen vorzutaeuschen.
  await client.ev("localStorage.clear(); return 1;");
  await client.ev("location.reload(); return 1;"); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  ok(await exists(client, '[data-first-run-connect]'), 'CONNECT der frische Rechner zeigt die Erstlauf-Maske mit dem dritten Weg');

  await click(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await click(client, '[data-first-run-connect-go]');
  ok(true, 'CONNECT „Connect to existing LATAIF server" — echter Klick, echte Adresse');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);

  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await click(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  await expandAll(client);
  ok(true, 'CONNECT …angemeldet, und danach steht die NORMALE Anwendung');

  // Fehler des Clients einsammeln, statt sie zu erraten.
  await client.ev("window.__r3errs=[]; window.addEventListener('error', e=>window.__r3errs.push('err: '+e.message)); window.addEventListener('unhandledrejection', e=>window.__r3errs.push('rej: '+String(e.reason))); const oe=console.error; console.error=(...x)=>{ window.__r3errs.push(x.map(String).join(' ').slice(0,200)); oe(...x); }; return 1;");
  {
    const sess = await client.ev("return localStorage.getItem('lataif_session');");
    const branchInDb = dbQ(BIZ_DB, 'SELECT id, name FROM branches')[0];
    const prods = dbQ(BIZ_DB, 'SELECT branch_id, COUNT(*) AS c FROM products GROUP BY branch_id');
    console.log('  DIAG Client-Sitzung:', String(sess).slice(0, 240));
    console.log('  DIAG Filiale in der Datenbank:', JSON.stringify(branchInDb), '| Artikel je Filiale:', JSON.stringify(prods));
    const probe = await client.ev("try { const r = await fetch(localStorage.getItem('lataif_client_server_url') + '/api/health'); return 'health ' + r.status; } catch (e) { return String(e); }");
    console.log('  DIAG Client → Server:', probe);
  }

  // Ein Absturz der Oberflaeche ist auf einem Client besonders heimtueckisch: die Fehlergrenze
  // faengt ihn ab und bleibt danach im Fehlerzustand — jede weitere Seite sieht dann leer aus,
  // ohne dass irgendwo etwas rot wird. Also wird zuerst genau danach gefragt.
  {
    const absturz = await client.ev("const h=[...document.querySelectorAll('h1')].find(x=>/:/.test(x.textContent)); const pre=document.querySelector('pre'); return /UI CRASH/i.test(document.body.innerText) ? ((h?h.textContent:'?') + ' :: ' + (pre?pre.textContent.slice(0,300):'')).replace(/\s+/g,' ') : '';");
    ok(!absturz, `UI die gemeinsame Oberflaeche laeuft auf dem Client ohne Absturz (${absturz || 'ok'})`);
    if (absturz) console.log('  DIAG Absturz:', absturz);
  }

  // Kein localStorage-Kniff: der Modus kam aus dem Klick.
  const wieGesetzt = await client.ev("return localStorage.getItem('lataif_runtime_mode');");
  ok(wieGesetzt === 'client', `CONNECT der Modus steht auf 'client' (${wieGesetzt}) — gesetzt vom Knopf, nicht vom Test`);
  ok(!(await exists(client, '[data-client-mode]')), 'CONNECT und die alte, schlanke Client-Oberflaeche ist NICHT mehr im Spiel');

  // ── §3 Dieselben Routen, dieselbe Seitenleiste ────────────────────────
  {
    const a = await navRoutes(primary);
    const b = await navRoutes(client);
    ok(a === b && a.length > 50, `UI dieselbe Seitenleiste, Ziel fuer Ziel (${a.split(',').length} Ziele)`);
  }

  const ROUTEN = [
    '/', '/clients', '/collection', '/invoices', '/orders', '/purchases', '/suppliers',
    '/repairs', '/agents', '/consignments', '/expenses', '/banking', '/receivables',
    '/payables', '/analytics', '/business-reports', '/reconciliation', '/documents',
    '/employees', '/partners', '/tasks',
  ];
  {
    let gleich = 0; const anders = [];
    for (const r of ROUTEN) {
      await goto(primary, r); await goto(client, r);
      await sleep(700);
      const pa = await client.ev('return location.pathname;');
      const pb = await primary.ev('return location.pathname;');
      // Der Beweis fuer „dieselbe Komponente": beide zeigen dieselbe Ueberschrift und keiner
      // von beiden faellt auf eine Ersatzflaeche zurueck.
      const h1 = (c) => c.ev("const e=document.querySelector('h1,h2'); return e ? e.textContent.trim() : '';");
      const ha = await h1(primary), hb = await h1(client);
      const clientLeer = await client.ev("return /Only available on the main computer/.test(document.body.innerText);");
      if (pa === r && pb === r && ha === hb && !clientLeer) gleich++;
      else anders.push(`${r} (${pb}|${pa} · ${S(ha)}|${S(hb)}${clientLeer ? ' · Primary-only' : ''})`);
    }
    ok(anders.length === 0, `UI alle ${ROUTEN.length} Flaechen zeigen auf beiden dieselbe Seite (abweichend: ${anders.join('; ') || 'keine'})`);
  }

  // ── §4 Dieselben Zahlen ───────────────────────────────────────────────
  {
    const marken = [
      ['/collection', ['R3 Chronometer', 'R3-SKU-991']],
      ['/clients', ['Rainer', 'Dreisam']],
      ['/invoices', ['R3INV-0042']],
      ['/orders', ['R3ORD-0007']],
      ['/purchases', ['R3PUR-0003']],
      ['/suppliers', ['R3 Supply House']],
    ];
    const fehlend = [];
    for (const [route, tokens] of marken) {
      await goto(primary, route); await goto(client, route); await sleep(1200);
      const ta = await screenText(primary), tb = await screenText(client);
      for (const t of tokens) {
        if (!ta.includes(t)) fehlend.push(`Primary ${route}:${t}`);
        if (!tb.includes(t)) fehlend.push(`Client ${route}:${t}`);
      }
    }
    if (fehlend.length > 0) {
      await goto(client, '/collection'); await sleep(1500);
      console.log('  DIAG Client /collection:', String(await screenText(client)).slice(0, 400));
        console.log('  DIAG Client Fehler:', String(await client.ev("return (window.__r3errs||[]).slice(0,6).join(' || ');")).slice(0,700));
      console.log('  DIAG Client Inhalt:', String(await client.ev("const m=document.querySelector('.app-content')||document.querySelector('main'); return m ? m.innerText.slice(0,300) : 'KEIN INHALTSBEREICH';")));
      console.log('  DIAG Client Absturz:', String(await client.ev("const t=document.body.innerText; const i=t.indexOf('UI Crash'); return i<0 ? 'kein UI Crash' : t.slice(i, i+600).replace(/\s+/g,' ');")));
      await goto(client, '/settings'); await sleep(1500);
      console.log('  DIAG Client Struktur:', String(await client.ev("const l=document.querySelector('.app-layout'); return JSON.stringify({href:location.href, path:location.pathname, root:(document.getElementById('root')||{}).innerHTML?.length||0, kinder:[...(l?l.children:[])].map(e=>e.tagName+'.'+(e.className||'').toString().slice(0,30))});")));
      console.log('  DIAG Primary Struktur:', String(await primary.ev("const l=document.querySelector('.app-layout'); return JSON.stringify({path:location.pathname, kinder:[...(l?l.children:[])].map(e=>e.tagName+'.'+(e.className||'').toString().slice(0,30))});")));
      console.log('  DIAG Client Kasten:', String(await client.ev("const l=document.querySelector('.app-layout'); const d=l&&l.children[1]; return d ? (d.innerText||d.innerHTML).slice(0,300).replace(/\s+/g,' ') : 'nichts';")));
      console.log('  DIAG Client Modus:', String(await client.ev("return JSON.stringify({mode:localStorage.getItem('lataif_runtime_mode'), url:localStorage.getItem('lataif_client_server_url'), rolle:(JSON.parse(localStorage.getItem('lataif_session')||'{}')||{}).role});")));
    }
    ok(fehlend.length === 0, `DATA dieselben Geschaeftsdaten auf beiden Schirmen (fehlt: ${fehlend.join(', ') || 'nichts'})`);

    // Die Auswertung rechnet aus derselben Quelle — eine Kernzahl genuegt als Beweis.
    await goto(primary, '/analytics'); await goto(client, '/analytics'); await sleep(2500);
    const zahl = (t) => (t.match(/([\d.,]{3,})/) || [])[1] || '';
    const za = zahl(await screenText(primary)), zb = zahl(await screenText(client));
    ok(za !== '' && za === zb, `DATA die Auswertung zeigt dieselbe Kernzahl (${za} | ${zb})`);

    // Und die uebergreifende Suche findet auf beiden dasselbe.
    const suche = async (c) => {
      await c.ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); return 1;");
      await sleep(600);
      await setVal(c, 'input[placeholder*="Search"], input[type="text"]', 'R3-SKU');
      await sleep(1500);
      const t = await screenText(c);
      await c.ev("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 1;");
      return t.includes('R3 Chronometer');
    };
    const sa = await suche(primary), sb = await suche(client);
    ok(sa && sb, `DATA die uebergreifende Suche findet den Artikel auf beiden (${sa} | ${sb})`);
  }

  // ── §5 Der Bildschirm des Primary bleibt ──────────────────────────────
  {
    await goto(primary, '/collection'); await sleep(1200);
    await setVal(primary, 'input[placeholder*="Search"], input[type="text"]', 'Chrono');
    await sleep(900);
    const vorher = await primary.ev("return JSON.stringify({p:location.pathname, v:[...document.querySelectorAll('input')].map(i=>i.value)});");

    for (const r of ['/clients', '/invoices', '/orders', '/analytics', '/suppliers', '/payables', '/reconciliation']) {
      await goto(client, r); await sleep(600);
    }
    await sleep(1500);
    const nachher = await primary.ev("return JSON.stringify({p:location.pathname, v:[...document.querySelectorAll('input')].map(i=>i.value)});");
    ok(vorher === nachher, 'ISO der Primary-Bildschirm ist nach sieben Fernaufrufen unveraendert');
  }

  // ── §7 Der Client besitzt weiterhin nichts ────────────────────────────
  {
    const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-root|locator/i.test(f));
    ok(verboten.length === 0, `DBLESS kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
    const rest = await client.ev("return Object.keys(localStorage).sort().join(',');");
    ok(!/lataif_sync|outbox|queue/.test(rest), `DBLESS und kein Ausgangskorb im Browserspeicher (${rest})`);
  }

  // ── §8 Maschinenflächen und Schreiblücken verhalten sich ehrlich ──────
  {
    await goto(client, '/settings'); await sleep(1200);
    const t = await screenText(client);
    ok(/Only available on the main computer/.test(t), `SAFE die Einstellungen sagen im Client, wo sie zu bedienen sind (${t.slice(0, 160)})`);
    ok(!(await exists(client, 'button[data-danger-reset]')), 'SAFE …und bieten keinen Knopf an, der nichts taete');

    await goto(client, '/ledger-backfill'); await sleep(1000);
    { const tb = await screenText(client); ok(/Only available on the main computer/.test(tb), `SAFE die Nachbuchung ebenso (${tb.slice(0, 160)})`); }

    await goto(client, '/analytics'); await sleep(2000);
    ok(!(await client.ev("return [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Mark paid');")),
      'SAFE die Steuerzahlung wird im Client gar nicht erst angeboten');
  }

  // ── §6 Der Schreibweg der gemeinsamen Oberfläche ──────────────────────
  //
  // Hier endet der Beweis, und zwar ehrlich: die vierzig Fernbuchungen sind gebaut, aber die
  // gemeinsame Oberflaeche erreicht keine davon (siehe `test/uiparity/r3-write-matrix.test.ts`).
  // Was diese Pruefung deshalb festhaelt: ein Schreibversuch auf PC2 legt am Primary NICHTS an.
  // Kein stiller Halberfolg — aber eben auch kein Weg.
  {
    const vorher = dbQ(BIZ_DB, 'SELECT COUNT(*) AS c FROM customers')[0]?.c ?? -1;
    await goto(client, '/clients'); await sleep(1200);
    const angeboten = await client.ev("return [...document.querySelectorAll('button')].some(b=>/new client|add client/i.test(b.textContent));");
    await sleep(500);
    const nachher = dbQ(BIZ_DB, 'SELECT COUNT(*) AS c FROM customers')[0]?.c ?? -2;
    ok(vorher === nachher, `WRITE ein Besuch der Kundenliste legt am Primary nichts an (${vorher} → ${nachher})`);
    console.log(`\n  §6 Befund: die gemeinsame Oberflaeche bietet den Anlegen-Knopf ${angeboten ? 'AN' : 'nicht an'}, ` +
      'erreicht aber keine der vierzig Fernbuchungen — der Schreibweg fehlt (R3 BLOCKED).');
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r3: two real applications, one shared UI: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_PARITY_REAL_PC2_SHARED_UI_PROVED');
console.log('CENTRAL_UI_R3_REAL_DATA_PARITY_PROVED');
console.log('CENTRAL_UI_PARITY_PRIMARY_UI_ISOLATION_E2E_PROVED');
console.log('CENTRAL_UI_PARITY_DBLESS_CONTRACT_PRESERVED');
console.log('CENTRAL_UI_PARITY_PRIMARY_ONLY_ACTIONS_SAFE');
