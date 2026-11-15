// ════════════════════════════════════════════════════════════════════════════
// COLLECTIONS-S3 — die Kartenbilder der Artikelliste für PC2, OHNE Bild und ohne Einzelauskunft.
//
// PC2 bekommt seine Artikelliste über `store.products.get`. Bisher fragte danach JEDE sichtbare Karte
// `products.get` (die ganze Galerie mit Schlüsseln) und holte das Hauptbild. Jetzt reist mit der Liste
// je Artikel genau EIN Verweis mit: die Medienkennung des Hauptbilds, der Speicherschlüssel seiner
// Vorschau (aktuelle, verfügbare Generation) und der des Hauptbilds (Rückfall, falls die Vorschau
// fehlt). Es reist kein Byte; die Bytes holt die Karte über die bestehende, angemeldete Medienroute,
// die Vorschau-Varianten ohnehin bedient.
//
// Regel = `products.get` (read-commands `galleryOf`): dieselben Lebendigkeitsfilter, dieselbe Ordnung
// (Hauptbild zuerst) — das erste Bild dort ist das Bild hier. Rückwärtsverträglich: ein alter Client
// kennt das Feld nicht und bleibt bei `products.get`; ein neuer Client an einem alten Primary sieht kein
// `cardThumbsVersion` und nimmt ebenfalls den alten Weg.
// ════════════════════════════════════════════════════════════════════════════

export const CARD_THUMBS_VERSION = 1;

export interface CardThumbRef {
  mediaId: string;
  /** Vorschau (aktuelle Generation); `null`, wenn es keine gibt → Hauptbild. */
  thumbKey: string | null;
  mainKey: string;
}

type Rows = (sql: string, params: unknown[]) => Array<Record<string, unknown>>;

/** Je Artikel der Filiale (mit Galerie) der Kartenverweis. Nur lesend. */
export function cardThumbsFor(rows: Rows, tenantId: string, branchId: string): Record<string, CardThumbRef> {
  if (!tenantId || !branchId) return {};
  const list = rows(
    `SELECT l.entity_id AS pid, l.media_id AS m, g.storage_key AS mk,
            (SELECT gt.storage_key
               FROM media_variants v
               JOIN media_blobs bt ON bt.tenant_id = v.tenant_id AND bt.blob_id = v.blob_id
                                  AND bt.blob_status = 'present' AND bt.deleted_at IS NULL
               JOIN media_blob_generations gt ON gt.tenant_id = bt.tenant_id AND gt.blob_id = bt.blob_id
                                             AND gt.generation_no = bt.current_generation_no
                                             AND gt.gen_status = 'available' AND gt.deleted_at IS NULL
              WHERE v.tenant_id = l.tenant_id AND v.media_id = l.media_id
                AND v.variant_type = 'thumbnail' AND v.deleted_at IS NULL
              ORDER BY v.variant_id ASC LIMIT 1) AS tk
       FROM media_links l
       JOIN products p ON p.id = l.entity_id AND p.branch_id = ?
       JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
       JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
       JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                    AND g.generation_no = b.current_generation_no
      WHERE l.tenant_id = ? AND l.entity_type = 'product'
        AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND g.deleted_at IS NULL
        AND o.ingest_status = 'ready' AND b.blob_status = 'present' AND g.gen_status = 'available'
      ORDER BY l.entity_id ASC, l.is_primary DESC, l.sort_order ASC, l.link_id ASC`,
    [branchId, tenantId],
  );
  const out: Record<string, CardThumbRef> = {};
  for (const r of list) {
    const pid = r.pid == null ? '' : String(r.pid);
    const mid = r.m == null ? '' : String(r.m);
    const mk = r.mk == null ? '' : String(r.mk);
    if (!pid || !mid || !mk || out[pid]) continue; // das erste (Haupt-)Bild gewinnt
    out[pid] = { mediaId: mid, thumbKey: r.tk == null || r.tk === '' ? null : String(r.tk), mainKey: mk };
  }
  return out;
}

/** Fingerabdruck der Karte auf PC2: Kennung + beide Schlüssel (inhaltsadressiert → jede neue Fassung ändert ihn). */
export function cardThumbFingerprint(ref: CardThumbRef): string {
  return `t1:${ref.mediaId},${ref.thumbKey ?? ''},${ref.mainKey}`;
}
