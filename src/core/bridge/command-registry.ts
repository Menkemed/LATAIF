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

import { runExclusive } from './command-scheduler';

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

export interface CommandSpec {
  /** Verändert dieser Auftrag Geschäftsdaten? Dann läuft er durch die eine Warteschlange. */
  readonly mutates: boolean;
  readonly handler: CommandHandler;
}

/** Die Probe: sagt nur, wer geantwortet hat und was sie bekommen hat. */
export const OP_PROBE = 'bridge.probe';

const REGISTRY = new Map<string, CommandSpec>();

export function registerCommand(op: string, spec: CommandSpec): void {
  if (REGISTRY.has(op)) throw new Error(`[bridge] duplicate command: ${op}`);
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
    // Verändernde Aufträge werden gereiht, lesende nicht — sonst würde eine lange Liste die
    // Schreibvorgänge aufhalten, ohne dass es dafür einen Grund gäbe.
    const value = spec.mutates
      ? await runExclusive(() => spec.handler(payload))
      : await spec.handler(payload);
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
  mutates: true,
  handler: (payload) => ({
    ok: true,
    echo: (payload as { echo?: unknown } | null)?.echo ?? null,
    at: new Date().toISOString(),
  }),
});
