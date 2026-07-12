// B4 — NBR Export Quantity Net Calculation regression tests.
// Kern-Bug (B0): der Standard-Rated-Nettobetrag wurde als line.unitPrice (= NETTO PRO STUECK)
// ausgewiesen, obwohl VAT/Gross die GANZE Zeile betreffen → bei quantity>1 zu niedrig.
// Fix: Net Line Amount = lineTotal (Gross, Zeilen-GESAMT) − vatAmount (VAT, Zeilen-GESAMT).
//
// Der Test fährt die OEFFENTLICHE exportNbrVatReport end-to-end: schreibt die echte .xlsx in ein
// frisches OS-temp-Verzeichnis, liest sie via xlsx zurueck und prueft die erzeugten Rows +
// Section-Totals. Keine Live-DB, kein Artefakt im Projekt (temp-dir wird geloescht).
// Run: node test/b4/nbr-export-quantity.test.ts
import * as XLSX from 'xlsx';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportNbrVatReport } from '../../src/core/tax/nbr-export.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void { if (cond) pass++; else fail.push(msg); }
const close = (a: number, b: number) => Math.abs(Number(a) - Number(b)) < 1e-6;

// ── Fixtures (Minimal-Objekte; nur die vom Export gelesenen Felder) ──
let lineSeq = 0;
function line(taxScheme: string, o: Record<string, number> = {}): any {
  return {
    id: `L${++lineSeq}`, invoiceId: '', productId: 'P1',
    quantity: o.quantity ?? 1,
    unitPrice: o.unitPrice ?? 0,
    purchasePriceSnapshot: o.purchasePriceSnapshot ?? 0,
    vatRate: o.vatRate ?? 10,
    taxScheme,
    vatAmount: o.vatAmount ?? 0,
    lineTotal: o.lineTotal ?? 0,
    position: 1,
  };
}
function invoice(invoiceNumber: string, lines: any[]): any {
  return {
    id: invoiceNumber, invoiceNumber, customerId: 'C1', status: 'FINAL', currency: 'BHD',
    netAmount: 0, vatRateSnapshot: 10, vatAmount: 0, grossAmount: 0, taxSchemeSnapshot: 'mixed',
    purchasePriceSnapshot: 0, salePriceSnapshot: 0, marginSnapshot: 0, paidAmount: 0,
    issuedAt: '2026-06-15T09:00:00.000Z', createdAt: '2026-06-15T09:00:00.000Z',
    lines: lines.map((l, i) => ({ ...l, invoiceId: invoiceNumber, position: i + 1 })),
  };
}
const customers: any[] = [{ id: 'C1', firstName: 'Test', lastName: 'Kunde', company: '', vatAccountNumber: 'VAT123', personalId: 'PID9' }];
const products: any[] = [{ id: 'P1', brand: 'Rolex', name: 'Submariner' }];

// Fuehrt die echte exportNbrVatReport in einem temp-cwd aus und liest das Jun2026-Sheet als AOA zurueck.
function runExport(invoices: any[]): { res: any; rows: any[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'b4-nbr-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const res = exportNbrVatReport(2026, invoices, customers, products);
    const full = join(dir, res.filename);
    if (!existsSync(full)) throw new Error('xlsx nicht geschrieben: ' + full);
    // XLSX.readFile (fs-gebunden) ist im ESM-Build nicht verfuegbar → via node:fs lesen + XLSX.read parsen.
    const wb = XLSX.read(readFileSync(full), { type: 'buffer' });
    if (!wb.SheetNames.includes('Jun2026')) throw new Error('Jun2026-Sheet fehlt: ' + wb.SheetNames.join(','));
    const ws = wb.Sheets['Jun2026'];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true }) as any[][];
    return { res, rows };
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Datenzeilen (Spalte[0] leer, Spalte[1] = Invoice-Nr) zwischen Section-Titel und Total-Row.
function sectionDataRows(rows: any[][], titlePrefix: string, totalPrefix: string): any[][] {
  const start = rows.findIndex(r => typeof r?.[0] === 'string' && r[0].startsWith(titlePrefix));
  if (start < 0) return [];
  const end = rows.findIndex((r, i) => i > start && typeof r?.[0] === 'string' && r[0].startsWith(totalPrefix));
  const out: any[][] = [];
  for (let i = start + 1; i < (end < 0 ? rows.length : end); i++) {
    const r = rows[i];
    if (r && (r[0] === '' || r[0] === undefined) && r[1] !== undefined && r[1] !== '') out.push(r);
  }
  return out;
}
function totalRow(rows: any[][], prefix: string): any[] | undefined {
  const matches = rows.filter(r => typeof r?.[0] === 'string' && r[0].startsWith(prefix));
  return matches[matches.length - 1]; // Margin/Zero: Titel+Total gleicher Text → Total = letzte
}
const STD_TITLE = 'Standard Rated Sales at 10%';
const STD_TOTAL = 'Standard Rated Sales (Line 1';
const ZERO_TITLE = 'Zero-Rated Domestic Sales (Line 4';
const MARGIN_TITLE = 'Profit Margin Scheme Sales';
const stdRows = (rows: any[][], inv: string) => sectionDataRows(rows, STD_TITLE, STD_TOTAL).filter(r => r[1] === inv);
const zeroRows = (rows: any[][], inv: string) => sectionDataRows(rows, ZERO_TITLE, ZERO_TITLE).filter(r => r[1] === inv);
const marginRows = (rows: any[][], inv: string) => sectionDataRows(rows, MARGIN_TITLE, MARGIN_TITLE).filter(r => r[1] === inv);

// ── Export 1: Einzelrechnungen (je 1 Section-Line) — je Datenzeile pruefen ──
function test1_singles(): void {
  const { rows } = runExport([
    invoice('INV-Q1', [line('VAT_10', { quantity: 1, unitPrice: 50, vatAmount: 5, lineTotal: 55 })]),
    invoice('INV-Q2', [line('VAT_10', { quantity: 2, unitPrice: 50, vatAmount: 10, lineTotal: 110 })]),
    invoice('INV-Q3', [line('VAT_10', { quantity: 3, unitPrice: 50, vatAmount: 15, lineTotal: 165 })]),
    // Custom/editable lineTotal: unitPrice bewusst INKONSISTENT (999) → Export MUSS lineTotal−vat nehmen.
    invoice('INV-CUSTOM', [line('VAT_10', { quantity: 2, unitPrice: 999, vatAmount: 10, lineTotal: 110 })]),
    // Rounding: gespeicherter Fils-Wert; net = round3(100 − 9.091) = 90.909, net+vat = 100.
    invoice('INV-ROUND', [line('VAT_10', { quantity: 1, unitPrice: 90.909, vatAmount: 9.091, lineTotal: 100 })]),
    invoice('INV-ZERO', [line('ZERO', { quantity: 2, unitPrice: 50, vatAmount: 0, lineTotal: 100 })]),
    invoice('INV-MARGIN', [line('MARGIN', { quantity: 2, purchasePriceSnapshot: 30, unitPrice: 50, vatAmount: 0, lineTotal: 100, vatRate: 10 })]),
  ]);

  const q1 = stdRows(rows, 'INV-Q1')[0];
  check(q1 && close(q1[7], 50) && close(q1[8], 5) && close(q1[9], 55), `1: qty1 → net 50/vat 5/gross 55, ist ${q1?.[7]}/${q1?.[8]}/${q1?.[9]}`);

  const q2 = stdRows(rows, 'INV-Q2')[0];
  check(q2 && close(q2[7], 100), `2: qty2 KERNBUG → net 100 (nicht 50), ist ${q2?.[7]}`);
  check(q2 && close(q2[8], 10) && close(q2[9], 110), `2: qty2 vat 10 / gross 110 unveraendert, ist ${q2?.[8]}/${q2?.[9]}`);

  const q3 = stdRows(rows, 'INV-Q3')[0];
  check(q3 && close(q3[7], 150) && close(q3[8], 15) && close(q3[9], 165), `3: qty3 → net 150/vat 15/gross 165, ist ${q3?.[7]}/${q3?.[8]}/${q3?.[9]}`);

  const cu = stdRows(rows, 'INV-CUSTOM')[0];
  check(cu && close(cu[7], 100), `4: custom lineTotal → net = gross−vat = 100 (nicht unitPrice 999, nicht unitPrice*qty 1998), ist ${cu?.[7]}`);

  const ro = stdRows(rows, 'INV-ROUND')[0];
  check(ro && close(ro[7], 90.909), `5: rounding → net 90.909 (round3), ist ${ro?.[7]}`);
  check(ro && close(ro[7] + ro[8], 100), `5: net + vat = gross 100 (exakt), ist ${ro ? ro[7] + ro[8] : NaN}`);

  const z = zeroRows(rows, 'INV-ZERO')[0];
  check(z && close(z[7], 100), `6: ZERO qty2 → amount = lineTotal 100 (qty-korrekt), ist ${z?.[7]}`);

  // Margin unveraendert (M-10 qty-korrekt; NICHT Teil des B4-Fixes): purchase=30*2=60,
  // selling=100, profit=40, vatOnProfit=round3(40−40/1.1)=3.636, exclVat=36.364.
  const mg = marginRows(rows, 'INV-MARGIN')[0];
  check(mg && close(mg[7], 60) && close(mg[8], 100) && close(mg[9], 40), `7: MARGIN purchase 60/selling 100/profit 40, ist ${mg?.[7]}/${mg?.[8]}/${mg?.[9]}`);
  check(mg && close(mg[10], 3.636) && close(mg[11], 36.364), `7: MARGIN vatOnProfit 3.636 / exclVat 36.364 (unveraendert), ist ${mg?.[10]}/${mg?.[11]}`);

  // Felder unveraendert ausser net: Invoice-Nr, Name, Produkt, VAT-Acc, Personal-ID, Datum gesetzt.
  check(q2 && q2[1] === 'INV-Q2', `8: Invoice-Nr unveraendert`);
  check(q2 && q2[5] === 'Test Kunde', `8: Client Name unveraendert`);
  check(q2 && q2[6] === 'Rolex Submariner', `8: Good/Service Description unveraendert`);
  check(q2 && q2[3] === 'VAT123' && q2[4] === 'PID9', `8: VAT-Account + Personal-ID unveraendert`);
  check(q2 && typeof q2[2] === 'string' && /\d{2}\.\d{2}\.\d{2}/.test(q2[2]), `8: Invoice Date gesetzt (dd.mm.yy), ist ${q2?.[2]}`);
}

// ── Export 2: gemischte Rechnung (qty1 + qty2 + zero) — Rows + Section-Totals ──
function test2_mixed(): void {
  const { rows } = runExport([
    invoice('INV-MIX', [
      line('VAT_10', { quantity: 1, unitPrice: 50, vatAmount: 5, lineTotal: 55 }),
      line('VAT_10', { quantity: 2, unitPrice: 50, vatAmount: 10, lineTotal: 110 }),
      line('ZERO', { quantity: 2, unitPrice: 50, vatAmount: 0, lineTotal: 100 }),
    ]),
  ]);
  const sr = stdRows(rows, 'INV-MIX');
  check(sr.length === 2, `mix: 2 Standard-Datenzeilen, ist ${sr.length}`);
  check(sr[0] && close(sr[0][7], 50) && close(sr[0][9], 55), `mix: Line A (qty1) net 50 / gross 55, ist ${sr[0]?.[7]}/${sr[0]?.[9]}`);
  check(sr[1] && close(sr[1][7], 100) && close(sr[1][9], 110), `mix: Line B (qty2) net 100 / gross 110, ist ${sr[1]?.[7]}/${sr[1]?.[9]}`);

  const stdTot = totalRow(rows, STD_TOTAL);
  check(stdTot && close(stdTot[7], 150), `mix: Σ Standard-Net = 150 (50+100, keine qty-Doppelzaehlung), ist ${stdTot?.[7]}`);
  check(stdTot && close(stdTot[8], 15) && close(stdTot[9], 165), `mix: Σ Standard-VAT 15 / Σ Gross 165, ist ${stdTot?.[8]}/${stdTot?.[9]}`);

  const zr = zeroRows(rows, 'INV-MIX');
  check(zr[0] && close(zr[0][7], 100), `mix: Zero-Datenzeile 100, ist ${zr[0]?.[7]}`);
  const zTot = totalRow(rows, ZERO_TITLE);
  check(zTot && close(zTot[7], 100), `mix: Σ Zero = 100, ist ${zTot?.[7]}`);
}

// ── Export 3: UI-Summary (return.totals) qty-korrekt (zweite Bug-Stelle) ──
function test3_summary(): void {
  const { res } = runExport([
    invoice('INV-S', [line('VAT_10', { quantity: 2, unitPrice: 50, vatAmount: 10, lineTotal: 110 })]),
  ]);
  check(close(res.totals.standardNet, 100), `summary: standardNet = 100 (qty-korrekt, nicht unitPrice 50), ist ${res.totals.standardNet}`);
  check(close(res.totals.standardVat, 10), `summary: standardVat = 10, ist ${res.totals.standardVat}`);
  check(res.invoiceCount === 1, `summary: invoiceCount 1, ist ${res.invoiceCount}`);
}

function main(): void {
  test1_singles();
  test2_mixed();
  test3_summary();
  const total = pass + fail.length;
  console.log(`\nB4 nbr-export-quantity: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all B4 nbr-export-quantity checks green (Net = lineTotal − vatAmount, qty-korrekt)');
}
main();
