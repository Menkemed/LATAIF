// ════════════════════════════════════════════════════════════════════════════
// v0.8.48 — der fachliche Suchvertrag der Produktsuche.
// Run: node test/product-search/business-fields.test.ts
//
// Suche beantwortet "welcher Artikel ist das" — Marke, Name, SKU, Referenz, Seriennummer,
// Zustand, Beschreibung, Notiz, Lagerort, Lieferumfang, Lieferant, Kategorie und die
// fachlichen Attributwerte. Sie beantwortet NICHT "welche Artikel haben Eigenschaft X":
// Preise, Steuerschema, Eigentumsart und der interne Bestandsstatus haben dafuer Filter und
// wuerden als Freitext nur Zufallstreffer erzeugen.
//
// Die Fehler, die dahinter stehen, sind real gemessen worden (66 Artikel in Produktion):
// "large" fand 6 statt 2 Artikel ueber die KI-Bildbeschreibung, "126" fand ALLE 66 ueber den
// Embedding-Vektor, "steel" und "serial number" ebenfalls alle — letztere ueber die
// DEFINITION der Kategorie statt ueber den Artikel.
//
// Geprueft wird die echte `matchesDeep` mit der echten Projektion, an allen sechs Flaechen,
// auch dort, wo das Produkt IN einem Beleg steckt.
// ════════════════════════════════════════════════════════════════════════════
import { matchesDeep } from '../../src/core/utils/deep-search.ts';
import {
  productBusinessSearchText, productSearchText, PRODUCT_SEARCH_FIELDS,
  isProductLike, isCategoryLike,
} from '../../src/core/utils/product-format.ts';
import { registerCategoryLookup, clearCategoryLookup, categorySelection } from '../../src/core/utils/category-lookup.ts';

let PASS = 0, FAIL = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };

// ── Fixture ────────────────────────────────────────────────────────────────
// Der Embedding-Vektor traegt "126" als Text — genau wie an allen 66 echten Artikeln.
const EMBEDDING = [0.126_45, -0.3126, 1.126, 0.0126, -1.2612];

type Any = Record<string, unknown>;
const product = (over: Any = {}): Any => ({
  id: 'p-' + (over.sku ?? 'x'), categoryId: 'cat-watch',
  brand: 'Rolex', name: 'Datejust 41', sku: 'RLX-WCH-001', quantity: 1,
  condition: 'Pre-Owned', scopeOfDelivery: ['Box', 'Papers'], storageLocation: 'Safe A',
  purchaseDate: '2026-01-05', purchaseCurrency: 'BHD',
  // Jedes ausgeschlossene Feld traegt ein Kennwort, das sonst nirgends vorkommt.
  purchasePrice: 987_654_321, plannedSalePrice: 987_654_322, minSalePrice: 987_654_323,
  maxSalePrice: 987_654_324, lastOfferPrice: 987_654_325, lastSalePrice: 987_654_326,
  taxScheme: 'MARGIN_taxtoken', sourceType: 'OWN_ownershiptoken',
  stockStatus: 'in_stock_statustoken', purchaseSource: 'provenancetoken Auction',
  paidFrom: 'cash', expectedMargin: 987_654_327, daysInStock: 987_654_328,
  supplierName: 'Al Noor Trading', supplierId: 'sup-supplieridtoken',
  notes: 'top drawer', images: ['blob:zzz'],
  imageHash: 'ffb1large126aaaa',
  imageDescription: 'A steel watch with large, bold Arabic numerals at 12, 4 and 8.',
  imageEmbedding: EMBEDDING,
  aiIdentifiedSnapshot: '{"brand":"Rolex","hint":"aisnapshottoken"}',
  aiCorrections: '[{"field":"name","aiSaid":"aicorrectiontoken"}]',
  aiConfirmedAt: '2026-02-11T08:00:00.000Z',
  attributes: {
    reference_number: '126334', serial_number: 'X785757', model_number: 'MOD-1267',
    dial: 'Slate Roman', material: 'Steel', description: 'presentation box included',
    certificate: 'AGS 2019', case_diameter_mm: 41,
  },
  createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-02-11T08:00:00.000Z', createdBy: 'u-1',
  ...over,
});

// Die Kategorie, so wie die Collection sie mitgibt: eine DEFINITION mit Labels und
// Auswahlwerten — nicht die Daten eines Artikels.
const category = {
  id: 'cat-watch', name: 'Watch', icon: 'Watch', color: '#0F0F10',
  attributes: [
    { key: 'reference_number', label: 'Reference Number', type: 'text', showInList: true },
    { key: 'serial_number', label: 'Serial Number', type: 'text', showInList: true },
    { key: 'model_number', label: 'Model Number', type: 'text', showInList: true },
    { key: 'dial', label: 'Dial', type: 'text', showInList: false },
    { key: 'description', label: 'Description', type: 'text', showInList: false },
    { key: 'certificate', label: 'Certificate', type: 'text', showInList: false },
    { key: 'case_diameter_mm', label: 'Case Diameter', type: 'number', unit: 'mm', showInList: true },
    { key: 'material', label: 'Material', type: 'select', options: ['Steel', 'Gold', 'Leather'], showInList: true },
    { key: 'size', label: 'Size', type: 'select', options: ['Small', 'Medium', 'Large'], showInList: false },
  ],
  scopeOptions: ['Box', 'Papers'], conditionOptions: ['New', 'Pre-Owned'], active: true, sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// Die kanonische Kategorie-Auflösung, so wie sie im laufenden Programm der Produkt-Store
// anmeldet. Damit gilt die Attributgrenze ueberall gleich — auch dort, wo das Produkt in
// einem Beleg steckt und niemand eine Kategorie mitgibt.
registerCategoryLookup((id) => (id === category.id ? (category as never) : undefined));

/** Die Collection-Suche, wortgleich zu `WatchList.tsx`. */
const collection = (list: Any[], q: string): Any[] => list.filter(p => matchesDeep(p, q, [category]));
const finds = (p: Any, q: string): boolean => matchesDeep(p, q, [category]);

// ── §14 die fachliche Suche funktioniert ───────────────────────────────────
{
  const p = product({
    sku: 'RLX-WCH-042', brand: 'Rolex', name: 'Datejust 41 Wimbledon', condition: 'Pre-Owned',
    storageLocation: 'Vitrine 3', notes: 'kratzer am boden', supplierName: 'Al Noor Trading',
    scopeOfDelivery: ['Box', 'Certificate'],
  });
  for (const [what, term] of [
    ['SKU', 'rlx-wch-042'], ['SKU partial', 'wch-042'], ['brand', 'rolex'],
    ['name', 'wimbledon'], ['model', 'mod-1267'], ['reference', '126334'],
    ['serial', 'x785757'], ['condition', 'pre-owned'], ['description', 'presentation box'],
    ['notes', 'kratzer'], ['location', 'vitrine 3'], ['included', 'certificate'],
    ['supplier display name', 'al noor'], ['category name', 'watch'],
    ['category attribute value', 'steel'], ['dial attribute', 'slate roman'],
    ['numeric attribute', '41'],
  ] as Array<[string, string]>) {
    ok(finds(p, term), `BUSINESS ${what} stays searchable ("${term}")`);
  }
  ok(finds(p, 'AL NOOR'), 'BUSINESS the search stays case-insensitive');
  ok(finds(p, '  wimbledon  '), 'BUSINESS …and trims the query');
  ok(finds(p, 'imbledo'), 'BUSINESS …and still matches inside a word');
  ok(finds(p, ''), 'BUSINESS an empty query matches everything, as before');
}

// ── §15 Filterfelder erzeugen keine Freitexttreffer ────────────────────────
{
  const p = product({ sku: 'RLX-WCH-050' });
  for (const [what, token] of [
    ['purchase price', '987654321'], ['sale price', '987654322'], ['minimum sale price', '987654323'],
    ['max sale price', '987654324'], ['last offer price', '987654325'], ['last sale price', '987654326'],
    ['tax scheme', 'taxtoken'], ['ownership type', 'ownershiptoken'],
    ['internal stock status', 'statustoken'], ['technical provenance', 'provenancetoken'],
    ['supplier id', 'supplieridtoken'], ['payment method', 'cash'],
    ['purchase date', '2026-01-05'], ['quantity/margin numbers', '987654327'],
  ] as Array<[string, string]>) {
    ok(!finds(p, token), `FILTER ${what} is not a free-text hit ("${token}")`);
  }
  // …und der Artikel ist trotzdem auffindbar. Ohne diesen Nachweis koennte die Projektion
  // schlicht leer sein und alle Negativtests waeren wertlos.
  ok(finds(p, 'rlx-wch-050'), 'FILTER the item itself is still found by its SKU');
  ok(finds(p, 'al noor'), 'FILTER …and by its supplier');
}

// ── §10 KI- und Maschinendaten bleiben draussen ────────────────────────────
{
  const p = product({
    sku: 'RLX-WCH-060', imageHash: 'hashtoken0000', imageDescription: 'descriptiontoken here',
    imageEmbedding: [0.999_777, 1.5551], aiIdentifiedSnapshot: '{"x":"snapshottoken"}',
    aiCorrections: '[{"v":"correctiontoken"}]', aiConfirmedAt: '2026-07-07T07:07:07.000Z',
    images: ['imagestoken.jpg'],
  });
  for (const [field, term] of [
    ['imageHash', 'hashtoken'], ['imageDescription', 'descriptiontoken'], ['imageEmbedding', '999777'],
    ['aiIdentifiedSnapshot', 'snapshottoken'], ['aiCorrections', 'correctiontoken'],
    ['aiConfirmedAt', '2026-07-07'], ['images', 'imagestoken'],
  ] as Array<[string, string]>) {
    ok(!finds(p, term), `MACHINE "${term}" (only in ${field}) is not a product hit`);
  }
  ok(!finds(product({ id: 'p-uuidtoken', sku: 'S-1' }), 'uuidtoken'), 'MACHINE an internal id is not searchable');
  ok(!finds(p, '2026-02-11t08'), 'MACHINE a technical timestamp is not searchable');
  const machine = ['images', 'imageHash', 'imageDescription', 'imageEmbedding', 'aiIdentifiedSnapshot',
    'aiCorrections', 'aiConfirmedAt', 'id', 'categoryId', 'createdAt', 'updatedAt', 'createdBy',
    'purchasePrice', 'plannedSalePrice', 'minSalePrice', 'taxScheme', 'sourceType', 'stockStatus',
    'purchaseSource'];
  ok(machine.every(f => !(PRODUCT_SEARCH_FIELDS as readonly string[]).includes(f)),
    'MACHINE the field list names none of them');
}

// ── §16 Attribut des Artikels ≠ Definition der Kategorie ───────────────────
{
  const steel = product({ sku: 'A-1', attributes: { material: 'Steel' } });
  const gold = product({ sku: 'A-2', attributes: { material: 'Gold' } });
  ok(finds(steel, 'steel'), 'ATTR the item\'s own material matches');
  ok(!finds(gold, 'steel'), 'ATTR an option the category merely offers does not match');
  ok(!finds(gold, 'serial number'), 'ATTR …and neither does a field label of the definition');
  ok(!finds(gold, 'large'), 'ATTR …and neither does an option value like "Large"');
  ok(finds(gold, 'watch'), 'ATTR the category NAME stays searchable');

  // Unbekannter Schluessel: die Kategorie kennt ihn nicht, also ist er kein fachlicher Wert.
  const stray = product({ sku: 'A-3', attributes: { material: 'Gold', _internal_meta: 'unknownkeytoken' } });
  ok(!finds(stray, 'unknownkeytoken'), 'ATTR an attribute key the category does not define is not searchable');
  ok(finds(stray, 'a-3'), 'ATTR …while the item stays findable');

  // Verschachtelte Struktur in einem Attribut wird nie serialisiert — auch ohne Kategorie.
  const nested = product({ sku: 'A-4', attributes: { material: { value: 'Steel', meta: 'nestedtoken' } } });
  ok(!matchesDeep(nested, 'nestedtoken'), 'ATTR a nested attribute object is never serialised into the search text');
  ok(!matchesDeep(nested, 'object object'), 'ATTR …and does not leak as "[object Object]" either');
  ok(matchesDeep(nested, 'a-4'), 'ATTR …while the item stays findable without a category too');

  // Auch OHNE mitgegebene Kategorie: die Auflösung liefert sie, die Grenze gilt.
  ok(!matchesDeep(stray, 'unknownkeytoken'),
    'ATTR the key boundary holds even when no category is handed to the search');
  ok(matchesDeep(stray, 'gold'), 'ATTR …and a defined attribute still matches there');

  // FAIL CLOSED: Kategorie nicht aufloesbar ⇒ gar keine Attribute — der Rest bleibt.
  const orphan = product({ sku: 'A-5', categoryId: 'cat-does-not-exist' });
  ok(!matchesDeep(orphan, '126334'), 'ATTR an unresolvable category means NO attribute is searched');
  ok(!matchesDeep(orphan, 'steel'), 'ATTR …not one of them');
  ok(matchesDeep(orphan, 'a-5') && matchesDeep(orphan, 'rolex') && matchesDeep(orphan, 'al noor'),
    'ATTR …while SKU, brand and supplier stay searchable');

  // Dasselbe, wenn ueberhaupt keine Auflösung angemeldet ist.
  clearCategoryLookup();
  ok(!matchesDeep(product({ sku: 'A-6' }), '126334'),
    'ATTR with no canonical lookup at all, attributes are not searched either');
  ok(matchesDeep(product({ sku: 'A-6' }), 'a-6'), 'ATTR …and the item is still found by its SKU');
  ok(matchesDeep(product({ sku: 'A-7' }), '126334', [category]),
    'ATTR …but a category handed in directly still opens its own attributes');
  registerCategoryLookup((id) => (id === category.id ? (category as never) : undefined));
}

// ── §12 die Formerkennung trifft nur Produkte ──────────────────────────────
{
  ok(isProductLike(product()), 'SHAPE a real product is recognised');
  ok(!isProductLike({ id: 'x', name: 'Watch service', status: 'open' }),
    'SHAPE a plain business object with id/name/status is NOT a product');
  ok(!isProductLike({ id: 'x', name: 'n', status: 'open', category: 'watches', attributes: {} }),
    'SHAPE …not even with a category label and an attributes bag');
  ok(!isProductLike({ categoryId: 'c', stockStatus: 's', attributes: {} }),
    'SHAPE …and not without brand or SKU');
  ok(!isProductLike(category), 'SHAPE a category is not a product');
  ok(isCategoryLike(category), 'SHAPE …but it is recognised as a category');
  ok(!isCategoryLike(product()), 'SHAPE and a product is not a category');
  // Ein Fremdobjekt mit denselben allgemeinen Feldern bleibt normal durchsuchbar.
  const task = { id: 't-1', name: 'Poliermaschine holen', status: 'open', notes: 'tasktoken' };
  ok(matchesDeep(task, 'tasktoken'), 'SHAPE a non-product object is still deep-searched as before');
}

// ── §17 der Produktionsfall "large" ────────────────────────────────────────
{
  const list = [
    product({ sku: 'CAR-WCH-007', brand: 'Cartier', name: 'Tank Must Large' }),
    product({ sku: 'CAR-WCH-009', brand: 'Cartier', name: 'Tank Must Large' }),
    product({ sku: 'CON-WCH-003', name: 'Saratoga', imageDescription: 'date window at 3 and large, bold hour markers' }),
    product({ sku: 'OME-WCH-006', name: 'Constellation', imageDescription: 'large white Arabic numerals at 12, 4 and 8' }),
    product({ sku: 'MON-WCH-002', name: 'Summit', imageDescription: 'displaying large black Arabic numerals' }),
    product({ sku: 'RLX-WCH-003', name: 'Oyster Perpetual 26', imageDescription: 'a large crown guard' }),
  ];
  ok(String(list[2].imageDescription).includes('large'), 'LARGE the machine field really contains the term');
  const hits = collection(list, 'large').map(p => p.sku);
  ok(hits.length === 2, `LARGE exactly the two items really called "Large" (${hits.length}: ${hits.join(', ')})`);
  ok(hits.includes('CAR-WCH-007') && hits.includes('CAR-WCH-009'), 'LARGE …and they are the two Cartier Tank Must Large');
}

// ── §18 der schwerste Fall: Zahlen ─────────────────────────────────────────
{
  const list = [
    product({ sku: 'RLX-WCH-010', attributes: { reference_number: '126333', material: 'Steel' } }),
    product({ sku: 'RLX-WCH-011', attributes: { reference_number: '228238', material: 'Gold' } }),
    product({ sku: 'RLX-WCH-012', attributes: { reference_number: '116500' }, purchasePrice: 126_500 }),
    product({ sku: 'RLX-WCH-013', attributes: { serial_number: 'Z9' }, plannedSalePrice: 12_612, minSalePrice: 1260 }),
  ];
  ok(list.every(p => JSON.stringify(p.imageEmbedding).includes('126')), 'REF the embeddings really carry "126" as text');
  ok(String(list[2].purchasePrice).includes('126') && String(list[3].plannedSalePrice).includes('126'),
    'REF …and two items really carry "126" in a price');
  const hits = collection(list, '126').map(p => p.sku);
  ok(hits.length === 1 && hits[0] === 'RLX-WCH-010',
    `REF a reference search finds exactly the one item (${hits.length}: ${hits.join(', ')})`);
  ok(collection(list, '126333').length === 1, 'REF …and the full reference number too');
}

// ── §19/§20 alle sechs Flaechen, auch mit eingebettetem Produkt ────────────
{
  const p = product({
    sku: 'RLX-WCH-777', name: 'Submariner', supplierName: 'Al Noor Trading',
    imageDescription: 'a large steel bezel with descriptiontoken',
    // Ein Schluessel, den die Kategorie NICHT definiert — der Rest aus einem Import.
    attributes: { reference_number: '116610', serial_number: 'Z1', material: 'Steel', _internal_meta: 'straykeytoken' },
  });
  const customer = { id: 'c-1', firstName: 'Ali', lastName: 'Hassan', phone: '39001122', email: 'ali@example.com' };
  const surfaces: Array<[string, unknown, unknown[], string]> = [
    ['Collection', p, [category], 'submariner'],
    ['Invoice', { id: 'i-1', invoiceNumber: 'INV-000009', status: 'issued', notes: 'abholung', customerId: 'c-1', totalAmount: 12000, lines: [{ id: 'l-1', productId: p.id, unitPrice: 12000 }] }, [customer, p], 'inv-000009'],
    ['Offer', { id: 'o-1', offerNumber: 'OFF-000003', status: 'open', customerId: 'c-1', lines: [{ id: 'l-1', productId: p.id }] }, [customer, p], 'off-000003'],
    ['Order', { id: 'or-1', orderNumber: 'ORD-000002', status: 'ordered', customerId: 'c-1', product: p }, [customer, p], 'ord-000002'],
    ['Repair', { id: 'r-1', repairNumber: 'REP-000004', status: 'in_progress', issueDescription: 'krone locker', customerId: 'c-1', product: p }, [customer, p], 'rep-000004'],
    ['Consignment', { id: 'k-1', status: 'active', model: 'percent', consignorId: 'c-9', productId: p.id, product: p }, [customer, p], 'percent'],
  ];
  for (const [name, obj, extras, ownTerm] of surfaces) {
    ok(matchesDeep(obj, 'submariner', extras), `${name} finds the item by its product name`);
    ok(matchesDeep(obj, 'al noor', extras), `${name} finds it by its supplier`);
    ok(matchesDeep(obj, ownTerm, extras), `${name} still finds the document by its own field ("${ownTerm}")`);
    ok(!matchesDeep(obj, 'descriptiontoken', extras), `${name} does NOT leak the product's AI description`);
    ok(!matchesDeep(obj, '126', extras), `${name} does NOT leak the embedding numbers`);
    ok(!matchesDeep(obj, '987654321', extras), `${name} does NOT leak the product's purchase price`);
    ok(!matchesDeep(obj, 'ownershiptoken', extras), `${name} does NOT leak the ownership type`);
    ok(!matchesDeep(obj, 'supplieridtoken', extras), `${name} does NOT leak the supplier id`);
    // Die Attributgrenze — auf ALLEN sechs Flaechen dieselbe. Nur die Collection reicht eine
    // Kategorie mit; die fuenf Beleglisten kommen ueber die kanonische Auflösung dorthin.
    ok(!matchesDeep(obj, 'straykeytoken', extras), `${name} does NOT search an attribute key the category never defined`);
    ok(matchesDeep(obj, '116610', extras), `${name} …while a defined attribute (reference) still matches`);
    ok(matchesDeep(obj, 'steel', extras), `${name} …and so does the material`);
  }
  // Der Beleg behaelt seine eigenen fachlichen Felder — inklusive Betraegen und Status.
  const invoice = surfaces[1][1];
  ok(matchesDeep(invoice, 'hassan', [customer, p]), 'DOCUMENT an invoice is still found by its customer');
  ok(matchesDeep(invoice, '39001122', [customer, p]), 'DOCUMENT …and by the customer phone number');
  ok(matchesDeep(invoice, 'abholung', [customer, p]), 'DOCUMENT …and by its own note');
  ok(matchesDeep(invoice, '12000', [customer, p]), 'DOCUMENT …and by its amount — a document amount is not a product price');
  ok(matchesDeep(invoice, 'issued', [customer, p]), 'DOCUMENT …and by its own status');
  const repair = surfaces[4][1];
  ok(matchesDeep(repair, 'krone locker', [customer, p]), 'DOCUMENT a repair is still found by its issue description');
  ok(matchesDeep(repair, 'in_progress', [customer, p]), 'DOCUMENT …and by its own status');
}

// ── die Projektion selbst ──────────────────────────────────────────────────
{
  const text = productBusinessSearchText(product() as never, category as never);
  ok(text.includes('rolex') && text.includes('126334') && text.includes('top drawer') && text.includes('al noor'),
    'PROJECTION carries brand, attributes, notes and supplier');
  ok(!text.includes('987654321') && !text.includes('taxtoken') && !text.includes('ownershiptoken')
    && !text.includes('statustoken') && !text.includes('provenancetoken') && !text.includes('supplieridtoken'),
    'PROJECTION carries no price, tax, ownership, status or provenance');
  ok(!text.includes('large, bold') && !text.includes('0.126') && !text.includes('ffb1large'),
    'PROJECTION carries no AI description, no embedding and no hash');
  // Der Picker-Helfer bleibt, was er war — dieselbe Attributableitung, eigener Umfang.
  const picker = productSearchText(product() as never);
  ok(picker.includes('rolex') && picker.includes('126334'), 'PICKER still carries brand and attributes');
  ok(!picker.includes('987654321'), 'PICKER never carried prices either');
}

// ── deaktivierte Kategorie: die Definition gilt fuer bestehende Artikel weiter ──
//
// Eine Kategorie zu deaktivieren heisst "nicht mehr fuer Neuanlagen anbieten". Die Artikel,
// die schon in ihr liegen, behalten ihre Kategorie und ihre Attribute — sie duerfen dadurch
// nicht unauffindbar werden. Genau deshalb loest die Suche ueber ALLE bekannten Definitionen
// auf, waehrend die Auswahlliste weiterhin nur die aktiven zeigt.
{
  const retired = { ...category, id: "cat-retired", name: "Retired Line", active: false };
  // Genau die Aufteilung, die auch der Store benutzt — die echte Funktion, keine Kopie.
  const { schema, active } = categorySelection([category, retired] as never);
  registerCategoryLookup((id) => (schema.find(c => c.id === id) as never) ?? undefined);

  const old = product({
    sku: "OLD-001", categoryId: "cat-retired", brand: "Cartier", supplierName: "Al Noor Trading",
    attributes: { reference_number: "INACTIVE-REF-777", material: "Steel", _leftover: "straytoken2" },
  });
  ok(matchesDeep(old, "inactive-ref-777"),
    "INACTIVE an item in a deactivated category is still found by its reference");
  ok(matchesDeep(old, "steel"), "INACTIVE …and by its material");
  ok(matchesDeep(old, "old-001") && matchesDeep(old, "al noor"), "INACTIVE …and by SKU and supplier");
  ok(!matchesDeep(old, "straytoken2"), "INACTIVE …while the key boundary still holds there");

  // Die Auswahlliste sieht ausschliesslich aktive Kategorien — dieselbe Trennung, die der
  // Store macht: `categories` = aktiv, `categorySchema` = alle bekannten.
  ok(!active.some(c => c.id === "cat-retired"), "INACTIVE the retired category is NOT offered for new items");
  ok(active.some(c => c.id === "cat-watch"), "INACTIVE …while the active one still is");
  ok(schema.some(c => c.id === "cat-retired"), "INACTIVE …but its definition is still known");

  // Und das gilt auch dort, wo der Artikel in einem Beleg steckt und niemand eine Kategorie
  // mitgibt — derselbe zentrale Weg wie fuer alle sechs Flaechen.
  const order = { id: "or-9", orderNumber: "ORD-000009", status: "ordered", product: old };
  const invoice = { id: "i-9", invoiceNumber: "INV-000009", lines: [{ id: "l-9", productId: old.id }] };
  ok(matchesDeep(order, "inactive-ref-777"), "INACTIVE an embedded product resolves it too (nested)");
  ok(matchesDeep(invoice, "inactive-ref-777", [old]), "INACTIVE …and as an extra (line products)");
  ok(!matchesDeep(order, "straytoken2") && !matchesDeep(invoice, "straytoken2", [old]),
    "INACTIVE …and neither form opens the undefined key");

  // Eine Kategorie-Id, die es wirklich nicht gibt, bleibt geschlossen.
  const ghost = product({ sku: "GHOST-1", categoryId: "does-not-exist", attributes: { mystery_key: "SHOULD-NOT-MATCH" } });
  ok(!matchesDeep(ghost, "should-not-match"), "UNKNOWN an unknown category opens no attribute at all");
  ok(matchesDeep(ghost, "ghost-1") && matchesDeep(ghost, "rolex") && matchesDeep(ghost, "al noor"),
    "UNKNOWN …while SKU, brand and supplier still find it");
}

// ── Lebenszyklus der Auflösung: nichts wird eingefroren ───────────────────
{
  // (a) noch nichts angemeldet — kein Absturz, keine Attribute.
  clearCategoryLookup();
  const p = product({ sku: "LC-1" });
  let threw = null;
  try { ok(!matchesDeep(p, "126334"), "LIFECYCLE before registration no attribute is searched"); }
  catch (e) { threw = e; }
  ok(threw === null, `LIFECYCLE …and nothing throws (${threw && (threw as Error).message})`);
  ok(matchesDeep(p, "lc-1"), "LIFECYCLE …while the basic fields keep working");

  // (b) angemeldet — dieselben Attribute sind sofort da.
  registerCategoryLookup((id) => (id === category.id ? (category as never) : undefined));
  ok(matchesDeep(p, "126334"), "LIFECYCLE registering the lookup makes them searchable immediately");

  // (c) die Definitionen wechseln (Neuladen, anderer Zweig): der AKTUELLE Stand entscheidet.
  // Der Store meldet eine Funktion an, die ihren Zustand bei jedem Aufruf neu liest — genau
  // das wird hier nachgestellt, damit ein eingefrorener Schnappschuss auffliegen wuerde.
  let live: unknown[] = [category];
  registerCategoryLookup((id) => (live.find((c) => (c as { id: string }).id === id) as never) ?? undefined);
  const swapped = product({ sku: "LC-2", categoryId: "cat-swap", attributes: { swap_key: "swaptoken" } });
  ok(!matchesDeep(swapped, "swaptoken"), "LIFECYCLE an unknown category stays closed");
  live = [category, { ...category, id: "cat-swap", name: "Swapped", attributes: [{ key: "swap_key", label: "Swap", type: "text" }] }];
  ok(matchesDeep(swapped, "swaptoken"), "LIFECYCLE …and after a reload the CURRENT definitions decide");
  live = [category];
  ok(!matchesDeep(swapped, "swaptoken"), "LIFECYCLE …in both directions — nothing is cached");

  registerCategoryLookup((id) => (id === category.id ? (category as never) : undefined));
}

// ── §11 die sechs Flaechen benutzen wirklich diesen einen Weg ──────────────
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
    ok(!/productBusinessSearchText|PRODUCT_SEARCH_FIELDS/.test(src),
      `WIRING ${name} keeps no product field list of its own`);
  }
  // Auswahl und Auslegung sind im Store getrennt — und nur die Auswahl ist auf aktiv gefiltert.
  const store = readFileSync(new URL('../../src/stores/productStore.ts', import.meta.url), 'utf8');
  ok(store.includes('const { schema, active } = categorySelection(rows.map(rowToCategory));')
    && store.includes('set({ categorySchema: schema, categories: active });'),
    'WIRING the store keeps all definitions but offers only active ones for selection');
  ok(store.includes('registerCategoryLookup((id) => useProductStore.getState().getCategorySchema(id));'),
    'WIRING …and the search resolves against the definitions, not against the selection list');
  ok(!/SELECT * FROM categories WHERE branch_id = ? AND active = 1/.test(store),
    'WIRING the definitions are no longer dropped at the query');
  // Keine Oberflaeche darf die Definitionsliste als Auswahl benutzen.
  for (const file of ['src/pages/watches/WatchList.tsx', 'src/pages/watches/ProductDetail.tsx', 'src/pages/settings/SettingsPage.tsx']) {
    const src = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    ok(!/categorySchema/.test(src), `WIRING ${file} does not offer the raw definitions anywhere`);
  }

  const deep = readFileSync(new URL('../../src/core/utils/deep-search.ts', import.meta.url), 'utf8');
  ok(/isProductLike\(value\)\)\s*\{[\s\S]{0,300}productBusinessSearchText\(value, own\)/.test(deep),
    'WIRING a product is searched through its business projection, not field by field');
  ok(/isCategoryLike\(value\)\) return categorySearchText\(value\)/.test(deep),
    'WIRING …and a category only through its name');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — product search: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
