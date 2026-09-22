// ════════════════════════════════════════════════════════════════════════════
// STOCK-LOT-INTEGRITY — der EINE Bestandsvertrag eines Verkaufs.
//
// Ein Lagerartikel wird beim fachlichen Verkauf (Rechnung anlegen/ändern, Agentenverkauf)
// verbraucht — nicht pauschal beim Bezahlen. Zwei Formen, ein Vertrag:
//   • mit Los:  das Los trägt den Bestand (consumeLot/restoreLot, Menge folgt den Losen);
//   • ohne Los: `products.quantity` IST der Bestand (manuell/mobil angelegte Artikel,
//               Auftrags-Einzelstück). Verbraucht wird genau die Zeilenmenge.
// Ausnahmen, ausdrücklich: das Reparatur-Serviceprodukt (`svc-repair-*`) ist kein Lagerartikel;
// eine Zeile, deren Stück der Agentenverkauf schon hält, verbraucht nichts ein zweites Mal.
//
// Was eine Zeile genommen hat, steht in `invoice_lines.stock_taken` — Storno, Löschen und Ändern
// geben GENAU das zurück. NULL heißt: Zeile von vor diesem Vertrag; für sie bleiben die alten
// Wege unverändert (kein Raten über früher Abgezogenes).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { restoreLot, trackProductRow } from './lot-queries';
import { STOCK_UNAVAILABLE_MESSAGE } from './lot-availability';

/** Das Reparatur-Serviceprodukt ist eine Leistung, kein Lagerartikel. */
export function isServiceProduct(productId: string | null | undefined): boolean {
  return String(productId ?? '').startsWith('svc-repair-');
}

/** Wird der Artikel über Lose geführt (gibt es irgendeine Los-Zeile)? */
export function hasLotHistory(productId: string): boolean {
  return query('SELECT 1 FROM stock_lots WHERE product_id = ? LIMIT 1', [productId]).length > 0;
}

/** Artikel ohne Los, dessen Bestand `products.quantity` ist. */
function isLotLessStock(productId: string | null | undefined): productId is string {
  return !!productId && !isServiceProduct(productId) && !hasLotHistory(productId);
}

function rawQuantity(productId: string): number {
  return Number(query('SELECT COALESCE(quantity, 0) AS q FROM products WHERE id = ?', [productId])[0]?.q ?? 0);
}

export interface StockPick {
  productId?: string | null;
  lotId: string | null;
  qty: number;
  /** Das Stück hält schon ein anderer Vorgang (Agentenverkauf) — nichts ein zweites Mal nehmen. */
  preTaken?: boolean;
}

/**
 * Vor jedem Schreiben: reicht der Bestand der Artikel ohne Los für ALLE Zeilen zusammen?
 * (Mit Los prüfen `assertLotsConsumable` / `assertLotTrackedLinesResolved`.)
 */
export function assertLotLessStockAvailable(picks: readonly StockPick[]): void {
  const need = new Map<string, number>();
  for (const p of picks) {
    if (p.preTaken || p.lotId || !isLotLessStock(p.productId)) continue;
    need.set(p.productId, (need.get(p.productId) ?? 0) + Math.max(1, p.qty || 1));
  }
  for (const [pid, qty] of need) {
    if (rawQuantity(pid) < qty - 0.0005) throw new Error(STOCK_UNAVAILABLE_MESSAGE);
  }
}

/**
 * Nimmt den Bestand einer frisch geschriebenen Zeile und sagt, wie viel sie genommen hat.
 * Das Los selbst verbraucht der Aufrufer wie bisher (`consumeLot`); hier nur die Zahl dazu.
 */
export function takeStock(p: StockPick, now: string): number {
  const qty = Math.max(1, p.qty || 1);
  if (p.preTaken || !p.productId || isServiceProduct(p.productId)) return 0;
  if (p.lotId) return qty;
  if (!isLotLessStock(p.productId)) return 0;   // Los-Artikel ohne Los: vorher abgewiesen
  const db = getDatabase();
  const rest = rawQuantity(p.productId) - qty;
  if (rest < -0.0005) throw new Error(STOCK_UNAVAILABLE_MESSAGE);
  db.run(
    `UPDATE products SET quantity = ?,
       stock_status = CASE
         WHEN ? > 0 THEN stock_status
         WHEN stock_status IN ('in_stock', 'offered') THEN 'reserved'
         WHEN stock_status = 'consignment' THEN 'consignment_reserved'
         ELSE stock_status END,
       updated_at = ? WHERE id = ?`,
    [Math.max(0, rest), rest, now, p.productId],
  );
  trackProductRow(p.productId);
  return qty;
}

/** Gibt GENAU zurück, was eine Zeile/ein Vorgang genommen hat (`taken` > 0). */
export function giveBackStock(productId: string | null | undefined, lotId: string | null, taken: number, now: string): void {
  if (!(taken > 0) || !productId) return;
  if (lotId) { restoreLot(lotId, taken); return; }
  if (isServiceProduct(productId)) return;
  const db = getDatabase();
  db.run(
    `UPDATE products SET quantity = COALESCE(quantity, 0) + ?,
       stock_status = CASE
         WHEN stock_status IN ('reserved', 'sold') THEN 'in_stock'
         WHEN stock_status = 'consignment_reserved' THEN 'consignment'
         ELSE stock_status END,
       updated_at = ? WHERE id = ?`,
    [taken, now, productId],
  );
  trackProductRow(productId);
}

/**
 * Nimmt ein zurückgegebenes Stück ERNEUT (Storno einer Retoure). Fehlt es inzwischen (wieder
 * verkauft), wird abgewiesen statt still bei 0 zu kappen.
 */
export function retakeLotLessStock(productId: string, qty: number, now: string): void {
  const rest = rawQuantity(productId) - qty;
  if (rest < -0.0005) throw new Error(STOCK_UNAVAILABLE_MESSAGE);
  getDatabase().run(
    `UPDATE products SET quantity = ?, stock_status = CASE WHEN ? > 0 THEN stock_status ELSE 'sold' END,
       updated_at = ? WHERE id = ?`,
    [Math.max(0, rest), rest, now, productId],
  );
  trackProductRow(productId);
}

/** Die Zeilen einer Rechnung mit ihrem Nachweis — für Storno/Löschen/Ändern. */
export function invoiceStockLines(invoiceId: string): Array<{ id: string; productId: string | null; lotId: string | null; qty: number; stockTaken: number | null }> {
  return query('SELECT id, product_id, lot_id, quantity, stock_taken FROM invoice_lines WHERE invoice_id = ?', [invoiceId])
    .map((r) => ({
      id: String(r.id),
      productId: (r.product_id as string | null) ?? null,
      lotId: (r.lot_id as string | null) ?? null,
      qty: Math.max(1, Number(r.quantity ?? 1) || 1),
      stockTaken: r.stock_taken === null || r.stock_taken === undefined ? null : Number(r.stock_taken),
    }));
}

// ── Übergang: Rechnungszeilen von VOR diesem Vertrag (stock_taken NULL, ohne Los) ─────────────
//
// Der alte Vertrag zog beim Übergang auf FINAL genau 1 Stück ab (egal welche Zeilenmenge).
// `legacy_stock` hält fest, was davon bekannt ist:
//   'pending'  — noch nie FINAL: der alte Abzug kommt beim ersten FINAL, einmal;
//   'deducted' — der alte Abzug lief (jetzt FINAL oder im Protokoll ein Übergang auf FINAL);
//   'released' — dieser eine Abzug wurde beim Storno/Löschen zurückgegeben.
// Eingeordnet wird beim Start (`classifyLegacyInvoiceLines`), nur Zeilen ohne Merker.

/** Einmal je Start, idempotent: ordnet Altzeilen ohne Los nach Beleg (Status + Protokoll) ein. */
export function classifyLegacyInvoiceLines(db: { run: (sql: string, p?: unknown[]) => unknown }): void {
  const lotLess = `il.stock_taken IS NULL AND il.legacy_stock IS NULL AND il.lot_id IS NULL
      AND il.product_id IS NOT NULL AND il.product_id NOT LIKE 'svc-repair-%'
      AND NOT EXISTS (SELECT 1 FROM stock_lots sl WHERE sl.product_id = il.product_id)
      AND i.status != 'CANCELLED'`;
  const wasFinal = `(i.status = 'FINAL' OR EXISTS (SELECT 1 FROM audit_log a
      WHERE a.entity_type = 'invoices' AND a.entity_id = i.id AND a.field_name = 'status'
        AND a.new_value IN ('FINAL', '"FINAL"')))`;
  db.run(`UPDATE invoice_lines SET legacy_stock = 'deducted' WHERE id IN (
    SELECT il.id FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE ${lotLess} AND ${wasFinal})`);
  db.run(`UPDATE invoice_lines SET legacy_stock = 'pending' WHERE id IN (
    SELECT il.id FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE ${lotLess} AND NOT ${wasFinal})`);
}

/**
 * Die Kennung des Neins — intern (Fern-Urteil, Protokoll, Tests). Sie steht NICHT mehr am Anfang
 * des Satzes, den ein Mensch liest: der Code erklärt niemandem, was zu tun ist.
 */
export const LEGACY_STOCK_LINES = 'LEGACY_STOCK_LINES';
/** Was die Maske zeigt: der Grund und der Weg, in normalen Worten. */
export const LEGACY_STOCK_LINES_MESSAGE =
  'This invoice was created before the current stock tracking, so its items cannot be changed — '
  + 'how much stock they took back then is not recorded. Cancel this invoice and create a new one instead.';

/** Ein fachliches Nein mit interner Kennung; die Oberfläche zeigt nur den Satz. */
class LegacyStockLinesRejected extends Error {
  readonly code = LEGACY_STOCK_LINES;
  constructor() {
    super(LEGACY_STOCK_LINES_MESSAGE);
    this.name = 'LegacyStockLinesRejected';
  }
}

/** Ändern einer Rechnung mit Altzeilen ohne Los: fail-closed (die Altmenge ist nicht bekannt). */
export function assertNoLegacyLotLessLines(invoiceId: string): void {
  const legacy = query(
    `SELECT 1 FROM invoice_lines WHERE invoice_id = ? AND stock_taken IS NULL AND lot_id IS NULL AND legacy_stock IS NOT NULL LIMIT 1`,
    [invoiceId],
  );
  if (legacy.length > 0) {
    throw new LegacyStockLinesRejected();
  }
}

/** Storno/Löschen einer Altzeile ohne Los: genau den EINEN alten Abzug zurück, falls er lief — einmal. */
export function releaseLegacyDeduction(lineId: string, productId: string | null, now: string): void {
  const row = query('SELECT legacy_stock FROM invoice_lines WHERE id = ?', [lineId])[0];
  if (!row || row.legacy_stock !== 'deducted' || !productId) return;
  giveBackStock(productId, null, 1, now);
  getDatabase().run(`UPDATE invoice_lines SET legacy_stock = 'released' WHERE id = ?`, [lineId]);
}
