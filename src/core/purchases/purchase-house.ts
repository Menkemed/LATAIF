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
import { localHouseCtx } from '@/core/payables/payables-house';
import { normalizeSpecImages } from '@/core/media/record-image';
import { adoptInboxPhotosToProduct } from './inbox-media';
import { planPurchaseCreate, type PurchaseCreateInput, type PurchaseCreatePort } from './purchase-create';
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
      "SELECT id FROM products WHERE id = ? AND branch_id = ? AND COALESCE(category_id, '') NOT LIKE 'cat-repair-service%'",
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
    category: (id) => useProductStore.getState().categories.find((c) => c.id === id && !c.id.startsWith('cat-repair-service')),
    isSkuTaken: (sku) => useProductStore.getState().isSkuTaken(sku),
  };
}

function frischLesen(): void {
  usePurchaseStore.getState().loadPurchases();
  useProductStore.getState().loadProducts();
  useOrderStore.getState().loadOrders();
}

/** „Save Purchase": der Einkauf — und, wenn er aus einem Inbox-Foto kam, das Foto „erledigt". */
export function createPurchaseInHouse(input: PurchaseCreateInput, branchId: string): Purchase {
  const payload = planPurchaseCreate(input, housePurchasePort(branchId));
  const store = usePurchaseStore.getState();
  const purchase = store.createPurchase(payload as never);
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
  return purchase;
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
