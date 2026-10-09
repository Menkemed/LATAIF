// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — der Einkauf am Haus: dieselben Regeln, EINE Klammer.
//
// „Save Purchase" legte am Primary neue Artikel, Beleg, Zeilen, Lose, Menge, Status, Zahlung,
// Auftragsverknüpfung und Buchung in `createPurchase` an und markierte DANACH, getrennt, das Foto
// der Wareneingangs-Inbox als erledigt. Jetzt ist das EINE Folge — am Primary exklusiv in EINER
// Transaktion, fern in der Transaktion des Auftrags.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useProductStore } from '@/stores/productStore';
import { useOrderStore } from '@/stores/orderStore';
import { useSupplierStore } from '@/stores/supplierStore';
import type { Purchase } from '@/core/models/types';
import type { WriteAdapters, WriteOutcome } from '@/core/data/shared-write';
import { isClientMode } from '@/core/bridge/client-mode';
import { localHouseCtx, recordPurchasePaymentInHouse, PayablesRejected } from '@/core/payables/payables-house';
import { useCustomerStore } from '@/stores/customerStore';
import { MasterdataInputError } from '@/core/masterdata/masterdata-rules';
import { normalizeSpecImages } from '@/core/media/record-image';
import { adoptInboxPhotosToProduct } from './inbox-media';
import { applyIdentityDocument, IdentityMediaError } from '@/core/identity/identity-media';
import { PurchaseActionRejected, planPurchaseCreate, purchaseCreateIssue, type PurchaseCreateInput, type PurchaseCreatePort } from './purchase-create';
import {
  PURCHASE_PRIMARY_ONLY, PurchaseLifecycleRejected,
  returnToSupplierInHouse, cancelPurchaseInHouse, dismissPurchaseInboxInHouse,
  type PurchaseReturnRequest, type PurchaseReturned, type PurchaseCancelled, type PurchaseInboxDismissed, type RefundMethod,
} from './purchase-lifecycle-house';

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function housePurchasePort(branchId: string): PurchaseCreatePort {
  const ps = useProductStore.getState();
  ps.loadCategories();
  ps.loadProducts();
  const has = (sql: string, p: unknown[]): boolean => !!query(sql, p)[0];
  return {
    // Die Lieferantenauswahl der Maske zeigt nur aktive.
    supplierActive: (id) => has('SELECT id FROM suppliers WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [id, branchId]),
    // Die Artikelauswahl der Maske: alles außer dem Reparatur-Service.
    productPickable: (id) => has(
      "SELECT id FROM products WHERE id = ? AND branch_id = ? AND COALESCE(category_id, '') NOT LIKE 'cat-repair-service%' AND COALESCE(category_id, '') NOT LIKE 'cat-bulk-metal%' AND id NOT LIKE 'bulk-%'",
      [id, branchId]),
    categoryExists: (id) => has('SELECT id FROM categories WHERE id = ? AND branch_id = ?', [id, branchId]),
    employeeActive: (id) => has(
      "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
      [id, branchId]),
    orderExists: (id) => has('SELECT id FROM orders WHERE id = ? AND branch_id = ?', [id, branchId]),
    orderLineOf: (lineId) => {
      const r = query('SELECT ol.order_id FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.id = ? AND o.branch_id = ?',
        [lineId, branchId])[0];
      return r ? String(r.order_id) : undefined;
    },
    inboxExists: (id) => has('SELECT id FROM purchase_inbox WHERE id = ? AND branch_id = ?', [id, branchId]),
    partnerActive: (id) => has('SELECT id FROM partners WHERE id = ? AND branch_id = ? AND active = 1', [id, branchId]),
    category: (id) => useProductStore.getState().categories.find((c) => c.id === id && !c.id.startsWith('cat-repair-service') && !c.id.startsWith('cat-bulk-metal')),
    isSkuTaken: (sku) => useProductStore.getState().isSkuTaken(sku),
  };
}

function frischLesen(): void {
  usePurchaseStore.getState().loadPurchases();
  useProductStore.getState().loadProducts();
  useOrderStore.getState().loadOrders();
}

/** Ein Nein der Stammdaten oder der Zahlungen als Nein des Einkaufs — derselbe Code, dieselben Worte. */
function alsEinkaufsNein<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof MasterdataInputError || e instanceof PayablesRejected) {
      throw new PurchaseActionRejected((e as { code: string }).code, e.message);
    }
    throw e;
  }
}

/**
 * MOBILE-PURCHASE — der Lieferant, der erst mit dem Einkauf entsteht. Dieselben Hausfunktionen wie
 * „New Supplier → Use existing customer": ein schon verknüpfter Lieferant wird wiederverwendet, ein
 * möglicher unverknüpfter Lieferant derselben Person fragt nach (`SUPPLIER_CANDIDATES_EXIST`), eine neue
 * Person wird zuerst normaler Kunde. Alles in der Transaktion des Einkaufs — scheitert er, bleibt nichts.
 */
function resolveSupplier(input: PurchaseCreateInput): { supplierId: string; customerId?: string } {
  if (input.supplierId) return { supplierId: input.supplierId };
  return alsEinkaufsNein(() => {
    if (input.supplierFromCustomer) {
      const fc = input.supplierFromCustomer;
      const r = useSupplierStore.getState().createSupplierFromCustomer(fc.customerId,
        { createDespiteExistingSuppliers: fc.createDespiteExistingSuppliers === true }, fc.seenCustomerUpdatedAt);
      return { supplierId: r.supplier.id, customerId: fc.customerId };
    }
    const np = input.newSupplierPerson!;
    const customer = useCustomerStore.getState().createCustomer(np.fields as never);
    // MOBILE-PURCHASE — das Ausweisfoto der neuen Person, wie bei `customers.create`: die Zeile ist
    // gerade entstanden, das Anlegen IST die Änderung, also keine zweite Fassung. In der Klammer.
    if (np.idMediaId) {
      try { applyIdentityDocument('customer', customer.id, np.idMediaId, { bumpOwner: false }); } catch (e) {
        if (e instanceof IdentityMediaError) throw new PurchaseActionRejected(e.code, e.message);
        throw e;
      }
    }
    const fresh = query('SELECT updated_at FROM customers WHERE id = ?', [customer.id])[0];
    const r = useSupplierStore.getState().createSupplierFromCustomer(customer.id,
      { createDespiteExistingSuppliers: np.createDespiteExistingSuppliers === true }, fresh ? String(fresh.updated_at) : undefined);
    return { supplierId: r.supplier.id, customerId: customer.id };
  });
}

/**
 * SKU-ALLOC — ein neuer Artikel ohne eingetippte SKU bekommt eine aus DEMSELBEN durablen Zähler wie
 * Collection, Kommission und Handy-Upload (`allocateSkuOnCreate`), am PC wie vom Telefon. Erst nach
 * der Planung — eine abgewiesene Eingabe verbraucht keine Nummer — und innerhalb der Klammer des
 * Einkaufs: scheitert er, fällt auch die Nummer zurück. Eine eingetippte SKU bleibt, wie sie ist.
 */
function withAllocatedSkus(payload: Record<string, unknown>): Record<string, unknown> {
  const allocate = useProductStore.getState().allocateSkuOnCreate;
  const lines = (payload.lines as Array<Record<string, unknown>>).map((l) => {
    if (l.productId) return l;
    const np = l.newProduct as Record<string, unknown> | undefined;
    if (np) {
      return np.sku ? l : { ...l, newProduct: { ...np, sku: allocate(undefined, np.brand as string | undefined, np.categoryId as string | undefined) } };
    }
    return l.newProductSku ? l : {
      ...l, newProductSku: allocate(undefined, l.newProductBrand as string | undefined, l.newProductCategoryId as string | undefined),
    };
  });
  return { ...payload, lines };
}

/** „Save Purchase": der Einkauf — und, wenn er aus einem Inbox-Foto kam, das Foto „erledigt". */
export function createPurchaseInHouse(input: PurchaseCreateInput, branchId: string, userId = ''): Purchase {
  return createPurchaseDetailedInHouse(input, branchId, userId).purchase;
}

/** Wie `createPurchaseInHouse`, dazu der aufgelöste Lieferant und ein neu angelegter Kunde. */
export function createPurchaseDetailedInHouse(input: PurchaseCreateInput, branchId: string, userId = '')
  : { purchase: Purchase; supplierId: string; customerId?: string } {
  // Erst die Eingaben prüfen (mit einem Platzhalter-Lieferanten, falls er erst entsteht), dann den
  // Lieferanten auflösen — so legt eine ungültige Zeile keinen Kunden oder Lieferanten an.
  const issue = purchaseCreateIssue(input);
  if (issue) throw new PurchaseActionRejected(issue.code, issue.message);
  const supplier = resolveSupplier(input);
  const resolved: PurchaseCreateInput = { ...input, supplierId: supplier.supplierId, supplierFromCustomer: undefined, newSupplierPerson: undefined };
  const payload = withAllocatedSkus(planPurchaseCreate(resolved, housePurchasePort(branchId)));
  const store = usePurchaseStore.getState();
  const purchase0 = store.createPurchase(payload as never);
  // MOBILE-PURCHASE — mehrere Zahlungen: jede über denselben Weg wie „Record Payment" (eigene Zeile,
  // eigene Buchung, Status neu gerechnet), mit dem Datum des Einkaufs. Keine Sammelbuchung.
  if (input.payments && input.payments.length > 0) {
    const ctx = { branchId, userId, now: new Date().toISOString() };
    for (const p of input.payments) {
      alsEinkaufsNein(() => recordPurchasePaymentInHouse(purchase0.id, p.amount, p.method, ctx,
        { reference: p.reference || undefined, paidAt: input.purchaseDate }));
    }
    store.loadPurchases();
  }
  const purchase = store.getPurchase(purchase0.id) ?? purchase0;
  if (input.inboxId) {
    // MEDIA-INBOX §6 — aus dem Posteingangsfoto wird das Bild des neuen Artikels: DASSELBE
    // Medienobjekt, neue Verknüpfung (`stock_image`, Klasse unverändert `internal`). Erst ab
    // hier ist es Artikelmedium, und erst ab hier gilt der Produktvertrag samt Embedding.
    // Entsteht kein neuer Artikel (der Einkauf lief auf einen vorhandenen), bleibt das Foto beim
    // Eintrag: er ist dann der einzige Ort, an dem dieser Nachweis hängt.
    const idx = input.lines.findIndex((l) => l.newProduct);
    const productId = idx >= 0 ? purchase.lines[idx]?.productId : undefined;
    if (productId) adoptInboxPhotosToProduct(input.inboxId, productId);
    usePurchaseStore.getState().markPurchaseInboxDone(input.inboxId);
  }
  return { purchase, supplierId: supplier.supplierId, customerId: supplier.customerId };
}

/** „Save Purchase" am Primary. */
export async function createPurchaseOnPrimary(input: PurchaseCreateInput): Promise<Purchase> {
  // POST-PARITY R7B PP-12 — die Fotos eines neuen Artikels durch den EINEN Normalisierer, wie fern —
  // vor der Klammer, damit das Umrechnen die Schreibreihenfolge nicht aufhält.
  const lines: PurchaseCreateInput['lines'] = [];
  for (const l of input.lines) lines.push(l.newProduct ? { ...l, newProduct: await normalizeSpecImages(l.newProduct) } : l);
  return runOnPrimary(() => createPurchaseInHouse({ ...input, lines }, currentBranchId()), frischLesen);
}

// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — der Lebenszyklus am Primary: „Return to Supplier", „Cancel",
// „Inbox-Foto verwerfen". Die Folgen wohnen in `purchase-lifecycle-house.ts` (ohne Store-Import);
// hier nur die Anschlüsse der Masken: am Primary `runOnPrimary` (exklusiv, EINE Transaktion, erst
// danach durabel), auf PC2 der Rumpf für den geprüften Fernbefehl — beide für DIESELBE Handlung.
// ════════════════════════════════════════════════════════════════════════════

/** Nach der Handlung (auch nach einem Rollback) die Listen frisch — auf PC2 holen dieselben Ladefunktionen vom Primary. */
function lebenszyklusLesen(): void {
  const ps = usePurchaseStore.getState();
  ps.loadPurchases();
  ps.loadReturns();
  ps.loadPurchaseInbox();
  useProductStore.getState().loadProducts();
  useOrderStore.getState().loadOrders();
  useSupplierStore.getState().loadSuppliers();
}
export const reloadPurchaseLifecycle = lebenszyklusLesen;

/** Ein Fenster ohne Bücher weist ab, BEVOR es eine Datenbank anfasst — die Handlung geht dort über die Brücke. */
function nurAmPrimary<T>(): Promise<T> | null {
  if (!isClientMode()) return null;
  return Promise.reject(new PurchaseLifecycleRejected(PURCHASE_PRIMARY_ONLY, 'this happens on the main computer — this window has no business database'));
}

/** „Confirm Return" am Primary: Retoure anlegen UND wirken lassen — EINE Klammer statt zweier Speichervorgänge. */
export function returnToSupplierOnPrimary(req: PurchaseReturnRequest, expectedRevision?: number): Promise<PurchaseReturned> {
  return nurAmPrimary<PurchaseReturned>()
    ?? runOnPrimary(() => returnToSupplierInHouse(req, localHouseCtx(), expectedRevision), lebenszyklusLesen);
}

/** „Confirm Cancel" am Primary — mit der Regel der Maske (nicht voll bezahlt). */
export function cancelPurchaseOnPrimary(purchaseId: string, expectedRevision?: number): Promise<PurchaseCancelled> {
  return nurAmPrimary<PurchaseCancelled>()
    ?? runOnPrimary(() => cancelPurchaseInHouse(purchaseId, localHouseCtx().branchId, { expectedRevision, blockPaid: true }), lebenszyklusLesen);
}

/** „Dismiss" am Inbox-Foto am Primary. */
export function dismissPurchaseInboxOnPrimary(inboxId: string): Promise<PurchaseInboxDismissed> {
  return nurAmPrimary<PurchaseInboxDismissed>()
    ?? runOnPrimary(() => dismissPurchaseInboxInHouse(inboxId, localHouseCtx().branchId), lebenszyklusLesen);
}

/** Die Fassung, die die Maske gesehen hat — sie kommt mit dem geladenen Einkauf (beide Rechner). */
function fassungVon(x: unknown): number | undefined {
  const r = Number((x as { revision?: unknown } | null | undefined)?.revision);
  return Number.isInteger(r) && r >= 1 ? r : undefined;
}

/** Was die Maske „Return to Supplier (PRET)" den Menschen wählen lässt — sonst nichts. */
export interface PurchaseReturnForm {
  refundMethod: RefundMethod;
  notes?: string;
  lines: Array<{ purchaseLineId: string; quantity: number; unitPrice: number }>;
}

/** Der Rumpf für `purchases.return_to_supplier` — Artikel, Summen, Erstattung, Datum und Nummer rechnet der Primary. */
export function purchaseReturnBody(purchase: { id: string }, form: PurchaseReturnForm): Record<string, unknown> {
  const notes = typeof form.notes === 'string' && form.notes.trim() ? form.notes.trim() : undefined;
  return {
    purchaseId: purchase.id,
    expectedRevision: fassungVon(purchase),
    refundMethod: form.refundMethod,
    ...(notes ? { notes } : {}),
    lines: form.lines.map((l) => ({ purchaseLineId: l.purchaseLineId, quantity: l.quantity, unitPrice: l.unitPrice })),
  };
}

/** Der Rumpf für `purchases.cancel`: welcher Einkauf, welche Fassung. */
export function purchaseCancelBody(purchase: { id: string }): Record<string, unknown> {
  return { purchaseId: purchase.id, expectedRevision: fassungVon(purchase) };
}

/** Der Rumpf für `purchases.dismiss_inbox`: welches Foto. */
export function inboxDismissBody(inboxId: string): Record<string, unknown> {
  return { inboxId };
}

/** Was eine Maske von ihrer Schreibweiche braucht — `useSharedWrite` passt direkt, `useSharedWrites` über `viaWrites`. */
export interface PurchaseLifecycleWrite<T> {
  readonly remote: boolean;
  save: (adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
}
type Result = Record<string, unknown>;

const absage = (code: string, message: string): WriteOutcome<Result> => ({ kind: 'business_error', code, message });
const ohneFassung = (): WriteOutcome<Result> =>
  absage('REVISION_UNKNOWN', 'this purchase is not loaded yet — reload the page and try again');

async function speichern(write: PurchaseLifecycleWrite<Result>, adapters: WriteAdapters<Result>): Promise<WriteOutcome<Result>> {
  const r = await write.save(adapters);
  if (r.kind === 'ok' && write.remote) lebenszyklusLesen();
  return r;
}

/** „Confirm Return": EINE Buchung — am Primary die Hausfolge, auf PC2 der geprüfte Befehl. */
export function savePurchaseReturn(
  write: PurchaseLifecycleWrite<Result>, purchase: { id: string }, form: PurchaseReturnForm,
): Promise<WriteOutcome<Result>> {
  // Eine angehakte Zeile mit Menge 0 gibt nichts zurück — sie reist nicht mit.
  const lines = form.lines.filter((l) => l.quantity > 0);
  if (lines.length === 0) return Promise.resolve(absage('PURCHASE_RETURN_NO_LINES', 'Select at least one item to return.'));
  const rev = fassungVon(purchase);
  if (write.remote && rev === undefined) return Promise.resolve(ohneFassung());
  const f: PurchaseReturnForm = { ...form, lines };
  return speichern(write, {
    local: () => returnToSupplierOnPrimary({ purchaseId: purchase.id, refundMethod: f.refundMethod, notes: f.notes, lines }, rev) as unknown as Promise<Result>,
    remote: () => purchaseReturnBody(purchase, f),
  });
}

/** „Confirm Cancel": EINE Buchung gegen die gesehene Fassung. */
export function savePurchaseCancel(write: PurchaseLifecycleWrite<Result>, purchase: { id: string }): Promise<WriteOutcome<Result>> {
  const rev = fassungVon(purchase);
  if (write.remote && rev === undefined) return Promise.resolve(ohneFassung());
  return speichern(write, {
    local: () => cancelPurchaseOnPrimary(purchase.id, rev) as unknown as Promise<Result>,
    remote: () => purchaseCancelBody(purchase),
  });
}

/** „Dismiss" am Inbox-Foto: EINE Buchung. */
export function saveInboxDismiss(write: PurchaseLifecycleWrite<Result>, inboxId: string): Promise<WriteOutcome<Result>> {
  return speichern(write, {
    local: () => dismissPurchaseInboxOnPrimary(inboxId) as unknown as Promise<Result>,
    remote: () => inboxDismissBody(inboxId),
  });
}
