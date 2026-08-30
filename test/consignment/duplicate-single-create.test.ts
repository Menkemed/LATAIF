// Duplikatshinweis — eine bewusste Entscheidung, genau eine Anlage.
// Run: node test/consignment/duplicate-single-create.test.ts
//
// Zwei Fehler, ein Weg: nach "Copy details" sprang der Hinweis sofort wieder auf, weil der
// "schon entschieden"-Merker den Fingerabdruck von VOR der Uebernahme trug — nach der Uebernahme
// sah das Formular aber aus wie der gefundene Artikel, also fand die Pruefung ihn erneut. Und die
// Anlage der Kommissionsware kannte keine Einfachausfuehrung: sie schiebt ihre Schreibvorgaenge in
// einen eigenen Tick, ein zweiter Klick davor reihte einen zweiten Auftrag ein.
//
// Teil A prueft die gemeinsame Regel an den echten Funktionen, Teil B haelt die drei Bildschirme
// darauf fest — mitsamt der Einfachausfuehrung, die man einer reinen Funktion nicht ansieht.
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withTs = (p: string): string => (existsSync(p) ? p : existsSync(p + '.ts') ? p + '.ts' : p);
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(withTs(resolvePath(repo, 'src', specifier.slice(2)))).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const { duplicateFingerprint, fingerprintAfterCopy, copiedAttributes } =
  await import('../../src/core/products/duplicate-dismiss.ts');

let pass = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) pass++; else { fails.push(m); console.log('  x ' + m); } };

// ── A) Die gemeinsame Regel ───────────────────────────────────────────────
const typed = { brand: 'Rolex', name: 'Submariner', sku: 'MY-001', attributes: { serial_number: 'MINE-9' } };
const found = {
  brand: 'Rolex', name: 'Submariner Date', sku: 'RLX-WCH-001',
  attributes: { serial_number: 'THEIRS-1', reference_number: '126610', dial: 'Black' },
};

ok(duplicateFingerprint(typed) === duplicateFingerprint({ ...typed }), 'FP the same input yields the same fingerprint');
ok(duplicateFingerprint({ brand: ' rolex ' }) === duplicateFingerprint({ brand: 'ROLEX' }),
  'FP …case and spacing do not make a different input');
ok(duplicateFingerprint(null) === duplicateFingerprint({}), 'FP an empty form has one empty fingerprint');
ok(duplicateFingerprint(typed) !== duplicateFingerprint(found), 'FP two different items differ');

const copied = copiedAttributes(found);
ok(copied.reference_number === '126610' && copied.dial === 'Black', 'COPY the model details are taken over');
ok(!('serial_number' in copied), 'COPY …but never the serial — that belongs to the physical piece');
ok(!('serialNo' in copiedAttributes({ attributes: { serialNo: 'x' } })), 'COPY …in either spelling');

// Der Kern: der Merker muss den Zustand NACH der Uebernahme beschreiben. Hier wird die Uebernahme
// so nachgestellt, wie der Bildschirm sie macht — mit derselben Funktion, die er dafuer benutzt.
const afterCopy = {
  ...typed,
  brand: found.brand,
  name: found.name,
  attributes: { ...typed.attributes, ...copiedAttributes(found) },
};
ok(fingerprintAfterCopy(typed, found) === duplicateFingerprint(afterCopy),
  'DISMISS the remembered fingerprint is exactly the one the form carries after the copy');
ok(fingerprintAfterCopy(typed, found) !== duplicateFingerprint(typed),
  'DISMISS …and it is NOT the one from before — that was the bug: the check ran again and found the same item');
ok(fingerprintAfterCopy(typed, found).includes('MY-001'),
  'DISMISS the own SKU survives the copy, so it belongs in the fingerprint');
ok(fingerprintAfterCopy(typed, found).includes('MINE-9'),
  'DISMISS …and so does the own serial, which is never overwritten');

// ── B) Die drei Bildschirme benutzen genau das ────────────────────────────
const SURFACES: Array<[string, string, string]> = [
  ['collection list', 'src/pages/watches/WatchList.tsx', 'form'],
  ['new item dialog', 'src/components/products/NewProductModal.tsx', 'form'],
  ['consignment list', 'src/pages/consignments/ConsignmentList.tsx', 'productForm'],
];
for (const [label, rel, formVar] of SURFACES) {
  const src = readFileSync(resolvePath(repo, rel), 'utf8');
  ok(src.includes(`duplicateFingerprint(${formVar})`), `WIRED ${label} builds its fingerprint from the shared rule`);
  ok(!/\.map\(v => String\(v \?\? ''\)\.trim\(\)\.toUpperCase\(\)\)\.join\('\|'\)/.test(src),
    `WIRED ${label} …and no longer carries its own copy of the formula`);
  ok(src.includes(`fingerprintAfterCopy(${formVar}, src)`),
    `WIRED ${label} remembers the fingerprint the copy produces, not the one before it`);
  ok(src.includes('copiedAttributes(src)'), `WIRED ${label} copies through the shared rule too`);
  ok(!/delete srcAttrs\.serial_number/.test(src), `WIRED ${label} …so the strip cannot drift from the fingerprint`);
}

// ── C) Einfachausfuehrung der Kommissions-Anlage ──────────────────────────
//
// Diese Anlage schiebt ihre Schreibvorgaenge in einen eigenen Tick. Ohne Sperre reiht ein zweiter
// Klick davor einen zweiten Auftrag ein — zwei Artikel, zwei Kommissionen, aus einem Willen.
{
  const src = readFileSync(resolvePath(repo, 'src/pages/consignments/ConsignmentList.tsx'), 'utf8');
  const from = src.indexOf('function doCreate() {');
  const to = src.indexOf('\n  function ', from + 10);
  ok(from > 0, 'SINGLE the create function was located');
  const fn = src.slice(from, to > from ? to : undefined);
  ok(/if \(createInFlight\.current\) return;\r?\n\s*createInFlight\.current = true;/.test(fn),
    'SINGLE it refuses a second entry while the first is still on its way');
  const guardAt = fn.indexOf('createInFlight.current = true');
  const firstWrite = Math.min(
    ...['setTimeout(', 'createProduct(', 'createConsignment('].map((n) => { const i = fn.indexOf(n); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }),
  );
  ok(guardAt > 0 && guardAt < firstWrite, 'SINGLE …and it does so BEFORE anything is written or deferred');
  ok(/finally \{[\s\S]*createInFlight\.current = false;[\s\S]*\}/.test(fn),
    'SINGLE it is released in a finally, so a failed attempt can be retried');
  ok(/const createInFlight = useRef\(false\);/.test(src),
    'SINGLE the guard is a ref — React state would let three clicks in one tick all pass');
  // Und die Entscheidung des Hinweises geht durch DIESELBE Funktion, nicht an ihr vorbei.
  ok(/onCreateAnyway=\{doCreate\}/.test(src), 'SINGLE "Create anyway" runs the guarded create, not a second path');
  ok(!/onCreateAnyway=\{\(\) =>/.test(src), 'SINGLE …with no inline second implementation beside it');
}
// Die Collection hatte diese Sperre schon — sie bleibt, wie sie ist.
{
  const src = readFileSync(resolvePath(repo, 'src/pages/watches/WatchList.tsx'), 'utf8');
  ok(/const createInFlight = useRef\(false\);/.test(src) && /if \(createInFlight\.current\) return;/.test(src),
    'SINGLE the collection keeps the guard it already had');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — consignment duplicate single create: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CONSIGNMENT_DUPLICATE_SINGLE_CREATE_PROVED');
