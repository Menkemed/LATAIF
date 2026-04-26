// NBR Bahrain VAT Export — exact structure as required by tax authority.
// One sheet per month (Jan2024, Feb2024, ...) with 3 sections:
//   1. Standard Rated Sales at 10% (Line 1 of the VAT Return)
//   2. Profit Margin Scheme Sales (Line 1 of the VAT Return)
//   3. Zero-Rated Domestic Sales (Line 4 of the VAT Return)

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

interface MonthInvoices {
  year: number;
  month: number; // 0-11
  invoices: Invoice[];
}

function groupByMonth(year: number, invoices: Invoice[], selectedIds?: Set<string>): MonthInvoices[] {
  const result: MonthInvoices[] = MONTHS.map((_, i) => ({ year, month: i, invoices: [] }));
  for (const inv of invoices) {
    const iso = inv.issuedAt || inv.createdAt;
    if (!iso) continue;
    const d = new Date(iso);
    if (d.getFullYear() !== year) continue;
    if (inv.status === 'CANCELLED' || inv.status === 'DRAFT') continue;
    if (selectedIds && !selectedIds.has(inv.id)) continue;
    result[d.getMonth()].invoices.push(inv);
  }
  return result;
}

function buildMonthSheet(
  bucket: MonthInvoices,
  customers: Customer[],
  products: Product[],
): AOA {
  const rows: AOA = [];

  // ── SECTION 1: Standard Rated Sales at 10% ──
  rows.push(['Standard Rated Sales at 10% (Line 1 of the VAT Return)']);
  rows.push([
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
  ]);

  let stdNet = 0, stdVat = 0, stdGross = 0;

  for (const inv of bucket.invoices) {
    const stdLines = inv.lines.filter(l => l.taxScheme === 'VAT_10');
    if (stdLines.length === 0) continue;
    const customer = customers.find(c => c.id === inv.customerId);
    const vatAcc = customer?.vatAccountNumber || '';
    const personalId = customer?.personalId || '';
    const name = customerLabel(customer);
    const date = fmtDate(inv.issuedAt || inv.createdAt);

    for (const line of stdLines) {
      const net = round3(line.unitPrice);
      const vat = round3(line.vatAmount);
      const gross = round3(line.lineTotal);
      rows.push([
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
      ]);
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
  rows.push([
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
  ]);

  let mPurchase = 0, mSelling = 0, mProfit = 0, mVat = 0, mExcl = 0;

  for (const inv of bucket.invoices) {
    const mLines = inv.lines.filter(l => l.taxScheme === 'MARGIN');
    if (mLines.length === 0) continue;
    const customer = customers.find(c => c.id === inv.customerId);
    const vatAcc = customer?.vatAccountNumber || '';
    const personalId = customer?.personalId || '';
    const name = customerLabel(customer);
    const date = fmtDate(inv.issuedAt || inv.createdAt);

    for (const line of mLines) {
      const purchase = round3(line.purchasePriceSnapshot);
      const selling = round3(line.lineTotal);   // customer-facing price (incl. margin VAT)
      const profit = round3(selling - purchase);
      const vatOnProfit = profit > 0 ? round3(profit - profit / (1 + (line.vatRate || 10) / 100)) : 0;
      const exclVat = round3(profit - vatOnProfit);

      rows.push([
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
      ]);

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
  rows.push([
    'VAT Return Field Number',
    'Invoice Number',
    'Invoice Date',
    'Client VAT Account Number',
    'Client Personal ID',
    'Client Name',
    'Good/Service Description',
    'Total BHD (exclusive of VAT)',
  ]);

  let zTotal = 0;

  for (const inv of bucket.invoices) {
    const zLines = inv.lines.filter(l => l.taxScheme === 'ZERO');
    if (zLines.length === 0) continue;
    const customer = customers.find(c => c.id === inv.customerId);
    const vatAcc = customer?.vatAccountNumber || '';
    const personalId = customer?.personalId || '';
    const name = customerLabel(customer);
    const date = fmtDate(inv.issuedAt || inv.createdAt);

    for (const line of zLines) {
      const amount = round3(line.lineTotal);
      rows.push([
        '',
        inv.invoiceNumber,
        date,
        vatAcc,
        personalId,
        name,
        productLabel(products, line.productId),
        amount,
      ]);
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
export function exportNbrVatReport(year: number, invoices: Invoice[], customers: Customer[], products: Product[], selectedInvoiceIds?: string[]) {
  const wb = XLSX.utils.book_new();
  const selectedSet = selectedInvoiceIds ? new Set(selectedInvoiceIds) : undefined;
  const buckets = groupByMonth(year, invoices, selectedSet);

  for (const bucket of buckets) {
    const sheetData = buildMonthSheet(bucket, customers, products);
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
            acc.standardNet += line.unitPrice;
            acc.standardVat += line.vatAmount;
          } else if (line.taxScheme === 'MARGIN') {
            acc.marginProfit += (line.lineTotal - line.purchasePriceSnapshot);
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
