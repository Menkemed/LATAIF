// CENTRAL-C3C — das Artikelformular des zweiten Rechners: anlegen (mit Fotos) und ändern.
//
// Es hat zwei Eigenheiten, die man ihm ansehen soll, weil sie den Unterschied zum Primary-Formular
// ausmachen:
//
//  1. **Es zeigt keine SKU-Vorschau.** Das große Formular am Primary darf eine vorschlagen; hier
//     wäre sie eine Lüge. Die Nummer entsteht erst, wenn der Primary den Auftrag ausführt, aus
//     seinem durablen Zähler — sonst bekämen zwei Rechner, die gleichzeitig anlegen, dieselbe.
//     Deshalb steht hier: „die Nummer vergibt der Primary", und danach steht sie da.
//  2. **Bilder gehen VOR dem Speichern weg.** Jedes gewählte Foto wandert sofort in die neutrale
//     Zwischenablage und ist danach nur noch eine Kennung. Der Speichern-Knopf schickt eine
//     Nachricht, keine Bytes — und eine Wiederholung schickt dieselbe Nachricht.
//
// Beim Ändern gilt dieselbe Regel wie beim Kunden: nur der Unterschied wird geschickt. Und die
// Galerie wird hier NICHT geändert — das Ändern von Bildern hat am Primary einen eigenen,
// mehrstufigen Weg (Plan, Batch, Wiederaufnahme), und den von außen halb nachzubauen wäre genau
// der zweite Medienweg, den dieses ganze Kapitel vermeidet.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import { stageImage, StagingUploadError, ACCEPTED_IMAGE_TYPES } from '@/core/bridge/client-staging-upload';
import {
  CLIENT_PRODUCT_FIELDS, PRODUCT_NUMERIC, diffDraft, draftFrom, emptyDraft, type Draft as AnyDraft,
} from '@/core/bridge/client-masterdata-draft';

export const OP_PRODUCTS_CREATE = 'products.create';
export const OP_PRODUCTS_UPDATE = 'products.update';

export interface ProductSaveValue {
  productId: string;
  sku: string;
  name: string;
  imageCount: number;
  replayed?: boolean;
}

// Feldliste und Unterschiedsbildung liegen im gemeinsamen Modul — derselbe Vertrag wie beim
// Kundenformular, und aus demselben Grund prüfbar ohne Browser.
type Field = typeof CLIENT_PRODUCT_FIELDS[number];
type Draft = AnyDraft;

const EMPTY: Draft = emptyDraft(CLIENT_PRODUCT_FIELDS);
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export { CLIENT_PRODUCT_FIELDS };
export const draftFromRemote = (row: Record<string, unknown>): Draft => draftFrom(CLIENT_PRODUCT_FIELDS, row);
export const changedFields = (base: Draft, now: Draft): Record<string, unknown> =>
  diffDraft(CLIENT_PRODUCT_FIELDS, PRODUCT_NUMERIC, base, now);

interface Staged {
  stagingId: string;
  label: string;
}

export interface ClientProductFormProps {
  productId?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
  read?: typeof remoteRead;
  upload?: typeof stageImage;
}

export function ClientProductForm({
  productId, onSaved, onCancel, read = remoteRead, upload = stageImage,
}: ClientProductFormProps) {
  const editing = typeof productId === 'string' && productId !== '';
  const [base, setBase] = useState<Draft>(EMPTY);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome<ProductSaveValue> | null>(null);

  const controller = useMemo(
    () => new CommandSaveController<ProductSaveValue>(editing ? OP_PRODUCTS_UPDATE : OP_PRODUCTS_CREATE),
    [editing],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (editing) {
          const row = await read<Record<string, unknown>>('products.get', { id: productId });
          if (cancelled) return;
          const d = draftFromRemote(row);
          setBase(d);
          setDraft(d);
          setCategoryId(text(row.categoryId));
        } else {
          // Der Client kennt nur die Kategorien, die in der Sammlung VORKOMMEN: einen eigenen
          // Lesebefehl dafür gibt es nicht, und einen zu erfinden, nur damit dieses Formular
          // hübscher wird, wäre eine Erweiterung der Angriffsfläche für nichts.
          const list = await read<{ items: Array<Record<string, unknown>> }>('products.list', {});
          if (cancelled) return;
          const seen = [...new Set(list.items.map((i) => text(i.categoryId)).filter((s) => s !== ''))].sort();
          setCategories(seen);
          setCategoryId(seen[0] ?? '');
        }
        if (!cancelled) { setLoadError(null); setLoading(false); }
      } catch (e) {
        if (cancelled) return;
        const err = e as RemoteReadError;
        setLoadError(err?.code ? `${err.code}: ${err.message}` : String(e));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editing, productId, read]);

  const set = (f: Field, v: string): void => setDraft((prev) => ({ ...prev, [f]: v }));

  const changes = changedFields(base, draft);
  const complete = editing
    ? Object.keys(changes).length > 0
    : draft.name.trim() !== '' && categoryId !== '';

  const pending = outcome?.kind === 'unknown';
  const done = outcome?.kind === 'ok';

  /** Ein gewähltes Foto geht SOFORT weg — danach ist es nur noch eine Kennung. */
  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setImageError(null);
    try {
      for (const file of Array.from(files)) {
        try {
          const s = await upload(file);
          setStaged((prev) => (prev.some((x) => x.stagingId === s.stagingId)
            // Derselbe Inhalt ergibt dieselbe Kennung — zweimal dasselbe Bild ist EIN Bild.
            ? prev
            : [...prev, { stagingId: s.stagingId, label: `${file.name} · ${s.width}×${s.height}` }]));
        } catch (e) {
          const err = e as StagingUploadError;
          setImageError(err?.code ? `${file.name}: ${err.code}` : String(e));
        }
      }
    } finally {
      setUploading(false);
    }
  }, [upload]);

  const send = useCallback(async () => {
    setBusy(true);
    try {
      const attempt = controller.beginAttempt();
      const body = editing
        ? { id: productId, ...changes }
        // Kein `sku`, keine `images`, keine `branchId`: was der Primary entscheidet, steht hier
        // nicht drin — und er würde es abweisen, stünde es doch drin.
        : { categoryId, ...changedFields(EMPTY, draft), stagingIds: staged.map((s) => s.stagingId) };
      setOutcome(await attempt.send(body));
    } finally {
      setBusy(false);
    }
  }, [controller, editing, productId, changes, categoryId, draft, staged]);

  function startOver(): void {
    controller.forget();
    setOutcome(null);
    if (!editing) { setDraft(EMPTY); setStaged([]); }
  }

  if (loading) return <div data-client-product-loading style={box}>Loading…</div>;

  if (done && outcome.kind === 'ok') {
    return (
      <div data-client-product-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{editing ? 'Item updated' : 'Item created'}</div>
        <div data-client-product-name style={{ marginTop: 6 }}>{outcome.value.name}</div>
        {/* Die Nummer kommt vom Primary. Der Client hat sie nicht vorgeschlagen und rechnet sie nicht nach. */}
        <div data-client-product-sku style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 16 }}>
          {outcome.value.sku}
        </div>
        <div style={{ opacity: 0.7, marginTop: 4, fontSize: 12 }}>
          {outcome.value.imageCount} image{outcome.value.imageCount === 1 ? '' : 's'} · {outcome.value.productId}
        </div>
        {outcome.replayed && (
          <div data-client-product-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing was written twice.
          </div>
        )}
        <button data-client-product-again onClick={() => {
          const id = outcome.value.productId;
          startOver();
          onSaved?.(id);
        }} style={btn(true)}>{editing ? 'Back' : 'New item'}</button>
      </div>
    );
  }

  return (
    <div data-client-product-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        {editing ? 'Edit item' : 'New item'}
      </div>
      {loadError && <div data-client-product-loaderror style={warn}>Cannot reach the server: {loadError}</div>}

      {!editing && (
        <>
          <label style={label}>Category</label>
          <select data-client-product-category value={categoryId} disabled={pending}
            onChange={(e) => setCategoryId(e.target.value)} style={field}>
            {categories.length === 0 && <option value="">— no category found —</option>}
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </>
      )}

      <Row>
        <Text f="brand" label="Brand" draft={draft} set={set} disabled={pending} />
        <Text f="name" label="Name" draft={draft} set={set} disabled={pending} />
      </Row>
      <Row>
        <Text f="condition" label="Condition" draft={draft} set={set} disabled={pending} />
        <Text f="storageLocation" label="Location" draft={draft} set={set} disabled={pending} />
      </Row>
      <Row>
        <Text f="purchasePrice" label="Cost" draft={draft} set={set} disabled={pending} numeric />
        <Text f="plannedSalePrice" label="Price" draft={draft} set={set} disabled={pending} numeric />
      </Row>
      <Row>
        <Pick f="stockStatus" label="Stock" draft={draft} set={set} disabled={pending}
          options={[['', '—'], ['in_stock', 'In stock'], ['reserved', 'Reserved'], ['sold', 'Sold']]} />
        <Pick f="taxScheme" label="Tax" draft={draft} set={set} disabled={pending}
          options={[['', '—'], ['MARGIN', 'Margin'], ['STANDARD', 'Standard']]} />
        <Pick f="sourceType" label="Source" draft={draft} set={set} disabled={pending}
          options={[['', '—'], ['OWN', 'Own'], ['CONSIGNMENT', 'Consignment']]} />
      </Row>
      <label style={{ ...label, marginTop: 8 }}>Note</label>
      <input data-client-product-notes value={draft.notes} disabled={pending}
        onChange={(e) => set('notes', e.target.value)} style={field} />

      {!editing && (
        <div style={{ marginTop: 12 }}>
          <label style={label}>Photos</label>
          <input data-client-product-images type="file" multiple accept={ACCEPTED_IMAGE_TYPES.join(',')}
            disabled={pending || uploading}
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          {uploading && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>Uploading…</span>}
          {staged.length > 0 && (
            <ul data-client-product-staged style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {staged.map((s) => (
                <li key={s.stagingId}>
                  {s.label}
                  {' '}
                  <button data-client-product-drop style={{ ...btn(false), marginTop: 0, padding: '0 6px' }}
                    onClick={() => setStaged((prev) => prev.filter((x) => x.stagingId !== s.stagingId))}>
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {imageError && <div data-client-product-imageerror style={warn}>{imageError}</div>}
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6 }}>
            The primary assigns the item number when it saves — there is no preview here on purpose.
          </div>
        </div>
      )}

      {editing && (
        <div data-client-product-changes style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {Object.keys(changes).length === 0
            ? 'Nothing changed yet — only what you edit is sent. Photos are edited on the primary.'
            : `Sending only: ${Object.keys(changes).join(', ')}`}
        </div>
      )}

      {pending && (
        <div data-client-product-pending style={warn}>
          The outcome of this save is not known — the item may already exist. Retrying checks the
          same attempt instead of creating a second one.
        </div>
      )}
      {outcome?.kind === 'business_error' && (
        <div data-client-product-rejected style={warn}>{outcome.code}: {outcome.message}</div>
      )}
      {outcome?.kind === 'not_executed' && (
        <div data-client-product-notexecuted style={warn}>
          Not executed ({outcome.code}) — safe to send again.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-product-save disabled={busy || uploading || !complete || outcome?.kind === 'business_error'}
          onClick={send} style={btn(true)}>
          {pending ? 'Retry the same attempt' : busy ? 'Saving…' : 'Save'}
        </button>
        {outcome?.kind === 'business_error' && (
          <button data-client-product-restart onClick={startOver} style={btn(false)}>Start a new attempt</button>
        )}
        {onCancel && !pending && (
          <button data-client-product-cancel onClick={onCancel} style={btn(false)}>Cancel</button>
        )}
      </div>
    </div>
  );
}

// ── Anzeige ───────────────────────────────────────────────────────────────

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>{children}</div>;
}

interface CellProps {
  f: Field;
  label: string;
  draft: Draft;
  set: (f: Field, v: string) => void;
  disabled: boolean;
}

function Text({ f, label: l, draft, set, disabled, numeric }: CellProps & { numeric?: boolean }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={label}>{l}</label>
      <input data-client-product-field={f} value={draft[f]} disabled={disabled}
        type={numeric ? 'number' : 'text'} min={numeric ? 0 : undefined} step={numeric ? '0.001' : undefined}
        onChange={(e) => set(f, e.target.value)} style={field} />
    </div>
  );
}

function Pick({ f, label: l, draft, set, disabled, options }: CellProps & { options: Array<[string, string]> }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={label}>{l}</label>
      <select data-client-product-field={f} value={draft[f]} disabled={disabled}
        onChange={(e) => set(f, e.target.value)} style={field}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </div>
  );
}

const box: React.CSSProperties = { padding: 16, maxWidth: 760 };
const label: React.CSSProperties = { display: 'block', fontSize: 12, opacity: 0.7, marginBottom: 4 };
const field: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,0.4)',
  background: 'transparent', color: 'inherit',
};
const warn: React.CSSProperties = {
  marginTop: 12, padding: '8px 10px', borderRadius: 6,
  border: '1px solid rgba(200,150,0,0.5)', background: 'rgba(200,150,0,0.08)',
};
function btn(primary: boolean): React.CSSProperties {
  return {
    marginTop: 8, padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)',
    background: primary ? 'rgba(90,140,255,0.18)' : 'transparent', color: 'inherit',
  };
}
