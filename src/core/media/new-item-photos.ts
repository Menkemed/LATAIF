// ════════════════════════════════════════════════════════════════════════════
// v0.8.111 MEDIA STORAGE — die Fotos des „New Item"-Artikels aus Einkauf, Edit Purchase und Auftrag
// direkt in den Medienspeicher (CAS), wie die Fotos des Einkaufs-Posteingangs.
//
// Bis hierher schrieb `createProduct` die Fotos als Daten-URL in `products.images`; der Abgleich kopierte
// die ganze Zeile samt Base64 in beide Changelogs, und erst ein Nachlauf (PP-12, `new-item-media`) zog sie
// in den Medienspeicher — ohne Größenklasse, also mit 100/20 KB statt 60/30/10 KB.
//
// Jetzt derselbe Weg wie beim Posteingang (`inbox-media.ts`) und bei Reparaturen:
//
//   1. VOR der Buchungstransaktion: `ingestRecordPhotos` — Rust normalisiert EINMAL in die Größenklasse aus
//      `size-profile.ts` (Kategorie des Artikels), prüft und veröffentlicht; das Objekt ist noch unverknüpft.
//      Die Aufnahmekennung kommt aus den Bytes: eine Wiederholung ergibt dasselbe Objekt, keine zweite Datei.
//   2. IN der Buchungstransaktion: `createProduct` legt den Artikel mit `images = '[]'` an und verknüpft die
//      Objekte (`linkNewItemPhotos`). Ein Rollback nimmt Artikel und Verknüpfung zurück; das unverknüpfte
//      Objekt bleibt liegen, wie es der GC-Vertrag für jede vorab aufgenommene Datei vorsieht.
//
// Ohne Medienspeicher (Browser, Node-Prüfungen) bleibt es beim bisherigen Weg (Spalte + Nachlauf).
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { ingestRecordPhotos } from '@/core/media/record-photo-media';
import { normalizeSpecImages } from '@/core/media/record-image';
import type { MediaOwner } from '@/core/media/media-owner';
import type { StockMediaOrchestrator } from '@/core/media/orchestrator';
import type { Product } from '@/core/models/types';

export const NEW_ITEM_PHOTO_ROLE = 'stock_image';

/**
 * Ein Artikel-Entwurf, dessen Fotos schon im Medienspeicher liegen. Beide Felder setzt NUR der Primary nach der
 * Aufnahme — kein Client-Rumpf darf sie tragen (die Zerleger lassen nur die bekannten Felder zu).
 */
export type NewItemSpec = Partial<Product> & {
  /** Die aufgenommenen, noch unverknüpften Medien — in der Reihenfolge der Fotos. */
  photoMediaIds?: string[];
  /** Nur flüchtig: die erste Aufnahme als Vorlage für das KI-Embedding (wird nie gespeichert). */
  photoEmbedFrom?: string;
};

let testHook: { orchestrator?: StockMediaOrchestrator; enabled?: boolean } | null = null;
/** Nur für Prüfungen: Medienweg erzwingen/abschalten und einen Orchestrator einsetzen. */
export function setNewItemPhotoTestHook(h: { orchestrator?: StockMediaOrchestrator; enabled?: boolean } | null): void { testHook = h; }

const inTauri = (): boolean => typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

function mediaCoreAvailable(): boolean {
  try { return query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_links' LIMIT 1").length > 0; } catch { return false; }
}

/** Läuft der direkte Medienweg in diesem Fenster? */
export function newItemPhotosDirect(): boolean {
  if (testHook?.enabled !== undefined) return testHook.enabled;
  return inTauri() && mediaCoreAvailable();
}

function tenantOf(branchId: string): string {
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0]?.tenant_id;
  if (!t) throw new Error('MEDIA_CREATE_SCOPE_REQUIRED: this branch has no tenant');
  return String(t);
}

/**
 * Schritt 1 — VOR der Transaktion. Liefert den Entwurf mit `images: []` und den Medienkennungen; ohne Fotos,
 * ohne Medienspeicher oder mit Einträgen, die keine Daten-URL sind (Altbestand), unverändert.
 */
export async function ingestNewItemPhotos<T extends NewItemSpec | undefined>(spec: T, branchId: string): Promise<T> {
  if (!spec) return spec;
  const images = Array.isArray(spec.images) ? spec.images : [];
  if (images.length === 0 || !newItemPhotosDirect()) return spec;
  if (!images.every((s) => typeof s === 'string' && s.startsWith('data:'))) return spec;
  const ids = await ingestRecordPhotos(images as string[], {
    tenantId: tenantOf(branchId), branchId, ownerType: 'product', role: NEW_ITEM_PHOTO_ROLE,
    categoryId: typeof spec.categoryId === 'string' ? spec.categoryId : null,
    orchestrator: testHook?.orchestrator,
  });
  // Dasselbe Foto zweimal in einem Artikel ist EIN Medium an EINEM Platz (der Galerievertrag kennt keine Doppel).
  const unique = ids.filter((m, i) => ids.indexOf(m) === i);
  return { ...spec, images: [], photoMediaIds: unique, photoEmbedFrom: images[0] as string };
}

/** Für mehrere Entwürfe (Zeilen eines Einkaufs). */
export async function ingestNewItemPhotosAll<T extends NewItemSpec | undefined>(specs: readonly T[], branchId: string): Promise<T[]> {
  const out: T[] = [];
  for (const s of specs) out.push(await ingestNewItemPhotos(s, branchId));
  return out;
}

/** Schritt 2 — IN der Transaktion, direkt nach dem INSERT des Artikels: die Galerie auf genau diese Medien. */
export function linkNewItemPhotos(productId: string, branchId: string, mediaIds: readonly string[]): void {
  if (mediaIds.length === 0) return;
  const owner: MediaOwner = {
    tenantId: tenantOf(branchId), scopeKind: 'branch', branchId,
    entityType: 'product', entityId: productId, role: NEW_ITEM_PHOTO_ROLE, securityClass: 'internal',
  };
  // Der Artikel ist gerade entstanden; seine Zeile IST die Änderung — keine zusätzliche Fassung.
  new MediaOwnerLinks(getDatabase() as never).setGallery(owner, mediaIds, { bumpOwner: false });
}

/**
 * Der eine Einstieg am Primary (Einkauf, Edit Purchase, Auftrag), VOR der Klammer: mit Medienspeicher direkt
 * aufnehmen — Rust normalisiert dabei EINMAL in die Größenklasse; ohne ihn wie bisher normalisieren (Spalte).
 */
export async function prepareNewItemSpec<T extends NewItemSpec>(spec: T | undefined, branchId: string): Promise<T | undefined> {
  if (!spec) return spec;
  if (newItemPhotosDirect()) return ingestNewItemPhotos(spec, branchId);
  return normalizeSpecImages(spec as T & { images?: string[] }) as Promise<T | undefined>;
}
