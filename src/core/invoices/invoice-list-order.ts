// ════════════════════════════════════════════════════════════════════════════
// INVOICE-LIST-ORDER — die Reihenfolge der Rechnungsübersicht (nur Anzeige, nichts wird gespeichert).
//
// Vorher kam die Liste in der Ladereihenfolge der Datenbank (`created_at` absteigend), gezeigt wird aber
// das Belegdatum aus `invoiceDocumentDate` (Endrechnung: Endrechnungsdatum `final_issued_at`, Altbestand
// berechnet aus den Zahlungen; sonst der Rechnungstag). Eine später angelegte Rechnung mit früherem
// Datum — oder eine Endrechnung, deren Datum erst bei der Vollzahlung entsteht — stand dadurch an der
// falschen Stelle (17 → 16 → 17 → 14 → 12 → 15 Nov).
//
// Regel:
//   1. Der KALENDERTAG, den die Zeile zeigt (dieselbe Ortszeit-Umrechnung wie die Anzeige), absteigend.
//   2. Gleicher Tag: `created_at` absteigend (die bisherige Reihenfolge innerhalb des Tages).
//   3. Danach die `id` — damit die Reihenfolge bei völlig gleichen Werten fest bleibt.
// Ein fehlendes oder ungültiges Datum steht am Ende.
// ════════════════════════════════════════════════════════════════════════════
import { invoiceDocumentDate } from './invoice-document-date.ts';
import type { DatedPayment } from './finalization-date.ts';
import type { Invoice } from '@/core/models/types';

export type ListOrderInvoice = Pick<Invoice, 'id' | 'status' | 'issuedAt' | 'createdAt' | 'finalIssuedAt'>;

/** Der angezeigte Kalendertag als Zahl JJJJMMTT (Ortszeit, wie `toLocaleDateString`); ohne gültiges Datum -1. */
export function displayedDayKey(iso: string | null | undefined): number {
  if (!iso) return -1;
  const d = new Date(iso);
  const t = d.getTime();
  if (!Number.isFinite(t)) return -1;
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

const desc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

/**
 * Sortiert eine (schon gefilterte) Rechnungsliste nach dem angezeigten Datum, neueste zuerst.
 * `paymentsOf` liefert dieselben Zahlungen, mit denen die Zeile ihr Datum zeigt (Altbestand-Endrechnungen).
 * Gibt ein neues Feld zurück; die Eingabe bleibt unverändert.
 */
export function sortInvoicesByDisplayedDate<T extends ListOrderInvoice>(
  invoices: readonly T[],
  paymentsOf: (invoiceId: string) => readonly DatedPayment[] | undefined,
): T[] {
  const keyed = invoices.map((inv) => ({
    inv,
    day: displayedDayKey(invoiceDocumentDate(inv, paymentsOf(inv.id)).date),
    created: String(inv.createdAt || ''),
    id: String(inv.id || ''),
  }));
  keyed.sort((a, b) => (b.day - a.day) || desc(a.created, b.created) || desc(a.id, b.id));
  return keyed.map((k) => k.inv);
}
