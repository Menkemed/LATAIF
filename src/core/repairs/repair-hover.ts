// ════════════════════════════════════════════════════════════════════════════
// REPAIR-HOVER — die große Hover-Karte der Reparaturliste: Artikelbild + Marke, Modell, Referenz, Seriennummer.
//
// Rein und ohne React/DB (unter node getestet: test/repair-hover/repair-hover.test.ts). Es wird nichts erfunden:
// ein fehlendes Feld bleibt leer (die Karte zeigt „—"). Referenz und Seriennummer kommen aus den Feldern der
// Reparatur; nur wenn dort nichts steht, aus den gespeicherten Kategorie-Angaben derselben Reparatur.
// ════════════════════════════════════════════════════════════════════════════

export interface RepairHoverSource {
  itemBrand?: string | null;
  itemModel?: string | null;
  itemReference?: string | null;
  itemSerial?: string | null;
  itemAttributes?: Record<string, unknown> | null;
}

export interface RepairHoverFields {
  brand: string | null;
  model: string | null;
  reference: string | null;
  serial: string | null;
}

const text = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
};

/** Die vier Felder der Karte — gespeicherte Werte oder `null`. */
export function repairHoverFields(r: RepairHoverSource): RepairHoverFields {
  const a = r.itemAttributes ?? {};
  return {
    brand: text(r.itemBrand),
    model: text(r.itemModel),
    reference: text(r.itemReference) ?? text(a.reference_number) ?? text(a.reference),
    serial: text(r.itemSerial) ?? text(a.serial_number) ?? text(a.serial),
  };
}

export interface CoverRefLike {
  mediaId: string;
  isPrimary: boolean;
  sortOrder: number;
  main: { storageKey: string; hash: string; extension: string; mimeType: string };
}

/** Das Titelbild der Galerie: das als erstes markierte, sonst das erste nach Reihenfolge. */
export function pickRepairCover<T extends CoverRefLike>(refs: readonly T[]): T | null {
  if (refs.length === 0) return null;
  const primary = refs.find((r) => r.isPrimary);
  if (primary) return primary;
  return [...refs].sort((a, b) => a.sortOrder - b.sortOrder)[0];
}

/** Fingerabdruck des Titelbilds (Kennung + Inhalt) — ändert sich mit jeder Galerie-Änderung, die das Bild betrifft. */
export function repairCoverFingerprint(ref: Pick<CoverRefLike, 'mediaId' | 'main'>): string {
  return `${ref.mediaId}|${ref.main.hash}`;
}

/** Schlüssel im gemeinsamen Bild-Cache (getrennt von den Artikelkarten). */
export const repairCoverCacheKey = (repairId: string): string => `repair-cover:${repairId}`;

/** Lage der Karte am Mauszeiger, immer ganz im Fenster. */
export function hoverCardPosition(x: number, y: number, viewW: number, viewH: number, cardW = 300, cardH = 440): { left: number; top: number } {
  const left = x + 18 + cardW > viewW ? Math.max(8, x - 18 - cardW) : x + 18;
  const top = Math.max(8, Math.min(y + 12, viewH - cardH - 8));
  return { left, top };
}
