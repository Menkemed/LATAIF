// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — gemeinsamer Einkauf: die Regeln, ohne Datenbank.
//
// LATAIF kauft beim Lieferanten wie immer (Beleg, Lieferantenschuld, Lager, Wareneinsatz bleiben
// unverändert). Ein oder mehrere Partner aus dem Partner-Modul sind an einzelnen Einkaufszeilen
// beteiligt; LATAIF hält den Rest. Getrennt gespeichert:
//   - der Anteil (Eigentum = Gewinn/Verlust), in Basispunkten, Summe je Zeile genau 10000,
//   - der vereinbarte Kostenanteil in BHD (aus dem Zeilenbetrag; Rest-Fils bei LATAIF),
//   - die tatsächlichen Geldbewegungen zwischen Firma und Partner (Beitrag, Auszahlung) und der
//     Gewinnanteil eines abgerechneten Verkaufs.
//
// Offener Ausgleich je Partner und Zeile (positiv = LATAIF schuldet dem Partner, negativ = der
// Partner schuldet LATAIF):
//     Beiträge − Auszahlungen + Gewinnanteile (inkl. Nachabrechnungen) ± Verrechnungen
//     − Kostenanteil × (noch nicht abgerechnete Menge / Menge)
//     − Anteil an nachträglich aktivierten Kosten (Reparatur → Los-Einstand) der nicht abgerechneten Stücke
// Solange nichts verkauft ist, ist das „gezahlt minus vereinbart" (600 statt 500 → +100). Mit der
// Abrechnung eines Verkaufs fällt der Kostenanteil der verkauften Stücke weg — ihn deckt der Erlös —
// und der Gewinnanteil kommt hinzu (400 gezahlt, 150 Gewinn → 550 an den Partner, 750 bleiben).
//
// Der Gewinn eines Verkaufs ist die Regel des ERP für die Rechnungszeile: Netto (Zeilenbetrag minus
// VAT, bei MARGIN minus Margen-VAT) minus Wareneinsatz (Einstand des Loses × Menge) — genau die
// Beträge, die `postInvoiceIssued` als REVENUE und COGS bucht. Keine eigene Formel.
// ════════════════════════════════════════════════════════════════════════════

export class PartnerItemRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PartnerItemRejected';
    this.code = code;
  }
}
const nein = (code: string, message: string): PartnerItemRejected => new PartnerItemRejected(code, message);

export const PARTNER_SHARES_INVALID = 'PARTNER_SHARES_INVALID';
export const PARTNER_DUPLICATE = 'PARTNER_DUPLICATE';
export const PARTNER_NOT_ACTIVE = 'PARTNER_NOT_ACTIVE';
export const PARTNER_ITEM_NOT_FOUND = 'PARTNER_ITEM_NOT_FOUND';
export const PARTNER_ITEM_AMOUNT_INVALID = 'PARTNER_ITEM_AMOUNT_INVALID';
export const PARTNER_ITEM_METHOD_INVALID = 'PARTNER_ITEM_METHOD_INVALID';
export const PARTNER_ITEM_DATE_INVALID = 'PARTNER_ITEM_DATE_INVALID';
export const PARTNER_ITEM_KIND_INVALID = 'PARTNER_ITEM_KIND_INVALID';
export const PARTNER_ITEM_OVERFUNDED = 'PARTNER_ITEM_OVERFUNDED';
export const PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN = 'PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN';
export const PARTNER_ITEM_PURCHASE_CANCELLED = 'PARTNER_ITEM_PURCHASE_CANCELLED';
export const PARTNER_SALE_NOT_FOUND = 'PARTNER_SALE_NOT_FOUND';
export const PARTNER_SALE_NOT_PAID = 'PARTNER_SALE_NOT_PAID';
export const PARTNER_SALE_RETURN_PRESENT = 'PARTNER_SALE_RETURN_PRESENT';
export const PARTNER_SALE_ALREADY_SETTLED = 'PARTNER_SALE_ALREADY_SETTLED';
export const PARTNER_MOVEMENT_NOT_FOUND = 'PARTNER_MOVEMENT_NOT_FOUND';
export const PARTNER_MOVEMENT_CANCELLED = 'PARTNER_MOVEMENT_CANCELLED';
export const PARTNER_ITEM_PRIMARY_ONLY = 'PARTNER_ITEM_PRIMARY_ONLY';
export const PARTNER_SALE_PENDING = 'PARTNER_SALE_PENDING';
export const PARTNER_SALE_NEEDS_CORRECTION = 'PARTNER_SALE_NEEDS_CORRECTION';
export const PARTNER_ITEM_OFFSET_INVALID = 'PARTNER_ITEM_OFFSET_INVALID';
export const PARTNER_ITEM_JOINT_BLOCKED = 'PARTNER_ITEM_JOINT_BLOCKED';
export const PARTNER_SUPPLIER_REFUND_PENDING = 'PARTNER_SUPPLIER_REFUND_PENDING';
export const PARTNER_OWNERSHIP_BLOCKED = 'PARTNER_OWNERSHIP_BLOCKED';
export const PARTNER_OWNERSHIP_VALUE_MISMATCH = 'PARTNER_OWNERSHIP_VALUE_MISMATCH';
export const PARTNER_OWNERSHIP_UNCHANGED = 'PARTNER_OWNERSHIP_UNCHANGED';
export const PARTNER_SALE_OUTSIDE_PARTNERSHIP = 'PARTNER_SALE_OUTSIDE_PARTNERSHIP';

/** „Take over" / „Change partners": die Zeile und der Wert, den die Maske angezeigt hat. */
export interface OwnershipChangeInput {
  purchaseLineId: string;
  /** Der angezeigte aktuelle Lager-Einstand der betroffenen Stücke — muss dem des Hauses entsprechen. */
  expectedValue: number;
  /** Nur „Change partners": die neuen Partner und Anteile (LATAIF hält den Rest). */
  partnerShares?: PartnerShareInput[];
}

export function ownershipChangeInput(raw: Record<string, unknown>, withShares: boolean): OwnershipChangeInput {
  const v = raw.expectedValue;
  if (typeof v !== 'number' || !Number.isFinite(v) || F(v) < 0) {
    throw nein(PARTNER_ITEM_AMOUNT_INVALID, 'expectedValue must be the shown stock value');
  }
  const out: OwnershipChangeInput = { purchaseLineId: idOf(raw.purchaseLineId, 'purchaseLineId'), expectedValue: B(F(v)) };
  if (withShares) {
    if (!Array.isArray(raw.partnerShares)) throw nein(PARTNER_SHARES_INVALID, 'partnerShares must be a list');
    out.partnerShares = raw.partnerShares.map((s) => {
      const r = (s ?? {}) as Record<string, unknown>;
      return { partnerId: typeof r.partnerId === 'string' ? r.partnerId : '', sharePct: r.sharePct as number };
    });
  }
  return out;
}

/** BHD in Fils — verglichen wird immer ganzzahlig, wie überall im Haus. */
export const F = (v: unknown): number => Math.round((Number(v) || 0) * 1000);
export const B = (f: number): number => f / 1000;

export const FULL_BP = 10000;

/** Prozent (höchstens zwei Nachkommastellen) → Basispunkte. */
export function pctToBp(pct: unknown): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) throw nein(PARTNER_SHARES_INVALID, 'a share must be a number');
  const bp = Math.round(pct * 100);
  if (Math.abs(bp - pct * 100) > 1e-6) throw nein(PARTNER_SHARES_INVALID, `a share has at most two decimals (got ${pct})`);
  return bp;
}
export const bpToPct = (bp: number): number => bp / 100;

/** Was die Maske je Einkaufszeile schickt: die Partner und ihre Anteile. LATAIF hält den Rest. */
export interface PartnerShareInput {
  partnerId: string;
  sharePct: number;
}

export interface PlannedParticipant {
  party: 'HOUSE' | 'PARTNER';
  partnerId: string | null;
  shareBp: number;
  costShareF: number;
}

/**
 * Die Beteiligung einer Zeile: jeder Partner > 0 %, keiner doppelt, zusammen höchstens 100 %;
 * LATAIF bekommt den Rest (auch 0 %), damit die Summe immer genau 100 % ist. Der Kostenanteil folgt
 * dem Anteil; die Rundungs-Fils bleiben bei LATAIF, damit die Kostenanteile genau den Zeilenbetrag ergeben.
 */
export function planLineParticipation(partners: readonly PartnerShareInput[], lineTotalF: number): PlannedParticipant[] {
  if (!Array.isArray(partners) || partners.length === 0) {
    throw nein(PARTNER_SHARES_INVALID, 'a joint purchase line needs at least one partner');
  }
  if (!Number.isInteger(lineTotalF) || lineTotalF < 0) throw nein(PARTNER_SHARES_INVALID, 'the line amount is invalid');
  const seen = new Set<string>();
  const out: PlannedParticipant[] = [];
  let sumBp = 0;
  let sumCostF = 0;
  for (const p of partners) {
    const id = typeof p?.partnerId === 'string' ? p.partnerId.trim() : '';
    if (!id) throw nein(PARTNER_SHARES_INVALID, 'every share needs a partner');
    if (seen.has(id)) throw nein(PARTNER_DUPLICATE, 'the same partner appears twice on one line');
    seen.add(id);
    const bp = pctToBp(p.sharePct);
    if (bp <= 0 || bp > FULL_BP) throw nein(PARTNER_SHARES_INVALID, 'a partner share must be more than 0 % and at most 100 %');
    sumBp += bp;
    const costShareF = Math.round(lineTotalF * bp / FULL_BP);
    sumCostF += costShareF;
    out.push({ party: 'PARTNER', partnerId: id, shareBp: bp, costShareF });
  }
  if (sumBp > FULL_BP) {
    throw nein(PARTNER_SHARES_INVALID, `the shares add up to ${bpToPct(sumBp)} % — together they must be exactly 100 %`);
  }
  if (sumCostF > lineTotalF) {
    // Nur durch Aufrunden bei 100 % Partneranteil möglich: den letzten Partner um die Differenz kürzen.
    out[out.length - 1].costShareF -= sumCostF - lineTotalF;
    sumCostF = lineTotalF;
  }
  out.unshift({ party: 'HOUSE', partnerId: null, shareBp: FULL_BP - sumBp, costShareF: lineTotalF - sumCostF });
  return out;
}

/** Vorschlag der Maske: alle Beteiligten (LATAIF + Partner) zu gleichen Teilen; bei einem Partner 50/50. */
export function suggestedPartnerPcts(partnerCount: number): number[] {
  if (!Number.isInteger(partnerCount) || partnerCount < 1) return [];
  const each = Math.floor(FULL_BP / (partnerCount + 1));
  return Array.from({ length: partnerCount }, () => bpToPct(each));
}

/** Der Gewinn einer verkauften Rechnungszeile nach der Regel des ERP (REVENUE − COGS dieser Zeile). */
export function saleLineProfitF(line: { lineTotal: number; vatAmount: number; costSnapshot: number; quantity: number }): {
  netF: number; costF: number; profitF: number; qty: number;
} {
  const qty = Math.max(1, Number(line.quantity) || 1);
  const netF = F(line.lineTotal) - F(line.vatAmount);
  const costF = F((Number(line.costSnapshot) || 0) * qty);
  return { netF, costF, profitF: netF - costF, qty };
}

/** Der Anteil eines Beteiligten an einem Gewinn (oder Verlust), auf Fils gerundet. */
export function profitShareF(profitF: number, shareBp: number): number {
  return Math.round(profitF * shareBp / FULL_BP);
}

export interface PartnerLineState {
  costShareF: number;
  quantity: number;
  /** Menge, deren Verkauf für DIESEN Partner schon abgerechnet ist. */
  settledQty: number;
  contributedF: number;
  paidOutF: number;
  profitShareF: number;
  /** Verrechnungen mit anderen Artikeln desselben Partners (vorzeichenbehaftet). */
  offsetF?: number;
  /** Partneranteil an nachträglich aktivierten Kosten der noch nicht abgerechneten Stücke. */
  extraCostShareF?: number;
  /** Einkauf storniert: der Kostenanteil entfällt, nur Geld zurück. */
  purchaseCancelled?: boolean;
}

/** Der noch geschuldete Kostenanteil der nicht abgerechneten Stücke (inkl. nachträglicher Kosten). */
export function owedCostF(s: PartnerLineState): number {
  if (s.purchaseCancelled) return 0;
  const qty = Math.max(1, s.quantity || 1);
  const unsettled = Math.max(0, qty - Math.max(0, s.settledQty || 0));
  return Math.round(s.costShareF * unsettled / qty) + (s.extraCostShareF ?? 0);
}

/** Offener Ausgleich (positiv = LATAIF schuldet dem Partner). */
export function openBalanceF(s: PartnerLineState): number {
  return s.contributedF - s.paidOutF + s.profitShareF + (s.offsetF ?? 0) - owedCostF(s);
}

/** „Verrechnen": Guthaben eines Partners an einem Artikel gegen seine Schuld an einem anderen. */
export interface ItemOffsetInput {
  partnerId: string;
  /** Der Artikel, an dem LATAIF dem Partner schuldet (wird kleiner). */
  fromPurchaseLineId: string;
  /** Der Artikel, an dem der Partner LATAIF schuldet (wird kleiner). */
  toPurchaseLineId: string;
  amount: number;
  date: string;
  note?: string;
}

export function itemOffsetInput(raw: Record<string, unknown>): ItemOffsetInput {
  const amount = raw.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || F(amount) <= 0) {
    throw nein(PARTNER_ITEM_AMOUNT_INVALID, 'amount must be a positive amount (at least 0.001 BHD)');
  }
  const out: ItemOffsetInput = {
    partnerId: idOf(raw.partnerId, 'partnerId'),
    fromPurchaseLineId: idOf(raw.fromPurchaseLineId, 'fromPurchaseLineId'),
    toPurchaseLineId: idOf(raw.toPurchaseLineId, 'toPurchaseLineId'),
    amount: B(F(amount)),
    date: isoDay(raw.date, 'date'),
  };
  if (out.fromPurchaseLineId === out.toPurchaseLineId) throw nein(PARTNER_ITEM_OFFSET_INVALID, 'an offset needs two different items');
  if (raw.note !== undefined && raw.note !== null && raw.note !== '') {
    if (typeof raw.note !== 'string') throw nein(PARTNER_ITEM_AMOUNT_INVALID, 'note must be text');
    out.note = raw.note.slice(0, 500);
  }
  return out;
}

/** Eine Kennung aus einem Rumpf (Verkaufszeile, Buchung) — dieselbe Prüfung für Maske und Fernbefehl. */
export function requiredId(v: unknown, what: string): string {
  return idOf(v, what);
}

export const ITEM_MOVEMENT_KINDS = ['CONTRIBUTION', 'PAYOUT'] as const;
export type ItemMovementKind = typeof ITEM_MOVEMENT_KINDS[number];
export const ITEM_MOVEMENT_METHODS = ['cash', 'bank', 'benefit'] as const;
export type ItemMovementMethod = typeof ITEM_MOVEMENT_METHODS[number];

/** „Beitrag erfassen" / „Auszahlen": was die Maske und der Fernbefehl schicken dürfen. */
export interface ItemMovementInput {
  purchaseLineId: string;
  partnerId: string;
  kind: ItemMovementKind;
  amount: number;
  method: ItemMovementMethod;
  /** YYYY-MM-DD */
  date: string;
  note?: string;
}

function isoDay(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw nein(PARTNER_ITEM_DATE_INVALID, `${what} must be a date (YYYY-MM-DD)`);
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    throw nein(PARTNER_ITEM_DATE_INVALID, `${what} is not a calendar date: ${v}`);
  }
  return v;
}
function idOf(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw nein(PARTNER_ITEM_NOT_FOUND, `${what} is required`);
  return v.trim();
}

/** Dieselbe Prüfung für Maske, Rumpf und Hausfolge. */
export function itemMovementInput(raw: Record<string, unknown>): ItemMovementInput {
  const kind = raw.kind;
  if (!(ITEM_MOVEMENT_KINDS as readonly unknown[]).includes(kind)) throw nein(PARTNER_ITEM_KIND_INVALID, `unknown kind: ${String(kind)}`);
  const method = raw.method;
  if (!(ITEM_MOVEMENT_METHODS as readonly unknown[]).includes(method)) {
    throw nein(PARTNER_ITEM_METHOD_INVALID, `unknown payment method: ${String(method)}`);
  }
  const amount = raw.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || F(amount) <= 0) {
    throw nein(PARTNER_ITEM_AMOUNT_INVALID, 'amount must be a positive amount (at least 0.001 BHD)');
  }
  const out: ItemMovementInput = {
    purchaseLineId: idOf(raw.purchaseLineId, 'purchaseLineId'),
    partnerId: idOf(raw.partnerId, 'partnerId'),
    kind: kind as ItemMovementKind,
    amount: B(F(amount)),
    method: method as ItemMovementMethod,
    date: isoDay(raw.date, 'date'),
  };
  if (raw.note !== undefined && raw.note !== null && raw.note !== '') {
    if (typeof raw.note !== 'string') throw nein(PARTNER_ITEM_AMOUNT_INVALID, 'note must be text');
    out.note = raw.note.slice(0, 500);
  }
  return out;
}
