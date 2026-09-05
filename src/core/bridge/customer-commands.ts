// CENTRAL-C3C — Kunden anlegen und ändern, von einem zweiten Rechner aus.
//
// Derselbe Bau wie bei der Rechnung, und aus denselben Gründen:
//
//  1. **Keine zweite Kundenlogik.** Der Befehl ruft `createCustomer` / `updateCustomer` — genau die
//     Funktionen, die die Oberfläche des Primary ruft. Spaltenliste, Standardwerte, Changelog,
//     Audit und Ereignisse bleiben dort, wo sie sind.
//  2. **Der Rumpf ist ein Wunsch.** Der Client darf nennen, was ein Mensch eingibt. Filiale,
//     Benutzer, interne Kennung, Umsatzsummen und Kaufzähler entscheidet der Primary — sie stehen
//     namentlich auf der Verbotsliste, und ein unbekanntes Feld wird abgewiesen statt ignoriert.
//  3. **Dieselbe Doppel-Regel wie lokal.** Das Haus BLOCKIERT einen Doppelgänger nicht; es warnt in
//     der Liste (`findSimilarContacts` → Hinweisband) und überlässt die Entscheidung dem Menschen.
//     Hier eine Sperre zu erfinden wäre eine zweite Regel für dieselbe Frage — der Client zeigt
//     dieselbe Warnung mit demselben Helfer, und der Primary legt an, was verlangt wurde.
//
// Bewusst NICHT dabei: Löschen (hat einen eigenen Referenz-Vertrag), und die vom Haus berechneten
// Felder `totalRevenue`/`totalProfit`/`purchaseCount` — die sind seit M-01 auch lokal nicht mehr
// schreibbar, weil ein veraltetes Formular sie sonst zurückschrieb.

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { useCustomerStore } from '@/stores/customerStore';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';

export const OP_CUSTOMERS_CREATE = 'customers.create';
export const OP_CUSTOMERS_UPDATE = 'customers.update';

/**
 * Was ein Mensch im Kundenformular eingibt — und nichts sonst. Die Liste ist die des lokalen
 * Formulars; `lastContactAt`/`lastPurchaseAt` fehlen mit Absicht: die setzt die Domäne, wenn etwas
 * passiert, nicht ein Client.
 */
const EDITABLE = new Set([
  'firstName', 'lastName', 'company', 'phone', 'whatsapp', 'email',
  'country', 'language', 'budgetMin', 'budgetMax', 'vipLevel',
  'preferences', 'customerType', 'salesStage', 'notes',
  'vatAccountNumber', 'personalId',
]);

/**
 * Felder, die der Client ausdrücklich NICHT setzen darf. Jedes einzelne wäre eine andere Art, das
 * Haus zu belügen: eine selbstvergebene Kennung, eine fremde Filiale, ein erfundener Umsatz.
 */
const FORBIDDEN = [
  'id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt',
  'totalRevenue', 'totalProfit', 'purchaseCount', 'lastContactAt', 'lastPurchaseAt',
];

export class CustomerPayloadError extends Error {
  readonly code = 'CUSTOMER_PAYLOAD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'CustomerPayloadError';
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new CustomerPayloadError(`${what} must be text`);
  return v;
};

/** Der geprüfte Wunsch: nur erlaubte Felder, in ihrer erwarteten Form. */
export function parseCustomerFields(raw: unknown): Record<string, unknown> {
  if (!isPlain(raw)) throw new CustomerPayloadError('payload must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN.includes(k)) throw new CustomerPayloadError(`the primary decides ${k}, not the client`);
    if (!EDITABLE.has(k)) throw new CustomerPayloadError(`unknown field: ${k}`);
    if (v === undefined || v === null) { out[k] = null; continue; }
    switch (k) {
      case 'budgetMin': case 'budgetMax': case 'vipLevel': {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new CustomerPayloadError(`${k} must be a number`);
        if (v < 0) throw new CustomerPayloadError(`${k} cannot be negative`);
        out[k] = v;
        break;
      }
      case 'preferences': {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
          throw new CustomerPayloadError('preferences must be a list of words');
        }
        out[k] = v;
        break;
      }
      default:
        out[k] = str(v, k);
    }
  }
  return out;
}

/** Anlegen: mindestens ein Name. Genau die Regel des Schnell-Anlegen-Dialogs im Haus. */
export function parseCustomerCreate(raw: unknown): Record<string, unknown> {
  if (!isPlain(raw)) throw new CustomerPayloadError('payload must be an object');
  const fields = parseCustomerFields(raw);
  const first = String(fields.firstName ?? '').trim();
  const last = String(fields.lastName ?? '').trim();
  if (!first && !last) throw new CustomerPayloadError('a customer needs at least a first or last name');
  return fields;
}

/** Ändern: eine Kennung und mindestens ein Feld — ein leeres Update ist keine Absicht. */
export function parseCustomerUpdate(raw: unknown): { id: string; fields: Record<string, unknown> } {
  if (!isPlain(raw)) throw new CustomerPayloadError('payload must be an object');
  const { id, ...rest } = raw as { id?: unknown };
  if (typeof id !== 'string' || !id.trim()) throw new CustomerPayloadError('id is required');
  const fields = parseCustomerFields(rest);
  if (Object.keys(fields).length === 0) throw new CustomerPayloadError('nothing to change');
  const first = 'firstName' in fields ? String(fields.firstName ?? '').trim() : null;
  const last = 'lastName' in fields ? String(fields.lastName ?? '').trim() : null;
  if (first !== null && last !== null && !first && !last) {
    throw new CustomerPayloadError('a customer needs at least a first or last name');
  }
  return { id, fields };
}

/** Absichtlich ein Typ-Alias: das Ergebnis wird als `CommandResult` (mit Index-Signatur)
 *  herausgegeben, und ein `interface` waere dorthin nicht zuweisbar. */
export type CustomerCommandResult = {
  customerId: string;
  name: string;
};

/** Die Transaktionsklammern des Hauses — dieselben wie bei der Rechnung. */
export function customerEngineDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runCustomerCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const fields = parseCustomerCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    const created = useCustomerStore.getState().createCustomer(fields as never);
    const result: CustomerCommandResult = {
      customerId: created.id,
      name: `${created.firstName} ${created.lastName}`.trim(),
    };
    return result;
  });
}

export function runCustomerUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const { id, fields } = parseCustomerUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    // Der Kunde muss es geben — sonst schriebe ein `UPDATE` still ins Leere und meldete Erfolg.
    // Das ist ein Urteil der Domäne über DIESE Anfrage und wird deshalb eingefroren.
    const rows = query('SELECT id, first_name, last_name FROM customers WHERE id = ?', [id]);
    if (rows.length === 0) throw new CommandRejected('CUSTOMER_NOT_FOUND', 'no such customer');
    useCustomerStore.getState().updateCustomer(id, fields as never);
    const after = query('SELECT first_name, last_name FROM customers WHERE id = ?', [id])[0];
    const result: CustomerCommandResult = {
      customerId: id,
      name: `${String(after?.first_name ?? '')} ${String(after?.last_name ?? '')}`.trim(),
    };
    return result;
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string,
  payload: unknown,
  actor?: CommandActor,
): Promise<CustomerCommandResult & { replayed: boolean }> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  // Die Brücke reicht `{ actor, input }` durch — dieselbe Hülle wie bei den Lesebefehlen.
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(customerEngineDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort, keine Störung: der Client soll ihn korrigieren und
    // mit einer NEUEN Kennung erneut schicken.
    if (err instanceof CustomerPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // NUR ein EINGEFRORENES Urteil ist ein fachliches Nein. Ein nicht eingefrorenes
    // (`frozen: false`) heißt: der Vorgang wurde nie bewertet — eine Kennungskollision, ein
    // abgebrochener Medienweg, ein Artikel, der erst umgezogen werden muss. Es als Nein zu
    // melden wäre die teuerste Verwechslung dieses Systems: die Oberfläche beendet dann den
    // Versuch, sagt dem Benutzer „abgelehnt" und lässt ihn eine NEUE Kennung nehmen — für einen
    // Vorgang, der noch gar nicht stattgefunden hat. Also weiterreichen als das, was es ist.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as CustomerCommandResult), replayed: outcome.replayed };
}

registerCommand(OP_CUSTOMERS_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runCustomerCreate, OP_CUSTOMERS_CREATE, payload, actor),
});

registerCommand(OP_CUSTOMERS_UPDATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runCustomerUpdate, OP_CUSTOMERS_UPDATE, payload, actor),
});
