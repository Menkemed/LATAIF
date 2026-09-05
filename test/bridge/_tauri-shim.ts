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

/** Der gestellte Rust-Zustand. Ein Test darf ihn anfassen, um einen Ausfall zu erzwingen. */
export const tauriState = {
  /** Die Zwischenablage: Kennung → Bytes. */
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

/** Legt Bytes ab, wie es die echte Route taete: die Kennung IST ihr Inhalt. */
export function stageForTest(bytes: Uint8Array): string {
  const id = sha(bytes);
  tauriState.staged.set(id, bytes);
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

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  tauriState.calls.push(cmd);
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case 'staging_media_read': {
      if (tauriState.readShouldThrow) throw new Error('STAGING_IO');
      const id = String(a.stagingId ?? '');
      const bytes = tauriState.staged.get(id);
      // Genau wie in Rust: was seine Kennung nicht mehr traegt, gibt es nicht.
      if (!bytes || sha(bytes) !== id) throw new Error('STAGING_NOT_FOUND');
      return { mime: 'image/jpeg', bytes: bytes.length, dataBase64: Buffer.from(bytes).toString('base64') } as T;
    }
    case 'staging_media_discard': {
      const id = String(a.stagingId ?? '');
      tauriState.staged.delete(id);
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
    case 'media_recover_ingests':
      return [] as unknown as T;
    default:
      throw new Error(`[test] no tauri command in this shim: ${cmd}`);
  }
}

export const convertFileSrc = (p: string): string => p;
