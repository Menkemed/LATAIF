// ════════════════════════════════════════════════════════════════════════════
// AI-PRICE — no identify result reaches a commercial field, in ANY consumer.
// Run: node test/items/ai-price-consumers.test.ts
//
// `buildAiFormPatch` is covered by its own gate, but it is not the only place an identify result is
// merged: the Collection create, the New Item dialog, the sync guard and the consignment form each
// unpack `result` inline, in JSX, where no unit test can reach them. That is not a hypothetical gap
// — it is how `minSalePrice` and `maxSalePrice` survived a release that had already removed the
// estimate and the cost guess from everywhere a test was looking.
//
// So this reads the SOURCE. It is the same move the e2e preflight makes when it inspects the built
// binary rather than the code that was supposed to build it: the only way to make a claim about
// every consumer is to look at every consumer.
//
// What a price is here: anything the business trades on — what was paid, what it is asked for, and
// the floor and ceiling a negotiation runs between. The model may describe the piece; it may not
// put a number on it.
// ════════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildAiFormPatch } from '../../src/core/ai/edit-merge.ts';
import type { AiProductIdentification } from '../../src/core/ai/ai-service.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  x ${msg}`); }
}

// ── the fields an identify response can offer a number in ───────────────────
const AI_MONEY = ['estimatedValue', 'purchasePriceEstimate', 'minSalePrice', 'maxSalePrice'] as const;
/** Where the model's own type and prompt legitimately name them. */
const DECLARATION_ONLY = ['src/core/ai/ai-service.ts'];

const SRC = 'src';
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
ok(files.length > 100, `the sweep really walked the source tree (${files.length} files)`);

const offenders: string[] = [];
for (const file of files) {
  const rel = file.split(sep).join('/');
  if (DECLARATION_ONLY.includes(rel)) continue;
  // Split on CRLF as well as LF. A trailing `\r` is a line terminator, so `.*$` stops before it and
  // the comment stripper below silently matches nothing on a Windows checkout — which is exactly
  // how this gate first "found" a violation that was only a comment quoting the old code.
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // A comment explaining the rule is not a violation of it.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    for (const field of AI_MONEY) {
      if (new RegExp(`\\bresult\\.${field}\\b`).test(code)) offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 80)}`);
    }
  });
}
ok(offenders.length === 0, `no consumer reads a price out of an identify result\n     ${offenders.join('\n     ')}`);

// ── and the shared merge agrees, with a response that offers every one ──────
const WITH_MONEY = {
  brand: 'Rolex', name: 'Submariner Date', condition: 'Pre-Owned',
  estimatedValue: 9990, purchasePriceEstimate: 8880, minSalePrice: 7770, maxSalePrice: 11110,
  attributes: {},
} as unknown as AiProductIdentification;

const ERP_PRICES = ['purchasePrice', 'plannedSalePrice', 'minSalePrice', 'maxSalePrice'] as const;

for (const mode of ['create', 'edit'] as const) {
  const onEmpty = buildAiFormPatch(WITH_MONEY, {}, { mode });
  for (const f of ERP_PRICES) {
    ok(!(f in onEmpty), `${mode}: an empty ${f} is left empty, not filled from an estimate`);
  }
  // The case that matters most on real stock: a figure someone entered stays exactly as entered.
  const entered = { purchasePrice: 120, plannedSalePrice: 250, minSalePrice: 200, maxSalePrice: 900 };
  const after = { ...entered, ...buildAiFormPatch(WITH_MONEY, entered, { mode }) };
  for (const f of ERP_PRICES) {
    ok(after[f] === entered[f], `${mode}: an entered ${f} of ${entered[f]} comes back as ${after[f]}`);
  }
  // A real zero is a decision — the defect that started this whole rule.
  const free = { purchasePrice: 0 };
  ok(!('purchasePrice' in buildAiFormPatch(WITH_MONEY, free, { mode })),
    `${mode}: a purchase price of 0 is a value, not an empty field`);
  // …while the model still does the job it is there for.
  ok(buildAiFormPatch(WITH_MONEY, {}, { mode }).brand === 'Rolex',
    `${mode}: the brand is still recognised — this is a rule about money, not a refusal to help`);
}

console.log(`\nai-price-consumers: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
