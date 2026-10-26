// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — der Einkauf am Haus: dieselben Regeln, EINE Klammer.
//
// „Save Purchase" legte am Primary neue Artikel, Beleg, Zeilen, Lose, Menge, Status, Zahlung,
// Auftragsverknüpfung und Buchung in `createPurchase` an und markierte DANACH, getrennt, das Foto
// der Wareneingangs-Inbox als erledigt. Jetzt ist das EINE Folge — am Primary exklusiv in EINER
// Transaktion, fern in der Transaktion des Auftrags.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { trackProductRow } from '@/core/lots/lot-queries';
// PURCHASE-EDIT Teil 2 — der Port wohnt jetzt bei der Zeilenfolge (`purchase-lines.ts`); der Name bleibt hier erreichbar.
export { housePurchasePort };
import { skuIsEmpty } from '@/core/products/sku-allocation';
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
import { housePurchasePort, withAllocatedSkus, PURCHASE_LINE_OPS } from './purchase-lines';
import { applyIdentityDocument, identitySourceOf, IdentityMediaError } from '@/core/identity/identity-media';
import { prepareIdentityPhoto } from '@/core/identity/identity-save';
import {
  PurchaseEditRejected, editPurchaseInHouse, voidPurchasePaymentInHouse,
  type CorrectionKind, type PurchaseEditAddLine, type PurchaseEditRequest, type PurchaseEdited, type PurchasePaymentVoided,
} from './purchase-edit-house';
import { PurchaseActionRejected, planPurchaseCreate, purchaseCreateIssue, type PurchaseCreateInput } from './purchase-create';
import { EMBEDDED_PRODUCT_FIELDS, pickProductSpec, stageSpecImages } from '@/core/products/embedded-product';
import { stageRecordDataUrls } from '@/core/bridge/client-staging-upload';
import {
  PURCHASE_PRIMARY_ONLY, PurchaseLifecycleRejected,
  returnToSupplierInHouse, cancelPurchaseInHouse, dismissPurchaseInboxInHouse,
  type PurchaseReturnRequest, type PurchaseReturned, type PurchaseCancelled, type PurchaseInboxDismissed, type RefundMethod,
} from './purchase-lifecycle-house';

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
 * v0.8.91 — ein Auftragsartikel wird erst mit dem Wareneingang zum Lagerartikel (Back-to-Back: die Einkaufszeile
 * zeigt auf die Auftragsposition und auf den Artikel, den der Auftrag ohne SKU angelegt hat). Genau dann bekommt er
 * seine Nummer aus DEM Zähler — in der Klammer des Einkaufs. Nur so verknüpfte Zeilen: ein anderer vorhandener Artikel
 * ohne SKU wird hier nicht nummeriert (keine Massennummerierung alter Artikel), eine vorhandene SKU nie ersetzt.
 */
function skuForOrderStockArrivals(payload: Record<string, unknown>): void {
  const allocate = useProductStore.getState().allocateSkuOnCreate;
  for (const l of payload.lines as Array<Record<string, unknown>>) {
    if (!l.productId || !l.sourceOrderLineId) continue;
    const p = query('SELECT sku, brand, category_id FROM products WHERE id = ?', [String(l.productId)])[0];
    if (!p || !skuIsEmpty(p.sku)) continue;
    const sku = allocate(undefined, (p.brand as string | null) ?? undefined, (p.category_id as string | null) ?? undefined);
    if (!sku) continue;
    getDatabase().run('UPDATE products SET sku = ?, updated_at = ? WHERE id = ?', [sku, new Date().toISOString(), String(l.productId)]);
    trackProductRow(String(l.productId));
  }
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
  skuForOrderStockArrivals(payload);
  // MOBILE-PURCHASE — mehrere Zahlungen: jede über denselben Weg wie „Record Payment" (eigene Zeile,
  // eigene Buchung, Status neu gerechnet), mit dem Datum des Einkaufs. Keine Sammelbuchung.
  // v0.8.91 — der Desktop nennt je Zahlung einen eigenen Tag (geprüft in purchaseCreateIssue); ohne ihn wie bisher.
  if (input.payments && input.payments.length > 0) {
    const ctx = { branchId, userId, now: new Date().toISOString() };
    for (const p of input.payments) {
      alsEinkaufsNein(() => recordPurchasePaymentInHouse(purchase0.id, p.amount, p.method, ctx,
        { reference: p.reference || undefined, paidAt: p.paidDate || input.purchaseDate }));
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

// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT — „Save" der Einkaufsbearbeitung und „Void payment": am Primary `runOnPrimary`
// (exklusiv, EINE Transaktion, danach durabel), auf PC2 der Rumpf für den geprüften Fernbefehl —
// beide für DIESELBE Hausfolge (`purchase-edit-house.ts`).
// ════════════════════════════════════════════════════════════════════════════

/** Was die Maske „Edit purchase" den Menschen ändern lässt. `undefined` = unverändert. */
export interface PurchaseEditForm {
  reason: string;
  notes?: string | null;
  staffId?: string | null;
  purchaseDate?: string;
  supplierId?: string;
  confirmPaymentsToNewSupplier?: boolean;
  lines?: Array<{ lineId: string; unitPrice?: number; quantity?: number }>;
  correctionKind?: CorrectionKind;
  /** Das neue Ausweisfoto (Kamera/Galerie, schon normalisiert) und ob es auch die Person bekommt. */
  identityPhoto?: { dataUrl: string; alsoUpdatePerson?: boolean };
  /** Teil 2 — nachzutragende Positionen (ein neuer Artikel trägt seine Fotos als Datenbilder, wie beim Anlegen). */
  addLines?: PurchaseEditAddLine[];
  /** Teil 3 — zu entfernende Positionen. */
  removeLineIds?: string[];
}

/** Ändert diese Maske Geld oder Ware (Klasse C, nur Owner)? Dann `purchases.correct`, sonst `purchases.update`. */
export function isFinancialPurchaseEdit(form: PurchaseEditForm): boolean {
  return form.purchaseDate !== undefined || form.supplierId !== undefined
    || (form.lines !== undefined && form.lines.length > 0) || form.correctionKind !== undefined
    || (form.addLines !== undefined && form.addLines.length > 0) || (form.removeLineIds !== undefined && form.removeLineIds.length > 0);
}

/** Der Rumpf für `purchases.update` / `purchases.correct` — Summen, Lose, Buchungen rechnet der Primary. */
export function purchaseEditBody(
  purchase: { id: string }, form: PurchaseEditForm, stagingId?: string, stagedAddLines?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { purchaseId: purchase.id, expectedRevision: fassungVon(purchase), reason: form.reason };
  if (form.notes !== undefined) body.notes = form.notes;
  if (form.staffId !== undefined) body.staffId = form.staffId;
  if (stagingId) {
    body.identityPhotoStagingId = stagingId;
    if (form.identityPhoto?.alsoUpdatePerson) body.alsoUpdatePerson = true;
  }
  if (form.purchaseDate !== undefined) body.purchaseDate = form.purchaseDate;
  if (form.supplierId !== undefined) body.supplierId = form.supplierId;
  if (form.confirmPaymentsToNewSupplier !== undefined) body.confirmPaymentsToNewSupplier = form.confirmPaymentsToNewSupplier;
  if (form.lines !== undefined && form.lines.length > 0) body.lines = form.lines;
  if (form.correctionKind !== undefined) body.correctionKind = form.correctionKind;
  if (form.removeLineIds !== undefined && form.removeLineIds.length > 0) body.removeLineIds = [...form.removeLineIds];
  // Teil 2 — die Fotos eines neuen Artikels reisen als Ablagekennungen (`stagedAddLines`), nie als Bytes.
  if (stagedAddLines && stagedAddLines.length > 0) body.addLines = stagedAddLines;
  return body;
}

/** Teil 2 — die nachzutragenden Positionen für den Fernbefehl: Fotos vorab in die Ablage des Primary (wie „Save Purchase"). */
export async function stagePurchaseEditAddLines(
  lines: readonly PurchaseEditAddLine[], stage: (urls: readonly string[]) => Promise<string[]> = stageRecordDataUrls,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const l of lines) {
    const line: Record<string, unknown> = { mode: l.mode, quantity: l.quantity, unitPrice: l.unitPrice };
    if (l.productId) line.productId = l.productId;
    if (l.newProduct) line.newProduct = await stageSpecImages(pickProductSpec(l.newProduct, EMBEDDED_PRODUCT_FIELDS), stage);
    out.push(line);
  }
  return out;
}

/** „Save" am Primary: das neue Ausweisfoto VOR der Klammer aufnehmen (im Bereich der Person), dann EINE Klammer. */
export async function editPurchaseOnPrimary(purchaseId: string, form: PurchaseEditForm, expectedRevision?: number): Promise<PurchaseEdited> {
  const blocked = nurAmPrimary<PurchaseEdited>();
  if (blocked) return blocked;
  let identityPhoto: PurchaseEditRequest['identityPhoto'];
  if (form.identityPhoto) {
    const sid = form.supplierId
      ?? String(query('SELECT supplier_id FROM purchases WHERE id = ?', [purchaseId])[0]?.supplier_id ?? '');
    const owner = identitySourceOf('supplier', sid);
    const prepared = await prepareIdentityPhoto(false, owner.ownerType, { kind: 'set', dataUrl: form.identityPhoto.dataUrl },
      { staging: 'identityPhotoStagingId', remove: 'identityPhoto' }, owner.ownerId);
    if (prepared.kind === 'fail') {
      const o = prepared.outcome as { code?: string; message?: string };
      throw new PurchaseEditRejected(o.code ?? 'IDENTITY_INGEST_FAILED', o.message ?? 'The ID photo could not be stored. Nothing was saved.');
    }
    if (prepared.kind === 'ready' && prepared.mediaId) {
      identityPhoto = { mediaId: prepared.mediaId, alsoUpdatePerson: form.identityPhoto.alsoUpdatePerson === true };
    }
  }
  // Teil 2 — die Fotos eines neuen Artikels durch DENSELBEN Normalisierer wie beim Anlegen, vor der Klammer.
  let addLines: PurchaseEditAddLine[] | undefined;
  if (form.addLines && form.addLines.length > 0) {
    addLines = [];
    for (const l of form.addLines) addLines.push(l.newProduct ? { ...l, newProduct: await normalizeSpecImages(l.newProduct) } : l);
  }
  const req: PurchaseEditRequest = {
    purchaseId, reason: form.reason, notes: form.notes, staffId: form.staffId, purchaseDate: form.purchaseDate,
    supplierId: form.supplierId, confirmPaymentsToNewSupplier: form.confirmPaymentsToNewSupplier, lines: form.lines,
    correctionKind: form.correctionKind, ...(identityPhoto ? { identityPhoto } : {}),
    ...(addLines ? { addLines } : {}),
    ...(form.removeLineIds && form.removeLineIds.length > 0 ? { removeLineIds: form.removeLineIds } : {}),
  };
  return runOnPrimary(() => editPurchaseInHouse(req, localHouseCtx(), expectedRevision, PURCHASE_LINE_OPS), lebenszyklusLesen);
}

/** „Save" der Maske: EINE Buchung — am Primary die Hausfolge, auf PC2 der geprüfte Befehl (Foto vorher in die Ablage). */
export async function savePurchaseEdit(
  write: PurchaseLifecycleWrite<Result>, purchase: { id: string }, form: PurchaseEditForm,
): Promise<WriteOutcome<Result>> {
  if (!form.reason || !form.reason.trim()) return absage('PURCHASE_EDIT_REASON_REQUIRED', 'Please enter a reason for this edit.');
  const rev = fassungVon(purchase);
  if (write.remote && rev === undefined) return ohneFassung();
  let stagingId: string | undefined;
  if (write.remote && form.identityPhoto) {
    const prepared = await prepareIdentityPhoto(true, 'supplier', { kind: 'set', dataUrl: form.identityPhoto.dataUrl },
      { staging: 'identityPhotoStagingId', remove: 'identityPhoto' });
    if (prepared.kind === 'fail') return prepared.outcome as WriteOutcome<Result>;
    if (prepared.kind === 'ready') stagingId = String(prepared.body.identityPhotoStagingId ?? '') || undefined;
  }
  // Teil 2 — auf PC2 reisen die Fotos eines neuen Artikels vorab in die Ablage des Primary; der Auftrag nennt ihre Kennungen.
  let stagedAddLines: Array<Record<string, unknown>> | undefined;
  if (write.remote && form.addLines && form.addLines.length > 0) {
    try { stagedAddLines = await stagePurchaseEditAddLines(form.addLines); } catch (e) {
      return absage('STAGING_FAILED', `The photos of a new item could not be handed to the main computer (${e instanceof Error ? e.message : String(e)}). Nothing was saved.`);
    }
  }
  return speichern(write, {
    local: () => editPurchaseOnPrimary(purchase.id, form, rev) as unknown as Promise<Result>,
    remote: () => purchaseEditBody(purchase, form, stagingId, stagedAddLines),
  });
}

/** Der Rumpf für `purchases.void_payment`. */
export function purchaseVoidPaymentBody(purchase: { id: string }, paymentId: string, reason: string): Record<string, unknown> {
  return { purchaseId: purchase.id, paymentId, expectedRevision: fassungVon(purchase), reason };
}

/** „Void payment" am Primary. */
export function voidPurchasePaymentOnPrimary(purchaseId: string, paymentId: string, reason: string, expectedRevision?: number): Promise<PurchasePaymentVoided> {
  return nurAmPrimary<PurchasePaymentVoided>()
    ?? runOnPrimary(() => voidPurchasePaymentInHouse(purchaseId, paymentId, reason, localHouseCtx(), expectedRevision), lebenszyklusLesen);
}

/** „Void payment": EINE Buchung gegen die gesehene Fassung. */
export function savePurchasePaymentVoid(
  write: PurchaseLifecycleWrite<Result>, purchase: { id: string }, paymentId: string, reason: string,
): Promise<WriteOutcome<Result>> {
  if (!reason || !reason.trim()) return Promise.resolve(absage('PURCHASE_EDIT_REASON_REQUIRED', 'Please enter a reason for voiding this payment.'));
  const rev = fassungVon(purchase);
  if (write.remote && rev === undefined) return Promise.resolve(ohneFassung());
  return speichern(write, {
    local: () => voidPurchasePaymentOnPrimary(purchase.id, paymentId, reason.trim(), rev) as unknown as Promise<Result>,
    remote: () => purchaseVoidPaymentBody(purchase, paymentId, reason.trim()),
  });
}
