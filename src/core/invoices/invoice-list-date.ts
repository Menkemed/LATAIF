// ════════════════════════════════════════════════════════════════════════════
// INVOICE-LIST-DATE — welches Datum die Rechnungsliste zeigt (nur Anzeige, nichts wird gespeichert).
//
// • Vorläufige/offene Rechnung (Status ≠ FINAL): ihr Rechnungstag (`issued_at`, sonst `created_at`).
// • Endrechnung (FINAL): der Tag der Vollzahlung — DIESELBE Quelle wie NBR-Export und VAT-Periodensperre
//   (`invoiceFinalizationDate`: spätestes tatsächliches Zahlungsdatum `received_at`, nicht der Eingabetag;
//   ohne Zahlungszeilen der Rechnungstag). So zeigen Liste, NBR und Sperre denselben Tag.
//   Der Rechnungstag bleibt sichtbar daneben (`issued`), weil PDF und Detailseite weiterhin ihn drucken.
// Keine Änderung an Rechnung, Zahlung, Buchung oder VAT; historische Endrechnungen bleiben, wie sie sind.
// ════════════════════════════════════════════════════════════════════════════
import { invoiceFinalizationDate, type NbrPayment } from '../tax/nbr-export.ts';
import type { Invoice } from '@/core/models/types';

export interface InvoiceListDate {
  /** Das Datum der Zeile (ISO). */
  date: string;
  /** 'final' = Tag der Vollzahlung (wie NBR); 'issued' = Rechnungstag. */
  kind: 'final' | 'issued';
  /** Der Rechnungstag (wie PDF/Detailseite) — zum Vergleich. */
  issued: string;
  /** true, wenn Tag der Vollzahlung und Rechnungstag auf verschiedene Kalendertage fallen. */
  differs: boolean;
}

const day = (iso: string): string => String(iso || '').slice(0, 10);

export function invoiceListDate(inv: Pick<Invoice, 'status' | 'issuedAt' | 'createdAt'>, payments?: readonly NbrPayment[]): InvoiceListDate {
  const issued = inv.issuedAt || inv.createdAt || '';
  if (inv.status !== 'FINAL') return { date: issued, kind: 'issued', issued, differs: false };
  const fin = invoiceFinalizationDate(inv as Invoice, payments ? [...payments] : undefined);
  return { date: fin, kind: 'final', issued, differs: day(fin) !== day(issued) };
}
