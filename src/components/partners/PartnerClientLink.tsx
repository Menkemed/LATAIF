// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT A2 (P1) — „Linked client" im Partner-Dialog: einen Partner ausdrücklich mit einem Kunden (dieselbe
// Person) verknüpfen oder die Verknüpfung lösen. Kunde bewusst auswählen, bestätigen; nie über Name oder Telefon.
// Geschrieben wird nur `partners.linked_customer_id` (Primary: Hausfunktion, PC2: `partners.update`), mit Protokoll.
// Beteiligungen, Bewegungen, Abrechnungen und Buchungen bleiben unberührt.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useCustomerStore } from '@/stores/customerStore';
import { useSharedWrites, fehlertext, type WriteAdapters } from '@/core/data/shared-write';
import { savePartnerLinkToCustomer, savePartnerUnlink } from '@/core/masterdata/masterdata-save';
import type { Partner } from '@/core/models/types';

const nameOf = (c: { firstName?: string; lastName?: string; company?: string }): string =>
  `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || c.company || '—';

export function PartnerClientLink({ partner, onChanged }: { partner: Partner; onChanged: () => void }) {
  const { customers, loadCustomers } = useCustomerStore();
  const w = useSharedWrites();
  const [wahl, setWahl] = useState('');
  const [fehler, setFehler] = useState('');
  useEffect(() => { loadCustomers(); }, [loadCustomers]);
  const sortiert = useMemo(() => [...customers].sort((a, b) => nameOf(a).localeCompare(nameOf(b))), [customers]);
  const verknuepft = partner.linkedCustomerId ? customers.find((c) => c.id === partner.linkedCustomerId) : undefined;
  const linkWrite = { remote: w.remote, save: (a: WriteAdapters<{ partnerId: string; existing: boolean }>) => w.save('partners.update', a) };
  const unlinkWrite = { remote: w.remote, save: (a: WriteAdapters<{ partnerId: string }>) => w.save('partners.update', a) };

  async function verknuepfen() {
    const c = customers.find((x) => x.id === wahl);
    if (!c) return;
    setFehler('');
    const ok = await window.confirm(`Link partner "${partner.name}" to client "${nameOf(c)}"?\n\nOnly the link is saved — shares, settlements and bookings stay as they are. The partner's open amounts then appear in this client's account.`);
    if (!ok) return;
    const r = await savePartnerLinkToCustomer(linkWrite, partner.id, { id: c.id, updatedAt: c.updatedAt });
    if (r.kind !== 'ok') { setFehler(`Could not link: ${fehlertext(r)}`); return; }
    setWahl('');
    onChanged();
  }
  async function loesen() {
    if (!partner.linkedCustomerId) return;
    setFehler('');
    const ok = await window.confirm(`Unlink partner "${partner.name}" from client "${verknuepft ? nameOf(verknuepft) : partner.linkedCustomerId}"?\n\nThe partner's amounts leave this client's account. Nothing else changes.`);
    if (!ok) return;
    const r = await savePartnerUnlink(unlinkWrite, partner.id, partner.linkedCustomerId);
    if (r.kind !== 'ok') { setFehler(`Could not unlink: ${fehlertext(r)}`); return; }
    onChanged();
  }

  return (
    <div data-partner-client-link={partner.id}>
      <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>LINKED CLIENT</span>
      {partner.linkedCustomerId ? (
        <div className="flex items-center justify-between gap-3" style={{ fontSize: 13 }}>
          <span data-partner-linked-client={partner.linkedCustomerId}>
            <Link to={`/clients/${partner.linkedCustomerId}/account`} style={{ color: '#0F0F10', fontWeight: 500 }}>
              {verknuepft ? nameOf(verknuepft) : partner.linkedCustomerId}
            </Link>
            <span style={{ color: '#6B7280', fontSize: 12 }}> · same person — open amounts count in the client account</span>
          </span>
          <Button variant="ghost" disabled={w.busy} onClick={() => void loesen()} data-partner-unlink>Unlink</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select value={wahl} onChange={(e) => setWahl(e.target.value)} data-partner-link-select
            style={{ flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, background: 'transparent' }}>
            <option value="">Choose the client (same person)…</option>
            {sortiert.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}{c.phone ? ` · ${c.phone}` : ''}</option>)}
          </select>
          <Button variant="secondary" disabled={!wahl || w.busy} onClick={() => void verknuepfen()} data-partner-link>Link to client</Button>
        </div>
      )}
      {fehler && <div style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }} data-partner-link-error>{fehler}</div>}
    </div>
  );
}
