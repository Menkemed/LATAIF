// ════════════════════════════════════════════════════════════════════════════
// STARTUP-MIGRATION-INTEGRITY — die historischen Bestandskorrekturen (2026-04/05) GENAU EINMAL je Datenbank.
//
// Sie standen im Migrationsblock von `runMigrations`, der bei JEDEM Start läuft, und rechneten so bei jedem Start
// Herkunft, Status, Einstand, Losbezug der Rechnungszeilen, Losreste und Mengen aus Rechnungszeilen neu — über alles
// hinweg, was seitdem geschah: ein Agentenverkauf, eine Produktion oder eine Rücksendung an den Lieferanten (Entnahme
// ohne Rechnungszeile) kam als Bestand zurück, eine Retoure „Keep" zählte doppelt, und jedes Edelmetall-Los
// (Stückmenge 0, Bestand im Gewicht) wurde EXHAUSTED.
//
// Jetzt:
//   • Merker gesetzt → nichts.
//   • Hatte die Datenbank `stock_lots` schon VOR diesem Start, lief sie mit einer Fassung, die diese Korrekturen
//     enthielt — sie kamen alle mit `89cbcf4` (2026-05-17, mit `stock_lots` selbst) oder mit dem ersten Commit. Sie
//     sind dort also angewandt, und zwar bei jedem Start bis heute: nur der Merker wird gesetzt, nichts neu gerechnet.
//   • Sonst (neue Datenbank, oder eine aus der Zeit vor den Losen): sie laufen EINMAL, in ihrer alten Reihenfolge,
//     zusammen mit dem Merker in einem Sicherungspunkt — ganz oder gar nicht; scheitert einer, bleibt der Merker aus.
//
// Bereits beschädigte Bestände werden hier NICHT repariert (keine Rekonstruktion aus Rechnungszeilen).
// ════════════════════════════════════════════════════════════════════════════

/** Die Datenbank, wie sql.js sie liefert — nur, was hier gebraucht wird (Node-tauglich, ohne Import). */
export interface LegacyRepairDb {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export const LEGACY_STOCK_REPAIR_FLAG = 'migration.legacy_stock_repairs_once_v1';

/** Die Korrekturen, in ihrer alten Reihenfolge und im alten Wortlaut — Edelmetall-Lose (`unit = 'mg'`) ausgenommen. */
export const LEGACY_STOCK_REPAIRS: readonly string[] = [
  // Mark products attached to active consignments as CONSIGNMENT source
  `UPDATE products SET source_type = 'CONSIGNMENT' WHERE id IN
    (SELECT product_id FROM consignments WHERE status != 'returned')`,

  // Mark products attached to active agent transfers as AGENT source
  `UPDATE products SET source_type = 'AGENT' WHERE id IN
    (SELECT product_id FROM agent_transfers WHERE status = 'transferred' OR status = 'sold')`,

  // 2026-05-16 — Backfill stock_status fuer Consignment-Produkte die VOR dem
  // Partial-Payment-Reservation-Fix verkauft wurden: Invoice nicht FINAL → 'consignment_reserved'.
  `UPDATE products SET stock_status = 'consignment_reserved'
     WHERE source_type = 'CONSIGNMENT'
       AND stock_status = 'sold'
       AND EXISTS (
         SELECT 1 FROM consignments c
           JOIN invoices i ON i.id = c.invoice_id
          WHERE c.product_id = products.id
            AND i.status NOT IN ('FINAL', 'CANCELLED', 'RETURNED')
       )`,
  // Analog fuer OWN-Produkte: 'sold', aber eine Invoice-Line nicht-FINAL → 'reserved'.
  `UPDATE products SET stock_status = 'reserved'
     WHERE source_type != 'CONSIGNMENT'
       AND stock_status = 'sold'
       AND EXISTS (
         SELECT 1 FROM invoice_lines il
           JOIN invoices i ON i.id = il.invoice_id
          WHERE il.product_id = products.id
            AND i.status NOT IN ('FINAL', 'CANCELLED', 'RETURNED')
       )
       AND NOT EXISTS (
         SELECT 1 FROM invoice_lines il2
           JOIN invoices i2 ON i2.id = il2.invoice_id
          WHERE il2.product_id = products.id
            AND i2.status = 'FINAL'
       )`,

  // 2026-05-16 — Backfill Cost fuer Consignment-Produkte mit purchase_price=0 (Los-Einstand, Auszahlung,
  // Schätzung aus Vereinbarung). Greift nur bei aktuell 0.
  `UPDATE products SET purchase_price = COALESCE(
     (SELECT sl.unit_cost FROM stock_lots sl
        WHERE sl.product_id = products.id AND sl.status != 'CANCELLED'
        ORDER BY sl.acquired_at DESC LIMIT 1),
     (SELECT CASE
        WHEN c.status IN ('sold', 'paid_out') AND COALESCE(c.payout_amount, 0) > 0 THEN c.payout_amount
        WHEN COALESCE(c.commission_type, 'percent') = 'consignor_fixed' THEN c.agreed_price
        ELSE c.agreed_price * (1.0 - COALESCE(c.commission_rate, 15) / 100.0)
      END
      FROM consignments c
      WHERE c.product_id = products.id
      ORDER BY c.created_at DESC LIMIT 1)
   )
   WHERE source_type = 'CONSIGNMENT'
     AND COALESCE(purchase_price, 0) = 0
     AND EXISTS (
       SELECT 1 FROM consignments c2 WHERE c2.product_id = products.id
     )`,

  // 2026-05-17 — Stock-Lot Reconciliation, Schritt 1: Orphan invoice_lines (lot_id IS NULL) für FINAL/PARTIAL
  // Invoices an den ersten verfügbaren Lot des Produkts hängen (FIFO).
  `UPDATE invoice_lines
     SET lot_id = (
       SELECT id FROM stock_lots
       WHERE product_id = invoice_lines.product_id
         AND status != 'CANCELLED'
         AND COALESCE(unit, 'pcs') = 'pcs'
       ORDER BY acquired_at ASC, id ASC
       LIMIT 1
     )
   WHERE lot_id IS NULL
     AND EXISTS (
       SELECT 1 FROM invoices i
       WHERE i.id = invoice_lines.invoice_id
         AND i.status IN ('FINAL', 'PARTIAL')
     )
     AND EXISTS (
       SELECT 1 FROM stock_lots sl
       WHERE sl.product_id = invoice_lines.product_id
         AND sl.status != 'CANCELLED'
         AND COALESCE(sl.unit, 'pcs') = 'pcs'
     )`,

  // Schritt 2: qty_remaining + status pro Lot aus den Rechnungszeilen zurückrechnen (CANCELLED bleibt CANCELLED).
  `UPDATE stock_lots
     SET qty_remaining = MAX(0,
           qty_total
           - COALESCE((
               SELECT SUM(il.quantity) FROM invoice_lines il
               JOIN invoices i ON i.id = il.invoice_id
               WHERE il.lot_id = stock_lots.id
                 AND i.status IN ('FINAL', 'PARTIAL')
             ), 0)
           + COALESCE((
               SELECT SUM(srl.quantity) FROM sales_return_lines srl
               JOIN invoice_lines il2 ON il2.id = srl.invoice_line_id
               WHERE il2.lot_id = stock_lots.id
             ), 0)
         ),
         status = CASE
           WHEN qty_total
                - COALESCE((
                    SELECT SUM(il.quantity) FROM invoice_lines il
                    JOIN invoices i ON i.id = il.invoice_id
                    WHERE il.lot_id = stock_lots.id
                      AND i.status IN ('FINAL', 'PARTIAL')
                  ), 0)
                + COALESCE((
                    SELECT SUM(srl.quantity) FROM sales_return_lines srl
                    JOIN invoice_lines il2 ON il2.id = srl.invoice_line_id
                    WHERE il2.lot_id = stock_lots.id
                  ), 0)
                <= 0 THEN 'EXHAUSTED'
           ELSE 'ACTIVE'
         END
   WHERE status != 'CANCELLED'
     AND COALESCE(unit, 'pcs') = 'pcs'`,

  // Schritt 3: products.quantity aus den Losen nachziehen.
  `UPDATE products
     SET quantity = COALESCE((
       SELECT SUM(qty_remaining)
       FROM stock_lots
       WHERE product_id = products.id
         AND status != 'CANCELLED'
         AND qty_remaining > 0
     ), products.quantity)
   WHERE EXISTS (
     SELECT 1 FROM stock_lots sl
     WHERE sl.product_id = products.id
   )`,
];

/** Gab es die Lose schon? VOR dem Migrationsblock zu fragen — der legt `stock_lots` an. */
export function hasStockLotsTable(db: LegacyRepairDb): boolean {
  return (db.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stock_lots'")[0]?.values.length ?? 0) > 0;
}

export type LegacyRepairOutcome = 'already-done' | 'marked-applied' | 'applied' | 'failed';

function setzeMerker(db: LegacyRepairDb): void {
  db.run(
    `INSERT INTO settings (branch_id, key, value, category, updated_at)
     VALUES ('branch-main', ?, '1', 'migration', ?)
     ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [LEGACY_STOCK_REPAIR_FLAG, new Date().toISOString()],
  );
}

/**
 * Nach dem Migrationsblock zu rufen (das Schema ist dann vollständig). `hadStockLotsBefore` ist die Antwort von
 * `hasStockLotsTable`, VOR dem Block gefragt.
 */
export function runLegacyStockRepairsOnce(db: LegacyRepairDb, hadStockLotsBefore: boolean): LegacyRepairOutcome {
  const merker = db.exec('SELECT value FROM settings WHERE key = ?', [LEGACY_STOCK_REPAIR_FLAG])[0]?.values?.[0]?.[0];
  if (merker === '1') return 'already-done';
  db.run('SAVEPOINT legacy_stock_repairs');
  try {
    if (!hadStockLotsBefore) {
      for (const sql of LEGACY_STOCK_REPAIRS) db.run(sql);
    }
    setzeMerker(db);
    db.run('RELEASE SAVEPOINT legacy_stock_repairs');
    return hadStockLotsBefore ? 'marked-applied' : 'applied';
  } catch (err) {
    // Ganz oder gar nicht: keine halbe Korrektur, kein Merker — der nächste Start versucht es wieder.
    try { db.run('ROLLBACK TO SAVEPOINT legacy_stock_repairs'); db.run('RELEASE SAVEPOINT legacy_stock_repairs'); } catch { /* */ }
    console.warn('[Migration] legacy stock repairs skipped:', err);
    return 'failed';
  }
}
