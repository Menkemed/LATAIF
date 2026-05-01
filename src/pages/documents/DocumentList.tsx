import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Image, File, Trash2, Upload, Grid, List } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useDocumentStore, type DocumentRow } from '@/stores/documentStore';
import type { DocumentClass, LinkedEntityType } from '@/core/models/types';

const DOC_CLASSES: DocumentClass[] = ['invoice', 'receipt', 'certificate', 'warranty', 'photo', 'note', 'other'];
const ENTITY_TYPES: LinkedEntityType[] = ['customer', 'product', 'offer', 'invoice', 'repair', 'consignment', 'agent_transfer', 'order'];

const classColors: Record<DocumentClass, string> = {
  invoice: '#AA956E',
  receipt: '#7EAA6E',
  certificate: '#6E8AAA',
  warranty: '#0F0F10',
  photo: '#8A6EAA',
  note: '#6B7280',
  other: '#6B7280',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function isImage(fileType: string): boolean {
  return fileType.startsWith('image/');
}

function DocIcon({ fileType }: { fileType: string }) {
  if (isImage(fileType)) return <Image size={20} strokeWidth={1.5} style={{ color: '#8A6EAA' }} />;
  if (fileType === 'application/pdf') return <FileText size={20} strokeWidth={1.5} style={{ color: '#AA6E6E' }} />;
  return <File size={20} strokeWidth={1.5} style={{ color: '#6B7280' }} />;
}

export function DocumentList() {
  const { documents, loadDocuments, uploadDocument, deleteDocument, extractOcr } = useDocumentStore();
  const [filterClass, setFilterClass] = useState<DocumentClass | ''>('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showUpload, setShowUpload] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrError, setOcrError] = useState('');
  const [showPreview, setShowPreview] = useState<DocumentRow | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Upload form state
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadClass, setUploadClass] = useState<DocumentClass>('other');
  const [uploadEntityType, setUploadEntityType] = useState<LinkedEntityType | ''>('');
  const [uploadEntityId, setUploadEntityId] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  const filtered = useMemo(() => {
    if (!filterClass) return documents;
    return documents.filter(d => d.docClass === filterClass);
  }, [documents, filterClass]);

  async function handleUpload() {
    if (!uploadFile) return;
    setUploading(true);
    try {
      await uploadDocument(
        uploadFile,
        uploadClass,
        uploadEntityType || undefined,
        uploadEntityId || undefined,
      );
      setShowUpload(false);
      resetUploadForm();
    } finally {
      setUploading(false);
    }
  }

  function resetUploadForm() {
    setUploadFile(null);
    setUploadClass('other');
    setUploadEntityType('');
    setUploadEntityId('');
  }

  function handleDelete(id: string) {
    deleteDocument(id);
    setShowDeleteConfirm(null);
  }

  const entityTypeOptions = ENTITY_TYPES.map(t => ({
    id: t,
    label: t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  }));

  return (
    <PageLayout
      title="Documents"
      subtitle={`${documents.length} documents`}
      actions={
        <div className="flex gap-2 items-center">
          {/* Filter pills */}
          <div className="flex gap-1" style={{ marginRight: 8 }}>
            {(['', ...DOC_CLASSES] as (DocumentClass | '')[]).map(c => (
              <button
                key={c}
                onClick={() => setFilterClass(c)}
                className="cursor-pointer"
                style={{
                  padding: '5px 10px', fontSize: 11, borderRadius: 999, border: 'none',
                  background: filterClass === c ? 'rgba(15,15,16,0.08)' : 'transparent',
                  color: filterClass === c ? '#0F0F10' : '#6B7280',
                }}
              >
                {c ? c.replace(/\b\w/g, l => l.toUpperCase()) : 'All'}
              </button>
            ))}
          </div>
          {/* View toggle */}
          <button
            onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
            className="cursor-pointer"
            style={{ padding: 6, background: 'none', border: '1px solid #D5D9DE', borderRadius: 6, color: '#6B7280' }}
          >
            {viewMode === 'grid' ? <List size={16} /> : <Grid size={16} />}
          </button>
          <Button variant="primary" icon={<Upload size={15} />} onClick={() => { setShowUpload(true); resetUploadForm(); }}>
            Upload
          </Button>
        </div>
      }
    >
      {/* Document Grid / List */}
      {filtered.length === 0 ? (
        <div className="text-center" style={{ padding: '80px 0', color: '#6B7280' }}>
          <File size={48} strokeWidth={1} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
          <p style={{ fontSize: 14 }}>No documents found</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
          {filtered.map(doc => (
            <Card key={doc.id} hoverable onClick={() => setShowPreview(doc)}>
              {/* Thumbnail / Icon area */}
              <div
                className="flex items-center justify-center rounded-md"
                style={{ height: 120, background: '#F2F7FA', marginBottom: 12, overflow: 'hidden' }}
              >
                {isImage(doc.fileType) && doc.filePath ? (
                  <img
                    src={doc.filePath}
                    alt={doc.fileName}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <DocIcon fileType={doc.fileType} />
                )}
              </div>
              {/* Info */}
              <div style={{ fontSize: 13, color: '#0F0F10', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {doc.fileName}
              </div>
              <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
                <span
                  style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 999,
                    background: `${classColors[doc.docClass]}15`,
                    color: classColors[doc.docClass],
                    textTransform: 'capitalize',
                  }}
                >
                  {doc.docClass}
                </span>
                <span style={{ fontSize: 11, color: '#6B7280' }}>{formatBytes(doc.fileSize)}</span>
              </div>
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                {formatDate(doc.createdAt)}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        /* List view */
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto', gap: 12, padding: '0 12px 10px' }}>
            {['FILE NAME', 'TYPE', 'CLASS', 'SIZE', 'DATE', ''].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          {filtered.map(doc => (
            <div
              key={doc.id}
              className="transition-all duration-200 rounded-md cursor-pointer"
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto', gap: 12, padding: '14px 12px', borderBottom: '1px solid #E5E9EE' }}
              onClick={() => setShowPreview(doc)}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(198,163,109,0.02)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div className="flex items-center gap-3">
                <DocIcon fileType={doc.fileType} />
                <span style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {doc.fileName}
                </span>
              </div>
              <span style={{ fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center' }}>
                {doc.fileType.split('/')[1]?.toUpperCase() || doc.fileType}
              </span>
              <span style={{ display: 'flex', alignItems: 'center' }}>
                <span
                  style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 999,
                    background: `${classColors[doc.docClass]}15`,
                    color: classColors[doc.docClass],
                    textTransform: 'capitalize',
                  }}
                >
                  {doc.docClass}
                </span>
              </span>
              <span style={{ fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center' }}>
                {formatBytes(doc.fileSize)}
              </span>
              <span style={{ fontSize: 12, color: '#6B7280', display: 'flex', alignItems: 'center' }}>
                {formatDate(doc.createdAt)}
              </span>
              <button
                onClick={e => { e.stopPropagation(); setShowDeleteConfirm(doc.id); }}
                className="cursor-pointer transition-colors"
                style={{ background: 'none', border: 'none', color: '#6B7280', padding: 4 }}
                onMouseEnter={e => (e.currentTarget.style.color = '#AA6E6E')}
                onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload Modal */}
      <Modal open={showUpload} onClose={() => setShowUpload(false)} title="Upload Document">
        <div className="space-y-5">
          {/* File picker */}
          <div>
            <label style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>File</label>
            <input
              ref={fileInputRef}
              type="file"
              onChange={e => setUploadFile(e.target.files?.[0] || null)}
              style={{ display: 'none' }}
            />
            <div
              className="flex items-center justify-center rounded-md cursor-pointer transition-colors"
              style={{
                height: 100, border: '1px dashed #D5D9DE', background: '#F2F7FA',
                color: uploadFile ? '#0F0F10' : '#6B7280', fontSize: 13,
              }}
              onClick={() => fileInputRef.current?.click()}
              onMouseEnter={e => (e.currentTarget.style.borderColor = '#0F0F10')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = '#D5D9DE')}
            >
              {uploadFile ? (
                <div className="text-center">
                  <p style={{ color: '#0F0F10' }}>{uploadFile.name}</p>
                  <p style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>{formatBytes(uploadFile.size)}</p>
                </div>
              ) : (
                <div className="text-center">
                  <Upload size={20} style={{ margin: '0 auto 8px' }} />
                  <p>Click to select a file</p>
                </div>
              )}
            </div>
          </div>

          {/* Doc class */}
          <div>
            <label style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>Document Class</label>
            <div className="flex flex-wrap gap-2">
              {DOC_CLASSES.map(c => (
                <button
                  key={c}
                  onClick={() => setUploadClass(c)}
                  className="cursor-pointer transition-all"
                  style={{
                    padding: '6px 14px', fontSize: 12, borderRadius: 6,
                    border: uploadClass === c ? `1px solid ${classColors[c]}` : '1px solid #D5D9DE',
                    background: uploadClass === c ? `${classColors[c]}10` : 'transparent',
                    color: uploadClass === c ? classColors[c] : '#6B7280',
                    textTransform: 'capitalize',
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Entity link */}
          <div>
            <label style={{ fontSize: 12, color: '#6B7280', display: 'block', marginBottom: 8 }}>Link to Entity (optional)</label>
            <div className="flex gap-3">
              <div style={{ flex: 1 }}>
                <SearchSelect
                  placeholder="Entity type..."
                  options={entityTypeOptions}
                  value={uploadEntityType}
                  onChange={v => { setUploadEntityType(v as LinkedEntityType); setUploadEntityId(''); }}
                />
              </div>
              {uploadEntityType && (
                <div style={{ flex: 1 }}>
                  <input
                    type="text"
                    placeholder="Entity ID"
                    value={uploadEntityId}
                    onChange={e => setUploadEntityId(e.target.value)}
                    className="w-full outline-none transition-colors"
                    style={{
                      background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8,
                      padding: '10px 14px', fontSize: 13, color: '#0F0F10',
                    }}
                    onFocus={e => (e.currentTarget.style.borderColor = '#D5D9DE')}
                    onBlur={e => (e.currentTarget.style.borderColor = '#E5E9EE')}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3" style={{ paddingTop: 8 }}>
            <Button variant="ghost" onClick={() => setShowUpload(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleUpload} disabled={!uploadFile || uploading}>
              {uploading ? 'Uploading...' : 'Upload'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Preview Modal */}
      <Modal open={!!showPreview} onClose={() => setShowPreview(null)} title={showPreview?.fileName || 'Preview'} width={720}>
        {showPreview && (
          <div>
            {/* Preview area */}
            <div
              className="flex items-center justify-center rounded-md"
              style={{ minHeight: 300, maxHeight: 500, background: '#F2F7FA', marginBottom: 16, overflow: 'hidden' }}
            >
              {isImage(showPreview.fileType) && showPreview.filePath ? (
                <img
                  src={showPreview.filePath}
                  alt={showPreview.fileName}
                  style={{ maxWidth: '100%', maxHeight: 500, objectFit: 'contain' }}
                />
              ) : showPreview.fileType === 'application/pdf' ? (
                <div className="text-center" style={{ padding: 40 }}>
                  <FileText size={48} strokeWidth={1} style={{ margin: '0 auto 16px', color: '#AA6E6E' }} />
                  <p style={{ fontSize: 14, color: '#6B7280' }}>PDF preview not available</p>
                  <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{showPreview.fileName}</p>
                </div>
              ) : (
                <div className="text-center" style={{ padding: 40 }}>
                  <File size={48} strokeWidth={1} style={{ margin: '0 auto 16px', color: '#6B7280' }} />
                  <p style={{ fontSize: 14, color: '#6B7280' }}>Preview not available</p>
                  <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{showPreview.fileName}</p>
                </div>
              )}
            </div>

            {/* Meta info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', fontSize: 13 }}>
              <div>
                <span style={{ color: '#6B7280' }}>Class: </span>
                <span style={{ color: classColors[showPreview.docClass], textTransform: 'capitalize' }}>{showPreview.docClass}</span>
              </div>
              <div>
                <span style={{ color: '#6B7280' }}>Size: </span>
                <span style={{ color: '#0F0F10' }}>{formatBytes(showPreview.fileSize)}</span>
              </div>
              <div>
                <span style={{ color: '#6B7280' }}>Type: </span>
                <span style={{ color: '#0F0F10' }}>{showPreview.fileType}</span>
              </div>
              <div>
                <span style={{ color: '#6B7280' }}>Uploaded: </span>
                <span style={{ color: '#0F0F10' }}>{formatDate(showPreview.createdAt)}</span>
              </div>
              {showPreview.linkedEntityType && (
                <div>
                  <span style={{ color: '#6B7280' }}>Linked to: </span>
                  <span style={{ color: '#0F0F10', textTransform: 'capitalize' }}>
                    {showPreview.linkedEntityType.replace(/_/g, ' ')}
                  </span>
                </div>
              )}
            </div>

            {/* OCR Section */}
            {showPreview.fileType?.startsWith('image/') && (
              <div style={{ marginTop: 20, padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                  <span className="text-overline">EXTRACTED TEXT {showPreview.ocrConfidence ? `(${Math.round(showPreview.ocrConfidence)}% confidence)` : ''}</span>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      setOcrRunning(true);
                      setOcrError('');
                      try {
                        const res = await extractOcr(showPreview.id);
                        if (!res.text) setOcrError('No text detected. Try a clearer photo.');
                        setShowPreview({ ...showPreview, ocrText: res.text, ocrConfidence: res.confidence, ocrReviewed: true });
                      } catch (e) {
                        setOcrError(String(e));
                      }
                      setOcrRunning(false);
                    }}
                    disabled={ocrRunning}
                  >{ocrRunning ? 'Extracting...' : showPreview.ocrText ? 'Re-run OCR' : 'Extract Text (OCR)'}</Button>
                </div>
                {showPreview.ocrText ? (
                  <pre style={{ fontSize: 12, color: '#4B5563', whiteSpace: 'pre-wrap', fontFamily: 'inherit', lineHeight: 1.6, maxHeight: 200, overflowY: 'auto', margin: 0 }}>
                    {showPreview.ocrText}
                  </pre>
                ) : (
                  <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>
                    Click "Extract Text" to run offline OCR (English + Arabic). First run downloads ~3 MB of language data.
                  </p>
                )}
                {ocrError && <p style={{ fontSize: 11, color: '#AA6E6E', marginTop: 6 }}>{ocrError}</p>}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="danger" onClick={() => { setShowDeleteConfirm(showPreview.id); setShowPreview(null); }}>
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setShowPreview(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!showDeleteConfirm} onClose={() => setShowDeleteConfirm(null)} title="Delete Document" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Are you sure you want to delete this document? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setShowDeleteConfirm(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => showDeleteConfirm && handleDelete(showDeleteConfirm)}>Delete</Button>
        </div>
      </Modal>
    </PageLayout>
  );
}
