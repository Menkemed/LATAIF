// ════════════════════════════════════════════════════════════════════════════
// B1 OPENING ACCOUNTING — Kontenklassen des Hauptbuchs (Aktiva, Passiva, Eigenkapital, Ertrag, Aufwand).
//
// Bisher kannte der Code nur die Soll-/Haben-Natur eines Kontos (`NATURAL_DEBIT` in `queries.ts`); die Einordnung in
// Bilanz und Ergebnis stand nur in Kommentaren. Hier steht sie EINMAL, vollständig (der Typ verlangt jedes Konto aus
// `LedgerAccount`), und die Saldenliste/Bilanzvorschau rechnet nur damit.
//
// Seite eines Saldos: ASSET und EXPENSE = Soll − Haben, LIABILITY, EQUITY und INCOME = Haben − Soll. Zwei Konten stehen
// bewusst gegen ihre Natur in ihrer Gruppe (`contra`): TAX_PAID (an die NBR gezahlt, mindert die VAT-Schuld) und REFUNDS
// (mindert den Ertrag). Ein Konto, das im Hauptbuch steht, aber hier fehlt, wird als „nicht zugeordnet" gezeigt — nie
// still einer Seite zugeschlagen.
// ════════════════════════════════════════════════════════════════════════════
import type { LedgerAccount } from './posting';

export type AccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type AccountGroup =
  | 'CASH' | 'RECEIVABLES' | 'INVENTORY' | 'SUPPLIER_ADVANCES' | 'LOANS_RECEIVABLE' | 'VAT_ASSET' | 'OTHER_ASSETS'
  | 'PAYABLES' | 'CUSTOMER_ADVANCES' | 'LOANS_PAYABLE' | 'VAT' | 'OTHER_LIABILITIES'
  | 'OPENING_EQUITY' | 'PARTNER_EQUITY'
  | 'INCOME' | 'EXPENSE';

export interface AccountClassInfo { klass: AccountClass; group: AccountGroup; contra?: true }

export const ACCOUNT_CLASSES: Readonly<Record<LedgerAccount, AccountClassInfo>> = {
  CASH: { klass: 'ASSET', group: 'CASH' },
  BANK: { klass: 'ASSET', group: 'CASH' },
  BENEFIT: { klass: 'ASSET', group: 'CASH' },
  CARD_CLEARING: { klass: 'ASSET', group: 'CASH' },
  ACCOUNTS_RECEIVABLE: { klass: 'ASSET', group: 'RECEIVABLES' },
  INVENTORY: { klass: 'ASSET', group: 'INVENTORY' },
  SUPPLIER_CREDIT: { klass: 'ASSET', group: 'SUPPLIER_ADVANCES' },
  LOAN_RECEIVABLE: { klass: 'ASSET', group: 'LOANS_RECEIVABLE' },
  VAT_INPUT: { klass: 'ASSET', group: 'VAT_ASSET' },
  GOLD_CREDIT_CLEARING: { klass: 'ASSET', group: 'OTHER_ASSETS' },
  INTERNAL_TRANSFER: { klass: 'ASSET', group: 'OTHER_ASSETS' },
  ACCOUNTS_PAYABLE: { klass: 'LIABILITY', group: 'PAYABLES' },
  COMMISSION_PAYABLE_AGENT: { klass: 'LIABILITY', group: 'PAYABLES' },
  COMMISSION_PAYABLE_CONSIGNOR: { klass: 'LIABILITY', group: 'PAYABLES' },
  CUSTOMER_CREDIT: { klass: 'LIABILITY', group: 'CUSTOMER_ADVANCES' },
  CUSTOMER_DEPOSITS: { klass: 'LIABILITY', group: 'CUSTOMER_ADVANCES' },
  LOAN_PAYABLE: { klass: 'LIABILITY', group: 'LOANS_PAYABLE' },
  VAT_OUTPUT: { klass: 'LIABILITY', group: 'VAT' },
  MARGIN_VAT: { klass: 'LIABILITY', group: 'VAT' },
  TAX_PAID: { klass: 'LIABILITY', group: 'VAT', contra: true },
  PARTNER_ITEM_BALANCE: { klass: 'LIABILITY', group: 'OTHER_LIABILITIES' },
  OPENING_BALANCE_EQUITY: { klass: 'EQUITY', group: 'OPENING_EQUITY' },
  PARTNER_EQUITY: { klass: 'EQUITY', group: 'PARTNER_EQUITY' },
  REVENUE: { klass: 'INCOME', group: 'INCOME' },
  CANCELLATION_FEE_INCOME: { klass: 'INCOME', group: 'INCOME' },
  REFUNDS: { klass: 'INCOME', group: 'INCOME', contra: true },
  COGS: { klass: 'EXPENSE', group: 'EXPENSE' },
  INVENTORY_LOSS: { klass: 'EXPENSE', group: 'EXPENSE' },
  EXPENSES_OPERATING: { klass: 'EXPENSE', group: 'EXPENSE' },
  CARD_FEES: { klass: 'EXPENSE', group: 'EXPENSE' },
  PARTNER_ITEM_PROFIT_SHARE: { klass: 'EXPENSE', group: 'EXPENSE' },
};

export const GROUP_LABEL: Readonly<Record<AccountGroup, string>> = {
  CASH: 'Cash, bank, Benefit, card clearing',
  RECEIVABLES: 'Customer receivables',
  INVENTORY: 'Inventory',
  SUPPLIER_ADVANCES: 'Supplier advances / credits',
  LOANS_RECEIVABLE: 'Loans given',
  VAT_ASSET: 'Input VAT',
  OTHER_ASSETS: 'Other assets',
  PAYABLES: 'Supplier payables',
  CUSTOMER_ADVANCES: 'Customer advances / credits',
  LOANS_PAYABLE: 'Loans taken',
  VAT: 'VAT (output, margin VAT, paid to NBR)',
  OTHER_LIABILITIES: 'Other liabilities',
  OPENING_EQUITY: 'Opening equity',
  PARTNER_EQUITY: 'Partner equity',
  INCOME: 'Income',
  EXPENSE: 'Expenses',
};

export function accountClassOf(account: string): AccountClassInfo | null {
  return (ACCOUNT_CLASSES as Readonly<Record<string, AccountClassInfo>>)[account] ?? null;
}

/** Saldo auf der Seite seiner Klasse, in Fils: Aktiva/Aufwand Soll − Haben, sonst Haben − Soll. */
export function sideBalanceFils(klass: AccountClass, debitFils: number, creditFils: number): number {
  return klass === 'ASSET' || klass === 'EXPENSE' ? debitFils - creditFils : creditFils - debitFils;
}
