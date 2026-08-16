// ════════════════════════════════════════════════════════════════════════════
// RELEASE-ADDITIONS D — AI Identify on an EXISTING product is a recognition step, nothing else.
// Run: node test/items/ai-edit-merge.test.ts
//
// The reported behaviour was that identifying an item in the edit dialog could fill in prices and,
// sometimes, lose the photo. Both had concrete causes:
//
//   • prices: the merge tested `!f.purchasePrice`, and `purchasePrice` is `0` on a large share of
//     real stock (the mobile drain writes 0 for an unknown cost, and 0 is a valid price). `!0` is
//     true, so a model's guess replaced a real figure.
//   • the photo: identifying could not touch media directly, but a store reload during the request
//     reset the whole form from `product` — and a gallery-backed product's `product.images` is `[]`,
//     so the seeded image draft went empty and the next save reconciled the gallery to nothing.
//
// This gate covers the first cause and the merge contract; the second is fixed by not resetting the
// form while editing, and is asserted structurally at the bottom.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AI_EDIT_FORBIDDEN_FIELDS, buildAiAttributePatch, buildAiFormPatch, isAiForbiddenEditField, isRecognised,
} from '../../src/core/ai/edit-merge.ts';
import type { AiProductIdentification } from '../../src/core/ai/ai-service.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

/** Every price/cost column the product form really carries — read from the type, not from memory. */
const PRICE_FIELDS = [
  'purchasePrice', 'plannedSalePrice', 'minSalePrice', 'maxSalePrice',
  'lastOfferPrice', 'lastSalePrice', 'purchaseCurrency', 'expectedMargin',
];

const FULL_AI: AiProductIdentification = {
  brand: 'Rolex', name: 'Submariner Date',
  sku: 'RLX-SUB-9', condition: 'Pre-Owned', description: 'Steel diver, ceramic bezel.',
  estimatedValue: 999, purchasePriceEstimate: 888, minSalePrice: 777, maxSalePrice: 1111,
  scopeOfDelivery: ['Box', 'Papers'], taxScheme: 'VAT_10', storageLocation: 'Safe A',
  attributes: { dial: 'Black', material: 'Steel', case_diameter_mm: 41 },
};

// ════════════════════════════════════════════════════════════════════════════
// §11 — the price list is derived from the REAL Product type, not from memory
// ════════════════════════════════════════════════════════════════════════════
{
  const types = readFileSync(join(REPO, 'src/core/models/types.ts'), 'utf8');
  const start = types.indexOf('export interface Product ');
  const product = types.slice(start, types.indexOf('\n}', start));
  const declared = [...product.matchAll(/^\s*([a-zA-Z]*(?:Price|Currency|Margin))\??:/gm)].map((m) => m[1]);
  ok(declared.length >= 6, `§11 the Product type declares money fields (${declared.join(', ')})`);
  for (const f of declared) {
    ok(isAiForbiddenEditField(f), `§11 ${f} — a real money field of Product — is on the forbidden list`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// §18/§27 — prices are never written in edit mode
// ════════════════════════════════════════════════════════════════════════════
{
  // The exact reported case: an existing price is kept.
  const withPrices = { purchasePrice: 123, plannedSalePrice: 456, minSalePrice: 200, maxSalePrice: 900 };
  const patch = buildAiFormPatch(FULL_AI, withPrices, { mode: 'edit' });
  for (const f of PRICE_FIELDS) ok(!(f in patch), `§18 ${f} is absent from the edit patch (existing value survives)`);

  // The case the old code got wrong: purchasePrice === 0 is REAL, not "empty".
  const zeroCost = { purchasePrice: 0 };
  const zeroPatch = buildAiFormPatch(FULL_AI, zeroCost, { mode: 'edit' });
  ok(!('purchasePrice' in zeroPatch), '§18 a purchase price of 0 is a real value and is not overwritten (the exact old defect)');

  // And an empty price stays empty — the spec is explicit that AI must not fill it.
  const noPrices = { brand: 'Rolex' };
  const emptyPatch = buildAiFormPatch(FULL_AI, noPrices, { mode: 'edit' });
  for (const f of PRICE_FIELDS) ok(!(f in emptyPatch), `§18 ${f} stays empty rather than being filled by AI`);

  // Every price column is named in the forbidden map, so the intent is data and greppable.
  for (const f of PRICE_FIELDS) ok(isAiForbiddenEditField(f), `§18 ${f} is declared forbidden with a reason`);
  ok(Object.values(AI_EDIT_FORBIDDEN_FIELDS).every((r) => typeof r === 'string' && r.length > 20),
    '§18 every forbidden field carries a real explanation, not a label');
}

// ════════════════════════════════════════════════════════════════════════════
// §17/§30 — media, quantity and system fields are untouchable in BOTH modes
// ════════════════════════════════════════════════════════════════════════════
{
  const hostile = {
    ...FULL_AI,
    // A response that carries far more than the contract allows.
    images: ['data:image/jpeg;base64,AAAA'],
    quantity: 99,
    id: 'other-product', branchId: 'other-branch', categoryId: 'cat-accessory',
    createdAt: '1999-01-01', updatedAt: '1999-01-01', version: 42, syncStatus: 'pending',
    stockStatus: 'sold', daysInStock: 500, totallyUnknownKey: 'x',
  } as unknown as AiProductIdentification;

  for (const mode of ['edit', 'create'] as const) {
    const patch = buildAiFormPatch(hostile, { purchasePrice: 5, images: ['keep-me'], quantity: 3 }, { mode });
    for (const f of ['images', 'quantity', 'id', 'branchId', 'categoryId', 'createdAt', 'updatedAt', 'version', 'syncStatus', 'stockStatus', 'daysInStock', 'totallyUnknownKey']) {
      ok(!(f in patch), `§30 [${mode}] ${f} never reaches the form`);
    }
  }
  ok(isAiForbiddenEditField('images') && isAiForbiddenEditField('quantity') && isAiForbiddenEditField('categoryId'),
    '§23/§30 media, inventory and category are declared forbidden');
}

// ════════════════════════════════════════════════════════════════════════════
// §19/§21/§28 — what the model does NOT know never deletes what is there
// ════════════════════════════════════════════════════════════════════════════
{
  const existing = { brand: 'Rolex', name: 'Submariner', sku: 'ABC', condition: 'Vintage', notes: 'bought in Basel', storageLocation: 'Safe B' };
  for (const blank of [undefined, null, '', '   '] as unknown[]) {
    const patch = buildAiFormPatch(
      { attributes: {}, brand: blank, name: blank, sku: blank, condition: blank, description: blank, storageLocation: blank } as unknown as AiProductIdentification,
      existing, { mode: 'edit' },
    );
    ok(Object.keys(patch).length === 0, `§19 an answer of ${JSON.stringify(blank)} produces an EMPTY patch — nothing is cleared`);
  }
  ok(isRecognised('x') && isRecognised(0) && isRecognised(false) && isRecognised(['a']), '§19 0 and false ARE recognised values');
  ok(!isRecognised('') && !isRecognised('  ') && !isRecognised(null) && !isRecognised(undefined) && !isRecognised([]) && !isRecognised(Number.NaN),
    '§21 blank, missing and NaN all mean "did not know"');

  // §28 — a serial the model could not read must leave the stored one alone.
  const attrPatch = buildAiAttributePatch(
    { attributes: { serial_number: '', dial: 'Blue' } } as unknown as AiProductIdentification,
    ['serial_number', 'dial', 'material'],
  );
  ok(!('serial_number' in attrPatch), '§28 an unrecognised serial does not overwrite the stored one');
  ok(attrPatch.dial === 'Blue', '§28 …while a recognised attribute is applied');
}

// ════════════════════════════════════════════════════════════════════════════
// §20/§29 — only allow-listed, category-known fields are merged
// ════════════════════════════════════════════════════════════════════════════
{
  const patch = buildAiFormPatch(FULL_AI, {}, { mode: 'edit' });
  ok(patch.brand === 'Rolex' && patch.name === 'Submariner Date', '§29 a recognised brand/name is applied — that is what identify is for');
  ok(patch.condition === 'Pre-Owned' && patch.storageLocation === 'Safe A' && patch.taxScheme === 'VAT_10', '§20 operator gaps are filled');
  ok(JSON.stringify(patch.scopeOfDelivery) === JSON.stringify(['Box', 'Papers']), '§20 the included set is filled when empty');

  // The AI does not name products. `FULL_AI` carries `sku: 'RLX-SUB-9'`, and an empty SKU field is
  // exactly the situation where it used to be taken — on an existing item that rewrote a number the
  // business already prints on labels, and on a new one it went round the counter both surfaces
  // share. It is out of the patch entirely, not merely filtered.
  ok(!('sku' in patch), 'the AI never proposes a SKU, not even into an empty field');

  // …and a decision the operator already made is NOT overwritten.
  const decided = { sku: 'MINE-1', condition: 'Unworn', storageLocation: 'Display', taxScheme: 'MARGIN', scopeOfDelivery: ['Box'] };
  const p2 = buildAiFormPatch(FULL_AI, decided, { mode: 'edit' });
  for (const f of ['sku', 'condition', 'storageLocation', 'taxScheme', 'scopeOfDelivery']) {
    ok(!(f in p2), `§29 ${f} is an operator decision once made and is not replaced`);
  }

  // The live case: a Rolex already carrying a legacy number, identified again. Whatever the model
  // says, the number the shelf uses has to come back out of the merge byte for byte.
  const legacy = { brand: 'Rolex', name: 'Datejust 36', sku: 'RLX-DJ36-001' };
  const merged = { ...legacy, ...buildAiFormPatch(FULL_AI, legacy, { mode: 'edit' }) };
  ok(merged.sku === 'RLX-DJ36-001', 'an existing legacy SKU survives AI Identify unchanged (' + merged.sku + ')');
  ok(!('sku' in buildAiFormPatch(FULL_AI, legacy, { mode: 'create' })), 'and the create mode does not propose one either');

  // §24 — description is additive; an existing one is never replaced or emptied.
  const withNotes = buildAiFormPatch(FULL_AI, { notes: 'seen at auction' }, { mode: 'edit' });
  ok(String(withNotes.notes).startsWith('seen at auction'), '§24 the existing description is kept');
  ok(String(withNotes.notes).includes('Steel diver'), '§24 …and the recognised text is appended');
  const noDesc = buildAiFormPatch({ ...FULL_AI, description: '' }, { notes: 'seen at auction' }, { mode: 'edit' });
  ok(!('notes' in noDesc), '§24 an unsure answer cannot blank an existing description');

  // Attributes: only keys the CURRENT category declares.
  const attrs = buildAiAttributePatch(FULL_AI, ['dial', 'material']);
  ok(attrs.dial === 'Black' && attrs.material === 'Steel', '§20 known attributes are merged');
  ok(!('case_diameter_mm' in attrs), '§23 a key the current category does not declare is dropped, not written as a stale field');
}

// ════════════════════════════════════════════════════════════════════════════
// §25 — create keeps its price estimates; edit does not
// ════════════════════════════════════════════════════════════════════════════
{
  const createPatch = buildAiFormPatch(FULL_AI, {}, { mode: 'create' });
  ok(createPatch.plannedSalePrice === 999 && createPatch.purchasePrice === 888, '§25 CREATE still fills prices from an estimate');
  ok(createPatch.minSalePrice === 777 && createPatch.maxSalePrice === 1111, '§25 …including min/max');
  const createWithPrices = buildAiFormPatch(FULL_AI, { purchasePrice: 5, plannedSalePrice: 6 }, { mode: 'create' });
  ok(!('purchasePrice' in createWithPrices) && !('plannedSalePrice' in createWithPrices),
    '§25 …but even in create an already-entered price is never replaced');
  const editPatch = buildAiFormPatch(FULL_AI, {}, { mode: 'edit' });
  ok(!('plannedSalePrice' in editPatch) && !('purchasePrice' in editPatch), '§25 EDIT never fills a price');
}

// ════════════════════════════════════════════════════════════════════════════
// §22/§17 — the patch shape, and the form reset that used to eat the image draft
// ════════════════════════════════════════════════════════════════════════════
{
  // A patch is spread onto the CURRENT state by the caller, so a value typed while the request was
  // in flight survives. Simulate exactly that.
  // The production shape is `setForm(f => ({ ...f, ...buildAiFormPatch(result, f, …) }))`: the patch is
  // computed against the state as it is WHEN THE ANSWER LANDS, not against a snapshot captured at
  // click time. That is what makes a gap-filler correct — the gap is re-tested against what the user
  // has since typed.
  const atClickTime = { brand: 'Rolex', name: 'Sub', notes: '' };
  const typedMeanwhile = { ...atClickTime, storageLocation: 'Vault 9', purchasePrice: 4200 };
  const applyLikeProduction = (current: Record<string, unknown>) =>
    ({ ...current, ...buildAiFormPatch(FULL_AI, current, { mode: 'edit' }) });
  const merged = applyLikeProduction(typedMeanwhile);
  ok(merged.purchasePrice === 4200, '§22 a price typed during the request survives the merge');
  ok(merged.storageLocation === 'Vault 9', '§22 …and a storage location typed during it is not overwritten by a gap-filler');
  ok(merged.brand === 'Rolex' && merged.name === 'Submariner Date', '§22 …while the recognised identity is still applied');
  // Against the STALE snapshot the same gap-filler would have clobbered it — which is exactly why the
  // dialog must pass the live state and never a captured one.
  const stalePatch = buildAiFormPatch(FULL_AI, atClickTime, { mode: 'edit' });
  ok(stalePatch.storageLocation === 'Safe A', '§22 (a snapshot-based merge WOULD have overwritten it — the reason the live state is used)');
  ok(!('images' in merged), '§17 the merged form carries no image key from AI at all');

  // §17 — the structural half of the media fix: the edit dialog must not reset its form from the
  // store while editing. That reset is what emptied the seeded gallery draft (`product.images` is
  // `[]` for a gallery product) and made the following save retire every link.
  const src = readFileSync(join(REPO, 'src/pages/watches/ProductDetail.tsx'), 'utf8');
  ok(/editing && draftSeeded \? \{ \.\.\.product, images: f\.images \} : \{ \.\.\.product \}/.test(src),
    '§17 the product→form re-sync PRESERVES a SEEDED image draft instead of resetting it to product.images');
  ok(/}, \[product, editing, draftSeeded\]\);/.test(src),
    '§17 …and re-runs when edit mode or the seed state changes, so read mode still mirrors the store');
  ok(/buildAiFormPatch\(result/.test(src) && /buildAiAttributePatch\(result/.test(src),
    '§16 the edit dialog merges through the ONE contract, not a private if-chain');
  ok(!/updated\.purchasePrice = result\.purchasePriceEstimate/.test(src), '§18 the old price-filling chain is gone from the dialog');
  ok(!/setForm\(aiResult\)|setForm\(result\)/.test(src), '§19 the dialog never replaces the whole form with an AI answer');
}

console.log(`\nai-edit-merge: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
