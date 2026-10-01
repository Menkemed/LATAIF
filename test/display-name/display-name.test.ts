// ════════════════════════════════════════════════════════════════════════════
// DISPLAY-NAME — der EINE Anzeigename eines Artikels (Rechner + Telefon), Marke/Modell bei
// Gold-Diamond Jewellery weder verlangt noch gezeigt, AI Identify ohne Marke bei Gold.
// Run: node test/display-name/display-name.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
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
const store = new Map<string, string>();
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const dn = await import('../../src/core/products/display-name.ts');
const lookup = await import('../../src/core/utils/category-lookup.ts');
const { DEFAULT_CATEGORIES } = await import('../../src/core/models/default-categories.ts');
const { isBrandRequired } = await import('../../src/core/products/field-contract.ts');
const purchaseRules = await import('../../src/core/purchases/purchase-create.ts');
// Wie in der Seite: der Baustein hängt sich an `self` (die Datei ist kein Modul).
const jsBox: Record<string, unknown> = {};
new Function('self', readFileSync(join(repo, 'src-tauri/src/sync/mobile_display_name.js'), 'utf8'))(jsBox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const js = jsBox.MobileDisplayName as any;

let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) { PASS++; } else { fails.push(m); console.log('  x ' + m); } };
const S = JSON.stringify;
const src = (p: string) => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');

lookup.registerCategoryLookup((id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id) as never);
const GOLD = 'cat-gold-jewelry';

// ── 1 der Name ──
const faelle: Array<[string, Record<string, unknown>, string]> = [
  ['Marke + Modell wie bisher', { brand: 'Rolex', name: 'Datejust 36', categoryId: 'cat-watch' }, 'Rolex Datejust 36'],
  ['nur Modell', { brand: '', name: 'Tank', categoryId: 'cat-watch' }, 'Tank'],
  ['Gold ohne Marke: aus den Merkmalen', { brand: '', name: '', categoryId: GOLD, attributes: { item_type: 'Necklace', description: 'EMERALD PENDANT', karat: '18K White', weight: 5 } }, 'Necklace · Emerald Pendant · 18K White Gold · 5 g'],
  ['Gewicht mit zwei Stellen', { categoryId: GOLD, attributes: { item_type: 'Ring', description: 'BAGUETTE DIAMOND', karat: '18K Yellow', weight: 3.1 } }, 'Ring · Baguette Diamond · 18K Yellow Gold · 3.10 g'],
  ['Silber', { categoryId: GOLD, attributes: { item_type: 'Pendant', description: 'GREEN STONE', karat: 'Silver', weight: 4 } }, 'Pendant · Green Stone · Silver · 4 g'],
  ['Merkmale als JSON-Text (SQL-Zeile)', { categoryId: GOLD, attributes: '{"item_type":"Ring","karat":"18K White","weight":2.92}' }, 'Ring · 18K White Gold · 2.92 g'],
  ['Beschreibung gleich Schmuckart nicht doppelt', { categoryId: GOLD, attributes: { item_type: 'Ring', description: 'RING', weight: 1 } }, 'Ring · 1 g'],
  ['gemischte Schreibweise bleibt', { categoryId: GOLD, attributes: { item_type: 'Ring', description: 'Love Knot' } }, 'Ring · Love Knot'],
  ['Schmuckart steckt in der Beschreibung: nicht doppelt', { categoryId: GOLD, attributes: { item_type: 'Ring', description: 'DOUBLE RING', karat: '18K White', weight: 2.92 } }, 'Double Ring · 18K White Gold · 2.92 g'],
  ['…auch mitten im Text', { categoryId: GOLD, attributes: { item_type: 'Ring', description: 'Diamond Ring Main 0.59ct', karat: '18K White', weight: 16.1 } }, 'Diamond Ring Main 0.59ct · 18K White Gold · 16.10 g'],
  ['…aber nur als ganzes Wort', { categoryId: GOLD, attributes: { item_type: 'Ring', description: 'Earrings Set', weight: 2 } }, 'Ring · Earrings Set · 2 g'],
  ['Karat mit „Gold" (Mix, nur Karat)', { categoryId: GOLD, attributes: { item_type: 'Bangle', karat: '14K Mix' } }, 'Bangle · 14K Mix Gold'],
  ['…„Gold" steht schon da: nicht doppelt', { categoryId: GOLD, attributes: { item_type: 'Bangle', karat: '18K Rose Gold' } }, 'Bangle · 18K Rose Gold'],
  ['gar nichts → Kategoriename', { categoryId: GOLD, attributes: {} }, 'Gold-Diamond Jewellery'],
  ['ein älterer Wert bei Gold bleibt sichtbar', { brand: 'Pendant', name: 'Emerald Pendant Necklace', categoryId: GOLD, attributes: { item_type: 'Necklace' } }, 'Pendant Emerald Pendant Necklace'],
];
ok(['18K White', '21K', '18k yellow', '22KT Yellow', 'Silver', '18K Rose Gold', '', 'Platinum'].map(dn.karatText).join('|')
  === '18K White Gold|21K Gold|18k yellow Gold|22KT Yellow Gold|Silver|18K Rose Gold||Platinum', 'KARAT „Gold" nur hinter einem Karatwert');
for (const [was, p, soll] of faelle) {
  ok(dn.productDisplayName(p as never) === soll, `NAME ${was}: „${dn.productDisplayName(p as never)}" soll „${soll}"`);
  ok(js.displayName(p, (DEFAULT_CATEGORIES.find((c) => c.id === p.categoryId) || {}).name) === soll, `PARITÄT Telefon ${was}: „${js.displayName(p)}"`);
}
ok(dn.productDisplayName(null) === '' && dn.productDisplayName({}) === '', 'NAME leer bleibt leer (der Aufrufer entscheidet über „(unnamed)")');
ok(S(dn.productDisplayLines({ brand: 'Rolex', name: 'Datejust' })) === S({ overline: 'Rolex', title: 'Datejust' })
  && S(dn.productDisplayLines({ categoryId: GOLD, attributes: { item_type: 'Ring', weight: 2 } })) === S({ overline: '', title: 'Ring · 2 g' })
  && S(dn.productDisplayLines({ brand: 'Cartier', name: '' })) === S({ overline: '', title: 'Cartier' }),
  'ZWEIZEILIG Marke oben/Modell darunter; ohne Marke der erzeugte Name als Titel');
ok(S(js.displayLines({ categoryId: GOLD, attributes: { item_type: 'Ring', weight: 2 } })) === S({ overline: '', title: 'Ring · 2 g' }), 'PARITÄT Telefon zweizeilig');

// ── 2 Marke/Modell ausblenden: nur Gold-Diamond Jewellery; Pflicht wie am Rechner ──
ok(dn.brandModelHidden(GOLD) && !dn.brandModelHidden('cat-branded-gold-jewelry') && !dn.brandModelHidden('cat-accessory') && !dn.brandModelHidden('cat-watch'),
  'AUSBLENDEN nur bei Gold-Diamond Jewellery — Branded Gold, Zubehör, Uhren zeigen Marke/Modell');
ok(S(js.BRAND_MODEL_HIDDEN_CATEGORIES) === S(dn.BRAND_MODEL_HIDDEN_CATEGORIES), 'PARITÄT Telefon dieselbe Liste');
const sandbox: Record<string, unknown> = { MobileDisplayName: js };
new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(sandbox);
new Function('self', src('src-tauri/src/sync/mobile_business_date.js'))(sandbox);
new Function('self', src('src-tauri/src/sync/mobile_purchase_commands.js'))(sandbox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MPX = sandbox.MobilePurchase as any;
ok(DEFAULT_CATEGORIES.every((c) => MPX.brandRequired(c.id) === isBrandRequired(c.id)), 'PARITÄT Telefon Pflicht für Marke/Modell je Kategorie wie am Rechner');

// ── 3 Einkauf: Gold ohne Marke ist gültig, Uhr ohne Marke nicht ──
const kopf = { supplierId: 'sup-1', purchaseDate: '2026-09-29', taxScheme: 'ZERO', paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '' };
const zeile = (categoryId: string, brand = '', name = '') => ({ mode: 'new', brand, name, sku: '', categoryId, quantity: 1, unitPrice: 10, newProduct: { categoryId, brand, name } });
ok(purchaseRules.purchaseCreateIssue({ ...kopf, lines: [zeile(GOLD)] } as never) === null, 'EINKAUF Gold-Diamond Jewellery ohne Marke/Modell ist gültig (PC, Handy, Primary)');
ok(purchaseRules.purchaseCreateIssue({ ...kopf, lines: [zeile('cat-watch')] } as never)?.code === 'LINE_INVALID', 'EINKAUF eine Uhr ohne Marke/Modell bleibt ungültig');
ok(purchaseRules.purchaseCreateIssue({ ...kopf, lines: [zeile('cat-watch', 'Rolex', 'Datejust')] } as never) === null, 'EINKAUF Uhr mit Marke/Modell gültig');

// ── 4 Telefon-Einkauf: keine Marke/kein Modell bei Gold, Name aus den Merkmalen ──
const d = MPX.newDraft('d1', '2026-09-29');
d.supplier = { mode: 'existing', supplierId: 'sup-1', name: 'S', person: {}, createDespite: false };
const g = Object.assign(MPX.newItem('g', GOLD), { brand: 'Pendant', name: 'Old', quantity: '1', unitPrice: '100',
  attributes: { item_type: 'Necklace', description: 'SOLITAIRE', karat: '18K White', weight: 2.5 } });
d.items.push(g);
ok(MPX.validate(d).length === 0, `TELEFON Gold ohne Pflicht zu Marke/Modell ist gültig (${S(MPX.validate(d))})`);
const body = MPX.buildBody(d, () => []).body;
ok(body.lines[0].brand === '' && body.lines[0].name === '' && body.lines[0].newProduct.brand === null && body.lines[0].newProduct.name === null,
  'TELEFON bei Gold reisen keine Marke/kein Modell mit (auch nicht aus einer früheren Eingabe)');
ok(/^Necklace · Solitaire · 18K White Gold · 2\.50 g · 1 ×/.test(MPX.itemSummary(g)), `TELEFON Zusammenfassung mit dem erzeugten Namen (${MPX.itemSummary(g)})`);
const w = Object.assign(MPX.newItem('w', 'cat-watch'), { quantity: '1', unitPrice: '100' });
d.items = [w];
ok(MPX.validate(d).some((x: { code: string }) => x.code === 'LINE_INVALID'), 'TELEFON eine Uhr ohne Marke bleibt ungültig');

// ── 5 AI Identify bei Gold: keine Marke, Schmuckart nach item_type ──
const ai = dn.aiResultForCategory({ brand: 'Pendant', name: 'Emerald Pendant Necklace', attributes: { karat: '18K White' } }, GOLD);
ok(!('brand' in ai) && !('name' in ai) && ai.attributes.item_type === 'Pendant' && ai.attributes.karat === '18K White',
  `KI Gold: Marke/Modell fallen weg, „Pendant" wandert nach Item Type (${S(ai)})`);
const ai2 = dn.aiResultForCategory({ brand: 'Pendant', attributes: { item_type: 'Necklace' } }, GOLD);
ok(ai2.attributes.item_type === 'Necklace' && !('brand' in ai2), 'KI Gold: ein schon erkanntes Item Type bleibt');
const uhr = { brand: 'Rolex', name: 'Datejust', attributes: {} };
ok(dn.aiResultForCategory(uhr, 'cat-watch') === uhr && dn.aiResultForCategory(uhr, 'cat-branded-gold-jewelry') === uhr, 'KI andere Kategorien unverändert (Branded Gold behält die Marke)');
const opts = (DEFAULT_CATEGORIES.find((c) => c.id === GOLD)!.attributes.find((a) => a.key === 'item_type')!.options) as string[];
ok(S(js.aiResultForCategory({ brand: 'Pendant', name: 'X', attributes: {} }, GOLD, opts)) === S(ai.attributes ? { attributes: { item_type: 'Pendant' } } : {}),
  'PARITÄT Telefon KI-Regel');
const vertrag = JSON.parse(src('src/core/ai/identify-contract.json'));
ok(/return brand = null and name = null/.test(vertrag.categories[GOLD].notes), 'KI-Vorgabe (PC + Primary lesen dieselbe): bei Gold brand/name = null');
ok(/aiResultForCategory\(r, p\.categoryId\)/.test(src('src/core/ai/identify-adapter.ts')), 'KI Rechner: alle Masken gehen durch den einen Adapter mit der Regel');

// ── 6 eine Stelle: niemand setzt „Marke + Modell" mehr selbst zusammen ──
const erlaubt = new Set(['src/core/products/display-name.ts', 'src/core/tax/vat-period-lock.ts']);
const rest: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(join(repo, dir))) {
    const p = dir + '/' + e;
    if (statSync(join(repo, p)).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(e) || erlaubt.has(p)) continue;
    const s = src(p);
    if (/\$\{[\w.]+\.brand(?: \|\| '')?\} \$\{[\w.]+\.name(?: \|\| '')?\}/.test(s) || /\[[\w.]+\.brand, [\w.]+\.name\]\.filter\(Boolean\)\.join/.test(s)
      || /\{[\w]+\.brand\} \{[\w]+\.name\}/.test(s)) rest.push(p);
  }
})('src');
ok(rest.length === 0, `EINE STELLE keine eigene „Marke + Modell"-Zusammensetzung mehr (${rest.join(', ')})`);
const seite = src('src-tauri/src/sync/mobile_page.rs');
ok(seite.indexOf('include_str!("mobile_display_name.js")') > 0 && seite.indexOf('include_str!("mobile_display_name.js")') < seite.indexOf('include_str!("mobile_purchase_commands.js")'),
  'TELEFON der Namensbaustein ist eingebunden, vor den Befehlsmodulen');
ok(/MobileDisplayName\.displayLines\(p,/.test(seite) && /MobileDisplayName\.displayLines\(\{ brand: h\.brand/.test(seite),
  'TELEFON Artikelanzeige und Suchtreffer nutzen den Anzeigenamen');
ok(/MobileDisplayName\.brandModelHidden\(catId\)/.test(seite) && /MobileDisplayName\.brandModelHidden\(catId\)/.test(src('src-tauri/src/sync/mobile_consignment_ui.js')),
  'TELEFON Collection und Kommission blenden Marke/Modell bei Gold aus');

console.log(`\ndisplay-name: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('DISPLAY_NAME_PROVED');
