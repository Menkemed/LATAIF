// ═══════════════════════════════════════════════════════════
// LATAIF — Transaction Context (Ambient-SQL-Transaktion)
//
// Unabhängiger Zustands-Container für (verschachtelte) SQL-Transaktionen.
// Hält NUR Zustand (txDepth + pendingSave) — KEINE SQL-Befehle und KEINE
// Imports aus database.ts / posting.ts / Stores → garantiert kein Circular Import.
//
// HINTERGRUND (Release-Blocker, v0.8.6):
// sql.js' db.export() (in database.saveDatabase) BEENDET eine offene SQL-
// Transaktion. Wird es zwischen BEGIN und COMMIT ausgelöst — z.B. via
// trackChange→saveDatabase während editInvoice/cancelReturn bei AKTIVEM Sync —
// schlägt der spätere COMMIT mit "cannot commit - no transaction is active"
// fehl und hinterlässt einen inkonsistenten Teilzustand.
//
// LÖSUNG:
// database.saveDatabase() fragt isTransactionActive() ab und schiebt den Export
// auf (markSavePending), statt ihn auszuführen. Nur das ÄUSSERSTE COMMIT
// persistiert danach genau einmal (consumePendingSave). Ein ROLLBACK verwirft
// den pending Save (resetTransactionContext) → kein Phantom-Save / -Sync.
// ═══════════════════════════════════════════════════════════

let txDepth = 0;
let pendingSave = false;

/** true, solange eine (ggf. verschachtelte) SQL-Transaktion offen ist. */
export function isTransactionActive(): boolean {
  return txDepth > 0;
}

/** Aktuelle Verschachtelungstiefe — nur für Tests/Diagnose. */
export function transactionDepth(): number {
  return txDepth;
}

/**
 * Betritt eine Transaktionsebene (erhöht txDepth).
 * @returns true, wenn dies die ÄUSSERSTE Ebene ist (0 → 1) und der Aufrufer ein
 *          SQL BEGIN ausführen muss. Innere (verschachtelte) Ebenen liefern false.
 */
export function enterTransaction(): boolean {
  const outermost = txDepth === 0;
  txDepth++;
  return outermost;
}

/**
 * Verlässt eine Transaktionsebene (senkt txDepth).
 * @returns true, wenn damit die ÄUSSERSTE Ebene verlassen wurde (1 → 0) und der
 *          Aufrufer ein SQL COMMIT ausführen muss. Innere Ebenen liefern false.
 * @throws wenn keine Transaktion aktiv ist (Programmierfehler beim Aufrufer).
 */
export function leaveNestedTransaction(): boolean {
  if (txDepth === 0) {
    throw new Error('leaveNestedTransaction: no active transaction');
  }
  txDepth--;
  return txDepth === 0;
}

/** Merkt vor, dass nach dem äußersten COMMIT genau ein Save fällig ist. */
export function markSavePending(): void {
  pendingSave = true;
}

/**
 * Liest das pendingSave-Flag und setzt es atomar (single-threaded JS) zurück.
 * @returns true, wenn ein Save aussteht (→ Aufrufer persistiert danach genau einmal).
 */
export function consumePendingSave(): boolean {
  const had = pendingSave;
  pendingSave = false;
  return had;
}

/**
 * Harte Rücksetzung — bei ROLLBACK oder jedem Fehler, der die Gesamtoperation
 * ungültig macht: txDepth → 0 und pendingSave verworfen. Garantiert, dass txDepth
 * nach einem Fehler nie hängen bleibt und kein Save für zurückgerollte Daten läuft.
 */
export function resetTransactionContext(): void {
  txDepth = 0;
  pendingSave = false;
}
