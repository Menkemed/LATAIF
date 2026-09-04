// CENTRAL-C3A — was gilt, wenn der Commit durch ist, aber das Speichern nicht.
//
// Die Lücke, die dieser Zustand schließt, ist unauffällig und teuer: Die Transaktion ist committet,
// Wirkung und Nachweis stehen im Speicher — und dann scheitert das Schreiben auf die Platte. Der
// Speicher sagt jetzt „erledigt". Eine Wiederholung fände den Nachweis und meldete dem Client
// wortgleich Erfolg. Stirbt der Prozess eine Sekunde später, ist von alldem nichts da: der Kunde
// hat eine Belegnummer, die es nie gab.
//
// Also merkt sich der Prozess, dass er der Platte etwas schuldet. Solange diese Schuld offen ist:
//
//   • wird KEIN eingefrorenes Ergebnis herausgegeben, bevor der Stand wirklich gespeichert ist;
//   • wird KEIN neuer Fernschreibvorgang begonnen — er würde die Schuld nur vergrößern;
//   • wird KEIN Fernlesen beantwortet — eine Auskunft ist eine Bestätigung, und was ein Absturz
//     wegnimmt, darf nicht als verbindlich gelten;
//   • wird KEINE lokale Geschäftsmutation begonnen, ohne dass vorher gespeichert wurde.
//
// Nichts davon rollt etwas zurück. Wirkung und Nachweis bleiben zusammen im Speicher, so wie sie
// committet wurden; ein künstlicher Teilrollback wäre gefährlicher als der Zustand selbst. Sobald
// ein Speichern gelingt, ist die Schuld beglichen und alles läuft weiter.
//
// Der Zustand ist bewusst PROZESSWEIT und nicht pro Auftrag: die Geschäftsdatenbank ist EIN Abbild
// im Speicher, das als Ganzes geschrieben wird. Ein fehlgeschlagenes Speichern gefährdet deshalb
// nicht den einen Auftrag, sondern alles, was seit dem letzten gelungenen Schreiben passiert ist.

let debt: { reason: string; since: string } | null = null;

/**
 * Wie dieser Prozess seine Schuld begleicht. Wird einmal beim Hochfahren gesetzt (von der
 * Datenbankschicht), damit die Sperren nicht ihrerseits die Datenbank importieren müssen — sonst
 * zöge jeder Test der Warteschlange das ganze sql.js-Modul nach.
 */
let saver: (() => Promise<void>) | null = null;

export function setDurableSaver(fn: () => Promise<void>): void {
  saver = fn;
}

/** Schuldet dieser Prozess der Platte etwas? */
export function isDurabilityDegraded(): boolean {
  return debt !== null;
}

export function durabilityDebt(): { reason: string; since: string } | null {
  return debt;
}

/** Nach einem gescheiterten Speichern eines bereits committeten Standes. */
export function markDurabilityDegraded(reason: string, now: string): void {
  // Der ERSTE Fehler ist der interessante: er nennt den Zeitpunkt, ab dem der Stand nur noch im
  // Speicher steht. Spätere Fehlschläge überschreiben ihn nicht.
  if (!debt) debt = { reason, since: now };
}

/** Nur für Tests: Zustand und Speicherweg zurücksetzen. */
export function resetDurabilityStateForTest(): void {
  debt = null;
  saver = null;
}

/** Der Code, den ein Client in diesem Zustand sieht. Sein Ausgang ist offen, nicht „nicht passiert". */
export const DURABILITY_DEGRADED = 'DURABILITY_DEGRADED';

export class DurabilityError extends Error {
  readonly code = DURABILITY_DEGRADED;
  constructor(message: string) {
    super(message);
    this.name = 'DurabilityError';
  }
}

/**
 * Stellt sicher, dass der aktuelle Stand auf der Platte ist. Gelingt das Speichern, ist die Schuld
 * beglichen; gelingt es nicht, bleibt sie stehen und der Aufrufer erfährt es — er darf dann weder
 * ein Ergebnis herausgeben noch etwas Neues beginnen.
 */
export async function ensureDurable(save: () => Promise<void>, now: string): Promise<void> {
  try {
    await save();
    debt = null;
  } catch (err) {
    markDurabilityDegraded(String(err), now);
    throw new DurabilityError(`the business database could not be written: ${String(err)}`);
  }
}

/** Vor einem Fernauftrag: erst die Schuld begleichen, sonst gar nicht anfangen. */
export async function requireDurable(save: () => Promise<void>, now: string): Promise<void> {
  if (!debt) return;
  await ensureDurable(save, now);
}

/**
 * Dieselbe Sperre für Aufrufer, die den Speicherweg nicht selbst in der Hand haben — die lokale
 * Schreibreihenfolge und die Fernlesevorgänge. Im Normalfall kostet sie nichts: ohne Schuld kehrt
 * sie sofort zurück. Ist eine Schuld offen und niemand hat einen Speicherweg registriert, wird
 * abgewiesen statt gehofft.
 */
export async function requireDurableOrFail(now = new Date().toISOString()): Promise<void> {
  if (!debt) return;
  if (!saver) throw new DurabilityError(`the business database is unsaved since ${debt.since} and no writer is available`);
  await ensureDurable(saver, now);
}
