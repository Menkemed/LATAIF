// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — die Eingaberegeln des Angebots: EINE Prüfung für die Maske, den Fernrumpf
// und die Hausfolge (`offer-house.ts`).
//
// Rein — keine Datenbank. Die Maske fragt damit VOR dem Schicken, der Fernbefehl prüft damit den
// Rumpf, und die Hausfolge noch einmal (damit ein alter Store-Aufruf nicht an ihr vorbeikommt).
//
// Jede Regel stammt aus einem vorhandenen Vertrag:
//   • mindestens eine Position beim Anlegen — der Knopf „Create Offer" ist ohne Artikel gesperrt;
//   • jeder Artikel höchstens einmal — beide Auswahllisten blenden schon gewählte Artikel aus;
//   • ein Preis ist nie negativ — dieselbe Grenze wie die Rechnung, in die das Angebot mündet;
//   • „Valid Until" ist das Datumsfeld der Maske (YYYY-MM-DD), leer heißt „keines";
//   • die Übergänge sind genau die Knöpfe beider Seiten: Entwurf → gesendet, gesendet →
//     angenommen oder abgelehnt. Mehr bietet keine Oberfläche an.
// ════════════════════════════════════════════════════════════════════════════
import { TAX_SCHEMES, type TaxScheme } from '@/core/models/types';

/** Ein fachliches Nein der Angebotsfolge — eingefroren, wenn es aus einem Fernauftrag kommt. */
export class OfferRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OfferRejected';
    this.code = code;
  }
}

export const OFFER_PRIMARY_ONLY = 'OFFER_PRIMARY_ONLY';
export const OFFER_NO_SESSION = 'OFFER_NO_SESSION';
export const OFFER_ID_REQUIRED = 'OFFER_ID_REQUIRED';
export const OFFER_NOT_FOUND = 'OFFER_NOT_FOUND';
export const OFFER_NOT_EDITABLE = 'OFFER_NOT_EDITABLE';
export const OFFER_STATUS_INVALID = 'OFFER_STATUS_INVALID';
export const OFFER_INVALID_TRANSITION = 'OFFER_INVALID_TRANSITION';
export const OFFER_NOT_ACCEPTED = 'OFFER_NOT_ACCEPTED';
export const OFFER_ALREADY_INVOICED = 'OFFER_ALREADY_INVOICED';
export const OFFER_HAS_NO_LINES = 'OFFER_HAS_NO_LINES';
export const OFFER_LINES_REQUIRED = 'OFFER_LINES_REQUIRED';
export const OFFER_LINE_INVALID = 'OFFER_LINE_INVALID';
export const OFFER_LINE_NOT_FOUND = 'OFFER_LINE_NOT_FOUND';
export const OFFER_DUPLICATE_PRODUCT = 'OFFER_DUPLICATE_PRODUCT';
export const OFFER_PRICE_INVALID = 'OFFER_PRICE_INVALID';
export const OFFER_SCHEME_INVALID = 'OFFER_SCHEME_INVALID';
export const OFFER_DATE_INVALID = 'OFFER_DATE_INVALID';
export const OFFER_TEXT_INVALID = 'OFFER_TEXT_INVALID';
export const CUSTOMER_REQUIRED = 'CUSTOMER_REQUIRED';
export const CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND';
export const PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND';
export const EMPLOYEE_NOT_FOUND = 'EMPLOYEE_NOT_FOUND';
export const STOCK_UNAVAILABLE = 'STOCK_UNAVAILABLE';
export const WITH_AGENT_BLOCKED = 'WITH_AGENT_BLOCKED';
export const RECORD_CHANGED = 'RECORD_CHANGED';

// ── Die Werte ───────────────────────────────────────────────────────────────

/** Geld wird in Fils verglichen (×1000, gerundet) — wie überall im Haus. */
export const toFils = (v: number): number => Math.round(v * 1000);

function idOf(v: unknown, what: string, code = OFFER_ID_REQUIRED): string {
  if (typeof v !== 'string' || !v.trim()) throw new OfferRejected(code, `${what} is required`);
  return v.trim();
}

/** Ein Nettopreis: endlich, nie negativ, auf Fils gerundet. */
function priceOf(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new OfferRejected(OFFER_PRICE_INVALID, `${where}: the price must be a number of at least 0`);
  }
  return toFils(v) / 1000;
}

function schemeOf(v: unknown, where: string): TaxScheme | undefined {
  if (v === undefined || v === null) return undefined;
  if (!(TAX_SCHEMES as readonly unknown[]).includes(v)) {
    throw new OfferRejected(OFFER_SCHEME_INVALID, `${where}: unknown tax scheme ${String(v)}`);
  }
  return v as TaxScheme;
}

/** Ein Kalendertag, wie ihn das Datumsfeld liefert. `undefined` = nicht genannt, `null`/'' = keiner. */
function dateOrNull(v: unknown, what: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new OfferRejected(OFFER_DATE_INVALID, `${what} must be a date (YYYY-MM-DD)`);
  }
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    throw new OfferRejected(OFFER_DATE_INVALID, `${what} is not a calendar date: ${v}`);
  }
  return v;
}

/** Freitext wie getippt (die Maske trimmt nicht); leer heißt „keiner". */
function textOrNull(v: unknown, what: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new OfferRejected(OFFER_TEXT_INVALID, `${what} must be text`);
  return v.trim() === '' ? null : v;
}

function expectedRevisionOpt(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new OfferRejected(RECORD_CHANGED, 'expectedRevision must be the revision you saw');
  }
  return v;
}

// ── Die Positionen ──────────────────────────────────────────────────────────

/** Was ein Mensch je Position wählt: den Artikel und den Nettopreis. Alles andere rechnet das Haus. */
export interface OfferLineWish {
  productId: string;
  unitPrice: number;
  /** Nur wenn ausdrücklich gewählt — sonst das Schema des Artikels (bzw. der bestehenden Position). */
  taxScheme?: TaxScheme;
}

/** Eine Position im gewünschten Endstand: mit `id` die bestehende, ohne `id` eine neue. */
export interface OfferLineDraft extends OfferLineWish {
  id?: string;
}

function linesOf(raw: unknown, opts: { withIds: boolean; atLeastOne: boolean }): OfferLineDraft[] {
  if (!Array.isArray(raw)) throw new OfferRejected(OFFER_LINE_INVALID, 'lines must be a list');
  if (opts.atLeastOne && raw.length === 0) {
    throw new OfferRejected(OFFER_LINES_REQUIRED, 'an offer needs at least one article');
  }
  const seenProducts = new Set<string>();
  const seenIds = new Set<string>();
  return raw.map((l, i) => {
    const where = `line ${i + 1}`;
    if (typeof l !== 'object' || l === null || Array.isArray(l)) throw new OfferRejected(OFFER_LINE_INVALID, `${where} must be an object`);
    const r = l as Record<string, unknown>;
    const productId = idOf(r.productId, `${where}: productId`, OFFER_LINE_INVALID);
    if (seenProducts.has(productId)) {
      throw new OfferRejected(OFFER_DUPLICATE_PRODUCT, `${where}: this article is already on the offer`);
    }
    seenProducts.add(productId);
    const out: OfferLineDraft = { productId, unitPrice: priceOf(r.unitPrice, where) };
    const scheme = schemeOf(r.taxScheme, where);
    if (scheme !== undefined) out.taxScheme = scheme;
    if (opts.withIds && r.id !== undefined && r.id !== null) {
      const id = idOf(r.id, `${where}: id`, OFFER_LINE_INVALID);
      if (seenIds.has(id)) throw new OfferRejected(OFFER_LINE_INVALID, `${where}: the same line twice`);
      seenIds.add(id);
      out.id = id;
    }
    return out;
  });
}

// ── offers.create ───────────────────────────────────────────────────────────

export interface OfferCreateInput {
  customerId: string;
  lines: OfferLineWish[];
  notes?: string;
  /** YYYY-MM-DD */
  validUntil?: string;
}

export function offerCreateInput(raw: Record<string, unknown>): OfferCreateInput {
  const customerId = raw.customerId;
  if (typeof customerId !== 'string' || !customerId.trim()) {
    throw new OfferRejected(CUSTOMER_REQUIRED, 'Please select a client.');
  }
  const out: OfferCreateInput = {
    customerId: customerId.trim(),
    lines: linesOf(raw.lines, { withIds: false, atLeastOne: true }),
  };
  const notes = textOrNull(raw.notes, 'notes');
  if (notes) out.notes = notes;
  const validUntil = dateOrNull(raw.validUntil, 'valid until');
  if (validUntil) out.validUntil = validUntil;
  return out;
}

// ── offers.update ───────────────────────────────────────────────────────────

/**
 * EIN Speichern des Entwurfs: Kopf und der VOLLSTÄNDIGE gewünschte Positionsstand. Was hinzukommt,
 * sich ändert oder wegfällt, leitet das Haus aus den Kennungen ab.
 */
export interface OfferUpdateInput {
  offerId: string;
  /** Die Fassung, die die Maske gesehen hat. Fern Pflicht; am Primary schickt die Maske sie mit. */
  expectedRevision?: number;
  /** `null` löscht */
  notes?: string | null;
  /** YYYY-MM-DD; `null` löscht */
  validUntil?: string | null;
  customerId?: string;
  lines: OfferLineDraft[];
}

export function offerUpdateInput(raw: Record<string, unknown>): OfferUpdateInput {
  const out: OfferUpdateInput = {
    offerId: idOf(raw.offerId, 'offerId'),
    // Ein Entwurf ohne Positionen gibt es heute (jede Zeile einzeln entfernt) — also auch hier.
    lines: linesOf(raw.lines, { withIds: true, atLeastOne: false }),
  };
  const rev = expectedRevisionOpt(raw.expectedRevision);
  if (rev !== undefined) out.expectedRevision = rev;
  const notes = textOrNull(raw.notes, 'notes');
  if (notes !== undefined) out.notes = notes;
  const validUntil = dateOrNull(raw.validUntil, 'valid until');
  if (validUntil !== undefined) out.validUntil = validUntil;
  if (raw.customerId !== undefined) out.customerId = idOf(raw.customerId, 'customerId', CUSTOMER_REQUIRED);
  return out;
}

/** Bearbeitbar ist nur der Entwurf — dieselbe Regel wie der Edit-Knopf (`canEdit`). */
export function isOfferEditable(status: string | undefined | null): boolean {
  return (status || 'draft') === 'draft';
}

// ── offers.set_status ───────────────────────────────────────────────────────

export type OfferTargetStatus = 'sent' | 'accepted' | 'rejected';
export type OfferSentVia = 'email' | 'whatsapp' | 'in_person';

const TARGETS: Record<OfferTargetStatus, true> = { sent: true, accepted: true, rejected: true };
const SENT_VIA: Record<OfferSentVia, true> = { email: true, whatsapp: true, in_person: true };

/** Genau die Knöpfe von Liste und Detail: „Send" am Entwurf, „Accept"/„Reject" am gesendeten Angebot. */
export const OFFER_TRANSITIONS: Readonly<Record<string, readonly OfferTargetStatus[]>> = {
  draft: ['sent'],
  sent: ['accepted', 'rejected'],
};

export function offerTransitionAllowed(from: string | undefined | null, to: OfferTargetStatus): boolean {
  return (OFFER_TRANSITIONS[from || 'draft'] ?? []).includes(to);
}

export interface OfferStatusInput {
  offerId: string;
  expectedRevision?: number;
  status: OfferTargetStatus;
  sentVia?: OfferSentVia;
}

export function offerStatusInput(raw: Record<string, unknown>): OfferStatusInput {
  const status = raw.status;
  if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(TARGETS, status)) {
    throw new OfferRejected(OFFER_STATUS_INVALID, 'status must be one of sent, accepted, rejected');
  }
  const out: OfferStatusInput = { offerId: idOf(raw.offerId, 'offerId'), status: status as OfferTargetStatus };
  const rev = expectedRevisionOpt(raw.expectedRevision);
  if (rev !== undefined) out.expectedRevision = rev;
  if (raw.sentVia !== undefined && raw.sentVia !== null) {
    if (out.status !== 'sent') throw new OfferRejected(OFFER_STATUS_INVALID, 'sentVia belongs to sending an offer');
    if (typeof raw.sentVia !== 'string' || !Object.prototype.hasOwnProperty.call(SENT_VIA, raw.sentVia)) {
      throw new OfferRejected(OFFER_STATUS_INVALID, 'sentVia must be one of email, whatsapp, in_person');
    }
    out.sentVia = raw.sentVia as OfferSentVia;
  }
  return out;
}

// ── offers.convert_to_invoice ───────────────────────────────────────────────

export interface OfferConvertInput {
  offerId: string;
  expectedRevision?: number;
  /** Die Wahl des Schema-Dialogs je Angebotsposition (`ConfirmTaxSchemeModal`). */
  perLineSchemes?: Record<string, TaxScheme>;
  staffId?: string;
  /** Die Wahl des Nummern-Dialogs (`NumberTypeDialog`). */
  specialMark?: boolean;
}

export function offerConvertInput(raw: Record<string, unknown>): OfferConvertInput {
  const out: OfferConvertInput = { offerId: idOf(raw.offerId, 'offerId') };
  const rev = expectedRevisionOpt(raw.expectedRevision);
  if (rev !== undefined) out.expectedRevision = rev;
  if (raw.perLineSchemes !== undefined && raw.perLineSchemes !== null) {
    const p = raw.perLineSchemes;
    if (typeof p !== 'object' || Array.isArray(p)) throw new OfferRejected(OFFER_SCHEME_INVALID, 'perLineSchemes must be an object');
    const schemes: Record<string, TaxScheme> = {};
    for (const [lineId, scheme] of Object.entries(p as Record<string, unknown>)) {
      if (!lineId.trim()) throw new OfferRejected(OFFER_LINE_INVALID, 'perLineSchemes: empty line id');
      schemes[lineId] = schemeOf(scheme, `line ${lineId}`) as TaxScheme;
      if (!schemes[lineId]) throw new OfferRejected(OFFER_SCHEME_INVALID, `line ${lineId}: a tax scheme is required`);
    }
    out.perLineSchemes = schemes;
  }
  if (raw.staffId !== undefined && raw.staffId !== null && raw.staffId !== '') out.staffId = idOf(raw.staffId, 'staffId');
  if (raw.specialMark !== undefined) {
    if (typeof raw.specialMark !== 'boolean') throw new OfferRejected(OFFER_LINE_INVALID, 'specialMark must be true or false');
    out.specialMark = raw.specialMark;
  }
  return out;
}
