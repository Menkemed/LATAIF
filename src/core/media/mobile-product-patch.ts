// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT v0.8.48 — der Produkt-Patch vom Handy: lesen, gegen die Kategorie-SSOT pruefen,
// gegen den AKTUELLEN Stand zusammenfuehren.
//
// Drei Regeln tragen diese Datei:
//
//   1. Was hier nicht steht, kann vom Handy aus nicht geschrieben werden. `sku`, `categoryId` und
//      `quantity` fehlen bewusst — ein Request, der sie mitschickt, wird abgewiesen, nicht gefiltert.
//   2. `attributes` traegt nur die GEAENDERTEN Schluessel und wird gegen den aktuellen Stand
//      gemerged. Ein Ersetzen des ganzen JSON waere der Weg, auf dem eine Korrektur an einer
//      Seriennummer alle anderen Attribute mitnimmt.
//   3. Die erlaubten Attribute, Auswahlwerte und Abhaengigkeiten kommen aus derselben
//      Kategorie-Definition, die auch das Anlegen benutzt — keine zweite Liste fuers Handy.
//
// Die Preise stehen zwar in der Feldliste, ihre Zulaessigkeit haengt aber nicht an der Form: ob
// DIESER Artikel seine Preise noch aendern darf, entscheidet seine Herkunft. Das prueft der Drain.
// ════════════════════════════════════════════════════════════════════════════

import type { MobileFieldCategory, MobileFieldSchema } from '../mobile/mobile-field-schema.ts';

/** Die einfachen Textfelder. Spiegel von `MOBILE_TEXT_EDIT_FIELDS` in Rust. */
export const MOBILE_PATCH_TEXT_FIELDS: ReadonlySet<string> = new Set([
  'name', 'brand', 'condition', 'storageLocation', 'notes',
]);
/** Die drei Preise, unter ihren kanonischen Produktschluesseln. */
export const MOBILE_PATCH_PRICE_FIELDS: ReadonlySet<string> = new Set([
  'purchasePrice', 'plannedSalePrice', 'minSalePrice',
]);
/** Ausdruecklich unveraenderlich — hier nur benannt, damit ein Versuch einen sprechenden Code bekommt. */
export const MOBILE_PATCH_IMMUTABLE_FIELDS: ReadonlySet<string> = new Set([
  'sku', 'categoryId', 'quantity',
]);

export const ERR_PATCH_INVALID = 'MOBILE_EDIT_PATCH_INVALID';
export const ERR_PATCH_IMMUTABLE = 'MOBILE_EDIT_IMMUTABLE_FIELD';
export const ERR_PATCH_ATTR_INVALID = 'MOBILE_EDIT_ATTRIBUTE_INVALID';
export const ERR_PATCH_SCOPE_INVALID = 'MOBILE_EDIT_SCOPE_INVALID';
export const ERR_PRICE_NOT_ELIGIBLE = 'MOBILE_EDIT_PRICE_NOT_ELIGIBLE';

export type MobilePatchValue = string | number | boolean | null | string[] | Record<string, unknown>;
export type MobileProductPatch = Record<string, MobilePatchValue>;

/** Der aktuelle Stand des Artikels, so wie ihn der Drain unter der Sperre liest. */
export interface CurrentProductState {
  categoryId: string;
  /** Die bereits gespeicherten Attribute (geparst). */
  attributes: Record<string, unknown>;
  /** Der bereits gespeicherte Lieferumfang. */
  scopeOfDelivery: string[];
}

export type PatchCheck = { ok: true; patch: MobileProductPatch } | { ok: false; code: string };

/** Ein Preis: Zahl >= 0 oder `null`. `""` wird NICHT zu 0 — "kein Preis" und "Preis 0" sind zweierlei. */
function isPrice(v: unknown): boolean {
  return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

/** Den Patch aus der Metadata lesen. Fail closed: unbekannte Felder machen ihn ungueltig. */
export function parseMobileProductPatch(raw: unknown): PatchCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: ERR_PATCH_INVALID };
  const patch: MobileProductPatch = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, code: ERR_PATCH_INVALID };
  for (const [k, v] of entries) {
    // Unveraenderliche Felder bekommen ihren EIGENEN Code — "das darf nicht geaendert werden" ist
    // eine andere Aussage als "dieses Feld kenne ich nicht".
    if (MOBILE_PATCH_IMMUTABLE_FIELDS.has(k)) return { ok: false, code: ERR_PATCH_IMMUTABLE };
    if (MOBILE_PATCH_TEXT_FIELDS.has(k)) {
      if (v !== null && typeof v !== 'string') return { ok: false, code: ERR_PATCH_INVALID };
      patch[k] = v as string | null;
    } else if (MOBILE_PATCH_PRICE_FIELDS.has(k)) {
      if (!isPrice(v)) return { ok: false, code: ERR_PATCH_INVALID };
      patch[k] = v as number | null;
    } else if (k === 'scopeOfDelivery') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) return { ok: false, code: ERR_PATCH_INVALID };
      patch[k] = v as string[];
    } else if (k === 'attributes') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: ERR_PATCH_INVALID };
      if (Object.keys(v as object).length === 0) return { ok: false, code: ERR_PATCH_INVALID };
      patch[k] = v as Record<string, unknown>;
    } else {
      return { ok: false, code: ERR_PATCH_INVALID };
    }
  }
  return { ok: true, patch };
}

/** Trägt dieser Patch mindestens einen Preis? */
export function patchTouchesPrices(patch: MobileProductPatch): boolean {
  return Object.keys(patch).some((k) => MOBILE_PATCH_PRICE_FIELDS.has(k));
}

function categoryOf(schema: MobileFieldSchema, categoryId: string): MobileFieldCategory | undefined {
  return schema.categories.find((c) => c.id === categoryId);
}

/**
 * Den Patch gegen die Kategorie-SSOT und den aktuellen Stand pruefen und in die Form bringen, die
 * der kanonische durable Edit erwartet.
 *
 * Was hier passiert und warum:
 *   • `attributes` wird MIT dem aktuellen Stand zusammengefuehrt, nicht ersetzt.
 *   • Jeder geaenderte Attributschluessel muss in der Kategorie des Artikels wirklich existieren —
 *     ein Attribut einer anderen Kategorie ist ein Fehler, kein zu ignorierendes Extra.
 *   • Auswahlfelder muessen einen der definierten Werte tragen, Zahlenfelder eine Zahl.
 *   • `dependsOn` wird gegen den ZUSAMMENGEFUEHRTEN Zustand geprueft: ob `karat_color` erlaubt ist,
 *     haengt am Material NACH dieser Aenderung, nicht davor.
 *   • `condition` und `scopeOfDelivery` gegen dieselben Optionslisten wie beim Anlegen.
 */
export function resolveMobileProductPatch(
  patch: MobileProductPatch,
  current: CurrentProductState,
  schema: MobileFieldSchema,
): { ok: true; resolved: Record<string, unknown> } | { ok: false; code: string } {
  const cat = categoryOf(schema, current.categoryId);
  if (!cat) return { ok: false, code: ERR_PATCH_ATTR_INVALID };
  const resolved: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'attributes') continue;      // unten, gegen den zusammengefuehrten Stand
    if (k === 'scopeOfDelivery') {
      const items = v as string[];
      if (items.some((s) => !cat.scopeOptions.includes(s))) return { ok: false, code: ERR_PATCH_SCOPE_INVALID };
      if (new Set(items).size !== items.length) return { ok: false, code: ERR_PATCH_SCOPE_INVALID };
      resolved.scopeOfDelivery = items;
      continue;
    }
    if (k === 'condition') {
      // Leer heisst "nicht gesetzt" und bleibt erlaubt; ein gesetzter Wert muss aus der Liste kommen.
      const s = v as string | null;
      if (s !== null && s !== '' && !cat.conditionOptions.includes(s)) return { ok: false, code: ERR_PATCH_INVALID };
    }
    resolved[k] = v;
  }

  const changed = patch.attributes as Record<string, unknown> | undefined;
  if (changed) {
    const merged: Record<string, unknown> = { ...current.attributes };
    for (const [ak, av] of Object.entries(changed)) {
      const def = cat.attributes.find((a) => a.key === ak);
      if (!def) return { ok: false, code: ERR_PATCH_ATTR_INVALID };   // fremdes / unbekanntes Attribut
      if (av === null || av === '') { delete merged[ak]; continue; }  // leeren heisst entfernen
      if (def.type === 'number') {
        const n = typeof av === 'number' ? av : Number(av);
        if (!Number.isFinite(n)) return { ok: false, code: ERR_PATCH_ATTR_INVALID };
        merged[ak] = n;
        continue;
      }
      if (def.type === 'select') {
        if (typeof av !== 'string' || !(def.options || []).includes(av)) return { ok: false, code: ERR_PATCH_ATTR_INVALID };
        merged[ak] = av;
        continue;
      }
      if (def.type === 'boolean') {
        if (typeof av !== 'boolean') return { ok: false, code: ERR_PATCH_ATTR_INVALID };
        merged[ak] = av;
        continue;
      }
      if (typeof av !== 'string') return { ok: false, code: ERR_PATCH_ATTR_INVALID };
      merged[ak] = av;
    }
    // `dependsOn` gegen den ZUSAMMENGEFUEHRTEN Zustand: ein Attribut, dessen Bedingung nach dieser
    // Aenderung nicht mehr gilt, darf nicht als Wert stehen bleiben.
    for (const def of cat.attributes) {
      if (!def.dependsOn) continue;
      const depValue = merged[def.dependsOn.key];
      const satisfied = typeof depValue === 'string' && def.dependsOn.valueIncludes.includes(depValue);
      if (!satisfied && merged[def.key] !== undefined) {
        // Nur ein Wert, den DIESER Patch gesetzt hat, ist ein Fehler; einen alten Rest raeumen wir
        // still ab, statt den Save an vorhandenen Altdaten scheitern zu lassen.
        if (Object.prototype.hasOwnProperty.call(changed, def.key)) return { ok: false, code: ERR_PATCH_ATTR_INVALID };
        delete merged[def.key];
      }
    }
    resolved.attributes = merged;
  }

  if (Object.keys(resolved).length === 0) return { ok: false, code: ERR_PATCH_INVALID };
  return { ok: true, resolved };
}
