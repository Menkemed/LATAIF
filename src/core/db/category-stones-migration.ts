import type { Database } from 'sql.js';
import { DEFAULT_CATEGORIES } from '../models/default-categories.ts';

// STONES (v0.8.68) — die Kategorie Gold-Diamond Jewellery bekommt die Steinliste. Idempotent: fehlt das
// Merkmal `stones`, wird es direkt nach `diamond_weight` eingefügt, sonst bleibt alles, wie es ist.
// Produktdaten werden NICHT angefasst — ein Diamond Weight älterer Artikel bleibt stehen, und aus ihm
// wird keine Steinzeile erfunden (src/core/products/stones.ts).
export function migrateCategoryStonesV1(database: Database): void {
  try {
    const r = database.exec("SELECT attributes FROM categories WHERE id = 'cat-gold-jewelry'");
    if (!r.length || !r[0].values.length) return;
    const attrs = JSON.parse(String(r[0].values[0][0] || '[]')) as Array<{ key?: string }>;
    if (!Array.isArray(attrs) || attrs.some((a) => a && a.key === 'stones')) return;
    const def = DEFAULT_CATEGORIES.find((c) => c.id === 'cat-gold-jewelry')?.attributes.find((a) => a.key === 'stones');
    if (!def) return;
    const i = attrs.findIndex((a) => a && a.key === 'diamond_weight');
    attrs.splice(i >= 0 ? i + 1 : attrs.length, 0, def);
    database.run("UPDATE categories SET attributes = ?, updated_at = ? WHERE id = 'cat-gold-jewelry'", [JSON.stringify(attrs), new Date().toISOString()]);
  } catch (err) {
    console.warn('[Migration] category stones failed:', err);
  }
}
