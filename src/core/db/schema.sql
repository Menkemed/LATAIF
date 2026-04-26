-- ═══════════════════════════════════════════════════════════
-- LATAIF — Production Database Schema
-- Multi-Tenant, Multi-Branch, Offline-First, Sync-Ready
-- ═══════════════════════════════════════════════════════════

-- ── TENANTS (one per company / customer) ──
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,        -- url-safe identifier
  plan        TEXT DEFAULT 'starter',      -- starter, professional, enterprise
  logo_path   TEXT,
  primary_color TEXT DEFAULT '#C6A36D',    -- white-label branding
  active      INTEGER DEFAULT 1,
  max_branches INTEGER DEFAULT 3,
  max_users    INTEGER DEFAULT 10,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ── BRANCHES ──
CREATE TABLE IF NOT EXISTS branches (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  country     TEXT DEFAULT 'BH',
  currency    TEXT DEFAULT 'BHD',
  address     TEXT,
  phone       TEXT,
  email       TEXT,
  logo_path   TEXT,
  active      INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ── USERS & AUTH ──
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  avatar_path   TEXT,
  active        INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(tenant_id, email)
);

CREATE TABLE IF NOT EXISTS user_branches (
  user_id    TEXT NOT NULL REFERENCES users(id),
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  role       TEXT NOT NULL DEFAULT 'viewer',  -- owner, manager, sales, backoffice, viewer
  is_default INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  branch_id   TEXT NOT NULL REFERENCES branches(id),
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ── CATEGORIES ──
CREATE TABLE IF NOT EXISTS categories (
  id                TEXT PRIMARY KEY,
  branch_id         TEXT NOT NULL REFERENCES branches(id),
  name              TEXT NOT NULL,
  icon              TEXT DEFAULT 'Package',
  color             TEXT DEFAULT '#C6A36D',
  attributes        TEXT DEFAULT '[]',   -- JSON: CategoryAttribute[]
  scope_options     TEXT DEFAULT '[]',   -- JSON: string[]
  condition_options TEXT DEFAULT '[]',   -- JSON: string[]
  active            INTEGER DEFAULT 1,
  sort_order        INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER DEFAULT 1,
  sync_status       TEXT DEFAULT 'synced'  -- synced, pending, conflict
);

-- ── PRODUCTS ──
CREATE TABLE IF NOT EXISTS products (
  id                 TEXT PRIMARY KEY,
  branch_id          TEXT NOT NULL REFERENCES branches(id),
  category_id        TEXT NOT NULL REFERENCES categories(id),
  brand              TEXT NOT NULL,
  name               TEXT NOT NULL,
  sku                TEXT,
  condition          TEXT,
  scope_of_delivery  TEXT DEFAULT '[]',   -- JSON
  storage_location   TEXT,
  purchase_date      TEXT,
  purchase_price     REAL NOT NULL,
  purchase_currency  TEXT DEFAULT 'BHD',
  planned_sale_price REAL,
  min_sale_price     REAL,
  max_sale_price     REAL,
  last_offer_price   REAL,
  last_sale_price    REAL,
  stock_status       TEXT DEFAULT 'in_stock',
  tax_scheme         TEXT DEFAULT 'MARGIN',
  expected_margin    REAL,
  days_in_stock      INTEGER DEFAULT 0,
  supplier_name      TEXT,
  notes              TEXT,
  images             TEXT DEFAULT '[]',   -- JSON: string[] (local paths or URLs)
  attributes         TEXT DEFAULT '{}',   -- JSON: dynamic category fields
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  created_by         TEXT REFERENCES users(id),
  version            INTEGER DEFAULT 1,
  sync_status        TEXT DEFAULT 'synced'
);

-- ── CUSTOMERS ──
CREATE TABLE IF NOT EXISTS customers (
  id               TEXT PRIMARY KEY,
  branch_id        TEXT NOT NULL REFERENCES branches(id),
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  company          TEXT,
  phone            TEXT,
  whatsapp         TEXT,
  email            TEXT,
  country          TEXT DEFAULT 'BH',
  language         TEXT DEFAULT 'en',
  budget_min       REAL,
  budget_max       REAL,
  vip_level        INTEGER DEFAULT 0,
  preferences      TEXT DEFAULT '[]',    -- JSON
  customer_type    TEXT DEFAULT 'collector',
  sales_stage      TEXT DEFAULT 'lead',
  last_contact_at  TEXT,
  last_purchase_at TEXT,
  total_revenue    REAL DEFAULT 0,
  total_profit     REAL DEFAULT 0,
  purchase_count   INTEGER DEFAULT 0,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  created_by       TEXT REFERENCES users(id),
  version          INTEGER DEFAULT 1,
  sync_status      TEXT DEFAULT 'synced'
);

-- ── OFFERS ──
CREATE TABLE IF NOT EXISTS offers (
  id           TEXT PRIMARY KEY,
  branch_id    TEXT NOT NULL REFERENCES branches(id),
  offer_number TEXT NOT NULL,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  status       TEXT DEFAULT 'draft',
  valid_until  TEXT,
  currency     TEXT DEFAULT 'BHD',
  subtotal     REAL NOT NULL DEFAULT 0,
  vat_rate     REAL,
  vat_amount   REAL DEFAULT 0,
  total        REAL NOT NULL DEFAULT 0,
  tax_scheme   TEXT,
  notes        TEXT,
  sent_at      TEXT,
  sent_via     TEXT,
  follow_up_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id),
  version      INTEGER DEFAULT 1,
  sync_status  TEXT DEFAULT 'synced',
  UNIQUE(branch_id, offer_number)
);

CREATE TABLE IF NOT EXISTS offer_lines (
  id         TEXT PRIMARY KEY,
  offer_id   TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  unit_price REAL NOT NULL,
  vat_rate   REAL,
  tax_scheme TEXT,
  line_total REAL NOT NULL,
  position   INTEGER DEFAULT 1
);

-- ── INVOICES (immutable after issued) ──
CREATE TABLE IF NOT EXISTS invoices (
  id                      TEXT PRIMARY KEY,
  branch_id               TEXT NOT NULL REFERENCES branches(id),
  invoice_number          TEXT NOT NULL,
  offer_id                TEXT REFERENCES offers(id),
  customer_id             TEXT NOT NULL REFERENCES customers(id),
  status                  TEXT DEFAULT 'draft',
  currency                TEXT DEFAULT 'BHD',
  net_amount              REAL NOT NULL,
  vat_rate_snapshot        REAL NOT NULL,
  vat_amount              REAL NOT NULL,
  gross_amount            REAL NOT NULL,
  tax_scheme_snapshot     TEXT NOT NULL,  -- 'VAT_10', 'MARGIN', 'ZERO', or 'mixed'
  purchase_price_snapshot REAL,
  sale_price_snapshot     REAL,
  margin_snapshot         REAL,
  paid_amount             REAL DEFAULT 0,
  issued_at               TEXT,
  due_at                  TEXT,
  notes                   TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  created_by              TEXT REFERENCES users(id),
  version                 INTEGER DEFAULT 1,
  sync_status             TEXT DEFAULT 'synced',
  UNIQUE(branch_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                      TEXT PRIMARY KEY,
  invoice_id              TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id              TEXT NOT NULL REFERENCES products(id),
  description             TEXT,
  unit_price              REAL NOT NULL,
  purchase_price_snapshot REAL,
  vat_rate                REAL NOT NULL,
  tax_scheme              TEXT NOT NULL,
  vat_amount              REAL NOT NULL,
  line_total              REAL NOT NULL,
  position                INTEGER DEFAULT 1
);

-- ── PAYMENTS ──
CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branches(id),
  invoice_id  TEXT NOT NULL REFERENCES invoices(id),
  amount      REAL NOT NULL,
  method      TEXT DEFAULT 'bank_transfer',
  reference   TEXT,
  received_at TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  version     INTEGER DEFAULT 1,
  sync_status TEXT DEFAULT 'synced'
);

-- ── DOCUMENTS & IMAGES ──
CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  branch_id          TEXT NOT NULL REFERENCES branches(id),
  file_name          TEXT NOT NULL,
  file_path          TEXT NOT NULL,     -- local path
  file_type          TEXT,
  file_size          INTEGER,
  doc_class          TEXT DEFAULT 'other',
  linked_entity_type TEXT,
  linked_entity_id   TEXT,
  ocr_text           TEXT,
  ocr_confidence     REAL,
  ocr_reviewed       INTEGER DEFAULT 0,
  extracted_fields   TEXT,              -- JSON
  ai_suggestions     TEXT,              -- JSON: AI-generated field suggestions
  thumbnail_path     TEXT,
  created_at         TEXT NOT NULL,
  created_by         TEXT REFERENCES users(id),
  version            INTEGER DEFAULT 1,
  sync_status        TEXT DEFAULT 'synced'
);

-- ── TASKS ──
CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  branch_id          TEXT NOT NULL REFERENCES branches(id),
  title              TEXT NOT NULL,
  description        TEXT,
  type               TEXT DEFAULT 'general',
  priority           TEXT DEFAULT 'medium',
  due_at             TEXT,
  linked_entity_type TEXT,
  linked_entity_id   TEXT,
  assigned_to        TEXT REFERENCES users(id),
  status             TEXT DEFAULT 'open',
  auto_generated     INTEGER DEFAULT 0,
  created_at         TEXT NOT NULL,
  completed_at       TEXT,
  created_by         TEXT REFERENCES users(id),
  version            INTEGER DEFAULT 1,
  sync_status        TEXT DEFAULT 'synced'
);

-- ── EVENT LOG ──
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  branch_id    TEXT NOT NULL REFERENCES branches(id),
  event_type   TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  payload      TEXT NOT NULL,            -- JSON
  triggered_by TEXT DEFAULT 'system',
  processed    INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- ── SETTINGS (per branch) ──
CREATE TABLE IF NOT EXISTS settings (
  branch_id  TEXT NOT NULL REFERENCES branches(id),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  category   TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, key)
);

-- ── SYNC CHANGELOG ──
CREATE TABLE IF NOT EXISTS sync_changelog (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  branch_id   TEXT NOT NULL,
  action      TEXT NOT NULL,     -- insert, update, delete
  data        TEXT NOT NULL,     -- JSON: full record snapshot
  synced      INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- ── KPI CACHE ──
CREATE TABLE IF NOT EXISTS kpi_cache (
  branch_id   TEXT NOT NULL,
  kpi_id      TEXT NOT NULL,
  period      TEXT NOT NULL,
  value       TEXT NOT NULL,     -- JSON
  computed_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, kpi_id, period)
);

-- ═══════════════════════════════════════════════════════════
-- BUSINESS PROCESS TABLES
-- Repair, Consignment, Agent Sales, Orders
-- ═══════════════════════════════════════════════════════════

-- ── REPAIRS ──
CREATE TABLE IF NOT EXISTS repairs (
  id                TEXT PRIMARY KEY,
  branch_id         TEXT NOT NULL REFERENCES branches(id),
  repair_number     TEXT NOT NULL,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  product_id        TEXT REFERENCES products(id),        -- if product exists in system
  -- Watch/Item info (if not in product table)
  item_brand        TEXT,
  item_model        TEXT,
  item_reference    TEXT,
  item_serial       TEXT,
  item_description  TEXT,
  -- Repair details
  issue_description TEXT NOT NULL,                       -- what's wrong
  diagnosis         TEXT,                                -- what we found
  repair_type       TEXT DEFAULT 'internal',             -- internal, external, hybrid
  external_vendor   TEXT,                                -- if sent to external
  -- Costs
  estimated_cost    REAL,
  actual_cost       REAL,
  internal_cost     REAL DEFAULT 0,                      -- our cost (parts, labor)
  charge_to_customer REAL,                               -- what customer pays
  margin            REAL,                                -- charge - internal_cost
  -- Status
  status            TEXT DEFAULT 'received',             -- received, diagnosed, in_progress, ready, picked_up, cancelled
  -- Dates
  received_at       TEXT NOT NULL,
  diagnosed_at      TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  picked_up_at      TEXT,
  estimated_ready   TEXT,
  -- Voucher
  voucher_code      TEXT UNIQUE,
  -- Linked invoice
  invoice_id        TEXT REFERENCES invoices(id),
  -- Meta
  notes             TEXT,
  images            TEXT DEFAULT '[]',                   -- JSON: before/after photos
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  created_by        TEXT REFERENCES users(id),
  version           INTEGER DEFAULT 1,
  sync_status       TEXT DEFAULT 'synced',
  UNIQUE(branch_id, repair_number)
);

-- ── CONSIGNMENTS ──
CREATE TABLE IF NOT EXISTS consignments (
  id                TEXT PRIMARY KEY,
  branch_id         TEXT NOT NULL REFERENCES branches(id),
  consignment_number TEXT NOT NULL,
  consignor_id      TEXT NOT NULL REFERENCES customers(id),  -- the owner giving us the item
  product_id        TEXT NOT NULL REFERENCES products(id),   -- the item in our stock
  -- Agreement
  agreed_price      REAL NOT NULL,                           -- what consignor wants
  minimum_price     REAL,                                    -- lowest we can sell for
  commission_rate   REAL NOT NULL DEFAULT 15,                -- our commission %
  commission_amount REAL,                                    -- calculated on sale
  -- Payout
  payout_amount     REAL,                                    -- consignor receives
  payout_status     TEXT DEFAULT 'pending',                  -- pending, paid, returned
  payout_method     TEXT,
  payout_date       TEXT,
  payout_reference  TEXT,
  -- Status
  status            TEXT DEFAULT 'active',                   -- active, sold, paid_out, returned, expired
  -- Agreement
  agreement_date    TEXT NOT NULL,
  expiry_date       TEXT,                                    -- when consignment expires
  -- Sale reference
  sale_price        REAL,                                    -- actual sale price
  buyer_id          TEXT REFERENCES customers(id),           -- who bought it
  invoice_id        TEXT REFERENCES invoices(id),            -- sale invoice
  -- Meta
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  created_by        TEXT REFERENCES users(id),
  version           INTEGER DEFAULT 1,
  sync_status       TEXT DEFAULT 'synced',
  UNIQUE(branch_id, consignment_number)
);

-- ── AGENTS (external sellers) ──
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  branch_id       TEXT NOT NULL REFERENCES branches(id),
  name            TEXT NOT NULL,
  company         TEXT,
  phone           TEXT,
  whatsapp        TEXT,
  email           TEXT,
  commission_rate REAL DEFAULT 10,                        -- default commission %
  active          INTEGER DEFAULT 1,
  notes           TEXT,
  total_sales     REAL DEFAULT 0,
  total_commission REAL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version         INTEGER DEFAULT 1,
  sync_status     TEXT DEFAULT 'synced'
);

-- ── AGENT TRANSFERS ──
CREATE TABLE IF NOT EXISTS agent_transfers (
  id              TEXT PRIMARY KEY,
  branch_id       TEXT NOT NULL REFERENCES branches(id),
  transfer_number TEXT NOT NULL,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  product_id      TEXT NOT NULL REFERENCES products(id),
  -- Pricing
  agent_price     REAL NOT NULL,                          -- price agent should sell at
  minimum_price   REAL,                                   -- lowest acceptable
  commission_rate REAL NOT NULL,                          -- commission for this transfer
  commission_amount REAL,                                 -- calculated on sale
  -- Status
  status          TEXT DEFAULT 'transferred',             -- transferred, sold, returned, settled
  -- Transfer dates
  transferred_at  TEXT NOT NULL,
  return_by       TEXT,                                   -- deadline to return
  sold_at         TEXT,
  returned_at     TEXT,
  settled_at      TEXT,
  -- Sale info
  actual_sale_price REAL,
  buyer_info      TEXT,
  invoice_id      TEXT REFERENCES invoices(id),
  -- Settlement
  settlement_amount REAL,                                 -- what we receive after commission
  settlement_status TEXT DEFAULT 'pending',               -- pending, paid
  -- Meta
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES users(id),
  version         INTEGER DEFAULT 1,
  sync_status     TEXT DEFAULT 'synced',
  UNIQUE(branch_id, transfer_number)
);

-- ── ORDERS (Pre-Orders / Sourcing) ──
CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  branch_id             TEXT NOT NULL REFERENCES branches(id),
  order_number          TEXT NOT NULL,
  customer_id           TEXT NOT NULL REFERENCES customers(id),
  -- What they want
  requested_brand       TEXT NOT NULL,
  requested_model       TEXT NOT NULL,
  requested_reference   TEXT,
  requested_details     TEXT,                              -- JSON or text: specific requirements
  -- Pricing
  agreed_price          REAL,
  deposit_amount        REAL DEFAULT 0,
  deposit_paid          INTEGER DEFAULT 0,                 -- boolean
  deposit_date          TEXT,
  remaining_amount      REAL,
  -- Sourcing
  supplier_name         TEXT,
  supplier_price        REAL,                              -- our cost
  expected_margin       REAL,                              -- agreed_price - supplier_price
  expected_delivery     TEXT,                              -- date
  actual_delivery       TEXT,
  -- Status
  status                TEXT DEFAULT 'pending',            -- pending, deposit_received, sourcing, sourced, arrived, notified, completed, cancelled
  -- Fulfillment
  product_id            TEXT REFERENCES products(id),      -- once item arrives and is in stock
  invoice_id            TEXT REFERENCES invoices(id),      -- final invoice
  -- Meta
  notes                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  created_by            TEXT REFERENCES users(id),
  version               INTEGER DEFAULT 1,
  sync_status           TEXT DEFAULT 'synced',
  UNIQUE(branch_id, order_number)
);

-- ── PRECIOUS METALS ──
CREATE TABLE IF NOT EXISTS precious_metals (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  metal_type TEXT NOT NULL, -- gold, silver, platinum
  karat TEXT, -- 24K, 22K, 21K, 18K, 14K, 9K, 999, 925, 950
  weight_grams REAL NOT NULL,
  description TEXT,
  purchase_price_per_gram REAL,
  purchase_total REAL,
  spot_price_at_purchase REAL,
  current_spot_price REAL,
  melt_value REAL, -- weight * purity * spot price
  sale_price REAL,
  status TEXT DEFAULT 'in_stock', -- in_stock, sold, melted
  supplier_name TEXT,
  customer_id TEXT REFERENCES customers(id),
  notes TEXT,
  images TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_metals_branch ON precious_metals(branch_id);

-- ═══════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════

-- ── INDEXES ──
CREATE INDEX IF NOT EXISTS idx_products_branch ON products(branch_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(stock_status);
CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers(branch_id);
CREATE INDEX IF NOT EXISTS idx_customers_stage ON customers(sales_stage);
CREATE INDEX IF NOT EXISTS idx_offers_branch ON offers(branch_id);
CREATE INDEX IF NOT EXISTS idx_offers_customer ON offers(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_branch ON invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_tasks_branch ON tasks(branch_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_pending ON sync_changelog(synced) WHERE synced = 0;
CREATE INDEX IF NOT EXISTS idx_documents_linked ON documents(linked_entity_type, linked_entity_id);

-- Business process indexes
CREATE INDEX IF NOT EXISTS idx_repairs_branch ON repairs(branch_id);
CREATE INDEX IF NOT EXISTS idx_repairs_customer ON repairs(customer_id);
CREATE INDEX IF NOT EXISTS idx_repairs_status ON repairs(status);
CREATE INDEX IF NOT EXISTS idx_repairs_voucher ON repairs(voucher_code);
CREATE INDEX IF NOT EXISTS idx_consignments_branch ON consignments(branch_id);
CREATE INDEX IF NOT EXISTS idx_consignments_consignor ON consignments(consignor_id);
CREATE INDEX IF NOT EXISTS idx_consignments_product ON consignments(product_id);
CREATE INDEX IF NOT EXISTS idx_consignments_status ON consignments(status);
CREATE INDEX IF NOT EXISTS idx_agents_branch ON agents(branch_id);
CREATE INDEX IF NOT EXISTS idx_agent_transfers_branch ON agent_transfers(branch_id);
CREATE INDEX IF NOT EXISTS idx_agent_transfers_agent ON agent_transfers(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_transfers_product ON agent_transfers(product_id);
CREATE INDEX IF NOT EXISTS idx_agent_transfers_status ON agent_transfers(status);
CREATE INDEX IF NOT EXISTS idx_orders_branch ON orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
