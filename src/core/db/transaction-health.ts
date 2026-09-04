// CENTRAL-C3A — wenn selbst die Rücknahme scheitert.
//
// Ein fehlgeschlagenes ROLLBACK sieht harmlos aus („dann ist die Transaktion eben offen"). Gemessen
// an einer echten sql.js-Datenbank ist es das nicht. Nach einem Teilwrite, einer Ablehnung und einem
// ROLLBACK, das die Datenbank nie erreicht hat, gilt:
//
//   • Die Transaktion ist WEITER OFFEN — ein neues `BEGIN` scheitert mit
//     „cannot start a transaction within a transaction".
//   • Die Teilwirkung ist im Speicher SICHTBAR: die halb geschriebene Zeile steht da, der geänderte
//     Betrag auch. Jede Abfrage danach liest schmutzige Daten.
//   • Weitere Schreibvorgänge werden ANGENOMMEN und hängen sich an dieselbe offene Transaktion.
//   • `export()` funktioniert — und beendet die offene Transaktion still. Danach meldet ein COMMIT
//     „no transaction is active", und das exportierte Abbild ist der Stand VOR der Transaktion.
//     Ein Speichern in diesem Zustand repariert also nichts, es verwischt nur die Spur: der
//     Aufrufer glaubt, seine Transaktion laufe noch, und sie ist längst weg.
//
// Deshalb wird hier nichts mehr versucht. Kein zweites SQL, keine Reparatur auf Verdacht, keine
// Auskunft aus dieser Datenbank, die jemand als verbindlich nehmen könnte. Der Prozess merkt sich,
// dass sein Transaktionszustand nicht mehr vertrauenswürdig ist, und sagt das ehrlich, bis er neu
// startet — dann kommt die Datenbank aus der letzten durablen Datei und ist nachweislich sauber.
//
// Bewusst KEINE Heilung zur Laufzeit: die Speicherschuld kann man nachholen, einen verlorenen
// Transaktionszustand nicht. Ein Neustart ist hier die einzige ehrliche Wiederherstellung.

let fault: { reason: string; since: string } | null = null;

export function isTransactionUnhealthy(): boolean {
  return fault !== null;
}

export function transactionFault(): { reason: string; since: string } | null {
  return fault;
}

/** Nach einem gescheiterten ROLLBACK — der erste Grund ist der interessante. */
export function markTransactionUnhealthy(reason: string, now: string): void {
  if (!fault) fault = { reason, since: now };
}

/** Nur für Tests: der Prozessneustart, den es in einem Testlauf nicht gibt. */
export function resetTransactionHealthForTest(): void {
  fault = null;
}

export const TRANSACTION_UNHEALTHY = 'TRANSACTION_UNHEALTHY';

export class TransactionUnhealthyError extends Error {
  readonly code = TRANSACTION_UNHEALTHY;
  constructor(message: string) {
    super(message);
    this.name = 'TransactionUnhealthyError';
  }
}

/** Vor allem, was diese Datenbank verändern oder aus ihr etwas bestätigen würde. */
export function assertTransactionHealthy(): void {
  if (!fault) return;
  throw new TransactionUnhealthyError(
    `the business database has an unresolved transaction since ${fault.since}: ${fault.reason} — restart required`,
  );
}
