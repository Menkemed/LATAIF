// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P3 — Kommissionsartikel auf der Rechnung „Direct Sale" (nur ADMIN/MANAGER): je Artikel Preis inkl. VAT,
// Steuerart, VAT, Auszahlung an den Einlieferer und LATAIF-Anteil; Unterdeckung und E7 je Zeile ausdrücklich bestätigt;
// je Einlieferer EIN Einkauf mit seiner Einkaufs-VAT (Pflichtwahl, nichts vorbelegt — D2).
// Gerechnet wird mit DENSELBEN Funktionen wie die Buchung: `computeConsignmentSale` (Ökonomie), `consignmentLineAmounts`
// (Zeile) und `consignmentVatShortfall` (E7) — die Vorschau ist, was gebucht wird.
//
// MIXED-INVOICE P4 — dieselbe Karte beim ÄNDERN einer Rechnung mit Kommissionszeilen: die gebundenen Kommissionen stehen
// als bleibende Zeilen (Preis, Steuerart korrigierbar; entfernen = zurück auf Active, E5), neue kommen dazu (E6). Je
// Einlieferer-Einkauf dieses Verkaufs: Zahlungsstand, Einkaufs-VAT (nur vor der ersten Auszahlung, E10) und — wenn dem
// schon bezahlten Einlieferer weniger zusteht — die Pflichtwahl Guthaben oder Rückforderung (E2). Das Haus
// (`correctMixedInvoiceInHouse`) prüft und rechnet alles noch einmal; die Karte schätzt, um zu zeigen und zu fragen.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo } from 'react';
import { Trash2, RotateCcw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { Bhd } from '@/components/ui/Bhd';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { commissionModelLabel, computeConsignmentSale, type ConsignmentSaleResult } from '@/core/consignment/economics';
import {
  consignmentLineAmounts, consignmentVatShortfall, consignorPurchaseAmount, type ConsignorOverpayChoice, type SaleScheme,
} from '@/core/invoices/mixed-invoice';
import type { ConsignorPurchaseTaxScheme } from '@/core/consignment/consignment-finance';
import { productDisplayName } from '@/core/products/display-name';
import type { Consignment, Purchase } from '@/core/models/types';

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
  /** P4 — die Zeile steht schon auf der Rechnung: Preis und Steuerart, wie gespeichert. */
  kept?: { salePrice: number; scheme: SaleScheme };
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
  /** E7: negatives LATAIF-Ergebnis unter VAT 10 % (sonst null) — bei einer bleibenden Zeile nur, wenn sie sich ändert. */
  vatShortfall: number | null;
  /** P4 — Preis oder Steuerart einer bleibenden Zeile geändert (eine neue Zeile ist immer „geändert"). */
  changed: boolean;
  /** Unterdeckung zu bestätigen (nur bei neuem oder geändertem Preis). */
  needsAck: boolean;
  /** Was der Einkauf beim Einlieferer für diesen Verkauf trägt. */
  purchaseAmount: number;
}

const SCHEMES: Array<{ id: SaleScheme; label: string }> = [
  { id: 'MARGIN', label: 'Margin' }, { id: 'VAT_10', label: 'VAT 10 %' }, { id: 'ZERO', label: 'Zero-rated' },
];
const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

/** Die gerechneten Zeilen der Kommissionsartikel. `edit`: die Regel der Korrektur (Margen-Basis = Auszahlung, wie das Haus). */
export function useConsignmentInvoiceRows(drafts: readonly ConsignmentDraft[], edit = false): ConsignmentRow[] {
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
    // Dieselbe Quelle wie die Buchung: beim Anlegen der Einkaufspreis des Artikels, sonst die Auszahlung (G4 unverändert);
    // beim Korrigieren die Auszahlung (der Einkaufspreis des Artikels ist dann schon der des alten Verkaufs).
    const purchasePrice = edit ? econ.payout : (prod?.purchasePrice || econ.payout);
    const a = price > 0 ? consignmentLineAmounts(price, d.scheme, purchasePrice) : null;
    const persisted = a ? a.persistedVat : 0;
    const priceChanged = !d.kept || !same(d.kept.salePrice, price);
    const changed = priceChanged || d.kept!.scheme !== d.scheme;
    return {
      draft: d, con,
      label: prod ? productDisplayName(prod) : (con?.consignmentNumber ?? d.consignmentId),
      consignorName: consignor ? `${consignor.firstName} ${consignor.lastName}`.trim() : '—',
      price, econ,
      net: a ? a.calc.netAmount : 0,
      vat: a ? a.calc.vatAmount : 0,
      internalVat: d.scheme === 'MARGIN' ? persisted : 0,
      gross: a ? a.calc.grossAmount : 0,
      vatShortfall: price > 0 && changed ? consignmentVatShortfall(econ, d.scheme, persisted) : null,
      changed,
      needsAck: price > 0 && econ.belowFloor && priceChanged,
      purchaseAmount: consignorPurchaseAmount(econ, price),
    };
  }), [drafts, consignments, customers, products, edit]);
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

// ── P4 — die Einlieferer-Seite einer Korrektur (Schätzung für die Maske; das Haus entscheidet) ─────────────────

/** Ein Einlieferer-Einkauf dieses Verkaufs, wie die Korrektur ihn ändern würde. */
export interface CorrectionPurchase {
  id: string;
  number: string;
  revision: number;
  consignorId: string;
  consignorName: string;
  total: number;
  /** Bar und per Guthaben bezahlt. */
  paid: number;
  remaining: number;
  scheme: 'ZERO' | 'VAT_10';
  /** Die gespeicherte Einkaufs-VAT (vor einer Wahl in der Maske). */
  originalScheme: 'ZERO' | 'VAT_10';
  /** Schon einmal (auch storniert) bezahlt — dann ist die Einkaufs-VAT fest (E10). */
  everPaid: boolean;
  /** Der Einkauf nach der Korrektur (geschätzt). */
  newTotal: number;
  /** Was ein bezahlter Einlieferer zurückschuldet (Rückgabe einer Zeile oder Minderung) — > 0 ⇒ Pflichtwahl E2. */
  owedBack: number;
  /** Kommissionen dieses Einkaufs, die die Rechnung verlassen. */
  removed: string[];
  /** Neue Kommissionen, die an diesen (unbezahlten) Einkauf kommen. */
  appended: string[];
}

export interface CorrectionPlan {
  purchases: CorrectionPurchase[];
  /** Neue Kommissionen ohne unbezahlten Einkauf ihres Einlieferers ⇒ neuer Einkauf mit Pflichtwahl der Einkaufs-VAT. */
  newPurchases: Array<{ consignorId: string; name: string; count: number; payout: number }>;
  /** Gebundene Kommissionen, die die Rechnung verlassen (zurück auf Active). */
  removed: Consignment[];
  /** Die gesehenen Fassungen der Einkäufe dieses Verkaufs. */
  purchaseRevisions: Record<string, number>;
  /** E5/E9 — Kommissionen, deren schon bezahlte Verlust-Ausgabe den neuen Verlust übersteigt (Pflichtwahl). */
  lossOverpays: Array<{ consignmentId: string; number: string; consignorName: string; paid: number; newLoss: number; overpay: number }>;
  /** Kommissionen mit schon (teil)bezahlter Verlust-Ausgabe (für die Nachfrage, wenn das Haus eine Wahl verlangt). */
  paidLosses: string[];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
function paidOf(p: Purchase): number {
  const credit = (p.payments ?? []).filter((x) => x.method === 'credit' && !x.voidedAt).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return r3((Number(p.paidAmount) || 0) + credit);
}

/** Die Einlieferer-Seite der Korrektur — dieselbe Reihenfolge wie das Haus (entfernen, ändern, anhängen, neu). */
export function useConsignmentCorrectionPlan(
  bound: readonly Consignment[], rows: readonly ConsignmentRow[], purchaseVat: Readonly<Record<string, 'ZERO' | 'VAT_10'>>,
): CorrectionPlan {
  const { purchases } = usePurchaseStore();
  const { customers } = useCustomerStore();
  const { expenses } = useExpenseStore();
  return useMemo(() => {
    const name = (id: string): string => { const k = customers.find((x) => x.id === id); return k ? `${k.firstName} ${k.lastName}`.trim() : '—'; };
    const ofCon = (cid: string): Purchase | undefined => purchases
      .filter((p) => p.status !== 'CANCELLED' && (p.sourceConsignmentId === cid || p.lines.some((l) => l.sourceConsignmentId === cid)))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop();
    const rowById = new Map(rows.map((r) => [r.draft.consignmentId, r]));
    const boundIds = new Set(bound.map((c) => c.id));
    const plans = new Map<string, CorrectionPurchase>();
    const linien = new Map<string, Purchase>();
    for (const c of bound) {
      const p = ofCon(c.id);
      if (!p) continue;
      linien.set(p.id, p);
      if (!plans.has(p.id)) {
        const paid = paidOf(p);
        const gespeichert: 'ZERO' | 'VAT_10' = p.lines[0]?.taxScheme === 'VAT_10' ? 'VAT_10' : 'ZERO';
        plans.set(p.id, {
          originalScheme: gespeichert,
          id: p.id, number: p.purchaseNumber, revision: Number((p as Purchase & { revision?: number }).revision ?? 0), consignorId: c.consignorId,
          consignorName: name(c.consignorId), total: r3(p.totalAmount), paid, remaining: r3(p.remainingAmount),
          scheme: (p.lines[0]?.taxScheme === 'VAT_10' ? 'VAT_10' : 'ZERO'),
          everPaid: paid > 0.0005 || (p.payments ?? []).length > 0, newTotal: 0, owedBack: 0, removed: [], appended: [],
        });
      }
      if (!rowById.has(c.id)) plans.get(p.id)!.removed.push(c.id);
    }
    // Neue Zeilen: an den ersten unbezahlten Einkauf desselben Einlieferers, der nicht ganz geht; sonst neuer Einkauf.
    const neu = new Map<string, { consignorId: string; name: string; count: number; payout: number }>();
    for (const r of rows) {
      if (!r.con || boundIds.has(r.con.id)) continue;
      const ziel = [...plans.values()].find((x) => x.consignorId === r.con!.consignorId && !x.everPaid
        && x.removed.length < (linien.get(x.id)?.lines.length ?? 0));
      if (ziel) { ziel.appended.push(r.con.id); continue; }
      const g = neu.get(r.con.consignorId) ?? { consignorId: r.con.consignorId, name: r.consignorName, count: 0, payout: 0 };
      g.count += 1; g.payout = r3(g.payout + r.purchaseAmount);
      neu.set(r.con.consignorId, g);
    }
    for (const plan of plans.values()) {
      const p = linien.get(plan.id)!;
      let total = 0;
      let offen = plan.remaining;
      let zurueck = 0;
      const ganz = p.lines.length === 1;
      for (const l of p.lines) {
        const c = l.sourceConsignmentId ? bound.find((b) => b.id === l.sourceConsignmentId)
          : ganz && p.sourceConsignmentId ? bound.find((b) => b.id === p.sourceConsignmentId)
          : bound.find((b) => b.productId === l.productId);
        if (c && plan.removed.includes(c.id)) {
          if (plan.paid > 0.0005) { zurueck += ganz ? plan.paid : Math.max(0, l.lineTotal - offen); offen = Math.max(0, offen - l.lineTotal); }
          continue;
        }
        const r = c ? rowById.get(c.id) : undefined;
        total += r && r.changed ? r.purchaseAmount : l.lineTotal;
      }
      for (const cid of plan.appended) total += rowById.get(cid)?.purchaseAmount ?? 0;
      plan.newTotal = r3(total);
      const minderung = plan.removed.length === 0 && plan.paid > total + 0.0005 ? plan.paid - total : 0;
      plan.owedBack = r3(zurueck + minderung);
      if (purchaseVat[plan.id]) plan.scheme = purchaseVat[plan.id];
    }
    // E5/E9 — die Verlust-Ausgaben jeder gebundenen Kommission: bezahlt, und was nach der Korrektur noch zusteht.
    const lossOverpays: CorrectionPlan['lossOverpays'] = [];
    const paidLosses: string[] = [];
    for (const c of bound) {
      const ls = expenses.filter((e) => e.category === 'ConsignorLoss' && e.relatedEntityId === c.id && e.status !== 'CANCELLED');
      const paid = r3(ls.reduce((x, e) => x + (Number(e.paidAmount) || 0), 0));
      if (paid <= 0.0005) continue;
      paidLosses.push(c.id);
      const r = rowById.get(c.id);
      const alt = r3(ls.reduce((x, e) => x + (Number(e.amount) || 0), 0));
      const newLoss = !r ? 0 : r.changed ? r3(r.econ.loss) : alt;
      if (paid > newLoss + 0.0005) {
        lossOverpays.push({ consignmentId: c.id, number: c.consignmentNumber, consignorName: name(c.consignorId), paid, newLoss, overpay: r3(paid - newLoss) });
      }
    }
    return {
      lossOverpays, paidLosses,
      purchases: [...plans.values()],
      newPurchases: [...neu.values()],
      removed: bound.filter((c) => !rowById.has(c.id)),
      purchaseRevisions: Object.fromEntries([...plans.values()].map((p) => [p.id, p.revision])),
    };
  }, [bound, rows, purchases, customers, purchaseVat, expenses]);
}

/** Die Prüfung der Kommissionsartikel vor dem Speichern (das Haus prüft dasselbe noch einmal). */
export function consignmentRowsIssue(
  rows: readonly ConsignmentRow[], buyerId: string, consignorVat: Readonly<Record<string, ConsignorPurchaseTaxScheme>>,
  edit?: { plan: CorrectionPlan; overpay: Readonly<Record<string, ConsignorOverpayChoice>>; invoiceId: string; lossOverpay?: Readonly<Record<string, ConsignorOverpayChoice>> },
): string | null {
  for (const r of rows) {
    if (!r.con) return 'One of the consignment items is no longer available — remove it and add it again';
    const nr = r.con.consignmentNumber;
    const bleibt = !!r.draft.kept && !!edit && r.con.invoiceId === edit.invoiceId;
    if (!bleibt && (r.con.status !== 'active' || r.con.invoiceId)) return `${nr} is "${r.con.status}" — only an active consignment is sold`;
    if (bleibt && r.con.status !== 'sold' && r.changed) return `${nr} is "${r.con.status}" — a returned item stays on its invoice as it is`;
    if (!(r.price > 0)) return `${nr}: enter a price above 0`;
    if (buyerId && r.con.consignorId === buyerId) return `${nr}: the customer is the consignor of this item — buyer and consignor must differ`;
    if (r.needsAck && !r.draft.ack) return `${nr}: sold below the consignor's floor — confirm the Consignor Loss on the line`;
    if (r.vatShortfall !== null && !r.draft.vatAck) return `${nr}: with VAT 10 % the LATAIF result is negative — confirm it on the line`;
  }
  if (edit) {
    const ohne = edit.plan.newPurchases.find((g) => !consignorVat[g.consignorId]);
    if (ohne) return `${ohne.name}: choose the VAT of the consignor's new purchase — No VAT or VAT 10 %`;
    const offen = edit.plan.purchases.find((p) => p.owedBack > 0.0005 && !edit.overpay[p.id]);
    if (offen) return `${offen.consignorName}: he was already paid more than he is now owed — choose consignor credit or reclaim (purchase ${offen.number})`;
    const verlust = edit.plan.lossOverpays.find((l) => !edit.lossOverpay?.[l.consignmentId]);
    if (verlust) return `${verlust.number}: the consignor's loss was already paid — choose consignor credit or reclaim`;
    return null;
  }
  const ohne = consignorGroupsOf(rows).find((g) => !consignorVat[g.consignorId]);
  if (ohne) return `${ohne.name}: choose the VAT of the consignor's purchase — No VAT or VAT 10 %`;
  return null;
}

/** P4 — was die Karte beim Ändern zusätzlich braucht. */
export interface ConsignmentEditProps {
  invoiceId: string;
  plan: CorrectionPlan;
  purchaseVat: Record<string, 'ZERO' | 'VAT_10'>;
  onPurchaseVat: (purchaseId: string, v: 'ZERO' | 'VAT_10') => void;
  overpay: Record<string, ConsignorOverpayChoice>;
  onOverpay: (purchaseId: string, v: ConsignorOverpayChoice) => void;
  /** E5/E9 — die Wahl je Kommission für eine überzahlte Verlust-Ausgabe. */
  lossOverpay: Record<string, ConsignorOverpayChoice>;
  onLossOverpay: (consignmentId: string, v: ConsignorOverpayChoice) => void;
  /** Eine entfernte Kommission bleibt doch auf der Rechnung (Preis und Steuerart wie gespeichert). */
  onKeep: (c: Consignment) => void;
  /** Das Haus hat eine Wahl verlangt, die die Schätzung nicht sah: für jeden bezahlten Einkauf fragen. */
  askAllPaid?: boolean;
}

interface Props {
  drafts: ConsignmentDraft[];
  rows: ConsignmentRow[];
  onDrafts: (next: ConsignmentDraft[]) => void;
  consignorVat: Record<string, ConsignorPurchaseTaxScheme>;
  onConsignorVat: (consignorId: string, v: ConsignorPurchaseTaxScheme) => void;
  customerId: string;
  edit?: ConsignmentEditProps;
}

const knopf = (an: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
  border: an ? '1px solid #0F0F10' : '1px solid #D5D9DE', background: an ? '#0F0F10' : '#FFFFFF', color: an ? '#FFFFFF' : '#0F0F10',
});

export function ConsignmentInvoiceLines({ drafts, rows, onDrafts, consignorVat, onConsignorVat, customerId, edit }: Props) {
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
                <div key={id} data-mixed-con-row={id} data-mixed-con-kept={r.draft.kept ? '1' : '0'} style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) 140px 150px 110px 120px 120px 32px', gap: 12, alignItems: 'end' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>
                        <span className="font-mono">{r.con?.consignmentNumber}</span> · Consignor {r.consignorName}{r.con ? ` · ${commissionModelLabel(r.con)}` : ''}
                        {edit && (r.draft.kept
                          ? <span style={{ marginLeft: 6, color: r.changed ? '#B45309' : '#6B7280' }}>· on this invoice{r.changed ? ` (was ${r.draft.kept.salePrice.toFixed(3)})` : ''}</span>
                          : <span style={{ marginLeft: 6, color: '#2563EB' }}>· new on this invoice</span>)}
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
                    <button type="button" title={r.draft.kept ? 'Remove from this invoice (entry error — the consignment goes back to Active)' : 'Remove this consignment item'} data-mixed-con-remove={id}
                      onClick={() => onDrafts(drafts.filter((d) => d.consignmentId !== id))}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', paddingBottom: 6 }}><Trash2 size={15} /></button>
                  </div>
                  {r.con && customerIsConsignor(r.con.consignorId) && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#DC2626' }}>The customer is the consignor of this item — buyer and consignor must differ (use “Return” if the consignor takes it back).</div>
                  )}
                  {r.price > 0 && r.econ.belowFloor && r.needsAck && (
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
        {edit && edit.plan.removed.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }} data-mixed-con-removed-list>
            {edit.plan.removed.map((c) => {
              const prod = products.find((p) => p.id === c.productId);
              return (
                <div key={c.id} data-mixed-con-removed={c.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderRadius: 8, border: '1px dashed #D5D9DE', fontSize: 12, color: '#6B7280' }}>
                  <span><span className="font-mono">{c.consignmentNumber}</span> · {prod ? productDisplayName(prod) : '—'} — leaves this invoice (entry error): the consignment goes back to Active, the consignor's purchase line is undone. A real return stays “Post-Sale Return”.</span>
                  <button type="button" data-mixed-con-keep={c.id} onClick={() => edit.onKeep(c)}
                    style={{ ...knopf(false), display: 'inline-flex', alignItems: 'center', gap: 6 }}><RotateCcw size={13} /> Keep on invoice</button>
                </div>
              );
            })}
          </div>
        )}
        {!edit && groups.length > 0 && (
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
                        style={knopf(consignorVat[g.consignorId] === v)}>{v === 'ZERO' ? 'No VAT' : 'VAT 10 %'}</button>
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
        {edit && (edit.plan.purchases.length > 0 || edit.plan.newPurchases.length > 0 || edit.plan.lossOverpays.length > 0) && (
          <div style={{ marginTop: 16 }} data-mixed-consignor-settlement>
            <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>CONSIGNOR SETTLEMENT</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {edit.plan.purchases.map((p) => {
                const vat = edit.purchaseVat[p.id] ?? p.scheme;
                const fragen = p.owedBack > 0.0005 || (!!edit.askAllPaid && p.paid > 0.0005);
                return (
                  <div key={p.id} data-mixed-purchase={p.id} style={{ padding: '10px 12px', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ fontSize: 13 }}>
                        <div style={{ color: '#0F0F10' }}>{p.consignorName} · <span className="font-mono">{p.number}</span></div>
                        <div style={{ fontSize: 11, color: '#6B7280' }} data-mixed-purchase-state={p.id}>
                          purchase <Bhd v={p.total}/> BHD · {p.paid > 0.0005 ? <>paid <Bhd v={p.paid}/></> : 'unpaid'}
                          {Math.abs(p.newTotal - p.total) > 0.0005 && <> · after this correction <b><Bhd v={p.newTotal}/></b> BHD</>}
                          {p.appended.length > 0 && <> · {p.appended.length} new item{p.appended.length === 1 ? '' : 's'} added to it</>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <span style={{ color: '#6B7280', marginRight: 4 }}>Purchase VAT{p.everPaid ? ' (fixed after payout)' : ''}</span>
                        {(['ZERO', 'VAT_10'] as const).map((v) => (
                          <button key={v} type="button" data-mixed-purchase-vat={`${p.id}:${v}`} disabled={p.everPaid && v !== vat}
                            onClick={() => { if (!p.everPaid) edit.onPurchaseVat(p.id, v); }}
                            style={{ ...knopf(vat === v), opacity: p.everPaid && v !== vat ? 0.4 : 1, cursor: p.everPaid ? 'default' : 'pointer' }}>{v === 'ZERO' ? 'No VAT' : 'VAT 10 %'}</button>
                        ))}
                      </div>
                    </div>
                    {fragen && (
                      <div data-mixed-overpay={p.id} style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'rgba(37,99,235,0.05)', border: '1px solid rgba(37,99,235,0.25)', fontSize: 12, color: '#1E3A8A' }}>
                        <div style={{ marginBottom: 6 }}>
                          {p.consignorName} was already paid {p.owedBack > 0.0005 ? <><b><Bhd v={p.owedBack}/> BHD</b> more</> : 'more'} than he is now owed. Historical payments stay. Choose:
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" data-mixed-overpay-choice={`${p.id}:credit`} onClick={() => edit.onOverpay(p.id, 'credit')} style={knopf(edit.overpay[p.id] === 'credit')}>Consignor credit (offset later)</button>
                          <button type="button" data-mixed-overpay-choice={`${p.id}:refund`} onClick={() => edit.onOverpay(p.id, 'refund')} style={knopf(edit.overpay[p.id] === 'refund')}>Reclaim from consignor</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {/* E5/E9 (Owner) — eine schon bezahlte Verlust-Ausgabe übersteigt den neuen Verlust: Guthaben oder Rückforderung. */}
              {[...edit.plan.lossOverpays, ...(edit.askAllPaid
                ? edit.plan.paidLosses.filter((id) => !edit.plan.lossOverpays.some((l) => l.consignmentId === id))
                  .map((id) => ({ consignmentId: id, number: consignments.find((c) => c.id === id)?.consignmentNumber ?? id, consignorName: '', paid: 0, newLoss: 0, overpay: 0 }))
                : [])].map((l) => (
                <div key={`loss-${l.consignmentId}`} data-mixed-loss-overpay={l.consignmentId}
                  style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(37,99,235,0.05)', border: '1px solid rgba(37,99,235,0.25)', fontSize: 12, color: '#1E3A8A' }}>
                  <div style={{ marginBottom: 6 }}>
                    <span className="font-mono">{l.number}</span> · the consignor's guarantee shortfall was already paid
                    {l.overpay > 0.0005 ? <> (<Bhd v={l.paid}/> BHD) — <b><Bhd v={l.overpay}/> BHD</b> more than he is now owed</> : ' — more than he is now owed'}.
                    The payment stays. Choose:
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" data-mixed-loss-overpay-choice={`${l.consignmentId}:credit`} onClick={() => edit.onLossOverpay(l.consignmentId, 'credit')} style={knopf(edit.lossOverpay[l.consignmentId] === 'credit')}>Consignor credit (offset later)</button>
                    <button type="button" data-mixed-loss-overpay-choice={`${l.consignmentId}:refund`} onClick={() => edit.onLossOverpay(l.consignmentId, 'refund')} style={knopf(edit.lossOverpay[l.consignmentId] === 'refund')}>Reclaim from consignor</button>
                  </div>
                </div>
              ))}
              {edit.plan.newPurchases.map((g) => (
                <div key={g.consignorId} data-mixed-consignor={g.consignorId}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                  <div style={{ fontSize: 13 }}>
                    <div style={{ color: '#0F0F10' }}>{g.name}</div>
                    <div style={{ fontSize: 11, color: '#6B7280' }}>{g.count} new item{g.count === 1 ? '' : 's'} · new consignor purchase <Bhd v={g.payout}/> BHD (unpaid)</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ color: '#6B7280', marginRight: 4 }}>Purchase VAT *</span>
                    {(['ZERO', 'VAT_10'] as const).map((v) => (
                      <button key={v} type="button" data-mixed-consignor-vat={`${g.consignorId}:${v}`}
                        onClick={() => onConsignorVat(g.consignorId, v)} style={knopf(consignorVat[g.consignorId] === v)}>{v === 'ZERO' ? 'No VAT' : 'VAT 10 %'}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
              An unpaid consignor purchase follows the correction (amount, VAT, date); a paid one keeps its date and payments. A new item goes to the consignor's unpaid purchase of this sale, otherwise to a new purchase.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
