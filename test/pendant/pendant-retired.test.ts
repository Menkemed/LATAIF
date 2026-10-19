// ═════════════════════════════════════════════════════════════════
// PENDANT — „Pendant" ist keine eigene Schmuckart mehr (Owner 19.10.2026: ein Anhänger ist „Necklace").
// Run: node test/pendant/pendant-retired.test.ts
//
//   1 die Auswahl (Rechner/PC2, Reparatur, Handy, KI) ohne Pendant — alles andere wörtlich gleich
//   2 bestehende Datenbank: die Auswahl verliert Pendant beim Start, KEIN Artikelwert wird umgeschrieben
//   3 neue Artikel: Pendant wird abgelehnt (klarer Satz), Necklace geht; eine eigene Kategorie mit Pendant bleibt frei
//   4 bestehende Artikel: Bearbeiten erlaubt, der alte Wert bleibt sichtbar gewählt; Anzeige/Etikett unverändert
//   5 Handy: Neuanlage mit Pendant abgewiesen, ein Edit ohne Item Type an einem alten Pendant-Artikel geht
//   6 Excel: Pendant → Necklace nur sichtbar (Warnung + Original in der Notiz)   7 KI-Vorgabe   8 Bulk unberührt
// ═════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

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
const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const S = JSON.stringify;
const src = (p: string) => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');
let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

const { DEFAULT_CATEGORIES } = await import('../../src/core/models/default-categories.ts');
const { REPAIR_FIELDS } = await import('../../src/core/models/repair-fields.ts');
const { migrateCategoryStonesV1 } = await import('../../src/core/db/category-stones-migration.ts');
const mfs = await import('../../src/core/mobile/mobile-field-schema.ts');
const patchMod = await import('../../src/core/media/mobile-product-patch.ts');
const fc = await import('../../src/core/products/field-contract.ts');
const pc = await import('../../src/core/products/product-create.ts');
const rc = await import('../../src/core/products/retired-choices.ts');
const cv = await import('../../src/core/products/choice-value.ts');
const dn = await import('../../src/core/products/display-name.ts');
const zpl = await import('../../src/core/print/zpl-tag.ts');
const imp = await import('../../src/core/import/product-import.ts');
const prompt = await import('../../src/core/ai/identify-prompt.ts');
const lookup = await import('../../src/core/utils/category-lookup.ts');
lookup.registerCategoryLookup((id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id) as never);

const GOLD = 'cat-gold-jewelry', BRANDED = 'cat-branded-gold-jewelry', ORIGINAL = 'cat-original-gold-jewelry';
const JEWELLERY = [GOLD, BRANDED, ORIGINAL];
const catOf = (id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id)!;
const typesOf = (id: string) => catOf(id).attributes.find((a) => a.key === 'item_type')?.options || [];
const SOLL: Record<string, string[]> = {
  [GOLD]: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Earrings', 'Brooch', 'Bar', 'Coin'],
  [BRANDED]: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Earrings', 'Brooch'],
  [ORIGINAL]: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Earrings', 'Brooch'],
};

// ── 1 die Auswahl ──────────────────────────────────────────────────────────────
for (const id of JEWELLERY) {
  ok(S(typesOf(id)) === S(SOLL[id]), `AUSWAHL ${id}: ohne Pendant, sonst unverändert (${S(typesOf(id))})`);
  ok(S(REPAIR_FIELDS[id].find((f) => f.key === 'item_type')?.options) === S(SOLL[id]), `AUSWAHL Reparatur ${id}: dieselbe Liste`);
}
ok(S(typesOf('cat-accessory')) === S(['Handbag', 'Eyeglass', 'Wallet', 'Lighter', 'Cufflinks', 'Prayer Beads', 'Walking Stick', 'Pen', 'Key Holder', 'Other']), 'AUSWAHL Accessory unverändert');
ok(!/"Pendant"|'Pendant'/.test(src('src/core/models/default-categories.ts') + src('src/core/models/repair-fields.ts') + src('src-tauri/src/sync/mobile_field_schema.json')),
  'AUSWAHL nirgends mehr als Option (Kategorien, Reparatur, Handy-Schema)');
const schema = mfs.buildMobileFieldSchema();
ok(src('src-tauri/src/sync/mobile_field_schema.json') === JSON.stringify(schema, null, 2) + '\n', 'AUSWAHL das eingebaute Handy-Schema ist frisch erzeugt');

// ── 2 bestehende Datenbank ─────────────────────────────────────────────────────
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
{
  const DB_TS = src('src/core/db/database.ts');
  const goldSql = /`(UPDATE categories SET name = 'Gold-Diamond Jewellery'[\s\S]*?WHERE id = 'cat-gold-jewelry')`/.exec(DB_TS)?.[1] || '';
  ok(goldSql.includes('"options":["Ring","Bangle","Bracelet","Necklace","Earrings","Brooch","Bar","Coin"]'), 'DB die feste Gold-Diamond-Zeile (jeder Start) ohne Pendant');
  const sqlFor = (id: string) => `UPDATE categories SET attributes = '${JSON.stringify(catOf(id).attributes).replace(/'/g, "''")}' WHERE id = '${id}'`;
  const db = new SQL.Database();
  db.run('CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, attributes TEXT, condition_options TEXT, updated_at TEXT)');
  db.run('CREATE TABLE products (id TEXT PRIMARY KEY, category_id TEXT, attributes TEXT)');
  const mitPendant = (id: string) => JSON.stringify(catOf(id).attributes.map((a) => (a.key === 'item_type'
    ? { ...a, options: [...SOLL[id].slice(0, 4), 'Pendant', ...SOLL[id].slice(4)] } : a)));
  for (const id of JEWELLERY) db.run('INSERT INTO categories VALUES (?,?,?,?,?)', [id, catOf(id).name, mitPendant(id), '[]', 'x']);
  const ARTIKEL: Array<[string, string, string]> = [['p1', GOLD, '{"item_type":"Pendant","karat":"18K White","weight":3}'], ['p2', BRANDED, '{"item_type":"Pendant","karat":"Platinum"}'], ['p3', ORIGINAL, '{"item_type":"Necklace"}']];
  for (const a of ARTIKEL) db.run('INSERT INTO products VALUES (?,?,?)', a);
  const start = () => { db.run(goldSql); db.run(sqlFor(BRANDED)); db.run(sqlFor(ORIGINAL)); migrateCategoryStonesV1(db as never); };
  start(); start();
  for (const id of JEWELLERY) {
    const attrs = JSON.parse(String(db.exec('SELECT attributes FROM categories WHERE id = ?', [id])[0].values[0][0]));
    ok(S(attrs) === S(catOf(id).attributes), `DB ${id}: nach dem Update-Start = SSOT (ohne Pendant)`);
  }
  ok(S(db.exec('SELECT * FROM products ORDER BY id')[0].values) === S(ARTIKEL), 'DB kein Artikelwert umgeschrieben (Pendant-Artikel bleiben Pendant)');
  db.close();
}

// ── 3 neue Artikel ─────────────────────────────────────────────────────────────
const port = (id: string) => ({ category: catOf(id) as never, isSkuTaken: () => false, allocateSku: () => 'SKU-T' });
for (const id of JEWELLERY) {
  const form = { categoryId: id, brand: id === GOLD ? '' : 'B', name: id === GOLD ? '' : 'N', quantity: 1, attributes: { item_type: 'Pendant', karat: '18K Yellow', weight: 4 } };
  const plan = pc.planProductCreate(form as never, port(id));
  const refusal = plan.kind === 'invalid' ? pc.productCreateRefusal(plan) : null;
  ok(refusal?.code === 'CHOICE_RETIRED' && /“Pendant” is no longer a choice — use Necklace\./.test(refusal.message),
    `NEU ${id}: Pendant abgelehnt, mit Satz (${S(refusal)})`);
  const gut = pc.planProductCreate({ ...form, attributes: { ...form.attributes, item_type: 'Necklace' } } as never, port(id));
  ok(gut.kind === 'ok', `NEU ${id}: Necklace wird angelegt (${gut.kind})`);
}
ok(pc.planProductCreate({ categoryId: GOLD, quantity: 1, attributes: { item_type: 'pendants ', karat: '18K Yellow', weight: 1 } } as never, port(GOLD)).kind === 'invalid', 'NEU auch „pendants" (Schreibweise) wird erkannt');
{
  const eigene = { id: 'cat-eigen', name: 'Eigene', attributes: [{ key: 'item_type', label: 'Type', type: 'select', options: ['Pendant', 'Charm'], required: true }], conditionOptions: [], scopeOptions: [] };
  ok(pc.planProductCreate({ categoryId: 'cat-eigen', brand: 'B', name: 'N', quantity: 1, attributes: { item_type: 'Pendant' } } as never, { category: eigene as never, isSkuTaken: () => false, allocateSku: () => 'S' }).kind === 'ok',
    'NEU eine eigene Kategorie, die Pendant selbst anbietet, bleibt unberührt');
}
ok(/retiredChoiceIssues\(input\.attributes as Record<string, unknown> \| undefined, port\.category\)/.test(src('src/core/products/product-create.ts')),
  'NEU die Sperre sitzt in der EINEN Anlegevorbereitung (Rechner, PC2-Auftrag, Einkauf, Kommission, Auftrag, Produktion)');

// ── 4 bestehende Artikel ───────────────────────────────────────────────────────
{
  const alt = { categoryId: GOLD, brand: '', name: '', attributes: { item_type: 'Pendant', karat: '18K White', weight: 3, description: 'HALO' } };
  ok(fc.blockingIssues(fc.validateProductFields(catOf(GOLD) as never, alt as never)).length === 0, 'ALT Bearbeiten eines Pendant-Artikels wird nicht gesperrt');
  ok(S(cv.optionsWithStored(SOLL[GOLD], 'Pendant')) === S([...SOLL[GOLD], 'Pendant']) && S(cv.optionsWithStored(SOLL[GOLD], 'Necklace')) === S(SOLL[GOLD])
    && S(cv.optionsWithStored(SOLL[GOLD], undefined)) === S(SOLL[GOLD]), 'ALT der gespeicherte Wert bleibt in der Auswahl sichtbar (gewählt), sonst nichts hinzu');
  ok(/optionsWithStored\(attr\.options, formAttrs\[attr\.key\]\)/.test(src('src/pages/watches/ProductDetail.tsx'))
    && /optionsWithStored\(attr\.options, attrs\[attr\.key\]\)/.test(src('src/pages/orders/OrderDetail.tsx')), 'ALT Artikelseite und Auftrag zeigen den gespeicherten Wert');
  ok(dn.productDisplayName(alt as never) === 'Pendant · Halo · 18K White Gold · 3 g', `ALT Anzeigename unverändert (${dn.productDisplayName(alt as never)})`);
  const face = zpl.buildProductFace({ sku: 'GJ-1', plannedSalePrice: 100, attributes: alt.attributes } as never, catOf(GOLD) as never);
  ok((face.scan?.details || []).includes('PENDANT 18K WG'), `ALT Etikett unverändert (${S(face.scan?.details)})`);
}

// ── 5 Handy ────────────────────────────────────────────────────────────────────
{
  const neu = { categoryId: GOLD, attributes: { weight: 3, item_type: 'Pendant', karat: '18K White' } };
  ok(mfs.validateMobileMetadata(neu, schema, { protocolVersion: 2 }).some((e) => e.code === 'BAD_ENUM' && e.field === 'item_type'), 'HANDY Neuanlage mit Pendant abgewiesen');
  ok(mfs.validateMobileMetadata({ ...neu, attributes: { ...neu.attributes, item_type: 'Necklace' } }, schema, { enforceRequired: true, protocolVersion: 2 }).length === 0, 'HANDY Necklace geht');
  const jetzt = { categoryId: GOLD, attributes: { item_type: 'Pendant', karat: '18K White', weight: 3 }, scopeOfDelivery: [] };
  const p1 = patchMod.parseMobileProductPatch({ attributes: { weight: 3.5 } });
  ok(p1.ok && patchMod.resolveMobileProductPatch((p1 as { patch: never }).patch, jetzt, schema).ok, 'HANDY Edit eines alten Pendant-Artikels (ohne Item Type) geht');
  const p2 = patchMod.parseMobileProductPatch({ attributes: { item_type: 'Pendant' } });
  const r2 = p2.ok ? patchMod.resolveMobileProductPatch((p2 as { patch: never }).patch, jetzt, schema) : p2;
  ok(!r2.ok, 'HANDY Pendant neu setzen wird abgewiesen');
}

// ── 6 Excel ────────────────────────────────────────────────────────────────────
{
  const katVon = (n: string) => { const c = DEFAULT_CATEGORIES.find((x) => x.name.toLowerCase() === n.toLowerCase()); return c ? { id: c.id, name: c.name, matched: true } : { id: 'cat-watch', name: 'Watch', matched: false }; };
  const zeile = (typ: string) => imp.classifyRows([{ Category: 'Gold-Diamond Jewellery', 'Item Type': typ, 'Karat & Color': '18K White', Weight: 3, Cost: 100 }],
    { resolveCategory: katVon, defaultVatScheme: 'VAT_10' as const, existingIndex: imp.buildExistingIndex([]) })[0];
  for (const roh of ['Pendant', 'pendants', ' PENDANT ']) {
    const z = zeile(roh);
    ok(z.attributes.item_type === 'Necklace' && z.status === 'warning' && (z.notes || '').includes(`Item type: ${roh.trim()}`)
      && z.warnings.some((w) => w === `Item Type "${roh.trim()}" → Necklace; it is no longer a separate type (kept in notes)`),
      `EXCEL „${roh}" → Necklace, sichtbar: Warnung + Original in der Notiz (${S({ s: z.status, n: z.notes, w: z.warnings })})`);
  }
  const n = zeile('Necklace');
  ok(n.status === 'new' && n.attributes.item_type === 'Necklace' && !n.notes, 'EXCEL „Necklace" ohne Warnung');
  const u = zeile('Charm');
  ok(!u.attributes.item_type && u.warnings.some((w) => w.includes('not recognised')) && (u.notes || '').includes('Item type: Charm'), 'EXCEL unbekannte Art wie bisher: leer, Warnung, Notiz');
  const src2 = src('src/core/import/product-import.ts');
  ok(!/'Item Type': 'Pendant'/.test(src2) && /Pendant is no longer a separate type: it becomes Necklace, the preview warns and the original value stays in the notes\./.test(src2),
    'EXCEL die Vorlage zeigt kein Pendant mehr und erklärt die Übersetzung');
  ok(rc.retiredReplacement('item_type', 'Pendant') === 'Necklace' && rc.retiredReplacement('item_type', 'Necklace') === null && rc.retiredReplacement('karat', 'Pendant') === null,
    'EXCEL die Übersetzung gilt nur für Item Type und nur für den ausgemusterten Wert');
}

// ── 7 KI ───────────────────────────────────────────────────────────────────────
{
  const vertrag = JSON.parse(src('src/core/ai/identify-contract.json'));
  for (const id of JEWELLERY) {
    const notes = String(vertrag.categories[id].notes);
    ok(!/Necklace, Pendant/.test(notes) && /A pendant \(with or without a chain\) is Necklace — there is no separate Pendant type\./.test(notes), `KI ${id}: Liste ohne Pendant, Hinweis „Anhänger = Necklace"`);
    ok(prompt.buildSystemPrompt(id).includes('there is no separate Pendant type'), `KI ${id}: der Prompt (Rechner und Primary) enthält den Hinweis`);
  }
  const ai = dn.aiResultForCategory({ brand: 'Pendant', name: 'X', attributes: {} }, GOLD);
  ok(!('item_type' in ai.attributes), 'KI eine Antwort „Pendant" wird nicht zum Item Type (die Neuanlage würde es ohnehin ablehnen)');
}

// ── 8 Bulk Metal unberührt ─────────────────────────────────────────────────────
ok(/PENDANT: 'Pendant'/.test(src('src/core/bulk/bulk-math.ts')), 'BULK die Verkaufsart „Pendant" im Bulk-Metall ist ein anderes Konzept und bleibt');

console.log(`\npendant-retired: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
