// Nur fuer Tests: die IPC-Grenze. Alles darueber ist ECHT.
//
// Der Produktweg spricht an genau zwei Stellen mit Rust: der Medien-Gateway (`TauriMediaGateway`,
// fuenf Befehle) und die neutrale Zwischenablage (`staging_media_read`/`staging_media_discard`).
// Beides sind Transporte, keine Entscheidungen — also wird HIER gestellt und nirgendwo sonst. Der
// echte Gateway, der echte Orchestrator, der echte Koordinator und der echte Store laufen.
//
// Die Ablage ist bewusst inhaltsadressiert wie das Original: eine Kennung ist der SHA-256 der
// Bytes. Ein Test, der eine Kennung erfindet, bekommt deshalb dieselbe Antwort wie in der
// Produktion — nichts.

import { createHash } from 'node:crypto';

const sha = (b: Uint8Array): string => createHash('sha256').update(Buffer.from(b)).digest('hex');
const cat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
};

const desc = (hash: string, size: number, w: number, h: number) => ({
  hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg',
  byte_size: size, width: w, height: h,
});

interface Rend { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }

/**
 * Der Eigentümerschlüssel — Zeichen für Zeichen dieselbe Ableitung wie in Rust
 * (`media_staging::owner_key`). Zwei Formeln wären zwei Meinungen darüber, wem eine Ablage
 * gehört, und der Test würde etwas beweisen, das die Produktion nicht tut.
 */
export function ownerKey(o: { tenantId: string; branchId: string; userId: string }): string {
  return createHash('sha256')
    .update(`staging-owner\u0001${o.tenantId}\u0001${o.branchId}\u0001${o.userId}`)
    .digest('hex');
}

/** Der gestellte Rust-Zustand. Ein Test darf ihn anfassen, um einen Ausfall zu erzwingen. */
export const tauriState = {
  /** Die Zwischenablage: `<Eigentümer>/<Kennung>` → Bytes. Genau wie auf der Platte. */
  staged: new Map<string, Uint8Array>(),
  /** Welche Kennungen verworfen wurden — der Beweis, dass aufgeraeumt wird. */
  discarded: [] as string[],
  /** Wenn gesetzt, scheitert der Commit dieses Ingest-Auftrags (Medienausfall). */
  commitShouldThrowFor: null as string | null,
  /** Wenn gesetzt, scheitert JEDES Vorbereiten (die Bilder kommen gar nicht erst an). */
  prepareShouldThrow: false,
  /** Wenn gesetzt, scheitert das Lesen aus der Ablage. */
  readShouldThrow: false,
  calls: [] as string[],
  reset(): void {
    this.staged.clear();
    this.discarded = [];
    this.commitShouldThrowFor = null;
    this.prepareShouldThrow = false;
    this.readShouldThrow = false;
    this.calls = [];
  },
};

/**
 * Legt Bytes ab, wie es die echte Route taete: die Kennung IST ihr Inhalt, und das Fach gehoert
 * dem angemeldeten Absender.
 */
export function stageForTest(
  bytes: Uint8Array,
  owner: { tenantId: string; branchId: string; userId: string },
): string {
  const id = sha(bytes);
  tauriState.staged.set(`${ownerKey(owner)}/${id}`, bytes);
  return id;
}

const files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
const byHash = new Map<string, Rend>();
const reqBytes = new Map<string, Uint8Array>();

function rend(scope: string, input: Uint8Array): Rend {
  const h = sha(input);
  let r = byHash.get(h);
  if (!r) {
    r = {
      main: sha(cat(input, new Uint8Array([1]))),
      thumb: sha(cat(input, new Uint8Array([2]))),
      mainB: cat(input, new Uint8Array([0xaa])),
      thumbB: cat(input, new Uint8Array([0xbb])),
    };
    byHash.set(h, r);
  }
  files.set(`${scope}::${r.main}`, { bytes: r.mainB, mime: 'image/jpeg', ext: 'jpg' });
  files.set(`${scope}::${r.thumb}`, { bytes: r.thumbB, mime: 'image/jpeg', ext: 'jpg' });
  return r;
}

export async function invoke<T = unknown>(
  cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> },
): Promise<T> {
  tauriState.calls.push(cmd);
  // MEDIA-DOCUMENTS — ein ORIGINAL reist als ROHER Rumpf: das Argument IST die Bytefolge, die
  // Angaben stehen in Kopfzeilen. Genau so traegt Tauri es, und genau so wird es hier gelesen.
  const roh = args instanceof Uint8Array ? args : null;
  const kopf = options?.headers ?? {};
  const a = (roh ? {} : (args ?? {})) as Record<string, unknown>;
  switch (cmd) {
    case 'staging_media_read': {
      if (tauriState.readShouldThrow) throw new Error('STAGING_IO');
      const id = String(a.stagingId ?? '');
      // Der Eigentuemer kommt als Teil des Aufrufs — in der Produktion aus der geprueften
      // Identitaet des Auftrags. Ein fremdes Fach ist von hier aus nicht vorhanden.
      const key = `${ownerKey({
        tenantId: String(a.tenantId ?? ''), branchId: String(a.branchId ?? ''), userId: String(a.userId ?? ''),
      })}/${id}`;
      const bytes = tauriState.staged.get(key);
      // Genau wie in Rust: was seine Kennung nicht mehr traegt, gibt es nicht.
      if (!bytes || sha(bytes) !== id) throw new Error('STAGING_NOT_FOUND');
      return { mime: 'image/jpeg', bytes: bytes.length, dataBase64: Buffer.from(bytes).toString('base64') } as T;
    }
    // POST-PARITY R7B PP-12 — der Belegbild-Weg. Der echte Normalisierer (Rust `media::record_image`)
    // rechnet das Foto in ein JPEG ≤ 100 000 B um; hier steht er — wie `media_prepare_stock_image`
    // für den Medienspeicher — mit derselben Form und den Bytes selbst (Kennzeichen: immer JPEG).
    // Was er WIRKLICH tut, prüfen `cargo test media::record_image` und der Zwei-Rechner-Lauf.
    case 'staging_media_read_record': {
      if (tauriState.readShouldThrow) throw new Error('STAGING_IO');
      const id = String(a.stagingId ?? '');
      const key = `${ownerKey({
        tenantId: String(a.tenantId ?? ''), branchId: String(a.branchId ?? ''), userId: String(a.userId ?? ''),
      })}/${id}`;
      const bytes = tauriState.staged.get(key);
      if (!bytes || sha(bytes) !== id) throw new Error('STAGING_NOT_FOUND');
      return { mime: 'image/jpeg', bytes: bytes.length, width: 0, height: 0, dataBase64: Buffer.from(bytes).toString('base64') } as T;
    }
    case 'media_normalize_record_image': {
      const b64 = String(a.dataBase64 ?? '');
      return { mime: 'image/jpeg', bytes: Buffer.from(b64, 'base64').length, width: 0, height: 0, dataBase64: b64 } as T;
    }
    case 'staging_media_discard': {
      const id = String(a.stagingId ?? '');
      const key = `${ownerKey({
        tenantId: String(a.tenantId ?? ''), branchId: String(a.branchId ?? ''), userId: String(a.userId ?? ''),
      })}/${id}`;
      tauriState.staged.delete(key);
      tauriState.discarded.push(id);
      return undefined as T;
    }
    case 'media_prepare_stock_image': {
      if (tauriState.prepareShouldThrow) throw new Error('MEDIA_PREPARE_FAILED');
      const bytes = Uint8Array.from(a.imageBytes as number[]);
      const scope = String(a.tenantScope);
      reqBytes.set(`${scope}::${String(a.ingestRequestId)}`, bytes);
      const r = rend(scope, bytes);
      return {
        ingest_request_id: String(a.ingestRequestId), request_hash: String(a.requestHash), state: 'prepared',
        main_descriptor: desc(r.main, r.mainB.length, 800, 600),
        thumbnail_descriptor: desc(r.thumb, r.thumbB.length, 200, 150),
      } as T;
    }
    case 'media_commit_stock_image': {
      const id = String(a.ingestRequestId);
      if (tauriState.commitShouldThrowFor === id) throw new Error('MEDIA_INGEST_NOT_FOUND');
      const scope = String(a.tenantScope);
      const bytes = reqBytes.get(`${scope}::${id}`);
      if (!bytes) throw new Error('MEDIA_INGEST_NOT_FOUND');
      const r = rend(scope, bytes);
      return {
        state: 'published',
        main_descriptor: desc(r.main, r.mainB.length, 800, 600),
        thumbnail_descriptor: desc(r.thumb, r.thumbB.length, 200, 150),
        main_storage_key: `${scope}/${r.main.slice(0, 2)}/${r.main}.jpg`,
        thumbnail_storage_key: `${scope}/${r.thumb.slice(0, 2)}/${r.thumb}.jpg`,
      } as T;
    }
    case 'media_abort_stock_image':
      return { ingest_request_id: String(a.ingestRequestId), state: 'aborted' } as T;
    case 'media_read_verified':
    case 'read_verified_media': {
      const f = files.get(`${String(a.tenantScope)}::${String(a.hash)}`);
      if (!f) throw new Error('MEDIA_FILE_MISSING');
      return { bytes: Array.from(f.bytes), hash: String(a.hash), byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext } as T;
    }
    // MEDIA-DOCUMENTS — der Rohweg fuer ORIGINALE (PDF). Derselbe Vertrag wie in Rust: Endung,
    // Groesse, fuehrende Bytes, Inhalt-Hash — und der Speicher ist inhaltsadressiert.
    case 'media_publish_original': {
      const bytes = roh as Uint8Array;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('MEDIA_FILE_TOO_LARGE');
      if (bytes.length > 25 * 1024 * 1024) throw new Error('MEDIA_FILE_TOO_LARGE');
      const ext = String(kopf['x-lataif-extension'] ?? 'pdf');
      if (ext !== 'pdf') throw new Error('MEDIA_INVALID_EXTENSION');
      const istPdf = bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
      if (!istPdf) throw new Error('MEDIA_INVALID_EXTENSION');
      const scope = String(kopf['x-lataif-tenant-scope'] ?? 'tenant-1');
      const h = sha(bytes);
      const key = `${scope}/${h.slice(0, 2)}/${h}.pdf`;
      const reused = files.has(`${scope}::${h}`);
      if (!reused) files.set(`${scope}::${h}`, { bytes, mime: 'application/pdf', ext: 'pdf' });
      return { storage_key: key, hash: h, byte_size: bytes.length, mime_type: 'application/pdf', extension: 'pdf', content_kind: 'pdf', reused } as T;
    }
    case 'media_stat_original': {
      const scope = String(a.tenantScope);
      const f = files.get(`${scope}::${String(a.hash)}`);
      if (!f) throw new Error('MEDIA_FILE_MISSING');
      if (sha(f.bytes) !== String(a.hash)) throw new Error('MEDIA_FILE_HASH_MISMATCH');
      return {
        storage_key: `${scope}/${String(a.hash).slice(0, 2)}/${String(a.hash)}.pdf`,
        byte_size: f.bytes.length, mime_type: f.mime, content_kind: 'pdf', extension: f.ext,
      } as T;
    }
    case 'media_read_verified_raw': {
      const f = files.get(`${String(a.tenantScope)}::${String(a.hash)}`);
      if (!f) throw new Error('MEDIA_FILE_MISSING');
      if (sha(f.bytes) !== String(a.hash)) throw new Error('MEDIA_FILE_HASH_MISMATCH');
      return f.bytes as unknown as T;
    }
    case 'media_recover_ingests':
      return [] as unknown as T;
    default:
      throw new Error(`[test] no tauri command in this shim: ${cmd}`);
  }
}

export const convertFileSrc = (p: string): string => p;
