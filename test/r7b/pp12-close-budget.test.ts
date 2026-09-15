// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B / PP-12 — Nachtrag: Beenden/Neuladen/Neustart — die Wartefristen (laufender Abgleich,
// Flush) kennen die Datenbankgröße. Nachgestellt (518 MB): die feste 8-s-Frist lief ab, während der Primary seinen
// Abgleich mit sich selbst fuhr (zwei Ganz-Datenbank-Speicherungen) — „Save failed", die App blieb offen.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const src = (p: string): string => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const coord = await import('../../src/core/lifecycle/relaunch-coordinator.ts');

// ══ §1 — die Fristen nach der Datenbankgröße ══════════════════════════════════
{
  const floorRust = Number(/pub const SAVE_FLOOR_BYTES_PER_SEC: u64 = ([\d_]+);/.exec(src('src-tauri/src/bridge.rs'))?.[1].replace(/_/g, ''));
  ok(coord.SAVE_FLOOR_BYTES_PER_SEC === floorRust && floorRust === 4_000_000, `FRIST dieselbe Untergrenze wie bridge.rs (${coord.SAVE_FLOOR_BYTES_PER_SEC} = ${floorRust} B/s)`);
  ok(coord.SYNC_IDLE_TIMEOUT_MS === 8000 && coord.FLUSH_TIMEOUT_MS === 15000, 'FRIST der feste Anteil bleibt (8 s / 15 s)');
  ok(coord.syncIdleBudgetMs(0) === 8000 && coord.flushBudgetMs(0) === 15000, 'FRIST unbekannte Größe (0) → genau die festen Fristen');
  ok(coord.syncIdleBudgetMs(2_000_000) === 9000 && coord.flushBudgetMs(2_000_000) === 16000, 'FRIST kleine Datenbank (2 MB) → +1 s, praktisch unverändert');
  const b518 = coord.syncIdleBudgetMs(518_000_000), f518 = coord.flushBudgetMs(518_000_000);
  // Gemessen (Nachstellung 518 MB): ein ganzes Speichern ~13 s; der Selbst-Abgleich speichert zweimal → ~26 s.
  ok(b518 === 8000 + 2 * 129_500 && f518 === 15000 + 2 * 129_500 && b518 > 26_000 * 5, `FRIST 518 MB → Abgleich ${b518} ms, Flush ${f518} ms (gemessen ~26 s / ~13 s; Untergrenze 4 MB/s ~10× langsamer als gemessen)`);
  ok(coord.syncIdleBudgetMs(Number.NaN) === 8000 && coord.syncIdleBudgetMs(-5) === 8000, 'FRIST ungültige Größe → die festen Fristen');

  // Der Koordinator fragt die Größe EINMAL und hält beide Wartepunkte damit.
  const order: string[] = [];
  let asked = 0;
  await coord.coordinatedRelaunch({
    blockWrites: () => { order.push('block'); },
    awaitWritersIdle: async () => { await sleep(20); order.push('idle'); },
    dbBytes: () => { asked++; return 518_000_000; },
    flushDurably: async () => { order.push('flush'); },
    stopServerConfirmFree: async () => { order.push('stop'); },
    persistIntent: async () => false,
    clearIntent: async () => {},
    resumeWrites: () => { order.push('resume'); },
    relaunch: async () => { order.push('relaunch'); },
  });
  ok(asked === 1 && order.join(',') === 'block,idle,flush,stop,relaunch', `KOORDINATOR Reihenfolge unverändert, Größe einmal gefragt (${order.join(',')}; ${asked}×)`);
  const cc = code(src('src/core/lifecycle/relaunch-coordinator.ts'));
  ok(/withTimeout\(ops\.awaitWritersIdle\(\), syncIdleBudgetMs\(dbBytes\), 'flushing'\)/.test(cc) && /withTimeout\(ops\.flushDurably\(\), flushBudgetMs\(dbBytes\), 'flushing'\)/.test(cc),
    'KOORDINATOR beide Wartepunkte mit der Frist nach Größe');
}

// ══ §1b — die Verdrahtung: jeder Wartepunkt auf Abgleich/Flush ══
{
  const app = code(src('src/App.tsx'));
  ok(/waitForPendingOperations: \(\) =>\s*withTimeout\(sync\.waitForSyncIdle\(\), syncIdleBudgetMs\(getLastPersistedDbBytes\(\)\), 'flushing'\)/.test(app),
    'BEENDEN das Warten auf den laufenden Abgleich nach Größe');
  ok(/flushPendingDatabaseWrites: \(\) => withTimeout\(flushDatabase\(\), flushBudgetMs\(getLastPersistedDbBytes\(\)\), 'flushing'\)/.test(app), 'BEENDEN der Flush nach Größe');
  ok((app.match(/syncIdleBudgetMs\(getLastPersistedDbBytes\(\)\)/g) || []).length === 2, 'NEULADEN das Warten auf den Abgleich ebenfalls nach Größe');
  ok(!/SYNC_IDLE_TIMEOUT_MS|FLUSH_TIMEOUT_MS/.test(app), 'BEENDEN/NEULADEN keine feste Frist mehr in App.tsx');
  ok(/invoke\(\s*'finalize_application_shutdown'\s*\)/.test(app) && !/proc\.exit\s*\(/.test(app) && !/win\.destroy\s*\(/.test(app),
    'BEENDEN weiterhin nur über den nativen Finalizer — kein erzwungenes Ende');
  for (const f of ['src/core/lifecycle/restore-wiring.ts', 'src/components/shared/UpdateBanner.tsx', 'src/core/lifecycle/data-root-move.ts']) {
    const s = code(src(f));
    const calls = (s.match(/coordinatedRelaunch\(\{/g) || []).length;
    const sized = (s.match(/dbBytes: \(\) => db\.getLastPersistedDbBytes\(\),/g) || []).length;
    ok(calls > 0 && calls === sized, `NEUSTART ${f}: jeder koordinierte Neustart nennt die Größe (${sized}/${calls})`);
  }
  const rw = code(src('src/core/lifecycle/restore-wiring.ts'));
  ok(/coord\.syncIdleBudgetMs\(db\.getLastPersistedDbBytes\(\)\)/.test(rw) && /coord\.flushBudgetMs\(db\.getLastPersistedDbBytes\(\)\)/.test(rw) && !/coord\.(SYNC_IDLE|FLUSH)_TIMEOUT_MS/.test(rw),
    'WIEDERHERSTELLEN die begrenzten Wartepunkte nach Größe');
  const db = code(src('src/core/db/database.ts'));
  ok(/export function getLastPersistedDbBytes\(\): number \{\s*return lastKnownDiskSig\?\.size \?\? 0;\s*\}/.test(db), 'GRÖSSE aus der zuletzt geladenen/geschriebenen Datei — kein Export, kein Dateizugriff');
  const co = code(src('src/core/lifecycle/close-orchestration.ts'));
  ok(/await ops\.flushPendingDatabaseWrites\(\);[\s\S]*await ops\.closeWindow\(\);/.test(co) && /ops\.setStatus\(\{ kind: 'error'/.test(co),
    'REGEL A/B unverändert: Schließen nur nach bestätigtem Flush, sonst sichtbarer Fehler und App bleibt offen');
}

if (fails.length) {
  console.log(`
FAIL — r7b pp-12 close budgets: ${PASS} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log('POST_PARITY_PP12_CLOSE_BUDGET_PROVED');
console.log(`
PASS — r7b pp-12 close budgets: ${PASS} passed, 0 failed`);
