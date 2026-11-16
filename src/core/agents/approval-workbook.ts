// ════════════════════════════════════════════════════════════════════════════
// APPROVAL-EXCEL — die Stücke auf Approval als .xlsx, aufgebaut wie der Collections-Export.
//
// Je Approval-Kunde ein Blatt (ein Transfer = eine Zeile, mit Bild und den Artikeldetails der Kategorien;
// Referenz-/Modellnummer und Seriennummer vorn nebeneinander), am Ende das Blatt „Total" mit einer Zeile je
// Kunde und der Gesamtsumme. Welche Transfers erscheinen, regelt derselbe Filter wie beim Druck
// (All / Sold / Open / Returned). Forderung, Bezahlt und Offen gibt es nur bei verkauften Stücken.
//
// Keine Einkaufspreise, keine Marge, keine Käuferdaten, keine Notizen — die Liste kann an den Kunden gehen.
// Nur lesend; ein nicht lesbares Bild lässt nur das Bild weg.
// ════════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';
import type { Agent, AgentTransfer, Category, Invoice, Product } from '@/core/models/types';
import type { ExportImage, ExportMediaScope } from '@/core/media/product-image-export-core';
import type { ItemListFilter } from '@/core/pdf/itemListPdf';
import { collectionDetailColumns, detailRowValues, styleHeaderRow, styleTotalRow, uniqueSheetName } from '@/core/media/collection-workbook';
import { approvalRowMoney, approvalStatusLabel, filterApprovalTransfers, isApprovalBack, isApprovalSold } from '@/core/agents/approval-rows';
export interface ApprovalWorkbookDeps {
  filter: ItemListFilter;
  /** single = ein Kunde (Blatt auch ohne Zeilen); aggregate = alle Kunden mit passenden Stücken. */
  scope: 'single' | 'aggregate';
  agents: readonly Agent[];
  transfers: readonly AgentTransfer[];
  invoices: readonly Invoice[];
  products: readonly Product[];
  /** Kategorie-Definitionen (Quelle der Detailspalten). */
  categories?: readonly Category[];
  categoryName: (categoryId: string) => string;
  resolveImage: (product: { id: string; images?: string[] }, scope: ExportMediaScope) => Promise<ExportImage | null>;
  mediaScope: ExportMediaScope;
  /** Geschäftstag JJJJ-MM-TT für „Days on Approval" und überfällige Rückgaben. */
  today: string;
}

const MONEY = '#,##0.000';
const COUNT = '#,##0';
const GOLD = 'FFC6A36D';

interface Col { header: string; key: string; width: number; numFmt?: string }

const KOPF: Col[] = [
  { header: 'Image',     key: 'image',    width: 12 },
  { header: 'SKU',       key: 'sku',      width: 14 },
  { header: 'Brand',     key: 'brand',    width: 16 },
  { header: 'Name',      key: 'name',     width: 26 },
  { header: 'Category',  key: 'category', width: 14 },
  { header: 'Condition', key: 'cond',     width: 12 },
];
const TRANSFER: Col[] = [
  { header: 'Transfer No',      key: 'tno',      width: 13 },
  { header: 'Transfer Date',    key: 'tdate',    width: 13 },
  { header: 'Return By',        key: 'returnBy', width: 12 },
  { header: 'Days on Approval', key: 'days',     width: 11, numFmt: COUNT },
  { header: 'Status',           key: 'status',   width: 15 },
  { header: 'Sold Date',        key: 'soldAt',   width: 12 },
  { header: 'Returned Date',    key: 'backAt',   width: 13 },
];
const BETRAEGE: Col[] = [
  { header: 'Our Price (BHD)',   key: 'our',  width: 15, numFmt: MONEY },
  { header: 'Sale Price (BHD)',  key: 'sale', width: 15, numFmt: MONEY },
  { header: 'Amount Due (BHD)',  key: 'due',  width: 16, numFmt: MONEY },
  { header: 'Paid (BHD)',        key: 'paid', width: 13, numFmt: MONEY },
  { header: 'Outstanding (BHD)', key: 'open', width: 16, numFmt: MONEY },
];
const WEITERE: Col[] = [
  { header: 'Settlement', key: 'settle', width: 12 },
];

/** Die festen Kopfzeilen eines Kunden-Blatts (ohne Detailspalten, die zwischen Kopf und Transfer stehen). */
export const APPROVAL_BASE_HEADERS: readonly string[] = [...KOPF, ...TRANSFER, ...BETRAEGE, ...WEITERE].map((c) => c.header);

/** Summen eines Kunden-Blatts — dieselben Zahlen stehen in seiner Zeile im Blatt „Total". */
export interface ApprovalTotals {
  items: number;
  onApproval: number;
  sold: number;
  returned: number;
  /** Our Price der Stücke, die noch beim Kunden liegen. */
  valueOnApproval: number;
  amountDue: number;
  paid: number;
  outstanding: number;
}

const day = (iso?: string | null): string => (iso ? String(iso).split('T')[0] : '');
const daysBetween = (from: string, to: string): number | '' => {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : '';
};

/** Build the approval workbook and return its .xlsx bytes. */
export async function buildApprovalWorkbookBuffer(deps: ApprovalWorkbookDeps): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LATAIF';
  wb.created = new Date();

  const used = new Set<string>(['total']);
  const summary: Array<{ agent: Agent; sheet: string; totals: ApprovalTotals }> = [];
  for (const agent of deps.agents) {
    const rows = filterApprovalTransfers(deps.transfers.filter((t) => t.agentId === agent.id), deps.filter);
    if (deps.scope === 'aggregate' && rows.length === 0) continue;
    const sheet = uniqueSheetName(agent.name || 'Approval', used);
    summary.push({ agent, sheet, totals: await addAgentSheet(wb, sheet, rows, deps) });
  }
  if (summary.length === 0) await addAgentSheet(wb, uniqueSheetName('Approval', used), [], deps);
  addTotalSheet(wb, summary);
  return wb.xlsx.writeBuffer();
}

async function addAgentSheet(wb: ExcelJS.Workbook, sheetName: string, transfers: readonly AgentTransfer[], deps: ApprovalWorkbookDeps): Promise<ApprovalTotals> {
  const ws = wb.addWorksheet(sheetName);
  const productOf = new Map(deps.products.map((p) => [p.id, p]));
  const invoiceOf = new Map(deps.invoices.map((i) => [i.id, i]));
  const sheetProducts = transfers.map((t) => productOf.get(t.productId)).filter((p): p is Product => !!p);
  const details = collectionDetailColumns(sheetProducts, deps.categories);

  const asCol = (c: Col): Partial<ExcelJS.Column> => ({ header: c.header, key: c.key, width: c.width, ...(c.numFmt ? { style: { numFmt: c.numFmt } } : {}) });
  ws.columns = [
    ...KOPF.map(asCol),
    ...details.map((d) => ({ header: d.header, key: d.key, width: Math.min(30, Math.max(12, d.header.length + 2)), ...(d.type === 'number' ? { style: { numFmt: '#,##0.###' } } : {}) })),
    ...TRANSFER.map(asCol), ...BETRAEGE.map(asCol), ...WEITERE.map(asCol),
  ];
  const header = ws.getRow(1);
  styleHeaderRow(header);
  for (const k of [details[0]?.key, TRANSFER[0].key, BETRAEGE[0].key, WEITERE[0].key].filter(Boolean) as string[]) {
    const cell = header.getCell(k);
    cell.border = { ...cell.border, left: { style: 'thin', color: { argb: GOLD } } };
  }

  const totals: ApprovalTotals = { items: 0, onApproval: 0, sold: 0, returned: 0, valueOnApproval: 0, amountDue: 0, paid: 0, outstanding: 0 };
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const p = productOf.get(t.productId);
    const invoice = t.invoiceId ? invoiceOf.get(t.invoiceId) : undefined;
    const money = approvalRowMoney(t, invoice);
    const open = t.status === 'transferred';
    const returnBy = day(t.returnBy);
    const row = ws.addRow({
      image: '',
      sku: p?.sku || '',
      brand: p?.brand || '',
      // Wie im Collections-Export nur der Modellname — Art, Beschreibung, Karat, Gewicht stehen in ihren eigenen Spalten.
      name: p ? (p.name || '') : '(product not found)',
      category: p ? deps.categoryName(p.categoryId) : '',
      cond: p?.condition || '',
      ...(p ? detailRowValues(details, p) : {}),
      tno: t.transferNumber || '',
      tdate: day(t.transferredAt || t.createdAt),
      returnBy,
      days: open ? daysBetween(day(t.transferredAt || t.createdAt), deps.today) : '',
      status: approvalStatusLabel(t, invoice),
      soldAt: isApprovalSold(t) ? day(t.soldAt) : '',
      backAt: t.status === 'returned' ? day(t.returnedAt) : '',
      our: money.ourPrice,
      sale: money.salePrice ?? '',
      due: money.amountDue ?? '',
      paid: money.paid ?? '',
      open: money.outstanding ?? '',
      settle: t.settlementModel === 'split' ? `Split ${t.excessSplitPct ?? 50}%` : 'Full',
    });
    row.height = 60;
    row.alignment = { vertical: 'middle' };
    // Überfällig: noch beim Kunden und die Rückgabefrist ist vorbei.
    if (open && returnBy && returnBy < deps.today) row.getCell('returnBy').font = { bold: true, color: { argb: 'FFB91C1C' } };

    totals.items++;
    if (open) { totals.onApproval++; totals.valueOnApproval += money.ourPrice; }
    if (isApprovalSold(t)) totals.sold++;
    if (isApprovalBack(t)) totals.returned++;
    totals.amountDue += money.amountDue ?? 0;
    totals.paid += money.paid ?? 0;
    totals.outstanding += money.outstanding ?? 0;

    if (!p) continue;
    try {
      const img = await deps.resolveImage(p, deps.mediaScope);
      if (img) {
        const imgId = wb.addImage({ buffer: img.bytes as unknown as ArrayBuffer, extension: img.extension });
        ws.addImage(imgId, { tl: { col: 0.1, row: i + 1.1 }, ext: { width: 70, height: 70 }, editAs: 'oneCell' });
      }
    } catch {
      console.warn('[Approval-Excel] image embed skipped for product', p.id);
    }
  }

  styleTotalRow(ws.addRow({
    name: `TOTAL (${totals.items} item${totals.items === 1 ? '' : 's'})`,
    our: transfers.reduce((s, t) => s + (t.agentPrice || 0), 0),
    due: totals.amountDue, paid: totals.paid, open: totals.outstanding,
  }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return totals;
}

function addTotalSheet(wb: ExcelJS.Workbook, summary: Array<{ agent: Agent; sheet: string; totals: ApprovalTotals }>): void {
  const ws = wb.addWorksheet('Total');
  ws.columns = [
    { header: 'Approval',                 key: 'name',            width: 26 },
    { header: 'Company',                  key: 'company',         width: 20 },
    { header: 'Phone',                    key: 'phone',           width: 16 },
    { header: 'Items',                    key: 'items',           width: 8,  style: { numFmt: COUNT } },
    { header: 'On Approval',              key: 'onApproval',      width: 12, style: { numFmt: COUNT } },
    { header: 'Sold',                     key: 'sold',            width: 8,  style: { numFmt: COUNT } },
    { header: 'Returned',                 key: 'returned',        width: 10, style: { numFmt: COUNT } },
    { header: 'Value on Approval (BHD)',  key: 'valueOnApproval', width: 22, style: { numFmt: MONEY } },
    { header: 'Amount Due (BHD)',         key: 'amountDue',       width: 17, style: { numFmt: MONEY } },
    { header: 'Paid (BHD)',               key: 'paid',            width: 13, style: { numFmt: MONEY } },
    { header: 'Outstanding (BHD)',        key: 'outstanding',     width: 17, style: { numFmt: MONEY } },
  ];
  styleHeaderRow(ws.getRow(1));
  const sum: ApprovalTotals = { items: 0, onApproval: 0, sold: 0, returned: 0, valueOnApproval: 0, amountDue: 0, paid: 0, outstanding: 0 };
  for (const s of summary) {
    const row = ws.addRow({
      ...s.totals,
      name: { text: s.agent.name, hyperlink: `#'${s.sheet.replace(/'/g, "''")}'!A1` },
      company: s.agent.company || '',
      phone: s.agent.phone || '',
    });
    row.getCell('name').font = { color: { argb: 'FF1F4E79' }, underline: true };
    for (const k of Object.keys(sum) as Array<keyof ApprovalTotals>) sum[k] += s.totals[k];
  }
  styleTotalRow(ws.addRow({ name: 'TOTAL', ...sum }));
  ws.addRow({});
  const note = ws.addRow({ name: 'Value on Approval: Our Price of items still with the client. Amount Due, Paid and Outstanding: sold items only.' });
  note.getCell('name').font = { italic: true, color: { argb: 'FF6B6B6B' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
