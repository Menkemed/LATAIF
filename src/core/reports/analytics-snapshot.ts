// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2C — die Auswertung, einmal gerechnet, für beide Rechner.
//
// Bis hierher stand diese Rechnung IN der Seite: rund fünfzig Abfragen, verteilt auf vier
// `useMemo`-Blöcke, die ihre Filiale aus `currentBranchId()` nahmen. Am Primary war das
// richtig. Auf einem Rechner ohne Datenbank fing jede einzelne Abfrage ihren Fehler ab und
// lieferte eine leere Menge — die Seite zeigte dann überall NULL. Nullen, die wie Zahlen
// aussehen, sind schlimmer als gar keine Seite.
//
// Jetzt gilt derselbe Schnitt wie für jede andere Lesefläche:
//
//   • zustandsfrei — kein React, kein Store, kein Bildschirmzustand
//   • die Filiale kommt aus dem AUSWEIS der Anfrage, nirgends aus der Sitzung des Primary
//   • dieselbe Funktion rechnet am Primary und für die Ferne — es gibt nur EINE Rechnung
//
// Was hier ausdrücklich NICHT entsteht: kein SQL vom Client, kein frei wählbarer Metrik- oder
// Abfragename, keine fünfzig Netzaufrufe. Eine Auskunft, ein begrenztes Ergebnis.
//
// Zeitraum, Kategorie oder Status wären FILTER und gehörten als Parameter hierher — diese
// Fläche hat heute keine: die vier Blöcke hängen allein an der Filiale. Käme einer dazu,
// bliebe er ein Parameter und würde niemals die Filiale ersetzen.
import { query } from '@/core/db/helpers';
import { balanceOf } from '@/core/ledger/queries';
import { computeSalesMetricsByCustomer } from '@/core/reports/sales-metrics';
import { loadSalesData } from '@/core/reports/sales-metrics-loader';
import { getStockAggregates, computeStockValuation } from '@/core/lots/lot-queries';
import type { BusinessReadContext } from '@/core/data/read-context';

export function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

function qry(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  try {
    return query(sql, params);
  } catch {
    return [];
  }
}

export function num(row: Record<string, unknown>, key: string): number {
  return (row[key] as number) || 0;
}

// Anteilige Cash-Refunds auf FINAL-Invoices (cash + pro-rata net/profit). Geteilt von
// Sales- und Finance-Block (vorher 2x identisch dupliziert). All-time (kein Period-Filter,
// passend zur Analytics-Lifetime-Sicht). Regel deckt sich mit computeSalesMetrics.
function finalRefundTotals(branchId: string): { cash: number; net: number; profit: number } {
  const rows = qry(
    `SELECT COALESCE(SUM(r.refund_paid_amount), 0)                                                  AS cash,
            COALESCE(SUM(r.refund_paid_amount * (i.net_amount      / NULLIF(i.gross_amount, 0))), 0)  AS net,
            COALESCE(SUM(r.refund_paid_amount * (i.margin_snapshot / NULLIF(i.gross_amount, 0))), 0)  AS profit
       FROM sales_returns r
       JOIN invoices i ON i.id = r.invoice_id
      WHERE i.branch_id = ? AND i.status = 'FINAL'`,
    [branchId]
  );
  const row = rows[0] || {};
  return { cash: num(row, 'cash'), net: num(row, 'net'), profit: num(row, 'profit') };
}

// ── Tab button style ──

/** Verkauf: Rechnungen, Angebote, Umsatz je Kategorie und Marke. */
export function salesFor(ctx: BusinessReadContext) {
  const branchId = ctx.branchId;
    if (!branchId) return null;

    // Invoices (non-cancelled)
    const invoices = qry(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(gross_amount),0) as gross,
              COALESCE(SUM(net_amount),0) as net,
              COALESCE(SUM(margin_snapshot),0) as profit,
              COALESCE(SUM(purchase_price_snapshot),0) as cost
       FROM invoices WHERE branch_id = ? AND status = 'FINAL'`,
      [branchId]
    );
    const inv = invoices[0] || {};
    const invoiceCount = num(inv, 'cnt');
    const grossInvoiced = num(inv, 'gross');
    const netInvoiced = num(inv, 'net');
    const profitInvoiced = num(inv, 'profit');

    // Refund-Abzug: Cash-Refunds, die zu FINAL-Invoices gehören. Pro-rata netto/profit
    // entsprechend dem Anteil des Refund-Brutto am Original-Brutto pro Invoice (SSOT-Helper).
    const { cash: refundCash, net: refundNet, profit: refundProfit } = finalRefundTotals(branchId);

    const grossRevenue = grossInvoiced - refundCash;
    const netRevenue   = netInvoiced   - refundNet;
    const totalProfit  = profitInvoiced - refundProfit;
    const marginPct = safeDiv(totalProfit, netRevenue) * 100;
    const avgSaleValue = safeDiv(grossRevenue, invoiceCount);

    // Offers
    const offers = qry(
      `SELECT COUNT(*) as cnt FROM offers WHERE branch_id = ?`,
      [branchId]
    );
    const offerCount = num(offers[0] || {}, 'cnt');

    const accepted = qry(
      `SELECT COUNT(*) as cnt FROM offers WHERE branch_id = ? AND status = 'accepted'`,
      [branchId]
    );
    const acceptedCount = num(accepted[0] || {}, 'cnt');
    const closeRate = safeDiv(acceptedCount, offerCount) * 100;

    // Revenue by category
    const revByCat = qry(
      `SELECT c.name, c.color, COALESCE(SUM(il.line_total),0) as revenue, COUNT(il.id) as cnt
       FROM invoice_lines il
       JOIN products p ON p.id = il.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.branch_id = ? AND i.status = 'FINAL'
       GROUP BY c.id ORDER BY revenue DESC`,
      [branchId]
    );

    // Top 5 brands
    const topBrands = qry(
      `SELECT p.brand, COALESCE(SUM(il.line_total),0) as revenue, COUNT(il.id) as cnt
       FROM invoice_lines il
       JOIN products p ON p.id = il.product_id
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.branch_id = ? AND i.status = 'FINAL'
       GROUP BY p.brand ORDER BY revenue DESC LIMIT 5`,
      [branchId]
    );

    return {
      grossRevenue, netRevenue, totalProfit, marginPct,
      invoiceCount, offerCount, closeRate, avgSaleValue,
      revByCat, topBrands,
    };
}

/** Bestand: Stückzahl, Einkaufs- und Verkaufswert, Ladenhüter, Status. */
export function stockFor(ctx: BusinessReadContext) {
  const branchId = ctx.branchId;
    if (!branchId) return null;

    // Total stock value (EK = purchase, VK = planned sale)
    // Plan §Commission §5: nur OWN-Ware zählt als Asset.
    // L-18 — zentrale Hybrid-Bewertung (Lot, sonst pp×qty) via computeStockValuation,
    // konsistent mit Dashboard/BusinessReports. SQL laedt nur die Felder; die Regel ist zentral.
    const stockItems = qry(
      `SELECT p.id, p.purchase_price, p.quantity, p.planned_sale_price,
              COALESCE(c.name, 'Uncategorized') AS cat_name, COALESCE(c.color, '#0F0F10') AS cat_color
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.branch_id = ? AND p.stock_status = 'in_stock' AND p.source_type = 'OWN'`,
      [branchId]
    ).map(r => ({
      id: r.id as string,
      purchasePrice: num(r, 'purchase_price'),
      // ROH weiterreichen: `num` macht aus NULL eine 0, und eine 0 heisst hier "nichts mehr da".
      quantity: (r.quantity ?? null) as number | null,
      plannedSalePrice: num(r, 'planned_sale_price'),
      catName: r.cat_name as string,
      catColor: r.cat_color as string,
    }));
    const stockAgg = getStockAggregates(stockItems.map(i => i.id));
    const totalVal = computeStockValuation(stockItems, stockAgg);
    const totalItems = totalVal.count;
    const totalEK = totalVal.cost;
    const totalVK = totalVal.plannedSale;

    // Items by category — gleiche Hybrid-Regel, EIN agg fuer alle.
    const catGroups = new Map<string, { name: string; color: string; items: typeof stockItems }>();
    for (const it of stockItems) {
      const g = catGroups.get(it.catName) || { name: it.catName, color: it.catColor, items: [] as typeof stockItems };
      g.items.push(it);
      catGroups.set(it.catName, g);
    }
    const byCat = [...catGroups.values()].map(g => {
      const v = computeStockValuation(g.items, stockAgg);
      return { name: g.name, color: g.color, cnt: v.count, value: v.cost };
    }).sort((a, b) => b.value - a.value);

    // Slow movers (> 90 days in stock)
    const slow = qry(
      `SELECT COUNT(*) as cnt FROM products
       WHERE branch_id = ? AND stock_status = 'in_stock' AND days_in_stock > 90`,
      [branchId]
    );
    const slowCount = num(slow[0] || {}, 'cnt');

    // Average days in stock
    const avgDays = qry(
      `SELECT COALESCE(AVG(days_in_stock),0) as avg_days
       FROM products WHERE branch_id = ? AND stock_status = 'in_stock'`,
      [branchId]
    );
    const avgDaysInStock = num(avgDays[0] || {}, 'avg_days');

    // Status breakdown (all products, not just in_stock)
    const byStatus = qry(
      `SELECT stock_status, COUNT(*) as cnt
       FROM products WHERE branch_id = ?
       GROUP BY stock_status ORDER BY cnt DESC`,
      [branchId]
    );

    return { totalItems, totalEK, totalVK, byCat, slowCount, avgDaysInStock, byStatus };
}

/** Finanzen: Erlöse, Steuern, Zahlungswege, Salden, Quartale. */
export function financeFor(ctx: BusinessReadContext) {
  const branchId = ctx.branchId;
    if (!branchId) return null;

    // Revenue totals from final invoices.
    // Total VAT muss BEIDE Steuern erfassen — auch in mixed-Scheme-Invoices (typisch: Watch via MARGIN
    // + Strap/Box via VAT_10 in derselben Rechnung). Lösung: per-Line aggregieren.
    //  - Stored vat_amount (Invoice-Level): erfasst nur VAT_10/ZERO-Anteile (MARGIN-Lines speichern 0)
    //  - Margin-VAT muss live aus invoice_lines berechnet werden:
    //    qty × max(0, unit_price − purchase_price) × vat_rate / (100 + vat_rate)
    const rev = qry(
      `SELECT COALESCE(SUM(net_amount),0) as net,
              COALESCE(SUM(gross_amount),0) as gross,
              COALESCE(SUM(vat_amount),0) as stored_vat,
              COALESCE(SUM(margin_snapshot),0) as profit
       FROM invoices WHERE branch_id = ? AND status = 'FINAL'`,
      [branchId]
    );
    // Per-Line MARGIN-VAT — über alle FINAL-Invoices, alle Lines mit tax_scheme='MARGIN'.
    const marginVatRow = qry(
      `SELECT COALESCE(SUM(
         CASE WHEN il.tax_scheme = 'MARGIN' AND il.unit_price > il.purchase_price_snapshot
           THEN COALESCE(il.quantity, 1) * (il.unit_price - il.purchase_price_snapshot)
                * il.vat_rate / (100 + il.vat_rate)
         ELSE 0 END
       ),0) AS margin_vat
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.branch_id = ? AND i.status = 'FINAL'`,
      [branchId]
    );
    const r = rev[0] || {};
    // Refund-Abzug: identisch zu sales-block — pro-rata net/gross/profit aus Cash-Refunds
    // auf FINAL-Invoices (SSOT-Helper). Sonst zeigt der Finance-Tab inflated Revenue & Profit.
    const fRefunds = finalRefundTotals(branchId);
    const netRevenue = num(r, 'net') - fRefunds.net;
    const grossRevenue = num(r, 'gross') - fRefunds.cash;
    const totalVat = num(r, 'stored_vat') + num(marginVatRow[0] || {}, 'margin_vat');
    const profitAfterVat = num(r, 'profit') - fRefunds.profit;

    // Plan §Purchase §Tax: Input-VAT (Vorsteuer aus Purchases) für Verrechnung
    // gegen Output-VAT. Zählt nur nicht-stornierte Purchases.
    const inputVatRow = qry(
      `SELECT COALESCE(SUM(pl.vat_amount), 0) AS input_vat
       FROM purchase_lines pl
       JOIN purchases p ON p.id = pl.purchase_id
       WHERE p.branch_id = ? AND p.status != 'CANCELLED'`,
      [branchId]
    );
    const totalInputVat = num(inputVatRow[0] || {}, 'input_vat');
    // Plan §Tax §Erstattung: Wenn Input > Output → wir haben Anspruch auf Erstattung
    // vom Finanzamt (statt Schuld). Beide Beträge separat halten, damit UI zwischen
    // „we owe NBR" (netVatOwed) und „NBR owes us" (vatRefundDue) unterscheidet.
    const netVatBalance = totalVat - totalInputVat;
    const netVatOwed = Math.max(0, netVatBalance);
    const vatRefundDue = Math.max(0, -netVatBalance);

    // Open invoices — PARTIAL = nicht voll bezahlt. 'issued'/'partially_paid'
    // waren Alt-Status (siehe database.ts Migration) und sind zu PARTIAL migriert.
    const open = qry(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(gross_amount - paid_amount),0) as outstanding
       FROM invoices WHERE branch_id = ? AND status = 'PARTIAL'`,
      [branchId]
    );
    const o = open[0] || {};
    const openCount = num(o, 'cnt');
    const openValue = num(o, 'outstanding');

    // Paid invoices
    const paid = qry(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(paid_amount),0) as total_paid
       FROM invoices WHERE branch_id = ? AND status = 'FINAL'`,
      [branchId]
    );
    const p = paid[0] || {};
    const paidCount = num(p, 'cnt');
    const paidValue = num(p, 'total_paid');

    // Revenue from repairs (completed or picked_up with charge)
    // M-09 — invoice_id IS NULL: konvertierte Repairs laufen ueber die Invoice
    // (paidValue) — sonst Doppelzaehlung von Umsatz UND Profit. Deckt sich mit
    // dem Cashflow-Block unten (`AND invoice_id IS NULL`).
    const repairRev = qry(
      `SELECT COALESCE(SUM(charge_to_customer),0) as rev, COALESCE(SUM(margin),0) as profit
       FROM repairs WHERE branch_id = ? AND status IN ('ready','picked_up') AND charge_to_customer > 0
       AND invoice_id IS NULL`,
      [branchId]
    );
    const repRev = num(repairRev[0] || {}, 'rev');

    // Consignment commissions
    const conComm = qry(
      `SELECT COALESCE(SUM(commission_amount),0) as comm
       FROM consignments WHERE branch_id = ? AND status IN ('sold','paid_out')`,
      [branchId]
    );
    const consignmentComm = num(conComm[0] || {}, 'comm');

    // L-15 — Scrap Gold Spread als EIGENER Revenue-Stream (Entscheid A: Scrap bleibt
    // separat, nie in netRevenue gemischt). Nur completed Trades; Income = Spread
    // (Profit), NIEMALS der volle Sale-Price. All-time, konsistent zum Analytics-Ansatz.
    const scrapRow = qry(
      `SELECT COALESCE(SUM(profit),0) as spread
       FROM scrap_trades WHERE branch_id = ? AND status = 'completed'`,
      [branchId]
    );
    const scrapSpread = num(scrapRow[0] || {}, 'spread');

    // Agent commissions (what we pay out to agents)
    const agentComm = qry(
      `SELECT COALESCE(SUM(commission_amount),0) as comm
       FROM agent_transfers WHERE branch_id = ? AND status IN ('sold','settled')`,
      [branchId]
    );
    const agentCommTotal = num(agentComm[0] || {}, 'comm');

    // Outstanding payments (total owed to us)
    const outstandingPayments = openValue;

    // ── Cashflow: Cash vs Bank vs Card (with fee deduction) ──
    const payByMethod = qry(
      `SELECT method, COALESCE(SUM(amount),0) as total
       FROM payments WHERE branch_id = ? GROUP BY method`,
      [branchId]
    );
    let cashReceived = 0, bankReceived = 0, cardReceived = 0, benefitReceived = 0, otherReceived = 0;
    for (const row of payByMethod) {
      const m = row.method as string;
      const amt = (row.total as number) || 0;
      if (m === 'cash') cashReceived += amt;
      else if (m === 'bank_transfer') bankReceived += amt;
      else if (m === 'card') cardReceived += amt;
      else if (m === 'benefit') benefitReceived += amt;
      else otherReceived += amt; // legacy 'crypto' etc.
    }
    // v0.7.26 — Brand-genaue Karten-Gebuehr: die TATSAECHLICH gebuchten CardFees
    // (Amex 2,5% / Normal 2,2%) summieren statt pauschal mit einer Einzelrate zu
    // schaetzen. So stimmt Analytics exakt mit Ledger + Banking ueberein (CANCELLED
    // ausgeschlossen). Karten-Zahlungen vor dem Feature haben keine gebuchte Gebuehr
    // -> 0 (korrekt; real wurde keine gebucht, Banking nettet sie ebenfalls nicht).
    const invCardFeeRow = qry(
      `SELECT COALESCE(SUM(amount),0) as fee FROM expenses
       WHERE branch_id = ? AND category = 'CardFees' AND status != 'CANCELLED'
         AND related_module = 'invoice'`,
      [branchId]
    );
    const cardFeeLost = Math.round(num(invCardFeeRow[0] || {}, 'fee') * 1000) / 1000;
    const cardNetToBank = cardReceived - cardFeeLost;
    // Effektive (gemischte) Rate nur fuer die Anzeige.
    const cardFeeRate = cardReceived > 0 ? Math.round((cardFeeLost / cardReceived) * 10000) / 100 : 0;
    // Quarterly tax paid (outflow)
    const taxPaidRows = qry(
      `SELECT year, quarter, amount, source FROM tax_payments WHERE branch_id = ?`,
      [branchId]
    );
    let taxPaidTotal = 0, taxPaidFromCash = 0, taxPaidFromBank = 0;
    for (const t of taxPaidRows) {
      const a = (t.amount as number) || 0;
      taxPaidTotal += a;
      if ((t.source as string) === 'cash') taxPaidFromCash += a;
      else taxPaidFromBank += a;
    }
    // Debt flows (if debts table exists)
    let lentOutCash = 0, lentOutBank = 0, borrowedInCash = 0, borrowedInBank = 0;
    let debtRepaidToUsCash = 0, debtRepaidToUsBank = 0;
    let debtRepaidByUsCash = 0, debtRepaidByUsBank = 0;
    try {
      const debts = qry(`SELECT direction, source, amount FROM debts WHERE branch_id = ?`, [branchId]);
      for (const d of debts) {
        const a = (d.amount as number) || 0;
        const src = d.source as string;
        if (d.direction === 'we_lend') {
          if (src === 'cash') lentOutCash += a; else lentOutBank += a;
        } else {
          if (src === 'cash') borrowedInCash += a; else borrowedInBank += a;
        }
      }
      const dpays = qry(
        `SELECT dp.amount, dp.source, d.direction
         FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id
         WHERE d.branch_id = ?`,
        [branchId]
      );
      for (const p of dpays) {
        const a = (p.amount as number) || 0;
        const src = p.source as string;
        if (p.direction === 'we_lend') {
          if (src === 'cash') debtRepaidToUsCash += a; else debtRepaidToUsBank += a;
        } else {
          if (src === 'cash') debtRepaidByUsCash += a; else debtRepaidByUsBank += a;
        }
      }
    } catch { /* debts table not yet migrated */ }

    // Opening balances (admin-set status quo)
    const openingRows = qry(
      `SELECT key, value FROM settings WHERE branch_id = ? AND (key = 'finance.opening_cash' OR key = 'finance.opening_bank')`,
      [branchId]
    );
    let openingCash = 0, openingBank = 0;
    for (const r of openingRows) {
      const v = parseFloat((r.value as string) || '0') || 0;
      if (r.key === 'finance.opening_cash') openingCash = v;
      else if (r.key === 'finance.opening_bank') openingBank = v;
    }

    // Product EK outflow (cash / bank)
    let productEkCash = 0, productEkBank = 0;
    try {
      const ekRows = qry(
        `SELECT paid_from, COALESCE(SUM(purchase_price),0) as total
         FROM products WHERE branch_id = ? AND paid_from IS NOT NULL GROUP BY paid_from`,
        [branchId]
      );
      for (const r of ekRows) {
        const t = (r.total as number) || 0;
        if (r.paid_from === 'cash') productEkCash += t;
        else if (r.paid_from === 'bank') productEkBank += t;
      }
    } catch { /* columns not yet migrated */ }

    // Repair cashflow
    let repairCashIn = 0, repairBankIn = 0, repairCashOut = 0, repairBankOut = 0;
    try {
      // v0.7.26 — invoice_id IS NULL: konvertierte Repairs laufen ueber invoice.payments
      // (Doppelzaehlung vermeiden, deckt sich mit bankingStore `if (r.invoice_id) continue`).
      const rpIn = qry(
        `SELECT customer_paid_from, COALESCE(SUM(charge_to_customer),0) as total
         FROM repairs WHERE branch_id = ? AND status IN ('ready','picked_up')
         AND customer_paid_from IS NOT NULL AND charge_to_customer > 0
         AND invoice_id IS NULL GROUP BY customer_paid_from`,
        [branchId]
      );
      for (const r of rpIn) {
        const t = (r.total as number) || 0;
        if (r.customer_paid_from === 'cash') repairCashIn += t;
        else if (r.customer_paid_from === 'bank') repairBankIn += t;
        else if (r.customer_paid_from === 'card') repairBankIn += t; // brutto; Gebuehr unten netto abziehen
        // 'benefit' → BENEFIT-Konto (separater Geldtopf, in dieser cash/bank-Cashflow-Sicht nicht gefuehrt)
      }
      // v0.7.26 — Repair-Karten-Gebuehr brand-genau aus den ECHTEN CardFees abziehen
      // (gleiche Scope wie rpIn: ready/picked_up, nicht invoice-gekoppelt). Karte settled
      // netto an die Bank.
      const repairCardFeeRow = qry(
        `SELECT COALESCE(SUM(e.amount),0) as fee FROM expenses e
         JOIN repairs r ON r.id = e.related_entity_id
         WHERE e.branch_id = ? AND e.category = 'CardFees' AND e.status != 'CANCELLED'
           AND e.related_module = 'repair' AND r.invoice_id IS NULL
           AND r.status IN ('ready','picked_up')`,
        [branchId]
      );
      repairBankIn -= Math.round(num(repairCardFeeRow[0] || {}, 'fee') * 1000) / 1000;
      const rpOut = qry(
        `SELECT internal_paid_from, COALESCE(SUM(internal_cost),0) as total
         FROM repairs WHERE branch_id = ? AND internal_paid_from IS NOT NULL
         AND internal_cost > 0 GROUP BY internal_paid_from`,
        [branchId]
      );
      for (const r of rpOut) {
        const t = (r.total as number) || 0;
        if (r.internal_paid_from === 'cash') repairCashOut += t;
        else if (r.internal_paid_from === 'bank') repairBankOut += t;
      }
    } catch { /* ignore */ }

    // Consignment cashflow (sale income + payout)
    let consignSaleCash = 0, consignSaleBank = 0, consignPayoutCash = 0, consignPayoutBank = 0;
    try {
      const cnIn = qry(
        `SELECT sale_method, COALESCE(SUM(sale_price),0) as total
         FROM consignments WHERE branch_id = ? AND status IN ('sold','paid_out')
         AND sale_method IS NOT NULL GROUP BY sale_method`,
        [branchId]
      );
      for (const r of cnIn) {
        const t = (r.total as number) || 0;
        if (r.sale_method === 'cash') consignSaleCash += t;
        else if (r.sale_method === 'bank') consignSaleBank += t;
      }
      const cnOut = qry(
        `SELECT payout_method, COALESCE(SUM(payout_amount),0) as total
         FROM consignments WHERE branch_id = ? AND payout_status = 'paid'
         AND payout_method IS NOT NULL GROUP BY payout_method`,
        [branchId]
      );
      for (const r of cnOut) {
        const t = (r.total as number) || 0;
        if (r.payout_method === 'cash') consignPayoutCash += t;
        else consignPayoutBank += t; // treat bank_transfer/card as bank
      }
    } catch { /* ignore */ }

    // Agent/Approval Settlements (Inflow): Der Agent verkauft unsere Ware und
    // zahlt uns den Erlös abzüglich Kommission aus → Geld kommt rein.
    // Konvertierte Transfers (mit invoice_id) werden hier NICHT gezählt — deren
    // Cashflow läuft über die Invoice-Payments (= cashReceived/bankReceived).
    let agentSettleCash = 0, agentSettleBank = 0;
    try {
      const agRows = qry(
        `SELECT asp.method, COALESCE(SUM(asp.amount),0) as total
         FROM agent_settlement_payments asp
         JOIN agent_transfers at ON at.id = asp.transfer_id
         WHERE at.branch_id = ? AND at.invoice_id IS NULL
         GROUP BY asp.method`,
        [branchId]
      );
      for (const r of agRows) {
        const t = (r.total as number) || 0;
        if (r.method === 'cash') agentSettleCash += t;
        else if (r.method === 'bank') agentSettleBank += t;
      }
    } catch { /* ignore */ }

    // Order deposits not yet converted to invoice (avoid doubling after conversion)
    let orderDepositCash = 0, orderDepositBank = 0;
    try {
      const opRows = qry(
        `SELECT op.method, COALESCE(SUM(op.amount),0) as total
         FROM order_payments op JOIN orders o ON o.id = op.order_id
         WHERE o.branch_id = ? AND COALESCE(op.converted_to_invoice,0) = 0
           AND o.status != 'cancelled'
         GROUP BY op.method`,
        [branchId]
      );
      for (const r of opRows) {
        const t = (r.total as number) || 0;
        const m = (r.method as string) || 'cash';
        if (m === 'cash') orderDepositCash += t;
        else if (m === 'bank_transfer') orderDepositBank += t;
        else if (m === 'card') orderDepositBank += t; // brutto; Gebuehr unten brand-genau abziehen
      }
      // v0.7.26 — Karten-Gebuehr der noch NICHT konvertierten Order-Anzahlungen
      // brand-genau aus den TATSAECHLICH gebuchten CardFees abziehen. Konvertierte
      // Anzahlungen sind als CardFee CANCELLED (status-Filter), cancelled-Orders via
      // Join raus -> Scope deckt sich mit der order_payments-Query oben.
      const ordCardFeeRow = qry(
        `SELECT COALESCE(SUM(e.amount),0) as fee FROM expenses e
         JOIN orders o ON o.id = e.related_entity_id
         WHERE e.branch_id = ? AND e.category = 'CardFees' AND e.status != 'CANCELLED'
           AND e.related_module = 'order' AND o.status != 'cancelled'`,
        [branchId]
      );
      orderDepositBank -= Math.round(num(ordCardFeeRow[0] || {}, 'fee') * 1000) / 1000;
    } catch { /* ignore */ }

    // Phase 1 — Purchase payments (Plan §Purchases §8), Cash/Bank ↓
    let purchasePaidCash = 0, purchasePaidBank = 0;
    try {
      const ppRows = qry(
        `SELECT pp.method, COALESCE(SUM(pp.amount),0) as total
         FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
         WHERE p.branch_id = ? AND p.status != 'CANCELLED'
         GROUP BY pp.method`,
        [branchId]
      );
      for (const r of ppRows) {
        const t = (r.total as number) || 0;
        if (r.method === 'cash') purchasePaidCash += t;
        else if (r.method === 'bank') purchasePaidBank += t;
      }
    } catch { /* ignore */ }

    // Phase 1 — Expenses (Plan §Expenses §6), Cash/Bank ↓
    let expenseCash = 0, expenseBank = 0;
    try {
      const expRows = qry(
        `SELECT payment_method, COALESCE(SUM(amount),0) as total
         FROM expenses WHERE branch_id = ? GROUP BY payment_method`,
        [branchId]
      );
      for (const r of expRows) {
        const t = (r.total as number) || 0;
        if (r.payment_method === 'cash') expenseCash += t;
        else if (r.payment_method === 'bank') expenseBank += t;
      }
    } catch { /* ignore */ }

    // Phase 2 — Sales Return refunds (Plan §Returns §7), Cash/Bank ↓
    let salesRefundCash = 0, salesRefundBank = 0;
    try {
      const srRows = qry(
        `SELECT refund_method, COALESCE(SUM(refund_amount),0) as total
         FROM sales_returns WHERE branch_id = ? AND status = 'REFUNDED'
         AND refund_method IS NOT NULL AND refund_amount > 0
         GROUP BY refund_method`,
        [branchId]
      );
      for (const r of srRows) {
        const t = (r.total as number) || 0;
        if (r.refund_method === 'cash') salesRefundCash += t;
        else if (r.refund_method === 'bank') salesRefundBank += t;
      }
    } catch { /* ignore */ }

    // Phase 4 — Bank Transfers (Cash ↔ Bank ↔ Benefit). Plan §Banking §10
    // Cash- und Bank-Bilanzen müssen alle 6 Richtungen kennen — Benefit-Transfers
    // verschieben Geld von/in Cash bzw. Bank, sonst kippt die Liquid-Summe.
    let cashToBank = 0, bankToCash = 0;
    let cashToBenefit = 0, benefitToCash = 0;
    let bankToBenefit = 0, benefitToBank = 0;
    try {
      const btRows = qry(
        `SELECT direction, COALESCE(SUM(amount),0) as total FROM bank_transfers WHERE branch_id = ? GROUP BY direction`,
        [branchId]
      );
      for (const r of btRows) {
        const t = (r.total as number) || 0;
        switch (r.direction) {
          case 'CASH_TO_BANK':    cashToBank    += t; break;
          case 'BANK_TO_CASH':    bankToCash    += t; break;
          case 'CASH_TO_BENEFIT': cashToBenefit += t; break;
          case 'BENEFIT_TO_CASH': benefitToCash += t; break;
          case 'BANK_TO_BENEFIT': bankToBenefit += t; break;
          case 'BENEFIT_TO_BANK': benefitToBank += t; break;
        }
      }
    } catch { /* ignore */ }

    // Phase 4 — Partner investments (IN) + withdrawals (OUT) + profit distributions (OUT)
    let partnerInvestCash = 0, partnerInvestBank = 0;
    let partnerWithdrawCash = 0, partnerWithdrawBank = 0;
    try {
      const ptRows = qry(
        `SELECT type, method, COALESCE(SUM(amount),0) as total
         FROM partner_transactions WHERE branch_id = ? GROUP BY type, method`,
        [branchId]
      );
      for (const r of ptRows) {
        const t = (r.total as number) || 0;
        const m = r.method as string;
        const type = r.type as string;
        if (type === 'INVESTMENT') {
          if (m === 'cash') partnerInvestCash += t; else partnerInvestBank += t;
        } else {
          // WITHDRAWAL + PROFIT_DISTRIBUTION both reduce liquid cash
          if (m === 'cash') partnerWithdrawCash += t; else partnerWithdrawBank += t;
        }
      }
    } catch { /* ignore */ }

    // Phase 1 — Purchase return refunds (Plan §Purchase Returns §9), Cash/Bank ↑
    let purchaseRefundCash = 0, purchaseRefundBank = 0;
    try {
      const prRows = qry(
        `SELECT refund_method, COALESCE(SUM(refund_amount),0) as total
         FROM purchase_returns WHERE branch_id = ? AND status = 'CONFIRMED'
         AND refund_method IS NOT NULL AND refund_method != 'credit' AND refund_amount > 0
         GROUP BY refund_method`,
        [branchId]
      );
      for (const r of prRows) {
        const t = (r.total as number) || 0;
        if (r.refund_method === 'cash') purchaseRefundCash += t;
        else if (r.refund_method === 'bank') purchaseRefundBank += t;
      }
    } catch { /* ignore */ }

    // M-12 Phase 2 — Cash/Bank/Benefit-Saldo aus dem Ledger-SSOT (balanceOf), All-Time
    // (dieses Memo ist nicht periodengefiltert, gleiche Semantik wie die bisherige
    // Hand-Aggregation). Karten-Geld liegt auf CARD_CLEARING (brutto−Gebühr) und wird
    // wie bisher in die Bank-Liquidität eingerechnet (Parität zur alten cardNetToBank-
    // Sicht). Opening lebt jetzt im Ledger (postOpeningBalances / Backfill-Button) —
    // die settings-basierten openingCash/openingBank dienen nur noch der Info-Zeile.
    // Die vielen Flow-Variablen oben bleiben für die CASH-&-BANK-BREAKDOWN-Zeilen.
    const cashBalance = balanceOf('CASH', { branchId });
    const bankBalance = balanceOf('BANK', { branchId }) + balanceOf('CARD_CLEARING', { branchId });
    const benefitBalance = balanceOf('BENEFIT', { branchId });
    const totalLiquid = cashBalance + bankBalance + benefitBalance;

    // ── Quarterly VAT (owed) ──
    // vat = Output-VAT (aus Sales), inputVat = Vorsteuer (aus Purchases),
    // netVat = max(0, vat − inputVat) = was effektiv an NBR gezahlt werden muss,
    // refund = max(0, inputVat − vat) = was die NBR uns erstatten muss.
    type QuarterRow = { year: number; quarter: number; vat: number; inputVat: number; netVat: number; refund: number; paid: number };
    const fyStartRow = qry(
      `SELECT value FROM settings WHERE branch_id = ? AND key = 'finance.fiscal_year_start_month'`,
      [branchId]
    );
    const fyStartMonth = parseInt((fyStartRow[0]?.value as string) || '1') || 1; // 1-12

    // Quarterly VAT: per-invoice effective VAT = stored vat_amount (VAT_10/ZERO-Anteile)
    // PLUS per-line MARGIN-VAT-Subselect (für mixed-Scheme-Invoices ist das essentiell —
    // dort enthält der invoice-level vat_amount nur den VAT_10-Anteil, MARGIN-Anteil fehlt).
    const vatByInv = qry(
      `SELECT COALESCE(i.issued_at, i.created_at) as d,
              i.vat_amount + COALESCE((
                SELECT SUM(
                  CASE WHEN il.tax_scheme = 'MARGIN' AND il.unit_price > il.purchase_price_snapshot
                    THEN COALESCE(il.quantity, 1) * (il.unit_price - il.purchase_price_snapshot)
                         * il.vat_rate / (100 + il.vat_rate)
                  ELSE 0 END
                )
                FROM invoice_lines il WHERE il.invoice_id = i.id
              ), 0) AS effective_vat
         FROM invoices i
        WHERE i.branch_id = ? AND i.status != 'CANCELLED' AND i.status != 'DRAFT'
          AND COALESCE(i.butterfly,0) = 0`,
      [branchId]
    );
    const quarterlyVatOwed: Record<string, number> = {};
    for (const row of vatByInv) {
      const d = new Date((row.d as string) || Date.now());
      const year = d.getFullYear();
      const month = d.getMonth() + 1; // 1-12
      // Map calendar month to fiscal quarter (1-4)
      const fyOffset = ((month - fyStartMonth + 12) % 12); // 0-11 within fy
      const q = Math.floor(fyOffset / 3) + 1;
      // Fiscal year label: the calendar year of the quarter's start month
      const key = `${year}-Q${q}`;
      quarterlyVatOwed[key] = (quarterlyVatOwed[key] || 0) + ((row.effective_vat as number) || 0);
    }
    const quarterlyVatPaid: Record<string, number> = {};
    for (const t of taxPaidRows) {
      const key = `${t.year}-Q${t.quarter}`;
      quarterlyVatPaid[key] = (quarterlyVatPaid[key] || 0) + ((t.amount as number) || 0);
    }
    // Plan §Purchase §Tax: Input-VAT per Fiscal-Quarter — wird gegen Output-VAT
    // verrechnet, sodass nur die Netto-Schuld an die NBR ausgewiesen wird.
    const inputVatByPurchase = qry(
      `SELECT COALESCE(p.purchase_date, p.created_at) AS d,
              COALESCE((SELECT SUM(vat_amount) FROM purchase_lines WHERE purchase_id = p.id), 0) AS input_vat
       FROM purchases p
       WHERE p.branch_id = ? AND p.status != 'CANCELLED'`,
      [branchId]
    );
    const quarterlyInputVat: Record<string, number> = {};
    for (const row of inputVatByPurchase) {
      const d = new Date((row.d as string) || Date.now());
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const fyOffset = ((month - fyStartMonth + 12) % 12);
      const q = Math.floor(fyOffset / 3) + 1;
      const key = `${year}-Q${q}`;
      quarterlyInputVat[key] = (quarterlyInputVat[key] || 0) + ((row.input_vat as number) || 0);
    }
    // Gemeinsame Key-Menge — auch Quartale, in denen es nur Purchases ohne Sales gab
    // (z.B. erstes Lager-Aufbau), sollen sichtbar sein.
    const allQuarterKeys = new Set<string>([
      ...Object.keys(quarterlyVatOwed),
      ...Object.keys(quarterlyInputVat),
    ]);
    const quarterly: QuarterRow[] = Array.from(allQuarterKeys)
      .sort((a, b) => b.localeCompare(a))
      .map(k => {
        const [yearStr, qStr] = k.split('-Q');
        const owed = quarterlyVatOwed[k] || 0;
        const input = quarterlyInputVat[k] || 0;
        const balance = owed - input;
        return {
          year: parseInt(yearStr),
          quarter: parseInt(qStr),
          vat: owed,
          inputVat: input,
          netVat: Math.max(0, balance),
          refund: Math.max(0, -balance),
          paid: quarterlyVatPaid[k] || 0,
        };
      });

    return {
      netRevenue, grossRevenue, totalVat, totalInputVat, netVatOwed, vatRefundDue, profitAfterVat,
      openCount, openValue, paidCount, paidValue,
      repairRevenue: repRev, consignmentComm, agentCommTotal, scrapSpread,
      outstandingPayments,
      // Cashflow
      cashReceived, bankReceived, cardReceived, benefitReceived, otherReceived,
      cardFeeRate, cardFeeLost, cardNetToBank,
      cashBalance, bankBalance, benefitBalance, totalLiquid,
      openingCash, openingBank,
      productEkCash, productEkBank,
      purchasePaidCash, purchasePaidBank,
      expenseCash, expenseBank,
      purchaseRefundCash, purchaseRefundBank,
      salesRefundCash, salesRefundBank,
      partnerInvestCash, partnerInvestBank,
      partnerWithdrawCash, partnerWithdrawBank,
      cashToBank, bankToCash, cashToBenefit, benefitToCash, bankToBenefit, benefitToBank,
      repairCashIn, repairBankIn, repairCashOut, repairBankOut,
      consignSaleCash, consignSaleBank, consignPayoutCash, consignPayoutBank,
      agentSettleCash, agentSettleBank,
      orderDepositCash, orderDepositBank,
      // Debt flows
      lentOutCash, lentOutBank, borrowedInCash, borrowedInBank,
      debtRepaidToUsCash, debtRepaidToUsBank, debtRepaidByUsCash, debtRepaidByUsBank,
      // Tax
      taxPaidTotal, taxPaidFromCash, taxPaidFromBank,
      quarterly,
    };
}


  // M-01 — Revenue/Profit/Counts pro Kunde aus der EINEN SSOT (loadSalesData →
  // computeSalesMetricsByCustomer, rechnungsbasiert all-time) statt aus stale
  // customers.total_*/purchase_count. sys-Sentinels (z.B. sys-own-shop-*) sind
  // KEINE Clients und fliegen ueberall raus — vorher konnte "Own Shop" als
  // Top-Client erscheinen.
export function clientsFor(ctx: BusinessReadContext) {
  const branchId = ctx.branchId;
    if (!branchId) return null;

    // Total clients
    const total = qry(
      `SELECT COUNT(*) as cnt FROM customers WHERE branch_id = ? AND id NOT LIKE 'sys-%'`,
      [branchId]
    );
    const totalClients = num(total[0] || {}, 'cnt');

    // Active (purchased in last 180 days)
    const active = qry(
      `SELECT COUNT(*) as cnt FROM customers
       WHERE branch_id = ? AND id NOT LIKE 'sys-%' AND last_purchase_at IS NOT NULL
       AND last_purchase_at >= date('now','-180 days')`,
      [branchId]
    );
    const activeClients = num(active[0] || {}, 'cnt');

    // Dormant
    const dormant = qry(
      `SELECT COUNT(*) as cnt FROM customers
       WHERE branch_id = ? AND id NOT LIKE 'sys-%' AND sales_stage = 'dormant'`,
      [branchId]
    );
    const dormantClients = num(dormant[0] || {}, 'cnt');

    // Per-Kunde-Metriken (SSOT). Namens-Map zugleich null-Guard: Invoices auf
    // geloeschte oder sys-Kunden tragen nicht zu den Client-Karten bei.
    const { invoices, salesReturns } = loadSalesData({ branchId });
    const byCustomer = computeSalesMetricsByCustomer(invoices, salesReturns);
    const nameRows = qry(
      `SELECT id, first_name, last_name FROM customers
       WHERE branch_id = ? AND id NOT LIKE 'sys-%'`,
      [branchId]
    );
    const names = new Map(nameRows.map(r => [
      String(r.id),
      `${(r.first_name as string) || ''} ${(r.last_name as string) || ''}`.trim(),
    ]));
    const perClient = [...byCustomer.entries()]
      .filter(([id]) => names.has(id))
      .map(([id, m]) => ({ id, name: names.get(id)!, gross: m.gross, profit: m.profit, count: m.count }));

    // Top 5 by revenue / by profit
    const topByRev = perClient.filter(p => p.gross > 0)
      .sort((a, b) => b.gross - a.gross).slice(0, 5);
    const topByProfit = perClient.filter(p => p.profit > 0)
      .sort((a, b) => b.profit - a.profit).slice(0, 5);

    // Average client value
    const avgClientValue = safeDiv(perClient.reduce((s, p) => s + p.gross, 0), totalClients);

    // Repeat purchase rate (count = FINAL-Rechnungen, gleiche Regel wie Revenue)
    const buyingCount = perClient.filter(p => p.count >= 1).length;
    const repeatCount = perClient.filter(p => p.count >= 2).length;
    const repeatRate = safeDiv(repeatCount, buyingCount) * 100;

    // VIP distribution
    const vipDist = qry(
      `SELECT vip_level, COUNT(*) as cnt
       FROM customers WHERE branch_id = ? AND id NOT LIKE 'sys-%'
       GROUP BY vip_level ORDER BY vip_level`,
      [branchId]
    );

    return {
      totalClients, activeClients, dormantClients,
      topByRev, topByProfit, avgClientValue,
      repeatRate, buyingCount, repeatCount, vipDist,
    };
}

/** Was die Auswertungsseite zeigt — vier Blöcke, ein Ergebnis. */
export interface AnalyticsSnapshot {
  sales: ReturnType<typeof salesFor>;
  stock: ReturnType<typeof stockFor>;
  finance: ReturnType<typeof financeFor>;
  clients: ReturnType<typeof clientsFor>;
}

/**
 * Die eine Auskunft. Sie rechnet alle vier Blöcke in einem Durchgang — der Client bekommt sie
 * mit EINER Anfrage statt mit fünfzig, und die Zahlen stammen garantiert aus demselben
 * Augenblick.
 */
export function loadAnalyticsFor(ctx: BusinessReadContext): { snapshot: AnalyticsSnapshot } {
  return {
    snapshot: {
      sales: salesFor(ctx),
      stock: stockFor(ctx),
      finance: financeFor(ctx),
      clients: clientsFor(ctx),
    },
  };
}

/**
 * Der Steuerbericht zum Herunterladen — bewusst NICHT Teil der Auskunft oben.
 *
 * Er ist zeilenweise und kann groß werden; er reist deshalb nur, wenn jemand den Knopf
 * wirklich drückt. Auch hier: die Filiale kommt aus dem Ausweis, und es kommen ausschließlich
 * abgeschlossene Rechnungen.
 */
export function vatExportRowsFor(ctx: BusinessReadContext): {
  invoices: Record<string, unknown>[];
  lines: Record<string, unknown>[];
} {
  const invoices = qry(
    `SELECT i.invoice_number, i.created_at, i.net_amount, i.vat_amount, i.gross_amount, i.tax_scheme_snapshot, i.margin_snapshot, i.purchase_price_snapshot, i.sale_price_snapshot, i.status,
            c.first_name || ' ' || c.last_name as customer_name
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.branch_id = ? AND i.status = 'FINAL' ORDER BY i.created_at DESC`,
    [ctx.branchId]
  );
  const lines = qry(
    `SELECT i.invoice_number, p.brand || ' ' || p.name as product_name,
            il.tax_scheme, il.unit_price, il.purchase_price_snapshot, il.vat_rate, il.vat_amount, il.line_total
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     JOIN products p ON p.id = il.product_id
     WHERE i.branch_id = ? AND i.status = 'FINAL' ORDER BY i.created_at DESC, il.position`,
    [ctx.branchId]
  );
  return { invoices, lines };
}
