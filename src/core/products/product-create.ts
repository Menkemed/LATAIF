// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5B — einen Artikel anlegen: EINE Vorbereitung für beide Seiten.
//
// Bis hierher prüfte das Anlegeformular (WatchList) die Pflichtfelder, strich veraltete Attribute
// und vergab die SKU — in der React-Komponente. Der Fernbefehl `products.create` prüfte davon nur
// „Kategorie und Name" und nahm keine eingetippte SKU an. Zwei Meinungen darüber, was ein gültiger
// neuer Artikel ist: eine Goldkette ohne Namen war am Primary gültig und aus der Ferne nicht, ein
// Artikel ohne Pflichtattribut aus der Ferne gültig und am Primary nicht.
//
// Jetzt gibt es EINE Vorbereitung. Die Anlegemaske ruft sie am Primary, der Fernbefehl ruft sie am
// Primary für einen Client — dieselbe Pflichtfeldregel (`field-contract`), derselbe Riegel gegen
// eine schon vergebene SKU, dieselbe Vergabe aus dem durablen Zähler, dasselbe Streichen.
// ════════════════════════════════════════════════════════════════════════════
import { validateProductFields, blockingIssues, stripStaleAttributes } from './field-contract';
import { skuIsEmpty } from './sku-allocation';
import { PRODUCT_CREATE_FIELDS, createPayload } from '@/core/data/write-payloads';
import type { Category, Product } from '@/core/models/types';

export interface ProductCreatePort {
  /** Die Kategorie, in der angelegt wird — die Definition des Hauses, nicht die des Rumpfs. */
  category: Category | null | undefined;
  /** Der harte Riegel: eine eingetippte SKU, die schon an einem Artikel steht. */
  isSkuTaken: (sku: string) => boolean;
  /** Die Vergabe aus dem durablen Zähler — nur, wenn nichts eingetippt wurde. */
  allocateSku: (brand: string | undefined, categoryId: string | undefined) => string;
}

export interface ProductCreateIssue { field: string; label: string; code: string }

export type ProductCreatePlan =
  | { kind: 'ok'; data: Partial<Product> & { sku: string }; allocated: boolean }
  | { kind: 'invalid'; issues: ProductCreateIssue[] }
  | { kind: 'sku_taken'; sku: string };

/**
 * Was aus einer Eingabe ein anlegbarer Artikel wird.
 *
 * `reuseSku` ist die Nummer, die ein vorheriger Versuch DERSELBEN Anlage schon beansprucht hat
 * (die Anlegemaske wiederholt nach einem unvollständigen Bilderweg mit demselben Artikel). Eine
 * eingetippte SKU wird getrimmt, bevor sie irgendetwas anderes ist — `" RLX-001 "` und `"RLX-001"`
 * sind dieselbe Nummer, sonst schlüpft die zweite an jeder Prüfung vorbei.
 */
export function planProductCreate(input: Partial<Product>, port: ProductCreatePort, reuseSku = ''): ProductCreatePlan {
  const issues = blockingIssues(validateProductFields(port.category ?? undefined, {
    categoryId: input.categoryId, brand: input.brand, name: input.name, attributes: input.attributes,
  }));
  if (issues.length > 0) {
    return { kind: 'invalid', issues: issues.map((i) => ({ field: i.field, label: i.label, code: i.code })) };
  }
  const typed = skuIsEmpty(input.sku) ? '' : String(input.sku).trim();
  if (typed && port.isSkuTaken(typed)) return { kind: 'sku_taken', sku: typed };
  const sku = typed || reuseSku || port.allocateSku(input.brand, input.categoryId);
  return {
    kind: 'ok',
    allocated: !typed && sku !== reuseSku,
    data: {
      ...input,
      sku,
      // Ein Attribut, dessen Bedingung nicht mehr erfüllt ist, wird nie gespeichert (eine
      // Stahluhr trägt keine Goldfarbe) — dieselbe Regel wie beim Ändern und am Handy.
      attributes: stripStaleAttributes(port.category ?? undefined, input.attributes) as Product['attributes'],
    },
  };
}

/** Der Satz, den ein Mensch an der Maske liest, wenn die Vorbereitung Nein sagt. */
export function productCreateRefusal(plan: Exclude<ProductCreatePlan, { kind: 'ok' }>): { code: string; message: string } {
  if (plan.kind === 'sku_taken') return { code: 'SKU_TAKEN', message: `The SKU / reference ${plan.sku} is already in use.` };
  if (plan.issues.some((i) => i.code === 'UNKNOWN_CATEGORY')) return { code: 'CATEGORY_NOT_FOUND', message: 'No such category.' };
  return { code: 'PRODUCT_FIELDS_REQUIRED', message: `Required: ${plan.issues.map((i) => i.label).join(', ')}` };
}

/**
 * Der Rumpf einer Anlage vom zweiten Rechner: die Felder der Maske (ohne die leeren), die
 * eingetippte SKU getrimmt, und statt der Bilder ihre Kennungen in der Zwischenablage.
 * Die Bilder selbst reisen NIE im Auftrag.
 */
export function productCreateRequest(form: Partial<Product>, stagingIds: readonly string[]): Record<string, unknown> {
  const body = createPayload(form as Record<string, unknown>, PRODUCT_CREATE_FIELDS);
  const typed = skuIsEmpty(form.sku) ? '' : String(form.sku).trim();
  if (typed) body.sku = typed;
  if (stagingIds.length > 0) body.stagingIds = [...stagingIds];
  return body;
}
