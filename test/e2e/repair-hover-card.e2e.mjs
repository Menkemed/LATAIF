// ════════════════════════════════════════════════════════════════════════════
// REPAIR-HOVER — die große Hover-Karte der Reparaturliste, echte Maus in der Test-App (nur Primary).
// Run: node test/e2e/repair-hover-card.e2e.mjs
//
//   A   Reparatur MIT Foto (über die Maske hochgeladen, 1200 × 600 → beim Erfassen 800 × 400): Maus über die
//       Zeile → nach der Verzögerung erscheint die Karte; Bildfläche ≈ 280 × 280; geladen ist das HAUPTBILD
//       (Bytes = Hauptbild, nicht die Vorschau); Marke, Modell, Referenz, Seriennummer stehen da.
//   B   Reparatur OHNE Foto und ohne Artikel: „No photo"-Platzhalter, fehlende Angaben als „—".
//   AUS Maus von den Zeilen weg → die Karte verschwindet.
//
// Isoliert: com.lataif.app.e2e, Port 3011 — Produktion und E:\LATAIF\Data bleiben unberührt.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { closeTestWindow, killStarted, killTestImage, spawnTracked, startedPids, waitTestImageGone } from './_e2e-process.mjs';
import { maus, mausText, tippe } from './_e2e-mouse.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const RUN = join(os.tmpdir(), 'lataif-repair-hover', 'run-' + Date.now());
const APP_DATA_DIR = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const env = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
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
/** EIN echtes Bild 1200 × 600 in den Datei-Eingang der Maske (die Erfassung bringt es auf 800 × 400). */
const bildLegen = (c) => c.ev(`
  const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 600; const x = cv.getContext('2d');
  x.fillStyle = '#715DE3'; x.fillRect(0, 0, 1200, 600); x.fillStyle = '#fff'; x.fillRect(40, 40, 200, 200);
  const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
  const dt = new DataTransfer(); dt.items.add(new File([b], 'hover-1200x600.jpg', { type: 'image/jpeg' }));
  const inp = [...document.querySelectorAll('input[type=file][multiple]')].pop(); if (!inp) return 'KEIN-EINGANG';
  inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); return 'OK';`);

async function anlegen(c, issue, marke, modell, mitFoto) {
  await geh(c, '/repairs');
  await warte(c, `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Repair')`, 30000);
  const r = [await mausText(c, 'New Repair')];
  await warte(c, `document.querySelector('[data-create-repair]')`, 15000); await sleep(300);
  r.push(await maus(c, '[data-ss-trigger="Search clients by name, company, phone..."]'));
  await warte(c, `document.querySelector('[data-ss-option="k"]')`, 15000);
  r.push(await maus(c, '[data-ss-option="k"]')); await sleep(200);
  r.push(await tippe(c, 'textarea[placeholder="Describe the issue or requested repair..."]', issue));
  if (marke) r.push(await tippe(c, 'input[placeholder="e.g. Rolex, Cartier"]', marke));
  if (modell) r.push(await tippe(c, 'input[placeholder="e.g. Submariner"]', modell));
  r.push(await maus(c, '[data-repair-create-inhouse]')); await sleep(200);
  r.push(await tippe(c, '[data-repair-create-charge]', '50'));
  if (mitFoto) { r.push(await bildLegen(c)); await warte(c, `document.querySelectorAll('img').length >= 1`, 15000); await sleep(500); }
  const vor = await c.ev('return location.pathname;');
  r.push(await maus(c, '[data-create-repair]'));
  await warte(c, `/\\/repairs\\/.+/.test(location.pathname) && location.pathname !== ${S(vor)}`, 40000);
  const id = await c.ev(`return decodeURIComponent(location.pathname.split('/').pop());`);
  return { id, r: r.every((x) => x === 'OK' || x === 1) ? 'OK' : r.join(',') };
}

/** Echte Mausbewegung: erst auf eine neutrale Stelle, dann in die Zeile (löst mouseenter aus wie eine Hand). */
async function ueberZeile(c, id) {
  const p = await c.ev(`const e=document.querySelector('[data-repair-row="${id}"]'); if(!e) return null; e.scrollIntoView({block:'center'});
    const r=e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(260, r.width / 3)), y: Math.round(r.top + r.height / 2) };`);
  if (!p) return 'FEHLT';
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
  await sleep(150);
  for (let i = 1; i <= 4; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(3 + (p.x - 3) * i / 4), y: Math.round(3 + (p.y - 3) * i / 4) }); await sleep(40); }
  const oben = await c.ev(`const t=document.elementFromPoint(${p.x}, ${p.y}); return !!t && !!t.closest('[data-repair-row="${id}"]');`);
  return oben ? 'OK' : 'VERDECKT';
}
const karte = (c, id) => c.ev(`const k=document.querySelector('[data-repair-hover-card="${id}"]'); if(!k) return null;
  const box=k.firstElementChild.getBoundingClientRect(), kr=k.getBoundingClientRect(), img=k.querySelector('[data-repair-hover-img]'), leer=k.querySelector('[data-repair-hover-noimg]');
  const feld=(n)=>k.querySelector('[data-repair-hover-field="'+n+'"]')?.textContent.trim() ?? null;
  return { box: [Math.round(box.width), Math.round(box.height)], card: [Math.round(kr.left), Math.round(kr.top), Math.round(kr.width), Math.round(kr.height)],
    imFenster: kr.left >= 0 && kr.top >= 0 && kr.right <= innerWidth && kr.bottom <= innerHeight,
    img: img ? { art: img.getAttribute('data-repair-hover-img'), fertig: img.complete, nat: [img.naturalWidth, img.naturalHeight], fit: getComputedStyle(img).objectFit } : null,
    leer: leer ? { art: leer.getAttribute('data-repair-hover-noimg'), text: leer.textContent.trim() } : null,
    felder: { brand: feld('Brand'), model: feld('Model'), reference: feld('Reference'), serial: feld('Serial number') },
    karten: document.querySelectorAll('[data-repair-hover-card]').length };`);

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
  await set(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'Hover'); await set(c, 'input[placeholder="e.g. Main Store"]', 'Hover');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="Full name"]')`);
  await set(c, 'input[placeholder="Full name"]', 'Hover'); await set(c, 'input[placeholder="you@company.com"]', 'admin@lataif.com'); await set(c, 'input[placeholder="Choose a password"]', 'e2epass123');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="10"]')`);
  await set(c, 'input[placeholder="10"]', '10');
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  await warte(c, SHELL, 90000);
  { const pid = startedPids().pop(); c.close(); c = null; await closeTestWindow(pid, APP); }
  { const d = new DatabaseSync(BIZ_DB); try { const b = d.prepare('SELECT id FROM branches LIMIT 1').get().id; const now = new Date().toISOString();
    d.prepare("INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at) VALUES ('k', ?, 'E2E', 'Kunde', 'BH', 'en', 'NONE', '[]', 'PRIVATE', 'active', ?, ?)").run(b, now, now); } finally { d.close(); } }

  // ── Sitzung 2: zwei Reparaturen über die Maske ──
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach(); await warte(c, SHELL, 120000);
  await c.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
  const A = await anlegen(c, 'Hover mit Foto', 'Rolex', 'Submariner', true);
  ok(!!A.id && A.r === 'OK', `SETUP A über die Maske angelegt, mit Foto 1200×600 (${A.r})`);
  const B = await anlegen(c, 'Hover ohne Foto', 'Omega', null, false);
  ok(!!B.id && B.r === 'OK' && B.id !== A.id, `SETUP B über die Maske angelegt, ohne Foto, nur Marke (${B.r})`);
  const medien = dbQ(`SELECT COUNT(*) n FROM media_links WHERE entity_type = 'repair' AND entity_id = ?`, [A.id])[0]?.n;
  ok(Number(medien) === 1, `SETUP A hat genau 1 Foto im Medienspeicher (${medien})`);
  { const pid = startedPids().pop(); c.close(); c = null; await closeTestWindow(pid, APP); }
  // Referenz und Seriennummer: Felder der Artikelkategorie — hier direkt bei geschlossener App gesetzt.
  { const d = new DatabaseSync(BIZ_DB); try { d.prepare("UPDATE repairs SET item_reference = 'REF-116610', item_serial = 'SN-ABC123' WHERE id = ?").run(A.id); } finally { d.close(); } }

  // ── Sitzung 3: Liste, echte Maus ──
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach(); await warte(c, SHELL, 120000);
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await geh(c, '/repairs');
  ok(await warte(c, `document.querySelector('[data-repair-row="${A.id}"]') && document.querySelector('[data-repair-row="${B.id}"]')`, 30000), 'LISTE beide Reparaturen stehen in der Liste');

  // A — mit Foto
  ok(await ueberZeile(c, A.id) === 'OK', 'A Maus über der Zeile (Zeile liegt zuoberst)');
  const frueh = await c.ev(`return document.querySelectorAll('[data-repair-hover-card]').length;`);
  ok(await warte(c, `document.querySelector('[data-repair-hover-card="${A.id}"]')`, 5000), `A die Karte erscheint nach der Verzögerung (sofort: ${frueh} Karten)`);
  ok(await warte(c, `(() => { const i = document.querySelector('[data-repair-hover-card="${A.id}"] [data-repair-hover-img]'); return i && i.complete && i.naturalWidth > 0; })()`, 15000), 'A das Bild ist geladen');
  const ka = await karte(c, A.id);
  await foto(c, 'hover-mit-foto');
  ok(!!ka && Math.abs(ka.box[0] - 280) <= 2 && Math.abs(ka.box[1] - 280) <= 2, `A Bildfläche ≈ 280 × 280 (${ka?.box?.join('×')}; Karte ${ka?.card?.slice(2).join('×')})`);
  // Hauptbild statt Vorschau: die geladenen Bytes sind genau die des Hauptbilds (Master), nicht die der Vorschau.
  // (Jede Aufnahme wird beim Erfassen auf ≤ 800 px gebracht — `CAPTURE_MAX_DIM` — darum 800 × 400.)
  const groessen = dbQ(`SELECT v.variant_type t, g.byte_size b FROM media_links l JOIN media_objects o ON o.media_id = l.media_id
      JOIN media_variants v ON v.media_id = o.media_id AND v.deleted_at IS NULL JOIN media_blob_generations g ON g.blob_id = v.blob_id
    WHERE l.entity_type = 'repair' AND l.entity_id = ?
    UNION ALL SELECT 'master' t, g.byte_size b FROM media_links l JOIN media_objects o ON o.media_id = l.media_id JOIN media_blob_generations g ON g.blob_id = o.master_blob_id
    WHERE l.entity_type = 'repair' AND l.entity_id = ?`, [A.id, A.id]);
  const master = groessen.find((g) => g.t === 'master')?.b; const vorschau = groessen.find((g) => g.t === 'thumbnail')?.b;
  const geladen = await c.ev(`const i=document.querySelector('[data-repair-hover-card="${A.id}"] [data-repair-hover-img]'); return (await (await fetch(i.src)).blob()).size;`);
  ok(ka?.img?.art === 'media' && ka.img.nat[0] === 800 && ka.img.nat[1] === 400 && geladen === master && geladen !== vorschau,
    `A Hauptbild aus dem Medienspeicher, nicht die Vorschau (${ka?.img?.art}, natürlich ${ka?.img?.nat?.join('×')}, geladen ${geladen} B = Hauptbild ${master} B, Vorschau ${vorschau} B)`);
  ok(ka?.img?.fit === 'contain', `A ganzes Bild, Proportionen erhalten (object-fit ${ka?.img?.fit})`);
  ok(ka?.felder?.brand === 'Rolex' && ka.felder.model === 'Submariner' && ka.felder.reference === 'REF-116610' && ka.felder.serial === 'SN-ABC123',
    `A Marke/Modell/Referenz/Seriennummer (${S(ka?.felder)})`);
  ok(ka?.imFenster && ka.karten === 1, `A Karte ganz im Fenster, genau eine Karte (${ka?.karten})`);

  // B — ohne Foto
  ok(await ueberZeile(c, B.id) === 'OK', 'B Maus über der Zeile');
  ok(await warte(c, `document.querySelector('[data-repair-hover-card="${B.id}"] [data-repair-hover-noimg="empty"]')`, 8000), 'B die Karte erscheint mit Platzhalter');
  const kb = await karte(c, B.id);
  await foto(c, 'hover-ohne-foto');
  ok(kb?.leer?.art === 'empty' && /No photo/.test(kb.leer.text) && !kb.img, `B ohne Bild: Platzhalter „${kb?.leer?.text}", kein Bild-Element`);
  ok(Math.abs((kb?.box?.[0] ?? 0) - 280) <= 2 && Math.abs((kb?.box?.[1] ?? 0) - 280) <= 2, `B dieselbe Fläche ${kb?.box?.join('×')}`);
  ok(kb?.felder?.brand === 'Omega' && kb.felder.model === '—' && kb.felder.reference === '—' && kb.felder.serial === '—',
    `B fehlende Angaben als „—", nichts erfunden (${S(kb?.felder)})`);
  ok(kb?.karten === 1 && !(await c.ev(`return !!document.querySelector('[data-repair-hover-card="${A.id}"]');`)), 'B nur die Karte von B, die von A ist weg');

  // AUS — Maus weg von den Zeilen
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
  ok(await warte(c, `document.querySelectorAll('[data-repair-hover-card]').length === 0`, 3000), 'AUS Maus weg: keine Karte mehr');

  // Noch einmal A: das Bild kommt sofort aus dem Cache.
  ok(await ueberZeile(c, A.id) === 'OK' && await warte(c, `(() => { const i = document.querySelector('[data-repair-hover-card="${A.id}"] [data-repair-hover-img]'); return i && i.complete && i.naturalWidth === 800; })()`, 3000),
    'A zweites Überfahren: Hauptbild wieder da');
  await c.send('Emulation.clearDeviceMetricsOverride');
  console.log('  Bildschirmfotos: ' + RUN);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e)); console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { c?.close(); } catch { /* zu */ }
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  clearTimeout(WACHHUND);
}
if (FAIL > 0) { console.log(`\nFAIL — repair hover card: ${PASS} passed, ${FAIL} failed`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log(`\nPASS — repair hover card: ${PASS} passed, 0 failed`);
