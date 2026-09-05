// CENTRAL-C3C — das Kundenformular des zweiten Rechners: anlegen und ändern.
//
// Derselbe Bau wie das Rechnungsformular, mit drei Unterschieden, die alle aus derselben Frage
// kommen — was weiß dieser Rechner eigentlich?
//
//  1. **Er hat keine Datenbank.** Beim Ändern lädt er den Kunden über `customers.get`. Fällt der
//     Server aus, steht das da; es wird nichts Lokales gezeigt und nichts Lokales angelegt.
//  2. **Er schickt nur, was ein Mensch WIRKLICH geändert hat.** Ein Formular, das alle Felder
//     zurückschickt, überschreibt beim Speichern auch das, was jemand anderes in der Zwischenzeit
//     geändert hat — mit dem Stand, den dieser Rechner beim Laden gesehen hat. Genau daran ist im
//     Haus schon einmal der Kundenumsatz gestorben (M-01). Deshalb: ein Unterschied gegen den
//     geladenen Stand, sonst gar nichts.
//  3. **Er zeigt nur Felder, die er auch lesen kann.** `customers.get` liefert keine `preferences`,
//     keine Steuernummer und keine Ausweisnummer. Ein Eingabefeld dafür wäre eine Lüge: es stünde
//     leer da, und ein Speichern würde den echten Wert löschen.
//
// Und wie überall: eine Kennung pro VORSATZ. Kommt keine Antwort, bleibt derselbe Versuch offen;
// „Retry" fragt mit DERSELBEN Kennung nach, statt einen zweiten Kunden anzulegen.
//
// Die Doppelgänger-Warnung ist dieselbe wie im Haus (`findSimilarContacts`) und bleibt eine
// WARNUNG: sie sperrt nichts. Wer trotzdem anlegen will, darf das — die Entscheidung gehört dem
// Menschen, nicht dem Formular.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { remoteRead, type RemoteReadError } from '@/core/bridge/remote-read';
import { findSimilarContacts } from '@/core/contacts/duplicate-check';
import {
  CLIENT_CUSTOMER_FIELDS, CUSTOMER_NUMERIC, diffDraft, draftFrom, emptyDraft, type Draft as AnyDraft,
} from '@/core/bridge/client-masterdata-draft';

export const OP_CUSTOMERS_CREATE = 'customers.create';
export const OP_CUSTOMERS_UPDATE = 'customers.update';

/** Was der Primary zurückgibt. Die Kennung vergibt ER — der Client erfindet keine. */
export interface CustomerSaveValue {
  customerId: string;
  name: string;
  replayed?: boolean;
}

// Die Feldliste und die Unterschiedsbildung liegen in einem eigenen Modul: sie sind der
// eigentliche Vertrag dieses Formulars, und ein Vertrag, den man nur im Browser laden kann, ist
// nicht prüfbar.
type Field = typeof CLIENT_CUSTOMER_FIELDS[number];
type Draft = AnyDraft;

const EMPTY: Draft = emptyDraft(CLIENT_CUSTOMER_FIELDS);
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export { CLIENT_CUSTOMER_FIELDS };
export const draftFromRemote = (row: Record<string, unknown>): Draft => draftFrom(CLIENT_CUSTOMER_FIELDS, row);
export const changedFields = (base: Draft, now: Draft): Record<string, unknown> =>
  diffDraft(CLIENT_CUSTOMER_FIELDS, CUSTOMER_NUMERIC, base, now);

export interface ClientCustomerFormProps {
  /** Gesetzt = ändern, leer = anlegen. */
  customerId?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
  /** Nur für Tests: der Lesekanal. Voreingestellt ist der echte Fernlesevorgang. */
  read?: typeof remoteRead;
}

export function ClientCustomerForm({ customerId, onSaved, onCancel, read = remoteRead }: ClientCustomerFormProps) {
  const editing = typeof customerId === 'string' && customerId !== '';
  const [base, setBase] = useState<Draft>(EMPTY);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [others, setOthers] = useState<Array<Record<string, unknown>>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome<CustomerSaveValue> | null>(null);

  // EIN Wächter pro Formular, und sein Name steht fest: anlegen und ändern sind zwei Operationen,
  // und ein Versuch der einen darf nie als Versuch der anderen weiterlaufen.
  const controller = useMemo(
    () => new CommandSaveController<CustomerSaveValue>(editing ? OP_CUSTOMERS_UPDATE : OP_CUSTOMERS_CREATE),
    [editing],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Beim Ändern zuerst den echten Stand holen — ein leeres Formular würde beim Speichern
        // Felder als „geändert" ausweisen, die niemand angefasst hat.
        if (editing) {
          const row = await read<Record<string, unknown>>('customers.get', { id: customerId });
          if (cancelled) return;
          const d = draftFromRemote(row);
          setBase(d);
          setDraft(d);
        }
        // Die Doppelgänger-Warnung braucht die Nachbarn. Sie ist Beiwerk: schlägt sie fehl, ist das
        // kein Grund, das Formular zu verweigern.
        try {
          const list = await read<{ items: Array<Record<string, unknown>> }>('customers.list', {});
          if (!cancelled) setOthers(list.items ?? []);
        } catch { /* nur die Warnung fehlt */ }
        if (!cancelled) { setLoadError(null); setLoading(false); }
      } catch (e) {
        if (cancelled) return;
        // Kein stiller Rückfall auf irgendetwas Lokales.
        const err = e as RemoteReadError;
        setLoadError(err?.code ? `${err.code}: ${err.message}` : String(e));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editing, customerId, read]);

  const set = (f: Field, v: string): void => setDraft((prev) => ({ ...prev, [f]: v }));

  const changes = changedFields(base, draft);
  const hasName = draft.firstName.trim() !== '' || draft.lastName.trim() !== '';
  const complete = editing ? Object.keys(changes).length > 0 : hasName;

  // Dieselbe Warnung wie im Haus, mit demselben Helfer — und ohne Sperre.
  const similar = !editing && hasName
    ? findSimilarContacts(
      // Genau die Felder, die der Vergleich im Haus auch liest — Telefon, WhatsApp, Name.
      {
        firstName: draft.firstName, lastName: draft.lastName,
        phone: draft.phone, whatsapp: draft.whatsapp, company: draft.company,
      },
      others as never,
      { excludeId: customerId },
    )
    : [];

  const pending = outcome?.kind === 'unknown';
  const done = outcome?.kind === 'ok';

  const send = useCallback(async () => {
    setBusy(true);
    try {
      // Der Wächter gibt bei einem offenen Versuch DENSELBEN zurück — deshalb steht hier kein
      // `new CommandSaveAttempt()`, und deshalb kann ein zweiter Klick keinen zweiten Kunden anlegen.
      const attempt = controller.beginAttempt();
      const body = editing ? { id: customerId, ...changes } : changedFields(EMPTY, draft);
      setOutcome(await attempt.send(body));
    } finally {
      setBusy(false);
    }
  }, [controller, editing, customerId, changes, draft]);

  function startOver(): void {
    controller.forget();
    setOutcome(null);
    if (!editing) setDraft(EMPTY);
  }

  if (loading) return <div data-client-customer-loading style={box}>Loading…</div>;

  if (done && outcome.kind === 'ok') {
    return (
      <div data-client-customer-done style={box}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{editing ? 'Client updated' : 'Client created'}</div>
        <div data-client-customer-name style={{ marginTop: 6 }}>{outcome.value.name}</div>
        <div style={{ opacity: 0.7, marginTop: 4, fontFamily: 'monospace', fontSize: 12 }}>
          {outcome.value.customerId}
        </div>
        {outcome.replayed && (
          <div data-client-customer-replayed style={{ marginTop: 8, opacity: 0.8 }}>
            This was the answer to the attempt that had already run — nothing was written twice.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button data-client-customer-again onClick={() => {
            const id = outcome.value.customerId;
            startOver();
            onSaved?.(id);
          }} style={btn(true)}>{editing ? 'Back' : 'New client'}</button>
        </div>
      </div>
    );
  }

  return (
    <div data-client-customer-form style={box}>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        {editing ? 'Edit client' : 'New client'}
      </div>
      {loadError && <div data-client-customer-loaderror style={warn}>Cannot reach the server: {loadError}</div>}

      <Row>
        <Text f="firstName" label="First name" draft={draft} set={set} disabled={pending} />
        <Text f="lastName" label="Last name" draft={draft} set={set} disabled={pending} />
      </Row>
      <Row>
        <Text f="company" label="Company" draft={draft} set={set} disabled={pending} />
        <Text f="email" label="E-mail" draft={draft} set={set} disabled={pending} />
      </Row>
      <Row>
        <Text f="phone" label="Phone" draft={draft} set={set} disabled={pending} />
        <Text f="whatsapp" label="WhatsApp" draft={draft} set={set} disabled={pending} />
      </Row>
      <Row>
        <Text f="country" label="Country" draft={draft} set={set} disabled={pending} />
        <Text f="language" label="Language" draft={draft} set={set} disabled={pending} />
      </Row>
      <Row>
        <Text f="budgetMin" label="Budget from" draft={draft} set={set} disabled={pending} numeric />
        <Text f="budgetMax" label="Budget to" draft={draft} set={set} disabled={pending} numeric />
      </Row>
      <Row>
        <Pick f="vipLevel" label="VIP" draft={draft} set={set} disabled={pending}
          options={[['', '—'], ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3']]} />
        <Pick f="customerType" label="Type" draft={draft} set={set} disabled={pending}
          options={[['', '—'], ['RETAIL', 'Retail'], ['CONSIGNMENT', 'Consignment'],
            ['LOAN_CONTACT', 'Loan contact'], ['PARTNER', 'Partner']]} />
        <Pick f="salesStage" label="Stage" draft={draft} set={set} disabled={pending}
          options={[['', '—'], ['lead', 'Lead'], ['qualified', 'Qualified'], ['active', 'Active'],
            ['dormant', 'Dormant'], ['lost', 'Lost']]} />
      </Row>
      <label style={{ ...label, marginTop: 8 }}>Note</label>
      <input data-client-customer-notes value={draft.notes} disabled={pending}
        onChange={(e) => set('notes', e.target.value)} style={field} />

      {similar.length > 0 && (
        <div data-client-customer-duplicate style={warn}>
          {similar.length} similar {similar.length === 1 ? 'client' : 'clients'} already exist
          {' — '}
          {similar.slice(0, 3).map((m) => `${text(m.contact.firstName)} ${text(m.contact.lastName)}`.trim()).join(', ')}.
          {' '}You can still create this one.
        </div>
      )}

      {editing && (
        <div data-client-customer-changes style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          {Object.keys(changes).length === 0
            ? 'Nothing changed yet — only what you edit is sent.'
            : `Sending only: ${Object.keys(changes).join(', ')}`}
        </div>
      )}

      {pending && (
        <div data-client-customer-pending style={warn}>
          The outcome of this save is not known — the client may already exist. Retrying checks the
          same attempt instead of writing a second one.
        </div>
      )}
      {outcome?.kind === 'business_error' && (
        <div data-client-customer-rejected style={warn}>{outcome.code}: {outcome.message}</div>
      )}
      {outcome?.kind === 'not_executed' && (
        <div data-client-customer-notexecuted style={warn}>
          Not executed ({outcome.code}) — safe to send again.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button data-client-customer-save disabled={busy || !complete || outcome?.kind === 'business_error'}
          onClick={send} style={btn(true)}>
          {pending ? 'Retry the same attempt' : busy ? 'Saving…' : 'Save'}
        </button>
        {outcome?.kind === 'business_error' && (
          <button data-client-customer-restart onClick={startOver} style={btn(false)}>Start a new attempt</button>
        )}
        {onCancel && !pending && (
          <button data-client-customer-cancel onClick={onCancel} style={btn(false)}>Cancel</button>
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
      <input data-client-customer-field={f} value={draft[f]} disabled={disabled}
        type={numeric ? 'number' : 'text'} min={numeric ? 0 : undefined}
        onChange={(e) => set(f, e.target.value)} style={field} />
    </div>
  );
}

function Pick({ f, label: l, draft, set, disabled, options }: CellProps & { options: Array<[string, string]> }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={label}>{l}</label>
      <select data-client-customer-field={f} value={draft[f]} disabled={disabled}
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
