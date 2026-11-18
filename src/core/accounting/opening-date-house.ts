// ════════════════════════════════════════════════════════════════════════════
// ACCOUNTING-OPENING-DATE — den Buchungsstichtag DIESER Datenbank ändern (nur Owner, nur am Primary).
//
// Was eine Änderung NIE tut: Rechnungen, Zahlungen, Buchungen oder andere historische Daten anfassen. Sie
// verschiebt nur die Grenze, ab der Korrekturen buchen dürfen. Eingereichte/bezahlte VAT-Quartale und alle
// übrigen Sperren gelten unabhängig davon weiter.
//
// Vor dem Speichern wird geprüft und eine unsichere Änderung abgelehnt:
//   • Eröffnungsposten (Partei-Eröffnungssalden, Konten-Eröffnung), die noch gelten, tragen „Saldo am Stichtag"
//     — mit einem anderen Stichtag stimmte ihre Bedeutung nicht mehr. Erst stornieren, dann ändern.
//   • Ein SPÄTERER Stichtag schlösse Vorgänge rückwirkend weg: liegen zwischen altem und neuem Tag schon Buchungen
//     oder Belege (Rechnungen, Einkäufe), wird abgelehnt.
//   • Kein Tag in der Zukunft (er sperrte das laufende Geschäft), kein Tag, den es nicht gibt.
// Berechtigung: die Rolle wird in der Hausfunktion geprüft — aus dem Ausweis UND aus `user_branches` dieser
// Datenbank (Owner). Am zweiten Rechner gibt es diesen Weg nicht (`PRIMARY_ONLY`).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { canonicalRole } from '@/core/models/types';
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import { useAuthStore } from '@/stores/authStore';
import { cutoffBoundaryIso } from './ledger-statements';
import {
  ACCOUNTING_OPENING_DATE_KEY, DEFAULT_ACCOUNTING_OPENING_DATE, accountingOpeningDate, isCalendarDay, storedAccountingOpeningDate,
} from './opening-date';

export class OpeningDateRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'OpeningDateRejected'; }
}

export interface OpeningDateCtx { branchId: string; userId: string; now: string; role?: string }

export interface OpeningDateCheck {
  ok: boolean;
  current: string;
  /** `true`, wenn der neue Tag der wirksame ist (nichts zu tun). */
  unchanged: boolean;
  direction: 'earlier' | 'later' | 'same';
  problems: string[];
}

const localDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const n = (sql: string, p: unknown[] = []): number => Number(query(sql, p)[0]?.n ?? 0) || 0;

/** Rein lesend: darf der Stichtag DIESER Datenbank auf `newDate` gehen? Dieselbe Prüfung vor dem Schreiben. */
export function checkOpeningDateChange(newDate: unknown, nowIso: string = new Date().toISOString()): OpeningDateCheck {
  const current = accountingOpeningDate();
  const problems: string[] = [];
  if (!isCalendarDay(newDate)) {
    return { ok: false, current, unchanged: false, direction: 'same', problems: ['The opening date is a calendar day (YYYY-MM-DD).'] };
  }
  const direction = newDate === current ? 'same' : newDate < current ? 'earlier' : 'later';
  if (newDate > localDay(nowIso)) problems.push(`The opening date cannot be in the future (${newDate}) — it would lock today's business.`);
  if (newDate < '2000-01-01') problems.push('The opening date cannot be before 2000-01-01.');
  if (direction !== 'same') {
    // Eröffnungsposten tragen „Saldo am Stichtag" — sie gelten nur für den Tag, für den sie erfasst sind.
    const parteien = query(`SELECT cutoff_date AS d, COUNT(*) AS n FROM opening_balance_items WHERE status = 'RECORDED' GROUP BY cutoff_date`);
    const konten = query(`SELECT cutoff_date AS d, COUNT(*) AS n FROM opening_account_items WHERE status = 'RECORDED' GROUP BY cutoff_date`);
    for (const [was, rows] of [['party opening balances', parteien], ['opening account balances', konten]] as const) {
      const fremd = rows.filter((r) => String(r.d) !== newDate);
      const anzahl = fremd.reduce((s, r) => s + Number(r.n ?? 0), 0);
      if (anzahl > 0) {
        problems.push(`${anzahl} ${was} are recorded as of ${fremd.map((r) => String(r.d)).join(', ')}. They describe the balance on that date — cancel them first, or keep the opening date.`);
      }
    }
    if (direction === 'later') {
      // Ein späterer Stichtag schlösse Vorgänge zwischen altem und neuem Tag rückwirkend weg.
      const von = cutoffBoundaryIso(current), bis = cutoffBoundaryIso(newDate);
      const buchungen = n('SELECT COUNT(*) AS n FROM ledger_entries WHERE occurred_at >= ? AND occurred_at < ?', [von, bis]);
      const rechnungen = n('SELECT COUNT(*) AS n FROM invoices WHERE substr(COALESCE(issued_at, created_at), 1, 10) >= ? AND substr(COALESCE(issued_at, created_at), 1, 10) < ?', [current, newDate]);
      const einkaeufe = n('SELECT COUNT(*) AS n FROM purchases WHERE substr(COALESCE(purchase_date, created_at), 1, 10) >= ? AND substr(COALESCE(purchase_date, created_at), 1, 10) < ?', [current, newDate]);
      if (buchungen + rechnungen + einkaeufe > 0) {
        problems.push(`Between ${current} and ${newDate} there are already ${buchungen} bookings, ${rechnungen} invoices and ${einkaeufe} purchases. `
          + 'A later opening date would lock them retroactively — they could no longer be corrected.');
      }
    }
  }
  return { ok: problems.length === 0, current, unchanged: direction === 'same', direction, problems };
}

/** Die Rolle aus der Datenbank (nicht aus dem Fenster): Owner dieser Filiale? */
function istOwner(ctx: OpeningDateCtx): boolean {
  if (canonicalRole(ctx.role) !== 'ADMIN') return false;
  const r = query('SELECT role FROM user_branches WHERE user_id = ? AND branch_id = ?', [ctx.userId, ctx.branchId])[0]?.role;
  return canonicalRole(r as string | undefined) === 'ADMIN' && r !== undefined && r !== null;
}

export interface OpeningDateResult { date: string; previous: string; previousSource: 'database' | 'default'; changed: boolean }

/** Den Stichtag DIESER Datenbank setzen — prüft Berechtigung und Konflikte vor jedem Schreiben. */
export function setAccountingOpeningDateInHouse(input: { date: unknown }, ctx: OpeningDateCtx): OpeningDateResult {
  if (!istOwner(ctx)) throw new OpeningDateRejected('PERMISSION_DENIED', 'only the owner (admin) may change the accounting opening date');
  const check = checkOpeningDateChange(input.date, ctx.now);
  if (!check.ok) throw new OpeningDateRejected('OPENING_DATE_UNSAFE', check.problems.join(' '));
  const date = input.date as string;
  const vorher = storedAccountingOpeningDate();
  if (check.unchanged) return { date, previous: check.current, previousSource: vorher ? 'database' : 'default', changed: false };
  const db = getDatabase();
  db.run(
    `INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES (?, ?, ?, 'accounting', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = excluded.updated_at`,
    [ctx.branchId, ACCOUNTING_OPENING_DATE_KEY, date, ctx.now],
  );
  // EIN Wert je Datenbank: ein Eintrag unter einer anderen Filiale wäre ein zweiter, widersprechender.
  db.run('DELETE FROM settings WHERE key = ? AND branch_id <> ?', [ACCOUNTING_OPENING_DATE_KEY, ctx.branchId]);
  logAuditOrThrow({
    module: 'Settings', entityType: 'settings', entityId: ACCOUNTING_OPENING_DATE_KEY, action: 'UPDATE',
    field: ACCOUNTING_OPENING_DATE_KEY, oldValue: vorher ?? `${DEFAULT_ACCOUNTING_OPENING_DATE} (default)`, newValue: date,
    actor: { branchId: ctx.branchId, userId: ctx.userId },
  });
  if (accountingOpeningDate() !== date) throw new OpeningDateRejected('OPENING_DATE_NOT_STORED', 'the opening date was not stored — nothing changed');
  return { date, previous: check.current, previousSource: vorher ? 'database' : 'default', changed: true };
}

function localCtx(): OpeningDateCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}

/** Settings → Accounting: nur am Primary, exklusiv, in EINER Transaktion, danach durabel gespeichert. */
export function setAccountingOpeningDateOnPrimary(date: string, reload: () => void = () => {}): Promise<OpeningDateResult> {
  if (isClientMode()) {
    return Promise.reject(new OpeningDateRejected('PRIMARY_ONLY', 'the accounting opening date is set on the main computer'));
  }
  return runOnPrimary(() => setAccountingOpeningDateInHouse({ date }, localCtx()), reload);
}
