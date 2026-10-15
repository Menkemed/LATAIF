// ════════════════════════════════════════════════════════════════════════════
// OPENING BALANCES — „Opening balances": die gemeinsame Abstimmungsliste aller Eröffnungsposten zum 15.10.2026.
//
// Nur für den Owner, am Primary und am PC2 (Auskunft `page.opening_balances.get`). Schreibgeschützt: erfasst wird je
// Kunde/Lieferant in Edit Client / Supplier Edit. Gebucht ist hier nichts — Gegenkonto, Datum und VAT bestätigt erst der
// Buchhalter. Der vorhandene Kassen-Anfangsbestand (Settings, Stichtag 01.01.2000) wird nur gezeigt, nicht verschoben.
// ════════════════════════════════════════════════════════════════════════════
import { useNavigate } from 'react-router-dom';
import { PageLayout } from '@/components/layout/PageLayout';
import { KPICard } from '@/components/ui/KPICard';
import { useSharedRead } from '@/core/data/shared-read';
import { usePermission } from '@/hooks/usePermission';
import { KIND_LABEL, openingOverviewFor, type OpeningOverview } from '@/core/parties/opening-balances';
import { OP_PAGE_OPENING_BALANCES_GET } from '@/core/parties/party-account';

const b3 = (n: number): string => n.toFixed(3);

export function OpeningBalancesPage() {
  const perm = usePermission();
  const navigate = useNavigate();
  const data = useSharedRead<OpeningOverview | null>(OP_PAGE_OPENING_BALANCES_GET, {}, (ctx) => openingOverviewFor(ctx), null, []);

  if (!perm.isOwner) {
    return (
      <PageLayout title="Opening balances">
        <p data-opening-no-access style={{ fontSize: 14, color: '#6B7280' }}>Only the owner can see the opening balances.</p>
      </PageLayout>
    );
  }
  if (!data) {
    return (
      <PageLayout title="Opening balances">
        <p data-opening-unavailable style={{ fontSize: 14, color: '#6B7280' }}>The opening balances are not available right now.</p>
      </PageLayout>
    );
  }
  const total = (kind: string) => data.totals.find((t) => t.kind === kind);

  return (
    <PageLayout title="Opening balances" subtitle={`As of ${data.cutoffDate} — recorded, not booked`}>
      <div data-opening-notes style={{ padding: '10px 14px', background: '#F5F7FA', border: '1px solid #E5E9EE', borderRadius: 8, fontSize: 13, color: '#374151', marginBottom: 20, display: 'grid', gap: 4 }}>
        <span>Old customer and supplier balances are recorded per customer or supplier (Edit Client / Supplier Edit → Opening balances).</span>
        <span>{data.booking.reason}</span>
        <span>Old stock: see the page “Old stock”. Cash, bank and Benefit: the existing opening from the settings stays as it is (booked on {data.cashOpening.bookedOn}) — it is not moved to {data.cutoffDate} without a decision.</span>
        {/* B1 OPENING ACCOUNTING — die ganze Eröffnungsbilanz (Kasse gezählt, Darlehen, VAT, Saldenliste, Bilanzvorschau). */}
        <button onClick={() => navigate('/settings?tab=opening')} className="text-left cursor-pointer" style={{ background: 'none', border: 'none', padding: 0, color: '#1F4E8C', fontSize: 13 }} data-opening-settings-link>
          The complete opening balance sheet (cash count, loans, other balances, VAT, trial balance): Settings → Opening Balances
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 24 }}>
        {(['CUSTOMER_RECEIVABLE', 'CUSTOMER_ADVANCE', 'SUPPLIER_PAYABLE', 'SUPPLIER_ADVANCE'] as const).map((k) => (
          <KPICard key={k} label={KIND_LABEL[k].toUpperCase()} value={b3(total(k)?.amount ?? 0)} unit={`BHD · ${total(k)?.count ?? 0} position(s) · not booked`} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 24 }} data-opening-cash>
        <KPICard label="CASH OPENING (SETTINGS)" value={b3(data.cashOpening.settings.cash)} unit={`BHD · ledger ${b3(data.cashOpening.ledger.cash)}`} />
        <KPICard label="BANK OPENING (SETTINGS)" value={b3(data.cashOpening.settings.bank)} unit={`BHD · ledger ${b3(data.cashOpening.ledger.bank)}`} />
        <KPICard label="BENEFIT OPENING (SETTINGS)" value={b3(data.cashOpening.settings.benefit)} unit={`BHD · ledger ${b3(data.cashOpening.ledger.benefit)}`} />
      </div>
      <div style={{ border: '1px solid #E5E9EE', borderRadius: 8 }} data-opening-parties>
        {data.parties.length === 0 && <p style={{ padding: 16, fontSize: 13, color: '#6B7280' }}>No opening positions recorded yet.</p>}
        {data.parties.map((p) => (
          <button key={`${p.partyType}:${p.partyId}:${p.kind}`} onClick={() => navigate(p.partyType === 'CUSTOMER' ? `/clients/${p.partyId}` : `/suppliers/${p.partyId}`)}
            className="w-full text-left cursor-pointer flex justify-between"
            style={{ padding: '10px 14px', borderTop: '1px solid #F1F3F5', background: 'none', border: 'none', fontSize: 13 }} data-opening-party-row>
            <span>{p.name} <span style={{ color: '#6B7280' }}>· {KIND_LABEL[p.kind]} · {p.count} position(s)</span></span>
            <span className="font-mono">{b3(p.amount)} BHD</span>
          </button>
        ))}
      </div>
      {data.cancelledCount > 0 && <p style={{ marginTop: 10, fontSize: 12, color: '#9CA3AF' }}>{data.cancelledCount} cancelled position(s) are kept in the documents and the audit log.</p>}
    </PageLayout>
  );
}
