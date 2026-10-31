// ════════════════════════════════════════════════════════════════════════════
// REPAIR COST FINAL CLOSURE — kurzer Oberflächen-Smoke: die echte Komponente, serverseitig gerendert (kein App-Build).
// Run: node --experimental-strip-types test/repair-type-rule/conflict-note-smoke.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import ts from 'typescript';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const treffer = (p: string): string | null => [p, p + '.ts', p + '.tsx'].find((x) => existsSync(x) && !x.endsWith('src')) ?? null;
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    const p = specifier.startsWith('@/') ? resolvePath(repo, 'src', specifier.slice(2))
      : specifier.startsWith('.') && context.parentURL ? resolvePath(dirname(fileURLToPath(context.parentURL)), specifier) : null;
    const f = p ? treffer(p) : null;
    return f ? { url: pathToFileURL(f).href, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return { format: 'module', source, shortCircuit: true };
  },
} as never);

const { renderToStaticMarkup } = await import('react-dom/server');
const { createElement } = await import('react');
const { RepairTypeConflictNote } = await import('../../src/components/repairs/RepairWorkParts.tsx');
const { repairWorkSource } = await import('../../src/core/repairs/repair-work-source.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const html = (r: Record<string, unknown>, ls: Array<Record<string, unknown>>, compact?: boolean): string =>
  renderToStaticMarkup(createElement(RepairTypeConflictNote, { ws: repairWorkSource(r as never, ls as never), compact }));

const konflikt = [{ status: 'OPEN', costAmount: 0 }, { status: 'OPEN', supplierId: 'w', costAmount: 20 }];
const voll = html({ repairType: 'external', workshopSupplierId: 'w' }, konflikt);
ok(voll.includes('data-repair-type-conflict="full"') && voll.includes('Saved type: External workshop') && voll.includes('Work lines show: Hybrid')
  && voll.includes('not changed automatically'), `Detailseite: beide Aussagen und der Hinweis (${voll.slice(0, 160)})`);
const kurz = html({ repairType: 'external', workshopSupplierId: 'w' }, konflikt, true);
ok(kurz.includes('data-repair-type-conflict="compact"') && kurz.includes('Saved type: External workshop') && kurz.includes('title="The type was not changed'),
  'Liste/Quick Edit: kurz, Hinweis im Tooltip');
ok(html({ repairType: 'external', workshopSupplierId: 'w' }, [{ status: 'OPEN', supplierId: 'w', costAmount: 20 }]) === '' && html({ repairType: 'internal' }, []) === '',
  'ohne Widerspruch: nichts');

console.log(`\nCONFLICT-NOTE SMOKE: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
