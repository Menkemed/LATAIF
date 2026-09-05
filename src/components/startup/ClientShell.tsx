// CENTRAL-C2/C3B — die Oberfläche des zweiten Rechners.
//
// Bewusst schmal: Anmeldung, drei Listen, drei Detailansichten — und seit C3B EIN Formular, das
// etwas anlegt: eine Rechnung. Genau eines, weil genau eine verändernde Fernoperation freigegeben
// ist (`ALLOWED_MUTATIONS`). Alles andere kann die Gegenstelle nach wie vor nicht annehmen.
//
// Auch das Formular legt hier nichts an: es schickt die Auswahl eines Menschen an den Primary und
// zeigt, was von dort zurückkommt. Gerechnet, nummeriert und gebucht wird dort.
//
// Und es gibt keinen stillen Rückfall. Ist der Server weg, steht das da. Es wird keine lokale
// Datenbank angelegt, um „wenigstens etwas" zu zeigen — das wäre eine zweite Wahrheit.

import { useCallback, useEffect, useState } from 'react';
import { clientConfig, leaveClientMode } from '@/core/bridge/client-mode';
import { remoteRead, clientLogin, RemoteReadError, ERR_UNAUTHENTICATED } from '@/core/bridge/remote-read';
import { ClientInvoiceCreate } from '@/components/client/ClientInvoiceCreate';

type Area = 'products' | 'customers' | 'invoices' | 'new-invoice';

interface ListState {
  items: Array<Record<string, unknown>>;
  stock?: { records: number; units: number; cost: number };
}

// `op` ist die Leseoperation des Bereichs. Das Rechnungsformular hat keine — es lädt seine
// Auswahllisten selbst über dieselben C2-Lesevorgänge und schickt beim Speichern einen Auftrag.
const AREAS: Array<{ key: Area; label: string; op: string | null }> = [
  { key: 'products', label: 'Collection', op: 'products.list' },
  { key: 'customers', label: 'Clients', op: 'customers.list' },
  { key: 'invoices', label: 'Invoices', op: 'invoices.list' },
  { key: 'new-invoice', label: 'New invoice', op: null },
];

const fmt = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function ClientShell() {
  const cfg = clientConfig();
  const [signedIn, setSignedIn] = useState(Boolean(cfg?.token));
  const [area, setArea] = useState<Area>('products');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<ListState | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const areaOp = AREAS.find((a) => a.key === area)!.op;
  const isForm = areaOp === null;

  const load = useCallback(async () => {
    if (areaOp === null) { setList(null); setError(null); return; }
    setBusy(true);
    setError(null);
    try {
      const value = await remoteRead<ListState>(areaOp, query ? { q: query } : {});
      setList(value);
    } catch (e) {
      setList(null);
      const err = e as RemoteReadError;
      if (err.code === ERR_UNAUTHENTICATED) setSignedIn(false);
      // Die Meldung ist die Wahrheit, nicht ein leerer Bildschirm: „keine Treffer" und „kein
      // Server" sehen sonst gleich aus.
      setError(err.code === 'SERVER_UNAVAILABLE' ? 'Server unavailable' : `${err.code}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [areaOp, query]);

  useEffect(() => { if (signedIn) void load(); }, [signedIn, load, tick]);

  if (!cfg) {
    return <Frame><p>No server is configured for this client.</p></Frame>;
  }

  if (!signedIn) {
    return <SignIn serverUrl={cfg.serverUrl} onDone={() => { setSignedIn(true); setTick((t) => t + 1); }} />;
  }

  return (
    <Frame>
      <div data-client-mode style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {AREAS.map((a) => (
          <button key={a.key} data-client-area={a.key}
            onClick={() => { setArea(a.key); setDetail(null); setQuery(''); }}
            style={chip(area === a.key)}>{a.label}</button>
        ))}
        <input data-client-search placeholder="Search…" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #D5D9DE', fontSize: 12 }} />
        <button data-client-refresh onClick={() => setTick((t) => t + 1)} style={chip(false)}>Refresh</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B7280' }}>
          reads + new invoice · {cfg.serverUrl}
        </span>
        <button onClick={() => { leaveClientMode(); window.location.reload(); }} style={chip(false)}>Disconnect</button>
      </div>

      {error && <p data-client-error style={{ color: '#B91C1C', fontSize: 13 }}>{error}</p>}

      {isForm && <ClientInvoiceCreate />}
      {busy && !list && <p style={{ fontSize: 12, color: '#6B7280' }}>Loading…</p>}

      {list?.stock && (
        <p data-client-stock style={{ fontSize: 13, color: '#6B7280', marginBottom: 10 }}>
          {list.stock.records} products · {list.stock.units} items · {fmt(list.stock.cost)} BHD stock value
        </p>
      )}

      {list && (
        <div data-client-list>
          {list.items.length === 0 && <p style={{ fontSize: 12, color: '#6B7280' }}>Nothing here.</p>}
          {list.items.map((row) => (
            <div key={s(row.id)} data-client-row={s(row.id)}
              onClick={() => void openDetail(area, s(row.id), setDetail, setError)}
              style={{
                padding: '8px 10px', border: '1px solid #E5E7EB', borderRadius: 8,
                marginBottom: 6, cursor: 'pointer', fontSize: 13,
              }}>
              {rowLabel(area, row)}
            </div>
          ))}
        </div>
      )}

      {detail && (
        <div data-client-detail style={{ marginTop: 16, padding: 14, border: '1px solid #D5D9DE', borderRadius: 10 }}>
          <button onClick={() => setDetail(null)} style={chip(false)}>Close</button>
          <pre data-client-detail-json style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 10 }}>
            {JSON.stringify(detail, null, 2)}
          </pre>
          <RemoteImages keys={(detail.mediaKeys as string[] | undefined) ?? []} serverUrl={cfg.serverUrl} token={cfg.token} />
        </div>
      )}
    </Frame>
  );
}

function rowLabel(area: Area, r: Record<string, unknown>): string {
  if (area === 'products') return `${s(r.brand)} ${s(r.name)} · ${s(r.sku)} · x${s(r.quantity ?? 1)}`;
  if (area === 'customers') return `${s(r.firstName)} ${s(r.lastName)} ${s(r.company) ? '· ' + s(r.company) : ''}`;
  return `${s(r.invoiceNumber)} · ${s(r.status)} · ${fmt(Number(r.grossAmount) || 0)} BHD`;
}

async function openDetail(
  area: Area,
  id: string,
  setDetail: (v: Record<string, unknown> | null) => void,
  setError: (v: string | null) => void,
): Promise<void> {
  const op = area === 'products' ? 'products.get' : area === 'customers' ? 'customers.get' : 'invoices.get';
  try {
    setDetail(await remoteRead<Record<string, unknown>>(op, { id }));
  } catch (e) {
    const err = e as RemoteReadError;
    setError(err.code === 'SERVER_UNAVAILABLE' ? 'Server unavailable' : `${err.code}: ${err.message}`);
  }
}

/**
 * Bilder kommen über die bestehende, angemeldete Medienroute — kein kopiertes Verzeichnis, keine
 * Netzfreigabe. Ohne Anmeldung liefert sie nichts, deshalb werden die Bytes geholt und als
 * Objekt-URL gezeigt statt die Adresse in ein `src` zu schreiben (dort fehlte der Token).
 */
function RemoteImages({ keys, serverUrl, token }: { keys: string[]; serverUrl: string; token: string | null }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let dead = false;
    const made: string[] = [];
    (async () => {
      if (!token || keys.length === 0) { setUrls([]); return; }
      for (const key of keys.slice(0, 8)) {
        try {
          const res = await fetch(`${serverUrl}/api/media?key=${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) continue;                       // fehlendes Bild bleibt ein fehlendes Bild
          const url = URL.createObjectURL(await res.blob());
          made.push(url);
          if (!dead) setUrls([...made]);
        } catch { /* ein Bild weniger, kein Fehler der Seite */ }
      }
    })();
    return () => {
      dead = true;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [keys.join(','), serverUrl, token]);

  if (urls.length === 0) return <p data-client-no-media style={{ fontSize: 11, color: '#9CA3AF' }}>No image.</p>;
  return (
    <div data-client-media style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      {urls.map((u) => <img key={u} src={u} alt="" data-client-image style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8 }} />)}
    </div>
  );
}

function SignIn({ serverUrl, onDone }: { serverUrl: string; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Frame>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Connected to {serverUrl}</h2>
      <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 14 }}>
        This machine has no database of its own. Sign in to read from the server.
      </p>
      <input data-client-email type="email" placeholder="you@company.com" value={email}
        onChange={(e) => setEmail(e.target.value)} style={field} />
      <input data-client-password type="password" placeholder="Password" value={password}
        onChange={(e) => setPassword(e.target.value)} style={field} />
      {error && <p data-client-error style={{ color: '#B91C1C', fontSize: 12 }}>{error}</p>}
      <button data-client-signin disabled={busy} style={{ ...chip(true), marginTop: 8 }}
        onClick={async () => {
          setBusy(true); setError(null);
          try { await clientLogin(email, password); onDone(); }
          catch (e) {
            const err = e as RemoteReadError;
            setError(err.code === 'SERVER_UNAVAILABLE' ? 'Server unavailable' : 'Wrong e-mail or password');
          } finally { setBusy(false); }
        }}>Sign in</button>
      <button style={{ ...chip(false), marginTop: 8, marginLeft: 8 }}
        onClick={() => { leaveClientMode(); window.location.reload(); }}>Disconnect</button>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div data-client-shell style={{ padding: 28, maxWidth: 1100, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      {children}
    </div>
  );
}

const field: React.CSSProperties = {
  display: 'block', width: 280, padding: '8px 10px', marginBottom: 8,
  borderRadius: 8, border: '1px solid #D5D9DE', fontSize: 13,
};

function chip(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
    color: active ? '#0F0F10' : '#6B7280',
    background: active ? 'rgba(15,15,16,0.06)' : '#FFFFFF',
  };
}
