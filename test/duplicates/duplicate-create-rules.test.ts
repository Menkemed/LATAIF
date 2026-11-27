// ════════════════════════════════════════════════════════════════════════════
// v0.8.113 — Duplikat-Warnung beim Anlegen: nur sichere Signale halten an, ähnliche Stücke sind ein stiller Hinweis;
// verschiedene Seriennummern sind zwei Stücke. Dazu die Description in der Modellkarte/-tabelle.
// Run: node test/duplicates/duplicate-create-rules.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    if (specifier.startsWith('@/')) { const p = resolvePath(repo, 'src', specifier.slice(2)); return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true }; }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);
const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'u' })]]);
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const { useProductStore } = await import('../../src/stores/productStore.ts');
const VIEW = await import('../../src/core/products/product-models-view.ts');
const { splitDuplicates } = await import('../../src/core/products/duplicate-dismiss.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const P = (id: string, extra: Record<string, unknown>) => ({ id, categoryId: 'cat-branded-gold-jewelry', brand: 'Van Cleef & Arpels', name: 'Alhambra 5 motifs', sku: 'VCA-' + id, stockStatus: 'in_stock', attributes: {}, ...extra }) as never;
const emb = (x: number) => Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : x));

useProductStore.setState({ products: [
  P('1', { attributes: { karat: '18K Yellow', weight: 12.3, item_type: 'Bracelet', description: 'Malachite', serial_number: 'SN-1' }, imageEmbedding: emb(0.1) }),
  P('2', { attributes: { karat: '18K Yellow', weight: 12.85, item_type: 'Bracelet', description: 'Onyx', reference_number: 'VCARF48900' } }),
  P('3', { brand: 'Rolex', name: 'Submariner', sku: 'RLX-3', categoryId: 'cat-watch', attributes: { reference_number: '126610LN', serial_number: 'Z111' } }),
] } as never);
const find = (c: Record<string, unknown>) => useProductStore.getState().findPossibleDuplicates(c as never, undefined, { forCreate: true });

// 1 gleiche Marke + Name, anderes Gewicht/Steinfarbe → nur stiller Hinweis, kein Popup
{
  const h = find({ categoryId: 'cat-branded-gold-jewelry', brand: 'Van Cleef & Arpels', name: 'Alhambra 5 motifs', attributes: { karat: '18K Yellow', weight: 12.5, item_type: 'Bracelet', description: 'Carnelian' } });
  const { hard, soft } = splitDuplicates(h);
  ok(hard.length === 0 && soft.length === 2, `1 gleiches Modell, andere Steinfarbe: KEIN Popup, 2 ähnliche als Hinweis (${hard.length}/${soft.length})`);
  ok(!h.some((x) => x.reasons.some((r) => /g · /.test(r))), '1 das Gold-Merkmal (Gewicht ±0,5 g) zählt beim Anlegen nicht mehr');
}
// 2 gleiche SKU → hart (Popup)
{
  const { hard } = splitDuplicates(find({ sku: 'VCA-1', brand: 'X', name: 'Y' }));
  ok(hard.length === 1 && hard[0].product.id === '1', '2 gleiche SKU: Popup');
}
// 3 gleiche Marke + Referenz → hart; aber verschiedene Seriennummern → zwei Stücke, kein Treffer
{
  const gleich = splitDuplicates(find({ brand: 'Rolex', name: 'Submariner', attributes: { reference_number: '126610LN' } }));
  ok(gleich.hard.length === 1, '3 gleiche Marke + Referenz ohne Seriennummer: Popup (könnte dasselbe Stück sein)');
  const zwei = find({ brand: 'Rolex', name: 'Submariner', attributes: { reference_number: '126610LN', serial_number: 'Z222' } });
  ok(zwei.length === 0, `3 gleiche Referenz, aber andere Seriennummer: zwei Stücke — keine Warnung, kein Hinweis (${zwei.length})`);
  const selbe = splitDuplicates(find({ brand: 'Rolex', name: 'Sub', attributes: { serial_number: 'Z111' } }));
  ok(selbe.hard.length === 1, '3 gleiche Seriennummer: Popup');
}
// 4 Foto: beim Anlegen nie hart; schwach (0,80–0,87) gar nicht, fast identisch nur Hinweis
{
  const schwach = find({ brand: 'Other', name: 'Thing', imageEmbedding: emb(0.55) });
  const fast = find({ brand: 'Other', name: 'Thing', imageEmbedding: emb(0.1) });
  ok(schwach.length === 0, `4 ähnliches Foto: beim Anlegen kein Treffer (${schwach.length})`);
  ok(fast.length === 1 && fast[0].hard === false, '4 fast identisches Foto: nur Hinweis, kein Popup');
  const ohne = useProductStore.getState().findPossibleDuplicates({ brand: 'Other', name: 'Thing', imageEmbedding: emb(0.1) } as never);
  ok(ohne.length === 1 && ohne[0].matchClass === 'STRONG', '4 außerhalb des Anlegens (Duplikat-Gruppen, Handy) bleibt die Foto-Regel wie bisher');
}
// 5 Description in Modellkarte und Tabelle
{
  const ps = useProductStore.getState().products as never[];
  ok(VIEW.variantKeyOf(ps[0]) === '18K YG · Malachite' && VIEW.variantKeyOf(ps[1]) === '18K YG · Onyx',
    `5 Chips: „18K YG · Malachite" / „18K YG · Onyx" (${VIEW.variantKeyOf(ps[0])} / ${VIEW.variantKeyOf(ps[1])})`);
  ok(VIEW.variantKeyOf({ attributes: { size: '16', karat: '18K Yellow' } } as never) === '16 · 18K YG', '5 ohne Description wie bisher: „16 · 18K YG"');
  ok(VIEW.shortText('Mother of Pearl and Diamonds', 18) === 'Mother of Pearl a…' && VIEW.descriptionOf({ attributes: { description: '  Onyx \n  5 motifs ' } } as never) === 'Onyx 5 motifs',
    '5 lange Descriptions werden gekürzt, Leerraum zusammengefasst');
}

console.log(`\nduplicate-create-rules: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('DUPLICATE_CREATE_RULES_PROVED');
process.exit(0);
