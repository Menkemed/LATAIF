// NBR Bahrain VAT Export — exact structure as required by tax authority.
// One sheet per month (Jan2024, Feb2024, ...) with 3 sections:
//   1. Standard Rated Sales at 10% (Line 1 of the VAT Return)
//   2. Profit Margin Scheme Sales (Line 1 of the VAT Return)
//   3. Zero-Rated Domestic Sales (Line 4 of the VAT Return)
//
// M-01 ABGRENZUNG: Drei bewusst verschiedene Revenue-Regeln im System —
//   Steuer (hier):  Periode = Tag der Vollzahlung (invoiceFinalizationDate), nur FINAL.
//   Reports/Kunden: computeSalesMetrics — FINAL-only auf issuedAt, Refunds anteilig.
//   Ledger:         Realisierung bei ISSUE (Accrual, siehe posting.ts postInvoiceIssued).
// Abweichungen zwischen den dreien sind gewollt, kein Bug.

import * as XLSX from 'xlsx';
import type { Invoice, Customer, Product } from '@/core/models/types';

type AOA = (string | number | null)[][];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  // format: dd.mm.yy
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function productLabel(products: Product[], productId: string): string {
  const p = products.find(pp => pp.id === productId);
  if (!p) return '';
  return [p.brand, p.name].filter(Boolean).join(' ');
}

function customerLabel(c: Customer | undefined): string {
  if (!c) return '';
  const base = `${c.firstName} ${c.lastName}`.trim();
  return c.company ? `${base} (${c.company})` : base;
}

// v0.7.23 — Zahlungen pro Invoice (fuer Finalisierungs-Datum + Audit-Notiz).
export interface NbrPayment {
  amount: number;
  method: string;
  receivedAt: string;
}
export type PaymentsByInvoice = Map<string, NbrPayment[]>;

/**
 * Finalisierungs-Datum = Tag an dem die Rechnung VOLL bezahlt wurde.
 * = Datum der spaetesten Zahlung. Das ist der Steuer-Zeitpunkt (NBR-Periode).
 * Fallback (Alt-Daten ohne Payment-Zeilen, 0-BHD-Rechnung): issuedAt/createdAt.
 */
export function invoiceFinalizationDate(inv: Invoice, payments?: NbrPayment[]): string {
  if (payments && payments.length > 0) {
    let max = '';
    for (const p of payments) {
      if (p.receivedAt && p.receivedAt > max) max = p.receivedAt;
    }
    if (max) return max;
  }
  return inv.issuedAt || inv.createdAt;
}

/**
 * Audit-Hinweis fuer die Steuer-Tabelle: urspruengliches Erstelldatum + alle
 * Teilzahlungen (Betrag/Datum/Methode). Macht transparent, dass eine im Maerz
 * gemeldete Rechnung schon im Januar erstellt wurde.
 */
function paymentNote(inv: Invoice, payments?: NbrPayment[]): string {
  const issued = fmtDate(inv.issuedAt || inv.createdAt);
  const base = `Issued ${issued}`;
  if (!payments || payments.length === 0) return base;
  const sorted = [...payments].sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
  const payStr = sorted
    .map(p => `${round3(p.amount).toFixed(3)} (${fmtDate(p.receivedAt)}, ${p.method})`)
    .join('; ');
  return `${base} · Payments: ${payStr}`;
}

// Interne Audit-Spalte rechts neben dem offiziellen NBR-Raster. NOTE_COL=13 laesst
// 1 Spalte Abstand nach dem breitesten Abschnitt (Margin = 12 Spalten, Index 0-11),
// damit klar ist: das ist eine interne Anmerkung, kein Teil des amtlichen Rasters.
const NOTE_COL = 13;
function rowWithNote(cells: (string | number | null)[], note: string): (string | number | null)[] {
  const row = cells.slice();
  while (row.length < NOTE_COL) row.push('');
  row[NOTE_COL] = note;
  return row;
}

interface MonthInvoices {
  year: number;
  month: number; // 0-11
  invoices: Invoice[];
}

function groupByMonth(year: number, invoices: Invoice[], selectedIds?: Set<string>, paymentsByInvoice?: PaymentsByInvoice): MonthInvoices[] {
  const result: MonthInvoices[] = MONTHS.map((_, i) => ({ year, month: i, invoices: [] }));
  for (const inv of invoices) {
    // v0.7.23 — Nur FINAL (voll bezahlte) Rechnungen in den NBR-Steuer-Export.
    // Konsistent mit Dashboard + Plan §Sales §3 ("nur Final zählt für Umsatz/Steuer").
    // PARTIAL (= erstellt, aber noch nicht voll bezahlt) wird erst nach Vollzahlung
    // zur FINAL und erscheint dann. Vorher fälschlich auch PARTIAL exportiert.
    if (inv.status !== 'FINAL') continue;
    if (selectedIds && !selectedIds.has(inv.id)) continue;
    // v0.7.23 — Steuer-Periode = Tag der Vollzahlung (Finalisierung), NICHT das
    // urspruengliche Erstell-/Rechnungsdatum. Eine im Januar erstellte, erst im
    // Maerz voll bezahlte Rechnung erscheint im Maerz-Sheet (Steuer-Zeitpunkt).
    const iso = invoiceFinalizationDate(inv, paymentsByInvoice?.get(inv.id));
    if (!iso) continue;
    const d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    if (d.getFullYear() !== year) continue;
    result[d.getMonth()].invoices.push(inv);
  }
  return result;
}

function buildMonthSheet(
  bucket: MonthInvoices,
  customers: Customer[],
  products: Product[],
  paymentsByInvoice?: PaymentsByInvoice,
): AOA {
  const rows: AOA = [];

  // ── SECTION 1: Standard Rated Sales at 10% ──
  rows.push(['Standard Rated Sales at 10% (Line 1 of the VAT Return)']);
  rows.push(rowWithNote([
    'VAT Return Field Number',
    'Invoice Number',
    'Invoice Date',
    'Client VAT Account Number',
    'Client Personal ID',
    'Client Name',
    'Good/Service Description',
    'Total BHD (Exclusive of VAT)',
    'VAT Amount',
    'Total BHD (Inclusive of VAT)',
  ], 'Internal Note — Original Invoice Date & Payments'));

  let stdNet = 0, stdVat = 0, stdGross = 0;

  for (const inv of bucket.invoices) {
    const stdLines = inv.lines.filter(l => l.taxScheme === 'VAT_10');
    if (stdLines.length === 0) continue;
    const customer = customers.find(c => c.id === inv.customerId);
    const vatAcc = customer?.vatAccountNumber || '';
    const personalId = customer?.personalId || '';
    const name = customerLabel(customer);
    const pays = paymentsByInvoice?.get(inv.id);
    // v0.7.23 — angezeigtes Datum = Tag der Vollzahlung (Steuer-Zeitpunkt).
    const date = fmtDate(invoiceFinalizationDate(inv, pays));
    const note = paymentNote(inv, pays);

    for (const line of stdLines) {
      // B4 — Net Line Amount = GROSS (lineTotal) − VAT (vatAmount). Beide Felder sind
      // kanonisch als ZEILEN-GESAMT gespeichert (createDirectInvoice: grossAmount += lineTotal,
      // totalVat += vatAmount — je OHNE *qty), unitPrice dagegen ist NETTO PRO STUECK
      // (netAmount += unitPrice*qty). Vorher `net = unitPrice` → bei quantity>1 zu niedrig
      // (VAT/Gross betrafen die ganze Zeile, Netto nur 1 Stueck). qty=1 unveraendert, da dann
      // lineTotal = unitPrice + vatAmount. Bewusst der persistierte/editierbare lineTotal,
      // nicht unitPrice*qty (robust gegen manuell gesetzte/gerundete Line-Totals).
      const net = round3(line.lineTotal - line.vatAmount);
      const vat = round3(line.vatAmount);
      const gross = round3(line.lineTotal);
      rows.push(rowWithNote([
        '',
        inv.invoiceNumber,
        date,
        vatAcc,
        personalId,
        name,
        productLabel(products, line.productId),
        net,
        vat,
        gross,
      ], note));
      stdNet += net;
      stdVat += vat;
      stdGross += gross;
    }
  }

  rows.push([
    'Standard Rated Sales (Line 1 of the VAT Return)',
    '', '', '', '', '', '',
    round3(stdNet),
    round3(stdVat),
    round3(stdGross),
  ]);
  rows.push([]);

  // ── SECTION 2: Profit Margin Scheme Sales ──
  rows.push(['Profit Margin Scheme Sales (Line 1 of the VAT Return)']);
  rows.push(rowWithNote([
    'VAT Return Field Number',
    'Invoice Number',
    'Invoice Date',
    'Client VAT Account Number',
    'Client Personal ID',
    'Client Name',
    'Good/Service Description',
    'Total BHD (Purchase Price)',
    'Total BHD (Selling Price)',
    'Total BHD (Profit)',
    'VAT Amount',
    'Total BHD (Exclusive of VAT)',
  ], 'Internal Note — Original Invoice Date & Payments'));

  let mPurchase = 0, mSelling = 0, mProfit = 0, mVat = 0, mExcl = 0;

  for (const inv of bucket.invoices) {
    const mLines = inv.lines.filter(l => l.taxScheme === 'MARGIN');
    if (mLines.length === 0) continue;
    const customer = customers.find(c => c.id === inv.customerId);
    const vatAcc = customer?.vatAccountNumber || '';
    const personalId = customer?.personalId || '';
    const name = customerLabel(customer);
    const pays = paymentsByInvoice?.get(inv.id);
    // v0.7.23 — angezeigtes Datum = Tag der Vollzahlung (Steuer-Zeitpunkt).
    const date = fmtDate(invoiceFinalizationDate(inv, pays));
    const note = paymentNote(inv, pays);

    for (const line of mLines) {
      // M-10 — purchasePriceSnapshot ist Cost PRO STUECK, lineTotal ist GESAMT.
      // Cost mal Menge, damit Margin-VAT bei qty>1 stimmt (vorher zu hoch).
      const qty = Math.max(1, line.quantity || 1);
      const purchase = round3(line.purchasePriceSnapshot * qty);
      const selling = round3(line.lineTotal);   // customer-facing price (incl. margin VAT, gesamt)
      const profit = round3(selling - purchase);
      const vatOnProfit = profit > 0 ? round3(profit - profit / (1 + (line.vatRate || 10) / 100)) : 0;
      const exclVat = round3(profit - vatOnProfit);

      rows.push(rowWithNote([
        '',
        inv.invoiceNumber,
        date,
        vatAcc,
        personalId,
        name,
        productLabel(products, line.productId),
        purchase,
        selling,
        profit,
        vatOnProfit,
        exclVat,
      ], note));

      mPurchase += purchase;
      mSelling += selling;
      mProfit += profit;
      mVat += vatOnProfit;
      mExcl += exclVat;
    }
  }

  rows.push([
    'Profit Margin Scheme Sales (Line 1 of the VAT Return)',
    '', '', '', '', '', '',
    round3(mPurchase),
    round3(mSelling),
    round3(mProfit),
    round3(mVat),
    round3(mExcl),
  ]);
  rows.push([]);

  // ── SECTION 3: Zero-Rated Domestic Sales ──
  rows.push(['Zero-Rated Domestic Sales (Line 4 of the VAT Return)']);
  rows.push(rowWithNote([
    'VAT Return Field Number',
    'Invoice Number',
    'Invoice Date',
    'Client VAT Account Number',
    'Client Personal ID',
    'Client Name',
    'Good/Service Description',
    'Total BHD (exclusive of VAT)',
  ], 'Internal Note — Original Invoice Date & Payments'));

  let zTotal = 0;

  for (const inv of bucket.invoices) {
    const zLines = inv.lines.filter(l => l.taxScheme === 'ZERO');
    if (zLines.length === 0) continue;
    const customer = customers.find(c => c.id === inv.customerId);
    const vatAcc = customer?.vatAccountNumber || '';
    const personalId = customer?.personalId || '';
    const name = customerLabel(customer);
    const pays = paymentsByInvoice?.get(inv.id);
    // v0.7.23 — angezeigtes Datum = Tag der Vollzahlung (Steuer-Zeitpunkt).
    const date = fmtDate(invoiceFinalizationDate(inv, pays));
    const note = paymentNote(inv, pays);

    for (const line of zLines) {
      const amount = round3(line.lineTotal);
      rows.push(rowWithNote([
        '',
        inv.invoiceNumber,
        date,
        vatAcc,
        personalId,
        name,
        productLabel(products, line.productId),
        amount,
      ], note));
      zTotal += amount;
    }
  }

  rows.push([
    'Zero-Rated Domestic Sales (Line 4 of the VAT Return)',
    '', '', '', '', '', '',
    round3(zTotal),
  ]);

  return rows;
}

/**
 * Generate the NBR VAT Excel file for a given year.
 * Downloads the file as `LATAIF_NBR_VAT_<year>.xlsx`.
 */
export function exportNbrVatReport(year: number, invoices: Invoice[], customers: Customer[], products: Product[], selectedInvoiceIds?: string[], paymentsByInvoice?: PaymentsByInvoice) {
  const wb = XLSX.utils.book_new();
  const selectedSet = selectedInvoiceIds ? new Set(selectedInvoiceIds) : undefined;
  const buckets = groupByMonth(year, invoices, selectedSet, paymentsByInvoice);

  for (const bucket of buckets) {
    const sheetData = buildMonthSheet(bucket, customers, products, paymentsByInvoice);
    const ws = XLSX.utils.aoa_to_sheet(sheetData);

    // Column widths (in characters)
    ws['!cols'] = [
      { wch: 8 },   // VAT Return Field Number
      { wch: 12 },  // Invoice Number
      { wch: 10 },  // Invoice Date
      { wch: 16 },  // Client VAT Account
      { wch: 16 },  // Client Personal ID
      { wch: 28 },  // Client Name
      { wch: 32 },  // Good/Service Description
      { wch: 14 },  // Numbers
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 3 },   // gap (col M) — trennt amtliches Raster von interner Notiz
      { wch: 52 },  // Internal Note — Original Invoice Date & Payments (col N)
    ];

    const sheetName = `${MONTHS[bucket.month]}${year}`;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const filename = `LATAIF_NBR_VAT_${year}.xlsx`;
  XLSX.writeFile(wb, filename);

  // Return summary for UI
  const totals = buckets.reduce(
    (acc, b) => {
      for (const inv of b.invoices) {
        for (const line of inv.lines) {
          if (line.taxScheme === 'VAT_10') {
            acc.standardNet += (line.lineTotal - line.vatAmount);   // B4 — Zeilen-Netto = Gross − VAT (qty-korrekt), nicht unitPrice (pro Stueck)
            acc.standardVat += line.vatAmount;
          } else if (line.taxScheme === 'MARGIN') {
            acc.marginProfit += (line.lineTotal - line.purchasePriceSnapshot * Math.max(1, line.quantity || 1));
          } else if (line.taxScheme === 'ZERO') {
            acc.zeroRated += line.lineTotal;
          }
        }
      }
      return acc;
    },
    { standardNet: 0, standardVat: 0, marginProfit: 0, zeroRated: 0 }
  );

  return {
    filename,
    year,
    invoiceCount: buckets.reduce((s, b) => s + b.invoices.length, 0),
    totals: {
      standardNet: round2(totals.standardNet),
      standardVat: round2(totals.standardVat),
      marginProfit: round2(totals.marginProfit),
      zeroRated: round2(totals.zeroRated),
    },
  };
}
