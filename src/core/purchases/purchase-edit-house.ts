// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT — einen bestehenden Einkauf bearbeiten (Owner-Entscheide D1–D14, 24.10.2026).
//
// EINE Hausfolge für den Primary (`runOnPrimary`) und für PC2 (`purchases.update` /
// `purchases.correct`, in der Transaktion des Auftrags). Diese Datei öffnet, schließt und rollt nie
// selbst zurück, speichert nie selbst; ein Nein ist ein geworfener `PurchaseEditRejected` mit festem
// Code, und JEDE Regel steht vor dem ersten Schreiben. Sie importiert keinen Store.
//
// Was sich ändern lässt, in drei Klassen (Phase-1-Matrix):
//   A  Notizen, Mitarbeiter                       — nur Protokoll und Fassung
//   B  Ausweisfoto ersetzen (D10)                 — das alte bleibt verborgen aufbewahrt
//   C  Datum, Lieferant, Stückpreis, Menge        — dokumentierte Finanzkorrektur
// Artikelmerkmale und Artikelfotos sind Felder DES ARTIKELS (D13: derselbe Datensatz wie in der
// Collection) und werden über die Artikelbearbeitung geändert, nicht hier kopiert.
//
// Die Finanzkorrektur (C), Schritt für Schritt:
//   • Zeilen-IDs bleiben (die Buchung hängt über `source_line_id` daran, die Retoure über
//     `purchase_line_id`). Eine geänderte Zeile behält ihre Kennung.
//   • Teil 2 (v0.8.91): eine vergessene Position wird NACHGETRAGEN — über dieselbe Planung, SKU-Vergabe und
//     Zeilenfolge wie „Save Purchase" (`PurchaseLineOps`, von außen hereingereicht: diese Datei kennt keinen Store).
//   • Teil 3 (v0.8.91): eine UNBERÜHRTE Position wird ENTFERNT — Zeile und Los gehen; der Artikel nur, wenn ihn
//     diese Zeile angelegt hat und nichts sonst an ihm hängt (jede Spalte `…product_id` zählt). Die letzte Position
//     bleibt (dafür gibt es „Cancel Purchase"); Zahlungen bleiben, eine Überzahlung wird Lieferantenguthaben.
//   • Das Hauptbuch wird nicht überschrieben: die Einkaufsbuchung wird gegengebucht und mit den neuen
//     Werten NEU gebucht — beides am Tag der Korrektur (D3, keine Rückdatierung). Zahlungen bleiben
//     Zeilen und Buchungen; beim Lieferantenwechsel (D5) werden ihre Buchungen auf den neuen
//     Lieferanten umgebucht, die Zahlung selbst (Betrag, Weg, Datum, Beleg) bleibt.
//   • Das Los verschiebt seinen Einstand um die DIFFERENZ je Stück (eine aktivierte Reparatur bleibt).
//   • Schon verkaufte Stücke (D1): die Rechnung bleibt unverändert; je Rechnungszeile eine
//     Einstandskorrektur mit eigenem Beleg (`cost_corrections`) und eigener Buchung (COST_CORRECTION,
//     Lager ↔ Wareneinsatz, kein VAT-Konto). Gebucht heute, wirtschaftlich dem Verkauf zugeordnet;
//     die mögliche VAT-Wirkung ist gekennzeichnet (REVIEW) und geht in KEINE Erklärung.
//   • Der Artikel (D13): Einkaufspreis und -datum nur, wenn ihn diese Zeile angelegt hat (oder sein
//     Wert die Zeile noch genau spiegelt); Verkaufs- und Mindestpreis nie.
//
// Was gesperrt bleibt, bis der Buchhalter eine Regel bestätigt (vorbereitet, nicht aktiv): spätere
// Lieferantenrabatte, Vorgänge vor dem Eröffnungsstichtag, Vorsteuer außerhalb des laufenden offenen
// Quartals, Partnerzeilen, Edelmetall-Sammellose, Kommissions-Einkäufe, Einkäufe mit Rückgabe.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import { trackChange } from '@/core/sync/sync-service';
import { getAvailableStock, syncProductQuantity, trackLotRow, trackProductRow } from '@/core/lots/lot-queries';
import { purgeProductLeftovers, type LeftoverDb } from '@/core/products/product-leftovers';
import { purchaseLotUnitCost } from '@/core/lots/lot-cost';
import {
  hasLedgerEntries, postCostCorrection, postPurchasePayment, postPurchaseReceived, reverseSource,
} from '@/core/ledger/posting';
import {
  assertSupplierOverpayMutable, reconcilePurchaseOverpayCredit, OverpayCreditRedeemed,
} from '@/core/payables/purchase-overpay';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { businessDateIssue } from '@/core/utils/business-date';
import { closedVatQuarters, nbrQuarterOfDate } from '@/core/tax/vat-period-lock';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import { isBulkMetalProduct } from '@/core/bulk/bulk-product';
import {
  applyIdentityDocument, identityDocumentFor, identitySourceOf, supplierLegacyIdPhoto, IdentityMediaError,
} from '@/core/identity/identity-media';
import type { Product, Purchase, PurchaseIdentityReference, PurchasePayment, PurchaseStatus, SupplierSnapshot } from '@/core/models/types';
import { purchaseLineConsumption, type PurchaseLineConsumption } from './purchase-consumption';
import { restoreSupplierCreditUsage } from '@/core/finance/supplierCreditRestore';

/** Die Buchungen dieses Bereichs — Maske (useSharedWrite) und Fernbefehl benutzen DIESE Namen. */
export const PURCHASE_EDIT_OP = {
  /** Klasse A/B: Notizen, Mitarbeiter, Ausweisfoto — nach den Rechten des Einkaufs (D11). */
  UPDATE: 'purchases.update',
  /** Klasse C: Datum, Lieferant, Preise, Mengen — nur Owner/Admin (D11). */
  CORRECT: 'purchases.correct',
  /** D14: eine falsch erfasste Zahlung stornieren — nur Owner/Admin. */
  VOID_PAYMENT: 'purchases.void_payment',
} as const;

/** Die Auskunft für die Maske: was darf sich bei DIESEM Einkauf ändern, und wenn nicht, warum nicht. */
export const PURCHASE_EDIT_CHECK_OP = 'purchase.edit_check.get';

export class PurchaseEditRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PurchaseEditRejected';
    this.code = code;
  }
}
const nein = (code: string, message: string): PurchaseEditRejected => new PurchaseEditRejected(code, message);

export const PURCHASE_EDIT_PRIMARY_ONLY = 'PURCHASE_PRIMARY_ONLY';

/** Erfassungsfehler (aktiv) oder späterer Rabatt des Lieferanten (D1: gesperrt, bis der Buchhalter entscheidet). */
export const CORRECTION_KINDS = ['ENTRY_ERROR', 'SUPPLIER_DISCOUNT'] as const;
export type CorrectionKind = typeof CORRECTION_KINDS[number];
export const isCorrectionKind = (v: unknown): v is CorrectionKind => (CORRECTION_KINDS as readonly unknown[]).includes(v);

// BHD = 3 Dezimalstellen (Fils). Gerechnet und verglichen wird in Minor Units.
const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const R3 = (n: number): number => Math.round(n * 1000) / 1000;
const EPS = 0.0005;
const dayOf = (iso: string): string => String(iso).slice(0, 10);
const fmt = (n: number): string => R3(n).toFixed(3);

export interface HouseCtx { branchId: string; userId: string; now: string }

// ── Was die Maske meint ─────────────────────────────────────────────────────

export interface PurchaseEditRequest {
  purchaseId: string;
  /** Pflicht bei jeder Bearbeitung (wie bei der Rechnung). */
  reason: string;
  /** A — `undefined` = unverändert, `''`/`null` = leeren. */
  notes?: string | null;
  staffId?: string | null;
  /** B — das NEUE Ausweisfoto, schon als Medium aufgenommen (vor der Klammer). */
  identityPhoto?: { mediaId: string; alsoUpdatePerson?: boolean };
  /** C — Einkaufsdatum (JJJJ-MM-TT). */
  purchaseDate?: string;
  /** C — der richtige Lieferant. */
  supplierId?: string;
  /** D5 — Pflicht, wenn schon bezahlt wurde: die Zahlungen gingen tatsächlich an den neuen Lieferanten. */
  confirmPaymentsToNewSupplier?: boolean;
  /** C — je Zeile der richtige Stückpreis (brutto, wie beim Anlegen) und/oder die richtige Menge. */
  lines?: Array<{ lineId: string; unitPrice?: number; quantity?: number }>;
  /** C — Pflicht, sobald ein Stückpreis sich ändert. */
  correctionKind?: CorrectionKind;
  /** C, Teil 2 — vergessene Positionen nachtragen. */
  addLines?: PurchaseEditAddLine[];
  /** C, Teil 3 — unberührte Positionen entfernen. */
  removeLineIds?: string[];
}

/** Teil 2 — eine nachgetragene Position: ein vorhandener Artikel oder ein neuer (dieselbe Maske „New Item" wie beim Anlegen). */
export interface PurchaseEditAddLine {
  mode: 'existing' | 'new';
  productId?: string;
  /** Der Artikel-Entwurf (Kategorie, Merkmale, Fotos …) wie bei „Save Purchase"; Einstand und Menge kommen aus der Zeile. */
  newProduct?: Partial<Product>;
  quantity: number;
  /** Brutto je Stück, wie beim Anlegen. */
  unitPrice: number;
}

/** So viele Positionen trägt eine Bearbeitung höchstens nach. */
export const MAX_ADD_LINES = 50;

/** Eine geplante Position: geprüft wie bei „Save Purchase", noch nichts geschrieben, noch keine SKU vergeben. */
export interface PlannedAddLine { line: Record<string, unknown>; lineTotal: number }

/**
 * Teil 2 — was die Hausfolge von der Zeilenfolge des Einkaufs braucht (`purchase-lines.ts`): diese Datei importiert
 * keinen Store, und Artikel legt `createProduct` an. Primary (`editPurchaseOnPrimary`) und PC2 (`runPurchaseEdit`)
 * reichen DIESELBE Folge herein.
 */
export interface PurchaseLineOps {
  /** Nur lesend: prüfen und planen. Ein Nein ist ein `PurchaseEditRejected`. */
  planAdd(lines: readonly PurchaseEditAddLine[], taxScheme: 'ZERO' | 'VAT_10', branchId: string): PlannedAddLine[];
  /** Schreibend, in der Klammer des Aufrufers: SKU vergeben, Artikel anlegen, Zeilen, Lose, Menge, Lagerstatus. */
  append(purchaseId: string, purchaseDate: string, planned: readonly PlannedAddLine[], ctx: HouseCtx): Array<{ id: string; productId: string; createdProduct: boolean }>;
}

export interface PurchaseEdited {
  purchaseId: string;
  purchaseNumber: string;
  editId: string;
  editNo: number;
  kinds: string[];
  totalAmount: number;
  remainingAmount: number;
  status: PurchaseStatus;
  revision: number;
  overpayCredit: number;
  corrections: Array<{ correctionNumber: string; invoiceNumber: string; amount: number; economicDate: string; vatEstimate: number }>;
  /** Teil 2/3 — die nachgetragenen und die entfernten Zeilen, und welche Artikel mit ihrer Zeile gingen. */
  addedLineIds: string[];
  removedLineIds: string[];
  removedProductIds: string[];
}

// ── Die Sperren (eine Quelle für Maske und Hausfolge) ──────────────────────

export type EditLock = { allowed: true; note?: string } | { allowed: false; code: string; reason: string };
const offen = (note?: string): EditLock => (note ? { allowed: true, note } : { allowed: true });
const zu = (code: string, reason: string): EditLock => ({ allowed: false, code, reason });

export interface PurchaseEditLineCheck {
  lineId: string;
  productId: string | null;
  quantity: number;
  unitPrice: number;
  taxScheme: string;
  price: EditLock;
  quantityLock: EditLock;
  /** So viele Stücke dieser Zeile sind verkauft und würden eine Einstandskorrektur bekommen (D1). */
  soldUnits: number;
  /** D13 — gehört der Einkaufspreis des Artikels dieser Zeile (er folgt der Korrektur)? */
  productFollows: boolean;
  /** Teil 3 — darf diese Position entfernt werden (unberührt im Lager, an nichts gebunden)? */
  remove: EditLock;
  /** Teil 3 — ginge der Artikel mit (von dieser Zeile angelegt, an nichts sonst gebunden)? Sonst bleibt er. */
  removesProduct: boolean;
}

export interface PurchaseEditCheck {
  purchaseId: string;
  purchaseNumber: string;
  revision: number;
  status: string;
  notes: EditLock;
  staff: EditLock;
  identityPhoto: EditLock;
  date: EditLock;
  supplier: EditLock;
  lines: PurchaseEditLineCheck[];
  /** Gilt für jeden Preis: Erfassungsfehler aktiv, späterer Rabatt gesperrt (D1). */
  correctionKinds: Array<{ kind: CorrectionKind; allowed: boolean; reason?: string }>;
  cutoverDate: string;
  /** Live gebuchte Zahlungen (bar/Bank/Benefit) — beim Lieferantenwechsel zu bestätigen (D5). */
  livePayments: number;
  /** Teil 2 — dürfen Positionen nachgetragen werden? */
  addLines: EditLock;
  /** Teil 2 — das Steuerschema einer nachgetragenen Position: das des Einkaufs. */
  addTaxScheme: 'ZERO' | 'VAT_10';
}

interface Kontext {
  p: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  consumption: Map<string, PurchaseLineConsumption>;
  partnerLines: Set<string>;
  hasReturn: boolean;
  consignment: boolean;
  consignmentByNoteOnly: boolean;
  bulk: boolean;
  needsLedger: boolean;
  hasLedger: boolean;
  beforeCutover: boolean;
  vat10: boolean;
  currentQuarter: string;
  purchaseQuarter: string;
  closed: Set<string>;
  creditPaidF: number;
  overpayCredit: boolean;
  livePayments: Array<Record<string, unknown>>;
  /** Teil 2 — das eine Steuerschema der Zeilen (eine nachgetragene Zeile übernimmt es); `null` = gemischt. */
  addScheme: 'ZERO' | 'VAT_10' | null;
}

function assertBooks(): void {
  if (isClientMode()) {
    throw nein(PURCHASE_EDIT_PRIMARY_ONLY, 'this happens on the main computer — this window has no business database');
  }
}

function livePurchase(id: string, branchId: string): Record<string, unknown> {
  const r = query('SELECT * FROM purchases WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!r) throw nein('PURCHASE_NOT_FOUND', 'no such purchase in this branch');
  return r;
}

const revisionOf = (purchaseId: string): number =>
  Number(query('SELECT revision FROM purchases WHERE id = ?', [purchaseId])[0]?.revision ?? 0);

function assertSeen(purchaseId: string, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = revisionOf(purchaseId);
  if (now !== expected) {
    throw nein('RECORD_CHANGED', `this purchase changed since you opened it (you saw ${expected}, it is now ${now}) — reload and try again`);
  }
}

/** Live gebuchte (nicht stornierte) Zahlungen eines Einkaufs. */
function paymentsOf(purchaseId: string): Array<Record<string, unknown>> {
  return query(
    'SELECT * FROM purchase_payments WHERE purchase_id = ? AND voided_at IS NULL ORDER BY paid_at ASC, created_at ASC, id ASC',
    [purchaseId],
  );
}

function kontext(purchaseId: string, branchId: string, now: string): Kontext {
  const p = livePurchase(purchaseId, branchId);
  const lines = query('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position, id', [purchaseId]);
  const consumption = new Map(purchaseLineConsumption(purchaseId).map((c) => [c.lineId, c]));
  const partnerLines = new Set(query('SELECT DISTINCT purchase_line_id FROM item_participations WHERE purchase_id = ?', [purchaseId])
    .map((r) => String(r.purchase_line_id)));
  const hasReturn = !!query(`SELECT 1 FROM purchase_returns WHERE purchase_id = ? AND status != 'CANCELLED' LIMIT 1`, [purchaseId])[0];
  const byColumn = !!p.source_consignment_id;
  const byNote = !byColumn && /^Consignor payout/.test(String(p.notes ?? ''));
  const bulk = lines.some((l) => isBulkMetalProduct(String(l.product_id ?? '')));
  const needsLedger = F(p.total_amount) > 0;
  const hasLedger = hasLedgerEntries('PURCHASE', purchaseId);
  const purchaseDate = String(p.purchase_date ?? '');
  const vat10 = lines.some((l) => String(l.tax_scheme ?? '') === 'VAT_10' || Number(l.vat_amount ?? 0) > EPS);
  const creditPaidF = F(query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = 'credit' AND voided_at IS NULL`,
    [purchaseId],
  )[0]?.t);
  const overpayCredit = !!query(
    'SELECT 1 FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL LIMIT 1', [purchaseId],
  )[0];
  const schemes = new Set(lines.map((l) => (String(l.tax_scheme ?? '') === 'VAT_10' || Number(l.vat_amount ?? 0) > EPS ? 'VAT_10' : 'ZERO')));
  const addScheme = schemes.size === 0 ? 'ZERO' : schemes.size === 1 ? ([...schemes][0] as 'ZERO' | 'VAT_10') : null;
  return {
    addScheme,
    p, lines, consumption, partnerLines, hasReturn,
    consignment: byColumn || byNote, consignmentByNoteOnly: byNote,
    bulk, needsLedger, hasLedger,
    beforeCutover: purchaseDate < OPENING_CUTOFF_DATE,
    vat10,
    currentQuarter: nbrQuarterOfDate(dayOf(now))?.key ?? '',
    purchaseQuarter: nbrQuarterOfDate(purchaseDate)?.key ?? '',
    closed: new Set(closedVatQuarters(branchId).keys()),
    creditPaidF, overpayCredit,
    livePayments: paymentsOf(purchaseId).filter((pp) => String(pp.method) !== 'credit'),
  };
}

/** Die Sperren aller Finanzfelder (C), die nicht vom einzelnen Feld abhängen. */
function finanzSperre(k: Kontext): EditLock {
  if (String(k.p.status) === 'CANCELLED') return zu('PURCHASE_CANCELLED', 'A cancelled purchase is not edited.');
  if (k.consignment) {
    return zu('PURCHASE_EDIT_CONSIGNMENT', 'This is the automatic purchase of a consignment sale — correct it through the consignment.');
  }
  if (k.bulk) {
    return zu('PURCHASE_EDIT_BULK', 'Bulk metal is corrected as in its specification: cancel the unused purchase and enter it again.');
  }
  if (k.hasReturn) {
    return zu('PURCHASE_EDIT_HAS_RETURN', 'This purchase has a supplier return. Cancel the return first, correct, then return again.');
  }
  if (k.needsLedger && !k.hasLedger) {
    return zu('PURCHASE_EDIT_NO_LEDGER', 'This purchase has no accounting entry. It has to be reconciled before amounts can be corrected.');
  }
  return offen();
}

/** Vorsteuer nur im laufenden, offenen Quartal (sonst verschöbe die Neubuchung sie — D2/D4). */
function vorsteuerSperre(k: Kontext): EditLock {
  if (!k.vat10) return offen();
  if (k.closed.has(k.purchaseQuarter)) {
    return zu('PURCHASE_EDIT_VAT_PERIOD', `The VAT quarter ${k.purchaseQuarter} of this purchase is filed — its input VAT is not changed.`);
  }
  if (k.purchaseQuarter !== k.currentQuarter) {
    return zu('PURCHASE_EDIT_VAT_PERIOD',
      `This purchase carries input VAT in ${k.purchaseQuarter}. Until the accountant confirms a rule, its amounts are only corrected within the current quarter (${k.currentQuarter}).`);
  }
  return offen();
}

const vorStichtag = (): EditLock => zu('PURCHASE_EDIT_BEFORE_CUTOVER',
  `This purchase is dated before the opening cut-off (${OPENING_CUTOFF_DATE}). Its amounts wait for the accountant to confirm the opening balances.`);

/** Darf der Stückpreis dieser Zeile sich ändern — auch wenn schon verkauft wurde (D1)? */
function preisSperre(k: Kontext, line: Record<string, unknown>): EditLock {
  const base = finanzSperre(k);
  if (!base.allowed) return base;
  if (k.beforeCutover) return vorStichtag();
  const v = vorsteuerSperre(k);
  if (!v.allowed) return v;
  const lineId = String(line.id);
  if (k.partnerLines.has(lineId)) {
    return zu('PURCHASE_EDIT_PARTNER_LINE', 'This item was bought together with a partner. Its amounts stay as they are until the accountant settles the gross/net basis.');
  }
  const c = k.consumption.get(lineId);
  if (c) {
    if (c.agentHeld > 0) return zu('PURCHASE_EDIT_SOLD_VIA_AGENT', 'An item from this line was sold by an agent and is not invoiced yet.');
    if (c.production > 0) return zu('PURCHASE_EDIT_IN_PRODUCTION', 'An item from this line was used in a production.');
    if (c.adjustments > 0) return zu('PURCHASE_EDIT_STOCK_ADJUSTED', 'An item from this line was written off by a stock correction.');
    for (const s of c.sales) {
      if (s.unitsInCogs <= 0) continue;
      if (s.viaAgent) return zu('PURCHASE_EDIT_SOLD_VIA_AGENT', `An item from this line was sold through an agent (${s.invoiceNumber}).`);
      if (!s.hasCogs) return zu('PURCHASE_EDIT_SALE_WITHOUT_COGS', `The sale ${s.invoiceNumber} has no cost-of-sales entry — it has to be reconciled first.`);
      if (s.issuedDate < OPENING_CUTOFF_DATE) {
        return zu('PURCHASE_EDIT_SALE_BEFORE_CUTOVER', `The sale ${s.invoiceNumber} is dated before the opening cut-off (${OPENING_CUTOFF_DATE}).`);
      }
    }
    const sold = c.sales.reduce((n, s) => n + s.unitsInCogs, 0);
    if (sold > 0) return offen(`${sold} sold — a separate cost correction is recorded, the invoice stays unchanged`);
  }
  return offen();
}

function mengenSperre(k: Kontext, line: Record<string, unknown>): EditLock {
  const base = finanzSperre(k);
  if (!base.allowed) return base;
  if (k.beforeCutover) return vorStichtag();
  const v = vorsteuerSperre(k);
  if (!v.allowed) return v;
  const lineId = String(line.id);
  if (k.partnerLines.has(lineId)) {
    return zu('PURCHASE_EDIT_PARTNER_LINE', 'This item was bought together with a partner. Its quantity stays as it is until the accountant settles the gross/net basis.');
  }
  const c = k.consumption.get(lineId);
  const status = String(query('SELECT stock_status FROM products WHERE id = ?', [String(line.product_id ?? '')])[0]?.stock_status ?? '');
  if (!c || !c.untouched || status !== 'in_stock') {
    return zu('PURCHASE_EDIT_QTY_STOCK_USED', 'The quantity changes only while every piece of this line is still untouched in stock.');
  }
  return offen();
}

/** Teil 2 — Positionen nachtragen: dieselben Sperren wie eine Mengenänderung (Geld, Stichtag, Vorsteuer), ohne Zeile. */
function hinzufuegenSperre(k: Kontext): EditLock {
  const base = finanzSperre(k);
  if (!base.allowed) return base;
  if (k.beforeCutover) return vorStichtag();
  const v = vorsteuerSperre(k);
  if (!v.allowed) return v;
  if (!k.addScheme) {
    return zu('PURCHASE_EDIT_ADD_MIXED_VAT', 'The lines of this purchase carry different input VAT — a new line cannot take one of them over.');
  }
  return offen(k.addScheme === 'VAT_10' ? 'a new line carries 10% input VAT like the purchase' : undefined);
}

/** Spalten, die auf einen Artikel zeigen — und was davon beim Entfernen NICHT als Bindung zählt. */
const ARTIKEL_SPALTE = /(^|_)product_id$/;
// Der Upload-Beleg des Handys geht mit dem Artikel (`purgeProductLeftovers`), wie beim normalen Löschen.
const KEINE_BINDUNG = new Set(['mobile_upload_receipts']);

/**
 * Teil 3 — woran hängt ein Artikel außer an der Zeile `exceptLineId` und ihrem Los? JEDE Tabelle mit einer Spalte
 * `…product_id` zählt (fail-closed: auch eine, die es heute noch nicht gibt). Leer = an nichts.
 */
function artikelBindungen(productId: string, exceptLineId: string): string[] {
  const out: string[] = [];
  const tables = query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((r) => String(r.name)).filter((t) => /^[a-z_][a-z0-9_]*$/.test(t) && !KEINE_BINDUNG.has(t));
  for (const t of tables) {
    for (const col of query(`PRAGMA table_info(${t})`).map((c) => String(c.name)).filter((c) => ARTIKEL_SPALTE.test(c))) {
      let sql = `SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`;
      const params: unknown[] = [productId];
      if (t === 'purchase_lines') { sql += ' AND id != ?'; params.push(exceptLineId); }
      if (t === 'stock_lots') { sql += ` AND COALESCE(purchase_line_id, '') != ?`; params.push(exceptLineId); }
      const n = Number(query(sql, params)[0]?.n ?? 0);
      if (n > 0) out.push(`${t}.${col}`);
    }
  }
  return out;
}

/** Teil 3 — ginge der Artikel dieser Zeile beim Entfernen mit? Nur wenn SIE ihn angelegt hat und nichts sonst an ihm hängt. */
function artikelGehtMit(line: Record<string, unknown>): boolean {
  const productId = String(line.product_id ?? '');
  if (!productId || isBulkMetalProduct(productId)) return false;
  // Eine Altzeile ohne Vermerk (`created_product` NULL) gilt nicht als Anlegerin — der Artikel bleibt (fail-closed).
  if (Number(line.created_product) !== 1) return false;
  return artikelBindungen(productId, String(line.id)).length === 0;
}

/**
 * Teil 3 — eine Position entfernen: nur, solange jedes ihrer Stücke unberührt im Lager liegt (nicht verkauft,
 * reserviert, zurückgegeben, in Kommission, in Produktion, abgeschrieben oder sonst bewegt) und sie an nichts
 * gebunden ist (Partner, Kundenauftrag). Dazu die Sperren jeder Geldkorrektur. Die letzte Position bleibt.
 */
function entfernenSperre(k: Kontext, line: Record<string, unknown>): EditLock {
  const base = finanzSperre(k);
  if (!base.allowed) return base;
  if (k.beforeCutover) return vorStichtag();
  const v = vorsteuerSperre(k);
  if (!v.allowed) return v;
  const lineId = String(line.id);
  if (k.partnerLines.has(lineId)) {
    return zu('PURCHASE_EDIT_PARTNER_LINE', 'This item was bought together with a partner. Its line stays until the accountant settles the gross/net basis.');
  }
  if (line.source_order_line_id) {
    return zu('PURCHASE_EDIT_REMOVE_ORDER_LINE', 'This line received an item for a customer order. It is not removed here — change the order, or cancel the purchase.');
  }
  const c = k.consumption.get(lineId);
  const status = String(query('SELECT stock_status FROM products WHERE id = ?', [String(line.product_id ?? '')])[0]?.stock_status ?? '');
  if (!line.product_id || !c || !c.untouched || status !== 'in_stock') {
    return zu('PURCHASE_EDIT_REMOVE_STOCK_USED',
      'Only a line whose items are all still untouched in stock can be removed — not sold, reserved, returned, on consignment, in production, written off or moved.');
  }
  if (k.lines.length <= 1) {
    return zu('PURCHASE_EDIT_LAST_LINE', 'This is the only line of the purchase. To undo the whole purchase, use Cancel Purchase.');
  }
  return offen(artikelGehtMit(line)
    ? 'the item was created by this line and is removed with it'
    : 'only this purchase line and its stock lot are removed — the item itself stays');
}

function lieferantSperre(k: Kontext): EditLock {
  const base = finanzSperre(k);
  if (!base.allowed) return base;
  if (k.beforeCutover) return vorStichtag();
  const v = vorsteuerSperre(k);
  if (!v.allowed) return v;
  if (k.creditPaidF > 0) {
    return zu('PURCHASE_EDIT_SUPPLIER_CREDIT_PAID', 'Part of this purchase was settled with the supplier\'s own credit — that credit is not moved to another supplier.');
  }
  if (k.overpayCredit) {
    return zu('PURCHASE_EDIT_SUPPLIER_OVERPAY', 'An overpayment of this purchase became supplier credit — settle or reverse it first.');
  }
  return offen(k.livePayments.length > 0
    ? `${k.livePayments.length} payment(s) are booked over to the new supplier — confirm they really went to that supplier`
    : undefined);
}

function datumSperre(k: Kontext): EditLock {
  const base = finanzSperre(k);
  if (!base.allowed) return base;
  return offen(k.vat10 ? 'with input VAT the date stays within its open quarter' : undefined);
}

/** D13 — folgt der Einkaufspreis des Artikels dieser Zeile? (angelegt von ihr, oder der Wert spiegelt sie noch genau) */
function artikelFolgt(line: Record<string, unknown>): boolean {
  const productId = String(line.product_id ?? '');
  if (!productId || isBulkMetalProduct(productId)) return false;
  if (line.created_product !== null && line.created_product !== undefined) return Number(line.created_product) === 1;
  // Altzeile: nur wenn sie die EINZIGE wirksame Einkaufszeile des Artikels ist und sein Preis sie genau spiegelt.
  const n = Number(query(
    `SELECT COUNT(*) AS c FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.product_id = ? AND p.status != 'CANCELLED'`, [productId],
  )[0]?.c ?? 0);
  if (n !== 1) return false;
  const pp = query('SELECT purchase_price FROM products WHERE id = ?', [productId])[0];
  return !!pp && Math.abs(Number(pp.purchase_price || 0) - Number(line.unit_price || 0)) < EPS;
}

/** Die Auskunft der Maske — dieselben Sperren, die die Hausfolge prüft. Nur lesend. */
export function purchaseEditCheck(purchaseId: string, branchId: string, now: string): PurchaseEditCheck {
  const k = kontext(purchaseId, branchId, now);
  const cancelled = String(k.p.status) === 'CANCELLED';
  const aSperre = cancelled ? zu('PURCHASE_CANCELLED', 'A cancelled purchase is not edited.') : offen();
  const notes = !aSperre.allowed ? aSperre : k.consignmentByNoteOnly
    ? zu('PURCHASE_EDIT_CONSIGNMENT_NOTE', 'The note of this consignment purchase still carries its link — it is not changed.')
    : offen();
  return {
    purchaseId,
    purchaseNumber: String(k.p.purchase_number ?? ''),
    revision: Number(k.p.revision ?? 0),
    status: String(k.p.status ?? ''),
    notes,
    staff: aSperre,
    identityPhoto: aSperre,
    date: datumSperre(k),
    supplier: lieferantSperre(k),
    lines: k.lines.map((l) => {
      const c = k.consumption.get(String(l.id));
      return {
        lineId: String(l.id),
        productId: l.product_id ? String(l.product_id) : null,
        quantity: Number(l.quantity) || 0,
        unitPrice: Number(l.unit_price) || 0,
        taxScheme: String(l.tax_scheme ?? 'ZERO'),
        price: preisSperre(k, l),
        quantityLock: mengenSperre(k, l),
        soldUnits: c ? c.sales.reduce((n, s) => n + s.unitsInCogs, 0) : 0,
        productFollows: artikelFolgt(l),
        remove: entfernenSperre(k, l),
        removesProduct: artikelGehtMit(l),
      };
    }),
    addLines: hinzufuegenSperre(k),
    addTaxScheme: k.addScheme ?? 'ZERO',
    correctionKinds: [
      { kind: 'ENTRY_ERROR', allowed: true },
      { kind: 'SUPPLIER_DISCOUNT', allowed: false, reason: 'A later discount from the supplier is not booked yet — the accountant decides its treatment first.' },
    ],
    cutoverDate: OPENING_CUTOFF_DATE,
    livePayments: k.livePayments.length,
  };
}

function wirf(l: EditLock): void {
  if (!l.allowed) throw nein(l.code, l.reason);
}

// ── Der Zustand fürs Protokoll (Vorher/Nachher) ─────────────────────────────

function belegZustand(purchaseId: string): Record<string, unknown> {
  const p = query(
    `SELECT purchase_number, supplier_id, status, total_amount, paid_amount, remaining_amount, purchase_date, notes, staff_id,
            supplier_snapshot, revision FROM purchases WHERE id = ?`, [purchaseId],
  )[0] ?? {};
  let snapshot: unknown = null;
  try { snapshot = p.supplier_snapshot ? JSON.parse(String(p.supplier_snapshot)) : null; } catch { snapshot = null; }
  // Nur Referenzen — nie Bildbytes ins Protokoll.
  if (snapshot && typeof snapshot === 'object') {
    const s = { ...(snapshot as Record<string, unknown>) };
    if (typeof s.cprImage === 'string') s.cprImage = '[legacy image]';
    if (Array.isArray(s.cprImageRetired)) s.cprImageRetired = (s.cprImageRetired as unknown[]).map(() => '[legacy image]');
    snapshot = s;
  }
  return {
    header: {
      purchaseNumber: p.purchase_number, supplierId: p.supplier_id, status: p.status, totalAmount: p.total_amount,
      paidAmount: p.paid_amount, remainingAmount: p.remaining_amount, purchaseDate: p.purchase_date, notes: p.notes ?? null,
      staffId: p.staff_id ?? null, revision: p.revision,
    },
    supplierSnapshot: snapshot,
    lines: query(
      'SELECT id, product_id, quantity, unit_price, line_total, tax_scheme, vat_rate, vat_amount FROM purchase_lines WHERE purchase_id = ? ORDER BY position, id',
      [purchaseId],
    ),
    lots: query('SELECT id, purchase_line_id, unit_cost, qty_total, qty_remaining, acquired_at, status FROM stock_lots WHERE purchase_id = ? ORDER BY id', [purchaseId]),
    payments: query('SELECT id, amount, method, paid_at, reference, voided_at FROM purchase_payments WHERE purchase_id = ? ORDER BY created_at, id', [purchaseId]),
  };
}

// ── Ausweisfoto ─────────────────────────────────────────────────────────────

/** Die aktuelle Fassung eines (aufgenommenen) Mediums als Einkaufsnachweis — oder Nein. */
function nachweisVon(mediaId: string, owner: { ownerType: 'customer' | 'supplier'; ownerId: string }): PurchaseIdentityReference {
  const r = query(
    `SELECT o.media_id, g.generation_no, g.stored_blob_hash, g.byte_size, g.storage_key, g.extension
       FROM media_objects o
       JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id AND b.blob_status = 'present'
       JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                    AND g.generation_no = b.current_generation_no AND g.gen_status = 'available'
      WHERE o.media_id = ? AND o.deleted_at IS NULL AND o.ingest_status = 'ready'`,
    [mediaId],
  )[0];
  if (!r) throw nein('IDENTITY_PHOTO_NOT_FOUND', 'the new ID photo is not available — take or choose it again');
  return {
    mediaId: String(r.media_id), generationNo: Number(r.generation_no), blobHash: String(r.stored_blob_hash),
    byteSize: Number(r.byte_size), storageKey: String(r.storage_key), extension: String(r.extension),
    ownerType: owner.ownerType, ownerId: owner.ownerId,
  };
}

/** Die alte Fassung wandert verborgen in `identityRetired` (D10: nie angezeigt, aufbewahrt). */
function zurueckstellen(snap: SupplierSnapshot, retiredAt: string): void {
  if (snap.identity) {
    snap.identityRetired = [...(snap.identityRetired ?? []), { ...snap.identity, retiredAt }];
    delete snap.identity;
  }
  if (snap.cprImage) {
    const s = snap as SupplierSnapshot & { cprImageRetired?: string[] };
    s.cprImageRetired = [...(s.cprImageRetired ?? []), snap.cprImage];
    delete snap.cprImage;
  }
}

function snapshotOf(p: Record<string, unknown>, now: string): SupplierSnapshot {
  try {
    const s = p.supplier_snapshot ? JSON.parse(String(p.supplier_snapshot)) as SupplierSnapshot : null;
    if (s && typeof s === 'object') return s;
  } catch { /* unten neu */ }
  return { name: '', snapshotAt: now };
}

/** D5 — die Stammdaten des neuen Lieferanten einfrieren (wie beim Anlegen), das Alte verborgen behalten. */
function lieferantEinfrieren(snap: SupplierSnapshot, oldSupplierId: string, newSupplierId: string, now: string): SupplierSnapshot {
  const sup = query('SELECT name, phone, email, address, cpr FROM suppliers WHERE id = ?', [newSupplierId])[0] ?? {};
  const out: SupplierSnapshot = {
    ...snap,
    name: String(sup.name ?? ''),
    phone: (sup.phone as string) || undefined,
    email: (sup.email as string) || undefined,
    address: (sup.address as string) || undefined,
    cpr: (sup.cpr as string) || undefined,
    snapshotAt: now,
    previousSuppliers: [...(snap.previousSuppliers ?? []), { supplierId: oldSupplierId, name: snap.name, replacedAt: now }],
  };
  zurueckstellen(out, now);
  const doc = identityDocumentFor('supplier', newSupplierId);
  if (doc.ref) {
    out.identity = {
      mediaId: doc.ref.mediaId, generationNo: doc.ref.main.generationNo, blobHash: doc.ref.main.hash,
      byteSize: doc.ref.main.byteSize, storageKey: doc.ref.main.storageKey, extension: doc.ref.main.extension,
      ownerType: doc.source.ownerType, ownerId: doc.source.ownerId,
    };
  } else {
    const legacy = supplierLegacyIdPhoto(newSupplierId);
    if (legacy) out.cprImage = legacy;
  }
  return out;
}

// ── Die Hausfolge ───────────────────────────────────────────────────────────

const textOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};

/** Die Margen-VAT eines Stücks, wie die Rechnung sie aus dem Einstand rechnet (calcMarginFromNet). */
function marginVatPerUnit(saleUnit: number, cost: number, rate: number): number {
  const margin = Math.max(0, saleUnit - cost);
  return margin * rate / (100 + rate);
}

/** Einen Einkauf für die Buchung aus der Datenbank bauen (die Hausfolge kennt den Store nicht). */
function belegFuerBuchung(purchaseId: string): Purchase {
  const p = query('SELECT * FROM purchases WHERE id = ?', [purchaseId])[0] ?? {};
  const lines = query('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position, id', [purchaseId]);
  return {
    id: purchaseId, purchaseNumber: String(p.purchase_number ?? ''), branchId: String(p.branch_id ?? ''),
    supplierId: String(p.supplier_id ?? ''), status: String(p.status ?? '') as PurchaseStatus,
    totalAmount: Number(p.total_amount) || 0, paidAmount: Number(p.paid_amount) || 0, remainingAmount: Number(p.remaining_amount) || 0,
    purchaseDate: String(p.purchase_date ?? ''), createdAt: String(p.created_at ?? ''), updatedAt: String(p.updated_at ?? ''),
    payments: [],
    lines: lines.map((l) => ({
      id: String(l.id), purchaseId, productId: l.product_id ? String(l.product_id) : undefined,
      quantity: Number(l.quantity) || 1, unitPrice: Number(l.unit_price) || 0, lineTotal: Number(l.line_total) || 0,
      position: Number(l.position) || 0, taxScheme: (l.tax_scheme as 'ZERO' | 'VAT_10' | null) || undefined,
      vatRate: l.vat_rate !== null && l.vat_rate !== undefined ? Number(l.vat_rate) : undefined,
      vatAmount: l.vat_amount !== null && l.vat_amount !== undefined ? Number(l.vat_amount) : undefined,
    })),
  };
}

function statusOf(totalF: number, settledF: number): PurchaseStatus {
  if (totalF <= 0) return 'DRAFT';
  if (settledF <= 0) return 'UNPAID';
  if (settledF >= totalF) return 'PAID';
  return 'PARTIALLY_PAID';
}

/**
 * „Save" der Einkaufsbearbeitung. Alle Regeln stehen vor dem ersten Schreiben; in der Transaktion des
 * Aufrufers (Primary: `runOnPrimary`, PC2: `runRemoteCommand`).
 */
export function editPurchaseInHouse(
  req: PurchaseEditRequest, ctx: HouseCtx, expectedRevision?: number, ops?: PurchaseLineOps,
): PurchaseEdited {
  assertBooks();
  const k = kontext(req.purchaseId, ctx.branchId, ctx.now);
  assertSeen(req.purchaseId, expectedRevision);
  const p = k.p;
  const purchaseId = req.purchaseId;
  const reason = typeof req.reason === 'string' ? req.reason.trim() : '';
  if (!reason) throw nein('PURCHASE_EDIT_REASON_REQUIRED', 'Please enter a reason for this edit.');
  if (String(p.status) === 'CANCELLED') throw nein('PURCHASE_CANCELLED', 'A cancelled purchase is not edited.');

  // ── 1. Was ändert sich? ──
  const kinds: string[] = [];
  const oldNotes = textOrNull(p.notes);
  const newNotes = req.notes === undefined ? oldNotes : textOrNull(req.notes);
  if (newNotes !== oldNotes) kinds.push('NOTES');
  const oldStaff = textOrNull(p.staff_id);
  const newStaff = req.staffId === undefined ? oldStaff : textOrNull(req.staffId);
  if (newStaff !== oldStaff) kinds.push('STAFF');
  if (req.identityPhoto) kinds.push('IDENTITY_PHOTO');
  const oldDate = String(p.purchase_date ?? '');
  const newDate = req.purchaseDate === undefined ? oldDate : String(req.purchaseDate);
  if (newDate !== oldDate) kinds.push('DATE');
  const oldSupplier = String(p.supplier_id ?? '');
  const newSupplier = req.supplierId === undefined ? oldSupplier : String(req.supplierId);
  if (newSupplier !== oldSupplier) kinds.push('SUPPLIER');

  const lineById = new Map(k.lines.map((l) => [String(l.id), l]));
  const changes: Array<{ line: Record<string, unknown>; qty: number; price: number; priceChanged: boolean; qtyChanged: boolean }> = [];
  const seen = new Set<string>();
  for (const l of req.lines ?? []) {
    if (seen.has(l.lineId)) throw nein('PURCHASE_EDIT_LINE_DUPLICATE', 'the same line twice is not an edit');
    seen.add(l.lineId);
    const line = lineById.get(l.lineId);
    if (!line) throw nein('PURCHASE_EDIT_LINE_UNKNOWN', 'a changed line is not a line of this purchase');
    const oldQty = Number(line.quantity) || 1;
    const oldPrice = Number(line.unit_price) || 0;
    const qty = l.quantity === undefined ? oldQty : l.quantity;
    const price = l.unitPrice === undefined ? oldPrice : l.unitPrice;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
      throw nein('PURCHASE_EDIT_QTY_INVALID', 'the quantity is a whole number of at least 1');
    }
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      throw nein('PURCHASE_EDIT_PRICE_INVALID', 'the unit price is a number of at least 0');
    }
    const priceChanged = F(price) !== F(oldPrice);
    const qtyChanged = qty !== oldQty;
    if (priceChanged || qtyChanged) changes.push({ line, qty, price: B(F(price)), priceChanged, qtyChanged });
  }
  if (changes.some((c) => c.priceChanged)) kinds.push('PRICE');
  if (changes.some((c) => c.qtyChanged)) kinds.push('QUANTITY');
  // Teil 3 — die zu entfernenden Positionen (eine Zeile wird entweder berichtigt oder entfernt).
  const removeIds: string[] = [];
  for (const raw of req.removeLineIds ?? []) {
    const lineId = String(raw ?? '');
    if (removeIds.includes(lineId)) throw nein('PURCHASE_EDIT_LINE_DUPLICATE', 'the same line twice is not an edit');
    if (!lineById.has(lineId)) throw nein('PURCHASE_EDIT_LINE_UNKNOWN', 'a removed line is not a line of this purchase');
    if (seen.has(lineId)) throw nein('PURCHASE_EDIT_LINE_CONFLICT', 'a line is either corrected or removed, not both');
    removeIds.push(lineId);
  }
  if (removeIds.length > 0) kinds.push('REMOVE_LINE');
  // Teil 2 — die nachzutragenden Positionen.
  const adds = req.addLines ?? [];
  if (adds.length > MAX_ADD_LINES) throw nein('PURCHASE_EDIT_ADD_TOO_MANY', `at most ${MAX_ADD_LINES} lines are added in one edit`);
  if (adds.length > 0) kinds.push('ADD_LINE');
  if (kinds.length === 0) throw nein('PURCHASE_EDIT_NOTHING', 'Nothing was changed.');

  // ── 2. Die Regeln — alle VOR dem ersten Schreiben ──
  const check = purchaseEditCheck(purchaseId, ctx.branchId, ctx.now);
  if (kinds.includes('NOTES')) wirf(check.notes);
  if (kinds.includes('STAFF')) {
    wirf(check.staff);
    if (newStaff && !query(
      "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
      [newStaff, ctx.branchId],
    )[0]) throw nein('EMPLOYEE_NOT_FOUND', 'no such active employee in this branch');
  }
  if (kinds.includes('IDENTITY_PHOTO')) wirf(check.identityPhoto);
  if (kinds.includes('DATE')) {
    wirf(check.date);
    const issue = businessDateIssue(newDate, 'The purchase date', Date.parse(ctx.now));
    if (issue || !newDate) throw nein('PURCHASE_EDIT_DATE_INVALID', issue ?? 'The purchase date is required');
    // Über den Eröffnungsstichtag hinweg verschöbe der Einkauf seine Eröffnungswerte (D1-Vorbehalt).
    if ((oldDate < OPENING_CUTOFF_DATE) !== (newDate < OPENING_CUTOFF_DATE)) {
      throw nein('PURCHASE_EDIT_BEFORE_CUTOVER', `The date cannot move across the opening cut-off (${OPENING_CUTOFF_DATE}).`);
    }
    if (k.vat10) {
      const q = nbrQuarterOfDate(newDate)?.key ?? '';
      if (q !== k.purchaseQuarter || k.closed.has(q) || k.closed.has(k.purchaseQuarter)) {
        throw nein('PURCHASE_EDIT_VAT_PERIOD', `With input VAT the date stays within its open quarter (${k.purchaseQuarter}).`);
      }
    }
  }
  if (kinds.includes('SUPPLIER')) {
    wirf(check.supplier);
    if (!query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [newSupplier, ctx.branchId])[0]) {
      throw nein('SUPPLIER_NOT_FOUND', 'no such active supplier in this branch');
    }
    if (k.livePayments.length > 0 && req.confirmPaymentsToNewSupplier !== true) {
      throw nein('PURCHASE_EDIT_CONFIRM_PAYMENTS',
        'This purchase is already paid (partly). Confirm that the payments really went to the new supplier — they are booked over to it.');
    }
  }
  const lineChecks = new Map(check.lines.map((l) => [l.lineId, l]));
  for (const c of changes) {
    const lc = lineChecks.get(String(c.line.id))!;
    if (c.priceChanged) wirf(lc.price);
    if (c.qtyChanged) wirf(lc.quantityLock);
  }
  if (changes.some((c) => c.priceChanged)) {
    if (!isCorrectionKind(req.correctionKind)) {
      throw nein('PURCHASE_EDIT_CORRECTION_KIND_REQUIRED', 'Say what kind of correction this is: an entry error or a later discount from the supplier.');
    }
    if (req.correctionKind === 'SUPPLIER_DISCOUNT') {
      throw nein('PURCHASE_EDIT_DISCOUNT_NOT_ENABLED', 'A later discount from the supplier is not booked yet — the accountant decides its treatment first.');
    }
  }

  // Teil 3 — jede Position einzeln geprüft, und eine bleibt immer (für alles andere gibt es „Cancel Purchase").
  const removed = new Set(removeIds);
  for (const lineId of removeIds) wirf(lineChecks.get(lineId)!.remove);
  if (removeIds.length > 0 && removeIds.length >= k.lines.length) {
    throw nein('PURCHASE_EDIT_LAST_LINE', 'At least one line of the purchase stays. To undo the whole purchase, use Cancel Purchase.');
  }
  // Teil 2 — geprüft und geplant wie bei „Save Purchase"; geschrieben (und eine SKU vergeben) wird erst unten.
  let planned: PlannedAddLine[] = [];
  if (adds.length > 0) {
    wirf(check.addLines);
    if (!ops) throw nein('PURCHASE_EDIT_ADD_UNAVAILABLE', 'adding lines needs the purchase line flow of the main computer');
    planned = ops.planAdd(adds, check.addTaxScheme, ctx.branchId);
    if (planned.length !== adds.length) throw nein('PURCHASE_EDIT_ADD_INVALID', 'a new line could not be planned');
  }

  // Die neuen Summen — und ob die Zahlungen dazu passen.
  const neu = new Map(changes.map((c) => [String(c.line.id), c]));
  let newTotalF = 0;
  for (const l of k.lines) {
    if (removed.has(String(l.id))) continue;
    const c = neu.get(String(l.id));
    newTotalF += c ? F(c.qty * c.price) : F(l.line_total);
  }
  for (const pl of planned) newTotalF += F(pl.lineTotal);
  const cashF = F(p.paid_amount);
  const settledF = cashF + k.creditPaidF;
  if (k.creditPaidF > 0 && newTotalF < settledF) {
    throw nein('PURCHASE_EDIT_BELOW_CREDIT_SETTLED',
      `This purchase is partly settled with supplier credit (${fmt(B(k.creditPaidF))}). The new total (${fmt(B(newTotalF))}) cannot be lower than what is settled (${fmt(B(settledF))}).`);
  }
  try { assertSupplierOverpayMutable(purchaseId, B(cashF), B(newTotalF)); } catch (e) {
    if (e instanceof OverpayCreditRedeemed) throw nein(e.code, e.message);
    throw e;
  }

  // D1 — die Einstandskorrekturen der schon verkauften Stücke, vorab gerechnet.
  type Korrektur = {
    line: Record<string, unknown>; sale: PurchaseLineConsumption['sales'][number];
    unitDelta: number; amount: number; oldUnit: number; newUnit: number; vatEstimate: number;
  };
  const korrekturen: Korrektur[] = [];
  const lotDelta = new Map<string, number>();
  for (const c of changes) {
    if (!c.priceChanged) continue;
    const l = c.line;
    const oldUnit = purchaseLotUnitCost({ qty: Number(l.quantity) || 1, unitPrice: Number(l.unit_price) || 0,
      lineTotal: Number(l.line_total) || 0, vatAmount: Number(l.vat_amount) || 0 });
    const rate = Number(l.vat_rate ?? 0) || 0;
    const lt = c.qty * c.price;
    const vat = rate > 0 ? lt * rate / (100 + rate) : 0;
    const newUnit = purchaseLotUnitCost({ qty: c.qty, unitPrice: c.price, lineTotal: lt, vatAmount: vat });
    const unitDelta = newUnit - oldUnit;
    lotDelta.set(String(l.id), unitDelta);
    const cons = k.consumption.get(String(l.id));
    for (const s of cons?.sales ?? []) {
      if (s.unitsInCogs <= 0) continue;
      const amount = R3(unitDelta * s.unitsInCogs);
      if (Math.abs(amount) < EPS) continue;
      const before = s.snapshotUnitCost + Number(query(
        `SELECT COALESCE(SUM(unit_delta), 0) AS d FROM cost_corrections WHERE invoice_line_id = ? AND status = 'ACTIVE'`,
        [s.invoiceLineId],
      )[0]?.d ?? 0);
      const after = before + unitDelta;
      const saleUnit = s.lineTotal / Math.max(1, s.quantity);
      const vatEstimate = s.taxScheme === 'MARGIN'
        ? R3((marginVatPerUnit(saleUnit, after, s.vatRate || 10) - marginVatPerUnit(saleUnit, before, s.vatRate || 10)) * s.unitsInCogs)
        : 0;
      korrekturen.push({ line: l, sale: s, unitDelta, amount, oldUnit: before, newUnit: after, vatEstimate });
    }
  }
  // Ein Los darf nie einen negativen Einstand bekommen.
  for (const [lineId, d] of lotDelta) {
    const c = k.consumption.get(lineId);
    for (const lot of c?.lots ?? []) {
      if (lot.status !== 'CANCELLED' && lot.unit === 'pcs' && lot.unitCost + d < -EPS) {
        throw nein('PURCHASE_EDIT_COST_NEGATIVE', 'this correction would make the cost of an item negative');
      }
    }
  }

  // Das neue Ausweisfoto — vorab geprüft (Medium bereit), geschrieben unten.
  const supplierAfter = newSupplier;
  let neuerNachweis: PurchaseIdentityReference | null = null;
  if (req.identityPhoto) {
    const source = identitySourceOf('supplier', supplierAfter);
    neuerNachweis = nachweisVon(req.identityPhoto.mediaId, { ownerType: source.ownerType, ownerId: source.ownerId });
  }

  // ── 3. Die Wirkung ──
  const db = getDatabase();
  const before = belegZustand(purchaseId);
  const today = dayOf(ctx.now);
  const finanz = kinds.some((x) => x === 'PRICE' || x === 'QUANTITY' || x === 'SUPPLIER' || x === 'ADD_LINE' || x === 'REMOVE_LINE');

  // a) Zeilen und Lose.
  const touchedProducts = new Set<string>();
  for (const c of changes) {
    const l = c.line;
    const lineId = String(l.id);
    const rate = Number(l.vat_rate ?? 0) || 0;
    const lineTotal = R3(c.qty * c.price);
    const vatAmount = rate > 0 ? lineTotal * rate / (100 + rate) : 0;
    db.run('UPDATE purchase_lines SET quantity = ?, unit_price = ?, line_total = ?, vat_amount = ? WHERE id = ?',
      [c.qty, c.price, lineTotal, vatAmount, lineId]);
    trackChange('purchase_lines', lineId, 'update', {});
    const lots = query(`SELECT id FROM stock_lots WHERE purchase_line_id = ? AND status != 'CANCELLED' AND COALESCE(unit, 'pcs') = 'pcs'`, [lineId]);
    if (c.qtyChanged) {
      // Nur eine unberührte Zeile (Sperre oben): ihr eines Los nimmt Menge und Einstand neu auf.
      const unitCost = purchaseLotUnitCost({ qty: c.qty, unitPrice: c.price, lineTotal, vatAmount });
      for (const lot of lots) {
        db.run('UPDATE stock_lots SET qty_total = ?, qty_remaining = ?, unit_cost = ? WHERE id = ?', [c.qty, c.qty, unitCost, String(lot.id)]);
        trackLotRow(String(lot.id), 'update');
      }
    } else if (c.priceChanged) {
      const d = lotDelta.get(lineId) ?? 0;
      for (const lot of lots) {
        db.run('UPDATE stock_lots SET unit_cost = unit_cost + ? WHERE id = ?', [d, String(lot.id)]);
        trackLotRow(String(lot.id), 'update');
      }
    }
    if (l.product_id) touchedProducts.add(String(l.product_id));
  }

  // a2) Teil 3 — Positionen entfernen. Entschieden wird VOR dem ersten Löschen (dieselbe Regel wie die Auskunft):
  //     • der Artikel geht mit (von DIESER Zeile angelegt, an nichts sonst gebunden): Los, Zeile und Artikel weg;
  //     • sonst bleibt der Artikel: sein Los wird storniert (Historie, wie beim Storno des Einkaufs — so bleibt die
  //       Los-Historie, und die Menge folgt den Losen statt als „Altbestand ohne Lose" stehen zu bleiben), die Zeile geht.
  //     Alles im Protokoll; der Vorher-Stand jeder Zeile steht zusätzlich im Bearbeitungsbeleg (`purchase_edits`).
  const removedProductIds: string[] = [];
  const keptProducts = new Set<string>();
  const mitArtikel = new Map(removeIds.map((id) => [id, artikelGehtMit(lineById.get(id)!)]));
  for (const lineId of removeIds) {
    const l = lineById.get(lineId)!;
    const productId = String(l.product_id ?? '');
    const geht = mitArtikel.get(lineId) === true;
    for (const lot of query('SELECT id FROM stock_lots WHERE purchase_line_id = ?', [lineId])) {
      if (geht) {
        db.run('DELETE FROM stock_lots WHERE id = ?', [String(lot.id)]);
        trackLotRow(String(lot.id), 'delete');
      } else {
        db.run(`UPDATE stock_lots SET status = 'CANCELLED' WHERE id = ?`, [String(lot.id)]);
        trackLotRow(String(lot.id), 'update');
      }
    }
    db.run('DELETE FROM purchase_lines WHERE id = ?', [lineId]);
    trackChange('purchase_lines', lineId, 'delete', {});
    logAuditOrThrow({
      module: 'Purchase', entityType: 'purchase_lines', entityId: lineId, action: 'DELETE', field: 'line',
      oldValue: { productId: productId || null, quantity: l.quantity, unitPrice: l.unit_price, lineTotal: l.line_total, taxScheme: l.tax_scheme ?? null },
      newValue: { purchaseId, reason, itemRemoved: geht },
      actor: { branchId: ctx.branchId, userId: ctx.userId },
    });
    if (!productId) continue;
    if (!geht) { keptProducts.add(productId); continue; }
    const p0 = query('SELECT brand, name, sku, category_id FROM products WHERE id = ?', [productId])[0];
    if (!p0) continue;
    purgeProductLeftovers(db as unknown as LeftoverDb, [productId], ctx.now);
    db.run('DELETE FROM products WHERE id = ?', [productId]);
    trackChange('products', productId, 'delete', {});
    logAuditOrThrow({
      module: 'Product', entityType: 'products', entityId: productId, action: 'DELETE', field: 'product',
      oldValue: { brand: p0.brand ?? null, name: p0.name ?? null, sku: p0.sku ?? null, categoryId: p0.category_id ?? null },
      newValue: { reason: 'purchase line removed', purchaseId, purchaseLineId: lineId },
      actor: { branchId: ctx.branchId, userId: ctx.userId },
    });
    removedProductIds.push(productId);
    touchedProducts.delete(productId);
  }
  for (const pid of keptProducts) {
    if (removedProductIds.includes(pid)) continue;
    syncProductQuantity(pid);
    // Wie beim Storno (F-PRC-01): ohne Bestand kein „in_stock"; ein anderer Status gehört einem anderen Vorgang.
    if (getAvailableStock(pid) === 0) {
      db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ? AND stock_status = 'in_stock'`, [ctx.now, pid]);
    }
    trackProductRow(pid);
  }

  // a3) Teil 2 — Positionen nachtragen: dieselbe Zeilenfolge wie „Save Purchase" (SKU, Artikel, Zeile, Los, Menge),
  //     datiert auf das (neue) Einkaufsdatum. Die Buchung folgt unten mit allen Zeilen.
  const addedLineIds = planned.length > 0 && ops ? ops.append(purchaseId, newDate, planned, ctx).map((a) => a.id) : [];

  // b) Datum: Lose (FIFO-Reihenfolge) und — wo er dem Einkauf gehört — der Artikel. Das Hauptbuch behält
  //    sein Buchungsdatum (D4): verschoben wird nichts, und die Vorsteuer bleibt in ihrem Quartal.
  if (kinds.includes('DATE')) {
    db.run(`UPDATE stock_lots SET acquired_at = ? WHERE purchase_id = ? AND status != 'CANCELLED' AND COALESCE(unit, 'pcs') = 'pcs'`, [newDate, purchaseId]);
    for (const lot of query(`SELECT id FROM stock_lots WHERE purchase_id = ? AND COALESCE(unit, 'pcs') = 'pcs'`, [purchaseId])) {
      trackLotRow(String(lot.id), 'update');
    }
  }

  // c) D13 — der Artikel folgt, wo er dem Einkauf gehört. Verkaufs- und Mindestpreis bleiben.
  for (const l of k.lines) {
    const productId = String(l.product_id ?? '');
    if (removed.has(String(l.id)) || !productId || !artikelFolgt(l)) continue;
    const c = neu.get(String(l.id));
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (c?.priceChanged) {
      const delta = c.price - (Number(l.unit_price) || 0);
      sets.push('purchase_price = COALESCE(purchase_price, 0) + ?');
      vals.push(delta);
      sets.push(`expected_margin = CASE WHEN planned_sale_price IS NOT NULL AND planned_sale_price > 0
                 THEN planned_sale_price - (COALESCE(purchase_price, 0) + ?) ELSE expected_margin END`);
      vals.push(delta);
    }
    if (kinds.includes('DATE')) {
      const pd = String(query('SELECT purchase_date FROM products WHERE id = ?', [productId])[0]?.purchase_date ?? '');
      if (Number(l.created_product) === 1 || pd.slice(0, 10) === oldDate) { sets.push('purchase_date = ?'); vals.push(newDate); }
    }
    if (sets.length === 0) continue;
    db.run(`UPDATE products SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, ctx.now, productId]);
    touchedProducts.add(productId);
  }
  for (const pid of touchedProducts) {
    syncProductQuantity(pid);
    trackProductRow(pid);
  }

  // d) Lieferanten-Momentaufnahme: neuer Lieferant und/oder neues Ausweisfoto; Altes verborgen (D5/D10).
  let snap = snapshotOf(p, ctx.now);
  let snapChanged = false;
  if (kinds.includes('SUPPLIER')) {
    snap = lieferantEinfrieren(snap, oldSupplier, newSupplier, ctx.now);
    snapChanged = true;
  }
  if (neuerNachweis) {
    if (req.identityPhoto?.alsoUpdatePerson) {
      // Nur auf ausdrücklichen Wunsch auch im Stamm der Person (D10: nicht ungefragt überschreiben).
      try { applyIdentityDocument(neuerNachweis.ownerType, neuerNachweis.ownerId, neuerNachweis.mediaId, { bumpOwner: true }); } catch (e) {
        if (e instanceof IdentityMediaError) throw nein(e.code, e.message);
        throw e;
      }
    }
    zurueckstellen(snap, ctx.now);
    snap.identity = neuerNachweis;
    snapChanged = true;
  }

  // e) Der Kopf — EIN Schreiben (die Fassung steigt genau einmal).
  const remainingF = Math.max(0, newTotalF - settledF);
  const status = statusOf(newTotalF, settledF);
  db.run(
    `UPDATE purchases SET total_amount = ?, remaining_amount = ?, status = ?, purchase_date = ?, supplier_id = ?, notes = ?,
       staff_id = ?, supplier_snapshot = ?, updated_at = ? WHERE id = ?`,
    [B(newTotalF), B(remainingF), status, newDate, newSupplier, newNotes, newStaff,
      snapChanged ? JSON.stringify(snap) : (p.supplier_snapshot ?? null), ctx.now, purchaseId],
  );

  // f) Das Hauptbuch: gegenbuchen und neu buchen, beides heute (D3). Bei einem Lieferantenwechsel auch
  //    die Zahlungsbuchungen — die Zahlungszeilen selbst bleiben unverändert (D5).
  if (finanz) {
    // Ohne Buchung kommt man nur hierher, wenn die alte Summe 0 war (sonst sperrt `PURCHASE_EDIT_NO_LEDGER`).
    if (k.hasLedger) reverseSource('PURCHASE', purchaseId, ctx.now);
    if (newTotalF > 0) postPurchaseReceived(belegFuerBuchung(purchaseId), { occurredAt: today });
  }
  if (kinds.includes('SUPPLIER')) {
    for (const pp of k.livePayments) {
      const payId = String(pp.id);
      if (!hasLedgerEntries('PURCHASE_PAYMENT', payId)) continue;
      reverseSource('PURCHASE_PAYMENT', payId, ctx.now);
      const payment: PurchasePayment = {
        id: payId, purchaseId, amount: Number(pp.amount) || 0, method: String(pp.method) as PurchasePayment['method'],
        paidAt: String(pp.paid_at ?? today), reference: (pp.reference as string) || undefined,
        note: (pp.note as string) || undefined, createdAt: String(pp.created_at ?? ctx.now),
      };
      postPurchasePayment(payment, newSupplier, { occurredAt: today });
    }
  }

  // g) D1 — die Einstandskorrekturen: eigener Beleg, eigene Buchung, die Rechnung bleibt.
  const corrections: PurchaseEdited['corrections'] = [];
  const editId = uuid();
  for (const kz of korrekturen) {
    const id = uuid();
    const number = getNextDocumentNumber('CC');
    db.run(
      `INSERT INTO cost_corrections (id, branch_id, correction_number, purchase_id, purchase_line_id, edit_id, kind, invoice_id,
         invoice_line_id, product_id, quantity, old_unit_cost, new_unit_cost, unit_delta, amount, booking_date, economic_date,
         sale_tax_scheme, vat_status, vat_estimate, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'ENTRY_ERROR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REVIEW', ?, 'ACTIVE', ?, ?)`,
      [id, ctx.branchId, number, purchaseId, String(kz.line.id), editId, kz.sale.invoiceId, kz.sale.invoiceLineId,
        kz.sale.productId, kz.sale.unitsInCogs, kz.oldUnit, kz.newUnit, kz.unitDelta, kz.amount, today, kz.sale.issuedDate,
        kz.sale.taxScheme || null, kz.vatEstimate, ctx.now, ctx.userId || null],
    );
    postCostCorrection({
      correctionId: id, correctionNumber: number, invoiceLineId: kz.sale.invoiceLineId, invoiceId: kz.sale.invoiceId,
      invoiceNumber: kz.sale.invoiceNumber, purchaseId, productId: kz.sale.productId ?? undefined, amount: kz.amount,
      occurredAt: today, economicDate: kz.sale.issuedDate,
    });
    logAuditOrThrow({
      module: 'Purchase', entityType: 'cost_corrections', entityId: id, action: 'CREATE', field: 'amount',
      oldValue: kz.oldUnit, newValue: {
        correctionNumber: number, invoiceNumber: kz.sale.invoiceNumber, amount: kz.amount, newUnitCost: kz.newUnit,
        economicDate: kz.sale.issuedDate, bookingDate: today, vatStatus: 'REVIEW', vatEstimate: kz.vatEstimate, purchaseId,
      },
      actor: { branchId: ctx.branchId, userId: ctx.userId },
    });
    corrections.push({
      correctionNumber: number, invoiceNumber: kz.sale.invoiceNumber, amount: kz.amount,
      economicDate: kz.sale.issuedDate, vatEstimate: kz.vatEstimate,
    });
  }

  // h) Überzahlung → Lieferantenguthaben nachziehen (dieselbe Regel wie jede Zahlung, Slice 4b).
  try { reconcilePurchaseOverpayCredit(purchaseId, { now: ctx.now }); } catch (e) {
    if (e instanceof OverpayCreditRedeemed) throw nein(e.code, e.message);
    throw e;
  }

  // i) Protokoll ATOMAR: Vorher/Nachher + Feldprotokoll.
  const editNo = Number(query('SELECT COUNT(*) AS c FROM purchase_edits WHERE purchase_id = ?', [purchaseId])[0]?.c ?? 0) + 1;
  const after = belegZustand(purchaseId);
  db.run(
    `INSERT INTO purchase_edits (id, branch_id, purchase_id, edit_no, reason, kinds, correction_kind, old_snapshot, new_snapshot, edited_by, edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [editId, ctx.branchId, purchaseId, editNo, reason, kinds.join(','), changes.some((c) => c.priceChanged) ? (req.correctionKind ?? null) : null,
      JSON.stringify(before), JSON.stringify(after), ctx.userId || null, ctx.now],
  );
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchases', entityId: purchaseId, action: 'UPDATE', field: kinds.join(','),
    oldValue: (before as { header: unknown }).header,
    newValue: {
      reason, kinds, editNo, editId, header: (after as { header: unknown }).header, corrections: corrections.map((c) => c.correctionNumber),
      ...(addedLineIds.length ? { addedLines: addedLineIds } : {}),
      ...(removeIds.length ? { removedLines: removeIds, removedProducts: removedProductIds } : {}),
    },
    actor: { branchId: ctx.branchId, userId: ctx.userId },
  });
  trackChange('purchases', purchaseId, 'update', {});

  const over = Number(query('SELECT COALESCE(SUM(amount), 0) AS a FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL', [purchaseId])[0]?.a ?? 0);
  return {
    purchaseId, purchaseNumber: String(p.purchase_number ?? ''), editId, editNo, kinds,
    totalAmount: B(newTotalF), remainingAmount: B(remainingF), status, revision: revisionOf(purchaseId),
    overpayCredit: over, corrections, addedLineIds, removedLineIds: removeIds, removedProductIds,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// D14 — eine falsch erfasste Zahlung stornieren
// ════════════════════════════════════════════════════════════════════════════

export interface PurchasePaymentVoided {
  purchaseId: string;
  paymentId: string;
  amount: number;
  method: string;
  paidAmount: number;
  remainingAmount: number;
  status: PurchaseStatus;
  revision: number;
  restoredCreditId: string | null;
}

/**
 * „Void payment": die Zahlung bleibt als Zeile stehen (Betrag, Weg, Datum, Beleg — der Nachweis),
 * bekommt ihren Storno (wann, wer, warum), und ihre Buchung wird HEUTE gegengebucht. Eine mit
 * Lieferanten-Guthaben beglichene Zahlung gibt das Guthaben zurück. Eine Bar-/Bank-Zahlung senkt
 * den bezahlten Betrag; war daraus ein schon eingelöstes Überzahlungsguthaben entstanden, wird
 * abgewiesen. Danach erfasst der Mensch die richtige Zahlung über den normalen Weg neu.
 */
export function voidPurchasePaymentInHouse(
  purchaseId: string, paymentId: string, reasonRaw: string, ctx: HouseCtx, expectedRevision?: number,
): PurchasePaymentVoided {
  assertBooks();
  const p = livePurchase(purchaseId, ctx.branchId);
  assertSeen(purchaseId, expectedRevision);
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  if (!reason) throw nein('PURCHASE_EDIT_REASON_REQUIRED', 'Please enter a reason for voiding this payment.');
  if (String(p.status) === 'CANCELLED') throw nein('PURCHASE_CANCELLED', 'A cancelled purchase is not edited.');
  if (p.source_consignment_id || /^Consignor payout/.test(String(p.notes ?? ''))) {
    throw nein('PURCHASE_EDIT_CONSIGNMENT', 'This is the automatic purchase of a consignment sale — correct it through the consignment.');
  }
  const pay = query('SELECT * FROM purchase_payments WHERE id = ? AND purchase_id = ?', [paymentId, purchaseId])[0];
  if (!pay) throw nein('PAYMENT_NOT_FOUND', 'no such payment on this purchase');
  if (pay.voided_at) throw nein('PAYMENT_ALREADY_VOIDED', 'This payment is already voided.');
  const paidAt = String(pay.paid_at ?? '');
  if (paidAt.slice(0, 10) < OPENING_CUTOFF_DATE) {
    throw nein('PURCHASE_EDIT_BEFORE_CUTOVER',
      `This payment is dated before the opening cut-off (${OPENING_CUTOFF_DATE}). It waits for the accountant to confirm the opening balances.`);
  }
  if (!hasLedgerEntries('PURCHASE_PAYMENT', paymentId)) {
    throw nein('PURCHASE_EDIT_NO_LEDGER', 'This payment has no live accounting entry. It has to be reconciled first.');
  }
  const method = String(pay.method ?? '');
  const amountF = F(pay.amount);
  const cashF = F(p.paid_amount);
  const newCashF = method === 'credit' ? cashF : Math.max(0, cashF - amountF);
  const creditF = F(query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = 'credit' AND voided_at IS NULL`,
    [purchaseId],
  )[0]?.t);
  const newCreditF = method === 'credit' ? Math.max(0, creditF - amountF) : creditF;
  try { assertSupplierOverpayMutable(purchaseId, B(newCashF)); } catch (e) {
    if (e instanceof OverpayCreditRedeemed) throw nein(e.code, e.message);
    throw e;
  }

  const db = getDatabase();
  const before = belegZustand(purchaseId);
  db.run('UPDATE purchase_payments SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?',
    [ctx.now, ctx.userId || null, reason, paymentId]);
  trackChange('purchase_payments', paymentId, 'update', {});
  reverseSource('PURCHASE_PAYMENT', paymentId, ctx.now);
  let restoredCreditId: string | null = null;
  if (method === 'credit' && pay.reference) {
    restoreSupplierCreditUsage(String(pay.reference), B(amountF));
    restoredCreditId = String(pay.reference);
  }
  const totalF = F(p.total_amount);
  const settledF = newCashF + newCreditF;
  const remainingF = Math.max(0, totalF - settledF);
  const status = statusOf(totalF, settledF);
  db.run('UPDATE purchases SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?',
    [B(newCashF), B(remainingF), status, ctx.now, purchaseId]);
  try { reconcilePurchaseOverpayCredit(purchaseId, { now: ctx.now }); } catch (e) {
    if (e instanceof OverpayCreditRedeemed) throw nein(e.code, e.message);
    throw e;
  }

  const editNo = Number(query('SELECT COUNT(*) AS c FROM purchase_edits WHERE purchase_id = ?', [purchaseId])[0]?.c ?? 0) + 1;
  db.run(
    `INSERT INTO purchase_edits (id, branch_id, purchase_id, edit_no, reason, kinds, correction_kind, old_snapshot, new_snapshot, edited_by, edited_at)
     VALUES (?, ?, ?, ?, ?, 'PAYMENT_VOID', NULL, ?, ?, ?, ?)`,
    [uuid(), ctx.branchId, purchaseId, editNo, reason, JSON.stringify(before), JSON.stringify(belegZustand(purchaseId)), ctx.userId || null, ctx.now],
  );
  logAuditOrThrow({
    module: 'Purchase', entityType: 'purchase_payments', entityId: paymentId, action: 'STATUS_CHANGE', field: 'voided_at',
    oldValue: { amount: B(amountF), method, paidAt }, newValue: { voidedAt: ctx.now, reason, purchaseId },
    actor: { branchId: ctx.branchId, userId: ctx.userId },
  });
  trackChange('purchases', purchaseId, 'update', {});
  return {
    purchaseId, paymentId, amount: B(amountF), method, paidAmount: B(newCashF), remainingAmount: B(remainingF), status,
    revision: revisionOf(purchaseId), restoredCreditId,
  };
}
