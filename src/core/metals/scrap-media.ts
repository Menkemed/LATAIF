// ════════════════════════════════════════════════════════════════════════════
// MEDIA-SCRAP — die Belegfotos eines Altgold-Geschäfts im generischen Medienkern.
//
// Fotos gehören hier der einzelnen POSITION und je Seite: was der Verkäufer gebracht hat
// (`purchase_photo`) und was an den Käufer ging (`sale_photo`). Der Besitzer ist deshalb die
// Zeile — `entityType = 'scrap_trade_line'` —, und ihre Kennung ist `line_key`: die Zeile wird bei
// jedem Speichern gelöscht und neu eingefügt, der Schlüssel aber bleibt. Eine Verknüpfung über die
// Position im Formular wäre genau der Fehler, der nach dem Löschen der ersten Zeile das Foto der
// zweiten bei der dritten zeigt.
//
// Fotos ändern an der Buchhaltung NICHTS. Gewicht, Karat, Preise, Zahlungen, Umkehrbuchungen und
// Summen stehen unverändert dort, wo sie stehen; dieses Modul fasst keine davon an.
//
// Die alten Spalten `images_purchase` / `images_sale` werden nicht mehr geschrieben. Sie bleiben
// als Altbestand lesbar — und sobald eine Zeile ihre Fotos über den Medienkern setzt, werden sie
// in DERSELBEN Klammer geleert: sonst käme ein bewusst entferntes Foto zurück.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { resolveOwnerMedia, type OwnerMediaRef } from '@/core/media/owner-media-resolver';
import { ingestRecordPhotos, resolvePhotoSlots, type PhotoSlotRequest, type RecordPhotoScope } from '@/core/media/record-photo-media';
import type { MediaOwner } from '@/core/media/media-owner';
import type { StockMediaOrchestrator } from '@/core/media/orchestrator';
import { ScrapRejected } from '@/core/metals/scrap-house';

export const SCRAP_MEDIA_ENTITY = 'scrap_trade_line';
/** Zwei Seiten, zwei feste Rollen. Keine Rolle, die eine Zeilenkennung in sich trägt. */
export const SCRAP_ROLE_PURCHASE = 'purchase_photo';
export const SCRAP_ROLE_SALE = 'sale_photo';
export type ScrapSide = 'purchase' | 'sale';
const ROLE: Record<ScrapSide, string> = { purchase: SCRAP_ROLE_PURCHASE, sale: SCRAP_ROLE_SALE };

/**
 * Gibt es den Medienkern in DIESER Datenbank überhaupt?
 *
 * Eine blanke Abfrage gegen eine fehlende Tabelle würde werfen — und der Aufrufer ist eine
 * Geschaeftsklammer, die daran zerbräche. Also wird gefragt, nicht gehofft.
 */
function mediaCoreAvailable(): boolean {
  return query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_links' LIMIT 1").length > 0;
}

/** Mandant und Filiale des Geschäfts, zu dem diese Zeile gehört. */
export function scrapMediaScope(tradeId?: string): { tenantId: string; branchId: string } {
  let branchId = '';
  const row = tradeId ? query('SELECT branch_id FROM scrap_trades WHERE id = ?', [tradeId])[0] : undefined;
  if (row?.branch_id) branchId = String(row.branch_id);
  if (!branchId) branchId = currentBranchId();
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0];
  return { tenantId: String(t?.tenant_id ?? 'tenant-1'), branchId };
}

export function scrapLineOwner(
  lineKey: string, side: ScrapSide, scope: { tenantId: string; branchId: string },
): MediaOwner {
  return {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: SCRAP_MEDIA_ENTITY, entityId: lineKey, role: ROLE[side], securityClass: 'internal',
  };
}

export function scrapPhotoScope(
  side: ScrapSide, scope = scrapMediaScope(), orchestrator?: StockMediaOrchestrator,
): RecordPhotoScope {
  return { tenantId: scope.tenantId, branchId: scope.branchId, ownerType: SCRAP_MEDIA_ENTITY, role: ROLE[side], orchestrator };
}

/** Aufnehmen VOR der Klammer: aus Daten-URLs werden geprüfte, noch unverknüpfte Objekte. */
export function ingestScrapPhotos(
  urls: readonly string[], side: ScrapSide, orchestrator?: StockMediaOrchestrator, tradeId?: string,
): Promise<string[]> {
  return ingestRecordPhotos(urls, scrapPhotoScope(side, scrapMediaScope(tradeId), orchestrator));
}

/** Dasselbe für einen Plan aus behaltenen Medien und neuen Aufnahmen. */
export function resolveScrapPhotoSlots(
  slots: readonly PhotoSlotRequest[], side: ScrapSide, orchestrator?: StockMediaOrchestrator, tradeId?: string,
): Promise<string[]> {
  return resolvePhotoSlots(slots, scrapPhotoScope(side, scrapMediaScope(tradeId), orchestrator));
}

/** Was nach dem Speichern an einer Zeile hängen soll — in Medienkennungen, je Seite. */
export interface ScrapLineGallery {
  lineKey: string;
  purchase: readonly string[];
  sale: readonly string[];
}

/**
 * Die Fotos aller Zeilen eines Geschäfts INNERHALB der laufenden Geschäftstransaktion setzen.
 *
 * Zeilen, die es nach diesem Speichern nicht mehr gibt, verlieren ihre Fotos — sonst zeigten
 * Verknüpfungen auf eine Zeile, die niemand mehr sehen kann, und Sicherung wie GC hielten deren
 * Dateien für lebendig. Die Medienobjekte selbst bleiben (der GC-Vertrag gilt unverändert).
 *
 * `bumpOwner: false` überall: die Zeile ist gerade neu geschrieben worden und führt ohnehin keine
 * eigene Fassung — die Fassung des Geschäfts (`scrap_trades.version`) zählt die Hausfunktion.
 */
export function applyScrapGalleries(
  tradeId: string,
  galleries: readonly ScrapLineGallery[],
  lebendeSchluessel: readonly string[],
  vorherigeSchluessel: readonly string[] = [],
): void {
  const hatFotos = galleries.some((g) => g.purchase.length > 0 || g.sale.length > 0);
  // Eine sehr alte Datenbank — oder eine Testdatenbank, die nur die Geschäftstabellen anlegt — hat
  // keinen Medienkern. Ohne Fotos ist das die Antwort „dieses Geschäft hat keine“ und kein Fehler;
  // MIT Fotos ist es einer, und zwar ein lauter: sie hätten nirgends hingekonnt.
  if (!mediaCoreAvailable()) {
    if (!hatFotos) return;
    throw new ScrapRejected('MEDIA_CORE_MISSING', 'this database has no media store — photos cannot be saved');
  }
  const scope = scrapMediaScope(tradeId);
  const links = new MediaOwnerLinks(getDatabase() as never);
  const db = getDatabase();
  try {
    for (const g of galleries) {
      for (const side of ['purchase', 'sale'] as const) {
        links.setGallery(scrapLineOwner(g.lineKey, side, scope), side === 'purchase' ? g.purchase : g.sale, { bumpOwner: false });
      }
    }
    // Verwaiste Verknüpfungen einer Position, die es nicht mehr gibt.
    //
    // Sie sind NICHT über die Zeilen zu finden: die sind beim Ersetzen gelöscht worden. Der
    // Aufrufer nennt deshalb, welche Schlüssel dieses Geschäft VORHER hatte — was davon jetzt
    // fehlt, ist eine gelöschte Position, und ihre Fotos gehören niemandem mehr.
    const lebend = new Set(lebendeSchluessel);
    const tot = [...new Set(vorherigeSchluessel)].filter((k) => !lebend.has(k));
    if (tot.length > 0) {
      // Bewusst NICHT über `setGallery`: der Vertrag dort verlangt einen Besitzer, der EXISTIERT —
      // und genau der ist hier fort. Die Verknüpfung wird deshalb direkt still gelegt, mit
      // derselben Wirkung wie dort (die Zeile bleibt als Nachweis, das Medienobjekt bleibt, der
      // GC-Vertrag gilt unverändert). Nur diese eine Zeile darf das, und nur für diese Rollen.
      const jetzt = new Date().toISOString();
      db.run(
        `UPDATE media_links SET deleted_at = ?, is_primary = 0
          WHERE tenant_id = ? AND entity_type = ? AND branch_id = ? AND deleted_at IS NULL
            AND media_role IN (?, ?) AND entity_id IN (${tot.map(() => '?').join(',')})`,
        [jetzt, scope.tenantId, SCRAP_MEDIA_ENTITY, scope.branchId, SCRAP_ROLE_PURCHASE, SCRAP_ROLE_SALE, ...tot],
      );
    }
    // ALTBESTAND — sobald die Fotos im Medienkern liegen, ist die alte Liste erledigt.
    db.run(
      `UPDATE scrap_trade_lines SET images_purchase = '[]', images_sale = '[]'
        WHERE scrap_trade_id = ? AND (COALESCE(images_purchase,'') NOT IN ('','[]') OR COALESCE(images_sale,'') NOT IN ('','[]'))`,
      [tradeId],
    );
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'MEDIA_LINK_OBJECT_NOT_READY') {
      throw new ScrapRejected('PHOTO_NOT_FOUND', 'this photo is not on the trade (any more)');
    }
    if (typeof code === 'string' && code.startsWith('MEDIA_')) throw new ScrapRejected(code, (e as Error).message);
    throw e;
  }
}

/** Die Fotos aller Zeilen eines Geschäfts — EINE Abfrage je Seite, Referenzen statt Bytes. */
export function scrapPhotoRefs(tradeId: string): Map<string, { purchase: OwnerMediaRef[]; sale: OwnerMediaRef[] }> {
  if (!mediaCoreAvailable()) return new Map();
  const scope = scrapMediaScope(tradeId);
  const keys = query('SELECT line_key FROM scrap_trade_lines WHERE scrap_trade_id = ? ORDER BY position', [tradeId])
    .map((r) => String(r.line_key ?? '')).filter(Boolean);
  const out = new Map<string, { purchase: OwnerMediaRef[]; sale: OwnerMediaRef[] }>();
  for (const k of keys) out.set(k, { purchase: [], sale: [] });
  if (keys.length === 0) return out;
  for (const side of ['purchase', 'sale'] as const) {
    const found = resolveOwnerMedia(getDatabase() as never, {
      tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
      entityType: SCRAP_MEDIA_ENTITY, role: ROLE[side], entityIds: keys,
    });
    for (const k of keys) {
      const slot = out.get(k);
      if (slot) slot[side] = found.get(k) ?? [];
    }
  }
  return out;
}

/** Die Medienkennungen einer Zeile und Seite — die Grundlage jedes „behalten". */
export function scrapLineMediaIds(tradeId: string, lineKey: string, side: ScrapSide): string[] {
  return (scrapPhotoRefs(tradeId).get(lineKey)?.[side] ?? []).map((r) => r.mediaId);
}

/** Der Altbestand einer Zeile — gelesen, nie neu geschrieben. */
export function legacyScrapLineImages(lineKey: string, side: ScrapSide): string[] {
  const col = side === 'purchase' ? 'images_purchase' : 'images_sale';
  const row = query(`SELECT ${col} AS v FROM scrap_trade_lines WHERE line_key = ?`, [lineKey])[0];
  try {
    const list = JSON.parse(String(row?.v ?? '[]'));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export type { PhotoSlotRequest };
