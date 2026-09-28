// ════════════════════════════════════════════════════════════════════════════
// Rückfragen in der echten Desktop-App: `await window.confirm(…)` muss ein Fenster öffnen.
// Run: node test/e2e/native-confirm.e2e.mjs
//
//   Das Dialog-Plugin legt `window.confirm` auf den Befehl `plugin:dialog|confirm`, den es in 2.7
//   nicht mehr gibt — jede Rückfrage wurde sofort abgelehnt und der Knopf tat nichts (z. B.
//   „Settle sale"). Alle anderen E2E-Läufe ersetzen `window.confirm` selbst und sahen das nie.
//   Hier wird NICHT ersetzt: die Rückfrage muss offen stehen (Dialog der App wartet auf den
//   Benutzer), statt abgelehnt zu werden; Cancel antwortet „Nein".
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat.
// Port 3011, CDP 9223, Datenordner com.lataif.app.e2e.
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, spawnTracked, waitTestImageGone, foreignProcesses, killTestImage } from './_e2e-process.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const RUN = join(os.tmpdir(), 'lataif-confirm', 'run-' + Date.now());
const APP_DATA_DIR = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), IDENT);

let PASS = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

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

const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze'); killStarted(); process.exit(1); }, 5 * 60 * 1000);
let c = null;
try {
  const fremd = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));
  spawnTracked(APP, [], { env: appEnv(), stdio: 'ignore', detached: true }).unref();
  const end = Date.now() + 120000; let page = null;
  while (Date.now() < end && !page) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
    } catch { /* noch nicht oben */ }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('no CDP page');
  c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  for (let i = 0; i < 60 && !(await c.ev('return !!document.getElementById("root")?.children.length;')); i++) await sleep(500);

  // Ohne Stub: die echte Rückfrage. Offen = Fenster wartet; abgelehnt = der alte Fehler.
  const r = await c.ev(`
    const p = window.confirm('LATAIF E2E — confirm check (the test closes this window)');
    window.__e2eConfirm = p;
    if (!(p instanceof Promise)) return 'sync:' + String(p);
    return await Promise.race([
      p.then((v) => 'resolved:' + v, (e) => 'rejected:' + String(e)),
      new Promise((res) => setTimeout(() => res('pending'), 2500)),
    ]);`);
  console.log('  confirm →', r);
  ok(r === 'pending', `RÜCKFRAGE öffnet ein Fenster und wartet auf den Benutzer statt abzulehnen (${r})`);
  // Die Rückfrage steht im Dialog der App; Cancel beantwortet sie mit „Nein".
  const imDialog = await c.ev("return !!document.querySelector('[data-app-confirm]') && (document.querySelector('[data-app-confirm-text]')?.textContent || '').includes('confirm check');");
  await c.ev("document.querySelector('[data-app-confirm-cancel]')?.click(); return 1;");
  const antwort = await c.ev('return String(await window.__e2eConfirm);');
  ok(imDialog && antwort === 'false', `RÜCKFRAGE im Dialog der App, Cancel → false (${imDialog}, ${antwort})`);
  ok(foreignProcesses('lataif.exe').map((p) => p.pid).sort().join() === fremd.join(), 'ISOLATION fremde lataif.exe unberührt');
} catch (e) {
  fails.push('THROWN ' + String(e?.stack || e)); console.log('  x', e);
} finally {
  c?.close();
  killStarted();
  clearTimeout(WACHHUND);
}
console.log(`\nnative-confirm e2e: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('NATIVE_CONFIRM_E2E_PROVED');
