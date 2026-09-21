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
/**
 * R7B-Review — eine Bildspalte in fremder Form (gemischte Liste, Objekt statt Liste, Nicht-Text als
 * Einzelfoto, Auftragsentwurf ohne gültige Fotoliste). Hinter dieser Stelle prüft die Übernahme nur
 * die Transportform (`validateBusinessPayload`), und `applyUpsert` schreibt jedes Objekt als JSON-Text
 * — ohne dieses Nein stünde die Form wörtlich in der Zeile, am Normalisierer vorbei. Leere Felder und
 * ein unverändert zurückgespielter Bestandswert bleiben erlaubt.
 */
export const RECORD_IMAGE_SHAPE_INVALID = 'RECORD_IMAGE_SHAPE_INVALID';

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

/**
 * MEDIA-LEGACY-SYNC — die Bildspalten, deren Wahrheit seit dem Media-Umbau der MEDIENKERN ist.
 *
 * Für einen Datensatz, den es am Primary schon gibt, schreibt der Abgleich diese Spalte NIE mehr.
 * Der Grund: nach dem Umbau schreibt die aktuelle Anwendung dort höchstens noch `'[]'` (Altbestand
 * übernommen, Spalte geleert) — ein nicht-leerer Wert, der über den Abgleich hereinkommt, stammt
 * also von einem veralteten Rechner oder ist eine alte Zeile, die jemand noch einmal abspielt. Ihn
 * zu übernehmen hieße, ein längst übernommenes oder bewusst entferntes Foto wieder zum aktuellen
 * Stand zu machen. Also bleibt der Wert des Primary, wie er ist; die Verknüpfungen bleiben die
 * einzige Wahrheit, und „alle Fotos entfernt" bleibt leer.
 *
 * Ausdrücklich NICHT: aus dem Altbild still ein neues Medium machen — genau so würde ein gelöschtes
 * Bild zur neuen Wahrheit.
 *
 * Ein NEUER Datensatz eines alten Rechners (die Zeile gibt es am Primary nicht) bringt sein Foto
 * weiterhin als Altbestand mit, normalisiert wie bisher: er kann nichts wiederbeleben, weil es
 * nichts gab — und das Foto geht nicht verloren. Beim ersten Speichern wird er übernommen.
 *
 * Nur die Bildspalte ist betroffen; jedes andere Feld derselben Änderung wird übernommen wie bisher.
 * Artikel (`products`) und Edelmetall haben ihren eigenen, älteren Vertrag und stehen nicht hier.
 */
export const MEDIA_GOVERNED_LEGACY_COLUMNS: Readonly<Record<string, string>> = {
  repairs: 'images',
  purchase_inbox: 'images',
  suppliers: 'cpr_image',
  orders: 'custom_product_spec',
};

/**
 * MEDIA-LEGACY-SYNC — dasselbe für einen Beleg der Dokumentenmappe, aber NUR, wenn er vom Medienkern
 * geführt wird (seine Datei ist ein Medium). Ein Bilddokument trägt seinen Inhalt weiterhin in
 * `file_path` — das ist dort der gültige Vertrag (Texterkennung) und bleibt abgleichbar.
 */
export const MEDIA_GOVERNED_DOCUMENT_COLUMN = { table: 'documents', column: 'file_path' } as const;

export interface PulledChangeLike {
  table_name: string;
  record_id: string;
  action: string;
  data?: string;
}

/** Was der Primary über eine Zeile weiß — für den Media-Vertrag der Bildspalten. */
export interface MediaGovernance {
  /** Gibt es diese Zeile am Primary schon? */
  exists(table: string, recordId: string): boolean;
  /** Wird die Datei dieses Belegs vom Medienkern geführt (jemals eine Verknüpfung, aktiv oder stillgelegt)? */
  documentIsMedia(recordId: string): boolean;
}

/** Der gespeicherte Wert einer Spalte dieser Zeile (für `keep`); `undefined`/`null`, wenn es keine Zeile gibt. */
export type StoredColumn = (table: string, recordId: string, column: string) => unknown;

export interface PreparedPull<C extends PulledChangeLike> {
  changes: C[];
  /** Änderungen, deren Foto nicht gespeichert werden kann → Quarantäne statt Übernahme. */
  rejected: Map<C, string>;
  /** Wie viele Fotos neu gerechnet wurden (nur zur Auskunft). */
  normalized: number;
  /**
   * MEDIA-LEGACY-SYNC — wie viele Altbild-Werte NICHT übernommen wurden, weil der Datensatz vom
   * Medienkern geführt wird. Sichtbar statt still: ein Rechner, der hier zählt, ist veraltet.
   */
  ignoredLegacy: number;
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

/** Steht genau dieser Wert schon in der Zeile? Verglichen wird, was `applyUpsert` binden würde (Objekt → JSON-Text). */
function sameAsStored(v: unknown, before: unknown): boolean {
  if (v === null || v === undefined || before === null || before === undefined) return false;
  return String(typeof v === 'object' ? JSON.stringify(v) : v) === String(before);
}

const shapeInvalid = (table: string, column: string): RecordImageRejected =>
  new RecordImageRejected(RECORD_IMAGE_SHAPE_INVALID, `${table}.${column} is not a photo in the stored form`);

/**
 * Bereitet einen abgeholten Stapel für die Übernahme vor: neue Fotos normalisiert, gespeicherte
 * unverändert, unspeicherbare als Quarantänefall markiert. Läuft VOR der Transaktion des Stapels
 * (der Normalisierer ist asynchron), aber im selben exklusiven Platz wie sie (`syncNow`).
 */
export async function prepareRecordImages<C extends PulledChangeLike>(
  changes: readonly C[], stored: StoredColumn, governance?: MediaGovernance,
): Promise<PreparedPull<C>> {
  const out: C[] = [];
  const rejected = new Map<C, string>();
  let normalized = 0;
  let ignoredLegacy = 0;
  for (const change of changes) {
    const cols = PULLED_RECORD_IMAGE_COLUMNS[change.table_name];
    const betroffen = !!cols || (!!governance && change.table_name === MEDIA_GOVERNED_DOCUMENT_COLUMN.table);
    if (!betroffen || (change.action !== 'insert' && change.action !== 'update') || typeof change.data !== 'string') { out.push(change); continue; }
    let data: Record<string, unknown>;
    try {
      const p = JSON.parse(change.data);
      if (!p || typeof p !== 'object' || Array.isArray(p)) { out.push(change); continue; }
      data = p as Record<string, unknown>;
    } catch { out.push(change); continue; } // die Nutzlastprüfung der Übernahme weist es ab
    // MEDIA-LEGACY-SYNC — zuerst der Media-Vertrag: für einen bestehenden, vom Medienkern geführten
    // Datensatz ist die Altbild-Spalte nicht abgleichbar. Sie wird aus der Änderung genommen, und
    // die Übernahme schreibt nur, was mitkommt — die Spalte des Primary bleibt, wie sie ist.
    const vorab = governance ? legacyNichtUebernehmen(change, data, stored, governance) : { touched: false, ignored: 0 };
    ignoredLegacy += vorab.ignored;
    if (!cols) {
      out.push(vorab.touched ? ({ ...change, data: JSON.stringify(data) } as C) : change);
      continue;
    }
    let changed = vorab.touched;
    try {
      for (const { column, shape } of cols) {
        if (!Object.prototype.hasOwnProperty.call(data, column)) continue;
        const before = stored(change.table_name, change.record_id, column);
        const raw = data[column];
        if (shape === 'list') {
          const inc = readList(raw);
          if (!inc) { if (sameAsStored(raw, before)) continue; throw shapeInvalid(change.table_name, column); }
          if (inc.list.length === 0) continue;
          const keep = readList(before)?.list ?? [];
          const next = await normalizeRecordImages(inc.list, { keep });
          normalized += next.filter((x, i) => x !== inc.list[i]).length;
          if (!sameList(next, inc.list)) { data[column] = inc.asText ? JSON.stringify(next) : next; changed = true; }
        } else if (shape === 'single') {
          const inc = raw;
          if (inc === null || inc === undefined || inc === '') continue;
          if (typeof inc !== 'string') { if (sameAsStored(inc, before)) continue; throw shapeInvalid(change.table_name, column); }
          const keep = typeof before === 'string' && before ? [before] : [];
          const [next] = await normalizeRecordImages([inc], { keep });
          if (next !== inc) { data[column] = next; changed = true; normalized++; }
        } else {
          if (raw === null || raw === undefined || raw === '') continue;
          const inc = readSpec(raw);
          if (!inc) { if (sameAsStored(raw, before)) continue; throw shapeInvalid(change.table_name, column); }
          const imgs = readList(inc.spec.images);
          if (!imgs) { if (sameAsStored(raw, before)) continue; throw shapeInvalid(change.table_name, column); }
          if (imgs.list.length === 0) continue;
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
  return { changes: out, rejected, normalized, ignoredLegacy };
}

const hat = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Dieselbe Bildliste? Verglichen wird der Inhalt, nicht die Schreibweise (Feld oder JSON-Text). */
function gleicheBilder(a: unknown, b: unknown): boolean {
  const la = readList(a)?.list;
  const lb = readList(b)?.list;
  if (la && lb) return sameList(la, lb);
  return sameAsStored(a, b);
}

/**
 * MEDIA-LEGACY-SYNC — nimmt die Altbild-Spalte eines vom Medienkern geführten Datensatzes aus einer
 * abgeholten Änderung. Verändert `data` an Ort und Stelle. `touched`: die Änderung muss neu
 * geschrieben werden; `ignored`: so viele WIRKLICH abweichende Altbild-Werte kamen nicht durch
 * (das eigene Echo des Primary zählt nicht — es sagt nur, was ohnehin gilt).
 */
function legacyNichtUebernehmen(
  change: PulledChangeLike, data: Record<string, unknown>, stored: StoredColumn, g: MediaGovernance,
): { touched: boolean; ignored: number } {
  const table = change.table_name;

  // Ein Beleg der Mappe: nur, wenn seine Datei ein Medium ist. Ein Bilddokument bleibt, wie es war.
  if (table === MEDIA_GOVERNED_DOCUMENT_COLUMN.table) {
    const col = MEDIA_GOVERNED_DOCUMENT_COLUMN.column;
    if (!hat(data, col) || !g.exists(table, change.record_id) || !g.documentIsMedia(change.record_id)) {
      return { touched: false, ignored: 0 };
    }
    const abweichend = !sameAsStored(data[col], stored(table, change.record_id, col)) && !!data[col];
    delete data[col];
    return { touched: true, ignored: abweichend ? 1 : 0 };
  }

  const col = MEDIA_GOVERNED_LEGACY_COLUMNS[table];
  if (!col || !hat(data, col)) return { touched: false, ignored: 0 };
  // Ein NEUER Datensatz eines alten Rechners: nichts, was wiederbelebt werden könnte.
  if (!g.exists(table, change.record_id)) return { touched: false, ignored: 0 };
  const vorher = stored(table, change.record_id, col);

  if (col === 'custom_product_spec') {
    // Der Entwurf trägt mehr als Bilder (Kategorie, Bezeichner, …) — das bleibt abgleichbar. Nur
    // `images` kommt aus dem Stand des Primary, nicht aus der abgeholten Zeile.
    const inc = readSpec(data[col]);
    if (!inc || !hat(inc.spec, 'images')) return { touched: false, ignored: 0 };
    const primaryBilder = readSpec(vorher)?.spec.images;
    if (gleicheBilder(inc.spec.images, primaryBilder ?? [])) return { touched: false, ignored: 0 };
    const spec = { ...inc.spec };
    if (primaryBilder === undefined) delete spec.images; else spec.images = primaryBilder;
    data[col] = inc.asText ? JSON.stringify(spec) : spec;
    const kamMit = readList(inc.spec.images)?.list ?? [];
    return { touched: true, ignored: kamMit.length > 0 ? 1 : 0 };
  }

  const abweichend = !gleicheBilder(data[col], vorher);
  const leer = data[col] === null || data[col] === undefined || data[col] === '' || (readList(data[col])?.list.length ?? 1) === 0;
  delete data[col];
  return { touched: true, ignored: abweichend && !leer ? 1 : 0 };
}

interface ExecDb {
  exec(sql: string, params?: unknown[]): Array<{ values: unknown[][] }>;
}

/**
 * MEDIA-LEGACY-SYNC — was der Primary für den Media-Vertrag wissen muss, aus SEINER Datenbank.
 * Tabellennamen kommen nur aus der festen Liste oben, nie aus der abgeholten Änderung.
 */
export function syncMediaGovernance(db: ExecDb): MediaGovernance {
  const erlaubt = new Set([...Object.keys(MEDIA_GOVERNED_LEGACY_COLUMNS), MEDIA_GOVERNED_DOCUMENT_COLUMN.table]);
  return {
    exists(table, recordId) {
      if (!erlaubt.has(table)) return false;
      return (db.exec(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`, [recordId])[0]?.values?.length ?? 0) > 0;
    },
    documentIsMedia(recordId) {
      try {
        // Jemals verknüpft — aktiv ODER stillgelegt. „Datei entfernt" heißt nicht „wieder Altbestand".
        return (db.exec(
          "SELECT 1 FROM media_links WHERE entity_type = 'document' AND entity_id = ? AND media_role = 'file' LIMIT 1",
          [recordId],
        )[0]?.values?.length ?? 0) > 0;
      } catch {
        return false; // kein Medienkern in dieser Datenbank — dann gibt es auch keine Medien-Belege
      }
    },
  };
}
