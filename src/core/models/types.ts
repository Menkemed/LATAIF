// ═══════════════════════════════════════════════════════════
// LATAIF — Core Domain Models
// Multi-Category Luxury Trading System
// ═══════════════════════════════════════════════════════════

export type UUID = string;
export type Currency = 'BHD' | 'USD' | 'EUR' | 'GBP' | 'SAR' | 'AED';
// Plan §Tax §3: kanonische Namen VAT_10 / ZERO / MARGIN.
// Legacy-Namen bleiben zur Laufzeit akzeptiert (via canonicalTaxScheme), Typ ist aber canonical-only.
export type TaxSchemeCanonical = 'VAT_10' | 'ZERO' | 'MARGIN';
export type TaxScheme = TaxSchemeCanonical;
export type InvoiceTaxScheme = TaxScheme | 'mixed';

// Helper: akzeptiert jede Variante, normalisiert auf canonical.
export function canonicalTaxScheme(s: string | undefined | null): TaxSchemeCanonical {
  if (s === 'standard') return 'VAT_10';
  if (s === 'margin') return 'MARGIN';
  if (s === 'exempt') return 'ZERO';
  if (s === 'VAT_10' || s === 'ZERO' || s === 'MARGIN') return s;
  return 'MARGIN'; // safe default
}

// ── Category System ──

export type AttributeType = 'text' | 'number' | 'select' | 'multiselect' | 'boolean';

export interface CategoryAttribute {
  key: string;           // e.g. "movement", "carat", "material"
  label: string;         // e.g. "Movement", "Carat Weight", "Material"
  type: AttributeType;
  options?: string[];    // for select/multiselect
  required: boolean;
  unit?: string;         // e.g. "mm", "ct", "g"
  showInList: boolean;   // show in collection list view
  // Optional: nur sichtbar (und nur dann required), wenn ein anderes Attribut
  // einen bestimmten Wert hat. Beispiel: karat_color hängt von material ab.
  dependsOn?: {
    key: string;
    valueIncludes: string[];
  };
}

export interface Category {
  id: UUID;
  name: string;          // "Watches", "Jewelry", "Bags", etc.
  icon: string;          // lucide icon name
  color: string;         // accent color for this category
  attributes: CategoryAttribute[];
  scopeOptions: string[]; // e.g. ["box", "papers", "dust_bag", "certificate"]
  conditionOptions: string[]; // e.g. ["new", "pre_owned", "vintage"]
  active: boolean;
  sortOrder: number;
  createdAt: string;
}

// ── Product (universal, replaces Watch) ──

// Plan §Product §6: Canonical status set.
// Legacy-Werte (in_stock/reserved/offered/sold/consignment/in_repair/with_agent/on_order)
// bleiben als Union für Back-Compat erlaubt; canonicalStockStatus() normalisiert.
export type CanonicalStockStatus = 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'GIVEN_TO_AGENT' | 'UNDER_REPAIR' | 'RETURNED' | 'WRITE_OFF' | 'CONSUMED';
export type StockStatus =
  | CanonicalStockStatus
  | 'in_stock' | 'reserved' | 'offered' | 'sold' | 'consignment' | 'consignment_reserved'
  | 'in_repair' | 'with_agent' | 'on_order' | 'consumed';

export function canonicalStockStatus(s: StockStatus | string | undefined | null): CanonicalStockStatus {
  const v = String(s || '').toLowerCase();
  if (v === 'in_stock' || v === 'consignment' || v === 'offered') return 'IN_STOCK';
  if (v === 'reserved' || v === 'consignment_reserved') return 'RESERVED';
  if (v === 'sold') return 'SOLD';
  if (v === 'with_agent' || v === 'given_to_agent') return 'GIVEN_TO_AGENT';
  if (v === 'in_repair' || v === 'under_repair') return 'UNDER_REPAIR';
  if (v === 'returned') return 'RETURNED';
  if (v === 'write_off') return 'WRITE_OFF';
  if (v === 'consumed') return 'CONSUMED';
  if (v === 'on_order') return 'RESERVED';
  return 'IN_STOCK';
}

export type OwnershipType = 'owned' | 'consignment';

// Plan §Product §5: source_type = OWN / CONSIGNMENT / AGENT
export type ProductSourceType = 'OWN' | 'CONSIGNMENT' | 'AGENT';

export interface Product {
  id: UUID;
  categoryId: UUID;
  // Universal fields
  brand: string;
  name: string;           // model/title/description
  sku?: string;           // internal reference
  quantity: number;       // Stückzahl (default 1, kann beim Import oder manuell gesetzt werden)
  condition: string;
  scopeOfDelivery: string[];
  storageLocation?: string;
  purchaseDate?: string;
  purchasePrice: number;
  purchaseCurrency: Currency;
  plannedSalePrice?: number;
  minSalePrice?: number;
  maxSalePrice?: number;
  lastOfferPrice?: number;
  lastSalePrice?: number;
  stockStatus: StockStatus;
  taxScheme: TaxScheme;
  expectedMargin?: number;
  daysInStock?: number;
  supplierName?: string;
  purchaseSource?: string;
  paidFrom?: 'cash' | 'bank' | 'benefit' | null;
  sourceType: ProductSourceType;
  notes?: string;
  images: string[];
  /** Plan §Image-Duplicate-Detection: perceptual hash des ersten Bildes (16-stelliger Hex / 64bit DCT-pHash). */
  imageHash?: string;
  /** Plan §AI-Embedding: gpt-4o-mini Vision-Description des ersten Bildes (Cache fürs Embedding). */
  imageDescription?: string;
  /** Plan §AI-Embedding: text-embedding-3-small Vektor (1536 Dim) der Description. */
  imageEmbedding?: number[];
  /** Plan §AI-Learning (2026-05-18) — Snapshot dessen was die AI beim letzten
   *  Identify vorgeschlagen hat (JSON). Wird benutzt um spaeter user-Korrekturen
   *  zu erkennen (diff aktueller Wert vs Snapshot). */
  aiIdentifiedSnapshot?: string;
  /** Plan §AI-Learning — Liste der Felder die der User nach AI-Identify
   *  korrigiert hat. JSON-Array: [{ field, aiSaid, userChanged, at }].
   *  Wird beim naechsten Identify als Few-Shot-Example an die AI gegeben. */
  aiCorrections?: string;
  /** Plan §AI-Learning — Zeitpunkt an dem der User die AI-Identifikation
   *  explizit bestaetigt hat ("AI hatte recht"). Bestaetigte Items werden bei
   *  naechsten Identifies als POSITIVE Few-Shot-Examples mitgegeben. */
  aiConfirmedAt?: string;
  // Dynamic attributes (category-specific)
  attributes: Record<string, string | number | boolean | string[]>;
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  // Populated
  category?: Category;
}

// ── Customer ──

export type VIPLevel = 0 | 1 | 2 | 3;
// Plan §Customer §3: Retail / Consignment / Loan Contact / Partner.
// Legacy-Werte (collector/dealer/investor/gift_buyer) bleiben erlaubt.
export type CanonicalCustomerType = 'RETAIL' | 'CONSIGNMENT' | 'LOAN_CONTACT' | 'PARTNER';
export type CustomerType =
  | CanonicalCustomerType
  | 'collector' | 'dealer' | 'investor' | 'gift_buyer';

export function canonicalCustomerType(t: CustomerType | string | undefined | null): CanonicalCustomerType {
  const v = String(t || '').toLowerCase();
  if (v === 'consignment') return 'CONSIGNMENT';
  if (v === 'loan_contact' || v === 'loan') return 'LOAN_CONTACT';
  if (v === 'partner') return 'PARTNER';
  return 'RETAIL'; // collector/dealer/investor/gift_buyer/retail → RETAIL
}
export type SalesStage = 'lead' | 'qualified' | 'active' | 'dormant' | 'lost';

export interface Customer {
  id: UUID;
  firstName: string;
  lastName: string;
  company?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  country: string;
  language: string;
  budgetMin?: number;
  budgetMax?: number;
  vipLevel: VIPLevel;
  preferences: string[];
  customerType: CustomerType;
  salesStage: SalesStage;
  lastContactAt?: string;
  lastPurchaseAt?: string;
  totalRevenue: number;
  totalProfit: number;
  purchaseCount: number;
  vatAccountNumber?: string;
  personalId?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
}

// ── Offer ──

export type OfferStatus = 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired';

export interface OfferLine {
  id: UUID;
  offerId: UUID;
  productId: UUID;
  unitPrice: number;
  vatRate: number;
  taxScheme: TaxScheme;
  lineTotal: number;
  position: number;
  product?: Product;
}

export interface Offer {
  id: UUID;
  offerNumber: string;
  customerId: UUID;
  status: OfferStatus;
  validUntil?: string;
  currency: Currency;
  subtotal: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  taxScheme: TaxScheme;
  notes?: string;
  sentAt?: string;
  sentVia?: 'email' | 'whatsapp' | 'in_person';
  followUpAt?: string;
  lines: OfferLine[];
  // Plan §8 #10 — Roundtrip zur erzeugten Invoice (wird bei Storno zurückgesetzt).
  invoiceId?: UUID;
  createdAt: string;
  createdBy?: UUID;
  customer?: Customer;
}

// ── Invoice ──

// Plan §Sales §2: Partial Invoice (PINV) + Final Invoice (INV). Storno (§14).
export type InvoiceStatus = 'DRAFT' | 'PARTIAL' | 'FINAL' | 'CANCELLED' | 'RETURNED';

export interface InvoiceLine {
  id: UUID;
  invoiceId: UUID;
  productId: UUID;
  description?: string;
  quantity: number;             // Default 1; nur sichtbar im UI wenn Produkt-Bestand > 1
  unitPrice: number;
  purchasePriceSnapshot: number;
  vatRate: number;
  taxScheme: TaxScheme;
  vatAmount: number;
  lineTotal: number;
  position: number;
  product?: Product;
}

export interface Invoice {
  id: UUID;
  invoiceNumber: string;
  offerId?: UUID;
  customerId: UUID;
  status: InvoiceStatus;
  currency: Currency;
  netAmount: number;
  vatRateSnapshot: number;
  vatAmount: number;
  grossAmount: number;
  taxSchemeSnapshot: InvoiceTaxScheme;
  purchasePriceSnapshot?: number;
  salePriceSnapshot?: number;
  marginSnapshot?: number;
  paidAmount: number;
  tipAmount?: number;
  butterfly?: boolean;
  issuedAt?: string;
  dueAt?: string;
  notes?: string;
  lines: InvoiceLine[];
  // Wave-2: einheitliches Staff-Feld — welcher Mitarbeiter den Sale gemacht hat.
  staffId?: UUID;
  // 2026-05-16 — Optischer Marker fuer Final-Invoices ("Special" vs "Normal").
  // true = Display mit Punkt-Praefix (`.000021` / `.Repair-000021`); false/undef = ohne.
  specialMark?: boolean;
  createdAt: string;
  createdBy?: UUID;
  customer?: Customer;
}

// ── Payment ──

export type PaymentMethod = 'bank_transfer' | 'cash' | 'card' | 'benefit' | 'other';

export interface Payment {
  id: UUID;
  invoiceId: UUID;
  amount: number;
  method: PaymentMethod;
  receivedAt: string;
  notes?: string;
  createdAt: string;
}

// ── Document ──

export type DocumentClass = 'invoice' | 'receipt' | 'certificate' | 'warranty' | 'photo' | 'note' | 'other';
export type LinkedEntityType = 'customer' | 'product' | 'offer' | 'invoice' | 'repair' | 'consignment' | 'agent_transfer' | 'order';

export interface Document {
  id: UUID;
  filePath: string;
  fileType: string;
  docClass: DocumentClass;
  linkedEntityType?: LinkedEntityType;
  linkedEntityId?: UUID;
  ocrText?: string;
  ocrConfidence?: number;
  ocrReviewed: boolean;
  extractedFields?: Record<string, string>;
  createdAt: string;
}

// ── Task ──

export type TaskType = 'follow_up' | 'review' | 'price_check' | 'reactivation' | 'payment_reminder' | 'repair_ready' | 'consignment_expiry' | 'agent_return' | 'order_delivery' | 'general';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';

export interface Task {
  id: UUID;
  title: string;
  description?: string;
  type: TaskType;
  priority: TaskPriority;
  dueAt?: string;
  linkedEntityType?: LinkedEntityType;
  linkedEntityId?: UUID;
  assignedTo?: UUID;
  status: TaskStatus;
  autoGenerated: boolean;
  createdAt: string;
  completedAt?: string;
}

// ── Event ──

export type EventType =
  // Product
  | 'product.created' | 'product.updated' | 'product.sold' | 'product.price_changed'
  // Customer
  | 'customer.created' | 'customer.updated' | 'customer.dormant'
  // Offer
  | 'offer.created' | 'offer.sent' | 'offer.accepted' | 'offer.rejected' | 'offer.expired'
  // Invoice
  | 'invoice.created' | 'invoice.issued' | 'invoice.paid' | 'invoice.overdue'
  | 'payment.received'
  // Documents
  | 'document.uploaded' | 'document.ocr_completed' | 'document.ocr_needs_review'
  // Tasks
  | 'task.created' | 'task.completed' | 'task.overdue'
  // Repair
  | 'repair.created' | 'repair.diagnosed' | 'repair.started' | 'repair.completed' | 'repair.ready' | 'repair.picked_up'
  // Consignment
  | 'consignment.created' | 'consignment.sold' | 'consignment.paid_out' | 'consignment.returned' | 'consignment.expired'
  | 'consignment.sale_recorded' | 'consignment.sale_cancelled'
  // Agent
  | 'agent.created' | 'agent_transfer.created' | 'agent_transfer.sold' | 'agent_transfer.returned' | 'agent_transfer.settled' | 'agent_transfer.invoice_created' | 'agent_transfer.invoice_undone'
  // Order
  | 'order.created' | 'order.deposit_received' | 'order.sourced' | 'order.arrived' | 'order.notified' | 'order.completed' | 'order.cancelled'
  // System
  | 'stock.value_changed'
  | 'category.created' | 'category.updated'
  | 'kpi.refresh_needed';

export interface DomainEvent {
  id: UUID;
  type: EventType;
  entityType: string;
  entityId: UUID;
  payload: Record<string, unknown>;
  triggeredBy: string;
  processed: boolean;
  createdAt: string;
}

// ── User / Role ──

// Plan §Users §4 — kanonische Rollen: ADMIN / MANAGER / SALES / ACCOUNTANT
// Legacy-Werte (owner/backoffice/viewer) werden via canonicalRole() abgebildet.
export type UserRole = 'ADMIN' | 'MANAGER' | 'SALES' | 'ACCOUNTANT'
  | 'owner' | 'manager' | 'sales' | 'backoffice' | 'viewer';

export type CanonicalUserRole = 'ADMIN' | 'MANAGER' | 'SALES' | 'ACCOUNTANT';

export function canonicalRole(r: UserRole | string | undefined | null): CanonicalUserRole {
  if (r === 'owner' || r === 'ADMIN') return 'ADMIN';
  if (r === 'manager' || r === 'MANAGER') return 'MANAGER';
  if (r === 'sales' || r === 'SALES') return 'SALES';
  if (r === 'backoffice' || r === 'ACCOUNTANT') return 'ACCOUNTANT';
  if (r === 'viewer') return 'SALES';  // Downgrade Viewer to most-limited canonical role
  return 'SALES';
}

// Plan §Users §5: granular action types
export type PermissionAction = 'VIEW' | 'CREATE' | 'EDIT' | 'DELETE' | 'APPROVE';

export interface User {
  id: UUID;
  name: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface Setting {
  key: string;
  value: string;
  category: string;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════
// BUSINESS PROCESSES
// ═══════════════════════════════════════════════════════════

// ── Repair ──

// Plan §Repair §6: RECEIVED / IN_PROGRESS / SENT_TO_WORKSHOP / READY / DELIVERED / CANCELLED.
// Legacy (received/diagnosed/in_progress/ready/picked_up/cancelled) bleibt erlaubt.
export type CanonicalRepairStatus = 'RECEIVED' | 'IN_PROGRESS' | 'SENT_TO_WORKSHOP' | 'READY' | 'DELIVERED' | 'CANCELLED';
export type RepairStatus =
  | CanonicalRepairStatus
  | 'received' | 'diagnosed' | 'in_progress' | 'sent_to_workshop' | 'ready' | 'picked_up' | 'cancelled'
  // User-Spec §Repair Return: Ware geht ohne Reparatur zurück (nicht reparierbar,
  // Kunde will nicht, wirtschaftlich nicht sinnvoll, nur Diagnose). Terminal — wie
  // 'picked_up' und 'cancelled'.
  | 'returned';

export function canonicalRepairStatus(s: RepairStatus | string | undefined | null): CanonicalRepairStatus {
  const v = String(s || '').toLowerCase();
  if (v === 'received') return 'RECEIVED';
  if (v === 'diagnosed' || v === 'in_progress') return 'IN_PROGRESS';
  if (v === 'sent_to_workshop') return 'SENT_TO_WORKSHOP';
  if (v === 'ready') return 'READY';
  if (v === 'picked_up' || v === 'delivered') return 'DELIVERED';
  if (v === 'cancelled') return 'CANCELLED';
  return (String(s || 'RECEIVED').toUpperCase() as CanonicalRepairStatus);
}

export interface Repair {
  id: UUID;
  repairNumber: string;
  // Plan §Repair §Own-Item: zwei Varianten — Kundenreparatur (CUSTOMER) oder eigenes
  // Inventar-Repair (OWN). Bei OWN ist customerId ein internes Sentinel
  // (sys-own-shop-{branchId}), wird in der UI nicht angezeigt; Kosten gehen direkt
  // auf das verlinkte Produkt (productId Pflicht), keine Charge / kein Invoice.
  repairScope?: 'CUSTOMER' | 'OWN';
  customerId: UUID;
  productId?: UUID;
  // Stock-Lots Phase 5d (Refinement): bei OWN-Repair waehlt der User explizit
  // welcher Lot des verlinkten Produkts den Repair-Cost kapitalisiert. Wird beim
  // READY-Uebergang in unit_cost dieses Lots eingebucht. Optional — Fallback
  // = aeltester ACTIVE Lot des Produkts (FIFO-konsistent zur Sale-Konsumption).
  lotId?: UUID;
  // Plan §Repair §Item-Details: kategorie-basierte Erfassung (vereinfachte Variante
  // gegenüber Collection — nur die Kategorie + ein paar wichtige Felder pro Typ).
  itemCategoryId?: UUID;
  itemAttributes?: Record<string, string | number | boolean>;
  // Plan §Repair §Tax: Service-Invoice-Tax-Scheme. Default VAT_10, kann auf
  // ZERO gesetzt werden falls Service nicht VAT-pflichtig ist.
  taxScheme?: 'VAT_10' | 'ZERO';
  itemBrand?: string;
  itemModel?: string;
  itemReference?: string;
  itemSerial?: string;
  itemDescription?: string;
  issueDescription: string;
  diagnosis?: string;
  repairType: 'internal' | 'external' | 'hybrid';
  externalVendor?: string;
  // Plan §Repair §Workshop-as-Supplier: Workshop/Goldsmith ist ein Supplier-FK,
  // nicht mehr ein freier Text. Bei externer Repair-Auto-Expense wird supplier_id
  // gesetzt, sodass die offene Forderung in der Supplier-Bilanz erscheint.
  workshopSupplierId?: UUID;
  estimatedCost?: number;
  actualCost?: number;
  internalCost: number;
  chargeToCustomer?: number;
  customerPaidFrom?: 'cash' | 'bank' | 'benefit' | null;
  internalPaidFrom?: 'cash' | 'bank' | 'benefit' | null;
  // Plan §8 — Repair customer payment tracking
  customerPaidAmount?: number;
  customerPaymentStatus?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  customerPaymentMethod?: 'cash' | 'bank' | 'card' | 'benefit' | null;
  customerPaymentDate?: string;
  margin?: number;
  status: RepairStatus;
  receivedAt: string;
  diagnosedAt?: string;
  startedAt?: string;
  completedAt?: string;
  pickedUpAt?: string;
  estimatedReady?: string;
  voucherCode: string;
  invoiceId?: UUID;
  notes?: string;
  images: string[];
  // Wave-2: einheitliches Staff-Feld — welcher Mitarbeiter die Repair betreut hat.
  staffId?: UUID;
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  // Populated
  customer?: Customer;
  product?: Product;
}

// ── Consignment ──

// Plan §Commission §15: IN_STOCK / SOLD / RETURNED / RETURNED_TO_OWNER.
// Legacy (active/sold/paid_out/returned/expired) bleibt erlaubt.
export type CanonicalConsignmentStatus = 'IN_STOCK' | 'SOLD' | 'RETURNED' | 'RETURNED_TO_OWNER';
export type ConsignmentStatus =
  | CanonicalConsignmentStatus
  | 'active' | 'sold' | 'paid_out' | 'returned' | 'expired';

export function canonicalConsignmentStatus(s: ConsignmentStatus | string | undefined | null): CanonicalConsignmentStatus {
  const v = String(s || '').toLowerCase();
  if (v === 'active' || v === 'in_stock' || v === 'expired') return 'IN_STOCK';
  if (v === 'sold' || v === 'paid_out') return 'SOLD';
  if (v === 'returned_to_owner') return 'RETURNED_TO_OWNER';
  if (v === 'returned') return 'RETURNED';
  return 'IN_STOCK';
}

export interface Consignment {
  id: UUID;
  consignmentNumber: string;
  consignorId: UUID;
  productId: UUID;
  agreedPrice: number;
  minimumPrice?: number;
  commissionType?: 'percent' | 'fixed' | 'consignor_fixed';
  commissionValue?: number;
  commissionRate: number;
  commissionAmount?: number;
  payoutAmount?: number;
  payoutStatus: 'pending' | 'partial' | 'paid' | 'returned';
  payoutPaidAmount?: number;  // Plan §8 #2 — Partial Payouts
  payoutMethod?: string;
  saleMethod?: 'cash' | 'bank' | null;
  payoutDate?: string;
  payoutReference?: string;
  status: ConsignmentStatus;
  agreementDate: string;
  expiryDate?: string;
  salePrice?: number;
  buyerId?: UUID;
  invoiceId?: UUID;
  notes?: string;
  staffId?: UUID;
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  // Populated
  consignor?: Customer;
  product?: Product;
}

// ── Agent ──

export interface Agent {
  id: UUID;
  name: string;
  company?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  commissionRate: number;
  active: boolean;
  notes?: string;
  totalSales: number;
  totalCommission: number;
  // Optionaler Link auf Customer-Stammsatz für Convert-Transfer-to-Invoice.
  // Wird beim ersten Convert gesetzt (entweder auf bestehenden Customer oder
  // auto-erzeugten Spiegel-Eintrag) und danach wiederverwendet.
  customerId?: UUID;
  createdAt: string;
  updatedAt: string;
}

// ── Agent Transfer ──

export type AgentTransferStatus = 'transferred' | 'sold' | 'returned' | 'settled';

export interface AgentTransfer {
  id: UUID;
  transferNumber: string;
  agentId: UUID;
  productId: UUID;
  agentPrice: number;
  minimumPrice?: number;
  commissionRate: number;
  commissionType?: 'percent' | 'fixed';
  commissionValue?: number;
  commissionPaidFrom?: 'cash' | 'bank' | null;
  commissionAmount?: number;
  status: AgentTransferStatus;
  transferredAt: string;
  returnBy?: string;
  soldAt?: string;
  returnedAt?: string;
  settledAt?: string;
  actualSalePrice?: number;
  buyerInfo?: string;
  invoiceId?: UUID;
  settlementAmount?: number;
  settlementPaidAmount?: number;  // Plan §Agent §4: Teilzahlung tracking
  settlementStatus: 'pending' | 'partial' | 'paid';
  notes?: string;
  staffId?: UUID;
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  // Populated
  agent?: Agent;
  product?: Product;
}

// ── Repair Work Lines + Gold-Flow (Plan repair-multi-supplier) ──

// Plan §6: Work-Type Enum fuer Repair-Lines. Frei erweiterbar — UI rendert
// als Dropdown. Wird im DB als TEXT gespeichert.
export type RepairWorkType =
  | 'service'
  | 'polishing'
  | 'spare_part'
  | 'gold_work'
  | 'stone_setting'
  | 'engraving'
  | 'plating'
  | 'other';

export type RepairLineStatus = 'OPEN' | 'CANCELLED';

export interface RepairLine {
  id: UUID;
  branchId: UUID;
  repairId: UUID;
  position: number;
  supplierId?: UUID;          // NULL bei Legacy-Backfill ohne Supplier
  workType?: RepairWorkType;
  description?: string;
  costAmount: number;
  expenseId?: UUID;           // 1:1 link auf expenses, NULL bis IN_PROGRESS
  status: RepairLineStatus;
  dueDate?: string;
  notes?: string;
  // v0.2.1 — Material Parity (Diamond/Stone/Gold-Piece consumed during repair)
  materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | 'custom' | null;
  materialDetails?: MaterialDetails;
  createdAt: string;
  updatedAt: string;
  // Populated (nicht gespeichert) — live aus expenses-Tabelle gelesen.
  paidAmount?: number;
  paymentStatus?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
}

// Gold-Schuld an Supplier/Workshop in Gramm + Karat (NICHT in BHD —
// Goldpreis schwankt, daher getrennte Buchung). Wird beim Workshop-Gold-
// Repair angelegt; settled entweder durch Gold-Return aus precious_metals
// oder durch Konvertierung in eine Money-Expense.
export type GoldPayableStatus = 'OPEN' | 'FULFILLED' | 'CANCELLED';
export type GoldSettlementType = 'return_gold' | 'pay_money';
export type GoldPayableDirection = 'we_owe' | 'they_owe';

export interface GoldPayable {
  id: UUID;
  branchId: UUID;
  supplierId: UUID;
  // v0.2.1 — exactly one of sourceRepairId / sourceOrderId must be set
  sourceRepairId?: UUID;
  sourceOrderId?: UUID;
  sourceRepairLineId?: UUID;
  // v0.6.5 — verknuepft die Gramm-Schuld mit der exakten Order-Kostenzeile.
  sourceOrderLineId?: UUID;
  direction: GoldPayableDirection;
  weightGrams: number;
  karat: MetalKarat | string;
  settlementType: GoldSettlementType;
  fulfilledGrams: number;
  settlementExpenseId?: UUID;
  status: GoldPayableStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// Customer-Gold-Credit: Kunde hat Gold gebracht, nur Teil davon im Repair
// verwendet, Rest als Guthaben geparkt. Spaetere Settlement-Optionen:
// Redeem im naechsten Repair, Return als physisches Gold, Convert zu BHD-Credit.
export type CustomerGoldCreditStatus = 'OPEN' | 'FULFILLED' | 'CANCELLED';

export interface CustomerGoldCredit {
  id: UUID;
  branchId: UUID;
  customerId: UUID;
  // v0.2.1 — exactly one of sourceRepairId / sourceOrderId must be set
  sourceRepairId?: UUID;
  sourceOrderId?: UUID;
  weightGrams: number;
  karat: MetalKarat | string;
  fulfilledGrams: number;
  settlementCreditId?: UUID;   // Link auf BHD-Credit-Eintrag wenn konvertiert
  status: CustomerGoldCreditStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// Audit-Trail aller Gramm-Bewegungen. Schreibt sich automatisch bei jeder
// Settle/Convert/Cross-Settle-Action (analog ledger_entries fuer BHD).
export type GoldBucket =
  | 'precious_metals'
  | 'gold_payable'
  | 'customer_gold_credit'
  | 'repair_consumption'
  | 'order_consumption'  // v0.2.1 — Gold konsumiert durch eine Custom-Order
  | 'scrap_trade'
  | 'external';

export interface GoldMovement {
  id: UUID;
  branchId: UUID;
  movedAt: string;
  direction: 'in' | 'out';
  weightGrams: number;
  karat: MetalKarat | string;
  sourceBucket?: GoldBucket;
  sourceId?: UUID;
  targetBucket?: GoldBucket;
  targetId?: UUID;
  relatedRepairId?: UUID;
  relatedOrderId?: UUID;  // v0.2.1 — optionaler Order-Link analog zu Repair
  notes?: string;
}

// ── Order (Pre-Order / Sourcing) ──

// ── Precious Metals ──

export type MetalType = 'gold' | 'silver' | 'platinum';
export type MetalKarat = '24K' | '22K' | '21K' | '18K' | '14K' | '9K' | '999' | '925' | '950';
export type MetalStatus = 'in_stock' | 'sold' | 'melted';

export interface PreciousMetal {
  id: UUID;
  metalType: MetalType;
  karat?: MetalKarat;
  weightGrams: number;
  description?: string;
  purchasePricePerGram?: number;
  purchaseTotal?: number;
  spotPriceAtPurchase?: number;
  currentSpotPrice?: number;
  meltValue?: number;
  salePrice?: number;
  status: MetalStatus;
  // Plan §8 #4 — Payment-Integration für Metall-Verkäufe
  paidAmount?: number;
  paymentStatus?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  supplierName?: string;
  // v0.1.46 — optional Supplier-FK + linked Expense fuer A/P-Buchung beim Kauf.
  // Wenn supplierId + purchaseTotal > 0 → metalStore.createMetal erzeugt
  // automatisch eine Expense (category=Inventory) + postExpense() Ledger-Eintrag.
  supplierId?: UUID;
  linkedExpenseId?: UUID;
  customerId?: UUID;
  notes?: string;
  images: string[];
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
}

// ── Order (Pre-Order / Sourcing) ──

// Plan §Order: Order-Status getrennt von Payment-Status.
// Order-Status beschreibt den Prozess (wo ist die Ware?), Payment-Status die Zahlung.
export type OrderStatus = 'pending' | 'arrived' | 'notified' | 'completed' | 'cancelled';
// Payment-Status wird aus agreedPrice + totalPaid abgeleitet (siehe deriveOrderPaymentStatus).
export type OrderPaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

/**
 * Leitet den Payment-Status aus Auftragspreis + Summe der Zahlungen ab.
 * Tolerance 0.005 BHD fuer Float-Vergleiche (Konsistenz mit Invoice-Logik).
 */
export function deriveOrderPaymentStatus(agreedPrice: number | null | undefined, totalPaid: number): OrderPaymentStatus {
  const gross = Math.max(0, agreedPrice || 0);
  if (gross > 0 && totalPaid >= gross - 0.005) return 'PAID';
  if (totalPaid > 0.005) return 'PARTIALLY_PAID';
  return 'UNPAID';
}

export interface OrderLine {
  id: UUID;
  orderId: UUID;
  productId?: UUID;          // optional: bei freier Beschreibung kein Produkt
  description: string;
  quantity: number;
  unitPrice: number;          // NET pro Stück (System rechnet VAT auf, Plan §Tax §7)
  lineTotal: number;          // qty * unitPrice (= line-net)
  position: number;
  // Tax-Scheme & Rate werden bereits in OrderCreate festgelegt und müssen hier
  // persistiert sein, damit Convert-to-Invoice nicht erneut fragt und nicht doppelt rechnet.
  taxScheme?: TaxScheme;     // VAT_10 / ZERO / MARGIN — undefined = Legacy-Order ohne Snapshot
  vatRate?: number;           // 10 oder 0
  // v0.2.1 — Custom-Order Support: per-line supplier-cost analog zu repair_lines
  supplierId?: UUID;         // wenn gesetzt → A/P-Expense bei commitOrderLineExpenses
  costAmount?: number;        // was wir Supplier zahlen (default = unitPrice fuer 1:1 Pass-Through)
  expenseId?: UUID;          // verlinkter Expense-Eintrag nach commit
  isCustomerFacing?: boolean; // default true; false = pure-cost-line, NICHT auf Invoice
  // v0.2.1 — Material Parity (Diamond/Stone/Gold)
  materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | 'custom' | null;
  materialDetails?: MaterialDetails;
  // v0.3.0 — Per-Line Fulfillment-Status + partial-invoicing link
  status?: OrderLineStatus;   // default 'PENDING'
  invoiceId?: UUID;           // NULL bis die Line invoiced wurde
  // Back-to-Back Beschaffung: beim "Beim Supplier bestellt"-Markieren erfasster
  // Supplier — gruppiert den Wareneingang nach Lieferant.
  orderedSupplierId?: UUID;
  product?: Product;
}

/**
 * v0.2.1 — Strukturierte Material-Daten fuer repair_lines + order_lines.
 * Gespeichert als JSON in repair_lines.material_details / order_lines.material_details.
 */
export interface MaterialDetails {
  ct?: number;              // Carat (fuer Diamond/Stone)
  qty?: number;             // Stueckzahl
  description?: string;     // "Round Brilliant", "Princess cut"
  karat?: string;           // bei Gold-Material
  weightGrams?: number;     // bei Gold-Material
  supplierName?: string;    // Snapshot fuer Print (auch wenn supplier_id NULL)
}

/**
 * v0.2.1 — Custom-Order Meta-Daten (Materialien + Output-Beschreibung +
 * Diamond-Items). Wird als JSON in orders.custom_meta serialisiert.
 */
export interface CustomOrderMeta {
  // Customer-Material (nur dokumentiert, kein Asset, kein Expense)
  customerGoldWeight?: number;     // gramm
  customerGoldKarat?: string;       // '24K' | '22K' | '21K' | '18K' | ...
  customerStones?: string;          // freier Text: "2x 0.5ct round diamonds"
  customerMaterialReceivedAt?: string; // ISO date

  // Final Output
  finalProductDescription?: string;
  finalProductPhotos?: string[];    // base64 images

  // Workshop-Gold-Debt Flag (gold_payable lebt in eigener Tabelle)
  workshopOwesUsGold?: boolean;

  // Diamond/Stone Materials — strukturierte Liste fuer Reports & Print
  // (jeder Eintrag erzeugt EINE order_line mit material_kind='diamond')
  diamondDetails?: Array<{
    description: string;       // "Round Brilliant", "Princess cut"
    quantity: number;          // pieces
    caratPerPiece: number;     // ct
    totalCost: number;         // BHD wir zahlen
    customerPrice: number;     // BHD Customer zahlt (default = totalCost)
    supplierId?: UUID;         // wenn gesetzt → A/P
  }>;

  // Misc
  rushOrder?: boolean;
  internalNotes?: string;
}

export type OrderType = 'normal' | 'custom' | 'mixed';

// v0.3.0 — Per-Line Fulfillment-Status. Erlaubt gemischte Orders mit
// unterschiedlichen Liefer-Timelines pro Line zu tracken.
// 'ORDERED' = beim Supplier bestellt, Wareneingang/Purchase steht noch aus
// (Back-to-Back Beschaffung — Zwischen-Marker vor 'ARRIVED').
export type OrderLineStatus = 'PENDING' | 'ORDERED' | 'ARRIVED' | 'DELIVERED' | 'CANCELLED';

/**
 * v0.3.0 — Leitet den Order-Type aus den Lines ab. Eine Line gilt als
 * „custom" wenn sie ein materialKind traegt (labor/diamond/stone/gold).
 */
export function deriveOrderType(lines: Array<{ materialKind?: string | null }>): OrderType {
  const hasCustom = lines.some(l => l.materialKind != null);
  const hasProduct = lines.some(l => l.materialKind == null);
  if (hasCustom && hasProduct) return 'mixed';
  if (hasCustom) return 'custom';
  return 'normal';
}

/**
 * v0.3.0 — Roll-up des Order-Status aus den Line-Stati.
 * 'notified' ist sticky (manuelle Customer-Benachrichtigung wird nicht
 * von einem Roll-up ueberschrieben solange alle Lines mind. ARRIVED sind).
 */
export function deriveOrderStatusFromLines(
  lineStatuses: OrderLineStatus[],
  currentStatus: OrderStatus
): OrderStatus {
  const active = lineStatuses.filter(s => s !== 'CANCELLED');
  if (active.length === 0) {
    return lineStatuses.length > 0 ? 'cancelled' : currentStatus;
  }
  if (active.every(s => s === 'DELIVERED')) return 'completed';
  const allHere = active.every(s => s === 'ARRIVED' || s === 'DELIVERED');
  if (allHere) return currentStatus === 'notified' ? 'notified' : 'arrived';
  return 'pending';
}

export interface Order {
  id: UUID;
  orderNumber: string;
  customerId: UUID;
  // v0.2.1 — Order-Type Discriminator. 'custom' = Goldsmith / Sonderanfertigung.
  // Conditional UI Cards + custom_meta Daten + commitOrderLineExpenses Trigger.
  type?: OrderType;
  customMeta?: CustomOrderMeta;
  // v0.6.7 — Strukturierte Produkt-Spec fuer Custom-Orders (Karte 3e). Wird ueber
  // das NewProductModal erfasst und beim Convert in `createProduct` umgesetzt,
  // damit das fertige Stueck in der Collection eine Kategorie + Attribute + Foto
  // bekommt statt nur einen Freitext.
  customProductSpec?: Partial<Product>;
  // Promoted Custom-Fields (queryable / report-friendly statt nur JSON)
  goldsmithSupplierId?: UUID;
  laborCost?: number;
  extraGoldValue?: number;
  // Single source of truth: Order nutzt Collection-Kategorie + dynamische Attribute.
  categoryId?: UUID;
  attributes?: Record<string, string | number | boolean | string[]>;
  condition?: string;
  serialNumber?: string;
  // Wenn Order auf bestehendes Produkt referenziert (existing item flow)
  existingProductId?: UUID;
  // Legacy / Universal-Felder
  requestedBrand: string;
  requestedModel: string;
  requestedReference?: string;
  requestedDetails?: string;
  agreedPrice?: number;
  taxAmount?: number;          // Optional Tax-Anteil
  depositAmount: number;
  depositPaid: boolean;
  depositDate?: string;
  remainingAmount?: number;
  paymentMethod?: 'cash' | 'bank' | 'card' | 'benefit';
  fullyPaid?: boolean;
  supplierName?: string;
  supplierPrice?: number;
  expectedMargin?: number;
  expectedDelivery?: string;
  actualDelivery?: string;
  status: OrderStatus;
  productId?: UUID;
  invoiceId?: UUID;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  lines?: OrderLine[];          // Multi-Item Support
  // Populated
  customer?: Customer;
  product?: Product;
}

// ── Debt / Loan (Plan §Loan) ──
// Plan Nomenclature: MONEY_GIVEN (= we_lend, receivable) / MONEY_RECEIVED (= we_borrow, payable).
// Legacy-Werte `we_lend`/`we_borrow` bleiben erlaubt für Backward-Compat.

export type DebtDirection = 'we_lend' | 'we_borrow' | 'MONEY_GIVEN' | 'MONEY_RECEIVED';
export type CanonicalLoanDirection = 'MONEY_GIVEN' | 'MONEY_RECEIVED';
export type CashSource = 'cash' | 'bank' | 'benefit';
// Plan §Loan §10: OPEN / PARTIALLY_REPAID / REPAID / CANCELLED.
// Legacy-Werte (open/settled) bleiben erlaubt; canonicalLoanStatus normalisiert.
export type CanonicalLoanStatus = 'OPEN' | 'PARTIALLY_REPAID' | 'REPAID' | 'CANCELLED';
export type DebtStatus = CanonicalLoanStatus | 'open' | 'settled';

export function canonicalLoanStatus(s: DebtStatus | string | undefined | null, amount?: number, paidAmount?: number): CanonicalLoanStatus {
  const v = String(s || '').toUpperCase();
  if (v === 'CANCELLED') return 'CANCELLED';
  if (v === 'REPAID' || v === 'SETTLED') return 'REPAID';
  if (v === 'PARTIALLY_REPAID') return 'PARTIALLY_REPAID';
  // OPEN oder 'open' — ggf. mit Amount-Check auf PARTIALLY_REPAID upgraden
  if (typeof amount === 'number' && typeof paidAmount === 'number' && paidAmount > 0 && paidAmount < amount) {
    return 'PARTIALLY_REPAID';
  }
  return 'OPEN';
}

export function canonicalLoanDirection(d: DebtDirection | string | undefined | null): CanonicalLoanDirection {
  if (d === 'MONEY_GIVEN' || d === 'we_lend') return 'MONEY_GIVEN';
  return 'MONEY_RECEIVED';
}

export function isLoanGiven(d: DebtDirection | string | undefined | null): boolean {
  return canonicalLoanDirection(d) === 'MONEY_GIVEN';
}

export interface Debt {
  id: UUID;
  loanNumber?: string;         // Plan §Loan §4: LOA-000001
  direction: DebtDirection;
  counterparty: string;        // free text name
  customerId?: UUID;           // optional link to customer
  amount: number;              // original BHD
  source: CashSource;          // where it flowed initially
  dueDate?: string;            // ISO date
  notes?: string;
  status: DebtStatus;
  staffId?: UUID;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
  paidAmount: number;          // sum of debt_payments
}

export interface DebtPayment {
  id: UUID;
  debtId: UUID;
  amount: number;
  source: CashSource;          // cash or bank at repayment
  paidAt: string;
  notes?: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// Phase 1: Einkauf (Supplier / Purchase / Purchase Return / Expense)
// Plan §Supplier, §Purchases, §Purchase Returns, §Expenses
// ─────────────────────────────────────────────────────────────

// Supplier (Plan §Supplier §2)
export interface Supplier {
  id: UUID;
  branchId: UUID;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  // CPR (Bahrain personal ID) + ID-card image (base64 data URL).
  // Erscheint auf Purchase-Print-PDFs als Beleg-Block (z.B. fuer Altgold/used watches
  // von Privatpersonen — Compliance-relevant).
  cpr?: string;
  cprImage?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  // Populated (not stored)
  totalPurchases?: number;
  totalPaid?: number;
  outstandingBalance?: number;
  creditBalance?: number;  // Plan §Purchase Returns §8: offene Gutschrift beim Supplier
}

// Purchase (Plan §Purchases §16)
export type PurchaseStatus = 'DRAFT' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';

export interface PurchaseLine {
  id: UUID;
  purchaseId: UUID;
  productId?: UUID;
  description?: string;
  quantity: number;
  unitPrice: number;          // gross-incl-VAT pro Stück (was wir dem Lieferanten zahlen)
  lineTotal: number;          // qty × unitPrice (= gross)
  position: number;
  // Plan §Purchase §Tax: Input-VAT (Vorsteuer). NULL/'ZERO' = keine Vorsteuer
  // (Default für Altbestände); 'VAT_10' = 10% Vorsteuer im Bruttopreis enthalten.
  taxScheme?: 'ZERO' | 'VAT_10';
  vatRate?: number;            // 0 oder 10
  vatAmount?: number;          // dekomponiert: lineTotal × rate / (100 + rate)
  // Back-to-Back Beschaffung: verknuepft diese Einkaufs-Zeile mit der Order-Zeile,
  // die sie ausgeloest hat. NULL = reine Lager-Zeile ohne Order-Bezug.
  sourceOrderLineId?: UUID;
}

// Plan §Purchase Returns §8: 'credit' erlaubt Nutzung von Supplier-Credit-Balance.
export interface PurchasePayment {
  id: UUID;
  purchaseId: UUID;
  amount: number;
  method: 'cash' | 'bank' | 'benefit' | 'credit';
  paidAt: string;
  reference?: string;
  note?: string;
  createdAt: string;
}

// Audit-Snapshot: Supplier-Stamm-/Identifikationsdaten zum Zeitpunkt des
// Purchase-Create. Wird NIE veraendert. Print-PDF + Detail lesen ZUERST aus
// dem Snapshot, fallen nur fuer historische Records ohne Snapshot auf den
// live Supplier zurueck. So zeigt der gedruckte Beleg immer die Daten an,
// die zum Ankaufszeitpunkt galten — Compliance-relevant fuer Altgold-/
// Used-Watch-Belege.
export interface SupplierSnapshot {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  cpr?: string;
  cprImage?: string;
  snapshotAt: string;
}

export interface Purchase {
  id: UUID;
  purchaseNumber: string;
  branchId: UUID;
  supplierId: UUID;
  status: PurchaseStatus;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  purchaseDate: string;
  notes?: string;
  lines: PurchaseLine[];
  payments: PurchasePayment[];
  staffId?: UUID;
  supplierSnapshot?: SupplierSnapshot;
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  supplier?: Supplier;
  // Back-to-Back Beschaffung: Order, deren Posten dieser Einkauf (mit-)beschafft.
  sourceOrderId?: UUID;
}

// Purchase Return (Plan §Purchase Returns §17)
export type PurchaseReturnStatus = 'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';

export interface PurchaseReturnLine {
  id: UUID;
  returnId: UUID;
  purchaseLineId?: UUID;
  productId?: UUID;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface PurchaseReturn {
  id: UUID;
  returnNumber: string;
  branchId: UUID;
  purchaseId: UUID;
  supplierId: UUID;
  status: PurchaseReturnStatus;
  totalAmount: number;
  returnDate: string;
  refundMethod?: 'cash' | 'bank' | 'benefit' | 'credit';
  refundAmount: number;
  notes?: string;
  lines: PurchaseReturnLine[];
  createdAt: string;
  createdBy?: UUID;
}

// Sales Return (Plan §Returns §17)
export type SalesReturnStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REFUNDED' | 'CLOSED';
// Refund-Status (getrennt von Return-Status — Ware kann zurück sein OHNE dass Geld zurück ist).
// PENDING_REFUND: Return existiert, Refund noch offen (kein Cash geflossen).
// NOT_REFUNDED: Legacy-Wert, wird wie PENDING_REFUND behandelt.
export type RefundStatus = 'PENDING_REFUND' | 'NOT_REFUNDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
// Plan §Returns §6 + §Commission §13: Standard IN_STOCK/UNDER_REPAIR/WRITE_OFF.
// Consignment-spezifisch (§13 Option A/B): RETURN_TO_OWNER (verlässt System) / KEEP_AS_OWN (source_type→OWN).
export type ProductDisposition = 'IN_STOCK' | 'UNDER_REPAIR' | 'WRITE_OFF' | 'RETURN_TO_OWNER' | 'KEEP_AS_OWN';

export interface SalesReturnLine {
  id: UUID;
  returnId: UUID;
  invoiceLineId?: UUID;
  productId?: UUID;
  quantity: number;
  unitPrice: number;
  vatAmount: number;
  lineTotal: number;
}

export interface SalesReturn {
  id: UUID;
  returnNumber: string;
  branchId: UUID;
  invoiceId: UUID;
  customerId: UUID;
  status: SalesReturnStatus;
  totalAmount: number;          // Geschuldeter Refund (was zurückgezahlt werden muss)
  vatCorrected: number;
  returnDate: string;
  refundMethod?: 'cash' | 'bank' | 'benefit' | 'card' | 'credit' | 'other';
  refundAmount: number;          // Legacy: Gesamtbetrag der Rückzahlung
  refundPaidAmount: number;      // Bereits tatsächlich gezahlt (kann partial sein)
  refundPaidDate?: string;
  refundStatus: RefundStatus;    // NOT_REFUNDED | PARTIALLY_REFUNDED | REFUNDED
  productDisposition?: ProductDisposition;
  reason?: string;               // Optional: Grund für die Rückgabe
  notes?: string;
  lines: SalesReturnLine[];
  staffId?: UUID;
  createdAt: string;
  createdBy?: UUID;
}

// Credit Note (Storno-Rechnung) — eigenständige Steuerurkunde, 1:1 zu SalesReturn.
// Industry Standard (SAP/DATEV/Xero/QuickBooks/Lexware): jeder bestätigte Sales Return
// erzeugt automatisch ein Credit Note mit eigener Nummer.
export interface CreditNote {
  id: UUID;
  creditNoteNumber: string;        // CN-2026-000001
  branchId: UUID;
  invoiceId: UUID;                 // Original-Invoice
  salesReturnId?: UUID;            // 1:1 zur Return-Buchung (optional → manuell anlegbar)
  customerId: UUID;
  issuedAt: string;
  totalAmount: number;             // Brutto der Gutschrift
  vatAmount: number;               // VAT-Korrektur
  cashRefundAmount: number;        // Cash zurück (nur was Customer wirklich gezahlt hat)
  receivableCancelAmount: number;  // Forderungsstornierung (kein Cash)
  refundMethod?: 'cash' | 'bank' | 'benefit' | 'card' | 'credit' | 'other';
  reason?: string;
  notes?: string;
  createdAt: string;
  createdBy?: UUID;
}

// Phase 5: Production & Consumption (Plan §Production)
// Input-Snapshot enthält volle Produkt-Spec zum Zeitpunkt des Konsums (Inputs
// werden ja aus der products-Tabelle gelöscht). Für Detail-View nötig — sonst
// hätten wir nur die ID und nichts mehr.
export interface ProductionInputSnapshot {
  categoryId?: string;
  brand?: string;
  name?: string;
  sku?: string;
  condition?: string;
  attributes?: Record<string, unknown>;
  images?: string[];
  purchasePrice?: number;
}

export interface ProductionInput {
  id: UUID;
  recordId: UUID;
  productId: UUID;
  /** JSON-string des kompletten Snapshots (siehe ProductionInputSnapshot). */
  productSnapshot?: string;
  /** Geparste Variante — wird in loadRecords befüllt. */
  snapshot?: ProductionInputSnapshot;
  inputValue: number;
}

export interface ProductionOutput {
  id: UUID;
  recordId: UUID;
  productId: UUID;
  outputValue: number;
}

export interface ProductionRecord {
  id: UUID;
  recordNumber: string;
  branchId: UUID;
  productionDate: string;
  totalValue: number;
  notes?: string;
  status: 'DRAFT' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
  // Plan §8 #7 — Cost-Tracking pro Record
  laborCost?: number;
  overheadCost?: number;
  totalCost?: number;
  inputs: ProductionInput[];
  outputs: ProductionOutput[];
  createdAt: string;
  createdBy?: UUID;
}

// ─────────────────────────────────────────────────────────────
// Phase 4: Banking + Partner (Plan §Banking §10, §Partner)
// ─────────────────────────────────────────────────────────────

// Banking — Cash↔Bank Transfer (Plan §Banking §10)
export interface BankTransfer {
  id: UUID;
  branchId: UUID;
  amount: number;
  direction:
    | 'CASH_TO_BANK' | 'BANK_TO_CASH'
    | 'CASH_TO_BENEFIT' | 'BENEFIT_TO_CASH'
    | 'BANK_TO_BENEFIT' | 'BENEFIT_TO_BANK';
  transferDate: string;
  notes?: string;
  createdAt: string;
  createdBy?: UUID;
}

// Partner (Plan §Partner — referenziert in Banking §5, Dashboard §G, Reports §H)
export interface Partner {
  id: UUID;
  branchId: UUID;
  name: string;
  phone?: string;
  email?: string;
  sharePercentage: number;  // 0–100
  active: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Computed
  totalInvested?: number;
  totalWithdrawn?: number;
  totalProfitShare?: number;
  balance?: number;
}

export type PartnerTransactionType = 'INVESTMENT' | 'WITHDRAWAL' | 'PROFIT_DISTRIBUTION';

export interface PartnerTransaction {
  id: UUID;
  branchId: UUID;
  partnerId: UUID;
  transactionNumber: string;
  type: PartnerTransactionType;
  amount: number;
  method: 'cash' | 'bank' | 'benefit';
  transactionDate: string;
  notes?: string;
  // Plan §8 #8 — Payment-Status (cash auto PAID, bank startet PENDING bis Bestätigung).
  paymentStatus?: 'PENDING' | 'PAID';
  paidAtActual?: string;
  createdAt: string;
  createdBy?: UUID;
}

// Expense (Plan §Expenses §3 + §11)
export type ExpenseCategory = 'Rent' | 'Salary' | 'Utilities' | 'CardFees' | 'RepairCosts' | 'Transport' | 'ConsignorLoss' | 'Inventory' | 'Miscellaneous';

// v0.6.0 — Kategorien deren Kosten in den Produkt-/Inventar-Wert kapitalisiert
// werden (→ COGS beim Verkauf) und daher NICHT als laufende Betriebsausgabe
// zaehlen. Sonst wuerde dieselbe Kost doppelt zaehlen — einmal als COGS in der
// Invoice-Marge, einmal als operative Ausgabe.
export const CAPITALIZED_EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ['Inventory'];

export function isCapitalizedExpenseCategory(cat: string): boolean {
  return (CAPITALIZED_EXPENSE_CATEGORIES as readonly string[]).includes(cat);
}

export interface Expense {
  id: UUID;
  expenseNumber: string;
  branchId: UUID;
  category: ExpenseCategory;
  amount: number;
  paidAmount: number;          // Plan §Expenses §Pay-Later — Teilzahlungen
  paymentMethod: 'cash' | 'bank' | 'benefit';
  expenseDate: string;
  description?: string;
  relatedModule?: string;
  relatedEntityId?: UUID;
  // Plan §Repair §Workshop-as-Supplier: optionaler FK auf den Supplier, der die
  // Rechnung gestellt hat. Bei gesetztem supplier_id zählt eine offene (PENDING)
  // Expense in die Supplier-Outstanding-Bilanz.
  supplierId?: UUID;
  // Status-Semantik:
  //  - PAID:      paid_amount >= amount (voll bezahlt)
  //  - PENDING:   paid_amount < amount  (Unpaid + Partially Paid)
  //  - CANCELLED: storniert, zählt nicht in Cashflow/Payables
  status?: 'PENDING' | 'PAID' | 'CANCELLED';
  // Wenn diese Expense von einem Recurring-Template generiert wurde, traegt sie
  // dessen ID hier — sonst NULL/undefined fuer manuell angelegte.
  recurringTemplateId?: UUID;
  // Bei category='Salary' verpflichtet: welcher Mitarbeiter bekommt das Gehalt.
  employeeId?: UUID;
  createdAt: string;
  createdBy?: UUID;
}

export interface RecurringExpenseTemplate {
  id: UUID;
  branchId: UUID;
  category: ExpenseCategory;
  amount: number;
  paymentMethod: 'cash' | 'bank' | 'benefit';
  payNowDefault: boolean;       // false = generierte Expense bleibt PENDING (Payable)
  description?: string;
  dayOfMonth: number;           // 1..31 (am Monatsende auf letzten Tag geclampt)
  startDate: string;            // YYYY-MM-DD
  endDate?: string;             // optional; danach keine neuen Instanzen
  active: boolean;              // false = pausiert
  lastGeneratedPeriod?: string; // 'YYYY-MM'
  supplierId?: UUID;
  employeeId?: UUID;            // bei category='Salary' Pflicht (UI-validiert)
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
}

export type EmploymentStatus = 'active' | 'on_leave' | 'inactive';

export interface Employee {
  id: UUID;
  branchId: UUID;
  name: string;
  role?: string;                // 'Sales', 'Repair Tech', 'Manager', etc. (free text)
  employmentStatus: EmploymentStatus;
  baseSalary?: number;          // monatliches Base-Gehalt (BHD), optional
  phone?: string;
  email?: string;
  notes?: string;
  userId?: UUID;                // optional: verknuepfter Login-User
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
}

export interface ExpensePayment {
  id: UUID;
  expenseId: UUID;
  amount: number;
  method: 'cash' | 'bank' | 'benefit';
  paidAt: string;
  note?: string;
  createdAt: string;
}

// ── Scrap Gold Quick Trade ───────────────────────────────────────
// Direkter Altgold-Handel: Kunde verkauft uns mehrere Goldstücke, wir
// verkaufen sofort an Händler weiter. Spec: nur Spread pro Item (sale -
// purchase) zählt als Income; Brutto-Preise bleiben pro Line intern
// dokumentiert. Aggregate auf scrap_trades sind SUMMEN bzw. 'mixed' für
// karat bei Multi-Line.

export type ScrapPaymentMethod = 'cash' | 'bank' | 'benefit';
export type ScrapTradeStatus = 'completed' | 'cancelled';
export type ScrapPaymentDirection = 'OUT' | 'IN';   // OUT = zum Seller, IN = vom Buyer

export interface ScrapTradeLine {
  id: UUID;
  scrapTradeId: UUID;
  position: number;
  weightGrams: number;
  karat: string;                    // '24K' | '22K' | '21K' | '18K' | '14K' | '9K' | custom
  purchasePrice: number;
  salePrice: number;
  profit: number;                   // = salePrice - purchasePrice (persisted)
  notes?: string;
  imagesPurchase: string[];         // base64 data URLs PRO Item
  imagesSale: string[];
  createdAt: string;
}

// Split-Payments: ein Trade kann mehrere Payments pro Direction haben.
// Bsp: Seller bekommt 200 cash + 300 benefit = 500 BHD total Purchase.
// Sum(OUT) muss SUM(lines.purchase) entsprechen, Sum(IN) = SUM(lines.sale).
export interface ScrapTradePayment {
  id: UUID;
  scrapTradeId: UUID;
  direction: ScrapPaymentDirection;
  method: ScrapPaymentMethod;
  amount: number;
  position: number;
  createdAt: string;
}

export interface ScrapTrade {
  id: UUID;
  branchId: UUID;
  tradeNumber: string;              // 'SGT-000001'
  sellerName: string;
  sellerPhone?: string;
  sellerCustomerId?: UUID;
  buyerName: string;
  buyerPhone?: string;
  buyerSupplierId?: UUID;
  // Aggregates abgeleitet aus lines:
  weightGrams: number;              // SUM(lines.weight_grams)
  karat: string;                    // 'mixed' wenn lines.length > 1, sonst single karat
  purchasePrice: number;            // SUM(lines.purchase_price)
  salePrice: number;                // SUM(lines.sale_price)
  profit: number;                   // SUM(lines.profit)
  tradeDate: string;                // ISO
  notes?: string;                   // Trade-weite Notiz (item-spezifisch siehe lines)
  status: ScrapTradeStatus;
  lines: ScrapTradeLine[];
  paymentsOut: ScrapTradePayment[]; // Splits zum Seller — sum = SUM(lines.purchase)
  paymentsIn: ScrapTradePayment[];  // Splits vom Buyer — sum = SUM(lines.sale)
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  version: number;
}

export function rowToScrapTradePayment(row: any): ScrapTradePayment {
  return {
    id: row.id,
    scrapTradeId: row.scrap_trade_id,
    direction: (row.direction as ScrapPaymentDirection) || 'OUT',
    method: (row.method as ScrapPaymentMethod) || 'cash',
    amount: Number(row.amount) || 0,
    position: Number(row.position) || 1,
    createdAt: row.created_at,
  };
}

export function rowToScrapTradeLine(row: any): ScrapTradeLine {
  return {
    id: row.id,
    scrapTradeId: row.scrap_trade_id,
    position: Number(row.position) || 1,
    weightGrams: Number(row.weight_grams) || 0,
    karat: row.karat,
    purchasePrice: Number(row.purchase_price) || 0,
    salePrice: Number(row.sale_price) || 0,
    profit: Number(row.profit) || 0,
    notes: row.notes || undefined,
    imagesPurchase: row.images_purchase ? JSON.parse(row.images_purchase) : [],
    imagesSale: row.images_sale ? JSON.parse(row.images_sale) : [],
    createdAt: row.created_at,
  };
}

export function rowToScrapTrade(
  row: any,
  lines: ScrapTradeLine[] = [],
  paymentsOut: ScrapTradePayment[] = [],
  paymentsIn: ScrapTradePayment[] = []
): ScrapTrade {
  return {
    id: row.id,
    branchId: row.branch_id,
    tradeNumber: row.trade_number,
    sellerName: row.seller_name,
    sellerPhone: row.seller_phone || undefined,
    sellerCustomerId: row.seller_customer_id || undefined,
    buyerName: row.buyer_name,
    buyerPhone: row.buyer_phone || undefined,
    buyerSupplierId: row.buyer_supplier_id || undefined,
    weightGrams: Number(row.weight_grams) || 0,
    karat: row.karat,
    purchasePrice: Number(row.purchase_price) || 0,
    salePrice: Number(row.sale_price) || 0,
    profit: Number(row.profit) || 0,
    tradeDate: row.trade_date,
    notes: row.notes || undefined,
    status: (row.status as ScrapTradeStatus) || 'completed',
    lines,
    paymentsOut,
    paymentsIn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by || undefined,
    version: Number(row.version) || 1,
  };
}
