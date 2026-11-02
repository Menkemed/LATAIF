// ════════════════════════════════════════════════════════════════════════════
// NEW REPAIR 0 % + DETAIL-LAYOUT — echte Bedienung in der Test-App (nur Primary).
// Run: node test/e2e/repair-vat-photo.e2e.mjs
//
//   VAT     New Repair öffnet mit 0 %; ohne Klick wird ZERO gespeichert, mit Klick auf 10 % VAT_10.
//   FOTO    Das Artikelbild steht groß oben links (Proportionen erhalten), die Vorschau wechselt das Bild, ein Klick vergrößert.
//   VOUCHER Die Voucher-Nummer steht kompakt bei den Artikelinformationen, mit derselben Nummer wie gespeichert.
//   SCHMAL  Bei schmalem Fenster bleibt alles sichtbar, nichts läuft seitlich heraus.
//
// Isoliert: com.lataif.app.e2e, Port 3011 — Produktion und E:\LATAIF\Data bleiben unberührt.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { closeTestWindow, killStarted, killTestImage, spawnTracked, startedPids, waitTestImageGone } from './_e2e-process.mjs';
import { maus, mausText, tippe, sichtbar } from './_e2e-mouse.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const RUN = join(os.tmpdir(), 'lataif-vat-photo', 'run-' + Date.now());
const APP_DATA_DIR = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const env = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze'); killStarted(); killTestImage('lataif.exe'); process.exit(1); }, 15 * 60 * 1000);

const dbQ = (sql, p = []) => { let d; try { d = new DatabaseSync(BIZ_DB, { readOnly: true }); return d.prepare(sql).all(...p); } catch (e) { console.log('      (db) ' + e); return []; } finally { try { d?.close(); } catch { /* zu */ } } };
class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map();
    this.ready = new Promise((a, b) => { this.ws.addEventListener('open', a); this.ws.addEventListener('error', b); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(x) { const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}
async function attach() {
  for (let i = 0; i < 300; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); const p = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url)); if (p) { const c = new CDP(p.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c; } } catch { /* noch nicht */ }
    await sleep(400);
  }
  throw new Error('no page');
}
const warte = async (c, x, t = 45000) => { const e = Date.now() + t; while (Date.now() < e) { try { if (await c.ev(`return !!(${x});`)) return true; } catch { /* baut */ } await sleep(300); } return false; };
const SHELL = `document.querySelector('a[href="/settings"]')`;
const set = (c, s, v) => c.ev(`const e=document.querySelector(${S(s)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
const txt = (c, t) => c.ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)})?.click(); return 1;`);
const geh = async (c, route) => { await c.ev(`history.pushState({}, '', '/tasks'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`); await sleep(300); await c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`); await sleep(600); };
const foto = async (c, name) => { const p = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(RUN, name + '.png'), Buffer.from(p.data, 'base64')); };
/** Zwei echte Bilder mit verschiedenen Seitenverhältnissen (breit 400×200, hoch 200×400) in den Datei-Eingang der Maske. */
const bilderLegen = (c) => c.ev(`
  const bild = async (w, h, farbe) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = farbe; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(10, 10, 40, 40); const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9)); return new File([b], w + 'x' + h + '.jpg', { type: 'image/jpeg' }); };
  const dt = new DataTransfer(); dt.items.add(await bild(400, 200, '#715DE3')); dt.items.add(await bild(200, 400, '#15803D'));
  const inp = [...document.querySelectorAll('input[type=file][multiple]')].pop(); if (!inp) return 'KEIN-EINGANG';
  inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); return 'OK';`);

async function anlegen(c, issue, steuer) {
  await geh(c, '/repairs');
  await warte(c, `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Repair')`, 30000);
  await mausText(c, 'New Repair');
  await warte(c, `document.querySelector('[data-create-repair]')`, 15000); await sleep(300);
  const vorgabe = await c.ev(`return ['ZERO','VAT_10'].map((k) => { const b = document.querySelector('[data-repair-create-tax="' + k + '"]'); return b ? getComputedStyle(b).backgroundColor : null; });`);
  await maus(c, '[data-ss-trigger="Search clients by name, company, phone..."]');
  await warte(c, `document.querySelector('[data-ss-option="k"]')`, 15000);
  await maus(c, '[data-ss-option="k"]'); await sleep(200);
  await tippe(c, 'textarea[placeholder="Describe the issue or requested repair..."]', issue);
  await maus(c, '[data-repair-create-inhouse]'); await sleep(200);
  await tippe(c, '[data-repair-create-charge]', '50');
  if (steuer) await maus(c, `[data-repair-create-tax="${steuer}"]`);
  return vorgabe;
}
async function speichern(c) {
  const vor = await c.ev('return location.pathname;');
  await maus(c, '[data-create-repair]');
  await warte(c, `/\\/repairs\\/.+/.test(location.pathname) && location.pathname !== ${S(vor)}`, 40000);
  return c.ev(`return decodeURIComponent(location.pathname.split('/').pop());`);
}

let c = null;
try {
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: env() }));
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach();
  await warte(c, `document.querySelector('[data-first-run-gate], input[placeholder="e.g. Al-Khalifa Luxury"]')`, 90000);
  if (await c.ev(`return !!document.querySelector('[data-first-run-new]');`)) { await c.ev(`document.querySelector('[data-first-run-new]').click(); return 1;`); await sleep(1500); }
  await warte(c, `document.querySelector('input[placeholder="e.g. Al-Khalifa Luxury"]')`);
  await set(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'VAT Foto'); await set(c, 'input[placeholder="e.g. Main Store"]', 'VAT Foto');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="Full name"]')`);
  await set(c, 'input[placeholder="Full name"]', 'VAT Foto'); await set(c, 'input[placeholder="you@company.com"]', 'admin@lataif.com'); await set(c, 'input[placeholder="Choose a password"]', 'e2epass123');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="10"]')`);
  await set(c, 'input[placeholder="10"]', '10');
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  await warte(c, SHELL, 90000);
  { const pid = startedPids().pop(); c.close(); c = null; await closeTestWindow(pid, APP); }
  { const d = new DatabaseSync(BIZ_DB); try { const b = d.prepare('SELECT id FROM branches LIMIT 1').get().id; const now = new Date().toISOString();
    d.prepare("INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at) VALUES ('k', ?, 'E2E', 'Kunde', 'BH', 'en', 'NONE', '[]', 'PRIVATE', 'active', ?, ?)").run(b, now, now); } finally { d.close(); } }
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach(); await warte(c, SHELL, 120000);
  await c.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
  await c.send('Page.enable');

  // ══ VAT ══
  const v1 = await anlegen(c, 'VAT Vorgabe', null);
  ok(v1[0] === 'rgb(113, 93, 227)' && v1[1] !== 'rgb(113, 93, 227)', `VAT 0 % ist beim Öffnen gewählt, 10 % nicht (${S(v1)})`);
  ok(await bilderLegen(c) === 'OK', 'FOTO zwei Bilder in die Maske gelegt');
  await warte(c, `document.querySelectorAll('[data-create-repair]').length && document.querySelectorAll('img').length >= 2`, 15000);
  const id1 = await speichern(c);
  const r1 = dbQ('SELECT tax_scheme t, voucher_code v FROM repairs WHERE id = ?', [id1])[0] || {};
  ok(r1.t === 'ZERO', `VAT ohne Klick gespeichert: ZERO (${S(r1)})`);
  const v2 = await anlegen(c, 'VAT Zehn', 'VAT_10');
  const id2 = await speichern(c);
  ok(dbQ('SELECT tax_scheme t FROM repairs WHERE id = ?', [id2])[0]?.t === 'VAT_10', 'VAT mit Klick auf 10 % gespeichert: VAT_10');
  ok(v2[0] === 'rgb(113, 93, 227)', 'VAT auch beim zweiten Öffnen wieder 0 % vorgewählt');

  // ══ FOTO + VOUCHER ══
  await geh(c, `/repairs/${id1}`);
  ok(await warte(c, `document.querySelector('[data-repair-photo-main] img') && document.querySelector('[data-repair-photo-main] img').naturalWidth > 0`, 30000), 'FOTO das große Bild ist geladen');
  const m = await c.ev(`const b=document.querySelector('[data-repair-photo-main]'), i=b.querySelector('img'), v=document.querySelector('[data-repair-voucher]'); const r=b.getBoundingClientRect(), rv=v.getBoundingClientRect(), hero=document.querySelector('[data-repair-hero-photo]').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), fit: getComputedStyle(i).objectFit, nat: [i.naturalWidth, i.naturalHeight], heroLinksOben: hero.left < window.innerWidth / 2 && hero.top < 400,
      voucher: document.querySelector('[data-repair-voucher-code]').textContent.trim(), voucherGross: getComputedStyle(document.querySelector('[data-repair-voucher-code]')).fontSize, voucherH: Math.round(rv.height),
      alt48: [...document.querySelectorAll('span')].some((s) => getComputedStyle(s).fontSize === '48px'), thumbs: document.querySelectorAll('[data-repair-photo-thumb]').length };`);
  ok(m.w >= 400 && m.h >= 300 && m.heroLinksOben, `FOTO groß oben links (${m.w}×${m.h})`);
  ok(m.fit === 'contain', `FOTO Proportionen bleiben (object-fit ${m.fit}, Bild ${m.nat.join('×')})`);
  ok(m.voucher === r1.v && m.voucherGross === '18px' && m.voucherH < 80 && !m.alt48, `VOUCHER kompakt mit der gespeicherten Nummer (${m.voucher}, ${m.voucherGross}, ${m.voucherH}px)`);
  ok(m.thumbs === 2, `FOTO zwei Vorschauen (${m.thumbs})`);
  const src1 = await c.ev(`return document.querySelector('[data-repair-photo-main] img').src;`);
  ok(await maus(c, '[data-repair-photo-thumb="1"]') === 'OK' && await warte(c, `document.querySelector('[data-repair-photo-main] img').src !== ${S(src1)}`, 5000), 'FOTO Vorschau wechselt das große Bild');
  await foto(c, 'detail-breit');
  ok(await maus(c, '[data-repair-photo-main]') === 'OK' && await warte(c, `[...document.querySelectorAll('img')].filter((i) => getComputedStyle(i).position !== 'static' || i.closest('[role=dialog], .fixed')).length > 0`, 5000), 'FOTO Klick öffnet die Vergrößerung');
  await c.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`);
  await sleep(500);
  // Bearbeiten: der Foto-Bereich ist oben die Upload-Maske, dieselben zwei Bilder.
  await mausText(c, 'Edit'); await sleep(500);
  ok(await warte(c, `document.querySelector('[data-repair-hero-photo] input[type=file]') && document.querySelectorAll('[data-repair-hero-photo] img').length === 2`, 10000), 'FOTO beim Bearbeiten oben die Upload-Maske mit beiden Bildern');
  await mausText(c, 'Cancel'); await sleep(500);

  // ══ SCHMAL ══
  await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const schmal = await c.ev(`return { scroll: document.documentElement.scrollWidth <= window.innerWidth + 1, foto: !!document.querySelector('[data-repair-photo-main]') && document.querySelector('[data-repair-photo-main]').getBoundingClientRect().width > 150, voucher: document.querySelector('[data-repair-voucher]').getBoundingClientRect().width > 0 };`);
  ok(schmal.scroll && schmal.foto && schmal.voucher, `SCHMAL 900 px: Bild und Voucher sichtbar, kein seitliches Herauslaufen (${S(schmal)})`);
  await foto(c, 'detail-schmal');
  await c.send('Emulation.clearDeviceMetricsOverride');
  console.log('  Bildschirmfotos: ' + RUN);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e)); console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { c?.close(); } catch { /* zu */ }
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  clearTimeout(WACHHUND);
}
if (FAIL > 0) { console.log(`\nFAIL — repair vat + photo layout: ${PASS} passed, ${FAIL} failed`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log(`\nPASS — repair vat + photo layout: ${PASS} passed, 0 failed`);
