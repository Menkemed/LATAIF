import { create } from 'zustand';
// CENTRAL-C2 — mehrphasige Geschaeftsschreibvorgaenge laufen in derselben Spur wie die
// Fernauftraege: ein Lesen vom zweiten Rechner darf keinen Zwischenzustand sehen.
import { runExclusive } from '@/core/bridge/command-scheduler';
import { v4 as uuid } from 'uuid';
import type { Document, DocumentClass, LinkedEntityType } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary, readsFromPrimary, fetchFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';

/** Extended document with DB-only display fields */
export interface DocumentRow extends Document {
  fileName: string;
  fileSize: number;
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

  uploadDocument: (file, docClass, linkedEntityType, linkedEntityId) => runExclusive(async () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const dataUrl = await fileToBase64(file);

    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    const doc: DocumentRow = {
      id,
      fileName: file.name,
      filePath: dataUrl,
      fileType: file.type,
      fileSize: file.size,
      docClass,
      linkedEntityType,
      linkedEntityId,
      ocrReviewed: false,
      createdAt: now,
    };

    db.run(
      `INSERT INTO documents (id, branch_id, file_name, file_path, file_type, file_size, doc_class,
        linked_entity_type, linked_entity_id, ocr_reviewed, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id, branchId, file.name, dataUrl, file.type, file.size, docClass,
        linkedEntityType || null, linkedEntityId || null, now,
        (() => { try { return currentUserId(); } catch { return null; } })(),
      ],
    );

    saveDatabase();
    trackInsert('documents', id, { fileName: file.name, docClass, linkedEntityType, linkedEntityId });
    get().loadDocuments();
    return doc;
  }),

  deleteDocument: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM documents WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('documents', id);
    get().loadDocuments();
  },

  extractOcr: (id) => runExclusive(async () => {
    const doc = get().documents.find(d => d.id === id);
    if (!doc || !doc.fileType?.startsWith('image/')) {
      return { text: '', confidence: 0 };
    }
    const { runOcr } = await import('@/core/ai/ocr-service');
    const result = await runOcr(doc.filePath);
    if (result.text) {
      const db = getDatabase();
      db.run(
        `UPDATE documents SET ocr_text = ?, ocr_confidence = ?, ocr_reviewed = 1 WHERE id = ?`,
        [result.text, result.confidence, id]
      );
      saveDatabase();
      get().loadDocuments();
    }
    return result;
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
  return { documents };
}
