// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1B §1/§2 — the extracted AI contract must reproduce v0.8.37 exactly.
// Run: node test/ai/identify-contract-parity.test.ts
//
// The desktop identify path is live-validated. Moving its prompt into a shared SSOT is therefore
// only acceptable if the assembled text is IDENTICAL — so this gate rebuilds the prompt from the
// RELEASED source (`git show ff038ad:src/core/ai/ai-service.ts`) and compares it, character for
// character, with what `identify-prompt.ts` now produces for every category.
//
// It is not a snapshot of our own output: the reference comes from the released commit, so nobody
// can "fix" a drift by re-recording the golden file.
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import {
  buildSystemPrompt, buildUserPrompt, knownCategoryIds, categorySpec,
  contractFingerprint, fnv1a64, MOBILE_ALLOWED_FIELDS, MOBILE_FORBIDDEN_FIELDS,
} from '../../src/core/ai/identify-prompt.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

const RELEASED = 'ff038ad';

/** Rebuild the prompt the way the released file built it, straight from that file's text. */
function releasedPrompts(): Record<string, { system: string; userPlain: string; userHints: string }> {
  const src = execFileSync('git', ['show', `${RELEASED}:src/core/ai/ai-service.ts`], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });

  // CATEGORY_SPECS — balanced-brace slice, then evaluated as the object literal it is.
  const specStart = src.indexOf('= {', src.indexOf('const CATEGORY_SPECS')) + 2;
  let depth = 0, k = specStart;
  for (;;) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) break; }
    k++;
  }
  // eslint-disable-next-line no-new-func
  const specs = new Function(`return ${src.slice(specStart, k + 1)};`)() as Record<string, {
    name: string; required: string[]; optional: string[];
    conditionOptions: string[]; scopeOptions: string[]; notes: string;
  }>;

  const tplStart = src.indexOf('const systemPrompt = `') + 'const systemPrompt = `'.length;
  const tpl = src.slice(tplStart, src.indexOf('`;', tplStart));
  const watchExtra = /const watchExtra = params\.categoryId === 'cat-watch'\s*\n\s*\? '([\s\S]*?)'\s*\n\s*: '';/.exec(src)![1]
    .replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"');

  const out: Record<string, { system: string; userPlain: string; userHints: string }> = {};
  for (const [id, spec] of Object.entries(specs)) {
    // Exactly the released interpolation, in the released order.
    const system = tpl
      .replace(/\$\{spec\.name\}/g, spec.name)
      .replace(/\$\{spec\.required\.join\(', '\)\}/g, spec.required.join(', '))
      .replace(/\$\{spec\.optional\.join\(', '\)\}/g, spec.optional.join(', '))
      .replace(/\$\{spec\.conditionOptions\.join\(' \| '\)\}/g, spec.conditionOptions.join(' | '))
      .replace(/\$\{spec\.scopeOptions\.join\(' \| '\)\}/g, spec.scopeOptions.join(' | '))
      .replace(/\$\{spec\.notes\}/g, spec.notes)
      .replace(
        /\$\{spec\.required\.map\(k => `"\$\{k\}": null`\)\.concat\(spec\.optional\.map\(k => `"\$\{k\}": null`\)\)\.join\(', '\)\}/g,
        [...spec.required, ...spec.optional].map(x => `"${x}": null`).join(', '),
      );
    const extra = id === 'cat-watch' ? watchExtra : '';
    out[id] = {
      system,
      userPlain: `Identify this ${spec.name} item and fill out ALL category fields. Use every visual detail you can extract.${extra}`,
      userHints: `User-provided hints:\nbrand: Rolex\n\nIdentify the item and fill out ALL category fields for "${spec.name}".${extra}`,
    };
  }
  return out;
}

const released = releasedPrompts();

ok(knownCategoryIds().length === 6, 'the contract carries all six categories');
ok(Object.keys(released).length === 6, 'the released source carries all six categories');

for (const id of knownCategoryIds()) {
  const ref = released[id];
  ok(!!ref, `${id} exists in the released source too`);
  if (!ref) continue;

  const sys = buildSystemPrompt(id);
  ok(sys === ref.system,
    `§2 ${id}: system prompt is character-identical to ${RELEASED}` +
    (sys === ref.system ? '' : ` (len ${sys.length} vs ${ref.system.length})`));

  ok(buildUserPrompt(id, '') === ref.userPlain, `§2 ${id}: user prompt without hints is identical`);
  ok(buildUserPrompt(id, 'brand: Rolex') === ref.userHints, `§2 ${id}: user prompt with hints is identical`);

  // The watch-only suffix must stay watch-only, or every category would inherit watch rules.
  const hasExtra = buildUserPrompt(id, '').includes('the three CRITICAL fields are reference_number');
  ok(id === 'cat-watch' ? hasExtra : !hasExtra, `§2 ${id}: the watch suffix appears only for watches`);
}

// ── the category rules themselves came across intact ────────────────────────
{
  const watch = categorySpec('cat-watch')!;
  ok(watch.name === 'WATCH', '§1 watch spec name survived extraction');
  ok(watch.required.includes('dial') && watch.required.includes('karat_color'),
    '§1 watch required attributes survived extraction');
  ok(categorySpec('cat-spare-part')!.optional.length === 0, '§1 spare-part has no optional attributes, as released');
  ok(categorySpec('nope') === null, '§1 an unknown category resolves to null rather than a guess');
}

// ── §5 — the mobile allow/deny lists are DATA, and money is on the deny side ──
{
  for (const money of ['estimatedValue', 'purchasePriceEstimate', 'minSalePrice', 'maxSalePrice',
                       'purchasePrice', 'plannedSalePrice', 'lastOfferPrice', 'lastSalePrice']) {
    ok(MOBILE_FORBIDDEN_FIELDS.includes(money), `§5 ${money} is on the mobile deny list`);
    ok(!MOBILE_ALLOWED_FIELDS.includes(money), `§5 ${money} is not on the mobile allow list`);
  }
  for (const state of ['quantity', 'images', 'id', 'stockStatus', 'syncStatus', 'categoryId']) {
    ok(MOBILE_FORBIDDEN_FIELDS.includes(state), `§5 ${state} is on the mobile deny list`);
  }
  ok(MOBILE_ALLOWED_FIELDS.includes('brand') && MOBILE_ALLOWED_FIELDS.includes('name'),
    '§5 identity fields are what mobile may adopt');
  const overlap = MOBILE_ALLOWED_FIELDS.filter(f => MOBILE_FORBIDDEN_FIELDS.includes(f));
  ok(overlap.length === 0, `§5 no field is both allowed and forbidden (overlap: ${overlap.join(',')})`);
}

// ── §5 — the fingerprint's input must be structurally unambiguous ──────────
{
  // Rebuild the same components the fingerprint hashes, and assert the shape rather than the value:
  // a fixed count, a fixed order, one fixed-width digest per component, and a separator no
  // component can itself contain.
  const parts: string[] = [];
  for (const id of knownCategoryIds().sort()) {
    parts.push(`${id}:system:${fnv1a64(buildSystemPrompt(id))}`);
    parts.push(`${id}:user:${fnv1a64(buildUserPrompt(id, ''))}`);
    parts.push(`${id}:user-hints:${fnv1a64(buildUserPrompt(id, 'brand: Rolex'))}`);
  }
  ok(parts.length === 18, '§5 the fingerprint has a fixed 18 components (6 categories x 3 prompts)');
  ok(parts.every(p => /:[0-9a-f]{16}$/.test(p)), '§5 every component ends in a 16-hex-digit digest');
  ok(parts.every(p => !p.includes('|')), '§5 no component can contain the join separator');
  ok(new Set(parts.map(p => p.slice(0, p.lastIndexOf(':')))).size === 18, '§5 every component key is unique');
  const order = parts.filter((_, i) => i % 3 === 0).map(p => p.split(':')[0]);
  ok(JSON.stringify(order) === JSON.stringify([...order].sort()), '§5 categories are emitted in sorted order');
  ok(parts[0].includes(':system:') && parts[1].includes(':user:') && parts[2].includes(':user-hints:'),
    '§5 the three prompts of a category always appear in the same order');
}

// ── the fingerprint both sides compare against ──────────────────────────────
{
  ok(/^[0-9a-f]{16}$/.test(contractFingerprint()), 'the contract fingerprint is a 16-hex-digit value');
  ok(fnv1a64('') === 'cbf29ce484222325', 'FNV-1a offset basis matches the reference implementation');
  ok(fnv1a64('a') === 'af63dc4c8601ec8c', 'FNV-1a of "a" matches the reference implementation');
  ok(fnv1a64('foobar') === '85944171f73967e8', 'FNV-1a of "foobar" matches the reference implementation');
  console.log(`\n  contract fingerprint: ${contractFingerprint()}`);
}

console.log(`\nidentify-contract-parity: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
