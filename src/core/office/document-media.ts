// ════════════════════════════════════════════════════════════════════════════
// MEDIA-DOCUMENTS — die hochgeladene PDF-Datei eines Belegs im Medienkern.
//
// Bis hierher trug `documents.file_path` die GANZE Datei als Daten-URL in der Zeile. Das ist der
// teuerste Weg, den es gibt: Base64 macht aus jedem Byte vier Zeichen, die Zeile reist als JSON
// durch den Abgleich, und die Obergrenze der Datei war nicht die der Datei, sondern die einer
// Abgleich-Nachricht (~23,95 MiB, abgeleitet aus 32 MiB Nutzlast). Eine PDF von 25 MiB passte nie.
//
// Jetzt gilt für PDF der S1-Vertrag für ORIGINALE, byte-genau:
//
//   Bytes → `publish_original` (Rust: Endung, Größe ≤ 25 MiB, führende Bytes, Hash) → Datei im
//   inhaltsadressierten Speicher → Medienzeilen (Objekt, Blob, Fassung) → Geschäftstransaktion:
//   Belegzeile + Verknüpfung → COMMIT
//
// Was hier ausdrücklich NICHT geschieht: keine JPEG-Normalisierung, keine Miniatur, kein
// Produkt-Embedding, kein `publish_atomically` (das gehört den Renditionen). `master_kind` ist
// `original` — das ist der Unterschied, den das Schema kennt.
//
// Bilder in der Dokumentenmappe bleiben vorerst auf ihrem alten Weg: sie durch den Bild-Normalisierer
// zu schicken hieße, ihre Bytes zu verändern (die Texterkennung liest genau diese), und ein zweiter
// Originaltyp wäre ein neuer Speichervertrag. Dieses Bündel ist PDF.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId } from '@/core/db/helpers';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { resolveOwnerMedia, type OwnerMediaRef } from '@/core/media/owner-media-resolver';
import { blobIdFor, dedupTokenFor, mediaIdFor } from '@/core/media/ids';
import { toIngestRequestId } from '@/core/media/ingest-request-id';
import { ORIGINAL_MAX_BYTES, OriginalMediaTransport, type OriginalDescriptor } from '@/core/media/gateway';
import type { MediaOwner } from '@/core/media/media-owner';

/** Der Beleg selbst ist der Besitzer — es gibt keine „Datei, die irgendwo hingehört". */
export const DOCUMENT_MEDIA_ENTITY = 'document';
/** Eine Rolle: DIE Datei dieses Belegs. */
export const DOCUMENT_MEDIA_ROLE = 'file';
/** Eine Rechnung, ein Beleg, ein Zertifikat — interne Unterlagen. Ausweise leben woanders. */
export const DOCUMENT_SECURITY_CLASS = 'internal' as const;
/** Der eine Originaltyp dieses Bündels. */
export const DOCUMENT_EXTENSION = 'pdf' as const;
export const DOCUMENT_MIME = 'application/pdf';
/** Dieselbe Grenze wie `storage::DOCUMENT_MAX_BYTES` — 25 MiB, nicht erhöht. */
export const DOCUMENT_MAX_BYTES = ORIGINAL_MAX_BYTES;

export class DocumentMediaError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'DocumentMediaError';
  }
}

/** Gibt es den Medienkern in DIESER Datenbank? Eine fehlende Tabelle ist eine Antwort, kein Absturz. */
function mediaCoreAvailable(): boolean {
  return query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_links' LIMIT 1").length > 0;
}

/** `%PDF-` — dieselben fünf Bytes, die Rust prüft. Der Client weist früh ab, statt zu senden. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export function documentMediaScope(documentId?: string): { tenantId: string; branchId: string } {
  let branchId = '';
  const row = documentId ? query('SELECT branch_id FROM documents WHERE id = ?', [documentId])[0] : undefined;
  if (row?.branch_id) branchId = String(row.branch_id);
  if (!branchId) branchId = currentBranchId();
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0];
  return { tenantId: String(t?.tenant_id ?? 'tenant-1'), branchId };
}

export function documentMediaOwner(documentId: string, scope = documentMediaScope(documentId)): MediaOwner {
  return {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: DOCUMENT_MEDIA_ENTITY, entityId: documentId, role: DOCUMENT_MEDIA_ROLE,
    securityClass: DOCUMENT_SECURITY_CLASS,
  };
}

/** Die Kennung DIESES Inhalts für DIESEN Besitzertyp — stabil, ohne Zufall: dieselbe Datei, dasselbe Objekt. */
export function documentIngestRequestId(hash: string): string {
  return toIngestRequestId(`doc-${DOCUMENT_MEDIA_ROLE}-${hash}`);
}

/**
 * Die Beschreibung einer Datei, die schon im Speicher liegt — so, wie Rust sie zurückgibt oder wie
 * der Geschäftsbefehl sie nachprüft. Sie trägt NIE Bytes.
 */
export interface DocumentOriginal {
  hash: string;
  byteSize: number;
  storageKey: string;
  mimeType: string;
  extension: string;
  contentKind: string;
}

export function originalOf(d: OriginalDescriptor): DocumentOriginal {
  return {
    hash: d.hash, byteSize: d.byte_size, storageKey: d.storage_key,
    mimeType: d.mime_type, extension: d.extension, contentKind: d.content_kind,
  };
}

/**
 * Die Bytes am PRIMARY in den Speicher legen — roh über die IPC, nie als JSON-Zahlenfeld und nie
 * als Base64. Der Client prüft Typ und Größe VOR dem Senden; Rust prüft beides noch einmal.
 */
export async function publishDocumentOriginal(
  bytes: Uint8Array, tenantScope: string, transport = new OriginalMediaTransport(),
): Promise<DocumentOriginal> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new DocumentMediaError('DOCUMENT_EMPTY', 'a document has no bytes');
  }
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
    throw new DocumentMediaError('DOCUMENT_TOO_LARGE', `a document is at most ${DOCUMENT_MAX_BYTES} bytes`);
  }
  if (!isPdfBytes(bytes)) {
    throw new DocumentMediaError('DOCUMENT_NOT_A_PDF', 'this file does not start with %PDF-');
  }
  return originalOf(await transport.publishOriginal({ tenantScope, extension: DOCUMENT_EXTENSION, bytes }));
}

/**
 * MEDIA-DOCUMENTS §3/§9 — die Bytes EINER PDF in den Speicher des Primary bringen, von welchem
 * Rechner auch immer. Zurück kommt nur ihre Beschreibung; der Auftrag nennt danach den Hash.
 *
 *   Primary → die rohe IPC (`media_publish_original`)
 *   PC2     → `POST /api/documents/raw` mit Ausweis, Rumpf = die Bytes
 *
 * Auf beiden Wegen: kein JSON-Zahlenfeld, kein Base64, keine zweite Kopie. Die Größe wird VOR dem
 * Senden geprüft — und auf der Gegenseite noch einmal, denn ein Client prüft nur sich selbst.
 */
export async function sendDocumentFile(
  bytes: Uint8Array,
  wege: {
    remote: boolean;
    tenantScope: string;
    client?: { serverUrl: string; token: string } | null;
    fetchFn?: typeof fetch;
    transport?: OriginalMediaTransport;
  },
): Promise<{ hash: string; byteSize: number }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new DocumentMediaError('DOCUMENT_EMPTY', 'a document has no bytes');
  }
  if (bytes.byteLength > DOCUMENT_MAX_BYTES) {
    throw new DocumentMediaError('DOCUMENT_TOO_LARGE', `a document is at most ${DOCUMENT_MAX_BYTES} bytes`);
  }
  if (!isPdfBytes(bytes)) {
    throw new DocumentMediaError('DOCUMENT_NOT_A_PDF', 'this file does not start with %PDF-');
  }
  if (!wege.remote) {
    const o = await publishDocumentOriginal(bytes, wege.tenantScope, wege.transport);
    return { hash: o.hash, byteSize: o.byteSize };
  }
  const c = wege.client;
  if (!c?.token) throw new DocumentMediaError('NOT_AUTHENTICATED', 'this computer is not signed in to the main computer');
  const res = await (wege.fetchFn ?? fetch)(`${c.serverUrl}/api/documents/raw`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/pdf' },
    body: bytes as unknown as BodyInit,
  });
  if (res.status === 413) throw new DocumentMediaError('DOCUMENT_TOO_LARGE', 'the main computer refused this file as too large');
  if (!res.ok) throw new DocumentMediaError('DOCUMENT_UPLOAD_FAILED', `the main computer refused this file (${res.status})`);
  const body = await res.json() as { hash?: unknown; byteSize?: unknown };
  if (typeof body.hash !== 'string' || !Number.isInteger(Number(body.byteSize))) {
    throw new DocumentMediaError('DOCUMENT_UPLOAD_FAILED', 'the main computer did not describe the stored file');
  }
  return { hash: body.hash, byteSize: Number(body.byteSize) };
}

/**
 * MEDIA-DOCUMENTS §3 — „liegt diese Datei wirklich so da?", ohne sie zu holen.
 *
 * Rust liest sie in Stücken und prüft Größe, führende Bytes und Inhalt-Hash; zurück kommt nur ihre
 * Beschreibung. Sie ganz einzulesen, um sie gleich wieder wegzuwerfen, wäre genau die Belegung, die
 * dieser Weg vermeidet.
 */
export async function statDocumentOriginal(
  tenantScope: string, hash: string,
  invoker?: <T>(cmd: string, args?: unknown) => Promise<T>,
): Promise<DocumentOriginal> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new DocumentMediaError('DOCUMENT_ORIGINAL_INVALID', 'a content hash is 64 hex characters');
  const call = invoker ?? (async <T>(cmd: string, args?: unknown): Promise<T> => {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(cmd, args as never);
  });
  let raw: Record<string, unknown>;
  try {
    raw = await call<Record<string, unknown>>('media_stat_original', {
      tenantScope, hash, extension: DOCUMENT_EXTENSION,
    });
  } catch (e) {
    throw new DocumentMediaError('DOCUMENT_FILE_NOT_FOUND', `this document file is not in the store: ${(e as Error).message}`);
  }
  return {
    hash, byteSize: Number(raw.byte_size), storageKey: String(raw.storage_key),
    mimeType: String(raw.mime_type), extension: String(raw.extension), contentKind: String(raw.content_kind),
  };
}

/**
 * Aus einer Datei, die schon im Speicher liegt, ein verifiziertes, noch UNVERKNÜPFTES Medienobjekt
 * machen. Läuft VOR der Geschäftstransaktion — die Zeilen sind idempotent über den Inhalt-Hash:
 * dieselbe Datei zweimal ergibt dasselbe Objekt, keine zweite Zeile, keine zweite Datei.
 */
export function registerDocumentOriginal(o: DocumentOriginal, scope = documentMediaScope()): string {
  if (!mediaCoreAvailable()) {
    throw new DocumentMediaError('MEDIA_CORE_MISSING', 'this database has no media store — documents cannot be saved');
  }
  if (o.extension !== DOCUMENT_EXTENSION || o.contentKind !== 'pdf' || o.mimeType !== DOCUMENT_MIME) {
    throw new DocumentMediaError('DOCUMENT_NOT_A_PDF', 'only a PDF original belongs to this contract');
  }
  if (!/^[0-9a-f]{64}$/.test(o.hash) || !Number.isInteger(o.byteSize) || o.byteSize <= 0 || o.byteSize > DOCUMENT_MAX_BYTES) {
    throw new DocumentMediaError('DOCUMENT_ORIGINAL_INVALID', 'the stored original is not described correctly');
  }
  const db = getDatabase();
  const now = new Date().toISOString();
  const blobId = blobIdFor(o.hash);
  const mediaId = mediaIdFor(documentIngestRequestId(o.hash));

  const gen = query(
    'SELECT storage_key, stored_blob_hash, byte_size, extension FROM media_blob_generations WHERE tenant_id = ? AND blob_id = ? AND generation_no = 1',
    [scope.tenantId, blobId],
  )[0];
  if (gen) {
    // Dieselbe Datei war schon da. Sie MUSS in jedem Stück dieselbe sein — sonst behauptet
    // irgendetwas denselben Inhalt für andere Bytes, und das ist kein Zustand, in dem man schreibt.
    if (String(gen.storage_key) !== o.storageKey || String(gen.stored_blob_hash) !== o.hash
      || Number(gen.byte_size) !== o.byteSize || String(gen.extension) !== o.extension) {
      throw new DocumentMediaError('MEDIA_DB_MEDIA_CONFLICT', 'a different file already claims this content hash');
    }
  } else {
    // Erst die Fassung (`available`), dann der Zeiger (`present`) — der Auslöser des Schemas
    // verlangt genau diese Reihenfolge.
    db.run(
      `INSERT INTO media_blob_generations
        (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash, byte_size,
         content_kind, mime_type, extension, is_encrypted, dek_version, gen_status, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0, NULL, 'available', ?)`,
      [scope.tenantId, blobId, o.storageKey, o.hash, o.byteSize, o.contentKind, o.mimeType, o.extension, now],
    );
    db.run(
      `INSERT INTO media_blobs (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'present', ?, ?)`,
      [scope.tenantId, blobId, dedupTokenFor(scope.tenantId, o.hash), now, now],
    );
  }

  const obj = query('SELECT master_blob_id, master_kind, security_class FROM media_objects WHERE tenant_id = ? AND media_id = ?',
    [scope.tenantId, mediaId])[0];
  if (obj) {
    if (String(obj.master_blob_id) !== blobId || String(obj.master_kind) !== 'original'
      || String(obj.security_class) !== DOCUMENT_SECURITY_CLASS) {
      throw new DocumentMediaError('MEDIA_DB_MEDIA_CONFLICT', 'this media object already exists with a different contract');
    }
    return mediaId;
  }
  db.run(
    `INSERT INTO media_objects
      (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind, source_type,
       security_class, retention_class, ingest_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'original', 'upload_desktop', ?, 'standard', 'ready', ?, ?)`,
    [scope.tenantId, mediaId, scope.branchId, blobId, DOCUMENT_SECURITY_CLASS, now, now],
  );
  return mediaId;
}

/**
 * MEDIA-DOCUMENTS §5 — aus „diese Datei liegt da (Hash)" wird „dieses Medienobjekt" — an EINER
 * Stelle, für beide Wege: die Maske am Primary und der Fernbefehl von PC2.
 *
 * Läuft VOR der Geschäftsklammer: der Nachweis liest die Datei stückweise, das Anmelden schreibt
 * drei Zeilen. Beides braucht keine offene Geschäftstransaktion — und in einer offenen hätte der
 * Nachweis keinen eigenen Haltepunkt.
 */
export async function resolveDocumentMedia(
  body: Record<string, unknown>, scope: { tenantId: string; branchId: string },
  stat: (tenantScope: string, hash: string) => Promise<DocumentOriginal> = statDocumentOriginal,
): Promise<Record<string, unknown>> {
  const named = body.media as { hash?: unknown; byteSize?: unknown; mediaId?: unknown } | undefined;
  if (!named || typeof named.hash !== 'string') return body;
  const o = await stat(scope.tenantId, named.hash);
  if (Number(named.byteSize) !== o.byteSize) {
    throw new DocumentMediaError('DOCUMENT_CONTENT_INVALID', 'the stored file has a different size than the order claims');
  }
  return { ...body, media: { mediaId: registerDocumentOriginal(o, scope), byteSize: o.byteSize } };
}

/**
 * Die Datei INNERHALB der laufenden Geschäftstransaktion an den Beleg hängen.
 *
 * Genau eine Datei je Beleg: die Mappe zeigt einen Beleg, nicht eine Galerie. `setGallery` mit
 * einer Kennung ersetzt eine vorhandene Verknüpfung (stilllegen + neu) in EINER logischen Fassung —
 * das ist zugleich „Ersetzen"; mit leerer Liste ist es „Entfernen".
 */
export function applyDocumentFile(
  documentId: string, mediaIds: readonly string[], opts: { bumpOwner?: boolean } = {},
): { changed: boolean } {
  if (!mediaCoreAvailable()) {
    if (mediaIds.length === 0) return { changed: false };
    throw new DocumentMediaError('MEDIA_CORE_MISSING', 'this database has no media store — documents cannot be saved');
  }
  if (mediaIds.length > 1) throw new DocumentMediaError('DOCUMENT_ONE_FILE', 'a document record holds exactly one file');
  const links = new MediaOwnerLinks(getDatabase() as never);
  try {
    return links.setGallery(documentMediaOwner(documentId), mediaIds, { bumpOwner: opts.bumpOwner ?? false });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'MEDIA_LINK_OBJECT_NOT_READY') {
      throw new DocumentMediaError('DOCUMENT_FILE_NOT_FOUND', 'this document file is not available (any more)');
    }
    if (typeof code === 'string' && code.startsWith('MEDIA_')) throw new DocumentMediaError(code, (e as Error).message);
    throw e;
  }
}

/** Die Datei eines Belegs — eine Referenz, nie Bytes. */
export function documentFileRef(documentId: string): OwnerMediaRef | null {
  return documentFileRefsFor([documentId]).get(documentId)?.[0] ?? null;
}

/** Dieselbe Auskunft für viele Belege — EINE Abfrage (die Mappe bleibt eine Liste). */
export function documentFileRefsFor(documentIds: readonly string[], branchId?: string): Map<string, OwnerMediaRef[]> {
  if (!mediaCoreAvailable()) return new Map(documentIds.map((id) => [id, []]));
  const scope = documentMediaScope();
  return resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: branchId ?? scope.branchId,
    entityType: DOCUMENT_MEDIA_ENTITY, role: DOCUMENT_MEDIA_ROLE, entityIds: [...documentIds],
  });
}

export function documentMediaId(documentId: string): string | null {
  return documentFileRef(documentId)?.mediaId ?? null;
}
