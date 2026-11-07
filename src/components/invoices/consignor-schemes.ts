// VAT-CONSISTENCY (v0.8.99) — welche Einkaufs-VAT der Einlieferer-Einkauf jedes Kommissionsartikels der Rechnungsmaske trägt.
// Eigene Datei (kein Komponentenmodul), damit `ConsignmentInvoiceLines.tsx` nur Komponenten und die bisherigen Helfer exportiert.
import { useMemo } from 'react';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import type { ConsignorPurchaseTaxScheme } from '@/core/consignment/consignment-finance';
import type { Purchase } from '@/core/models/types';
import type { ConsignmentDraft } from './ConsignmentInvoiceLines';

/**
 * Die Einkaufs-VAT, mit der der Einlieferer-Einkauf jedes Kommissionsartikels gebucht wird (oder würde): beim Anlegen die Wahl
 * je Einlieferer; beim Korrigieren die des Einkaufs, an dem die Kommission hängt (mit der Wahl in der Maske), für eine neue
 * Kommission die des unbezahlten Einkaufs desselben Einlieferers, sonst die Wahl. Ungewählt fehlt der Eintrag (Vorschau dann
 * ohne VAT). Daraus rechnet die Maske den Einstand (`consignorLotCost`) und die Margen-VAT; das Haus rechnet mit dem Los.
 */
export function useConsignorSchemes(
  drafts: readonly ConsignmentDraft[], consignorVat: Readonly<Record<string, ConsignorPurchaseTaxScheme>>,
  purchaseVat: Readonly<Record<string, 'ZERO' | 'VAT_10'>>, edit: boolean,
): Record<string, 'ZERO' | 'VAT_10'> {
  const { consignments } = useConsignmentStore();
  const { purchases } = usePurchaseStore();
  return useMemo(() => {
    const out: Record<string, 'ZERO' | 'VAT_10'> = {};
    const schemeOf = (p: Purchase, cid?: string): 'ZERO' | 'VAT_10' => purchaseVat[p.id]
      ?? ((p.lines.find((l) => l.sourceConsignmentId === cid) ?? p.lines[0])?.taxScheme === 'VAT_10' ? 'VAT_10' : 'ZERO');
    const ofCon = (cid: string): Purchase | undefined => purchases
      .filter((p) => p.status !== 'CANCELLED' && (p.sourceConsignmentId === cid || p.lines.some((l) => l.sourceConsignmentId === cid)))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop();
    const gebunden = edit ? drafts.map((d) => ofCon(d.consignmentId)).filter((p): p is Purchase => !!p) : [];
    for (const d of drafts) {
      const con = consignments.find((c) => c.id === d.consignmentId);
      if (!con) continue;
      const eigen = edit ? ofCon(con.id) : undefined;
      const ziel = eigen ?? gebunden.find((p) => (Number(p.paidAmount) || 0) <= 0.0005 && (p.payments ?? []).length === 0
        && p.lines.some((l) => consignments.some((c) => c.id === l.sourceConsignmentId && c.consignorId === con.consignorId)));
      const v = ziel ? schemeOf(ziel, con.id) : consignorVat[con.consignorId];
      if (v) out[con.id] = v;
    }
    return out;
  }, [drafts, consignments, purchases, consignorVat, purchaseVat, edit]);
}
