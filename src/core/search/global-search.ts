// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2D — die übergreifende Suche, einmal geschrieben.
//
// Sie war der größte Einzelposten unter den Seiten, die selbst in der Datenbank suchten: neun
// Abfragen über Artikel, Kunden und sieben Belegarten. Auf einem Rechner ohne Datenbank fing der
// umschließende `try` jeden Fehler ab — die Suche fand dort einfach nie etwas, ohne es zu sagen.
//
// Jetzt gilt derselbe Schnitt wie überall: zustandsfrei, die Filiale aus dem AUSWEIS der Anfrage,
// dieselbe Funktion am Primary wie für die Ferne.
//
// Drei Dinge, die diese Datei ausdrücklich nicht tut:
//
//   • Sie nimmt keinen Tabellen- oder Spaltennamen aus dem Rumpf entgegen. Was gesucht wird,
//     entscheidet die Präfix-Tabelle HIER; vom Aufrufer kommt nur der Suchtext.
//   • Sie nimmt keine Filiale entgegen. Wer sucht, steht im geprüften Absender.
//   • Sie gibt keine internen Felder heraus: zurück gehen Titel, Untertitel, Ziel-Adresse,
//     Datum und Betrag — dieselben Felder, die die Trefferliste auch am Primary anzeigt.
import { query } from '@/core/db/helpers';
import type { BusinessReadContext } from '@/core/data/read-context';

export type ResultType =
  | 'product' | 'customer' | 'offer' | 'invoice' | 'repair' | 'order'
  | 'purchase' | 'sales_return' | 'purchase_return' | 'expense' | 'production';

export interface SearchResult {
  type: ResultType;
  id: string;
  title: string;
  subtitle: string;
  link: string;
  date?: string;
  amount?: number;
}

// Document prefix → destination.
// 2026-05-16 — Invoices haben 6 Prefixe (4 Final-Counter + 2 Partial-Counter):
//   PINV / INV / SINV   (Sales: Partial / Final Normal / Final Special)
//   RPINV / RINV / SRINV (Repair: Partial / Final Normal / Final Special)
// Wichtig: Spezifischere Prefixe (SINV, SRINV, RPINV, RINV) MUESSEN vor den
// allgemeineren (INV) stehen — find() returnt erstes Match.
const DOC_PREFIX_MAP: { prefix: string; type: ResultType; table: string; numberCol: string; linkFn: (id: string) => string; hasDetail: boolean }[] = [
  { prefix: 'SRINV', type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'RPINV', type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'RINV',  type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'SINV',  type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'PINV',  type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'INV',   type: 'invoice', table: 'invoices', numberCol: 'invoice_number', linkFn: (id) => `/invoices/${id}`, hasDetail: true },
  { prefix: 'OFF',  type: 'offer', table: 'offers', numberCol: 'offer_number', linkFn: (id) => `/offers/${id}`, hasDetail: true },
  { prefix: 'PUR',  type: 'purchase', table: 'purchases', numberCol: 'purchase_number', linkFn: (id) => `/purchases/${id}`, hasDetail: true },
  { prefix: 'PRET', type: 'purchase_return', table: 'purchase_returns', numberCol: 'return_number', linkFn: () => `/purchases`, hasDetail: false },
  { prefix: 'RET',  type: 'sales_return', table: 'sales_returns', numberCol: 'return_number', linkFn: () => `/invoices`, hasDetail: false },
  { prefix: 'REP',  type: 'repair', table: 'repairs', numberCol: 'repair_number', linkFn: (id) => `/repairs/${id}`, hasDetail: true },
  { prefix: 'AGD',  type: 'order', table: 'agent_transfers', numberCol: 'transfer_number', linkFn: () => `/agents`, hasDetail: false },
  { prefix: 'CON',  type: 'order', table: 'consignments', numberCol: 'consignment_number', linkFn: (id) => `/consignments/${id}`, hasDetail: true },
  { prefix: 'EXP',  type: 'expense', table: 'expenses', numberCol: 'expense_number', linkFn: () => `/expenses`, hasDetail: false },
  { prefix: 'PRD',  type: 'production', table: 'production_records', numberCol: 'production_number', linkFn: () => `/production`, hasDetail: false },
];


export type SearchFilterKey = 'all' | 'products' | 'customers' | 'documents' | 'sold';

/** Was der Mensch eingegeben hat — Auswahl, niemals Berechtigung. */
export interface GlobalSearchParams {
  q: string;
  filter: SearchFilterKey;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: string;
  amountMax?: string;
  weightMin?: string;
  weightMax?: string;
  productStatus?: string;
}


/**
 * Die Suche. Alle Einschränkungen des Menschen sind Parameter; die Filiale ist es nicht.
 */
export function globalSearchFor(
  ctx: BusinessReadContext,
  params: GlobalSearchParams,
): { items: SearchResult[] } {
  const q = typeof params.q === 'string' ? params.q : '';
  if (!q || q.length < 2) return { items: [] };
  const filter: SearchFilterKey = params.filter ?? 'all';
  const dateFrom = params.dateFrom ?? '';
  const dateTo = params.dateTo ?? '';
  const amountMin = params.amountMin ?? '';
  const amountMax = params.amountMax ?? '';
  const weightMin = params.weightMin ?? '';
  const weightMax = params.weightMax ?? '';
  const productStatus = params.productStatus ?? '';

  const term = `%${q}%`;
  const items: SearchResult[] = [];
  const branchId = ctx.branchId;

    const trimmed = q.trim().toUpperCase();
    const matchedPrefix = DOC_PREFIX_MAP.find(p => trimmed.startsWith(p.prefix + '-') || trimmed.startsWith(p.prefix + ' '));

    const minAmount = amountMin ? parseFloat(amountMin) : null;
    const maxAmount = amountMax ? parseFloat(amountMax) : null;
    const minWeight = weightMin ? parseFloat(weightMin) : null;
    const maxWeight = weightMax ? parseFloat(weightMax) : null;

    // Plan §Search §11: Smart search — reine Zahl als Preis deuten, "Xg" / "X g" als Gewicht.
    const asNumber = /^-?\d+(\.\d+)?$/.test(q.trim()) ? parseFloat(q.trim()) : null;
    const weightMatch = q.trim().match(/^(\d+(?:\.\d+)?)\s*g(?:r|ram|rams)?$/i);
    const smartWeight = weightMatch ? parseFloat(weightMatch[1]) : null;

    try {
      // ── Document-ID direct routing (highest priority) ──
      if (matchedPrefix && (filter === 'all' || filter === 'documents')) {
        const rows = query(
          `SELECT id, ${matchedPrefix.numberCol} AS num FROM ${matchedPrefix.table}
           WHERE branch_id = ? AND ${matchedPrefix.numberCol} LIKE ? LIMIT 8`,
          [branchId, term]
        );
        for (const r of rows) {
          items.push({
            type: matchedPrefix.type,
            id: r.id as string,
            title: r.num as string,
            subtitle: matchedPrefix.hasDetail ? 'Open document' : `Open ${matchedPrefix.type} list`,
            link: matchedPrefix.linkFn(r.id as string),
          });
        }
        if (items.length > 0) return { items };
      }

      // ── Products ── (Plan §Search §3-5: brand/serial/model/category/weight/price/material + status)
      if (filter === 'all' || filter === 'products' || filter === 'sold') {
        // Smart Search: reine Zahl → Preisbereich ±10% um Zahl
        const priceMin = asNumber !== null ? asNumber * 0.9 : minAmount;
        const priceMax = asNumber !== null ? asNumber * 1.1 : maxAmount;
        const effWeightMin = smartWeight !== null ? smartWeight * 0.9 : minWeight;
        const effWeightMax = smartWeight !== null ? smartWeight * 1.1 : maxWeight;

        const whereParts: string[] = [`branch_id = ?`];
        const args: unknown[] = [branchId];
        // Text-Suche nur wenn kein reiner Zahlen-/Gewichts-Input
        if (asNumber === null && smartWeight === null) {
          whereParts.push(`(brand LIKE ? OR name LIKE ? OR sku LIKE ? OR notes LIKE ?)`);
          args.push(term, term, term, term);
        }
        // BEFUND R2D: hier stand `retail_price` — eine Spalte, die es in dieser Datenbank nicht
        // gibt und nie gab. Der umschliessende `try` verschluckte den Fehler, und damit fiel
        // nicht nur die Artikelsuche aus, sondern alles, was in demselben Block danach kam.
        // Der Verkaufspreis heisst `planned_sale_price`.
        if (priceMin !== null) { whereParts.push(`(planned_sale_price >= ? OR purchase_price >= ?)`); args.push(priceMin, priceMin); }
        if (priceMax !== null) { whereParts.push(`(planned_sale_price <= ? OR purchase_price <= ?)`); args.push(priceMax, priceMax); }
        if (productStatus) { whereParts.push(`stock_status = ?`); args.push(productStatus); }

        const prods = query(
          `SELECT id, brand, name, sku, planned_sale_price, stock_status, attributes
           FROM products WHERE ${whereParts.join(' AND ')} LIMIT 20`,
          args
        );

        // Weight-Filter läuft client-seitig auf JSON attributes
        const filtered = prods.filter(p => {
          if (effWeightMin === null && effWeightMax === null) return true;
          try {
            const attr = JSON.parse((p.attributes as string) || '{}');
            const w = parseFloat(String(attr.weight || attr.Weight || ''));
            if (!isFinite(w)) return false;
            if (effWeightMin !== null && w < effWeightMin) return false;
            if (effWeightMax !== null && w > effWeightMax) return false;
            return true;
          } catch { return false; }
        });
        prods.length = 0;
        prods.push(...filtered.slice(0, 8));
        for (const p of prods) {
          // Check if sold — look up invoice_lines
          const soldRows = query(
            `SELECT i.id AS inv_id, i.invoice_number, i.issued_at, i.status, c.first_name, c.last_name, c.company
             FROM invoice_lines il
             JOIN invoices i ON i.id = il.invoice_id
             LEFT JOIN customers c ON c.id = i.customer_id
             WHERE il.product_id = ? AND i.status != 'CANCELLED'
             ORDER BY i.issued_at DESC LIMIT 1`,
            [p.id]
          );
          const isSold = soldRows.length > 0;
          if (filter === 'sold' && !isSold) continue;

          if (isSold) {
            const s = soldRows[0];
            const customerName = (s.company as string) || `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unknown';
            items.push({
              type: 'product',
              id: p.id as string,
              title: `${p.brand} ${p.name}`,
              subtitle: `Sold · ${s.invoice_number} · ${customerName}`,
              link: `/invoices/${s.inv_id}`,
              date: s.issued_at as string,
            });
          } else {
            items.push({
              type: 'product',
              id: p.id as string,
              title: `${p.brand} ${p.name}`,
              subtitle: (p.sku as string) || (p.stock_status as string) || '',
              link: `/collection/${p.id}`,
            });
          }
        }
      }

      // ── Customers ──
      if (filter === 'all' || filter === 'customers') {
        const custs = query(
          `SELECT id, first_name, last_name, company, phone, email FROM customers
           WHERE branch_id = ? AND (first_name LIKE ? OR last_name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?)
           LIMIT 6`,
          [branchId, term, term, term, term, term]
        );
        for (const c of custs) {
          items.push({
            type: 'customer',
            id: c.id as string,
            title: `${c.first_name} ${c.last_name}`.trim(),
            subtitle: (c.company as string) || (c.email as string) || (c.phone as string) || '',
            link: `/clients/${c.id}`,
          });
        }
      }

      // ── Documents (numbers + cross-doc search) ──
      if (filter === 'all' || filter === 'documents') {
        const dateFilter = (col: string) => {
          const parts: string[] = [];
          const args: unknown[] = [];
          if (dateFrom) { parts.push(`${col} >= ?`); args.push(dateFrom); }
          if (dateTo)   { parts.push(`${col} <= ?`); args.push(dateTo + 'T23:59:59'); }
          return { where: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
        };
        const amountFilter = (col: string) => {
          const parts: string[] = [];
          const args: unknown[] = [];
          if (minAmount !== null) { parts.push(`${col} >= ?`); args.push(minAmount); }
          if (maxAmount !== null) { parts.push(`${col} <= ?`); args.push(maxAmount); }
          return { where: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
        };

        // Offers
        const offD = dateFilter('o.created_at');
        const offA = amountFilter('o.total');
        const offs = query(
          `SELECT o.id, o.offer_number, o.total, o.created_at, c.first_name, c.last_name, c.company
           FROM offers o LEFT JOIN customers c ON c.id = o.customer_id
           WHERE o.branch_id = ? AND o.offer_number LIKE ?${offD.where}${offA.where} LIMIT 4`,
          [branchId, term, ...offD.args, ...offA.args]
        );
        for (const o of offs) {
          const cust = (o.company as string) || `${o.first_name || ''} ${o.last_name || ''}`.trim();
          items.push({
            type: 'offer',
            id: o.id as string,
            title: o.offer_number as string,
            subtitle: cust ? `Offer · ${cust}` : 'Offer',
            link: `/offers/${o.id}`,
            amount: o.total as number,
            date: o.created_at as string,
          });
        }

        // Invoices
        const invD = dateFilter('i.issued_at');
        const invA = amountFilter('i.gross_amount');
        const invs = query(
          `SELECT i.id, i.invoice_number, i.gross_amount, i.issued_at, i.status, c.first_name, c.last_name, c.company
           FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
           WHERE i.branch_id = ? AND i.invoice_number LIKE ?${invD.where}${invA.where} LIMIT 4`,
          [branchId, term, ...invD.args, ...invA.args]
        );
        for (const i of invs) {
          const cust = (i.company as string) || `${i.first_name || ''} ${i.last_name || ''}`.trim();
          items.push({
            type: 'invoice',
            id: i.id as string,
            title: i.invoice_number as string,
            subtitle: `${i.status || 'Invoice'}${cust ? ' · ' + cust : ''}`,
            link: `/invoices/${i.id}`,
            amount: i.gross_amount as number,
            date: i.issued_at as string,
          });
        }

        // Purchases
        const purD = dateFilter('created_at');
        // BEFUND R2D: auch hier eine Spalte, die es nicht gibt — der Einkauf fuehrt `total_amount`.
        const purA = amountFilter('total_amount');
        const purs = query(
          `SELECT id, purchase_number, total_amount, created_at, status
           FROM purchases WHERE branch_id = ? AND purchase_number LIKE ?${purD.where}${purA.where} LIMIT 3`,
          [branchId, term, ...purD.args, ...purA.args]
        );
        for (const p of purs) {
          items.push({
            type: 'purchase',
            id: p.id as string,
            title: p.purchase_number as string,
            subtitle: `Purchase · ${p.status || ''}`,
            link: `/purchases/${p.id}`,
            amount: p.total_amount as number,
            date: p.created_at as string,
          });
        }

        // Repairs
        const reps = query(
          `SELECT id, repair_number, voucher_code, created_at FROM repairs
           WHERE branch_id = ? AND (repair_number LIKE ? OR voucher_code LIKE ?)${dateFilter('created_at').where} LIMIT 3`,
          [branchId, term, term, ...dateFilter('created_at').args]
        );
        for (const r of reps) {
          items.push({
            type: 'repair',
            id: r.id as string,
            title: r.repair_number as string,
            subtitle: r.voucher_code ? `Voucher: ${r.voucher_code}` : 'Repair',
            link: `/repairs/${r.id}`,
            date: r.created_at as string,
          });
        }

        // Orders
        const ordrs = query(
          `SELECT id, order_number, agreed_price, created_at, status FROM orders
           WHERE branch_id = ? AND order_number LIKE ?${dateFilter('created_at').where} LIMIT 3`,
          [branchId, term, ...dateFilter('created_at').args]
        );
        for (const o of ordrs) {
          items.push({
            type: 'order',
            id: o.id as string,
            title: o.order_number as string,
            subtitle: `Order · ${o.status || ''}`,
            link: `/orders/${o.id}`,
            amount: o.agreed_price as number,
            date: o.created_at as string,
          });
        }
      }
    } catch (e) {
      console.warn('[search] query error:', e);
    }
  return { items };
}
