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
import { CUSTOMER_EDITABLE } from '@/core/data/write-payloads';
import { assertRevision } from './financial-commands';
import {
  assertHouseBranch, discardStagedAfterSuccess, invokeDiscardStaged, invokeReadStagedRecord, isStagingId,
  readStagedAsRecordImages, stagingOwnerOf, type StagedMediaDiscard, type StagedMediaReader,
} from './remote-create-support';
import { applyIdentityDocument, ingestIdentityPhoto, IdentityMediaError } from '@/core/identity/identity-media';

export const OP_CUSTOMERS_CREATE = 'customers.create';
export const OP_CUSTOMERS_UPDATE = 'customers.update';

/**
 * Was ein Mensch im Kundenformular eingibt — und nichts sonst. Die Liste ist die des lokalen
 * Formulars; `lastContactAt`/`lastPurchaseAt` fehlen mit Absicht: die setzt die Domäne, wenn etwas
 * passiert, nicht ein Client.
 */
const EDITABLE = new Set<string>(CUSTOMER_EDITABLE);

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

// ── MEDIA-IDENTITY §2 — das Ausweisdokument im Auftrag ────────────────────────
//
// Es reist NIE als Bytes. Ein neues Foto wird vorher in die Zwischenablage des Primary gelegt
// (R5B) und hier nur bei seiner Inhaltskennung genannt; ein entferntes ist ein ausdrückliches
// `idPhoto: null`. Beides zusammen wäre kein Wunsch, sondern ein Widerspruch.
const PHOTO_KEYS = ['idPhoto', 'idPhotoStagingId', 'expectedRevision'];

export interface CustomerIdentityPlan {
  /** Eine neue Aufnahme, benannt nach ihrem Inhalt. */
  stagingId?: string;
  /** Ausdrücklich entfernen. */
  remove: boolean;
}

function parseIdentityPlan(raw: Record<string, unknown>): CustomerIdentityPlan {
  const staging = raw.idPhotoStagingId;
  const remove = 'idPhoto' in raw;
  if (remove && raw.idPhoto !== null) {
    throw new CustomerPayloadError('an ID document travels as staged bytes (idPhotoStagingId); only `idPhoto: null` removes it');
  }
  if (staging === undefined) return { remove };
  if (!isStagingId(staging)) throw new CustomerPayloadError('a staged image is named by its content hash');
  if (remove) throw new CustomerPayloadError('replace the ID document OR remove it, not both');
  return { stagingId: staging, remove: false };
}

function expectedRevisionOf(raw: Record<string, unknown>): number | undefined {
  const v = raw.expectedRevision;
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new CustomerPayloadError('expectedRevision must be the revision you saw');
  }
  return v;
}

const withoutKeys = (raw: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!keys.includes(k)) out[k] = v;
  return out;
};

/** Anlegen: mindestens ein Name. Genau die Regel des Schnell-Anlegen-Dialogs im Haus. */
export function parseCustomerCreate(raw: unknown): { fields: Record<string, unknown>; photo: CustomerIdentityPlan } {
  if (!isPlain(raw)) throw new CustomerPayloadError('payload must be an object');
  const photo = parseIdentityPlan(raw);
  if (photo.remove) throw new CustomerPayloadError('a new customer has nothing to remove');
  const fields = parseCustomerFields(withoutKeys(raw, PHOTO_KEYS));
  const first = String(fields.firstName ?? '').trim();
  const last = String(fields.lastName ?? '').trim();
  if (!first && !last) throw new CustomerPayloadError('a customer needs at least a first or last name');
  return { fields, photo };
}

/** Ändern: eine Kennung und mindestens ein Feld — ein leeres Update ist keine Absicht. */
export function parseCustomerUpdate(raw: unknown): {
  id: string; fields: Record<string, unknown>; photo: CustomerIdentityPlan; expectedRevision?: number;
} {
  if (!isPlain(raw)) throw new CustomerPayloadError('payload must be an object');
  const { id, ...rest } = raw as { id?: unknown };
  if (typeof id !== 'string' || !id.trim()) throw new CustomerPayloadError('id is required');
  const photo = parseIdentityPlan(rest as Record<string, unknown>);
  const expectedRevision = expectedRevisionOf(rest as Record<string, unknown>);
  const changesPhoto = photo.remove || photo.stagingId !== undefined;
  // MEDIA-IDENTITY §9 — wer das Ausweisdokument tauscht oder entfernt, MUSS sagen, welchen Stand
  // er dabei gesehen hat. Sonst ersetzt ein zweiter Bildschirm ein gerade getauschtes Dokument
  // still wieder durch das alte.
  if (changesPhoto && expectedRevision === undefined) {
    throw new CustomerPayloadError('expectedRevision is required when the ID document changes');
  }
  const fields = parseCustomerFields(withoutKeys(rest as Record<string, unknown>, PHOTO_KEYS));
  if (Object.keys(fields).length === 0 && !changesPhoto) throw new CustomerPayloadError('nothing to change');
  const first = 'firstName' in fields ? String(fields.firstName ?? '').trim() : null;
  const last = 'lastName' in fields ? String(fields.lastName ?? '').trim() : null;
  if (first !== null && last !== null && !first && !last) {
    throw new CustomerPayloadError('a customer needs at least a first or last name');
  }
  return { id, fields, photo, expectedRevision };
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

/** Nur für Tests: die Zwischenablage ohne Tauri. Voreingestellt sind die echten Aufrufe. */
export interface CustomerMediaExtras {
  readStaged?: StagedMediaReader;
  discardStaged?: StagedMediaDiscard;
}

/** Ein Nein des Ausweisvertrags ist ein eingefrorenes Nein mit SEINEM Code. */
function ausweis<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof IdentityMediaError) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

/**
 * MEDIA-IDENTITY §2 — die Bytes aus der Ablage holen und zu einem geprüften Medium machen.
 * VOR der Klammer: der Ingest hat eigene durable Haltepunkte und darf nicht in einer offenen
 * Geschäftstransaktion sitzen. Ein Nein wird mitgenommen statt geworfen, damit eine Wiederholung
 * desselben Auftrags die eingefrorene Antwort bekommt und nicht einen neuen Fehler.
 */
async function ingestStagedIdentity(
  photo: CustomerIdentityPlan, identity: CommandIdentity, extras: CustomerMediaExtras, customerId?: string,
): Promise<{ mediaId: string | null; error: unknown }> {
  if (!photo.stagingId) return { mediaId: null, error: null };
  try {
    const [dataUrl] = await readStagedAsRecordImages(
      [photo.stagingId], stagingOwnerOf(identity), extras.readStaged ?? invokeReadStagedRecord,
      (m) => new CustomerPayloadError(m),
    );
    return { mediaId: dataUrl ? await ingestIdentityPhoto(dataUrl, 'customer', { ownerId: customerId }) : null, error: null };
  } catch (e) {
    return { mediaId: null, error: e };
  }
}

export async function runCustomerCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: CustomerMediaExtras = {},
): Promise<CommandOutcome> {
  const { fields, photo } = parseCustomerCreate(raw);
  const { mediaId, error } = await ingestStagedIdentity(photo, identity, extras);
  const outcome = await runRemoteCommand(deps, identity, () => {
    if (error) throw error;
    assertHouseBranch(identity);
    const created = useCustomerStore.getState().createCustomer(fields as never);
    // Die Zeile ist gerade entstanden — das Anlegen IST die Änderung, also keine zweite Fassung.
    if (mediaId) ausweis(() => applyIdentityDocument('customer', created.id, mediaId, { bumpOwner: false }));
    const result: CustomerCommandResult = {
      customerId: created.id,
      name: `${created.firstName} ${created.lastName}`.trim(),
    };
    return result;
  });
  if (outcome.kind === 'ok' && photo.stagingId) {
    await discardStagedAfterSuccess([photo.stagingId], stagingOwnerOf(identity), extras.discardStaged ?? invokeDiscardStaged);
  }
  return outcome;
}

export async function runCustomerUpdate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: CustomerMediaExtras = {},
): Promise<CommandOutcome> {
  const { id, fields, photo, expectedRevision } = parseCustomerUpdate(raw);
  const changesPhoto = photo.remove || photo.stagingId !== undefined;
  const { mediaId, error } = await ingestStagedIdentity(photo, identity, extras, id);
  const outcome = await runRemoteCommand(deps, identity, () => {
    if (error) throw error;
    // Der Kunde muss es geben — sonst schriebe ein `UPDATE` still ins Leere und meldete Erfolg.
    // Das ist ein Urteil der Domäne über DIESE Anfrage und wird deshalb eingefroren.
    const rows = query('SELECT id, first_name, last_name FROM customers WHERE id = ?', [id]);
    if (rows.length === 0) throw new CommandRejected('CUSTOMER_NOT_FOUND', 'no such customer');
    if (expectedRevision !== undefined) assertRevision('customers', id, expectedRevision, 'CUSTOMER_NOT_FOUND');
    // Schreibt dieser Auftrag die Zeile ohnehin, ist IHR Trigger die eine Fassung; ändert sich nur
    // das Dokument, zählt die Verknüpfung selbst — ein Tausch ist genau EINE Fassung.
    if (changesPhoto) {
      ausweis(() => applyIdentityDocument('customer', id, mediaId, { bumpOwner: Object.keys(fields).length === 0 }));
    }
    if (Object.keys(fields).length > 0) useCustomerStore.getState().updateCustomer(id, fields as never);
    const after = query('SELECT first_name, last_name FROM customers WHERE id = ?', [id])[0];
    const result: CustomerCommandResult = {
      customerId: id,
      name: `${String(after?.first_name ?? '')} ${String(after?.last_name ?? '')}`.trim(),
    };
    return result;
  });
  if (outcome.kind === 'ok' && photo.stagingId) {
    await discardStagedAfterSuccess([photo.stagingId], stagingOwnerOf(identity), extras.discardStaged ?? invokeDiscardStaged);
  }
  return outcome;
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
