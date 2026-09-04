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

export type CommandHandler = (payload: unknown) => Promise<CommandResult> | CommandResult;

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
 * Verändernde Fernaufträge sind gesperrt, bis der durable Nachweis steht: ein Ledger-Eintrag mit
 * der logischen Kennung des Clients, geschrieben in DERSELBEN sql.js-Transaktion wie die Buchung
 * und die Belegnummer. Ohne den kann eine Wiederholung nach einem verlorenen Antwortweg nicht
 * erkennen, dass die Buchung längst passiert ist — und ein zweites Mal buchen ist schlimmer als
 * gar nicht. Die Sperre steht hier im Code, nicht nur in einem Test, damit sie beim Registrieren
 * zuschlägt und nicht erst beim Prüfen.
 */
export const REMOTE_MUTATIONS_ENABLED = false;

export interface CommandSpec {
  readonly kind: CommandClass;
  readonly handler: CommandHandler;
}

/** Die Probe: sagt nur, wer geantwortet hat und was sie bekommen hat. */
export const OP_PROBE = 'bridge.probe';

const REGISTRY = new Map<string, CommandSpec>();

export function registerCommand(op: string, spec: CommandSpec): void {
  if (REGISTRY.has(op)) throw new Error(`[bridge] duplicate command: ${op}`);
  // Der Riegel: keine verändernde Fernoperation, solange der durable Nachweis fehlt.
  if (spec.kind === 'mutation' && !REMOTE_MUTATIONS_ENABLED) {
    throw new Error(
      `[bridge] refusing to register a mutating remote command (${op}): remote writes stay closed `
      + 'until a durable command ledger commits in the same transaction as the business effect.'
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
export async function executeCommand(op: string, payload: unknown): Promise<Reply> {
  const spec = REGISTRY.get(op);
  if (!spec) return { kind: 'infrastructure_error', code: 'BRIDGE_OP_NOT_REGISTERED' };
  try {
    // Lesevorgänge laufen nebeneinander, aber nicht MITTEN in einer Buchung: der Produktweg mit
    // Medien hat mehrere Phasen, und ein Lesen dazwischen sähe ein Produkt ohne seine Bilder.
    const value = spec.kind === 'read'
      ? await businessWriteScheduler.runShared(() => spec.handler(payload))
      : await runExclusive(() => spec.handler(payload));
    return { kind: 'ok', value };
  } catch (err) {
    if (err instanceof BusinessError) {
      return { kind: 'business_error', code: err.code, message: err.message };
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
