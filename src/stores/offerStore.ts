import { create } from 'zustand';
// CENTRAL-C3A — der durable Nummerngeber. `getNextNumber` rechnete ueber den Bestand und gab
// die Nummer einer geloeschten Zeile erneut aus.
import { ensureLegacySequence, legacySpec } from '@/core/db/legacy-sequences';
import type { SqlDb } from '@/core/sync/apply-change';
import type { Offer, OfferLine, OfferStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { trackDelete } from '@/core/sync/track';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
import { trackChange } from '@/core/sync/sync-service';   // sync-only (kein Audit) — offer_lines beim Loeschen
// CENTRAL-UI-PARITY R6E — Anlegen, Speichern, Status und Umwandeln leben in EINER Hausfolge
// (`core/offers/offer-house.ts`), die Maske und Fernbefehl gleichermassen rufen. Die frueheren
// Einzelschreiber (`updateOffer`, `updateOfferLine`, `addOfferLine`, `removeOfferLine`,
// `recalcOfferTotals`) sind weg: jeder schrieb fuer sich, ohne Transaktion und ohne Fassung, der
// Preis sogar bei jedem Tastendruck — und ein geaenderter Preis verlor bei VAT_10 die Steuer.
import { createOfferInHouse, offerAction } from '@/core/offers/offer-house';

interface OfferStore {
  offers: Offer[];
  loading: boolean;
  loadOffers: () => void;
  getOffer: (id: string) => Offer | undefined;
  /** R6E — dieselbe Hausfolge wie Maske und Fernbefehl. Einstand und Schema kommen aus der Datenbank. */
  createOffer: (customerId: string, lines: { productId: string; unitPrice: number }[], notes?: string, validUntil?: string) => Offer;
  deleteOffer: (id: string) => void;
  getNextOfferNumber: () => string;
}

function rowToOffer(row: Record<string, unknown>): Offer {
  return {
    // R6E — die Fassung reist mit (Speichern, Senden, Umwandeln nennen sie).
    revision: row.revision === undefined || row.revision === null ? undefined : Number(row.revision),
    id: row.id as string,
    offerNumber: row.offer_number as string,
    customerId: row.customer_id as string,
    status: (row.status as OfferStatus) || 'draft',
    validUntil: row.valid_until as string | undefined,
    currency: (row.currency as Offer['currency']) || 'BHD',
    subtotal: (row.subtotal as number) || 0,
    vatRate: (row.vat_rate as number) || 0,
    vatAmount: (row.vat_amount as number) || 0,
    total: (row.total as number) || 0,
    taxScheme: (row.tax_scheme as Offer['taxScheme']) || 'MARGIN',
    notes: row.notes as string | undefined,
    sentAt: row.sent_at as string | undefined,
    sentVia: row.sent_via as Offer['sentVia'],
    followUpAt: row.follow_up_at as string | undefined,
    lines: [],
    invoiceId: row.invoice_id as string | undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToLine(row: Record<string, unknown>): OfferLine {
  return {
    id: row.id as string,
    offerId: row.offer_id as string,
    productId: row.product_id as string,
    unitPrice: (row.unit_price as number) || 0,
    vatRate: (row.vat_rate as number) || 0,
    taxScheme: (row.tax_scheme as OfferLine['taxScheme']) || 'MARGIN',
    lineTotal: (row.line_total as number) || 0,
    position: (row.position as number) || 1,
  };
}

export const useOfferStore = create<OfferStore>((set, get) => ({
  offers: [],
  loading: false,

  loadOffers: () => {
    if (hydrateFromPrimary('store.offers.get', (d) => set(d as never))) return;
    try {
      set({ ...loadOffersFor(localReadContext()), loading: false });
    } catch { set({ offers: [], loading: false }); }
  },

  getOffer: (id) => get().offers.find(o => o.id === id),

  // CENTRAL-C3A — durabler Zaehler statt MAX(Bestand)+1.
  getNextOfferNumber: () => {
    ensureLegacySequence(getDatabase() as unknown as SqlDb, legacySpec('OFF'), new Date().toISOString(), new Date().getFullYear());
    return getNextDocumentNumber('OFF');
  },

  // R6E — der alte synchrone Aufruf laeuft durch dieselbe Hausfolge (eigene Klammer, oder die des
  // Aufrufers). Auf einem Rechner ohne Datenbank verweigert sie, bevor sie etwas anfasst.
  createOffer: (customerId, lines, notes, validUntil) => {
    const r = offerAction((ctx) => createOfferInHouse({
      customerId,
      lines: lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
      notes,
      validUntil,
    }, ctx));
    get().loadOffers();
    return get().getOffer(r.offerId)!;
  },

  deleteOffer: (id) => {
    const db = getDatabase();
    // offer_line-IDs VOR dem Delete erfassen → je Line als delete syncen, sonst
    // verwaisen sie auf Gerät B (FK ON DELETE CASCADE wird in sql.js nicht erzwungen).
    const lineIds = query(`SELECT id FROM offer_lines WHERE offer_id = ?`, [id]).map(r => r.id as string);
    db.run(`DELETE FROM offer_lines WHERE offer_id = ?`, [id]);
    db.run(`DELETE FROM offers WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('offers', id);
    for (const lid of lineIds) trackChange('offer_lines', lid, 'delete', {});
    get().loadOffers();
  },
}));

/** CENTRAL-UI-PARITY R2B — die Angebote einer Filiale samt Zeilen, zustandsfrei. */
export function loadOffersFor(ctx: BusinessReadContext): { offers: Offer[] } {
  const rows = query('SELECT * FROM offers WHERE branch_id = ? ORDER BY created_at DESC', [ctx.branchId]);
  const offers = rows.map((r) => {
    const offer = rowToOffer(r);
    // `offer_lines` hat keine eigene Filiale — sie haengt am Angebot, und das ist bereits
    // eingeschraenkt. Die Zeile kann also nur zu einem Angebot der eigenen Filiale gehoeren.
    const lineRows = query('SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position', [offer.id]);
    offer.lines = lineRows.map(rowToLine);
    return offer;
  });
  return { offers };
}
