// ═══════════════════════════════════════════════════════════
// LATAIF — Invoice edit reason (E1)
// ═══════════════════════════════════════════════════════════
//
// Reine, DB-freie Validierung des Pflicht-Grunds im Invoice-EDIT-Modus. Sie ist die
// freundliche UI-Vorprüfung und spiegelt den harten Store-Guard in
// invoiceStore.editInvoice ("An edit reason is required."). Ausgelagert, damit sie
// headless testbar ist (Muster wie core/credit, core/import) und die angezeigte Meldung
// an GENAU EINER Stelle definiert ist — die UI leitet Feld-Highlight/Inline-Fehler von
// derselben Konstante ab, kein String-Drift.
//
// Bewusst NUR Reason-Validierung: keine Berührung von Betrag/VAT/Payment/Credit/Ledger.

/** Einzige Quelle der Edit-Reason-Fehlermeldung (UI-Validierung + Inline-Anzeige). */
export const EDIT_REASON_REQUIRED_MESSAGE = 'Please enter a reason for this edit.';

export type EditReasonCheck =
  | { ok: true; reason: string }
  | { ok: false; message: string };

/**
 * Prüft den Pflicht-Grund für einen Invoice-Save.
 * - Create-Modus (isEditMode=false): kein Grund nötig → ok mit leerem reason.
 * - Edit-Modus: der GETRIMMTE Grund muss nicht-leer sein; sonst blockiert die Meldung
 *   das Speichern (leer bzw. nur Leerzeichen ⇒ blockiert).
 *
 * Gibt bei Erfolg den GETRIMMTEN Grund zurück — genau der Wert, der 1:1 als `reason` in
 * den bestehenden editInvoice-/Audit-Payload geht. `notes` bleibt davon unberührt.
 */
export function checkEditReason(isEditMode: boolean, rawReason: string): EditReasonCheck {
  if (!isEditMode) return { ok: true, reason: '' };
  const reason = (rawReason || '').trim();
  if (!reason) return { ok: false, message: EDIT_REASON_REQUIRED_MESSAGE };
  return { ok: true, reason };
}
