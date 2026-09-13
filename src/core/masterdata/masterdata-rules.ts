// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — die EINE Regel für Stammdaten: Lieferant, Mitarbeiter, Partner, Agent.
//
// Bisher prüfte jede Maske für sich, und die Hausfunktion gar nicht. Drei Einstiege legten einen
// Lieferanten an, und nur einer trimmte den Namen; zwei ließen einen Namen aus Leerzeichen durch.
// Ein geleertes Namensfeld beim Ändern schrieb einen leeren Namen. Ein Partner konnte 250 % Anteil
// bekommen, ein Mitarbeiter ein negatives Grundgehalt. Das Ändern eines Agenten schrieb dessen
// Umsatzsummen aus dem Stand zurück, der beim Öffnen der Maske geladen war — ein Verkauf dazwischen
// verschwand wieder (dieselbe Sorte Fehler wie M-01 beim Kunden).
//
// Hier steht die Regel jetzt EINMAL. Die Hausfunktionen (Store) prüfen mit ihr, der Fernbefehl prüft
// mit ihr, und die Masken bauen ihren Rumpf aus denselben Feldlisten. Primary und PC2 bekommen damit
// für dieselbe Eingabe dieselbe Antwort.
//
// Was hier NICHT steht: keine Datenbank, keine Filiale, keine Kennung. Diese Datei ist rein.
// ════════════════════════════════════════════════════════════════════════════

/** Ein fachliches Nein zu einer Stammdaten-Eingabe — gleich, woher sie kommt. */
export class MasterdataInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MasterdataInputError';
    this.code = code;
  }
}

const fail = (code: string, message: string): never => { throw new MasterdataInputError(code, message); };

/** Text: getrimmt; leer oder fehlend heißt „kein Wert". Etwas anderes als Text ist ein Nein. */
function text(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return fail('MASTERDATA_FIELD_INVALID', `${what} must be text`);
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Beim ÄNDERN: ein geleertes Feld ist eine Aussage („weg damit") und wird `null`. */
function textOrClear(v: unknown, what: string): string | null {
  return text(v, what) ?? null;
}

function name(v: unknown, code: string, what: string): string {
  const t = text(v, what);
  if (!t) return fail(code, `${what} is required`);
  return t;
}

function number(v: unknown, what: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail('MASTERDATA_FIELD_INVALID', `${what} must be a number`);
  if (v < min || v > max) return fail('MASTERDATA_FIELD_OUT_OF_RANGE', `${what} must be between ${min} and ${max}`);
  return v;
}

function flag(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') return fail('MASTERDATA_FIELD_INVALID', `${what} must be true or false`);
  return v;
}

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

// ── Lieferant ──────────────────────────────────────────────────────────────

/** Was die Anlegemasken eines Lieferanten erfassen (SupplierList, PurchaseCreate, RepairList). */
export const SUPPLIER_CREATE_FIELDS = ['name', 'phone', 'email', 'address', 'notes', 'cpr', 'cprImage'] as const;
/** Ändern: dieselben Felder und der Aktiv-Schalter. */
export const SUPPLIER_UPDATE_FIELDS = [...SUPPLIER_CREATE_FIELDS, 'active'] as const;

export interface SupplierCreateInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  cpr?: string;
  /** Das Bild des Ausweises als Daten-URL — so, wie `ImageUpload` es liefert. */
  cprImage?: string;
}

export type SupplierUpdateInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  cpr?: string | null;
  cprImage?: string | null;
  active?: boolean;
};

export const SUPPLIER_NAME_REQUIRED = 'SUPPLIER_NAME_REQUIRED';

export function supplierCreateInput(raw: Record<string, unknown>): SupplierCreateInput {
  const out: SupplierCreateInput = { name: name(raw.name, SUPPLIER_NAME_REQUIRED, 'the supplier name') };
  for (const k of ['phone', 'email', 'address', 'notes', 'cpr', 'cprImage'] as const) {
    const v = text(raw[k], k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function supplierUpdateInput(raw: Record<string, unknown>): SupplierUpdateInput {
  const out: SupplierUpdateInput = {};
  if (has(raw, 'name')) out.name = name(raw.name, SUPPLIER_NAME_REQUIRED, 'the supplier name');
  for (const k of ['phone', 'email', 'address', 'notes', 'cpr', 'cprImage'] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = textOrClear(raw[k], k);
  }
  if (has(raw, 'active')) out.active = flag(raw.active, 'active');
  return out;
}

// ── Mitarbeiter ────────────────────────────────────────────────────────────

export const EMPLOYMENT_STATUSES = ['active', 'on_leave', 'inactive'] as const;
export type EmploymentStatusValue = typeof EMPLOYMENT_STATUSES[number];

export const EMPLOYEE_FIELDS = ['name', 'role', 'employmentStatus', 'baseSalary', 'phone', 'email', 'notes'] as const;
export const EMPLOYEE_NAME_REQUIRED = 'EMPLOYEE_NAME_REQUIRED';
/** Ein Grundgehalt ist ein Monatsbetrag in BHD — nie negativ. */
export const MAX_BASE_SALARY = 1_000_000;

export interface EmployeeCreateInput {
  name: string;
  role?: string;
  employmentStatus: EmploymentStatusValue;
  baseSalary?: number;
  phone?: string;
  email?: string;
  notes?: string;
}

export type EmployeeUpdateInput = {
  name?: string;
  role?: string | null;
  employmentStatus?: EmploymentStatusValue;
  baseSalary?: number | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
};

function status(v: unknown): EmploymentStatusValue {
  if (typeof v !== 'string' || !(EMPLOYMENT_STATUSES as readonly string[]).includes(v)) {
    return fail('EMPLOYEE_STATUS_INVALID', `employmentStatus must be one of ${EMPLOYMENT_STATUSES.join(', ')}`);
  }
  return v as EmploymentStatusValue;
}

export function employeeCreateInput(raw: Record<string, unknown>): EmployeeCreateInput {
  const out: EmployeeCreateInput = {
    name: name(raw.name, EMPLOYEE_NAME_REQUIRED, 'Employee name'),
    employmentStatus: has(raw, 'employmentStatus') ? status(raw.employmentStatus) : 'active',
  };
  for (const k of ['role', 'phone', 'email', 'notes'] as const) {
    const v = text(raw[k], k);
    if (v !== undefined) out[k] = v;
  }
  const salary = number(raw.baseSalary, 'baseSalary', 0, MAX_BASE_SALARY);
  if (salary !== undefined) out.baseSalary = salary;
  return out;
}

export function employeeUpdateInput(raw: Record<string, unknown>): EmployeeUpdateInput {
  const out: EmployeeUpdateInput = {};
  if (has(raw, 'name')) out.name = name(raw.name, EMPLOYEE_NAME_REQUIRED, 'Employee name');
  for (const k of ['role', 'phone', 'email', 'notes'] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = textOrClear(raw[k], k);
  }
  if (has(raw, 'employmentStatus')) out.employmentStatus = status(raw.employmentStatus);
  if (Object.prototype.hasOwnProperty.call(raw, 'baseSalary')) {
    out.baseSalary = number(raw.baseSalary, 'baseSalary', 0, MAX_BASE_SALARY) ?? null;
  }
  return out;
}

// ── Partner ────────────────────────────────────────────────────────────────

export const PARTNER_CREATE_FIELDS = ['name', 'phone', 'email', 'sharePercentage', 'notes'] as const;
export const PARTNER_UPDATE_FIELDS = [...PARTNER_CREATE_FIELDS, 'active'] as const;
export const PARTNER_NAME_REQUIRED = 'PARTNER_NAME_REQUIRED';

export interface PartnerCreateInput {
  name: string;
  phone?: string;
  email?: string;
  /** Der Gewinnanteil in Prozent: 0 bis 100 (Plan §Partner). */
  sharePercentage: number;
  notes?: string;
}

export type PartnerUpdateInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  sharePercentage?: number;
  notes?: string | null;
  active?: boolean;
};

export function partnerCreateInput(raw: Record<string, unknown>): PartnerCreateInput {
  const out: PartnerCreateInput = {
    name: name(raw.name, PARTNER_NAME_REQUIRED, 'the partner name'),
    sharePercentage: number(raw.sharePercentage, 'sharePercentage', 0, 100) ?? 0,
  };
  for (const k of ['phone', 'email', 'notes'] as const) {
    const v = text(raw[k], k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function partnerUpdateInput(raw: Record<string, unknown>): PartnerUpdateInput {
  const out: PartnerUpdateInput = {};
  if (has(raw, 'name')) out.name = name(raw.name, PARTNER_NAME_REQUIRED, 'the partner name');
  for (const k of ['phone', 'email', 'notes'] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = textOrClear(raw[k], k);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'sharePercentage')) {
    out.sharePercentage = number(raw.sharePercentage, 'sharePercentage', 0, 100) ?? 0;
  }
  if (has(raw, 'active')) out.active = flag(raw.active, 'active');
  return out;
}

// ── Agent (Approval) ───────────────────────────────────────────────────────

/** Was die Maske „Edit Approval" anbietet. Umsatzsummen gehören NICHT dazu: die führt das Haus. */
export const AGENT_UPDATE_FIELDS = ['name', 'company', 'phone', 'whatsapp', 'email', 'active', 'customerId', 'notes'] as const;
/** Die Hausfunktion nimmt zusätzlich den Provisionssatz (interne Wege, kein Formularfeld). */
export const AGENT_HOUSE_FIELDS = [...AGENT_UPDATE_FIELDS, 'commissionRate'] as const;
export const AGENT_NAME_REQUIRED = 'AGENT_NAME_REQUIRED';

export type AgentUpdateInput = {
  name?: string;
  company?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  active?: boolean;
  customerId?: string | null;
  notes?: string | null;
  commissionRate?: number;
};

export function agentUpdateInput(raw: Record<string, unknown>): AgentUpdateInput {
  const out: AgentUpdateInput = {};
  if (has(raw, 'name')) out.name = name(raw.name, AGENT_NAME_REQUIRED, 'the approval name');
  for (const k of ['company', 'phone', 'whatsapp', 'email', 'notes', 'customerId'] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = textOrClear(raw[k], k);
  }
  if (has(raw, 'active')) out.active = flag(raw.active, 'active');
  if (has(raw, 'commissionRate')) out.commissionRate = number(raw.commissionRate, 'commissionRate', 0, 100) ?? 0;
  return out;
}

/** Nur die genannten Felder eines Formularstands — der Rest (Kennung, Summen, Zeitstempel) fällt weg. */
export function pickFields(form: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(form, f)) out[f] = form[f];
  return out;
}
