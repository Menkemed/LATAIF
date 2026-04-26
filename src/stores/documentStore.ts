import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Document, DocumentClass, LinkedEntityType } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

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
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM documents WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      set({ documents: rows.map(rowToDocument), loading: false });
    } catch {
      set({ documents: [], loading: false });
    }
  },

  getDocumentsForEntity: (entityType, entityId) => {
    return get().documents.filter(
      d => d.linkedEntityType === entityType && d.linkedEntityId === entityId,
    );
  },

  uploadDocument: async (file, docClass, linkedEntityType, linkedEntityId) => {
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
  },

  deleteDocument: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM documents WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('documents', id);
    get().loadDocuments();
  },

  extractOcr: async (id) => {
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
  },

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
