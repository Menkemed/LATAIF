// ═════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN (Owner 23.11.2026, Lösung E) — Modellgruppen.
//
// Mehrere eigenständige Artikel (eigene SKU, eigenes Gewicht, eigener Preis, eigener Bestand, eigene Buchungen) gehören
// zu EINEM Modell. Gespeichert wird nur die Zuordnung `product_models (product_id → model_key)` — eine Zeile je gruppiertem
// Artikel, nur am Primary, nicht im Abgleichsvertrag. Gruppieren, Entfernen und Auflösen schreiben NIE in `products`,
// `stock_lots`, Rechnungen oder Buchungen; nur in diese Tabelle und ins Audit.
//
// Regeln (Owner):
//   • nur manuell — nie automatisch nach ähnlichen Namen;
//   • nur innerhalb derselben Filiale, derselben Kategorie, derselben Marke und derselben Warenart (item_type);
//   • eigene Ware und Kommissionsware strikt getrennt;
//   • mehrere Stücke derselben Größe erlaubt; verkaufte Stücke bleiben im Modell sichtbar;
//   • der Modellname kommt aus den Artikeln (häufigster Name) — keine Stammdatentabelle.
//
// „Merge Photos": die gewählten Varianten verweisen danach auf EIN bestehendes Medienobjekt (dieselbe Datei, keine neue
// Datei, keine Neukodierung). Bisherige Bilder bleiben als weitere Bilder am Artikel oder werden nur gelöst (Verknüpfung
// weich entfernt, Datei bleibt). Endgültig entfernt wird eine Datei nie hier, sondern nur über die bestehende Medien-
// Freigabe (Referenzprüfung, Probelauf, Quarantäne). Verkaufte Artikel werden nie angefasst.
//
// Alle Hausfunktionen laufen in der Transaktion des Aufrufers (Primary: `runOnPrimary`, PC2: der Fernauftrag) und prüfen
// VOR dem ersten Schreiben alles, was sie prüfen können — ein Nein lässt die Datenbank unverändert.
// ═════════════════════════════════════════════════════════════════

import { query } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { roleHasPermission } from '@/core/auth/role-permissions';
import { MediaOwnerLinks } from '@/core/media/media-links';
import type { MediaOwner } from '@/core/media/media-owner';
import { trackChange, watchSyncTracks } from '@/core/sync/sync-service';
import { belongsToConsignment } from '@/core/consignment/consignment-sale-link';
import { dissolveSingleMemberModels, type LeftoverDb } from '@/core/products/product-leftovers';

export const PRODUCT_MODELS_GROUP_OP = 'product_models.group';
export const PRODUCT_MODELS_UNGROUP_OP = 'product_models.ungroup';
export const PRODUCT_MODELS_MERGE_PHOTOS_OP = 'product_models.merge_photos';

/** Wer handelt — am Primary aus der Sitzung, beim Fernauftrag aus dem geprüften Token. */
export interface ProductModelCtx {
  branchId: string;
  userId: string;
  role?: string | null;
  now: string;
}

export class ProductModelRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProductModelRejected';
    this.code = code;
  }
}
const nein = (code: string, message: string): never => { throw new ProductModelRejected(code, message); };

// ── Fachregeln (rein, ohne Datenbank — dieselbe Regel für die Anzeige am Primary und am PC2) ─────────────────────

/** Die Merkmale eines Artikels, die über die Gruppierbarkeit entscheiden. */
export interface ModelCandidate {
  id: string;
  branchId: string;
  categoryId: string;
  brand: string;
  attributes: Record<string, unknown>;
  /** 'OWN' | 'CONSIGNMENT' | 'AGENT' — eigene Ware und Kommissionsware nie gemischt */
  ownership: string;
  stockStatus: string;
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();
/** Warenart: item_type (Schmuck, Zubehör) bzw. part_type (Ersatzteil); Uhren haben keine — dann zählt die Kategorie. */
export const warenart = (attrs: Record<string, unknown> | null | undefined): string => norm(attrs?.item_type ?? attrs?.part_type ?? '');

/** Bulk-Systemartikel und Reparatur-Service gehören in kein Modell. */
export function isSystemArticle(id: string, categoryId: string): boolean {
  return id.startsWith('bulk-') || id.startsWith('svc-repair-') || categoryId.startsWith('cat-repair-service') || categoryId.startsWith('cat-bulk-metal');
}

/** Status, mit denen ein Artikel NEU in ein Modell kommen darf (verkaufte ja — sie bleiben sichtbar; verbrauchte/abgeschriebene nicht). */
export function mayJoinModel(stockStatus: string): boolean {
  const s = norm(stockStatus);
  return s !== 'consumed' && s !== 'write_off';
}

/** Darf `candidate` mit `anchor` in EIN Modell? `null` = ja, sonst der Grund (Englisch, wie die App). */
export function modelCompatibilityReason(anchor: ModelCandidate, candidate: ModelCandidate): string | null {
  if (candidate.id === anchor.id) return null;
  if (isSystemArticle(candidate.id, candidate.categoryId)) return 'System item — cannot be part of a model';
  if (!mayJoinModel(candidate.stockStatus)) return 'Consumed or written off — cannot join a model';
  if (candidate.branchId !== anchor.branchId) return 'Different branch';
  if (norm(candidate.ownership) !== norm(anchor.ownership)) {
    return norm(candidate.ownership) === 'consignment'
      ? 'Consignment item — only with consignment items of the same model'
      : 'Own stock — never together with consignment items';
  }
  if (candidate.categoryId !== anchor.categoryId) return 'Different category';
  if (norm(candidate.brand) !== norm(anchor.brand)) return 'Different brand';
  if (warenart(candidate.attributes) !== warenart(anchor.attributes)) return 'Different item type';
  return null;
}

/** Der angezeigte Modellname: der häufigste Artikelname (bei Gleichstand alphabetisch). Kein eigener Stammsatz. */
export function modelDisplayName(names: readonly string[]): string {
  const c = new Map<string, number>();
  for (const n of names) { const k = String(n ?? '').trim(); if (k) c.set(k, (c.get(k) ?? 0) + 1); }
  const best = [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best ? best[0] : '';
}

/** Gilt ein Artikel als „verfügbar" (zählt zum Bestand des Modells)? Verkaufte/verbrauchte/abgeschriebene nicht. */
export function isAvailableVariant(stockStatus: string): boolean {
  const s = norm(stockStatus);
  return s === 'in_stock' || s === 'consignment' || s === 'offered';
}

/** Darf das Bild eines Artikels beim „Merge Photos" geändert werden? Verkaufte und erledigte nie. */
export function mayChangeVariantPhoto(stockStatus: string): boolean {
  const s = norm(stockStatus);
  return s !== 'sold' && s !== 'consumed' && s !== 'write_off';
}

// ── Lesen ──────────────────────────────────────────────────────────────────────────────────────────────────

function hasModelTable(): boolean {
  return query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_models'`).length > 0;
}

/** Alle Zuordnungen der Filiale: productId → modelKey. Für Collection und Detail (Primary lokal, PC2 über `store.products.get`). */
export function loadProductModelsFor(branchId: string): Record<string, string> {
  if (!hasModelTable()) return {};
  const out: Record<string, string> = {};
  for (const r of query(`SELECT m.product_id, m.model_key FROM product_models m JOIN products p ON p.id = m.product_id
                          WHERE p.branch_id = ?`, [branchId])) {
    out[String(r.product_id)] = String(r.model_key);
  }
  return out;
}

function productRows(ids: readonly string[]): Record<string, unknown>[] {
  if (ids.length === 0) return [];
  return query(`SELECT id, branch_id, category_id, brand, name, attributes, source_type, stock_status, images, updated_at
                  FROM products WHERE id IN (${ids.map(() => '?').join(',')})`, [...ids]);
}

function parseAttrs(v: unknown): Record<string, unknown> {
  try { const o = JSON.parse(String(v ?? '{}')); return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {}; } catch { return {}; }
}

function candidateOf(r: Record<string, unknown>): ModelCandidate {
  const id = String(r.id);
  return {
    id,
    branchId: String(r.branch_id ?? ''),
    categoryId: String(r.category_id ?? ''),
    brand: String(r.brand ?? ''),
    attributes: parseAttrs(r.attributes),
    // Strenger als die Anzeige: auch eine offene Kommissionszeile macht den Artikel zur Kommissionsware.
    ownership: belongsToConsignment(id) ? 'CONSIGNMENT' : String(r.source_type || 'OWN').toUpperCase(),
    stockStatus: String(r.stock_status ?? ''),
  };
}

function modelKeyOf(productId: string): string | null {
  const r = query('SELECT model_key FROM product_models WHERE product_id = ?', [productId])[0];
  return r ? String(r.model_key) : null;
}
function membersOf(modelKey: string): string[] {
  return query('SELECT product_id FROM product_models WHERE model_key = ? ORDER BY product_id', [modelKey]).map((r) => String(r.product_id));
}

function newModelKey(): string {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return 'mdl-' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function assertMayEdit(ctx: ProductModelCtx): void {
  if (!roleHasPermission(ctx.role ?? null, 'products.edit')) nein('PERMISSION_DENIED', 'You are not allowed to change product models.');
}
const actor = (ctx: ProductModelCtx) => ({ userId: ctx.userId, branchId: ctx.branchId });

// ── Gruppieren ───────────────────────────────────────────────────────────────────────────────────────────────

export interface GroupInput {
  productIds: string[];
  /** bestehendes Modell, dem die Artikel beitreten — fehlt es, entsteht ein neues (mindestens zwei Artikel) */
  modelKey?: string | null;
}
export interface GroupResult { modelKey: string; added: string[] }

/** Prüft, ohne zu schreiben. Wirft `ProductModelRejected`. Gibt den Plan zurück. */
function planGroup(input: GroupInput, ctx: ProductModelCtx): { modelKey: string; isNew: boolean; add: string[] } {
  assertMayEdit(ctx);
  const ids = [...new Set((input.productIds ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  const target = input.modelKey ? String(input.modelKey) : null;
  const existing = target ? membersOf(target) : [];
  if (target && existing.length === 0) nein('PRODUCT_MODEL_NOT_FOUND', 'This model no longer exists.');
  const add = ids.filter((id) => !existing.includes(id));
  if (target ? add.length < 1 : add.length < 2) {
    nein('PRODUCT_MODEL_TOO_FEW', target ? 'Choose at least one item to add.' : 'Choose at least two items for a new model.');
  }
  const rows = productRows([...existing, ...add]);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const id of [...existing, ...add]) if (!byId.has(id)) nein('PRODUCT_MODEL_ITEM_MISSING', 'An item no longer exists.');
  const anchor = candidateOf(byId.get(existing[0] ?? add[0])!);
  if (anchor.branchId !== ctx.branchId) nein('PRODUCT_MODEL_OTHER_BRANCH', 'Models can only be changed in their own branch.');
  for (const id of add) {
    const c = candidateOf(byId.get(id)!);
    // Der Anker selbst muss ebenfalls in ein Modell dürfen (System-/erledigte Artikel nie).
    if (id === anchor.id && (isSystemArticle(c.id, c.categoryId) || !mayJoinModel(c.stockStatus))) {
      nein('PRODUCT_MODEL_INCOMPATIBLE', `${id}: this item cannot be part of a model`);
    }
    const reason = modelCompatibilityReason(anchor, c);
    if (reason) nein('PRODUCT_MODEL_INCOMPATIBLE', `${String(byId.get(id)!.name ?? id)}: ${reason}`);
    const other = modelKeyOf(id);
    if (other && other !== target) nein('PRODUCT_MODEL_IN_OTHER_MODEL', `${String(byId.get(id)!.name ?? id)} already belongs to another model — remove it there first.`);
  }
  return { modelKey: target ?? newModelKey(), isNew: !target, add };
}

/** Prüft, ohne zu schreiben: `null` = möglich, sonst der Grund. Für Hinweise vor dem Speichern. */
export function checkGroup(input: GroupInput, ctx: ProductModelCtx): { code: string; message: string } | null {
  try { planGroup(input, ctx); return null; } catch (e) {
    if (e instanceof ProductModelRejected) return { code: e.code, message: e.message };
    throw e;
  }
}

/** Gruppieren — in der Transaktion des Aufrufers. Schreibt nur `product_models` und das Audit. */
export function groupProductsInHouse(input: GroupInput, ctx: ProductModelCtx): GroupResult {
  const p = planGroup(input, ctx);
  const db = getDatabase();
  for (const id of p.add) {
    db.run('INSERT INTO product_models (product_id, model_key) VALUES (?, ?)', [id, p.modelKey]);
    logAuditOrThrow({
      module: 'Product', entityType: 'product_models', entityId: id, action: 'CREATE',
      field: 'model_key', newValue: p.modelKey, actor: actor(ctx),
    });
  }
  return { modelKey: p.modelKey, added: p.add };
}

// ── Add Variant: ein NEUER Artikel tritt einem Modell bei (in DERSELBEN Transaktion wie seine Anlage) ──────────────

export interface VariantIntent {
  /** das Modell, dem die Variante beitritt (Einstieg über ein bestehendes Modell) */
  modelKey?: string | null;
  /**
   * PURCHASE ADD VARIANT (Owner 25.11.2026) — der Ausgangsartikel. Gehört er schon zu einem Modell, tritt die Variante
   * diesem bei; sonst entsteht beim Speichern ein neues Modell aus Ausgangsartikel und Variante. Genau eins von beiden.
   */
  anchorProductId?: string | null;
  /** auf Wunsch das bestehende Modellbild (ein Medium, das an einem Artikel dieses Modells hängt) */
  pickMediaId?: string | null;
}
export interface VariantCandidateData {
  categoryId: string;
  brand?: string | null;
  attributes?: Record<string, unknown> | null;
}

/**
 * Der Rumpf einer Varianten-Absicht, streng — für `products.create` UND die Einkaufszeile von `purchases.create`:
 * {modelKey | anchorProductId, pickMediaId?}, nur Kennungen. Ein älterer Client schickt weiter nur `modelKey`.
 */
export function parseVariantShape(v: unknown, fehler: (m: string) => Error): VariantIntent {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fehler('variant must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'modelKey' && k !== 'anchorProductId' && k !== 'pickMediaId') throw fehler(`unknown field: variant.${k}`);
  const ok = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '' && x.length <= 200;
  const hasKey = o.modelKey !== undefined && o.modelKey !== null;
  const hasAnchor = o.anchorProductId !== undefined && o.anchorProductId !== null;
  if (hasKey === hasAnchor) throw fehler('variant needs exactly one of modelKey or anchorProductId');
  if (hasKey && !ok(o.modelKey)) throw fehler('variant.modelKey must be an id');
  if (hasAnchor && !ok(o.anchorProductId)) throw fehler('variant.anchorProductId must be an id');
  if (o.pickMediaId !== undefined && o.pickMediaId !== null && !ok(o.pickMediaId)) throw fehler('variant.pickMediaId must be an id');
  const pick = ok(o.pickMediaId) ? o.pickMediaId.trim() : null;
  return hasKey ? { modelKey: (o.modelKey as string).trim(), pickMediaId: pick } : { anchorProductId: (o.anchorProductId as string).trim(), pickMediaId: pick };
}

/** Der Artikel, an dem die Regel für eine neue Variante gemessen wird: ein Mitglied des Modells oder der Ausgangsartikel. */
function variantAnchor(intent: VariantIntent): ModelCandidate {
  const hasKey = typeof intent.modelKey === 'string' && intent.modelKey.trim() !== '';
  const hasAnchor = typeof intent.anchorProductId === 'string' && intent.anchorProductId.trim() !== '';
  if (hasKey === hasAnchor) nein('PRODUCT_MODEL_VARIANT_TARGET', 'Name either the model or the item the variant belongs to.');
  if (hasKey) {
    const members = membersOf(String(intent.modelKey));
    if (members.length < 2) nein('PRODUCT_MODEL_NOT_FOUND', 'This model no longer exists.');
    const row = productRows([members[0]])[0];
    if (!row) nein('PRODUCT_MODEL_NOT_FOUND', 'This model no longer exists.');
    return candidateOf(row!);
  }
  const row = productRows([String(intent.anchorProductId)])[0];
  if (!row) nein('PRODUCT_MODEL_ITEM_MISSING', 'The item this variant belongs to no longer exists.');
  return candidateOf(row!);
}

/**
 * Passt ein NEU anzulegender Artikel in das Modell? „Add variant" legt über den gewöhnlichen Weg („New Item") an —
 * und der legt eigene Ware an. Eine Kommissions-Variante entsteht nur über die Kommissionsaufnahme. Wirft vor jedem Schreiben.
 */
export function checkVariantFits(intent: VariantIntent, data: VariantCandidateData, ctx: ProductModelCtx): void {
  assertMayEdit(ctx);
  const anchor = variantAnchor(intent);
  if (anchor.branchId !== ctx.branchId) nein('PRODUCT_MODEL_OTHER_BRANCH', 'Models can only be changed in their own branch.');
  // Ein Ausgangsartikel ohne Modell muss selbst in ein Modell dürfen (System-, verbrauchte, abgeschriebene nie).
  if (!intent.modelKey && (isSystemArticle(anchor.id, anchor.categoryId) || !mayJoinModel(anchor.stockStatus))) {
    nein('PRODUCT_MODEL_INCOMPATIBLE', 'This item cannot be part of a model.');
  }
  if (norm(anchor.ownership) === 'consignment') {
    nein('PRODUCT_MODEL_VARIANT_CONSIGNMENT', 'This model is consignment stock — add further pieces through the consignment intake, not as a new own item.');
  }
  const reason = modelCompatibilityReason(anchor, {
    id: '__new__', branchId: ctx.branchId, categoryId: String(data.categoryId ?? ''), brand: String(data.brand ?? ''),
    attributes: (data.attributes ?? {}) as Record<string, unknown>, ownership: 'OWN', stockStatus: 'in_stock',
  });
  if (reason) nein('PRODUCT_MODEL_INCOMPATIBLE', `The new item does not fit this model: ${reason}`);
}

/**
 * Den eben angelegten Artikel dem Modell zuordnen und — auf Wunsch — auf das bestehende Modellbild verweisen. Läuft in
 * der Transaktion der Anlage (Primary: `createVariantOnPrimary`, PC2: `products.create` mit `variant`): wirft es, ist
 * auch der Artikel nicht angelegt. So gibt es nie einen Artikel, der still ohne seine Zuordnung bleibt.
 */
export function attachNewVariantInHouse(productId: string, intent: VariantIntent, ctx: ProductModelCtx): { modelKey: string; photoLinked: boolean } {
  // Frisch gelesen: legt eine frühere Zeile DESSELBEN Einkaufs das Modell des Ausgangsartikels gerade an, tritt diese bei.
  const key = intent.modelKey ? String(intent.modelKey) : modelKeyOf(String(intent.anchorProductId ?? ''));
  const g = key
    ? groupProductsInHouse({ productIds: [productId], modelKey: key }, ctx)
    : groupProductsInHouse({ productIds: [String(intent.anchorProductId), productId] }, ctx);
  let photoLinked = false;
  if (intent.pickMediaId) {
    const updatedAt = String(query('SELECT updated_at FROM products WHERE id = ?', [productId])[0]?.updated_at ?? '');
    mergeModelPhotosInHouse({
      modelKey: g.modelKey, pickMediaId: intent.pickMediaId, detachOld: false,
      targets: [{ productId, expectedUpdatedAt: updatedAt }],
    }, ctx);
    photoLinked = true;
  }
  return { modelKey: g.modelKey, photoLinked };
}

// ── Entfernen / Auflösen ──────────────────────────────────────────────────────────────────────────────────

export interface RemoveInput { productIds: string[] }
export interface RemoveResult { removed: string[]; dissolved: string[] }

/**
 * Artikel aus ihrem Modell nehmen (alle Artikel eines Modells = Gruppierung aufheben). Bleibt in einem Modell nur EIN
 * Artikel übrig, ist es kein Modell mehr: dessen Zuordnung geht ebenfalls. Kein Artikel, kein Bild, keine Buchung ändert sich.
 */
export function removeFromModelInHouse(input: RemoveInput, ctx: ProductModelCtx): RemoveResult {
  assertMayEdit(ctx);
  const ids = [...new Set((input.productIds ?? []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) nein('PRODUCT_MODEL_TOO_FEW', 'Choose at least one item.');
  const rows = productRows(ids);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const keys = new Map<string, string>();
  for (const id of ids) {
    const key = modelKeyOf(id);
    if (!key) nein('PRODUCT_MODEL_NOT_IN_MODEL', 'An item is not part of a model (any more).');
    const r = byId.get(id);
    if (r && String(r.branch_id) !== ctx.branchId) nein('PRODUCT_MODEL_OTHER_BRANCH', 'Models can only be changed in their own branch.');
    keys.set(id, key!);
  }
  const db = getDatabase();
  for (const id of ids) {
    db.run('DELETE FROM product_models WHERE product_id = ?', [id]);
    logAuditOrThrow({
      module: 'Product', entityType: 'product_models', entityId: id, action: 'DELETE',
      field: 'model_key', oldValue: keys.get(id), actor: actor(ctx),
    });
  }
  // Einzeln gewordene Modelle: die letzte Zuordnung ebenfalls entfernen (mit Audit).
  const dissolved: string[] = [];
  for (const key of new Set(keys.values())) {
    const rest = membersOf(key);
    if (rest.length === 1) {
      dissolved.push(rest[0]);
      logAuditOrThrow({
        module: 'Product', entityType: 'product_models', entityId: rest[0], action: 'DELETE',
        field: 'model_key', oldValue: key, newValue: 'model dissolved (only one item left)', actor: actor(ctx),
      });
    }
  }
  dissolveSingleMemberModels(db as unknown as LeftoverDb, [...new Set(keys.values())]);
  return { removed: ids, dissolved };
}

// ── Merge Photos ──────────────────────────────────────────────────────────────────────────────────────────────

export interface MergePhotosTarget { productId: string; expectedUpdatedAt: string }
export interface MergePhotosInput {
  modelKey: string;
  /** das gemeinsame Bild: ein bestehendes Medienobjekt, das an einem Artikel DIESES Modells hängt */
  pickMediaId?: string;
  targets?: MergePhotosTarget[];
  /** true = bisherige Bilder vom Artikel lösen (Datei bleibt); false = als weitere Bilder behalten */
  detachOld?: boolean;
  /** Rückgängig: je Artikel die vorherige Bildfolge (nur Medien, die schon einmal an genau diesem Artikel hingen) */
  restore?: Array<{ productId: string; mediaIds: string[]; expectedUpdatedAt: string }>;
}
export interface MergePhotosResult {
  modelKey: string;
  products: Array<{ productId: string; previousMediaIds: string[]; mediaIds: string[]; updatedAt: string }>;
}

/** Die aktive Bildfolge eines Artikels (Rolle stock_image), Hauptbild zuerst. */
export function activeGallery(productId: string, branchId: string): string[] {
  return query(`SELECT media_id FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND branch_id = ?
                  AND media_role = 'stock_image' AND deleted_at IS NULL ORDER BY sort_order`, [productId, branchId])
    .map((r) => String(r.media_id));
}

function legacyImages(raw: unknown): number {
  try { const a = JSON.parse(String(raw ?? '[]')); return Array.isArray(a) ? a.length : 0; } catch { return 1; }
}

function ownerFor(productId: string, branchId: string): MediaOwner {
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0]?.tenant_id;
  if (!t) nein('MODEL_PHOTO_BRANCH_UNKNOWN', 'The branch of this item is unknown.');
  return { tenantId: String(t), scopeKind: 'branch', branchId, entityType: 'product', entityId: productId, role: 'stock_image', securityClass: 'internal' };
}

/** Ein Medienobjekt, das verlinkt werden darf: vorhanden, bereit, nicht freigegeben, aus dieser Filiale. */
function mediaLinkable(mediaId: string, branchId: string): boolean {
  return query(`SELECT 1 FROM media_objects WHERE media_id = ? AND deleted_at IS NULL AND ingest_status = 'ready'
                  AND origin_branch_id = ? AND security_class = 'internal'`, [mediaId, branchId]).length > 0;
}

interface PhotoStep { productId: string; previous: string[]; next: string[] }

function planMergePhotos(input: MergePhotosInput, ctx: ProductModelCtx, opts: { legacyOk?: boolean } = {}): PhotoStep[] {
  assertMayEdit(ctx);
  const key = String(input.modelKey ?? '');
  const members = key ? membersOf(key) : [];
  if (members.length < 2) nein('PRODUCT_MODEL_NOT_FOUND', 'This model no longer exists.');
  const rows = new Map(productRows(members).map((r) => [String(r.id), r]));
  for (const id of members) {
    const r = rows.get(id);
    if (r && String(r.branch_id) !== ctx.branchId) nein('PRODUCT_MODEL_OTHER_BRANCH', 'Models can only be changed in their own branch.');
  }
  const requests = input.restore
    ? input.restore.map((x) => ({ productId: String(x.productId), expectedUpdatedAt: String(x.expectedUpdatedAt ?? ''), restoreIds: x.mediaIds.map(String) }))
    : (input.targets ?? []).map((x) => ({ productId: String(x.productId), expectedUpdatedAt: String(x.expectedUpdatedAt ?? ''), restoreIds: null as string[] | null }));
  if (requests.length === 0) nein('MODEL_PHOTO_NOTHING', 'Choose at least one item.');
  const pick = input.restore ? null : String(input.pickMediaId ?? '');
  if (!input.restore) {
    if (!pick) nein('MODEL_PHOTO_NO_PICK', 'Choose the shared photo.');
    // Das gewählte Bild muss an einem Artikel DIESES Modells hängen (auch an einem verkauften — es wird nur verwiesen).
    const anchored = query(`SELECT 1 FROM media_links WHERE entity_type = 'product' AND media_id = ? AND media_role = 'stock_image'
                              AND deleted_at IS NULL AND branch_id = ? AND entity_id IN (${members.map(() => '?').join(',')}) LIMIT 1`,
      [pick, ctx.branchId, ...members]).length > 0;
    if (!anchored) nein('MODEL_PHOTO_NOT_IN_MODEL', 'The chosen photo does not belong to this model.');
    if (!mediaLinkable(pick!, ctx.branchId)) nein('MODEL_PHOTO_NOT_READY', 'The chosen photo cannot be used (not ready or already released).');
  }
  const seen = new Set<string>();
  const steps: PhotoStep[] = [];
  // Das Altformat wird ZULETZT geprüft (nach allen anderen Regeln für ALLE Ziele): so nennt eine Ablehnung den echten
  // Grund, und der Vorab-Umzug (legacyMergeTargets) läuft nur, wenn der Merge abgesehen davon gelingen würde.
  let altformat: string | null = null;
  for (const req of requests) {
    if (seen.has(req.productId)) nein('MODEL_PHOTO_DUPLICATE', 'An item is listed twice.');
    seen.add(req.productId);
    if (!members.includes(req.productId)) nein('MODEL_PHOTO_NOT_MEMBER', 'An item is not part of this model.');
    const r = rows.get(req.productId)!;
    if (!mayChangeVariantPhoto(String(r.stock_status ?? ''))) nein('MODEL_PHOTO_SOLD', `${String(r.name ?? req.productId)}: sold or closed items keep their photos.`);
    if (legacyImages(r.images) > 0 && altformat === null) altformat = String(r.name ?? req.productId);
    if (String(r.updated_at ?? '') !== req.expectedUpdatedAt) {
      nein('PRODUCT_RECORD_CHANGED', `${String(r.name ?? req.productId)} was changed in the meantime — reload and try again.`);
    }
    const previous = activeGallery(req.productId, ctx.branchId);
    let next: string[];
    if (req.restoreIds) {
      next = [...new Set(req.restoreIds)];
      for (const m of next) {
        // Nur zurück, was schon einmal an GENAU diesem Artikel hing — Rückgängig verlinkt nichts Fremdes.
        const known = query(`SELECT 1 FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND media_id = ?
                               AND media_role = 'stock_image' AND branch_id = ? LIMIT 1`, [req.productId, m, ctx.branchId]).length > 0;
        if (!known) nein('MODEL_PHOTO_RESTORE_FOREIGN', 'Undo can only restore photos this item had before.');
        if (!mediaLinkable(m, ctx.branchId)) {
          nein('MODEL_PHOTO_RESTORE_UNAVAILABLE', 'A previous photo has been released in the meantime — undo is no longer possible for it.');
        }
      }
    } else {
      next = input.detachOld ? [pick!] : [pick!, ...previous.filter((m) => m !== pick)];
      // Behalten heißt: die bisherigen Bilder bleiben verknüpft — sie müssen dafür selbst verknüpfbar sein.
      for (const m of next) if (m !== pick && !mediaLinkable(m, ctx.branchId)) nein('MODEL_PHOTO_NOT_READY', 'A current photo of this item is not ready.');
    }
    steps.push({ productId: req.productId, previous, next });
  }
  if (altformat !== null && !opts.legacyOk) {
    // Der Umzug in den Bildspeicher läuft VOR dieser Transaktion (convertLegacyMergeTargets); hier kommt ein Altbild nur
    // an, wenn er nicht laufen durfte oder scheiterte — dann ändert dieser Merge nichts.
    nein('MODEL_PHOTO_LEGACY', `${altformat}: photos are still in the old format — reload and try again (they are moved to the photo storage first).`);
  }
  return steps;
}

/**
 * Welche Ziele eines „Merge Photos" tragen noch Bilder im alten Format (in `products.images` eingebettet) und dürfen
 * VORHER in den Bildspeicher umziehen? Nur, was der Merge selbst anfassen würde: Recht `products.edit`, Mitglied DIESES
 * Modells in der eigenen Filiale, verfügbar (verkaufte/abgeschlossene bleiben unberührt) und mit dem Stand, den der
 * Auftrag nennt (ein veralteter oder schon ausgeführter Auftrag zieht nichts um). Rückgängig zieht nie um. Liest nur.
 */
export function legacyMergeTargets(input: MergePhotosInput, ctx: ProductModelCtx): string[] {
  if (input.restore || !input.targets?.length) return [];
  try { assertMayEdit(ctx); } catch { return []; }
  const key = String(input.modelKey ?? '');
  const members = key ? membersOf(key) : [];
  if (members.length < 2) return [];
  const rows = new Map(productRows(members).map((r) => [String(r.id), r]));
  const out: string[] = [];
  for (const t of input.targets) {
    const r = rows.get(String(t.productId));
    if (!r || String(r.branch_id) !== ctx.branchId) continue;
    if (!mayChangeVariantPhoto(String(r.stock_status ?? ''))) continue;
    if (String(r.updated_at ?? '') !== String(t.expectedUpdatedAt ?? '')) continue;
    if (legacyImages(r.images) > 0 && !out.includes(String(r.id))) out.push(String(r.id));
  }
  if (out.length === 0) return [];
  // Nur umziehen, wenn der Merge abgesehen vom Altformat gelingen würde (alle Ziele, Bildwahl, Stände, Bereitschaft) —
  // ein ohnehin abgelehnter Merge ändert so auch am Altbild nichts; die Ablehnung kommt dann aus der Hausregel.
  try { planMergePhotos(input, ctx, { legacyOk: true }); } catch { return []; }
  return out;
}

/** Prüft, ohne zu schreiben: `null` = möglich, sonst der Grund. */
export function checkMergePhotos(input: MergePhotosInput, ctx: ProductModelCtx): { code: string; message: string } | null {
  try { planMergePhotos(input, ctx); return null; } catch (e) {
    if (e instanceof ProductModelRejected) return { code: e.code, message: e.message };
    throw e;
  }
}

/**
 * „Merge Photos" (oder dessen Rückgängig) — in der Transaktion des Aufrufers. Je Artikel: Galerie neu setzen (bestehende
 * Verknüpfungen werden wieder aktiviert oder weich entfernt, NIE gelöscht; keine Datei, keine Neukodierung), dann die
 * Artikelzeile als geändert markieren (`updated_at`, damit ein vorher geöffneter Stand — auch am alten PC2 — nicht still
 * überschreibt) und die bildabgeleiteten Felder zurücksetzen wie bei jeder Galerieänderung. Ein Audit-Eintrag je Artikel.
 */
export function mergeModelPhotosInHouse(input: MergePhotosInput, ctx: ProductModelCtx): MergePhotosResult {
  const steps = planMergePhotos(input, ctx);
  const db = getDatabase();
  const links = new MediaOwnerLinks(db as never);
  const abgleich = watchSyncTracks('merge model photos');
  const out: MergePhotosResult['products'] = [];
  for (const s of steps) {
    const sameOrder = s.previous.length === s.next.length && s.previous.every((m, i) => m === s.next[i]);
    if (sameOrder) { out.push({ productId: s.productId, previousMediaIds: s.previous, mediaIds: s.next, updatedAt: String(query('SELECT updated_at FROM products WHERE id = ?', [s.productId])[0]?.updated_at ?? '') }); continue; }
    links.setGallery(ownerFor(s.productId, ctx.branchId), s.next, { bumpOwner: false });
    db.run(`UPDATE products SET updated_at = ?, image_hash = NULL, image_description = NULL, image_embedding = NULL WHERE id = ?`,
      [ctx.now, s.productId]);
    trackChange('products', s.productId, 'update', { updated_at: ctx.now });
    logAuditOrThrow({
      module: 'Product', entityType: 'products', entityId: s.productId, action: 'UPDATE', field: 'gallery',
      oldValue: s.previous, newValue: { mediaIds: s.next, modelKey: input.modelKey, undo: !!input.restore },
      actor: actor(ctx),
    });
    out.push({ productId: s.productId, previousMediaIds: s.previous, mediaIds: s.next, updatedAt: ctx.now });
  }
  abgleich();
  return { modelKey: input.modelKey, products: out };
}
