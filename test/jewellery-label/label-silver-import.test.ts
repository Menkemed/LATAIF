// ═════════════════════════════════════════════════════════════════
// JEWELLERY-LABEL & SILVER-IMPORT
//   A Original Gold Jewellery: das Etikett zeigt das Material (Platinum, Silver, 18K, 22K) — höchstens 4 Zeilen,
//     nichts gekürzt, nichts überlagert; alle anderen Etiketten byte-gleich zum Stand vor der Änderung (52aa4df).
//   B Excel: Silver / Silver 925 / Sterling / 925 → Silver, die Feinheit wörtlich in der Notiz (einmal), Mischwerte
//     nicht geraten; Platinum-Korrektur und Gold-Karate unverändert.
// Es wird NICHTS gedruckt: die Tests erzeugen nur den ZPL-Text.
// Run: node test/jewellery-label/label-silver-import.test.ts
// ═════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) { const p = resolvePath(repo, 'src', specifier.slice(2)); return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true }; }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const S = JSON.stringify;
let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

const { DEFAULT_CATEGORIES } = await import('../../src/core/models/default-categories.ts');
const zpl = await import('../../src/core/print/zpl-tag.ts');
const imp = await import('../../src/core/import/product-import.ts');

// Der Stand VOR dieser Änderung — zum Vergleich der unveränderten Etiketten.
const VORHER = '52aa4df';
const altQuelle = execFileSync('git', ['show', `${VORHER}:src/core/print/zpl-tag.ts`], { cwd: repo, encoding: 'utf8' });
const tmp = mkdtempSync(join(tmpdir(), 'lataif-zpl-before-'));
writeFileSync(join(tmp, 'zpl-tag-before.ts'), altQuelle);
const alt = await import(pathToFileURL(join(tmp, 'zpl-tag-before.ts')).href);
rmSync(tmp, { recursive: true, force: true });

const catOf = (id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id)!;
const ORIGINAL = catOf('cat-original-gold-jewelry');
const face = (attrs: Record<string, unknown>, scope: string[] = []) =>
  zpl.buildProductFace({ sku: 'OJ-0001', plannedSalePrice: 2500, scopeOfDelivery: scope, attributes: attrs } as never, ORIGINAL as never);
const det = (attrs: Record<string, unknown>, scope: string[] = []) => face(attrs, scope).scan?.details || [];

// ── A1 Material auf dem Original-Etikett ─────────────────────────────────────
const FAELLE: Array<[string, Record<string, unknown>, string[], string[]]> = [
  ['Platinum mit Größe', { item_type: 'Ring', karat: 'Platinum', size: '52' }, [], ['52 / PLATINUM']],
  ['Silver ohne Größe', { item_type: 'Ring', karat: 'Silver' }, [], ['SILVER']],
  ['18K Yellow', { item_type: 'Bangle', karat: '18K Yellow', size: '7' }, [], ['7 / 18K YG']],
  ['22K Yellow', { item_type: 'Bangle', karat: '22K Yellow' }, [], ['22K YG']],
  ['18K Mix', { item_type: 'Ring', karat: '18K Mix', size: '54' }, [], ['54 / 18K MIX']],
  ['alle Angaben', { item_type: 'Ring', karat: 'Platinum', size: '52', serial_number: 'ab123', model_number: 'crd4', year: 2019 }, ['Certificate'],
    ['SN AB123', 'REF CRD4', '52 / PLATINUM', 'CERTIFICATE 2019']],
  ['alle Angaben, Silver', { item_type: 'Ring', karat: 'Silver', size: 'M', serial_number: 'X1', model_number: 'Y2', year: 2001 }, ['Certificate'],
    ['SN X1', 'REF Y2', 'M / SILVER', 'CERTIFICATE 2001']],
  ['lange Größe, Platz für eigene Zeile', { item_type: 'Bracelet', karat: 'Platinum', size: '17.5 cm', serial_number: 'S9' }, ['Certificate'],
    ['SN S9', '17.5 CM', 'PLATINUM', 'CERTIFICATE']],
  ['volles Etikett, lange Größe: ohne Leerzeichen, nichts gekürzt', { item_type: 'Bracelet', karat: 'Platinum', size: '17.5 cm', serial_number: 'S9', model_number: 'R1', year: 2020 }, ['Certificate'],
    ['SN S9', 'REF R1', '17.5 CM/PLATINUM', 'CERTIFICATE 2020']],
  ['volles Etikett, Silver, 10 Zeichen Größe', { item_type: 'Bracelet', karat: 'Silver', size: 'ADJUSTABLE', serial_number: 'S1', model_number: 'R2', year: 2021 }, ['Certificate'],
    ['SN S1', 'REF R2', 'ADJUSTABLE/SILVER', 'CERTIFICATE 2021']],
  ['volles Etikett, 18K YG', { item_type: 'Ring', karat: '18K Yellow', size: '16-18 CM', serial_number: 'S2', model_number: 'R3' }, ['Certificate'],
    ['SN S2', 'REF R3', '16-18 CM / 18K YG', 'CERTIFICATE']],
  ['lange Größe ohne Kopf: eigene Zeilen', { item_type: 'Bangle', karat: '22K Yellow', size: '17.5 CM WIDE' }, ['Certificate'],
    ['17.5 CM WIDE', '22K YG', 'CERTIFICATE']],
];
for (const [was, attrs, scope, soll] of FAELLE) {
  const d = det(attrs, scope);
  ok(S(d) === S(soll), `ORIGINAL ${was}: ${S(d)} soll ${S(soll)}`);
}
const KURZ: Record<string, string> = { Platinum: 'PLATINUM', Silver: 'SILVER', '18K Yellow': '18K YG', '22K Yellow': '22K YG', '18K Mix': '18K MIX' };
const prod = (attrs: Record<string, unknown>, scope: string[] = []) => ({ sku: 'OJ-0001', plannedSalePrice: 2500, scopeOfDelivery: scope, attributes: attrs });
for (const [was, attrs, scope] of FAELLE) {
  const d = det(attrs, scope);
  const material = KURZ[String(attrs.karat)] || '';
  const size = attrs.size ? String(attrs.size).toUpperCase() : '';
  ok(d.length <= 4 && d.every((z) => z.length <= 17), `ORIGINAL ${was}: höchstens 4 Zeilen à 17 Zeichen`);
  if (material) ok(d.some((z) => z === material || z.endsWith(' / ' + material) || z.endsWith('/' + material)), `ORIGINAL ${was}: Material vollständig`);
  if (size) ok(d.some((z) => z === size || z.startsWith(size + ' / ') || z.startsWith(size + '/')), `ORIGINAL ${was}: Größe vollständig`);
  ok(zpl.tagProblem(prod(attrs, scope) as never, ORIGINAL as never) === null, `ORIGINAL ${was}: druckbar`);
}
// Ein Artikel ohne Karat: genau wie vorher.
for (const attrs of [{ item_type: 'Ring', size: '52', serial_number: 'A', model_number: 'B', year: 2019 }, { item_type: 'Ring' }, { item_type: 'Ring', size: 'SEVENTEEN CHARS 1' }]) {
  ok(S(face(attrs, ['Certificate'])) === S(alt.buildProductFace(prod(attrs, ['Certificate']), ORIGINAL)), `ORIGINAL ohne Karat unverändert ${S(attrs)}`);
}

// ── A1b volles Etikett, das auch kompakt nicht passt: Drucksperre mit Grund, nie gekürzt ─────────────────
const GESPERRT: Array<[string, Record<string, unknown>, string[], RegExp]> = [
  ['Platinum, Größe 9 Zeichen', { item_type: 'Bracelet', karat: 'Platinum', size: '17.5 CM W', serial_number: 'S9', model_number: 'R1', year: 2020 }, ['Certificate'], /at most 8 characters/],
  ['22K YG, Größe 12 Zeichen', { item_type: 'Bangle', karat: '22K Yellow', size: '17.5 CM WIDE', serial_number: 'S3', model_number: 'R4', year: 1999 }, ['Certificate'], /at most 10 characters/],
  ['Silver, Größe 18 Zeichen (auch allein zu lang)', { item_type: 'Ring', karat: 'Silver', size: 'ADJUSTABLE 16-19CM' }, [], /at most 17 characters/],
  ['ohne Karat, Größe 18 Zeichen', { item_type: 'Ring', size: 'A VERY LONG SIZE 1' }, [], /size "A VERY LONG SIZE 1" does not fit the tag completely — shorten the size on the item to at most 17 characters/],
];
for (const [was, attrs, scope, grund] of GESPERRT) {
  const problem = zpl.tagProblem(prod(attrs, scope) as never, ORIGINAL as never);
  ok(!!problem && grund.test(problem) && problem.includes(String(attrs.size).toUpperCase()), `GESPERRT ${was}: sichtbarer Grund (${problem})`);
  let einzel = '', stapel = '';
  try { zpl.buildProductTagsZpl(prod(attrs, scope) as never, ORIGINAL as never); } catch (e) { einzel = String((e as Error).message); }
  try { zpl.buildBatchTagsZpl([{ product: prod({ item_type: 'Ring', karat: 'Silver', size: '52' }) as never, category: ORIGINAL as never }, { product: prod(attrs, scope) as never, category: ORIGINAL as never }]); }
  catch (e) { stapel = String((e as Error).message); }
  ok(/^Tag OJ-0001 not printed: /.test(einzel) && /^Tag OJ-0001 not printed: /.test(stapel), `GESPERRT ${was}: kein ZPL — weder einzeln noch im Stapel`);
  const d = det(attrs, scope);
  ok(!d.some((z) => z.length > 0 && String(attrs.size).toUpperCase().startsWith(z) && z !== String(attrs.size).toUpperCase() && z.length < String(attrs.size).length),
    `GESPERRT ${was}: keine gekürzte Größe im Etikett`);
}
{
  const wl = readFileSync(join(repo, 'src/pages/watches/WatchList.tsx'), 'utf8');
  ok(/import \{ buildBatchTagsZpl, tagProblem \} from '@\/core\/print\/zpl-tag'/.test(wl)
    && /const blocked = selAll\.map\(p => \(\{ p, problem: tagProblem\(p, getCat\(p\.categoryId\)\) \}\)\)\.filter\(x => x\.problem\)/.test(wl)
    && /const selProducts = selAll\.filter\(p => !blocked\.some\(b => b\.p\.id === p\.id\)\)/.test(wl)
    && /data-tag-blocked=\{blocked\.length\}/.test(wl) && /not printed<\/strong>/.test(wl),
    'DIALOG Print Tags nennt gesperrte Etiketten sichtbar und druckt nur die vollständigen');
  ok(/const items = selProducts\.map\(p => \(\{ product: p, category: getCat\(p\.categoryId\) \}\)\);/.test(wl), 'DIALOG der Druck nimmt nur die druckbaren Artikel');
}

// ── A2 ZPL: nur der Text, gleiche Geometrie, nichts überlagert ──────────────────
{
  const voll = FAELLE[5];
  const f = face(voll[1], voll[2]);
  const text = zpl.facesToZpl([f, f]);
  const ys = (x: number) => [...text.matchAll(new RegExp(`\\^FO${x},(\\d+)\\^A0N`, 'g'))].map((m) => Number(m[1]));
  const yB = ys(500), yA = ys(5);
  // Pad B: SKU 20, Details 126… (der Preis steht daneben bei x+72, y66); Pad A dasselbe um 90 tiefer.
  ok(S(yB) === S([20, 126, 146, 166, 186]) && S(yA) === S([110, 216, 236, 256, 276])
    && text.includes('^FO572,66^A0N') && text.includes('^FO77,156^A0N'),
    `ZPL Zeilen im 20-Punkte-Raster, letzte Detailzeile wie bei den übrigen Scan-Etiketten (B ${S(yB)} / A ${S(yA)})`);
  ok(new Set(yB).size === yB.length && new Set(yA).size === yA.length, 'ZPL keine zwei Zeilen an derselben Stelle');
  ok(text.includes('^FD52 / PLATINUM^FS'), 'ZPL das Material steht im Etikett');
  ok(text.startsWith('^XA\n^CI28\n^PW663\n^LL296\n^LH0,0\n^MD30\n^PR2\n'), 'ZPL Kopf (Breite, Länge, Dichte, Tempo) unverändert');
}
{
  const alteGeometrie = altQuelle.slice(altQuelle.indexOf('const FONT'), altQuelle.indexOf('const ZPL_FOOT'));
  const neu = readFileSync(join(repo, 'src/core/print/zpl-tag.ts'), 'utf8');
  ok(alteGeometrie.length > 100 && neu.includes(alteGeometrie), 'ZPL gelockte Geometrie (Font, 17 Zeichen, Pads, Kopf) wörtlich unverändert');
}

// ── A3 alle anderen Etiketten byte-gleich ────────────────────────────────────
const ANDERE: Array<[string, Record<string, unknown>, string[]]> = [
  ['cat-watch', { reference_number: '126610ln', serial_number: 'x9', year: 2021, material: 'Platinum' }, ['Papers', 'Warranty Card']],
  ['cat-gold-jewelry', { item_type: 'Ring', karat: 'Platinum', weight: 5, diamond_weight: 0.5, description: 'solitaire' }, []],
  ['cat-gold-jewelry', { item_type: 'Bracelet', karat: '18K Yellow', weight: 12.4 }, []],
  ['cat-gold-jewelry', { item_type: 'Pendant', karat: 'Silver' }, []],
  ['cat-branded-gold-jewelry', { item_type: 'Ring', karat: 'Platinum', size: '52', description: 'love', weight: 6.2 }, []],
  ['cat-branded-gold-jewelry', { item_type: 'Bangle', karat: '22K Yellow' }, []],
  ['cat-accessory', { serial_number: 's1', model_number: 'm1', year: 2018 }, ['Papers']],
  ['cat-spare-part', { part_type: 'Dial', material: '18K YG', original_or_copy: 'Original', description: 'blue' }, []],
];
for (const [cat, attrs, scope] of ANDERE) {
  const p = { sku: 'T-1', plannedSalePrice: 1200, scopeOfDelivery: scope, attributes: attrs, brand: 'B', name: 'N' };
  ok(S(zpl.buildProductFace(p as never, catOf(cat) as never)) === S(alt.buildProductFace(p, catOf(cat))), `ANDERE ${cat} ${S(attrs)}: Etikett unverändert`);
  ok(zpl.buildProductTagsZpl(p as never, catOf(cat) as never, 3) === alt.buildProductTagsZpl(p, catOf(cat), 3), `ANDERE ${cat}: ZPL byte-gleich`);
}
{
  const generisch = { id: 'cat-custom', name: 'Custom', attributes: [{ key: 'color', label: 'Color', type: 'text', showInList: true }] };
  const p = { sku: 'G-1', brand: 'Brand', name: 'Thing', plannedSalePrice: 99, scopeOfDelivery: ['Box'], attributes: { color: 'red' } };
  ok(zpl.buildProductTagsZpl(p as never, generisch as never) === alt.buildProductTagsZpl(p, generisch), 'ANDERE generisches Etikett byte-gleich');
}
ok(zpl.buildBatchTagsZpl(ANDERE.map(([cat, attrs, scope]) => ({ product: { sku: 'T', scopeOfDelivery: scope, attributes: attrs } as never, category: catOf(cat) as never })))
  === alt.buildBatchTagsZpl(ANDERE.map(([cat, attrs, scope]) => ({ product: { sku: 'T', scopeOfDelivery: scope, attributes: attrs }, category: catOf(cat) }))),
  'ANDERE Stapeldruck (2-up) byte-gleich');

// ── B1 Excel: Zuordnung ───────────────────────────────────────────────────────
const OPT = DEFAULT_CATEGORIES.find((c) => c.id === 'cat-gold-jewelry')!.attributes.find((a) => a.key === 'karat')!.options!;
const k = (raw: string) => imp.karatColorOption(raw, OPT);
const ZUORDNUNG: Array<[string, string | null]> = [
  ['Silver', 'Silver'], ['silver', 'Silver'], ['Silver 925', 'Silver'], ['925 Silver', 'Silver'], ['Sterling', 'Silver'], ['Sterling Silver 925', 'Silver'],
  ['925', 'Silver'], ['Silver 999', 'Silver'],
  ['Platinum', 'Platinum'], ['Platinum 950', 'Platinum'], ['Platinum 999', 'Platinum'], ['PT950', 'Platinum'],
  ['18K Yellow', '18K Yellow'], ['22K Yellow', '22K Yellow'], ['999', '24K Yellow'], ['22', '22K Yellow'], ['750 rose', '18K Rose'], ['18 white gold', '18K White'],
  // nicht geraten: Gold, Goldfarbe, Gold-Karat/-Feinheit oder Überzug neben Silber/Platin
  ['925 white gold', null], ['18K Gold & Silver', null], ['Silver plated', null], ['silver plated brass', null], ['18 silver', null], ['Silver 750', null],
  ['Gold vermeil 925', null], ['Platinum 925', null], ['Platinum plated', null],
];
for (const [roh, soll] of ZUORDNUNG) ok(k(roh) === soll, `IMPORT „${roh}" → ${soll} (${k(roh)})`);
for (const roh of ['Silver', 'Silver 925', '925', 'Sterling', 'Platinum 950', 'Platinum 999', '925 white gold', 'Silver 750']) {
  ok(!/\dK/.test(String(k(roh) ?? '')), `IMPORT „${roh}" wird nie ein Gold-Karat`);
}

// ── B2 Excel: Zeilen, Notiz, Warnung ───────────────────────────────────────────
const katVon = (n: string) => { const c = DEFAULT_CATEGORIES.find((x) => x.name.toLowerCase() === n.toLowerCase()); return c ? { id: c.id, name: c.name, matched: true } : { id: 'cat-watch', name: 'Watch', matched: false }; };
const optsMit = (existing: unknown[] = []) => ({ resolveCategory: katVon, defaultVatScheme: 'VAT_10' as const, existingIndex: imp.buildExistingIndex(existing as never) });
const zeile = (extra: Record<string, string | number>, existing: unknown[] = []) =>
  imp.classifyRows([{ Category: 'Gold-Diamond Jewellery', 'Item Type': 'Ring', Weight: 5, Cost: 100, ...extra }], optsMit(existing))[0];
const vorkommen = (text: string | undefined, teil: string) => (text || '').split(teil).length - 1;
{
  const r = zeile({ 'Karat & Color': 'Silver' });
  ok(r.status === 'new' && r.attributes.karat === 'Silver' && !r.notes && !r.warnings.length, `ZEILE „Silver": angelegt, keine Notiz, keine Warnung (${S({ s: r.status, n: r.notes, w: r.warnings })})`);
  for (const roh of ['Silver 925', 'Sterling', '925', 'Silver 999']) {
    const z = zeile({ 'Karat & Color': roh });
    ok(z.status === 'warning' && z.attributes.karat === 'Silver' && vorkommen(z.notes, `Karat & Color: ${roh}`) === 1
      && z.warnings.some((w) => w === `Karat & Color "${roh}" → Silver; the fineness has no field (kept in notes)`),
      `ZEILE „${roh}": Silver, Angabe genau einmal wörtlich in der Notiz, Warnung (${S({ s: z.status, n: z.notes, w: z.warnings })})`);
  }
  const zwei = zeile({ Karat: 925, Metal: 'Silver' });
  ok(zwei.attributes.karat === 'Silver' && zwei.notes === 'Karat: 925 / Metal: Silver' && zwei.status === 'warning',
    `ZEILE alte Spalten Karat 925 + Metal Silver: Silver, beide Spalten in der Notiz (${S({ n: zwei.notes, w: zwei.warnings })})`);
  const doppelt = zeile({ 'Karat & Color': 'Silver 925', Metal: 'silver  925' });
  ok(doppelt.attributes.karat === 'Silver' && vorkommen(doppelt.notes, '925') === 1 && doppelt.notes === 'Karat & Color: Silver 925',
    `ZEILE gleicher Text in Karat & Color und Metal steht nur einmal in der Notiz (${S(doppelt.notes)})`);
  const verschieden = zeile({ 'Karat & Color': 'Silver 925', Metal: 'Sterling' });
  ok(verschieden.notes === 'Karat & Color: Silver 925 / Metal: Sterling', `ZEILE verschiedene Angaben bleiben beide (${S(verschieden.notes)})`);
  const nurMetal = zeile({ Metal: 'Silver' });
  ok(nurMetal.attributes.karat === 'Silver' && !nurMetal.notes && nurMetal.status === 'new', `ZEILE nur Metal Silver: Silver, nichts verloren (${S({ n: nurMetal.notes, w: nurMetal.warnings })})`);
  const misch = zeile({ 'Karat & Color': '925 White Gold' });
  ok(!misch.attributes.karat && misch.notes === 'Karat & Color: 925 White Gold' && misch.warnings.some((w) => w.includes('not recognised')),
    `ZEILE „925 White Gold": nicht geraten, wörtlich in der Notiz (${S({ n: misch.notes, w: misch.warnings })})`);
  // Platinum-Korrektur unverändert.
  for (const roh of ['Platinum 950', 'Platinum 999']) {
    const z = zeile({ 'Karat & Color': roh });
    ok(z.attributes.karat === 'Platinum' && z.notes === `Karat & Color: ${roh}` && z.status === 'warning'
      && z.warnings.includes(`Karat & Color "${roh}" → Platinum; the fineness has no field (kept in notes)`), `ZEILE „${roh}" wie bisher (${S({ n: z.notes, w: z.warnings })})`);
  }
  for (const roh of ['18K Yellow', '22K Yellow']) {
    const z = zeile({ 'Karat & Color': roh });
    ok(z.status === 'new' && z.attributes.karat === roh && !z.notes, `ZEILE Gold „${roh}" unverändert`);
  }
  // Wiederholter Import: dieselbe Zeile ergibt dieselbe Notiz (nichts wird angehängt); mit SKU ist sie beim zweiten Mal
  // ein Duplikat und wird nicht noch einmal angelegt — bestehende Artikel werden nie verändert.
  const erst = zeile({ 'Karat & Color': 'Silver 925', SKU: 'SLV-925-1' });
  const nochmal = zeile({ 'Karat & Color': 'Silver 925', SKU: 'SLV-925-1' });
  ok(erst.notes === nochmal.notes && vorkommen(erst.notes, '925') === 1, 'WIEDERHOLT dieselbe Notiz, die Feinheit einmal');
  const zweiterLauf = zeile({ 'Karat & Color': 'Silver 925', SKU: 'SLV-925-1' }, [{ sku: 'SLV-925-1', brand: '', attributes: { karat: 'Silver' } }]);
  ok(zweiterLauf.status === 'duplicate' && !imp.isImportable(zweiterLauf.status), `WIEDERHOLT zweiter Import derselben SKU: Duplikat, wird nicht angelegt (${zweiterLauf.status})`);
  const imSelbenLauf = imp.classifyRows([
    { Category: 'Gold-Diamond Jewellery', 'Item Type': 'Ring', Weight: 5, Cost: 100, 'Karat & Color': 'Silver 925', SKU: 'SLV-2' },
    { Category: 'Gold-Diamond Jewellery', 'Item Type': 'Ring', Weight: 5, Cost: 100, 'Karat & Color': 'Silver 925', SKU: 'SLV-2' },
  ], optsMit());
  ok(imSelbenLauf[0].status === 'warning' && imSelbenLauf[1].status === 'duplicate', 'WIEDERHOLT dieselbe Zeile zweimal in einer Datei: nur einmal angelegt');
  ok(/runProductImport[\s\S]*deps\.create\(r\)/.test(readFileSync(join(repo, 'src/core/import/product-import.ts'), 'utf8')), 'WIEDERHOLT der Import legt nur neu an (kein Ändern bestehender Artikel)');
}
ok(/Silver, Silver 925, Sterling or 925 become Silver/.test(readFileSync(join(repo, 'src/core/import/product-import.ts'), 'utf8')), 'VORLAGE erklärt Silver und die Notiz');

console.log(`\njewellery-label/silver-import: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
