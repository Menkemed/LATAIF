// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B PP-12 — Belegbilder, die über den Abgleich hereinkommen.
//
// Das Handy legt eine Reparatur (Kunde + Reparatur mit Foto) und ein Einkaufs-Inbox-Foto NICHT über
// `/api/mobile/upload` an, sondern als Zeilen über `/api/sync/push`; der Primary übernimmt sie beim
// Abholen (`pullChanges` → `applySyncChange`) in seine Geschäftsdatenbank. Auf diesem Weg gab es bis
// hier KEINE Bildprüfung: das Foto (am Handy 1600 px, JPEG 0,85, ohne Byte-Ziel) landete so, wie es
// kam, in `repairs.images` bzw. `purchase_inbox.images` — und jeder angemeldete Rechner hätte über
// denselben Eingang beliebige Bytes in eine Bildspalte schreiben können.
//
// Jetzt gilt an der Übernahme derselbe Vertrag wie am Primary und beim Abholen von PC2: jedes NEUE
// Foto einer Bildspalte geht durch den EINEN Normalisierer (`normalizeRecordImages` → Rust
// `normalize_stock_image`: JPEG, ≤ 100 000 B, ≤ 1600 px, Metadaten weg). Ein schon gespeichertes
// Foto derselben Zeile bleibt Byte für Byte (`keep`) — der Primary spielt seine eigenen Änderungen
// beim nächsten Abholen wieder ein, und ein Altbild darf dadurch nicht still umgerechnet werden.
// Ein Foto, das nicht gespeichert werden kann, macht die ganze Änderung zu einem Fall für die
// bestehende Quarantäne (`SYNC_RECORD_IMAGE_REJECTED`) — nichts halb, nichts still ohne Foto.
//
// Dokumente (`documents.file_path`) gehören NICHT hierher: ihr Original ist die Vorlage der
// Texterkennung und bleibt unverändert.
// ════════════════════════════════════════════════════════════════════════════
import { normalizeRecordImages, RecordImageRejected } from '../media/record-image.ts';

export const SYNC_RECORD_IMAGE_REJECTED = 'SYNC_RECORD_IMAGE_REJECTED';

type Shape = 'list' | 'single' | 'spec';

/** Jede Bildspalte des Abgleich-Manifests, die ein Foto einer Zeile trägt (kein Dokument). */
export const PULLED_RECORD_IMAGE_COLUMNS: Readonly<Record<string, ReadonlyArray<{ column: string; shape: Shape }>>> = {
  repairs: [{ column: 'images', shape: 'list' }],
  purchase_inbox: [{ column: 'images', shape: 'list' }],
  products: [{ column: 'images', shape: 'list' }],
  precious_metals: [{ column: 'images', shape: 'list' }],
  suppliers: [{ column: 'cpr_image', shape: 'single' }],
  orders: [{ column: 'custom_product_spec', shape: 'spec' }],
};

export interface PulledChangeLike {
  table_name: string;
  record_id: string;
  action: string;
  data?: string;
}

/** Der gespeicherte Wert einer Spalte dieser Zeile (für `keep`); `undefined`/`null`, wenn es keine Zeile gibt. */
export type StoredColumn = (table: string, recordId: string, column: string) => unknown;

export interface PreparedPull<C extends PulledChangeLike> {
  changes: C[];
  /** Änderungen, deren Foto nicht gespeichert werden kann → Quarantäne statt Übernahme. */
  rejected: Map<C, string>;
  /** Wie viele Fotos neu gerechnet wurden (nur zur Auskunft). */
  normalized: number;
}

/** Eine Bildliste: ein echtes Feld oder — so schickt es das Handy — ein JSON-Text darin. */
function readList(v: unknown): { list: string[]; asText: boolean } | null {
  if (v === null || v === undefined || v === '') return { list: [], asText: typeof v === 'string' };
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? { list: v as string[], asText: false } : null;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p) && p.every((x) => typeof x === 'string')) return { list: p as string[], asText: true };
    } catch { /* kein JSON — nicht unser Fall */ }
  }
  return null;
}

function readSpec(v: unknown): { spec: Record<string, unknown>; asText: boolean } | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return { spec: v as Record<string, unknown>, asText: false };
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === 'object' && !Array.isArray(p)) return { spec: p as Record<string, unknown>, asText: true };
    } catch { /* kein JSON */ }
  }
  return null;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Bereitet einen abgeholten Stapel für die Übernahme vor: neue Fotos normalisiert, gespeicherte
 * unverändert, unspeicherbare als Quarantänefall markiert. Läuft VOR der Transaktion des Stapels
 * (der Normalisierer ist asynchron), aber im selben exklusiven Platz wie sie (`syncNow`).
 */
export async function prepareRecordImages<C extends PulledChangeLike>(changes: readonly C[], stored: StoredColumn): Promise<PreparedPull<C>> {
  const out: C[] = [];
  const rejected = new Map<C, string>();
  let normalized = 0;
  for (const change of changes) {
    const cols = PULLED_RECORD_IMAGE_COLUMNS[change.table_name];
    if (!cols || (change.action !== 'insert' && change.action !== 'update') || typeof change.data !== 'string') { out.push(change); continue; }
    let data: Record<string, unknown>;
    try {
      const p = JSON.parse(change.data);
      if (!p || typeof p !== 'object' || Array.isArray(p)) { out.push(change); continue; }
      data = p as Record<string, unknown>;
    } catch { out.push(change); continue; } // die Nutzlastprüfung der Übernahme weist es ab
    let changed = false;
    try {
      for (const { column, shape } of cols) {
        if (!Object.prototype.hasOwnProperty.call(data, column)) continue;
        const before = stored(change.table_name, change.record_id, column);
        if (shape === 'list') {
          const inc = readList(data[column]);
          if (!inc || inc.list.length === 0) continue;
          const keep = readList(before)?.list ?? [];
          const next = await normalizeRecordImages(inc.list, { keep });
          normalized += next.filter((x, i) => x !== inc.list[i]).length;
          if (!sameList(next, inc.list)) { data[column] = inc.asText ? JSON.stringify(next) : next; changed = true; }
        } else if (shape === 'single') {
          const inc = data[column];
          if (typeof inc !== 'string' || inc === '') continue;
          const keep = typeof before === 'string' && before ? [before] : [];
          const [next] = await normalizeRecordImages([inc], { keep });
          if (next !== inc) { data[column] = next; changed = true; normalized++; }
        } else {
          const inc = readSpec(data[column]);
          const imgs = inc ? readList(inc.spec.images) : null;
          if (!inc || !imgs || imgs.list.length === 0) continue;
          const keep = readList(readSpec(before)?.spec.images)?.list ?? [];
          const next = await normalizeRecordImages(imgs.list, { keep });
          normalized += next.filter((x, i) => x !== imgs.list[i]).length;
          if (!sameList(next, imgs.list)) {
            const spec = { ...inc.spec, images: imgs.asText ? JSON.stringify(next) : next };
            data[column] = inc.asText ? JSON.stringify(spec) : spec;
            changed = true;
          }
        }
      }
    } catch (e) {
      // Ein Urteil über das FOTO (fester Code des Normalisierers, oder gar kein Foto) → Quarantäne.
      // Alles andere (der Normalisierer war nicht erreichbar) ist keins: der Stapel wird dann nicht
      // übernommen, der Stand rückt nicht vor, und das nächste Abholen versucht es wieder.
      if (e instanceof RecordImageRejected && e.code !== 'RECORD_IMAGE_NOT_STORED') { out.push(change); rejected.set(change, e.code); continue; }
      throw e;
    }
    const next = changed ? ({ ...change, data: JSON.stringify(data) } as C) : change;
    out.push(next);
  }
  return { changes: out, rejected, normalized };
}
