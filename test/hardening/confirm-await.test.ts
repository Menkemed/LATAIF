// ════════════════════════════════════════════════════════════════════════════
// CONFIRM-AWAIT — jede Rückfrage wartet auf die Antwort.
//
// In der App ersetzt das Tauri-Dialog-Plugin `window.confirm` durch eine async Fassung
// (`plugin:dialog|confirm`, Promise<boolean>). Ohne `await` ist das Versprechen selbst „wahr":
// `if (!window.confirm(…)) return;` bricht nie ab, `if (window.confirm(…)) löschen()` löscht immer —
// egal, was der Mensch klickt. Der UI-E2E hat das an Kundenkorrektur und „Mark VAT filed" gezeigt.
//
// Dieses Gate liest den Quelltext und weist jeden Aufruf von `confirm(` ab, vor dem kein `await` steht.
// Run: node --experimental-strip-types test/hardening/confirm-await.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

function dateien(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...dateien(p));
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** Kommentare entfernen (Zeilenzahl bleibt), damit Erklärtexte wie „`confirm()`" nicht zählen. */
function ohneKommentare(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** Unsichere Aufrufe: `window.confirm(` / `globalThis.confirm(` / nacktes `confirm(` ohne `await` davor. */
export function unsichereConfirms(src: string): number[] {
  const text = ohneKommentare(src);
  // Eine Datei mit eigener Funktion namens `confirm` ruft damit keinen Dialog.
  const eigene = /\b(function\s+confirm\s*\(|(const|let)\s+confirm\s*=)/.test(text);
  const zeilen: number[] = [];
  // `x.confirm(` (eine Methode) zählt nicht, `window.confirm(` / `globalThis.confirm(` / `confirm(` schon.
  const re = /(?<![\w$.])(?:(?:window|globalThis)\s*\.\s*)?confirm\s*\(/g;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    const call = m[0];
    const global = /^(window|globalThis)/.test(call);
    if (!global && eigene) continue;
    const vor = text.slice(Math.max(0, i - 12), i);
    if (/\bawait\s*\(?\s*$/.test(vor)) continue;
    // `function confirm(` selbst ist keine Rückfrage.
    if (/function\s*$/.test(vor)) continue;
    zeilen.push(text.slice(0, i).split('\n').length);
  }
  return zeilen;
}

// ── Selbsttest: das Gate erkennt, was es erkennen soll ──
ok(unsichereConfirms("if (!window.confirm('x')) return;").length === 1, 'SELBST `if (!window.confirm(…))` wird erkannt');
ok(unsichereConfirms("if (x && window.confirm('x')) del();").length === 1, 'SELBST `x && window.confirm(…)` wird erkannt');
ok(unsichereConfirms("if (!confirm('x')) return;").length === 1, 'SELBST nacktes `confirm(…)` wird erkannt');
ok(unsichereConfirms("const ok = globalThis.confirm('x');").length === 1, 'SELBST `globalThis.confirm(…)` wird erkannt');
ok(unsichereConfirms("if (!(await window.confirm('x'))) return;").length === 0, 'SELBST `await window.confirm(…)` ist sicher');
ok(unsichereConfirms("function confirm() {}\nconfirm();").length === 0, 'SELBST eine eigene Funktion `confirm` ist kein Dialog');
ok(unsichereConfirms("// früher: confirm('x')\nconst a = 1;").length === 0, 'SELBST Kommentare zählen nicht');
ok(unsichereConfirms("<Button onConfirm={() => x()} />").length === 0, 'SELBST `onConfirm` ist kein Aufruf');

// ── Der ganze Quelltext ──
const src = join(repo, 'src');
const funde: string[] = [];
let geprueft = 0;
for (const f of dateien(src)) {
  const text = readFileSync(f, 'utf8');
  if (!/confirm/.test(text)) continue;
  geprueft++;
  for (const z of unsichereConfirms(text)) funde.push(`${relative(repo, f).replace(/\\/g, '/')}:${z}`);
}
ok(funde.length === 0, `GATE keine Rückfrage ohne await in src/ (${geprueft} Dateien mit „confirm" geprüft)${funde.length ? ': ' + funde.join(', ') : ''}`);
const awaited = dateien(src).reduce((n, f) => n + (readFileSync(f, 'utf8').match(/await window\.confirm\(/g) ?? []).length, 0);
ok(awaited >= 21, `GATE die korrigierten Rückfragen warten (${awaited}× \`await window.confirm\`)`);

console.log(`\nconfirm-await: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
