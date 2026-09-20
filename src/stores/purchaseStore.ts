// ═══════════════════════════════════════════════════════════
// LATAIF — Purchase Store (Plan §Purchases + §Purchase Returns)
// ═══════════════════════════════════════════════════════════
//
// Regeln (Plan §5, §14, §17):
//  - Ware kommt IMMER ins Inventar (egal ob bezahlt oder nicht)
//  - Payable = total_amount − paid_amount
//  - Status: DRAFT | UNPAID | PARTIALLY_PAID | PAID | CANCELLED
//  - Teilzahlungen erlaubt, Status wird automatisch aktualisiert

import { inboxPhotoRefsFor } from '@/core/purchases/inbox-media';
import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Purchase, PurchaseLine, PurchasePayment, PurchaseStatus, PurchaseReturn, PurchaseReturnLine, PurchaseReturnStatus, Product, SupplierSnapshot } from '@/core/models/types';
import { identityDocumentFor, supplierLegacyIdPhoto } from '@/core/identity/identity-media';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete, trackStatusChange, trackPayment } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';   // sync-only (kein Audit) — Line-Tabellen
import { getAvailableStock, syncProductQuantity, trackLotRow, trackProductRow } from '@/core/lots/lot-queries';
import { useProductStore } from '@/stores/productStore';
import {
  postPurchaseReceived,
  postPurchasePayment,
  hasLedgerEntries,
} from '@/core/ledger/posting';
import { atomar, localHouseCtx, recordPurchasePaymentInHouse } from '@/core/payables/payables-house';
// CENTRAL-UI-PARITY R6F — Retoure (Anlage + Wirkung), Storno, Retouren-Umkehr, Inbox-Verwerfen und
// der Auftrags-Rollup wohnen jetzt in der Hausfolge des Einkaufs-Lebenszyklus (ohne Store-Import);
// die Store-Aktionen hier sind nur noch ihre Altanschluesse — EINE Implementierung.
import {
  cancelPurchaseInHouse, confirmPurchaseReturnInHouse, createPurchaseReturnDraftInHouse,
  dismissPurchaseInboxInHouse, recomputeOrderStatusRaw, reverseConfirmedPurchaseReturnInHouse,
} from '@/core/purchases/purchase-lifecycle-house';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
// Wenn die Buchung scheitert, wird das Domain-Insert NICHT zurückgerollt; stattdessen
// loggen wir und überlassen die Korrektur der Reconciliation-View. Der operative Flow
// (Purchase / Payment / Cancel) darf nicht an einer Bilanz-Diskrepanz blockiert werden.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

// ── Slice 4b — Purchase-Ueberzahlung → SUPPLIER_CREDIT ────────────────────────
// Die Helfer (Overpay-Basis purchases.paid_amount = NETTO-CASH, clawback-then-rebook, Teardown)
// stehen seit R6D unveraendert in `core/payables/purchase-overpay.ts` — dort ruft sie auch die
// Zahlungsfolge des Hauses, ohne diesen Store zu importieren.

// F6 — beim Storno der EINLOESENDEN Purchase das auf einer Supplier-Gutschrift verbrauchte
// used_amount zurueckgeben. Logik liegt im neutralen Core-Helfer restoreSupplierCreditUsage
// (gemeinsam mit dem Expense-Cancel/Delete-Pfad, Slice A — keine Duplikation). Link 1:1 ueber
// purchase_payments.reference = supplier_credits.id; Idempotenz beim Caller (Capture vor Reverse,
// gefiltert auf !hasReversalFor) — seit R6F in `cancelPurchaseInHouse`.

interface PurchaseInput {
  supplierId: string;
  purchaseDate?: string;
  notes?: string;
  staffId?: string;
  lines: Array<{
    productId?: string;       // if omitted → new product is created
    // Plan §Purchase §New-Item: bei „New" wird das Produkt mit voller
    // Collection-Spec angelegt (Kategorie + dyn. Attribute + Photos + Tax-Scheme).
    // Legacy-Felder newProductBrand/Name/etc. bleiben als Fallback erhalten.
    newProduct?: Partial<Product>;
    newProductBrand?: string;
    newProductName?: string;
    newProductCategoryId?: string;
    newProductSku?: string;
    description?: string;
    quantity: number;
    unitPrice: number;        // gross-incl-VAT pro Stück (was an den Lieferanten gezahlt wird)
    // Plan §Purchase §Tax: Input-VAT (Vorsteuer) per Line.
    taxScheme?: 'ZERO' | 'VAT_10';
    vatRate?: number;          // 0 oder 10
    // Back-to-Back: verknuepft diese Zeile mit der Order-Zeile, die sie ausgeloest hat.
    sourceOrderLineId?: string;
  }>;
  initialPayment?: { amount: number; method: 'cash' | 'bank' | 'benefit'; reference?: string };
  // Back-to-Back: Order, deren Posten dieser Einkauf (mit-)beschafft.
  sourceOrderId?: string;
}

// v0.4.0 — Mobile-Capture: ein Foto aus der /mobile-Seite, das noch zu einer
// echten Purchase werden soll. Klick im Desktop oeffnet damit New Purchase.
export interface PurchaseInboxItem {
  id: string;
  branchId: string;
  /**
   * ALTBESTAND — Daten-URLs in der Zeile, von einem älteren Telefon. Wird NICHT mehr geschrieben
   * (MEDIA-INBOX); das Foto ist ein Medium. Bleibt lesbar, damit ein alter Eintrag nicht blind wird.
   */
  images: string[];
  /**
   * MEDIA-INBOX — das Foto als REFERENZ: genug zum Anzeigen, nie Bytes. `thumb` ist die kleine
   * Fassung; eine Kachel von 92 Pixeln braucht nicht die große, und der Medienkern hat sie schon.
   */
  photos?: Array<{
    mediaId: string;
    main: { key: string; hash: string; extension: string };
    thumb: { key: string; hash: string; extension: string } | null;
  }>;
  note?: string;
  status: string;
  createdAt: string;
}

interface PurchaseStore {
  purchases: Purchase[];
  returns: PurchaseReturn[];
  purchaseInbox: PurchaseInboxItem[];
  loading: boolean;
  loadPurchases: () => void;
  loadReturns: () => void;
  getPurchase: (id: string) => Purchase | undefined;
  getReturn: (id: string) => PurchaseReturn | undefined;
  createPurchase: (input: PurchaseInput) => Purchase;
  addPayment: (purchaseId: string, amount: number, method: 'cash' | 'bank' | 'benefit' | 'credit', reference?: string, note?: string) => void;
  cancelPurchase: (id: string) => void;
  // Returns
  createReturn: (input: {
    purchaseId: string;
    returnDate?: string;
    refundMethod?: 'cash' | 'bank' | 'benefit' | 'credit';
    notes?: string;
    lines: Array<{ purchaseLineId: string; productId?: string; quantity: number; unitPrice: number }>;
  }) => PurchaseReturn;
  confirmReturn: (id: string) => void;
  completeReturn: (id: string) => void;
  cancelReturn: (id: string) => void;
  deleteReturn: (id: string) => void;
  // v0.4.0 — Purchase-Inbox (Mobile-Capture)
  loadPurchaseInbox: () => void;
  markPurchaseInboxDone: (id: string) => void;
  dismissPurchaseInbox: (id: string) => void;
}

// R6D — die Fassung reist mit: „Add Payment" nennt sie, damit ein veralteter Stand abgewiesen wird.
function rowToPurchase(row: Record<string, unknown>): Purchase & { revision?: number } {
  // Snapshot der Supplier-Daten zum Zeitpunkt des Purchase-Create (Audit-Trail).
  let snapshot: import('@/core/models/types').SupplierSnapshot | undefined;
  const snapRaw = row.supplier_snapshot as string | null | undefined;
  if (snapRaw) {
    try { snapshot = JSON.parse(snapRaw); } catch { snapshot = undefined; }
  }
  return {
    id: row.id as string,
    purchaseNumber: row.purchase_number as string,
    branchId: row.branch_id as string,
    supplierId: row.supplier_id as string,
    status: (row.status as PurchaseStatus) || 'DRAFT',
    totalAmount: (row.total_amount as number) || 0,
    paidAmount: (row.paid_amount as number) || 0,
    remainingAmount: (row.remaining_amount as number) || 0,
    purchaseDate: row.purchase_date as string,
    notes: row.notes as string | undefined,
    lines: [],
    payments: [],
    staffId: (row.staff_id as string) || undefined,
    supplierSnapshot: snapshot,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
    sourceOrderId: (row.source_order_id as string | null) || undefined,
    revision: Number(row.revision ?? 0) || undefined,
  };
}

function rowToLine(row: Record<string, unknown>): PurchaseLine {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    productId: row.product_id as string | undefined,
    description: row.description as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    lineTotal: (row.line_total as number) || 0,
    position: (row.position as number) || 0,
    taxScheme: (row.tax_scheme as 'ZERO' | 'VAT_10' | null) || undefined,
    vatRate: row.vat_rate != null ? (row.vat_rate as number) : undefined,
    vatAmount: row.vat_amount != null ? (row.vat_amount as number) : undefined,
    sourceOrderLineId: (row.source_order_line_id as string | null) || undefined,
  };
}

function rowToPayment(row: Record<string, unknown>): PurchasePayment {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    amount: (row.amount as number) || 0,
    method: (row.method as 'cash' | 'bank') || 'cash',
    paidAt: row.paid_at as string,
    reference: row.reference as string | undefined,
    note: row.note as string | undefined,
    createdAt: row.created_at as string,
  };
}

function rowToReturn(row: Record<string, unknown>): PurchaseReturn {
  return {
    id: row.id as string,
    returnNumber: row.return_number as string,
    branchId: row.branch_id as string,
    purchaseId: row.purchase_id as string,
    supplierId: row.supplier_id as string,
    status: (row.status as PurchaseReturnStatus) || 'DRAFT',
    totalAmount: (row.total_amount as number) || 0,
    returnDate: row.return_date as string,
    refundMethod: row.refund_method as 'cash' | 'bank' | 'benefit' | 'credit' | undefined,
    refundAmount: (row.refund_amount as number) || 0,
    notes: row.notes as string | undefined,
    lines: [],
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToReturnLine(row: Record<string, unknown>): PurchaseReturnLine {
  return {
    id: row.id as string,
    returnId: row.return_id as string,
    purchaseLineId: row.purchase_line_id as string | undefined,
    productId: row.product_id as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    lineTotal: (row.line_total as number) || 0,
  };
}

function rowToInboxItem(row: Record<string, unknown>): PurchaseInboxItem {
  let images: string[] = [];
  try {
    const parsed = JSON.parse((row.images as string) || '[]');
    if (Array.isArray(parsed)) images = parsed as string[];
  } catch { /* leeres Array lassen */ }
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    images,
    note: (row.note as string) || undefined,
    status: (row.status as string) || 'pending',
    createdAt: row.created_at as string,
  };
}

function computeStatus(total: number, paid: number, cancelled = false): PurchaseStatus {
  if (cancelled) return 'CANCELLED';
  if (total <= 0) return 'DRAFT';
  if (paid <= 0) return 'UNPAID';
  if (paid >= total) return 'PAID';
  return 'PARTIALLY_PAID';
}

// Slice 4a — die Umkehr einer CONFIRMED/COMPLETED-Retoure (Ledger → Lots → Produkt-Status →
// Purchase-Totals → ungenutzten Credit entfernen) wohnt seit R6F als
// `reverseConfirmedPurchaseReturnInHouse` in der Hausfolge — strikt statt verschluckter
// Stornobuchung, und auch der Einkaufs-Storno nimmt damit eine wirksame Retoure mit zurueck.

// ── Back-to-Back Beschaffung: Order-Line Status-Sync ──────────────────────
// purchaseStore importiert NIE orderStore (HMR-Circular-Risk) — der Order-Line-
// Status wird per Raw-SQL aktualisiert, der Order-Roll-up ueber die REINE
// Funktion deriveOrderStatusFromLines (kein Store-Zugriff). R6F — der Roll-up
// (`recomputeOrderStatusRaw`) und das Zuruecksetzen beim Storno wohnen in der Hausfolge.

type SqlDb = ReturnType<typeof getDatabase>;

// Nach createPurchase: verknuepfte Order-Zeilen auf ARRIVED setzen. Invoicte oder
// stornierte Zeilen werden uebersprungen.
function arriveLinkedOrderLines(
  db: SqlDb,
  lineRecords: Array<{ sourceOrderLineId: string | null }>,
): void {
  const affectedOrders = new Set<string>();
  for (const lr of lineRecords) {
    if (!lr.sourceOrderLineId) continue;
    const rows = query(
      `SELECT order_id, invoice_id, status FROM order_lines WHERE id = ?`,
      [lr.sourceOrderLineId]
    );
    if (rows.length === 0) continue;
    if (rows[0].invoice_id) continue;
    if ((rows[0].status as string) === 'CANCELLED') continue;
    db.run(`UPDATE order_lines SET status = 'ARRIVED' WHERE id = ?`, [lr.sourceOrderLineId]);
    trackUpdate('order_lines', lr.sourceOrderLineId, { status: 'ARRIVED' });
    affectedOrders.add(rows[0].order_id as string);
  }
  for (const oid of affectedOrders) recomputeOrderStatusRaw(db, oid);
}

export const usePurchaseStore = create<PurchaseStore>((set, get) => ({
  purchases: [],
  returns: [],
  purchaseInbox: [],
  loading: false,

  loadPurchases: () => {
    if (hydrateFromPrimary('store.purchases.get', (d) => set(d as never))) return;
    try {
      set({ ...loadPurchasesFor(localReadContext()), loading: false });
    } catch { set({ purchases: [], loading: false }); }
  },

  // ── v0.4.0 — Purchase-Inbox (Mobile-Capture) ──
  loadPurchaseInbox: () => {
    if (hydrateFromPrimary('store.purchases.get', (d) => set(d as never))) return;
    try {
      set(loadPurchaseInboxFor(localReadContext()));
    } catch { set({ purchaseInbox: [] }); }
  },

  markPurchaseInboxDone: (id) => {
    const db = getDatabase();
    db.run(`UPDATE purchase_inbox SET status = 'done' WHERE id = ?`, [id]);
    saveDatabase();
    trackUpdate('purchase_inbox', id, { status: 'done' });
    get().loadPurchaseInbox();
  },

  // R6F — Altanschluss auf die Hausfolge (`dismissPurchaseInboxInHouse`): nur ein OFFENES Foto wird
  // verworfen, das Protokoll ist atomar. Die Maske ruft `dismissPurchaseInboxOnPrimary` / den Fernbefehl.
  dismissPurchaseInbox: (id) => {
    atomar(() => dismissPurchaseInboxInHouse(id, localHouseCtx().branchId));
    get().loadPurchaseInbox();
  },

  loadReturns: () => {
    if (hydrateFromPrimary('store.purchases.get', (d) => set(d as never))) return;
    try {
      set(loadPurchaseReturnsFor(localReadContext()));
    } catch { set({ returns: [] }); }
  },

  getPurchase: (id) => get().purchases.find(p => p.id === id),
  getReturn: (id) => get().returns.find(r => r.id === id),

  createPurchase: (input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const purchaseNumber = getNextDocumentNumber('PUR');
    const purchaseDate = input.purchaseDate || now.split('T')[0];

    // Create or link products for each line and build line records.
    // Plan §5: Ware kommt IMMER ins Inventar, product_status = IN_STOCK, source_type = OWN
    const lineRecords: Array<{
      id: string; productId: string; description: string | null;
      qty: number; unitPrice: number; lineTotal: number; position: number;
      taxScheme: 'ZERO' | 'VAT_10'; vatRate: number; vatAmount: number;
      sourceOrderLineId: string | null;
    }> = [];
    let total = 0;
    // Bestehende (nicht in diesem Purchase neu angelegte) Produkte — fuer die
    // Canonical-Receive-Statusregel weiter unten (neue Produkte setzt createProduct schon).
    const existingProductIds = new Set<string>();
    input.lines.forEach((ln, idx) => {
      let productId = ln.productId;
      if (ln.productId) existingProductIds.add(ln.productId);
      if (!productId) {
        if (ln.newProduct) {
          // Plan §Purchase §New-Item: Neues Produkt mit voller Collection-Spec
          // (Kategorie + dyn. Attribute + Photos + Tax-Scheme + Storage etc.).
          // Eine zentrale Stelle für das INSERT — useProductStore.createProduct —
          // statt SQL hier zu duplizieren.
          const created = useProductStore.getState().createProduct({
            ...ln.newProduct,
            purchasePrice: ln.unitPrice,        // Bruttopreis aus dem Purchase-Line-Input
            purchaseDate,
            stockStatus: 'in_stock',
            quantity: ln.quantity || 1,
          });
          productId = created.id;
        } else {
          // Legacy-Pfad: nur Brand/Name/SKU/Kategorie aus Inline-Eingabe.
          productId = uuid();
          const pNow = new Date().toISOString();
          db.run(
            `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
              purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
              supplier_name, notes, images, attributes, created_at, updated_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'BHD', 'in_stock', 'MARGIN', NULL, 0, NULL, ?, '[]', '{}', ?, ?, ?)`,
            [productId, branchId, ln.newProductCategoryId || 'cat-watches', ln.newProductBrand || '', ln.newProductName || '',
             ln.newProductSku || null, '', purchaseDate, ln.unitPrice, ln.description || null, pNow, pNow, userId]
          );
        }
      }
      const qty = Math.max(1, ln.quantity || 1);
      const unitPrice = ln.unitPrice || 0;
      const lineTotal = qty * unitPrice;       // gross-incl-VAT
      const scheme: 'ZERO' | 'VAT_10' = ln.taxScheme || 'ZERO';
      const rate = ln.vatRate ?? (scheme === 'VAT_10' ? 10 : 0);
      // Input-VAT aus Brutto dekomponieren: vat = gross × rate / (100 + rate).
      const vatAmount = rate > 0 ? lineTotal * rate / (100 + rate) : 0;
      total += lineTotal;
      const lineId = uuid();
      lineRecords.push({
        id: lineId, productId, description: ln.description || null,
        qty, unitPrice, lineTotal, position: idx + 1,
        taxScheme: scheme, vatRate: rate, vatAmount,
        sourceOrderLineId: ln.sourceOrderLineId ?? null,
      });
    });

    // Insert purchase header (status UNPAID unless initial payment covers)
    const status: PurchaseStatus = computeStatus(total, input.initialPayment?.amount || 0);
    const paid = input.initialPayment?.amount || 0;

    // Salesforce-Pattern: Supplier-Stamm-/Beleg-Daten zum Zeitpunkt des
    // Purchase-Create einfrieren. Vermeidet dass spaetere Edits am Supplier
    // (Name, CPR, ID-Bild) den gedruckten Original-Beleg ueberschreiben.
    let snapshotJson: string | null = null;
    try {
      const sup = query(
        'SELECT name, phone, email, address, cpr FROM suppliers WHERE id = ?',
        [input.supplierId]
      )[0];
      if (sup) {
        const snap: SupplierSnapshot = {
          name: (sup.name as string) || '',
          phone: (sup.phone as string) || undefined,
          email: (sup.email as string) || undefined,
          address: (sup.address as string) || undefined,
          cpr: (sup.cpr as string) || undefined,
          snapshotAt: now,
        };
        // MEDIA-IDENTITY §7 — der Ausweisnachweis reist als REFERENZ auf genau die Fassung, die
        // JETZT gilt: Medium, Fassungsnummer, Inhalt-Hash, und wem das Dokument gehört. Beim
        // verknüpften Lieferanten ist das die Fassung des Kunden — festgehalten wird trotzdem die
        // konkrete Version, damit ein späterer Austausch diesen Beleg nicht rückwirkend ändert.
        const doc = identityDocumentFor('supplier', input.supplierId);
        if (doc.ref) {
          snap.identity = {
            mediaId: doc.ref.mediaId,
            generationNo: doc.ref.main.generationNo,
            blobHash: doc.ref.main.hash,
            byteSize: doc.ref.main.byteSize,
            storageKey: doc.ref.main.storageKey,
            extension: doc.ref.main.extension,
            ownerType: doc.source.ownerType,
            ownerId: doc.source.ownerId,
          };
        } else {
          // ALTBESTAND — dieser Lieferant hat seinen Ausweis noch nie im Medienspeicher gehabt.
          // Dann ist die Spalte der einzige Nachweis, den es gibt, und ein Beleg ohne Nachweis
          // wäre rückwirkend nicht mehr zu reparieren. Sobald das Dokument umzieht, gilt oben.
          const legacy = supplierLegacyIdPhoto(input.supplierId);
          if (legacy) snap.cprImage = legacy;
        }
        snapshotJson = JSON.stringify(snap);
      }
    } catch (err) {
      console.warn('[purchase] supplier snapshot failed:', err);
    }

    db.run(
      `INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status, total_amount, paid_amount, remaining_amount,
        purchase_date, notes, staff_id, supplier_snapshot, created_at, updated_at, created_by, source_order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, purchaseNumber, input.supplierId, status, total, paid, total - paid,
       purchaseDate, input.notes || null, input.staffId || null, snapshotJson, now, now, userId,
       input.sourceOrderId || null]
    );

    // Insert lines (inkl. Input-VAT-Felder + Back-to-Back Order-Link)
    const lineStmt = db.prepare(
      `INSERT INTO purchase_lines (id, purchase_id, product_id, description, quantity, unit_price, line_total, position, tax_scheme, vat_rate, vat_amount, source_order_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lineRecords) {
      lineStmt.run([l.id, id, l.productId, l.description, l.qty, l.unitPrice, l.lineTotal, l.position, l.taxScheme, l.vatRate, l.vatAmount, l.sourceOrderLineId]);
    }
    lineStmt.free();

    // Phase 2 — Stock-Lots: Pro Purchase-Line ein Lot mit dem TATSAECHLICHEN
    // Einkaufspreis dieser Charge. Existing-Item-Purchase legt einen frischen
    // Lot an, ohne den alten Lot/products.purchase_price zu beruehren — damit
    // bleibt der Cost-Snapshot fuer noch nicht verkaufte alte Stuecke korrekt.
    const lotStmt = db.prepare(
      `INSERT INTO stock_lots
         (id, branch_id, product_id, purchase_id, purchase_line_id,
          unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
    );
    const affectedProductIds = new Set<string>();
    const createdLotIds: string[] = [];   // LAN-Sync Phase 1a
    for (const l of lineRecords) {
      if (!l.productId || l.qty <= 0) continue;
      // unit_cost = GROSS pro Stueck (Cash-Out an Supplier). Identische Basis wie
      // products.purchase_price heute, damit Phase 4 (Cost-Snapshot aus Lot) das
      // bestehende Margin-Verhalten 1:1 abloest, nur eben pro-Lot statt global.
      const lotId = uuid();
      lotStmt.run([lotId, branchId, l.productId, id, l.id,
        l.unitPrice, l.qty, l.qty, purchaseDate, now]);
      createdLotIds.push(lotId);
      affectedProductIds.add(l.productId);
    }
    lotStmt.free();
    // Phase 7 Sync: products.quantity = Σ lot.qty_remaining
    for (const pid of affectedProductIds) syncProductQuantity(pid);
    // LAN-Sync Phase 1a: neue Lots als Full-Row (kanonische id) an Geraet B tracken.
    for (const lid of createdLotIds) trackLotRow(lid, 'insert');

    // Canonical Purchase-Receive auch fuer BESTEHENDE Produkte: frische OWN-Ware macht
    // das Produkt wieder verfuegbar. Fuer NEU angelegte Produkte erledigt das bereits
    // createProduct (stock_status='in_stock'); fuer bestehende griff bisher NICHTS — ein
    // 'sold'/'returned'/'consumed'-Produkt blieb trotz neuem aktiven Lot unverfuegbar.
    // Reihenfolge: Lot erzeugt → syncProductQuantity (oben) → finaler Status/source_type → Snapshot.
    // GUARD (kein Blind-Overwrite, kein neuer Normalizer): Lifecycle-Stati, die noch
    // laufenden FREMDEN Workflows gehoeren, werden NICHT angefasst — with_agent (Agent-Out),
    // in_repair (Repair-Out), consignment/consignment_reserved (Konsignations-Ware, nicht
    // unsere), reserved (offene Teilzahlungs-Reservierung). Ein Purchase in diese Zustaende
    // fuer DENSELBEN Product-Datensatz ist eine fachliche Fehlbedienung — der Produkt-Picker
    // laesst sie zwar zu (kein Status-Filter), ein unterstuetzter Workflow ist es aber nicht.
    const PURCHASE_PROTECTED_STATUS = new Set(['with_agent', 'in_repair', 'consignment', 'consignment_reserved', 'reserved']);
    for (const pid of existingProductIds) {
      if (getAvailableStock(pid) <= 0) continue;        // kein aktiver Lot → nichts zu tun
      const curRows = query(`SELECT stock_status FROM products WHERE id = ?`, [pid]);
      const curStatus = String(curRows[0]?.stock_status || '');
      if (curStatus === 'in_stock' || PURCHASE_PROTECTED_STATUS.has(curStatus)) continue;
      db.run(`UPDATE products SET stock_status = 'in_stock', source_type = 'OWN', updated_at = ? WHERE id = ?`, [now, pid]);
      trackProductRow(pid);   // LAN-Sync Phase 1b: finaler autoritativer Product-Full-Row
    }

    // Initial payment (if any)
    let initialPaymentId: string | null = null;
    if (input.initialPayment && input.initialPayment.amount > 0) {
      initialPaymentId = uuid();
      db.run(
        `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [initialPaymentId, id, input.initialPayment.amount, input.initialPayment.method, purchaseDate, input.initialPayment.reference || null, null, now]
      );
      trackPayment('purchases', id, input.initialPayment.amount, input.initialPayment.method);
    }

    // Back-to-Back: verknuepfte Order-Zeilen auf ARRIVED + Order-Status hochrollen.
    if (input.sourceOrderId) {
      arriveLinkedOrderLines(db, lineRecords);
    }

    saveDatabase();
    trackInsert('purchases', id, { purchaseNumber, supplierId: input.supplierId, total });
    // LAN-Sync (Bug-3a): purchase_lines NACH dem Header tracken (FK-Reihenfolge). lineRecords
    // tragen bereits stabile l.id → 1:1 identisch auf A und B; sync-only, kein Audit.
    for (const l of lineRecords) trackChange('purchase_lines', l.id, 'insert', {});
    get().loadPurchases();

    // ZIEL.md §3a — Ledger-Posting nach Domain-Insert.
    safePost(`postPurchaseReceived(${id})`, () => {
      if (hasLedgerEntries('PURCHASE', id)) return;
      const fresh = get().getPurchase(id);
      if (fresh) postPurchaseReceived(fresh);
    });
    if (initialPaymentId && input.initialPayment) {
      const ipId = initialPaymentId;
      const ipMethod = input.initialPayment.method;
      safePost(`postPurchasePayment(${ipId}) [initial]`, () => {
        if (hasLedgerEntries('PURCHASE_PAYMENT', ipId)) return;
        const fresh = get().getPurchase(id);
        const ip = fresh?.payments.find(p => p.id === ipId);
        if (ip) postPurchasePayment(ip, input.supplierId);
        else if (fresh) {
          // Fallback wenn loadPurchases nicht alle Felder hatte
          postPurchasePayment(
            {
              id: ipId, purchaseId: id, amount: input.initialPayment!.amount,
              method: ipMethod, paidAt: purchaseDate, createdAt: now,
            },
            input.supplierId
          );
        }
      });
    }

    return get().getPurchase(id)!;
  },

  // R6D — die Hausfolge: Betrag > 0, storniert → Nein (vorher stilles Nichts), Rest und Status
  // guthabenbewusst (vorher `total − cash`, was eine Guthaben-Einloesung ueberschrieb), Buchung
  // strikt, Overpay → Lieferanten-Guthaben in DERSELBEN Klammer. Signatur unveraendert.
  addPayment: (purchaseId, amount, method, reference, note) => {
    atomar(() => recordPurchasePaymentInHouse(purchaseId, amount, method, localHouseCtx(), { reference, note }));
    get().loadPurchases();
  },

  // CENTRAL-UI-PARITY R6F — der Storno wohnt jetzt in `cancelPurchaseInHouse` (dieselbe Folge wie
  // die Maske „Cancel" und der Fernbefehl `purchases.cancel`). Dieser Anschluss bleibt fuer die
  // Altaufrufer (Kommission: Auto-Einkauf zuruecknehmen, Testseite) mit unveraenderter Signatur:
  // ein fehlender oder schon stornierter Einkauf ist wie bisher ein No-op, und die Regel der Maske
  // („nicht voll bezahlt") gilt hier nicht. Neu: gelesen wird aus der DATENBANK (vorher aus der
  // geladenen Liste — ein nicht geladener Einkauf wurde still NICHT storniert), EINE Klammer
  // (`atomar`, verschachtelt sich in eine offene Handlung), und jede Buchung ist strikt.
  cancelPurchase: (id) => {
    // `atomar` weist ein Fenster ohne Buecher ab, BEVOR hier irgendetwas gelesen wird.
    atomar(() => {
      const ctx = localHouseCtx();
      const st = query('SELECT status FROM purchases WHERE id = ? AND branch_id = ?', [id, ctx.branchId])[0];
      if (!st || String(st.status) === 'CANCELLED') return;
      cancelPurchaseInHouse(id, ctx.branchId, { now: ctx.now });
    });
    get().loadPurchases();
  },

  // ── Purchase Returns (Plan §Purchase Returns) ──

  // CENTRAL-UI-PARITY R6F — Anlage und Wirkung einer Retoure wohnen in der Hausfolge
  // (`createPurchaseReturnDraftInHouse` / `confirmPurchaseReturnInHouse`); „Confirm Return" der Maske
  // ruft beide als EINE Handlung (`returnToSupplierInHouse`). Diese zwei Altanschluesse behalten ihre
  // Signatur, lesen aus der DATENBANK (Filiale der Sitzung) und klammern sich selbst (`atomar`).
  createReturn: (input) => {
    const { returnId } = atomar(() => createPurchaseReturnDraftInHouse(input, localHouseCtx()));
    get().loadReturns();
    return get().getReturn(returnId)!;
  },

  // Confirm = perform the effects: reduce inventory + payable (Haus: strikte Buchung).
  confirmReturn: (id) => {
    atomar(() => {
      const ctx = localHouseCtx();
      const st = query('SELECT status FROM purchase_returns WHERE id = ? AND branch_id = ?', [id, ctx.branchId])[0];
      if (!st || String(st.status) !== 'DRAFT') return;
      confirmPurchaseReturnInHouse(id, ctx);
    });
    get().loadPurchases();
    get().loadReturns();
  },

  // Plan §Purchase Returns §9: manuelle Transition CONFIRMED → COMPLETED (z.B. nach Credit-Abwicklung).
  completeReturn: (id) => {
    const db = getDatabase();
    const ret = get().getReturn(id);
    if (!ret || ret.status !== 'CONFIRMED') return;
    db.run(`UPDATE purchase_returns SET status = 'COMPLETED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('purchase_returns', id, 'CONFIRMED', 'COMPLETED');
    trackChange('purchase_returns', id, 'update', {});   // LAN-Sync (Gruppe 1)
    get().loadReturns();
  },

  cancelReturn: (id) => {
    const ret = get().getReturn(id);
    if (!ret) return;
    if (ret.status === 'CANCELLED') return; // idempotent
    const now = new Date().toISOString();
    const prevStatus = ret.status;
    // Slice 4a — war der Return schon ausgefuehrt? Dann ALLE Effekte spiegeln, sonst bleiben
    // Ledger/Lots/Credits/Totals verwaist. Wirft, wenn ein bereits verbrauchter Supplier-Credit den
    // Reverse blockiert. R6F — die Umkehr ist strikt (Hausfolge) und laeuft in EINER Klammer.
    atomar(() => {
      if (prevStatus === 'CONFIRMED' || prevStatus === 'COMPLETED') reverseConfirmedPurchaseReturnInHouse(id, now);
      getDatabase().run(`UPDATE purchase_returns SET status = 'CANCELLED' WHERE id = ?`, [id]);
      trackStatusChange('purchase_returns', id, prevStatus, 'CANCELLED');
      trackChange('purchase_returns', id, 'update', {});   // LAN-Sync (Gruppe 1)
    });
    get().loadPurchases();
    get().loadReturns();
  },

  deleteReturn: (id) => {
    const ret = get().getReturn(id);
    const now = new Date().toISOString();
    // Slice 4a — bereits ausgefuehrte Returns vor dem Loeschen vollstaendig spiegeln
    // (sonst verwaiste Ledger/Lots/Credits/Totals). DRAFT/CANCELLED/REJECTED haben
    // keine aktiven Effekte. R6F — strikt und in EINER Klammer.
    atomar(() => {
      if (ret && (ret.status === 'CONFIRMED' || ret.status === 'COMPLETED')) reverseConfirmedPurchaseReturnInHouse(id, now);
      const db = getDatabase();
      db.run(`DELETE FROM purchase_return_lines WHERE return_id = ?`, [id]);
      db.run(`DELETE FROM purchase_returns WHERE id = ?`, [id]);
      trackDelete('purchase_returns', id);
    });
    get().loadPurchases();
    get().loadReturns();
  },
}));

/**
 * CENTRAL-UI-PARITY R2A — die gemeinsame Ladefunktion fuer Einkaeufe samt Zeilen und Zahlungen.
 *
 * Zustandsfrei: kein `set`, kein `get`, kein `currentBranchId()`. Die Filiale kommt aus dem
 * Ausweis, den der Aufrufer mitbringt — am Primary aus der eigenen Sitzung, aus der Ferne aus dem
 * geprueften Absender.
 */
export function loadPurchasesFor(ctx: BusinessReadContext): { purchases: Purchase[] } {
  const rows = query('SELECT * FROM purchases WHERE branch_id = ? ORDER BY created_at DESC', [ctx.branchId]);
  const purchases: Purchase[] = rows.map((r) => {
    const p = rowToPurchase(r);
    p.lines = query('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [p.id]).map(rowToLine);
    p.payments = query('SELECT * FROM purchase_payments WHERE purchase_id = ? ORDER BY paid_at ASC, created_at ASC', [p.id]).map(rowToPayment);
    return p;
  });
  return { purchases };
}

/**
 * CENTRAL-UI-PARITY R2A — die gemeinsame Ladefunktion fuer den offenen Wareneingang.
 *
 * Zustandsfrei: kein `set`, kein `get`, kein `currentBranchId()`. Die Filiale kommt aus dem
 * Ausweis, den der Aufrufer mitbringt — am Primary aus der eigenen Sitzung, aus der Ferne aus dem
 * geprueften Absender.
 */
export function loadPurchaseInboxFor(ctx: BusinessReadContext): { purchaseInbox: PurchaseInboxItem[] } {
  const rows = query(
    `SELECT * FROM purchase_inbox WHERE branch_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    [ctx.branchId],
  );
  const purchaseInbox = rows.map(rowToInboxItem);
  // MEDIA-INBOX — die Fotos als Referenzen dazu, in EINER Abfrage. Die Liste bleibt eine Liste.
  const refs = inboxPhotoRefsFor(purchaseInbox.map((i) => i.id), ctx.branchId);
  for (const item of purchaseInbox) {
    item.photos = (refs.get(item.id) ?? []).map((r) => ({
      mediaId: r.mediaId,
      main: { key: r.main.storageKey, hash: r.main.hash, extension: r.main.extension },
      thumb: r.thumbnail ? { key: r.thumbnail.storageKey, hash: r.thumbnail.hash, extension: r.thumbnail.extension } : null,
    }));
  }
  return { purchaseInbox };
}

/**
 * CENTRAL-UI-PARITY R2A — die gemeinsame Ladefunktion fuer Einkaufsretouren samt ihren Zeilen.
 *
 * Zustandsfrei: kein `set`, kein `get`, kein `currentBranchId()`. Die Filiale kommt aus dem
 * Ausweis, den der Aufrufer mitbringt — am Primary aus der eigenen Sitzung, aus der Ferne aus dem
 * geprueften Absender.
 */
export function loadPurchaseReturnsFor(ctx: BusinessReadContext): { returns: PurchaseReturn[] } {
  const rows = query('SELECT * FROM purchase_returns WHERE branch_id = ? ORDER BY created_at DESC', [ctx.branchId]);
  const returns: PurchaseReturn[] = rows.map((r) => {
    const pr = rowToReturn(r);
    pr.lines = query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [pr.id]).map(rowToReturnLine);
    return pr;
  });
  return { returns };
}
