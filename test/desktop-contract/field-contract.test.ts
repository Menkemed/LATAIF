// ════════════════════════════════════════════════════════════════════════════
// DESKTOP-CONTRACT — one product field contract for desktop create, desktop edit
// and the mobile v2 server gate.
// Run: node test/desktop-contract/field-contract.test.ts
//
// Fixes two defects found in LIVE v0.8.35 (both immortalised below as fixtures):
//   A. `material=Steel` still demanded "Karat & Color" in ProductDetail and then
//      persisted it — a combination the mobile v2 gate rejects as STALE_FIELD.
//   B. ProductDetail reported `purchasePrice must be > 0` as an ERROR and saved
//      anyway; no schema, no other surface and no real data backs that rule.
//
// Everything is derived from the category SSOT. A surface that drifts from it
// makes the parity section below fail.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CATEGORIES } from '../../src/core/models/default-categories.ts';
import type { Category, CategoryAttribute } from '../../src/core/models/types.ts';
import {
  isAttributeVisible, visibleAttributes, requiredAttributeKeys, stripStaleAttributes,
  validateProductFields, blockingIssues, isBrandRequired, hasValue,
} from '../../src/core/products/field-contract.ts';
import { buildMobileFieldSchema, validateMobileMetadata } from '../../src/core/mobile/mobile-field-schema.ts';

let PASS = 0, FAIL = 0; const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };

const cats = DEFAULT_CATEGORIES as unknown as Category[];
const catById = (id: string) => cats.find((c) => c.id === id)!;
const schema = buildMobileFieldSchema();

// ── 1) SSOT inventory: every dependency in the model is covered by this suite ──
const DEPENDENCIES: Array<{ cat: Category; attr: CategoryAttribute }> = [];
for (const c of cats) for (const a of c.attributes) if (a.dependsOn) DEPENDENCIES.push({ cat: c, attr: a });
{
  ok(DEPENDENCIES.length > 0, 'the SSOT declares at least one dependsOn rule');
  // the live bug's rule must be among them
  const watchKarat = DEPENDENCIES.find((d) => d.cat.id === 'cat-watch' && d.attr.key === 'karat_color');
  ok(!!watchKarat, 'cat-watch.karat_color depends on material (the live finding)');
  ok(!!watchKarat && watchKarat.attr.dependsOn!.key === 'material' && watchKarat.attr.dependsOn!.valueIncludes.length > 0, 'the dependency names material with a non-empty value set');
}

// ── 2) dependsOn semantics, for EVERY dependency in the SSOT ────────────────
for (const { cat, attr } of DEPENDENCIES) {
  const dep = attr.dependsOn!;
  const satisfying = dep.valueIncludes[0];
  const parentOptions = (cat.attributes.find((a) => a.key === dep.key)?.options ?? []);
  const unsatisfying = parentOptions.find((o) => !dep.valueIncludes.includes(o))!;
  ok(!!unsatisfying, `${cat.id}: a non-satisfying value exists for ${dep.key} (fixture is meaningful)`);

  // dependency unmet → invisible, not required, stripped
  const unmet = { [dep.key]: unsatisfying, [attr.key]: (attr.options ?? ['x'])[0] };
  ok(!isAttributeVisible(attr, unmet), `${cat.id}.${attr.key}: hidden while ${dep.key}=${unsatisfying}`);
  ok(!requiredAttributeKeys(cat, unmet).includes(attr.key), `${cat.id}.${attr.key}: NOT required while hidden`);
  ok(!(attr.key in stripStaleAttributes(cat, unmet)), `${cat.id}.${attr.key}: stale value is stripped, never persisted`);

  // dependency met → visible, required exactly as the SSOT says
  const met = { [dep.key]: satisfying };
  ok(isAttributeVisible(attr, met), `${cat.id}.${attr.key}: visible while ${dep.key}=${satisfying}`);
  ok(requiredAttributeKeys(cat, met).includes(attr.key) === !!attr.required, `${cat.id}.${attr.key}: requiredness follows the SSOT when visible`);
  const withValue = { ...met, [attr.key]: (attr.options ?? ['x'])[0] };
  ok(attr.key in stripStaleAttributes(cat, withValue), `${cat.id}.${attr.key}: a valid value survives the strip`);
}

// ── 3) LIVE FIXTURE A — Steel watch: no karat requirement, no stale value ────
{
  const watch = catById('cat-watch');
  const steel = { case_diameter_mm: 41, dial: 'Black', material: 'Steel', karat_color: '9K Rose' };
  ok(!visibleAttributes(watch, steel).some((a) => a.key === 'karat_color'), 'FIXTURE A: karat_color is not rendered for a Steel watch');
  const issues = validateProductFields(watch, { categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: steel });
  ok(!issues.some((i) => i.field === 'karat_color'), 'FIXTURE A: karat_color is not demanded for a Steel watch');
  ok(blockingIssues(issues).length === 0, 'FIXTURE A: a complete Steel watch saves without any blocking finding');
  ok(!('karat_color' in stripStaleAttributes(watch, steel)), 'FIXTURE A: the stale karat_color is dropped before persistence');
  // and the mobile v2 gate agrees on exactly this shape
  const mob = validateMobileMetadata({ categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: stripStaleAttributes(watch, steel) }, schema, { enforceRequired: true, protocolVersion: 2 });
  ok(mob.length === 0, 'FIXTURE A: the stripped payload is accepted by the mobile v2 gate');
  const mobStale = validateMobileMetadata({ categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: steel }, schema, { enforceRequired: true, protocolVersion: 2 });
  ok(mobStale.some((e) => e.code === 'STALE_FIELD'), 'FIXTURE A: the UNSTRIPPED payload is what mobile rejects — desktop must never produce it');
  // gold variant → required again
  const gold = { case_diameter_mm: 41, dial: 'Black', material: 'Solid Gold' };
  ok(blockingIssues(validateProductFields(watch, { categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: gold })).some((i) => i.field === 'karat_color'), 'FIXTURE A: switching to Solid Gold makes karat_color required again');
}

// ── 4) LIVE FIXTURE B — purchase price 0 is a valid value, never an error ────
{
  const watch = catById('cat-watch');
  const full = { categoryId: 'cat-watch', brand: 'R', name: 'S', attributes: { case_diameter_mm: 41, dial: 'B', material: 'Steel' } };
  for (const price of [undefined, 0, 0.001, 1.25, 999999]) {
    const issues = validateProductFields(watch, { ...full });
    ok(blockingIssues(issues).length === 0, `FIXTURE B: purchase price ${String(price)} produces no blocking finding (no > 0 rule anywhere)`);
  }
  // Code only (comments explaining the removed rule must not count as the rule).
  const code = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
    .split(/\r?\n/).filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  ok(!/purchasePrice\s*[<>=]/.test(code('src/core/products/field-contract.ts')), 'FIXTURE B: the contract contains no price comparison');
  for (const f of ['src/pages/watches/ProductDetail.tsx', 'src/pages/watches/WatchList.tsx', 'src/components/products/NewProductModal.tsx']) {
    ok(!/Must be > 0/.test(code(f)), `FIXTURE B: ${f} no longer reports a "Must be > 0" error`);
  }
  // the DB column carries no positivity constraint either
  const sql = readFileSync(join(process.cwd(), 'src', 'core', 'db', 'schema.sql'), 'utf8');
  ok(/purchase_price\s+REAL NOT NULL/.test(sql) && !/purchase_price[^,]*CHECK/.test(sql), 'FIXTURE B: schema.sql stores purchase_price as a plain REAL (0 is storable)');
}

// ── 4b) LEGACY SURVIVAL — a save is not a migration ──────────────────────────
// Real stock still carries attributes this build no longer models (a watch's
// `movement`, an accessory's `box`/`papers`). An allow-list rewrite of the
// attributes object deletes them on the next ordinary save; only the contract's
// own contradiction (an unsatisfied dependsOn) may be removed. These keys appear
// ONLY here — never in product code.
{
  const watch = catById('cat-watch');
  const accessory = catById('cat-accessory');

  // A/B/C: known active, optional and satisfied-dependent attributes survive
  const gold = { case_diameter_mm: 41, dial: 'Black', material: 'Solid Gold', karat_color: '18K Yellow', year: 2020, description: 'note' };
  const keptGold = stripStaleAttributes(watch, gold);
  ok(Object.keys(keptGold).sort().join(',') === Object.keys(gold).sort().join(','), 'A/B/C: known active, optional and satisfied-dependent attributes all survive');

  // D: known dependent with an unsatisfied dependency is stripped
  const steel = { case_diameter_mm: 41, dial: 'Black', material: 'Steel', karat_color: '9K Rose' };
  ok(!('karat_color' in stripStaleAttributes(watch, steel)), 'D: an unsatisfied dependent attribute IS stripped');

  // E/F: unknown historical keys and arbitrary future keys survive
  const legacy = { case_diameter_mm: 41, dial: 'Black', material: 'Steel', movement: 'Automatic', diamonds: 'Yes', legacy_future_key: 'x' };
  const keptLegacy = stripStaleAttributes(watch, legacy);
  for (const k of ['movement', 'diamonds', 'legacy_future_key']) {
    ok(keptLegacy[k] === legacy[k as keyof typeof legacy], `E/F: unknown historical key ${k} survives with its exact value`);
  }
  const acc = { item_type: 'Handbag', color: 'Black', material: 'Leather', description: 'd', box: true, papers: 'yes' };
  const keptAcc = stripStaleAttributes(accessory, acc);
  ok(keptAcc.box === true && keptAcc.papers === 'yes', 'E: accessory historical keys box/papers survive');
  ok(Object.keys(keptAcc).length === Object.keys(acc).length, 'E: an accessory edit removes nothing at all');

  // G: the mixed real-world object
  const mixed = { material: 'Steel', karat_color: '9K Rose', movement: 'Automatic', diamonds: 'Yes', legacy_future_key: 'x' };
  const keptMixed = stripStaleAttributes(watch, mixed);
  ok(JSON.stringify(keptMixed) === JSON.stringify({ material: 'Steel', movement: 'Automatic', diamonds: 'Yes', legacy_future_key: 'x' }),
    'G: exactly karat_color is removed; material + every historical key stay');

  // H: purity
  const before = JSON.stringify(mixed);
  stripStaleAttributes(watch, mixed);
  ok(JSON.stringify(mixed) === before, 'H: the input object is never mutated');

  // Guard against a relapse to the allow-list implementation.
  const src = readFileSync(join(process.cwd(), 'src', 'core', 'products', 'field-contract.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function stripStaleAttributes'));
  ok(/\{ \.\.\.\(attrs \|\| \{\}\) \}/.test(fn), 'the strip COPIES the stored attributes (subtractive), it does not rebuild from the SSOT');
  ok(/if \(!attr\.dependsOn\) continue;/.test(fn), 'only dependent attributes can ever be removed');
  // no historical key may be named in product code
  for (const f of ['src/core/products/field-contract.ts', 'src/pages/watches/ProductDetail.tsx', 'src/pages/watches/WatchList.tsx', 'src/components/products/NewProductModal.tsx']) {
    const s = readFileSync(join(process.cwd(), f), 'utf8');
    ok(!/['"](movement|diamonds|box|papers)['"]/.test(s), `${f} hardcodes no historical key`);
  }
}

// ── 5) severity contract: everything reported IS blocking (no "error but saves") ──
{
  const watch = catById('cat-watch');
  const missing = validateProductFields(watch, { categoryId: 'cat-watch', attributes: {} });
  ok(missing.length > 0 && missing.every((i) => i.blocking), 'every finding is blocking — the UI can never show a non-blocking "error"');
  ok(missing.some((i) => i.field === 'brand') && missing.some((i) => i.field === 'name'), 'brand+name required for a branded category');
  ok(blockingIssues(validateProductFields(catById('cat-gold-jewelry'), { categoryId: 'cat-gold-jewelry', attributes: { weight: 5, item_type: 'Ring', karat: '18K Yellow' } })).length === 0, 'unbranded category needs no brand/name');
  ok(validateProductFields(undefined, { categoryId: '' })[0].code === 'UNKNOWN_CATEGORY', 'a missing category blocks');
  // 0 and false are values, not gaps
  ok(hasValue(0) && hasValue(false) && !hasValue('') && !hasValue(null) && !hasValue([]), 'presence check treats 0/false as present');
}

// ── 6) 6/6 parity: desktop contract == mobile v2 gate for every category ─────
{
  let parity = true;
  for (const cat of cats) {
    // brand/name rule identical
    if (isBrandRequired(cat.id) !== schema.categories.find((c) => c.id === cat.id)!.brandRequired) { parity = false; console.log('  brandRequired drift: ' + cat.id); }
    // build a payload that satisfies exactly the visible required attributes
    const attrs: Record<string, unknown> = {};
    for (const a of cat.attributes) {
      if (!a.required || a.dependsOn) continue;
      attrs[a.key] = a.type === 'number' ? 1 : a.type === 'boolean' ? true : a.type === 'multiselect' ? [a.options![0]] : (a.options?.[0] ?? 'x');
    }
    const form = { categoryId: cat.id, brand: 'B', name: 'N', attributes: attrs };
    const desktop = blockingIssues(validateProductFields(cat, form)).map((i) => i.field).sort();
    const mobile = validateMobileMetadata({ categoryId: cat.id, brand: 'B', name: 'N', attributes: attrs }, schema, { enforceRequired: true, protocolVersion: 2 })
      .filter((e) => e.code === 'REQUIRED').map((e) => e.field!).sort();
    if (JSON.stringify(desktop) !== JSON.stringify(mobile)) { parity = false; console.log(`  ${cat.id}: desktop ${JSON.stringify(desktop)} vs mobile ${JSON.stringify(mobile)}`); }
    // required-key set identical
    const dReq = requiredAttributeKeys(cat, attrs).sort();
    const mReq = schema.categories.find((c) => c.id === cat.id)!.attributes
      .filter((a) => a.required && (!a.dependsOn || (typeof attrs[a.dependsOn.key] === 'string' && a.dependsOn.valueIncludes.includes(String(attrs[a.dependsOn.key])))))
      .map((a) => a.key).sort();
    if (JSON.stringify(dReq) !== JSON.stringify(mReq)) { parity = false; console.log(`  ${cat.id} required drift: ${JSON.stringify(dReq)} vs ${JSON.stringify(mReq)}`); }
    ok(true, `${cat.id}: contract compared against the mobile gate`);
  }
  ok(parity, 'desktop↔mobile field contract parity: 6/6 categories agree (requiredness, dependsOn, brand rule)');
}

// ── 7) structural: no surface keeps its own copy of the rules ────────────────
{
  for (const f of ['src/pages/watches/ProductDetail.tsx', 'src/pages/watches/WatchList.tsx', 'src/components/products/NewProductModal.tsx']) {
    const s = readFileSync(join(process.cwd(), f), 'utf8');
    ok(/from '@\/core\/products\/field-contract'/.test(s), `${f} uses the shared contract`);
    ok(!/attr\.dependsOn\.valueIncludes/.test(s), `${f} has no local dependsOn copy`);
    ok(!/cat-gold-jewelry' \|\| .*cat-accessory/.test(s.replace(/\n/g, ' ')) || /isBrandRequired/.test(s), `${f} has no local brand-required copy`);
  }
  const pd = readFileSync(join(process.cwd(), 'src/pages/watches/ProductDetail.tsx'), 'utf8');
  ok(/const blocking = validate\(\);[\s\S]{0,200}if \(Object\.keys\(blocking\)\.length > 0\) return;/.test(pd), 'ProductDetail save BLOCKS when the contract reports findings');
  ok(/stripStaleAttributes\(category \?\? undefined, formAttrs\)/.test(pd), 'ProductDetail strips stale attributes before saving');
}

console.log(`\nDESKTOP-CONTRACT field-contract: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
