// CENTRAL-C2/C3B/C3C — die Oberfläche des zweiten Rechners.
//
// Bewusst schmal: Anmeldung, drei Listen, drei Detailansichten — und Formulare für genau die
// Operationen, die namentlich freigegeben sind (`ALLOWED_MUTATIONS`): eine Rechnung, ein neuer
// Kunde, ein geänderter Kunde. Alles andere kann die Gegenstelle nach wie vor nicht annehmen —
// ein Produkt zum Beispiel nicht, solange sein Medienweg nicht ehrlich gebaut ist.
//
// Auch die Formulare legen hier nichts an: sie schicken die Auswahl eines Menschen an den Primary
// und zeigen, was von dort zurückkommt. Gerechnet, nummeriert und gebucht wird dort.
//
// Und es gibt keinen stillen Rückfall. Ist der Server weg, steht das da. Es wird keine lokale
// Datenbank angelegt, um „wenigstens etwas" zu zeigen — das wäre eine zweite Wahrheit.

import { useCallback, useEffect, useState } from 'react';
import { clientConfig, leaveClientMode } from '@/core/bridge/client-mode';
import { remoteRead, clientLogin, RemoteReadError, ERR_UNAUTHENTICATED } from '@/core/bridge/remote-read';
import { ClientInvoiceCreate } from '@/components/client/ClientInvoiceCreate';
import { ClientCustomerForm } from '@/components/client/ClientCustomerForm';
import { ClientProductForm } from '@/components/client/ClientProductForm';
import { ClientInvoiceDetail } from '@/components/client/ClientInvoiceDetail';
import { ClientPurchaseForm } from '@/components/client/ClientPurchaseForm';
import { ClientConsignmentForm } from '@/components/client/ClientConsignmentForm';
import { ClientOrderForm } from '@/components/client/ClientOrderForm';
import { ClientRepairForm } from '@/components/client/ClientRepairForm';
import { ClientTransferForm } from '@/components/client/ClientTransferForm';

type Area =
  | 'products' | 'customers' | 'invoices' | 'purchases' | 'consignments' | 'orders'
  | 'new-invoice' | 'new-customer' | 'new-product'
  | 'new-purchase' | 'new-consignment' | 'new-order'
  | 'repairs' | 'transfers' | 'new-repair' | 'new-transfer';

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
  { key: 'new-customer', label: 'New client', op: null },
  { key: 'new-product', label: 'New item', op: null },
  // CENTRAL-C3E — die drei Handelsbelege. Lesen und Anlegen sind getrennte Bereiche, damit das
  // Ändern IMMER an einer gelesenen Zeile beginnt: eine frei eingetippte Kennung gibt es nicht.
  { key: 'purchases', label: 'Purchases', op: 'purchases.list' },
  { key: 'consignments', label: 'Consignments', op: 'consignments.list' },
  { key: 'orders', label: 'Orders', op: 'orders.list' },
  { key: 'new-purchase', label: 'New purchase', op: null },
  { key: 'new-consignment', label: 'New consignment', op: null },
  { key: 'new-order', label: 'New order', op: null },
  // CENTRAL-C3F — Reparaturen und Ware auf Kommission bei einem Kunden. „Transfer" ist hier KEIN
  // Filialtransfer: es gibt im Haus keinen.
  { key: 'repairs', label: 'Repairs', op: 'repairs.list' },
  { key: 'transfers', label: 'On approval', op: 'transfers.list' },
  { key: 'new-repair', label: 'New repair', op: null },
  { key: 'new-transfer', label: 'Send out', op: null },
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
  // Welchen Kunden gerade jemand ändert. Kein eigener Bereich: das Ändern beginnt IMMER an einem
  // Kunden, den dieser Rechner vorher gelesen hat — eine frei eingetippte Kennung gäbe es sonst.
  const [editCustomerId, setEditCustomerId] = useState<string | null>(null);
  const [editProductId, setEditProductId] = useState<string | null>(null);
  // Welche Rechnung gerade offen ist. Sie beginnt IMMER an einer gelesenen Zeile — es gibt kein
  // Feld, in das jemand eine Kennung tippen koennte.
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  // Dieselbe Regel für Kommission und Auftrag: das Ändern beginnt an einer gelesenen Zeile.
  const [editConsignmentId, setEditConsignmentId] = useState<string | null>(null);
  const [editOrderId, setEditOrderId] = useState<string | null>(null);
  const [editRepairId, setEditRepairId] = useState<string | null>(null);
  const [editTransferId, setEditTransferId] = useState<string | null>(null);

  const areaOp = AREAS.find((a) => a.key === area)!.op;

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
            onClick={() => {
              setArea(a.key); setDetail(null); setQuery('');
              setEditCustomerId(null); setEditProductId(null); setOpenInvoiceId(null);
              setEditConsignmentId(null); setEditOrderId(null);
              setEditRepairId(null); setEditTransferId(null);
            }}
            style={chip(area === a.key)}>{a.label}</button>
        ))}
        <input data-client-search placeholder="Search…" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #D5D9DE', fontSize: 12 }} />
        <button data-client-refresh onClick={() => setTick((t) => t + 1)} style={chip(false)}>Refresh</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6B7280' }}>
          reads + invoice + clients + items + payments + purchases + consignments + orders
          {' + repairs + approvals · '}{cfg.serverUrl}
        </span>
        <button onClick={() => { leaveClientMode(); window.location.reload(); }} style={chip(false)}>Disconnect</button>
      </div>

      {error && <p data-client-error style={{ color: '#B91C1C', fontSize: 13 }}>{error}</p>}

      {area === 'new-invoice' && <ClientInvoiceCreate />}
      {area === 'new-customer' && (
        <ClientCustomerForm onSaved={() => { setArea('customers'); setTick((t) => t + 1); }} />
      )}
      {editCustomerId && (
        <ClientCustomerForm
          customerId={editCustomerId}
          onSaved={() => { setEditCustomerId(null); setDetail(null); setTick((t) => t + 1); }}
          onCancel={() => setEditCustomerId(null)}
        />
      )}
      {area === 'new-product' && (
        <ClientProductForm onSaved={() => { setArea('products'); setTick((t) => t + 1); }} />
      )}
      {editProductId && (
        <ClientProductForm
          productId={editProductId}
          onSaved={() => { setEditProductId(null); setDetail(null); setTick((t) => t + 1); }}
          onCancel={() => setEditProductId(null)}
        />
      )}
      {openInvoiceId && (
        <ClientInvoiceDetail
          invoiceId={openInvoiceId}
          onClose={() => { setOpenInvoiceId(null); setDetail(null); setTick((t) => t + 1); }}
        />
      )}
      {area === 'new-purchase' && (
        <ClientPurchaseForm onSaved={() => { setArea('purchases'); setTick((t) => t + 1); }} />
      )}
      {area === 'new-consignment' && (
        <ClientConsignmentForm onSaved={() => { setArea('consignments'); setTick((t) => t + 1); }} />
      )}
      {editConsignmentId && (
        <ClientConsignmentForm
          consignmentId={editConsignmentId}
          onSaved={() => { setEditConsignmentId(null); setDetail(null); setTick((t) => t + 1); }}
          onCancel={() => setEditConsignmentId(null)}
        />
      )}
      {area === 'new-order' && (
        <ClientOrderForm onSaved={() => { setArea('orders'); setTick((t) => t + 1); }} />
      )}
      {editOrderId && (
        <ClientOrderForm
          orderId={editOrderId}
          onSaved={() => { setEditOrderId(null); setDetail(null); setTick((t) => t + 1); }}
          onCancel={() => setEditOrderId(null)}
        />
      )}
      {area === 'new-repair' && (
        <ClientRepairForm onSaved={() => { setArea('repairs'); setTick((t) => t + 1); }} />
      )}
      {editRepairId && (
        <ClientRepairForm
          repairId={editRepairId}
          onSaved={() => { setEditRepairId(null); setDetail(null); setTick((t) => t + 1); }}
          onCancel={() => setEditRepairId(null)}
        />
      )}
      {area === 'new-transfer' && (
        <ClientTransferForm onSaved={() => { setArea('transfers'); setTick((t) => t + 1); }} />
      )}
      {editTransferId && (
        <ClientTransferForm
          transferId={editTransferId}
          onSaved={() => { setEditTransferId(null); setDetail(null); setTick((t) => t + 1); }}
          onCancel={() => setEditTransferId(null)}
        />
      )}
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

      {detail && !editCustomerId && !editProductId && !openInvoiceId
        && !editConsignmentId && !editOrderId && !editRepairId && !editTransferId && (
        <div data-client-detail style={{ marginTop: 16, padding: 14, border: '1px solid #D5D9DE', borderRadius: 10 }}>
          <button onClick={() => setDetail(null)} style={chip(false)}>Close</button>
          {area === 'customers' && (
            <button data-client-edit-customer style={{ ...chip(true), marginLeft: 8 }}
              onClick={() => setEditCustomerId(s(detail.id))}>Edit</button>
          )}
          {area === 'products' && (
            <button data-client-edit-product style={{ ...chip(true), marginLeft: 8 }}
              onClick={() => setEditProductId(s(detail.id))}>Edit</button>
          )}
          {area === 'invoices' && (
            <button data-client-open-invoice style={{ ...chip(true), marginLeft: 8 }}
              onClick={() => setOpenInvoiceId(s(detail.id))}>Edit / pay</button>
          )}
          {area === 'consignments' && (
            <button data-client-edit-consignment style={{ ...chip(true), marginLeft: 8 }}
              onClick={() => setEditConsignmentId(s(detail.id))}>Edit</button>
          )}
          {area === 'orders' && (
            <button data-client-edit-order style={{ ...chip(true), marginLeft: 8 }}
              onClick={() => setEditOrderId(s(detail.id))}>Edit</button>
          )}
          {area === 'repairs' && (
            <button data-client-edit-repair style={{ ...chip(true), marginLeft: 8 }}
              onClick={() => setEditRepairId(s(detail.id))}>Edit</button>
          )}
          {area === 'transfers' && (
            <button data-client-edit-transfer style={{ ...chip(true), marginLeft: 8 }}
              onClick={() => setEditTransferId(s(detail.id))}>Edit / take back</button>
          )}
          {/* Ein Einkauf hat KEINEN Ändern-Knopf: es gibt im Haus keine Bearbeitung eines
              Einkaufs, und ein Knopf, der nichts kann, wäre ein Versprechen. */}
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
  if (area === 'purchases') {
    return `${s(r.purchaseNumber)} · ${s(r.status)} · ${fmt(Number(r.totalAmount) || 0)} BHD · open ${fmt(Number(r.openAmount) || 0)}`;
  }
  if (area === 'consignments') {
    return `${s(r.consignmentNumber)} · ${s(r.payoutModel)} · ${fmt(Number(r.agreedPrice) || 0)} BHD · ${s(r.status)}`;
  }
  if (area === 'orders') {
    return `${s(r.orderNumber)} · ${s(r.status)} · ${fmt(Number(r.agreedPrice) || 0)} BHD · open ${fmt(Number(r.remainingAmount) || 0)}`;
  }
  if (area === 'repairs') {
    return `${s(r.repairNumber)} · ${s(r.status)} · ${s(r.itemBrand)} ${s(r.itemModel)}`;
  }
  if (area === 'transfers') {
    return `${s(r.transferNumber)} · ${s(r.status)} · ${fmt(Number(r.agentPrice) || 0)} BHD`;
  }
  return `${s(r.invoiceNumber)} · ${s(r.status)} · ${fmt(Number(r.grossAmount) || 0)} BHD`;
}

/** Welcher Lesevorgang hinter einer Zeile steht. Fehlt einer, gibt es keine Detailansicht. */
const DETAIL_OPS: Partial<Record<Area, string>> = {
  products: 'products.get',
  customers: 'customers.get',
  invoices: 'invoices.get',
  purchases: 'purchases.get',
  consignments: 'consignments.get',
  orders: 'orders.get',
  repairs: 'repairs.get',
  transfers: 'transfers.get',
};

async function openDetail(
  area: Area,
  id: string,
  setDetail: (v: Record<string, unknown> | null) => void,
  setError: (v: string | null) => void,
): Promise<void> {
  const op = DETAIL_OPS[area];
  // Ein Bereich ohne Lesevorgang hat auch keine Detailansicht — es wird nichts geraten.
  if (!op) return;
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
