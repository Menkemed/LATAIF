// ════════════════════════════════════════════════════════════════════════════
// INVOICE-NUMBER-FREEZE — die Endnummer einer Rechnung wird genau EINMAL vergeben.
//
// Eine Rechnung beginnt mit einer vorläufigen Nummer (`PINV-…`, Reparatur `RPINV-…`). Sobald sie
// zum ersten Mal vollständig bezahlt ist, bekommt sie ihre Endnummer aus dem passenden Kreis
// (`INV`/`SINV`, Reparatur `RINV`/`SRINV`) und die Wahl „normal oder Sonder" (`special_mark`).
//
// Früher hing die Vergabe am STATUS („ist nicht FINAL"). Fiel eine bezahlte Rechnung zurück —
// Preiserhöhung, Zahlung geändert oder gelöscht, Retoure storniert — und wurde erneut voll bezahlt,
// zog sie eine ZWEITE Endnummer: die Rechnung hieß danach anders, eine Nummer war verbrannt.
//
// Jetzt hängt die Vergabe an einem Merker am Beleg: `invoices.number_finalized_at`. Ist er gesetzt,
// bleiben Nummer und Sonder-Kennzeichen für immer, egal welcher Status folgt. Auch die Anzeige
// (`formatInvoiceDisplay`) richtet sich nach ihm, damit eine wieder offene Rechnung nicht plötzlich
// anders aussieht.
// ════════════════════════════════════════════════════════════════════════════
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { logAudit } from '@/core/audit/audit-log';
import { finalizationDate } from '@/core/invoices/finalization-date';

export interface FinalNumberResult {
  invoiceNumber: string;
  specialMark: boolean;
  /** true = in diesem Aufruf vergeben; false = war schon vergeben (unverändert). */
  assigned: boolean;
}

/** Trägt die Rechnung schon ihre Endnummer? Liest die Datenbank, nicht den Store. */
export function isInvoiceNumberFinal(invoiceId: string): boolean {
  const r = query('SELECT number_finalized_at FROM invoices WHERE id = ?', [invoiceId])[0];
  return !!(r && r.number_finalized_at);
}

/**
 * Die Endnummer sicherstellen — höchstens einmal im Leben einer Rechnung.
 *
 * Aufzurufen, wenn die Rechnung (wieder) vollständig bezahlt ist. Ist die Nummer schon endgültig,
 * passiert nichts: keine neue Nummer, keine neue Sonder-Wahl. Sonst wird aus dem Kreis der
 * vorläufigen Nummer gezogen; `specialMarkOnFinal` ist die Wahl des Nummern-Dialogs, ohne sie gilt
 * das Kennzeichen, das die Rechnung schon trägt.
 */
export function ensureFinalInvoiceNumber(invoiceId: string, now: string, specialMarkOnFinal?: boolean): FinalNumberResult {
  const r = query('SELECT invoice_number, special_mark, number_finalized_at, issued_at, created_at FROM invoices WHERE id = ?', [invoiceId])[0];
  if (!r) throw new Error(`ensureFinalInvoiceNumber: invoice ${invoiceId} not found`);
  const current = String(r.invoice_number ?? '');
  const currentSpecial = Number(r.special_mark) === 1;
  // Schon endgültig: Nummer, Kennzeichen UND Datum der Endrechnung bleiben, wie sie sind.
  if (r.number_finalized_at) return { invoiceNumber: current, specialMark: currentSpecial, assigned: false };

  const special = typeof specialMarkOnFinal === 'boolean' ? specialMarkOnFinal : currentSpecial;
  // Kreise wie bisher: Reparatur RPINV → RINV/SRINV, sonst INV/SINV.
  const isRepair = current.startsWith('RPINV-');
  const next = isRepair
    ? getNextDocumentNumber(special ? 'SRINV' : 'RINV')
    : getNextDocumentNumber(special ? 'SINV' : 'INV');
  // FINAL-INVOICE-DATE — der Tag der ersten Vollzahlung, einmal festgehalten (Zahlungen stehen schon in der
  // Datenbank: jeder Aufrufer schreibt sie vorher). `now` bleibt der technische Zeitpunkt der Vergabe.
  const finalDate = finalIssuedAtIfFinalNow(invoiceId);
  getDatabase().run(
    'UPDATE invoices SET invoice_number = ?, special_mark = ?, number_finalized_at = ?, final_issued_at = ?, updated_at = ? WHERE id = ?',
    [next, special ? 1 : 0, now, finalDate, now, invoiceId],
  );
  logAudit({ module: 'Sales', entityType: 'invoices', entityId: invoiceId, action: 'UPDATE',
    field: 'invoice_number', oldValue: current, newValue: next });
  logAudit({ module: 'Sales', entityType: 'invoices', entityId: invoiceId, action: 'UPDATE',
    field: 'final_issued_at', oldValue: String(r.issued_at ?? r.created_at ?? ''), newValue: finalDate });
  return { invoiceNumber: next, specialMark: special, assigned: true };
}

/**
 * FINAL-INVOICE-DATE — welches Datum die Endrechnung trägt bzw. trüge, wäre sie JETZT voll bezahlt:
 * das schon festgehaltene; sonst der Tag der Vollzahlung aus den gespeicherten Zahlungen (dieselbe Regel
 * wie NBR-Export und VAT-Sperre), auf Wunsch samt einer noch nicht geschriebenen Zahlung (`pendingReceivedAt`,
 * für die Vorprüfung vor jedem Schreiben).
 */
export function finalIssuedAtIfFinalNow(invoiceId: string, pendingReceivedAt?: string): string {
  const r = query('SELECT issued_at, created_at, final_issued_at FROM invoices WHERE id = ?', [invoiceId])[0];
  if (!r) return pendingReceivedAt || '';
  const pays = query('SELECT received_at FROM payments WHERE invoice_id = ?', [invoiceId])
    .map((p) => ({ receivedAt: String(p.received_at ?? '') }));
  if (pendingReceivedAt) pays.push({ receivedAt: pendingReceivedAt });
  return finalizationDate({
    finalIssuedAt: (r.final_issued_at as string | null) || undefined,
    issuedAt: (r.issued_at as string | null) || undefined,
    createdAt: (r.created_at as string | null) || undefined,
  }, pays);
}

interface BackfillDb {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

/**
 * Aufstieg beim Start (idempotent): Rechnungen, die ihre Endnummer VOR diesem Vertrag bekommen
 * haben, erhalten den Merker — ohne dass sich Nummer, Kennzeichen oder Status ändern.
 *
 * Belege dafür, dass eine Endnummer vergeben wurde:
 *   • der Protokolleintrag der Nummernvergabe (`audit_log`, Feld `invoice_number`) — er deckt auch
 *     die Rechnungen ab, die danach wieder auf PARTIAL zurückgefallen sind;
 *   • oder der Status FINAL, solange die Nummer nicht mehr die vorläufige ist.
 * Eine FINALe Rechnung, die noch ihre vorläufige Nummer trägt, bleibt ohne Merker: ihr wurde nie
 * eine Endnummer gegeben, und nachträglich wird keine erfunden.
 */
export function backfillInvoiceNumberFinalized(db: BackfillDb): void {
  const prov = db.exec("SELECT prefix FROM document_sequences WHERE doc_type IN ('PINV','RPINV')")[0]?.values
    .map((v) => String(v[0] ?? '')).filter(Boolean) ?? [];
  const provisional = [...new Set(['PINV', 'RPINV', ...prov])];
  const notProvisional = provisional.map(() => 'invoice_number NOT LIKE ?').join(' AND ');
  const params = provisional.map((p) => `${p}-%`);
  db.run(
    `UPDATE invoices SET number_finalized_at = COALESCE(
        (SELECT MIN(a.changed_at) FROM audit_log a
          WHERE a.entity_type = 'invoices' AND a.entity_id = invoices.id AND a.field_name = 'invoice_number'),
        updated_at, created_at)
      WHERE number_finalized_at IS NULL
        AND (EXISTS (SELECT 1 FROM audit_log a
                      WHERE a.entity_type = 'invoices' AND a.entity_id = invoices.id AND a.field_name = 'invoice_number')
             OR (status = 'FINAL' AND ${notProvisional}))`,
    params,
  );
}
