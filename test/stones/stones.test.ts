// ════════════════════════════════════════════════════════════════════════════
// STONES — die EINE Steinliste für Gold-Diamond Jewellery: Regeln, Diamond Weight, Altbestand,
// Parität Rechner/Telefon/Rust, Anzeige, Suche, KI, Migration, Reparatur.
// Run: node test/stones/stones.test.ts
// ════════════════════════════════════════════════════════════════════════════
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

const st = await import('../../src/core/products/stones.ts');
const fc = await import('../../src/core/products/field-contract.ts');
const pc = await import('../../src/core/products/product-create.ts');
const pf = await import('../../src/core/utils/product-format.ts');
const dn = await import('../../src/core/products/display-name.ts');
const em = await import('../../src/core/ai/edit-merge.ts');
const lookup = await import('../../src/core/utils/category-lookup.ts');
const { DEFAULT_CATEGORIES } = await import('../../src/core/models/default-categories.ts');
const { REPAIR_FIELDS } = await import('../../src/core/models/repair-fields.ts');
const rr = await import('../../src/core/repairs/repair-rules.ts');
const mfs = await import('../../src/core/mobile/mobile-field-schema.ts');
const { migrateCategoryStonesV1 } = await import('../../src/core/db/category-stones-migration.ts');
const box: Record<string, unknown> = {};
new Function('self', src('src-tauri/src/sync/mobile_stones.js'))(box);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const js = box.MobileStones as any;
lookup.registerCategoryLookup((id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id) as never);
const GOLD = 'cat-gold-jewelry';
const codes = (raw: unknown) => st.parseStones(raw).issues.map((i) => i.code);

// ── 1 die Regeln ──
ok(S(st.parseStones(undefined)) === S({ rows: [], issues: [] }) && S(st.parseStones([])) === S({ rows: [], issues: [] }), 'REGEL keine Steine ist gültig');
const eine = st.parseStones([{ type: 'diamond', qty: 1, carat: 0.5, color: 'G', clarity: 'VS1', shape: 'oval' }]);
ok(!eine.issues.length && S(eine.rows) === S([{ type: 'diamond', qty: 1, carat: 0.5, color: 'G', clarity: 'VS1', shape: 'oval' }]), 'REGEL eine Diamant-Zeile mit Farbe/Reinheit/Form');
const viele = [
  { type: 'diamond', qty: 1, carat: '0.50', color: 'G', clarity: 'VS1', shape: 'oval' },
  { type: 'diamond', qty: '20', carat: 0.3, color: 'G', clarity: 'VS', shape: 'round' },
  { type: 'emerald', qty: 3, carat: '0,45' },
  { type: 'sapphire', qty: 2 },
];
const pv = st.parseStones(viele);
ok(!pv.issues.length && pv.rows.length === 4 && pv.rows[0].carat === 0.5 && pv.rows[1].qty === 20 && pv.rows[2].carat === 0.45 && pv.rows[3].carat === undefined,
  `REGEL mehrere Diamant-Zeilen + Smaragd + Saphir, Reihenfolge bleibt, nichts zusammengelegt (${S(pv.rows)})`);
ok(st.parseStones([{ type: 'other', qty: 2, name: ' Spinel ' }]).rows[0]?.name === 'Spinel', 'REGEL Other mit Namen');
ok(S(codes([{ type: 'other', qty: 2 }])) === S(['STONE_NAME_REQUIRED']), 'REGEL Other ohne Namen → abgelehnt');
ok(codes([{ type: 'diamond', qty: 0 }])[0] === 'STONE_QTY_INVALID' && codes([{ type: 'diamond', qty: 1.5 }])[0] === 'STONE_QTY_INVALID'
  && codes([{ type: 'diamond', qty: 'x' }])[0] === 'STONE_QTY_INVALID' && codes([{ type: 'diamond' }])[0] === 'STONE_QTY_INVALID', 'REGEL Menge ganz und ≥ 1');
ok(!codes([{ type: 'ruby', qty: 1, carat: '' }]).length, 'REGEL Gesamt-Karat darf leer sein');
ok(codes([{ type: 'ruby', qty: 1, carat: 0.1234 }])[0] === 'STONE_CARAT_INVALID' && codes([{ type: 'ruby', qty: 1, carat: -1 }])[0] === 'STONE_CARAT_INVALID'
  && codes([{ type: 'ruby', qty: 1, carat: 0 }])[0] === 'STONE_CARAT_INVALID', 'REGEL Karat > 0, höchstens drei Nachkommastellen');
ok(S(codes([{ type: 'emerald', qty: 1, color: 'G' }])) === S(['STONE_DIAMOND_ONLY']) && S(codes([{ type: 'emerald', qty: 1, shape: 'oval' }])) === S(['STONE_DIAMOND_ONLY']),
  'REGEL Nicht-Diamant ohne versteckte Diamant-Felder');
ok(codes([{ type: 'ruby', qty: 1, name: 'x' }])[0] === 'STONE_NAME_ONLY_OTHER' && codes([{ type: 'diamond', qty: 1, size_mm: 3 }])[0] === 'STONE_FIELD_UNKNOWN'
  && codes([{ type: 'Diamond', qty: 1 }])[0] === 'STONE_TYPE_INVALID' && codes([{ type: 'diamond', qty: 1, color: 'Z9' }])[0] === 'STONE_COLOR_INVALID',
  'REGEL Name nur bei Other, kein Größenfeld, kanonische Schlüssel, feste Listen');
ok(st.parseStones([{ type: '', qty: '', carat: '' }, { type: 'pearl', qty: 12 }]).rows.length === 1, 'REGEL leere Zeilen werden nicht gespeichert');
ok(codes(Array.from({ length: 51 }, () => ({ type: 'pearl', qty: 1 })))[0] === 'STONES_TOO_MANY', 'REGEL höchstens 50 Zeilen');

// ── 2 Diamond Weight: Summe ohne Float-Fehler, Altbestand bleibt ──
ok(st.diamondCaratThousandths(pv.rows) === 800 && st.fmtCarat(800) === '0.80', 'SUMME 0.50 + 0.30 = 0.80 ct');
ok(st.diamondCaratThousandths(st.parseStones([{ type: 'diamond', qty: 1, carat: 0.1 }, { type: 'diamond', qty: 1, carat: 0.2 }]).rows) === 300, 'SUMME 0.1 + 0.2 = 0.300 (kein Float-Fehler)');
const neu = st.normalizeStoneAttributes(GOLD, { weight: 5.2, stones: viele });
ok(!neu.issues.length && neu.attributes.diamond_weight === 0.8 && Array.isArray(neu.attributes.stones), 'SUMME Diamond Weight = Summe der Diamant-Zeilen');
const alt = st.normalizeStoneAttributes(GOLD, { weight: 3, diamond_weight: 0.6 });
ok(alt.attributes.diamond_weight === 0.6 && !('stones' in alt.attributes), 'ALTBESTAND ohne Steinliste: Diamond Weight bleibt, keine Zeile erfunden');
const altPlus = st.normalizeStoneAttributes(GOLD, { diamond_weight: 0.6, stones: [{ type: 'emerald', qty: 1 }] }, { diamond_weight: 0.6 });
ok(altPlus.attributes.diamond_weight === 0.6, 'ALTBESTAND Steinliste ohne Diamant-Karat: der alte Wert bleibt');
const ersetzt = st.normalizeStoneAttributes(GOLD, { diamond_weight: 0.6, stones: [{ type: 'diamond', qty: 2, carat: 0.25 }] }, { diamond_weight: 0.6 });
ok(ersetzt.attributes.diamond_weight === 0.25, 'ALTBESTAND Diamant-Zeilen mit Karat ersetzen den alten Wert');
const weg = st.normalizeStoneAttributes(GOLD, { diamond_weight: 0.8, stones: [{ type: 'emerald', qty: 3 }] }, { diamond_weight: 0.8, stones: pv.rows });
ok(!('diamond_weight' in weg.attributes), 'ABGELEITET fallen die Diamant-Zeilen weg, fällt auch die abgeleitete Summe weg');
ok(!('stones' in st.normalizeStoneAttributes(GOLD, { stones: [] }).attributes), 'LEER eine leere Liste wird nicht gespeichert');
ok(st.normalizeStoneAttributes('cat-watch', { stones: [{ type: 'diamond', qty: 1 }] }).issues[0]?.code === 'STONES_NOT_FOR_CATEGORY'
  && st.normalizeStoneAttributes('cat-branded-gold-jewelry', { stones: pv.rows }).issues.length === 1, 'KATEGORIE nur Gold-Diamond Jewellery hat eine Steinliste');
ok(S(st.diamondWeightInfo({ diamond_weight: 0.6 })) === S({ thousandths: 600, source: 'legacy' })
  && S(st.diamondWeightInfo({ stones: pv.rows, diamond_weight: 0.8 })) === S({ thousandths: 800, source: 'stones' }), 'ANZEIGE woher Diamond Weight kommt');
let wurf = '';
try { st.stonesOrThrow(GOLD, { stones: [{ type: 'other', qty: 1 }] }); } catch (e) { wurf = (e as { code?: string }).code ?? ''; }
ok(wurf === 'STONES_INVALID', 'SCHREIBSTELLE eine ungültige Liste wird nie geschrieben');

// ── 3 Anzeige und Suche ──
ok(st.stonesSummary(pv.rows) === 'Diamond 0.80 ct · Emerald 0.45 ct · Sapphire ×2', `ANZEIGE Kurzform (${st.stonesSummary(pv.rows)})`);
ok(st.stoneRowLabel(pv.rows[0]) === 'Diamond · Qty 1 · 0.50 ct · G · VS1 · Oval' && st.stonesSectionSummary(pv.rows).startsWith('4 rows · Diamond 0.80 ct'), 'ANZEIGE Zeile und Abschnitt');
const ring = { id: 'p', categoryId: GOLD, brand: '', name: '', attributes: { item_type: 'Ring', karat: '18K White', weight: 3.1, description: 'CLUSTER', stones: pv.rows, diamond_weight: 0.8 } };
const such = pf.productAttributeSearchValues(ring as never).join(' ');
ok(/Diamond/.test(such) && /Emerald/.test(such) && /VS1/.test(such) && /Oval/.test(such) && !/object/.test(such), `SUCHE Steinarten und Merkmale (${such.slice(0, 80)})`);
ok(pf.productAttributeSearchValues({ ...ring, attributes: { stones: [{ type: 'other', qty: 1, name: 'Spinel' }] } } as never).join(' ').includes('Spinel'), 'SUCHE Other-Name');
const spec = pf.getProductSpecs(ring as never, DEFAULT_CATEGORIES as never);
ok(spec.some((x) => x.label === 'Stones' && x.value === 'Diamond 0.80 ct · Emerald 0.45 ct · Sapphire ×2') && spec.some((x) => x.label === 'Diamond Weight' && x.value === '0.80 ct'),
  `DOKUMENTE Specs mit Steinen und Diamond Weight (${S(spec.map((x) => x.label + '=' + x.value))})`);
ok(dn.productDisplayName(ring as never) === 'Ring · Cluster · 18K White · 3.10 g', 'NAME Steine stehen NICHT im Titel');

// ── 4 Prüfung der Masken (Rechner) und Anlage ──
const kat = DEFAULT_CATEGORIES.find((c) => c.id === GOLD)!;
const iss = fc.validateProductFields(kat as never, { categoryId: GOLD, attributes: { weight: 1, item_type: 'Ring', karat: '18K White', stones: [{ type: 'other', qty: 1 }] } });
ok(iss.some((i) => i.code === 'STONES_INVALID' && i.blocking && /stone name/.test(i.message || '')), 'MASKE eine falsche Steinzeile blockiert mit Satz');
ok(!fc.validateProductFields(kat as never, { categoryId: GOLD, attributes: { weight: 1, item_type: 'Ring', karat: '18K White' } }).length, 'MASKE Gold ohne Steine und ohne Marke/Modell ist gültig');
const plan = pc.planProductCreate({ categoryId: GOLD, attributes: { weight: 1, item_type: 'Ring', karat: '18K White', stones: viele } } as never,
  { category: kat as never, isSkuTaken: () => false, allocateSku: () => 'X-1' });
ok(plan.kind === 'ok' && (plan.data.attributes as Record<string, unknown>).diamond_weight === 0.8 && ((plan.data.attributes as Record<string, unknown>).stones as unknown[]).length === 4,
  'ANLAGE die Anlage speichert die normalisierte Liste und die Summe');
const nein = pc.planProductCreate({ categoryId: GOLD, attributes: { weight: 1, item_type: 'Ring', karat: '18K White', stones: [{ type: 'other', qty: 1 }] } } as never,
  { category: kat as never, isSkuTaken: () => false, allocateSku: () => 'X-1' });
ok(nein.kind === 'invalid' && pc.productCreateRefusal(nein as never).code === 'STONES_INVALID', 'ANLAGE eine falsche Liste → STONES_INVALID');
ok(S(fc.editableAttributes(kat as never, {}).map((a) => a.key)) === S(['weight', 'stones', 'item_type', 'karat', 'description']),
  'MASKE Diamond Weight ist bei Gold kein eigenes Eingabefeld');
ok(fc.editableAttributes(DEFAULT_CATEGORIES.find((c) => c.id === 'cat-branded-gold-jewelry') as never, {}).some((a) => a.key === 'diamond_weight'), 'MASKE Branded Gold behält Diamond Weight');

// ── 5 KI ──
const ki = st.stonesFromAi([
  { type: 'Diamond', qty: 20, carat: 0.8, color: 'g', clarity: 'vs1', shape: 'Round' },
  { type: 'emerald', qty: 3, carat: 0.45 },
  { type: 'spinel', qty: 2 },
  { type: 'diamond', carat: 0.5 },              // ohne Stückzahl — nichts erfinden
  { type: 'ruby', qty: 1, color: 'D' },          // Farbe gehört nur zum Diamanten — sie fällt weg, die Zeile bleibt
]);
ok(S(ki) === S([{ type: 'diamond', qty: 20, carat: 0.8, color: 'G', clarity: 'VS1', shape: 'round' }, { type: 'emerald', qty: 3, carat: 0.45 }, { type: 'other', qty: 2, name: 'spinel' }, { type: 'ruby', qty: 1 }]),
  `KI nur Zeilen, die die Prüfung bestehen; nichts erfunden (${S(ki)})`);
ok(st.stonesFromAi('[{"type":"pearl","qty":12}]').length === 1 && st.stonesFromAi('kaputt').length === 0, 'KI die Liste kommt vom Primary als JSON-Text');
const kiRes = dn.aiResultForCategory({ brand: 'Ring', attributes: { diamond_weight: 0.9, stones: '[{"type":"diamond","qty":2,"carat":0.4}]', karat: '18K White' } }, GOLD);
ok(!('diamond_weight' in kiRes.attributes!) && S(kiRes.attributes!.stones) === S([{ type: 'diamond', qty: 2, carat: 0.4 }]) && kiRes.attributes!.item_type === 'Ring',
  'KI Gold: Diamond Weight nie von der KI, Steinliste geprüft, keine Marke');
const manuell = [{ type: 'ruby', qty: '1' }];
ok(S(st.mergeAiAttributes({ stones: manuell, karat: '' }, { stones: [{ type: 'diamond', qty: 1 }], karat: '18K White' })) === S({ stones: manuell, karat: '18K White' }),
  'KI eine schon erfasste Steinliste wird nicht überschrieben (Neuanlage)');
ok(!('stones' in em.buildAiAttributePatch({ attributes: { stones: [{ type: 'diamond', qty: 1 }] } } as never, ['stones'], { stones: manuell })), 'KI … und beim Bearbeiten');
const vertrag = JSON.parse(src('src/core/ai/identify-contract.json')).categories[GOLD];
ok(vertrag.optional.includes('stones') && !vertrag.optional.includes('diamond_weight') && /NEVER guess carat, color, clarity or shape/.test(vertrag.notes),
  'KI-Vorgabe Steinliste statt Diamond Weight, keine geratenen Werte');

// ── 6 Parität Telefon + Rust ──
const faelle: unknown[] = [undefined, [], viele, [{ type: 'other', qty: 2 }], [{ type: 'emerald', qty: 1, color: 'G' }], [{ type: 'diamond', qty: 1, carat: 0.1234 }],
  [{ type: '', qty: '' }, { type: 'pearl', qty: '12' }], [{ type: 'ruby', qty: 1, name: 'x' }], 'x', [{ type: 'diamond', qty: 1, size_mm: 1 }]];
for (const f of faelle) {
  ok(S(js.parseStones(f)) === S(st.parseStones(f)), `PARITÄT Telefon parseStones ${S(f)?.slice(0, 60)}`);
}
ok(js.stonesSummary(pv.rows) === st.stonesSummary(pv.rows) && js.stoneRowLabel(pv.rows[0]) === st.stoneRowLabel(pv.rows[0])
  && js.stonesSectionSummary(pv.rows) === st.stonesSectionSummary(pv.rows) && js.fmtCarat(5) === st.fmtCarat(5)
  && S(js.diamondWeightInfo({ diamond_weight: 0.6 })) === S(st.diamondWeightInfo({ diamond_weight: 0.6 }))
  && S(js.stonesFromAi([{ type: 'Diamond', qty: 1, color: 'g' }])) === S(st.stonesFromAi([{ type: 'Diamond', qty: 1, color: 'g' }]))
  && js.stonesSearchText(pv.rows) === st.stonesSearchText(pv.rows), 'PARITÄT Telefon Anzeige, Summe, KI, Suche');
ok(S(js.STONE_TYPES) === S(st.STONE_TYPES) && S(js.DIAMOND_COLORS) === S(st.DIAMOND_COLORS) && S(js.DIAMOND_CLARITIES) === S(st.DIAMOND_CLARITIES)
  && S(js.DIAMOND_SHAPES) === S(st.DIAMOND_SHAPES) && S(js.STONE_CATEGORIES) === S(st.STONE_CATEGORIES), 'PARITÄT Telefon dieselben Listen');
const rs = src('src-tauri/src/sync/mobile_field_schema.rs');
const rsList = (name: string) => JSON.parse('[' + (new RegExp('const ' + name + ': &\\[&str\\] = &\\[([\\s\\S]*?)\\];').exec(rs)?.[1] ?? '').trim().replace(/,\s*$/, '') + ']');
ok(S(rsList('STONE_TYPES')) === S(st.STONE_TYPES.map((o) => o.key)) && S(rsList('DIAMOND_COLORS')) === S(st.DIAMOND_COLORS.map((o) => o.key))
  && S(rsList('DIAMOND_CLARITIES')) === S(st.DIAMOND_CLARITIES.map((o) => o.key)) && S(rsList('DIAMOND_SHAPES')) === S(st.DIAMOND_SHAPES.map((o) => o.key)),
  'PARITÄT Rust (Handy-Upload) dieselben kanonischen Listen');

// ── 7 Handy-Schema und Handy-Prüfung (TS-Zwilling der Rust-Prüfung) ──
const schema = JSON.parse(src('src-tauri/src/sync/mobile_field_schema.json'));
const goldSchema = schema.categories.find((c: { id: string }) => c.id === GOLD);
ok(goldSchema.attributes.some((a: { key: string; type: string }) => a.key === 'stones' && a.type === 'stones')
  && schema.categories.filter((c: { attributes: Array<{ type: string }> }) => c.attributes.some((a) => a.type === 'stones')).length === 1, 'SCHEMA die Steinliste nur bei Gold-Diamond Jewellery');
const mErr = mfs.validateMobileMetadata({ categoryId: GOLD, attributes: { weight: 1, item_type: 'Ring', karat: '18K White', stones: [{ type: 'other', qty: 1 }] } }, schema as never);
ok(Array.isArray(mErr) && mErr.some((e: { code: string }) => e.code === 'STONE_NAME_REQUIRED'), `HANDY-UPLOAD dieselbe Prüfung (${S(mErr).slice(0, 120)})`);

// ── 8 Migration: idempotent, Produktdaten unberührt ──
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs();
const db = new SQL.Database();
db.run('CREATE TABLE categories (id TEXT PRIMARY KEY, attributes TEXT, updated_at TEXT)');
db.run('CREATE TABLE products (id TEXT PRIMARY KEY, attributes TEXT)');
const altKat = kat.attributes.filter((a) => a.key !== 'stones');
db.run('INSERT INTO categories VALUES (?, ?, ?)', [GOLD, JSON.stringify(altKat), 'x']);
db.run('INSERT INTO products VALUES (?, ?)', ['p1', JSON.stringify({ diamond_weight: 0.6, weight: 3 })]);
migrateCategoryStonesV1(db as never);
const nach = JSON.parse(String(db.exec(`SELECT attributes FROM categories WHERE id = '${GOLD}'`)[0].values[0][0]));
ok(S(nach.map((a: { key: string }) => a.key)) === S(kat.attributes.map((a) => a.key)), `MIGRATION die Steinliste steht direkt nach Diamond Weight (${S(nach.map((a: { key: string }) => a.key))})`);
migrateCategoryStonesV1(db as never);
const zweimal = JSON.parse(String(db.exec(`SELECT attributes FROM categories WHERE id = '${GOLD}'`)[0].values[0][0]));
ok(zweimal.filter((a: { key: string }) => a.key === 'stones').length === 1, 'MIGRATION idempotent');
ok(String(db.exec("SELECT attributes FROM products WHERE id = 'p1'")[0].values[0][0]) === JSON.stringify({ diamond_weight: 0.6, weight: 3 }), 'MIGRATION Produktdaten unberührt');
ok(/migrateCategoryStonesV1\(db\);/.test(src('src/core/db/database.ts')) && (src('src/core/db/database.ts').match(/migrateCategoryStonesV1\(db\);/g) || []).length === 3,
  'MIGRATION läuft bei Upgrade, Neuanlage und Browser-Neuanlage');

// ── 9 Reparatur ──
const rep = REPAIR_FIELDS[GOLD];
ok(rep.some((f) => f.key === 'stones' && f.type === 'stones') && !rep.some((f) => (f.coreField === 'itemBrand' || f.coreField === 'itemModel') && f.required)
  && ['src/pages/repairs/RepairList.tsx', 'src/pages/repairs/RepairDetail.tsx'].every((p) => src(p).includes("field.coreField === 'itemModel') && brandModelHidden(form.itemCategoryId)")),
  'REPARATUR Gold: Steinliste, Marke/Modell weder verlangt noch gezeigt');
ok(rr.missingRepairItemFields({ itemCategoryId: GOLD, itemAttributes: { item_type: 'Ring' } }).length === 0, 'REPARATUR die Steinliste ist nie Pflicht');
ok(dn.repairItemDisplayName({ itemCategoryId: GOLD, itemAttributes: { item_type: 'Ring', description: 'SOLITAIRE', karat: '18K White', weight: 2 } }) === 'Ring · Solitaire · 18K White · 2 g'
  && dn.repairItemDisplayName({ itemBrand: 'Rolex', itemModel: 'Datejust' }) === 'Rolex Datejust', 'REPARATUR zentraler Anzeigename');
ok(/normalizeStoneAttributes\(input\.itemCategoryId/.test(src('src/core/repairs/repair-rules.ts')) && /stonesOrThrow\(/.test(src('src/stores/repairStore.ts')),
  'REPARATUR dieselbe Prüfung am Eingang und an der Schreibstelle');

// ── 10 die Schreibstellen und Masken nutzen die EINE Liste ──
ok(/stonesOrThrow\(data\.categoryId/.test(src('src/stores/productStore.ts')) && /stonesOrThrow\(kat, data\.attributes/.test(src('src/stores/productStore.ts')),
  'SCHREIBSTELLE Anlegen und Ändern normalisieren');
for (const f of ['src/components/products/NewProductModal.tsx', 'src/pages/watches/WatchList.tsx', 'src/pages/watches/ProductDetail.tsx',
  'src/pages/consignments/ConsignmentList.tsx', 'src/pages/repairs/RepairList.tsx', 'src/pages/repairs/RepairDetail.tsx']) {
  ok(/<StonesEditor /.test(src(f)), `RECHNER ${f.split('/').pop()} nutzt die EINE Steinliste`);
}
const seite = src('src-tauri/src/sync/mobile_page.rs');
ok(seite.indexOf('include_str!("mobile_stones.js")') > 0 && /if \(a\.type === 'stones'\) return makeStonesControl/.test(seite) && /function editableAttrs\(cat\)/.test(seite),
  'TELEFON die Steinliste in den gemeinsamen Feld-Bausteinen (Collection, Bearbeiten, Kommission, Einkauf)');
ok(/stonesOf\(v\)/.test(src('src-tauri/src/sync/mobile_consignment_ui.js')) && /stonesOf\(keep\.stones\)/.test(src('src-tauri/src/sync/mobile_purchase_ui.js')),
  'TELEFON Kommission und Einkauf prüfen/normalisieren mit derselben Regel');

// ── ANZEIGE — feste Beschriftung Qty / Total ct, Karte mit Einheiten ─────────────────────────
const goldKat = DEFAULT_CATEGORIES.find((c) => c.id === GOLD) as never;
ok(pf.cardAttributeText(goldKat, { weight: 6.4, diamond_weight: 0.8, item_type: 'Ring', karat: '18K Yellow', stones: [{ type: 'diamond', qty: 12, carat: 0.8 }] })
  === '6.40 g · 0.80 ct · Ring · 18K Yellow', 'KARTE „6.40 g · 0.80 ct · Ring · 18K Yellow" statt „6.4 · 0.8 · Ring · 18K Yellow"');
ok(pf.cardAttributeText(goldKat, { weight: 5, diamond_weight: '1.2', item_type: 'Bangle', karat: '21K Yellow' }) === '5 g · 1.20 ct · Bangle · 21K Yellow',
  'KARTE ganzes Gewicht „5 g", alter Text-Wert Diamond Weight „1.20 ct"');
ok(pf.cardAttributeText(goldKat, { weight: 3.1, diamond_weight: 0, item_type: 'Ring', karat: '' }) === '3.10 g · Ring', 'KARTE leere Werte und 0 fallen weg (wie bisher)');
ok(pf.cardAttributeText(DEFAULT_CATEGORIES.find((c) => c.id === 'cat-watch') as never, { case_diameter_mm: 40 }).includes('40 mm'), 'KARTE andere Zahlen mit Einheit (40 mm)');
ok(/cardAttributeText\(cat, p\.attributes/.test(src('src/pages/watches/WatchList.tsx')), 'KARTE die Collection nutzt die eine Kartenzeile');
const editor = src('src/components/products/StonesEditor.tsx');
ok(/<span style=\{beschriftung\}>Qty<\/span>/.test(editor) && /<span style=\{beschriftung\}>Total ct<\/span>/.test(editor), 'RECHNER feste Beschriftung über Qty und Total ct');
ok(/<div class="stone-f"><span>Qty<\/span>/.test(seite) && /<div class="stone-f"><span>Total ct<\/span>/.test(seite) && /\.stone-f span \{/.test(seite),
  'TELEFON feste Beschriftung über Qty und Total ct');
ok(!/Total ct \(optional\)/.test(seite) && /placeholder="Total ct"/.test(seite), 'TELEFON Platzhalter nur „Total ct" (wird bei 360 px nicht abgeschnitten)');

// ── EXCEL-IMPORT — dieselbe Steinregel, alte Dateien bleiben lesbar, Vorlage → Import ────────────
const imp = await import('../../src/core/import/product-import.ts');
const XLSX = await import('xlsx');
const katVon = (n: string) => {
  const c = DEFAULT_CATEGORIES.find((k) => k.name.toLowerCase() === n.toLowerCase());
  return c ? { id: c.id, name: c.name, matched: true } : { id: 'cat-watch', name: 'Watch', matched: false };
};
const impOpts = { resolveCategory: katVon, defaultVatScheme: 'VAT_10' as const, existingIndex: imp.buildExistingIndex([]) };
const zeileImp = (extra: Record<string, string | number>, kat = 'Gold-Diamond Jewellery') =>
  imp.classifyRows([{ Category: kat, 'Description 1': 'Ring', Cost: 100, ...extra }], impOpts)[0];
const altDatei = zeileImp({ 'Diamond Weight': 1.2 });
ok(altDatei.status === 'new' && altDatei.stones.length === 0 && altDatei.diamondWeight === 1.2, `IMPORT alte Datei nur mit Diamond Weight: importierbar, keine erfundenen Steine (${S({ s: altDatei.status, st: altDatei.stones, dw: altDatei.diamondWeight })})`);
const einer = zeileImp({ 'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 12, 'Stone 1 Carat': 0.8, 'Stone 1 Color': 'g', 'Stone 1 Clarity': 'vs1', 'Stone 1 Shape': 'Round' });
ok(einer.status === 'new' && S(einer.stones) === S([{ type: 'diamond', qty: 12, carat: 0.8, color: 'G', clarity: 'VS1', shape: 'round' }]) && einer.diamondWeight === 0.8,
  `IMPORT eine Diamant-Zeile (Bezeichnungen groß/klein egal) → Diamond Weight 0.80 (${S(einer.stones)})`);
const mehrere = zeileImp({ 'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 1, 'Stone 1 Carat': '0.50', 'Stone 1 Shape': 'Oval', 'Stone 2 Type': 'diamond', 'Stone 2 Qty': '20', 'Stone 2 Carat': '0,30' });
ok(mehrere.status === 'new' && mehrere.stones.length === 2 && mehrere.diamondWeight === 0.8, `IMPORT mehrere Diamanten → Summe 0.80 ct (${S(mehrere.stones)})`);
const gemischt = zeileImp({
  'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 12, 'Stone 1 Carat': 0.8, 'Stone 1 Color': 'G', 'Stone 1 Clarity': 'VS1', 'Stone 1 Shape': 'Round',
  'Stone 2 Type': 'Emerald', 'Stone 2 Qty': 2, 'Stone 2 Carat': 0.45, 'Stone 3 Type': 'Other', 'Stone 3 Qty': 6, 'Stone 3 Name': 'Tsavorite',
});
// Dieselben Zeilen, wie die Rechner-Maske (StonesEditor) und das Telefon sie liefern: Schlüssel, Zahlen als Text.
const maske = [{ type: 'diamond', qty: '12', carat: '0.80', color: 'G', clarity: 'VS1', shape: 'round' }, { type: 'emerald', qty: '2', carat: '0.45' }, { type: 'other', name: 'Tsavorite', qty: '6' }];
const rechner = st.stonesOrThrow(GOLD, { stones: maske } as Record<string, unknown>);
const telefon = js.parseStones(maske);
ok(gemischt.status === 'new' && S(gemischt.stones) === S(rechner.stones) && S(gemischt.stones) === S(telefon.rows) && gemischt.diamondWeight === rechner.diamond_weight,
  `IMPORT Diamond + Emerald + Other → dieselben attributes.stones wie Rechner und Telefon (${S(gemischt.stones)})`);
const geschrieben = st.stonesOrThrow(GOLD, { stones: gemischt.stones, diamond_weight: gemischt.diamondWeight } as Record<string, unknown>);
ok(S(geschrieben.stones) === S(gemischt.stones) && geschrieben.diamond_weight === 0.8, 'IMPORT die Schreibstelle (createProduct) nimmt die Import-Zeilen unverändert an');
const ohneName = zeileImp({ 'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 1, 'Stone 3 Type': 'Other', 'Stone 3 Qty': 2 });
ok(ohneName.status === 'invalid' && ohneName.errors.some((e: string) => e === 'Stones — Stone 3: enter the stone name for "Other".'),
  `IMPORT Other ohne Namen → abgelehnt, Meldung nennt die Spaltengruppe (${S(ohneName.errors)})`);
for (const [feld, wert, text] of [
  ['Stone 1 Qty', '2.5', 'quantity must be a whole number'], ['Stone 1 Qty', 0, 'quantity must be a whole number'], ['Stone 1 Qty', '', 'quantity must be a whole number'],
  ['Stone 1 Carat', 'abc', 'total carat must be a positive number'], ['Stone 1 Carat', 1.2345, 'total carat must be a positive number'], ['Stone 1 Carat', '-1', 'total carat must be a positive number'],
] as Array<[string, string | number, string]>) {
  const r = zeileImp({ 'Stone 1 Type': 'Emerald', 'Stone 1 Qty': 3, [feld]: wert });
  ok(r.status === 'invalid' && r.errors.some((e: string) => e.includes('Stone 1: ' + text)), `IMPORT ${feld} = ${S(wert)} → sauber abgelehnt (${S(r.errors)})`);
}
const fremd = zeileImp({ 'Stone 1 Type': 'Spinel', 'Stone 1 Qty': 1 });
ok(fremd.status === 'invalid' && fremd.errors.some((e: string) => /unknown stone type "Spinel"/.test(e)), 'IMPORT unbekannte Steinart → abgelehnt (dafür gibt es Other + Name)');
const nurDiamant = zeileImp({ 'Stone 1 Type': 'Emerald', 'Stone 1 Qty': 1, 'Stone 1 Color': 'G' });
ok(nurDiamant.status === 'invalid' && nurDiamant.errors.some((e: string) => /color belongs only to diamonds/.test(e)), 'IMPORT Farbe nur bei Diamant');
const beides = zeileImp({ 'Diamond Weight': 2, 'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 1, 'Stone 1 Carat': 0.5 });
ok(beides.status === 'warning' && beides.diamondWeight === 0.5 && beides.warnings.some((w: string) => /replaced by the diamond rows \(0\.50 ct\)/.test(w)),
  `IMPORT alte Spalte + Diamant-Zeilen: die Summe der Zeilen gilt, mit Hinweis (${S(beides.warnings)})`);
const ohneKarat = zeileImp({ 'Diamond Weight': 1.1, 'Stone 1 Type': 'Emerald', 'Stone 1 Qty': 2 });
ok(ohneKarat.status === 'new' && ohneKarat.diamondWeight === 1.1 && ohneKarat.stones.length === 1, 'IMPORT Steine ohne Diamant-Karat: das alte Diamond Weight bleibt');
const uhr = zeileImp({ 'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 1 }, 'Watch');
ok(uhr.status === 'invalid' && uhr.errors.some((e: string) => /only recorded for Gold-Diamond Jewellery/.test(e)), 'IMPORT Steine bei einer Uhr → abgelehnt');
const altUhr = zeileImp({}, 'Watch');
ok(altUhr.status === 'new' && altUhr.stones.length === 0, 'IMPORT Zeilen ohne Steinspalten unverändert');
// Vorlage → echte .xlsx → derselbe Lesepfad wie die Import-Seite (sheet_to_json, defval '').
const vorlage = imp.importTemplate();
const mappe = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(mappe, XLSX.utils.aoa_to_sheet(vorlage.items), 'Items');
XLSX.utils.book_append_sheet(mappe, XLSX.utils.aoa_to_sheet(vorlage.help), 'How to');
const gelesen = XLSX.read(XLSX.write(mappe, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
const vRows = imp.classifyRows(XLSX.utils.sheet_to_json(gelesen.Sheets[gelesen.SheetNames[0]], { defval: '' }), impOpts);
ok(vRows.length === 4 && vRows.every((r: { status: string }) => r.status === 'new'), `VORLAGE alle Beispielzeilen importierbar (${S(vRows.map((r: { status: string; errors: string[] }) => [r.status, r.errors]))})`);
ok(S(vRows[1].stones) === S(rechner.stones) && vRows[1].diamondWeight === 0.8, 'VORLAGE Diamond + Emerald + Other wie am Rechner');
ok(vRows[2].stones.length === 2 && vRows[2].diamondWeight === 0.8 && vRows[3].stones.length === 0 && vRows[3].diamondWeight === 1.2,
  'VORLAGE mehrere Diamanten (Summe) und eine alte Zeile nur mit Diamond Weight');
ok(gelesen.SheetNames[1] === 'How to' && vorlage.help.some((z: string[]) => /Stone 4 Type/.test(z[0])) && vorlage.help.some((z: string[]) => /Cubic Zirconia/.test(z[0])),
  'VORLAGE Blatt „How to" erklärt mehrere Steine und die erlaubten Werte');
const importSeite = src('src/pages/settings/ImportPage.tsx');
ok(/if \(item\.stones\.length\) attrs\.stones = item\.stones;/.test(importSeite) && /data-import-template onClick=\{downloadTemplate\}/.test(importSeite) && /importTemplate\(\)/.test(importSeite),
  'IMPORT-SEITE legt die Steine an und bietet die Vorlage an');
ok(/stonesFromLabels, normalizeStoneAttributes/.test(src('src/core/import/product-import.ts')) && !/STONE_TYPES\.some|DIAMOND_COLORS\.some/.test(src('src/core/import/product-import.ts')),
  'IMPORT keine eigene Steinprüfung — nur die zentrale Regel');

console.log(`\nstones: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('STONES_PROVED');
