// ════════════════════════════════════════════════════════════════════════════
// ACCOUNTING-OPENING-DATE — der Buchungsstichtag (Eröffnungsstichtag) JE DATENBANK.
//
// Owner-Entscheid 18.11.2026: Der Stichtag war die feste Konstante 2026-10-15 für jede LATAIF-Installation.
// Jeder Kollege führt aber seine eigene, eigenständige Datenbank und bestimmt seinen Stichtag selbst.
//
//   • Gespeichert in der Tabelle `settings` DIESER Datenbank (Schlüssel `accounting.opening_date`). `settings`
//     gehört nicht zum Sync-Vertrag: kein anderer Rechner, keine andere Installation sieht oder ändert den Wert.
//   • Fehlt der Eintrag, gilt der bisherige wirksame Stichtag 2026-10-15 — bestehende Installationen verhalten
//     sich ohne Zutun genau wie vorher.
//   • Gelesen wird überall über `accountingOpeningDate()`. Am Primary aus der eigenen Datenbank; am zweiten Rechner
//     (Client ohne Datenbank) der Wert SEINES Primary aus der Sitzungsauskunft — nur zur Anzeige: jede Sperre
//     prüft die Hausfunktion am Primary mit dem Wert des Primary.
//   • Ändern: `opening-date-house.ts` (nur Owner, nur am Primary, mit Konfliktprüfung und Audit).
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';

/** Der bisherige, für alle Installationen feste Stichtag — gilt weiter, solange die Datenbank keinen eigenen trägt. */
export const DEFAULT_ACCOUNTING_OPENING_DATE = '2026-10-15';
/** Der Schlüssel in `settings` dieser Datenbank. */
export const ACCOUNTING_OPENING_DATE_KEY = 'accounting.opening_date';
const CLIENT_KEY = 'lataif_client_primary_opening_date';

/** Ein Kalendertag JJJJ-MM-TT, den es wirklich gibt. */
export function isCalendarDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// ── Nur für Node-Tests: ein Stichtag ohne Datenbank-Eintrag (Regressionstests, deren Szenarien vor 2026-10-15 spielen).
// In der App (Vite setzt `import.meta.env`) wirft das Setzen — dort gilt immer der Wert der Datenbank.
const nurNodeTest = (): boolean => typeof import.meta.env === 'undefined';
let testWert: string | null = null;
export function setOpeningDateForTest(day: string | null): void {
  if (!nurNodeTest()) throw new Error('setOpeningDateForTest is only available in node tests — the opening date is read from the database in the app.');
  if (day !== null && !isCalendarDay(day)) throw new Error(`not a calendar day: ${day}`);
  testWert = day;
}

// ── Zweiter Rechner: der Wert seines Primary (Sitzungsauskunft), nur Anzeige ────────────────────────────────
export function setClientAccountingOpeningDate(day: unknown): void {
  try {
    if (isCalendarDay(day)) window.localStorage.setItem(CLIENT_KEY, day);
    else window.localStorage.removeItem(CLIENT_KEY);
  } catch { /* nur Anzeige */ }
}
function clientWert(): string | null {
  try { const v = window.localStorage.getItem(CLIENT_KEY); return isCalendarDay(v) ? v : null; } catch { return null; }
}

/** Der in DIESER Datenbank gespeicherte Stichtag — `null`, wenn keiner gesetzt ist (oder keine Datenbank offen). */
export function storedAccountingOpeningDate(): string | null {
  try {
    const v = query(`SELECT value FROM settings WHERE key = ? ORDER BY updated_at DESC LIMIT 1`, [ACCOUNTING_OPENING_DATE_KEY])[0]?.value;
    return isCalendarDay(v) ? v : null;
  } catch { return null; }
}

/** DER Buchungsstichtag (JJJJ-MM-TT): Buchungen und Korrekturen vor diesem Tag sind gesperrt. */
export function accountingOpeningDate(): string {
  if (nurNodeTest() && testWert !== null) return testWert;
  if (isClientMode()) return clientWert() ?? DEFAULT_ACCOUNTING_OPENING_DATE;
  return storedAccountingOpeningDate() ?? DEFAULT_ACCOUNTING_OPENING_DATE;
}

/** Für die Anzeige in Settings: der wirksame Tag und woher er kommt. */
export function accountingOpeningDateInfo(): { date: string; source: 'database' | 'default' | 'primary' } {
  if (isClientMode()) return { date: accountingOpeningDate(), source: 'primary' };
  const stored = storedAccountingOpeningDate();
  return { date: stored ?? DEFAULT_ACCOUNTING_OPENING_DATE, source: stored ? 'database' : 'default' };
}
