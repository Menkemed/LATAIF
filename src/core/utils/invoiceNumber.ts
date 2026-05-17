// 2026-05-16 — Display-Format fuer Invoice-Nummern.
//
// DB-Format (Audit-Trail, bleibt unveraendert):
//   PINV-2026-000009    (Sales, Partial)
//   INV-2026-000009     (Sales, Final Normal — eigener Zaehler)
//   SINV-2026-000003    (Sales, Final Special — eigener Zaehler, laeuft parallel)
//   RPINV-2026-000001   (Repair, Partial)
//   RINV-2026-000001    (Repair, Final Normal)
//   SRINV-2026-000002   (Repair, Final Special)
//
// UI-Format (Display):
//   Partial Sales:   PINV-2026-000009            (unveraendert)
//   Final Sales:     No: 000009    /  No: .000009    (specialMark)
//   Partial Repair:  RPINV-2026-000001           (unveraendert)
//   Final Repair:    Repair-000001 /  .Repair-000001 (specialMark)
//
// Der Punkt `.` ist ein User-Marker — Normal und Special haben EIGENE
// Zaehler die unabhaengig parallel laufen.

export type InvoiceNumberLike = {
  invoiceNumber: string;
  status?: string;
  specialMark?: boolean;
};

/**
 * Liefert die User-facing Anzeige der Invoice-Nummer.
 * - Falls Partial: Original DB-Nummer.
 * - Falls Final + Sales: `No: 000009` oder `No: .000009`.
 * - Falls Final + Repair: `Repair-000001` oder `.Repair-000001`.
 */
export function formatInvoiceDisplay(inv: InvoiceNumberLike | null | undefined): string {
  if (!inv) return '';
  const num = inv.invoiceNumber || '';
  const isFinal = inv.status === 'FINAL';
  const dot = inv.specialMark ? '.' : '';

  if (!isFinal) return num; // Partial bleibt wie heute (PINV / RPINV)

  // Sequenz extrahieren — letztes 6-stelliges Segment am Ende.
  // Funktioniert mit INV-2026-000009, SINV-2026-000003, RINV-2026-000001, SRINV-2026-000002, etc.
  const m = num.match(/(\d{4,})$/);
  const seq = m ? m[1] : num;

  // Repair-Prefixe: RINV (normal), SRINV (special), RPINV (legacy partial).
  const isRepair = num.startsWith('RINV-') || num.startsWith('SRINV-') || num.startsWith('RPINV-');
  if (isRepair) {
    return `${dot}Repair-${seq}`;
  }
  return `No: ${dot}${seq}`;
}

/**
 * Kurz-Variante ohne "No: " Praefix — fuer Tabellen-Spalten, Selects,
 * Detail-Headers wo der Kontext schon klar ist.
 */
export function formatInvoiceDisplayShort(inv: InvoiceNumberLike | null | undefined): string {
  const s = formatInvoiceDisplay(inv);
  return s.startsWith('No: ') ? s.slice(4) : s;
}
