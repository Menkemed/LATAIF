// ════════════════════════════════════════════════════════════════════════════
// INVENTORY METRICS — a product row is not a piece of stock.
// Run: node test/stock/inventory-metrics.test.ts
//
// The observation that started this: a shelf holds ten identical bracelets, the database holds ONE
// row with `quantity = 10`, and the screen says "1 item". The colleague's live database has exactly
// that shape — 28 rows in stock, 40 actual pieces, and a purchase value that is 265 BHD short if the
// quantity is dropped. Two different numbers were being called by the same name.
//
// So this file pins the two apart and keeps them apart:
//
//   • PRODUCT RECORDS — how many rows. A row with `quantity = 5` is one record.
//   • PHYSICAL UNITS  — how many pieces. That same row is five.
//   • STOCK VALUE     — the piece price times the pieces, or the lot's own total where lots exist.
//
// Everything is checked against the REAL functions the screens use, and against real numbers, never
// against "the helper was called".
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

// Geprueft werden die ECHTEN Funktionen aus `lot-queries`. Was dieses Modul sonst noch mitbringt —
// die Datenbank, der Ausgangskorb — wird nur gestellt, damit es ueberhaupt laedt; die Rechnung
// selbst kommt ohne beides aus (die Lot-Aggregate werden hereingereicht).
const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIM = pathToFileURL(resolvePath(repo, 'test/stock/_lot-shim.ts')).href;
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database' || specifier === '@/core/db/helpers' || specifier === '@/core/sync/sync-service') {
      return { url: SHIM, shortCircuit: true };
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

const {
  summarizeInventory, isOwnStockAsset,
} = await import('../../src/core/lots/lot-queries.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(p, 'utf8');
const round = (n: number): number => Math.round(n * 1000) / 1000;

// Der Fall aus der Anzeige: drei Datensaetze, acht Stueck, 1200 BHD.
const A = { id: 'A', purchasePrice: 100, quantity: 1, plannedSalePrice: 150, stockStatus: 'in_stock', sourceType: 'OWN' };
const B = { id: 'B', purchasePrice: 200, quantity: 5, plannedSalePrice: 300, stockStatus: 'in_stock', sourceType: 'OWN' };
const C = { id: 'C', purchasePrice: 50,  quantity: 2, plannedSalePrice: 80,  stockStatus: 'in_stock', sourceType: 'OWN' };
// Zwei Zeilen, die nach der BESTEHENDEN Bewertungsregel nicht zum eigenen Bestandsvermoegen zaehlen.
// Ihre Menge darf den Wert nicht anheben — sonst waere hier nebenbei eine neue Buchhaltung entstanden.
const D = { id: 'D', purchasePrice: 999, quantity: 7, plannedSalePrice: 999, stockStatus: 'consignment', sourceType: 'OWN' };
const E = { id: 'E', purchasePrice: 500, quantity: 3, plannedSalePrice: 600, stockStatus: 'in_stock',    sourceType: 'CONSIGNMENT' };
const ALL = [A, B, C, D, E];
const NO_LOTS = new Map();

// ── 1) Die beiden Zahlen sind verschieden, und beide sind richtig ──────────
{
  const s = summarizeInventory([A, B, C], NO_LOTS);
  ok(s.records === 3, `RECORDS three product rows stay three (${s.records})`);
  ok(s.units === 8, `UNITS …while the shelf holds eight pieces (${s.units})`);
  ok(round(s.cost) === 1200, `VALUE …worth 1200 BHD, not 350 (${round(s.cost)})`);
  ok(round(s.plannedSale) === 1810, `VALUE the planned sale value counts the pieces too (${round(s.plannedSale)})`);
  // Genau der Fehler, der auf dem Bildschirm stand: Zeilen zaehlen und Stueckpreise addieren.
  ok(s.records !== s.units, 'REGRESSION rows and pieces are not the same number — that was the bug');
  ok(round(s.cost) !== 350, 'REGRESSION …and the value is not the sum of the unit prices');
}

// ── 2) Die Bewertungsregel bleibt, wie sie war ─────────────────────────────
{
  ok(isOwnStockAsset(A) && isOwnStockAsset(B) && isOwnStockAsset(C), 'SCOPE own stock in stock counts');
  ok(!isOwnStockAsset(D), 'SCOPE a consignment-status row is not own stock');
  ok(!isOwnStockAsset(E), 'SCOPE …and neither is a consignment SOURCE');
  ok(isOwnStockAsset({ id: 'x', stockStatus: 'IN_STOCK', sourceType: 'OWN' }), 'SCOPE the upper-case spelling is the same status');
  ok(!isOwnStockAsset({ id: 'x', stockStatus: 'sold', sourceType: 'OWN' }), 'SCOPE sold stock is gone from the shelf');

  const eligible = ALL.filter(isOwnStockAsset);
  const s = summarizeInventory(eligible, NO_LOTS);
  ok(s.records === 3 && s.units === 8 && round(s.cost) === 1200,
    `SCOPE the two excluded rows raise neither count nor value (${s.records}/${s.units}/${round(s.cost)})`);
  // Und ohne den Filter waere es sichtbar anders — die Kontrolle prueft Zahlen, nicht einen Aufruf.
  const unfiltered = summarizeInventory(ALL, NO_LOTS);
  ok(unfiltered.units === 18 && round(unfiltered.cost) === 9693,
    `SCOPE dropping the eligibility really would change the numbers (${unfiltered.units}/${round(unfiltered.cost)})`);
}

// ── 3) Kein doppeltes Multiplizieren ───────────────────────────────────────
//
// Das gespeicherte Preisfeld ist ein STUECKPREIS. Wer es schon mit der Menge verrechnet bekommt und
// dann noch einmal multipliziert, bekommt B mit 25 statt 5 Stueck bezahlt.
{
  const s = summarizeInventory([B], NO_LOTS);
  ok(round(s.cost) === 1000, `UNIT the stored price is per piece: 5 x 200 = 1000 (${round(s.cost)})`);
  ok(round(s.cost) !== 5000, 'UNIT …and not 5 x 5 x 200 — the quantity is applied once');
  ok(s.units === 5 && s.units !== 25, `UNIT the piece count is applied once as well (${s.units})`);
}

// ── 4) Wo Lots existieren, gilt das Lot — nicht die Menge am Produkt ───────
//
// Ein Produkt mit Einkaufshistorie wird aus `stock_lots` bewertet. Dessen Restmenge IST die
// Stueckzahl; die Menge am Produktdatensatz darf dort nicht zusaetzlich hineinmultipliziert werden.
{
  const agg = new Map([['B', { totalQty: 4, totalValue: 810, weightedAvg: 202.5 }]]);
  const s = summarizeInventory([A, B, C], agg as never);
  ok(s.units === 1 + 4 + 2, `LOTS the lot's remaining quantity wins for that product (${s.units})`);
  ok(round(s.cost) === 100 + 810 + 100, `LOTS …and so does its own total value (${round(s.cost)})`);
  ok(round(s.cost) !== 100 + 810 * 5 + 100, 'LOTS a lot total is never multiplied by the product quantity again');
  ok(s.records === 3, 'LOTS the record count is unaffected by lots');
}

// ── 5) Fehlende, leere und unmoegliche Mengen ──────────────────────────────
//
// Die Spalte hat den Standardwert 1 und ist ganzzahlig; Altdatensaetze koennen sie leer haben. Der
// bestehende Vertrag im Haus ist `quantity || 1` — der wird hier festgehalten, nicht neu erfunden.
{
  const legacy = { id: 'L', purchasePrice: 70, stockStatus: 'in_stock', sourceType: 'OWN' };
  const zero = { id: 'Z', purchasePrice: 70, quantity: 0, stockStatus: 'in_stock', sourceType: 'OWN' };
  ok(summarizeInventory([legacy], NO_LOTS).units === 1, 'LEGACY a row without a quantity counts as one piece');
  ok(round(summarizeInventory([legacy], NO_LOTS).cost) === 70, 'LEGACY …and is worth its one price');
  ok(summarizeInventory([zero], NO_LOTS).units === 1, 'LEGACY a stored zero follows the same house rule');
  ok(summarizeInventory([], NO_LOTS).records === 0 && summarizeInventory([], NO_LOTS).units === 0,
    'LEGACY an empty shelf is zero of both');
}

// ── 6) Dieselbe Kennzahl, dieselbe Formel — an den echten Quellen ──────────
//
// Der Grund fuer diesen Abschnitt: die Zahl stand an mehreren Stellen und wurde an mehreren Stellen
// anders gerechnet. Wer sie kuenftig neu rechnet, faellt hier auf.
{
  const lots = src('src/core/lots/lot-queries.ts');
  ok(/export function summarizeInventory/.test(lots), 'WIRED there is ONE place that answers records/units/value');
  ok(/records: items\.length/.test(lots), 'WIRED …records are rows');
  ok(/units: v\.count/.test(lots) && /cost: v\.cost/.test(lots),
    'WIRED …and pieces and value come from the existing valuation, not from a second formula');

  const list = src('src/pages/watches/WatchList.tsx');
  ok(/summarizeInventory\(/.test(list), 'WIRED Collections uses it');
  ok(/summarizeInventory\(\s*filtered/.test(list), 'WIRED …over the set the page is showing, so a filter changes the totals');
  ok(!/\$\{filtered\.length\} item/.test(list), 'WIRED …and no longer calls a row an item');

  const ai = src('src/core/ai/business-tools.ts');
  ok(/summarizeInventory\(at\)/.test(ai), 'WIRED the slow-moving capital is quantity-aware');
  ok(!/at\.reduce\(\(s, p\) => s \+ \(p\.purchasePrice \|\| 0\), 0\)/.test(ai),
    'WIRED …the old sum of unit prices is gone');

  const store = src('src/stores/productStore.ts');
  ok(/isOwnStockAsset/.test(store), 'WIRED the store shares the one eligibility rule');
  const an = src('src/pages/analytics/AnalyticsPage.tsx');
  ok(/ITEMS IN STOCK[\s\S]{0,200}unit="items"/.test(an), 'WIRED Analytics labels a piece count as pieces');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — inventory metrics: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('INVENTORY_QUANTITY_RECORDS_VS_UNITS_PROVED');
