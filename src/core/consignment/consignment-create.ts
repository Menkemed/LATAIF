// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5B — eine Kommission anlegen: EIN Vorgang, EIN Vertrag, beide Seiten.
//
// Die Kommissionsmaske legt mit einem Klick zwei Dinge an: den Artikel des Einlieferers und die
// Kommission daran. Bis hierher geschah das am Primary als zwei getrennte Schreibvorgänge
// (`createProduct`, dann `createConsignment`) ohne gemeinsame Klammer — scheiterte der zweite,
// blieb ein Artikel „in Kommission" ohne Kommission stehen. Die Bilder landeten dabei als Text in
// `products.images`, am Medienspeicher vorbei, den jede andere Anlage seit MEDIA-3B2B benutzt.
// Der Fernbefehl `consignments.create` wiederum nahm weder Bilder noch SKU, Attribute, Steuer,
// Lagerort, Lieferumfang oder Mitarbeiter an.
//
// Jetzt ist es EIN Vorgang:
//
//   1. dieselben Prüfungen (Einlieferer, vereinbarter Preis, Auszahlungsmodell über die SSOT
//      `buildPayoutPatch`, Pflichtfelder und SKU über `planProductCreate`);
//   2. der Artikel über DENSELBEN Anlageweg wie jede andere Anlage (`createProductWithMedia`,
//      Bilder in den Medienspeicher) — mit den vier festen Werten des Kommissionseingangs;
//   3. die Kommission (`createConsignment`).
//
// Alles in EINER Transaktion: am Primary klammert `createConsignmentOnPrimary`, beim Fernbefehl
// klammert der Auftrag selbst. Scheitert irgendein Schritt, gibt es weder Artikel noch Kommission
// noch Bildverknüpfung. Bereits veröffentlichte Bilddateien sind dann verwaist — dafür gibt es die
// Medien-Müllabfuhr; einen halben Vorgang gibt es nicht.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { buildPayoutPatch, PayoutPatchError } from './payout-edit';
import { planProductCreate, productCreateRefusal } from '@/core/products/product-create';
import { skuIsEmpty } from '@/core/products/sku-allocation';
import { CONSIGNMENT_PRODUCT_FIELDS, createPayload } from '@/core/data/write-payloads';
import { useProductStore } from '@/stores/productStore';
import { useConsignmentStore } from '@/stores/consignmentStore';
import type { Category, Consignment, Product } from '@/core/models/types';
import type { MediaSource, ProductCreateResult } from '@/core/media/product-media-create';

/** Ein fachliches Nein — mit dem Code, den auch der Fernbefehl meldet. */
export class ConsignmentCreateRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConsignmentCreateRejected';
    this.code = code;
  }
}

/** Kein Nein, sondern ein Ausfall: die Bilder kamen nicht vollständig an. Alles geht zurück. */
export class ConsignmentMediaIncomplete extends Error {
  readonly code = 'PRODUCT_MEDIA_INCOMPLETE';
  constructor(message: string) {
    super(message);
    this.name = 'ConsignmentMediaIncomplete';
  }
}

export interface ConsignmentCreateInput {
  consignorId: string;
  /** Was die Maske für den Artikel erfasst (ohne Bilder — die kommen als `MediaSource`). */
  product: Partial<Product>;
  agreedPrice: number;
  minimumPrice?: number;
  payout: { model: unknown; commissionRate?: unknown; excessSplitPct?: unknown };
  expiryDate?: string;
  notes?: string;
  staffId?: string;
}

export interface ConsignmentCreatePort {
  consignorExists: (id: string) => boolean;
  category: (id: string) => Category | undefined;
  isSkuTaken: (sku: string) => boolean;
  allocateSku: (brand: string | undefined, categoryId: string | undefined) => string;
  createProductWithMedia: (data: Partial<Product>, source: MediaSource) => Promise<ProductCreateResult>;
  createConsignment: (data: Partial<Consignment>) => Consignment;
}

export interface ConsignmentCreated {
  consignment: Consignment;
  productId: string;
  sku: string;
}

/** Der Vorgang selbst — ohne eigene Klammer. Wer ihn ruft, hält die Transaktion. */
export async function createConsignmentWithProduct(
  input: ConsignmentCreateInput, images: MediaSource, port: ConsignmentCreatePort,
): Promise<ConsignmentCreated> {
  if (!input.consignorId || !port.consignorExists(input.consignorId)) {
    throw new ConsignmentCreateRejected('CONSIGNOR_NOT_FOUND', 'no such client in this branch');
  }
  if (!(Number(input.agreedPrice) > 0)) {
    throw new ConsignmentCreateRejected('AGREED_PRICE_REQUIRED', 'a consignment needs an agreed price');
  }
  // Das Modell baut die SSOT, nicht die Maske: Prozentbereich, Shop-Anteil zwischen 1 und 99, und
  // die Parameter FREMDER Modelle ausdrücklich leer — dieselbe Regel wie beim Ändern.
  let patch;
  try {
    patch = buildPayoutPatch(input.payout);
  } catch (e) {
    if (e instanceof PayoutPatchError) throw new ConsignmentCreateRejected('PAYOUT_MODEL_INVALID', e.message);
    throw e;
  }

  const categoryId = String(input.product.categoryId ?? '');
  const plan = planProductCreate({ ...input.product, categoryId }, {
    category: port.category(categoryId), isSkuTaken: port.isSkuTaken, allocateSku: port.allocateSku,
  });
  if (plan.kind !== 'ok') {
    const r = productCreateRefusal(plan);
    throw new ConsignmentCreateRejected(r.code, r.message);
  }

  // Der Artikel über DENSELBEN Anlageweg wie jede andere Anlage — mit den vier festen Werten des
  // Kommissionseingangs: die Ware gehört uns nicht, was sie uns kostet, entscheidet der Verkauf.
  const { images: _nichtHier, ...ohneBilder } = plan.data;
  void _nichtHier;
  const made = await port.createProductWithMedia({
    ...ohneBilder,
    purchasePrice: 0,
    stockStatus: 'consignment',
    sourceType: 'CONSIGNMENT',
    quantity: 1,
  }, images);
  if (made.status !== 'created') {
    throw new ConsignmentMediaIncomplete(`${made.status}: ${made.errorCode}`);
  }

  const consignment = port.createConsignment({
    consignorId: input.consignorId,
    productId: made.productId,
    agreedPrice: Number(input.agreedPrice),
    minimumPrice: input.minimumPrice,
    commissionType: patch.commissionType,
    // Model 1 (percent): der Satz. Model 2/3: kein eigener Satz — genau wie bisher an der Maske.
    commissionRate: patch.commissionType === 'percent' ? patch.commissionRate : 0,
    excessSplitPct: patch.excessSplitPct ?? undefined,
    expiryDate: input.expiryDate || undefined,
    notes: input.notes || undefined,
    staffId: input.staffId || undefined,
  });
  return { consignment, productId: made.productId, sku: plan.data.sku };
}

/**
 * Die Anschlüsse des Hauses. Der Artikelbestand wird FRISCH geladen: der SKU-Riegel und die
 * Kategorie gelten gegen das, was wirklich da ist, nicht gegen den Stand eines Bildschirms.
 */
export function houseConsignmentPort(branchId: string): ConsignmentCreatePort {
  const ps = useProductStore.getState();
  ps.loadProducts();
  ps.loadCategories();
  return {
    consignorExists: (id) => !!query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId],
    )[0],
    category: (id) => useProductStore.getState().getCategory(id),
    isSkuTaken: (sku) => useProductStore.getState().isSkuTaken(sku),
    allocateSku: (brand, categoryId) => useProductStore.getState().allocateSkuOnCreate(undefined, brand, categoryId),
    // Die Klammer hält der Aufrufer — der Anlageweg darf sich deshalb nicht noch einmal einreihen.
    createProductWithMedia: (data, source) =>
      useProductStore.getState().createProductWithMedia(data, undefined, undefined, source, { alreadySerialised: true }),
    createConsignment: (data) => useConsignmentStore.getState().createConsignment(data),
  };
}

/**
 * Am Primary: derselbe Vorgang, in EINER Transaktion und exklusiv. Erst nach dem Commit wird
 * durabel gespeichert; bei jedem Fehler wird alles zurückgenommen.
 */
export function createConsignmentOnPrimary(input: ConsignmentCreateInput, images: MediaSource): Promise<ConsignmentCreated> {
  return runExclusive(async () => {
    const port = houseConsignmentPort(currentBranchId());
    beginLedgerTransaction();
    let out: ConsignmentCreated;
    try {
      out = await createConsignmentWithProduct(input, images, port);
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      useProductStore.getState().loadProducts();
      useConsignmentStore.getState().loadConsignments();
      throw e;
    }
    await saveDatabaseDurably();
    useProductStore.getState().loadProducts();
    useConsignmentStore.getState().loadConsignments();
    return out;
  });
}

/**
 * Der Rumpf vom zweiten Rechner: die Felder der Maske (ohne die leeren), die SKU getrimmt, statt
 * der Bilder ihre Kennungen in der Zwischenablage. `acknowledgeDuplicate` ist die Antwort auf die
 * Duplikatsfrage, die DIESELBE Maske vorher gestellt hat — genau wie „Create anyway" am Primary.
 */
export function consignmentCreateRequest(input: ConsignmentCreateInput, stagingIds: readonly string[]): Record<string, unknown> {
  const product = createPayload(input.product as Record<string, unknown>, CONSIGNMENT_PRODUCT_FIELDS);
  const typed = skuIsEmpty(input.product.sku) ? '' : String(input.product.sku).trim();
  if (typed) product.sku = typed;
  const payout: Record<string, unknown> = { model: input.payout.model };
  if (input.payout.model === 'percent') payout.commissionRate = input.payout.commissionRate;
  if (input.payout.model === 'cost_split') payout.excessSplitPct = input.payout.excessSplitPct;
  const body: Record<string, unknown> = {
    consignorId: input.consignorId,
    product,
    agreedPrice: input.agreedPrice,
    payout,
    acknowledgeDuplicate: true,
  };
  if (input.minimumPrice !== undefined) body.minimumPrice = input.minimumPrice;
  if (input.expiryDate) body.expiryDate = input.expiryDate;
  if (input.notes) body.notes = input.notes;
  if (input.staffId) body.staffId = input.staffId;
  if (stagingIds.length > 0) body.stagingIds = [...stagingIds];
  return body;
}
