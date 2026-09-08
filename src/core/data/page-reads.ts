// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2D — die Abfragen, die bisher IN den Seiten standen.
//
// Zwölf Flächen holten ihre Zahlen selbst aus der Datenbank. Sie stehen jetzt hier: zustandsfrei,
// mit dem Ausweis der Anfrage als Parameter, und von der Seite wie von der Fernauskunft benutzt.
//
// Zwei Dinge sind dabei mehr als ein Umzug:
//
//   1. **Die Filialgrenze.** Ein gutes Dutzend dieser Abfragen hatte keine — sie fragten nach
//      einer Kennung („dieser Kunde", „dieser Artikel") und bekamen die Antwort ohne Rücksicht
//      darauf, wem die Zeile gehört. Solange nur der Primary fragte, konnte er ohnehin nur
//      eigene Kennungen kennen. Über das Netz wäre es die Preisgabe fremder Zahlen. Jede
//      Abfrage hier trägt die Grenze — meist über den Verbund (`JOIN`), weil die Kindzeile
//      selbst keine Filiale hat.
//   2. **Die Kennung ist Auswahl, nicht Erlaubnis.** Sie schränkt ein, was zurückkommt; wer
//      fragen darf, entscheidet allein der geprüfte Absender. Eine fremde Kennung ist deshalb
//      nicht „verboten", sondern schlicht leer.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import type { BusinessReadContext } from '@/core/data/read-context';

const s = (v: unknown): string => (v as string) ?? '';
const n = (v: unknown): number => Number(v ?? 0) || 0;

// ── Übersicht: das Monatsziel ─────────────────────────────────────────────
export interface DashboardExtras { monthlyTarget: string }

export function dashboardExtrasFor(ctx: BusinessReadContext): DashboardExtras {
  const rows = query(
    `SELECT value FROM settings WHERE branch_id = ? AND key = 'finance.monthly_target'`,
    [ctx.branchId],
  );
  return { monthlyTarget: s(rows[0]?.value) };
}

// ── Rechnungsliste: Zahlungen und die Zahl der offenen Rechnungen ─────────
export interface InvoiceListExtras {
  payments: Array<{ invoiceId: string; amount: number; method: string; receivedAt: string }>;
  openCount: number;
}

export function invoiceListExtrasFor(ctx: BusinessReadContext): InvoiceListExtras {
  // `payments` hat keine eigene Filiale — sie hängt an der Rechnung, und die hat eine.
  const payRows = query(
    `SELECT p.invoice_id, p.amount, p.method, p.received_at
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.branch_id = ?`,
    [ctx.branchId],
  );
  const openRows = query(
    `SELECT COALESCE(SUM(CASE WHEN (i.gross_amount - i.paid_amount
         - COALESCE(cn_totals.cancel_amount, 0)) > 0.005 THEN 1 ELSE 0 END), 0) AS cnt
     FROM invoices i
     LEFT JOIN (
       SELECT invoice_id, SUM(receivable_cancel_amount) AS cancel_amount
       FROM credit_notes GROUP BY invoice_id
     ) cn_totals ON cn_totals.invoice_id = i.id
     WHERE i.branch_id = ? AND i.status NOT IN ('CANCELLED', 'DRAFT', 'FINAL', 'RETURNED')`,
    [ctx.branchId],
  );
  return {
    payments: payRows.map((r) => ({
      invoiceId: s(r.invoice_id), amount: n(r.amount), method: s(r.method), receivedAt: s(r.received_at),
    })),
    openCount: n(openRows[0]?.cnt),
  };
}

// ── Auftragsliste: die Summe der noch nicht umgewandelten Anzahlungen ─────
export interface OrderPaidTotals { totals: Array<{ orderId: string; paid: number }> }

export function orderPaidTotalsFor(ctx: BusinessReadContext): OrderPaidTotals {
  const rows = query(
    `SELECT op.order_id, COALESCE(SUM(op.amount), 0) AS t
       FROM order_payments op JOIN orders o ON o.id = op.order_id
      WHERE o.branch_id = ? AND COALESCE(op.converted_to_invoice, 0) = 0
      GROUP BY op.order_id`,
    [ctx.branchId],
  );
  return { totals: rows.map((r) => ({ orderId: s(r.order_id), paid: n(r.t) })) };
}

// ── Gold-Modal: der Ladenbestand je Karat ─────────────────────────────────
export interface MetalStock { rows: Array<{ karat: string; grams: number }> }

export function metalStockByKaratFor(ctx: BusinessReadContext): MetalStock {
  const rows = query(
    `SELECT karat, COALESCE(SUM(weight_grams), 0) AS total
       FROM precious_metals
      WHERE branch_id = ? AND status = 'in_stock' AND weight_grams > 0
      GROUP BY karat
      ORDER BY karat DESC`,
    [ctx.branchId],
  );
  return { rows: rows.map((r) => ({ karat: s(r.karat), grams: n(r.total) })) };
}

// ── Belegnummern zu Kennungen ────────────────────────────────────────────
//
// Zwei Flächen brauchen dasselbe: aus einer Auftrags-, Reparatur- oder Kommissionskennung die
// Nummer, die der Mensch kennt. Eine Anfrage statt einer je Zeile — und die Filiale steht drin.
export interface RefNumbers {
  orders: Record<string, string>;
  repairs: Record<string, string>;
  consignments: Record<string, string>;
}

function numbersOf(
  branchId: string, table: string, numberCol: string, ids: readonly string[],
): Record<string, string> {
  const clean = [...new Set(ids.filter((x) => typeof x === 'string' && x))].slice(0, 500);
  if (clean.length === 0) return {};
  // Tabelle und Spalte stammen aus dieser Datei, niemals aus dem Rumpf einer Anfrage.
  const rows = query(
    `SELECT id, ${numberCol} AS num FROM ${table} WHERE branch_id = ? AND id IN (${clean.map(() => '?').join(',')})`,
    [branchId, ...clean],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[s(r.id)] = s(r.num);
  return out;
}

export function refNumbersFor(
  ctx: BusinessReadContext,
  ids: { orders?: readonly string[]; repairs?: readonly string[]; consignments?: readonly string[] },
): RefNumbers {
  return {
    orders: numbersOf(ctx.branchId, 'orders', 'order_number', ids.orders ?? []),
    repairs: numbersOf(ctx.branchId, 'repairs', 'repair_number', ids.repairs ?? []),
    consignments: numbersOf(ctx.branchId, 'consignments', 'consignment_number', ids.consignments ?? []),
  };
}

// ── Kunde: Zahlungen, Erstattungen, zurückgebuchte Forderungen ────────────
export interface CustomerDetailReads {
  payments: Array<{
    id: string; amount: number; method: string; receivedAt: string; notes?: string;
    invoiceNumber: string; invoiceStatus: string; invoiceSpecialMark: boolean; invoiceId: string;
  }>;
  refunds: Array<{
    id: string; amount: number; method: string; receivedAt: string; returnNumber: string;
    invoiceId: string; invoiceNumber: string; invoiceStatus: string; invoiceSpecialMark: boolean;
    creditNoteId?: string;
  }>;
  creditNoteCancels: Record<string, number>;
}

export function customerDetailReadsFor(ctx: BusinessReadContext, customerId: string): CustomerDetailReads {
  const payRows = query(
    `SELECT p.id, p.amount, p.method, p.received_at, p.notes, i.invoice_number, i.status, i.special_mark, i.id AS invoice_id
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.customer_id = ? AND i.branch_id = ?
      ORDER BY p.received_at DESC`,
    [customerId, ctx.branchId],
  );
  const refundRows = query(
    `SELECT sr.id, sr.return_number, sr.refund_paid_amount, sr.refund_method,
            sr.refund_paid_date, sr.invoice_id, i.invoice_number, i.status, i.special_mark,
            cn.id AS cn_id
       FROM sales_returns sr
       JOIN invoices i ON i.id = sr.invoice_id
       LEFT JOIN credit_notes cn ON cn.sales_return_id = sr.id
      WHERE sr.customer_id = ? AND sr.branch_id = ? AND sr.refund_paid_amount > 0
      ORDER BY sr.refund_paid_date DESC`,
    [customerId, ctx.branchId],
  );
  // Die Gutschrift-Summen je Rechnung dieses Kunden. Die Rechnungsliste kommt aus der
  // DATENBANK, nicht aus dem Rumpf: so kann niemand fremde Kennungen mitschicken.
  const cnRows = query(
    `SELECT cn.invoice_id, COALESCE(SUM(cn.receivable_cancel_amount), 0) AS cancel_amount
       FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
      WHERE i.customer_id = ? AND i.branch_id = ?
      GROUP BY cn.invoice_id`,
    [customerId, ctx.branchId],
  );
  const creditNoteCancels: Record<string, number> = {};
  for (const r of cnRows) creditNoteCancels[s(r.invoice_id)] = n(r.cancel_amount);

  return {
    payments: payRows.map((r) => ({
      id: s(r.id), amount: n(r.amount), method: s(r.method), receivedAt: s(r.received_at),
      notes: (r.notes as string | null) || undefined,
      invoiceNumber: s(r.invoice_number), invoiceStatus: s(r.status),
      invoiceSpecialMark: Number(r.special_mark) === 1, invoiceId: s(r.invoice_id),
    })),
    refunds: refundRows.map((r) => ({
      id: s(r.id), amount: n(r.refund_paid_amount), method: s(r.refund_method) || 'cash',
      receivedAt: s(r.refund_paid_date), returnNumber: s(r.return_number),
      invoiceId: s(r.invoice_id), invoiceNumber: s(r.invoice_number), invoiceStatus: s(r.status),
      invoiceSpecialMark: Number(r.special_mark) === 1,
      creditNoteId: (r.cn_id as string | null) || undefined,
    })),
    creditNoteCancels,
  };
}

// ── Auftrag: welche Zeile ist über welchen Einkauf beschafft ──────────────
export interface OrderDetailReads {
  sourced: Array<{ orderLineId: string; purchaseId: string; purchaseNumber: string }>;
}

export function orderDetailReadsFor(ctx: BusinessReadContext, orderId: string): OrderDetailReads {
  const rows = query(
    `SELECT pl.source_order_line_id AS olid, pl.purchase_id AS pid, p.purchase_number AS pnum
       FROM purchase_lines pl
       JOIN purchases p ON p.id = pl.purchase_id
       JOIN order_lines ol ON ol.id = pl.source_order_line_id
       JOIN orders o ON o.id = ol.order_id
      WHERE o.id = ? AND o.branch_id = ? AND p.branch_id = ? AND p.status != 'CANCELLED'`,
    [orderId, ctx.branchId, ctx.branchId],
  );
  return { sourced: rows.map((r) => ({ orderLineId: s(r.olid), purchaseId: s(r.pid), purchaseNumber: s(r.pnum) })) };
}

// ── Lieferant: Zahlungen, Retouren, Ausgaben ─────────────────────────────
export interface SupplierDetailReads {
  payments: Array<{ id: string; purchaseNumber: string; amount: number; method: string; paidAt: string; reference?: string }>;
  returns: Array<{ id: string; returnNumber: string; totalAmount: number; returnDate: string; status: string; refundMethod?: string }>;
  expenses: Array<{
    id: string; expenseNumber: string; description: string; amount: number; paidAmount: number;
    creditPaid: number; expenseDate: string; status: string; relatedModule: string;
    relatedEntityId?: string; orderNumber?: string; repairNumber?: string;
  }>;
}

export function supplierDetailReadsFor(ctx: BusinessReadContext, supplierId: string): SupplierDetailReads {
  const payRows = query(
    `SELECT pp.id, pp.amount, pp.method, pp.paid_at, pp.reference, p.purchase_number
       FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
      WHERE p.supplier_id = ? AND p.branch_id = ?
      ORDER BY pp.paid_at DESC`,
    [supplierId, ctx.branchId],
  );
  const returnRows = query(
    `SELECT id, return_number, total_amount, return_date, status, refund_method
       FROM purchase_returns WHERE supplier_id = ? AND branch_id = ? ORDER BY return_date DESC`,
    [supplierId, ctx.branchId],
  );
  const expenseRows = query(
    `SELECT e.id, e.expense_number, e.description, e.amount, e.paid_amount, e.expense_date, e.status,
            e.related_module, e.related_entity_id,
            o.order_number AS order_number, r.repair_number AS repair_number,
            COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep
                      WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0) AS credit_paid
       FROM expenses e
       LEFT JOIN orders  o ON o.id = e.related_entity_id AND e.related_module = 'order'
       LEFT JOIN repairs r ON r.id = e.related_entity_id AND e.related_module = 'repair'
      WHERE e.supplier_id = ? AND e.branch_id = ?
        AND e.related_module IN ('repair', 'order') AND e.status != 'CANCELLED'
      ORDER BY e.expense_date DESC`,
    [supplierId, ctx.branchId],
  );
  return {
    payments: payRows.map((r) => ({
      id: s(r.id), purchaseNumber: s(r.purchase_number), amount: n(r.amount),
      method: s(r.method), paidAt: s(r.paid_at), reference: (r.reference as string | null) || undefined,
    })),
    returns: returnRows.map((r) => ({
      id: s(r.id), returnNumber: s(r.return_number), totalAmount: n(r.total_amount),
      returnDate: s(r.return_date), status: s(r.status),
      refundMethod: (r.refund_method as string | null) || undefined,
    })),
    expenses: expenseRows.map((r) => ({
      id: s(r.id), expenseNumber: s(r.expense_number), description: s(r.description),
      amount: n(r.amount), paidAmount: n(r.paid_amount), creditPaid: n(r.credit_paid),
      expenseDate: s(r.expense_date), status: s(r.status), relatedModule: s(r.related_module),
      relatedEntityId: (r.related_entity_id as string | null) || undefined,
      orderNumber: (r.order_number as string | null) || undefined,
      repairNumber: (r.repair_number as string | null) || undefined,
    })),
  };
}

// ── Artikel: Verkaufs-, Einkaufs- und Fertigungshistorie ─────────────────
export interface ProductDetailReads {
  sales: Array<{
    invoiceId: string; invoiceNumber: string; status: string; specialMark: boolean;
    issuedAt: string; customerName: string; unitPrice: number; quantity: number; lineTotal: number;
  }>;
  purchases: Array<{
    purchaseId: string; purchaseNumber: string; status: string; purchaseDate: string;
    supplierName: string; unitPrice: number; quantity: number; lineTotal: number;
  }>;
  production: Array<{
    recordId: string; recordNumber: string; productionDate: string;
    direction: 'input' | 'output'; value: number;
    counterpart: Array<{ productId: string; label: string; value: number }>;
  }>;
  provenance: { supplier: string | null; paidFrom: string | null };
}

const LEER_PRODUCT_DETAIL: ProductDetailReads = { sales: [], purchases: [], production: [], provenance: { supplier: null, paidFrom: null } };

export function productDetailReadsFor(ctx: BusinessReadContext, productId: string): ProductDetailReads {
  // Zuerst die Frage, wem der Artikel gehört. Gehört er nicht hierher, gibt es nichts —
  // und zwar bevor irgendeine Kindzeile gelesen wird.
  const own = query('SELECT id FROM products WHERE id = ? AND branch_id = ?', [productId, ctx.branchId]);
  if (own.length === 0) return LEER_PRODUCT_DETAIL;

  const saleRows = query(
    `SELECT i.id AS inv_id, i.invoice_number, i.status, i.special_mark, i.issued_at,
            c.first_name, c.last_name,
            il.unit_price, il.quantity, il.line_total
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       LEFT JOIN customers c ON c.id = i.customer_id
      WHERE il.product_id = ? AND i.branch_id = ?
        AND i.status IN ('FINAL', 'PARTIAL')
      ORDER BY i.issued_at DESC, i.created_at DESC`,
    [productId, ctx.branchId],
  );
  const purchaseRows = query(
    `SELECT p.id AS pur_id, p.purchase_number, p.status, p.purchase_date,
            s.name AS supplier_name,
            pl.unit_price, pl.quantity, pl.line_total
       FROM purchase_lines pl
       JOIN purchases p ON p.id = pl.purchase_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE pl.product_id = ? AND p.branch_id = ?
        AND p.status NOT IN ('DRAFT', 'CANCELLED')
      ORDER BY p.purchase_date DESC, p.created_at DESC`,
    [productId, ctx.branchId],
  );

  const production: ProductDetailReads['production'] = [];
  const inputRows = query(
    `SELECT pi.record_id, pi.input_value, pr.record_number, pr.production_date
       FROM production_inputs pi
       JOIN production_records pr ON pr.id = pi.record_id
      WHERE pi.product_id = ? AND pr.branch_id = ?
      ORDER BY pr.production_date DESC, pr.created_at DESC`,
    [productId, ctx.branchId],
  );
  for (const r of inputRows) {
    const recId = s(r.record_id);
    const counter = query(
      `SELECT po.product_id, po.output_value, p.brand, p.name
         FROM production_outputs po
         LEFT JOIN products p ON p.id = po.product_id
        WHERE po.record_id = ?`,
      [recId],
    );
    production.push({
      recordId: recId, recordNumber: s(r.record_number) || '—', productionDate: s(r.production_date),
      direction: 'input', value: n(r.input_value),
      counterpart: counter.map((cr) => ({
        productId: s(cr.product_id),
        label: [cr.brand, cr.name].filter(Boolean).join(' ').trim() || '(deleted)',
        value: n(cr.output_value),
      })),
    });
  }
  const outputRows = query(
    `SELECT po.record_id, po.output_value, pr.record_number, pr.production_date
       FROM production_outputs po
       JOIN production_records pr ON pr.id = po.record_id
      WHERE po.product_id = ? AND pr.branch_id = ?
      ORDER BY pr.production_date DESC, pr.created_at DESC`,
    [productId, ctx.branchId],
  );
  for (const r of outputRows) {
    const recId = s(r.record_id);
    const counter = query(
      `SELECT pi.product_id, pi.input_value, pi.product_snapshot, p.brand, p.name
         FROM production_inputs pi
         LEFT JOIN products p ON p.id = pi.product_id
        WHERE pi.record_id = ?`,
      [recId],
    );
    production.push({
      recordId: recId, recordNumber: s(r.record_number) || '—', productionDate: s(r.production_date),
      direction: 'output', value: n(r.output_value),
      counterpart: counter.map((cr) => {
        let label = [cr.brand, cr.name].filter(Boolean).join(' ').trim();
        if (!label) {
          // Der Schnappschuss hält fest, was der Posten WAR — auch wenn der Artikel weg ist.
          try {
            const snap = JSON.parse(s(cr.product_snapshot) || '{}') as { brand?: string; name?: string };
            label = [snap.brand, snap.name].filter(Boolean).join(' ').trim();
          } catch { /* kein Schnappschuss */ }
        }
        return { productId: s(cr.product_id), label: label || '(deleted)', value: n(cr.input_value) };
      }),
    });
  }

  const lotRows = query(
    `SELECT DISTINCT s.name AS supplier_name, pp.method AS paid_method
       FROM stock_lots sl
       LEFT JOIN purchases p ON p.id = sl.purchase_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN purchase_payments pp ON pp.purchase_id = sl.purchase_id
      WHERE sl.product_id = ? AND sl.branch_id = ? AND sl.status != 'CANCELLED'`,
    [productId, ctx.branchId],
  );
  const suppliers = [...new Set(lotRows.map((r) => s(r.supplier_name)).filter(Boolean))];
  const methods = [...new Set(lotRows.map((r) => s(r.paid_method)).filter(Boolean))];

  return {
    sales: saleRows.map((r) => ({
      invoiceId: s(r.inv_id), invoiceNumber: s(r.invoice_number), status: s(r.status),
      specialMark: Number(r.special_mark) === 1, issuedAt: s(r.issued_at),
      customerName: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || '—',
      unitPrice: n(r.unit_price), quantity: n(r.quantity) || 1, lineTotal: n(r.line_total),
    })),
    purchases: purchaseRows.map((r) => ({
      purchaseId: s(r.pur_id), purchaseNumber: s(r.purchase_number), status: s(r.status),
      purchaseDate: s(r.purchase_date), supplierName: s(r.supplier_name) || '—',
      unitPrice: n(r.unit_price), quantity: n(r.quantity) || 1, lineTotal: n(r.line_total),
    })),
    production,
    provenance: {
      supplier: suppliers.length > 0 ? suppliers.join(', ') : null,
      paidFrom: methods.length > 0
        ? methods.map((m) => (m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : m)).join(', ')
        : null,
    },
  };
}

// ── Einkauf anlegen: die Vorlage aus Wareneingang oder Auftrag ───────────
export interface PurchaseCreatePrefill {
  inbox: { images: string[]; note: string } | null;
  order: { orderNumber: string; customerName: string } | null;
  lines: Array<{ id: string; productId?: string; description: string; quantity: number }>;
}

export function purchaseCreatePrefillFor(
  ctx: BusinessReadContext,
  params: { inboxId?: string; orderId?: string; lineIds?: readonly string[] },
): PurchaseCreatePrefill {
  let inbox: PurchaseCreatePrefill['inbox'] = null;
  if (params.inboxId) {
    const rows = query('SELECT images, note FROM purchase_inbox WHERE id = ? AND branch_id = ?', [params.inboxId, ctx.branchId]);
    if (rows[0]) {
      let images: string[] = [];
      try {
        const parsed = JSON.parse(s(rows[0].images) || '[]') as unknown;
        if (Array.isArray(parsed)) images = parsed as string[];
      } catch { /* kein Bild */ }
      inbox = { images, note: s(rows[0].note) };
    }
  }

  let order: PurchaseCreatePrefill['order'] = null;
  const lines: PurchaseCreatePrefill['lines'] = [];
  if (params.orderId) {
    const ordRows = query(
      `SELECT o.order_number AS onum, c.first_name AS fn, c.last_name AS ln
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ? AND o.branch_id = ?`,
      [params.orderId, ctx.branchId],
    );
    if (ordRows[0]) {
      order = {
        orderNumber: s(ordRows[0].onum),
        customerName: `${s(ordRows[0].fn)} ${s(ordRows[0].ln)}`.trim(),
      };
      const wanted = [...new Set((params.lineIds ?? []).filter((x) => typeof x === 'string' && x))].slice(0, 200);
      if (wanted.length > 0) {
        // Die Zeilen müssen zu GENAU diesem Auftrag gehören — eine fremde Zeilenkennung
        // bringt nichts mit, auch wenn sie im Rumpf steht.
        const rows = query(
          `SELECT ol.id, ol.product_id, ol.description, ol.quantity
             FROM order_lines ol
            WHERE ol.order_id = ? AND ol.id IN (${wanted.map(() => '?').join(',')})`,
          [params.orderId, ...wanted],
        );
        const byId = new Map(rows.map((r) => [s(r.id), r]));
        for (const wid of wanted) {
          const r = byId.get(wid);
          if (!r) continue;
          lines.push({
            id: s(r.id),
            productId: (r.product_id as string | null) || undefined,
            description: s(r.description),
            quantity: n(r.quantity) || 1,
          });
        }
      }
    }
  }
  return { inbox, order, lines };
}
