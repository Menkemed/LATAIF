// ════════════════════════════════════════════════════════════════════════════
// MEDIA-S2 — the generic read: owner(s) + role → their CURRENT, active media.
//
// What it returns is references, never bytes: storage keys, hashes and sizes of the current
// master and thumbnail generations. Displaying goes through the verified readers (desktop gateway,
// or `/api/media` with its S1 grant) — nothing here keeps a Base64/Data-URL copy.
//
// ONE query for any number of owners (chunked only to stay under SQLite's parameter limit), so a
// list of repairs does not turn into one query per repair.
//
// The same gates as the product path: tenant, the owner's branch (branch-scoped owners), active
// link, active and ready object, present blob, current and available generation. The security
// class is filtered too — by default `public` and `internal`; a caller must name `sensitive`
// explicitly. `highly_sensitive` is never returned (it cannot exist unencrypted, S1).
// ════════════════════════════════════════════════════════════════════════════
import type { MediaSecurityClass } from './media-owner.ts';

export interface OwnerMediaRef {
  linkId: string;
  mediaId: string;
  sortOrder: number;
  isPrimary: boolean;
  securityClass: MediaSecurityClass;
  main: {
    storageKey: string; hash: string; byteSize: number; mimeType: string; extension: string;
    /**
     * MEDIA-IDENTITY §7 — WELCHE Fassung der Datei das gerade ist. Für eine Galerie egal (dort
     * gilt immer die aktuelle), für einen historischen Beleg der ganze Punkt: ein Einkauf hält
     * fest, welche Fassung beim Kauf galt, und muss sie später wiederfinden, auch wenn inzwischen
     * eine neuere gilt.
     */
    generationNo: number;
  };
  thumbnail: { storageKey: string; hash: string; byteSize: number; mimeType: string; extension: string } | null;
}

export interface OwnerMediaQuery {
  tenantId: string;
  scopeKind: 'branch' | 'tenant';
  branchId: string | null;
  entityType: string;
  role: string;
  entityIds: string[];
  /** Default `['public','internal']`. `highly_sensitive` is ignored even if named. */
  classes?: MediaSecurityClass[];
}

interface ReadDb {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

const CHUNK = 400;

export function resolveOwnerMedia(db: ReadDb, q: OwnerMediaQuery): Map<string, OwnerMediaRef[]> {
  const out = new Map<string, OwnerMediaRef[]>();
  const ids = [...new Set(q.entityIds.filter((x) => typeof x === 'string' && x.length > 0))];
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  if (q.scopeKind === 'branch' && !q.branchId) return out; // no branch, no branch-scoped media
  const classes = (q.classes ?? ['public', 'internal']).filter((c) => c !== 'highly_sensitive');
  if (classes.length === 0) return out;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const params: unknown[] = [q.tenantId, q.scopeKind];
    if (q.scopeKind === 'branch') params.push(q.branchId);
    params.push(q.entityType, q.role, ...part, ...classes);
    const rows = db.exec(
      `SELECT l.entity_id, l.link_id, l.media_id, l.sort_order, l.is_primary, o.security_class,
              g.storage_key, g.stored_blob_hash, g.byte_size, g.mime_type, g.extension,
              tg.storage_key, tg.stored_blob_hash, tg.byte_size, tg.mime_type, tg.extension,
              -- Angehängt, nicht eingefügt: die Zuordnung unten läuft über Spaltenpositionen, und
              -- eine Spalte in der Mitte hätte jede folgende stillschweigend verschoben.
              g.generation_no
         FROM media_links l
         JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
                             AND o.deleted_at IS NULL AND o.ingest_status = 'ready'
         JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id AND b.blob_status = 'present'
         JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                      AND g.generation_no = b.current_generation_no
                                      AND g.gen_status = 'available' AND g.deleted_at IS NULL
         LEFT JOIN media_variants v ON v.tenant_id = o.tenant_id AND v.media_id = o.media_id
                                   AND v.variant_type = 'thumbnail' AND v.deleted_at IS NULL
         LEFT JOIN media_blobs tb ON tb.tenant_id = v.tenant_id AND tb.blob_id = v.blob_id AND tb.blob_status = 'present'
         LEFT JOIN media_blob_generations tg ON tg.tenant_id = tb.tenant_id AND tg.blob_id = tb.blob_id
                                           AND tg.generation_no = tb.current_generation_no
                                           AND tg.gen_status = 'available' AND tg.deleted_at IS NULL
        WHERE l.tenant_id = ? AND l.scope_kind = ?
          AND ${q.scopeKind === 'branch' ? 'l.branch_id = ?' : 'l.branch_id IS NULL'}
          AND l.entity_type = ? AND l.media_role = ? AND l.deleted_at IS NULL
          AND l.entity_id IN (${part.map(() => '?').join(',')})
          AND o.security_class IN (${classes.map(() => '?').join(',')})
        ORDER BY l.entity_id, l.sort_order ASC`,
      params,
    )[0];
    if (!rows) continue;
    for (const v of rows.values) {
      const list = out.get(String(v[0]));
      if (!list) continue;
      list.push({
        linkId: String(v[1]),
        mediaId: String(v[2]),
        sortOrder: Number(v[3]),
        isPrimary: Number(v[4]) === 1,
        securityClass: String(v[5]) as MediaSecurityClass,
        main: {
          storageKey: String(v[6]), hash: String(v[7]), byteSize: Number(v[8]),
          mimeType: String(v[9]), extension: String(v[10]), generationNo: Number(v[16]),
        },
        thumbnail: v[11] == null ? null : {
          storageKey: String(v[11]), hash: String(v[12]), byteSize: Number(v[13]), mimeType: String(v[14]), extension: String(v[15]),
        },
      });
    }
  }
  return out;
}
