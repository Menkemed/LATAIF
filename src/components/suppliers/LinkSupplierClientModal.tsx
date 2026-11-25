// CUSTOMER-SUPPLIER-ROLE-LINK V3 — „Link to client…" / „Link supplier…" direkt auf der Detailseite.
//
// Dieselbe Person wurde als Kunde UND als Lieferant angelegt, ohne „Use existing customer". Diese Maske
// verknüpft die beiden Rollen nachträglich. Geschrieben wird über DENSELBEN Weg wie in
// „New Supplier → Use existing customer → Link this supplier" (`saveSupplierLinkToCustomer`,
// am PC2 `suppliers.update` mit Kunde + gesehenem Stand): NUR `linked_customer_id` wird gesetzt —
// keine Einkäufe, Verbindlichkeiten, Rechnungen oder Buchungen. Die Regeln (Lieferant schon verknüpft,
// Kunde hat schon eine Lieferantenrolle, Kunde geändert) prüft der Primary.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { WriteError } from '@/components/shared/WriteError';
import { useCustomerStore } from '@/stores/customerStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { matchesDeep } from '@/core/utils/deep-search';
import { useSharedWrite, fehlertext } from '@/core/data/shared-write';
import { saveSupplierLinkToCustomer } from '@/core/masterdata/masterdata-save';
import type { Customer, Supplier } from '@/core/models/types';

type Props =
  | { open: boolean; onClose: () => void; onLinked: () => void; supplier: Supplier; customer?: undefined; suggested?: Customer }
  | { open: boolean; onClose: () => void; onLinked: () => void; customer: Customer; supplier?: undefined; suggested?: Supplier };

const kundeName = (c: Customer) => `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() + (c.company ? ` · ${c.company}` : '');

export function LinkSupplierClientModal(props: Props) {
  const { open, onClose, onLinked } = props;
  const { customers, loadCustomers } = useCustomerStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const verknuepfen = useSharedWrite<{ supplierId: string; existing: boolean }>('suppliers.update');
  const [search, setSearch] = useState('');
  const [pickedCustomer, setPickedCustomer] = useState<Customer | null>(null);
  const [pickedSupplier, setPickedSupplier] = useState<Supplier | null>(null);
  const [fehler, setFehler] = useState('');

  const vomLieferanten = !!props.supplier;

  useEffect(() => {
    if (!open) return;
    setSearch(''); setFehler('');
    if (props.supplier) { setPickedCustomer(props.suggested ?? null); setPickedSupplier(null); }
    else { setPickedSupplier(props.suggested ?? null); setPickedCustomer(null); }
    loadCustomers(); loadSuppliers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Kunden, die schon eine Lieferantenrolle haben, werden gezeigt, aber nicht wählbar (eine Rolle je Kunde).
  const rolleVon = useMemo(() => {
    const m = new Map<string, Supplier>();
    for (const s of suppliers) if (s.linkedCustomerId) m.set(s.linkedCustomerId, s);
    return m;
  }, [suppliers]);

  const kundenTreffer = useMemo(() => {
    const q = search.trim();
    if (!vomLieferanten || !q) return [];
    return customers.filter((c) => matchesDeep(c, q)).slice(0, 8);
  }, [customers, search, vomLieferanten]);

  const lieferantenTreffer = useMemo(() => {
    const q = search.trim();
    if (vomLieferanten || !q) return [];
    return suppliers.filter((s) => matchesDeep(s, q)).slice(0, 8);
  }, [suppliers, search, vomLieferanten]);

  const kunde = props.customer ?? pickedCustomer;
  const lieferant = props.supplier ?? pickedSupplier;
  const gewaehlt = vomLieferanten ? pickedCustomer : pickedSupplier;

  async function link() {
    if (!kunde || !lieferant) return;
    setFehler('');
    // Den Stand des Kunden aus dem frisch geladenen Store nehmen — der Primary prüft genau diesen Stand.
    const frisch = useCustomerStore.getState().customers.find((c) => c.id === kunde.id) ?? kunde;
    const r = await saveSupplierLinkToCustomer(verknuepfen, lieferant.id, { id: frisch.id, updatedAt: frisch.updatedAt });
    if (r.kind !== 'ok') {
      setFehler(`Could not link: ${fehlertext(r)}`);
      loadCustomers(); loadSuppliers();
      return;
    }
    loadCustomers(); loadSuppliers();
    onLinked();
  }

  const zeile = (key: string, title: string, sub: string, gesperrt: string | null, onPick: () => void, data: Record<string, string>) => (
    <button key={key} type="button" disabled={!!gesperrt} onClick={onPick} {...data}
      style={{ textAlign: 'left', padding: '8px 10px', border: '1px solid #E5E9EE', borderRadius: 6, background: 'transparent', cursor: gesperrt ? 'not-allowed' : 'pointer', opacity: gesperrt ? 0.55 : 1 }}>
      <div style={{ fontSize: 14, color: '#0F0F10' }}>{title}</div>
      <div style={{ fontSize: 11, color: '#6B7280' }}>{gesperrt ?? sub}</div>
    </button>
  );

  return (
    <Modal open={open} onClose={() => { if (!verknuepfen.busy) onClose(); }} title={vomLieferanten ? 'Link to Client' : 'Link Supplier'} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-link-supplier-client>
        <WriteError text={fehler} />
        {!gewaehlt ? (
          <>
            <p style={{ fontSize: 13, color: '#4B5563' }}>
              {vomLieferanten
                ? <>Is supplier <strong>{props.supplier!.name}</strong> the same person or company as an existing client? Find the client.</>
                : <>Is client <strong>{kundeName(props.customer!)}</strong> the same person or company as an existing supplier? Find the supplier.</>}
            </p>
            <Input label={vomLieferanten ? 'FIND CLIENT' : 'FIND SUPPLIER'} placeholder="Name, phone, company…" value={search}
              onChange={(e) => setSearch(e.target.value)} autoFocus data-link-search />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {vomLieferanten
                ? kundenTreffer.map((c) => {
                  const rolle = rolleVon.get(c.id);
                  return zeile(c.id, kundeName(c), c.phone || c.whatsapp || c.email || '',
                    rolle ? `already linked to supplier “${rolle.name}”` : null,
                    () => setPickedCustomer(c), { 'data-link-pick-customer': c.id });
                })
                : lieferantenTreffer.map((s) => zeile(s.id, s.name, s.phone || s.email || '',
                  s.linkedCustomerId ? 'already linked to another client' : null,
                  () => setPickedSupplier(s), { 'data-link-pick-supplier': s.id }))}
              {search.trim() && (vomLieferanten ? kundenTreffer : lieferantenTreffer).length === 0 && (
                <p style={{ fontSize: 12, color: '#9CA3AF' }}>{vomLieferanten ? 'No client found.' : 'No supplier found.'}</p>
              )}
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: '10px 14px', fontSize: 13 }} data-link-confirm>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ color: '#6B7280' }}>Client</span>
                <span style={{ color: '#0F0F10' }}>{kunde ? kundeName(kunde) : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ color: '#6B7280' }}>Supplier</span>
                <span style={{ color: '#0F0F10' }}>{lieferant?.name ?? '—'}</span>
              </div>
              <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>
                Only the link is saved. Purchases, payables, invoices and bookings stay exactly as they are.
                Both pages then show the balance of the other role.
              </p>
            </div>
            <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => { setPickedCustomer(null); setPickedSupplier(null); }} disabled={verknuepfen.busy}>Choose another</Button>
              <Button variant="primary" onClick={() => void link()} disabled={verknuepfen.busy} data-link-save>Link</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
