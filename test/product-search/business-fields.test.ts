// ════════════════════════════════════════════════════════════════════════════
// v0.8.48 — die Produktsuche findet fachliche Daten, keine Maschinendaten.
// Run: node test/product-search/business-fields.test.ts
//
// Der reale Fehler: die Tiefensuche verglich JEDES Feld eines Produkts als Text — auch die
// KI-Bildbeschreibung, den Embedding-Vektor und Bild-Hashes. An der Produktionsdatenbank
// gemessen (66 Artikel) fand "large" 6 statt 2 Artikel, "126" fand ALLE 66, und "steel"
// ebenfalls alle — letzteres ueber die Auswahlliste der KATEGORIE, nicht ueber das Produkt.
// Eine Referenznummer war damit nicht mehr auffindbar.
//
// Geprueft wird die echte `matchesDeep` mit der echten Projektion aus `product-format.ts`,
// an einem Fixture, das den Produktionsfall nachbaut — und an allen sechs Suchflaechen,
// inklusive der Faelle, in denen das Produkt IN einem Beleg steckt.
// ════════════════════════════════════════════════════════════════════════════
import { matchesDeep } from '../../src/core/utils/deep-search.ts';
import { productBusinessSearchText, PRODUCT_SEARCH_FIELDS } from '../../src/core/utils/product-format.ts';

let PASS = 0, FAIL = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };

// ── Fixture ────────────────────────────────────────────────────────────────
// Ein Embedding, dessen Zahlen "126" als Text enthalten — genau das, was in der echten
// Datenbank an allen 66 Artikeln haengt.
const EMBEDDING = [0.126_45, -0.3126, 1.126, 0.0126, -1.2612];

type Any = Record<string, unknown>;
const product = (over: Any = {}): Any => ({
  id: 'p-' + (over.sku ?? 'x'), categoryId: 'cat-watch',
  brand: 'Rolex', name: 'Datejust 41', sku: 'RLX-WCH-001', quantity: 1,
  condition: 'Pre-Owned', scopeOfDelivery: ['Box', 'Papers'], storageLocation: 'Safe A',
  purchaseDate: '2026-01-05', purchasePrice: 9000, purchaseCurrency: 'BHD',
  plannedSalePrice: 12000, minSalePrice: 10000, maxSalePrice: undefined,
  lastOfferPrice: undefined, lastSalePrice: undefined, stockStatus: 'in_stock',
  taxScheme: 'MARGIN', supplierName: 'Gulf Watches', purchaseSource: 'Auction',
  paidFrom: 'cash', sourceType: 'OWN', notes: 'top drawer', images: ['blob:zzz'],
  imageHash: 'ffb1large126aaaa',
  imageDescription: 'A steel watch with large, bold Arabic numerals at 12, 4 and 8.',
  imageEmbedding: EMBEDDING,
  aiIdentifiedSnapshot: '{"brand":"Rolex","hint":"aisnapshottoken"}',
  aiCorrections: '[{"field":"name","aiSaid":"aicorrectiontoken"}]',
  aiConfirmedAt: '2026-02-11T08:00:00.000Z',
  attributes: { reference_number: '126334', serial_number: 'X785757', dial: 'Slate', material: 'Steel' },
  createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-02-11T08:00:00.000Z', createdBy: 'u-1',
  ...over,
});

// Die Kategorie, so wie sie die Collection-Suche als Extra mitgibt: ihre Attributliste
// enthaelt Labels und Auswahlwerte ("Steel", "Leather", "Serial Number").
const category = {
  id: 'cat-watch', name: 'Watch', icon: 'Watch', color: '#0F0F10',
  attributes: [
    { key: 'reference_number', label: 'Reference Number', type: 'text', showInList: true },
    { key: 'serial_number', label: 'Serial Number', type: 'text', showInList: true },
    { key: 'material', label: 'Material', type: 'select', options: ['Steel', 'Gold', 'Leather'], showInList: true },
    { key: 'size', label: 'Size', type: 'select', options: ['Small', 'Medium', 'Large'], showInList: false },
  ],
  scopeOptions: ['Box', 'Papers'], conditionOptions: ['New', 'Pre-Owned'], active: true, sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Die Collection-Suche, wortgleich zu `WatchList.tsx`. */
const collection = (list: Any[], q: string): Any[] => list.filter(p => matchesDeep(p, q, [category]));

// ── §12 der Produktionsfall "large" ────────────────────────────────────────
{
  const list = [
    product({ sku: 'CAR-WCH-007', brand: 'Cartier', name: 'Tank Must Large' }),
    product({ sku: 'CAR-WCH-009', brand: 'Cartier', name: 'Tank Must Large' }),
    product({ sku: 'CON-WCH-003', name: 'Saratoga', imageDescription: 'date window at 3 and large, bold hour markers' }),
    product({ sku: 'OME-WCH-006', name: 'Constellation', imageDescription: 'large white Arabic numerals at 12, 4 and 8' }),
    product({ sku: 'MON-WCH-002', name: 'Summit', imageDescription: 'displaying large black Arabic numerals' }),
    product({ sku: 'RLX-WCH-003', name: 'Oyster Perpetual 26', imageDescription: 'a large crown guard' }),
  ];
  const hits = collection(list, 'large').map(p => p.sku);
  ok(hits.length === 2, `LARGE exactly the two items that are really called "Large" (${hits.length}: ${hits.join(', ')})`);
  ok(hits.includes('CAR-WCH-007') && hits.includes('CAR-WCH-009'), 'LARGE …and they are the two Cartier Tank Must Large');
  ok(!hits.includes('CON-WCH-003'), 'LARGE an AI photo description does not make an item "large"');
  // Und das Feld ist wirklich befuellt — sonst waere der Test oben wertlos.
  ok(list[2].imageDescription!.toString().includes('large'), 'LARGE the machine field really contains the term');
}

// ── §13 der wichtigste Fall: Zahlen ────────────────────────────────────────
{
  const list = [
    product({ sku: 'RLX-WCH-010', attributes: { reference_number: '126333', material: 'Steel' } }),
    product({ sku: 'RLX-WCH-011', attributes: { reference_number: '228238', material: 'Gold' } }),
    product({ sku: 'RLX-WCH-012', attributes: { reference_number: '116500', material: 'Steel' } }),
    product({ sku: 'RLX-WCH-013', attributes: { reference_number: '279174', material: 'Gold' } }),
  ];
  ok(list.every(p => JSON.stringify(p.imageEmbedding).includes('126')), 'REF the embeddings really carry "126" as text');
  const hits = collection(list, '126').map(p => p.sku);
  ok(hits.length === 1 && hits[0] === 'RLX-WCH-010', `REF a reference search finds exactly the one item (${hits.length}: ${hits.join(', ')})`);
  ok(collection(list, '126333').length === 1, 'REF …and the full reference number too');
}

// ── §14 kein Maschinenfeld erzeugt einen Treffer ───────────────────────────
{
  const p = product({
    imageHash: 'hashtoken0000', imageDescription: 'descriptiontoken here',
    imageEmbedding: [0.999_777, 1.5551], aiIdentifiedSnapshot: '{"x":"snapshottoken"}',
    aiCorrections: '[{"v":"correctiontoken"}]', aiConfirmedAt: '2026-07-07T07:07:07.000Z',
    images: ['imagestoken.jpg'],
  });
  for (const [field, term] of [
    ['imageHash', 'hashtoken'], ['imageDescription', 'descriptiontoken'], ['imageEmbedding', '999777'],
    ['aiIdentifiedSnapshot', 'snapshottoken'], ['aiCorrections', 'correctiontoken'],
    ['aiConfirmedAt', '2026-07-07'], ['images', 'imagestoken'],
  ] as Array<[string, string]>) {
    ok(!matchesDeep(p, term, [category]), `MACHINE "${term}" (only in ${field}) is not a product hit`);
  }
  // Technische Identitaeten ebenso wenig.
  ok(!matchesDeep(product({ id: 'p-uuidtoken' }), 'uuidtoken', [category]), 'MACHINE an internal id is not searchable');
  ok(!matchesDeep(p, '2026-02-11t08', [category]), 'MACHINE a technical timestamp is not searchable');
  // Und die Projektion selbst nennt kein einziges Maschinenfeld.
  const machine = ['images', 'imageHash', 'imageDescription', 'imageEmbedding', 'aiIdentifiedSnapshot',
    'aiCorrections', 'aiConfirmedAt', 'id', 'categoryId', 'createdAt', 'updatedAt', 'createdBy'];
  ok(machine.every(f => !(PRODUCT_SEARCH_FIELDS as readonly string[]).includes(f)),
    'MACHINE the field list contains no machine field at all');
}

// ── §15 die fachliche Suche funktioniert weiterhin ─────────────────────────
{
  const p = product({
    sku: 'RLX-WCH-042', brand: 'Rolex', name: 'Datejust 41 Wimbledon', condition: 'Pre-Owned',
    storageLocation: 'Vitrine 3', notes: 'kratzer am boden', supplierName: 'Gulf Watches',
    purchaseSource: 'Auction Dubai', scopeOfDelivery: ['Box', 'Certificate'],
    attributes: { reference_number: '126334', serial_number: 'X785757', material: 'Steel',
      dial: 'Slate Roman', description: 'presentation box included' },
  });
  for (const [what, term] of [
    ['SKU', 'rlx-wch-042'], ['SKU partial', 'wch-042'], ['brand', 'rolex'], ['name', 'wimbledon'],
    ['reference', '126334'], ['serial', 'x785757'], ['material attribute', 'steel'],
    ['dial attribute', 'slate roman'], ['description attribute', 'presentation box'],
    ['condition', 'pre-owned'], ['location', 'vitrine 3'], ['notes', 'kratzer'],
    ['supplier', 'gulf watches'], ['purchase source', 'auction dubai'],
    ['scope of delivery', 'certificate'], ['price', '12000'], ['stock status', 'in_stock'],
  ] as Array<[string, string]>) {
    ok(matchesDeep(p, term, [category]), `BUSINESS ${what} stays searchable ("${term}")`);
  }
  ok(matchesDeep(p, 'WIMBLEDON', [category]), 'BUSINESS the search stays case-insensitive');
  ok(matchesDeep(p, '  wimbledon  ', [category]), 'BUSINESS …and trims the query');
  ok(matchesDeep(p, 'imbledo', [category]), 'BUSINESS …and still matches inside a word');
  ok(matchesDeep(p, '', [category]), 'BUSINESS an empty query matches everything, as before');
}

// ── die Kategorie ist eine Definition, kein Artikel ────────────────────────
{
  const gold = product({ sku: 'X-1', attributes: { material: 'Gold' } });
  ok(!matchesDeep(gold, 'steel', [category]),
    'CATEGORY an option offered by the category does not make every item of it a hit');
  ok(!matchesDeep(gold, 'serial number', [category]), 'CATEGORY …and neither does a field label');
  ok(matchesDeep(gold, 'gold', [category]), 'CATEGORY the item\'s own material still matches');
  ok(matchesDeep(gold, 'watch', [category]), 'CATEGORY the category NAME stays searchable');
}

// ── §16/§17 alle sechs Suchflaechen, auch mit eingebettetem Produkt ────────
{
  // Referenz OHNE "126": die Ziffern stehen hier nur im Embedding-Vektor. Sonst waere der
  // Nicht-Leck-Test unten wertlos, weil ein fachliches Feld den Treffer erklaeren wuerde.
  const p = product({
    sku: 'RLX-WCH-777', name: 'Submariner', imageDescription: 'a large steel bezel with descriptiontoken',
    attributes: { reference_number: '116610', serial_number: 'Z1', material: 'Steel' },
  });
  const customer = { id: 'c-1', firstName: 'Ali', lastName: 'Hassan', phone: '39001122', email: 'ali@example.com' };
  const surfaces: Array<[string, unknown, unknown[], string]> = [
    // Name, durchsuchtes Objekt, Extras, eigenes fachliches Feld des Belegs
    ['Collection', p, [category], 'submariner'],
    ['Invoice', { id: 'i-1', invoiceNumber: 'INV-000009', status: 'issued', notes: 'abholung', customerId: 'c-1', lines: [{ id: 'l-1', productId: p.id, unitPrice: 12000 }] }, [customer, p], 'inv-000009'],
    ['Offer', { id: 'o-1', offerNumber: 'OFF-000003', status: 'open', customerId: 'c-1', lines: [{ id: 'l-1', productId: p.id }] }, [customer, p], 'off-000003'],
    ['Order', { id: 'or-1', orderNumber: 'ORD-000002', status: 'ordered', customerId: 'c-1', product: p }, [customer, p], 'ord-000002'],
    ['Repair', { id: 'r-1', repairNumber: 'REP-000004', status: 'in_progress', issueDescription: 'krone locker', customerId: 'c-1', product: p }, [customer, p], 'rep-000004'],
    ['Consignment', { id: 'k-1', status: 'active', model: 'percent', consignorId: 'c-9', productId: p.id, product: p }, [customer, p], 'percent'],
  ];
  for (const [name, obj, extras, ownTerm] of surfaces) {
    ok(matchesDeep(obj, 'submariner', extras), `${name} finds the item by its product name`);
    ok(matchesDeep(obj, ownTerm, extras), `${name} still finds the document by its own field ("${ownTerm}")`);
    ok(!matchesDeep(obj, 'descriptiontoken', extras), `${name} does NOT leak the product's AI description`);
    ok(!matchesDeep(obj, '126', extras), `${name} does NOT leak the embedding numbers`);
  }
  // Der Beleg behaelt seine eigenen fachlichen Felder — auch die des Kunden.
  const invoice = surfaces[1][1];
  ok(matchesDeep(invoice, 'hassan', [customer, p]), 'DOCUMENT an invoice is still found by its customer');
  ok(matchesDeep(invoice, '39001122', [customer, p]), 'DOCUMENT …and by the customer phone number');
  ok(matchesDeep(invoice, 'abholung', [customer, p]), 'DOCUMENT …and by its own note');
  ok(matchesDeep(invoice, '12000', [customer, p]), 'DOCUMENT …and by a line amount');
  const repair = surfaces[4][1];
  ok(matchesDeep(repair, 'krone locker', [customer, p]), 'DOCUMENT a repair is still found by its issue description');
  ok(matchesDeep(repair, 'in_progress', [customer, p]), 'DOCUMENT …and by its status');
}

// ── die Projektion selbst ──────────────────────────────────────────────────
{
  const text = productBusinessSearchText(product() as never);
  ok(text.includes('rolex') && text.includes('126334') && text.includes('top drawer'),
    'PROJECTION carries brand, attributes and notes');
  ok(!text.includes('large, bold') && !text.includes('0.126') && !text.includes('ffb1large'),
    'PROJECTION carries no AI description, no embedding and no hash');
}

// ── §16 die sechs Flaechen benutzen wirklich diesen einen Weg ──────────────
//
// Die Faelle oben beweisen das Verhalten an den Objektformen. Hier wird belegt, dass die
// sechs Listen genau diesen Helfer aufrufen und nicht daneben eine eigene Produktsuche
// halten — sonst waere die zentrale Korrektur an einer Liste wirkungslos.
{
  const { readFileSync } = await import('node:fs');
  const files: Array<[string, string]> = [
    ['Collection', 'src/pages/watches/WatchList.tsx'],
    ['Invoice', 'src/pages/invoices/InvoiceList.tsx'],
    ['Offer', 'src/pages/offers/OfferList.tsx'],
    ['Order', 'src/pages/orders/OrderList.tsx'],
    ['Repair', 'src/pages/repairs/RepairList.tsx'],
    ['Consignment', 'src/pages/consignments/ConsignmentList.tsx'],
  ];
  for (const [name, file] of files) {
    const src = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    ok(/import \{[^}]*matchesDeep[^}]*\} from '@\/core\/utils\/deep-search'/.test(src),
      `WIRING ${name} imports the shared deep search`);
    ok(/matchesDeep\(/.test(src), `WIRING ${name} filters through it`);
    ok(!/imageDescription|imageEmbedding|imageHash|aiIdentifiedSnapshot/.test(src),
      `WIRING ${name} does not reach into product machine fields on its own`);
  }
  // Und die Ausschlussliste ist NICHT der Ort, an dem der Fix haengt: die Projektion ist es.
  const deep = readFileSync(new URL('../../src/core/utils/deep-search.ts', import.meta.url), 'utf8');
  ok(/isProductLike\(value\)\) return productBusinessSearchText/.test(deep),
    'WIRING a product is searched through its business projection, not field by field');
  ok(/isCategoryLike\(value\)\) return categorySearchText/.test(deep),
    'WIRING …and a category only through its name');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — product search: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
