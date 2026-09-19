// CUSTOMER-SUPPLIER-ROLE-LINK — „New Supplier → Use existing customer".
//
// Dieselbe reale Person/Firma bekommt eine Lieferanten-Rolle mit EIGENER Kennung. Der Kunde bleibt,
// wie er ist. Was übernommen wird, zeigt diese Maske an — berechnet von der EINEN Regel
// (`supplierSeedFromCustomer`), die auch der Primary beim Anlegen anwendet; geschickt wird nur die
// Kunden-Kennung, der gesehene Stand und die Felder, die nur ein Lieferant braucht.
// Ist der Kunde schon Lieferant, wird nichts angelegt: die bestehende Rolle wird angeboten.
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { WriteError } from '@/components/shared/WriteError';
import { useCustomerStore } from '@/stores/customerStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { matchesDeep } from '@/core/utils/deep-search';
import { useSharedWrite, fehlertext } from '@/core/data/shared-write';
import { saveSupplierFromCustomer, saveSupplierLinkToCustomer } from '@/core/masterdata/masterdata-save';
import { supplierSeedFromCustomer, supplierLinkCandidates, type LinkCandidateReason } from '@/core/masterdata/masterdata-rules';
import type { Customer } from '@/core/models/types';

const WARUM: Record<LinkCandidateReason, string> = {
  created_from_this_customer: 'created from this customer (consignment)',
  same_phone: 'same phone',
  same_id_number: 'same CPR / ID number',
  same_name: 'same name',
};

export function UseCustomerAsSupplier({ onDone, onCancel }: {
  /** Die Lieferanten-Rolle, die jetzt gilt — neu angelegt oder schon vorhanden. */
  onDone: (supplierId: string, existing: boolean) => void;
  onCancel: () => void;
}) {
  const { customers, loadCustomers } = useCustomerStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const anlegen = useSharedWrite<{ supplierId: string; existing: boolean }>('suppliers.create');
  const verknuepfen = useSharedWrite<{ supplierId: string; existing: boolean }>('suppliers.update');
  // V2 — der Benutzer hat die vorhandenen Kandidaten gesehen und will trotzdem eine NEUE Rolle.
  const [trotzdemNeu, setTrotzdemNeu] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Customer | null>(null);
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [fehler, setFehler] = useState('');

  useEffect(() => { loadCustomers(); loadSuppliers(); }, [loadCustomers, loadSuppliers]);

  const hits = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    return customers.filter((c) => matchesDeep(c, q)).slice(0, 8);
  }, [customers, search]);

  const seed = useMemo(() => {
    if (!picked) return null;
    try { return supplierSeedFromCustomer(picked); } catch { return null; }
  }, [picked]);
  const schonLieferant = picked ? suppliers.find((s) => s.linkedCustomerId === picked.id) : undefined;
  // V2 — unverknüpfte Lieferanten, die diese Person sein könnten (nur exakte Merkmale). Nichts wird
  // automatisch verknüpft: der Benutzer wählt einen aus oder legt ausdrücklich neu an.
  const kandidaten = useMemo(
    () => (picked && !schonLieferant ? supplierLinkCandidates(picked, suppliers) : []),
    [picked, schonLieferant, suppliers],
  );

  async function link(supplierId: string) {
    if (!picked) return;
    setFehler('');
    const r = await saveSupplierLinkToCustomer(verknuepfen, supplierId, picked);
    if (r.kind !== 'ok') { setFehler(`Could not link supplier: ${fehlertext(r)}`); loadCustomers(); loadSuppliers(); return; }
    onDone(r.value.supplierId, true);
  }

  async function save() {
    if (!picked) return;
    setFehler('');
    const r = await saveSupplierFromCustomer(anlegen, picked, { address, notes, createDespiteExistingSuppliers: trotzdemNeu });
    if (r.kind !== 'ok') {
      setFehler(`Could not create supplier: ${fehlertext(r)}`);
      // Der Kunde hat sich geändert: frisch laden, damit die Übernahme wieder stimmt.
      loadCustomers();
      loadSuppliers();
      return;
    }
    onDone(r.value.supplierId, r.value.existing);
  }

  const zeile = (label: string, value?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
      <span style={{ color: '#6B7280' }}>{label}</span>
      <span style={{ color: '#0F0F10' }}>{value || '—'}</span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-use-customer-as-supplier>
      <WriteError text={fehler} />
      {!picked ? (
        <>
          <Input label="FIND CUSTOMER" placeholder="Name, phone, company…" value={search}
            onChange={(e) => setSearch(e.target.value)} autoFocus />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {hits.map((c) => (
              <button key={c.id} type="button" data-customer-pick={c.id}
                onClick={() => { setPicked(c); setTrotzdemNeu(false); }}
                style={{ textAlign: 'left', padding: '8px 10px', border: '1px solid #E5E9EE', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}>
                <div style={{ fontSize: 14, color: '#0F0F10' }}>{c.firstName} {c.lastName}{c.company ? ` · ${c.company}` : ''}</div>
                <div style={{ fontSize: 11, color: '#6B7280' }}>{c.phone || c.whatsapp || c.email || ''}</div>
              </button>
            ))}
            {search.trim() && hits.length === 0 && <p style={{ fontSize: 12, color: '#9CA3AF' }}>No customer found.</p>}
          </div>
        </>
      ) : schonLieferant ? (
        <div data-customer-already-supplier>
          <p style={{ fontSize: 13, color: '#0F0F10' }}>
            {picked.firstName} {picked.lastName} is already a supplier: <strong>{schonLieferant.name}</strong>.
          </p>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12 }}>
            <Button variant="ghost" onClick={() => setPicked(null)}>Choose another</Button>
            <Button variant="primary" onClick={() => onDone(schonLieferant.id, true)}>Use this supplier</Button>
          </div>
        </div>
      ) : kandidaten.length > 0 && !trotzdemNeu ? (
        <div data-supplier-link-candidates>
          <p style={{ fontSize: 13, color: '#0F0F10', marginBottom: 8 }}>
            An existing supplier may already be {picked.firstName} {picked.lastName}. Link it — its purchases and payables stay exactly as they are — or create a new supplier.
          </p>
          {kandidaten.map((k) => (
            <div key={k.supplier.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', border: '1px solid #E5E9EE', borderRadius: 6, marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 14, color: '#0F0F10' }}>{k.supplier.name}</div>
                <div style={{ fontSize: 11, color: '#6B7280' }}>{k.reasons.map((r) => WARUM[r]).join(' · ')}{k.supplier.phone ? ` · ${k.supplier.phone}` : ''}</div>
              </div>
              <Button variant="primary" onClick={() => void link(k.supplier.id)} disabled={verknuepfen.busy} data-supplier-link={k.supplier.id}>Link this supplier</Button>
            </div>
          ))}
          <div className="flex justify-end gap-3" style={{ paddingTop: 12 }}>
            <Button variant="ghost" onClick={() => setPicked(null)}>Choose another</Button>
            <Button variant="ghost" onClick={() => setTrotzdemNeu(true)} data-supplier-create-despite>Create a new supplier instead</Button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: '10px 14px' }}>
            <span className="text-overline">TAKEN FROM THE CUSTOMER</span>
            {zeile('Name', seed?.name)}
            {zeile('Phone', seed?.phone)}
            {zeile('Email', seed?.email)}
            {zeile('CPR / ID number', seed?.cpr)}
            <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>
              The customer stays unchanged. Sales and receivables stay with the customer; purchases and payables go to this supplier.
            </p>
          </div>
          <Input label="ADDRESS" placeholder="Street, City" value={address} onChange={(e) => setAddress(e.target.value)} />
          <Input label="SUPPLIER NOTES" placeholder="optional" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setPicked(null)}>Choose another</Button>
            <Button variant="primary" onClick={() => void save()} disabled={!seed || anlegen.busy} data-supplier-from-customer-save>
              Create Supplier
            </Button>
          </div>
        </>
      )}
      {!picked && (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
