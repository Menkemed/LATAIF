// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P3 — Kommissionsartikel auf der Rechnung „Direct Sale" (nur ADMIN/MANAGER): je Artikel Preis inkl. VAT,
// Steuerart, VAT, Auszahlung an den Einlieferer und LATAIF-Anteil; Unterdeckung und E7 je Zeile ausdrücklich bestätigt;
// je Einlieferer EIN Einkauf mit seiner Einkaufs-VAT (Pflichtwahl, nichts vorbelegt — D2).
// Gerechnet wird mit DENSELBEN Funktionen wie die Buchung: `computeConsignmentSale` (Ökonomie), `consignmentLineAmounts`
// (Zeile) und `consignmentVatShortfall` (E7) — die Vorschau ist, was gebucht wird.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { Bhd } from '@/components/ui/Bhd';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { commissionModelLabel, computeConsignmentSale, type ConsignmentSaleResult } from '@/core/consignment/economics';
import { consignmentLineAmounts, consignmentVatShortfall, type SaleScheme } from '@/core/invoices/mixed-invoice';
import type { ConsignorPurchaseTaxScheme } from '@/core/consignment/consignment-finance';
import { productDisplayName } from '@/core/products/display-name';
import type { Consignment } from '@/core/models/types';

/** Was der Mensch je Kommissionsartikel eingibt. */
export interface ConsignmentDraft {
  consignmentId: string;
  /** Kundenpreis inkl. VAT, wie getippt. */
  priceText: string;
  scheme: SaleScheme;
  /** Unterdeckung bestätigt (gilt für den Preis, bei dem sie gesetzt wurde). */
  ack: boolean;
  /** E7 bestätigt (gilt für Preis und Steuerart, bei denen sie gesetzt wurde). */
  vatAck: boolean;
}

/** Ein gerechneter Kommissionsartikel — Anzeige, Prüfung und Rumpf lesen DIESELBEN Werte. */
export interface ConsignmentRow {
  draft: ConsignmentDraft;
  con: Consignment | undefined;
  label: string;
  consignorName: string;
  price: number;
  econ: ConsignmentSaleResult;
  net: number;
  /** VAT an den Kunden (VAT 10 %), sonst 0. */
  vat: number;
  /** Margen-VAT (intern) bei Margin. */
  internalVat: number;
  gross: number;
  /** E7: negatives LATAIF-Ergebnis unter VAT 10 % (sonst null). */
  vatShortfall: number | null;
}

const SCHEMES: Array<{ id: SaleScheme; label: string }> = [
  { id: 'MARGIN', label: 'Margin' }, { id: 'VAT_10', label: 'VAT 10 %' }, { id: 'ZERO', label: 'Zero-rated' },
];

/** Die gerechneten Zeilen der Kommissionsartikel. */
export function useConsignmentInvoiceRows(drafts: readonly ConsignmentDraft[]): ConsignmentRow[] {
  const { consignments } = useConsignmentStore();
  const { customers } = useCustomerStore();
  const { products } = useProductStore();
  return useMemo(() => drafts.map((d) => {
    const con = consignments.find((c) => c.id === d.consignmentId);
    const prod = con ? products.find((p) => p.id === con.productId) : undefined;
    const consignor = con ? customers.find((k) => k.id === con.consignorId) : undefined;
    const v = parseFloat(d.priceText);
    const price = Number.isFinite(v) && v > 0 ? v : 0;
    const econ = computeConsignmentSale(con ?? { commissionType: 'percent', commissionRate: 0, agreedPrice: 0 }, price);
    // Dieselbe Quelle wie die Buchung: Einkaufspreis des Artikels, sonst die Auszahlung (G4 unverändert).
    const purchasePrice = prod?.purchasePrice || econ.payout;
    const a = price > 0 ? consignmentLineAmounts(price, d.scheme, purchasePrice) : null;
    const persisted = a ? a.persistedVat : 0;
    return {
      draft: d, con,
      label: prod ? productDisplayName(prod) : (con?.consignmentNumber ?? d.consignmentId),
      consignorName: consignor ? `${consignor.firstName} ${consignor.lastName}`.trim() : '—',
      price, econ,
      net: a ? a.calc.netAmount : 0,
      vat: a ? a.calc.vatAmount : 0,
      internalVat: d.scheme === 'MARGIN' ? persisted : 0,
      gross: a ? a.calc.grossAmount : 0,
      vatShortfall: price > 0 ? consignmentVatShortfall(econ, d.scheme, persisted) : null,
    };
  }), [drafts, consignments, customers, products]);
}

/** Je Einlieferer EIN Einkauf: Name, Artikel, Summe der Auszahlungen. */
export function consignorGroupsOf(rows: readonly ConsignmentRow[]): Array<{ consignorId: string; name: string; count: number; payout: number }> {
  const m = new Map<string, { consignorId: string; name: string; count: number; payout: number }>();
  for (const r of rows) {
    if (!r.con) continue;
    const g = m.get(r.con.consignorId) ?? { consignorId: r.con.consignorId, name: r.consignorName, count: 0, payout: 0 };
    g.count += 1; g.payout += r.econ.payout;
    m.set(r.con.consignorId, g);
  }
  return [...m.values()];
}

/** Die Prüfung der Kommissionsartikel vor dem Speichern (das Haus prüft dasselbe noch einmal). */
export function consignmentRowsIssue(
  rows: readonly ConsignmentRow[], buyerId: string, consignorVat: Readonly<Record<string, ConsignorPurchaseTaxScheme>>,
): string | null {
  for (const r of rows) {
    if (!r.con) return 'One of the consignment items is no longer available — remove it and add it again';
    const nr = r.con.consignmentNumber;
    if (r.con.status !== 'active' || r.con.invoiceId) return `${nr} is "${r.con.status}" — only an active consignment is sold`;
    if (!(r.price > 0)) return `${nr}: enter a price above 0`;
    if (buyerId && r.con.consignorId === buyerId) return `${nr}: the customer is the consignor of this item — buyer and consignor must differ`;
    if (r.econ.belowFloor && !r.draft.ack) return `${nr}: sold below the consignor's floor — confirm the Consignor Loss on the line`;
    if (r.vatShortfall !== null && !r.draft.vatAck) return `${nr}: with VAT 10 % the LATAIF result is negative — confirm it on the line`;
  }
  const ohne = consignorGroupsOf(rows).find((g) => !consignorVat[g.consignorId]);
  if (ohne) return `${ohne.name}: choose the VAT of the consignor's purchase — No VAT or VAT 10 %`;
  return null;
}

interface Props {
  drafts: ConsignmentDraft[];
  rows: ConsignmentRow[];
  onDrafts: (next: ConsignmentDraft[]) => void;
  consignorVat: Record<string, ConsignorPurchaseTaxScheme>;
  onConsignorVat: (consignorId: string, v: ConsignorPurchaseTaxScheme) => void;
  customerId: string;
}

export function ConsignmentInvoiceLines({ drafts, rows, onDrafts, consignorVat, onConsignorVat, customerId }: Props) {
  const { consignments } = useConsignmentStore();
  const { customers } = useCustomerStore();
  const { products } = useProductStore();
  const gewaehlt = useMemo(() => new Set(drafts.map((d) => d.consignmentId)), [drafts]);
  // Nur aktive Kommissionen ohne Rechnung; ein Artikel nur einmal je Rechnung.
  const options = useMemo(() => consignments
    .filter((c) => c.status === 'active' && !c.invoiceId && !gewaehlt.has(c.id)
      && !drafts.some((d) => consignments.find((x) => x.id === d.consignmentId)?.productId === c.productId))
    .map((c) => {
      const prod = products.find((p) => p.id === c.productId);
      const k = customers.find((x) => x.id === c.consignorId);
      return {
        id: c.id,
        label: `${c.consignmentNumber} · ${prod ? productDisplayName(prod) : '—'}`,
        subtitle: `Consignor: ${k ? `${k.firstName} ${k.lastName}`.trim() : '—'} · agreed ${(c.agreedPrice || 0).toFixed(3)} BHD`,
        meta: commissionModelLabel(c),
      };
    }), [consignments, products, customers, gewaehlt, drafts]);

  function add(id: string) {
    const c = consignments.find((x) => x.id === id);
    if (!c) return;
    const prod = products.find((p) => p.id === c.productId);
    const scheme = ((prod?.taxScheme as SaleScheme | undefined) || 'MARGIN') as SaleScheme;
    onDrafts([...drafts, { consignmentId: id, priceText: c.agreedPrice ? String(c.agreedPrice) : '', scheme, ack: false, vatAck: false }]);
  }
  // Eine Änderung von Preis oder Steuerart nimmt die Bestätigungen zurück — sie galten für die alten Werte.
  function patch(id: string, p: Partial<ConsignmentDraft>) {
    onDrafts(drafts.map((d) => (d.consignmentId === id ? { ...d, ...p } : d)));
  }
  const groups = consignorGroupsOf(rows);
  const customerIsConsignor = (consignorId: string) => !!customerId && customerId === consignorId;

  return (
    <div style={{ marginTop: 16 }} data-mixed-consignment-section>
      <Card>
        <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
          <span className="text-overline">2b · CONSIGNMENT ITEMS</span>
          <span style={{ fontSize: 11, color: '#6B7280' }}>Admin / Manager · one purchase per consignor, separate from the customer invoice</span>
        </div>
        <div style={{ maxWidth: 520 }} data-mixed-con-add>
          <SearchSelect placeholder="Add a consignment item…" options={options} value="" onChange={(id) => { if (id) add(id); }} />
        </div>
        {rows.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r) => {
              const id = r.draft.consignmentId;
              return (
                <div key={id} data-mixed-con-row={id} style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) 140px 150px 110px 120px 120px 32px', gap: 12, alignItems: 'end' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>
                        <span className="font-mono">{r.con?.consignmentNumber}</span> · Consignor {r.consignorName}{r.con ? ` · ${commissionModelLabel(r.con)}` : ''}
                      </div>
                    </div>
                    <label style={{ fontSize: 10, color: '#6B7280' }}>TAX SCHEME
                      <select className="input" value={r.draft.scheme} data-mixed-con-scheme={id}
                        onChange={(e) => patch(id, { scheme: e.target.value as SaleScheme, vatAck: false })}
                        style={{ width: '100%', marginTop: 4, height: 34, border: '1px solid #D5D9DE', borderRadius: 6, padding: '0 8px', fontSize: 13 }}>
                        {SCHEMES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select>
                    </label>
                    <label style={{ fontSize: 10, color: '#6B7280' }}>PRICE INCL. VAT
                      <input type="number" min="0" step="0.001" value={r.draft.priceText} data-mixed-con-price={id}
                        onChange={(e) => patch(id, { priceText: e.target.value, ack: false, vatAck: false })}
                        style={{ width: '100%', marginTop: 4, height: 34, border: '1px solid #D5D9DE', borderRadius: 6, padding: '0 8px', fontSize: 13, textAlign: 'right' }} />
                    </label>
                    <div style={{ textAlign: 'right', fontSize: 12 }}>
                      <div style={{ fontSize: 10, color: '#6B7280' }}>{r.draft.scheme === 'MARGIN' ? 'MARGIN VAT (INT.)' : 'VAT'}</div>
                      <div className="font-mono" data-mixed-con-vat={id}><Bhd v={r.draft.scheme === 'MARGIN' ? r.internalVat : r.vat}/></div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 12 }}>
                      <div style={{ fontSize: 10, color: '#6B7280' }}>TO CONSIGNOR</div>
                      <div className="font-mono" style={{ color: '#5C8550' }} data-mixed-con-payout={id}><Bhd v={r.econ.payout}/></div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 12 }}>
                      <div style={{ fontSize: 10, color: '#6B7280' }}>LATAIF SHARE</div>
                      <div className="font-mono" style={{ color: r.econ.commission < 0 ? '#DC2626' : '#0F0F10' }} data-mixed-con-share={id}><Bhd v={r.econ.commission}/></div>
                    </div>
                    <button type="button" title="Remove this consignment item" data-mixed-con-remove={id}
                      onClick={() => onDrafts(drafts.filter((d) => d.consignmentId !== id))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', paddingBottom: 6 }}><Trash2 size={15} /></button>
                  </div>
                  {r.con && customerIsConsignor(r.con.consignorId) && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#DC2626' }}>The customer is the consignor of this item — buyer and consignor must differ (use “Return” if the consignor takes it back).</div>
                  )}
                  {r.price > 0 && r.econ.belowFloor && (
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.3)', fontSize: 12, color: '#7A2A2A' }}>
                      <b style={{ color: '#DC2626' }}><Bhd v={r.econ.loss}/> BHD below the consignor's floor</b> — the consignor still receives <Bhd v={r.econ.floor}/> BHD; the difference is booked as Consignor Loss (a separate expense).
                      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={r.draft.ack} data-mixed-con-ack={id} onChange={(e) => patch(id, { ack: e.target.checked })} />
                        <span>I confirm — record this shortfall as Consignor Loss</span>
                      </label>
                    </div>
                  )}
                  {r.vatShortfall !== null && (
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'rgba(198,163,109,0.10)', border: '1px solid rgba(198,163,109,0.45)', fontSize: 12, color: '#5B4A2B' }} data-mixed-con-e7={id}>
                      <b>With VAT 10 % the LATAIF result is <Bhd v={r.vatShortfall}/> BHD</b> — the commission of <Bhd v={r.econ.commission}/> BHD is taken from the price incl. VAT, the VAT of <Bhd v={r.vat}/> BHD is carried by LATAIF.
                      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={r.draft.vatAck} data-mixed-con-vatack={id} onChange={(e) => patch(id, { vatAck: e.target.checked })} />
                        <span>I confirm the negative LATAIF result</span>
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {groups.length > 0 && (
          <div style={{ marginTop: 16 }} data-mixed-consignor-settlement>
            <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>CONSIGNOR SETTLEMENT</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {groups.map((g) => (
                <div key={g.consignorId} data-mixed-consignor={g.consignorId}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                  <div style={{ fontSize: 13 }}>
                    <div style={{ color: '#0F0F10' }}>{g.name}</div>
                    <div style={{ fontSize: 11, color: '#6B7280' }}>{g.count} item{g.count === 1 ? '' : 's'} · new consignor purchase <Bhd v={g.payout}/> BHD (unpaid)</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ color: '#6B7280', marginRight: 4 }}>Purchase VAT *</span>
                    {(['ZERO', 'VAT_10'] as const).map((v) => (
                      <button key={v} type="button" data-mixed-consignor-vat={`${g.consignorId}:${v}`}
                        onClick={() => onConsignorVat(g.consignorId, v)}
                        style={{
                          padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                          border: consignorVat[g.consignorId] === v ? '1px solid #0F0F10' : '1px solid #D5D9DE',
                          background: consignorVat[g.consignorId] === v ? '#0F0F10' : '#FFFFFF',
                          color: consignorVat[g.consignorId] === v ? '#FFFFFF' : '#0F0F10',
                        }}>{v === 'ZERO' ? 'No VAT' : 'VAT 10 %'}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
              VAT 10 % only if the consignor delivers taxably and issues a valid tax invoice. The resale tax of the items stays your choice per line.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
