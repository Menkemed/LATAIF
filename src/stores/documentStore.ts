import { create } from 'zustand';
// CENTRAL-C2 — mehrphasige Geschäftsschreibvorgaenge laufen in derselben Spur wie die
// Fernauftraege: ein Lesen vom zweiten Rechner darf keinen Zwischenzustand sehen.
import { runExclusive } from '@/core/bridge/command-scheduler';
import type { Document, DocumentClass, LinkedEntityType } from '@/core/models/types';
import { getDatabase, saveDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate, trackDelete } from '@/core/sync/track';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary, readsFromPrimary, fetchFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
// CENTRAL-UI-PARITY R6F — Hochladen und Texterkennung laufen durch EINE Hausfolge, am Primary wie
// fuer PC2 (`documents.upload`/`documents.set_ocr`). Kein eigenes SQL mehr fuer diese zwei.
import { runOnPrimary } from '@/core/data/primary-action';
import { localOfficeCtx, officeAction } from '@/core/office/office-rules';
// MEDIA-DOCUMENTS — die PDF eines Belegs lebt im Medienkern, nicht in seiner Zeile.
import { applyDocumentFile, documentFileRefsFor, documentMediaScope, resolveDocumentMedia } from '@/core/office/document-media';
import {
  assertDocumentsHere, setDocumentOcrInHouse, uploadDocumentInHouse,
  type DocumentOcrDone, type DocumentOcrInput, type DocumentUploadInput, type DocumentUploaded, type OcrEngine,
} from '@/core/office/document-house';

/** Extended document with DB-only display fields */
export interface DocumentRow extends Document {
  fileName: string;
  fileSize: number;
  /** R6F — die Fassung: wer die Texterkennung anstößt, nennt, welchen Stand er gesehen hat. */
  revision: number;
  /**
   * MEDIA-DOCUMENTS — die Datei als REFERENZ, wenn sie im Medienspeicher liegt (PDF): genug zum
   * Öffnen, nie Bytes. Für Belege des alten Weges bleibt sie leer und `filePath` trägt weiter
   * die Daten-URL.
   */
  file?: { mediaId: string; key: string; hash: string; extension: string; byteSize: number };
}

interface DocumentStore {
  documents: DocumentRow[];
  loading: boolean;
  loadDocuments: () => void;
  getDocumentsForEntity: (entityType: LinkedEntityType, entityId: string) => DocumentRow[];
  uploadDocument: (
    file: File,
    docClass: DocumentClass,
    linkedEntityType?: LinkedEntityType,
    linkedEntityId?: string,
  ) => Promise<DocumentRow>;
  deleteDocument: (id: string) => void;
  updateDocument: (id: string, data: Partial<Pick<Document, 'docClass' | 'linkedEntityType' | 'linkedEntityId'>>) => void;
  extractOcr: (id: string) => Promise<{ text: string; confidence: number }>;
  /**
   * Der Inhalt EINES Belegs, auf Abruf. Am Primary steht er längst in der Liste; auf einem
   * Rechner ohne Datenbank kommt er erst, wenn jemand den Beleg wirklich öffnet.
   */
  getContent: (id: string) => Promise<string | null>;
}

function rowToDocument(row: Record<string, unknown>): DocumentRow {
  return {
    id: row.id as string,
    fileName: row.file_name as string,
    filePath: row.file_path as string,
    fileType: row.file_type as string,
    fileSize: (row.file_size as number) || 0,
    docClass: (row.doc_class as DocumentClass) || 'other',
    linkedEntityType: row.linked_entity_type as LinkedEntityType | undefined,
    linkedEntityId: row.linked_entity_id as string | undefined,
    ocrText: row.ocr_text as string | undefined,
    ocrConfidence: row.ocr_confidence as number | undefined,
    ocrReviewed: Boolean(row.ocr_reviewed),
    extractedFields: row.extracted_fields ? JSON.parse(row.extracted_fields as string) : undefined,
    createdAt: row.created_at as string,
    revision: Number(row.revision ?? 0),
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** R6F — die Datei als Data-URL, so wie sie die Hausfolge erwartet (am Primary wie fuer PC2). */
export const readFileAsDataUrl = fileToBase64;

function documentById(id: string): DocumentRow {
  return rowToDocument(query('SELECT * FROM documents WHERE id = ?', [id])[0] ?? { id });
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  documents: [],
  loading: false,

  loadDocuments: () => {
    if (hydrateFromPrimary('store.documents.get', (d) => set(d as never))) return;
    try {
      set({ ...loadDocumentsFor(localReadContext()), loading: false });
    } catch {
      set({ documents: [], loading: false });
    }
  },

  getContent: async (id) => {
    // Am Primary trägt die Liste den Inhalt bereits — dann ist hier nichts zu holen.
    const local = get().documents.find((d) => d.id === id)?.filePath;
    if (local) return local;
    if (!readsFromPrimary()) return null;
    const d = await fetchFromPrimary('documents.content.get', { documentId: id });
    return typeof d?.content === 'string' && d.content ? d.content : null;
  },

  getDocumentsForEntity: (entityType, entityId) => {
    return get().documents.filter(
      d => d.linkedEntityType === entityType && d.linkedEntityId === entityId,
    );
  },

  // R6F — der alte Store-Aufruf ruft dieselbe Hausfolge wie die Maske: Typ und Größe aus dem
  // Inhalt, Verknüpfung in DIESER Filiale, Abgleich-Grenze geprüft. Weiterhin in der Spur.
  uploadDocument: (file, docClass, linkedEntityType, linkedEntityId) => runExclusive(async () => {
    const content = await fileToBase64(file);
    const r = await officeAction(assertDocumentsHere, (ctx) => uploadDocumentInHouse({
      fileName: file.name, content, docClass,
      linkedEntityType: linkedEntityType ?? null, linkedEntityId: linkedEntityId ?? null,
    }, ctx));
    await saveDatabaseDurably();
    get().loadDocuments();
    return documentById(r.documentId);
  }),

  deleteDocument: (id) => {
    const db = getDatabase();
    // MEDIA-DOCUMENTS §8 — „Entfernen" legt die Verknüpfung STILL, es löscht keine Datei. Ob die
    // Bytes je verschwinden, entscheidet später die Medien-Aufräumung — und nur, wenn niemand sonst
    // sie noch braucht. Zuerst die Verknüpfung, dann die Zeile: eine Verknüpfung auf einen Beleg,
    // den es nicht mehr gibt, wäre für immer erreichbar und nie mehr lesbar.
    try { applyDocumentFile(id, [], { bumpOwner: false }); } catch { /* kein Medienkern, keine Verknüpfung */ }
    db.run('DELETE FROM documents WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('documents', id);
    get().loadDocuments();
  },

  // R6F — vorher: Dokument aus der Bildschirmliste, Ergebnis `WHERE id = ?` ohne Filiale, ohne
  // Fassung und OHNE Abgleich-Eintrag. Jetzt dieselbe Hausfolge wie `documents.set_ocr`.
  extractOcr: (id) => runExclusive(async () => {
    const r = await officeAction(assertDocumentsHere, (ctx) => setDocumentOcrInHouse({ documentId: id }, ctx));
    await saveDatabaseDurably();
    get().loadDocuments();
    return { text: r.text, confidence: r.confidence };
  }),

  updateDocument: (id, data) => {
    const db = getDatabase();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.docClass !== undefined) {
      fields.push('doc_class = ?');
      values.push(data.docClass);
    }
    if (data.linkedEntityType !== undefined) {
      fields.push('linked_entity_type = ?');
      values.push(data.linkedEntityType || null);
    }
    if (data.linkedEntityId !== undefined) {
      fields.push('linked_entity_id = ?');
      values.push(data.linkedEntityId || null);
    }

    if (fields.length === 0) return;
    values.push(id);

    db.run(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('documents', id, data);
    get().loadDocuments();
  },
}));

// ── CENTRAL-UI-PARITY R6F — die Anschlüsse der Maske am Primary ─────────────
//
// Exklusiv, in EINER Transaktion, danach durabel (`runOnPrimary`) — dieselbe Klammer, die ein
// Fernauftrag von der Maschine bekommt. Ohne Geschäftsdatenbank verweigern sie, BEVOR eine
// Transaktion beginnt.

function reloadDocuments(): void {
  useDocumentStore.getState().loadDocuments();
}

/** „Upload" am Primary. */
export async function uploadDocumentOnPrimary(input: Record<string, unknown>): Promise<DocumentUploaded> {
  assertDocumentsHere();
  // MEDIA-DOCUMENTS — dieselbe Auflösung wie beim Fernbefehl, dieselbe Stelle: die abgelegte Datei
  // wird nachgewiesen und als Medienobjekt angemeldet, BEVOR die Geschäftsklammer aufgeht.
  const resolved = await resolveDocumentMedia(input, documentMediaScope());
  return runOnPrimary(() => uploadDocumentInHouse(resolved as unknown as DocumentUploadInput, localOfficeCtx()), reloadDocuments);
}

/** „Extract Text (OCR)" am Primary — die Erkennung läuft auf dem gespeicherten Inhalt, im Haus. */
export function extractOcrOnPrimary(input: Record<string, unknown>, engine?: OcrEngine): Promise<DocumentOcrDone> {
  try { assertDocumentsHere(); } catch (e) { return Promise.reject(e); }
  return runOnPrimary(() => setDocumentOcrInHouse(input as unknown as DocumentOcrInput, localOfficeCtx(), engine), reloadDocuments);
}

/**
 * CENTRAL-UI-PARITY R2B — die Belege einer Filiale, zustandsfrei.
 *
 * `file_path` traegt in dieser Tabelle nicht einen Pfad, sondern den GESAMTEN Dateiinhalt als
 * Data-URL. Ueber das Netz waere das je Liste zweistellig viele Megabyte. Deshalb kann der Inhalt
 * abgewaehlt werden: der Primary liest wie bisher alles, die Fernauskunft schickt die Liste ohne
 * Inhalt. Die Liste selbst zeigt dann ihr Symbol statt der Vorschau — sie prueft `filePath`
 * ohnehin schon.
 */
/**
 * CENTRAL-UI-PARITY R2C — der Inhalt genau EINES Belegs.
 *
 * Drei Dinge sind hier absichtlich eng: die Kennung muss genannt werden, die Filiale kommt aus
 * dem Ausweis (ein fremder Beleg ist schlicht nicht da), und zurück geht nur, was wirklich
 * Inhalt IST. In alten Beständen kann in `file_path` noch ein echter Dateipfad stehen — der
 * gehört niemandem über das Netz gezeigt, also kommt in dem Fall nichts.
 */
export function documentContentFor(
  ctx: BusinessReadContext,
  documentId: string,
): { id: string; fileName: string; fileType: string; content: string } | null {
  const rows = query(
    'SELECT id, file_name, file_type, file_path FROM documents WHERE id = ? AND branch_id = ?',
    [documentId, ctx.branchId]
  );
  const r = rows[0];
  if (!r) return null;
  const stored = String(r.file_path ?? '');
  return {
    id: String(r.id),
    fileName: String(r.file_name ?? ''),
    fileType: String(r.file_type ?? ''),
    content: stored.startsWith('data:') ? stored : '',
  };
}

export function loadDocumentsFor(
  ctx: BusinessReadContext,
  opts?: { withContent?: boolean },
): { documents: DocumentRow[] } {
  const rows = query('SELECT * FROM documents WHERE branch_id = ? ORDER BY created_at DESC', [ctx.branchId]);
  const documents = rows.map(rowToDocument);
  if (opts?.withContent === false) for (const d of documents) d.filePath = '';
  // MEDIA-DOCUMENTS — die Dateien als Referenzen dazu, in EINER Abfrage. Die Mappe bleibt eine Liste.
  const refs = documentFileRefsFor(documents.map((d) => d.id), ctx.branchId);
  for (const d of documents) {
    const r = refs.get(d.id)?.[0];
    if (r) d.file = { mediaId: r.mediaId, key: r.main.storageKey, hash: r.main.hash, extension: r.main.extension, byteSize: r.main.byteSize };
  }
  return { documents };
}
