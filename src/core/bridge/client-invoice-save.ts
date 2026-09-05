// CENTRAL-C3B — wie der Client eine Rechnung speichert, ohne sie versehentlich zweimal zu schreiben.
//
// Der gefährliche Moment ist nicht der Fehler, sondern die Stille. Der Client drückt „Speichern",
// die Anfrage geht weg — und dann kommt nichts zurück. Genau hier wird die Regel gebrochen, die
// alles andere trägt, wenn die Oberfläche „dann eben nochmal" denkt und einen NEUEN Auftrag
// schickt: die Rechnung wäre zweimal geschrieben, mit zwei Nummern, zwei Buchungen und einem
// Bestand, der zweimal abgezogen wurde.
//
// Deshalb gehört die Kennung nicht zur Anfrage, sondern zum VORSATZ des Menschen:
//
//   • Ein bewusster Speicherversuch bekommt EINE Kennung — hier, und nur hier, entsteht eine neue.
//   • Jede Wiederholung dieses Versuchs benutzt dieselbe. Der Primary erkennt sie wieder und
//     antwortet mit dem eingefrorenen Ergebnis, statt ein zweites Mal zu buchen.
//   • Ein offener Ausgang (Zeitgrenze, Verbindung weg) beendet den Versuch NICHT. Solange er offen
//     ist, gibt dieses Modul keine neue Kennung heraus — auch wenn jemand erneut klickt.
//   • Erst ein Ergebnis beendet ihn: ein Erfolg oder ein endgültiges fachliches Nein. Danach ist
//     der nächste Klick ein neuer Vorsatz und bekommt eine neue Kennung.
//
// Der letzte Punkt ist der feine: ein fachliches Nein („Ware ist weg") ist für DIESE Kennung
// endgültig. Wer danach trotzdem verkaufen will, stellt eine neue Frage — und die braucht einen
// neuen Namen, sonst bekäme sie für immer die alte Antwort.

import { RemoteReadError, ERR_UNAVAILABLE } from './remote-read';
import { clientConfig, setClientToken } from './client-mode';

export const OP_INVOICES_CREATE = 'invoices.create';

/** Die vier Ausgänge, die die Oberfläche unterscheiden MUSS. */
export type SaveOutcome =
  /** Die Rechnung existiert. `replayed` heißt: sie existierte schon, das hier war die Wiederholung. */
  | { kind: 'ok'; invoiceId: string; invoiceNumber: string; grossAmount: number; replayed: boolean }
  /** Ein endgültiges fachliches Nein. Diese Kennung ist damit beantwortet. */
  | { kind: 'business_error'; code: string; message: string }
  /** Nachweislich NICHT ausgeführt — dieselbe Kennung darf sofort erneut geschickt werden. */
  | { kind: 'not_executed'; code: string; message: string }
  /** Ausgang offen. Dieselbe Kennung wiederholen; NIEMALS eine neue erzeugen. */
  | { kind: 'unknown'; code: string; message: string };

type Fetcher = typeof fetch;

function newCommandId(): string {
  const g = globalThis.crypto;
  if (g && typeof g.randomUUID === 'function') return g.randomUUID();
  const b = new Uint8Array(16);
  g.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Der Speicherversuch eines Menschen. Ein Objekt pro Vorsatz, nicht pro Anfrage.
 */
export class InvoiceSaveAttempt {
  readonly commandId: string;
  private settled = false;

  constructor(commandId = newCommandId()) {
    this.commandId = commandId;
  }

  /** Ist dieser Versuch beantwortet (Erfolg oder endgültiges Nein)? */
  isSettled(): boolean {
    return this.settled;
  }

  /**
   * Schickt den Versuch. Beim ersten Mal und bei jeder Wiederholung mit DERSELBEN Kennung und
   * demselben Rumpf — ein geänderter Rumpf unter derselben Kennung wird vom Primary abgewiesen,
   * und das ist gewollt: er wäre eine andere Rechnung mit demselben Namen.
   */
  async send(payload: Record<string, unknown>, fetchFn: Fetcher = fetch): Promise<SaveOutcome> {
    if (this.settled) {
      throw new Error('this save attempt is already answered — a new deliberate save needs a new attempt');
    }
    const c = clientConfig();
    if (!c) return { kind: 'not_executed', code: ERR_UNAVAILABLE, message: 'no server configured for this client' };
    if (!c.token) return { kind: 'not_executed', code: 'NOT_AUTHENTICATED', message: 'not signed in' };

    let res: Response;
    try {
      res = await fetchFn(`${c.serverUrl}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
        body: JSON.stringify({ op: OP_INVOICES_CREATE, commandId: this.commandId, payload }),
      });
    } catch (e) {
      // Die Anfrage kann den Primary erreicht haben oder nicht — von hier aus ist das nicht zu
      // unterscheiden. Also der ehrliche Ausgang: offen.
      return { kind: 'unknown', code: ERR_UNAVAILABLE, message: `no answer from the server: ${String(e)}` };
    }

    if (res.status === 401 || res.status === 403) {
      setClientToken(null);
      // Abgewiesen, bevor irgendetwas lief.
      return { kind: 'not_executed', code: 'NOT_AUTHENTICATED', message: 'the session is no longer valid' };
    }
    // 504 ist die Zeitgrenze der Brücke: zugestellt, aber keine Antwort. Der Auftrag KANN gelaufen sein.
    if (res.status === 504) {
      return { kind: 'unknown', code: 'BRIDGE_TIMEOUT', message: 'the primary did not answer in time' };
    }

    let body: {
      ok?: boolean; value?: Record<string, unknown>; error?: string; message?: string; outcome?: string;
    };
    try {
      body = await res.json() as typeof body;
    } catch {
      return { kind: 'unknown', code: 'UNREADABLE_ANSWER', message: `unreadable answer (${res.status})` };
    }

    if (res.ok && body.ok === true && body.value) {
      this.settled = true;
      const v = body.value;
      return {
        kind: 'ok',
        invoiceId: String(v.invoiceId ?? ''),
        invoiceNumber: String(v.invoiceNumber ?? ''),
        grossAmount: Number(v.grossAmount ?? 0),
        replayed: v.replayed === true,
      };
    }

    const code = body.error || `HTTP_${res.status}`;
    const message = body.message || 'the primary refused this invoice';

    // Der Server sagt selbst, ob der Auftrag nachweislich nicht ausgeführt wurde. Nur die Brücke
    // setzt dieses Feld — ein fachliches Nein hat es nicht. Fehlt es und ist die Lage unklar, gilt
    // der teurere Fall: offen. Nie „ist nicht passiert" raten.
    if (body.outcome === 'not_executed') return { kind: 'not_executed', code, message };
    if (body.outcome === 'unknown') return { kind: 'unknown', code, message };

    // 409 heißt hier ZWEIERLEI, und der Unterschied ist teuer:
    //   • mit `outcome` (oben behandelt): derselbe Name für zwei verschiedene Anfragen — der
    //     Auftrag lief NIE, die Kennung ist verbrannt.
    //   • ohne `outcome`: das fachliche Nein des Primary („die Ware ist weg"). Es ist eingefroren
    //     und endgültig. Es als „sicher wiederholbar" auszugeben wäre falsch: der Benutzer würde
    //     denselben Auftrag erneut schicken und für immer dieselbe Antwort bekommen, statt zu
    //     merken, dass er eine neue Entscheidung treffen muss.
    if (res.ok || res.status === 409 || res.status === 422 || res.status === 400) {
      this.settled = true;
      return { kind: 'business_error', code, message };
    }
    return { kind: 'unknown', code, message };
  }
}

/**
 * Der Wächter über die Kennungen einer Oberfläche. Er gibt nur dann eine neue heraus, wenn der
 * letzte Versuch wirklich beantwortet ist — die Zeitgrenze allein macht aus einem Versuch keinen
 * neuen, und genau daran scheitern solche Oberflächen sonst.
 */
export class InvoiceSaveController {
  private attempt: InvoiceSaveAttempt | null = null;

  /** Der Klick des Benutzers auf „Speichern". */
  beginAttempt(): InvoiceSaveAttempt {
    if (this.attempt && !this.attempt.isSettled()) return this.attempt; // offen → dieselbe Kennung
    this.attempt = new InvoiceSaveAttempt();
    return this.attempt;
  }

  /** Die Wiederholung eines offenen Versuchs. `null`, wenn es keinen gibt. */
  pendingAttempt(): InvoiceSaveAttempt | null {
    return this.attempt && !this.attempt.isSettled() ? this.attempt : null;
  }

  /** Nur für Tests/Abbruch: den Versuch verwerfen (der nächste Klick beginnt einen neuen). */
  forget(): void {
    this.attempt = null;
  }
}

export { RemoteReadError };
