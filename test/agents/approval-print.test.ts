// APPROVAL-DRUCK — Outstanding und A4-Layout des Approval-PDFs (agent-print-helpers + itemListPdf), und derselbe
// Geldstand wie im Approval-Excel bei gleichem Filter.
//   • Bezahlt/Offen nur bei verkauften Stücken: offen beim Kunden und zurückgegeben → keine Forderung
//   • Teilzahlung, Vollzahlung, Rechnung: Paid/Outstanding aus den echten Zahlungsdaten
//   • HTML: ausdrücklich A4, feste Spaltenbreiten innerhalb der bedruckbaren Breite, Kopf wiederholt, Zeilen nicht
//     zerrissen, Summenzeile
// Das gedruckte Bild selbst (Seitengröße, Umbrüche) wird mit Edge headless geprüft — siehe Bericht.
// Run: node test/agents/approval-print.test.ts
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.endsWith('.png')) return { url: 'data:text/javascript,export default "logo.png"', shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      for (const cand of [p, p + '.ts', p + '.tsx']) if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const { buildAgentPrintGroup } = await import('../../src/core/pdf/agent-print-helpers.ts');
const { generateItemListHtml } = await import('../../src/core/pdf/itemListPdf.ts');
const { buildApprovalWorkbookBuffer } = await import('../../src/core/agents/approval-workbook.ts');
const ExcelJS = (await import('exceljs')).default;

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

const categories = [{ id: 'cat-watch', name: 'Watch', attributes: [{ key: 'reference_number', label: 'Reference Number', type: 'text', required: false, showInList: true }] }];
const products = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((id) => ({ id, sku: 'SKU-' + id, brand: 'Rolex', name: 'Model ' + id, categoryId: 'cat-watch', condition: 'Pre-Owned', images: [], attributes: { reference_number: 'REF-' + id }, quantity: 1, purchasePrice: 1, stockStatus: 'with_agent', sourceType: 'OWN', taxScheme: 'MARGIN' }));
const agent = { id: 'A1', name: 'Dr Khalid', company: 'K Trading', phone: '+973 1', commissionRate: 0, active: true, totalSales: 0, totalCommission: 0, createdAt: '', updatedAt: '' };
const tr = (id: string, productId: string, agentPrice: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, transferNumber: 'TRF-' + id, agentId: 'A1', productId, agentPrice, status, commissionRate: 0, settlementStatus: 'pending',
  transferredAt: '2026-11-01T10:00:00Z', createdAt: '2026-11-01T10:00:00Z', updatedAt: '', returnBy: '2026-11-30', ...extra,
});
const transfers = [
  tr('T1', 'P1', 1000, 'transferred'),                                                                                         // beim Kunden
  tr('T2', 'P2', 800, 'returned', { returnedAt: '2026-11-05T10:00:00Z' }),                                                     // zurück
  tr('T3', 'P3', 500, 'sold', { actualSalePrice: 700, settlementAmount: 600, settlementStatus: 'partial', settlementPaidAmount: 200 }), // Teilzahlung
  tr('T4', 'P4', 300, 'settled', { actualSalePrice: 350, settlementAmount: 350, settlementStatus: 'paid' }),                    // voll bezahlt
  tr('T5', 'P5', 900, 'sold', { invoiceId: 'INV1' }),                                                                          // mit Rechnung, teilbezahlt
  tr('T6', 'P6', 400, 'sold', { actualSalePrice: 450, settlementAmount: 450, settlementStatus: 'pending' }),                    // verkauft, nichts bezahlt
];
const invoices = [{ id: 'INV1', grossAmount: 990, paidAmount: 990 - 140 }];
const group = (filter: string) => buildAgentPrintGroup({ agent: agent as never, transfers: transfers as never, invoices: invoices as never, products: products as never, categories: categories as never, filter: filter as never });
const rowOf = (g: { rows: Array<{ refOrSerial?: string; paid?: number; outstanding?: number; status: string }> }, p: string) => g.rows.find((r) => r.refOrSerial?.startsWith('SKU-' + p));

// ── Outstanding: nur verkaufte Stücke ────────────────────────────────────────────────────────────────
{
  const g = group('all');
  check(rowOf(g, 'P1')?.paid === undefined && rowOf(g, 'P1')?.outstanding === undefined && rowOf(g, 'P1')?.status === 'On Approval', 'Open: beim Kunden → keine Forderung (früher Our Price als Outstanding)');
  check(rowOf(g, 'P2')?.paid === undefined && rowOf(g, 'P2')?.outstanding === undefined && rowOf(g, 'P2')?.status === 'Returned', 'Returned: zurück → keine Forderung');
  check(rowOf(g, 'P3')?.paid === 200 && rowOf(g, 'P3')?.outstanding === 400, `Teilzahlung: 600 fällig, 200 bezahlt, 400 offen (${rowOf(g, 'P3')?.paid}/${rowOf(g, 'P3')?.outstanding})`);
  check(rowOf(g, 'P4')?.paid === 350 && rowOf(g, 'P4')?.outstanding === 0, 'Vollzahlung: bezahlt, nichts offen');
  check(rowOf(g, 'P5')?.paid === 850 && rowOf(g, 'P5')?.outstanding === 140 && rowOf(g, 'P5')?.status === 'Partially Paid', 'mit Rechnung: Zahlungen der Rechnung, Rest offen');
  check(rowOf(g, 'P6')?.paid === 0 && rowOf(g, 'P6')?.outstanding === 450, 'verkauft, nichts bezahlt: voller Abrechnungsbetrag offen');
  check(g.summary === '6 items · Total Our Price: 3,900.000 BHD · Paid: 1,400.000 BHD · Outstanding: 990.000 BHD', `Zusammenfassung (${g.summary})`);
  const open = group('open');
  check(open.rows.length === 1 && !/Outstanding/.test(open.summary || ''), `Filter Open: kein offener Zahlungsbetrag (${open.summary})`);
  const ret = group('returned');
  check(ret.rows.length === 1 && !/Outstanding|Paid/.test(ret.summary || ''), `Filter Returned: kein Paid/Outstanding (${ret.summary})`);
  const sold = group('sold');
  check(sold.rows.length === 4 && /Outstanding: 990\.000 BHD/.test(sold.summary || ''), `Filter Sold: alle Forderungen (${sold.summary})`);
}

// ── Excel und PDF zeigen bei gleichem Filter dieselben Beträge ─────────────────────────────────────────
for (const filter of ['all', 'sold', 'open', 'returned']) {
  const g = group(filter);
  const pdfPaid = g.rows.reduce((s: number, r: { paid?: number }) => s + (r.paid || 0), 0);
  const pdfOpen = g.rows.reduce((s: number, r: { outstanding?: number }) => s + (r.outstanding || 0), 0);
  const buf = await buildApprovalWorkbookBuffer({
    filter: filter as never, scope: 'single', agents: [agent as never], transfers: transfers as never, invoices: invoices as never, products: products as never,
    categories: categories as never, categoryName: () => 'Watch', resolveImage: async () => null, mediaScope: { tenantId: 't', branchId: 'b' }, today: '2026-11-16',
  });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as ArrayBuffer);
  const T = wb.getWorksheet('Total')!;
  let xPaid: unknown = null, xOpen: unknown = null;
  T.eachRow((r) => { if (r.getCell(1).text === 'TOTAL') { xPaid = r.getCell(10).value; xOpen = r.getCell(11).value; } });
  check(xPaid === pdfPaid && xOpen === pdfOpen, `Filter ${filter}: Excel = PDF (Paid ${xPaid}/${pdfPaid}, Outstanding ${xOpen}/${pdfOpen})`);
}

// ── A4-Layout im Druck-HTML ──────────────────────────────────────────────────────────────────────────
{
  const html = generateItemListHtml({ kind: 'approval', filter: 'all', branchName: 'LATAIF', groups: [group('all')] });
  check(/@page\s*\{\s*size:\s*A4 portrait;\s*margin:\s*12mm 10mm 14mm 10mm;/.test(html), 'Papier ausdrücklich A4 hochkant, normale Ränder');
  check(/thead \{ display: table-header-group; \}/.test(html), 'Tabellenkopf wiederholt sich auf Folgeseiten');
  check(/tr \{ page-break-inside: avoid; break-inside: avoid; \}/.test(html), 'Artikelzeilen werden nicht zerrissen');
  check(/\.header, \.group-head \{ page-break-after: avoid; break-after: avoid; \}/.test(html), 'Kundenüberschrift bleibt bei ihren ersten Zeilen');
  check(!/page-break-inside:avoid">\s*<div class="group-head"/.test(html), 'eine lange Gruppe schiebt die nächste nicht mehr auf eine leere Seite');
  check(/table-layout:fixed/.test(html), 'feste Spaltenbreiten (nichts läuft über den Rand)');
  const widths = [...html.matchAll(/<col style="width:(\d+(?:\.\d+)?)mm">/g)].map((m) => Number(m[1]));
  const fixed = widths.reduce((s, w) => s + w, 0);
  check(widths.length === 8 && fixed <= 190 - 40, `feste Spalten ${fixed} mm + mindestens 40 mm für „Item" ≤ 190 mm bedruckbare Breite`);
  check((html.match(/<tr class="total">/g) || []).length === 1 && /Total \(6 items\)[\s\S]*?3,900\.000[\s\S]*?1,400\.000[\s\S]*?990\.000/.test(html), 'Summenzeile unter den Beträgen');
  check(/<div>SKU-P1<\/div><div>REF-P1<\/div>/.test(html), 'SKU und Referenz je eine Zeile (kein Umbruch mitten in der SKU)');
  const p1Row = html.split('<tr>').find((r) => r.includes('SKU-P1')) || '';
  check((p1Row.match(/color:#bbb">—/g) || []).length === 2 && !/1,000\.000<\/span>/.test(p1Row), 'offenes Stück: „—" statt Betrag unter Paid/Outstanding');
  check(/41&nbsp;mm|\d&nbsp;(g|mm|ct)/.test(generateItemListHtml({ kind: 'approval', filter: 'all', groups: [{ heading: 'X', rows: [{ date: '', itemLabel: 'Ring · 5.4 g', specsLine: '41 mm', ourPrice: 1, status: 'On Approval' }] }] })), 'Zahl und Einheit bleiben zusammen');
}

if (fail.length) { console.error('APPROVAL-PRINT: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`APPROVAL-PRINT: ${pass}/${pass} checks passed`);
