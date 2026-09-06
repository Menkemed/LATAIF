// CENTRAL-C2 — was ein zweiter Rechner lesen darf, und in welcher Form.
//
// Drei Grundsätze, und alle drei sind Sicherheitsgrenzen, keine Geschmacksfragen:
//
//   1. **Die Antwort ist eine Form, keine Tabelle.** Der Client bekommt benannte Felder, die hier
//      aufgezählt sind — nicht `SELECT *`. Kommt morgen eine Spalte mit einer Einkaufsmarge oder
//      einer internen Notiz dazu, reist sie nicht versehentlich mit.
//   2. **Der Client bestimmt nichts.** Kein SQL, kein Tabellenname, kein Sortierausdruck aus dem
//      Netz. Er darf einen Suchtext, eine Kennung und eine Obergrenze nennen; alles andere
//      entscheidet diese Datei.
//   3. **Gelesen wird aus der Autorität.** Diese Befehle laufen im Primary-Renderer auf der
//      aktuellen sql.js-Datenbank — nicht aus der Datei auf der Platte, die ihr hinterherhinkt.
//
// Bewusst NICHT alle 28 Stores: Bestand, Kunden und Rechnungen decken die drei Oberflächen ab, an
// denen sich der Client-Modus überhaupt beurteilen lässt.

import { registerCommand, BusinessError, type CommandResult } from './command-registry';
import { getDatabase } from '@/core/db/database';
import { summarizeInventory, isOwnStockAsset, type LotAggregate } from '@/core/lots/lot-queries';
import { getStockAggregates } from '@/core/lots/lot-queries';
// Ob das Auszahlungsmodell einer Kommission noch geändert werden darf, ist eine Aussage der
// DOMÄNE. Sie wird hier gelesen, damit der Client sie anzeigen kann — und beim Schreiben ein
// zweites Mal gefragt. Zwei Fragen an dieselbe Funktion, nie eine Nachbildung.
import { payoutModelLock } from '@/core/consignment/payout-edit';
import { rowToConsignment } from '@/stores/consignmentStore';
// CENTRAL-C3H — welcher Schritt als naechstes erlaubt ist, ist eine Aussage der DOMAENE. Sie
// wird hier gelesen, damit der Client sie anzeigen kann — und beim Schreiben ein zweites Mal
// gefragt. Zwei Fragen an dieselbe Funktion, nie eine Nachbildung.
import { nextOrderStatus } from '@/core/orders/order-status-flow';
import { allowedRepairStatusTargets } from '@/core/repairs/repair-status-flow';

export const OP_PRODUCTS_LIST = 'products.list';
export const OP_PRODUCTS_GET = 'products.get';
export const OP_CUSTOMERS_LIST = 'customers.list';
export const OP_CUSTOMERS_GET = 'customers.get';
export const OP_INVOICES_LIST = 'invoices.list';
export const OP_INVOICES_GET = 'invoices.get';

// CENTRAL-C3E — was ein zweiter Rechner braucht, um einen Einkauf, eine Kommission und einen
// Auftrag anzulegen und wiederzufinden. Der Lieferant ist dabei die einzige NEUE Stammdatenquelle:
// Kunden (und damit Einlieferer) und Artikel liest er bereits über C2.
export const OP_SUPPLIERS_LIST = 'suppliers.list';
// Eine Kommission legt ihren Artikel MIT an, und ein Artikel ohne Kategorie gibt es im Haus
// nicht. Der Client hat keine Tabelle, aus der er sie nehmen könnte — also fragt er.
export const OP_CATEGORIES_LIST = 'categories.list';
export const OP_PURCHASES_LIST = 'purchases.list';
export const OP_PURCHASES_GET = 'purchases.get';
export const OP_CONSIGNMENTS_LIST = 'consignments.list';
export const OP_CONSIGNMENTS_GET = 'consignments.get';
export const OP_ORDERS_LIST = 'orders.list';
export const OP_ORDERS_GET = 'orders.get';

// CENTRAL-C3F — Reparaturen und Agenten-Transfers. Der Transfer ist ausdrücklich KEIN
// Filialtransfer: es gibt im Haus keine Quell-/Zielfiliale und keine Mengenbewegung, sondern
// ein Stück Ware bei einem Agenten — der Bestandseffekt ist ein Statuswechsel am Artikel.
export const OP_REPAIRS_LIST = 'repairs.list';
export const OP_REPAIRS_GET = 'repairs.get';
export const OP_TRANSFERS_LIST = 'transfers.list';
export const OP_TRANSFERS_GET = 'transfers.get';

/** Jede Leseoperation, die C2 freischaltet — dieselbe Liste kennt auch Rust. */
export const C2_READ_OPS = [
  OP_PRODUCTS_LIST, OP_PRODUCTS_GET,
  OP_CUSTOMERS_LIST, OP_CUSTOMERS_GET,
  OP_INVOICES_LIST, OP_INVOICES_GET,
  OP_SUPPLIERS_LIST, OP_CATEGORIES_LIST,
  OP_PURCHASES_LIST, OP_PURCHASES_GET,
  OP_CONSIGNMENTS_LIST, OP_CONSIGNMENTS_GET,
  OP_ORDERS_LIST, OP_ORDERS_GET,
  OP_REPAIRS_LIST, OP_REPAIRS_GET,
  OP_TRANSFERS_LIST, OP_TRANSFERS_GET,
] as const;

/** Wie viele Zeilen eine Liste höchstens liefert, auch wenn jemand mehr verlangt. */
const MAX_ROWS = 500;

interface Actor { readonly branchId?: string; readonly tenantId?: string }

/** Der Rumpf, den die Route baut: geprüfter Absender plus die Eingabe des Clients. */
interface Envelope { readonly actor?: Actor; readonly input?: Record<string, unknown> }

function actorBranch(p: unknown): string {
  const branch = (p as Envelope | null)?.actor?.branchId;
  // Ohne Filiale wird nicht gelesen: sie kommt aus dem geprüften Token und ist die Grenze, an der
  // sich entscheidet, wessen Daten das sind.
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new BusinessError('BRANCH_REQUIRED', 'no branch in the authenticated request');
  }
  return branch;
}

function actorTenant(p: unknown): string {
  return str((p as Envelope | null)?.actor?.tenantId);
}

function input(p: unknown): Record<string, unknown> {
  const i = (p as Envelope | null)?.input;
  return i && typeof i === 'object' ? i : {};
}

function limitOf(p: unknown): number {
  const raw = Number(input(p).limit);
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return Math.min(Math.floor(raw), MAX_ROWS);
}

function idOf(p: unknown): string {
  const id = input(p).id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    throw new BusinessError('ID_REQUIRED', 'a record id is required');
  }
  return id;
}

/** Ein Suchtext ist Text — er wird gebunden übergeben, nie in SQL eingesetzt. */
function searchOf(p: unknown): string {
  const q = input(p).q;
  return typeof q === 'string' ? q.trim().slice(0, 120) : '';
}

type Row = Record<string, unknown>;

function rows(sql: string, params: unknown[]): Row[] {
  const res = getDatabase().exec(sql, params as never[]);
  if (res.length === 0) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/**
 * Die Speicherschlüssel der Bilder eines Produkts — dieselbe Reihenfolge, die auch das Handy
 * bekommt (Primärbild zuerst, dann die Galerie). Der Client lädt die Bytes damit über die
 * bestehende, angemeldete Medienroute; hier reist KEIN Bild mit, nur ein Schlüssel.
 */
/**
 * CENTRAL-C3C FINAL — die Galerie mit ihren stabilen KENNUNGEN, in ihrer Reihenfolge.
 *
 * Ein Speicherschlüssel benennt Bytes; eine Medienkennung benennt einen PLATZ in der Galerie. Wer
 * die Galerie ändern will, braucht die zweite: „behalte dieses Bild" ist eine Aussage über die
 * Identität, nicht über den Inhalt. Deshalb liefert `products.get` beides — dieselbe Abfrage,
 * dieselbe Ordnung, damit Bild i und Kennung i wirklich zusammengehören.
 */
function galleryOf(tenantId: string, productId: string): Array<{ mediaId: string; key: string }> {
  if (!tenantId) return [];
  return rows(
    `SELECT l.media_id AS m, g.storage_key AS k
       FROM media_links l
       JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
       JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
       JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                    AND g.generation_no = b.current_generation_no
      WHERE l.tenant_id = ? AND l.entity_type = 'product' AND l.entity_id = ?
        AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND g.deleted_at IS NULL
        AND o.ingest_status = 'ready' AND b.blob_status = 'present' AND g.gen_status = 'available'
      ORDER BY l.is_primary DESC, l.sort_order ASC, l.link_id ASC`,
    [tenantId, productId],
  ).map((r) => ({ mediaId: str(r.m), key: str(r.k) })).filter((x) => x.key !== '' && x.mediaId !== '');
}


// ── Bestand ────────────────────────────────────────────────────────────────
//
// Die Felder sind die, die die Collection-Seite zeigt — plus die Menge, weil ein Datensatz mit
// zehn Stück eben zehn Stück sind. Kein Lieferant, keine Notiz, kein Einkaufsvermerk.
const PRODUCT_COLUMNS =
  'id, branch_id, category_id, brand, name, sku, condition, purchase_price, planned_sale_price, '
  + 'stock_status, tax_scheme, quantity, source_type, days_in_stock, created_at, updated_at';

function productDto(r: Row): CommandResult {
  return {
    id: str(r.id),
    brand: str(r.brand),
    name: str(r.name),
    sku: str(r.sku),
    categoryId: str(r.category_id),
    condition: str(r.condition),
    purchasePrice: num(r.purchase_price),
    plannedSalePrice: r.planned_sale_price === null ? null : num(r.planned_sale_price),
    stockStatus: str(r.stock_status),
    taxScheme: str(r.tax_scheme),
    quantity: r.quantity === null ? null : num(r.quantity),
    sourceType: str(r.source_type),
    daysInStock: num(r.days_in_stock),
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_PRODUCTS_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    // Der Suchtext geht als PARAMETER in die Abfrage. Der Client kann damit kein Muster bauen,
    // das etwas anderes trifft als Marke, Name oder SKU.
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${PRODUCT_COLUMNS} FROM products
          WHERE branch_id = ?
            AND category_id NOT LIKE 'cat-repair-service%'
            AND (LOWER(brand) LIKE ? OR LOWER(name) LIKE ? OR LOWER(COALESCE(sku, '')) LIKE ?)
          ORDER BY updated_at DESC LIMIT ?`,
        [branch, like, like, like, limitOf(p)],
      )
      : rows(
        `SELECT ${PRODUCT_COLUMNS} FROM products
          WHERE branch_id = ? AND category_id NOT LIKE 'cat-repair-service%'
          ORDER BY updated_at DESC LIMIT ?`,
        [branch, limitOf(p)],
      );

    // Die Kopfzahlen kommen aus derselben Regel wie auf dem Primary — eine Kennzahl, eine Formel.
    const own = rows(
      `SELECT id, purchase_price, quantity, planned_sale_price, stock_status, source_type
         FROM products WHERE branch_id = ?`,
      [branch],
    )
      .map((r) => ({
        id: str(r.id),
        purchasePrice: num(r.purchase_price),
        quantity: r.quantity === null ? null : num(r.quantity),
        plannedSalePrice: num(r.planned_sale_price),
        stockStatus: str(r.stock_status),
        sourceType: str(r.source_type),
      }))
      .filter(isOwnStockAsset);
    const agg: Map<string, LotAggregate> = getStockAggregates(own.map((o) => o.id));
    const summary = summarizeInventory(own, agg);

    return {
      items: list.map(productDto),
      truncated: list.length >= limitOf(p),
      stock: { records: summary.records, units: summary.units, cost: summary.cost },
    };
  },
});

registerCommand(OP_PRODUCTS_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const found = rows(
      `SELECT ${PRODUCT_COLUMNS}, attributes, notes, storage_location
         FROM products WHERE id = ? AND branch_id = ?`,
      [idOf(p), branch],
    );
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such product in this branch');
    const r = found[0];
    const gal = galleryOf(actorTenant(p), str(r.id));
    return {
      ...productDto(r),
      attributes: str(r.attributes) || '{}',
      notes: str(r.notes),
      storageLocation: str(r.storage_location),
      // Der Client holt die Bytes über die bestehende, angemeldete Medienroute — hier reist kein Bild.
      mediaKeys: gal.map((g) => g.key),
      // …und die Kennungen daneben, in DERSELBEN Reihenfolge: ohne sie kann ein zweiter Rechner
      // keine Galerie planen, denn „behalte dieses Bild" braucht eine Identität, keinen Inhalt.
      mediaIds: gal.map((g) => g.mediaId),
    };
  },
});

// ── Kunden ─────────────────────────────────────────────────────────────────
const CUSTOMER_COLUMNS =
  'id, first_name, last_name, company, phone, email, country, vip_level, customer_type, '
  + 'sales_stage, created_at, updated_at';

function customerDto(r: Row): CommandResult {
  return {
    id: str(r.id),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    company: str(r.company),
    phone: str(r.phone),
    email: str(r.email),
    country: str(r.country),
    vipLevel: str(r.vip_level),
    customerType: str(r.customer_type),
    salesStage: str(r.sales_stage),
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_CUSTOMERS_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${CUSTOMER_COLUMNS} FROM customers
          WHERE branch_id = ? AND id NOT LIKE 'sys-%'
            AND (LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(COALESCE(company,'')) LIKE ?)
          ORDER BY updated_at DESC LIMIT ?`,
        [branch, like, like, like, limitOf(p)],
      )
      : rows(
        `SELECT ${CUSTOMER_COLUMNS} FROM customers
          WHERE branch_id = ? AND id NOT LIKE 'sys-%'
          ORDER BY updated_at DESC LIMIT ?`,
        [branch, limitOf(p)],
      );
    return { items: list.map(customerDto), truncated: list.length >= limitOf(p) };
  },
});

registerCommand(OP_CUSTOMERS_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const found = rows(
      `SELECT ${CUSTOMER_COLUMNS}, whatsapp, language, budget_min, budget_max, notes
         FROM customers WHERE id = ? AND branch_id = ?`,
      [idOf(p), branch],
    );
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such customer in this branch');
    const r = found[0];
    return {
      ...customerDto(r),
      whatsapp: str(r.whatsapp),
      language: str(r.language),
      budgetMin: r.budget_min === null ? null : num(r.budget_min),
      budgetMax: r.budget_max === null ? null : num(r.budget_max),
      notes: str(r.notes),
    };
  },
});

// ── Rechnungen ─────────────────────────────────────────────────────────────
const INVOICE_COLUMNS =
  'id, invoice_number, customer_id, status, currency, net_amount, vat_amount, gross_amount, '
  + 'paid_amount, issued_at, due_at, created_at, updated_at, revision';

function invoiceDto(r: Row): CommandResult {
  const gross = num(r.gross_amount);
  const paid = num(r.paid_amount);
  return {
    id: str(r.id),
    invoiceNumber: str(r.invoice_number),
    customerId: str(r.customer_id),
    status: str(r.status),
    currency: str(r.currency),
    netAmount: num(r.net_amount),
    vatAmount: num(r.vat_amount),
    grossAmount: gross,
    paidAmount: paid,
    // Was offen ist, rechnet der Primary — nicht der Client, sonst gäbe es zwei Antworten darauf.
    openAmount: Math.max(0, gross - paid),
    issuedAt: str(r.issued_at),
    dueAt: str(r.due_at),
    // CENTRAL-C3D — die FASSUNG, auf die sich eine Änderung bezieht. Ohne sie könnte ein zweiter
    // Rechner blind überschreiben, was der Primary inzwischen geändert hat. Ausdrücklich eine
    // Ganzzahl und kein Zeitstempel: zwei Änderungen in derselben Millisekunde trügen denselben
    // Zeitstempel, und die Sicherung versagte genau dann, wenn sie gebraucht wird.
    revision: num(r.revision),
    // Nur zur Anzeige.
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_INVOICES_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const status = input(p).status;
    // Nur ein Status aus einer festen Liste — kein freier Ausdruck.
    const allowed = ['DRAFT', 'FINAL', 'CANCELLED', 'PAID'];
    const filter = typeof status === 'string' && allowed.includes(status) ? status : null;
    const list = filter
      ? rows(
        `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE branch_id = ? AND status = ?
          ORDER BY COALESCE(issued_at, created_at) DESC LIMIT ?`,
        [branch, filter, limitOf(p)],
      )
      : rows(
        `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE branch_id = ?
          ORDER BY COALESCE(issued_at, created_at) DESC LIMIT ?`,
        [branch, limitOf(p)],
      );
    return { items: list.map(invoiceDto), truncated: list.length >= limitOf(p) };
  },
});

registerCommand(OP_INVOICES_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const id = idOf(p);
    const found = rows(`SELECT ${INVOICE_COLUMNS}, notes FROM invoices WHERE id = ? AND branch_id = ?`, [id, branch]);
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such invoice in this branch');
    const lines = rows(
      `SELECT id, product_id, description, quantity, unit_price, vat_rate, vat_amount, line_total, position
         FROM invoice_lines WHERE invoice_id = ? ORDER BY position ASC`,
      [id],
    ).map((l) => ({
      id: str(l.id),
      productId: str(l.product_id),
      description: str(l.description),
      quantity: l.quantity === null ? 1 : num(l.quantity),
      unitPrice: num(l.unit_price),
      vatRate: num(l.vat_rate),
      vatAmount: num(l.vat_amount),
      lineTotal: num(l.line_total),
      // CENTRAL-C3H — wieviel von dieser Zeile noch zurueckgegeben werden darf. Der Primary
      // rechnet es (Originalmenge minus alles, was nicht verworfene Rueckgaben schon halten) —
      // genau dieselbe Bedingung, die `createReturn` in der Transaktion noch einmal prueft.
      // Ohne diese Auskunft boete ein Client eine Menge an, die es nicht mehr gibt.
      returnedQuantity: num(rows(
        `SELECT COALESCE(SUM(srl.quantity), 0) AS q FROM sales_return_lines srl
           JOIN sales_returns r ON r.id = srl.return_id
          WHERE srl.invoice_line_id = ? AND r.status != 'REJECTED'`,
        [str(l.id)],
      )[0]?.q),
      returnableQuantity: Math.max(0, (l.quantity === null ? 1 : num(l.quantity)) - num(rows(
        `SELECT COALESCE(SUM(srl.quantity), 0) AS q FROM sales_return_lines srl
           JOIN sales_returns r ON r.id = srl.return_id
          WHERE srl.invoice_line_id = ? AND r.status != 'REJECTED'`,
        [str(l.id)],
      )[0]?.q)),
    }));
    // Die Rueckgaben dieser Rechnung — mit ihrer eigenen FASSUNG, denn Genehmigen, Erstatten
    // und Auszahlen beziehen sich auf die RUECKGABE, nicht auf die Rechnung.
    const returns = rows(
      `SELECT id, return_number, status, total_amount, refund_amount, refund_paid_amount,
              refund_status, refund_method, product_disposition, return_date, revision
         FROM sales_returns WHERE invoice_id = ? ORDER BY return_date ASC, id ASC`,
      [id],
    ).map((r) => ({
      id: str(r.id),
      returnNumber: str(r.return_number),
      status: str(r.status),
      totalAmount: num(r.total_amount),
      refundPaidAmount: num(r.refund_paid_amount),
      // Auch hier: was offen ist, rechnet der Primary.
      refundOpenAmount: Math.max(0, num(r.total_amount) - num(r.refund_paid_amount)),
      refundStatus: str(r.refund_status),
      refundMethod: str(r.refund_method),
      productDisposition: str(r.product_disposition),
      returnDate: str(r.return_date),
      revision: num(r.revision),
    }));
    // CENTRAL-C3G — die Zahlungen gehören zur Rechnung, nicht in einen eigenen Lesebefehl. Wer
    // eine berichtigen oder löschen will, muss sehen, welche es gibt.
    const payments = rows(
      `SELECT id, amount, method, card_brand, received_at, notes
         FROM payments WHERE invoice_id = ? ORDER BY received_at ASC, id ASC`,
      [id],
    ).map((x) => ({
      id: str(x.id),
      amount: num(x.amount),
      method: str(x.method),
      cardBrand: str(x.card_brand),
      receivedAt: str(x.received_at),
      notes: str(x.notes),
      // Eine Guthaben-Zahlung hängt an einer Guthabenzeile — der Client darf sie sehen, aber
      // nicht anfassen. Der Primary weist sie ohnehin ab; hier steht der Grund sichtbar.
      editable: str(x.method) !== 'credit',
    }));
    // Und was an offenem Guthaben dieses Kunden wirklich da ist — vom Primary summiert.
    const credit = rows(
      `SELECT COALESCE(SUM(amount - COALESCE(used_amount, 0)), 0) AS c
         FROM customer_credits WHERE customer_id = ? AND status = 'OPEN'`,
      [str(found[0].customer_id)],
    );
    return {
      ...invoiceDto(found[0]),
      notes: str(found[0].notes),
      lines,
      payments,
      returns,
      creditAvailable: Math.max(0, num(credit[0]?.c)),
    };
  },
});

// ── CENTRAL-C3E — Handelsbelege ────────────────────────────────────────────
//
// Dieselben drei Grundsätze wie oben, und ein vierter, der hier zum ersten Mal Geld kostet:
// **was abgeleitet ist, rechnet der Primary.** Der offene Rest eines Einkaufs, das bezahlte
// Geld eines Auftrags, die Sperre eines Auszahlungsmodells — nichts davon rechnet der Client
// selbst nach, sonst gäbe es zwei Antworten auf dieselbe Frage.
//
// Und wo es einen Änderungsweg gibt (Auftrag, Kommission), reist die FASSUNG mit. Sie ist das
// Einzige, womit ein Client später sagen kann, WORAUF sich seine Änderung bezieht.

// ── Lieferanten ────────────────────────────────────────────────────────────

const SUPPLIER_COLUMNS = 'id, name, phone, email, active';

registerCommand(OP_SUPPLIERS_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${SUPPLIER_COLUMNS} FROM suppliers
          WHERE branch_id = ? AND LOWER(name) LIKE ?
          ORDER BY name ASC LIMIT ?`,
        [branch, like, limitOf(p)],
      )
      : rows(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE branch_id = ? ORDER BY name ASC LIMIT ?`,
        [branch, limitOf(p)]);
    return {
      items: list.map((r) => ({
        id: str(r.id),
        name: str(r.name),
        phone: str(r.phone),
        email: str(r.email),
        // Ein stillgelegter Lieferant wird nicht versteckt, sondern benannt: eine Lücke in der
        // Liste sähe aus wie ein Fehler, die Kennzeichnung ist eine Auskunft.
        active: Number(r.active ?? 1) === 1,
      })),
      truncated: list.length >= limitOf(p),
    };
  },
});

// ── Kategorien ─────────────────────────────────────────────────────────────

registerCommand(OP_CATEGORIES_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const list = rows(
      `SELECT id, name, icon FROM categories WHERE branch_id = ? ORDER BY name ASC LIMIT ?`,
      [branch, limitOf(p)],
    );
    return {
      items: list.map((r) => ({ id: str(r.id), name: str(r.name), icon: str(r.icon) })),
      truncated: list.length >= limitOf(p),
    };
  },
});

// ── Einkäufe ───────────────────────────────────────────────────────────────

const PURCHASE_COLUMNS =
  'id, purchase_number, supplier_id, status, total_amount, paid_amount, '
  + 'purchase_date, created_at, updated_at';

function purchaseDto(r: Row): CommandResult {
  const total = num(r.total_amount);
  const paid = num(r.paid_amount);
  return {
    id: str(r.id),
    purchaseNumber: str(r.purchase_number),
    supplierId: str(r.supplier_id),
    status: str(r.status),
    totalAmount: total,
    paidAmount: paid,
    // Was noch offen ist, rechnet der Primary. Die gespeicherte Spalte reist ABSICHTLICH nicht
    // mit: zwei Quellen für dieselbe Zahl sind eine zu viel.
    openAmount: Math.max(0, total - paid),
    purchaseDate: str(r.purchase_date),
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_PURCHASES_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${PURCHASE_COLUMNS} FROM purchases
          WHERE branch_id = ? AND LOWER(purchase_number) LIKE ?
          ORDER BY COALESCE(purchase_date, created_at) DESC LIMIT ?`,
        [branch, like, limitOf(p)],
      )
      : rows(
        `SELECT ${PURCHASE_COLUMNS} FROM purchases WHERE branch_id = ?
          ORDER BY COALESCE(purchase_date, created_at) DESC LIMIT ?`,
        [branch, limitOf(p)],
      );
    return { items: list.map(purchaseDto), truncated: list.length >= limitOf(p) };
  },
});

registerCommand(OP_PURCHASES_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const id = idOf(p);
    const found = rows(`SELECT ${PURCHASE_COLUMNS}, notes FROM purchases WHERE id = ? AND branch_id = ?`, [id, branch]);
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such purchase in this branch');
    const lines = rows(
      `SELECT id, product_id, description, quantity, unit_price, line_total, position, tax_scheme, vat_amount
         FROM purchase_lines WHERE purchase_id = ? ORDER BY position ASC`,
      [id],
    ).map((l) => ({
      id: str(l.id),
      productId: str(l.product_id),
      description: str(l.description),
      quantity: l.quantity === null ? 1 : num(l.quantity),
      unitPrice: num(l.unit_price),
      lineTotal: num(l.line_total),
      taxScheme: str(l.tax_scheme),
      vatAmount: num(l.vat_amount),
    }));
    const payments = rows(
      'SELECT id, amount, method, paid_at FROM purchase_payments WHERE purchase_id = ? ORDER BY paid_at ASC',
      [id],
    ).map((x) => ({ id: str(x.id), amount: num(x.amount), method: str(x.method), paidAt: str(x.paid_at) }));
    return { ...purchaseDto(found[0]), notes: str(found[0].notes), lines, payments };
  },
});

// ── Kommissionen ───────────────────────────────────────────────────────────

const CONSIGNMENT_COLUMNS =
  'id, consignment_number, consignor_id, product_id, agreed_price, minimum_price, commission_rate, '
  + 'commission_type, commission_value, excess_split_pct, status, agreement_date, expiry_date, '
  + 'payout_status, payout_paid_amount, sale_price, commission_amount, payout_amount, invoice_id, '
  + 'updated_at, revision';

function consignmentDto(r: Row): CommandResult {
  return {
    id: str(r.id),
    consignmentNumber: str(r.consignment_number),
    consignorId: str(r.consignor_id),
    productId: str(r.product_id),
    agreedPrice: num(r.agreed_price),
    minimumPrice: r.minimum_price === null ? null : num(r.minimum_price),
    // Modell und Parameter gehören zusammen — getrennt gelesen ergäben sie eine Abrechnung, die
    // es so nie gab.
    payoutModel: str(r.commission_type),
    commissionRate: num(r.commission_rate),
    excessSplitPct: r.excess_split_pct === null ? null : num(r.excess_split_pct),
    status: str(r.status),
    agreementDate: str(r.agreement_date),
    expiryDate: str(r.expiry_date),
    payoutStatus: str(r.payout_status),
    // CENTRAL-C3G — was auszuzahlen ist, was schon geflossen ist und was offen bleibt. Der
    // Primary rechnet den Rest; der Client zeigt ihn nur.
    payoutAmount: r.payout_amount === null ? null : num(r.payout_amount),
    payoutPaidAmount: num(r.payout_paid_amount),
    payoutOpenAmount: Math.max(0, num(r.payout_amount) - num(r.payout_paid_amount)),
    salePrice: r.sale_price === null ? null : num(r.sale_price),
    commissionAmount: r.commission_amount === null ? null : num(r.commission_amount),
    // Die Sperre kommt aus der Domäne, nicht aus einer Nachbildung im Client.
    payoutLocked: payoutModelLock(rowToConsignment(r)).locked,
    // CENTRAL-C3H — der Kaeufer darf nicht der Einlieferer sein (das waere eine Ruecknahme,
    // kein Verkauf). Der Client kann ihn damit aus seiner Auswahl nehmen; der Primary weist es
    // trotzdem noch einmal ab.
    invoiceId: str(r.invoice_id),
    revision: num(r.revision),
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_CONSIGNMENTS_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${CONSIGNMENT_COLUMNS} FROM consignments
          WHERE branch_id = ? AND LOWER(consignment_number) LIKE ?
          ORDER BY COALESCE(agreement_date, created_at) DESC LIMIT ?`,
        [branch, like, limitOf(p)],
      )
      : rows(
        `SELECT ${CONSIGNMENT_COLUMNS} FROM consignments WHERE branch_id = ?
          ORDER BY COALESCE(agreement_date, created_at) DESC LIMIT ?`,
        [branch, limitOf(p)],
      );
    return { items: list.map(consignmentDto), truncated: list.length >= limitOf(p) };
  },
});

registerCommand(OP_CONSIGNMENTS_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const found = rows(`SELECT ${CONSIGNMENT_COLUMNS}, notes FROM consignments WHERE id = ? AND branch_id = ?`, [idOf(p), branch]);
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such consignment in this branch');
    return { ...consignmentDto(found[0]), notes: str(found[0].notes) };
  },
});

// ── Aufträge ───────────────────────────────────────────────────────────────

const ORDER_COLUMNS =
  'id, order_number, customer_id, status, type, agreed_price, deposit_amount, remaining_amount, '
  + 'supplier_name, supplier_price, expected_margin, expected_delivery, requested_brand, '
  + 'requested_model, invoice_id, created_at, updated_at, revision';

function orderDto(r: Row): CommandResult {
  return {
    id: str(r.id),
    orderNumber: str(r.order_number),
    customerId: str(r.customer_id),
    status: str(r.status),
    type: str(r.type),
    agreedPrice: r.agreed_price === null ? null : num(r.agreed_price),
    depositAmount: num(r.deposit_amount),
    remainingAmount: num(r.remaining_amount),
    supplierName: str(r.supplier_name),
    supplierPrice: r.supplier_price === null ? null : num(r.supplier_price),
    expectedMargin: r.expected_margin === null ? null : num(r.expected_margin),
    expectedDelivery: str(r.expected_delivery),
    requestedBrand: str(r.requested_brand),
    requestedModel: str(r.requested_model),
    // CENTRAL-C3G — ist der Auftrag schon berechnet? Ohne diese Auskunft böte ein Client eine
    // Umwandlung an, die der Primary sofort ablehnt.
    invoiceId: str(r.invoice_id),
    // CENTRAL-C3H — welcher Schritt als naechstes ginge. Aus DERSELBEN Ableitung, die auch der
    // Bildschirm des Primary und der Fernauftrag benutzen: ein Client, der sich eine eigene
    // Reihenfolge ausdaechte, boete Knoepfe an, die der Primary sofort abweist.
    nextStatus: nextOrderStatus(str(r.status)) ?? '',
    revision: num(r.revision),
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_ORDERS_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${ORDER_COLUMNS} FROM orders
          WHERE branch_id = ? AND (LOWER(order_number) LIKE ? OR LOWER(COALESCE(requested_brand,'')) LIKE ?)
          ORDER BY created_at DESC LIMIT ?`,
        [branch, like, like, limitOf(p)],
      )
      : rows(`SELECT ${ORDER_COLUMNS} FROM orders WHERE branch_id = ? ORDER BY created_at DESC LIMIT ?`,
        [branch, limitOf(p)]);
    return { items: list.map(orderDto), truncated: list.length >= limitOf(p) };
  },
});

registerCommand(OP_ORDERS_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const id = idOf(p);
    const found = rows(`SELECT ${ORDER_COLUMNS}, notes FROM orders WHERE id = ? AND branch_id = ?`, [id, branch]);
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such order in this branch');
    const lines = rows(
      `SELECT id, product_id, description, quantity, unit_price, line_total, position, status,
              is_customer_facing, invoice_id
         FROM order_lines WHERE order_id = ? ORDER BY position ASC`,
      [id],
    ).map((l) => ({
      id: str(l.id),
      productId: str(l.product_id),
      description: str(l.description),
      quantity: l.quantity === null ? 1 : num(l.quantity),
      unitPrice: num(l.unit_price),
      lineTotal: num(l.line_total),
      status: str(l.status),
      isCustomerFacing: Number(l.is_customer_facing ?? 1) === 1,
      // Abrechenbar ist, was fertig, kundenseitig und noch nicht berechnet ist — dieselbe
      // Bedingung wie `getBillableLines`. WELCHE Zeilen es am Ende sind, entscheidet trotzdem
      // der Primary in der Transaktion; hier steht sie, damit der Client nichts Falsches anbietet.
      invoiceId: str(l.invoice_id),
      billable: str(l.invoice_id) === '' && Number(l.is_customer_facing ?? 1) === 1
        && ['ARRIVED', 'DELIVERED'].includes(str(l.status)),
    }));
    const paid = rows(
      'SELECT COALESCE(SUM(amount), 0) AS s FROM order_payments WHERE order_id = ? AND COALESCE(converted_to_invoice, 0) = 0',
      [id],
    );
    // CENTRAL-C3H — die Anzahlungen EINZELN: wer eine zuruecknehmen will, muss sehen, welche es
    // gibt. Eine bereits an die Rechnung uebergegangene ist sichtbar, aber nicht mehr loeschbar
    // — das Geld steht dort in einem Beleg.
    const payments = rows(
      `SELECT id, amount, method, card_brand, paid_at, reference, note, converted_to_invoice
         FROM order_payments WHERE order_id = ? ORDER BY paid_at ASC, created_at ASC`,
      [id],
    ).map((x) => ({
      id: str(x.id),
      amount: num(x.amount),
      method: str(x.method),
      cardBrand: str(x.card_brand),
      paidAt: str(x.paid_at),
      reference: str(x.reference),
      note: str(x.note),
      convertedToInvoice: Number(x.converted_to_invoice ?? 0) === 1,
      deletable: Number(x.converted_to_invoice ?? 0) === 0,
    }));
    return {
      ...orderDto(found[0]),
      notes: str(found[0].notes),
      lines,
      payments,
      // Auch hier summiert der Primary. Der Client zeigt nur.
      paidAmount: num(paid[0]?.s),
    };
  },
});

// ── Reparaturen ────────────────────────────────────────────────────────────

const REPAIR_COLUMNS =
  'id, repair_number, customer_id, product_id, item_brand, item_model, item_serial, '
  + 'issue_description, diagnosis, repair_type, repair_scope, external_vendor, '
  + 'workshop_supplier_id, estimated_cost, actual_cost, internal_cost, charge_to_customer, '
  + 'margin, status, received_at, estimated_ready, tax_scheme, invoice_id, updated_at, revision';

function repairDto(r: Row): CommandResult {
  return {
    id: str(r.id),
    repairNumber: str(r.repair_number),
    customerId: str(r.customer_id),
    productId: str(r.product_id),
    itemBrand: str(r.item_brand),
    itemModel: str(r.item_model),
    itemSerial: str(r.item_serial),
    issueDescription: str(r.issue_description),
    diagnosis: str(r.diagnosis),
    repairType: str(r.repair_type),
    repairScope: str(r.repair_scope),
    externalVendor: str(r.external_vendor),
    workshopSupplierId: str(r.workshop_supplier_id),
    estimatedCost: r.estimated_cost === null ? null : num(r.estimated_cost),
    actualCost: r.actual_cost === null ? null : num(r.actual_cost),
    internalCost: num(r.internal_cost),
    chargeToCustomer: r.charge_to_customer === null ? null : num(r.charge_to_customer),
    // Die Marge rechnet der Primary. Sie reist als ERGEBNIS mit, nie als Eingabe.
    margin: r.margin === null ? null : num(r.margin),
    status: str(r.status),
    receivedAt: str(r.received_at),
    estimatedReady: str(r.estimated_ready),
    taxScheme: str(r.tax_scheme),
    // CENTRAL-C3H — hat sie schon eine Rechnung? Ohne diese Auskunft boete ein Client eine
    // zweite an, die der Primary sofort abweist.
    invoiceId: str(r.invoice_id),
    // Und welche Schritte von hier aus wirklich gingen — aus der geteilten Ableitung.
    allowedStatusTargets: allowedRepairStatusTargets(str(r.status), str(r.repair_type), str(r.repair_scope)),
    revision: num(r.revision),
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_REPAIRS_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${REPAIR_COLUMNS} FROM repairs
          WHERE branch_id = ? AND (LOWER(repair_number) LIKE ? OR LOWER(COALESCE(item_brand,'')) LIKE ?
            OR LOWER(COALESCE(item_model,'')) LIKE ?)
          ORDER BY received_at DESC LIMIT ?`,
        [branch, like, like, like, limitOf(p)],
      )
      : rows(`SELECT ${REPAIR_COLUMNS} FROM repairs WHERE branch_id = ? ORDER BY received_at DESC LIMIT ?`,
        [branch, limitOf(p)]);
    return { items: list.map(repairDto), truncated: list.length >= limitOf(p) };
  },
});

registerCommand(OP_REPAIRS_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const id = idOf(p);
    const found = rows(`SELECT ${REPAIR_COLUMNS}, notes, voucher_code FROM repairs WHERE id = ? AND branch_id = ?`, [id, branch]);
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such repair in this branch');
    // Die Arbeitszeilen gehören dazu: sie tragen die Kosten, und wer den Kopf ändert, muss sehen,
    // worauf er sich bezieht.
    const lines = rows(
      `SELECT id, supplier_id, work_type, cost_amount, status, position
         , expense_id FROM repair_lines WHERE repair_id = ? ORDER BY position ASC`,
      [id],
    ).map((l) => ({
      id: str(l.id),
      supplierId: str(l.supplier_id),
      workType: str(l.work_type),
      costAmount: num(l.cost_amount),
      status: str(l.status),
      // Eine Zeile mit gebuchter Zahlung wird nicht mehr geaendert — das sagt der Primary, nicht
      // eine Nachbildung im Client.
      expenseId: str(l.expense_id),
      editable: str(l.status) === 'OPEN'
        && num(rows('SELECT COALESCE(paid_amount, 0) AS p FROM expenses WHERE id = ?', [str(l.expense_id)])[0]?.p) <= 0,
    }));
    // Was die offenen Arbeitszeilen zusammen kosten — die Zahl, die in den Einstand der
    // Rechnungszeile eingeht. Vom Primary summiert.
    const openLineTotal = num(rows(
      "SELECT COALESCE(SUM(cost_amount), 0) AS t FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'",
      [id],
    )[0]?.t);
    return {
      ...repairDto(found[0]), notes: str(found[0].notes),
      voucherCode: str(found[0].voucher_code), lines, openLineTotal,
    };
  },
});

// ── Agenten-Transfers ──────────────────────────────────────────────────────

const TRANSFER_COLUMNS =
  'id, transfer_number, agent_id, product_id, agent_price, minimum_price, settlement_model, '
  + 'excess_split_pct, status, transferred_at, return_by, sold_at, returned_at, '
  + 'actual_sale_price, settlement_amount, settlement_paid_amount, settlement_status, '
  + 'invoice_id, updated_at, revision';

function transferDto(r: Row): CommandResult {
  return {
    id: str(r.id),
    transferNumber: str(r.transfer_number),
    agentId: str(r.agent_id),
    productId: str(r.product_id),
    agentPrice: num(r.agent_price),
    minimumPrice: r.minimum_price === null ? null : num(r.minimum_price),
    settlementModel: str(r.settlement_model),
    excessSplitPct: r.excess_split_pct === null ? null : num(r.excess_split_pct),
    status: str(r.status),
    transferredAt: str(r.transferred_at),
    returnBy: str(r.return_by),
    soldAt: str(r.sold_at),
    returnedAt: str(r.returned_at),
    actualSalePrice: r.actual_sale_price === null ? null : num(r.actual_sale_price),
    // CENTRAL-C3G — was uns aus dem Verkauf zusteht, was der Agent schon abgerechnet hat und was
    // offen bleibt. Alle drei vom Primary.
    settlementAmount: r.settlement_amount === null ? null : num(r.settlement_amount),
    settlementPaidAmount: num(r.settlement_paid_amount),
    settlementOpenAmount: Math.max(0, num(r.settlement_amount) - num(r.settlement_paid_amount)),
    settlementStatus: str(r.settlement_status),
    // CENTRAL-C3H — ist er schon in eine Rechnung gewandert? Zweimal umwandeln geht nicht, und
    // ein Client soll es gar nicht erst anbieten.
    invoiceId: str(r.invoice_id),
    revision: num(r.revision),
    updatedAt: str(r.updated_at),
  };
}

registerCommand(OP_TRANSFERS_LIST, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const q = searchOf(p);
    const like = `%${q.toLowerCase()}%`;
    const list = q
      ? rows(
        `SELECT ${TRANSFER_COLUMNS} FROM agent_transfers
          WHERE branch_id = ? AND LOWER(transfer_number) LIKE ?
          ORDER BY transferred_at DESC LIMIT ?`,
        [branch, like, limitOf(p)],
      )
      : rows(`SELECT ${TRANSFER_COLUMNS} FROM agent_transfers WHERE branch_id = ? ORDER BY transferred_at DESC LIMIT ?`,
        [branch, limitOf(p)]);
    return { items: list.map(transferDto), truncated: list.length >= limitOf(p) };
  },
});

registerCommand(OP_TRANSFERS_GET, {
  kind: 'read',
  handler: (p) => {
    const branch = actorBranch(p);
    const id = idOf(p);
    const found = rows(`SELECT ${TRANSFER_COLUMNS}, notes FROM agent_transfers WHERE id = ? AND branch_id = ?`, [id, branch]);
    if (found.length === 0) throw new BusinessError('NOT_FOUND', 'no such transfer in this branch');
    const agent = rows(`SELECT name, company FROM agents WHERE id = ?`, [str(found[0].agent_id)])[0];
    // Abrechnungszahlungen sind Geld an diesem Vorgang. Der Client darf sie SEHEN — anfassen
    // kann er sie nicht: dafür gibt es keine freigegebene Operation.
    const payments = rows(
      'SELECT id, amount, method, paid_at FROM agent_settlement_payments WHERE transfer_id = ? ORDER BY paid_at ASC',
      [id],
    ).map((x) => ({ id: str(x.id), amount: num(x.amount), method: str(x.method), paidAt: str(x.paid_at) }));
    return {
      ...transferDto(found[0]),
      notes: str(found[0].notes),
      agentName: str(agent?.name),
      agentCompany: str(agent?.company),
      settlementPayments: payments,
    };
  },
});
