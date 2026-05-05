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
export type CanonicalStockStatus = 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'GIVEN_TO_AGENT' | 'UNDER_REPAIR' | 'RETURNED' | 'WRITE_OFF';
export type StockStatus =
  | CanonicalStockStatus
  | 'in_stock' | 'reserved' | 'offered' | 'sold' | 'consignment'
  | 'in_repair' | 'with_agent' | 'on_order';

export function canonicalStockStatus(s: StockStatus | string | undefined | null): CanonicalStockStatus {
  const v = String(s || '').toLowerCase();
  if (v === 'in_stock' || v === 'consignment' || v === 'offered') return 'IN_STOCK';
  if (v === 'reserved') return 'RESERVED';
  if (v === 'sold') return 'SOLD';
  if (v === 'with_agent' || v === 'given_to_agent') return 'GIVEN_TO_AGENT';
  if (v === 'in_repair' || v === 'under_repair') return 'UNDER_REPAIR';
  if (v === 'returned') return 'RETURNED';
  if (v === 'write_off') return 'WRITE_OFF';
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
  paidFrom?: 'cash' | 'bank' | null;
  sourceType: ProductSourceType;
  notes?: string;
  images: string[];
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
export type InvoiceStatus = 'DRAFT' | 'PARTIAL' | 'FINAL' | 'CANCELLED';

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
  createdAt: string;
  createdBy?: UUID;
  customer?: Customer;
}

// ── Payment ──

export type PaymentMethod = 'bank_transfer' | 'cash' | 'card' | 'crypto' | 'other';

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
  customerId: UUID;
  productId?: UUID;
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
  estimatedCost?: number;
  actualCost?: number;
  internalCost: number;
  chargeToCustomer?: number;
  customerPaidFrom?: 'cash' | 'bank' | null;
  internalPaidFrom?: 'cash' | 'bank' | null;
  // Plan §8 — Repair customer payment tracking
  customerPaidAmount?: number;
  customerPaymentStatus?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  customerPaymentMethod?: 'cash' | 'bank' | 'card' | null;
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
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  // Populated
  agent?: Agent;
  product?: Product;
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
  product?: Product;
}

export interface Order {
  id: UUID;
  orderNumber: string;
  customerId: UUID;
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
  paymentMethod?: 'cash' | 'bank' | 'card';
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
export type CashSource = 'cash' | 'bank';
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
}

// Plan §Purchase Returns §8: 'credit' erlaubt Nutzung von Supplier-Credit-Balance.
export interface PurchasePayment {
  id: UUID;
  purchaseId: UUID;
  amount: number;
  method: 'cash' | 'bank' | 'credit';
  paidAt: string;
  reference?: string;
  note?: string;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
  createdBy?: UUID;
  supplier?: Supplier;
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
  refundMethod?: 'cash' | 'bank' | 'credit';
  refundAmount: number;
  notes?: string;
  lines: PurchaseReturnLine[];
  createdAt: string;
  createdBy?: UUID;
}

// Sales Return (Plan §Returns §17)
export type SalesReturnStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'REFUNDED' | 'CLOSED';
// Refund-Status (getrennt von Return-Status — Ware kann zurück sein OHNE dass Geld zurück ist).
export type RefundStatus = 'NOT_REFUNDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
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
  refundMethod?: 'cash' | 'bank' | 'card' | 'credit' | 'other';
  refundAmount: number;          // Legacy: Gesamtbetrag der Rückzahlung
  refundPaidAmount: number;      // Bereits tatsächlich gezahlt (kann partial sein)
  refundPaidDate?: string;
  refundStatus: RefundStatus;    // NOT_REFUNDED | PARTIALLY_REFUNDED | REFUNDED
  productDisposition?: ProductDisposition;
  reason?: string;               // Optional: Grund für die Rückgabe
  notes?: string;
  lines: SalesReturnLine[];
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
  refundMethod?: 'cash' | 'bank' | 'card' | 'credit' | 'other';
  reason?: string;
  notes?: string;
  createdAt: string;
  createdBy?: UUID;
}

// Phase 5: Production & Consumption (Plan §Production)
export interface ProductionInput {
  id: UUID;
  recordId: UUID;
  productId: UUID;
  productSnapshot?: string;
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
  direction: 'CASH_TO_BANK' | 'BANK_TO_CASH';
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
  method: 'cash' | 'bank';
  transactionDate: string;
  notes?: string;
  // Plan §8 #8 — Payment-Status (cash auto PAID, bank startet PENDING bis Bestätigung).
  paymentStatus?: 'PENDING' | 'PAID';
  paidAtActual?: string;
  createdAt: string;
  createdBy?: UUID;
}

// Expense (Plan §Expenses §3 + §11)
export type ExpenseCategory = 'Rent' | 'Salary' | 'Utilities' | 'CardFees' | 'RepairCosts' | 'Transport' | 'Miscellaneous';

export interface Expense {
  id: UUID;
  expenseNumber: string;
  branchId: UUID;
  category: ExpenseCategory;
  amount: number;
  paidAmount: number;          // Plan §Expenses §Pay-Later — Teilzahlungen
  paymentMethod: 'cash' | 'bank';
  expenseDate: string;
  description?: string;
  relatedModule?: string;
  relatedEntityId?: UUID;
  // Status-Semantik:
  //  - PAID:      paid_amount >= amount (voll bezahlt)
  //  - PENDING:   paid_amount < amount  (Unpaid + Partially Paid)
  //  - CANCELLED: storniert, zählt nicht in Cashflow/Payables
  status?: 'PENDING' | 'PAID' | 'CANCELLED';
  createdAt: string;
  createdBy?: UUID;
}

export interface ExpensePayment {
  id: UUID;
  expenseId: UUID;
  amount: number;
  method: 'cash' | 'bank';
  paidAt: string;
  note?: string;
  createdAt: string;
}
