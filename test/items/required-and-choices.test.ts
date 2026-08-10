// ════════════════════════════════════════════════════════════════════════════
// RELEASE-ADDITIONS B + C — clearable choice fields and the three requiredness changes.
// Run: node test/items/required-and-choices.test.ts
//
// Both features are about the SAME single source of truth. Requiredness lives in
// `default-categories.ts` and is read through `field-contract.ts`; "can I unselect this" is a
// property of the control, not of the contract. The two are deliberately independent here:
// a required field must stay clearable in the UI and must still block the save.
// ════════════════════════════════════════════════════════════════════════════

import { DEFAULT_CATEGORIES } from '../../src/core/models/default-categories.ts';
import {
  requiredAttributeKeys, stripStaleAttributes, validateProductFields, visibleAttributes,
} from '../../src/core/products/field-contract.ts';
import { applyChoiceSelection, clearsChoice, isSameChoice, toggleChoice } from '../../src/core/products/choice-value.ts';
import type { Category } from '../../src/core/models/types.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

const cat = (id: string) => DEFAULT_CATEGORIES.find((c) => c.id === id) as unknown as Category;
const WATCH = cat('cat-watch');
const BRANDED = cat('cat-branded-gold-jewelry');
const ACCESSORY = cat('cat-accessory');
const attrOf = (c: Category, key: string) => c.attributes.find((a) => a.key === key);

// ════════════════════════════════════════════════════════════════════════════
// C — exactly three fields became optional, and nothing else moved
// ════════════════════════════════════════════════════════════════════════════
{
  const THE_THREE: Array<[Category, string, string]> = [
    [WATCH, 'case_diameter_mm', 'Watch → Case Diameter'],
    [BRANDED, 'size', 'Branded Gold Jewelry → Size'],
    [ACCESSORY, 'description', 'Accessory → Description'],
  ];
  for (const [c, key, label] of THE_THREE) {
    const a = attrOf(c, key);
    ok(a !== undefined, `§13 ${label} still exists in the SSOT (only its requiredness changed)`);
    ok(a?.required === false, `§13 ${label} is OPTIONAL`);
    // The whole point of a single source: the contract must AGREE without a second list.
    ok(!requiredAttributeKeys(c, {}).includes(key), `§14 ${label} is not demanded by the field contract`);
  }

  // A save with none of the three set must produce no finding for them.
  const watchIssues = validateProductFields(WATCH, {
    categoryId: WATCH.id, brand: 'Rolex', name: 'Submariner',
    attributes: { dial: 'Black', material: 'Steel' },
  });
  ok(watchIssues.length === 0, `§14 a watch saves without a case diameter (${watchIssues.map((i) => i.field).join(', ') || 'no issues'})`);

  const brandedIssues = validateProductFields(BRANDED, {
    categoryId: BRANDED.id, brand: 'Cartier', name: 'Love',
    attributes: { item_type: 'Bracelet', karat: '18K Yellow' },
  });
  ok(brandedIssues.length === 0, `§14 a branded piece saves without a size (${brandedIssues.map((i) => i.field).join(', ') || 'no issues'})`);

  const accIssues = validateProductFields(ACCESSORY, {
    categoryId: ACCESSORY.id, brand: 'Hermès', name: 'Birkin',
    attributes: { item_type: 'Handbag', color: 'Black', material: 'Leather' },
  });
  ok(accIssues.length === 0, `§14 an accessory saves without a description (${accIssues.map((i) => i.field).join(', ') || 'no issues'})`);

  // …and a value may still be stored, and may still be cleared and stored as cleared.
  ok(validateProductFields(WATCH, { categoryId: WATCH.id, brand: 'R', name: 'S', attributes: { dial: 'B', material: 'Steel', case_diameter_mm: 41 } }).length === 0,
    '§14 the optional field still accepts a value');
  ok(!('case_diameter_mm' in applyChoiceSelection({ case_diameter_mm: 41 }, 'case_diameter_mm', 41)),
    '§14 …and clearing that value is itself savable');

  // ── §15: NO other requiredness drifted. The full expected map, asserted exactly. ──
  const EXPECTED: Record<string, string[]> = {
    'cat-watch': ['dial', 'material', 'karat_color'],
    'cat-gold-jewelry': ['weight', 'item_type', 'karat'],
    'cat-branded-gold-jewelry': ['item_type', 'karat'],
    'cat-original-gold-jewelry': ['item_type', 'karat'],
    'cat-accessory': ['item_type', 'color', 'material'],
    'cat-spare-part': ['part_type', 'material', 'original_or_copy', 'description'],
  };
  ok(Object.keys(EXPECTED).length === DEFAULT_CATEGORIES.length, '§15 every category is covered by the expectation');
  for (const c of DEFAULT_CATEGORIES) {
    const actual = c.attributes.filter((a) => a.required).map((a) => a.key).sort();
    const expected = [...(EXPECTED[c.id] ?? [])].sort();
    ok(JSON.stringify(actual) === JSON.stringify(expected),
      `§15 ${c.id} requires exactly [${expected.join(', ')}] (got [${actual.join(', ')}])`);
  }
  // The Spare Part description is a DIFFERENT field from the Accessory one and must NOT have moved.
  ok(attrOf(cat('cat-spare-part'), 'description')?.required === true,
    '§15 the Spare Part description is still required — the change was scoped to Accessories');
  ok(attrOf(cat('cat-original-gold-jewelry'), 'size')?.required === false,
    '§15 Original Gold Jewelry size was already optional and is unchanged');
}

// ════════════════════════════════════════════════════════════════════════════
// B — a chosen option can be un-chosen
// ════════════════════════════════════════════════════════════════════════════
{
  ok(isSameChoice('Steel', 'Steel') && !isSameChoice('Steel', 'Gold'), '§9 same/different choices compare by value');
  ok(isSameChoice(41, '41'), '§9 a numeric option that round-tripped through a form still matches');
  ok(!isSameChoice(undefined, 'Steel') && !isSameChoice(null, 'Steel'), '§9 nothing selected never equals an option');

  ok(toggleChoice('Steel', 'Steel') === undefined, '§9 clicking the selected option clears it');
  ok(toggleChoice('Steel', 'Gold') === 'Gold', '§9 clicking another option selects it');
  ok(toggleChoice(undefined, 'Steel') === 'Steel', '§9 clicking from empty selects');

  // The attribute form: the key is REMOVED, never blanked.
  const withValue = { material: 'Solid Gold', dial: 'Black' };
  const cleared = applyChoiceSelection(withValue, 'material', 'Solid Gold');
  ok(!('material' in cleared), '§10 clearing DELETES the key — no stale key with a fake empty value');
  ok(cleared.dial === 'Black', '§10 …and touches nothing else');
  ok(JSON.stringify(withValue) === JSON.stringify({ material: 'Solid Gold', dial: 'Black' }), '§10 the input object is never mutated');
  ok(applyChoiceSelection(withValue, 'material', 'Steel').material === 'Steel', '§9 switching to another option assigns it');
  ok(applyChoiceSelection(undefined, 'material', 'Steel').material === 'Steel', '§9 works from an empty attributes object');
  ok(clearsChoice(withValue, 'material', 'Solid Gold') && !clearsChoice(withValue, 'material', 'Steel'),
    '§9 the caller can tell a clear from a change');

  // Booleans clear too — the Yes/No toggle had exactly the same one-way problem.
  ok(!('has_box' in applyChoiceSelection({ has_box: true }, 'has_box', true)), '§8 a Yes/No toggle can be un-answered');
  ok(applyChoiceSelection({ has_box: true }, 'has_box', false).has_box === false, '§8 …and switching to No still works');

  // ── §9: clearable ≠ optional. A REQUIRED field is clearable in the UI and blocks the save. ──
  const clearedDial = applyChoiceSelection({ dial: 'Black', material: 'Steel' }, 'dial', 'Black');
  ok(!('dial' in clearedDial), '§9 a REQUIRED attribute can be cleared in the form');
  const issues = validateProductFields(WATCH, { categoryId: WATCH.id, brand: 'R', name: 'S', attributes: clearedDial });
  ok(issues.some((i) => i.field === 'dial' && i.blocking), '§9 …and the save is then correctly blocked');
  ok(validateProductFields(WATCH, { categoryId: WATCH.id, brand: 'R', name: 'S', attributes: { dial: 'Black', material: 'Steel' } }).length === 0,
    '§9 …while the same form with the value saves');

  // ── §11: dependsOn. karat_color appears for gold, can be cleared, and blocks while visible. ──
  const gold = { material: 'Solid Gold', dial: 'Black', karat_color: '18K Yellow' };
  ok(visibleAttributes(WATCH, gold).some((a) => a.key === 'karat_color'), '§11 karat_color is visible for Solid Gold');
  const goldCleared = applyChoiceSelection(gold, 'karat_color', '18K Yellow');
  ok(!('karat_color' in goldCleared), '§11 …and the user can clear it again');
  ok(validateProductFields(WATCH, { categoryId: WATCH.id, brand: 'R', name: 'S', attributes: goldCleared }).some((i) => i.field === 'karat_color'),
    '§11 …with the save correctly blocked while the dependency still holds');

  // Switching the parent back to Steel must still strip the stale child (the v0.8.36 behaviour).
  const backToSteel = applyChoiceSelection(gold, 'material', 'Steel');
  ok(backToSteel.material === 'Steel', '§11 material switched');
  const stripped = stripStaleAttributes(WATCH, backToSteel);
  ok(!('karat_color' in stripped), '§11 the stale karat_color is still stripped — no regression from v0.8.36');
  ok(stripped.dial === 'Black', '§11 …and unrelated attributes survive the strip');
  // Clearing the PARENT entirely also hides the child, and the child must not then be demanded.
  const noMaterial = applyChoiceSelection(gold, 'material', 'Solid Gold');
  ok(!('material' in noMaterial), '§11 the parent select can be cleared too');
  ok(!requiredAttributeKeys(WATCH, noMaterial).includes('karat_color'),
    '§11 a hidden dependent field is never required (it has no visible parent value)');
  ok(!('karat_color' in stripStaleAttributes(WATCH, noMaterial)), '§11 …and is stripped on save');
}

console.log(`\nrequired-and-choices: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
