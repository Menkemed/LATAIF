// ════════════════════════════════════════════════════════════════════════════
// STOCK CORRECTION — der Korrekturbeleg kennt jetzt zwei Richtungen: ISSUE (Abgang, Phase 1) und RECEIPT (Altbestand
// zusätzlich erfasst, „Add Old Stock" — nur Menge, Eröffnung offen).
//
// Die Tabelle entstand mit `CHECK (direction IN ('ISSUE'))`. Phase 1 ist nie ausgeliefert worden, die neue Definition
// steht deshalb direkt in der Migration; nur eine Entwicklungs-/Testdatenbank, die die Tabelle schon mit der alten
// Regel angelegt hat, wird hier einmal umgebaut: neue Tabelle, Zeilen 1:1 kopiert, alte ersetzt, Indizes neu — alles
// in einem SAVEPOINT; scheitert ein Schritt, bleibt die alte Tabelle unverändert stehen.
// ════════════════════════════════════════════════════════════════════════════

interface SchemaDb {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export const OLD_DIRECTION_CHECK = "CHECK (direction IN ('ISSUE'))";
export const DIRECTION_CHECK = "CHECK (direction IN ('ISSUE','RECEIPT'))";
export const STOCK_ADJUSTMENT_INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_adjustments_action ON stock_adjustments(branch_id, action_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_adjustments_number ON stock_adjustments(branch_id, adjustment_number)',
  'CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product ON stock_adjustments(product_id)',
];

/** true = umgebaut; false = nichts zu tun (keine Tabelle oder schon die neue Regel). Wirft, wenn der Umbau scheitert. */
export function widenStockAdjustmentDirections(db: SchemaDb): boolean {
  const sql = db.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stock_adjustments'")[0]?.values?.[0]?.[0];
  if (typeof sql !== 'string' || !sql.includes(OLD_DIRECTION_CHECK)) return false;
  const neu = sql.replace(OLD_DIRECTION_CHECK, DIRECTION_CHECK).replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?"?stock_adjustments"?/i, 'CREATE TABLE stock_adjustments_widen');
  if (!neu.startsWith('CREATE TABLE stock_adjustments_widen')) throw new Error('stock_adjustments: unexpected table definition — not rebuilt');
  const vorher = Number(db.exec('SELECT COUNT(*) FROM stock_adjustments')[0]?.values?.[0]?.[0] ?? 0);
  db.run('SAVEPOINT widen_stock_adjustments');
  try {
    db.run('DROP TABLE IF EXISTS stock_adjustments_widen');
    db.run(neu);
    db.run('INSERT INTO stock_adjustments_widen SELECT * FROM stock_adjustments');
    const kopiert = Number(db.exec('SELECT COUNT(*) FROM stock_adjustments_widen')[0]?.values?.[0]?.[0] ?? -1);
    if (kopiert !== vorher) throw new Error(`stock_adjustments: copied ${kopiert} of ${vorher} rows`);
    db.run('DROP TABLE stock_adjustments');
    db.run('ALTER TABLE stock_adjustments_widen RENAME TO stock_adjustments');
    for (const ix of STOCK_ADJUSTMENT_INDEXES) db.run(ix);
    db.run('RELEASE SAVEPOINT widen_stock_adjustments');
    return true;
  } catch (err) {
    try { db.run('ROLLBACK TO SAVEPOINT widen_stock_adjustments'); db.run('RELEASE SAVEPOINT widen_stock_adjustments'); } catch { /* */ }
    throw err;
  }
}
