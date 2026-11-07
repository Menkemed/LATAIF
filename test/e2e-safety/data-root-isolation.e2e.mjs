// ════════════════════════════════════════════════════════════════════════════
// TEST-ISOLATION (Vorfall 07.11.2026) — die echte Test-App verweigert einen Datenort außerhalb ihres Testordners und
// des Temp-Verzeichnisses, BEVOR sie dort etwas öffnet. Run: node test/e2e-safety/data-root-isolation.e2e.mjs
//
// Der „fremde" Datenort ist ein ERFUNDENER Ordner im Arbeitsbaum (`.iso-fremd-<pid>`), keine Produktion: mit gültiger
// Markierung, damit die Auflösung ihn ohne die Sperre annähme. Stufe 1 (Testtreiber) muss den Zeiger abweisen; danach
// wird die Test-App absichtlich OHNE Stufe 1 gestartet — Stufe 2 (App, nur im Automations-Build) muss den Start beenden.
// Geprüft: die App läuft nicht weiter, im fremden Ordner entsteht nichts und nichts ändert sich.
// Prozess-Isolation wie überall: nur der exakte Test-Pfad, nie die Produktions-App.
// ════════════════════════════════════════════════════════════════════════════
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { assertE2eBinary, assertE2eScope, E2E_IDENT, E2eIdentityError } from '../e2e/_e2e-preflight.mjs';
import { spawnTracked, killStarted, killTestImage, waitTestImageGone, foreignProcesses } from '../e2e/_e2e-process.mjs';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const APP_DATA_DIR = join(process.env.APPDATA, E2E_IDENT);
const FREMD_BASIS = join(REPO, '.iso-fremd-' + process.pid);
const FREMD = join(FREMD_BASIS, 'Data');
const RUN = join(os.tmpdir(), 'lataif-iso-e2e', 'run-' + process.pid);
const PORT = 3011;
let PASS = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bild = (dir) => {
  if (!existsSync(dir)) return 'fehlt';
  return JSON.stringify(readdirSync(dir).sort().map((f) => { const p = join(dir, f); const s = statSync(p); return [f, s.size, s.mtimeMs, s.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'dir']; }));
};

const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
try {
  assertE2eBinary(APP);
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(FREMD, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const rootId = 'iso-' + process.pid;
  writeFileSync(join(FREMD, '.lataif-data-root.json'), JSON.stringify({ schemaVersion: 1, rootId, createdAt: new Date().toISOString(), bootstrapPending: false, businessDbExpected: false }));
  writeFileSync(join(FREMD, 'sentinel.txt'), 'darf sich nie aendern');
  writeFileSync(join(APP_DATA_DIR, 'data-location.json'), JSON.stringify({ schemaVersion: 1, dataRoot: FREMD, rootId, updatedAt: new Date().toISOString() }));
  writeFileSync(join(APP_DATA_DIR, '.lataif-data-root.json'), JSON.stringify({ schemaVersion: 1, rootId, createdAt: new Date().toISOString(), bootstrapPending: false, businessDbExpected: false }));
  const vorher = bild(FREMD);

  // Stufe 1 — der Testtreiber startet so nicht.
  let stufe1 = '';
  try { assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: { LATAIF_E2E_SYNC_PORT: String(PORT) } }); } catch (e) { stufe1 = e instanceof E2eIdentityError ? e.message : 'ANDERS ' + e; }
  ok(/outside the test folder/.test(stufe1), `Stufe 1: der Testtreiber weist den Zeiger ab (${stufe1.slice(0, 100)})`);

  // Stufe 2 — absichtlich OHNE Stufe 1 gestartet: die App selbst muss verweigern.
  const env = { ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') };
  const child = spawnTracked(APP, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  const ende = await Promise.race([new Promise((r) => child.on('exit', (code) => r({ code }))), sleep(45000).then(() => null)]);
  ok(ende !== null, `Stufe 2: die Test-App beendet ihren Start selbst (Exit ${ende ? ende.code : 'läuft noch nach 45 s'})`);
  ok(/E2E ISOLATION: the automation build refuses the data location/.test(stderr), `Stufe 2: mit der Isolationsmeldung (${(stderr.match(/\[data-root\][^\n]*/) || [''])[0].slice(0, 160)})`);
  await sleep(1000);
  ok(bild(FREMD) === vorher, 'im fremden Ordner ist nichts entstanden und nichts geändert (keine Datenbank, keine Markierung)');
  ok(!existsSync(join(FREMD, 'lataif.db')) && !existsSync(join(FREMD, 'lataif_sync_server.db')), '…insbesondere keine lataif.db und keine Server-DB');
} catch (e) {
  fails.push('Abbruch: ' + String(e)); console.log('  x ' + String(e));
} finally {
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  rmSync(FREMD_BASIS, { recursive: true, force: true });
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(RUN, { recursive: true, force: true });
}
ok(JSON.stringify(foreignProcesses('lataif.exe').map((p) => p.pid).sort()) === JSON.stringify(fremdVorher), 'fremde LATAIF-Prozesse (Produktion) unberührt');
console.log(fails.length ? `\nFAIL — data-root isolation e2e: ${PASS} passed, ${fails.length} failed` : `\nPASS — data-root isolation e2e: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);
