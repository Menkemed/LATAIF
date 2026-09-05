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
// Beim Ändern gilt dieselbe Regel wie beim Kunden: nur der Unterschied wird geschickt.
//
// Die Galerie ist der dritte Punkt, und sie ist eine LISTE, kein Befehlssatz: das Formular schickt
// die gewünschte Reihenfolge, Platz für Platz — jeder Platz entweder ein behaltenes Bild oder ein
// neues aus der Zwischenablage. Was fehlt, geht; was dazukommt, kommt dazu; was sich verschiebt,
// verschiebt sich. Der Primary rechnet daraus seinen Plan und wendet ihn mit dem Text in EINER
// Transaktion an — genau der Weg, den auch sein eigenes Formular fährt.
//
// Und sie wird nur geschickt, wenn ein Mensch sie WIRKLICH angefasst hat: ein reiner Textsave
// lässt `gallery` weg, und dann liest der Primary die Medien nicht einmal (MEDIA-EDIT-PRESERVE —
// so ist im Haus schon einmal ein Handy-Foto gestorben).

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

/** Ein Platz in der Galerie: ein bestehendes Bild oder ein frisch abgelegtes. */
type Slot =
  | { kind: 'keep'; mediaId: string; key: string }
  | { kind: 'new'; stagingId: string; label: string };

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
  /** Die gewünschte Galerie in ihrer Reihenfolge. Beim Anlegen sind alle Plätze neu. */
  const [slots, setSlots] = useState<Slot[]>([]);
  /** Die Galerie, wie sie GELADEN wurde — nur so ist „angefasst?" beantwortbar. */
  const [baseSlots, setBaseSlots] = useState<Slot[]>([]);
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
          // Kennung UND Schlüssel kommen aus derselben Antwort in derselben Ordnung: die eine
          // benennt den Platz, der andere holt das Bild zum Anschauen.
          const ids = Array.isArray(row.mediaIds) ? (row.mediaIds as string[]) : [];
          const keys = Array.isArray(row.mediaKeys) ? (row.mediaKeys as string[]) : [];
          const loaded: Slot[] = ids.map((mediaId, i) => ({ kind: 'keep', mediaId, key: keys[i] ?? '' }));
          setSlots(loaded);
          setBaseSlots(loaded);
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
  /** Wurde die Galerie angefasst? Reihenfolge zählt — ein Verschieben IST eine Änderung. */
  const galleryTouched = editing
    && (slots.length !== baseSlots.length
      || slots.some((s, i) => {
        const b = baseSlots[i];
        return s.kind !== 'keep' || b === undefined || b.kind !== 'keep' || s.mediaId !== b.mediaId;
      }));
  const complete = editing
    ? Object.keys(changes).length > 0 || galleryTouched
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
          const up = await upload(file);
          setSlots((prev) => (prev.some((x) => x.kind === 'new' && x.stagingId === up.stagingId)
            // Derselbe Inhalt ergibt dieselbe Kennung — zweimal dasselbe Bild ist EIN Bild, und
            // der Primary würde einen doppelten Platz ohnehin abweisen.
            ? prev
            : [...prev, { kind: 'new', stagingId: up.stagingId, label: `${file.name} · ${up.width}×${up.height}` }]));
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
      const plan = slots.map((s) => (s.kind === 'keep' ? { keep: s.mediaId } : { stagingId: s.stagingId }));
      const body = editing
        // `gallery` NUR wenn wirklich angefasst: sonst bliebe die Galerie zwar gleich, würde aber
        // gelesen und neu geplant — und das ist ein anderer Weg mit anderen Fehlermöglichkeiten.
        ? { id: productId, ...changes, ...(galleryTouched ? { gallery: plan } : {}) }
        // Kein `sku`, keine `images`, keine `branchId`: was der Primary entscheidet, steht hier
        // nicht drin — und er würde es abweisen, stünde es doch drin.
        : { categoryId, ...changedFields(EMPTY, draft), stagingIds: slots.map((s) => (s.kind === 'new' ? s.stagingId : '')) };
      setOutcome(await attempt.send(body));
    } finally {
      setBusy(false);
    }
  }, [controller, editing, productId, changes, categoryId, draft, slots, galleryTouched]);

  function startOver(): void {
    controller.forget();
    setOutcome(null);
    if (!editing) { setDraft(EMPTY); setSlots([]); }
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

      <div style={{ marginTop: 12 }}>
        <label style={label}>Photos</label>
        <input data-client-product-images type="file" multiple accept={ACCEPTED_IMAGE_TYPES.join(',')}
          disabled={pending || uploading}
          onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
        {uploading && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>Uploading…</span>}
        {/* Die Reihenfolge IST die Aussage: Platz 0 ist das Hauptbild. */}
        {slots.length > 0 && (
          <ol data-client-product-staged style={{ margin: '8px 0 0', paddingLeft: 22, fontSize: 12 }}>
            {slots.map((slot, i) => (
              <li key={slot.kind === 'keep' ? slot.mediaId : slot.stagingId}
                data-client-product-slot={slot.kind === 'keep' ? slot.mediaId : slot.stagingId}>
                {slot.kind === 'keep' ? `saved photo ${i + 1}` : slot.label}
                {i === 0 && <span style={{ opacity: 0.6 }}> · main</span>}
                {' '}
                <button data-client-product-up disabled={pending || i === 0}
                  style={{ ...btn(false), marginTop: 0, padding: '0 6px' }}
                  onClick={() => setSlots((prev) => {
                    const next = [...prev];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    return next;
                  })}>
                  up
                </button>
                {' '}
                <button data-client-product-drop disabled={pending}
                  style={{ ...btn(false), marginTop: 0, padding: '0 6px' }}
                  onClick={() => setSlots((prev) => prev.filter((_, j) => j !== i))}>
                  remove
                </button>
              </li>
            ))}
          </ol>
        )}
        {imageError && <div data-client-product-imageerror style={warn}>{imageError}</div>}
        {!editing && (
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.6 }}>
            The primary assigns the item number when it saves — there is no preview here on purpose.
          </div>
        )}
      </div>

      {editing && (
        <div data-client-product-changes style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {Object.keys(changes).length === 0 && !galleryTouched
            ? 'Nothing changed yet — only what you edit is sent.'
            : `Sending only: ${[...Object.keys(changes), ...(galleryTouched ? ['gallery'] : [])].join(', ')}`}
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
