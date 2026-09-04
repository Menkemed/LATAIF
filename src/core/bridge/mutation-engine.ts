// CENTRAL-C3A — ein Fernauftrag, der Geschäftsdaten ändert: genau einmal, oder gar nicht.
//
// Der Ablauf ist eine einzige Transaktion, und die Reihenfolge darin ist der ganze Vertrag:
//
//   durabel sein                  — offene Speicherschuld zuerst begleichen, sonst gar nicht erst anfangen
//   BEGIN
//     Kennung nachschlagen        — ist das hier schon gelaufen?
//     Geschäftswirkung ausführen  — Belegnummer, Domänenschreibvorgänge, Buchungen
//     Ergebnis einfrieren         — dieselbe Transaktion, nicht die nächste
//   COMMIT
//   durabel speichern             — erst danach darf ein Ergebnis herausgegeben werden
//
// Was daran wichtig ist, in der Reihenfolge der Gefahren:
//
//  1. **Wirkung und Nachweis teilen ein Schicksal.** Lägen sie in zwei Commits, gäbe es ein
//     Fenster, in dem die Buchung existiert und der Nachweis nicht — eine Wiederholung würde
//     ein zweites Mal buchen. Deshalb schreibt `recordCommand` INNERHALB derselben Transaktion.
//  2. **Ein verlorener Antwortweg ist kein Fehlschlag.** Der Auftrag kann vollständig gelaufen
//     sein. Beim zweiten Versuch mit derselben Kennung wird der Geschäftscode NICHT erneut
//     ausgeführt; es kommt die eingefrorene Antwort zurück.
//  3. **Eingefroren wird das Urteil der Domäne — und nur das.** Dieselbe Kennung ist eine
//     WIEDERHOLUNG, kein neuer Versuch. Wer wirklich neu fragen will („ist die Ware jetzt da?"),
//     schickt eine neue Kennung. Deshalb friert auch ein `STOCK_UNAVAILABLE` ein: es war die
//     Antwort auf genau diese Frage zu genau diesem Zeitpunkt. Täte es das nicht, hinge das
//     Ergebnis einer Wiederholung davon ab, wann sie ankommt — bei zwei Wiederholungen derselben
//     Anfrage könnte einmal „nein" und einmal „verkauft" herauskommen, und niemand wüsste, welche
//     der beiden Antworten der Client gesehen hat.
//  4. **Eine Störung wird nicht als Urteil festgehalten.** Was nie bis zu einer fachlichen
//     Entscheidung kam — Kennungskonflikt, Bruch in der Brücke, Persistenzfehler — hinterlässt
//     keine Zeile. Die Kennung bleibt frei, und der Client darf es erneut versuchen.
//  5. **Gespeichert wird vor der Antwort.** Die Geschäftsdatenbank liegt im Speicher und wird als
//     ganzes Abbild geschrieben. Ein Ergebnis ohne bestätigtes Speichern wäre dasselbe Versprechen,
//     das A1 beim Pull-Stand schon einmal gebrochen hat — und es gilt auch für die WIEDERHOLUNG:
//     ein eingefrorenes Ergebnis, das nur im Speicher steht, wird nicht herausgegeben.
//
// C3A registriert bewusst NOCH KEINE produktive Operation: `REMOTE_MUTATIONS_ENABLED` bleibt
// zu. Diese Maschine ist gebaut und geprüft, aber sie hat noch keinen Kunden.

import type { SqlDb } from '../sync/apply-change';
import { lookupCommand, recordCommand, type CommandIdentity, type CommandRecord } from './command-ledger';
import { ensureDurable, requireDurable } from './durability-state';
import { assertTransactionHealthy, markTransactionUnhealthy } from '../db/transaction-health';

/**
 * Das endgültige fachliche Nein der Domäne: die Operation wurde ausgewertet und beurteilt.
 * Es wird EINGEFROREN — für diese Kennung ist die Frage beantwortet.
 *
 * Dazu gehört ausdrücklich auch, was vom Zustand abhängt (`STOCK_UNAVAILABLE`, „schon bezahlt"):
 * die Domäne hat entschieden, und dieselbe Kennung fragt nicht neu, sie wiederholt. Ein neuer
 * Versuch ist ein neuer Auftrag mit einer neuen Kennung.
 */
export class CommandRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandRejected';
    this.code = code;
  }
}

/**
 * Kein Urteil, sondern ein Nicht-Zustandekommen: die Operation wurde nie bis zu einer fachlichen
 * Entscheidung ausgewertet (Kennungskonflikt, fehlende Voraussetzung des Transports). Der Client
 * bekommt eine Begründung, aber NICHTS wird eingefroren — die Kennung bleibt frei.
 */
export class CommandNotEvaluated extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandNotEvaluated';
    this.code = code;
  }
}

/** Was der Aufrufer zurückbekommt. `frozen` sagt, ob dieses Nein für die Kennung endgültig ist. */
export type CommandOutcome =
  | { readonly kind: 'ok'; readonly value: unknown; readonly replayed: boolean }
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly message: string;
      readonly frozen: boolean;
      readonly replayed: boolean;
    };

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

  // Noch vor der Speicherschuld: ist der Transaktionszustand überhaupt noch vertrauenswürdig?
  // Nach einem gescheiterten ROLLBACK ist er es nicht — dann darf auch dieselbe Kennung nicht
  // erneut bewertet werden, obwohl sie im Nachweis „frei" aussieht. Sie IST frei; nur diese
  // Datenbank kann die Frage nicht mehr beantworten.
  assertTransactionHealthy();

  // Zuerst die Schuld gegenüber der Platte. Ein Auftrag auf einem Stand, der nicht geschrieben
  // werden konnte, vergrößert nur den Schaden eines Absturzes — und sein Nachweis läge auf
  // demselben ungeschriebenen Abbild. Gelingt das Nachholen nicht, wirft es: offener Ausgang.
  await requireDurable(deps.durableSave, deps.now());

  deps.begin();
  try {
    // Nachschlagen INNERHALB der Transaktion: sonst könnte zwischen Frage und Buchung ein
    // zweiter Auftrag dieselbe Kennung belegen.
    const seen = lookupCommand(db, identity);
    if (seen.kind === 'conflict') {
      // Dieselbe Kennung, andere Anfrage. Kein Geschäftscode, keine Zeile — nur ein Nein.
      throw new CommandNotEvaluated('COMMAND_ID_CONFLICT', seen.reason);
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
    // Der Rücknahme kommt hier eine tragende Rolle zu: ein fachliches Nein darf erst dann als
    // endgültig festgehalten werden, wenn von dem abgebrochenen Versuch NICHTS übrig ist. Heute
    // entscheidet die Bestandsprüfung vor dem ersten Schreiben — aber das ist eine Eigenschaft
    // der heutigen Operationen, kein Vertrag. Ein späterer Auftrag darf schreiben und danach
    // ablehnen; dann ist genau dieser ROLLBACK der Grund, warum kein Rest zurückbleibt.
    let undone = true;
    try {
      deps.rollback();
    } catch (rbErr) {
      undone = false;
      console.error('[bridge] rollback failed:', rbErr);
      // Gemessen: die Transaktion bleibt offen, die Teilwirkung ist im Speicher sichtbar, weitere
      // Schreibvorgänge hängen sich an, und ein `export()` beendet die Transaktion still. Es gibt
      // hier nichts mehr zu retten — ab jetzt wird nichts mehr verändert und nichts mehr als
      // verbindlich ausgegeben, bis der Prozess neu startet.
      markTransactionUnhealthy(String(rbErr), deps.now());
    }

    if (!undone) {
      // Kein eingefrorenes Ergebnis, kein fachliches Urteil, keine Zeile: der Ausgang ist offen.
      // Die Kennung bleibt zwar frei, aber die Sperre oben verhindert, dass sie in DIESEM Prozess
      // noch einmal bewertet wird — erst ein Neustart aus der letzten durablen Datei gibt sie frei.
      throw new Error(`could not undo a failed command: refusing to report on an unsound database (${String(err)})`);
    }

    if (err instanceof CommandRejected) {
      // Ein Urteil. Es wird festgehalten — in einer EIGENEN Transaktion, weil die erste verworfen
      // wurde. Es beschreibt keine Wirkung, also braucht es keine.
      const rejected: CommandRecord = {
        status: 'rejected', identity, code: err.code, message: err.message,
      };
      deps.begin();
      try {
        if (lookupCommand(db, identity).kind === 'fresh') recordCommand(db, rejected, deps.now());
        deps.commit();
      } catch (freezeErr) {
        // Ohne Nachweis darf das Nein nicht als endgültig gemeldet werden: eine Wiederholung
        // würde die Domäne erneut fragen und könnte etwas anderes bekommen.
        try { deps.rollback(); } catch { /* ignore */ }
        throw freezeErr;
      }
      // Auch ein eingefrorenes Nein gilt erst, wenn es auf der Platte steht.
      await ensureDurable(deps.durableSave, deps.now());
      return { kind: 'rejected', code: err.code, message: err.message, frozen: true, replayed: false };
    }
    if (err instanceof CommandNotEvaluated) {
      // Kein Urteil, keine Zeile — die Kennung bleibt frei.
      return { kind: 'rejected', code: err.code, message: err.message, frozen: false, replayed: false };
    }
    // Eine Störung. KEINE Zeile: ein Auftrag, der nie zu Ende ausgewertet wurde, darf nicht als
    // beantwortet gelten.
    throw err;
  }

  // Erst nach bestätigtem Speichern wird ein Ergebnis herausgegeben — beim ersten Lauf UND bei der
  // Wiederholung. Schlägt es fehl, wirft es: der Client bekommt keinen Erfolg, sondern einen
  // offenen Ausgang, und der Prozess merkt sich die Schuld.
  await ensureDurable(deps.durableSave, deps.now());

  if (record.status === 'completed') {
    return { kind: 'ok', value: record.result, replayed };
  }
  return { kind: 'rejected', code: record.code, message: record.message, frozen: true, replayed };
}
