// APPROVAL-EXCEL — der echte Builder src/core/agents/approval-workbook.ts unter node mit ExcelJS; die Mappe wird
// wieder eingelesen und geprüft: ein Blatt je Kunde + „Total", Filter wie beim Druck, Ref/Model + Serial vorn,
// Geld nur bei verkauften Stücken, überfällige Rückgaben markiert, keine internen Einkaufsdaten.
// Run: node test/agents/approval-workbook.test.ts
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const ExcelJS = (await import('exceljs')).default;
const { buildApprovalWorkbookBuffer, APPROVAL_BASE_HEADERS } = await import('../../src/core/agents/approval-workbook.ts');
const { approvalRowMoney, filterApprovalTransfers } = await import('../../src/core/agents/approval-rows.ts');

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const attr = (key: string, label: string, type = 'text') => ({ key, label, type, required: false, showInList: false });
const categories = [
  { id: 'cat-watch', name: 'Watch', attributes: [attr('reference_number', 'Reference Number'), attr('serial_number', 'Serial Number'), attr('dial', 'Dial')] },
  { id: 'cat-accessory', name: 'Accessory', attributes: [attr('model_number', 'Model No'), attr('serial_number', 'Serial No'), attr('color', 'Color')] },
];
const prod = (id: string, categoryId: string, attributes: Record<string, unknown>) => ({
  id, sku: id, brand: 'B-' + id, name: 'N-' + id, categoryId, condition: 'Pre-Owned', images: [], attributes,
  quantity: 1, purchasePrice: 777.777, stockStatus: 'with_agent', sourceType: 'OWN', taxScheme: 'MARGIN', notes: 'INTERN-NOTIZ',
}) as never;
const products = [
  prod('W1', 'cat-watch', { reference_number: 'R1', serial_number: 'S1', dial: 'Black' }),
  prod('ACC1', 'cat-accessory', { model_number: 'M-7', serial_number: 'SN-2', color: 'Black' }),
  prod('W2', 'cat-watch', { reference_number: 'R2' }),
  prod('W3', 'cat-watch', { reference_number: 'R3' }),
  { ...(prod('RING9', 'cat-watch', { item_type: 'Ring', description: 'Red Stone' }) as object), brand: '', name: '' } as never,
];
const agents = [
  { id: 'A1', name: 'Ali Hassan', company: 'AH Trading', phone: '+973 1111', commissionRate: 0, active: true, totalSales: 0, totalCommission: 0, createdAt: '', updatedAt: '' },
  { id: 'A2', name: 'Client/Two: [VIP]', commissionRate: 0, active: true, totalSales: 0, totalCommission: 0, createdAt: '', updatedAt: '' },
  { id: 'A3', name: 'Nobody', commissionRate: 0, active: true, totalSales: 0, totalCommission: 0, createdAt: '', updatedAt: '' },
] as never[];
const tr = (id: string, agentId: string, productId: string, agentPrice: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, transferNumber: 'TRF-' + id, agentId, productId, agentPrice, status, commissionRate: 0, settlementStatus: 'pending',
  transferredAt: '2026-11-01T10:00:00Z', createdAt: '2026-11-01T10:00:00Z', updatedAt: '', notes: 'INTERN-TRANSFER', buyerInfo: 'KÄUFER-XY', ...extra,
}) as never;
const transfers = [
  tr('T1', 'A1', 'W1', 1000, 'transferred', { returnBy: '2026-11-10' }),                                                  // überfällig
  tr('T2', 'A1', 'ACC1', 500, 'sold', { actualSalePrice: 700, settlementAmount: 600, settlementStatus: 'partial', settlementPaidAmount: 200, soldAt: '2026-11-05T09:00:00Z' }),
  tr('T3', 'A1', 'W2', 800, 'returned', { returnedAt: '2026-11-07T09:00:00Z' }),
  tr('T4', 'A1', 'W3', 900, 'settled', { invoiceId: 'INV1', soldAt: '2026-11-06T09:00:00Z', settlementModel: 'split', excessSplitPct: 40 }),
  tr('T5', 'A2', 'GONE', 300, 'transferred', { returnBy: '2026-12-31' }),
  tr('T6', 'A2', 'RING9', 150, 'transferred'),
];
const invoices = [{ id: 'INV1', grossAmount: 1100, paidAmount: 1100 }] as never[];

const build = async (filter: string, scope: 'single' | 'aggregate', ag = agents) => {
  const buf = await buildApprovalWorkbookBuffer({
    filter: filter as never, scope, agents: ag, transfers, invoices, products, categories: categories as never,
    categoryName: (id: string) => categories.find((c) => c.id === id)?.name ?? '',
    resolveImage: async (p: { id: string }) => (p.id === 'W1' ? { bytes: PNG, extension: 'png' as const } : null),
    mediaScope: { tenantId: 't', branchId: 'b' }, today: '2026-11-16',
  });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as ArrayBuffer); return wb;
};
const headersOf = (ws: ExcelJS.Worksheet): string[] => { const h: string[] = []; ws.getRow(1).eachCell((c) => { h.push(String(c.value)); }); return h; };
const rowBySku = (ws: ExcelJS.Worksheet, sku: string) => { let r: ExcelJS.Row | undefined; ws.eachRow((x) => { if (x.getCell(2).value === sku) r = x; }); return r; };
const cell = (ws: ExcelJS.Worksheet, sku: string, header: string) => rowBySku(ws, sku)?.getCell(headersOf(ws).indexOf(header) + 1);
const val = (ws: ExcelJS.Worksheet, sku: string, header: string) => cell(ws, sku, header)?.value;
const leer = (x: unknown) => x === null || x === undefined || x === '';

// ── Alle Stücke, alle Kunden ─────────────────────────────────────────────────────────────────────────
{
  const wb = await build('all', 'aggregate');
  const names = wb.worksheets.map((w) => w.name);
  check(JSON.stringify(names) === JSON.stringify(['Ali Hassan', 'Client Two VIP', 'Total']), `ein Blatt je Kunde mit Stücken, Excel-taugliche Namen, „Total" am Ende (${names.join(' | ')})`);
  const ws = wb.getWorksheet('Ali Hassan')!;
  const h = headersOf(ws);
  const DET = ['Reference / Model No', 'Serial Number', 'Dial', 'Color'];
  check(JSON.stringify(h) === JSON.stringify([...APPROVAL_BASE_HEADERS.slice(0, 6), ...DET, ...APPROVAL_BASE_HEADERS.slice(6)]),
    `Spalten: Grunddaten · Artikeldetails (Ref/Model + Serial vorn) · Transfer · Beträge · Settlement (${h.join(' | ')})`);
  check(!h.some((x) => /purchase|cost|margin|buyer|notes|supplier/i.test(x)), 'keine Einkaufs-, Margen-, Käufer- oder Notizspalte');
  let intern = false;
  ws.eachRow((r) => r.eachCell((c) => { if (c.value === 777.777 || /INTERN|KÄUFER/.test(String(c.value))) intern = true; }));
  check(!intern, 'kein Einkaufspreis, keine Notiz, kein Käufer in irgendeiner Zelle');

  check(val(ws, 'W1', 'Reference / Model No') === 'R1' && val(ws, 'ACC1', 'Reference / Model No') === 'M-7', 'Uhr-Referenz und Accessory-Modellnummer in derselben Spalte');
  check(val(ws, 'W1', 'Serial Number') === 'S1' && val(ws, 'ACC1', 'Serial Number') === 'SN-2', 'Seriennummer beider Kategorien in einer Spalte');
  check(val(ws, 'W1', 'Status') === 'On Approval' && val(ws, 'W1', 'Days on Approval') === 15 && val(ws, 'W1', 'Transfer Date') === '2026-11-01', `offenes Stück: Status, Tage beim Kunden (${val(ws, 'W1', 'Days on Approval')})`);
  check(cell(ws, 'W1', 'Return By')?.font?.color?.argb === 'FFB91C1C', 'überfällige Rückgabe rot markiert');
  check(['Amount Due (BHD)', 'Paid (BHD)', 'Outstanding (BHD)'].every((x) => leer(val(ws, 'W1', x))) && val(ws, 'W1', 'Our Price (BHD)') === 1000, 'offenes Stück: Our Price, aber keine Forderung');
  check(val(ws, 'ACC1', 'Amount Due (BHD)') === 600 && val(ws, 'ACC1', 'Paid (BHD)') === 200 && val(ws, 'ACC1', 'Outstanding (BHD)') === 400 && val(ws, 'ACC1', 'Sale Price (BHD)') === 700,
    'verkauft ohne Rechnung: Forderung = Abrechnungsbetrag, Teilzahlung, offen');
  check(val(ws, 'ACC1', 'Sold Date') === '2026-11-05' && leer(val(ws, 'ACC1', 'Days on Approval')), 'verkauft: Verkaufsdatum, keine Tage-Zählung');
  check(val(ws, 'W2', 'Status') === 'Returned' && val(ws, 'W2', 'Returned Date') === '2026-11-07' && leer(val(ws, 'W2', 'Outstanding (BHD)')), 'zurück: Datum, keine Forderung');
  check(val(ws, 'W3', 'Status') === 'Settled' && val(ws, 'W3', 'Amount Due (BHD)') === 1100 && val(ws, 'W3', 'Outstanding (BHD)') === 0 && val(ws, 'W3', 'Settlement') === 'Split 40%',
    'mit Rechnung: Forderung = Rechnung brutto, bezahlt, Abrechnungsmodell');
  check(typeof val(ws, 'W1', 'Our Price (BHD)') === 'number' && ws.getColumn(h.indexOf('Our Price (BHD)') + 1).numFmt === '#,##0.000', 'Beträge als Excel-Zahlen im BHD-Format');
  const imgs = ws.getImages();
  check(imgs.length === 1 && imgs[0].range.tl.nativeRow === 1 && imgs[0].range.tl.nativeCol === 0, 'Bild in Spalte „Image" der richtigen Zeile');
  let tot: unknown[] = [];
  ws.eachRow((r) => { if (/^TOTAL/.test(String(r.getCell(4).value || ''))) tot = ['Our Price (BHD)', 'Amount Due (BHD)', 'Paid (BHD)', 'Outstanding (BHD)'].map((x) => r.getCell(h.indexOf(x) + 1).value); });
  check(JSON.stringify(tot) === JSON.stringify([3200, 1700, 1300, 400]), `Summenzeile des Blatts (${JSON.stringify(tot)})`);

  const ws2 = wb.getWorksheet('Client Two VIP')!;
  check(headersOf(ws2).length === APPROVAL_BASE_HEADERS.length && rowBySku(ws2, '') !== undefined, 'Stück ohne Artikel: Zeile bleibt, keine Detailspalten');
  let gone = false; ws2.eachRow((r) => { if (r.getCell(4).value === '(product not found)') gone = true; });
  check(gone && ws2.getImages().length === 0, 'fehlender Artikel: „(product not found)", kein Bild, kein Abbruch');

  const T = wb.getWorksheet('Total')!;
  check(JSON.stringify(headersOf(T)) === JSON.stringify(['Approval', 'Company', 'Phone', 'Items', 'On Approval', 'Sold', 'Returned', 'Value on Approval (BHD)', 'Amount Due (BHD)', 'Paid (BHD)', 'Outstanding (BHD)']), `Total-Kopf (${headersOf(T)})`);
  const rows: Array<{ name: string; link: string; vals: unknown[] }> = [];
  T.eachRow((r, n) => {
    if (n === 1 || !r.getCell(1).text) return;
    const v = r.getCell(1).value as unknown;
    rows.push({ name: r.getCell(1).text, link: v && typeof v === 'object' && 'hyperlink' in (v as object) ? String((v as { hyperlink: string }).hyperlink) : '', vals: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((k) => r.getCell(k).value) });
  });
  const by = (n: string) => rows.find((x) => x.name === n);
  check(JSON.stringify(by('Ali Hassan')?.vals) === JSON.stringify(['AH Trading', '+973 1111', 4, 1, 2, 1, 1000, 1700, 1300, 400]), `Total Ali (${JSON.stringify(by('Ali Hassan')?.vals)})`);
  check(by('Ali Hassan')?.link === "#'Ali Hassan'!A1" && by('Client/Two: [VIP]')?.link === "#'Client Two VIP'!A1", 'Kundenzeile springt zum Blatt');
  check(JSON.stringify(by('TOTAL')?.vals.slice(2)) === JSON.stringify([6, 3, 2, 1, 1450, 1700, 1300, 400]), `Gesamtsumme (${JSON.stringify(by('TOTAL')?.vals)})`);
  check(leer(val(ws2, 'RING9', 'Name')) && val(ws, 'W1', 'Name') === 'N-W1', `Name = nur der Modellname, Merkmale nicht doppelt (${val(ws2, 'RING9', 'Name')})`);
  check(!by('Nobody'), 'Kunde ohne Stücke: kein Blatt, keine Zeile');
}

// ── Filter wie beim Druck ────────────────────────────────────────────────────────────────────────────
{
  const open = await build('open', 'aggregate');
  const ws = open.getWorksheet('Ali Hassan')!;
  check(!!rowBySku(ws, 'W1') && !rowBySku(ws, 'ACC1') && !rowBySku(ws, 'W2') && !rowBySku(ws, 'W3'), 'Open: nur Stücke beim Kunden');
  const ret = await build('returned', 'aggregate');
  check(JSON.stringify(ret.worksheets.map((w) => w.name)) === JSON.stringify(['Ali Hassan', 'Total']), 'Returned: Kunden ohne Rückgabe fallen weg');
  const sold = await build('sold', 'aggregate');
  const s = sold.getWorksheet('Ali Hassan')!;
  check(!!rowBySku(s, 'ACC1') && !!rowBySku(s, 'W3') && !rowBySku(s, 'W1'), 'Sold: verkaufte und abgerechnete Stücke');
  const single = await build('all', 'single', [agents[2]]);
  check(JSON.stringify(single.worksheets.map((w) => w.name)) === JSON.stringify(['Nobody', 'Total']), 'ein Kunde ohne Stücke: sein Blatt (leer) + Total');
  check(filterApprovalTransfers(transfers as never, 'sold').length === 2, 'derselbe Filter wie beim Druck');
  const cancelled = approvalRowMoney({ ...(transfers[1] as object), status: 'cancelled' } as never);
  check(cancelled.amountDue === null && cancelled.outstanding === null, 'stornierter Verkauf: keine Forderung');
}

if (fail.length) { console.error('APPROVAL-EXCEL: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`APPROVAL-EXCEL: ${pass}/${pass} checks passed`);
