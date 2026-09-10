// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4B — eine Seite speichert, ohne zu wissen, wo die Datenbank steht.
//
// Für das LESEN gibt es diese Weiche seit R2D (`useSharedRead`). Beim SCHREIBEN fehlte sie: die
// gemeinsame Oberfläche rief überall direkt die Store-Aktion, und die holt als erstes
// `getDatabase()`. Am Primary richtig — auf einem Rechner ohne Datenbank ein Fehler mitten im
// Klick. Deshalb erreichte die gemeinsame Oberfläche **keine einzige** der vierzig geprüften
// Fernbuchungen (R3 §1).
//
// Die Form ist dieselbe wie beim Lesen — ein Vertrag, zwei Anschlüsse:
//
//     const speichern = useSharedWrite<Wert>('customers.create');
//     const r = await speichern.save({
//       local:  () => createCustomer(form),           // die vorhandene Domänenfunktion
//       remote: () => kundenRumpf(form),              // die vorhandene geprüfte Fernbuchung
//     });
//
//   • Am Primary läuft die VORHANDENE lokale Funktion — synchron, wie bisher — und ihr Ergebnis
//     wird in denselben asynchronen Vertrag gehoben.
//   • Auf einem Client geht die VORHANDENE geprüfte Buchung über die Brücke.
//
// Was hier NICHT passiert: keine Steuer, keine Bestandsregel, keine Nummernvergabe, keine
// Buchung, keine Fassungszählung, keine Validierung, keine Medienlogik. Dieses Modul kennt keine
// einzige Geschäftsregel — es kennt nur die zwei Anschlüsse und die vier Ausgänge.
//
// ── Die vier Ausgänge, und warum es genau vier sein müssen ────────────────────
//
//   ok             — der Vorgang existiert. `replayed` heißt: er existierte schon.
//   business_error — ein eingefrorenes fachliches Nein. Der Mensch muss etwas anderes entscheiden.
//   not_executed   — nachweislich NICHT gelaufen. Dieselbe Kennung darf sofort wieder.
//   unknown        — Ausgang offen. **Kein Erfolg.** Dieselbe Kennung wiederholen, nie eine neue.
//
// `unknown` als Erfolg zu behandeln wäre die teuerste Verwechslung dieses Systems: die Oberfläche
// meldete „gespeichert" für einen Vorgang, von dem niemand weiß, ob er stattgefunden hat.
// ════════════════════════════════════════════════════════════════════════════
import { useCallback, useMemo, useRef, useState } from 'react';
import { readsFromPrimary } from '@/core/data/primary-source';
import {
  CommandSaveController, type CommandSaveAttempt, type SaveOutcome,
} from '@/core/bridge/client-command-save';

/** Der Ausgang eines Speicherversuchs, wie ihn ein Formular sieht. */
export type WriteOutcome<T> =
  | { kind: 'ok'; value: T; replayed: boolean }
  | { kind: 'business_error'; code: string; message: string }
  | { kind: 'not_executed'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string };

/** Die zwei Anschlüsse einer Absicht. Beide beschreiben DIESELBE fachliche Handlung. */
export interface WriteAdapters<T> {
  /** Am Primary: die vorhandene lokale Domänen-/Store-Funktion. Darf synchron sein. */
  local: () => T | Promise<T>;
  /** Auf einem Client: der Rumpf für die vorhandene geprüfte Fernbuchung. */
  remote: () => Record<string, unknown>;
  /** Die Antwort des Primary in die Form bringen, die das Formular erwartet. */
  shape?: (value: Record<string, unknown>) => T;
}

/**
 * Eine geworfene Ausnahme der lokalen Domäne ist ein fachliches Nein — genau so, wie die
 * Fernbuchung eines bewertet. Damit sieht das Formular auf beiden Rechnern dasselbe.
 */
function alsAbsage(e: unknown): WriteOutcome<never> {
  const code = (e as { code?: unknown })?.code;
  return {
    kind: 'business_error',
    code: typeof code === 'string' && code ? code : 'LOCAL_WRITE_REJECTED',
    message: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Der Vertrag ohne React — damit er prüfbar ist, ohne einen Browser zu starten.
 *
 * `attempt` ist der offene Versuch des Wächters (eine Kennung je Absicht). Auf dem Primary gibt
 * es keinen: dort ist die lokale Transaktion selbst der Beweis, dass etwas genau einmal passiert.
 */
export async function runSharedWrite<T>(
  remote: boolean,
  adapters: WriteAdapters<T>,
  attempt: Pick<CommandSaveAttempt<Record<string, unknown>>, 'send'> | null,
  fetchFn?: typeof fetch,
): Promise<WriteOutcome<T>> {
  if (!remote) {
    try {
      return { kind: 'ok', value: await adapters.local(), replayed: false };
    } catch (e) {
      return alsAbsage(e);
    }
  }
  if (!attempt) {
    return { kind: 'not_executed', code: 'NO_ATTEMPT', message: 'no open save attempt' };
  }
  let rumpf: Record<string, unknown>;
  try {
    rumpf = adapters.remote();
  } catch (e) {
    // Ein Rumpf, den diese Oberfläche gar nicht bauen kann, ist ein Nein — und zwar bevor
    // irgendetwas verschickt wird.
    return alsAbsage(e);
  }
  const out: SaveOutcome<Record<string, unknown>> = await attempt.send(rumpf, fetchFn);
  if (out.kind !== 'ok') return out;
  const value = adapters.shape ? adapters.shape(out.value) : (out.value as unknown as T);
  return { kind: 'ok', value, replayed: out.replayed };
}

/** Was ein Formular von dieser Weiche bekommt. */
export interface SharedWrite<T> {
  /** Läuft gerade ein Versuch? Der Knopf gehört solange gesperrt. */
  readonly busy: boolean;
  /** Die Kennung des OFFENEN Versuchs — `null`, wenn keiner offen ist. Nur zur Anzeige/Prüfung. */
  readonly openCommandId: string | null;
  /** Schreibt dieses Fenster über die Brücke? */
  readonly remote: boolean;
  save: (adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
  /** Nur für Abbruch: den offenen Versuch vergessen (der nächste Klick beginnt einen neuen). */
  forget: () => void;
}

/**
 * Die Weiche für ein Formular. EINE Absicht — ein Wächter, und der lebt so lange wie das
 * Formular: ein neuer Wächter bei jedem Zeichnen gäbe bei jedem Klick eine neue Kennung heraus,
 * und genau das wäre der doppelte Vorgang, den der ganze Vertrag verhindern soll.
 */
export function useSharedWrite<T>(op: string): SharedWrite<T> {
  const remote = readsFromPrimary();
  const controller = useMemo(() => new CommandSaveController<Record<string, unknown>>(op), [op]);
  const [busy, setBusy] = useState(false);
  const [openCommandId, setOpenCommandId] = useState<string | null>(null);
  // Der Riegel gegen den zweiten Klick, der eintrifft, bevor der erste zurück ist. Ein
  // Zustandswert wäre dafür zu spät — er steht erst beim nächsten Zeichnen.
  const laeuft = useRef(false);

  const save = useCallback(async (adapters: WriteAdapters<T>): Promise<WriteOutcome<T>> => {
    if (laeuft.current) {
      return { kind: 'not_executed', code: 'SAVE_IN_FLIGHT', message: 'a save is already running' };
    }
    laeuft.current = true;
    setBusy(true);
    try {
      // Derselbe Versuch, solange er offen ist: eine Zeitgrenze macht aus einer Absicht keine neue.
      const attempt = remote ? controller.beginAttempt() : null;
      if (attempt) setOpenCommandId(attempt.commandId);
      const out = await runSharedWrite<T>(remote, adapters, attempt);
      // Nur ein beantworteter Versuch gibt die Kennung frei. Bei `unknown` bleibt sie stehen —
      // der nächste Klick wiederholt DIESELBE Absicht.
      setOpenCommandId(controller.pendingAttempt()?.commandId ?? null);
      return out;
    } finally {
      laeuft.current = false;
      setBusy(false);
    }
  }, [remote, controller]);

  const forget = useCallback(() => {
    controller.forget();
    setOpenCommandId(null);
  }, [controller]);

  return { busy, openCommandId, remote, save, forget };
}

/**
 * Eine gemeinsame Schreibaktion, die es auf einem Client noch NICHT gibt.
 *
 * Sie ist ausdrücklich kein stilles Nichts: sie meldet sich als fachliches Nein mit eigenem Code,
 * damit die Oberfläche es anzeigen kann und niemand „gespeichert" sieht, wo nichts gespeichert
 * wurde. Der Weg in die lokale Datenbank bleibt dabei verschlossen.
 */
export const CLIENT_WRITE_UNSUPPORTED = 'CLIENT_WRITE_UNSUPPORTED';

/**
 * Eine Seite mit MEHREREN Schreibhandlungen — R4C.
 *
 * Eine Rechnungsansicht kennt sieben davon (Zahlung erfassen, berichtigen, löschen, Guthaben
 * verrechnen, Zeilen ändern, Retoure anlegen, erstatten). Sieben einzelne Weichen wären sieben
 * Zustände und sieben Fehleranzeigen; hier gibt es EINEN Zustand und EINE Anzeige — aber weiterhin
 * **einen Wächter je Buchung**, denn die Kennung gehört zur Absicht, nicht zur Seite.
 *
 *     const w = useSharedWrites();
 *     if (!await w.ok('invoices.record_payment', { local: …, remote: … })) return;
 *
 * `ok()` gibt `false` zurück, sobald es NICHT geglückt ist — und legt den Grund in `w.fehler`.
 * Ein offener Ausgang zählt dabei ausdrücklich als „nicht geglückt".
 */
export interface SharedWrites {
  readonly busy: boolean;
  readonly fehler: string;
  readonly remote: boolean;
  save: <T>(op: string, adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
  ok: <T>(op: string, adapters: WriteAdapters<T>) => Promise<boolean>;
  clear: () => void;
}

export function useSharedWrites(): SharedWrites {
  const remote = readsFromPrimary();
  // Ein Wächter JE BUCHUNG, über die Lebensdauer der Seite stabil.
  const waechter = useRef(new Map<string, CommandSaveController<Record<string, unknown>>>());
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  const laeuft = useRef(false);

  const save = useCallback(async <T,>(op: string, adapters: WriteAdapters<T>): Promise<WriteOutcome<T>> => {
    if (laeuft.current) {
      return { kind: 'not_executed', code: 'SAVE_IN_FLIGHT', message: 'a save is already running' };
    }
    laeuft.current = true;
    setBusy(true);
    setFehler('');
    try {
      let attempt = null;
      if (remote) {
        let c = waechter.current.get(op);
        if (!c) { c = new CommandSaveController<Record<string, unknown>>(op); waechter.current.set(op, c); }
        attempt = c.beginAttempt();
      }
      const r = await runSharedWrite<T>(remote, adapters, attempt);
      // R5A.2 — auch wer den WERT braucht (`save` statt `ok`), bekommt den Grund in `w.fehler`.
      // Vorher gab `save` den Ausgang nur zurueck; die Auftragsumwandlung kehrte bei einem offenen
      // Ausgang still um — der Mensch klickte „Confirm", und nichts geschah.
      if (r.kind !== 'ok') setFehler(fehlertext(r));
      return r;
    } finally {
      laeuft.current = false;
      setBusy(false);
    }
  }, [remote]);

  const ok = useCallback(async <T,>(op: string, adapters: WriteAdapters<T>): Promise<boolean> =>
    (await save<T>(op, adapters)).kind === 'ok', [save]);

  return { busy, fehler, remote, save, ok, clear: useCallback(() => setFehler(''), []) };
}

/**
 * Was der Mensch liest, wenn es nicht geklappt hat — eine Stelle für alle Formulare.
 *
 * Der offene Ausgang bekommt bewusst eigene Worte: „nicht gespeichert" wäre falsch (es kann
 * passiert sein), „gespeichert" wäre schlimmer. Die ehrliche Auskunft ist, dass es offen ist und
 * dass ein erneuter Versuch nichts doppelt anlegt.
 */
export function fehlertext(r: WriteOutcome<unknown>): string {
  switch (r.kind) {
    case 'ok': return '';
    case 'business_error': return r.message || r.code;
    case 'not_executed': return `Not saved (${r.code}). You can try again.`;
    case 'unknown':
      return `No answer from the primary (${r.code}) — it is not clear whether this was saved. `
        + 'Press save again: the same attempt is repeated, and it can never create it twice.';
  }
}

export function nichtAmClient<T>(was: string): WriteOutcome<T> {
  return {
    kind: 'business_error',
    code: CLIENT_WRITE_UNSUPPORTED,
    message: `${was} is not available on a connected client yet`,
  };
}
