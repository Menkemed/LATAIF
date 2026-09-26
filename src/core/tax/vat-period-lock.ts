// ════════════════════════════════════════════════════════════════════════════
// VAT-PERIOD-LOCK — ein eingereichtes VAT-Quartal ist zu.
//
// Der Mensch korrigiert Rechnungen normalerweise VOR der Einreichung. Danach darf keine Änderung die
// gemeldeten Daten still verschieben. „Gemeldet" heißt hier genau das, was der NBR-Export zeigt —
// dieselbe Regel, nicht eine zweite: nur FINAL-Rechnungen, Monat = Tag der Vollzahlung
// (`invoiceFinalizationDate`, spätestes Zahlungsdatum), je Zeile Steuerart, Beträge, Einstand,
// Artikel, dazu Rechnungsnummer, Kunde, Rechnungsdatum und die Zahlungen (Betrag, Datum, Art) aus
// der Notiz des Exports. Gutschriften stehen nicht im Export; eine Retoure bleibt erlaubt und
// gehört in die Periode, in der sie entsteht.
//
// Zu ist ein Quartal, wenn es ausdrücklich als eingereicht markiert ist (`vat_filings`) ODER seine
// VAT schon bezahlt ist (`tax_payments`, wie bisher). Ein Export allein markiert nichts.
//
// Die Prüfung ist ein Vergleich: der „Fingerabdruck" einer Rechnung im Export vorher und nachher.
// Liegt einer von beiden in einem zugemachten Quartal und unterscheiden sie sich, wird abgelehnt.
// So bleibt eine reine Notiz- oder Mitarbeiteränderung erlaubt, und keine gemeldete Rechnung kann
// unbemerkt in einen anderen Exportmonat wandern — auch nicht HINEIN in ein zugemachtes Quartal.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { invoiceFinalizationDate } from '@/core/tax/nbr-export';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { liveVatQuarters } from '@/core/tax/vat-quarter-overview';
import type { Invoice } from '@/core/models/types';

export const VAT_PERIOD_FILED = 'VAT_PERIOD_FILED';

/** Ein fachliches Nein mit Kennung — als `InvoiceActionRejected`, damit jeder PC2-Weg, der dessen
 *  Kennung schon als endgültiges Urteil weitergibt (Zahlung, Storno, Anlegen), es ohne Sonderfall tut. */
export class VatPeriodFiled extends InvoiceActionRejected {
  constructor(message: string) {
    super(VAT_PERIOD_FILED, message);
    this.name = 'VatPeriodFiled';
  }
}

const r3 = (v: unknown): number => Math.round((Number(v) || 0) * 1000) / 1000;

/** Monat und Quartal wie im NBR-Export (`groupByMonth`: `new Date(iso)`, Kalendermonat). */
export function nbrQuarterOfDate(iso: string): { key: string; month: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear(); const m = d.getMonth() + 1;
  return { key: `${y}-Q${Math.ceil(m / 3)}`, month: `${y}-${String(m).padStart(2, '0')}` };
}

export interface FiledQuarter { key: string; filedAt: string | null; paid: boolean }

/** Die zugemachten Quartale einer Filiale: eingereicht ODER schon bezahlt. */
export function closedVatQuarters(branchId: string): Map<string, FiledQuarter> {
  const out = new Map<string, FiledQuarter>();
  for (const r of query('SELECT year, quarter, filed_at FROM vat_filings WHERE branch_id = ?', [branchId])) {
    const key = `${Number(r.year)}-Q${Number(r.quarter)}`;
    out.set(key, { key, filedAt: String(r.filed_at), paid: false });
  }
  for (const r of query('SELECT DISTINCT year, quarter FROM tax_payments WHERE branch_id = ?', [branchId])) {
    const key = `${Number(r.year)}-Q${Number(r.quarter)}`;
    const prev = out.get(key);
    out.set(key, { key, filedAt: prev?.filedAt ?? null, paid: true });
  }
  return out;
}

export interface VatFingerprint {
  quarter: string;
  month: string;
  /** Was der Export von dieser Rechnung zeigt — als vergleichbare Zeichenkette. */
  data: string;
  row: Record<string, unknown>;
}

/** Wie der Export den Kunden zeigt (`customerLabel` + VAT-Konto + Personal-ID in `nbr-export`). */
function customerIdentity(c: Record<string, unknown> | undefined): { name: string; vatAccountNumber: string; personalId: string } {
  const base = `${String(c?.first_name ?? '')} ${String(c?.last_name ?? '')}`.trim();
  const company = String(c?.company ?? '');
  return {
    name: c ? (company ? `${base} (${company})` : base) : '',
    vatAccountNumber: String(c?.vat_account_number ?? '') || '',
    personalId: String(c?.personal_id ?? '') || '',
  };
}

/** Was der NBR-Export von dieser Rechnung zeigt; `null`, wenn sie dort nicht steht (nicht FINAL). */
export function vatFingerprint(invoiceId: string): VatFingerprint | null {
  const inv = query(
    'SELECT id, invoice_number, customer_id, status, issued_at, created_at FROM invoices WHERE id = ?', [invoiceId],
  )[0];
  if (!inv || String(inv.status) !== 'FINAL') return null;
  const pays = query('SELECT amount, method, received_at FROM payments WHERE invoice_id = ? ORDER BY received_at, id', [invoiceId])
    .map((p) => ({ amount: r3(p.amount), method: String(p.method), receivedAt: String(p.received_at) }));
  const iso = invoiceFinalizationDate(
    { issuedAt: (inv.issued_at as string) || undefined, createdAt: String(inv.created_at) } as Invoice, pays,
  );
  const q = nbrQuarterOfDate(iso);
  if (!q) return null;
  // Die Artikelbezeichnung steht im Export (`productLabel`: Marke + Name) — sie gehört in das
  // Festgehaltene, damit die Einreichung auch dann nachvollziehbar bleibt, wenn der Artikel später
  // umbenannt wird.
  const lines = query(
    `SELECT l.product_id, l.tax_scheme, l.quantity, l.line_total, l.vat_amount, l.purchase_price_snapshot, l.vat_rate,
            TRIM(COALESCE(p.brand, '') || ' ' || COALESCE(p.name, '')) AS label
       FROM invoice_lines l LEFT JOIN products p ON p.id = l.product_id
      WHERE l.invoice_id = ? ORDER BY l.position, l.id`, [invoiceId],
  ).map((l) => [String(l.product_id), String(l.tax_scheme), Number(l.quantity) || 1, r3(l.line_total), r3(l.vat_amount),
    r3(l.purchase_price_snapshot), Number(l.vat_rate) || 0, String(l.label ?? '')]);
  const kunde = query(
    'SELECT first_name, last_name, company, vat_account_number, personal_id FROM customers WHERE id = ?', [String(inv.customer_id)],
  )[0];
  const row = {
    invoiceId, number: String(inv.invoice_number), month: q.month, finalizedAt: iso,
    customerId: String(inv.customer_id), customer: customerIdentity(kunde),
    issuedAt: String(inv.issued_at ?? inv.created_at ?? ''), lines, payments: pays,
  };
  return { quarter: q.key, month: q.month, data: JSON.stringify(row), row };
}

function quarterLabel(key: string): string {
  const [y, q] = key.split('-Q');
  return `Q${q}/${y}`;
}

/**
 * Vergleicht den Export-Fingerabdruck vorher/nachher. Liegt einer davon in einem zugemachten
 * Quartal und unterscheiden sie sich, wirft `VatPeriodFiled` (in einer Transaktion → Rollback).
 */
export function assertVatUnchanged(branchId: string, before: VatFingerprint | null, after: VatFingerprint | null): void {
  if ((before?.data ?? null) === (after?.data ?? null)) return;
  const closed = closedVatQuarters(branchId);
  const hit = [before?.quarter, after?.quarter].find((k): k is string => !!k && closed.has(k));
  if (!hit) return;
  const c = closed.get(hit)!;
  throw new VatPeriodFiled(
    `The VAT return for ${quarterLabel(hit)} is already ${c.filedAt ? 'filed' : 'paid'} and contains this invoice. `
    + 'This change would alter what was reported — only notes can still be changed.',
  );
}

/** Kurzform für Vorgänge ohne eigene Transaktion: die Rechnung steht jetzt in einem zugemachten Quartal? */
export function assertInvoiceNotInClosedVatQuarter(invoiceId: string): void {
  const fp = vatFingerprint(invoiceId);
  if (!fp) return;
  const branch = String(query('SELECT branch_id FROM invoices WHERE id = ?', [invoiceId])[0]?.branch_id ?? '');
  assertVatUnchanged(branch, fp, null);
}

/** Würde eine Rechnung JETZT (Datum `iso`) voll bezahlt, landete sie in einem zugemachten Quartal? */
export function assertNotFinalizingIntoClosedVatQuarter(branchId: string, iso: string): void {
  const q = nbrQuarterOfDate(iso);
  if (!q || !closedVatQuarters(branchId).has(q.key)) return;
  const c = closedVatQuarters(branchId).get(q.key)!;
  throw new VatPeriodFiled(
    `The VAT return for ${quarterLabel(q.key)} is already ${c.filedAt ? 'filed' : 'paid'} — a payment that completes an invoice `
    + 'on this date would add it to what was reported.',
  );
}

/**
 * Ein Umwandlungsweg, der erst die Rechnung und DANACH die mitgehenden Zahlungen schreibt (Agent,
 * Auftrag): schließen die Zahlungen die Rechnung heute ab, wird das VORHER geprüft. Sonst lehnte
 * `recordPayment` erst ab, wenn Rechnung und Gegenbuchungen schon stehen — halb umgewandelt.
 */
export function assertMayFinalizeNow(branchId: string, gross: number, paid: number): void {
  if (paid > 0.005 && paid >= gross - 0.005) assertNotFinalizingIntoClosedVatQuarter(branchId, new Date().toISOString());
}

// ── Kundenstamm ────────────────────────────────────────────────────────────────────────────

const KUNDE_IM_EXPORT: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', company: 'company',
  vatAccountNumber: 'vat_account_number', personalId: 'personal_id',
};

/**
 * Der Export liest Name, Firma, VAT-Konto und Personal-ID aus dem Kundenstamm, nicht aus der
 * Rechnung. Eine spätere Änderung daran schriebe also eine schon gemeldete Rechnung um. Gesperrt
 * ist genau das — und nur, wenn der Kunde auf einer Rechnung eines zugemachten Quartals steht.
 * Telefon, E-Mail, Adresse, Notizen usw. bleiben frei. Verglichen wird das, was der Export zeigt:
 * „Anna" + „Maria Weber" → „Anna Maria" + „Weber" ist keine Änderung.
 */
export function assertCustomerVatIdentityUnchanged(customerId: string, data: Record<string, unknown>): void {
  if (!Object.keys(KUNDE_IM_EXPORT).some((k) => k in data)) return;
  const row = query(
    'SELECT first_name, last_name, company, vat_account_number, personal_id FROM customers WHERE id = ?', [customerId],
  )[0];
  if (!row) return;
  const nachher: Record<string, unknown> = { ...row };
  for (const [key, col] of Object.entries(KUNDE_IM_EXPORT)) if (key in data) nachher[col] = data[key] ?? null;
  if (JSON.stringify(customerIdentity(row)) === JSON.stringify(customerIdentity(nachher))) return;
  const jeFiliale = new Map<string, Map<string, FiledQuarter>>();
  for (const r of query("SELECT id, branch_id FROM invoices WHERE customer_id = ? AND status = 'FINAL'", [customerId])) {
    const b = String(r.branch_id ?? '');
    if (!jeFiliale.has(b)) jeFiliale.set(b, closedVatQuarters(b));
    const closed = jeFiliale.get(b)!;
    if (closed.size === 0) continue;
    const q = vatFingerprint(String(r.id))?.quarter;
    if (!q || !closed.has(q)) continue;
    throw new VatPeriodFiled(
      `This customer is on an invoice in the VAT return for ${quarterLabel(q)}, which is already ${closed.get(q)!.filedAt ? 'filed' : 'paid'}. `
      + 'Name, company, VAT account number and personal ID appear in that return and can no longer be changed — phone, email, address and notes still can.',
    );
  }
}

// ── Artikelstamm ───────────────────────────────────────────────────────────────────────────

const artikelLabel = (brand: unknown, name: unknown): string =>
  [brand, name].map((v) => String(v ?? '')).filter(Boolean).join(' ');

/**
 * Der Export zeigt den Artikel als „Marke Name" (`productLabel`), gelesen aus dem Artikelstamm.
 * Eine Umbenennung schriebe eine schon gemeldete Rechnung um — gesperrt ist genau das, und nur,
 * wenn der Artikel auf einer Rechnung eines zugemachten Quartals steht. Preis, Zustand, Lagerort,
 * Notizen, Bilder usw. bleiben frei. `change` trägt Marke/Name unter `brand`/`name` (Feld- und
 * Spaltenname sind gleich).
 */
export function assertProductVatLabelUnchanged(productId: string, change: Record<string, unknown>): void {
  if (!('brand' in change) && !('name' in change)) return;
  const row = query('SELECT brand, name FROM products WHERE id = ?', [productId])[0];
  if (!row) return;
  const nachher = artikelLabel('brand' in change ? change.brand : row.brand, 'name' in change ? change.name : row.name);
  if (artikelLabel(row.brand, row.name) === nachher) return;
  const jeFiliale = new Map<string, Map<string, FiledQuarter>>();
  for (const r of query(
    `SELECT DISTINCT i.id, i.branch_id FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.product_id = ? AND i.status = 'FINAL'`, [productId],
  )) {
    const b = String(r.branch_id ?? '');
    if (!jeFiliale.has(b)) jeFiliale.set(b, closedVatQuarters(b));
    const closed = jeFiliale.get(b)!;
    if (closed.size === 0) continue;
    const q = vatFingerprint(String(r.id))?.quarter;
    if (!q || !closed.has(q)) continue;
    throw new VatPeriodFiled(
      `This article is on an invoice in the VAT return for ${quarterLabel(q)}, which is already ${closed.get(q)!.filedAt ? 'filed' : 'paid'}. `
      + 'Brand and name appear in that return and can no longer be changed — price, condition, notes and photos still can.',
    );
  }
}

/** Dasselbe als Antwort statt Wurf — für die Speicherwege, die ein Ergebnis zurückgeben. */
export function productVatLabelRefusal(productId: string, change: Record<string, unknown>): string | null {
  try { assertProductVatLabelUnchanged(productId, change); return null; } catch (e) {
    if (e instanceof VatPeriodFiled) return e.message;
    throw e;
  }
}

// ── Einreichen ─────────────────────────────────────────────────────────────────────────────

export const VAT_QUARTER_ALREADY_FILED = 'VAT_QUARTER_ALREADY_FILED';
export const VAT_QUARTER_NOT_OVER = 'VAT_QUARTER_NOT_OVER';

export interface VatFilingResult {
  id: string; year: number; quarter: number; filedAt: string; invoiceCount: number;
}

/**
 * „Mark VAT filed": hält Zeitpunkt, Person und die gemeldeten Daten des Quartals fest (je Rechnung
 * der Export-Fingerabdruck). Ab dann ist das Quartal zu. Einmal je Quartal — ein zweites Mal lehnt ab.
 */
export function markVatQuarterFiled(
  input: { branchId: string; year: number; quarter: number; userId?: string | null; note?: string | null },
): VatFilingResult {
  const { branchId, year, quarter } = input;
  if (!Number.isInteger(year) || year < 2000 || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new Error('A VAT quarter needs a year and a quarter between 1 and 4.');
  }
  if (query('SELECT 1 FROM vat_filings WHERE branch_id = ? AND year = ? AND quarter = ?', [branchId, year, quarter]).length > 0) {
    const e = new Error(`Q${quarter}/${year} is already marked as filed.`) as Error & { code?: string };
    e.code = VAT_QUARTER_ALREADY_FILED;
    throw e;
  }
  // Eingereicht wird nach dem Quartal. Ein laufendes Quartal zuzumachen sperrte jede Zahlung, die
  // heute eine Rechnung abschließt — also den normalen Verkauf.
  if (new Date() < new Date(year, quarter * 3, 1)) {
    const e = new Error(`Q${quarter}/${year} is not over yet — it can be marked as filed once the quarter has ended.`) as Error & { code?: string };
    e.code = VAT_QUARTER_NOT_OVER;
    throw e;
  }
  const key = `${year}-Q${quarter}`;
  // Gemeldet ist, was der Export zeigt: FINAL ohne Butterfly (dessen Vorauswahl). Die Summen hält die
  // Einreichung mit fest — die Übersicht zeigt sie danach, statt neu zu rechnen.
  const totals = liveVatQuarters(branchId).get(key) ?? { key, standardVat: 0, marginVat: 0, zeroRated: 0, vat: 0, invoiceCount: 0 };
  const rows = query("SELECT id FROM invoices WHERE branch_id = ? AND status = 'FINAL' AND COALESCE(butterfly, 0) = 0", [branchId])
    .map((r) => vatFingerprint(String(r.id)))
    .filter((f): f is VatFingerprint => !!f && f.quarter === key)
    .sort((a, b) => (a.row.finalizedAt as string).localeCompare(b.row.finalizedAt as string))
    .map((f) => f.row);
  const id = uuid();
  const now = new Date().toISOString();
  getDatabase().run(
    `INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, note, invoice_count, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, branchId, year, quarter, now, input.userId ?? null, input.note ?? null, rows.length,
      JSON.stringify({ rule: 'NBR export: FINAL invoices (no butterfly), month of full payment', totals, invoices: rows }), now],
  );
  return { id, year, quarter, filedAt: now, invoiceCount: rows.length };
}
