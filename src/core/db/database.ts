// ═══════════════════════════════════════════════════════════
// LATAIF — Database Layer
// Multi-Branch, Offline-First, Sync-Ready
// ═══════════════════════════════════════════════════════════

import initSqlJs, { type Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { v4 as uuid } from 'uuid';
import { DEFAULT_CATEGORIES } from '../models/default-categories';
import SCHEMA from './schema.sql?raw';

let db: Database | null = null;
const STORAGE_KEY = 'lataif_db_v2';
const DB_FILENAME = 'lataif.db';

// ── Tauri detection ──
function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

async function getTauriFs() {
  return await import('@tauri-apps/plugin-fs');
}

async function getAppDataDir(): Promise<string> {
  const { appDataDir } = await import('@tauri-apps/api/path');
  return await appDataDir();
}

async function getDbFilePath(): Promise<string> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const dir = await appDataDir();
  return await join(dir, DB_FILENAME);
}

// ── Load DB from file (Tauri) or localStorage (browser) ──
async function loadSavedDb(): Promise<Uint8Array | null> {
  if (isTauri()) {
    try {
      const fs = await getTauriFs();
      const path = await getDbFilePath();
      const exists = await fs.exists(path);
      if (exists) {
        const data = await fs.readFile(path);
        return new Uint8Array(data);
      }
    } catch (err) {
      console.warn('[DB] Tauri file load failed:', err);
    }
    return null;
  }

  // Browser fallback
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return Uint8Array.from(atob(saved), c => c.charCodeAt(0));
    } catch { /* corrupt */ }
  }
  return null;
}

// ── Save DB to file (Tauri) or localStorage (browser) ──
async function persistDb(data: Uint8Array): Promise<void> {
  if (isTauri()) {
    const fs = await getTauriFs();
    const dir = await getAppDataDir();
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const path = await getDbFilePath();
    await fs.writeFile(path, data);
    return;
  }

  // Browser-only fallback
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  localStorage.setItem(STORAGE_KEY, btoa(binary));
}

function runMigrations(database: Database): void {
  // Each migration wrapped: ignore "duplicate column" errors on re-run.
  const migrations: string[] = [
    `ALTER TABLE consignments ADD COLUMN commission_type TEXT DEFAULT 'percent'`,
    `ALTER TABLE consignments ADD COLUMN commission_value REAL`,
    `CREATE TABLE IF NOT EXISTS order_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      paid_at TEXT NOT NULL,
      method TEXT,
      reference TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    )`,
    `ALTER TABLE invoices ADD COLUMN tip_amount REAL DEFAULT 0`,
    `ALTER TABLE invoices ADD COLUMN butterfly INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS tax_payments (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      quarter INTEGER NOT NULL,
      amount REAL NOT NULL,
      source TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      reference TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `INSERT OR IGNORE INTO settings (branch_id, key, value, category, updated_at)
     SELECT 'branch-main', 'finance.card_fee_rate', '2.2', 'finance', datetime('now')
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE branch_id = 'branch-main' AND key = 'finance.card_fee_rate')`,
    `INSERT OR IGNORE INTO settings (branch_id, key, value, category, updated_at)
     SELECT 'branch-main', 'finance.fiscal_year_start_month', '1', 'finance', datetime('now')
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE branch_id = 'branch-main' AND key = 'finance.fiscal_year_start_month')`,
    `ALTER TABLE customers ADD COLUMN vat_account_number TEXT`,
    `ALTER TABLE customers ADD COLUMN personal_id TEXT`,
    `CREATE TABLE IF NOT EXISTS customer_messages (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'outbound',
      kind TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      linked_entity_type TEXT,
      linked_entity_id TEXT,
      sent_at TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS debts (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      counterparty TEXT NOT NULL,
      customer_id TEXT,
      amount REAL NOT NULL,
      source TEXT NOT NULL,
      due_date TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT,
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS debt_payments (
      id TEXT PRIMARY KEY,
      debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      source TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    )`,
    `ALTER TABLE products ADD COLUMN paid_from TEXT`,
    `ALTER TABLE products ADD COLUMN purchase_source TEXT`,
    `INSERT OR IGNORE INTO settings (branch_id, key, value, category, updated_at)
     SELECT 'branch-main', 'finance.opening_cash', '0', 'finance', datetime('now')
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE branch_id = 'branch-main' AND key = 'finance.opening_cash')`,
    `INSERT OR IGNORE INTO settings (branch_id, key, value, category, updated_at)
     SELECT 'branch-main', 'finance.opening_bank', '0', 'finance', datetime('now')
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE branch_id = 'branch-main' AND key = 'finance.opening_bank')`,
    `ALTER TABLE repairs ADD COLUMN customer_paid_from TEXT`,
    `ALTER TABLE repairs ADD COLUMN internal_paid_from TEXT`,
    `ALTER TABLE agent_transfers ADD COLUMN commission_type TEXT DEFAULT 'percent'`,
    `ALTER TABLE agent_transfers ADD COLUMN commission_value REAL`,
    `ALTER TABLE agent_transfers ADD COLUMN commission_paid_from TEXT`,
    // Plan §Agent §4: Teilzahlungen an Agent — settlement_paid_amount tracken.
    `ALTER TABLE agent_transfers ADD COLUMN settlement_paid_amount REAL DEFAULT 0`,
    `ALTER TABLE consignments ADD COLUMN sale_method TEXT`,
    `ALTER TABLE order_payments ADD COLUMN converted_to_invoice INTEGER DEFAULT 0`,
    // Stückzahl pro Produkt (User-Wunsch): Default 1, multipliziert in Lagerwert.
    `ALTER TABLE products ADD COLUMN quantity INTEGER DEFAULT 1`,
    // Quantity pro Invoice-Line — nur relevant wenn Produkt mehrere Stück hat.
    `ALTER TABLE invoice_lines ADD COLUMN quantity INTEGER DEFAULT 1`,
    // Refund-Tracking: getrennt zwischen "geschuldete Rückzahlung" (refund_amount) und "tatsächlich gezahlt" (refund_paid_amount).
    // Ein Return kann offen sein (Ware retour, Geld noch nicht zurück).
    `ALTER TABLE sales_returns ADD COLUMN refund_paid_amount REAL DEFAULT 0`,
    `ALTER TABLE sales_returns ADD COLUMN refund_paid_date TEXT`,
    `ALTER TABLE sales_returns ADD COLUMN refund_status TEXT DEFAULT 'NOT_REFUNDED'`,
    `ALTER TABLE sales_returns ADD COLUMN reason TEXT`,
    // Orders nutzen jetzt Collection-Kategorien + Attribute (single source of truth).
    `ALTER TABLE orders ADD COLUMN category_id TEXT`,
    `ALTER TABLE orders ADD COLUMN attributes TEXT DEFAULT '{}'`,
    `ALTER TABLE orders ADD COLUMN condition TEXT`,
    `ALTER TABLE orders ADD COLUMN serial_number TEXT`,
    `ALTER TABLE orders ADD COLUMN existing_product_id TEXT`,
    // Multi-Line Items pro Order — User-Spec ORDER ITEMS SECTION (plural).
    `CREATE TABLE IF NOT EXISTS order_lines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      product_id TEXT,
      description TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id)`,
    // Plan §Order §Convert: Tax-Scheme + Rate per order_line persistieren —
    // sonst kennt Convert-to-Invoice die in OrderCreate gewählte Scheme nicht
    // und müsste den User erneut fragen (was Doppelbesteuerung verursachen kann).
    `ALTER TABLE order_lines ADD COLUMN tax_scheme TEXT`,
    `ALTER TABLE order_lines ADD COLUMN vat_rate REAL DEFAULT 0`,
    // Optionale Tax-Felder auf Order-Ebene (für die Pricing-Section)
    `ALTER TABLE orders ADD COLUMN tax_amount REAL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN payment_method TEXT`,
    `ALTER TABLE orders ADD COLUMN fully_paid INTEGER DEFAULT 0`,
    // Gold-Jewelry-Kategorien um Item Type + Color Type erweitern (User-Vorgabe).
    `UPDATE categories SET attributes = '[
      {"key":"weight","label":"Weight","type":"number","unit":"g","required":true,"showInList":true},
      {"key":"karat","label":"Karat","type":"select","options":["24K","22K","21K","18K","14K","9K"],"required":true,"showInList":true},
      {"key":"item_type","label":"Item Type","type":"select","options":["Ring","Bangle","Bracelet","Necklace","Pendant","Earrings","Brooch"],"required":true,"showInList":true},
      {"key":"color_type","label":"Color","type":"select","options":["Yellow Gold","Rose Gold","White Gold","Two-Tone"],"required":true,"showInList":true},
      {"key":"diamond_weight","label":"Diamond Weight","type":"number","unit":"ct","required":false,"showInList":true},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-gold-jewelry'`,
    // BRANDED_GOLD_JEWELRY — schlank: ohne Model/Serial/Cert/Box.
    `UPDATE categories SET attributes = '[
      {"key":"item_type","label":"Item Type","type":"select","options":["Ring","Bangle","Bracelet","Necklace","Pendant","Earrings","Brooch"],"required":true,"showInList":true},
      {"key":"color_type","label":"Color","type":"select","options":["Yellow Gold","Rose Gold","White Gold","Two-Tone"],"required":true,"showInList":true},
      {"key":"size","label":"Size","type":"text","required":true,"showInList":true},
      {"key":"karat","label":"Karat","type":"select","options":["24K","22K","21K","18K","14K","9K"],"required":true,"showInList":true},
      {"key":"weight","label":"Weight","type":"number","unit":"g","required":false,"showInList":true},
      {"key":"diamond_weight","label":"Diamond Weight","type":"number","unit":"ct","required":false,"showInList":true},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-branded-gold-jewelry'`,
    // ORIGINAL_GOLD_JEWELRY — size optional, plus Model/Serial/Year optional.
    `UPDATE categories SET attributes = '[
      {"key":"item_type","label":"Item Type","type":"select","options":["Ring","Bangle","Bracelet","Necklace","Pendant","Earrings","Brooch"],"required":true,"showInList":true},
      {"key":"color_type","label":"Color","type":"select","options":["Yellow Gold","Rose Gold","White Gold","Two-Tone"],"required":true,"showInList":true},
      {"key":"size","label":"Size","type":"text","required":false,"showInList":true},
      {"key":"karat","label":"Karat","type":"select","options":["24K","22K","21K","18K","14K","9K"],"required":true,"showInList":true},
      {"key":"weight","label":"Weight","type":"number","unit":"g","required":false,"showInList":true},
      {"key":"diamond_weight","label":"Diamond Weight","type":"number","unit":"ct","required":false,"showInList":true},
      {"key":"model_name","label":"Model Name","type":"text","required":false,"showInList":true},
      {"key":"model_number","label":"Model Number","type":"text","required":false,"showInList":false},
      {"key":"serial_number","label":"Serial Number","type":"text","required":false,"showInList":false},
      {"key":"year","label":"Year","type":"number","required":false,"showInList":false},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-original-gold-jewelry'`,
    // ORIGINAL_GOLD_JEWELRY — Included-Auswahl ohne Appraisal/Pouch.
    `UPDATE categories SET scope_options = '["Box","Certificate"]' WHERE id = 'cat-original-gold-jewelry'`,
    // ACCESSORY — Box/Papers raus aus Attributen (sind im Included-Multi-Select).
    `UPDATE categories SET attributes = '[
      {"key":"item_type","label":"Item Type","type":"select","options":["Handbag","Eyeglass","Wallet","Lighter","Cufflinks","Prayer Beads","Walking Stick","Pen","Key Holder","Other"],"required":true,"showInList":true},
      {"key":"color","label":"Color","type":"text","required":true,"showInList":true},
      {"key":"material","label":"Material","type":"text","required":true,"showInList":true},
      {"key":"description","label":"Description","type":"text","required":true,"showInList":false},
      {"key":"model_number","label":"Model No","type":"text","required":false,"showInList":false},
      {"key":"serial_number","label":"Serial No","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-accessory'`,
    // WATCH — Diamonds + Strap Type optional.
    `UPDATE categories SET attributes = '[
      {"key":"reference_number","label":"Reference Number","type":"text","required":true,"showInList":true},
      {"key":"model","label":"Model / Name","type":"text","required":true,"showInList":true},
      {"key":"case_diameter_mm","label":"Case Diameter","type":"number","unit":"mm","required":true,"showInList":true},
      {"key":"serial_number","label":"Serial Number","type":"text","required":true,"showInList":true},
      {"key":"dial","label":"Dial","type":"text","required":true,"showInList":false},
      {"key":"bezel","label":"Bezel","type":"text","required":true,"showInList":false},
      {"key":"material","label":"Material","type":"select","options":["Steel","Gold","Rose Gold","White Gold","Two-Tone","Titanium","Plated"],"required":true,"showInList":true},
      {"key":"diamonds","label":"Diamonds","type":"boolean","required":false,"showInList":false},
      {"key":"strap_type","label":"Strap Type","type":"select","options":["Leather","Rubber"],"required":false,"showInList":false},
      {"key":"movement","label":"Movement / Caliber","type":"text","required":false,"showInList":false},
      {"key":"year","label":"Year","type":"number","required":false,"showInList":false},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-watch'`,

    // ── Phase 0: Foundation per Boss Plan ──

    // Document-Sequences table (Plan §Settings §B)
    `CREATE TABLE IF NOT EXISTS document_sequences (
      doc_type TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      include_year INTEGER NOT NULL DEFAULT 1,
      padding INTEGER NOT NULL DEFAULT 6,
      updated_at TEXT NOT NULL
    )`,
    // Seed all document types from Plan
    `INSERT OR IGNORE INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at) VALUES
      ('INV',  'INV',  1, 1, 6, datetime('now')),
      ('PINV', 'PINV', 1, 1, 6, datetime('now')),
      ('PUR',  'PUR',  1, 1, 6, datetime('now')),
      ('PRET', 'PRET', 1, 1, 6, datetime('now')),
      ('RET',  'RET',  1, 1, 6, datetime('now')),
      ('REP',  'REP',  1, 1, 6, datetime('now')),
      ('AGD',  'AGD',  1, 1, 6, datetime('now')),
      ('LOA',  'LOA',  1, 1, 6, datetime('now')),
      ('PRD',  'PRD',  1, 1, 6, datetime('now')),
      ('PST',  'PST',  1, 1, 6, datetime('now')),
      ('PWD',  'PWD',  1, 1, 6, datetime('now')),
      ('CON',  'CON',  1, 1, 6, datetime('now')),
      ('EXP',  'EXP',  1, 1, 6, datetime('now')),
      ('OFF',  'OFF',  1, 1, 6, datetime('now')),
      ('TRF',  'TRF',  1, 1, 6, datetime('now'))
    `,

    // Audit log table (Plan §History/Audit §4)
    `CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      branch_id TEXT,
      module TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      changed_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON audit_log(changed_at)`,

    // Phase 0.B: Tax-Scheme-Rename auf VAT_10 / ZERO / MARGIN (Plan §Tax §3)
    `UPDATE products SET tax_scheme = 'VAT_10' WHERE tax_scheme = 'standard'`,
    `UPDATE products SET tax_scheme = 'MARGIN' WHERE tax_scheme = 'margin'`,
    `UPDATE products SET tax_scheme = 'ZERO' WHERE tax_scheme = 'exempt'`,
    `UPDATE offers SET tax_scheme = 'VAT_10' WHERE tax_scheme = 'standard'`,
    `UPDATE offers SET tax_scheme = 'MARGIN' WHERE tax_scheme = 'margin'`,
    `UPDATE offers SET tax_scheme = 'ZERO' WHERE tax_scheme = 'exempt'`,
    `UPDATE offer_lines SET tax_scheme = 'VAT_10' WHERE tax_scheme = 'standard'`,
    `UPDATE offer_lines SET tax_scheme = 'MARGIN' WHERE tax_scheme = 'margin'`,
    `UPDATE offer_lines SET tax_scheme = 'ZERO' WHERE tax_scheme = 'exempt'`,
    `UPDATE invoices SET tax_scheme_snapshot = 'VAT_10' WHERE tax_scheme_snapshot = 'standard'`,
    `UPDATE invoices SET tax_scheme_snapshot = 'MARGIN' WHERE tax_scheme_snapshot = 'margin'`,
    `UPDATE invoices SET tax_scheme_snapshot = 'ZERO' WHERE tax_scheme_snapshot = 'exempt'`,
    `UPDATE invoice_lines SET tax_scheme = 'VAT_10' WHERE tax_scheme = 'standard'`,
    `UPDATE invoice_lines SET tax_scheme = 'MARGIN' WHERE tax_scheme = 'margin'`,
    `UPDATE invoice_lines SET tax_scheme = 'ZERO' WHERE tax_scheme = 'exempt'`,
    `UPDATE settings SET value = 'MARGIN' WHERE key = 'tax.default_scheme' AND value = 'margin'`,
    `UPDATE settings SET value = 'VAT_10' WHERE key = 'tax.default_scheme' AND value = 'standard'`,
    `UPDATE settings SET value = 'ZERO' WHERE key = 'tax.default_scheme' AND value = 'exempt'`,

    // ── Phase 1: Einkauf ──

    // Supplier Module (Plan §Supplier §2)
    `CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_suppliers_branch ON suppliers(branch_id)`,

    // Purchases Module (Plan §Purchases §16 status)
    `CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      purchase_number TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      remaining_amount REAL NOT NULL DEFAULT 0,
      purchase_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id)`,
    `CREATE INDEX IF NOT EXISTS idx_purchases_branch ON purchases(branch_id)`,

    `CREATE TABLE IF NOT EXISTS purchase_lines (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      product_id TEXT,
      description TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    )`,

    `CREATE TABLE IF NOT EXISTS purchase_payments (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      reference TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    )`,

    // Purchase Returns (Plan §Purchase Returns §3)
    `CREATE TABLE IF NOT EXISTS purchase_returns (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      return_number TEXT NOT NULL,
      purchase_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      total_amount REAL NOT NULL DEFAULT 0,
      return_date TEXT NOT NULL,
      refund_method TEXT,
      refund_amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS purchase_return_lines (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
      purchase_line_id TEXT,
      product_id TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    )`,

    // Expenses Module (Plan §Expenses §5)
    `CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      expense_number TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      expense_date TEXT NOT NULL,
      description TEXT,
      related_module TEXT,
      related_entity_id TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_branch ON expenses(branch_id)`,

    // ── Phase 2: Sales-Refactor (Plan §Sales §2, §16) ──
    // Neue Invoice-Status: DRAFT / PARTIAL / FINAL / CANCELLED
    `UPDATE invoices SET status = 'DRAFT' WHERE status = 'draft'`,
    `UPDATE invoices SET status = 'PARTIAL' WHERE status = 'issued' OR status = 'partially_paid'`,
    `UPDATE invoices SET status = 'FINAL' WHERE status = 'paid'`,
    `UPDATE invoices SET status = 'CANCELLED' WHERE status = 'cancelled'`,

    // Sales Returns (Plan §Returns §3)
    `CREATE TABLE IF NOT EXISTS sales_returns (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      return_number TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'REQUESTED',
      total_amount REAL NOT NULL DEFAULT 0,
      vat_corrected REAL NOT NULL DEFAULT 0,
      return_date TEXT NOT NULL,
      refund_method TEXT,
      refund_amount REAL NOT NULL DEFAULT 0,
      product_disposition TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sales_return_lines (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
      invoice_line_id TEXT,
      product_id TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice ON sales_returns(invoice_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_returns_branch ON sales_returns(branch_id)`,

    // Credit Notes (Storno-Rechnungen) — eigenständige Steuerurkunde, 1:1 zu Sales Return
    // Industry standard (SAP/DATEV/Xero/QuickBooks): jeder Return erzeugt automatisch eine Credit Note
    // mit eigener Nummer (CN-YYYY-NNNNN), die in der Customer-/Invoice-History klickbar verlinkt ist.
    `CREATE TABLE IF NOT EXISTS credit_notes (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      credit_note_number TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      sales_return_id TEXT,
      customer_id TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      cash_refund_amount REAL NOT NULL DEFAULT 0,
      receivable_cancel_amount REAL NOT NULL DEFAULT 0,
      refund_method TEXT,
      reason TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(invoice_id)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_notes_branch ON credit_notes(branch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_notes_return ON credit_notes(sales_return_id)`,
    // Seed credit note doc-type sequence
    `INSERT OR IGNORE INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at)
     VALUES ('CN', 'CN', 1, 1, 6, datetime('now'))`,

    // ── Phase 4: Banking + Partner (Plan §Banking §10 Transfers, §Partner) ──

    // Bank Transfers (Cash↔Bank) — Plan §Banking §10
    `CREATE TABLE IF NOT EXISTS bank_transfers (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      amount REAL NOT NULL,
      direction TEXT NOT NULL,
      transfer_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bank_transfers_branch ON bank_transfers(branch_id)`,

    // Partners (Plan §Partner)
    `CREATE TABLE IF NOT EXISTS partners (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      share_percentage REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_partners_branch ON partners(branch_id)`,

    // Partner Transactions (PST, PWD, Profit Distribution)
    `CREATE TABLE IF NOT EXISTS partner_transactions (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      partner_id TEXT NOT NULL,
      transaction_number TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      transaction_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_partner_tx_partner ON partner_transactions(partner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_partner_tx_branch ON partner_transactions(branch_id)`,

    // ── Phase 7: Rollen-Rename (Plan §Users §4) ──
    `UPDATE user_branches SET role = 'ADMIN' WHERE role = 'owner'`,
    `UPDATE user_branches SET role = 'MANAGER' WHERE role = 'manager'`,
    `UPDATE user_branches SET role = 'SALES' WHERE role = 'sales' OR role = 'viewer'`,
    `UPDATE user_branches SET role = 'ACCOUNTANT' WHERE role = 'backoffice'`,

    // ── Phase 5: Production & Consumption (Plan §Production) ──
    `CREATE TABLE IF NOT EXISTS production_records (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      record_number TEXT NOT NULL,
      production_date TEXT NOT NULL,
      total_value REAL NOT NULL DEFAULT 0,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS production_inputs (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES production_records(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      product_snapshot TEXT,
      input_value REAL NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS production_outputs (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES production_records(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      output_value REAL NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_production_branch ON production_records(branch_id)`,

    // ── Phase 3: Product-Struktur (Plan §Product §5 source_type) ──
    `ALTER TABLE products ADD COLUMN source_type TEXT NOT NULL DEFAULT 'OWN'`,

    // Mark products attached to active consignments as CONSIGNMENT source
    `UPDATE products SET source_type = 'CONSIGNMENT' WHERE id IN
      (SELECT product_id FROM consignments WHERE status != 'returned')`,

    // Mark products attached to active agent transfers as AGENT source
    `UPDATE products SET source_type = 'AGENT' WHERE id IN
      (SELECT product_id FROM agent_transfers WHERE status = 'transferred' OR status = 'sold')`,

    // ── Phase 7.B: Loan Module (Plan §Loan §4) — LOA-Prefix numbering ──
    `ALTER TABLE debts ADD COLUMN loan_number TEXT`,

    // ── Phase 7.C: Plan canonical status values ──
    // Migrations deaktiviert — Plan-Canonicals (IN_STOCK/SOLD/RECEIVED/OPEN/REPAID/RETAIL/etc.)
    // werden NUR für neue Records geschrieben. Alte lowercase-Werte (in_stock/sold/open/settled/
    // received/active/collector) bleiben bestehen. canonical*Status() Helper in types.ts normalisieren
    // beim Lesen. So brechen keine bestehenden Vergleiche im UI-Code.

    // ── Phase 8: Vollständige Zahlungsfluss-Automation (10 Features) ──
    // #1 Repair Customer Charge Payment
    `ALTER TABLE repairs ADD COLUMN customer_paid_amount REAL DEFAULT 0`,
    `ALTER TABLE repairs ADD COLUMN customer_payment_status TEXT DEFAULT 'UNPAID'`,
    `ALTER TABLE repairs ADD COLUMN customer_payment_method TEXT`,
    `ALTER TABLE repairs ADD COLUMN customer_payment_date TEXT`,
    // #2 Consignment Partial Payouts
    `ALTER TABLE consignments ADD COLUMN payout_paid_amount REAL DEFAULT 0`,
    // payoutStatus erweitert: pending → partial → paid (Spalte existiert bereits)
    // #3 Supplier Credit Balance Ledger
    `CREATE TABLE IF NOT EXISTS supplier_credits (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      source_return_id TEXT,
      source_purchase_id TEXT,
      amount REAL NOT NULL,
      used_amount REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN',
      note TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_supplier_credits_supplier ON supplier_credits(supplier_id, status)`,
    // #4 Metal Payment-Integration (Tabelle: precious_metals)
    `ALTER TABLE precious_metals ADD COLUMN paid_amount REAL DEFAULT 0`,
    `ALTER TABLE precious_metals ADD COLUMN payment_status TEXT DEFAULT 'UNPAID'`,
    `CREATE TABLE IF NOT EXISTS metal_payments (
      id TEXT PRIMARY KEY,
      metal_id TEXT NOT NULL REFERENCES precious_metals(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_metal_payments_metal ON metal_payments(metal_id)`,
    // #5 Agent Settlement Payment History
    `CREATE TABLE IF NOT EXISTS agent_settlement_payments (
      id TEXT PRIMARY KEY,
      transfer_id TEXT NOT NULL REFERENCES agent_transfers(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_settlement_pmt_transfer ON agent_settlement_payments(transfer_id)`,
    // #6 Expense Status Field
    `ALTER TABLE expenses ADD COLUMN status TEXT DEFAULT 'PAID'`,
    // #6b Expense Partial-Payment-Tracking (Plan §Expenses §Pay-Later)
    `ALTER TABLE expenses ADD COLUMN paid_amount REAL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS expense_payments (
      id TEXT PRIMARY KEY,
      expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_expense_pmt_expense ON expense_payments(expense_id)`,
    // Backfill: bestehende PAID-Expenses auf paid_amount = amount setzen,
    // damit sie nicht als „offen" in /payables erscheinen.
    `UPDATE expenses SET paid_amount = amount WHERE status = 'PAID' AND paid_amount = 0`,
    // #7 Production Cost Tracking + Status (production_records existiert)
    `ALTER TABLE production_records ADD COLUMN status TEXT DEFAULT 'COMPLETED'`,
    `ALTER TABLE production_records ADD COLUMN labor_cost REAL DEFAULT 0`,
    `ALTER TABLE production_records ADD COLUMN overhead_cost REAL DEFAULT 0`,
    `ALTER TABLE production_records ADD COLUMN total_cost REAL DEFAULT 0`,
    // #8 Partner Distribution Payment Status
    `ALTER TABLE partner_transactions ADD COLUMN payment_status TEXT DEFAULT 'PAID'`,
    `ALTER TABLE partner_transactions ADD COLUMN paid_at_actual TEXT`,
    // #9 Bank-Transfer Auto-Sync — keine Schema-Änderung, nur Logik
    // #10 Offer ↔ Invoice Roundtrip
    `ALTER TABLE offers ADD COLUMN invoice_id TEXT`,
  ];
  for (const sql of migrations) {
    try { database.run(sql); } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) {
        console.warn('Migration skipped:', msg);
      }
    }
  }

  // Plan §Returns §History (Round 4) — Daten-Migration:
  // Restoriert historischen invoice.paid_amount für Invoices die durch alte Refund-Logik
  // reduziert wurden. Idempotent via settings-Flag.
  try {
    const flag = database.exec(
      `SELECT value FROM settings WHERE key = 'migration.return_paid_amount_historical_v1'`
    );
    const alreadyApplied = flag.length > 0 && flag[0].values.length > 0 && flag[0].values[0][0] === '1';
    if (!alreadyApplied) {
      // 1) paid_amount += sum der refund_paid_amount aller refundeten Returns auf dieser Invoice.
      database.run(
        `UPDATE invoices
            SET paid_amount = paid_amount + COALESCE((
              SELECT SUM(refund_paid_amount)
                FROM sales_returns
               WHERE invoice_id = invoices.id
                 AND status != 'REJECTED'
                 AND refund_paid_amount > 0
            ), 0)
          WHERE id IN (
            SELECT DISTINCT invoice_id
              FROM sales_returns
             WHERE status != 'REJECTED' AND refund_paid_amount > 0
          )`
      );
      // 2) Status korrigieren: Invoices die durch alten Auto-Cancel auf CANCELLED gesetzt
      //    wurden (paid wurde 0 → cancel), zurück auf FINAL/PARTIAL setzen.
      database.run(
        `UPDATE invoices
            SET status = CASE
              WHEN paid_amount >= gross_amount - 0.005 THEN 'FINAL'
              WHEN paid_amount > 0 THEN 'PARTIAL'
              ELSE 'DRAFT'
            END
          WHERE status = 'CANCELLED'
            AND id IN (
              SELECT DISTINCT invoice_id
                FROM sales_returns
               WHERE status != 'REJECTED' AND refund_paid_amount > 0
            )`
      );
      // Flag setzen, damit Migration nur einmal läuft.
      database.run(
        `INSERT OR REPLACE INTO settings (branch_id, key, value, category, updated_at)
         VALUES ('branch-main', 'migration.return_paid_amount_historical_v1', '1', 'system', datetime('now'))`
      );
    }
  } catch (err) {
    console.warn('paid_amount-historical migration failed:', err);
  }

  // Plan §Order — Order-Status-Vereinfachung v1:
  // Reduziert die 8 Status-Werte auf 5 (pending/arrived/notified/completed/cancelled).
  // Alte Werte deposit_received/sourcing/sourced werden auf 'pending' gemappt
  // (Zahlungs-/Beschaffungs-Stand wird ab jetzt aus order_payments + paymentStatus abgeleitet).
  // Idempotent via settings-Flag.
  try {
    const flag = database.exec(
      `SELECT value FROM settings WHERE key = 'migration.order_status_v2'`
    );
    const alreadyApplied = flag.length > 0 && flag[0].values.length > 0 && flag[0].values[0][0] === '1';
    if (!alreadyApplied) {
      database.run(
        `UPDATE orders
            SET status = 'pending',
                updated_at = datetime('now')
          WHERE status IN ('deposit_received', 'sourcing', 'sourced')`
      );
      database.run(
        `INSERT OR REPLACE INTO settings (branch_id, key, value, category, updated_at)
         VALUES ('branch-main', 'migration.order_status_v2', '1', 'system', datetime('now'))`
      );
    }
  } catch (err) {
    console.warn('order_status_v2 migration failed:', err);
  }
}

// Replace old 7-category structure (watches, jewelry, bags, shoes, eyewear, services, diamonds)
// with the new 7-group business structure. Runs once, tracked via settings flag.
function migrateCategoriesToV2(database: Database): void {
  try {
    // Check if already done
    const existing = database.exec(
      "SELECT value FROM settings WHERE key = 'categories.migrated_to_v2'"
    );
    const done = existing.length > 0 && existing[0].values.length > 0 && existing[0].values[0][0] === '1';
    if (done) return;

    const now = new Date().toISOString();
    let branchId = 'branch-main';
    try {
      const r = database.exec("SELECT id FROM branches LIMIT 1");
      if (r.length > 0 && r[0].values.length > 0) branchId = r[0].values[0][0] as string;
    } catch { /* no branches yet */ }

    // 1. Ensure the new 7 categories exist (insert if missing by id)
    const catStmt = database.prepare(
      `INSERT OR IGNORE INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const cat of DEFAULT_CATEGORIES) {
      catStmt.run([
        cat.id, branchId, cat.name, cat.icon, cat.color,
        JSON.stringify(cat.attributes), JSON.stringify(cat.scopeOptions),
        JSON.stringify(cat.conditionOptions), cat.active ? 1 : 0, cat.sortOrder, now, now,
      ]);
    }
    catStmt.free();

    // 2. Map old category IDs to new ones and reassign products
    const mapping: Record<string, string> = {
      'cat-jewelry': 'cat-gold-diamond-jewellery',
      'cat-bags': 'cat-accessories',
      'cat-shoes': 'cat-accessories',
      'cat-eyewear': 'cat-accessories',
      'cat-services': 'cat-accessories',
      'cat-diamonds': 'cat-loose-gems',
    };

    for (const [oldId, newId] of Object.entries(mapping)) {
      try {
        database.run(
          `UPDATE products SET category_id = ? WHERE category_id = ?`,
          [newId, oldId]
        );
      } catch { /* products table may not exist yet */ }
    }

    // 3. Delete old categories (the ones we just re-mapped away from)
    const oldIds = Object.keys(mapping);
    for (const oldId of oldIds) {
      try {
        database.run(`DELETE FROM categories WHERE id = ?`, [oldId]);
      } catch { /* ignore */ }
    }

    // 4. Also rename any user-facing legacy name mismatch
    // (e.g. if a user had "Jewelry" with a custom id, leave it alone — only touches default IDs)

    // 5. Mark migration done
    database.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES (?, 'categories.migrated_to_v2', '1', 'migration', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [branchId, now]
    );
  } catch (err) {
    console.warn('[Migration] Category v2 migration failed:', err);
  }
}

// Plan §Product §3: 6 Plan-Kategorien (WATCH, GOLD_JEWELRY, BRANDED_GOLD_JEWELRY,
// ORIGINAL_GOLD_JEWELRY, ACCESSORY, SPARE_PART) mit Feldern aus §4.
function migrateCategoriesToV3(database: Database): void {
  try {
    const existing = database.exec(
      "SELECT value FROM settings WHERE key = 'categories.migrated_to_v3'"
    );
    const done = existing.length > 0 && existing[0].values.length > 0 && existing[0].values[0][0] === '1';
    if (done) return;

    const now = new Date().toISOString();
    let branchId = 'branch-main';
    try {
      const r = database.exec("SELECT id FROM branches LIMIT 1");
      if (r.length > 0 && r[0].values.length > 0) branchId = r[0].values[0][0] as string;
    } catch { /* */ }

    // 1. Insert the 6 Plan categories
    const catStmt = database.prepare(
      `INSERT OR IGNORE INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const cat of DEFAULT_CATEGORIES) {
      catStmt.run([
        cat.id, branchId, cat.name, cat.icon, cat.color,
        JSON.stringify(cat.attributes), JSON.stringify(cat.scopeOptions),
        JSON.stringify(cat.conditionOptions), cat.active ? 1 : 0, cat.sortOrder, now, now,
      ]);
    }
    catStmt.free();

    // 2. Upgrade existing Plan categories if already present (force attributes to new spec)
    for (const cat of DEFAULT_CATEGORIES) {
      try {
        database.run(
          `UPDATE categories SET attributes = ?, scope_options = ?, condition_options = ?, name = ?, icon = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
          [
            JSON.stringify(cat.attributes), JSON.stringify(cat.scopeOptions),
            JSON.stringify(cat.conditionOptions), cat.name, cat.icon, cat.color, cat.sortOrder, now, cat.id,
          ]
        );
      } catch { /* */ }
    }

    // 3. Map legacy v2 category IDs → new v3 (Plan) category IDs
    const mapping: Record<string, string> = {
      'cat-watches': 'cat-watch',
      'cat-gold-diamond-jewellery': 'cat-branded-gold-jewelry',
      'cat-original-jewellery': 'cat-original-gold-jewelry',
      'cat-customize-jewellery': 'cat-gold-jewelry',
      'cat-accessories': 'cat-accessory',
      'cat-parts': 'cat-spare-part',
      'cat-loose-gems': 'cat-gold-jewelry',  // kein direktes Plan-Pendant, Default nach GOLD_JEWELRY
    };
    for (const [oldId, newId] of Object.entries(mapping)) {
      try {
        database.run(`UPDATE products SET category_id = ? WHERE category_id = ?`, [newId, oldId]);
      } catch { /* */ }
    }

    // 4. Delete old v2 categories
    for (const oldId of Object.keys(mapping)) {
      try {
        database.run(`DELETE FROM categories WHERE id = ?`, [oldId]);
      } catch { /* */ }
    }

    // 5. Mark done
    database.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES (?, 'categories.migrated_to_v3', '1', 'migration', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [branchId, now]
    );
  } catch (err) {
    console.warn('[Migration] Category v3 migration failed:', err);
  }
}

export async function initDatabase(): Promise<Database> {
  if (db) return db;

  const SQL = await initSqlJs({ locateFile: () => wasmUrl });

  const saved = await loadSavedDb();
  if (saved) {
    try {
      db = new SQL.Database(saved);
      db.run(SCHEMA);
      runMigrations(db);
      migrateCategoriesToV2(db);
      migrateCategoriesToV3(db);
    } catch (err) {
      console.warn('DB load failed, creating fresh:', err);
      db = new SQL.Database();
      db.run(SCHEMA);
      runMigrations(db);
      await seedFreshDatabase(db);
      migrateCategoriesToV2(db);
      migrateCategoriesToV3(db);
    }
  } else {
    db = new SQL.Database();
    db.run(SCHEMA);
    runMigrations(db);
    // Tauri: clean start. Browser: demo data for development.
    if (isTauri()) {
      await seedCleanDatabase(db);
    } else {
      await seedFreshDatabase(db);
    }
    migrateCategoriesToV2(db);
  }

  return db;
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'lataif_salt_2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Clean start (Tauri) — only owner account, settings, categories ──
async function seedCleanDatabase(database: Database): Promise<void> {
  const now = new Date().toISOString();

  database.run(
    `INSERT INTO tenants (id, name, slug, plan, active, max_branches, max_users, created_at, updated_at)
     VALUES ('tenant-1', 'My Business', 'mybiz', 'enterprise', 1, 10, 50, ?, ?)`,
    [now, now]
  );

  database.run(
    `INSERT INTO branches (id, tenant_id, name, country, currency, address, created_at, updated_at)
     VALUES ('branch-main', 'tenant-1', 'Main Branch', 'BH', 'BHD', '', ?, ?)`,
    [now, now]
  );

  const hash = await hashPassword('admin');
  database.run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
     VALUES ('user-owner', 'tenant-1', 'admin@lataif.com', ?, 'Admin', 1, ?, ?)`,
    [hash, now, now]
  );
  database.run(
    `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
     VALUES ('user-owner', 'branch-main', 'ADMIN', 1, ?)`, [now]
  );

  const settings = [
    ['vat.standard_rate', '10', 'tax'],
    ['vat.margin_rate', '10', 'tax'],
    ['tax.default_scheme', 'MARGIN', 'tax'],
    ['currency.default', 'BHD', 'general'],
    ['offer.number_prefix', 'OFF', 'numbering'],
    ['invoice.number_prefix', 'INV', 'numbering'],
    ['company.name', '', 'company'],
  ];
  const settingsStmt = database.prepare(
    `INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES ('branch-main', ?, ?, ?, ?)`
  );
  for (const [key, value, cat] of settings) {
    settingsStmt.run([key, value, cat, now]);
  }
  settingsStmt.free();

  const catStmt = database.prepare(
    `INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at)
     VALUES (?, 'branch-main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const cat of DEFAULT_CATEGORIES) {
    catStmt.run([
      cat.id, cat.name, cat.icon, cat.color,
      JSON.stringify(cat.attributes), JSON.stringify(cat.scopeOptions),
      JSON.stringify(cat.conditionOptions), cat.active ? 1 : 0, cat.sortOrder, now, now,
    ]);
  }
  catStmt.free();

  saveDatabase();
}

// ── Full seed with demo data (Browser) ──
async function seedFreshDatabase(database: Database): Promise<void> {
  const now = new Date().toISOString();

  // ── Create default tenant ──
  database.run(
    `INSERT INTO tenants (id, name, slug, plan, active, max_branches, max_users, created_at, updated_at)
     VALUES ('tenant-1', 'LATAIF Trading', 'lataif', 'enterprise', 1, 10, 50, ?, ?)`,
    [now, now]
  );

  // ── Create branches ──
  database.run(
    `INSERT INTO branches (id, tenant_id, name, country, currency, address, created_at, updated_at)
     VALUES ('branch-main', 'tenant-1', 'Manama HQ', 'BH', 'BHD', 'Manama, Bahrain', ?, ?)`,
    [now, now]
  );
  database.run(
    `INSERT INTO branches (id, tenant_id, name, country, currency, address, created_at, updated_at)
     VALUES ('branch-dubai', 'tenant-1', 'Dubai Showroom', 'AE', 'AED', 'Dubai Mall, Dubai', ?, ?)`,
    [now, now]
  );

  // ── Create users ──
  const hash = await hashPassword('admin');
  const salesHash = await hashPassword('sales');

  // Owner: Ali Mansoor (ali@lataif.com / admin)
  database.run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
     VALUES ('user-owner', 'tenant-1', 'ali@lataif.com', ?, 'Ali Mansoor', 1, ?, ?)`,
    [hash, now, now]
  );
  database.run(
    `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
     VALUES ('user-owner', 'branch-main', 'ADMIN', 1, ?)`, [now]
  );
  database.run(
    `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
     VALUES ('user-owner', 'branch-dubai', 'ADMIN', 0, ?)`, [now]
  );

  // Sales 1: Youssef (youssef@lataif.com / sales)
  database.run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
     VALUES ('user-sales-1', 'tenant-1', 'youssef@lataif.com', ?, 'Youssef Al-Rashid', 1, ?, ?)`,
    [salesHash, now, now]
  );
  database.run(
    `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
     VALUES ('user-sales-1', 'branch-main', 'SALES', 1, ?)`, [now]
  );

  // Sales 2: Layla (layla@lataif.com / sales)
  database.run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
     VALUES ('user-sales-2', 'tenant-1', 'layla@lataif.com', ?, 'Layla Hassan', 1, ?, ?)`,
    [salesHash, now, now]
  );
  database.run(
    `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
     VALUES ('user-sales-2', 'branch-main', 'SALES', 1, ?)`, [now]
  );

  // Manager: Omar (omar@lataif.com / admin)
  database.run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
     VALUES ('user-manager', 'tenant-1', 'omar@lataif.com', ?, 'Omar Khalil', 1, ?, ?)`,
    [hash, now, now]
  );
  database.run(
    `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
     VALUES ('user-manager', 'branch-main', 'manager', 1, ?)`, [now]
  );
  database.run(
    `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
     VALUES ('user-manager', 'branch-dubai', 'manager', 0, ?)`, [now]
  );

  // ── Default settings ──
  const settings = [
    ['vat.standard_rate', '10', 'tax'],
    ['vat.margin_rate', '10', 'tax'],
    ['tax.default_scheme', 'MARGIN', 'tax'],
    ['currency.default', 'BHD', 'general'],
    ['offer.number_prefix', 'OFF', 'numbering'],
    ['invoice.number_prefix', 'INV', 'numbering'],
    ['company.name', 'LATAIF', 'company'],
  ];
  const settingsStmt = database.prepare(
    `INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES ('branch-main', ?, ?, ?, ?)`
  );
  for (const [key, value, cat] of settings) {
    settingsStmt.run([key, value, cat, now]);
  }
  settingsStmt.free();

  // ── Default categories ──
  const catStmt = database.prepare(
    `INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at)
     VALUES (?, 'branch-main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const cat of DEFAULT_CATEGORIES) {
    catStmt.run([
      cat.id, cat.name, cat.icon, cat.color,
      JSON.stringify(cat.attributes), JSON.stringify(cat.scopeOptions),
      JSON.stringify(cat.conditionOptions), cat.active ? 1 : 0, cat.sortOrder, now, now,
    ]);
  }
  catStmt.free();

  // ── Demo products ──
  const products = [
    { id: 'p-1', catId: 'cat-watches', brand: 'Rolex', name: 'Submariner Date', sku: '126610LN', condition: 'Pre-Owned', pp: 38200, sp: 45500, tax: 'MARGIN', scope: ['Box','Papers','Warranty Card'], loc: 'Main Safe, Shelf B3', supplier: 'Swiss Watch Trading LLC', attrs: { reference_no:'126610LN', serial_no:'9K2X7842', dial:'Black', case_material:'Oystersteel', case_size:41, movement:'Cal. 3235', year:2023 }},
    { id: 'p-2', catId: 'cat-watches', brand: 'Patek Philippe', name: 'Nautilus', sku: '5711/1A', condition: 'Pre-Owned', pp: 243000, sp: 285000, tax: 'MARGIN', scope: ['Box','Papers'], attrs: { reference_no:'5711/1A-010', dial:'Blue', case_material:'Stainless Steel', case_size:40, movement:'Cal. 26-330 S C', year:2021 }},
    { id: 'p-3', catId: 'cat-watches', brand: 'Audemars Piguet', name: 'Royal Oak', sku: '15500ST', condition: 'Unworn', pp: 55000, sp: 68000, tax: 'MARGIN', scope: ['Box','Papers','Warranty Card'], attrs: { reference_no:'15500ST.OO.1220ST.01', dial:'Blue', case_material:'Stainless Steel', case_size:41, year:2022 }},
    { id: 'p-4', catId: 'cat-watches', brand: 'Richard Mille', name: 'RM 011', sku: 'RM011', condition: 'Pre-Owned', pp: 185000, sp: 220000, tax: 'MARGIN', scope: ['Box','Papers'], attrs: { reference_no:'RM 011', dial:'Skeleton', case_material:'Titanium', case_size:50, year:2020 }},
    { id: 'p-5', catId: 'cat-jewelry', brand: 'Cartier', name: 'Love Bracelet', condition: 'New', pp: 6200, sp: 8500, tax: 'VAT_10', scope: ['Box','Certificate'], attrs: { type:'Bracelet', metal:'18K Yellow Gold' }},
    { id: 'p-6', catId: 'cat-jewelry', brand: 'Van Cleef & Arpels', name: 'Alhambra Necklace', condition: 'New', pp: 12800, sp: 16500, tax: 'VAT_10', scope: ['Box','Certificate'], attrs: { type:'Necklace', metal:'18K Rose Gold', main_stone:'Mother of Pearl' }},
    { id: 'p-7', catId: 'cat-bags', brand: 'Hermes', name: 'Birkin 30', condition: 'Excellent', pp: 42000, sp: 55000, tax: 'MARGIN', scope: ['Box','Dust Bag','Lock & Key','Clochette'], attrs: { material:'Togo Leather', color:'Gold', size:'30cm', hardware:'Gold' }},
    { id: 'p-8', catId: 'cat-bags', brand: 'Hermes', name: 'Kelly 28', condition: 'Very Good', pp: 32000, sp: 42000, tax: 'MARGIN', scope: ['Box','Dust Bag','Strap'], attrs: { material:'Epsom Leather', color:'Black', size:'28cm', hardware:'Palladium' }},
    { id: 'p-9', catId: 'cat-bags', brand: 'Chanel', name: 'Classic Flap Medium', condition: 'Excellent', pp: 8500, sp: 11200, tax: 'MARGIN', scope: ['Box','Dust Bag','Care Card'], attrs: { material:'Caviar', color:'Black', size:'Medium', hardware:'Gold' }},
    { id: 'p-10', catId: 'cat-eyewear', brand: 'Chrome Hearts', name: 'Bone Prone I', condition: 'New', pp: 2800, sp: 4200, tax: 'VAT_10', scope: ['Case','Box','Cloth'], attrs: { type:'Sunglasses', frame_material:'Titanium & Silver', frame_color:'Matte Black' }},
    { id: 'p-11', catId: 'cat-shoes', brand: 'Louis Vuitton', name: 'LV Trainer', condition: 'New', pp: 1200, sp: 1800, tax: 'VAT_10', scope: ['Box','Dust Bags'], attrs: { size_eu:43, material:'Calf Leather', color:'White/Green', style:'Sneakers' }},
  ];

  const pStmt = database.prepare(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
      storage_location, purchase_date, purchase_price, purchase_currency, planned_sale_price,
      min_sale_price, max_sale_price,
      stock_status, tax_scheme, expected_margin, days_in_stock, supplier_name, images, attributes, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BHD', ?, ?, ?, 'in_stock', ?, ?, 0, ?, '[]', ?, ?, ?, 'user-owner')`
  );
  for (const p of products) {
    // Auto-generate sales range: min = 90% of sale price, max = 110%
    const minSp = p.sp ? Math.round(p.sp * 0.9) : null;
    const maxSp = p.sp ? Math.round(p.sp * 1.1) : null;
    pStmt.run([
      p.id, p.catId, p.brand, p.name, p.sku || null, p.condition,
      JSON.stringify(p.scope || []), p.loc || null, now.split('T')[0],
      p.pp, p.sp, minSp, maxSp, p.tax, p.sp - p.pp, p.supplier || null,
      JSON.stringify(p.attrs || {}), now, now,
    ]);
  }
  pStmt.free();

  // ── Demo customers ──
  const customers = [
    { id:'c-1', fn:'Ahmed', ln:'Al-Khalifa', co:'Al-Khalifa Holdings', ph:'+973 3912 4455', wa:'+973 3912 4455', vip:2, prefs:['Rolex','Patek Philippe','Audemars Piguet'], bmin:30000, bmax:350000, stage:'active', rev:842000, profit:186400, cnt:12 },
    { id:'c-2', fn:'Fatima', ln:'Hassan', ph:'+973 3855 2200', vip:1, prefs:['Rolex','Cartier','Chanel'], bmin:10000, bmax:80000, stage:'active', rev:245000, profit:48200, cnt:6 },
    { id:'c-3', fn:'Mohammed', ln:'Al-Habsi', co:'Gulf Luxury Group', ph:'+973 3401 8800', vip:3, prefs:['Patek Philippe','Richard Mille','Hermes'], bmin:100000, bmax:1000000, stage:'active', rev:1520000, profit:340000, cnt:18 },
    { id:'c-4', fn:'Sara', ln:'Al-Dosari', ph:'+973 3600 1122', vip:1, prefs:['Chanel','Hermes','Cartier','Van Cleef & Arpels'], bmin:5000, bmax:60000, stage:'qualified', rev:78000, profit:18500, cnt:4 },
    { id:'c-5', fn:'Khalid', ln:'Bin Rashid', co:'Rashid Investments', ph:'+973 3777 9900', vip:2, prefs:['Audemars Piguet','Rolex','Richard Mille'], bmin:40000, bmax:200000, stage:'lead', rev:0, profit:0, cnt:0 },
    { id:'c-6', fn:'Noura', ln:'Al-Mannai', ph:'+973 3200 5500', vip:1, prefs:['Hermes','Louis Vuitton','Chanel'], bmin:8000, bmax:70000, stage:'active', rev:134000, profit:32000, cnt:8 },
  ];

  const cStmt = database.prepare(
    `INSERT INTO customers (id, branch_id, first_name, last_name, company, phone, whatsapp, country, language,
      budget_min, budget_max, vip_level, preferences, customer_type, sales_stage, total_revenue, total_profit, purchase_count, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', ?, ?, ?, ?, ?, 'BH', 'en', ?, ?, ?, ?, 'collector', ?, ?, ?, ?, ?, ?, 'user-owner')`
  );
  for (const c of customers) {
    cStmt.run([
      c.id, c.fn, c.ln, c.co || null, c.ph, c.wa || null,
      c.bmin, c.bmax, c.vip, JSON.stringify(c.prefs), c.stage,
      c.rev, c.profit, c.cnt, now, now,
    ]);
  }
  cStmt.free();

  // ── Demo offers ──
  // OFF-2026-00001: c-1, p-1 (Rolex Submariner 45500, margin) + p-5 (Cartier Love 8500, standard)
  const off1Id = uuid();
  // Margin: VAT = margin * rate/(100+rate) — tax-inclusive
  const off1Line1Margin = 45500 - 38200; // 7300
  const off1Line1Vat = Math.round(off1Line1Margin * 10 / 110 * 1000) / 1000; // 663.636
  // Standard: VAT = price * rate/100 — tax-exclusive (added on top)
  const off1Line2Vat = Math.round(8500 * 0.10 * 1000) / 1000; // 850
  const off1Subtotal = 45500 + 8500; // 54000
  const off1VatAmount = off1Line1Vat + off1Line2Vat;
  // Margin line: gross = sale price (no VAT on top). Standard line: gross = sale + VAT
  const off1Total = 45500 + (8500 + off1Line2Vat); // margin stays at price, standard gets VAT added
  database.run(
    `INSERT INTO offers (id, branch_id, offer_number, customer_id, status, valid_until, currency, subtotal, vat_rate, vat_amount, total, tax_scheme, sent_at, follow_up_at, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', 'OFF-2026-00001', 'c-1', 'sent', ?, 'BHD', ?, 10, ?, ?, 'mixed', ?, ?, ?, ?, 'user-owner')`,
    [off1Id, new Date(Date.now() + 14 * 86400000).toISOString(), off1Subtotal, off1VatAmount, off1Total, now, new Date(Date.now() + 3 * 86400000).toISOString(), now, now]
  );
  database.run(
    `INSERT INTO offer_lines (id, offer_id, product_id, unit_price, vat_rate, tax_scheme, line_total, position)
     VALUES (?, ?, 'p-1', 45500, 10, 'MARGIN', 45500, 1)`,
    [uuid(), off1Id]
  );
  database.run(
    `INSERT INTO offer_lines (id, offer_id, product_id, unit_price, vat_rate, tax_scheme, line_total, position)
     VALUES (?, ?, 'p-5', 8500, 10, 'VAT_10', ?, 2)`,
    [uuid(), off1Id, 8500 + off1Line2Vat]
  );

  // OFF-2026-00002: c-3, p-2 (Patek Nautilus 285000, margin)
  const off2Id = uuid();
  const off2Margin = 285000 - 243000; // 42000
  const off2Vat = Math.round(off2Margin * 10 / 110 * 1000) / 1000; // 3818.182
  const off2Subtotal = 285000;
  const off2Total = 285000; // margin: gross = sale price (VAT included)
  database.run(
    `INSERT INTO offers (id, branch_id, offer_number, customer_id, status, valid_until, currency, subtotal, vat_rate, vat_amount, total, tax_scheme, sent_at, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', 'OFF-2026-00002', 'c-3', 'accepted', ?, 'BHD', ?, 10, ?, ?, 'MARGIN', ?, ?, ?, 'user-owner')`,
    [off2Id, new Date(Date.now() + 14 * 86400000).toISOString(), off2Subtotal, off2Vat, off2Total, now, now, now]
  );
  database.run(
    `INSERT INTO offer_lines (id, offer_id, product_id, unit_price, vat_rate, tax_scheme, line_total, position)
     VALUES (?, ?, 'p-2', 285000, 10, 'MARGIN', 285000, 1)`,
    [uuid(), off2Id]
  );

  // ── Demo invoice ──
  // INV-2026-00001: from OFF-2026-00002, c-3, p-2 (margin scheme)
  const inv1Id = uuid();
  const inv1Net = 285000;
  const inv1Vat = off2Vat; // 3818.182
  const inv1Gross = 285000; // margin: gross = sale price
  const inv1Margin = 285000 - 243000; // 42000
  database.run(
    `INSERT INTO invoices (id, branch_id, invoice_number, offer_id, customer_id, status, currency, net_amount, vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, purchase_price_snapshot, sale_price_snapshot, margin_snapshot, paid_amount, issued_at, due_at, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', 'INV-2026-00001', ?, 'c-3', 'issued', 'BHD', ?, 10, ?, ?, 'MARGIN', 243000, 285000, ?, 0, ?, ?, ?, ?, 'user-owner')`,
    [inv1Id, off2Id, inv1Net, inv1Vat, inv1Gross, inv1Margin, now, new Date(Date.now() + 30 * 86400000).toISOString(), now, now]
  );
  database.run(
    `INSERT INTO invoice_lines (id, invoice_id, product_id, description, unit_price, purchase_price_snapshot, vat_rate, tax_scheme, vat_amount, line_total, position)
     VALUES (?, ?, 'p-2', 'Patek Philippe Nautilus 5711/1A', 285000, 243000, 10, 'MARGIN', ?, 285000, 1)`,
    [uuid(), inv1Id, inv1Vat]
  );

  // ── Demo repairs ──
  // REP-2026-00001: c-2, external item (Rolex Datejust), in_progress
  database.run(
    `INSERT INTO repairs (id, branch_id, repair_number, customer_id, item_brand, item_model, issue_description, repair_type, status, received_at, diagnosed_at, started_at, voucher_code, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', 'REP-2026-00001', 'c-2', 'Rolex', 'Datejust', 'Crown not screwing down properly', 'internal', 'in_progress', ?, ?, ?, 'REP8A3F2', ?, ?, 'user-owner')`,
    [uuid(), now, now, now, now, now]
  );

  // REP-2026-00002: c-6, product p-9 (Chanel Classic Flap), received
  database.run(
    `INSERT INTO repairs (id, branch_id, repair_number, customer_id, product_id, item_brand, item_model, issue_description, repair_type, status, received_at, voucher_code, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', 'REP-2026-00002', 'c-6', 'p-9', 'Chanel', 'Classic Flap Medium', 'Broken chain link', 'external', 'received', ?, 'REPB7C41', ?, ?, 'user-owner')`,
    [uuid(), now, now, now]
  );

  // ── Demo order ──
  // ORD-2026-00001: c-5, Patek Aquanaut, pending (deposit erhalten = payment partial, order pending)
  database.run(
    `INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model, agreed_price, deposit_amount, deposit_paid, deposit_date, remaining_amount, status, created_at, updated_at, created_by)
     VALUES (?, 'branch-main', 'ORD-2026-00001', 'c-5', 'Patek Philippe', 'Aquanaut', 95000, 20000, 1, ?, 75000, 'pending', ?, ?, 'user-owner')`,
    [uuid(), now, now, now]
  );

  // ── Demo tasks ──
  // Task 1: Follow up on sent offer OFF-2026-00001
  database.run(
    `INSERT INTO tasks (id, branch_id, title, description, type, priority, due_at, linked_entity_type, linked_entity_id, assigned_to, status, auto_generated, created_at, created_by)
     VALUES (?, 'branch-main', 'Follow up on sent offer', 'Follow up with Ahmed Al-Khalifa on offer OFF-2026-00001', 'follow_up', 'medium', ?, 'offer', ?, 'user-owner', 'open', 0, ?, 'user-owner')`,
    [uuid(), new Date(Date.now() + 3 * 86400000).toISOString(), off1Id, now]
  );

  // Task 2: Create invoice for accepted offer OFF-2026-00002
  database.run(
    `INSERT INTO tasks (id, branch_id, title, description, type, priority, due_at, linked_entity_type, linked_entity_id, assigned_to, status, auto_generated, created_at, created_by)
     VALUES (?, 'branch-main', 'Create invoice for accepted offer', 'Offer OFF-2026-00002 from Mohammed Al-Habsi has been accepted. Create invoice.', 'general', 'high', ?, 'offer', ?, 'user-owner', 'open', 0, ?, 'user-owner')`,
    [uuid(), new Date(Date.now() + 1 * 86400000).toISOString(), off2Id, now]
  );

  // Task 3: Diagnose repair REP-2026-00002
  const rep2Id = database.exec(`SELECT id FROM repairs WHERE repair_number = 'REP-2026-00002'`);
  const rep2IdVal = rep2Id[0]?.values[0]?.[0] as string;
  database.run(
    `INSERT INTO tasks (id, branch_id, title, description, type, priority, due_at, linked_entity_type, linked_entity_id, assigned_to, status, auto_generated, created_at, created_by)
     VALUES (?, 'branch-main', 'Diagnose repair', 'Diagnose broken chain link on Chanel Classic Flap for Noura Al-Mannai (REP-2026-00002)', 'review', 'medium', ?, 'repair', ?, 'user-owner', 'open', 0, ?, 'user-owner')`,
    [uuid(), new Date(Date.now() + 2 * 86400000).toISOString(), rep2IdVal, now]
  );

  saveDatabase();
}

export async function saveDatabase(): Promise<void> {
  if (!db) return;
  const data = db.export();
  await persistDb(data);
}

export function getDatabase(): Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Diagnostic: re-read the DB file from disk into memory. Returns false if file absent.
export async function reloadDbFromDisk(): Promise<boolean> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const saved = await loadSavedDb();
  if (!saved) return false;
  if (db) { db.close(); db = null; }
  db = new SQL.Database(saved);
  db.run(SCHEMA);
  runMigrations(db);
  return true;
}

export async function resetDatabase(): Promise<void> {
  if (isTauri()) {
    try {
      const fs = await getTauriFs();
      const path = await getDbFilePath();
      await fs.remove(path).catch(() => {});
    } catch { /* */ }
  }
  localStorage.removeItem(STORAGE_KEY);
  if (db) { db.close(); db = null; }
}
