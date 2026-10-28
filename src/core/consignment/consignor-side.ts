// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT MULTI-SALE / D3 / D4 — die Seite des Einlieferers je Kommission, abgeleitet beim LESEN (nie gespeichert).
//
// Seit „Record Sale" steht die Schuld an den Einlieferer als Einkauf bei seiner Lieferanten-Rolle (je Kommission einer,
// `purchases.source_consignment_id`), nicht mehr an der Kommission (`payout_amount − payout_paid_amount`, nur noch der
// Altweg ohne Rechnung). Wer „was schulden wir ihm noch?" fragte, las bisher das Kommissionsfeld — und zählte einen
// über den Einkauf bezahlten Verkauf weiter als offen. Hier steht die EINE Ableitung für alle Masken (Liste, Detail,
// Einlieferer-Seite), am Primary wie auf PC2 (sie reist mit dem Lesebefehl der Kommissionen):
//
//   • open      — was wir für den Verkauf noch schulden: offener Rest der wirksamen Einkäufe + offene Verlust-Ausgaben;
//                 beim Altweg ohne Rechnung `payout_amount − payout_paid_amount`;
//   • paid      — was er für den Verkauf schon bekam (bar und per Guthaben), beim Altweg `payout_paid_amount`;
//   • refunds   — D3: kam die Ware nach dem Verkauf zu ihm zurück, die Rückzahlung seiner Auszahlung (Lieferanten-
//                 Retoure des Einkaufs): sofort erhalten (Weg, Tag) oder offen als Lieferanten-Guthaben (Rest).
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import type { ConsignorRefundRow, ConsignorSide } from '@/core/models/types';

const r3 = (v: unknown): number => Math.round((Number(v) || 0) * 1000) / 1000;

/** Die Seite des Einlieferers für JEDE Kommission dieser Filiale, in drei Abfragen. */
export function consignorSidesFor(branchId: string, rows: ReadonlyArray<Record<string, unknown>>): Map<string, ConsignorSide> {
  const out = new Map<string, ConsignorSide>();
  const seite = (cid: string): ConsignorSide => {
    let s = out.get(cid);
    if (!s) { s = { open: 0, paid: 0, refunds: [], refundOpen: 0, returnRefund: 0 }; out.set(cid, s); }
    return s;
  };
  for (const p of query(
    `SELECT p.source_consignment_id AS cid,
            COALESCE(SUM(p.remaining_amount), 0) AS offen,
            COALESCE(SUM(p.paid_amount), 0) AS bar,
            COALESCE(SUM((SELECT COALESCE(SUM(pp.amount), 0) FROM purchase_payments pp
                           WHERE pp.purchase_id = p.id AND pp.method = 'credit' AND pp.voided_at IS NULL)), 0) AS guthaben
       FROM purchases p
      WHERE p.branch_id = ? AND p.source_consignment_id IS NOT NULL AND p.status != 'CANCELLED'
      GROUP BY p.source_consignment_id`,
    [branchId],
  )) {
    const s = seite(String(p.cid));
    s.open = r3(s.open + Number(p.offen));
    s.paid = r3(s.paid + Number(p.bar) + Number(p.guthaben));
    s.returnRefund = r3((s.returnRefund ?? 0) + Number(p.bar) + Number(p.guthaben));
  }
  // CONSIGNOR-JOINT-PURCHASE — ein gemeinsamer Einkauf (mehrere Artikel desselben Einlieferers, die Kommission an der ZEILE):
  // je Zeile ihr Wert (abzüglich ihrer Lieferanten-Retouren); das Bezahlte des Einkaufs (bar und per Guthaben) der Reihe nach
  // auf die Zeilen verteilt. Die Bücher führt der Einkauf als Ganzes — das hier ist nur die Anzeige je Kommission.
  for (const p of query(
    `SELECT p.id, COALESCE(p.paid_amount, 0) AS bar, COALESCE(p.remaining_amount, 0) AS offen,
            (SELECT COALESCE(SUM(pp.amount), 0) FROM purchase_payments pp
              WHERE pp.purchase_id = p.id AND pp.method = 'credit' AND pp.voided_at IS NULL) AS guthaben
       FROM purchases p
      WHERE p.branch_id = ? AND p.source_consignment_id IS NULL AND p.status != 'CANCELLED'
        AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id IS NOT NULL)`,
    [branchId],
  )) {
    let restF = Math.round((Number(p.bar) + Number(p.guthaben)) * 1000);
    for (const l of query(
      `SELECT pl.source_consignment_id AS cid,
              pl.line_total - COALESCE((SELECT SUM(prl.line_total) FROM purchase_return_lines prl
                                          JOIN purchase_returns pr ON pr.id = prl.return_id
                                         WHERE prl.purchase_line_id = pl.id AND pr.status != 'CANCELLED'), 0) AS wert
         FROM purchase_lines pl WHERE pl.purchase_id = ? AND pl.source_consignment_id IS NOT NULL ORDER BY pl.position, pl.id`,
      [String(p.id)],
    )) {
      const wertF = Math.max(0, Math.round(Number(l.wert) * 1000));
      const bezahltF = Math.min(restF, wertF);
      restF -= bezahltF;
      const s = seite(String(l.cid));
      s.paid = r3(s.paid + bezahltF / 1000);
      s.open = r3(s.open + (wertF - bezahltF) / 1000);
      // Eine Zeilen-Retoure mindert zuerst den offenen Rest des Einkaufs; zurück käme nur der Überschuss.
      s.returnRefund = r3((s.returnRefund ?? 0) + Math.max(0, wertF - Math.round(Number(p.offen) * 1000)) / 1000);
    }
  }
  for (const e of query(
    `SELECT e.related_entity_id AS cid,
            COALESCE(SUM(MAX(0, e.amount - COALESCE(e.paid_amount, 0)
              - COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0))), 0) AS offen
       FROM expenses e
      WHERE e.branch_id = ? AND e.related_module = 'consignment' AND e.category = 'ConsignorLoss' AND e.status != 'CANCELLED'
      GROUP BY e.related_entity_id`,
    [branchId],
  )) {
    const s = seite(String(e.cid));
    s.open = r3(s.open + Number(e.offen));
  }
  // D3 — die späteren Geldeingänge je Guthaben (nur am Primary gespeichert; PC2 bekommt sie mit diesem Lesebefehl).
  const eingaenge = new Map<string, ConsignorRefundRow['receipts']>();
  let hatTabelle = true;
  try { query('SELECT 1 FROM supplier_credit_refunds LIMIT 1'); } catch { hatTabelle = false; }
  if (hatTabelle) {
    for (const e of query(
      `SELECT id, supplier_credit_id, received_at, method, amount FROM supplier_credit_refunds
        WHERE branch_id = ? ORDER BY received_at ASC, created_at ASC, id ASC`,
      [branchId],
    )) {
      const k = String(e.supplier_credit_id);
      eingaenge.set(k, [...(eingaenge.get(k) ?? []), {
        id: String(e.id), date: String(e.received_at ?? '').slice(0, 10), method: String(e.method ?? ''), amount: r3(e.amount),
      }]);
    }
  }
  // CONSIGNOR-JOINT-PURCHASE — die Kommission einer Retoure: am Einkauf (ein Einkauf je Kommission) oder an der
  // zurückgegebenen Zeile (gemeinsamer Einkauf); „aktuell" über das Los genau dieser Zeile.
  for (const r of query(
    `SELECT x.*, EXISTS (SELECT 1 FROM invoice_lines il JOIN stock_lots sl ON sl.id = il.lot_id
                           JOIN consignments c ON c.invoice_id = il.invoice_id
                          WHERE c.id = x.cid AND sl.purchase_id = x.purchase_id
                            AND (x.line_id IS NULL OR sl.purchase_line_id = x.line_id)) AS aktuell
       FROM (
         SELECT pr.id, pr.return_number, pr.return_date, pr.refund_method, pr.refund_amount, pr.created_at AS created,
                p.id AS purchase_id,
                COALESCE(p.source_consignment_id,
                  (SELECT pl.source_consignment_id FROM purchase_return_lines prl JOIN purchase_lines pl ON pl.id = prl.purchase_line_id
                    WHERE prl.return_id = pr.id AND pl.source_consignment_id IS NOT NULL LIMIT 1)) AS cid,
                CASE WHEN p.source_consignment_id IS NULL THEN
                  (SELECT pl.id FROM purchase_return_lines prl JOIN purchase_lines pl ON pl.id = prl.purchase_line_id
                    WHERE prl.return_id = pr.id AND pl.source_consignment_id IS NOT NULL LIMIT 1) END AS line_id,
                sc.id AS credit_id, sc.amount AS credit_amount, sc.used_amount AS credit_used
           FROM purchase_returns pr
           JOIN purchases p ON p.id = pr.purchase_id
           LEFT JOIN supplier_credits sc ON sc.source_return_id = pr.id
          WHERE pr.branch_id = ? AND pr.status != 'CANCELLED' AND COALESCE(pr.refund_amount, 0) > 0.0005
       ) x
      WHERE x.cid IS NOT NULL
      ORDER BY x.created ASC, x.id ASC`,
    [branchId],
  )) {
    const s = seite(String(r.cid));
    const pending = String(r.refund_method ?? '') === 'credit';
    const open = pending ? Math.max(0, r3(Number(r.credit_amount ?? 0) - Number(r.credit_used ?? 0))) : 0;
    const creditId = pending && r.credit_id ? String(r.credit_id) : null;
    const receipts = creditId ? (eingaenge.get(creditId) ?? []) : [];
    const received = r3(receipts.reduce((x, e) => x + e.amount, 0));
    s.refunds.push({
      returnId: String(r.id), returnNumber: String(r.return_number ?? ''), date: String(r.return_date ?? ''),
      mode: pending ? 'pending' : 'received', method: pending ? null : String(r.refund_method ?? ''),
      amount: r3(r.refund_amount), open, currentSale: Number(r.aktuell) === 1,
      creditId, receipts, received,
      offset: pending ? Math.max(0, r3(Number(r.credit_used ?? 0) - received)) : 0,
    });
    s.refundOpen = r3(s.refundOpen + open);
  }
  // Der Altweg ohne Rechnung (`markSold` + „Pay Out Consignor"): die Schuld steht an der Kommission selbst.
  for (const c of rows) {
    if (String(c.invoice_id ?? '') !== '') continue;
    const status = String(c.status ?? '');
    if (status !== 'sold' && status !== 'SOLD' && status !== 'paid_out') continue;
    const s = seite(String(c.id));
    const ziel = Number(c.payout_amount ?? 0);
    const bezahlt = Number(c.payout_paid_amount ?? 0);
    s.open = r3(s.open + Math.max(0, ziel - bezahlt));
    s.paid = r3(s.paid + bezahlt);
  }
  return out;
}

/** Was die Kommissions-KPI „Outstanding Payout" zählt: offen nur für einen noch verkauften Artikel. */
export function consignorOpenFor(c: { status: string; consignorSide?: ConsignorSide }): number {
  if (c.status !== 'sold' && c.status !== 'SOLD') return 0;
  return c.consignorSide?.open ?? 0;
}
