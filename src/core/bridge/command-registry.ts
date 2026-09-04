// CENTRAL-C1 — welche Aufträge dieser Renderer überhaupt annimmt.
//
// Die Netzwerkseite nennt einen Namen. Dieser Name darf niemals ein JavaScript-Funktionsname sein
// und niemals frei gewählt: hier steht eine feste Liste, und was nicht darin steht, wird abgewiesen,
// bevor irgendetwas läuft. Rust prüft dieselbe Liste ein zweites Mal, bevor es überhaupt sendet —
// zwei Riegel, weil das Netz auf der anderen Seite liegt.
//
// C1 registriert absichtlich EINE Operation: eine Probe. Sie beweist den ganzen Weg (Anfrage →
// Warteschlange → Ausführung → Antwort → HTTP) und rührt keine Geschäftsdaten an. Rechnung,
// Verkauf, Einkauf, Transfer und Kommission kommen erst, wenn Transaktionsgrenzen und die vier
// Alt-Nummernkreise stehen.

import { runExclusive, businessWriteScheduler } from './command-scheduler';
import { DURABILITY_DEGRADED, DurabilityError, requireDurableOrFail } from './durability-state';
import { TRANSACTION_UNHEALTHY, TransactionUnhealthyError, assertTransactionHealthy } from '../db/transaction-health';
import { CommandNotEvaluated, CommandRejected } from './mutation-engine';

/** Was ein Auftrag zurückgeben darf. */
export type CommandResult = { readonly [k: string]: unknown };

/** Ein fachliches Nein — kein Fehler des Systems, sondern eine Antwort. */
export class BusinessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

/**
 * Wer einen Auftrag verantwortet — vom AUTHENTIFIZIERTEN Absender, durch Rust gereicht, nie aus
 * dem Rumpf. Eine Auskunft braucht sie nicht; eine Buchung schon: der durable Nachweis wird auf
 * genau diese Kennung geschlüsselt.
 */
export interface CommandActor {
  commandId: string;
  tenantId: string;
  branchId: string;
  userId: string;
  payloadHash: string;
}

export type CommandHandler = (payload: unknown, actor?: CommandActor) => Promise<CommandResult> | CommandResult;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Rust prüft die Kennung bereits, bevor es sendet. Hier steht der zweite Riegel — dieselbe
 * Begründung wie bei der Namensliste: was über das Netz kommt, wird zweimal geprüft.
 */
export function isUsableActor(a: CommandActor | undefined): a is CommandActor {
  return !!a && UUID.test(a.commandId) && !!a.tenantId && !!a.branchId && !!a.userId && !!a.payloadHash;
}

/**
 * Welche Art von Auftrag das ist. Absichtlich eine KLASSE und kein Name: eine Sperre gegen fünf
 * bekannte Namen hätte ein später hinzugefügtes `invoice.save` einfach durchgelassen.
 *
 *   • `probe` — beweist den Weg, rührt nichts an.
 *   • `read`  — liest, läuft parallel.
 *   • `mutation` — verändert Geschäftsdaten.
 */
export type CommandClass = 'probe' | 'read' | 'mutation';

/**
 * CENTRAL-C3B — welche verändernden Fernaufträge es gibt. NAMENTLICH, nicht als Schalter.
 *
 * In C3A stand hier ein `REMOTE_MUTATIONS_ENABLED = false`. Dieses Tor auf `true` zu drehen wäre
 * bequem und falsch gewesen: es hätte in einem Zug JEDE künftige `kind: 'mutation'` registrierbar
 * gemacht — auch ein später hinzugefügtes `products.create` oder `invoice.delete`, das nie
 * jemand geprüft hat. Freigegeben wird deshalb ein NAME, und die Liste ist so lang wie die Zahl
 * der Operationen, die wirklich durchdacht sind.
 *
 * Wer eine weitere Mutation freischalten will, kommt an dieser Liste vorbei — und damit an der
 * Frage, ob ihr Weg dieselben Beweise hat wie dieser: durabler Nachweis in derselben Transaktion,
 * Bestandsprüfung vor der Wirkung, eingefrorenes Urteil, Wiederholung ohne zweite Wirkung.
 */
export const ALLOWED_MUTATIONS: readonly string[] = ['invoices.create'];

export interface CommandSpec {
  readonly kind: CommandClass;
  readonly handler: CommandHandler;
}

/** Die Probe: sagt nur, wer geantwortet hat und was sie bekommen hat. */
export const OP_PROBE = 'bridge.probe';

const REGISTRY = new Map<string, CommandSpec>();

export function registerCommand(op: string, spec: CommandSpec): void {
  if (REGISTRY.has(op)) throw new Error(`[bridge] duplicate command: ${op}`);
  // Der Riegel: eine verändernde Fernoperation gibt es nur, wenn ihr Name ausdrücklich freigegeben ist.
  if (spec.kind === 'mutation' && !ALLOWED_MUTATIONS.includes(op)) {
    throw new Error(
      `[bridge] refusing to register a mutating remote command (${op}): only ${ALLOWED_MUTATIONS.join(', ')} `
      + 'may change business data from another machine.'
    );
  }
  REGISTRY.set(op, spec);
}

export function knownCommands(): string[] {
  return [...REGISTRY.keys()].sort();
}

/** Die drei Ausgänge, die auch Rust kennt. */
export type Reply =
  | { kind: 'ok'; value: CommandResult }
  | { kind: 'business_error'; code: string; message: string }
  | { kind: 'infrastructure_error'; code: string };

/**
 * Führt einen Auftrag aus und übersetzt JEDEN Ausgang in eine Antwort. Diese Funktion wirft nicht:
 * ein Auftrag, der niemanden erreicht, ist eine offene Anfrage auf der anderen Seite, und die
 * läuft dann in eine Zeitgrenze statt in eine Begründung.
 */
export async function executeCommand(op: string, payload: unknown, actor?: CommandActor): Promise<Reply> {
  const spec = REGISTRY.get(op);
  if (!spec) return { kind: 'infrastructure_error', code: 'BRIDGE_OP_NOT_REGISTERED' };
  // Eine Buchung ohne Absender gibt es nicht: ohne Kennung könnte der durable Nachweis nicht
  // geschrieben werden, und ohne ihn wäre jede Wiederholung ein zweites Mal buchen.
  if (spec.kind === 'mutation' && !isUsableActor(actor)) {
    console.error('[bridge] refusing a mutation without an authenticated identity:', op);
    return { kind: 'infrastructure_error', code: 'BRIDGE_IDENTITY_MISSING' };
  }
  try {
    let value: CommandResult;
    if (spec.kind === 'read') {
      // Lesevorgänge laufen nebeneinander, aber nicht MITTEN in einer Buchung: der Produktweg mit
      // Medien hat mehrere Phasen, und ein Lesen dazwischen sähe ein Produkt ohne seine Bilder.
      //
      // CENTRAL-C3A: und nicht auf einem Stand, der nicht auf der Platte steht. Eine Auskunft an
      // einen anderen Rechner ist eine Bestätigung — „diese Rechnung existiert". Verschwände sie
      // beim nächsten Absturz, hätte der Client sie trotzdem gesehen und danach gehandelt.
      value = await businessWriteScheduler.runShared(async () => {
        // Eine Auskunft aus einer Datenbank mit offener, nicht zurueckgenommener Transaktion waere
        // schmutzig: die Teilwirkung ist dort sichtbar. Also gar keine Auskunft.
        assertTransactionHealthy();
        await requireDurableOrFail();
        return spec.handler(payload);
      });
    } else if (spec.kind === 'probe') {
      // Die Probe bleibt ungesperrt: sie liest nichts und bestätigt nichts. Gerade wenn das
      // Speichern klemmt, muss man von außen noch feststellen können, dass der Weg lebt.
      value = await businessWriteScheduler.run(() => spec.handler(payload));
    } else {
      value = await runExclusive(() => spec.handler(payload, actor));
    }
    return { kind: 'ok', value };
  } catch (err) {
    if (err instanceof BusinessError) {
      return { kind: 'business_error', code: err.code, message: err.message };
    }
    // Das endgültige Urteil der Domäne — genau das, was der durable Nachweis eingefroren hat.
    // Der Client darf es als Antwort nehmen und NICHT einfach wiederholen.
    if (err instanceof CommandRejected) {
      return { kind: 'business_error', code: err.code, message: err.message };
    }
    // Kein Urteil, sondern ein Nicht-Zustandekommen (dieselbe Kennung, anderer Rumpf). Das ist
    // ausdrücklich KEIN fachliches Nein: der Vorgang wurde nie bewertet.
    if (err instanceof CommandNotEvaluated) {
      return { kind: 'infrastructure_error', code: err.code };
    }
    if (err instanceof TransactionUnhealthyError) {
      // Auch das ist KEIN fachliches Nein: dieser Rechner kann nichts mehr bestaetigen, bis er
      // neu startet. Der Ausgang eines laufenden Auftrags bleibt offen.
      console.error('[bridge] refusing on an unsound database:', op, err.message);
      return { kind: 'infrastructure_error', code: TRANSACTION_UNHEALTHY };
    }
    if (err instanceof DurabilityError) {
      // KEIN fachliches Nein: der Ausgang ist offen. Der Client darf daraus nicht schließen, dass
      // nichts passiert ist — nur, dass dieser Rechner gerade nichts bestätigen kann.
      console.warn('[bridge] refusing while unsaved:', op, err.message);
      return { kind: 'infrastructure_error', code: DURABILITY_DEGRADED };
    }
    // Alles andere ist eine Störung, und ihr Text bleibt beim Betreiber: eine fremde Anfrage
    // bekommt einen Code, keine Innereien.
    console.warn('[bridge] command failed:', op, err);
    return { kind: 'infrastructure_error', code: 'BRIDGE_COMMAND_FAILED' };
  }
}

// ── Die eine registrierte Operation ───────────────────────────────────────

registerCommand(OP_PROBE, {
  // Die Probe läuft durch die Warteschlange, obwohl sie nichts ändert: nur so beweist der
  // Ende-zu-Ende-Test, dass der Weg tatsächlich durch die Reihung führt.
  kind: 'probe',
  handler: (payload) => ({
    ok: true,
    echo: (payload as { echo?: unknown } | null)?.echo ?? null,
    at: new Date().toISOString(),
  }),
});
