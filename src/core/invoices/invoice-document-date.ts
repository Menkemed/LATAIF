// ════════════════════════════════════════════════════════════════════════════
// INVOICE-DOCUMENT-DATE — welches Datum eine Rechnung in Liste, Detailseite, PDF/Beleg und CSV trägt
// (nur Anzeige, nichts wird gespeichert). Eine Stelle für alle, damit sie nie auseinanderlaufen.
//
// • Endrechnung mit festgehaltenem Datum (`finalIssuedAt`, gesetzt bei der ersten Vollzahlung):
//   dieses — auch wenn sie später wieder auf „teilbezahlt" fällt; sie trägt ja ihre Endnummer.
// • Endrechnung von vor diesem Vertrag (FINAL, ohne festgehaltenes Datum): der Tag der Vollzahlung,
//   berechnet wie im NBR-Export (spätestes `received_at`; ohne Zahlungszeilen der Rechnungstag).
//   In der Datenbank wird dafür nichts geändert.
// • Sonst (vorläufig, teilbezahlt, Entwurf …): der Rechnungstag (`issued_at`, sonst `created_at`).
// `issued` bleibt der Rechnungstag der vorläufigen Rechnung — zum Anzeigen, wenn er abweicht.
// ════════════════════════════════════════════════════════════════════════════
import { finalizationDate, type DatedPayment } from './finalization-date.ts';
import type { Invoice } from '@/core/models/types';

export interface InvoiceDocumentDate {
  /** Das Datum, das die Rechnung zeigt (ISO). */
  date: string;
  /** 'final' = Datum der Endrechnung (Tag der Vollzahlung); 'issued' = Rechnungstag. */
  kind: 'final' | 'issued';
  /** true = festgehalten bei der ersten Vollzahlung; false = berechnet (Altbestand) bzw. Rechnungstag. */
  fixed: boolean;
  /** Der Rechnungstag der vorläufigen Rechnung. */
  issued: string;
  /** true, wenn Datum und Rechnungstag auf verschiedene Kalendertage fallen. */
  differs: boolean;
}

const day = (iso: string): string => String(iso || '').slice(0, 10);

export function invoiceDocumentDate(
  inv: Pick<Invoice, 'status' | 'issuedAt' | 'createdAt' | 'finalIssuedAt'>,
  payments?: readonly DatedPayment[],
): InvoiceDocumentDate {
  const issued = inv.issuedAt || inv.createdAt || '';
  if (!inv.finalIssuedAt && inv.status !== 'FINAL') return { date: issued, kind: 'issued', fixed: false, issued, differs: false };
  const date = finalizationDate(inv, payments);
  return { date, kind: 'final', fixed: !!inv.finalIssuedAt, issued, differs: day(date) !== day(issued) };
}
