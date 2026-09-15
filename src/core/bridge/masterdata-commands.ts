// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — Stammdaten vom zweiten Rechner: Lieferant, Mitarbeiter, Partner, Agent.
//
// Derselbe Bau wie beim Kunden (`customer-commands.ts`), und aus denselben Gründen:
//
//  1. **Keine zweite Stammdatenlogik.** Jeder Befehl ruft die Hausfunktion, die auch die Maske des
//     Primary ruft (`createSupplier`, `updateAgent`, …), und die prüft mit DERSELBEN Regel
//     (`masterdata-rules.ts`). Primary und PC2 bekommen für dieselbe Eingabe dieselbe Antwort.
//  2. **Der Rumpf ist ein Wunsch.** Kennung, Filiale, Benutzer, Zeitstempel und alles, was das Haus
//     selbst rechnet (Umsatzsummen, Salden, Anteile am Ergebnis), stehen namentlich auf der
//     Verbotsliste; ein unbekanntes Feld wird abgewiesen statt ignoriert.
//  3. **Eine fachliche Aktion, ein Befehl.** Drei „+ New Supplier"-Knöpfe sind EINE Aktion
//     (`suppliers.create`); „Deactivate" ist ein Ändern mit dem Zielwert (`suppliers.update`), kein
//     eigener Befehl und kein Umschalter (ein wiederholter Umschalter hätte zweimal umgeschaltet).
//  4. **Bilder reisen als Ablage.** Das Ausweisfoto eines Lieferanten kommt über die vorhandene
//     Zwischenablage (R5B, `remote-create-support.ts`) — nie als Bytes im Auftrag.
//
// Bewusst NICHT dabei: Löschen (§5, eigener Referenzvertrag), die Login-Verknüpfung eines
// Mitarbeiters (Hauskonfiguration) und die Umsatzsummen eines Agenten (führt das Haus).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { useSupplierStore } from '@/stores/supplierStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { usePartnerStore } from '@/stores/partnerStore';
import { useAgentStore } from '@/stores/agentStore';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import {
  assertHouseBranch, discardStagedAfterSuccess, invokeDiscardStaged, invokeReadStagedRecord, isStagingId,
  readStagedAsRecordImages, stagingOwnerOf, type StagedMediaDiscard, type StagedMediaReader,
} from './remote-create-support';
import {
  AGENT_UPDATE_FIELDS, EMPLOYEE_FIELDS, MasterdataInputError, PARTNER_CREATE_FIELDS, PARTNER_UPDATE_FIELDS,
  SUPPLIER_CREATE_FIELDS, SUPPLIER_UPDATE_FIELDS,
  agentUpdateInput, employeeCreateInput, employeeUpdateInput, partnerCreateInput, partnerUpdateInput,
  supplierCreateInput, supplierUpdateInput,
  type AgentUpdateInput, type EmployeeCreateInput, type EmployeeUpdateInput, type PartnerCreateInput,
  type PartnerUpdateInput, type SupplierCreateInput, type SupplierUpdateInput,
} from '@/core/masterdata/masterdata-rules';

export const OP_SUPPLIERS_CREATE = 'suppliers.create';
export const OP_SUPPLIERS_UPDATE = 'suppliers.update';
export const OP_AGENTS_UPDATE = 'agents.update';
export const OP_PARTNERS_CREATE = 'partners.create';
export const OP_PARTNERS_UPDATE = 'partners.update';
export const OP_EMPLOYEES_CREATE = 'employees.create';
export const OP_EMPLOYEES_UPDATE = 'employees.update';

export const MASTERDATA_OPS = [
  OP_SUPPLIERS_CREATE, OP_SUPPLIERS_UPDATE, OP_AGENTS_UPDATE,
  OP_PARTNERS_CREATE, OP_PARTNERS_UPDATE, OP_EMPLOYEES_CREATE, OP_EMPLOYEES_UPDATE,
] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class MasterdataPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'MASTERDATA_PAYLOAD_INVALID') {
    super(message);
    this.name = 'MasterdataPayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision'];
/** Was das Haus selbst führt — je Stammdatum. */
export const MASTERDATA_COMPUTED = {
  supplier: ['totalPurchases', 'totalPaid', 'outstandingBalance', 'creditBalance'],
  partner: ['totalInvested', 'totalWithdrawn', 'totalProfitShare', 'balance'],
  agent: ['totalSales', 'totalCommission', 'commissionRate'],
  employee: [] as string[],
} as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], computed: readonly string[], keep: readonly string[] = []): Record<string, unknown> {
  if (!isPlain(raw)) throw new MasterdataPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (keep.includes(k)) continue;
    if (FORBIDDEN.includes(k) || computed.includes(k)) throw new MasterdataPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new MasterdataPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

/** Die Regel als Prüfung des Rumpfs: ihr Nein kommt mit IHREM Code zurück — derselbe wie am Primary. */
function rule<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof MasterdataInputError) throw new MasterdataPayloadError(e.message, e.code);
    throw e;
  }
}

/** Dieselbe Regel INNERHALB des Auftrags: dort ist ihr Nein ein eingefrorenes Urteil. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof MasterdataInputError) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

function requiredId(raw: Record<string, unknown>): string {
  const id = raw.id;
  if (typeof id !== 'string' || !id.trim()) throw new MasterdataPayloadError('id is required');
  return id;
}

function without(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!keys.includes(k)) out[k] = v;
  return out;
}

function nothing(fields: Record<string, unknown>, extra = false): void {
  if (Object.keys(fields).length === 0 && !extra) throw new MasterdataPayloadError('nothing to change');
}

// ── Lieferant ──────────────────────────────────────────────────────────────

export interface SupplierCreateRequest { input: SupplierCreateInput; cprImageStagingId?: string }
export interface SupplierUpdateRequest { id: string; fields: SupplierUpdateInput; cprImageStagingId?: string }

function stagingIdOf(raw: Record<string, unknown>): string | undefined {
  const v = raw.cprImageStagingId;
  if (v === undefined) return undefined;
  if (!isStagingId(v)) throw new MasterdataPayloadError('a staged image is named by its content hash');
  return v;
}

export function parseSupplierCreate(raw: unknown): SupplierCreateRequest {
  if (isPlain(raw) && 'cprImage' in raw) {
    throw new MasterdataPayloadError('an ID-card photo travels as staged bytes (cprImageStagingId), never inside the order');
  }
  // Ein neuer Lieferant ist im Haus IMMER aktiv — das entscheidet kein Rumpf.
  if (isPlain(raw) && 'active' in raw) throw new MasterdataPayloadError('the primary decides active, not the client');
  const allowed = [...SUPPLIER_CREATE_FIELDS.filter((f) => f !== 'cprImage'), 'cprImageStagingId'];
  const r = strict(raw, allowed, MASTERDATA_COMPUTED.supplier);
  return { input: rule(() => supplierCreateInput(without(r, 'cprImageStagingId'))), cprImageStagingId: stagingIdOf(r) };
}

export function parseSupplierUpdate(raw: unknown): SupplierUpdateRequest {
  if (isPlain(raw) && 'cprImage' in raw && raw.cprImage !== null) {
    throw new MasterdataPayloadError('an ID-card photo travels as staged bytes (cprImageStagingId), never inside the order');
  }
  const r = strict(raw, [...SUPPLIER_UPDATE_FIELDS, 'cprImageStagingId'], MASTERDATA_COMPUTED.supplier, ['id']);
  const id = requiredId(r);
  const cprImageStagingId = stagingIdOf(r);
  if (cprImageStagingId && 'cprImage' in r) throw new MasterdataPayloadError('replace the photo OR remove it, not both');
  const fields = rule(() => supplierUpdateInput(without(r, 'id', 'cprImageStagingId')));
  nothing(fields as Record<string, unknown>, !!cprImageStagingId);
  return { id, fields, cprImageStagingId };
}

// ── Mitarbeiter ────────────────────────────────────────────────────────────

export function parseEmployeeCreate(raw: unknown): EmployeeCreateInput {
  return rule(() => employeeCreateInput(strict(raw, EMPLOYEE_FIELDS, MASTERDATA_COMPUTED.employee)));
}

export function parseEmployeeUpdate(raw: unknown): { id: string; fields: EmployeeUpdateInput } {
  const r = strict(raw, EMPLOYEE_FIELDS, MASTERDATA_COMPUTED.employee, ['id']);
  const id = requiredId(r);
  const fields = rule(() => employeeUpdateInput(without(r, 'id')));
  nothing(fields as Record<string, unknown>);
  return { id, fields };
}

// ── Partner ────────────────────────────────────────────────────────────────

export function parsePartnerCreate(raw: unknown): PartnerCreateInput {
  if (isPlain(raw) && 'active' in raw) throw new MasterdataPayloadError('the primary decides active, not the client');
  return rule(() => partnerCreateInput(strict(raw, PARTNER_CREATE_FIELDS, MASTERDATA_COMPUTED.partner)));
}

export function parsePartnerUpdate(raw: unknown): { id: string; fields: PartnerUpdateInput } {
  const r = strict(raw, PARTNER_UPDATE_FIELDS, MASTERDATA_COMPUTED.partner, ['id']);
  const id = requiredId(r);
  const fields = rule(() => partnerUpdateInput(without(r, 'id')));
  nothing(fields as Record<string, unknown>);
  return { id, fields };
}

// ── Agent ──────────────────────────────────────────────────────────────────

export function parseAgentUpdate(raw: unknown): { id: string; fields: AgentUpdateInput } {
  const r = strict(raw, AGENT_UPDATE_FIELDS, MASTERDATA_COMPUTED.agent, ['id']);
  const id = requiredId(r);
  const fields = rule(() => agentUpdateInput(without(r, 'id')));
  nothing(fields as Record<string, unknown>);
  return { id, fields };
}

// ── Die Läufe ──────────────────────────────────────────────────────────────

export function masterdataDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

/** Wie die Bytes einer Ablage geholt und danach geräumt werden — für Tests ersetzbar. */
export interface MasterdataMedia {
  readStaged?: StagedMediaReader;
  discardStaged?: StagedMediaDiscard;
}

/** Gibt es diesen Datensatz in der Filiale des Auftrags? Sonst ein eingefrorenes Nein. */
function mustExist(table: 'suppliers' | 'agents' | 'partners' | 'employees' | 'customers', id: string, branchId: string, code: string): void {
  const rows = query(`SELECT id FROM ${table} WHERE id = ? AND branch_id = ?`, [id, branchId]);
  if (rows.length === 0) throw new CommandRejected(code, 'no such record in this branch');
}

async function stagedImage(ids: string[], identity: CommandIdentity, media: MasterdataMedia): Promise<string | undefined> {
  if (ids.length === 0) return undefined;
  // POST-PARITY R7B PP-12 — das Ausweisfoto kommt so aus der Ablage, wie es gespeichert wird (≤ 100 000 B).
  const [img] = await readStagedAsRecordImages(ids, stagingOwnerOf(identity), media.readStaged ?? invokeReadStagedRecord,
    (m) => new MasterdataPayloadError(m, 'STAGED_IMAGE_GONE'));
  return img;
}

export async function runSupplierCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown, media: MasterdataMedia = {}): Promise<CommandOutcome> {
  const req = parseSupplierCreate(raw);
  const staged = req.cprImageStagingId ? [req.cprImageStagingId] : [];
  const outcome = await runRemoteCommand(deps, identity, async () => {
    assertHouseBranch(identity);
    const cprImage = await stagedImage(staged, identity, media);
    const s = urteil(() => useSupplierStore.getState().createSupplier({ ...req.input, ...(cprImage ? { cprImage } : {}) }));
    return { supplierId: s.id, name: s.name };
  });
  if (outcome.kind === 'ok' && staged.length) await discardStagedAfterSuccess(staged, stagingOwnerOf(identity), media.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

export async function runSupplierUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown, media: MasterdataMedia = {}): Promise<CommandOutcome> {
  const req = parseSupplierUpdate(raw);
  const staged = req.cprImageStagingId ? [req.cprImageStagingId] : [];
  const outcome = await runRemoteCommand(deps, identity, async () => {
    assertHouseBranch(identity);
    mustExist('suppliers', req.id, identity.branchId, 'SUPPLIER_NOT_FOUND');
    const cprImage = await stagedImage(staged, identity, media);
    urteil(() => useSupplierStore.getState().updateSupplier(req.id, { ...req.fields, ...(cprImage ? { cprImage } : {}) } as never));
    const row = query('SELECT name, active FROM suppliers WHERE id = ?', [req.id])[0];
    return { supplierId: req.id, name: String(row?.name ?? ''), active: Number(row?.active) === 1 };
  });
  if (outcome.kind === 'ok' && staged.length) await discardStagedAfterSuccess(staged, stagingOwnerOf(identity), media.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

export function runEmployeeCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseEmployeeCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const e = urteil(() => useEmployeeStore.getState().createEmployee(input as never));
    return { employeeId: e.id, name: e.name };
  });
}

export function runEmployeeUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const { id, fields } = parseEmployeeUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    mustExist('employees', id, identity.branchId, 'EMPLOYEE_NOT_FOUND');
    urteil(() => useEmployeeStore.getState().updateEmployee(id, fields as never));
    const row = query('SELECT name, employment_status FROM employees WHERE id = ?', [id])[0];
    return { employeeId: id, name: String(row?.name ?? ''), employmentStatus: String(row?.employment_status ?? '') };
  });
}

export function runPartnerCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parsePartnerCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const p = urteil(() => usePartnerStore.getState().createPartner(input));
    return { partnerId: p.id, name: p.name };
  });
}

export function runPartnerUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const { id, fields } = parsePartnerUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    mustExist('partners', id, identity.branchId, 'PARTNER_NOT_FOUND');
    urteil(() => usePartnerStore.getState().updatePartner(id, fields as never));
    const row = query('SELECT name FROM partners WHERE id = ?', [id])[0];
    return { partnerId: id, name: String(row?.name ?? '') };
  });
}

export function runAgentUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const { id, fields } = parseAgentUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    mustExist('agents', id, identity.branchId, 'AGENT_NOT_FOUND');
    // Ein verknüpfter Kunde muss in derselben Filiale existieren — sonst zeigte die Umwandlung in
    // eine Rechnung später auf ein Nichts.
    if (typeof fields.customerId === 'string') mustExist('customers', fields.customerId, identity.branchId, 'CUSTOMER_NOT_FOUND');
    urteil(() => useAgentStore.getState().updateAgent(id, fields as never));
    const row = query('SELECT name FROM agents WHERE id = ?', [id])[0];
    return { agentId: id, name: String(row?.name ?? '') };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(masterdataDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof MasterdataPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein (siehe `customer-commands.ts`).
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_SUPPLIERS_CREATE, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runSupplierCreate(d, i, r), OP_SUPPLIERS_CREATE, p, a) });
registerCommand(OP_SUPPLIERS_UPDATE, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runSupplierUpdate(d, i, r), OP_SUPPLIERS_UPDATE, p, a) });
registerCommand(OP_AGENTS_UPDATE, { kind: 'mutation', handler: (p, a) => execute(runAgentUpdate, OP_AGENTS_UPDATE, p, a) });
registerCommand(OP_PARTNERS_CREATE, { kind: 'mutation', handler: (p, a) => execute(runPartnerCreate, OP_PARTNERS_CREATE, p, a) });
registerCommand(OP_PARTNERS_UPDATE, { kind: 'mutation', handler: (p, a) => execute(runPartnerUpdate, OP_PARTNERS_UPDATE, p, a) });
registerCommand(OP_EMPLOYEES_CREATE, { kind: 'mutation', handler: (p, a) => execute(runEmployeeCreate, OP_EMPLOYEES_CREATE, p, a) });
registerCommand(OP_EMPLOYEES_UPDATE, { kind: 'mutation', handler: (p, a) => execute(runEmployeeUpdate, OP_EMPLOYEES_UPDATE, p, a) });
