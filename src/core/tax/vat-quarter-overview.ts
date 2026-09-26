// ════════════════════════════════════════════════════════════════════════════
// VAT-QUARTALSÜBERSICHT — dieselbe Grundlage wie der NBR-Export.
//
// Vorher rechnete die Übersicht (Analytics → Quarterly VAT) nach Rechnungsdatum und zählte auch
// teilbezahlte Rechnungen mit; Export, Einreichung und Periodensperre dagegen nach dem Tag der
// Vollzahlung und nur FINAL. Eine Juni-Rechnung, im Juli voll bezahlt, stand damit in der Übersicht
// unter Q2, in der Erklärung unter Q3 — und „NET OWED"/„Mark paid" beruhten auf der anderen Zahl.
//
// Jetzt liest die Übersicht die Beträge aus dem Export selbst (`nbrMonthTotals`: dieselbe Auswahl,
// dieselbe Zeilenrechnung, die Summenzeilen der Tabellenblätter). Hier werden nur die Rechnungen im
// Export-Zuschnitt aus der Datenbank geholt (die Übersicht läuft auch als Auskunft am Primary, nicht
// aus dem Store) und die Monate zu NBR-Kalenderquartalen zusammengefasst.
//
//  • Teilbezahlte Rechnungen stehen in keinem Quartal: sie sind (noch) nicht im Export. Die
//    Übersicht zeigt sie getrennt, mit der VAT, die sie bei Vollzahlung hätten.
//  • Ein eingereichtes Quartal zeigt die bei der Einreichung festgehaltenen Zahlen — nie still
//    neu gerechnet. Die aktuelle Rechnung steht daneben, damit eine Abweichung auffällt.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { nbrMonthTotals, type NbrMonthTotals, type PaymentsByInvoice } from '@/core/tax/nbr-export';
import type { Invoice } from '@/core/models/types';

export interface VatQuarterFigures {
  /** YYYY-Qn (Kalenderquartal). */
  key: string;
  standardVat: number;
  marginVat: number;
  zeroRated: number;
  /** Ausgangs-VAT, wie die Erklärung sie trägt: Standard + Margin. */
  vat: number;
  invoiceCount: number;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function quarterKeyOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/** Monatssummen → Kalenderquartale. */
export function sumByQuarter(months: NbrMonthTotals[]): Map<string, VatQuarterFigures> {
  const out = new Map<string, VatQuarterFigures>();
  for (const m of months) {
    const key = quarterKeyOfMonth(m.month);
    const q = out.get(key) ?? { key, standardVat: 0, marginVat: 0, zeroRated: 0, vat: 0, invoiceCount: 0 };
    q.standardVat = r3(q.standardVat + m.standardVat);
    q.marginVat = r3(q.marginVat + m.marginVat);
    q.zeroRated = r3(q.zeroRated + m.zeroRated);
    q.vat = r3(q.standardVat + q.marginVat);
    q.invoiceCount += m.invoiceIds.length;
    out.set(key, q);
  }
  return out;
}

/** Rechnungen im Export-Zuschnitt aus der Datenbank: ohne Butterfly (wie die Vorauswahl des Exports). */
export function nbrInvoicesFromDb(branchId: string, status: 'FINAL' | 'PARTIAL'): { invoices: Invoice[]; payments: PaymentsByInvoice; gross: Map<string, { gross: number; paid: number }> } {
  const heads = query(
    `SELECT id, invoice_number, customer_id, status, issued_at, created_at, gross_amount, paid_amount
       FROM invoices WHERE branch_id = ? AND status = ? AND COALESCE(butterfly, 0) = 0`, [branchId, status],
  );
  const invoices: Invoice[] = [];
  const payments: PaymentsByInvoice = new Map();
  const gross = new Map<string, { gross: number; paid: number }>();
  if (heads.length === 0) return { invoices, payments, gross };
  const byId = new Map<string, Record<string, unknown>[]>();
  for (const l of query(
    `SELECT l.invoice_id, l.product_id, l.tax_scheme, l.quantity, l.line_total, l.vat_amount, l.purchase_price_snapshot, l.vat_rate
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.branch_id = ? AND i.status = ? AND COALESCE(i.butterfly, 0) = 0 ORDER BY l.position, l.id`, [branchId, status],
  )) {
    const k = String(l.invoice_id);
    byId.set(k, [...(byId.get(k) ?? []), l]);
  }
  for (const p of query(
    `SELECT p.invoice_id, p.amount, p.method, p.received_at
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.branch_id = ? AND i.status = ? AND COALESCE(i.butterfly, 0) = 0`, [branchId, status],
  )) {
    const k = String(p.invoice_id);
    payments.set(k, [...(payments.get(k) ?? []), { amount: Number(p.amount) || 0, method: String(p.method), receivedAt: String(p.received_at) }]);
  }
  for (const h of heads) {
    const id = String(h.id);
    gross.set(id, { gross: Number(h.gross_amount) || 0, paid: Number(h.paid_amount) || 0 });
    invoices.push({
      id, invoiceNumber: String(h.invoice_number), customerId: String(h.customer_id), status: String(h.status),
      issuedAt: (h.issued_at as string) || undefined, createdAt: String(h.created_at),
      lines: (byId.get(id) ?? []).map((l) => ({
        productId: String(l.product_id), taxScheme: String(l.tax_scheme), quantity: Number(l.quantity) || 1,
        lineTotal: Number(l.line_total) || 0, vatAmount: Number(l.vat_amount) || 0,
        purchasePriceSnapshot: Number(l.purchase_price_snapshot) || 0, vatRate: Number(l.vat_rate) || 0,
      })),
    } as unknown as Invoice);
  }
  return { invoices, payments, gross };
}

/** Die aktuelle Rechnung je Kalenderquartal — genau die Beträge eines NBR-Exports von heute. */
export function liveVatQuarters(branchId: string): Map<string, VatQuarterFigures> {
  const { invoices, payments } = nbrInvoicesFromDb(branchId, 'FINAL');
  return sumByQuarter(nbrMonthTotals(invoices, payments));
}

export interface PartialVatSummary { count: number; gross: number; open: number; pendingVat: number }

/**
 * Teilbezahlte Rechnungen — nicht im Export, in keinem Quartal. `pendingVat` ist die VAT, die sie
 * bei Vollzahlung trügen (dieselbe Zeilenrechnung; nur für die Anzeige als FINAL betrachtet).
 */
export function partialVatSummary(branchId: string): PartialVatSummary {
  const { invoices, gross } = nbrInvoicesFromDb(branchId, 'PARTIAL');
  if (invoices.length === 0) return { count: 0, gross: 0, open: 0, pendingVat: 0 };
  const alsFinal = invoices.map((i) => ({ ...i, status: 'FINAL' }) as Invoice);
  const t = nbrMonthTotals(alsFinal, new Map());
  let g = 0, open = 0;
  for (const v of gross.values()) { g += v.gross; open += Math.max(0, v.gross - v.paid); }
  return {
    count: invoices.length, gross: r3(g), open: r3(open),
    pendingVat: r3(t.reduce((s, m) => s + m.standardVat + m.marginVat, 0)),
  };
}

/**
 * Die bei der Einreichung festgehaltenen Zahlen. Neuere Einreichungen tragen sie als `totals`; eine
 * ältere wird aus IHREN gespeicherten Rechnungszeilen gerechnet (dieselbe Exportrechnung) — nie aus
 * dem heutigen Datenstand.
 */
export function filedVatFigures(key: string, snapshotJson: string | null | undefined): VatQuarterFigures | null {
  let snap: { totals?: VatQuarterFigures; invoices?: Array<Record<string, unknown>> };
  try { snap = JSON.parse(String(snapshotJson ?? '')); } catch { return null; }
  if (snap?.totals && typeof snap.totals.vat === 'number') return { ...snap.totals, key };
  const rows = Array.isArray(snap?.invoices) ? snap.invoices : null;
  if (!rows) return null;
  const invoices: Invoice[] = [];
  const payments: PaymentsByInvoice = new Map();
  for (const r of rows) {
    const id = String(r.invoiceId);
    payments.set(id, (Array.isArray(r.payments) ? r.payments : []) as { amount: number; method: string; receivedAt: string }[]);
    invoices.push({
      id, invoiceNumber: String(r.number ?? ''), customerId: String(r.customerId ?? ''), status: 'FINAL',
      issuedAt: String(r.issuedAt ?? ''), createdAt: String(r.issuedAt ?? ''),
      lines: (Array.isArray(r.lines) ? r.lines : []).map((l: unknown[]) => ({
        productId: String(l[0]), taxScheme: String(l[1]), quantity: Number(l[2]) || 1, lineTotal: Number(l[3]) || 0,
        vatAmount: Number(l[4]) || 0, purchasePriceSnapshot: Number(l[5]) || 0, vatRate: Number(l[6]) || 0,
      })),
    } as unknown as Invoice);
  }
  const q = sumByQuarter(nbrMonthTotals(invoices, payments)).get(key);
  return q ?? { key, standardVat: 0, marginVat: 0, zeroRated: 0, vat: 0, invoiceCount: 0 };
}
