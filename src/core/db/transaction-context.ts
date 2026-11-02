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
//
// MIXED-INVOICE P1a — eine gescheiterte innere Ebene macht die GANZE Transaktion rollback-only.
// Vorher rollte eine innere Ebene (z. B. `editInvoice` in `runOnPrimary`) sofort alles zurück und
// setzte den Zähler auf 0; fing der Äußere den Fehler, schrieb er danach OHNE Transaktion weiter
// (bewiesen im Nachaudit, Fall P4b). Jetzt bleibt die SQL-Transaktion offen, bis ihr Eigentümer sie
// schließt; jedes weitere Betreten, Verlassen und jeder Datenschreibvorgang (Schreibwächter) wirft,
// und das äußere Commit rollt zurück. Erst die äußerste Rücksetzung hebt den Zustand auf.
//
// Dazu die Folgen am äußeren Commit (`runAtOuterCommit`, z. B. `invoice.paid`): sie laufen erst,
// wenn ALLE Schritte der äußersten Transaktion gelungen sind — IN ihr, unmittelbar vor ihrem COMMIT.
// Ihre Schreibwirkungen (Artikel „sold", letzter Kauf, Erinnerungen, Auftrag/Reparatur bezahlt) sind
// damit atomar mit der Rechnung: ein Rollback nimmt beide, ein COMMIT und das Speichern danach beide.
// Bei einem Rollback laufen sie nie; je Transaktion und Schlüssel höchstens einmal.
// ═══════════════════════════════════════════════════════════

let txDepth = 0;
let pendingSave = false;

/** Warum die offene Transaktion nicht mehr committet werden darf; null = sie darf. */
let rollbackOnly: string | null = null;
/** Je offene Ledger-Ebene (`beginLedgerTransaction`): hat SIE das SQL-BEGIN gesetzt? */
let ledgerLevels: boolean[] = [];
/** Folgen dieser Transaktion, die am Ende ihrer äußersten Ebene laufen (vor dem COMMIT, in ihr). */
let outerCommitEffects: Array<{ key: string; run: () => void }> = [];

export const TRANSACTION_ROLLBACK_ONLY = 'TRANSACTION_ROLLBACK_ONLY';

/** Fail-closed: diese Transaktion ist gescheitert und wird nur noch zurückgerollt. */
export class TransactionRollbackOnly extends Error {
  readonly code = TRANSACTION_ROLLBACK_ONLY;
  constructor(reason: string) {
    super(`The transaction failed (${reason}) and was rolled back — nothing was saved.`);
    this.name = 'TransactionRollbackOnly';
  }
}

/** true, solange eine (ggf. verschachtelte) SQL-Transaktion offen ist. */
export function isTransactionActive(): boolean {
  return txDepth > 0;
}

/** Aktuelle Verschachtelungstiefe — nur für Tests/Diagnose. */
export function transactionDepth(): number {
  return txDepth;
}

/** Ist die offene Transaktion gescheitert (nur noch Rollback erlaubt)? */
export function isRollbackOnly(): boolean {
  return rollbackOnly !== null;
}

/** Markiert die offene Transaktion als gescheitert. Der erste Grund bleibt. */
export function markRollbackOnly(reason: string): void {
  if (txDepth > 0 && rollbackOnly === null) rollbackOnly = reason;
}

/** Wirft, wenn die offene Transaktion gescheitert ist — für jeden weiteren Schreibversuch. */
export function assertNotRollbackOnly(): void {
  if (rollbackOnly !== null) throw new TransactionRollbackOnly(rollbackOnly);
}

/**
 * Betritt eine Transaktionsebene (erhöht txDepth).
 * @returns true, wenn dies die ÄUSSERSTE Ebene ist (0 → 1) und der Aufrufer ein
 *          SQL BEGIN ausführen muss. Innere (verschachtelte) Ebenen liefern false.
 * @throws in einer gescheiterten Transaktion (P1a: keine neue Ebene in einer toten Klammer).
 */
export function enterTransaction(): boolean {
  assertNotRollbackOnly();
  const outermost = txDepth === 0;
  txDepth++;
  return outermost;
}

/**
 * Verlässt eine Transaktionsebene (senkt txDepth).
 * @returns true, wenn damit die ÄUSSERSTE Ebene verlassen wurde (1 → 0) und der
 *          Aufrufer ein SQL COMMIT ausführen muss. Innere Ebenen liefern false.
 * @throws wenn keine Transaktion aktiv ist (Programmierfehler beim Aufrufer) — oder wenn sie
 *         gescheitert ist (P1a): dann kein Verlassen und kein COMMIT; der catch des Aufrufers
 *         rollt zurück.
 */
export function leaveNestedTransaction(): boolean {
  if (txDepth === 0) {
    throw new Error('leaveNestedTransaction: no active transaction');
  }
  assertNotRollbackOnly();
  txDepth--;
  return txDepth === 0;
}

/** Eine gescheiterte INNERE Ebene geht (ohne Prüfung, ohne COMMIT) — die Klammer bleibt beim Äußeren. */
export function leaveFailedNestedLevel(): void {
  if (txDepth > 1) txDepth--;
}

/** Ledger-Ebene merken: `ownsSql` = sie hat das SQL-BEGIN gesetzt. */
export function pushLedgerLevel(ownsSql: boolean): void {
  ledgerLevels.push(ownsSql);
}

/** Die oberste Ledger-Ebene entfernen; undefined, wenn keine offen ist. */
export function popLedgerLevel(): boolean | undefined {
  return ledgerLevels.pop();
}

/** Gehört die SQL-Transaktion der obersten offenen Ledger-Ebene? */
export function topLedgerLevelOwnsSql(): boolean {
  return ledgerLevels.length > 0 && ledgerLevels[ledgerLevels.length - 1] === true;
}

/** Ist gerade irgendeine Ledger-Ebene offen? */
export function ledgerLevelOpen(): boolean {
  return ledgerLevels.length > 0;
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
 * Eine Folge, die erst am Ende der äußersten Transaktion laufen darf (z. B. `invoice.paid`) — wenn alle
 * ihre Schritte gelungen sind, in ihr, vor dem COMMIT. Ohne offene Ledger-Ebene läuft sie sofort — wie
 * bisher. Derselbe Schlüssel wird je Transaktion nur einmal vorgemerkt. Bei einem Rollback entfällt sie.
 */
export function runAtOuterCommit(key: string, run: () => void): void {
  if (!ledgerLevelOpen()) { run(); return; }
  if (outerCommitEffects.some((e) => e.key === key)) return;
  outerCommitEffects.push({ key, run });
}

/** Ist diese Folge in der offenen Transaktion schon vorgemerkt? */
export function isPendingAtOuterCommit(key: string): boolean {
  return outerCommitEffects.some((e) => e.key === key);
}

/** Die vorgemerkten Folgen übernehmen und leeren. */
export function takeOuterCommitEffects(): Array<{ key: string; run: () => void }> {
  const out = outerCommitEffects;
  outerCommitEffects = [];
  return out;
}

/** Folgen ausführen — jede für sich; ein Fehler darf die übrigen nicht verhindern. */
export function runEffects(list: ReadonlyArray<{ key: string; run: () => void }>): void {
  for (const e of list) {
    try { e.run(); } catch (err) { console.error(`[tx] commit effect ${e.key} failed:`, err); }
  }
}

/**
 * Harte Rücksetzung — bei ROLLBACK oder jedem Fehler, der die Gesamtoperation
 * ungültig macht: txDepth → 0 und pendingSave verworfen. Garantiert, dass txDepth
 * nach einem Fehler nie hängen bleibt und kein Save für zurückgerollte Daten läuft.
 * P1a: auch der Rollback-only-Zustand, die Ledger-Ebenen und die vorgemerkten Folgen gehen.
 */
export function resetTransactionContext(): void {
  txDepth = 0;
  pendingSave = false;
  rollbackOnly = null;
  ledgerLevels = [];
  outerCommitEffects = [];
}
