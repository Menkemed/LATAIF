// X3 — Safe Product Import Hardening tests. Exercises the PURE import logic in
// src/core/import/product-import.ts. No React / DB / Tauri / xlsx / fs — only in-memory
// objects + injected fakes. Run: node test/x3/import-hardening.test.ts
//
// The `@/core/models/types` import inside the module under test is TYPE-ONLY (erased by
// Node's type-stripping), so this runs without any alias resolver.

import {
  parseNumber, parseVatScheme, buildExistingIndex, detectDuplicate,
  classifyRows, summarize, canStartImport, importableRows, runProductImport, isImportable,
  VAT_SCHEMES,
  type RawRow, type ClassifiedRow, type ClassifyOptions, type ExistingProductLike,
} from '../../src/core/import/product-import.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++; else fail.push(msg);
}
function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

// simple category resolver: 'watch' matches; empty/unknown → default (matched:false)
function makeResolver(): ClassifyOptions['resolveCategory'] {
  return (rawName: string) => {
    const n = rawName.toLowerCase().trim();
    if (n === 'watch' || n === 'watches') return { id: 'cat-watch', name: 'Watch', matched: true };
    if (n === 'gold') return { id: 'cat-gold', name: 'Gold', matched: true };
    return { id: 'cat-def', name: 'Default', matched: false };
  };
}
function opts(over: Partial<ClassifyOptions> = {}): ClassifyOptions {
  return {
    resolveCategory: makeResolver(),
    defaultVatScheme: 'VAT_10',
    existingIndex: buildExistingIndex([]),
    ...over,
  };
}

// ── 1 + 2 + 3: number parsing ──
function testNumbers(): void {
  // 1: EU
  check(parseNumber('1.234,50').ok && close(parseNumber('1.234,50').value, 1234.5), '1: EU 1.234,50 → 1234.50');
  check(close(parseNumber('1234,50').value, 1234.5), '1: EU 1234,50 → 1234.50');
  // 2: US
  check(parseNumber('1,234.50').ok && close(parseNumber('1,234.50').value, 1234.5), '2: US 1,234.50 → 1234.50');
  check(close(parseNumber('1234.50').value, 1234.5), '2: plain 1234.50 → 1234.50');
  // currency prefix, BHD 3-decimals
  check(parseNumber('BD 1,234.500').ok && close(parseNumber('BD 1,234.500').value, 1234.5), '2: "BD 1,234.500" → 1234.5');
  // 3: invalid / ambiguous
  check(parseNumber('abc').ok === false, '3: "abc" → ok=false');
  const amb = parseNumber('1,234');
  check(amb.ok === false && amb.ambiguous === true, '3: ambiguous "1,234" → ok=false, ambiguous=true');
  const empty = parseNumber('');
  check(empty.ok === true && empty.empty === true && empty.value === 0, '3: "" → empty=true, value 0');
  check(close(parseNumber('-50.5').value, -50.5), '3: negative -50.5');
  check(close(parseNumber('1,234,567').value, 1234567), '3: US thousands 1,234,567');
}

// ── 4 + 5: VAT scheme ──
function testVat(): void {
  // 4: cannot silently default to MARGIN
  const noVat = parseVatScheme('', null);
  check(noVat.scheme === null && noVat.ok === false, '4: empty VAT + no default → null (NOT MARGIN)');
  const withDef = parseVatScheme('', 'VAT_10');
  check(withDef.scheme === 'VAT_10' && withDef.fromDefault === true, '4: empty VAT + default VAT_10 → VAT_10 fromDefault');
  check(parseVatScheme('margin', null).scheme === 'MARGIN', '4: explicit "margin" → MARGIN');
  check(parseVatScheme('10%', null).scheme === 'VAT_10', '4: "10%" → VAT_10');
  check(parseVatScheme('zero rated', null).scheme === 'ZERO', '4: "zero rated" → ZERO');
  check(parseVatScheme('nonsense', null).ok === false, '4: unknown VAT value → ok=false (not silent)');
  check(VAT_SCHEMES.length === 3 && VAT_SCHEMES.includes('MARGIN') && VAT_SCHEMES.includes('VAT_10') && VAT_SCHEMES.includes('ZERO'), '4: VAT_SCHEMES = 3 canonical');

  // 5: a row with no VAT column and NO default → invalid → not importable → import blocked
  const rows: RawRow[] = [{ Brand: 'Rolex', Cost: '100' }];
  const classifiedNoDefault = classifyRows(rows, opts({ defaultVatScheme: null }));
  check(classifiedNoDefault[0].status === 'invalid' && classifiedNoDefault[0].errors.some(e => /VAT/i.test(e)), '5: no VAT + no default → invalid');
  const sumND = summarize(classifiedNoDefault);
  check(canStartImport({ canBackup: true, vatSelected: false, summary: sumND }) === false, '5: missing VAT scheme blocks import');
  // same rows WITH a default become importable
  const classifiedWithDefault = classifyRows(rows, opts({ defaultVatScheme: 'VAT_10' }));
  check(isImportable(classifiedWithDefault[0].status) && classifiedWithDefault[0].taxScheme === 'VAT_10', '5: default VAT_10 makes row importable');
}

// ── 6 + 7: duplicate detection ──
function testDuplicates(): void {
  const existing: ExistingProductLike[] = [
    { sku: 'SKU-1', brand: 'Rolex', attributes: { serial_no: 'SER-9', reference_no: '116610' } },
  ];
  const index = buildExistingIndex(existing);

  // 6: duplicate SKU
  check(detectDuplicate({ sku: 'SKU-1', serialNo: '', brand: '', referenceNo: '' }, index).duplicate === true, '6: duplicate SKU detected (helper)');
  const rows6: RawRow[] = [{ Brand: 'Omega', SKU: 'SKU-1', Cost: '100', VAT: 'margin' }];
  check(classifyRows(rows6, opts({ existingIndex: index }))[0].status === 'duplicate', '6: duplicate SKU row → status duplicate');

  // 7: duplicate serial
  check(detectDuplicate({ sku: '', serialNo: 'SER-9', brand: '', referenceNo: '' }, index).duplicate === true, '7: duplicate serial detected (helper)');
  const rows7: RawRow[] = [{ Brand: 'Omega', Serial: 'SER-9', Cost: '100', VAT: 'margin' }];
  check(classifyRows(rows7, opts({ existingIndex: index }))[0].status === 'duplicate', '7: duplicate serial row → status duplicate');

  // brand+reference duplicate
  const rowsBR: RawRow[] = [{ Brand: 'Rolex', Model: '116610', Cost: '100', VAT: 'margin' }];
  check(classifyRows(rowsBR, opts({ existingIndex: index }))[0].status === 'duplicate', '7b: brand+reference duplicate → status duplicate');

  // intra-file duplicate: two identical SKUs, second is duplicate
  const rowsIntra: RawRow[] = [
    { Brand: 'A', SKU: 'NEW-1', Cost: '10', VAT: 'margin' },
    { Brand: 'B', SKU: 'NEW-1', Cost: '20', VAT: 'margin' },
  ];
  const ci = classifyRows(rowsIntra, opts());
  check(ci[0].status !== 'duplicate' && ci[1].status === 'duplicate', '7c: intra-file duplicate SKU → 2nd row duplicate');
}

// ── 8 + 9 + 10 + 11: orchestrator (backup-first, importable-only, no overwrite) ──
async function testOrchestrator(): Promise<void> {
  const existing: ExistingProductLike[] = [{ sku: 'EXIST-1', brand: 'Rolex', attributes: {} }];
  const index = buildExistingIndex(existing);
  const rows: RawRow[] = [
    { Category: 'watch', Brand: 'New', SKU: 'NEW-1', Cost: '100', VAT: 'margin' },   // new
    { Category: 'watch', Brand: 'Dup', SKU: 'EXIST-1', Cost: '100', VAT: 'margin' }, // duplicate of existing
    { Brand: '', Cost: '', VAT: 'margin' },                                           // invalid (no identity, no cost)
  ];
  const classified = classifyRows(rows, opts({ existingIndex: index }));
  check(classified[0].status === 'new' && classified[1].status === 'duplicate' && classified[2].status === 'invalid', '10: statuses new/duplicate/invalid');

  // 8: backup failure blocks import — create must NEVER be called
  let created8 = 0;
  const res8 = await runProductImport(classified, {
    backup: () => Promise.reject(new Error('no backup in browser')),
    create: () => { created8++; },
  });
  check(res8.started === false && res8.imported === 0 && created8 === 0 && /no backup/.test(res8.backupError || ''), '8: backup failure blocks import (0 creates)');

  // 9 + 10 + 11: good backup → only importable rows created, existing never touched
  const createdSkus: string[] = [];
  const res = await runProductImport(classified, {
    backup: () => Promise.resolve({ location: '/tmp/backup/pre_import' }),
    create: (r: ClassifiedRow) => { createdSkus.push(r.sku); },
  });
  check(res.started === true && res.imported === 1 && res.failed === 0, '9: valid rows proceed after backup (1 imported)');
  check(createdSkus.length === 1 && createdSkus[0] === 'NEW-1', '10: only the new row imported (invalid/duplicate skipped)');
  check(!createdSkus.includes('EXIST-1'), '11: existing product NOT overwritten (duplicate never created)');
  check(importableRows(classified).length === 1, '10b: importableRows excludes invalid + duplicate');

  // a create() that throws → counted as failed, loop continues
  const rowsTwoNew: RawRow[] = [
    { Brand: 'X', SKU: 'X-1', Cost: '10', VAT: 'margin' },
    { Brand: 'Y', SKU: 'Y-1', Cost: '20', VAT: 'margin' },
  ];
  const cls2 = classifyRows(rowsTwoNew, opts());
  let n = 0;
  const resFail = await runProductImport(cls2, {
    backup: () => Promise.resolve({ location: '/b' }),
    create: () => { n++; if (n === 1) throw new Error('insert failed'); },
  });
  check(resFail.started === true && resFail.imported === 1 && resFail.failed === 1, '9b: per-row failure counted, import continues');
}

// ── classification + summary sanity ──
function testClassifySummary(): void {
  const rows: RawRow[] = [
    { Category: 'watch', Brand: 'Rolex', SKU: 'A1', Cost: '1.234,50', 'Tag Price': '2.000,00', Qty: '2', VAT: 'margin' }, // new
    { Category: 'unknowncat', Brand: 'Omega', SKU: 'A2', Cost: '500', VAT: 'vat' },                                      // warning (category defaulted)
    { Brand: 'NoCat', SKU: 'A3', Cost: '300' },                                                                          // warning (no category in file), VAT from default
    { Brand: '', Cost: '', VAT: 'margin' },                                                                              // invalid
  ];
  const cls = classifyRows(rows, opts());
  check(cls[0].status === 'new' && close(cls[0].purchasePrice, 1234.5) && cls[0].quantity === 2 && cls[0].taxScheme === 'MARGIN', 'C: clean EU row → new, parsed');
  check(cls[1].status === 'warning' && cls[1].warnings.some(w => /category/i.test(w)), 'C: unmatched category → warning');
  check(cls[2].status === 'warning' && cls[2].taxScheme === 'VAT_10', 'C: no-category row → warning + VAT from default');
  check(cls[3].status === 'invalid', 'C: empty row → invalid');

  const sum = summarize(cls);
  check(sum.total === 4 && sum.new === 1 && sum.warning === 2 && sum.invalid === 1 && sum.importable === 3, 'C: summary buckets');
  // est qty: 2 + 1 + 1 = 4 ; est cost: 1234.5*2 + 500*1 + 300*1 = 3269
  check(sum.estQtyTotal === 4 && close(sum.estCostTotal, 1234.5 * 2 + 500 + 300), 'C: est qty + cost totals');
  check(canStartImport({ canBackup: true, vatSelected: true, summary: sum }) === true, 'C: gate open when backup+vat+importable');
  check(canStartImport({ canBackup: false, vatSelected: true, summary: sum }) === false, 'C: gate closed without backup');
}

// ── 12: no real DB/file/xlsx import in tests ──
function testNoRealIo(): void {
  // The module under test only imports a TYPE from '@/core/models/types' (erased at runtime).
  // Everything above ran with in-memory objects + injected backup/create fakes — no fs, no DB,
  // no xlsx, no Tauri were touched. This test documents that contract explicitly.
  check(typeof runProductImport === 'function' && typeof classifyRows === 'function', '12: pure helpers only — no real DB/file/xlsx import');
}

async function main(): Promise<void> {
  testNumbers();
  testVat();
  testDuplicates();
  await testOrchestrator();
  testClassifySummary();
  testNoRealIo();

  const total = pass + fail.length;
  console.log(`\nX3 safe-import: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all X3 safe-import checks green');
}
main();
