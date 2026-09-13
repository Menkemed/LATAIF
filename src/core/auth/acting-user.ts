// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — wer eine Buchung verantwortet, während ein Fernauftrag läuft.
//
// Seit C3B lief jede Fernbuchung durch die Hausfunktionen des Primary — und die fragten den Urheber
// mit `currentUserId()`, also die ANMELDUNG AM PRIMARY. Ein Auftrag von PC2 (Benutzer B) wurde damit in
// Rechnung, Zahlung, Hauptbuch und Protokoll dem Menschen zugeschrieben, der gerade am Primary saß
// (Benutzer A). Der geprüfte Absender stand im durablen Nachweis, nur nicht in den Geschäftszeilen.
//
// Die Regel jetzt, an EINER Stelle:
//   • lokale Handlung am Primary → die Anmeldung am Primary (unverändert);
//   • Fernauftrag → der AUTHENTIFIZIERTE Absender aus den geprüften Ansprüchen (`identity.userId`),
//     gesetzt von `runRemoteCommand` für genau die Dauer seines Handlers;
//   • der Rumpf eines Clients nennt den Urheber nie — kein Parser nimmt `createdBy`/`userId` an.
//
// Ein Modul-Zustand genügt, weil ein Fernauftrag im EXKLUSIVEN Platz der einen Schreibreihenfolge
// läuft (kein zweiter Geschäftsauftrag, solange er — auch über ein `await` hinweg — arbeitet).
// ════════════════════════════════════════════════════════════════════════════

let acting: string | null = null;

/** Der Urheber des gerade laufenden Fernauftrags — `null` außerhalb eines Fernauftrags. */
export function actingUserId(): string | null {
  return acting;
}

/**
 * Führt `fn` im Namen von `userId` aus. Verschachtelt stellt es den vorigen Wert wieder her; ein Fehler
 * räumt genauso auf wie ein Erfolg — danach gilt wieder die Anmeldung am Primary.
 */
export async function withActingUser<T>(userId: string, fn: () => T | Promise<T>): Promise<T> {
  if (!userId) throw new Error('withActingUser needs the authenticated user of the command');
  const vorher = acting;
  acting = userId;
  try {
    return await fn();
  } finally {
    acting = vorher;
  }
}
