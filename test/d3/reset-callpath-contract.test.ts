// D3 reset-callpath contract — every production wipe goes through the guarded contract.
// Run: node test/d3/reset-callpath-contract.test.ts
//
// Warum es diesen Gate gibt: `runGuardedReset` (Sync/LAN-Block + Pre-destructive Backup +
// fail-closed) ist der Vertrag für den vollständigen lokalen Reset — aber ein Vertrag hilft nur,
// solange ihn niemand umgeht. `LoginPage.tsx` rief `resetDatabase()` direkt hinter einem
// `confirm()` auf: ohne Backup, ohne Resurrection-Guard, und vor jeder Anmeldung erreichbar.
// Der Kern-Test (`safe-purge.test.ts`) konnte das nicht sehen — er prüft den Vertrag, nicht seine
// Aufrufer. Dieser Gate liest deshalb die Quellen und hält die Aufruferseite fest.
//
// Reines Datei-Scanning, keine Imports aus `src/` — damit der Gate mit blankem `node` läuft.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}

/** Kommentare raus — eine Erwähnung im Fließtext ist kein Aufruf. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = collect(srcDir);
check(files.length > 100, `discovery found ${files.length} source files (expected the whole src tree)`);

// Wo `resetDatabase` DEFINIERT wird — dort ist die Nennung natürlich erlaubt.
const DEFINITION = join('src', 'core', 'db', 'database.ts');

const callers: string[] = [];
for (const f of files) {
  const rel = f.slice(f.indexOf(`${sep}src${sep}`) + 1);
  if (rel === DEFINITION) continue;
  const code = stripComments(readFileSync(f, 'utf8'));
  if (/\bresetDatabase\b/.test(code)) callers.push(rel);
}

// Es MUSS Aufrufer geben — findet der Scan keinen, ist er kaputt und würde alles durchwinken.
check(callers.length > 0, 'found at least one production caller of resetDatabase (else the scan is broken)');

for (const rel of callers) {
  const code = stripComments(readFileSync(join(srcDir, '..', rel), 'utf8'));
  check(
    /\brunGuardedReset\b/.test(code),
    `${rel.split(sep).join('/')}: calls resetDatabase but not through runGuardedReset`
  );
  // Der Guard ohne Backup wäre ein Reset ohne Sicherung — die Eigenschaft muss mitgegeben werden.
  check(
    /\bbackup\s*:/.test(code),
    `${rel.split(sep).join('/')}: passes no backup to runGuardedReset`
  );
}

// Der Vertrag selbst: Backup vor Reset, und ein fehlgeschlagenes Backup verhindert den Reset.
const contract = stripComments(readFileSync(join(srcDir, 'core', 'settings', 'safe-purge.ts'), 'utf8'));
const guarded = contract.slice(contract.indexOf('export async function runGuardedReset'));
const backupAt = guarded.indexOf('deps.backup()');
const resetAt = guarded.indexOf('deps.reset()');
check(backupAt > -1 && resetAt > -1, 'runGuardedReset calls both deps.backup() and deps.reset()');
check(backupAt > -1 && resetAt > -1 && backupAt < resetAt, 'runGuardedReset takes the backup BEFORE the reset');
check(/await deps\.backup\(\)/.test(guarded), 'runGuardedReset awaits the backup (a rejection must abort the reset)');
check(
  !/try\s*\{[\s\S]*deps\.backup\(\)[\s\S]*catch/.test(guarded),
  'runGuardedReset does not swallow a backup failure'
);

console.log(`\nD3 reset-callpath: ${pass}/${pass + fail.length} checks passed`);
if (fail.length) {
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ all D3 reset-callpath checks green');
