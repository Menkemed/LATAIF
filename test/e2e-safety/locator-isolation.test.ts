// ════════════════════════════════════════════════════════════════════════════
// TEST-ISOLATION (Vorfall 07.11.2026) — der Testtreiber startet keine Test-App, deren Datenort-Zeiger aus dem
// Testordner hinaus zeigt. Run: node test/e2e-safety/locator-isolation.test.ts
//
// Geprüft wird nur mit Zeigern als TEXT: Kein echter Produktionspfad wird gelesen, angelegt oder berührt.
// Dazu der Quelltext-Vertrag, dass die Test-App denselben Ort zur Laufzeit vor jedem Öffnen prüft.
// ════════════════════════════════════════════════════════════════════════════
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { assertIsolatedLocator, assertE2eScope, E2eIdentityError, E2E_IDENT } from '../e2e/_e2e-preflight.mjs';

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const base = join(os.tmpdir(), 'lataif-locator-iso-' + process.pid);
const dir = join(base, E2E_IDENT);
mkdirSync(dir, { recursive: true });
const zeiger = (dataRoot: unknown) => writeFileSync(join(dir, 'data-location.json'), JSON.stringify({ schemaVersion: 1, dataRoot, rootId: 'x' }));
const wirft = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return e instanceof E2eIdentityError ? 'E2E:' + e.message : 'ANDERS:' + String(e); } };

try {
  ok(assertIsolatedLocator(dir) === true, 'ohne Zeiger: erlaubt (die App legt ihn selbst im Testordner an)');
  zeiger(dir);
  ok(assertIsolatedLocator(dir) === true, 'Zeiger auf den eigenen Testordner: erlaubt');
  zeiger(join(dir, 'sub', 'Data'));
  ok(assertIsolatedLocator(dir) === true, 'Zeiger in einen Unterordner des Testordners: erlaubt');
  zeiger(join(os.tmpdir(), 'lataif-move-e2e', 'run-1', 'LATAIF', 'Data'));
  ok(assertIsolatedLocator(dir) === true, 'Zeiger ins Temp-Verzeichnis (Umzugs-Test): erlaubt');

  for (const fremd of ['E:\\LATAIF\\Data', 'E:/LATAIF/Data', 'e:\\lataif\\data\\', join(os.homedir(), 'AppData', 'Roaming', 'com.lataif.app'), 'D:\\Daten']) {
    zeiger(fremd);
    const r = wirft(() => assertIsolatedLocator(dir));
    ok(r.startsWith('E2E:') && /outside the test folder/.test(r), `Zeiger auf ${fremd}: Abbruch mit klarer Meldung (${r.slice(0, 90)})`);
    const s = wirft(() => assertE2eScope({ appDataDir: dir }));
    ok(s.startsWith('E2E:'), `…auch über assertE2eScope (den Weg jeder Suite und jeder Probe) (${fremd})`);
  }
  {
    // Präfix-Falle: ein Testordner AUSSERHALB von Temp (eigener Unterordner im Arbeitsbaum, danach gelöscht) und ein
    // Zeiger auf seinen Nachbarn mit gleichem Namensanfang — der ist nicht „innen".
    const aussen = join(repo, '.locator-iso-' + process.pid, E2E_IDENT);
    mkdirSync(aussen, { recursive: true });
    try {
      writeFileSync(join(aussen, 'data-location.json'), JSON.stringify({ schemaVersion: 1, dataRoot: aussen + '-nebenan', rootId: 'x' }));
      ok(wirft(() => assertIsolatedLocator(aussen)).startsWith('E2E:'), 'ein Nachbarordner mit gleichem Namensanfang ist NICHT „innen"');
      writeFileSync(join(aussen, 'data-location.json'), JSON.stringify({ schemaVersion: 1, dataRoot: join(aussen, 'Data'), rootId: 'x' }));
      ok(assertIsolatedLocator(aussen) === true, '…ein echter Unterordner schon');
    } finally { rmSync(join(repo, '.locator-iso-' + process.pid), { recursive: true, force: true }); }
  }
  writeFileSync(join(dir, 'data-location.json'), '{ kaputt');
  ok(wirft(() => assertIsolatedLocator(dir)).startsWith('E2E:'), 'unlesbarer Zeiger: Abbruch (Isolation nicht beweisbar)');
  zeiger('');
  ok(wirft(() => assertIsolatedLocator(dir)).startsWith('E2E:'), 'leerer Datenort: Abbruch');

  // Die Test-App prüft denselben Ort selbst — vor jedem Öffnen, nur im Automations-Build.
  const lib = readFileSync(join(repo, 'src-tauri/src/lib.rs'), 'utf8').replace(/\r\n/g, '\n');
  const vorAufloesung = lib.indexOf('if let Ok(Some(loc)) = data_root::read_locator(&locator_dir)');
  const aufloesung = lib.indexOf('data_root::resolve_or_first_run(&locator_dir)');
  const nachAufloesung = lib.indexOf('e2e_assert_isolated_data_root(root.path(), &locator_dir)');
  const ersterZugriff = lib.indexOf('cleanup_stale_control_copies(&locator_dir, &root)');
  ok(/#\[cfg\(feature = "e2e"\)\]\nfn e2e_assert_isolated_data_root/.test(lib), 'App: Prüffunktion existiert und ist nur im Automations-Build');
  ok(vorAufloesung > 0 && vorAufloesung < aufloesung, 'App: der Zeiger wird VOR der Auflösung geprüft');
  ok(nachAufloesung > 0 && nachAufloesung < ersterZugriff, 'App: der aufgelöste Ort wird VOR dem ersten Zugriff (Aufräumen, Recovery, DB) geprüft');
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log(fails.length ? `\nFAIL — locator isolation: ${PASS} passed, ${fails.length} failed` : `\nPASS — locator isolation: ${PASS} passed, 0 failed`);
if (fails.length) process.exit(1);
