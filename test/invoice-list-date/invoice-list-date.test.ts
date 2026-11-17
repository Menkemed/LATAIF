// INVOICE-LIST-DATE — Datum der Rechnungsliste: vorläufig = Rechnungstag, Endrechnung = Tag der Vollzahlung
// (dieselbe Quelle wie NBR-Export und VAT-Periodensperre). Nur Anzeige.
// Run: node test/invoice-list-date/invoice-list-date.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { invoiceListDate } = await import('../../src/core/invoices/invoice-list-date.ts');
const { invoiceFinalizationDate } = await import('../../src/core/tax/nbr-export.ts');

let PASS = 0, FAIL = 0;
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; console.log('  ✗ ' + m); } };
const S = JSON.stringify;

// vorläufig / teilbezahlt: Rechnungstag bleibt
const part = invoiceListDate({ status: 'PARTIAL', issuedAt: '2026-11-14T00:00:00.000Z', createdAt: '2026-11-17T13:29:29Z' },
  [{ amount: 10, method: 'cash', receivedAt: '2026-11-16T09:00:00Z' }]);
ok(part.kind === 'issued' && part.date === '2026-11-14T00:00:00.000Z' && !part.differs, 'vorläufige Rechnung: Rechnungstag (auch mit Teilzahlung)');
ok(invoiceListDate({ status: 'DRAFT', issuedAt: '', createdAt: '2026-11-01T08:00:00Z' }).date === '2026-11-01T08:00:00Z', 'ohne Rechnungstag: Anlagetag');

// voll bezahlt: Tag der Vollzahlung (Beispiel SRINV-2026-000012: Rechnungstag 14.11., Zahlung 17.11.)
const srinv = invoiceListDate({ status: 'FINAL', issuedAt: '2026-11-14T00:00:00.000Z', createdAt: '2026-11-17T13:29:29.631Z' },
  [{ amount: 25, method: 'benefit', receivedAt: '2026-11-17T13:38:10.166Z' }]);
ok(srinv.kind === 'final' && srinv.date.slice(0, 10) === '2026-11-17' && srinv.issued.slice(0, 10) === '2026-11-14' && srinv.differs,
  `Endrechnung: Tag der Vollzahlung 17.11., Rechnungstag 14.11. sichtbar daneben (${S(srinv)})`);

// mehrere Zahlungen: der Tag, an dem sie voll wurde (spätestes Zahlungsdatum) — wie NBR
const multi = invoiceListDate({ status: 'FINAL', issuedAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z' },
  [{ amount: 50, method: 'cash', receivedAt: '2026-11-03T10:00:00Z' }, { amount: 50, method: 'bank_transfer', receivedAt: '2026-11-12T10:00:00Z' }]);
ok(multi.date.slice(0, 10) === '2026-11-12', 'Teilzahlungen: Tag der letzten (vollmachenden) Zahlung');

// rückdatierte Zahlung: das tatsächliche Zahlungsdatum zählt, nicht der spätere Eingabetag
const backdated = invoiceListDate({ status: 'FINAL', issuedAt: '2026-11-05T00:00:00Z', createdAt: '2026-11-05T00:00:00Z' },
  [{ amount: 100, method: 'cash', receivedAt: '2026-11-08T00:00:00Z' }]);   // eingegeben am 17.11., received_at 08.11.
ok(backdated.date.slice(0, 10) === '2026-11-08', 'rückdatierte Zahlung: received_at (08.11.), nicht der Eingabetag');

// bereits abgeschlossen ohne Zahlungszeilen (Altbestand / 0 BHD): Rechnungstag, nichts erfunden
const alt = invoiceListDate({ status: 'FINAL', issuedAt: '2026-03-02T00:00:00Z', createdAt: '2026-03-02T00:00:00Z' }, []);
ok(alt.kind === 'final' && alt.date === '2026-03-02T00:00:00Z' && !alt.differs, 'abgeschlossene Rechnung ohne Zahlungszeilen: Rechnungstag');

// gleiche Quelle wie NBR-Export und VAT-Sperre
const pay = [{ amount: 1, method: 'cash', receivedAt: '2026-10-20T10:00:00Z' }];
ok(invoiceListDate({ status: 'FINAL', issuedAt: '2026-10-01', createdAt: '2026-10-01' }, pay).date === invoiceFinalizationDate({ issuedAt: '2026-10-01', createdAt: '2026-10-01' } as never, pay),
  'Liste = invoiceFinalizationDate (NBR)');
const lock = readFileSync(join(repo, 'src/core/tax/vat-period-lock.ts'), 'utf8');
const nbr = readFileSync(join(repo, 'src/core/tax/nbr-export.ts'), 'utf8');
ok(/invoiceFinalizationDate\(/.test(lock) && /invoiceFinalizationDate\(/.test(nbr), 'VAT-Periodensperre und NBR-Export nutzen dieselbe Quelle');
// nur Anzeige: PDF/Detail unverändert, keine Schreibzugriffe
const pdf = readFileSync(join(repo, 'src/core/pdf/invoice-a5.ts'), 'utf8');
const helper = readFileSync(join(repo, 'src/core/invoices/invoice-list-date.ts'), 'utf8');
const list = readFileSync(join(repo, 'src/pages/invoices/InvoiceList.tsx'), 'utf8');
ok(/\['Date', invoiceDateText\(invoice\.issuedAt \|\| invoice\.createdAt\)\]/.test(pdf), 'PDF druckt weiterhin den Rechnungstag (keine stille Änderung des Dokuments)');
ok(!/UPDATE |INSERT |DELETE |getDatabase|run\(/.test(helper), 'Listendatum ist reine Anzeige (kein Schreiben)');
ok(/invoiceListDate\(inv, nbrPaymentsByInvoice\.get\(inv\.id\)\)/.test(list) && /issued \{fmtDate\(d\.issued\)\}/.test(list), 'Liste zeigt Tag der Vollzahlung und den abweichenden Rechnungstag sichtbar');

console.log(FAIL ? `\nFAIL — invoice-list-date: ${PASS} passed, ${FAIL} failed` : `\nPASS — invoice-list-date: ${PASS} passed, 0 failed`);
process.exit(FAIL ? 1 : 0);
