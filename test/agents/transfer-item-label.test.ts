// Approval-Transfer — Beschriftung eines Stücks in der Meldung eines Sammeltransfers (transfer-item-label.ts).
// Regel: SKU, sonst der zentrale Anzeigename (Marke + Modell, sonst Merkmale, sonst Kategorie), sonst die Kennung.
// Run: node test/agents/transfer-item-label.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transferItemLabel } from '../../src/core/agents/transfer-item-label.ts';
import { productDisplayName } from '../../src/core/products/display-name.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log('  ✗ ' + m); } };
const ID = 'b34529ca-7c4b-42bc-9a1e-57eb95548266';

// ── Reihenfolge SKU → Anzeigename → Kennung ─────────────────────────────────
ok(transferItemLabel({ sku: 'CAR-OGJ-001', brand: 'Cartier', name: 'Love' }, ID) === 'CAR-OGJ-001', 'SKU vor allem anderen');
ok(transferItemLabel({ sku: '', brand: 'Rolex', name: 'Datejust 36' }, ID) === 'Rolex Datejust 36', 'ohne SKU: Marke + Modell (wie bisher)');
ok(transferItemLabel({ sku: null, brand: 'Rolex', name: null }, ID) === 'Rolex', 'nur Marke');
ok(transferItemLabel({ sku: null, brand: '', name: 'Datejust 36' }, ID) === 'Datejust 36', 'nur Modell');
ok(transferItemLabel({ sku: '   ', brand: 'Rolex', name: 'Datejust' }, ID) === 'Rolex Datejust', 'SKU nur aus Leerzeichen zählt nicht');
ok(transferItemLabel({ sku: null, brand: '  ', name: '  ', attributes: JSON.stringify({ item_type: 'Ring', karat: '18K White', weight: 3.1 }) }, ID)
  === 'Ring · 18K White Gold · 3.10 g', 'leere Marke/Modell (nur Leerzeichen) → Name aus den Merkmalen');
ok(transferItemLabel({ sku: null, brand: null, name: null, attributes: { item_type: 'Bangle', description: 'Love Bracelet' } }, ID) === 'Bangle · Love Bracelet',
  'Merkmale als Objekt');
ok(transferItemLabel({ sku: null, brand: null, name: null, attributes: '{kaputt' }, ID) === ID, 'unlesbare Merkmale, nichts sonst → Kennung');
ok(transferItemLabel({ sku: null, brand: null, name: null, attributes: null, category_id: null }, ID) === ID, 'alles leer → Kennung (nie leerer Text)');
ok(transferItemLabel(undefined, ID) === ID, 'Artikel nicht gefunden → Kennung');
// Dieselbe Regel wie der zentrale Anzeigename (keine zweite Zusammensetzung)
for (const p of [{ brand: 'Patek Philippe', name: 'Nautilus' }, { brand: '', name: '', attributes: { item_type: 'Pendant', description: 'Emerald' } }]) {
  ok(transferItemLabel(p, ID) === productDisplayName(p), `gleich productDisplayName (${productDisplayName(p)})`);
}

// ── transfer-house nutzt genau diese Funktion, keine eigene Zusammensetzung mehr ─────────
const th = readFileSync(join(repo, 'src/core/agents/transfer-house.ts'), 'utf8');
ok(/function stueckName\(productId: string\): string \{\s*const p = query\('SELECT sku, brand, name, category_id, attributes FROM products WHERE id = \?', \[productId\]\)\[0\];\s*return transferItemLabel\(p, productId\);\s*\}/.test(th),
  'transfer-house: stueckName = transferItemLabel (nur lesend, nur für die Meldung)');
ok(!/\[p\.brand, p\.name\]\.filter\(Boolean\)\.join/.test(th), 'transfer-house: keine eigene „Marke + Modell"-Zusammensetzung mehr');

console.log(`\nTRANSFER-ITEM-LABEL: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
