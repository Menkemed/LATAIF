// PURCHASE-EDIT D1 — die Einstandskorrekturen LESEN (nur Abfragen, keine Buchung). Gewinnleser nehmen
// den wirksamen Einstand (Verkaufstag + Korrektur); Steuerleser nehmen ihn ausdrücklich NICHT.
// Die Wirkung (Anlegen, Mitdrehen) steht in `cost-correction.ts` und `purchase-edit-house.ts`.
import { query } from '@/core/db/helpers';

/** Gibt es die Tabelle (eine sehr alte oder eine Test-Datenbank ohne Migration hat sie nicht)? */
export function hasCostCorrectionTable(): boolean {
  return query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cost_corrections' LIMIT 1").length > 0;
}

/**
 * SQL-Ausdruck: Σ der wirksamen Korrekturbeträge einer Rechnung (Spalte `i.id`). Positiv = Einstand
 * gestiegen (Gewinn kleiner). Für Leser, die Rechnungen per SQL summieren. Ohne die Tabelle: `0`.
 */
export function invoiceCostCorrectionSql(): string {
  return hasCostCorrectionTable()
    ? `(SELECT COALESCE(SUM(cc.amount), 0) FROM cost_corrections cc WHERE cc.invoice_id = i.id AND cc.status = 'ACTIVE')`
    : '0';
}

/** Dasselbe je Rechnungszeile (Spalte `il.id`). */
export function lineCostCorrectionSql(): string {
  return hasCostCorrectionTable()
    ? `(SELECT COALESCE(SUM(cc.amount), 0) FROM cost_corrections cc WHERE cc.invoice_line_id = il.id AND cc.status = 'ACTIVE')`
    : '0';
}

/** Σ der wirksamen Korrekturbeträge je Rechnung. */
export function costCorrectionsByInvoice(invoiceIds?: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!hasCostCorrectionTable()) return out;
  const rows = invoiceIds && invoiceIds.length > 0
    ? query(`SELECT invoice_id, COALESCE(SUM(amount), 0) AS t FROM cost_corrections WHERE status = 'ACTIVE'
               AND invoice_id IN (${invoiceIds.map(() => '?').join(',')}) GROUP BY invoice_id`, [...invoiceIds])
    : query(`SELECT invoice_id, COALESCE(SUM(amount), 0) AS t FROM cost_corrections WHERE status = 'ACTIVE' GROUP BY invoice_id`);
  for (const r of rows) out.set(String(r.invoice_id), Number(r.t) || 0);
  return out;
}

/** Σ der wirksamen Korrekturbeträge je Rechnungszeile. */
export function costCorrectionsByLine(invoiceLineIds?: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!hasCostCorrectionTable()) return out;
  const rows = invoiceLineIds && invoiceLineIds.length > 0
    ? query(`SELECT invoice_line_id, COALESCE(SUM(amount), 0) AS t FROM cost_corrections WHERE status = 'ACTIVE'
               AND invoice_line_id IN (${invoiceLineIds.map(() => '?').join(',')}) GROUP BY invoice_line_id`, [...invoiceLineIds])
    : query(`SELECT invoice_line_id, COALESCE(SUM(amount), 0) AS t FROM cost_corrections WHERE status = 'ACTIVE' GROUP BY invoice_line_id`);
  for (const r of rows) out.set(String(r.invoice_line_id), Number(r.t) || 0);
  return out;
}

/** Hat diese Rechnung wirksame Einstandskorrekturen? (Hinweis „korrigiert" an Beleg und Bericht) */
export function invoiceCostCorrections(invoiceId: string): Array<{
  id: string; correctionNumber: string; invoiceLineId: string; amount: number; quantity: number; unitDelta: number;
  bookingDate: string; economicDate: string; vatEstimate: number; vatStatus: string; purchaseId: string;
}> {
  if (!hasCostCorrectionTable()) return [];
  return query(
    `SELECT id, correction_number, invoice_line_id, amount, quantity, unit_delta, booking_date, economic_date, vat_estimate,
            vat_status, purchase_id
       FROM cost_corrections WHERE invoice_id = ? AND status = 'ACTIVE' ORDER BY created_at, id`,
    [invoiceId],
  ).map((r) => ({
    id: String(r.id), correctionNumber: String(r.correction_number), invoiceLineId: String(r.invoice_line_id),
    amount: Number(r.amount) || 0, quantity: Number(r.quantity) || 0, unitDelta: Number(r.unit_delta) || 0,
    bookingDate: String(r.booking_date), economicDate: String(r.economic_date), vatEstimate: Number(r.vat_estimate) || 0,
    vatStatus: String(r.vat_status), purchaseId: String(r.purchase_id),
  }));
}

/** Die Rechnungszeilen dieser Rechnung, die eine wirksame Korrektur tragen. */
export function correctedLinesOf(invoiceId: string): Set<string> {
  if (!hasCostCorrectionTable()) return new Set();
  return new Set(query(`SELECT DISTINCT invoice_line_id FROM cost_corrections WHERE invoice_id = ? AND status = 'ACTIVE'`, [invoiceId])
    .map((r) => String(r.invoice_line_id)));
}

/** Die Überleitungsansicht (D1): jede Korrektur genau einmal, mit beiden Daten. Nur lesend. */
export interface CostCorrectionRow {
  id: string;
  correctionNumber: string;
  status: string;
  purchaseId: string;
  purchaseNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  productId: string | null;
  productLabel: string;
  quantity: number;
  oldUnitCost: number;
  newUnitCost: number;
  amount: number;
  bookingDate: string;
  economicDate: string;
  saleTaxScheme: string | null;
  vatStatus: string;
  vatEstimate: number;
  reversedAt: string | null;
}

export function costCorrectionRows(branchId: string): CostCorrectionRow[] {
  if (!hasCostCorrectionTable()) return [];
  return query(
    `SELECT cc.*, p.purchase_number, i.invoice_number, pr.brand, pr.name
       FROM cost_corrections cc
       LEFT JOIN purchases p ON p.id = cc.purchase_id
       LEFT JOIN invoices i ON i.id = cc.invoice_id
       LEFT JOIN products pr ON pr.id = cc.product_id
      WHERE cc.branch_id = ?
      ORDER BY cc.booking_date DESC, cc.created_at DESC, cc.id`,
    [branchId],
  ).map((r) => ({
    id: String(r.id), correctionNumber: String(r.correction_number), status: String(r.status),
    purchaseId: String(r.purchase_id), purchaseNumber: String(r.purchase_number ?? ''),
    invoiceId: String(r.invoice_id), invoiceNumber: String(r.invoice_number ?? ''),
    productId: r.product_id ? String(r.product_id) : null,
    productLabel: [r.brand, r.name].filter((x) => typeof x === 'string' && x).join(' '),
    quantity: Number(r.quantity) || 0, oldUnitCost: Number(r.old_unit_cost) || 0, newUnitCost: Number(r.new_unit_cost) || 0,
    amount: Number(r.amount) || 0, bookingDate: String(r.booking_date), economicDate: String(r.economic_date),
    saleTaxScheme: r.sale_tax_scheme ? String(r.sale_tax_scheme) : null, vatStatus: String(r.vat_status),
    vatEstimate: Number(r.vat_estimate) || 0, reversedAt: r.reversed_at ? String(r.reversed_at) : null,
  }));
}

/**
 * Die Überleitung je Monat: was das Hauptbuch in diesem Monat bucht (COGS der Quelle COST_CORRECTION
 * nach Buchungsdatum, Gegenbuchungen eines Rechnungsstornos eingeschlossen) und was der Gewinnbericht
 * diesem Monat zuordnet (aktive Korrekturen nach wirtschaftlichem Datum). Über alle Monate gleichen sich
 * beide Spalten aus. Nur die Einstandskorrekturen — eine volle Abstimmung von Gewinnbericht und Hauptbuch
 * ist das ausdrücklich nicht.
 */
export function costCorrectionBridge(branchId: string): Array<{ month: string; booked: number; attributed: number; difference: number }> {
  const months = new Map<string, { booked: number; attributed: number }>();
  if (!hasCostCorrectionTable()) return [];
  for (const r of query(
    `SELECT substr(occurred_at, 1, 7) AS month,
            SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) AS net
       FROM ledger_entries
      WHERE source_module = 'COST_CORRECTION' AND account = 'COGS' AND branch_id = ?
      GROUP BY substr(occurred_at, 1, 7)`,
    [branchId],
  )) {
    const m = String(r.month);
    months.set(m, { booked: Number(r.net) || 0, attributed: 0 });
  }
  for (const r of costCorrectionRows(branchId)) {
    if (r.status !== 'ACTIVE') continue;
    const em = r.economicDate.slice(0, 7);
    const e = months.get(em) ?? { booked: 0, attributed: 0 };
    e.attributed += r.amount;
    months.set(em, e);
  }
  return [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, v]) => ({
    month, booked: Math.round(v.booked * 1000) / 1000, attributed: Math.round(v.attributed * 1000) / 1000,
    difference: Math.round((v.attributed - v.booked) * 1000) / 1000,
  }));
}
