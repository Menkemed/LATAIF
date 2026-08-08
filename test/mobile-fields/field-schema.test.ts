// ════════════════════════════════════════════════════════════════════════════
// MOBILE-FIELDS — unit tests: SSOT drift guard, category→field mapping, metadata validation
// (validity + enforceRequired), numeric normalization, old-payload compatibility, attribute filtering.
// Part of the node sweep.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from '../../src/core/models/default-categories.ts';
import {
  buildMobileFieldSchema, validateMobileMetadata, filterAttributesToSchema,
  isBrandRequired, SCHEMA_VERSION, ALLOWED_TOP_KEYS,
} from '../../src/core/mobile/mobile-field-schema.ts';

let PASS = 0, FAIL = 0; const fails: string[] = [];
function ok(c: unknown, m: string) { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } }

const schema = buildMobileFieldSchema();

// ── 1) committed JSON == freshly built schema (drift guard = the "no separate field model" invariant) ──
{
  const committed = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri', 'src', 'sync', 'mobile_field_schema.json'), 'utf8'));
  ok(JSON.stringify(committed) === JSON.stringify(schema), 'committed mobile_field_schema.json matches the TS SSOT (run gen-schema.mjs if this fails)');
  ok(committed.version === SCHEMA_VERSION, 'schema version tagged');
}

// ── 2) every desktop category + attribute is represented; enums/dependsOn carried verbatim ──
{
  ok(schema.categories.length === DEFAULT_CATEGORIES.filter((c) => c.active !== false).length, 'all active categories present');
  for (const cat of DEFAULT_CATEGORIES) {
    const mc = schema.categories.find((c) => c.id === cat.id)!;
    ok(!!mc, `category ${cat.id} present`);
    ok(mc.attributes.length === cat.attributes.length, `category ${cat.id} attribute count matches SSOT`);
    for (const a of cat.attributes) {
      const ma = mc.attributes.find((x) => x.key === a.key)!;
      ok(!!ma && ma.type === a.type && !!ma.required === !!a.required, `${cat.id}.${a.key} type/required carried`);
      if (a.options) ok(JSON.stringify(ma.options) === JSON.stringify(a.options), `${cat.id}.${a.key} options carried`);
      if (a.dependsOn) ok(JSON.stringify(ma.dependsOn) === JSON.stringify(a.dependsOn), `${cat.id}.${a.key} dependsOn carried`);
    }
  }
  // brandRequired rule mirrors the desktop NewProductModal.
  ok(isBrandRequired('cat-watch') && !isBrandRequired('cat-gold-jewelry') && !isBrandRequired('cat-accessory'), 'brandRequired rule matches desktop');
}

// ── 3) validity gate (server-mirror): allow-list, category, enum, number, caps ──
{
  ok(validateMobileMetadata({ categoryId: 'cat-watch', brand: 'Rolex', name: 'Sub', sku: 'R1' }, schema).length === 0, 'minimal old payload valid (backward compat)');
  ok(validateMobileMetadata({ categoryId: 'cat-nope' }, schema).some((e) => e.code === 'UNKNOWN_CATEGORY'), 'unknown category rejected');
  ok(validateMobileMetadata({ categoryId: 'cat-watch', tenant_id: 't1' }, schema).some((e) => e.code === 'UNKNOWN_FIELD'), 'unknown top-level field rejected (mass-assignment safe)');
  ok(validateMobileMetadata({ categoryId: 'cat-watch', attributes: { weight: 5 } }, schema).some((e) => e.code === 'UNKNOWN_FIELD'), "other category's attribute rejected");
  ok(validateMobileMetadata({ categoryId: 'cat-watch', attributes: { material: 'Wood' } }, schema).some((e) => e.code === 'BAD_ENUM'), 'bad select enum rejected');
  ok(validateMobileMetadata({ categoryId: 'cat-gold-jewelry', attributes: { weight: -1 } }, schema).some((e) => e.code === 'BAD_NUMBER'), 'negative number rejected');
  ok(validateMobileMetadata({ categoryId: 'cat-gold-jewelry', attributes: { weight: Infinity as unknown as number } }, schema).some((e) => e.code === 'BAD_NUMBER'), 'non-finite number rejected');
  ok(validateMobileMetadata({ categoryId: 'cat-accessory', attributes: { description: 'x'.repeat(3000) } }, schema).some((e) => e.code === 'TOO_LONG'), 'oversized text rejected');
  ok(validateMobileMetadata({ categoryId: 'cat-watch', condition: 'Broken' }, schema).some((e) => e.code === 'BAD_ENUM'), 'bad condition rejected');
  ok(validateMobileMetadata({ categoryId: 'cat-branded-gold-jewelry', scopeOfDelivery: ['Box'] }, schema).some((e) => e.code === 'BAD_ENUM'), 'scope on a no-scope category rejected');
  ok(validateMobileMetadata({ categoryId: 'cat-watch', condition: 'Vintage', scopeOfDelivery: ['Box', 'Papers'] }, schema).length === 0, 'valid condition + scope accepted');
  // full watch payload valid
  ok(validateMobileMetadata({ categoryId: 'cat-watch', brand: 'Rolex', name: 'Sub', sku: 'R1', condition: 'Pre-Owned', scopeOfDelivery: ['Box'], attributes: { case_diameter_mm: 41, dial: 'Black', material: 'Steel', reference_number: '126610' } }, schema).length === 0, 'full watch payload valid');
}

// ── 4) enforceRequired (client-side UX rule) incl. dependsOn ──
{
  const req = validateMobileMetadata({ categoryId: 'cat-watch', attributes: {} }, schema, { enforceRequired: true });
  ok(req.some((e) => e.code === 'REQUIRED' && e.field === 'case_diameter_mm'), 'required attr flagged when enforcing');
  ok(req.some((e) => e.code === 'REQUIRED' && e.field === 'brand'), 'brand required flagged for branded category');
  // karat_color is required ONLY when material is a gold variant (dependsOn) → not flagged for Steel.
  const steel = validateMobileMetadata({ categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: { case_diameter_mm: 41, dial: 'B', material: 'Steel' } }, schema, { enforceRequired: true });
  ok(!steel.some((e) => e.field === 'karat_color'), 'dependsOn required NOT enforced when dependency unmet (Steel)');
  const gold = validateMobileMetadata({ categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: { case_diameter_mm: 41, dial: 'B', material: 'Solid Gold' } }, schema, { enforceRequired: true });
  ok(gold.some((e) => e.code === 'REQUIRED' && e.field === 'karat_color'), 'dependsOn required enforced when dependency met (Solid Gold)');
  // stale/hidden dependsOn field present when condition unmet → fail-closed STALE_FIELD (v2 parity with Rust).
  const stale = validateMobileMetadata({ categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: { case_diameter_mm: 41, dial: 'B', material: 'Steel', karat_color: '18K Yellow' } }, schema, { enforceRequired: true });
  ok(stale.some((e) => e.code === 'STALE_FIELD' && e.field === 'karat_color'), 'stale dependsOn field rejected when condition unmet');
  // v1 (no enforceRequired) stays lenient: the same minimal watch is accepted.
  ok(validateMobileMetadata({ categoryId: 'cat-watch', brand: 'R', name: 'S' }, schema).length === 0, 'v1 lenient: minimal watch accepted without required attrs');
}

// ── 5) attribute filtering (drain defense) ──
{
  const filtered = filterAttributesToSchema('cat-watch', { dial: 'Black', weight: 5, storage_key: 'x' } as never, schema);
  ok(JSON.stringify(filtered) === JSON.stringify({ dial: 'Black' }), 'filterAttributesToSchema drops keys not in the category');
  ok(Object.keys(filterAttributesToSchema('cat-nope', { a: 1 } as never, schema)).length === 0, 'filter on unknown category → empty');
}

// ── 6) allow-list is exactly the intended transport surface ──
{
  ok(JSON.stringify([...ALLOWED_TOP_KEYS].sort()) === JSON.stringify(['attributes', 'brand', 'categoryId', 'condition', 'name', 'scopeOfDelivery', 'sku']), 'allow-list top keys are exactly the parity set');
}

console.log(`\nMOBILE-FIELDS unit: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
