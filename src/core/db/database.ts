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
  localStorage.setItem(STORAGE_KEY, encodeForLocalStorage(data));
}

function encodeForLocalStorage(data: Uint8Array): string {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Synchroner Browser-Save fuer beforeunload — async-Pfade laufen waehrend
// Window-Close nicht zuverlaessig durch, localStorage.setItem dagegen blockiert
// die Main-Thread und ist garantiert persistiert bevor der Tab zumacht.
function persistDbSync(data: Uint8Array): void {
  if (isTauri()) return; // Tauri kann hier nichts synchron tun
  try {
    localStorage.setItem(STORAGE_KEY, encodeForLocalStorage(data));
  } catch (err) {
    console.error('[DB] sync persist failed:', err);
  }
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
    // Plan §Agent §Convert: Verlinkung Agent → Customer für Convert-to-Invoice.
    // Optional. Wird beim ersten Convert befüllt und danach wiederverwendet.
    `ALTER TABLE agents ADD COLUMN customer_id TEXT REFERENCES customers(id)`,
    // Plan §Purchase §Tax: Input-VAT per Purchase-Line, damit sie gegen
    // Output-VAT in der Steuer-Abrechnung verrechnet werden kann.
    // Default tax_scheme=NULL ⇒ kein VAT (Backward-Compat für Altbestände).
    `ALTER TABLE purchase_lines ADD COLUMN tax_scheme TEXT`,
    `ALTER TABLE purchase_lines ADD COLUMN vat_rate REAL DEFAULT 0`,
    `ALTER TABLE purchase_lines ADD COLUMN vat_amount REAL DEFAULT 0`,
    // Plan §Repair §Item-Details: kategorie-basierte Item-Erfassung. Felder
    // ergänzen statt ersetzen, damit Legacy-Repairs ohne Kategorie weiter funktionieren.
    `ALTER TABLE repairs ADD COLUMN item_category_id TEXT`,
    `ALTER TABLE repairs ADD COLUMN item_attributes TEXT DEFAULT '{}'`,
    `ALTER TABLE repairs ADD COLUMN tax_scheme TEXT DEFAULT 'VAT_10'`,
    // Optionale Tax-Felder auf Order-Ebene (für die Pricing-Section)
    `ALTER TABLE orders ADD COLUMN tax_amount REAL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN payment_method TEXT`,
    `ALTER TABLE orders ADD COLUMN fully_paid INTEGER DEFAULT 0`,
    // GOLD_JEWELRY — 2026-05-17: umbenannt "Gold-Diamond Jewellery"; karat + color_type
    // kombiniert; +Bar/Coin (item_type), +Silver (karat); Diamond Weight neben Weight.
    `UPDATE categories SET name = 'Gold-Diamond Jewellery', condition_options = '["Pre-Owned","Vintage"]', attributes = '[
      {"key":"weight","label":"Weight","type":"number","unit":"g","required":true,"showInList":true},
      {"key":"diamond_weight","label":"Diamond Weight","type":"number","unit":"ct","required":false,"showInList":true},
      {"key":"item_type","label":"Item Type","type":"select","options":["Ring","Bangle","Bracelet","Necklace","Pendant","Earrings","Brooch","Bar","Coin"],"required":true,"showInList":true},
      {"key":"karat","label":"Karat & Color","type":"select","options":["24K Yellow","22K Yellow","21K Yellow","18K Yellow","18K Rose","18K White","18K Mix","14K Yellow","14K Rose","14K White","14K Mix","Silver"],"required":true,"showInList":true},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-gold-jewelry'`,
    // 2026-05-17: 9K auch aus Gold-Diamond Jewellery entfernt — bestehende 9K-Produkte
    // auf 14K (gleiche Farbe) hochmigrieren.
    `UPDATE products SET attributes = json_set(attributes, '$.karat',
      REPLACE(json_extract(attributes, '$.karat'), '9K ', '14K ')
    )
    WHERE category_id = 'cat-gold-jewelry'
      AND json_extract(attributes, '$.karat') LIKE '9K %'`,
    // Bestehende Produkte mit condition="New" auf "Pre-Owned" umstellen.
    `UPDATE products SET condition = 'Pre-Owned' WHERE category_id = 'cat-gold-jewelry' AND condition = 'New'`,
    // Backfill: bestehende Produkte — alten karat (z.B. "18K") + color_type
    // (z.B. "Yellow Gold") zu einem Wert kombinieren ("18K Yellow"). Idempotent —
    // wirkt nur wenn karat noch im alten Format ohne Color-Suffix ist.
    `UPDATE products SET attributes = json_set(
      attributes,
      '$.karat',
      json_extract(attributes, '$.karat') || ' ' ||
        CASE json_extract(attributes, '$.color_type')
          WHEN 'Yellow Gold' THEN 'Yellow'
          WHEN 'Rose Gold'   THEN 'Rose'
          WHEN 'White Gold'  THEN 'White'
          WHEN 'Two-Tone'    THEN 'Mix'
          ELSE 'Yellow'
        END
    )
    WHERE category_id = 'cat-gold-jewelry'
      AND json_extract(attributes, '$.karat') IN ('24K','22K','21K','18K','14K','9K')`,
    // Pure-Gold-Sonderfall: 24K/22K/21K nur Yellow erlaubt — wenn der alte color_type
    // was anderes war (Rose/White/Mix), auf Yellow korrigieren.
    `UPDATE products SET attributes = json_set(attributes, '$.karat', '24K Yellow')
      WHERE category_id = 'cat-gold-jewelry'
        AND json_extract(attributes, '$.karat') LIKE '24K %'
        AND json_extract(attributes, '$.karat') != '24K Yellow'`,
    `UPDATE products SET attributes = json_set(attributes, '$.karat', '22K Yellow')
      WHERE category_id = 'cat-gold-jewelry'
        AND json_extract(attributes, '$.karat') LIKE '22K %'
        AND json_extract(attributes, '$.karat') != '22K Yellow'`,
    `UPDATE products SET attributes = json_set(attributes, '$.karat', '21K Yellow')
      WHERE category_id = 'cat-gold-jewelry'
        AND json_extract(attributes, '$.karat') LIKE '21K %'
        AND json_extract(attributes, '$.karat') != '21K Yellow'`,
    // color_type-Schlüssel entfernen — Info ist jetzt in karat.
    `UPDATE products SET attributes = json_remove(attributes, '$.color_type')
      WHERE category_id = 'cat-gold-jewelry'
        AND json_extract(attributes, '$.color_type') IS NOT NULL`,
    // BRANDED_GOLD_JEWELRY — 2026-05-17: karat + color_type kombiniert.
    `UPDATE categories SET attributes = '[
      {"key":"item_type","label":"Item Type","type":"select","options":["Ring","Bangle","Bracelet","Necklace","Pendant","Earrings","Brooch"],"required":true,"showInList":true},
      {"key":"size","label":"Size","type":"text","required":true,"showInList":true},
      {"key":"karat","label":"Karat & Color","type":"select","options":["24K Yellow","22K Yellow","21K Yellow","18K Yellow","18K Rose","18K White","18K Mix","14K Yellow","14K Rose","14K White","14K Mix","Silver"],"required":true,"showInList":true},
      {"key":"weight","label":"Weight","type":"number","unit":"g","required":false,"showInList":true},
      {"key":"diamond_weight","label":"Diamond Weight","type":"number","unit":"ct","required":false,"showInList":true},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-branded-gold-jewelry'`,
    // ORIGINAL_GOLD_JEWELRY — 2026-05-17: karat + color_type kombiniert.
    `UPDATE categories SET attributes = '[
      {"key":"item_type","label":"Item Type","type":"select","options":["Ring","Bangle","Bracelet","Necklace","Pendant","Earrings","Brooch"],"required":true,"showInList":true},
      {"key":"size","label":"Size","type":"text","required":false,"showInList":true},
      {"key":"karat","label":"Karat & Color","type":"select","options":["24K Yellow","22K Yellow","21K Yellow","18K Yellow","18K Rose","18K White","18K Mix","14K Yellow","14K Rose","14K White","14K Mix","Silver"],"required":true,"showInList":true},
      {"key":"weight","label":"Weight","type":"number","unit":"g","required":false,"showInList":true},
      {"key":"diamond_weight","label":"Diamond Weight","type":"number","unit":"ct","required":false,"showInList":true},
      {"key":"model_number","label":"Model Number","type":"text","required":false,"showInList":false},
      {"key":"serial_number","label":"Serial Number","type":"text","required":false,"showInList":false},
      {"key":"year","label":"Year","type":"number","required":false,"showInList":false},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false}
    ]' WHERE id = 'cat-original-gold-jewelry'`,
    // 2026-05-17: 9K aus Branded + Original entfernt — bestehende 9K-Produkte
    // auf 14K (gleiche Farbe) hochmigrieren, damit der Wert wieder in den Optionen liegt.
    `UPDATE products SET attributes = json_set(attributes, '$.karat',
      REPLACE(json_extract(attributes, '$.karat'), '9K ', '14K ')
    )
    WHERE category_id IN ('cat-branded-gold-jewelry', 'cat-original-gold-jewelry')
      AND json_extract(attributes, '$.karat') LIKE '9K %'`,
    // Backfill für beide Kategorien: alten karat + color_type kombinieren.
    `UPDATE products SET attributes = json_set(
      attributes,
      '$.karat',
      json_extract(attributes, '$.karat') || ' ' ||
        CASE json_extract(attributes, '$.color_type')
          WHEN 'Yellow Gold' THEN 'Yellow'
          WHEN 'Rose Gold'   THEN 'Rose'
          WHEN 'White Gold'  THEN 'White'
          WHEN 'Two-Tone'    THEN 'Mix'
          ELSE 'Yellow'
        END
    )
    WHERE category_id IN ('cat-branded-gold-jewelry', 'cat-original-gold-jewelry')
      AND json_extract(attributes, '$.karat') IN ('24K','22K','21K','18K','14K','9K')`,
    // Pure-Gold-Sonderfall: 24K/22K/21K → erzwungen Yellow.
    `UPDATE products SET attributes = json_set(attributes, '$.karat', '24K Yellow')
      WHERE category_id IN ('cat-branded-gold-jewelry', 'cat-original-gold-jewelry')
        AND json_extract(attributes, '$.karat') LIKE '24K %'
        AND json_extract(attributes, '$.karat') != '24K Yellow'`,
    `UPDATE products SET attributes = json_set(attributes, '$.karat', '22K Yellow')
      WHERE category_id IN ('cat-branded-gold-jewelry', 'cat-original-gold-jewelry')
        AND json_extract(attributes, '$.karat') LIKE '22K %'
        AND json_extract(attributes, '$.karat') != '22K Yellow'`,
    `UPDATE products SET attributes = json_set(attributes, '$.karat', '21K Yellow')
      WHERE category_id IN ('cat-branded-gold-jewelry', 'cat-original-gold-jewelry')
        AND json_extract(attributes, '$.karat') LIKE '21K %'
        AND json_extract(attributes, '$.karat') != '21K Yellow'`,
    // color_type entfernen — Info ist jetzt in karat.
    `UPDATE products SET attributes = json_remove(attributes, '$.color_type')
      WHERE category_id IN ('cat-branded-gold-jewelry', 'cat-original-gold-jewelry')
        AND json_extract(attributes, '$.color_type') IS NOT NULL`,
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
    // WATCH — 2026-05-17: "New" aus Condition entfernt (Unworn ist die korrekte Bezeichnung).
    `UPDATE categories SET condition_options = '["Unworn","Pre-Owned","Vintage"]' WHERE id = 'cat-watch'`,
    // Bestehende Watch-Produkte mit condition="New" auf "Unworn" umstellen.
    `UPDATE products SET condition = 'Unworn' WHERE category_id = 'cat-watch' AND condition = 'New'`,
    // WATCH — 2026-05-17: material erweitert + Diamonds/Description sortiert + Ref/Serial/Bezel optional.
    `UPDATE categories SET attributes = '[
      {"key":"reference_number","label":"Reference Number","type":"text","required":false,"showInList":true},
      {"key":"case_diameter_mm","label":"Case Diameter","type":"number","unit":"mm","required":true,"showInList":true},
      {"key":"serial_number","label":"Serial Number","type":"text","required":false,"showInList":true},
      {"key":"dial","label":"Dial","type":"text","required":true,"showInList":false},
      {"key":"bezel","label":"Bezel","type":"text","required":false,"showInList":false},
      {"key":"diamonds","label":"Diamonds","type":"boolean","required":false,"showInList":false},
      {"key":"material","label":"Material","type":"select","options":["Steel","Solid Gold","Two-Tone Steel/Gold","Platinum","Titanium","Ceramic","Bronze","Carbon","DLC Steel","Plated","Ceramic & Steel","Ceramic & Gold","Titanium & Gold","Titanium & Ceramic"],"required":true,"showInList":true},
      {"key":"karat_color","label":"Karat & Color","type":"select","options":["18K Yellow","18K Rose","18K White","14K Yellow","14K Rose","14K White","9K Yellow","9K Rose"],"required":true,"showInList":true,"dependsOn":{"key":"material","valueIncludes":["Solid Gold","Two-Tone Steel/Gold","Ceramic & Gold","Titanium & Gold"]}},
      {"key":"description","label":"Description","type":"text","required":false,"showInList":false},
      {"key":"strap_type","label":"Strap Type","type":"select","options":["Leather","Rubber"],"required":false,"showInList":false},
      {"key":"movement","label":"Movement / Caliber","type":"text","required":false,"showInList":false},
      {"key":"year","label":"Year","type":"number","required":false,"showInList":false}
    ]' WHERE id = 'cat-watch'`,
    // Remap altes Material auf neue Optionen (idempotent):
    // alt "Gold"      → "Solid Gold"
    // alt "Rose Gold" → "Solid Gold" + karat_color "18K Rose"
    // alt "White Gold"→ "Solid Gold" + karat_color "18K White"
    // alt "Two-Tone"  → "Two-Tone Steel/Gold"
    // alt "Steel" / "Platinum" / "Titanium" / "Ceramic" / "Bronze" / "Plated" bleiben gleich.
    `UPDATE products
      SET attributes = json_set(
        json_set(attributes, '$.material', 'Solid Gold'),
        '$.karat_color',
        COALESCE(json_extract(attributes, '$.karat_color'), '18K Yellow')
      )
      WHERE category_id = 'cat-watch'
        AND json_extract(attributes, '$.material') = 'Gold'`,
    `UPDATE products
      SET attributes = json_set(
        json_set(attributes, '$.material', 'Solid Gold'),
        '$.karat_color',
        COALESCE(json_extract(attributes, '$.karat_color'), '18K Rose')
      )
      WHERE category_id = 'cat-watch'
        AND json_extract(attributes, '$.material') = 'Rose Gold'`,
    `UPDATE products
      SET attributes = json_set(
        json_set(attributes, '$.material', 'Solid Gold'),
        '$.karat_color',
        COALESCE(json_extract(attributes, '$.karat_color'), '18K White')
      )
      WHERE category_id = 'cat-watch'
        AND json_extract(attributes, '$.material') = 'White Gold'`,
    `UPDATE products
      SET attributes = json_set(
        json_set(attributes, '$.material', 'Two-Tone Steel/Gold'),
        '$.karat_color',
        COALESCE(json_extract(attributes, '$.karat_color'), '18K Yellow')
      )
      WHERE category_id = 'cat-watch'
        AND json_extract(attributes, '$.material') = 'Two-Tone'`,
    // Backfill: bestehende Watch-Produkte deren universal-`name` leer ist,
    // bekommen `attributes.model` als Name übernommen (idempotent — wirkt nur
    // einmal pro Produkt, weil danach name != '').
    `UPDATE products SET name = json_extract(attributes, '$.model')
      WHERE category_id = 'cat-watch'
        AND (name IS NULL OR name = '')
        AND json_extract(attributes, '$.model') IS NOT NULL
        AND json_extract(attributes, '$.model') != ''`,
    // SPARE_PART — 2026-05-17: Box ergänzt; Material nach Karat+Color differenziert
    // plus Steel/Gold-Bicolor-Varianten.
    `UPDATE categories SET attributes = '[
      {"key":"part_type","label":"Part Type","type":"select","options":["Dial","Bezel","Links","Crown","Strap","Buckle","Caseback","Movement","Crystal","Box","Other"],"required":true,"showInList":true},
      {"key":"material","label":"Material","type":"select","options":["Steel","18K YG","18K RG","18K WG","14K YG","14K RG","14K WG","Steel/18K YG","Steel/18K RG","Steel/18K WG","Steel/14K YG","Steel/14K RG","Steel/14K WG"],"required":true,"showInList":true},
      {"key":"original_or_copy","label":"Original or Copy","type":"select","options":["Original","Copy"],"required":true,"showInList":true},
      {"key":"description","label":"Description","type":"text","required":true,"showInList":false}
    ]' WHERE id = 'cat-spare-part'`,
    // Backfill alter material-Werte → neue Options. 18K/14K → YG (Yellow als Default);
    // Two-Tone → Steel/18K YG; 9K wird auf 14K YG mapped.
    `UPDATE products SET attributes = json_set(attributes, '$.material', '18K YG')
      WHERE category_id = 'cat-spare-part' AND json_extract(attributes, '$.material') = '18K'`,
    `UPDATE products SET attributes = json_set(attributes, '$.material', '14K YG')
      WHERE category_id = 'cat-spare-part' AND json_extract(attributes, '$.material') = '14K'`,
    `UPDATE products SET attributes = json_set(attributes, '$.material', '14K YG')
      WHERE category_id = 'cat-spare-part' AND json_extract(attributes, '$.material') = '9K'`,
    `UPDATE products SET attributes = json_set(attributes, '$.material', 'Steel/18K YG')
      WHERE category_id = 'cat-spare-part' AND json_extract(attributes, '$.material') = 'Two-Tone'`,
    // Backfill: bestehende Spare-Part-Produkte — wenn `attributes.karat` einer
    // der neuen Material-Optionen entspricht, in `material` übernehmen
    // (überschreibt das alte Free-Text `material` nur wenn karat valide ist).
    // Idempotent: nach erstem Run ist karat zwar noch da, wirkt aber identisch.
    `UPDATE products
      SET attributes = json_set(
        attributes,
        '$.material',
        json_extract(attributes, '$.karat')
      )
      WHERE category_id = 'cat-spare-part'
        AND json_extract(attributes, '$.karat') IN ('Steel', 'Two-Tone', '18K', '14K', '9K')`,
    // Old free-text material das nicht in den neuen Optionen ist: in description anhängen,
    // damit die Info nicht verloren geht. Nur wenn material nach dem karat-Backfill
    // immer noch ein NICHT-valider Wert ist.
    `UPDATE products
      SET attributes = json_set(
        attributes,
        '$.description',
        COALESCE(json_extract(attributes, '$.description'), '') ||
          CASE WHEN COALESCE(json_extract(attributes, '$.description'), '') = '' THEN '' ELSE ' · ' END ||
          'Material (legacy): ' || json_extract(attributes, '$.material')
      )
      WHERE category_id = 'cat-spare-part'
        AND json_extract(attributes, '$.material') IS NOT NULL
        AND json_extract(attributes, '$.material') != ''
        AND json_extract(attributes, '$.material') NOT IN ('Steel', 'Two-Tone', '18K', '14K', '9K')
        AND COALESCE(json_extract(attributes, '$.description'), '') NOT LIKE '%Material (legacy):%'`,
    // Material aufräumen wenn nicht in den neuen Optionen — User wählt neu.
    `UPDATE products
      SET attributes = json_remove(attributes, '$.material')
      WHERE category_id = 'cat-spare-part'
        AND json_extract(attributes, '$.material') IS NOT NULL
        AND json_extract(attributes, '$.material') NOT IN ('Steel', 'Two-Tone', '18K', '14K', '9K')`,
    // Karat-Schlüssel entfernen — Daten sind jetzt in material (oder ignoriert).
    `UPDATE products
      SET attributes = json_remove(attributes, '$.karat')
      WHERE category_id = 'cat-spare-part'
        AND json_extract(attributes, '$.karat') IS NOT NULL`,
    // Backfill: Spare-Part-Produkte ohne `name` bekommen `attributes.model`.
    `UPDATE products SET name = json_extract(attributes, '$.model')
      WHERE category_id = 'cat-spare-part'
        AND (name IS NULL OR name = '')
        AND json_extract(attributes, '$.model') IS NOT NULL
        AND json_extract(attributes, '$.model') != ''`,
    // Backfill: Original-Gold-Jewelry-Produkte ohne `name` bekommen `attributes.model_name`.
    `UPDATE products SET name = json_extract(attributes, '$.model_name')
      WHERE category_id = 'cat-original-gold-jewelry'
        AND (name IS NULL OR name = '')
        AND json_extract(attributes, '$.model_name') IS NOT NULL
        AND json_extract(attributes, '$.model_name') != ''`,

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
    // #11 Own-Item Repair: Repairs sollen entweder Kundenreparatur (CUSTOMER) sein
    // oder eigenes Inventar-Repair (OWN) — letztere ohne Client/Charge, Cost geht
    // direkt auf das Produkt. Default für Bestand = CUSTOMER (kein Datenverlust).
    `ALTER TABLE repairs ADD COLUMN repair_scope TEXT DEFAULT 'CUSTOMER'`,
    // #12 External-Repair Supplier-Link: Workshop/Goldsmith ist nun ein normaler
    // Supplier (FK), nicht mehr ein freier Text. Repair-Cost mit offener Zahlung
    // erscheint dann beim jeweiligen Supplier in den Payables. Bestehende Repairs
    // behalten external_vendor als Free-Text (Fallback in UI).
    `ALTER TABLE repairs ADD COLUMN workshop_supplier_id TEXT REFERENCES suppliers(id)`,
    `ALTER TABLE expenses ADD COLUMN supplier_id TEXT REFERENCES suppliers(id)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_supplier ON expenses(supplier_id)`,

    // ── Phase 9: Central Financial Ledger (SSOT) — ZIEL.md §3a ──
    // Doppelte Buchführung. Pro transaction_id gilt SUM(DEBIT) = SUM(CREDIT).
    // Immutable: keine UPDATEs/DELETEs. Korrektur via reverses_entry_id.
    // Schreibpfad ausschließlich über core/ledger/posting.ts.
    `CREATE TABLE IF NOT EXISTS ledger_entries (
      id                  TEXT PRIMARY KEY,
      branch_id           TEXT NOT NULL,
      tenant_id           TEXT,
      entry_no            INTEGER NOT NULL,
      transaction_id      TEXT NOT NULL,
      occurred_at         TEXT NOT NULL,
      recorded_at         TEXT NOT NULL,
      account             TEXT NOT NULL,
      direction           TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
      amount              REAL NOT NULL CHECK (amount >= 0),
      currency            TEXT NOT NULL DEFAULT 'BHD',
      counterparty_type   TEXT,
      counterparty_id     TEXT,
      source_module       TEXT NOT NULL,
      source_id           TEXT NOT NULL,
      source_line_id      TEXT,
      reverses_entry_id   TEXT REFERENCES ledger_entries(id),
      tax_scheme_snapshot TEXT,
      vat_rate_snapshot   REAL,
      metadata_json       TEXT,
      created_by          TEXT NOT NULL,
      created_at          TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_branch_account_date ON ledger_entries(branch_id, account, occurred_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON ledger_entries(transaction_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_source ON ledger_entries(source_module, source_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_counterparty ON ledger_entries(counterparty_type, counterparty_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_branch_no ON ledger_entries(branch_id, entry_no)`,

    // Sequenzcounter pro Branch — entry_no monoton, gap-frei, vergeben in postEntries().
    `CREATE TABLE IF NOT EXISTS ledger_sequence (
      branch_id   TEXT PRIMARY KEY,
      next_no     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT NOT NULL
    )`,

    // ── Recurring Expense Templates ──
    // Wiederkehrende Fixkosten (Miete, Gehalt, Strom, etc.). Ein Template
    // erzeugt monatlich am `day_of_month` (1..31, am Monatsende geclampt) eine
    // konkrete Expense via Generator. `last_generated_period` ('YYYY-MM') sorgt
    // fuer Idempotenz — Catch-up holt fehlende Monate seit Start auto nach.
    `CREATE TABLE IF NOT EXISTS recurring_expense_templates (
      id                    TEXT PRIMARY KEY,
      branch_id             TEXT NOT NULL REFERENCES branches(id),
      category              TEXT NOT NULL,
      amount                REAL NOT NULL,
      payment_method        TEXT NOT NULL DEFAULT 'bank',
      pay_now_default       INTEGER NOT NULL DEFAULT 0,    -- 0 = PENDING (Payable), 1 = sofort PAID
      description           TEXT,
      day_of_month          INTEGER NOT NULL DEFAULT 1,
      start_date            TEXT NOT NULL,                  -- YYYY-MM-DD
      end_date              TEXT,                           -- YYYY-MM-DD; NULL = unbefristet
      active                INTEGER NOT NULL DEFAULT 1,
      last_generated_period TEXT,                           -- letzter erzeugter Monat als 'YYYY-MM'
      supplier_id           TEXT REFERENCES suppliers(id),
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      created_by            TEXT REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_recurring_exp_branch_active ON recurring_expense_templates(branch_id, active)`,

    // Generierte Expense-Instanz traegt FK aufs Template (NULL = manuell erstellt).
    `ALTER TABLE expenses ADD COLUMN recurring_template_id TEXT REFERENCES recurring_expense_templates(id)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_recurring_template ON expenses(recurring_template_id)`,

    // ── Employees ──
    // Mitarbeiter-Stammdaten (separat von users — nicht jeder Mitarbeiter braucht
    // einen Login). Optionaler `user_id` Link wenn der Mitarbeiter auch Login hat.
    `CREATE TABLE IF NOT EXISTS employees (
      id                  TEXT PRIMARY KEY,
      branch_id           TEXT NOT NULL REFERENCES branches(id),
      name                TEXT NOT NULL,
      role                TEXT,                   -- 'Sales', 'Repair Tech', 'Manager', 'Admin', etc. (free text)
      employment_status   TEXT NOT NULL DEFAULT 'active',  -- 'active', 'on_leave', 'inactive'
      base_salary         REAL,                   -- monatliches Base-Gehalt (BHD), optional
      phone               TEXT,
      email               TEXT,
      notes               TEXT,
      user_id             TEXT REFERENCES users(id),  -- optional: verknuepfter Login-User
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      created_by          TEXT REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_employees_branch_status ON employees(branch_id, employment_status)`,
    `CREATE INDEX IF NOT EXISTS idx_employees_user ON employees(user_id)`,

    // Salary-Expenses koppeln per employee_id; Pflichtfeld nur in der UI
    // (Schema NULL-fähig, damit Bestands-Salary-Expenses ohne Migration weiterleben).
    `ALTER TABLE expenses ADD COLUMN employee_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_employee ON expenses(employee_id)`,

    // Recurring-Template kann ein Salary-Template sein → traegt employee_id durch.
    `ALTER TABLE recurring_expense_templates ADD COLUMN employee_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_recurring_exp_employee ON recurring_expense_templates(employee_id)`,

    // ── Staff-Feld auf Domain-Records (Wave 2) ──
    // EIN einheitliches Feld pro Record: welcher Mitarbeiter den Vorgang gemacht hat.
    // Separat von audit `created_by` (= eingeloggter User) damit der Owner auch
    // Records "im Namen von Ahmed" anlegen kann.
    `ALTER TABLE invoices ADD COLUMN staff_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoices_staff ON invoices(staff_id)`,
    `ALTER TABLE repairs ADD COLUMN staff_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_repairs_staff ON repairs(staff_id)`,

    // Wave-4 — Staff-Feld auf weiteren Domain-Tabellen.
    `ALTER TABLE purchases ADD COLUMN staff_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_purchases_staff ON purchases(staff_id)`,
    `ALTER TABLE agent_transfers ADD COLUMN staff_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_transfers_staff ON agent_transfers(staff_id)`,
    `ALTER TABLE consignments ADD COLUMN staff_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_consignments_staff ON consignments(staff_id)`,
    `ALTER TABLE sales_returns ADD COLUMN staff_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_returns_staff ON sales_returns(staff_id)`,
    `ALTER TABLE debts ADD COLUMN staff_id TEXT REFERENCES employees(id)`,
    `CREATE INDEX IF NOT EXISTS idx_debts_staff ON debts(staff_id)`,

    // Stock-Lots (Phase 1) — pro Purchase-Line ein Lot mit eigenem unit_cost,
    // damit Sales den korrekten Cost-Snapshot ziehen koennen statt das einzige
    // products.purchase_price-Feld zu ueberschreiben.
    `CREATE TABLE IF NOT EXISTS stock_lots (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id),
      purchase_id TEXT REFERENCES purchases(id) ON DELETE SET NULL,
      purchase_line_id TEXT REFERENCES purchase_lines(id) ON DELETE SET NULL,
      unit_cost REAL NOT NULL,
      qty_total REAL NOT NULL,
      qty_remaining REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      acquired_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stock_lots_product ON stock_lots(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_lots_purchase ON stock_lots(purchase_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_lots_purchase_line ON stock_lots(purchase_line_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_lots_status ON stock_lots(status)`,
    `ALTER TABLE invoice_lines ADD COLUMN lot_id TEXT REFERENCES stock_lots(id)`,
    `CREATE INDEX IF NOT EXISTS idx_invoice_lines_lot ON invoice_lines(lot_id)`,

    // Repair-Lot-Verknuepfung (Weg A Phase 5d Refinement) — User waehlt
    // explizit welchen Lot der OWN-Item-Repair kapitalisiert. Fallback: aeltester
    // ACTIVE Lot des Produkts (FIFO-konsistent).
    `ALTER TABLE repairs ADD COLUMN lot_id TEXT REFERENCES stock_lots(id)`,
    `CREATE INDEX IF NOT EXISTS idx_repairs_lot ON repairs(lot_id)`,

    // 2026-05-16 — Optischer Marker fuer Final-Invoices ("Special" vs "Normal").
    // 1 = Special (Display mit Punkt-Praefix: `.000021` / `.Repair-000021`),
    // 0/NULL = Normal (`000021` / `Repair-000021`). Reine Anzeige; keine
    // Buchungslogik aendert sich. User waehlt beim Convert/Finalize.
    `ALTER TABLE invoices ADD COLUMN special_mark INTEGER DEFAULT 0`,

    // 2026-05-16 — Backfill stock_status fuer Consignment-Produkte die VOR dem
    // Partial-Payment-Reservation-Fix verkauft wurden. Damals hat recordSale
    // sofort 'sold' gesetzt, auch wenn die Invoice noch PARTIAL war. Jetzt:
    // wenn die linked Invoice nicht FINAL ist (oder CANCELLED, RETURNED, ...),
    // setzen wir das Produkt zurueck auf 'consignment_reserved' damit es im
    // UI korrekt als "noch nicht voll bezahlt" angezeigt wird.
    `UPDATE products SET stock_status = 'consignment_reserved'
       WHERE source_type = 'CONSIGNMENT'
         AND stock_status = 'sold'
         AND EXISTS (
           SELECT 1 FROM consignments c
             JOIN invoices i ON i.id = c.invoice_id
            WHERE c.product_id = products.id
              AND i.status NOT IN ('FINAL', 'CANCELLED', 'RETURNED')
         )`,
    // Analog fuer OWN-Produkte: wenn aktuell 'sold', aber irgendeine Invoice-
    // Line nicht-FINAL — zurueck auf 'reserved'. Greift nur fuer Produkte mit
    // mind. einer Invoice (sonst ist 'sold' Legacy/Manual und bleibt).
    `UPDATE products SET stock_status = 'reserved'
       WHERE source_type != 'CONSIGNMENT'
         AND stock_status = 'sold'
         AND EXISTS (
           SELECT 1 FROM invoice_lines il
             JOIN invoices i ON i.id = il.invoice_id
            WHERE il.product_id = products.id
              AND i.status NOT IN ('FINAL', 'CANCELLED', 'RETURNED')
         )
         AND NOT EXISTS (
           SELECT 1 FROM invoice_lines il2
             JOIN invoices i2 ON i2.id = il2.invoice_id
            WHERE il2.product_id = products.id
              AND i2.status = 'FINAL'
         )`,

    // 2026-05-16 — Backfill Cost fuer Consignment-Produkte mit purchase_price=0.
    // Reihenfolge (am genauesten zuerst):
    //   1. stock_lot.unit_cost — vom Auto-Purchase gesetzt, gueltig auch nach
    //      EXHAUSTED weil das LOT bestehen bleibt (nur qty_remaining = 0).
    //   2. consignment.payout_amount — fuer SOLD/PAID_OUT Consignments wo der
    //      tatsaechliche Payout bekannt ist.
    //   3. agreed_price * (1 - commission_rate/100) — Estimate fuer ACTIVE
    //      Consignments ohne Sale.
    //   4. consignor_fixed → agreed_price (Garantie an Consignor).
    // Greift nur bei aktuell 0, ueberschreibt nie echte Daten.
    `UPDATE products SET purchase_price = COALESCE(
       (SELECT sl.unit_cost FROM stock_lots sl
          WHERE sl.product_id = products.id AND sl.status != 'CANCELLED'
          ORDER BY sl.acquired_at DESC LIMIT 1),
       (SELECT CASE
          WHEN c.status IN ('sold', 'paid_out') AND COALESCE(c.payout_amount, 0) > 0 THEN c.payout_amount
          WHEN COALESCE(c.commission_type, 'percent') = 'consignor_fixed' THEN c.agreed_price
          ELSE c.agreed_price * (1.0 - COALESCE(c.commission_rate, 15) / 100.0)
        END
        FROM consignments c
        WHERE c.product_id = products.id
        ORDER BY c.created_at DESC LIMIT 1)
     )
     WHERE source_type = 'CONSIGNMENT'
       AND COALESCE(purchase_price, 0) = 0
       AND EXISTS (
         SELECT 1 FROM consignments c2 WHERE c2.product_id = products.id
       )`,

    // ───────────────────────────────────────────────────────────────
    // 2026-05-17 — Stock-Lot Reconciliation
    // Bug-Symptom: Produkte mit stock_status='sold' zeigen stock_lots noch
    // als ACTIVE/Available, weil ältere FINAL/PARTIAL invoice_lines kein
    // lot_id Link hatten (entstanden vor Lot-System-Fertigstellung 2026-05-11).
    //
    // Schritt 1: Orphan invoice_lines (lot_id IS NULL) für FINAL/PARTIAL Invoices
    // an den ersten verfügbaren Lot des Produkts hängen (FIFO).
    // ───────────────────────────────────────────────────────────────
    `UPDATE invoice_lines
       SET lot_id = (
         SELECT id FROM stock_lots
         WHERE product_id = invoice_lines.product_id
           AND status != 'CANCELLED'
         ORDER BY acquired_at ASC, id ASC
         LIMIT 1
       )
     WHERE lot_id IS NULL
       AND EXISTS (
         SELECT 1 FROM invoices i
         WHERE i.id = invoice_lines.invoice_id
           AND i.status IN ('FINAL', 'PARTIAL')
       )
       AND EXISTS (
         SELECT 1 FROM stock_lots sl
         WHERE sl.product_id = invoice_lines.product_id
           AND sl.status != 'CANCELLED'
       )`,

    // Schritt 2: qty_remaining + status pro Lot aus der Wahrheit zurückrechnen.
    //   consumed = SUM(invoice_lines.quantity)         (FINAL/PARTIAL)
    //   returned = SUM(sales_return_lines.quantity)    (über invoice_lines.lot_id verlinkt)
    //   qty_remaining = MAX(0, qty_total - consumed + returned)
    //   status = EXHAUSTED falls qty_remaining = 0, sonst ACTIVE
    // CANCELLED Lots bleiben CANCELLED.
    `UPDATE stock_lots
       SET qty_remaining = MAX(0,
             qty_total
             - COALESCE((
                 SELECT SUM(il.quantity) FROM invoice_lines il
                 JOIN invoices i ON i.id = il.invoice_id
                 WHERE il.lot_id = stock_lots.id
                   AND i.status IN ('FINAL', 'PARTIAL')
               ), 0)
             + COALESCE((
                 SELECT SUM(srl.quantity) FROM sales_return_lines srl
                 JOIN invoice_lines il2 ON il2.id = srl.invoice_line_id
                 WHERE il2.lot_id = stock_lots.id
               ), 0)
           ),
           status = CASE
             WHEN qty_total
                  - COALESCE((
                      SELECT SUM(il.quantity) FROM invoice_lines il
                      JOIN invoices i ON i.id = il.invoice_id
                      WHERE il.lot_id = stock_lots.id
                        AND i.status IN ('FINAL', 'PARTIAL')
                    ), 0)
                  + COALESCE((
                      SELECT SUM(srl.quantity) FROM sales_return_lines srl
                      JOIN invoice_lines il2 ON il2.id = srl.invoice_line_id
                      WHERE il2.lot_id = stock_lots.id
                    ), 0)
                  <= 0 THEN 'EXHAUSTED'
             ELSE 'ACTIVE'
           END
     WHERE status != 'CANCELLED'`,

    // Schritt 3: products.quantity nachziehen (Phase 7 Sync).
    `UPDATE products
       SET quantity = COALESCE((
         SELECT SUM(qty_remaining)
         FROM stock_lots
         WHERE product_id = products.id
           AND status != 'CANCELLED'
           AND qty_remaining > 0
       ), products.quantity)
     WHERE EXISTS (
       SELECT 1 FROM stock_lots sl
       WHERE sl.product_id = products.id
     )`,

    // Plan §Image-Duplicate-Detection — 16-stelliger Hex pHash (64 bit DCT).
    // Befüllt von createProduct/updateProduct + Lazy-Backfill in loadProducts.
    `ALTER TABLE products ADD COLUMN image_hash TEXT`,

    // Plan §AI-Embedding — gpt-4o-mini Vision-Description + text-embedding-3-small
    // Vektor (1536 Dim, JSON-serialisiert). Primärsignal für Image-Duplicate-
    // Detection ab v0.1.32; pHash bleibt als Offline-Fallback.
    `ALTER TABLE products ADD COLUMN image_description TEXT`,
    `ALTER TABLE products ADD COLUMN image_embedding TEXT`,

    // ── AI-Learning (2026-05-18, v0.1.41) ──
    // Snapshot dessen was die AI beim letzten Identify vorgeschlagen hat (JSON).
    // ai_corrections speichert eine Liste von Feld-Korrekturen die der User
    // gemacht hat (Diff gegen Snapshot). Wird beim naechsten Identify als
    // Few-Shot-Example reingegeben damit die AI aus deinen Bestaetigungen lernt.
    `ALTER TABLE products ADD COLUMN ai_identified_snapshot TEXT`,
    `ALTER TABLE products ADD COLUMN ai_corrections TEXT`,
    `ALTER TABLE products ADD COLUMN ai_confirmed_at TEXT`,

    // ── Scrap Gold Quick Trade ──
    // Direkter Altgold-Handel (Kunde → wir → Händler). Nur der Spread (sale - purchase)
    // wird als REVENUE gebucht; Brutto-Preise bleiben als Audit-Trail auf der Row.
    `CREATE TABLE IF NOT EXISTS scrap_trades (
      id                       TEXT PRIMARY KEY,
      branch_id                TEXT NOT NULL REFERENCES branches(id),
      trade_number             TEXT NOT NULL,
      seller_name              TEXT NOT NULL,
      seller_phone             TEXT,
      seller_customer_id       TEXT REFERENCES customers(id),
      buyer_name               TEXT NOT NULL,
      buyer_phone              TEXT,
      buyer_supplier_id        TEXT REFERENCES suppliers(id),
      weight_grams             REAL NOT NULL,
      karat                    TEXT NOT NULL,
      purchase_price           REAL NOT NULL,
      sale_price               REAL NOT NULL,
      profit                   REAL NOT NULL,
      payment_method_purchase  TEXT DEFAULT 'cash',
      payment_method_sale      TEXT DEFAULT 'cash',
      trade_date               TEXT NOT NULL,
      notes                    TEXT,
      images_purchase          TEXT DEFAULT '[]',
      images_sale              TEXT DEFAULT '[]',
      status                   TEXT DEFAULT 'completed',
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      created_by               TEXT REFERENCES users(id),
      version                  INTEGER DEFAULT 1,
      sync_status              TEXT DEFAULT 'synced',
      UNIQUE(branch_id, trade_number)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_scrap_trades_branch ON scrap_trades(branch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scrap_trades_date ON scrap_trades(trade_date)`,
    `CREATE INDEX IF NOT EXISTS idx_scrap_trades_status ON scrap_trades(status)`,

    // Scrap Trade Lines — Multi-Item-Support. Ein Trade kann mehrere Goldstücke
    // mit eigenen Weight/Karat/Preisen umfassen. Aggregat-Felder auf scrap_trades
    // (weight_grams, karat, purchase_price, sale_price, profit) werden zu Summen
    // bzw. 'mixed' für karat bei Multi-Line. Photos sind PRO Item, nicht pro Trade.
    `CREATE TABLE IF NOT EXISTS scrap_trade_lines (
      id              TEXT PRIMARY KEY,
      scrap_trade_id  TEXT NOT NULL REFERENCES scrap_trades(id) ON DELETE CASCADE,
      position        INTEGER DEFAULT 1,
      weight_grams    REAL NOT NULL,
      karat           TEXT NOT NULL,
      purchase_price  REAL NOT NULL,
      sale_price      REAL NOT NULL,
      profit          REAL NOT NULL,
      notes           TEXT,
      images_purchase TEXT DEFAULT '[]',
      images_sale     TEXT DEFAULT '[]',
      created_at      TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_scrap_lines_trade ON scrap_trade_lines(scrap_trade_id)`,

    // Scrap Trade Payments — Split-Payments. Pro Trade können MEHRERE Payments
    // mit verschiedenen Methoden gebucht werden (z.B. 200 Cash + 300 Benefit zum
    // Seller, 300 Cash + 600 Bank vom Buyer). Sum(OUT) muss SUM(lines.purchase)
    // entsprechen, Sum(IN) muss SUM(lines.sale) entsprechen.
    `CREATE TABLE IF NOT EXISTS scrap_trade_payments (
      id              TEXT PRIMARY KEY,
      scrap_trade_id  TEXT NOT NULL REFERENCES scrap_trades(id) ON DELETE CASCADE,
      direction       TEXT NOT NULL CHECK (direction IN ('OUT','IN')),
      method          TEXT NOT NULL DEFAULT 'cash',
      amount          REAL NOT NULL,
      position        INTEGER DEFAULT 1,
      created_at      TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_scrap_pmt_trade ON scrap_trade_payments(scrap_trade_id, direction)`,

    // CPR (Bahrain ID) + ID-Card-Bild als Felder am Supplier — fuer
    // Purchase-Print-PDFs (Beleg-Block bei Altgold-/Used-Watch-Ankaeufen).
    `ALTER TABLE suppliers ADD COLUMN cpr TEXT`,
    `ALTER TABLE suppliers ADD COLUMN cpr_image TEXT`,

    // Audit-Snapshot der Supplier-Daten zum Zeitpunkt des Purchase-Create.
    // Salesforce-Pattern: vermeidet rueckwirkende Aenderungen am gedruckten
    // Beleg wenn der Supplier-Datensatz spaeter editiert/geloescht wird.
    `ALTER TABLE purchases ADD COLUMN supplier_snapshot TEXT`,

    // ─── Repair Multi-Line + Gold-Flow (Plan repair-multi-supplier) ────
    // Pro Repair koennen N Work-Lines existieren, je 1 externe Line erzeugt
    // beim Status-Wechsel auf IN_PROGRESS eine eigene Expense. Stand-Heute-
    // Single-Supplier-Repairs werden ueber das Backfill-INSERT weiter unten
    // automatisch in eine repair_lines-Zeile migriert.
    `CREATE TABLE IF NOT EXISTS repair_lines (
      id           TEXT PRIMARY KEY,
      branch_id    TEXT NOT NULL,
      repair_id    TEXT NOT NULL REFERENCES repairs(id) ON DELETE CASCADE,
      position     INTEGER NOT NULL,
      supplier_id  TEXT REFERENCES suppliers(id),
      work_type    TEXT,
      description  TEXT,
      cost_amount  REAL NOT NULL DEFAULT 0,
      expense_id   TEXT REFERENCES expenses(id),
      status       TEXT NOT NULL DEFAULT 'OPEN',
      due_date     TEXT,
      notes        TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      UNIQUE(repair_id, position)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_repair_lines_repair ON repair_lines(repair_id)`,
    `CREATE INDEX IF NOT EXISTS idx_repair_lines_supplier ON repair_lines(supplier_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_repair_lines_expense ON repair_lines(expense_id)`,

    // Gold-Payable: Workshop hat eigenes Gold im Repair verwendet → wir schulden
    // X Gramm in Karat Y. Settlement entweder durch Gold-Return aus precious_metals
    // ODER durch Umrechnung in BHD (settlement_expense_id verlinkt die erzeugte
    // Expense). Direction zukunftssicher fuer "they_owe" Fall (selten — wenn der
    // Workshop unser Gold genommen hat ohne es zu verwenden).
    `CREATE TABLE IF NOT EXISTS gold_payables (
      id                    TEXT PRIMARY KEY,
      branch_id             TEXT NOT NULL,
      supplier_id           TEXT NOT NULL REFERENCES suppliers(id),
      source_repair_id      TEXT REFERENCES repairs(id) ON DELETE CASCADE,
      source_repair_line_id TEXT REFERENCES repair_lines(id) ON DELETE SET NULL,
      direction             TEXT NOT NULL DEFAULT 'we_owe',
      weight_grams          REAL NOT NULL,
      karat                 TEXT NOT NULL,
      settlement_type       TEXT NOT NULL,
      fulfilled_grams       REAL NOT NULL DEFAULT 0,
      settlement_expense_id TEXT REFERENCES expenses(id),
      status                TEXT NOT NULL DEFAULT 'OPEN',
      notes                 TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gold_payables_supplier ON gold_payables(supplier_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_gold_payables_source ON gold_payables(source_repair_id)`,

    // Customer-Gold-Credit: Kunde hat eigenes Gold gebracht, nur Teil davon
    // verwendet, Rest als Guthaben bei uns geparkt. Mirror von gold_payables
    // aber auf der Customer-Seite. Konvertierbar zu BHD-Credit oder einloesbar
    // in zukuenftigen Repair.
    `CREATE TABLE IF NOT EXISTS customer_gold_credits (
      id                   TEXT PRIMARY KEY,
      branch_id            TEXT NOT NULL,
      customer_id          TEXT NOT NULL REFERENCES customers(id),
      source_repair_id     TEXT REFERENCES repairs(id) ON DELETE SET NULL,
      weight_grams         REAL NOT NULL,
      karat                TEXT NOT NULL,
      fulfilled_grams      REAL NOT NULL DEFAULT 0,
      settlement_credit_id TEXT,
      status               TEXT NOT NULL DEFAULT 'OPEN',
      notes                TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_gold_credits_customer ON customer_gold_credits(customer_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_gold_credits_source ON customer_gold_credits(source_repair_id)`,

    // Gold-Movements: universeller Audit-Trail fuer alle Gramm-Bewegungen
    // (analog ledger_entries fuer BHD). Schreibt sich automatisch bei jeder
    // Settle/Convert/Cross-Settle-Action.
    `CREATE TABLE IF NOT EXISTS gold_movements (
      id                TEXT PRIMARY KEY,
      branch_id         TEXT NOT NULL,
      moved_at          TEXT NOT NULL,
      direction         TEXT NOT NULL,
      weight_grams      REAL NOT NULL,
      karat             TEXT NOT NULL,
      source_bucket     TEXT,
      source_id         TEXT,
      target_bucket     TEXT,
      target_id         TEXT,
      related_repair_id TEXT,
      notes             TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gold_movements_moved_at ON gold_movements(moved_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_gold_movements_repair ON gold_movements(related_repair_id)`,

    // Customer-Credits (BHD) — Mirror von supplier_credits, fuer Faelle wo
    // wir Kunden Geld schulden (z.B. Gold-Credit-Conversion, Refund-Credit).
    // Plan repair-multi-supplier: convertCustomerCreditToMoney schreibt hier rein.
    `CREATE TABLE IF NOT EXISTS customer_credits (
      id              TEXT PRIMARY KEY,
      branch_id       TEXT NOT NULL,
      customer_id     TEXT NOT NULL,
      source_type     TEXT,
      source_id       TEXT,
      amount          REAL NOT NULL,
      used_amount     REAL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'OPEN',
      note            TEXT,
      created_at      TEXT NOT NULL,
      created_by      TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_credits_customer ON customer_credits(customer_id, status)`,

    // Backfill: existierende Single-Supplier-Repairs in eine repair_lines-Zeile
    // migrieren. NOT EXISTS-Guard macht den Schritt idempotent.
    `INSERT INTO repair_lines (id, branch_id, repair_id, position, supplier_id, work_type, cost_amount, expense_id, status, created_at, updated_at)
     SELECT
       lower(hex(randomblob(16))),
       r.branch_id, r.id, 1, r.workshop_supplier_id, 'service',
       COALESCE(r.actual_cost, r.estimated_cost, 0),
       (SELECT e.id FROM expenses e
          WHERE e.related_module = 'repair' AND e.related_entity_id = r.id
          ORDER BY e.created_at ASC
          LIMIT 1),
       'OPEN',
       COALESCE(r.created_at, datetime('now')),
       COALESCE(r.updated_at, datetime('now'))
     FROM repairs r
     WHERE r.workshop_supplier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM repair_lines rl WHERE rl.repair_id = r.id)`,

    // v0.1.46 — Metal-Inflow Audit + Ledger-Linkage:
    // Optionaler supplier_id-FK auf precious_metals erlaubt der MetalCreate-Action
    // einen A/P-Eintrag fuer den Lieferanten zu erzeugen (statt nur Bestands-Add).
    `ALTER TABLE precious_metals ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL`,
    `ALTER TABLE precious_metals ADD COLUMN linked_expense_id TEXT REFERENCES expenses(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_precious_metals_supplier ON precious_metals(supplier_id)`,

    // v0.2.1 — Custom Orders Merge:
    // Order-Type Discriminator: 'normal' (default) vs 'custom' (Goldsmith-Auftraege)
    `ALTER TABLE orders ADD COLUMN type TEXT NOT NULL DEFAULT 'normal'`,
    `ALTER TABLE orders ADD COLUMN custom_meta TEXT`,
    `ALTER TABLE orders ADD COLUMN goldsmith_supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL`,
    `ALTER TABLE orders ADD COLUMN labor_cost REAL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN extra_gold_value REAL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type)`,

    // order_lines erweitern (analog zu repair_lines): per-line supplier-cost.
    `ALTER TABLE order_lines ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL`,
    `ALTER TABLE order_lines ADD COLUMN cost_amount REAL DEFAULT 0`,
    `ALTER TABLE order_lines ADD COLUMN expense_id TEXT REFERENCES expenses(id) ON DELETE SET NULL`,
    `ALTER TABLE order_lines ADD COLUMN is_customer_facing INTEGER DEFAULT 1`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_supplier ON order_lines(supplier_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_expense ON order_lines(expense_id)`,

    // Gold-Buckets source-agnostic: parallel sourceFK fuer Custom-Orders.
    // Konvention: exactly one of source_repair_id / source_order_id must be set.
    `ALTER TABLE gold_payables ADD COLUMN source_order_id TEXT REFERENCES orders(id) ON DELETE CASCADE`,
    `ALTER TABLE customer_gold_credits ADD COLUMN source_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_gold_payables_source_order ON gold_payables(source_order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_gold_credits_source_order ON customer_gold_credits(source_order_id)`,

    // gold_movements: optionaler Order-Link analog zum repair-Link.
    `ALTER TABLE gold_movements ADD COLUMN related_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_gold_movements_order ON gold_movements(related_order_id)`,

    // Material-Kind Parity fuer BEIDE Module: repair_lines + order_lines bekommen
    // strukturierte Material-Daten. material_kind ist Discriminator,
    // material_details ist JSON ({ct, qty, description, karat, supplierName}).
    `ALTER TABLE repair_lines ADD COLUMN material_kind TEXT`,
    `ALTER TABLE repair_lines ADD COLUMN material_details TEXT`,
    `ALTER TABLE order_lines ADD COLUMN material_kind TEXT`,
    `ALTER TABLE order_lines ADD COLUMN material_details TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_repair_lines_material_kind ON repair_lines(material_kind)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_material_kind ON order_lines(material_kind)`,

    // v0.3.0 — Mixed Orders + Per-Line Fulfillment Status + Partial Invoicing:
    // order_lines bekommt einen eigenen Fulfillment-Status (PENDING/ARRIVED/
    // DELIVERED/CANCELLED) damit gemischte Orders mit verschiedenen Liefer-
    // Timelines per-Line getrackt werden koennen. invoice_id verlinkt eine
    // bereits invoicte Line (NULL = noch nicht invoiced) — ermoeglicht
    // partielles Invoicing (mehrere Invoices pro Order).
    `ALTER TABLE order_lines ADD COLUMN status TEXT DEFAULT 'PENDING'`,
    `ALTER TABLE order_lines ADD COLUMN invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_status ON order_lines(status)`,
    `CREATE INDEX IF NOT EXISTS idx_order_lines_invoice ON order_lines(invoice_id)`,

    // v0.4.0 — Mobile-Capture Vorfilter: Purchase-Inbox. Die /mobile-Seite legt
    // im Modus "Purchase" nur ein Foto in diese Inbox (kein Produkt, keine
    // Purchase, kein Ledger). Am Desktop oeffnet ein Klick auf das Inbox-Foto
    // die New-Purchase-Seite mit dem Foto. status: pending | done | dismissed.
    `CREATE TABLE IF NOT EXISTS purchase_inbox (
      id         TEXT PRIMARY KEY,
      branch_id  TEXT NOT NULL,
      images     TEXT NOT NULL DEFAULT '[]',
      note       TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      created_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_purchase_inbox_status ON purchase_inbox(status)`,

    // Back-to-Back Beschaffung: Order ↔ Purchase Verknuepfung.
    // source_order_id / source_order_line_id verknuepfen einen Lieferanten-Einkauf
    // mit der Kunden-Order, die ihn ausgeloest hat (ein Purchase kann order-
    // verknuepfte + reine Lager-Zeilen mischen). ordered_supplier_id haelt beim
    // "Beim Supplier bestellt"-Markieren den geplanten Supplier fest (Gruppierung).
    `ALTER TABLE purchases ADD COLUMN source_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL`,
    `ALTER TABLE purchase_lines ADD COLUMN source_order_line_id TEXT REFERENCES order_lines(id) ON DELETE SET NULL`,
    `ALTER TABLE order_lines ADD COLUMN ordered_supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_purchases_source_order ON purchases(source_order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_purchase_lines_source_order_line ON purchase_lines(source_order_line_id)`,
    // v0.6.5 — Gold-Verbindlichkeit ↔ Order-Kostenzeile verknuepfen, damit die
    // Gramm-Schuld beim Loeschen der Kostenzeile automatisch mitentfernt wird.
    `ALTER TABLE gold_payables ADD COLUMN source_order_line_id TEXT REFERENCES order_lines(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_gold_payables_source_order_line ON gold_payables(source_order_line_id)`,
    // v0.6.7 — Custom-Order Produkt-Spec (Kategorie + Attribute + Brand/Name +
    // Foto + Condition + TaxScheme + Notes) als JSON. Convert in OrderDetail
    // deserialisiert sie und erzeugt das Produkt damit, statt nur Freitext.
    `ALTER TABLE orders ADD COLUMN custom_product_spec TEXT`,
    // v0.6.7 — Gold-Diamond Jewellery: 'New' zur Condition-Liste hinzufuegen
    // (frisch goldgeschmiedete Custom-Stuecke + Neueinkaeufe). Idempotent durch
    // NOT-LIKE-Guard — laeuft jeden Startup, matched aber nichts wenn schon drin.
    `UPDATE categories SET condition_options = '["New","Pre-Owned","Vintage"]'
       WHERE id = 'cat-gold-jewelry' AND condition_options NOT LIKE '%New%'`,
    // v0.7.10 — Cost+Split Consignment-Modus: shop's profit-share in % wenn
    // commissionType = 'cost_split'. NULL fuer andere Modi. Default 50 wird in
    // der UI/Store-Logik gesetzt, nicht als DB-Default (damit klar bleibt:
    // alte Consignments waren NIE cost_split).
    `ALTER TABLE consignments ADD COLUMN excess_split_pct INTEGER`,
    // v0.7.22 — Approval "Our Price + Split": settlement_model 'full' (default,
    // altes Verhalten) vs. 'split'; excess_split_pct = Shop-Anteil am Überschuss.
    `ALTER TABLE agent_transfers ADD COLUMN settlement_model TEXT DEFAULT 'full'`,
    `ALTER TABLE agent_transfers ADD COLUMN excess_split_pct INTEGER`,
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

  // Daten-Reparatur — verwaiste Order ↔ Invoice-Verknuepfungen aufloesen.
  // sql.js erzwingt ON DELETE SET NULL nicht zuverlaessig: wurde eine aus einer
  // Order erzeugte Invoice geloescht ODER storniert, blieb order_lines.invoice_id
  // / orders.invoice_id als Geist-Referenz stehen. Folge: die Order war dauerhaft
  // gesperrt — jeder Zeilen-Delete/-Edit verlangte einen Invoice-Storno, den es
  // gar nicht mehr gab. Heilt Alt-Daten; der Vorwaerts-Fix sitzt in invoiceStore
  // (cancel/delete entkoppeln jetzt selbst). Idempotent via settings-Flag.
  try {
    const flag = database.exec(
      `SELECT value FROM settings WHERE key = 'migration.unlink_orphan_invoice_links_v1'`
    );
    const alreadyApplied = flag.length > 0 && flag[0].values.length > 0 && flag[0].values[0][0] === '1';
    if (!alreadyApplied) {
      database.run(
        `UPDATE order_lines SET invoice_id = NULL
          WHERE invoice_id IS NOT NULL
            AND invoice_id NOT IN (SELECT id FROM invoices WHERE status != 'CANCELLED')`
      );
      database.run(
        `UPDATE orders SET invoice_id = NULL, updated_at = datetime('now')
          WHERE invoice_id IS NOT NULL
            AND invoice_id NOT IN (SELECT id FROM invoices WHERE status != 'CANCELLED')`
      );
      database.run(
        `INSERT OR REPLACE INTO settings (branch_id, key, value, category, updated_at)
         VALUES ('branch-main', 'migration.unlink_orphan_invoice_links_v1', '1', 'system', datetime('now'))`
      );
    }
  } catch (err) {
    console.warn('unlink_orphan_invoice_links migration failed:', err);
  }

  // v0.7.1 — MARGIN-VAT Backfill: alte MARGIN-Invoice-Lines hatten `vat_amount = 0`
  // statt internalVat (= margin × rate / (100 + rate)). Der Convert-Flow speicherte
  // calc.vatAmount (=0 fuer MARGIN) statt calc.internalVatAmount. Folge: das
  // MARGIN_VAT-Ledger-Konto + invoice.vatAmount-Hero waren leer fuer Custom-Convert-
  // Invoices. NBR-Excel-Export ist nicht betroffen (rechnet selbst aus purchase/sale
  // Snapshots), nur das Management-Reporting + Hero-Konsistenz. Idempotent.
  try {
    const flag = database.exec(
      `SELECT value FROM settings WHERE key = 'migration.margin_vat_backfill_v1'`
    );
    const alreadyApplied = flag.length > 0 && flag[0].values.length > 0 && flag[0].values[0][0] === '1';
    if (!alreadyApplied) {
      // Recompute vat_amount fuer MARGIN-Lines mit 0 und positiver Marge.
      // Formel: vat = (line_total - purchase * qty) × rate / (100 + rate), 3 Dezimal.
      database.run(
        `UPDATE invoice_lines
            SET vat_amount = ROUND(
                  (line_total - COALESCE(purchase_price_snapshot, 0) * COALESCE(quantity, 1))
                  * COALESCE(vat_rate, 10)
                  / (100 + COALESCE(vat_rate, 10))
                  * 1000
                ) / 1000.0
          WHERE tax_scheme = 'MARGIN'
            AND COALESCE(vat_amount, 0) = 0
            AND line_total > COALESCE(purchase_price_snapshot, 0) * COALESCE(quantity, 1)`
      );
      // Re-sum invoice.vat_amount aus den korrigierten Lines, damit Hero/Liste konsistent sind.
      database.run(
        `UPDATE invoices
            SET vat_amount = COALESCE((
                  SELECT SUM(vat_amount) FROM invoice_lines WHERE invoice_id = invoices.id
                ), 0),
                updated_at = datetime('now')
          WHERE id IN (
            SELECT DISTINCT invoice_id FROM invoice_lines WHERE tax_scheme = 'MARGIN'
          )`
      );
      database.run(
        `INSERT OR REPLACE INTO settings (branch_id, key, value, category, updated_at)
         VALUES ('branch-main', 'migration.margin_vat_backfill_v1', '1', 'system', datetime('now'))`
      );
    }
  } catch (err) {
    console.warn('margin_vat_backfill_v1 migration failed:', err);
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

// Stock-Lots Backfill (Phase 1) — einmalig:
//  - jede non-CANCELLED purchase_line wird ein Lot mit qty_total = quantity, unit_cost = unit_price
//  - jede invoice_line in non-CANCELLED Invoices wird FIFO an das aelteste passende Lot gehaengt;
//    qty_remaining wird entsprechend reduziert (clamp bei 0)
// Idempotent via settings-Flag 'migration.stock_lots_backfill_v1'.
function backfillStockLots(database: Database): void {
  try {
    const flag = database.exec(
      `SELECT value FROM settings WHERE key = 'migration.stock_lots_backfill_v1'`
    );
    const alreadyApplied = flag.length > 0 && flag[0].values.length > 0 && flag[0].values[0][0] === '1';
    if (alreadyApplied) return;

    const now = new Date().toISOString();

    // Clean-Slate fuer Re-Runs: ein vorheriger Migrationsversuch konnte Lots
    // anlegen aber das Flag nicht setzen (z.B. SQL-Fehler in Schritt 2).
    // Da ohne Flag noch nichts produktiv Lots benutzt, koennen wir hier safe leeren.
    database.run(`UPDATE invoice_lines SET lot_id = NULL WHERE lot_id IS NOT NULL`);
    database.run(`DELETE FROM stock_lots`);

    // 1) Lots aus bestehenden purchase_lines (nur Purchases mit Produkt-Bezug, nicht CANCELLED).
    const lineRes = database.exec(
      `SELECT pl.id, pl.purchase_id, pl.product_id, pl.quantity, pl.unit_price,
              p.purchase_date, p.branch_id, p.status
         FROM purchase_lines pl
         JOIN purchases p ON p.id = pl.purchase_id
        WHERE pl.product_id IS NOT NULL
          AND p.status != 'CANCELLED'`
    );
    let lotsCreated = 0;
    if (lineRes.length > 0) {
      for (const row of lineRes[0].values) {
        const [lineId, purchaseId, productId, quantity, unitPrice, purchaseDate, branchId] = row as [
          string, string, string, number, number, string | null, string, string,
        ];
        const lotId = uuid();
        const qty = Number(quantity) || 0;
        if (qty <= 0) continue;
        database.run(
          `INSERT INTO stock_lots
             (id, branch_id, product_id, purchase_id, purchase_line_id,
              unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
          [lotId, branchId, productId, purchaseId, lineId,
           Number(unitPrice) || 0, qty, qty, purchaseDate || now, now]
        );
        lotsCreated++;
      }
    }

    // 2) invoice_lines an Lots haengen (FIFO nach acquired_at, dann id) und qty_remaining reduzieren.
    //    Nur fuer non-CANCELLED Invoices. Greedy: Pro invoice_line das aelteste Lot, das noch
    //    ausreicht; sonst irgendein aelteste mit qty_remaining > 0; sonst irgendeinen Lot fuer
    //    das Produkt (Fallback fuer historische Inkonsistenzen).
    const ilRes = database.exec(
      `SELECT il.id, il.product_id, COALESCE(il.quantity, 1) AS qty
         FROM invoice_lines il
         JOIN invoices i ON i.id = il.invoice_id
        WHERE il.lot_id IS NULL
          AND i.status != 'CANCELLED'
        ORDER BY i.issued_at ASC, i.created_at ASC, il.position ASC`
    );
    let linesLinked = 0;
    let linesUnmatched = 0;
    if (ilRes.length > 0) {
      for (const row of ilRes[0].values) {
        const [ilId, productId, qtyRaw] = row as [string, string, number];
        const qty = Number(qtyRaw) || 1;

        // erst Lot suchen das den vollen Bedarf deckt
        let lotRes = database.exec(
          `SELECT id, qty_remaining FROM stock_lots
            WHERE product_id = ? AND status = 'ACTIVE' AND qty_remaining >= ?
            ORDER BY acquired_at ASC, id ASC LIMIT 1`,
          [productId, qty]
        );
        // Fallback: irgendein Lot mit Restbestand
        if (lotRes.length === 0 || lotRes[0].values.length === 0) {
          lotRes = database.exec(
            `SELECT id, qty_remaining FROM stock_lots
              WHERE product_id = ? AND status = 'ACTIVE' AND qty_remaining > 0
              ORDER BY acquired_at ASC, id ASC LIMIT 1`,
            [productId]
          );
        }
        // Letzter Fallback: irgendein Lot fuer das Produkt (auch wenn leer) — historische Daten.
        if (lotRes.length === 0 || lotRes[0].values.length === 0) {
          lotRes = database.exec(
            `SELECT id, qty_remaining FROM stock_lots
              WHERE product_id = ?
              ORDER BY acquired_at ASC, id ASC LIMIT 1`,
            [productId]
          );
        }

        if (lotRes.length === 0 || lotRes[0].values.length === 0) {
          linesUnmatched++;
          continue;
        }

        const [lotId, lotRem] = lotRes[0].values[0] as [string, number];
        const newRem = Math.max(0, Number(lotRem) - qty);
        const newStatus = newRem <= 0 ? 'EXHAUSTED' : 'ACTIVE';
        database.run(`UPDATE invoice_lines SET lot_id = ? WHERE id = ?`, [lotId, ilId]);
        database.run(
          `UPDATE stock_lots SET qty_remaining = ?, status = ? WHERE id = ?`,
          [newRem, newStatus, lotId]
        );
        linesLinked++;
      }
    }

    database.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES ('branch-main', 'migration.stock_lots_backfill_v1', '1', 'migration', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [now]
    );

    console.info(
      `[Migration] stock_lots backfill v1: ${lotsCreated} Lots erzeugt, ` +
      `${linesLinked} invoice_lines verknuepft, ${linesUnmatched} ohne Lot (historisch).`
    );
  } catch (err) {
    console.warn('[Migration] stock_lots backfill failed:', err);
  }
}

// Phase 7 Reconcile — syncronisiert products.quantity einmalig mit Σ qty_remaining
// aus den Lots. Behebt den Daten-Skew bei Produkten die mehrere Purchases bekommen haben
// ohne dass der Legacy products.quantity hochgezogen wurde. Idempotent via Flag.
function reconcileProductQuantities(database: Database): void {
  try {
    const flag = database.exec(
      `SELECT value FROM settings WHERE key = 'migration.product_quantity_reconcile_v1'`
    );
    const alreadyApplied = flag.length > 0 && flag[0].values.length > 0 && flag[0].values[0][0] === '1';
    if (alreadyApplied) return;

    const before = database.exec(
      `SELECT COUNT(*) FROM products p
        WHERE EXISTS (SELECT 1 FROM stock_lots sl
                       WHERE sl.product_id = p.id
                         AND sl.status != 'CANCELLED'
                         AND sl.qty_remaining > 0)
          AND p.quantity != (SELECT COALESCE(SUM(sl.qty_remaining), 0)
                               FROM stock_lots sl
                              WHERE sl.product_id = p.id
                                AND sl.status != 'CANCELLED'
                                AND sl.qty_remaining > 0)`
    );
    const driftedCount = before.length > 0 ? Number(before[0].values[0][0]) || 0 : 0;

    database.run(
      `UPDATE products
          SET quantity = (
            SELECT COALESCE(SUM(qty_remaining), 0)
              FROM stock_lots
             WHERE stock_lots.product_id = products.id
               AND stock_lots.status != 'CANCELLED'
               AND stock_lots.qty_remaining > 0
          )
        WHERE id IN (
          SELECT DISTINCT product_id FROM stock_lots
           WHERE status != 'CANCELLED' AND qty_remaining > 0
        )`
    );

    const now = new Date().toISOString();
    database.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES ('branch-main', 'migration.product_quantity_reconcile_v1', '1', 'migration', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [now]
    );

    console.info(`[Migration] product_quantity reconcile v1: ${driftedCount} Produkte angepasst.`);
  } catch (err) {
    console.warn('[Migration] product_quantity reconcile failed:', err);
  }
}

// Consumed-Products Backfill (2026-05-18) — alte Production-Records haben Input-
// Produkte hart geloescht (DELETE FROM products). Damit die Detail-Page und der
// neue Consumed-Filter in Collection trotzdem die historischen Input-Items zeigt,
// werden hier aus production_inputs.product_snapshot fehlende Product-Rows neu
// angelegt mit stock_status='consumed'. Idempotent ueber settings-Flag.
function backfillConsumedProducts(database: Database): void {
  try {
    const flagRes = database.exec(
      `SELECT value FROM settings WHERE key = 'migration.consumed_products_backfill_v1' LIMIT 1`
    );
    if (flagRes.length > 0 && flagRes[0].values.length > 0 && flagRes[0].values[0][0]) {
      return;
    }

    // Alle production_inputs deren product_id nicht mehr existiert
    const res = database.exec(`
      SELECT pi.product_id, pi.product_snapshot, pi.input_value,
             pr.branch_id, pr.production_date, pr.created_at
        FROM production_inputs pi
        JOIN production_records pr ON pr.id = pi.record_id
       WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = pi.product_id)
    `);

    let restored = 0;
    if (res.length > 0) {
      for (const row of res[0].values) {
        const productId = row[0] as string;
        const snapshotRaw = row[1] as string | null;
        const inputValue = (row[2] as number) || 0;
        const branchId = (row[3] as string) || 'branch-main';
        const prodDate = row[4] as string | null;
        const createdAt = (row[5] as string) || new Date().toISOString();

        if (!snapshotRaw) continue;
        let snap: {
          categoryId?: string; brand?: string; name?: string; sku?: string;
          condition?: string; attributes?: Record<string, unknown>; images?: string[];
          purchasePrice?: number;
        };
        try { snap = JSON.parse(snapshotRaw); } catch { continue; }

        try {
          database.run(
            `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
              purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
              supplier_name, notes, images, attributes, source_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'BHD', 'consumed', 'MARGIN', NULL, 0, NULL, ?, ?, ?, 'OWN', ?, ?)`,
            [
              productId, branchId,
              snap.categoryId || 'cat-watch',
              (snap.brand || '').trim(),
              (snap.name || '').trim(),
              snap.sku || null,
              snap.condition || '',
              prodDate,
              typeof snap.purchasePrice === 'number' ? snap.purchasePrice : inputValue,
              'Restored from production snapshot',
              JSON.stringify(snap.images || []),
              JSON.stringify(snap.attributes || {}),
              createdAt, createdAt,
            ]
          );
          restored++;
        } catch (err) {
          console.warn('[Migration] consumed backfill row failed:', productId, err);
        }
      }
    }

    // Sichere zusaetzlich: existierende Produkte die in production_inputs auftauchen
    // aber NICHT consumed sind (z.B. weil das alte DELETE schiefging) auf consumed.
    database.run(`
      UPDATE products
         SET stock_status = 'consumed'
       WHERE id IN (SELECT product_id FROM production_inputs)
         AND stock_status NOT IN ('consumed', 'CONSUMED')
    `);

    const now = new Date().toISOString();
    database.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES ('branch-main', 'migration.consumed_products_backfill_v1', '1', 'migration', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [now]
    );

    console.info(`[Migration] consumed products backfill v1: ${restored} Produkte wiederhergestellt.`);
  } catch (err) {
    console.warn('[Migration] consumed products backfill failed:', err);
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
      backfillStockLots(db);
      reconcileProductQuantities(db);
      backfillConsumedProducts(db);
    } catch (err) {
      console.warn('DB load failed, creating fresh:', err);
      db = new SQL.Database();
      db.run(SCHEMA);
      runMigrations(db);
      await seedFreshDatabase(db);
      migrateCategoriesToV2(db);
      migrateCategoriesToV3(db);
      backfillStockLots(db);
      reconcileProductQuantities(db);
      backfillConsumedProducts(db);
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
    backfillStockLots(db);
    reconcileProductQuantities(db);
    backfillConsumedProducts(db);
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

// ── Persistence-Mutex ─────────────────────────────────────────
//
// Vorher: jede Mutation rief saveDatabase() *ohne* await auf → mehrere
// fs.writeFile Aufrufe schrieben gleichzeitig in dieselbe Datei. Reihenfolge
// ist OS-abhaengig: ein langsamer alter Snapshot konnte einen frischen
// ueberschreiben → User sah seine Aenderung nach Restart wieder verschwinden.
// Auch der Mobile-Sync-Pull konnte so mit einem stale in-memory Schnappschuss
// ueberschrieben werden.
//
// Jetzt: parallele saveDatabase()-Aufrufe werden koalesziert. Es laeuft
// IMMER nur ein writeFile gleichzeitig. Setzt jemand "dirty" waehrend ein
// Save laeuft, dreht die Schleife eine weitere Runde — am Ende ist garantiert
// der allerletzte In-Memory-State auf der Platte.
let saveInFlight: Promise<void> | null = null;
let dirty = false;

async function drainSaves(): Promise<void> {
  try {
    while (dirty && db) {
      dirty = false;
      const data = db.export();
      try {
        await persistDb(data);
      } catch (err) {
        console.error('[DB] persistDb failed, will retry on next save:', err);
        dirty = true; // naechster saveDatabase()-Caller probiert es nochmal
        break;
      }
    }
  } finally {
    saveInFlight = null;
  }
}

export function saveDatabase(): Promise<void> {
  if (!db) return Promise.resolve();
  dirty = true;
  if (saveInFlight) return saveInFlight;
  saveInFlight = drainSaves();
  return saveInFlight;
}

// Wartet bis alle pending writes durch sind. MUSS vor App-Quit awaited werden,
// sonst killt der OS den Prozess waehrend ein writeFile noch laeuft.
export async function flushDatabase(): Promise<void> {
  // Mehrere Runden falls neue Mutations *waehrend* dem Drain kommen.
  for (let i = 0; i < 10; i++) {
    if (saveInFlight) await saveInFlight;
    if (!dirty) return;
    saveDatabase();
  }
}

// Synchroner Flush fuer Browser beforeunload (localStorage.setItem blockiert).
// Nicht fuer Tauri verwenden — dort macht App.tsx einen async flushDatabase()
// im CloseRequested-Handler.
export function flushDatabaseSync(): void {
  if (!db || isTauri()) return;
  try {
    const data = db.export();
    persistDbSync(data);
  } catch (err) {
    console.error('[DB] flushDatabaseSync failed:', err);
  }
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
