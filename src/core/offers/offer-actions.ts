// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — die gemeinsame Speicherfolge der Angebotsseiten (Liste und Detail).
//
// Jede Maske ruft EINE Funktion dieser Datei. Sie kennt zwei Anschlüsse und keine eigene Regel:
//
//   • am Primary die Hausfolge (`offer-house.ts`) — exklusiv, in EINER Transaktion, erst danach
//     durabel (`…OnPrimary` = `runOnPrimary`). Vorher schrieb die Seite jede Zeilenänderung einzeln
//     und synchron an der Schreibreihenfolge vorbei, den Preis sogar bei jedem Tastendruck;
//   • auf dem Rechner ohne Datenbank der geprüfte Fernbefehl (`offers.create`, …).
//
// Geprüft wird VOR dem Schicken mit derselben Eingaberegel, die der Primary anwendet — ein
// unbrauchbarer Rumpf verlässt den Rechner nicht, und beide Rechner sagen dasselbe. Nach einem
// Erfolg auf PC2 holen die Stores ihren Stand frisch vom Primary.
// ════════════════════════════════════════════════════════════════════════════
import { runOnPrimary } from '@/core/data/primary-action';
import type { WriteAdapters, WriteOutcome } from '@/core/data/shared-write';
import { useOfferStore } from '@/stores/offerStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import type { Offer, TaxScheme } from '@/core/models/types';
import {
  convertOfferToInvoiceInHouse, createOfferInHouse, localOfferCtx, setOfferStatusInHouse, updateOfferInHouse,
} from './offer-house';
import {
  offerConvertInput, offerCreateInput, offerStatusInput, offerUpdateInput, toFils,
  type OfferConvertInput, type OfferCreateInput, type OfferStatusInput, type OfferTargetStatus, type OfferUpdateInput,
} from './offer-rules';

// Die Namen der geprüften Fernbefehle (`bridge/offer-commands.ts`). Hier als Wert, nicht als Import:
// die Oberfläche lädt die Befehlsdatei nicht (sie meldet beim Laden ihre Handler an).
const OP_OFFERS_CREATE = 'offers.create';
const OP_OFFERS_UPDATE = 'offers.update';
const OP_OFFERS_SET_STATUS = 'offers.set_status';
const OP_OFFERS_CONVERT_TO_INVOICE = 'offers.convert_to_invoice';

/** Was eine Seite von ihrer Schreibweiche braucht — `useSharedWrites()` passt. */
export interface OfferWrite {
  readonly remote: boolean;
  save: <T>(op: string, adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
}

function absage<T>(e: unknown): WriteOutcome<T> {
  const code = (e as { code?: unknown })?.code;
  return {
    kind: 'business_error',
    code: typeof code === 'string' && code ? code : 'LOCAL_WRITE_REJECTED',
    message: e instanceof Error ? e.message : String(e),
  };
}

/** Der Rumpf: nur, was gesetzt ist. `null` reist mit — es heißt „löschen". */
function rumpf(input: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  return out;
}

/** Ein Preis aus dem Eingabefeld; leer oder unlesbar bleibt NaN — die Eingaberegel sagt dann nein. */
export function priceFromField(v: string | number): number {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').trim();
  return t === '' ? Number.NaN : Number(t);
}

// ── Die Listen danach ───────────────────────────────────────────────────────

/** Angebote und Artikel („offered" / zurück auf Lager) — auch nach einem Rollback. */
const angeboteNeu = () => {
  useOfferStore.getState().loadOffers();
  useProductStore.getState().loadProducts();
};
const rechnungNeu = () => {
  angeboteNeu();
  useInvoiceStore.getState().loadInvoices();
};

// ── Am Primary: die Hausfolge in der Schreibreihenfolge ─────────────────────

export function createOfferOnPrimary(input: OfferCreateInput) {
  return runOnPrimary(() => createOfferInHouse(input, localOfferCtx()), angeboteNeu);
}
export function updateOfferOnPrimary(input: OfferUpdateInput) {
  return runOnPrimary(() => updateOfferInHouse(input, localOfferCtx()), angeboteNeu);
}
export function setOfferStatusOnPrimary(input: OfferStatusInput) {
  return runOnPrimary(() => setOfferStatusInHouse(input, localOfferCtx()), angeboteNeu);
}
export function convertOfferOnPrimary(input: OfferConvertInput) {
  return runOnPrimary(() => convertOfferToInvoiceInHouse(input, localOfferCtx()), rechnungNeu);
}

// ── Die Masken ──────────────────────────────────────────────────────────────

/** „Create Offer" (Liste). Einstand, Schema, Summen und Nummer bestimmt der Primary. */
export async function saveOfferCreate(
  w: OfferWrite,
  form: { customerId: string; lines: Array<{ productId: string; unitPrice: number | string }>; notes?: string; validUntil?: string },
): Promise<WriteOutcome<{ offerId: string; offerNumber: string }>> {
  let input: OfferCreateInput;
  try {
    input = offerCreateInput({
      customerId: form.customerId,
      lines: form.lines.map((l) => ({ productId: l.productId, unitPrice: priceFromField(l.unitPrice) })),
      notes: form.notes,
      validUntil: form.validUntil,
    });
  } catch (e) { return absage(e); }
  const r = await w.save<{ offerId: string; offerNumber: string }>(OP_OFFERS_CREATE, {
    local: async () => {
      const c = await createOfferOnPrimary(input);
      return { offerId: c.offerId, offerNumber: c.offerNumber };
    },
    remote: () => rumpf(input),
    shape: (v) => ({ offerId: String(v.offerId ?? ''), offerNumber: String(v.offerNumber ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) angeboteNeu();
  return r;
}

/** Der Entwurf der Detailseite im Bearbeiten — nur im Fenster, bis „Save". */
export interface OfferDraftLine { id?: string; productId: string; price: string | number }
export interface OfferDraft { customerId: string; notes: string; validUntil: string; lines: OfferDraftLine[] }

export function draftOf(offer: Offer): OfferDraft {
  return {
    customerId: offer.customerId,
    notes: offer.notes || '',
    validUntil: offer.validUntil || '',
    lines: offer.lines.map((l) => ({ id: l.id, productId: l.productId, price: String(l.unitPrice) })),
  };
}

/**
 * „Save" im Bearbeiten: Kopf und der vollständige Positionsstand als EIN Auftrag, mit der Fassung,
 * die die Seite gesehen hat. Ohne Änderung: nichts zu tun (keine neue Fassung für ein leeres Speichern).
 */
export async function saveOfferUpdate(
  w: OfferWrite,
  base: Offer,
  draft: OfferDraft,
): Promise<WriteOutcome<{ offerId: string; revision: number }>> {
  const patch: Record<string, unknown> = {
    offerId: base.id,
    lines: draft.lines.map((l) => (l.id
      ? { id: l.id, productId: l.productId, unitPrice: priceFromField(l.price) }
      : { productId: l.productId, unitPrice: priceFromField(l.price) })),
  };
  if (base.revision !== undefined) patch.expectedRevision = base.revision;
  const notes = draft.notes.trim() === '' ? null : draft.notes;
  if (notes !== (base.notes || null)) patch.notes = notes;
  const validUntil = draft.validUntil || null;
  if (validUntil !== (base.validUntil || null)) patch.validUntil = validUntil;
  if (draft.customerId && draft.customerId !== base.customerId) patch.customerId = draft.customerId;

  let input: OfferUpdateInput;
  try { input = offerUpdateInput(patch); } catch (e) { return absage(e); }
  const unveraendert = !('notes' in patch) && !('validUntil' in patch) && !('customerId' in patch)
    && input.lines.length === base.lines.length
    && input.lines.every((l) => {
      const b = l.id ? base.lines.find((x) => x.id === l.id) : undefined;
      return !!b && toFils(b.unitPrice) === toFils(l.unitPrice);
    });
  if (unveraendert) return { kind: 'ok', value: { offerId: base.id, revision: base.revision ?? 0 }, replayed: false };

  const r = await w.save<{ offerId: string; revision: number }>(OP_OFFERS_UPDATE, {
    local: async () => {
      const s = await updateOfferOnPrimary(input);
      return { offerId: s.offerId, revision: s.revision };
    },
    remote: () => rumpf(input),
    shape: (v) => ({ offerId: String(v.offerId ?? base.id), revision: Number(v.revision ?? 0) }),
  });
  if (r.kind === 'ok' && w.remote) angeboteNeu();
  return r;
}

/** „Send" / „Accept" / „Reject" — in der Liste und im Detail derselbe Auftrag. */
export async function saveOfferStatus(
  w: OfferWrite,
  offer: Offer,
  status: OfferTargetStatus,
): Promise<WriteOutcome<{ offerId: string; status: string; revision: number }>> {
  let input: OfferStatusInput;
  try {
    input = offerStatusInput({ offerId: offer.id, status, ...(offer.revision !== undefined ? { expectedRevision: offer.revision } : {}) });
  } catch (e) { return absage(e); }
  const r = await w.save<{ offerId: string; status: string; revision: number }>(OP_OFFERS_SET_STATUS, {
    local: async () => {
      const s = await setOfferStatusOnPrimary(input);
      return { offerId: s.offerId, status: s.status, revision: s.revision };
    },
    remote: () => rumpf(input),
    shape: (v) => ({ offerId: String(v.offerId ?? offer.id), status: String(v.status ?? status), revision: Number(v.revision ?? 0) }),
  });
  if (r.kind === 'ok' && w.remote) angeboteNeu();
  return r;
}

/** „Create Invoice" nach Schema- und Nummern-Dialog. */
export async function saveOfferConvert(
  w: OfferWrite,
  offer: Offer,
  perLineSchemes: Record<string, TaxScheme>,
  specialMark: boolean,
): Promise<WriteOutcome<{ invoiceId: string; invoiceNumber: string }>> {
  let input: OfferConvertInput;
  try {
    input = offerConvertInput({
      offerId: offer.id, perLineSchemes, specialMark,
      ...(offer.revision !== undefined ? { expectedRevision: offer.revision } : {}),
    });
  } catch (e) { return absage(e); }
  const r = await w.save<{ invoiceId: string; invoiceNumber: string }>(OP_OFFERS_CONVERT_TO_INVOICE, {
    local: async () => {
      const c = await convertOfferOnPrimary(input);
      return { invoiceId: c.invoiceId, invoiceNumber: c.invoiceNumber };
    },
    remote: () => rumpf(input),
    shape: (v) => ({ invoiceId: String(v.invoiceId ?? ''), invoiceNumber: String(v.invoiceNumber ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) rechnungNeu();
  return r;
}
