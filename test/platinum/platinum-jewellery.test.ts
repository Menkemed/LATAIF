// ═════════════════════════════════════════════════════════════════
// PLATINUM — „Platinum" als EINE Auswahl (ohne 950/999) bei Gold-Diamond, Branded und Original Jewellery.
// Run: node test/platinum/platinum-jewellery.test.ts
//
//   1 SSOT der drei Kategorien, alte Optionen unverändert, Uhr/Ersatzteil unverändert
//   2 bestehende und neue Datenbank (die echten Start-Anweisungen, dreimal)   3 Reparatur-Auswahl
//   4 Telefon (Schema, Prüfung, Bearbeiten)   5 Rechner/PC2 (Anlegen, Felder, Kategorien vom Primary)
//   6 Excel-Import (Platinum, 950, 999, PT950, Mischfälle, Gold unverändert)   7 KI-Vorgabe
//   8 Anzeige, Rechnung, Etikett   9 Gold-Karate und Reinheit unverändert, Platinum ist nie Gold
// ═════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
const dn = await import('../../src/core/products/display-name.ts');
const a5 = await import('../../src/core/pdf/invoice-a5.ts');
const zpl = await import('../../src/core/print/zpl-tag.ts');
const imp = await import('../../src/core/import/product-import.ts');
const prompt = await import('../../src/core/ai/identify-prompt.ts');
const purity = await import('../../src/core/gold/purity.ts');
const settle = await import('../../src/core/gold/gold-settle.ts');
const bulk = await import('../../src/core/bulk/bulk-product.ts');
const jsBox: Record<string, unknown> = {};
new Function('self', src('src-tauri/src/sync/mobile_display_name.js'))(jsBox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const js = jsBox.MobileDisplayName as any;

const GOLD = 'cat-gold-jewelry', BRANDED = 'cat-branded-gold-jewelry', ORIGINAL = 'cat-original-gold-jewelry';
const JEWELLERY = [GOLD, BRANDED, ORIGINAL];
const catOf = (id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id)!;
const karatOptions = (id: string) => catOf(id).attributes.find((a) => a.key === 'karat')?.options || [];
// Der Stand von v0.8.84 — er bleibt wörtlich, Platinum kommt nur ans Ende.
const BISHER = ['24K Yellow', '22K Yellow', '21K Yellow', '18K Yellow', '18K Rose', '18K White', '18K Mix',
  '14K Yellow', '14K Rose', '14K White', '14K Mix', 'Silver'];
const NEU = [...BISHER, 'Platinum'];

// ── 1 SSOT ──────────────────────────────────────────────────────────────────
for (const id of JEWELLERY) {
  ok(S(karatOptions(id)) === S(NEU), `SSOT ${id}: alle bisherigen Optionen unverändert, Platinum genau einmal am Ende (${S(karatOptions(id))})`);
}
ok(DEFAULT_CATEGORIES.every((c) => !(c.attributes.flatMap((a) => a.options || [])).some((o) => /platinum\s*\d|pt\s*\d/i.test(o))),
  'SSOT keine 950-/999-Variante irgendwo');
const watch = catOf('cat-watch').attributes;
ok(S(watch.find((a) => a.key === 'material')?.options) === S(['Steel', 'Solid Gold', 'Two-Tone Steel/Gold', 'Platinum', 'Titanium', 'Ceramic', 'Bronze', 'Carbon',
  'DLC Steel', 'Plated', 'Ceramic & Steel', 'Ceramic & Gold', 'Titanium & Gold', 'Titanium & Ceramic'])
  && S(watch.find((a) => a.key === 'karat_color')?.options) === S(['18K Yellow', '18K Rose', '18K White', '14K Yellow', '14K Rose', '14K White', '9K Yellow', '9K Rose']),
  'SSOT Uhr unverändert (Platinum bleibt Material, Karat & Color ohne Platinum)');
ok(!(catOf('cat-spare-part').attributes.find((a) => a.key === 'material')?.options || []).includes('Platinum'), 'SSOT Spare Part unverändert');
for (const id of JEWELLERY) {
  const k = catOf(id).attributes.find((a) => a.key === 'karat')!;
  ok(k.type === 'select' && k.label === 'Karat & Color' && k.required === true, `SSOT ${id}: Karat & Color bleibt Auswahl und Pflicht`);
}

// ── 2 bestehende und neue Datenbank — die echten Start-Anweisungen ─────────────
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const DB_TS = src('src/core/db/database.ts');
const goldSql = /`(UPDATE categories SET name = 'Gold-Diamond Jewellery'[\s\S]*?WHERE id = 'cat-gold-jewelry')`/.exec(DB_TS)?.[1] || '';
ok(!!goldSql && goldSql.includes('"14K Mix","Silver","Platinum"]'), 'DB die feste Gold-Diamond-Zeile (läuft bei jedem Start) trägt Platinum');
ok(/categoryAttributesSql\('cat-branded-gold-jewelry'\)/.test(DB_TS) && /categoryAttributesSql\('cat-original-gold-jewelry'\)/.test(DB_TS),
  'DB Branded und Original werden bei jedem Start aus der SSOT geschrieben');
// Derselbe Baustein wie in database.ts (dort nicht importierbar; test/items/category-reconciliation.test.ts prüft den Rumpf).
const categoryAttributesSql = (id: string) => `UPDATE categories SET attributes = '${JSON.stringify(catOf(id).attributes).replace(/'/g, "''")}' WHERE id = '${id}'`;
const neueDb = () => {
  const db = new SQL.Database();
  db.run('CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, attributes TEXT, condition_options TEXT, updated_at TEXT)');
  db.run('CREATE TABLE products (id TEXT PRIMARY KEY, category_id TEXT, attributes TEXT)');
  return db;
};
const start = (db: InstanceType<typeof SQL.Database>) => {
  db.run(goldSql);
  db.run(categoryAttributesSql(BRANDED));
  db.run(categoryAttributesSql(ORIGINAL));
  migrateCategoryStonesV1(db);
};
const attrsIn = (db: InstanceType<typeof SQL.Database>, id: string) => JSON.parse(String(db.exec('SELECT attributes FROM categories WHERE id = ?', [id])[0].values[0][0]));
const optsIn = (db: InstanceType<typeof SQL.Database>, id: string) => (attrsIn(db, id) as Array<{ key: string; options?: string[] }>).find((a) => a.key === 'karat')?.options || [];
{
  // Eine Datenbank von v0.8.84: Kategorien ohne Platinum, Artikel mit bisherigen Werten.
  const db = neueDb();
  const ohnePlatin = (id: string) => JSON.stringify(catOf(id).attributes.map((a) => (a.key === 'karat' ? { ...a, options: BISHER } : a)));
  db.run('INSERT INTO categories (id, name, attributes, condition_options, updated_at) VALUES (?,?,?,?,?),(?,?,?,?,?),(?,?,?,?,?)', [
    GOLD, 'Gold-Diamond Jewellery', ohnePlatin(GOLD), '["New","Pre-Owned","Vintage"]', '2026-10-01',
    BRANDED, 'Branded Gold Jewelry', ohnePlatin(BRANDED), '[]', '2026-10-01',
    ORIGINAL, 'Original Gold Jewelry', ohnePlatin(ORIGINAL), '[]', '2026-10-01',
  ]);
  const ARTIKEL: Array<[string, string, string]> = [
    ['p1', GOLD, '{"weight":5,"item_type":"Ring","karat":"Silver"}'],
    ['p2', BRANDED, '{"item_type":"Ring","karat":"18K White","weight":6.2}'],
    ['p3', ORIGINAL, '{"item_type":"Bangle","karat":"21K Yellow"}'],
  ];
  for (const a of ARTIKEL) db.run('INSERT INTO products VALUES (?,?,?)', a);
  for (const id of JEWELLERY) ok(!optsIn(db, id).includes('Platinum'), `BESTAND vorher: ${id} ohne Platinum`);
  start(db);
  for (const id of JEWELLERY) ok(S(optsIn(db, id)) === S(NEU), `BESTAND nach dem Update-Start: ${id} hat Platinum (${S(optsIn(db, id))})`);
  for (const id of JEWELLERY) ok(S(attrsIn(db, id)) === S(catOf(id).attributes), `BESTAND ${id} gleicht danach der SSOT (auch Steinliste/Reihenfolge)`);
  const nachEins = JEWELLERY.map((id) => S(attrsIn(db, id)));
  start(db); start(db);
  ok(S(JEWELLERY.map((id) => S(attrsIn(db, id)))) === S(nachEins), 'BESTAND drei Starts hintereinander — byte-gleich, Platinum bleibt');
  const nachher = db.exec('SELECT id, category_id, attributes FROM products ORDER BY id')[0].values.map((r) => r.map(String));
  ok(S(nachher) === S(ARTIKEL), 'BESTAND kein Artikelwert verändert (keine Datenmigration)');
  db.close();
}
{
  // Neue Datenbank: angelegt wie der Seed (DEFAULT_CATEGORIES), dann der Start.
  const db = neueDb();
  for (const c of DEFAULT_CATEGORIES.filter((k) => JEWELLERY.includes(k.id))) {
    db.run('INSERT INTO categories (id, name, attributes, condition_options, updated_at) VALUES (?,?,?,?,?)', [c.id, c.name, JSON.stringify(c.attributes), JSON.stringify(c.conditionOptions), 'x']);
  }
  for (const id of JEWELLERY) ok(S(optsIn(db, id)) === S(NEU), `NEU ${id} hat Platinum schon beim Anlegen`);
  start(db);
  for (const id of JEWELLERY) ok(S(attrsIn(db, id)) === S(catOf(id).attributes), `NEU ${id} nach dem ersten Start = SSOT`);
  db.close();
}
ok(!src('src/core/sync/sync-business-schema.json').includes('"categories"'), 'SYNC Kategorien werden nicht synchronisiert — jede Datenbank holt Platinum beim Start selbst');

// ── 3 Reparatur ─────────────────────────────────────────────────────────────
for (const id of JEWELLERY) {
  const f = REPAIR_FIELDS[id].find((x) => x.key === 'karat');
  ok(f?.type === 'select' && S(f.options) === S(NEU), `REPARATUR ${id}: dieselbe Auswahl wie am Artikel (mit Platinum)`);
}
ok(S(REPAIR_FIELDS['cat-watch'].find((x) => x.key === 'material')?.options) === S(watch.find((a) => a.key === 'material')?.options)
  && !(REPAIR_FIELDS['cat-watch'].find((x) => x.key === 'karat_color')?.options || []).includes('Platinum'), 'REPARATUR Uhr unverändert');

// ── 4 Telefon ───────────────────────────────────────────────────────────────
const schema = mfs.buildMobileFieldSchema();
ok(readFileSync(join(repo, 'src-tauri/src/sync/mobile_field_schema.json'), 'utf8').replace(/\r\n/g, '\n') === JSON.stringify(schema, null, 2) + '\n',
  'TELEFON das eingebaute Schema ist frisch erzeugt (Seite + Rust-Prüfung)');
for (const id of JEWELLERY) {
  const c = schema.categories.find((k) => k.id === id)!;
  ok(S(c.attributes.find((a) => a.key === 'karat')?.options) === S(NEU), `TELEFON ${id}: Platinum in der Auswahl`);
}
const PFLICHT: Record<string, Record<string, unknown>> = {
  [GOLD]: { categoryId: GOLD, attributes: { weight: 5, item_type: 'Ring', karat: 'Platinum' } },
  [BRANDED]: { categoryId: BRANDED, brand: 'Cartier', name: 'Love', attributes: { item_type: 'Ring', karat: 'Platinum' } },
  [ORIGINAL]: { categoryId: ORIGINAL, brand: 'X', name: 'Y', attributes: { item_type: 'Ring', karat: 'Platinum' } },
};
for (const id of JEWELLERY) {
  const e = mfs.validateMobileMetadata(PFLICHT[id], schema, { enforceRequired: true, protocolVersion: 2 });
  ok(e.length === 0, `TELEFON ${id}: Neuanlage mit Platinum gültig (${S(e)})`);
  for (const bad of ['Platinum 950', 'Platinum 999', 'PT950', 'platinum']) {
    const m = { ...PFLICHT[id], attributes: { ...(PFLICHT[id].attributes as object), karat: bad } };
    ok(mfs.validateMobileMetadata(m, schema, { protocolVersion: 2 }).some((x) => x.code === 'BAD_ENUM' && x.field === 'karat'), `TELEFON ${id}: „${bad}" ist keine Auswahl`);
  }
}
{
  const p = patchMod.parseMobileProductPatch({ attributes: { karat: 'Platinum' } });
  const jetzt = { categoryId: BRANDED, attributes: { item_type: 'Ring', karat: '18K Yellow' }, scopeOfDelivery: [] };
  ok(p.ok && patchMod.resolveMobileProductPatch((p as { patch: never }).patch, jetzt, schema).ok, 'TELEFON Bearbeiten: 18K Yellow → Platinum erlaubt');
  const q = patchMod.parseMobileProductPatch({ attributes: { karat: 'Platinum 950' } });
  const r = q.ok ? patchMod.resolveMobileProductPatch((q as { patch: never }).patch, jetzt, schema) : q;
  ok(!r.ok && (r as { code: string }).code === patchMod.ERR_PATCH_ATTR_INVALID, 'TELEFON Bearbeiten: „Platinum 950" abgewiesen');
}
ok(/fn platinum_is_one_jewellery_option_without_fineness/.test(src('src-tauri/src/sync/mobile_field_schema.rs')), 'TELEFON Rust prüft dieselbe Regel (cargo test)');

// ── 5 Rechner / PC2 ─────────────────────────────────────────────────────────
for (const id of JEWELLERY) {
  const form = { categoryId: id, brand: PFLICHT[id].brand as string | undefined, name: PFLICHT[id].name as string | undefined, attributes: PFLICHT[id].attributes as Record<string, unknown> };
  ok(fc.blockingIssues(fc.validateProductFields(catOf(id) as never, form as never)).length === 0, `RECHNER ${id}: Feldprüfung nimmt Platinum an`);
  const plan = pc.planProductCreate({ ...form, quantity: 1 } as never, { category: catOf(id) as never, isSkuTaken: () => false, allocateSku: () => 'SKU-T' });
  ok(plan.kind === 'ok' && (plan as { data: { attributes: Record<string, unknown> } }).data.attributes.karat === 'Platinum',
    `RECHNER ${id}: Anlegen speichert „Platinum" unverändert (${plan.kind})`);
}
// Die Masken zeichnen die Auswahl aus der Kategorie; eine Liste steht nur an den bekannten Stellen.
const MIT_LISTE = new Set(['src/core/models/default-categories.ts', 'src/core/models/repair-fields.ts', 'src/core/db/database.ts',
  'src/core/ai/identify-contract.json', 'src-tauri/src/sync/mobile_field_schema.json']);
const gefunden: string[] = [];
const lauf = (dir: string) => {
  for (const n of readdirSync(join(repo, dir))) {
    const rel = dir + '/' + n;
    if (n === 'target' || n === 'node_modules') continue;
    if (statSync(join(repo, rel)).isDirectory()) lauf(rel);
    else if (/\.(ts|tsx|js|rs|json|html)$/.test(n) && readFileSync(join(repo, rel), 'utf8').includes('14K Mix')) gefunden.push(rel);
  }
};
lauf('src'); lauf('src-tauri/src');
ok(gefunden.length === MIT_LISTE.size && gefunden.every((f) => MIT_LISTE.has(f)), `RECHNER keine weitere fest eingetippte Schmuck-Liste (${gefunden.join(', ')})`);
ok(/attr\.options\.map\(/.test(src('src/components/products/NewProductModal.tsx')), 'RECHNER Neuanlage (Collection, Purchase, Consignment, Orders, Production) zeigt die Auswahl der Kategorie');
ok(/loadCategories: \(\) => \{\n\s*if \(hydrateFromPrimary\('store\.products\.get'/.test(src('src/stores/productStore.ts'))
  && /loadCategoriesFor\(ctx\)/.test(src('src/core/bridge/store-read-commands.ts')), 'PC2 die Kategorien (mit Platinum) kommen vom Primary');

// ── 6 Excel-Import ──────────────────────────────────────────────────────────
const k = (raw: string) => imp.karatColorOption(raw, NEU);
const PLATIN: Array<[string, string]> = [['Platinum', 'Platinum'], ['platinum', 'Platinum'], ['PLATINUM', 'Platinum'], ['Platinum 950', 'Platinum'],
  ['Platinum 999', 'Platinum'], ['999 Platinum', 'Platinum'], ['PT950', 'Platinum'], ['Pt 999', 'Platinum'], ['pt-950', 'Platinum'], ['Platin 950', 'Platinum'], ['Plat 900', 'Platinum']];
for (const [roh, soll] of PLATIN) ok(k(roh) === soll, `IMPORT „${roh}" → ${soll} (${k(roh)})`);
ok(k('Platinum 999') !== '24K Yellow', 'IMPORT der Fehler aus dem Audit: „Platinum 999" wird NIE 24K Yellow');
for (const roh of ['18K White Gold & Platinum', 'Platinum plated silver', 'platinum plated', '18 platinum', 'Platinum 750', 'Platinum 24K', 'Two-tone platinum/yellow', 'Platinum 925']) {
  ok(k(roh) === null, `IMPORT Mischfall „${roh}" wird nicht geraten (${k(roh)})`);
}
ok(imp.karatColorOption('Platinum 950', BISHER) === null, 'IMPORT ohne Platinum in der Kategorie → nichts erfunden');
// Gold und Silber wie bisher.
const GOLDFAELLE: Array<[string, string | null]> = [['999', '24K Yellow'], ['18 white gold', '18K White'], ['750 rose', '18K Rose'], ['Silver 925', 'Silver'],
  ['Sterling', 'Silver'], ['21', '21K Yellow'], ['18K Yellow', '18K Yellow'], ['18', null], ['0.18', null], ['plate', null], ['Platform', null]];
for (const [roh, soll] of GOLDFAELLE) ok(k(roh) === soll, `IMPORT Gold/Silber unverändert „${roh}" → ${soll} (${k(roh)})`);

const katVon = (n: string) => { const c = DEFAULT_CATEGORIES.find((x) => x.name.toLowerCase() === n.toLowerCase()); return c ? { id: c.id, name: c.name, matched: true } : { id: 'cat-watch', name: 'Watch', matched: false }; };
const impOpts = { resolveCategory: katVon, defaultVatScheme: 'VAT_10' as const, existingIndex: imp.buildExistingIndex([]) };
const zeile = (extra: Record<string, string | number>) => imp.classifyRows([{ Category: 'Gold-Diamond Jewellery', 'Item Type': 'Ring', Weight: 5, Cost: 100, ...extra }], impOpts)[0];
{
  const r = zeile({ 'Karat & Color': 'Platinum' });
  ok(r.status === 'new' && r.attributes.karat === 'Platinum' && !r.notes && !r.warnings.length, `IMPORT „Platinum": angelegt ohne Warnung (${S({ s: r.status, w: r.warnings, n: r.notes })})`);
  for (const roh of ['Platinum 950', 'Platinum 999', 'PT950']) {
    const z = zeile({ 'Karat & Color': roh });
    ok(z.status === 'warning' && z.attributes.karat === 'Platinum' && (z.notes || '').includes(`Karat & Color: ${roh}`)
      && z.warnings.some((w) => w.includes('Platinum') && w.includes('kept in notes')),
      `IMPORT „${roh}": Platinum, Feinheit wörtlich in der Notiz, Zeile warnt (${S({ s: z.status, w: z.warnings, n: z.notes })})`);
  }
  const zwei = zeile({ Karat: 950, Metal: 'Platinum' });
  ok(zwei.attributes.karat === 'Platinum' && (zwei.notes || '').includes('Karat: 950') && (zwei.notes || '').includes('Metal: Platinum') && zwei.status === 'warning',
    `IMPORT alte Spalten Karat 950 + Metal Platinum: Platinum, beide Spalten in der Notiz (${S({ n: zwei.notes, w: zwei.warnings })})`);
  const nur = zeile({ Metal: 'Platinum' });
  ok(nur.attributes.karat === 'Platinum' && !(nur.notes || '').includes('Metal') && nur.status === 'new', `IMPORT nur Metal Platinum: Platinum, nichts verloren (${S({ n: nur.notes, w: nur.warnings })})`);
  const misch = zeile({ Karat: 18, Metal: 'Platinum' });
  ok(!misch.attributes.karat && (misch.notes || '').includes('Karat: 18') && (misch.notes || '').includes('Metal: Platinum')
    && misch.warnings.some((w) => w.includes('not recognised')), `IMPORT Karat 18 + Metal Platinum: nicht geraten, beides in der Notiz (${S({ n: misch.notes, w: misch.warnings })})`);
  const gold = zeile({ 'Karat & Color': '18K Yellow' });
  ok(gold.status === 'new' && gold.attributes.karat === '18K Yellow' && !gold.notes, 'IMPORT eine Goldzeile bleibt wie bisher');
  const alt = zeile({ Karat: 999 });
  ok(alt.attributes.karat === '24K Yellow', 'IMPORT Karat 999 ohne Platin bleibt 24K Yellow (Feingold)');
}
ok(/Platinum, Platinum 950, Platinum 999 or PT950 become Platinum/.test(src('src/core/import/product-import.ts')), 'IMPORT die Vorlage erklärt Platinum und die Notiz');

// ── 7 KI ────────────────────────────────────────────────────────────────────
const vertrag = JSON.parse(src('src/core/ai/identify-contract.json'));
for (const id of JEWELLERY) {
  const n = String(vertrag.categories[id].notes);
  ok(n.includes(`{${NEU.join(', ')}}`) && /Platinum for platinum/.test(n) && /no 950\/999/.test(n), `KI ${id}: Auswahl mit Platinum, eine Angabe ohne 950/999`);
  ok(prompt.buildSystemPrompt(id).includes('14K Mix, Silver, Platinum}'), `KI ${id}: der Prompt (Rechner und Primary lesen dieselbe Datei) nennt Platinum`);
}
ok(!String(vertrag.categories['cat-watch'].notes).includes('Silver, Platinum}'), 'KI Uhr unverändert');
{
  // Der Wert selbst bewegt sich mit jeder bewussten Vertragsänderung (zuletzt PENDANT); geprüft wird, dass beide Seiten denselben erwarten.
  const rust = /EXPECTED_FINGERPRINT: &str = "([0-9a-f]{16})"/.exec(src('src-tauri/src/sync/ai_identify_tests.rs'))?.[1];
  const ts = /const EXPECTED_FINGERPRINT = '([0-9a-f]{16})'/.exec(src('test/ai/identify-contract-parity.test.ts'))?.[1];
  ok(!!rust && rust === ts && rust !== 'ba9af9c515fa5ce1', `KI Rust und TypeScript erwarten denselben neuen Fingerabdruck (${rust} / ${ts})`);
}

// ── 8 Anzeige, Rechnung, Etikett ────────────────────────────────────────────
ok(dn.karatText('Platinum') === 'Platinum', 'ANZEIGE „Platinum" bleibt „Platinum" (nie „Platinum Gold")');
const goldRing = { categoryId: GOLD, attributes: { item_type: 'Ring', karat: 'Platinum', weight: 5 } };
ok(dn.productDisplayName(goldRing as never) === 'Ring · Platinum · 5 g', `ANZEIGE Name „${dn.productDisplayName(goldRing as never)}"`);
ok(js.displayName(goldRing) === dn.productDisplayName(goldRing as never), 'ANZEIGE Telefon zeigt denselben Namen');
const branded = { categoryId: BRANDED, brand: 'Cartier', name: 'Love', attributes: { item_type: 'Bracelet', karat: 'Platinum', weight: 6.2, size: '17' } };
const det = a5.lineDetails(branded as never);
ok(det.includes('Platinum') && !det.some((d) => /platinum gold/i.test(d)), `RECHNUNG A5 zeigt „Platinum" (${S(det)})`);
const detGold = a5.lineDetails(goldRing as never);
ok(!detGold.some((d) => /platinum/i.test(d)), `RECHNUNG A5 Gold-Diamond: Platinum steht schon im Namen, nicht doppelt (${S(detGold)})`);
for (const typ of ['Bracelet', 'Necklace', 'Earrings', 'Ring']) {
  const face = zpl.buildProductFace({ sku: 'GJ-1', plannedSalePrice: 900, attributes: { item_type: typ, karat: 'Platinum', weight: 5 } } as never, catOf(GOLD) as never);
  const zeileTag = (face.scan?.details || []).find((d: string) => d.includes('PLATINUM')) || '';
  ok(zeileTag === `${typ.toUpperCase()} PLATINUM` && zeileTag.length <= 17, `ETIKETT Gold-Diamond „${zeileTag}" passt ungekürzt`);
}
const faceB = zpl.buildProductFace({ sku: 'BJ-1', plannedSalePrice: 900, attributes: { item_type: 'Ring', karat: 'Platinum', size: '52' } } as never, catOf(BRANDED) as never);
ok((faceB.scan?.details || []).includes('52 / PLATINUM'), `ETIKETT Branded „52 / PLATINUM" (${S(faceB.scan?.details)})`);

// ── 9 Gold-Karate und Reinheit unverändert — Platinum ist nie Gold ─────────────
ok(S(Object.keys(purity.KARAT_PURITY)) === S(['24K', '22K', '21K', '18K', '14K', '9K']) && S(purity.METAL_GRADES.platinum) === S(['950', '999'])
  && purity.metalPurity('platinum', '950') === 0.95 && purity.metalPurity('platinum', '999') === 0.999, 'GOLD Reinheitstabellen unverändert');
ok(purity.goldPurity('Platinum') === null && purity.metalPurity('gold', 'Platinum') === null, 'GOLD „Platinum" hat keine Gold-Reinheit');
let wurf = '';
try { purity.purityOf('Platinum'); } catch (e) { wurf = String((e as Error).message); }
ok(/not a gold karat/.test(wurf), 'GOLD purityOf(„Platinum") wirft — nie still 1,0');
ok(!settle.isKnownKarat('Platinum') && !settle.isKnownKarat('950'), 'GOLD Platinum/950 sind kein Gold-Karat');
let code = '';
try { settle.assertKnownKarat('Platinum'); } catch (e) { code = String((e as { code?: string }).code); }
ok(code === 'GOLD_KARAT_UNKNOWN', `GOLD Ausgleich/Bestand/Schuld lehnen Platinum ab (${code})`);
ok(settle.isKnownKarat('21K') && settle.isKnownKarat('24K'), 'GOLD echte Gold-Karate gelten weiter');
ok(S(bulk.BULK_METALS) === S(['gold', 'silver', 'platinum']) && /METAL_TYPES: readonly MetalType\[\] = \['gold', 'silver', 'platinum'\]/.test(src('src/core/metals/metal-house.ts')),
  'GOLD Bulk Metal und Precious Metals unverändert');

console.log(`\nplatinum-jewellery: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
