// ════════════════════════════════════════════════════════════════════════════
// Einen Wareneingang rückgängig machen — was danach für den Artikel gilt. EINE Stelle für „Edit purchase →
// Remove Item" und „Cancel Purchase".
//
// Der Wareneingang setzt einen vorhandenen, nicht geschützten Artikel auf „in_stock" und `source_type = 'OWN'`
// (`insertPurchaseLineRows`, für den Kauf richtig: die Ware gehört dann uns). Den Zustand davor hält er nicht fest.
// Geht der Eingang wieder und bleibt kein Bestand aus anderen Losen:
//   • der STATUS kommt aus der Los- und Belegfolge zurück (`statusOhneBestand`) — eindeutig herleitbar;
//   • die HERKUNFT ist es nicht, wenn der Artikel vorher in Kommission oder bei einem Agenten war
//     (`herkunftUnklar`): dann wird nicht geraten, sondern das Rückgängigmachen gesperrt.
// Nur lesend; die Aufrufer schreiben.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';

const EPS = 0.0005;

/**
 * Der Status eines Artikels, dessen letzter Bestand mit dem rückgängig gemachten Wareneingang geht: der Zustand, den
 * ihm der Vorgang gab, der VORHER sein letztes Stück nahm — der jüngste aus der Los- und Belegfolge: ein Verkauf,
 * dessen Stück noch beim Kunden ist (abgeschlossen FINAL/RETURNED → 'sold', sonst 'reserved', dieselbe Regel wie
 * `reconcileSaleStatus`), eine Kundenretoure mit eigener Verwendung, eine Produktion, ein Bestandsabgang, eine echte
 * Rückgabe an den Lieferanten. Gab es keinen (das Stück kam nur mit diesem Eingang), gilt 'returned' wie bisher beim Storno.
 */
export function statusOhneBestand(productId: string): string {
  const ev: Array<{ at: string; status: string }> = [];
  for (const r of query(
    `SELECT i.status, i.created_at, COALESCE(il.quantity, 1) AS qty,
            (SELECT COALESCE(SUM(srl.quantity), 0) FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id
              WHERE srl.invoice_line_id = il.id AND sr.status != 'REJECTED') AS back
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE il.product_id = ? AND i.status != 'CANCELLED'`, [productId],
  )) {
    if (Number(r.qty) - Number(r.back) <= EPS) continue;   // alles zurück: dieser Verkauf hält kein Stück mehr
    ev.push({ at: String(r.created_at ?? ''), status: ['FINAL', 'RETURNED'].includes(String(r.status)) ? 'sold' : 'reserved' });
  }
  const verwendung: Record<string, string> = { UNDER_REPAIR: 'in_repair', WRITE_OFF: 'write_off', RETURN_TO_OWNER: 'returned' };
  for (const r of query(
    `SELECT DISTINCT sr.id, sr.product_disposition, sr.created_at FROM sales_returns sr JOIN sales_return_lines srl ON srl.return_id = sr.id
      WHERE srl.product_id = ? AND sr.status NOT IN ('REJECTED', 'REQUESTED')`, [productId],
  )) {
    const st = verwendung[String(r.product_disposition ?? '')];
    if (st) ev.push({ at: String(r.created_at ?? ''), status: st });
  }
  for (const r of query(
    'SELECT pr.created_at FROM production_inputs pi JOIN production_records pr ON pr.id = pi.record_id WHERE pi.product_id = ?', [productId],
  )) ev.push({ at: String(r.created_at ?? ''), status: 'consumed' });
  for (const r of query(
    `SELECT status_after, created_at FROM stock_adjustments WHERE product_id = ? AND direction = 'ISSUE' AND status != 'CANCELLED' AND COALESCE(status_after, '') != ''`,
    [productId],
  )) ev.push({ at: String(r.created_at ?? ''), status: String(r.status_after) });
  for (const r of query(
    `SELECT pr.created_at FROM purchase_return_lines prl JOIN purchase_returns pr ON pr.id = prl.return_id
      WHERE prl.product_id = ? AND pr.status != 'CANCELLED'`, [productId],
  )) ev.push({ at: String(r.created_at ?? ''), status: 'returned' });
  if (ev.length === 0) return 'returned';
  ev.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return ev[ev.length - 1].status;
}

/**
 * Wäre die Herkunft des Artikels nach dem Rückgängigmachen unklar? Ja, wenn er jetzt als eigen gilt
 * (`source_type = 'OWN'`), ihm OHNE die Lose `ownLotIds` kein Bestand bliebe (der Eingang war es, der ihn wieder ins
 * Lager und auf „eigen" brachte) und er vorher in Kommission oder bei einem Agenten war — welche Herkunft dann
 * gälte, ist nirgends festgehalten. Ein Artikel ohne solche Vorgeschichte war vorher eigen: das bleibt richtig.
 */
export function herkunftUnklar(productId: string, ownLotIds: readonly string[]): boolean {
  const p = query('SELECT source_type FROM products WHERE id = ?', [productId])[0];
  if (!p || String(p.source_type ?? 'OWN') !== 'OWN') return false;
  const marks = ownLotIds.map(() => '?').join(',');
  const rest = Number(query(
    `SELECT COALESCE(SUM(qty_remaining), 0) AS q FROM stock_lots
      WHERE product_id = ? AND status != 'CANCELLED' AND qty_remaining > 0${ownLotIds.length ? ` AND id NOT IN (${marks})` : ''}`,
    [productId, ...ownLotIds],
  )[0]?.q ?? 0);
  if (rest > EPS) return false;
  return query('SELECT 1 FROM consignments WHERE product_id = ? LIMIT 1', [productId]).length > 0
    || query('SELECT 1 FROM agent_transfers WHERE product_id = ? LIMIT 1', [productId]).length > 0;
}
