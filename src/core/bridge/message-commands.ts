// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — das Nachrichtenprotokoll vom zweiten Rechner: `customers.log_message`.
//
// Derselbe Bau wie bei den Geldaktionen (`money-commands.ts`):
//
//  1. **Keine zweite Schreiblogik.** Der Befehl ruft die Hausfolge, die auch die Maske des Primary
//     ruft (`message-house.ts`): dieselbe Prüfung, dieselbe Zeile, in der Transaktion des Auftrags.
//  2. **Der Rumpf ist ein Wunsch.** Kennung, Filiale, Benutzer, Zeitpunkte, Richtung und alles, was
//     das Haus vergibt, stehen namentlich auf der Verbotsliste; ein unbekanntes Feld wird
//     abgewiesen statt ignoriert. `created_by` ist der geprüfte Absender, nie der Primary.
//  3. **Nur anhängen.** Ein Protokolleintrag wird angelegt, nie geändert — keine Fassung. Eine
//     verlorene Antwort wiederholt der Client mit DERSELBEN Kennung: genau eine Zeile.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import {
  MessageRejected, logCustomerMessageInHouse, messageLogInput, type LoggedMessage, type MessageLogInput,
} from '@/core/customers/message-house';

export const OP_CUSTOMERS_LOG_MESSAGE = 'customers.log_message';

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class MessagePayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'MESSAGE_PAYLOAD_INVALID') {
    super(message);
    this.name = 'MessagePayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welcher Zustand. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status'];
/**
 * Was das Haus selbst vergibt: der Zeitpunkt des Versands (Uhr des Primary), die Richtung (dieses
 * Protokoll hält hinausgegangene Nachrichten fest) und die Kennung der Zeile.
 */
export const MESSAGE_COMPUTED = ['sentAt', 'direction', 'messageId'] as const;
/** Genau die Felder, die die Maske schickt — `subject` schickt keiner ihrer Aufrufer. */
const ALLOWED = ['customerId', 'channel', 'body', 'kind', 'linkedEntityType', 'linkedEntityId'];

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseLogMessage(raw: unknown): MessageLogInput {
  if (!isPlain(raw)) throw new MessagePayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k) || (MESSAGE_COMPUTED as readonly string[]).includes(k)) {
      throw new MessagePayloadError(`the primary decides ${k}, not the client`);
    }
    if (!ALLOWED.includes(k)) throw new MessagePayloadError(`unknown field: ${k}`);
  }
  // Die Eingaberegel als Prüfung des Rumpfs: ihr Nein kommt mit IHREM Code zurück — derselbe wie am Primary.
  try { return messageLogInput(raw); } catch (e) {
    if (e instanceof MessageRejected) throw new MessagePayloadError(e.message, e.code);
    throw e;
  }
}

export function messageDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runLogMessage(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseLogMessage(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    let m: LoggedMessage;
    try {
      m = logCustomerMessageInHouse(input, identity.branchId, identity.userId);
    } catch (e) {
      // Dieselbe Folge INNERHALB des Auftrags: dort ist ihr Nein ein eingefrorenes Urteil.
      if (e instanceof MessageRejected) throw new CommandRejected(e.code, e.message);
      throw e;
    }
    return { messageId: m.id, customerId: m.customerId, channel: m.channel, sentAt: m.sentAt };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${OP_CUSTOMERS_LOG_MESSAGE} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await runLogMessage(messageDeps(), { ...actor, op: OP_CUSTOMERS_LOG_MESSAGE }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof MessagePayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_CUSTOMERS_LOG_MESSAGE, { kind: 'mutation', handler: (p, a) => execute(p, a) });
