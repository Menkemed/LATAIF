// B3 / B3-B — isolierter End-to-End-Smoke: echtes sales_returns-Schema (node:sqlite Throwaway-DB)
// + loadSalesData-SQL (1:1 aus sales-metrics-loader.ts) + die ECHTE computeSalesMetrics.
// INVOICE-PERIOD-SEMANTIK (Option A): eine wirksame Return RESTATED die Periode IHRER Rechnung —
// unabhängig von Return-/Approval-/Refund-Datum. Cross-Period-Beweis: Invoice Juni 100 + Return
// Juli APPROVED 20 → Juni 80, Juli 0, August 0, All-Time 80; Refund erst im August ändert nichts;
// Storno (REJECTED) → Juni wieder 100. Kein Live-DB.
// Run: node test/b3/sales-metrics-return.smoke.mjs
import { DatabaseSync } from 'node:sqlite';
import { computeSalesMetrics } from '../../src/core/reports/sales-metrics.ts';

let pass = 0; const fail = [];
const check = (c, m) => { if (c) pass++; else fail.push(m); };
const close = (a, b) => Math.abs(a - b) < 1e-9;

const JUNE = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z' };
const JULY = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z' };
const AUGUST = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE invoices (id TEXT PRIMARY KEY, branch_id TEXT, customer_id TEXT, status TEXT,
    gross_amount REAL, net_amount REAL, margin_snapshot REAL, purchase_price_snapshot REAL,
    issued_at TEXT, created_at TEXT);
  CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT, tax_scheme TEXT, vat_amount REAL);
  CREATE TABLE sales_returns (id TEXT PRIMARY KEY, branch_id TEXT, invoice_id TEXT, status TEXT,
    total_amount REAL, return_date TEXT, refund_paid_amount REAL DEFAULT 0, refund_paid_date TEXT,
    refund_status TEXT DEFAULT 'NOT_REFUNDED');
`);
// Sale: FINAL invoice 100 (net 90, margin 40, cost 50), ausgestellt im JUNI + 1 VAT_10-Line (vat 10)
db.prepare(`INSERT INTO invoices VALUES ('INV1','b1','c1','FINAL',100,90,40,50,'2026-06-15','2026-06-15')`).run();
db.prepare(`INSERT INTO invoice_lines VALUES ('L1','INV1','VAT_10',10)`).run();
// Return: APPROVED (CN existiert), total 20, RETURN-Datum im JULI (Cross-Period), Refund noch NICHT bezahlt
db.prepare(`INSERT INTO sales_returns (id,branch_id,invoice_id,status,total_amount,return_date,refund_paid_amount,refund_status)
            VALUES ('R1','b1','INV1','APPROVED',20,'2026-07-05',0,'PENDING_REFUND')`).run();

// loadSalesData-SQL (1:1 aus dem Loader, all-time / kein Filter — Returns werden NIE zeitgefiltert)
function loadSalesData() {
  const invRows = db.prepare(`SELECT i.id, i.customer_id, i.status, i.gross_amount, i.net_amount,
      i.margin_snapshot, i.purchase_price_snapshot, i.issued_at, i.created_at FROM invoices i WHERE i.status = 'FINAL'`).all();
  const lineRows = db.prepare(`SELECT il.invoice_id, il.tax_scheme, il.vat_amount FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id WHERE i.status = 'FINAL'`).all();
  const linesByInv = new Map();
  for (const lr of lineRows) { const a = linesByInv.get(String(lr.invoice_id)) || []; a.push({ taxScheme: String(lr.tax_scheme || ''), vatAmount: Number(lr.vat_amount) || 0 }); linesByInv.set(String(lr.invoice_id), a); }
  const invoices = invRows.map(r => ({ id: String(r.id), customerId: r.customer_id || undefined, status: String(r.status),
    grossAmount: Number(r.gross_amount) || 0, netAmount: Number(r.net_amount) || 0, marginSnapshot: Number(r.margin_snapshot) || 0,
    purchasePriceSnapshot: Number(r.purchase_price_snapshot) || 0, issuedAt: r.issued_at || undefined, createdAt: r.created_at || undefined,
    lines: linesByInv.get(String(r.id)) || [] }));
  const retRows = db.prepare(`SELECT r.invoice_id, r.status, r.total_amount, r.refund_paid_amount, r.refund_paid_date, r.return_date
      FROM sales_returns r JOIN invoices i ON i.id = r.invoice_id WHERE 1=1`).all();
  const salesReturns = retRows.map(r => ({ invoiceId: String(r.invoice_id), status: String(r.status || ''), totalAmount: Number(r.total_amount) || 0,
    refundPaidAmount: Number(r.refund_paid_amount) || 0, refundPaidDate: r.refund_paid_date || undefined, returnDate: r.return_date || undefined }));
  return { invoices, salesReturns };
}

// 1) All-Time: Invoice 100 − wirksame Return 20 (unbezahlt) → 80 (Betrag = totalAmount, nicht Refund-Cash)
{ const { invoices, salesReturns } = loadSalesData();
  const m = computeSalesMetrics(invoices, salesReturns);
  check(close(m.gross, 80), `Smoke A: All-Time nach Return (unpaid) gross 80, ist ${m.gross}`);
  check(close(m.profit, 32) && close(m.vat, 8), `Smoke A: profit 32 / vat 8, ist ${m.profit}/${m.vat}`);
}

// 2) Cross-Period (Option A): Invoice Juni + Return Juli → Juni RESTATED 80, Juli 0, August 0
{ const { invoices, salesReturns } = loadSalesData();
  const j = computeSalesMetrics(invoices, salesReturns, JUNE).gross;
  const jl = computeSalesMetrics(invoices, salesReturns, JULY).gross;
  const a = computeSalesMetrics(invoices, salesReturns, AUGUST).gross;
  check(close(j, 80), `Smoke B: Juni-Report 80 (Return restated die Juni-Rechnung), ist ${j}`);
  check(close(jl, 0), `Smoke B: Juli-Report 0 (Rechnung nicht in Juli), ist ${jl}`);
  check(close(a, 0), `Smoke B: August-Report 0, ist ${a}`);
}

// 3) Refund erst im August bezahlt → Zuordnung UNVERÄNDERT (Zahlungsdatum irrelevant)
db.prepare(`UPDATE sales_returns SET refund_paid_amount=20, refund_paid_date='2026-08-10', refund_status='REFUNDED', status='REFUNDED' WHERE id='R1'`).run();
{ const { invoices, salesReturns } = loadSalesData();
  const j = computeSalesMetrics(invoices, salesReturns, JUNE).gross;
  const a = computeSalesMetrics(invoices, salesReturns, AUGUST).gross;
  const all = computeSalesMetrics(invoices, salesReturns).gross;
  check(close(j, 80), `Smoke C: nach Refund-Zahlung (Aug) Juni BLEIBT 80, ist ${j}`);
  check(close(a, 0), `Smoke C: August bleibt 0 (kein Event-Period-Abzug), ist ${a}`);
  check(close(all, 80), `Smoke C: All-Time bleibt 80 (kein zweiter Abzug), ist ${all}`);
}

// 4) Storno (REJECTED) → Restatement zurückgenommen: Juni wieder 100
db.prepare(`UPDATE sales_returns SET status='REJECTED' WHERE id='R1'`).run();
{ const { invoices, salesReturns } = loadSalesData();
  const j = computeSalesMetrics(invoices, salesReturns, JUNE).gross;
  const all = computeSalesMetrics(invoices, salesReturns).gross;
  check(close(j, 100), `Smoke D: nach Storno (REJECTED) Juni 100, ist ${j}`);
  check(close(all, 100), `Smoke D: All-Time 100, ist ${all}`);
}

db.close();
const total = pass + fail.length;
console.log(`\nB3 store-smoke: ${pass}/${total} checks passed`);
if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  ✗ ' + f); process.exit(1); }
console.log('✓ B3 store-smoke green (Invoice-Period-Semantik: Cross-Period-Return restated die Rechnungsperiode)');
