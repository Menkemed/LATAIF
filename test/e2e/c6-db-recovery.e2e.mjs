// CENTRAL-C6-P1 — eine vorhandene, aber nicht zu oeffnende Datenbank darf nichts kosten.
//
// Drei Zustaende, drei verschiedene Ausgaenge — und der mittlere ist der, der frueher Daten
// gefressen hat:
//
//   §1  KEINE lataif.db          → der bestehende Erstlauf-/Provisionierungsweg laeuft wie bisher
//   §2  lataif.db vorhanden, aber nicht zu oeffnen
//                                → Wiederherstellungs-Gate: Datei bytegleich, keine neue Datenbank,
//                                  nichts gespeichert, keine Geschaeftslaufzeit, kein Netz
//   §3  dieselbe Datei wieder heil → normaler Start MIT den alten Daten
//
// Der Fehler wird ECHT erzeugt (die Datei wird wirklich unbrauchbar gemacht), nicht ueber einen
// Schalter im Produkt — im ausgelieferten Programm gibt es keinen.

import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-c6-recovery', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const GOOD_COPY = join(RUN, 'good-lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

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
  close() { try { this.ws.close(); } catch { /* egal */ } }
}

const killImage = (name) => { try { execFileSync('taskkill', ['/F', '/IM', name, '/T'], { stdio: 'ignore' }); } catch { /* laeuft nicht */ } };
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!out.includes(name)) return; } catch { return; }
    await sleep(300);
  }
}
async function waitPortFree(port) {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); if (!out.split('\n').some((l) => l.includes(`:${port} `) && /LISTENING/.test(l))) return; } catch { return; }
    await sleep(300);
  }
}
const portListening = () => {
  try { return execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split('\n').some((l) => l.includes(`:${PORT} `) && /LISTENING/.test(l)); }
  catch { return false; }
};
async function findPage(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch { /* noch nicht oben */ }
    await sleep(400);
  }
  return null;
}
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 60000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor ' + sel);
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}

console.log('CENTRAL-C6-P1 — an unreadable existing database costs nothing\n');
let app = null;
try {
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });

  ok(assertE2eBinary(APP).verified.length === 4, 'ARTEFACT the primary is the isolated e2e build');
  assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });

  async function start() {
    spawn(APP, [], { env: appEnv(), stdio: 'ignore', detached: true }).unref();
    const page = await findPage(120000);
    if (!page) throw new Error('no CDP page');
    const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c;
  }
  async function stop(c) {
    try { c?.close(); } catch { /* egal */ }
    killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  }


  // ── §1 — KEINE Datenbank: der Erstlaufweg ist unveraendert ──────────────
  app = await start();
  await waitInvoke(app);
  await waitFor(app, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 120000);
  ok(await exists(app, 'input[placeholder="e.g. Al-Khalifa Luxury"]'),
    'FIRST-RUN without a database the provisioning wizard still comes up');
  await setVal(app, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
  await setVal(app, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
  await clickText(app, 'Next'); await waitFor(app, 'input[placeholder="Full name"]');
  await setVal(app, 'input[placeholder="Full name"]', 'E2E Admin');
  await setVal(app, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
  await setVal(app, 'input[placeholder="Choose a password"]', ONBOARD_PW);
  await clickText(app, 'Next'); await waitFor(app, 'input[placeholder="10"]');
  await setVal(app, 'input[placeholder="10"]', '10');
  await app.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  await waitFor(app, 'a[href="/settings"], nav a, [data-testid]', 60000);
  ok(true, 'FIRST-RUN …and it provisions through to the app');
  await sleep(2500);
  await stop(app); app = null;
  ok(existsSync(BIZ_DB), 'FIRST-RUN …leaving a real business database behind');

  // Der gute Stand wird gesichert — es wird KEINE Produktionsdatenbank angefasst.
  copyFileSync(BIZ_DB, GOOD_COPY);
  const goodSha = sha(GOOD_COPY), goodSize = statSync(GOOD_COPY).size;
  const goodUsers = (() => {
    const d = new DatabaseSync(GOOD_COPY, { readOnly: true });
    try { return Number(d.prepare('SELECT COUNT(*) c FROM users').get().c); } finally { d.close(); }
  })();
  ok(goodSize > 0 && goodUsers > 0, `FIXTURE the good copy holds real data (${goodSize}B, ${goodUsers} users)`);

  // ── §2 — vorhanden, aber nicht zu oeffnen ───────────────────────────────
  // Echt kaputt: der SQLite-Kopf bleibt stehen, alles dahinter ist Rauschen. Die Datei SIEHT
  // aus wie eine Datenbank und ist keine — genau der Fall, der frueher zur Neuanlage fuehrte.
  const broken = Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), randomBytes(3000)]);
  writeFileSync(BIZ_DB, broken);
  const brokenSha = sha(BIZ_DB), brokenSize = statSync(BIZ_DB).size;
  const filesBefore = readdirSync(APP_DATA_DIR).sort();

  app = await start();
  await waitInvoke(app);
  // Warten, bis die Anwendung fertig entschieden hat — und dann nachsehen, was sie tat.
  await sleep(12000);
  const screen = String(await app.ev('return document.body.innerText.slice(0, 600);')).replace(/\s+/g, ' ');
  ok(/nicht geoeffnet werden|Sicherung wieder her/.test(screen),
    `RECOVERY the app shows a recovery message instead of an empty app (${screen.slice(0, 90)})`);
  ok(!(await exists(app, 'a[href="/settings"], nav a')),
    'RECOVERY …the business shell never becomes ready');
  ok(!(await exists(app, 'input[placeholder="e.g. Al-Khalifa Luxury"]')),
    'RECOVERY …and it is NOT treated as a first run');
  ok(sha(BIZ_DB) === brokenSha && statSync(BIZ_DB).size === brokenSize,
    `RECOVERY the existing file is byte-for-byte untouched (${brokenSize}B)`);
  const filesAfter = readdirSync(APP_DATA_DIR).sort();
  ok(!filesAfter.some((f) => /^lataif\.db\.tmp/.test(f)),
    `RECOVERY no half-written database beside it (${filesAfter.filter((f) => f.startsWith('lataif.db')).join(' ')})`);
  ok(filesAfter.filter((f) => f.startsWith('lataif.db')).length === 1,
    'RECOVERY …and no second business database was created');
  ok(!portListening(), 'RECOVERY the business server never came up, so no remote write is possible');
  let health = 'no-answer';
  try { health = String((await fetch(`${BASE}/api/health`)).status); } catch { health = 'no-answer'; }
  ok(health === 'no-answer', `RECOVERY …and nothing answers on the LAN (${health})`);
  // Ein letzter Beweis, dass wirklich nichts geschrieben wurde: das Beenden darf die kaputte
  // Datei ebenso wenig anfassen wie der Start.
  await stop(app); app = null;
  ok(sha(BIZ_DB) === brokenSha, 'RECOVERY …and shutting down does not write over it either');
  // Der Start legt vor der Datenbankfrage seine eigenen Kontrolldateien an (Datenwurzel,
  // Serverdatenbank, Medienordner) — das ist kein Geschaeftsbestand. Was zaehlt: es ist NICHTS
  // verschwunden, und rund um `lataif.db` hat sich nichts veraendert.
  const filesEnd = readdirSync(APP_DATA_DIR).sort();
  const lost = filesBefore.filter((f) => !filesEnd.includes(f));
  const appeared = filesEnd.filter((f) => !filesBefore.includes(f));
  ok(lost.length === 0, `RECOVERY nothing was removed from the data directory (${lost.join(' ') || 'nothing'})`);
  ok(JSON.stringify(filesBefore.filter((f) => f.startsWith('lataif.db')))
    === JSON.stringify(filesEnd.filter((f) => f.startsWith('lataif.db'))),
    `RECOVERY and around the business database nothing changed (appeared elsewhere: ${appeared.join(' ') || 'nothing'})`);

  // ── §3 — dieselbe Datei wieder heil: normaler Start mit den alten Daten ──
  copyFileSync(GOOD_COPY, BIZ_DB);
  ok(sha(BIZ_DB) === goodSha, 'RESTORE the original database is back in place, unchanged');
  app = await start();
  await waitInvoke(app);
  await waitFor(app, 'a[href="/settings"], nav a, [data-testid], input[type="email"]', 120000);
  if (await exists(app, 'input[type="email"]')) {
    await setVal(app, 'input[type="email"]', OWNER_EMAIL);
    await setVal(app, 'input[type="password"]', ONBOARD_PW);
    await app.ev("[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;");
  }
  await waitFor(app, 'a[href="/settings"], nav a, [data-testid]', 60000);
  ok(true, 'RESTORE the app starts normally again');
  ok(!(await exists(app, 'input[placeholder="e.g. Al-Khalifa Luxury"]')),
    'RESTORE …and does not ask to be provisioned again');
  await sleep(2000);
  const usersNow = (() => {
    const d = new DatabaseSync(BIZ_DB, { readOnly: true });
    try { return Number(d.prepare('SELECT COUNT(*) c FROM users').get().c); } finally { d.close(); }
  })();
  ok(usersNow === goodUsers, `RESTORE …with its own data (${usersNow} users, was ${goodUsers})`);
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.stack || e));
  console.log('  x harness: ' + (e?.message || e));
} finally {
  try { app?.close(); } catch { /* egal */ }
  killImage('lataif.exe'); await waitGone('lataif.exe');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c6 p1 database recovery: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('  · ' + f); process.exit(1); }
console.log('CENTRAL_C6_DB_LOAD_FAILURE_NO_DATA_LOSS_PROVED');
