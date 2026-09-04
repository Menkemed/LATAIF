// CENTRAL-C3A — ein Fernauftrag, der Geschäftsdaten ändert: genau einmal, oder gar nicht.
//
// Der Ablauf ist eine einzige Transaktion, und die Reihenfolge darin ist der ganze Vertrag:
//
//   BEGIN
//     Kennung nachschlagen        — ist das hier schon gelaufen?
//     Geschäftswirkung ausführen  — Belegnummer, Domänenschreibvorgänge, Buchungen
//     Ergebnis einfrieren         — dieselbe Transaktion, nicht die nächste
//   COMMIT
//   durabel speichern             — erst danach darf „erfolgreich" gemeldet werden
//
// Was daran wichtig ist, in der Reihenfolge der Gefahren:
//
//  1. **Wirkung und Nachweis teilen ein Schicksal.** Lägen sie in zwei Commits, gäbe es ein
//     Fenster, in dem die Buchung existiert und der Nachweis nicht — eine Wiederholung würde
//     ein zweites Mal buchen. Deshalb schreibt `recordCommand` INNERHALB derselben Transaktion.
//  2. **Ein verlorener Antwortweg ist kein Fehlschlag.** Der Auftrag kann vollständig gelaufen
//     sein. Beim zweiten Versuch mit derselben Kennung wird der Geschäftscode NICHT erneut
//     ausgeführt; es kommt die eingefrorene Antwort zurück.
//  3. **Eine Störung wird nicht als Erfolg festgehalten.** Nur ein Ergebnis oder eine endgültige
//     fachliche Ablehnung wird eingefroren. Alles andere hinterlässt keine Zeile — die Kennung
//     bleibt frei, und der Client darf es erneut versuchen.
//  4. **Gespeichert wird vor der Erfolgsmeldung.** Die Geschäftsdatenbank liegt im Speicher und
//     wird als ganzes Abbild geschrieben. Ein „erfolgreich" ohne bestätigtes Speichern wäre
//     dasselbe Versprechen, das A1 beim Pull-Stand schon einmal gebrochen hat.
//
// C3A registriert bewusst NOCH KEINE produktive Operation: `REMOTE_MUTATIONS_ENABLED` bleibt
// zu. Diese Maschine ist gebaut und geprüft, aber sie hat noch keinen Kunden.

import type { SqlDb } from '../sync/apply-change';
import { lookupCommand, recordCommand, type CommandIdentity, type CommandRecord } from './command-ledger';

/**
 * Eine fachliche Ablehnung. `terminal` entscheidet, ob sie eingefroren wird:
 *
 *   • `true`  — sie hängt an der EINGABE und fällt jedes Mal gleich aus (Pflichtfeld fehlt,
 *               fremde Filiale, unbekannte Kennung). Einfrieren ist richtig und spart dem Client
 *               eine sinnlose Wiederholung.
 *   • `false` — sie hängt am ZUSTAND (`STOCK_UNAVAILABLE`, „schon bezahlt"). Morgen kann dieselbe
 *               Anfrage zu Recht gelingen. Sie einzufrieren wäre eine falsche Endgültigkeit.
 */
export class CommandRejected extends Error {
  readonly code: string;
  readonly terminal: boolean;
  constructor(code: string, message: string, terminal: boolean) {
    super(message);
    this.name = 'CommandRejected';
    this.code = code;
    this.terminal = terminal;
  }
}

/** Was der Aufrufer zurückbekommt — dieselben drei Ausgänge wie an der Brücke. */
export type CommandOutcome =
  | { readonly kind: 'ok'; readonly value: unknown; readonly replayed: boolean }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string; readonly replayed: boolean };

export interface EngineDeps {
  readonly db: SqlDb;
  /** Öffnet die äußerste Transaktion (oder verschachtelt sich, wenn schon eine läuft). */
  readonly begin: () => void;
  readonly commit: () => void;
  readonly rollback: () => void;
  /** Speichert die Geschäftsdatenbank durabel. Wirft bei Persistenzfehler. */
  readonly durableSave: () => Promise<void>;
  readonly now: () => string;
}

/**
 * Führt einen Fernauftrag aus. `handler` bekommt die Datenbank und läuft INNERHALB der
 * Transaktion — er darf Belegnummern ziehen, schreiben und buchen, aber weder committen noch
 * speichern; beides gehört hierher.
 */
export async function runRemoteCommand(
  deps: EngineDeps,
  identity: CommandIdentity,
  handler: (db: SqlDb) => unknown,
): Promise<CommandOutcome> {
  const { db } = deps;
  let record: CommandRecord | null = null;
  let replayed = false;

  deps.begin();
  try {
    // Nachschlagen INNERHALB der Transaktion: sonst könnte zwischen Frage und Buchung ein
    // zweiter Auftrag dieselbe Kennung belegen.
    const seen = lookupCommand(db, identity);
    if (seen.kind === 'conflict') {
      // Kein Geschäftscode, keine Zeile — nur ein Nein. Die Transaktion wird verworfen.
      throw new CommandRejected('COMMAND_ID_CONFLICT', seen.reason, false);
    }
    if (seen.kind === 'replay') {
      replayed = true;
      record = seen.record;
    } else {
      const value = handler(db);
      record = { status: 'completed', identity, result: value ?? null };
      recordCommand(db, record, deps.now());
    }
    deps.commit();
  } catch (err) {
    try { deps.rollback(); } catch { /* der ursprüngliche Fehler zählt */ }

    if (err instanceof CommandRejected && err.terminal) {
      // Eine endgültige Ablehnung wird festgehalten — in einer EIGENEN Transaktion, weil die
      // erste verworfen wurde. Sie beschreibt keine Wirkung, also braucht sie keine.
      const rejected: CommandRecord = {
        status: 'rejected', identity, code: err.code, message: err.message,
      };
      deps.begin();
      try {
        if (lookupCommand(db, identity).kind === 'fresh') recordCommand(db, rejected, deps.now());
        deps.commit();
      } catch { try { deps.rollback(); } catch { /* ignore */ } }
      await deps.durableSave();
      return { kind: 'rejected', code: err.code, message: err.message, replayed: false };
    }
    if (err instanceof CommandRejected) {
      // Zustandsabhängig — nichts wird eingefroren, die Kennung bleibt frei.
      return { kind: 'rejected', code: err.code, message: err.message, replayed: false };
    }
    // Eine Störung. KEINE Zeile: ein Auftrag, der nie lief, darf nicht als gelaufen gelten.
    throw err;
  }

  // Erst nach bestätigtem Speichern gilt der Auftrag als erfolgreich. Schlägt es fehl, wirft es —
  // der Client bekommt dann kein „erfolgreich", sondern einen offenen Ausgang, und die
  // Wiederholung mit derselben Kennung findet den Nachweis nur, wenn er wirklich auf der Platte ist.
  await deps.durableSave();

  if (record.status === 'completed') {
    return { kind: 'ok', value: record.result, replayed };
  }
  return { kind: 'rejected', code: record.code, message: record.message, replayed };
}
