// CENTRAL-C1 — die Renderer-Seite der Brücke: zuhören, ausführen, antworten.
//
// Der Vertrag mit Rust in zwei Sätzen: Dieser Renderer meldet sich EINMAL pro Leben als bereit und
// bekommt dafür eine Generationsnummer; jede Antwort trägt sie mit. Nach einem Neuladen (F5) ist es
// ein neues Leben, also eine neue Nummer — und alles, was für die alte offen war, hat Rust bereits
// abgeschlossen. Damit kann ein Auftrag nicht über ein Neuladen hinweg „weiterleben" und
// versehentlich zweimal ausgeführt werden.
//
// Angemeldet wird erst, wenn die Geschäftsmaschine wirklich läuft — nicht wenn das Fenster da ist.
// Bis dahin weist Rust jede Anfrage mit einer Begründung ab, statt ein Ereignis ins Leere zu
// schicken und den Client in eine Zeitgrenze laufen zu lassen.

import { executeCommand, type Reply } from './command-registry';
// Die Leseoperationen registrieren sich beim Laden — ohne diesen Import kennt der Renderer nur
// die Probe, und jeder Auftrag vom zweiten Rechner liefe in BRIDGE_OP_NOT_REGISTERED.
import './read-commands';
// CENTRAL-C3B — und die eine veraendernde Operation. Ohne diesen Import kennt der Renderer sie
// nicht, und ein Auftrag vom zweiten Rechner liefe in BRIDGE_OP_NOT_REGISTERED.
import './invoice-command';
// CENTRAL-C3C — Stammdaten: Kunde anlegen und aendern.
import './customer-commands';
import './product-commands';
import './invoice-lifecycle-commands';
import './commercial-commands';

/** Muss mit `bridge::EVENT_COMMAND` in Rust übereinstimmen. */
export const BRIDGE_COMMAND_EVENT = 'central-c1-bridge-command';

interface Envelope {
  opId: string;
  op: string;
  generation: number;
  payload: unknown;
  /**
   * CENTRAL-C3B — wer den Auftrag verantwortet. Kommt aus den geprueften Anmeldedaten in Rust,
   * niemals aus dem Rumpf des Clients. Fuer eine Auskunft fehlt sie; eine Buchung ohne sie wird
   * abgewiesen (der durable Nachweis haette sonst keinen Schluessel).
   */
  identity?: {
    commandId: string; tenantId: string; branchId: string; userId: string; payloadHash: string;
  };
}

/** Die Nummer dieses Renderer-Lebens. `null` = noch nicht angemeldet. */
let generation: number | null = null;
let unlisten: (() => void) | null = null;

export function currentGeneration(): number | null {
  return generation;
}

/** Nur für Tests: den Zustand dieses Moduls zurücksetzen. */
export function resetBridgeForTest(): void {
  generation = null;
  if (unlisten) { try { unlisten(); } catch { /* ignore */ } }
  unlisten = null;
}

interface Wiring {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
}

/**
 * Nimmt Aufträge an. Die Reihenfolge ist Absicht: ZUERST zuhören, DANN bereit melden. Umgekehrt
 * gäbe es ein Fenster, in dem Rust schon sendet und niemand horcht — und genau dieser Auftrag
 * würde dann in die Zeitgrenze laufen statt sofort und begründet abgewiesen zu werden.
 */
export async function startBridge(w: Wiring): Promise<void> {
  if (generation !== null) return; // schon angemeldet — eine Anmeldung pro Leben

  unlisten = await w.listen(BRIDGE_COMMAND_EVENT, (event) => {
    const env = event.payload as Envelope | null;
    if (!env || typeof env.opId !== 'string' || typeof env.op !== 'string') return;
    // Ein Auftrag aus einer anderen Generation gehört nicht uns. Rust filtert das ebenfalls; hier
    // steht der zweite Riegel, weil ein Ereignis nach einem Neuladen noch in der Luft sein kann.
    if (generation !== null && env.generation !== generation) return;

    void handle(w, env);
  });

  const announced = await w.invoke('bridge_announce_ready');
  generation = Number(announced);
}

async function handle(w: Wiring, env: Envelope): Promise<void> {
  let reply: Reply;
  try {
    reply = await executeCommand(env.op, env.payload, env.identity);
  } catch {
    // `executeCommand` wirft nicht; das hier ist der Gürtel zum Hosenträger. Eine unbeantwortete
    // Anfrage wäre das einzige wirklich schlechte Ergebnis.
    reply = { kind: 'infrastructure_error', code: 'BRIDGE_COMMAND_FAILED' };
  }
  try {
    await w.invoke('bridge_reply', { opId: env.opId, generation: env.generation, reply });
  } catch (err) {
    // Die Antwort kam nicht durch (Fenster geht, Generation vorbei). Der Auftrag IST gelaufen —
    // deshalb wird hier nichts wiederholt, sondern nur vermerkt.
    console.warn('[bridge] reply not delivered:', env.op, err);
  }
}

/** Der Standardweg in der laufenden Anwendung. */
export async function startBridgeWithTauri(): Promise<void> {
  const [{ invoke }, evt] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  await startBridge({
    invoke: (cmd, args) => invoke(cmd, args),
    listen: (event, cb) => evt.listen(event, (e) => cb({ payload: e.payload })),
  });
}
