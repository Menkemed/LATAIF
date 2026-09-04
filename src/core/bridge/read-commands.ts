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

export const OP_PRODUCTS_LIST = 'products.list';
export const OP_PRODUCTS_GET = 'products.get';
export const OP_CUSTOMERS_LIST = 'customers.list';
export const OP_CUSTOMERS_GET = 'customers.get';
export const OP_INVOICES_LIST = 'invoices.list';
export const OP_INVOICES_GET = 'invoices.get';

/** Jede Leseoperation, die C2 freischaltet — dieselbe Liste kennt auch Rust. */
export const C2_READ_OPS = [
  OP_PRODUCTS_LIST, OP_PRODUCTS_GET,
  OP_CUSTOMERS_LIST, OP_CUSTOMERS_GET,
  OP_INVOICES_LIST, OP_INVOICES_GET,
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
function mediaKeysFor(tenantId: string, productId: string): string[] {
  if (!tenantId) return [];
  return rows(
    `SELECT g.storage_key AS k
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
  ).map((r) => str(r.k)).filter(Boolean);
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
    return {
      ...productDto(r),
      attributes: str(r.attributes) || '{}',
      notes: str(r.notes),
      storageLocation: str(r.storage_location),
      // Der Client holt die Bytes über die bestehende, angemeldete Medienroute — hier reist kein Bild.
      mediaKeys: mediaKeysFor(actorTenant(p), str(r.id)),
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
  + 'paid_amount, issued_at, due_at, created_at, updated_at';

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
    }));
    return { ...invoiceDto(found[0]), notes: str(found[0].notes), lines };
  },
});
