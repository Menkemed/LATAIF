// ════════════════════════════════════════════════════════════════════════════
// SKU-ALLOC — the pure rules behind a new product's SKU.
// Run: node test/sku/sku-allocation.test.ts
//
// The durable, authoritative allocator is tested against a real database in sku-sequence.test.ts.
// What lives here is the arithmetic it and the desktop form previews share: how a seed is built,
// what counts as "no SKU", and how a sequence advances.
// ════════════════════════════════════════════════════════════════════════════

import {
  buildSkuSeed,
  skuCategoryCode,
  skuIsEmpty,
  nextSkuFrom,
  resolveSku,
  splitSku,
  padSequence,
} from '../../src/core/products/sku-allocation.ts';
import { withAllocatedSku } from '../../src/core/media/mobile-upload-drain.ts';
import type { ClaimGrant, MobileDrainDeps } from '../../src/core/media/mobile-upload-drain.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log('  x ' + msg); }
}
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ')');

// -- the seed ----------------------------------------------------------------
{
  eq(buildSkuSeed('Rolex', 'cat-watch'), 'ROL-WCH-001', 'seed is brand-3 + category-3 + an explicit sequence');
  eq(buildSkuSeed('Bvlgari', 'cat-branded-gold-jewelry'), 'BVL-BGJ-001', 'branded gold gets its own code');
  eq(buildSkuSeed('AP', 'cat-watch'), 'APX-WCH-001', 'a two-letter brand is padded, never short');
  eq(buildSkuSeed('', 'cat-watch'), 'ITM-WCH-001', 'no brand still yields a usable seed');
  eq(buildSkuSeed(undefined, undefined), 'ITM-GEN-001', 'no brand and no category still yields a seed');
  eq(buildSkuSeed('12 Karat!', 'cat-gold-jewelry'), 'KAR-GLD-001', 'digits and punctuation are not brand letters');
  ok(buildSkuSeed('x', 'y').length > 0, 'the seed is never empty - an empty seed would mean an empty SKU');
  for (const c of ['cat-watch', 'cat-gold-jewelry', 'cat-branded-gold-jewelry',
    'cat-original-gold-jewelry', 'cat-accessory', 'cat-spare-part']) {
    ok(skuCategoryCode(c) !== 'GEN', 'every real category has its own code (' + c + ')');
  }
  eq(skuCategoryCode('cat-made-up'), 'GEN', 'an unknown category falls back to GEN, it does not throw');
  // EVERY generated seed must end in an explicit sequence - that is what protects a model number
  // in the stem from being counted up.
  for (const brand of ['Rolex', 'Ebel', 'AP', '']) {
    for (const cat of ['cat-watch', 'cat-accessory', undefined]) {
      ok(/-\d{3}$/.test(buildSkuSeed(brand, cat)), 'generated seed ends in a sequence: ' + buildSkuSeed(brand, cat));
    }
  }
}

// -- splitting ---------------------------------------------------------------
{
  eq(splitSku('ROL-WCH-001'), { stem: 'ROL-WCH-', number: 1, width: 3 }, 'stem, number and width are read off the seed');
  eq(splitSku('WATCH-0007'), { stem: 'WATCH-', number: 7, width: 4 }, 'a four-digit width is kept');
  eq(splitSku('ABC'), { stem: 'ABC-', number: 0, width: 3 }, 'a value with no digits becomes a stem awaiting 001');
  eq(splitSku(''), null, 'an empty value cannot be split');
  // The trap, asserted rather than assumed: without a suffix the model number IS the sequence.
  eq(splitSku('RLX-DJ41'), { stem: 'RLX-DJ', number: 41, width: 2 }, 'a bare model number splits at the digits');
  eq(splitSku('RLX-DJ41-001'), { stem: 'RLX-DJ41-', number: 1, width: 3 },
    'with an explicit suffix the model number stays in the stem - this is why seeds carry -001');
  eq(padSequence(7, 3), '007', 'padding to width');
  eq(padSequence(1000, 3), '1000', 'a number wider than the padding is not truncated');
}

// -- what counts as "has no SKU" ---------------------------------------------
{
  for (const v of ['', '   ', 'null', 'NULL', 'undefined', null, undefined]) {
    ok(skuIsEmpty(v), 'treated as empty: ' + JSON.stringify(v));
  }
  for (const v of ['RLX-DJ41-002', '0', 'x']) {
    ok(!skuIsEmpty(v), 'treated as a real SKU: ' + JSON.stringify(v));
  }
}

// -- the sequence (the preview rule) -----------------------------------------
{
  eq(nextSkuFrom('ROL-WCH', []), 'ROL-WCH-001', 'a seed without a number starts at 001');
  eq(nextSkuFrom('ROL-WCH-001', []), 'ROL-WCH-001', 'a fresh stem keeps the seed number - the first item is -001');
  eq(nextSkuFrom('', ['A-001']), '', 'an empty seed yields an empty SKU rather than a bare number');
  eq(nextSkuFrom('WATCH-0001', ['WATCH-0007']), 'WATCH-0008', 'the seed padding width is preserved');
  eq(nextSkuFrom('CA/0007', ['CA/0009']), 'CA/0010', 'a non-dash separator is still a stem');

  const inUse = ['RLX-DJ36-002', 'RLX-DJ36-003', 'RLX-DJ36-005'];
  eq(nextSkuFrom('RLX-DJ36-001', inUse), 'RLX-DJ36-006',
    'the gap left by a deleted product is NOT refilled - a new item never inherits a retired number');
  ok(!inUse.includes(nextSkuFrom('RLX-DJ36-001', inUse)), 'the result is never a SKU already in the list');

  eq(nextSkuFrom('RLX-DJ36-001', ['rlx-dj36-009']), 'RLX-DJ36-010', 'a lowercase SKU in the data still blocks its number');
  eq(nextSkuFrom('RLX-DJ36-001', ['  RLX-DJ36-004  ']), 'RLX-DJ36-005', 'padding whitespace in stored data is ignored');
  eq(nextSkuFrom('RLX-DJ36-001', ['RLX-DJ41-099']), 'RLX-DJ36-001', 'a different stem does not move this one');
  eq(nextSkuFrom('A-008', ['A-009']), 'A-010', 'the highest number in use wins over the seed number');
  eq(nextSkuFrom('A-008', []), 'A-008', 'but on an unused stem the seed number is taken as offered');
  eq(nextSkuFrom('A-1', ['A-9']), 'A-10', 'a one-digit width widens rather than wrapping');
  eq(nextSkuFrom('RLX-DJ36-001', ['RLX-DJ36-002', '', 'RLX-DJ36-abc']), 'RLX-DJ36-003',
    'blank and non-numeric entries are skipped, not counted');

  // the model-number guarantee, stated as the negative it has to be
  eq(nextSkuFrom('RLX-DJ41-001', ['RLX-DJ41-001']), 'RLX-DJ41-002', 'RLX-DJ41-001 advances to RLX-DJ41-002');
  for (const n of ['RLX-DJ42', 'RLX-DJ42-001', 'RLX-DJ40']) {
    ok(nextSkuFrom('RLX-DJ41-001', ['RLX-DJ41-001']) !== n, 'never yields ' + n);
  }
  // KNOWN LEGACY BEHAVIOUR, deliberately preserved and asserted: a RAW seed with no suffix still
  // treats its trailing digits as the sequence (ABC123 -> ABC124). Only reachable from the desktop
  // callers that pass an AI-proposed string straight through; the generated path always has -001.
  eq(nextSkuFrom('ABC123', ['ABC123']), 'ABC124', 'legacy raw-seed contract is unchanged');
  eq(nextSkuFrom('RLX-DJ41', ['RLX-DJ41']), 'RLX-DJ42', 'and it is the same rule that makes a bare seed risky');
}

// -- an operator-typed SKU is untouchable ------------------------------------
{
  eq(resolveSku('MY-OWN-42', 'Rolex', 'cat-watch', ['MY-OWN-42']), 'MY-OWN-42',
    'a SKU the operator typed is returned unchanged, even when it is already in the list');
  eq(resolveSku('  spaced-1  ', 'Rolex', 'cat-watch', []), 'spaced-1', 'a typed SKU is only trimmed');
  eq(resolveSku('', 'Rolex', 'cat-watch', ['ROL-WCH-001']), 'ROL-WCH-002', 'an empty SKU is allocated');
  eq(resolveSku(null, undefined, undefined, []), 'ITM-GEN-001', 'a missing SKU with no brand still gets one');
  eq(resolveSku('', 'Rolex', 'cat-watch', []), 'ROL-WCH-001', 'the first watch of a brand is -001');
}

// -- the drain: allocation happens on the metadata that gets hashed ----------
{
  const grantOf = (metadata: Record<string, unknown>): ClaimGrant => ({
    uploadEventId: 'u-1', claimToken: 't-1', entityId: 'p-1', payloadHash: 'ph',
    authenticatedUserId: 'user-1', tenantId: 'tenant-1', branchId: 'branch-main',
    metadataJson: JSON.stringify(metadata), images: [],
  } as unknown as ClaimGrant);
  /** A stand-in allocator: hands out a contiguous run for whatever seed it is given. */
  const counterDeps = (): { deps: MobileDrainDeps; seeds: string[] } => {
    const seeds: string[] = [];
    let n = 0;
    const deps = {
      allocateSku: (seed: string) => {
        seeds.push(seed);
        const parts = splitSku(seed)!;
        return parts.stem + String(++n).padStart(parts.width, '0');
      },
    } as unknown as MobileDrainDeps;
    return { deps, seeds };
  };
  const skuOf = (g: ClaimGrant) => JSON.parse(g.metadataJson).sku;

  const base = { brand: 'Rolex', name: 'Datejust 36', categoryId: 'cat-watch', attributes: { dial: 'Black' } };

  {
    const { deps, seeds } = counterDeps();
    eq(skuOf(withAllocatedSku(grantOf(base), deps)), 'ROL-WCH-001',
      'an upload without a SKU is given one by the authoritative allocator');
    eq(seeds, ['ROL-WCH-001'],
      'the seed carries an explicit sequence suffix, so a model number can never be read as one');
  }

  {
    const { deps, seeds } = counterDeps();
    const typed = withAllocatedSku(grantOf({ ...base, sku: 'HAND-TYPED-7' }), deps);
    eq(skuOf(typed), 'HAND-TYPED-7', 'a SKU typed on the phone is never replaced');
    eq(seeds, [], 'and the allocator is not even consulted - no number is burned');
  }

  const untouched = grantOf(base);
  eq(withAllocatedSku(untouched, {} as MobileDrainDeps).metadataJson, untouched.metadataJson,
    'without an allocator the grant is returned byte-identical - the pre-allocation behaviour');

  {
    const { deps, seeds } = counterDeps();
    const broken = { ...grantOf(base), metadataJson: 'not json' } as ClaimGrant;
    eq(withAllocatedSku(broken, deps).metadataJson, 'not json',
      'unparseable metadata is passed through untouched rather than rewritten');
    const notAnObject = { ...grantOf(base), metadataJson: '[1,2]' } as ClaimGrant;
    eq(withAllocatedSku(notAnObject, deps).metadataJson, '[1,2]',
      'a JSON array is not a metadata object and is left alone');
    eq(seeds, [], 'neither case burns a number');
  }

  {
    const { deps } = counterDeps();
    const out = withAllocatedSku(grantOf(base), deps);
    const m = JSON.parse(out.metadataJson);
    eq(m.brand, 'Rolex', 'brand survives the metadata rewrite');
    eq(m.name, 'Datejust 36', 'name survives the metadata rewrite');
    eq(m.categoryId, 'cat-watch', 'categoryId survives the metadata rewrite');
    eq(m.attributes, { dial: 'Black' }, 'attributes survive the metadata rewrite');
    eq(out.entityId, 'p-1', 'the pinned entity id is carried over');
    eq(out.payloadHash, 'ph', 'the upload payload hash is NOT recomputed - it binds the upload, not the row');
    eq(out.claimToken, 't-1', 'the claim token is carried over');
  }

  {
    const { deps } = counterDeps();
    const first = skuOf(withAllocatedSku(grantOf(base), deps));
    const second = skuOf(withAllocatedSku(grantOf(base), deps));
    ok(first !== second, 'two uploads in one pass get different SKUs (' + first + ' vs ' + second + ')');
    eq([first, second], ['ROL-WCH-001', 'ROL-WCH-002'], 'and they are consecutive, starting at 001');
  }

  {
    const { deps, seeds } = counterDeps();
    eq(skuOf(withAllocatedSku(grantOf({ categoryId: 'cat-accessory' }), deps)), 'ITM-ACC-001',
      'an upload with neither brand nor SKU still gets a SKU');
    eq(seeds, ['ITM-ACC-001'], 'and its seed is well formed');
  }
}

console.log('\nsku-allocation: ' + PASS + ' passed, ' + FAIL + ' failed');
if (FAIL > 0) { for (const f of failures) console.log('   - ' + f); process.exit(1); }
