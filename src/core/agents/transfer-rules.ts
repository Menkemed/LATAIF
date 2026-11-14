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
import { businessDateIssue } from '@/core/utils/business-date';

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

/**
 * R5D.1 — das Stück, das auf Kommission hinausgehen darf: es liegt im Lager. Genau das zeigte die
 * Artikelliste der Anlegemaske schon immer (und nur das); der Fernbefehl prüfte es seit C3F.
 */
export const TRANSFERABLE_STOCK_STATUS = 'in_stock';
export const isTransferableStock = (stockStatus: string | null | undefined): boolean =>
  stockStatus === TRANSFERABLE_STOCK_STATUS;

/**
 * R5D.1 — der Anteil des Hauses am Überschuss („split"): die Maske begrenzte ihn schon immer auf
 * 0–100 und nahm ohne Eingabe 50. Beide Ränder sind Fachfälle (`computeAgentTransferSale`): 0 % —
 * der Kunde behält den ganzen Überschuss, 100 % — das Haus. Nicht die Regel der Kommission.
 */
export const TRANSFER_SPLIT_PCT_MIN = 0;
export const TRANSFER_SPLIT_PCT_MAX = 100;
/** Die Eingabe der Maske, wie sie sie immer begrenzt hat: keine Zahl → 0, darüber hinaus der Rand. */
export function clampTransferSplitPct(raw: string): number {
  return Math.max(TRANSFER_SPLIT_PCT_MIN, Math.min(TRANSFER_SPLIT_PCT_MAX, Number(raw) || 0));
}

/**
 * R5D.1 — „Our Price" ist größer als 0, beim Anlegen wie beim Ändern. Die Anlegemaske sperrte 0
 * und ein leeres Feld schon immer; der Fernbefehl verlangte > 0 seit C3F (anlegen UND ändern). Nur
 * ein eingetipptes Minus ging an der Maske durch — und damit rechnet das Haus falsch: beim Modell
 * „split" ist Our Price der Boden, ein Boden ≤ 0 macht den Abrechnungsbetrag ≤ 0, und daraus wird
 * keine Rechnung (TRANSFER_NO_SETTLEMENT).
 */
function ourPriceOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new TransferActionRejected('INVALID_AMOUNT', 'our price must be a positive number');
  }
  return v;
}

// ── Anlegen ───────────────────────────────────────────────────────────────

/** Was die Anlegemaske („New Transfer") erfasst. */
export interface TransferCreateForm {
  customerId?: string;
  productId?: string;
  ourPrice?: number;
  returnBy?: string;
  /** BUSINESS-DATE — der Tag der Übergabe (JJJJ-MM-TT), in der Maske wählbar; ohne Angabe heute. */
  transferredAt?: string;
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
  transferredAt?: string;
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
  const price = ourPriceOf(form.ourPrice);
  const model = form.settlementModel ?? 'full';
  if (!(TRANSFER_SETTLEMENT_MODELS as readonly string[]).includes(model)) {
    throw new TransferActionRejected('INVALID_SETTLEMENT_MODEL', `unknown settlement model: ${model || '(none)'}`);
  }
  const transferredAt = text(form.transferredAt);
  const datum = businessDateIssue(transferredAt, 'Transfer date');
  if (datum) throw new TransferActionRejected('INVALID_DATE', datum);
  const out: TransferCreateInput = {
    customerId, productId, ourPrice: price, settlementModel: model as TransferSettlementModel,
    returnBy: text(form.returnBy), transferredAt, notes: text(form.notes), staffId: text(form.staffId),
  };
  if (model === 'split') {
    const pct = form.excessSplitPct ?? DEFAULT_AGENT_SPLIT_PCT;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < TRANSFER_SPLIT_PCT_MIN || pct > TRANSFER_SPLIT_PCT_MAX) {
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
  /** CONSIGNMENT-AGENT — gehört das Stück zu einer nicht abgeschlossenen Kommission (aus der Relation)? */
  consignmentOwned(id: string): boolean;
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
  // CONSIGNMENT-AGENT — Kommissionsware geht nicht an einen Agenten: sein Verkauf kennt den Kommissionsvertrag nicht
  // (Einkauf beim Einlieferer, Provision, Rückweg). Geprüft über die Kommission, VOR dem Bestandsstatus — ein von Hand
  // auf „in stock" gesetzter Status umgeht die Regel nicht.
  if (port.consignmentOwned(input.productId)) {
    throw new TransferActionRejected('CONSIGNMENT_NOT_TRANSFERABLE',
      'this item is consignment stock — it does not go out to an agent (sell it with "Record Sale" on its consignment)');
  }
  // Die Artikelliste der Maske zeigt nur, was im Lager liegt. Ein Stück, das inzwischen verkauft,
  // in Reparatur oder schon draußen ist, geht nicht (noch einmal) hinaus.
  if (!isTransferableStock(stock)) {
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
  if (input.transferredAt) body.transferredAt = input.transferredAt;
  if (input.notes) body.notes = input.notes;
  if (input.staffId) body.staffId = input.staffId;
  return body;
}

// ── Anlegen: mehrere Stücke in EINEM Vorgang (Owner 14.11.2026) ──────────────────────────────────
//
// „New Transfer" mit Mehrfachauswahl: EIN Kunde, gemeinsame Angaben (Übergabe- und Rückgabedatum, Mitarbeiter, Notiz,
// Abrechnungsmodell mit Anteil) — dazu je Stück der eigene „Our Price" und, wenn gewollt, ein eigenes Modell bzw. ein eigener
// Anteil. Jedes Stück bleibt EIN Transfer (eigene Nummer, eigener Preis, eigener Status); jedes geht durch DIESELBE Regel wie
// der Einzeltransfer (`normalizeTransferCreate`, im Haus `planTransferCreate`). Abrechnung unverändert (Full / Split).

/** Höchstens so viele Stücke in einem Vorgang. */
export const TRANSFER_BATCH_MAX = 50;

/** Ein Stück der Mehrfachauswahl: Preis, und — nur wenn abweichend — eigenes Modell / eigener Anteil. */
export interface TransferBatchItem {
  productId?: string;
  ourPrice?: number;
  /** Leer = das gemeinsame Modell. */
  settlementModel?: string;
  /** Leer = der gemeinsame Anteil (bei „split"), sonst 50. */
  excessSplitPct?: number;
}

/** Was die Maske mit Mehrfachauswahl erfasst. */
export interface TransferBatchForm extends Omit<TransferCreateForm, 'productId' | 'ourPrice'> {
  items?: TransferBatchItem[];
}

/** Das wirksame Modell und der wirksame Anteil eines Stücks: seine Angabe, sonst die gemeinsame. */
export function transferBatchItemTerms(form: Pick<TransferBatchForm, 'settlementModel' | 'excessSplitPct'>, item: TransferBatchItem): {
  settlementModel: string; excessSplitPct?: number;
} {
  const model = item.settlementModel ?? form.settlementModel ?? 'full';
  if (model !== 'split') return { settlementModel: model };
  const pct = item.excessSplitPct ?? ((form.settlementModel ?? 'full') === 'split' ? form.excessSplitPct : undefined);
  return { settlementModel: model, ...(pct !== undefined ? { excessSplitPct: pct } : {}) };
}

/**
 * Die Mehrfachauswahl geprüft und in die Form des Hauses gebracht — je Stück GENAU der Einzeltransfer
 * (`normalizeTransferCreate`). Vorher: mindestens eins, höchstens `TRANSFER_BATCH_MAX`, kein Stück doppelt. Ein Nein nennt
 * die Stelle („item 3: …"), damit die Maske es zuordnen kann.
 */
export function normalizeTransferBatch(form: TransferBatchForm): TransferCreateInput[] {
  const items = Array.isArray(form.items) ? form.items : [];
  if (items.length === 0) throw new TransferActionRejected('NO_ITEMS_SELECTED', 'choose at least one item');
  if (items.length > TRANSFER_BATCH_MAX) {
    throw new TransferActionRejected('TOO_MANY_ITEMS', `at most ${TRANSFER_BATCH_MAX} items in one transfer`);
  }
  const gesehen = new Set<string>();
  return items.map((item, i) => {
    const pid = text(item.productId);
    if (pid && gesehen.has(pid)) throw new TransferActionRejected('ITEM_LISTED_TWICE', `item ${i + 1}: this item is listed twice`);
    if (pid) gesehen.add(pid);
    try {
      return normalizeTransferCreate({
        customerId: form.customerId, productId: item.productId, ourPrice: item.ourPrice,
        ...transferBatchItemTerms(form, item),
        returnBy: form.returnBy, transferredAt: form.transferredAt, notes: form.notes, staffId: form.staffId,
      });
    } catch (e) {
      if (e instanceof TransferActionRejected) throw new TransferActionRejected(e.code, `item ${i + 1}: ${e.message}`);
      throw e;
    }
  });
}

/**
 * Der Rumpf von `transfers.create` mit Artikelliste, wie ihn die Maske am zweiten Rechner baut: je Stück Preis, Modell und
 * Anteil schon AUFGELÖST (keine Vererbung auf dem Draht) — der Primary prüft jedes Stück mit derselben Regel.
 */
export function transferBatchBody(form: TransferBatchForm): Record<string, unknown> {
  const inputs = normalizeTransferBatch(form);
  const erstes = inputs[0];
  const body: Record<string, unknown> = {
    customerId: erstes.customerId,
    items: inputs.map((x) => ({
      productId: x.productId, agentPrice: x.ourPrice, settlementModel: x.settlementModel,
      ...(x.excessSplitPct !== undefined ? { excessSplitPct: x.excessSplitPct } : {}),
    })),
  };
  if (erstes.returnBy) body.returnBy = erstes.returnBy;
  if (erstes.transferredAt) body.transferredAt = erstes.transferredAt;
  if (erstes.notes) body.notes = erstes.notes;
  if (erstes.staffId) body.staffId = erstes.staffId;
  return body;
}

// ── Ändern ────────────────────────────────────────────────────────────────

/**
 * Was „Save" der Änderungsmaske schreibt. R5D.1: Preis, Rückgabedatum, Notiz. Owner 14.11.2026 — dazu Abrechnungsmodell und
 * Anteil, Mitarbeiter, Übergabedatum und Kunde (jeweils nur, was die Maske wirklich ändert), und die Bestätigung, wenn ein
 * schon gebuchter Verkauf danach unter dem neuen „Our Price" liegt.
 */
export interface TransferEditPatch {
  agentPrice?: number;
  returnBy?: string | null;
  notes?: string | null;
  settlementModel?: TransferSettlementModel;
  /** Nur bei „split" ein Wert; beim Wechsel auf „full" `null`. */
  excessSplitPct?: number | null;
  staffId?: string | null;
  /** JJJJ-MM-TT. */
  transferredAt?: string;
  customerId?: string;
  acknowledgeBelowPrice?: boolean;
}

export interface TransferEditForm {
  agentPrice?: number; returnBy?: string | null; notes?: string | null;
  settlementModel?: string; excessSplitPct?: number | null; staffId?: string | null;
  transferredAt?: string; customerId?: string; acknowledgeBelowPrice?: boolean;
}

/**
 * R5D.1 — der EINE Schreibsatz der Änderungsmaske (Liste und Detailseite), am Primary wie fern:
 * Preis (> 0), Rückgabedatum (ein geleertes Feld heißt „keins"), Notiz. Vorher schrieb der Primary
 * den ganzen geladenen Transfer zurück — Status und Abrechnung inklusive, auch wenn sie inzwischen
 * ein anderer Vorgang verändert hatte. Owner 14.11.2026 — dieselben Regeln wie beim Anlegen für Modell, Anteil (0–100,
 * „split" ohne Angabe 50), Übergabetag (kein künftiger) und Kunde.
 */
export function transferEditPatch(form: TransferEditForm): TransferEditPatch {
  const out: TransferEditPatch = {};
  if (form.agentPrice !== undefined) out.agentPrice = ourPriceOf(form.agentPrice);
  if (form.returnBy !== undefined) out.returnBy = form.returnBy ? form.returnBy : null;
  if (form.notes !== undefined) out.notes = form.notes;
  const pctOf = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < TRANSFER_SPLIT_PCT_MIN || v > TRANSFER_SPLIT_PCT_MAX) {
      throw new TransferActionRejected('INVALID_SPLIT_PCT', "the shop's share must be between 0 and 100 percent");
    }
    return v;
  };
  if (form.settlementModel !== undefined) {
    if (!(TRANSFER_SETTLEMENT_MODELS as readonly string[]).includes(form.settlementModel)) {
      throw new TransferActionRejected('INVALID_SETTLEMENT_MODEL', `unknown settlement model: ${form.settlementModel || '(none)'}`);
    }
    out.settlementModel = form.settlementModel as TransferSettlementModel;
    out.excessSplitPct = out.settlementModel === 'split' ? pctOf(form.excessSplitPct ?? DEFAULT_AGENT_SPLIT_PCT) : null;
  } else if (form.excessSplitPct !== undefined && form.excessSplitPct !== null) {
    out.excessSplitPct = pctOf(form.excessSplitPct);
  }
  if (form.staffId !== undefined) out.staffId = text(form.staffId) ?? null;
  if (form.transferredAt !== undefined) {
    const tag = text(form.transferredAt);
    const issue = tag ? businessDateIssue(tag, 'Transfer date') : 'Transfer date is required';
    if (issue) throw new TransferActionRejected('INVALID_DATE', issue);
    out.transferredAt = tag;
  }
  if (form.customerId !== undefined) {
    const kunde = text(form.customerId);
    if (!kunde) throw new TransferActionRejected('REQUIRED_FIELDS_MISSING', 'a transfer needs a client');
    out.customerId = kunde;
  }
  if (form.acknowledgeBelowPrice === true) out.acknowledgeBelowPrice = true;
  return out;
}

/** Ändert der Patch Geld (Preis, Modell, Anteil) oder den Kunden der Forderung? */
export function transferEditTouchesMoney(p: TransferEditPatch): boolean {
  return p.agentPrice !== undefined || p.settlementModel !== undefined || p.excessSplitPct !== undefined || p.customerId !== undefined;
}

/** Der Stand eines Transfers, gegen den „Edit" und „Remove" geprüft werden. */
export interface TransferCorrectionState {
  status: string;
  invoiceId?: string | null;
  /** Abrechnungszahlungen erfasst (Betrag oder Zeilen). */
  hasPayments: boolean;
  /** Eine lebende Verkaufsbuchung (AGENT_TRANSFER_SOLD). */
  hasSalePosting?: boolean;
}

/**
 * Owner 14.11.2026 — warum DIESE Änderung nicht geht (oder null). Preis, Modell und Anteil auch nach dem Verkauf — solange
 * keine Rechnung und keine Abrechnungszahlung daran hängt (dann sind sie verbindlich). Der Kunde nur, solange das Stück noch
 * draußen ist (danach steht die Forderung auf ihm). Notiz, Rückgabedatum und Mitarbeiter gehen immer.
 */
export function transferEditBlocker(s: TransferCorrectionState, p: TransferEditPatch): { code: string; message: string } | null {
  const geld = p.agentPrice !== undefined || p.settlementModel !== undefined || p.excessSplitPct !== undefined;
  if (s.invoiceId && (geld || p.customerId !== undefined || p.transferredAt !== undefined)) {
    return { code: 'TRANSFER_INVOICED', message: 'this transfer is on an invoice — price, settlement model, client and date are fixed there. '
      + 'Undo the conversion first (only while the invoice is unpaid), or correct the invoice itself.' };
  }
  if (s.hasPayments && (geld || p.customerId !== undefined)) {
    return { code: 'TRANSFER_SETTLEMENT_RECORDED', message: 'settlement payments are recorded on this transfer — price, settlement model and client '
      + 'no longer change. Convert it to an invoice and correct it there (credit note / return).' };
  }
  if (geld && s.status !== 'transferred' && s.status !== 'sold') {
    return { code: 'TRANSFER_NOT_OPEN', message: `this transfer is "${s.status}" — its price and settlement model no longer change` };
  }
  if (p.customerId !== undefined && s.status !== 'transferred') {
    return { code: 'TRANSFER_CLIENT_FIXED', message: 'after the sale the client is fixed — the receivable is booked to them. '
      + 'Remove this transfer (the sale is cancelled) and create a new one for the right client.' };
  }
  if (p.transferredAt !== undefined && s.status === 'cancelled') {
    return { code: 'TRANSFER_NOT_OPEN', message: 'this transfer is cancelled — its date no longer changes' };
  }
  return null;
}

/**
 * Owner 14.11.2026 — „Remove" eines Transfers: was geschieht — oder warum nicht (mit dem passenden Korrekturweg).
 *   • nichts gebucht (draußen oder zurück, keine Verkaufsbuchung): LÖSCHEN — das Stück wieder im Lager, die Nummer bleibt
 *     verbraucht, das Protokoll hält den Vorgang fest;
 *   • verkauft (Verkaufsbuchung, ohne Zahlung, ohne Rechnung): STORNO — Gegenbuchung am Tag des Verkaufs, das Stück wieder
 *     im Lager, der Transfer bleibt als „cancelled" stehen;
 *   • Rechnung oder Abrechnungszahlungen: Nein — dort wird korrigiert.
 */
export function transferRemovePlan(s: TransferCorrectionState): { kind: 'delete' | 'cancel' } | { code: string; message: string } {
  if (s.status === 'cancelled') return { code: 'TRANSFER_ALREADY_CANCELLED', message: 'this transfer is already cancelled' };
  if (s.invoiceId) {
    return { code: 'TRANSFER_INVOICED', message: 'this transfer is on an invoice — undo the conversion first (only while the invoice is unpaid); '
      + 'if the invoice is paid, correct it there with a return / credit note.' };
  }
  if (s.hasPayments) {
    return { code: 'TRANSFER_SETTLEMENT_RECORDED', message: 'settlement payments are recorded on this transfer — removing it would take back money '
      + 'that was received. Convert it to an invoice and record a return / credit note there.' };
  }
  if (s.status === 'sold' || s.status === 'settled' || s.hasSalePosting) return { kind: 'cancel' };
  return { kind: 'delete' };
}

/** Der Grund einer Korrektur: Pflicht, kurz. */
export function transferCorrectionReason(v: unknown): string {
  const r = typeof v === 'string' ? v.trim() : '';
  if (r.length < 3) throw new TransferActionRejected('REASON_REQUIRED', 'give a short reason');
  if (r.length > 200) throw new TransferActionRejected('REASON_TOO_LONG', 'keep the reason short (at most 200 characters)');
  return r;
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
