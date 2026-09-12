// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5D — der Agenten-Transfer: anlegen, in EINE Rechnung wandeln (einzeln, gesammelt).
//
// Rein, ohne Datenbank: was die Masken des Primary und die Fernbefehle gleich wissen müssen.
//
//   • Anlegen: Kunde, Stück, „Our Price", Abrechnungsmodell (voll / Our Price + Anteil), Rückgabe-
//     datum, Mitarbeiter. Den Agenten zum Kunden, die Nummer, den Bestandswechsel und die Zeitpunkte
//     setzt das Haus — nichts davon ist eine Eingabe.
//   • Umwandeln: an einen VORHANDENEN Kunden (die Maske wählt ihn) oder an einen, der aus den Angaben
//     DES AGENTEN neu entsteht („Auto-create from agent"). Die Maske legte ihn IMMER neu an, ohne
//     Abgleich — genau das bleibt so, jetzt aber in derselben Klammer wie die Rechnung.
//
// Die Anschlüsse ans Haus wohnen in `transfer-house`.
// ════════════════════════════════════════════════════════════════════════════
import type { AgentTransfer } from '@/core/models/types';
import { DEFAULT_AGENT_SPLIT_PCT } from '@/core/agent/economics';

/** Ein Nein der geteilten Regeln — am Primary eine Absage der Maske, fern ein eingefrorenes Urteil. */
export class TransferActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'TransferActionRejected';
  }
}

/** Die zwei Abrechnungsmodelle der Anlegemaske — ein WERT, aus dem der Typ folgt. */
export const TRANSFER_SETTLEMENT_MODELS = ['full', 'split'] as const;
export type TransferSettlementModel = typeof TRANSFER_SETTLEMENT_MODELS[number];

/** Aus diesen Zuständen wird ein Transfer zur Rechnung (Knopf „Create Invoice"). */
export const TRANSFER_CONVERTIBLE_STATUSES: readonly string[] = ['sold', 'settled'];

// ── Anlegen ───────────────────────────────────────────────────────────────

/** Was die Anlegemaske („New Transfer") erfasst. */
export interface TransferCreateForm {
  customerId?: string;
  productId?: string;
  ourPrice?: number;
  returnBy?: string;
  notes?: string;
  staffId?: string;
  settlementModel?: string;
  excessSplitPct?: number;
}

export interface TransferCreateInput {
  customerId: string;
  productId: string;
  ourPrice: number;
  settlementModel: TransferSettlementModel;
  excessSplitPct?: number;
  returnBy?: string;
  notes?: string;
  staffId?: string;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Die Werte der Maske, geprüft und in die Form des Hauses gebracht.
 *
 * „Our Price" ist der Betrag, den das Haus bekommen will — größer als 0 (die Maske sperrt den Knopf
 * ohne ihn; ein negativer Betrag war dort eintippbar und ist kein Fachfall). Der Anteil am Überschuss
 * gilt nur beim Modell „split": die Maske begrenzt ihn auf 0–100 und nimmt ohne Eingabe 50.
 */
export function normalizeTransferCreate(form: TransferCreateForm): TransferCreateInput {
  const customerId = text(form.customerId);
  const productId = text(form.productId);
  if (!customerId || !productId) {
    throw new TransferActionRejected('REQUIRED_FIELDS_MISSING', 'a transfer needs a client and an item');
  }
  const price = form.ourPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new TransferActionRejected('INVALID_AMOUNT', 'our price must be a positive number');
  }
  const model = form.settlementModel ?? 'full';
  if (!(TRANSFER_SETTLEMENT_MODELS as readonly string[]).includes(model)) {
    throw new TransferActionRejected('INVALID_SETTLEMENT_MODEL', `unknown settlement model: ${model || '(none)'}`);
  }
  const out: TransferCreateInput = {
    customerId, productId, ourPrice: price, settlementModel: model as TransferSettlementModel,
    returnBy: text(form.returnBy), notes: text(form.notes), staffId: text(form.staffId),
  };
  if (model === 'split') {
    const pct = form.excessSplitPct ?? DEFAULT_AGENT_SPLIT_PCT;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new TransferActionRejected('INVALID_SPLIT_PCT', "the shop's share must be between 0 and 100 percent");
    }
    out.excessSplitPct = pct;
  }
  return out;
}

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export interface TransferHousePort {
  /** Ein Kunde der Kundenauswahl (ohne die Platzhalter `sys-…`). */
  customerExists(id: string): boolean;
  /** Der Bestandsstatus des Stücks — `undefined`, wenn es das Stück in dieser Filiale nicht gibt. */
  productStock(id: string): string | undefined;
  /** Ist das Stück schon auf Kommission draußen? */
  productOut(id: string): boolean;
  /** Ein Mitarbeiter der Auswahl (nicht ausgeschieden). */
  employeeExists(id: string): boolean;
}

/** Die Prüfungen gegen den Stand des Hauses — dieselben am Primary und fern. */
export function planTransferCreate(input: TransferCreateInput, port: TransferHousePort): TransferCreateInput {
  if (!port.customerExists(input.customerId)) {
    throw new TransferActionRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
  }
  const stock = port.productStock(input.productId);
  if (stock === undefined) throw new TransferActionRejected('PRODUCT_NOT_FOUND', 'no such product in this branch');
  // Die Artikelliste der Maske zeigt nur, was im Lager liegt. Ein Stück, das inzwischen verkauft,
  // in Reparatur oder schon draußen ist, geht nicht (noch einmal) hinaus.
  if (stock !== 'in_stock') {
    throw new TransferActionRejected('PRODUCT_NOT_AVAILABLE',
      `this item is not in stock (it is "${stock}") — it cannot go out on approval`);
  }
  if (port.productOut(input.productId)) {
    throw new TransferActionRejected('PRODUCT_ALREADY_OUT', 'this item is already out on approval');
  }
  if (input.staffId && !port.employeeExists(input.staffId)) {
    throw new TransferActionRejected('EMPLOYEE_NOT_FOUND', 'no such active employee in this branch');
  }
  return input;
}

/** Der Rumpf von `transfers.create`, wie ihn die Anlegemaske am zweiten Rechner baut. */
export function transferCreateBody(form: TransferCreateForm): Record<string, unknown> {
  const input = normalizeTransferCreate(form);
  const body: Record<string, unknown> = {
    customerId: input.customerId, productId: input.productId,
    agentPrice: input.ourPrice, settlementModel: input.settlementModel,
  };
  if (input.excessSplitPct !== undefined) body.excessSplitPct = input.excessSplitPct;
  if (input.returnBy) body.returnBy = input.returnBy;
  if (input.notes) body.notes = input.notes;
  if (input.staffId) body.staffId = input.staffId;
  return body;
}

// ── Umwandeln ─────────────────────────────────────────────────────────────

/** An wen die Rechnung geht: einen gewählten Kunden — oder einen neuen aus den Angaben des Agenten. */
export type TransferBillTo = { customerId: string } | { autoCustomer: true };

/** Die Wahl „BILL TO" der Masken: `null`, solange im Modus „existing" niemand gewählt ist. */
export function transferBillTo(mode: 'existing' | 'auto', customerId: string): TransferBillTo | null {
  if (mode === 'auto') return { autoCustomer: true };
  return customerId ? { customerId } : null;
}

type ConvertView = Pick<AgentTransfer, 'status'> & { invoiceId?: string | null; settlementAmount?: number | null };

/** Der Knopf „Create Invoice" einer Zeile. */
export function canConvertTransfer(t: ConvertView): boolean {
  return TRANSFER_CONVERTIBLE_STATUSES.includes(t.status) && !t.invoiceId;
}

/** Die Auswahl für die Sammelrechnung: nur verkaufte Transfers ohne Rechnung. */
export function canCombineTransfer(t: ConvertView): boolean {
  return t.status === 'sold' && !t.invoiceId;
}

/** Warum dieser Transfer (noch) keine Rechnung wird — `null`, wenn er es werden kann. */
export function transferConvertBlocker(t: ConvertView, combined = false): { code: string; message: string } | null {
  if (t.invoiceId) return { code: 'TRANSFER_ALREADY_INVOICED', message: 'this transfer already has an invoice' };
  if (!TRANSFER_CONVERTIBLE_STATUSES.includes(t.status)) {
    return { code: 'TRANSFER_NOT_SOLD', message: `this transfer is "${t.status}" — only a sold or settled one becomes an invoice` };
  }
  if (combined && !canCombineTransfer(t)) {
    return { code: 'TRANSFER_NOT_COMBINABLE', message: `this transfer is "${t.status}" — a combined invoice takes sold transfers only` };
  }
  if (!(Number(t.settlementAmount ?? 0) > 0)) {
    return { code: 'TRANSFER_NO_SETTLEMENT', message: 'there is nothing to invoice — the settlement amount is not set' };
  }
  return null;
}

/** Die Angaben des Agenten, aus denen „Auto-create from agent" den Kunden macht. */
export interface AgentContact {
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
}

/**
 * Der neue Kunde aus dem Agenten — genau so, wie ihn die Masken anlegten: der erste Teil des
 * Namens als Vorname, der Rest als Nachname, Firma und Kontakte übernommen, dazu der Vermerk.
 * Kein Abgleich mit vorhandenen Kunden: die Wahl „Auto-create" legt an.
 */
export function agentAutoCustomer(agent: AgentContact, combined: boolean): {
  firstName: string; lastName: string; company?: string; phone?: string; whatsapp?: string; email?: string; notes: string;
} {
  const name = agent.name || '';
  const parts = name.trim().split(/\s+/);
  const opt = (v: string | null | undefined): string | undefined => v ?? undefined;
  return {
    firstName: parts[0] || name || 'Agent',
    lastName: parts.slice(1).join(' ') || '',
    company: opt(agent.company), phone: opt(agent.phone), whatsapp: opt(agent.whatsapp), email: opt(agent.email),
    notes: `Auto-created from agent ${name} for ${combined ? 'combined invoice' : 'transfer settlements'}.`,
  };
}

const billToBody = (b: TransferBillTo): Record<string, unknown> =>
  ('autoCustomer' in b ? { autoCustomer: true } : { customerId: b.customerId });

/** Der Rumpf von `transfers.convert_to_invoice` — der Transfer mit seiner gesehenen Fassung. */
export function transferConvertBody(t: { id: string; revision?: number }, billTo: TransferBillTo): Record<string, unknown> {
  return { transferId: t.id, expectedRevision: t.revision, ...billToBody(billTo) };
}

/** Der Rumpf von `transfers.convert_many_to_invoice` — jeder Transfer mit SEINER Fassung, in der Reihenfolge der Auswahl. */
export function transferConvertManyBody(
  ts: ReadonlyArray<{ id: string; revision?: number }>, billTo: TransferBillTo,
): Record<string, unknown> {
  return { transfers: ts.map((t) => ({ id: t.id, expectedRevision: t.revision })), ...billToBody(billTo) };
}
