// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — das Angebot am Haus: anlegen, als EIN Entwurf speichern, senden /
// annehmen / ablehnen und in eine Rechnung wandeln. EINE Hausfolge für die Maske am Primary und für
// den Fernbefehl von PC2 (`bridge/offer-commands.ts`).
//
// Was vorher geschah (auditiert, nicht angenommen):
//
//   • Jede Zeilenänderung war ein eigener Schreibvorgang — der Preis bei JEDEM Tastendruck, ohne
//     Transaktion, ohne Fassung. Und falsch: ein geänderter Preis setzte `line_total = Nettopreis`,
//     bei einer VAT_10-Position verschwand damit die Steuer aus Position und Summe.
//   • Die Folgen eines Statuswechsels („offered" am Artikel, Nachfass-Aufgabe, „Rechnung schreiben",
//     zurück auf Lager beim Ablehnen) liefen über den Ereignisbus — NACH dem Schreiben, mit
//     verschlucktem Fehler. Ein Angebot konnte gesendet sein ohne seine Aufgabe.
//   • `createInvoiceFromOffer` war ein ZWEITER Rechnungsweg neben `createDirectInvoice`: eigene
//     Los-Wahl, eigene Nummer, eigene Buchung (Fehler verschluckt), und der Einstand je Zeile kam aus
//     `products.purchase_price` statt aus dem Los, das tatsächlich verbraucht wurde — die Marge der
//     Rechnung und der Wareneinsatz im Hauptbuch stimmten nicht mit dem Bestand überein.
//   • Ein Artikel, der aus dem Entwurf entfernt wurde, blieb für immer „offered" und verschwand damit
//     aus jeder Auswahlliste.
//   • Ohne Sitzung fiel alles still auf 'branch-main' / 'user-owner' zurück.
//
// Jetzt gilt für jede Handlung dieselbe Reihenfolge: prüfen (aus der DATENBANK, in der Filiale des
// Auftrags), dann schreiben — alles INNERHALB der Transaktion des Aufrufers (`runOnPrimary` am
// Primary, `runRemoteCommand` für PC2). Diese Datei öffnet und schließt keine Transaktion und
// speichert nicht durabel — mit einer Ausnahme für die alten, synchronen Store-Aufrufe (`offerAction`).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { ensureLegacySequence, legacySpec } from '@/core/db/legacy-sequences';
import type { SqlDb } from '@/core/sync/apply-change';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';
import { isClientMode } from '@/core/bridge/client-mode';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction, watchLedgerPosts, inLedgerTransaction,
} from '@/core/ledger/posting';
import { vatEngine } from '@/core/tax/vat-engine';
import { deriveProductCostFromLots, getLotsWithPurchaseNumbers, trackProductRow } from '@/core/lots/lot-queries';
import { STOCK_UNAVAILABLE_MESSAGE } from '@/core/lots/lot-availability';
import { WITH_AGENT_INVOICE_BLOCKED_MESSAGE } from '@/core/products/product-sellability';
import { toInvoiceLine, type InvoiceLineInput } from '@/core/invoices/line-derivation';
import { canonicalTaxScheme, type TaxScheme } from '@/core/models/types';
import { useInvoiceStore } from '@/stores/invoiceStore';
import {
  OfferRejected, toFils, isOfferEditable, offerTransitionAllowed,
  offerCreateInput, offerUpdateInput, offerStatusInput, offerConvertInput,
  OFFER_PRIMARY_ONLY, OFFER_NO_SESSION, OFFER_NOT_FOUND, OFFER_NOT_EDITABLE, OFFER_INVALID_TRANSITION,
  OFFER_NOT_ACCEPTED, OFFER_ALREADY_INVOICED, OFFER_HAS_NO_LINES, OFFER_LINE_INVALID, OFFER_LINE_NOT_FOUND,
  OFFER_SCHEME_INVALID, CUSTOMER_NOT_FOUND, PRODUCT_NOT_FOUND, EMPLOYEE_NOT_FOUND,
  STOCK_UNAVAILABLE, WITH_AGENT_BLOCKED, RECORD_CHANGED,
  type OfferCreateInput, type OfferUpdateInput, type OfferStatusInput, type OfferConvertInput,
  type OfferTargetStatus,
} from './offer-rules';

// ── Wo und in wessen Namen ──────────────────────────────────────────────────

/** Die Filiale und der Mensch: fern aus dem geprüften Ausweis, am Primary aus der Sitzung. */
export interface OfferCtx {
  branchId: string;
  userId: string;
}

/**
 * Ein Rechner ohne Geschäftsdatenbank schreibt hier nie — auch nicht über einen vergessenen direkten
 * Store-Aufruf. Der Riegel steht vor dem ersten Zugriff auf eine Datenbank (dieselbe Regel wie R6B/R6D).
 */
export function assertOffersHere(): void {
  if (isClientMode()) {
    throw new OfferRejected(OFFER_PRIMARY_ONLY, 'offers are kept on the main computer — this window has no business database');
  }
}

/** Die Sitzung des Primary. Kein stilles 'branch-main' mehr: ohne Filiale wird nichts geschrieben. */
export function localOfferCtx(): OfferCtx {
  let branchId = '';
  let userId = '';
  try { branchId = currentBranchId(); } catch { branchId = ''; }
  try { userId = currentUserId(); } catch { userId = ''; }
  if (!branchId) throw new OfferRejected(OFFER_NO_SESSION, 'no branch in this session — sign in again');
  return { branchId, userId };
}

/**
 * Für die alten, synchronen Store-Aufrufe (`createOffer`, `createInvoiceFromOffer`): dieselbe
 * Hausfolge in einer eigenen Klammer. Läuft schon eine, fügt sie sich ein — die äußerste Klammer
 * entscheidet über COMMIT und Speichern.
 */
export function offerAction<T>(fn: (ctx: OfferCtx) => T): T {
  assertOffersHere();
  const ctx = localOfferCtx();
  // Läuft schon eine Klammer, gehört ihr die Rücknahme: `rollbackLedgerTransaction` setzt die GANZE
  // Tiefe zurück und hätte eine äußere Transaktion (samt Nachweis eines Fernauftrags) mit verworfen.
  if (inLedgerTransaction()) return fn(ctx);
  beginLedgerTransaction();
  try {
    const out = fn(ctx);
    commitLedgerTransaction();
    return out;
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
}

// ── Was das Haus weiß ───────────────────────────────────────────────────────

/** Die Angebotsnummer aus dem durablen Kreis OFF (CENTRAL-C3A) — erst NACH allen Prüfungen gezogen. */
function nextOfferNumber(): string {
  ensureLegacySequence(getDatabase() as unknown as SqlDb, legacySpec('OFF'), new Date().toISOString(), new Date().getFullYear());
  return getNextDocumentNumber('OFF');
}

/** Der Steuersatz der Filiale — derselbe Schlüssel, den der Store bisher las (Ersatz 10). */
function branchVatRate(branchId: string): number {
  const v = Number(query(`SELECT value FROM settings WHERE branch_id = ? AND key = 'vat.standard_rate'`, [branchId])[0]?.value);
  return Number.isFinite(v) && v >= 0 ? v : 10;
}

/** Das Angebot, wie es in der DATENBANK steht — in DIESER Filiale, sonst gibt es es nicht. */
function liveOffer(offerId: string, branchId: string): Record<string, unknown> {
  const o = query('SELECT * FROM offers WHERE id = ? AND branch_id = ?', [offerId, branchId])[0];
  if (!o) throw new OfferRejected(OFFER_NOT_FOUND, 'no such offer in this branch');
  return o;
}

/** Die gesehene Fassung, verglichen INNERHALB der Transaktion: zwei Rechner gewinnen nicht beide. */
function assertOfferRevision(o: Record<string, unknown>, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = Number(o.revision ?? 0);
  if (now !== expected) {
    throw new OfferRejected(RECORD_CHANGED, `this offer changed since you opened it (you saw ${expected}, it is now ${now}) — reopen it`);
  }
}

function revisionOf(offerId: string): number {
  return Number(query('SELECT revision FROM offers WHERE id = ?', [offerId])[0]?.revision ?? 0);
}

/** Dieselbe Kundenmenge wie die Auswahl der Maske (`loadCustomersFor`): Filiale, keine System-Kunden. */
function assertCustomer(customerId: string, branchId: string): void {
  const c = query("SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [customerId, branchId])[0];
  if (!c) throw new OfferRejected(CUSTOMER_NOT_FOUND, 'no such client in this branch');
}

function productIn(productId: string, branchId: string): Record<string, unknown> {
  const p = query('SELECT id, tax_scheme, purchase_price FROM products WHERE id = ? AND branch_id = ?', [productId, branchId])[0];
  if (!p) throw new OfferRejected(PRODUCT_NOT_FOUND, 'no such article in this branch');
  return p;
}

/** Ein gespeichertes Schema (auch die alten Namen). Ein unlesbares ist ein Nein, kein stilles MARGIN. */
function schemeFrom(stored: unknown, fallback: TaxScheme = 'MARGIN'): TaxScheme {
  try {
    return canonicalTaxScheme(stored === null || stored === undefined || stored === '' ? fallback : String(stored));
  } catch {
    throw new OfferRejected(OFFER_SCHEME_INVALID, `unreadable tax scheme ${String(stored)}`);
  }
}

/**
 * Der Einstand, mit dem die Maske rechnet (Phase 7): das älteste offene Los — derselbe Wert, den die
 * Seiten aus der gemeinsamen Kernauskunft zeigen —, sonst der Einkaufspreis des Artikels. Er kommt
 * aus der Datenbank, nie aus dem Rumpf.
 */
function costBasisOf(productId: string, product: Record<string, unknown>): number {
  const fifo = deriveProductCostFromLots(productId);
  return fifo ? fifo.fifoCost : (Number(product.purchase_price) || 0);
}

/** Die Summen, wie `recalcOfferTotals` sie rechnete: Netto = Σ Preis, MwSt = Σ (Brutto − Netto). In Fils. */
export function offerTotals(lines: ReadonlyArray<{ unitPrice: number; lineTotal: number }>): { subtotal: number; vatAmount: number; total: number } {
  let netF = 0;
  let grossF = 0;
  for (const l of lines) { netF += toFils(l.unitPrice); grossF += toFils(l.lineTotal); }
  return { subtotal: netF / 1000, vatAmount: (grossF - netF) / 1000, total: grossF / 1000 };
}

function totalsFromDb(offerId: string) {
  return offerTotals(query('SELECT unit_price, line_total FROM offer_lines WHERE offer_id = ?', [offerId])
    .map((r) => ({ unitPrice: Number(r.unit_price) || 0, lineTotal: Number(r.line_total) || 0 })));
}

/** Brutto einer Position: dieselbe Netto-Rechnung wie bisher (`vatEngine.calculateNet`). */
function lineTotalOf(unitPrice: number, costBasis: number, scheme: TaxScheme, vatRate: number): number {
  return vatEngine.calculateNet(unitPrice, costBasis, scheme, vatRate).grossAmount;
}

// ── Die Folgen am Artikel und in den Aufgaben — IN der Transaktion ─────────
//
// Vorher Ereignis-Handler (`automation-handlers.ts`), die NACH dem Schreiben liefen. Die Zeilen sind
// dieselben; nur der Zeitpunkt ist jetzt der richtige: zusammen mit dem Angebot oder gar nicht.

/** „offered" — nur ein Stück, das auf Lager liegt; der zuletzt angebotene Preis kommt mit. */
function markOffered(productId: string, unitPrice: number, now: string): void {
  getDatabase().run(
    `UPDATE products SET stock_status = 'offered', last_offer_price = ?, updated_at = ? WHERE id = ? AND stock_status = 'in_stock'`,
    [unitPrice, now, productId],
  );
  trackProductRow(productId);
}

/** Zurück auf Lager — nur, was noch „offered" ist (dieselbe Regel wie beim Ablehnen). */
function revertOffered(productId: string, now: string): void {
  getDatabase().run(
    `UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ? AND stock_status = 'offered'`,
    [now, productId],
  );
  trackProductRow(productId);
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** Eine automatische Aufgabe — dieselbe Zeile wie `insertTask` der Automatisierung, im Namen des Handelnden. */
function insertAutoTask(ctx: OfferCtx, t: {
  title: string; description: string; type: string; priority: string; dueAt: string;
  linkedEntityType: string; linkedEntityId: string;
}): void {
  const id = uuid();
  getDatabase().run(
    `INSERT INTO tasks (id, branch_id, title, description, type, priority, due_at, linked_entity_type, linked_entity_id, assigned_to, status, auto_generated, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
    [id, ctx.branchId, t.title, t.description, t.type, t.priority, t.dueAt, t.linkedEntityType, t.linkedEntityId,
      ctx.userId || null, new Date().toISOString(), ctx.userId || null],
  );
  trackChange('tasks', id, 'insert', {});
}

// ── offers.create ───────────────────────────────────────────────────────────

export interface OfferCreated { offerId: string; offerNumber: string; revision: number; total: number }

/**
 * „Create Offer": Kunde und Artikel in DIESER Filiale, Steuersatz der Filiale, Brutto je Position mit
 * dem Einstand aus der Datenbank, Nummer aus dem durablen Kreis — und die Artikel „offered". Zusammen
 * oder gar nicht.
 */
export function createOfferInHouse(raw: OfferCreateInput, ctx: OfferCtx): OfferCreated {
  assertOffersHere();
  const v = offerCreateInput(raw as unknown as Record<string, unknown>);
  assertCustomer(v.customerId, ctx.branchId);
  const vatRate = branchVatRate(ctx.branchId);
  const lines = v.lines.map((l, i) => {
    const p = productIn(l.productId, ctx.branchId);
    const scheme = l.taxScheme ?? schemeFrom(p.tax_scheme);
    return {
      id: uuid(), productId: l.productId, unitPrice: l.unitPrice, scheme, position: i + 1,
      lineTotal: lineTotalOf(l.unitPrice, costBasisOf(l.productId, p), scheme, vatRate),
    };
  });

  // Erst jetzt die Nummer: ein Nein oben verbraucht keine.
  const id = uuid();
  const now = new Date().toISOString();
  const offerNumber = nextOfferNumber();
  const { subtotal, vatAmount, total } = offerTotals(lines);
  const db = getDatabase();
  db.run(
    `INSERT INTO offers (id, branch_id, offer_number, customer_id, status, valid_until, currency,
      subtotal, vat_rate, vat_amount, total, notes, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, 'BHD', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, offerNumber, v.customerId, v.validUntil ?? null,
      subtotal, vatRate, vatAmount, total, v.notes ?? null, now, now, ctx.userId || null],
  );
  for (const l of lines) {
    db.run(
      `INSERT INTO offer_lines (id, offer_id, product_id, unit_price, vat_rate, tax_scheme, line_total, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [l.id, id, l.productId, l.unitPrice, vatRate, l.scheme, l.lineTotal, l.position],
    );
  }
  // LAN-Sync: Kopf zuerst, dann die Positionen (Eltern vor Kind) — wie bisher.
  trackInsert('offers', id, { offerNumber, customerId: v.customerId, total });
  for (const l of lines) trackChange('offer_lines', l.id, 'insert', {});
  for (const l of lines) markOffered(l.productId, l.unitPrice, now);
  return { offerId: id, offerNumber, revision: revisionOf(id), total };
}

// ── offers.update ───────────────────────────────────────────────────────────

export interface OfferSaved { offerId: string; revision: number; total: number; changed: boolean }

/**
 * „Save" im Bearbeiten: Kopf und der vollständige Positionsstand in EINEM Schritt. Nur der Entwurf
 * ist bearbeitbar (der Edit-Knopf erscheint nur dort). Hinzugekommene Artikel werden „offered",
 * entfernte gehen zurück auf Lager — dieselben zwei Regeln wie beim Anlegen und beim Ablehnen.
 */
export function updateOfferInHouse(raw: OfferUpdateInput, ctx: OfferCtx): OfferSaved {
  assertOffersHere();
  const v = offerUpdateInput(raw as unknown as Record<string, unknown>);
  const o = liveOffer(v.offerId, ctx.branchId);
  assertOfferRevision(o, v.expectedRevision);
  if (!isOfferEditable(o.status as string)) {
    throw new OfferRejected(OFFER_NOT_EDITABLE, `only a draft offer can be edited (this one is ${String(o.status)})`);
  }

  const header: Array<[string, string, unknown]> = [];
  if (v.customerId !== undefined && v.customerId !== String(o.customer_id ?? '')) {
    assertCustomer(v.customerId, ctx.branchId);
    header.push(['customer_id', 'customerId', v.customerId]);
  }
  if (v.notes !== undefined && v.notes !== ((o.notes as string | null) ?? null)) header.push(['notes', 'notes', v.notes]);
  if (v.validUntil !== undefined && v.validUntil !== ((o.valid_until as string | null) ?? null)) header.push(['valid_until', 'validUntil', v.validUntil]);

  // Die Positionen: erst vollständig prüfen, dann schreiben.
  const vatRate = o.vat_rate === null || o.vat_rate === undefined ? branchVatRate(ctx.branchId) : Number(o.vat_rate);
  const existing = query('SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position, rowid', [v.offerId]);
  const byId = new Map(existing.map((r) => [String(r.id), r]));
  const kept = new Set<string>();
  const updates: Array<{ id: string; unitPrice: number; scheme: TaxScheme; lineTotal: number }> = [];
  const inserts: Array<{ id: string; productId: string; unitPrice: number; scheme: TaxScheme; lineTotal: number; position: number }> = [];
  let position = existing.reduce((m, r) => Math.max(m, Number(r.position) || 0), 0);
  v.lines.forEach((l, i) => {
    if (l.id) {
      const cur = byId.get(l.id);
      if (!cur) throw new OfferRejected(OFFER_LINE_NOT_FOUND, `line ${i + 1} is not on this offer`);
      if (String(cur.product_id) !== l.productId) {
        throw new OfferRejected(OFFER_LINE_INVALID, `line ${i + 1}: an existing line keeps its article — remove it and add the other one`);
      }
      kept.add(l.id);
      const stored = schemeFrom(cur.tax_scheme);
      const scheme = l.taxScheme ?? stored;
      if (toFils(l.unitPrice) !== toFils(Number(cur.unit_price) || 0) || scheme !== stored) {
        const p = query('SELECT purchase_price FROM products WHERE id = ?', [l.productId])[0] ?? {};
        updates.push({ id: l.id, unitPrice: l.unitPrice, scheme, lineTotal: lineTotalOf(l.unitPrice, costBasisOf(l.productId, p), scheme, vatRate) });
      }
    } else {
      const p = productIn(l.productId, ctx.branchId);
      const scheme = l.taxScheme ?? schemeFrom(p.tax_scheme);
      position += 1;
      inserts.push({
        id: uuid(), productId: l.productId, unitPrice: l.unitPrice, scheme, position,
        lineTotal: lineTotalOf(l.unitPrice, costBasisOf(l.productId, p), scheme, vatRate),
      });
    }
  });
  const removed = existing.filter((r) => !kept.has(String(r.id)));

  if (header.length === 0 && updates.length === 0 && inserts.length === 0 && removed.length === 0) {
    return { offerId: v.offerId, revision: Number(o.revision ?? 0), total: Number(o.total ?? 0), changed: false };
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  for (const r of removed) db.run('DELETE FROM offer_lines WHERE id = ?', [String(r.id)]);
  for (const u of updates) {
    db.run('UPDATE offer_lines SET unit_price = ?, tax_scheme = ?, vat_rate = ?, line_total = ? WHERE id = ?',
      [u.unitPrice, u.scheme, vatRate, u.lineTotal, u.id]);
  }
  for (const n of inserts) {
    db.run(
      `INSERT INTO offer_lines (id, offer_id, product_id, unit_price, vat_rate, tax_scheme, line_total, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [n.id, v.offerId, n.productId, n.unitPrice, vatRate, n.scheme, n.lineTotal, n.position],
    );
  }
  const totals = totalsFromDb(v.offerId);
  db.run(
    `UPDATE offers SET ${header.map(([col]) => `${col} = ?`).concat(['subtotal = ?', 'vat_amount = ?', 'total = ?', 'updated_at = ?']).join(', ')} WHERE id = ?`,
    [...header.map(([, , val]) => val), totals.subtotal, totals.vatAmount, totals.total, now, v.offerId],
  );

  // LAN-Sync nach dem letzten Schreiben: die Positionen je einzeln, der Kopf als EIN Stand.
  for (const r of removed) trackChange('offer_lines', String(r.id), 'delete', {});
  for (const u of updates) trackChange('offer_lines', u.id, 'update', {});
  for (const n of inserts) trackChange('offer_lines', n.id, 'insert', {});
  if (header.length > 0) {
    trackUpdate('offers', v.offerId, { ...Object.fromEntries(header.map(([, key, val]) => [key, val])), total: totals.total });
  } else {
    trackChange('offers', v.offerId, 'update', {});
  }

  const keptProducts = new Set(existing.filter((r) => kept.has(String(r.id))).map((r) => String(r.product_id)));
  const wanted = new Set(v.lines.map((l) => l.productId));
  for (const n of inserts) if (!keptProducts.has(n.productId)) markOffered(n.productId, n.unitPrice, now);
  for (const r of removed) if (!wanted.has(String(r.product_id))) revertOffered(String(r.product_id), now);

  return { offerId: v.offerId, revision: revisionOf(v.offerId), total: totals.total, changed: true };
}

// ── offers.set_status ───────────────────────────────────────────────────────

export interface OfferStatusSet { offerId: string; status: OfferTargetStatus; revision: number; sentAt?: string }

/**
 * „Send" / „Accept" / „Reject": der Übergang, den die Knöpfe anbieten, und seine Folge — die
 * Nachfass-Aufgabe, die Aufgabe „Rechnung schreiben", die Artikel zurück auf Lager — in derselben
 * Transaktion. Der Zeitpunkt des Sendens ist der des Primary.
 */
export function setOfferStatusInHouse(raw: OfferStatusInput, ctx: OfferCtx): OfferStatusSet {
  assertOffersHere();
  const v = offerStatusInput(raw as unknown as Record<string, unknown>);
  const o = liveOffer(v.offerId, ctx.branchId);
  assertOfferRevision(o, v.expectedRevision);
  const from = String(o.status || 'draft');
  if (!offerTransitionAllowed(from, v.status)) {
    throw new OfferRejected(OFFER_INVALID_TRANSITION, `an offer that is ${from} cannot become ${v.status}`);
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const offerNumber = String(o.offer_number ?? v.offerId);
  if (v.status === 'sent') {
    db.run('UPDATE offers SET status = ?, sent_at = ?, sent_via = COALESCE(?, sent_via), updated_at = ? WHERE id = ?',
      ['sent', now, v.sentVia ?? null, now, v.offerId]);
    trackUpdate('offers', v.offerId, { status: 'sent', sentAt: now, ...(v.sentVia ? { sentVia: v.sentVia } : {}) });
    insertAutoTask(ctx, {
      title: 'Follow up on sent offer',
      description: `Offer ${offerNumber} was sent. Follow up with the customer to check interest.`,
      type: 'follow_up', priority: 'medium', dueAt: addDays(3),
      linkedEntityType: 'offer', linkedEntityId: v.offerId,
    });
  } else {
    db.run('UPDATE offers SET status = ?, updated_at = ? WHERE id = ?', [v.status, now, v.offerId]);
    trackUpdate('offers', v.offerId, { status: v.status });
    if (v.status === 'accepted') {
      insertAutoTask(ctx, {
        title: 'Create invoice for accepted offer',
        description: `Offer ${offerNumber} has been accepted. Create an invoice to proceed with the sale.`,
        type: 'general', priority: 'high', dueAt: addDays(1),
        linkedEntityType: 'offer', linkedEntityId: v.offerId,
      });
    } else {
      for (const l of query('SELECT product_id FROM offer_lines WHERE offer_id = ?', [v.offerId])) {
        revertOffered(String(l.product_id), now);
      }
    }
  }
  return {
    offerId: v.offerId, status: v.status, revision: revisionOf(v.offerId),
    ...(v.status === 'sent' ? { sentAt: now } : {}),
  };
}

// ── offers.convert_to_invoice ───────────────────────────────────────────────

export interface OfferConverted { invoiceId: string; invoiceNumber: string; grossAmount: number; status: string; offerRevision: number }

/**
 * Eine Angebotsposition als Rechnungszeile — mit DERSELBEN Ableitung wie das Rechnungsformular und
 * `invoices.create` (`toInvoiceLine`): das Los wird hier gewählt (das älteste offene, dieselbe Liste,
 * aus der das Formular vorbelegt), und sein Einstand ist der Einstand der Zeile. Ein Artikel, der
 * über Lose geführt wird und keines mehr offen hat, ist nicht lieferbar — vorher lief die Zeile dann
 * ohne Los und ohne Bestandsabzug weiter. Angebotszeilen haben keine Menge: ein Stück je Position.
 */
function invoiceLineFor(line: Record<string, unknown>, scheme: TaxScheme, branchId: string): InvoiceLineInput {
  const productId = String(line.product_id ?? '');
  const p = query('SELECT id, purchase_price FROM products WHERE id = ? AND branch_id = ?', [productId, branchId])[0];
  if (!p) throw new OfferRejected(PRODUCT_NOT_FOUND, 'an article of this offer is no longer in this branch');
  const open = getLotsWithPurchaseNumbers(productId);
  let lotId: string | null = null;
  let costBasis = Number(p.purchase_price) || 0;
  if (open.length > 0) {
    lotId = open[0].id;
    costBasis = open[0].unitCost || costBasis;
  } else if (query('SELECT id FROM stock_lots WHERE product_id = ? LIMIT 1', [productId]).length > 0) {
    throw new OfferRejected(STOCK_UNAVAILABLE, STOCK_UNAVAILABLE_MESSAGE);
  }
  return toInvoiceLine({ productId, lotId, quantity: 1, unitPrice: Number(line.unit_price) || 0, costBasis, scheme });
}

/**
 * „Create Invoice" am angenommenen Angebot: die Rechnung entsteht über DENSELBEN Weg wie jede andere
 * (`createDirectInvoice` — Nummer, Los, Bestand, Buchung), mit der Angebotskennung in derselben
 * Zeile; danach die Verknüpfung am Angebot. Eine gescheiterte Buchung (dort sonst verschluckt) nimmt
 * alles zurück: keine halbe Rechnung, kein verbrauchtes Los, keine verbrannte Nummer.
 */
export function convertOfferToInvoiceInHouse(raw: OfferConvertInput, ctx: OfferCtx): OfferConverted {
  assertOffersHere();
  const v = offerConvertInput(raw as unknown as Record<string, unknown>);
  const o = liveOffer(v.offerId, ctx.branchId);
  assertOfferRevision(o, v.expectedRevision);
  // Der Knopf steht nur am angenommenen Angebot ohne Rechnung (`canCreateInvoice`).
  if (String(o.status) !== 'accepted') {
    throw new OfferRejected(OFFER_NOT_ACCEPTED, `only an accepted offer becomes an invoice (this one is ${String(o.status)})`);
  }
  // H-03 — Doppelumwandlung: gefragt wird die Rechnungstabelle selbst, nicht `offers.invoice_id` —
  // ein nach dem Löschen verwaister Verweis blockiert nicht, eine stornierte Rechnung auch nicht.
  const existingInv = query(`SELECT invoice_number FROM invoices WHERE offer_id = ? AND status != 'CANCELLED' LIMIT 1`, [v.offerId])[0];
  if (existingInv) {
    throw new OfferRejected(OFFER_ALREADY_INVOICED, `this offer was already converted into invoice ${String(existingInv.invoice_number)}`);
  }
  const lines = query('SELECT * FROM offer_lines WHERE offer_id = ? ORDER BY position, rowid', [v.offerId]);
  // Der Schema-Dialog lässt ohne Positionen nicht bestätigen.
  if (lines.length === 0) throw new OfferRejected(OFFER_HAS_NO_LINES, 'this offer has no lines to invoice');
  const lineIds = new Set(lines.map((l) => String(l.id)));
  for (const k of Object.keys(v.perLineSchemes ?? {})) {
    if (!lineIds.has(k)) throw new OfferRejected(OFFER_LINE_NOT_FOUND, 'a chosen tax scheme names a line that is not on this offer');
  }
  if (v.staffId && !query('SELECT id FROM employees WHERE id = ? AND branch_id = ?', [v.staffId, ctx.branchId])[0]) {
    throw new OfferRejected(EMPLOYEE_NOT_FOUND, 'no such employee in this branch');
  }
  const invoiceLines = lines.map((l) => invoiceLineFor(l, v.perLineSchemes?.[String(l.id)] ?? schemeFrom(l.tax_scheme), ctx.branchId));

  const buchung = watchLedgerPosts('offer to invoice');
  let createdId: string | undefined;
  try {
    const inv = useInvoiceStore.getState().createDirectInvoice(
      String(o.customer_id), invoiceLines, (o.notes as string | null) || undefined,
      undefined,          // ausgestellt: jetzt
      undefined,          // der normale Verkaufskreis
      v.staffId, v.specialMark === true, { offerId: v.offerId },
    );
    createdId = inv?.id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === STOCK_UNAVAILABLE_MESSAGE) throw new OfferRejected(STOCK_UNAVAILABLE, msg);
    if (msg === WITH_AGENT_INVOICE_BLOCKED_MESSAGE) throw new OfferRejected(WITH_AGENT_BLOCKED, msg);
    throw e;
  }
  buchung();
  // Die Rechnung trägt die Angebotskennung seit ihrer ersten Zeile — auch wenn die Liste des Stores
  // gerade nicht lesbar war, ist sie damit eindeutig auffindbar.
  const invoiceId = createdId
    ?? String(query(`SELECT id FROM invoices WHERE offer_id = ? AND status != 'CANCELLED' LIMIT 1`, [v.offerId])[0]?.id ?? '');
  if (!invoiceId) throw new Error('offer to invoice: the new invoice is not readable inside its own transaction');

  const now = new Date().toISOString();
  // Plan §8 #10 — die Verknüpfung in beide Richtungen. Vorher ohne Abgleich-Eintrag.
  getDatabase().run(`UPDATE offers SET status = 'accepted', invoice_id = ?, updated_at = ? WHERE id = ?`, [invoiceId, now, v.offerId]);
  trackUpdate('offers', v.offerId, { status: 'accepted', invoiceId });

  const inv = query('SELECT invoice_number, gross_amount, status FROM invoices WHERE id = ?', [invoiceId])[0] ?? {};
  // Die Zahlungserinnerung, die bisher über `invoice.issued` NACH dem Speichern entstand.
  insertAutoTask(ctx, {
    title: 'Payment reminder',
    description: `Invoice ${String(inv.invoice_number ?? invoiceId)} was issued. Follow up on payment if not received by due date.`,
    type: 'payment_reminder', priority: 'medium', dueAt: addDays(14),
    linkedEntityType: 'invoice', linkedEntityId: invoiceId,
  });
  return {
    invoiceId,
    invoiceNumber: String(inv.invoice_number ?? ''),
    grossAmount: Number(inv.gross_amount ?? 0),
    status: String(inv.status ?? ''),
    offerRevision: revisionOf(v.offerId),
  };
}
