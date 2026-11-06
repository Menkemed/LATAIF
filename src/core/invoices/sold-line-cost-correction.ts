// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Review (O2) — den Einstand einer schon VERKAUFTEN Rechnungszeile nachträglich berichtigen.
//
// Owner-Regel: die Margin-VAT folgt der aktualisierten Marge (Kundenpreis − tatsächlicher Einstand). Zwei Fälle:
//
//   INVOICE  — die Rechnung liegt in einem OFFENEN Zeitraum (nach dem Eröffnungsstichtag, Quartal nicht gemeldet):
//              die Zeile bekommt den neuen Einstand, bei Margin die neu gerechnete Margin-VAT; Kopf-Schnappschüsse
//              folgen; die Buchung der Rechnung wird an ihren Originaltagen gegengebucht und zum Rechnungstag neu
//              gebucht (wie jede Rechnungskorrektur). Steuer- und Gewinnleser lesen danach dieselbe Zeile.
//   SEPARATE — die Rechnung liegt in einem GESCHLOSSENEN Quartal (oder vor dem Stichtag): sie bleibt unverändert.
//              Der Aufrufer bucht die Differenz in der offenen Periode (eigener Vorgang); eine mögliche VAT-Wirkung
//              wird nur geschätzt und als REVIEW geführt — der gesonderte VAT-Korrekturvorgang ist eine offene
//              Entscheidung (Vorschlag im Bericht), hier wird keine Steuer gebucht.
//
// Ein Sperrgrund (Retoure/Gutschrift, Rechnung mit Korrektur-Guthaben, negativer Einstand) ist kein Zeitraumproblem:
// er steht als `blocker` im Plan — der Aufrufer entscheidet (K3a: Nein, D1: eigener Beleg wie bisher).
// Wird von K3a (Goldschuld in BHD) und PURCHASE-EDIT D1 benutzt — EIN Weg, keine zweite Buchungslogik.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { reverseSource, postInvoiceIssued, activeSourceDates, hasLedgerEntries } from '@/core/ledger/posting';
import { correctionDateIssue } from '@/core/ledger/correction-dates';
import { vatFingerprint, assertVatUnchanged } from '@/core/tax/vat-period-lock';
import { vatEngine } from '@/core/tax/vat-engine';
import { useInvoiceStore } from '@/stores/invoiceStore';

export interface SoldLineRef { invoiceId: string; lineId: string }

export interface SoldLinePlan {
  mode: 'INVOICE' | 'SEPARATE';
  /** Warum SEPARATE (Zeitraum geschlossen / vor dem Stichtag) — der Text des Periodenschutzes. */
  periodReason?: string;
  /** Ein fachlicher Sperrgrund unabhängig vom Zeitraum; der Aufrufer entscheidet. */
  blocker?: { code: string; message: string };
  taxScheme: string;
  quantity: number;
  oldUnit: number; newUnit: number;
  oldVat: number; newVat: number;
}

const F = (v: unknown): number => Math.round((Number(v) || 0) * 1000);
const B = (fils: number): number => Math.round(fils) / 1000;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Was eine Berichtigung um `deltaFils` (Einstand der ganzen Zeile) bewirken würde — nur lesend. */
export function planSoldLineCostCorrection(sold: SoldLineRef, deltaFils: number, branchId: string): SoldLinePlan {
  const line = query('SELECT * FROM invoice_lines WHERE id = ? AND invoice_id = ?', [sold.lineId, sold.invoiceId])[0];
  const inv = query('SELECT id, issued_at, status FROM invoices WHERE id = ?', [sold.invoiceId])[0];
  if (!line || !inv) {
    return { mode: 'SEPARATE', blocker: { code: 'INVOICE_NOT_FOUND', message: 'The invoice of this item is missing.' },
      taxScheme: '', quantity: 1, oldUnit: 0, newUnit: 0, oldVat: 0, newVat: 0 };
  }
  const qty = Math.max(1, Number(line.quantity) || 1);
  const oldUnit = Number(line.purchase_price_snapshot) || 0;
  const newTotalF = F(oldUnit * qty) + deltaFils;
  const newUnit = Math.round((Math.max(0, newTotalF) / 1000 / qty) * 1e6) / 1e6;
  const taxScheme = String(line.tax_scheme ?? '');
  // Bei Margin ist die alte VAT die der alten Marge (dieselbe Formel) — eine Zeile, die (Altbestand) 0 speichert, wird so
  // nicht als „+volle VAT“ gemeldet; Hauptbuch und VAT-Übersicht rechnen ohnehin aus der Marge.
  const oldVat = taxScheme === 'MARGIN'
    ? (vatEngine.calcMarginFromNet(Number(line.line_total) || 0, B(F(oldUnit * qty)), Number(line.vat_rate) || 10).internalVatAmount ?? 0)
    : Number(line.vat_amount) || 0;
  // O2 — Margin-VAT aus der aktualisierten Marge (Kundenpreis − tatsächlicher Einstand), dieselbe Formel wie beim Anlegen.
  const newVat = taxScheme === 'MARGIN'
    ? (vatEngine.calcMarginFromNet(Number(line.line_total) || 0, B(Math.max(0, newTotalF)), Number(line.vat_rate) || 10).internalVatAmount ?? 0)
    : oldVat;
  const base = { taxScheme, quantity: qty, oldUnit, newUnit, oldVat, newVat };
  let blocker: SoldLinePlan['blocker'];
  if (newTotalF < 0) blocker = { code: 'COST_NEGATIVE', message: 'The cost of the item would become negative.' };
  const zurueck = Number(query(
    `SELECT (SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED')
          + (SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED') AS c`,
    [sold.invoiceId, sold.invoiceId])[0]?.c ?? 0);
  if (!blocker && zurueck > 0) {
    blocker = { code: 'INVOICE_HAS_RETURNS', message: 'The invoice already has a return or credit note — its cost cannot be corrected automatically.' };
  }
  if (!blocker) {
    const fremd = query(
      `SELECT 1 FROM ledger_entries e1 WHERE e1.source_module = 'INVOICE' AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
          AND e1.account NOT IN ('ACCOUNTS_RECEIVABLE','REVENUE','VAT_OUTPUT','MARGIN_VAT','COGS','INVENTORY')
          AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) LIMIT 1`, [sold.invoiceId]);
    if (fremd.length > 0) blocker = { code: 'INVOICE_HAS_EDIT_CREDIT', message: 'The invoice carries a credit from an earlier correction — its cost cannot be corrected automatically.' };
  }
  // Zeitraum: Gegenbuchung an den Originaltagen, Neubuchung am Rechnungstag — beide müssen offen sein.
  const dates = [...activeSourceDates('INVOICE', sold.invoiceId), String(inv.issued_at)].map((iso) => ({ iso, what: 'the correction of this invoice' }));
  const issue = correctionDateIssue(branchId, dates);
  return issue
    ? { mode: 'SEPARATE', periodReason: issue.message, ...(blocker ? { blocker } : {}), ...base }
    : { mode: 'INVOICE', ...(blocker ? { blocker } : {}), ...base };
}

/**
 * Führt eine INVOICE-Berichtigung aus (der Plan muss `mode: 'INVOICE'` ohne `blocker` sein). In der Klammer des Aufrufers.
 * `productUnitCost`: nur bei einem Einzelstück (Sonderstück) auch den Einstand des Artikels setzen.
 */
export function applySoldLineCostCorrection(
  sold: SoldLineRef, deltaFils: number, branchId: string, nowIso: string,
  opts: { setProductCost: boolean; auditField: string; auditContext?: Record<string, unknown> },
): { oldUnit: number; newUnit: number; oldVat: number; newVat: number } {
  const plan = planSoldLineCostCorrection(sold, deltaFils, branchId);
  if (plan.blocker) throw new Error(`sold-line correction: ${plan.blocker.code}`);
  if (plan.mode !== 'INVOICE') throw new Error('sold-line correction: the invoice is in a closed period');
  const line = query('SELECT product_id FROM invoice_lines WHERE id = ?', [sold.lineId])[0];
  const before = vatFingerprint(sold.invoiceId);
  const db = getDatabase();
  db.run('UPDATE invoice_lines SET purchase_price_snapshot = ?, vat_amount = ? WHERE id = ?', [plan.newUnit, plan.newVat, sold.lineId]);
  trackUpdate('invoice_lines', sold.lineId, { purchasePriceSnapshot: plan.newUnit, vatAmount: plan.newVat });
  const sums = query(
    `SELECT COALESCE(SUM(unit_price * MAX(1, quantity)), 0) AS net, COALESCE(SUM(vat_amount), 0) AS vat,
            COALESCE(SUM(purchase_price_snapshot * MAX(1, quantity)), 0) AS cost FROM invoice_lines WHERE invoice_id = ?`, [sold.invoiceId])[0];
  const net = Number(sums?.net) || 0, cost = r3(Number(sums?.cost) || 0), vat = r3(Number(sums?.vat) || 0);
  db.run('UPDATE invoices SET vat_amount = ?, purchase_price_snapshot = ?, margin_snapshot = ?, updated_at = ? WHERE id = ?',
    [vat, cost, r3(net - cost), nowIso, sold.invoiceId]);
  trackUpdate('invoices', sold.invoiceId, { vatAmount: vat, purchasePriceSnapshot: cost, marginSnapshot: r3(net - cost) });
  if (opts.setProductCost && line?.product_id) {
    db.run('UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ?', [plan.newUnit, nowIso, String(line.product_id)]);
    trackUpdate('products', String(line.product_id), { purchasePrice: plan.newUnit });
  }
  // Buchung wie jede Rechnungskorrektur: alles der Rechnung an den Originaltagen zurück, neu zum Rechnungstag.
  if (hasLedgerEntries('INVOICE', sold.invoiceId)) reverseSource('INVOICE', sold.invoiceId, nowIso, { mirrorOriginalDates: true });
  useInvoiceStore.getState().loadInvoices();
  const fresh = useInvoiceStore.getState().getInvoice(sold.invoiceId);
  if (!fresh) throw new Error('sold-line correction: the invoice could not be reloaded');
  postInvoiceIssued(fresh);
  // Ein gemeldetes Quartal (Export-Fingerabdruck) darf sich nicht still ändern.
  assertVatUnchanged(branchId, before, vatFingerprint(sold.invoiceId));
  logAuditOrThrow({
    module: 'Invoice', entityType: 'invoice_lines', entityId: sold.lineId, action: 'UPDATE', field: opts.auditField,
    oldValue: { purchasePriceSnapshot: plan.oldUnit, vatAmount: plan.oldVat },
    newValue: { purchasePriceSnapshot: plan.newUnit, vatAmount: plan.newVat, deltaFils, invoiceId: sold.invoiceId, ...(opts.auditContext ?? {}) },
  });
  return { oldUnit: plan.oldUnit, newUnit: plan.newUnit, oldVat: plan.oldVat, newVat: plan.newVat };
}
