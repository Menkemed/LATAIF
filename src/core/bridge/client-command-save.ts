// CENTRAL-C3C — wie der Client IRGENDEINEN Fernauftrag speichert, ohne ihn zweimal zu schreiben.
//
// Das hier stand zuerst im Rechnungsformular. Es gehört aber nicht der Rechnung, sondern jedem
// schreibenden Auftrag: der gefährliche Moment ist nie der Fehler, sondern die Stille. Die Anfrage
// geht weg, es kommt nichts zurück — und wenn die Oberfläche dann „dann eben nochmal" denkt und
// einen NEUEN Auftrag schickt, entsteht der Vorgang zweimal. Bei einer Rechnung sind das zwei
// Nummern; bei einem Produkt zwei Artikel und zwei SKUs.
//
// Deshalb gehört die Kennung zum VORSATZ eines Menschen, nicht zur Anfrage:
//
//   • Ein bewusster Speicherversuch bekommt EINE Kennung — hier, und nur hier, entsteht eine neue.
//   • Jede Wiederholung dieses Versuchs benutzt dieselbe. Der Primary erkennt sie wieder und
//     antwortet mit dem eingefrorenen Ergebnis, statt ein zweites Mal zu schreiben.
//   • Ein offener Ausgang (Zeitgrenze, Verbindung weg) beendet den Versuch NICHT. Solange er offen
//     ist, gibt dieses Modul keine neue Kennung heraus — auch wenn jemand erneut klickt.
//   • Erst ein Ergebnis beendet ihn: ein Erfolg oder ein endgültiges fachliches Nein. Danach ist
//     der nächste Klick ein neuer Vorsatz und bekommt eine neue Kennung.
//
// POST-PARITY R7C R1–R3 — und das gilt jetzt über die Maske hinaus:
//
//   • R1: bevor ein Versuch hinausgeht, steht er in der Ablage dieses Rechners (`pending-saves`) —
//     Kennung + ursprünglicher Auftrag + Kontext. Kann sie ihn nicht schreiben, geht er nicht
//     hinaus. Nach Maskenwechsel, Neuladen oder Neustart nimmt `attemptForPending` ihn mit
//     DERSELBEN Kennung und DEMSELBEN Auftrag wieder auf.
//   • R2: der ursprüngliche Auftrag bleibt der ursprüngliche. Ein geändertes Formular geht unter
//     dieser Kennung nicht hinaus (kein endloses „anderer Rumpf, gleiche Kennung") — erst den
//     früheren Vorgang klären, dann die Änderung als eigene Handlung speichern.
//   • R3: „dieser Versuch lief nicht" beweist nicht, dass ein früherer nichts bewirkt hat. Hat ein
//     früherer Versand den Primary vielleicht erreicht, bleibt der Vorgang offen.

import { clientConfig, setClientToken, type ClientConfig } from './client-mode';
import { ERR_UNAVAILABLE } from './remote-read';
import {
  currentPendingContext, dropPending, ensurePendingLoaded, pendingRecords, persistPending, sameContext,
  stableJson, type PendingRecord, type PendingState,
} from './pending-saves';

/** Die vier Ausgänge, die die Oberfläche unterscheiden MUSS. */
export type SaveOutcome<T = Record<string, unknown>> =
  /** Der Vorgang existiert. `replayed` heißt: er existierte schon, das hier war die Wiederholung. */
  | { kind: 'ok'; value: T; replayed: boolean }
  /** Ein endgültiges fachliches Nein. Diese Kennung ist damit beantwortet. */
  | { kind: 'business_error'; code: string; message: string }
  /** Nachweislich NICHT ausgeführt — und kein früherer Versand dieses Vorgangs kann angekommen sein. */
  | { kind: 'not_executed'; code: string; message: string }
  /** Ausgang offen. Dieselbe Kennung wiederholen; NIEMALS eine neue erzeugen. */
  | { kind: 'unknown'; code: string; message: string };

/** Der Primary hält diese Kennung für einen ANDEREN Auftrag (Brücke oder durabler Nachweis). */
export const COMMAND_ID_CONFLICT = 'BRIDGE_COMMAND_ID_CONFLICT';
/** R2 — das Formular hat sich geändert, der frühere Vorgang ist offen: nichts wurde gesendet. */
export const ORIGINAL_UNRESOLVED = 'ORIGINAL_UNRESOLVED';
/** R1 — eine NEUE Kennung, während ein früherer Vorgang derselben Buchung offen ist: erst bestätigen. */
export const EARLIER_SAVE_UNRESOLVED = 'EARLIER_SAVE_UNRESOLVED';
/** R3 — diese Wiederholung lief nicht; ob der frühere Versand gespeichert wurde, bleibt offen. */
export const EARLIER_TRY_OPEN = 'EARLIER_TRY_OPEN';
/** R1 — die Ablage konnte den Vorgang nicht sichern: nichts wurde gesendet. */
export const PENDING_STORE_FAILED = 'PENDING_STORE_FAILED';
/** R1 — der offene Vorgang gehört zu einer anderen Anmeldung / einem anderen Primary. */
export const PENDING_CONTEXT_MISMATCH = 'PENDING_CONTEXT_MISMATCH';

type Fetcher = typeof fetch;

export function newCommandId(): string {
  const g = globalThis.crypto;
  if (g && typeof g.randomUUID === 'function') return g.randomUUID();
  const b = new Uint8Array(16);
  g.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Die offenen Versuche dieses Fensters — damit Maske und Klärung DENSELBEN Versuch benutzen. */
const live = new Map<string, CommandSaveAttempt<unknown>>();

/** Den offenen Vorgang wieder aufnehmen — derselbe laufende Versuch, sonst aus der Ablage. */
export function attemptForPending<T = Record<string, unknown>>(rec: PendingRecord): CommandSaveAttempt<T> {
  const a = live.get(rec.commandId);
  if (a && !a.isSettled()) return a as unknown as CommandSaveAttempt<T>;
  return CommandSaveAttempt.resume<T>(rec);
}

/** Nur für Tests: die offenen Versuche des Fensters vergessen — genau das, was ein Neuladen tut. */
export function resetLiveAttemptsForTest(): void {
  live.clear();
}

const normalized = (p: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(p)) as Record<string, unknown>;

/** Der Speicherversuch eines Menschen. Ein Objekt pro Vorsatz, nicht pro Anfrage. */
export class CommandSaveAttempt<T = Record<string, unknown>> {
  readonly op: string;
  readonly commandId: string;
  private settled = false;
  /** Der gesicherte Vorgang (ursprünglicher Auftrag) — `null`, solange nichts hinausging. */
  private record: PendingRecord | null = null;
  /** Kann ein früherer Versand dieses Vorgangs den Primary erreicht haben? */
  private mayHaveRun = false;

  constructor(op: string, commandId = newCommandId()) {
    this.op = op;
    this.commandId = commandId;
  }

  /** Einen gesicherten Vorgang wieder aufnehmen. Ob sein Versand vor dem Neuladen hinausging, weiß
   *  niemand — also gilt er als „kann gelaufen sein". */
  static resume<T = Record<string, unknown>>(rec: PendingRecord): CommandSaveAttempt<T> {
    const a = new CommandSaveAttempt<T>(rec.op, rec.commandId);
    a.record = rec;
    a.mayHaveRun = true;
    live.set(rec.commandId, a as unknown as CommandSaveAttempt<unknown>);
    return a;
  }

  isSettled(): boolean {
    return this.settled;
  }

  /** Der Auftrag, unter dem diese Kennung zuerst hinausging (R2) — `null`, solange keiner hinausging. */
  originalPayload(): Record<string, unknown> | null {
    return this.record ? this.record.payload : null;
  }

  /**
   * Schickt den Versuch. Beim ersten Mal wird er VORHER gesichert; jede Wiederholung schickt den
   * ursprünglichen Auftrag unter derselben Kennung. Ein geänderter Auftrag geht nicht hinaus (R2).
   */
  async send(payload: Record<string, unknown>, fetchFn: Fetcher = fetch): Promise<SaveOutcome<T>> {
    if (this.settled) {
      throw new Error('this save attempt is already answered — a new deliberate save needs a new attempt');
    }
    const c = clientConfig();
    if (!c) return this.notSent(ERR_UNAVAILABLE, 'no server configured for this client');
    if (!c.token) return this.notSent('NOT_AUTHENTICATED', 'not signed in');
    await ensurePendingLoaded();
    const ctx = currentPendingContext();
    if (!ctx) return this.notSent('NOT_AUTHENTICATED', 'not signed in');

    if (this.record) {
      if (!sameContext(this.record.context, ctx)) {
        return {
          kind: 'not_executed', code: PENDING_CONTEXT_MISMATCH,
          message: 'this earlier save belongs to another sign-in or main computer — sign in there to clarify it',
        };
      }
      if (stableJson(normalized(payload)) !== stableJson(this.record.payload)) {
        return {
          kind: 'unknown', code: ORIGINAL_UNRESOLVED,
          message: 'the earlier save of this form is still unresolved and the form has changed since — the changes were not sent',
        };
      }
    } else {
      const now = new Date().toISOString();
      const rec: PendingRecord = {
        v: 1, commandId: this.commandId, op: this.op, payload: normalized(payload), context: ctx,
        createdAt: now, updatedAt: now, state: 'sending',
      };
      try {
        await persistPending(rec);
      } catch (e) {
        return {
          kind: 'not_executed', code: PENDING_STORE_FAILED,
          message: `this computer could not keep a safe record of the save, so nothing was sent (${String(e instanceof Error ? e.message : e)})`,
        };
      }
      this.record = rec;
      live.set(this.commandId, this as unknown as CommandSaveAttempt<unknown>);
    }

    const earlier = this.mayHaveRun;
    const out = await this.transmit(this.record.payload, c, fetchFn);
    return this.conclude(out, earlier);
  }

  /** Nicht gesendet (vor dem Netz). Ist ein früherer Versand vielleicht angekommen, bleibt es offen. */
  private notSent(code: string, message: string): SaveOutcome<T> {
    if (this.mayHaveRun) return { kind: 'unknown', code: EARLIER_TRY_OPEN, message: `${message} (${code}) — nothing was sent now; whether the earlier try was saved is still open` };
    return { kind: 'not_executed', code, message };
  }

  private async mark(state: PendingState, code: string): Promise<void> {
    if (!this.record) return;
    this.record = { ...this.record, state, lastCode: code, updatedAt: new Date().toISOString() };
    try {
      await persistPending(this.record);
    } catch {
      // Die Datei behält ihren früheren Stand — auch der heißt „kann gelaufen sein". Sicher.
    }
  }

  private async conclude(out: SaveOutcome<T>, earlier: boolean): Promise<SaveOutcome<T>> {
    const id = this.commandId;
    if (out.kind === 'ok' || out.kind === 'business_error') {
      this.settled = true;
      live.delete(id);
      await dropPending(id);
      return out;
    }
    if (out.kind === 'unknown') {
      this.mayHaveRun = true;
      await this.mark('unresolved', out.code);
      return out;
    }
    // not_executed: DIESER Versand lief nicht.
    if (out.code === COMMAND_ID_CONFLICT) {
      // Der Primary hält die Kennung für einen anderen Auftrag — dort steht etwas unter ihr.
      this.mayHaveRun = true;
      await this.mark('conflict', out.code);
      return out;
    }
    if (!earlier) {
      // Kein Versand dieses Vorgangs kann angekommen sein: es ist nichts passiert.
      live.delete(id);
      this.record = null;
      await dropPending(id);
      return out;
    }
    await this.mark(this.record?.state === 'conflict' ? 'conflict' : 'unresolved', out.code);
    return {
      kind: 'unknown', code: EARLIER_TRY_OPEN,
      message: `${out.message} (${out.code}) — this repeat did not run; whether the earlier try was saved is still open`,
    };
  }

  private async transmit(payload: Record<string, unknown>, c: ClientConfig, fetchFn: Fetcher): Promise<SaveOutcome<T>> {
    let res: Response;
    try {
      res = await fetchFn(`${c.serverUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
        body: JSON.stringify({ op: this.op, commandId: this.commandId, payload }),
      });
    } catch (e) {
      // Die Anfrage kann den Primary erreicht haben oder nicht — von hier aus ist das nicht zu
      // unterscheiden. Also der ehrliche Ausgang: offen.
      return { kind: 'unknown', code: ERR_UNAVAILABLE, message: `no answer from the server: ${String(e)}` };
    }

    if (res.status === 401 || res.status === 403) {
      setClientToken(null);
      return { kind: 'not_executed', code: 'NOT_AUTHENTICATED', message: 'the session is no longer valid' };
    }
    // 504 ist die Zeitgrenze der Brücke: zugestellt, aber keine Antwort. Der Auftrag KANN gelaufen sein.
    if (res.status === 504) {
      return { kind: 'unknown', code: 'BRIDGE_TIMEOUT', message: 'the primary did not answer in time' };
    }

    let body: { ok?: boolean; value?: T; error?: string; message?: string; outcome?: string };
    try {
      body = await res.json() as typeof body;
    } catch {
      return { kind: 'unknown', code: 'UNREADABLE_ANSWER', message: `unreadable answer (${res.status})` };
    }

    if (res.ok && body.ok === true && body.value) {
      const v = body.value as T & { replayed?: boolean };
      return { kind: 'ok', value: v, replayed: v.replayed === true };
    }

    const code = body.error || `HTTP_${res.status}`;
    const message = body.message || 'the primary refused this request';

    // Der Server sagt selbst, ob der Auftrag nachweislich nicht ausgeführt wurde. Nur die Brücke
    // (und seit R7C R3 der Kennungskonflikt aus dem durablen Nachweis) setzt dieses Feld — ein
    // fachliches Nein hat es nicht.
    if (body.outcome === 'not_executed') return { kind: 'not_executed', code, message };
    if (body.outcome === 'unknown') return { kind: 'unknown', code, message };

    // 409 heißt hier ZWEIERLEI, und der Unterschied ist teuer:
    //   • mit `outcome` (oben behandelt): derselbe Name für zwei verschiedene Anfragen — DIESER
    //     Versand lief nie; unter der Kennung steht auf dem Primary schon etwas.
    //   • ohne `outcome`: das fachliche Nein des Primary. Es ist eingefroren und endgültig; es als
    //     „sicher wiederholbar" auszugeben wäre falsch — der Benutzer bekäme für immer dieselbe
    //     Antwort, statt zu merken, dass er eine neue Entscheidung treffen muss.
    if (res.ok || res.status === 409 || res.status === 422 || res.status === 400) {
      return { kind: 'business_error', code, message };
    }
    return { kind: 'unknown', code, message };
  }
}

/**
 * Der Wächter über die Kennungen EINER Oberfläche. Er gibt nur dann eine neue heraus, wenn der
 * letzte Versuch wirklich beantwortet ist — die Zeitgrenze allein macht aus einem Versuch keinen
 * neuen, und genau daran scheitern solche Oberflächen sonst.
 */
export class CommandSaveController<T = Record<string, unknown>> {
  private attempt: CommandSaveAttempt<T> | null = null;
  // Kein Parameter-Property: der Node-Testlaeufer streift Typen nur ab und kennt die Kurzform nicht.
  private readonly op: string;
  private newEntryConfirmed = false;

  constructor(op: string) {
    this.op = op;
  }

  /** Der Klick des Benutzers auf „Speichern". */
  beginAttempt(): CommandSaveAttempt<T> {
    if (this.attempt && !this.attempt.isSettled()) return this.attempt; // offen → dieselbe Kennung
    this.attempt = new CommandSaveAttempt<T>(this.op);
    this.newEntryConfirmed = false;
    return this.attempt;
  }

  /** Die Wiederholung eines offenen Versuchs. `null`, wenn es keinen gibt. */
  pendingAttempt(): CommandSaveAttempt<T> | null {
    return this.attempt && !this.attempt.isSettled() ? this.attempt : null;
  }

  /** Nur für Tests/Abbruch: den Versuch verwerfen (der nächste Klick beginnt einen neuen). */
  forget(): void {
    this.attempt = null;
  }

  /**
   * R1 — ist für diese Buchung ein FRÜHERER Vorgang offen (andere Maske, vor dem Neuladen)? Dann
   * gibt es eine neue Kennung erst nach ausdrücklicher Bestätigung: der erste Klick sagt es, der
   * zweite ist die Entscheidung „das ist ein neuer, eigener Vorgang". Nie still.
   */
  async guardNewEntry(): Promise<SaveOutcome<T> | null> {
    if (this.pendingAttempt()) return null;
    await ensurePendingLoaded();
    const earlier = pendingRecords(currentPendingContext(), this.op);
    if (earlier.length === 0) { this.newEntryConfirmed = false; return null; }
    if (this.newEntryConfirmed) return null;
    this.newEntryConfirmed = true;
    const since = new Date(earlier[0].createdAt);
    const when = Number.isFinite(since.getTime()) ? since.toLocaleString() : earlier[0].createdAt;
    return {
      kind: 'unknown', code: EARLIER_SAVE_UNRESOLVED,
      message: `An earlier save of this kind (${when}) is still unresolved — it may already be on the main computer. `
        + 'Clarify it under "Unresolved saves" first. If this really is a new, separate entry, press save again.',
    };
  }
}

/** Was die Klärung eines offenen Vorgangs ergeben hat — in Worten für den Menschen. */
export function describeClarification(out: SaveOutcome<Record<string, unknown>>): string {
  switch (out.kind) {
    case 'ok':
      return out.replayed
        ? 'Clarified: it WAS saved on the main computer — nothing was added now.'
        : 'Clarified: it was not on the main computer yet and has now been saved once.';
    case 'business_error':
      return out.code === 'STAGED_IMAGE_GONE'
        ? `Not saved: the photos of this save are no longer on the main computer (${out.code}). Enter it again with the photos.`
        : `Not saved — the main computer refused it: ${out.message || out.code}`;
    case 'not_executed':
      return out.code === COMMAND_ID_CONFLICT
        ? 'The main computer holds this number for different content — this attempt was not executed. Check on the main computer what was recorded, then remove this reminder.'
        : `Not sent (${out.code}) — ${out.message}`;
    case 'unknown':
      return `Still no clear answer (${out.code}) — try again later; it is never saved twice.`;
  }
}
