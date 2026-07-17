import { useEffect, useMemo, useState, useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Receipt, Tags, GitBranch, Users, Hash, AlertTriangle,
  Plus, Pencil, Trash2, Check, X, Power, Cloud, Sparkles, Globe, Phone, Copy, Package, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import type { Product } from '@/core/models/types';
import { getDatabase, saveDatabase, resetDatabase, flushDatabase } from '@/core/db/database';
import { exportFile } from '@/core/utils/export-file';
import { query, currentBranchId } from '@/core/db/helpers';
import { useProductStore } from '@/stores/productStore';
import { runSafePurge, countPurge, PURGE_PLANS, runGuardedReset, isFactoryResetBlocked, FACTORY_RESET_BLOCKED_MESSAGE, type PurgeDb } from '@/core/settings/safe-purge';
import { createPreDestructiveBackup } from '@/core/settings/pre-destructive-backup';
import { trackDelete } from '@/core/sync/track';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { computeImageEmbedding, cosineSimilarity, pairwiseVisualMatch, isAiConfigured } from '@/core/ai/ai-service';
import { useAuthStore } from '@/stores/authStore';
import { usePermission } from '@/hooks/usePermission';
import { COUNTRIES, type CountryCode } from '@/core/contacts/country-codes';
import { useCountryCodesStore } from '@/core/contacts/country-codes-store';
import type { Category, CategoryAttribute, AttributeType, UserRole } from '@/core/models/types';

// ── Constants ──

type TabKey = 'company' | 'tax' | 'categories' | 'branch' | 'branches' | 'users' | 'numbering' | 'language' | 'phone' | 'ai' | 'sync' | 'updates' | 'duplicates' | 'danger';

interface TabDef {
  key: TabKey;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabDef[] = [
  { key: 'company', label: 'Company', icon: <Building2 size={16} /> },
  { key: 'tax', label: 'Tax / VAT', icon: <Receipt size={16} /> },
  { key: 'categories', label: 'Categories', icon: <Tags size={16} /> },
  { key: 'branch', label: 'Branch', icon: <GitBranch size={16} /> },
  { key: 'branches', label: 'Branches', icon: <GitBranch size={16} /> },
  { key: 'users', label: 'Users', icon: <Users size={16} /> },
  { key: 'numbering', label: 'Number Ranges', icon: <Hash size={16} /> },
  { key: 'language', label: 'Language', icon: <Globe size={16} /> },
  { key: 'phone', label: 'Country Codes', icon: <Phone size={16} /> },
  { key: 'ai', label: 'AI / OpenAI', icon: <Sparkles size={16} /> },
  { key: 'sync', label: 'Sync / Server', icon: <Cloud size={16} /> },
  { key: 'updates', label: 'Updates', icon: <Cloud size={16} /> },
  { key: 'duplicates', label: 'Duplicates', icon: <Copy size={16} /> },
  { key: 'danger', label: 'Danger Zone', icon: <AlertTriangle size={16} /> },
];

const ROLES: UserRole[] = ['ADMIN', 'MANAGER', 'SALES', 'ACCOUNTANT'];

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  SALES: 'Sales',
  ACCOUNTANT: 'Accountant',
  owner: 'Admin',
  manager: 'Manager',
  sales: 'Sales',
  backoffice: 'Accountant',
  viewer: 'Sales',
};

// ── Helpers ──

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'lataif_salt_2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getSetting(branchId: string, key: string): string {
  const rows = query('SELECT value FROM settings WHERE branch_id = ? AND key = ?', [branchId, key]);
  return rows.length > 0 ? (rows[0].value as string) : '';
}

function setSetting(branchId: string, key: string, value: string, category: string): void {
  // Permission-Guard: nur ADMIN darf Settings ändern. State.role wird aus authStore live gelesen,
  // damit auch direkter Aufruf aus DevTools/Console abgewiesen wird.
  const { role } = useAuthStore.getState();
  // canonicalRole: 'owner' (legacy) und 'ADMIN' (canonical) zählen als Admin.
  const r = role();
  if (r !== 'ADMIN' && r !== 'owner') {
    throw new Error('Only admin can modify settings.');
  }
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO settings (branch_id, key, value, category, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(branch_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    [branchId, key, value, category, now, value, now]
  );
  saveDatabase();
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7280', marginBottom: 16 }}>
      {children}
    </h3>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
      <label style={{ width: 160, flexShrink: 0, fontSize: 13, color: '#4B5563', paddingTop: 10 }}>{label}</label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function SuccessBanner({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{
      padding: '10px 16px', borderRadius: 8, fontSize: 13,
      background: 'rgba(126,170,110,0.08)', border: '1px solid rgba(126,170,110,0.2)', color: '#7EAA6E',
      marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <Check size={14} /> {message}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// COMPANY TAB
// ═══════════════════════════════════════════════════════════

function CompanyTab() {
  const branchId = currentBranchId();
  const [companyName, setCompanyName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [logo, setLogo] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    setCompanyName(getSetting(branchId, 'company.name'));
    setAddress(getSetting(branchId, 'company.address'));
    setPhone(getSetting(branchId, 'company.phone'));
    setEmail(getSetting(branchId, 'company.email'));
    setLogo(getSetting(branchId, 'company.logo'));
  }, [branchId]);

  function save() {
    setSetting(branchId, 'company.name', companyName, 'company');
    setSetting(branchId, 'company.address', address, 'company');
    setSetting(branchId, 'company.phone', phone, 'company');
    setSetting(branchId, 'company.email', email, 'company');
    setSetting(branchId, 'company.logo', logo, 'company');
    setSaved('Company settings saved.');
  }

  return (
    <div>
      <SectionTitle>Company Information</SectionTitle>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}
      <Card>
        <div style={{ padding: 8 }}>
          <FieldRow label="Company Name">
            <Input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Your company name" />
          </FieldRow>
          <FieldRow label="Address">
            <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Street, City, Country" />
          </FieldRow>
          <FieldRow label="Phone">
            <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+973 XXXX XXXX" />
          </FieldRow>
          <FieldRow label="Email">
            <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="info@company.com" type="email" />
          </FieldRow>
          <FieldRow label="Logo URL">
            <Input value={logo} onChange={e => setLogo(e.target.value)} placeholder="Path or URL to logo" />
          </FieldRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <Button variant="primary" onClick={save}>Save Changes</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAX / VAT TAB
// ═══════════════════════════════════════════════════════════

function TaxTab() {
  const branchId = currentBranchId();
  const role = useAuthStore(s => s.session?.role);
  // v0.7.13 — Bug-Fix: UserRole-Typ ist UPPERCASE ('ADMIN'/'MANAGER'/'SALES'/
  // 'ACCOUNTANT'), 'owner' gibt's nicht. Vorher war `isOwner` immer false →
  // Opening-Balance-Felder waren dauerhaft disabled fuer JEDEN. Jetzt ADMIN
  // erlaubt (= der Besitzer/Owner-Rolle in unserer Hierarchie).
  const isOwner = role === 'ADMIN';
  const [stdRate, setStdRate] = useState('');
  const [marginRate, setMarginRate] = useState('');
  const [marginEnabled, setMarginEnabled] = useState(true);
  const [defaultScheme, setDefaultScheme] = useState('');
  const [cardFeeRate, setCardFeeRate] = useState('');
  const [amexFeeRate, setAmexFeeRate] = useState('');
  const [fyStartMonth, setFyStartMonth] = useState('');
  const [openingCash, setOpeningCash] = useState('');
  const [openingBank, setOpeningBank] = useState('');
  // v0.7.13 — Benefit Opening-Balance. Benefit ist eigenes Banking-Konto (App-
  // Transfer), nicht Debit-Card. Vorher fehlte das Feld in Settings → User
  // konnte seinen BenefitPay-Bestand nicht als Baseline einpflegen.
  const [openingBenefit, setOpeningBenefit] = useState('');
  const [monthlyTarget, setMonthlyTarget] = useState('');
  // Plan §Settings §3.D Payment + §3.H Partner
  const [defaultInflowAccount, setDefaultInflowAccount] = useState('bank');
  const [defaultOutflowAccount, setDefaultOutflowAccount] = useState('bank');
  const [methodCashEnabled, setMethodCashEnabled] = useState(true);
  const [methodBankEnabled, setMethodBankEnabled] = useState(true);
  // v0.7.13 — Card → Benefit. Card war eine Legacy-Methode die im
  // Benefit-Refactor entfernt wurde; das UI-Toggle zeigte sie aber immer noch.
  const [methodBenefitEnabled, setMethodBenefitEnabled] = useState(true);
  const [partnerProfitShareDefault, setPartnerProfitShareDefault] = useState('0');
  const [partnerReportPeriod, setPartnerReportPeriod] = useState('monthly');
  const [partnerWarnLimit, setPartnerWarnLimit] = useState('0');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    setStdRate(getSetting(branchId, 'vat.standard_rate') || '10');
    setMarginRate(getSetting(branchId, 'vat.margin_rate') || '10');
    setMarginEnabled((getSetting(branchId, 'tax.margin_enabled') || '1') !== '0');
    setDefaultScheme(getSetting(branchId, 'tax.default_scheme') || 'MARGIN');
    setCardFeeRate(getSetting(branchId, 'finance.card_fee_rate') || '2.2');
    setAmexFeeRate(getSetting(branchId, 'finance.card_fee_rate_amex') || '2.5');
    setFyStartMonth(getSetting(branchId, 'finance.fiscal_year_start_month') || '1');
    setOpeningCash(getSetting(branchId, 'finance.opening_cash') || '0');
    setOpeningBank(getSetting(branchId, 'finance.opening_bank') || '0');
    setOpeningBenefit(getSetting(branchId, 'finance.opening_benefit') || '0');
    setMonthlyTarget(getSetting(branchId, 'finance.monthly_target') || '');
    setDefaultInflowAccount(getSetting(branchId, 'payment.default_inflow_account') || 'bank');
    setDefaultOutflowAccount(getSetting(branchId, 'payment.default_outflow_account') || 'bank');
    setMethodCashEnabled((getSetting(branchId, 'payment.method_cash_enabled') || '1') !== '0');
    setMethodBankEnabled((getSetting(branchId, 'payment.method_bank_enabled') || '1') !== '0');
    setMethodBenefitEnabled((getSetting(branchId, 'payment.method_benefit_enabled') || '1') !== '0');
    setPartnerProfitShareDefault(getSetting(branchId, 'partner.profit_share_default') || '0');
    setPartnerReportPeriod(getSetting(branchId, 'partner.report_period') || 'monthly');
    setPartnerWarnLimit(getSetting(branchId, 'partner.warn_limit') || '0');
  }, [branchId]);

  function save() {
    setSetting(branchId, 'vat.standard_rate', stdRate, 'tax');
    setSetting(branchId, 'vat.margin_rate', marginRate, 'tax');
    setSetting(branchId, 'tax.margin_enabled', marginEnabled ? '1' : '0', 'tax');
    setSetting(branchId, 'tax.default_scheme', defaultScheme, 'tax');
    setSetting(branchId, 'finance.card_fee_rate', cardFeeRate, 'finance');
    setSetting(branchId, 'finance.card_fee_rate_amex', amexFeeRate, 'finance');
    setSetting(branchId, 'finance.fiscal_year_start_month', fyStartMonth, 'finance');
    setSetting(branchId, 'payment.default_inflow_account', defaultInflowAccount, 'payment');
    setSetting(branchId, 'payment.default_outflow_account', defaultOutflowAccount, 'payment');
    setSetting(branchId, 'payment.method_cash_enabled', methodCashEnabled ? '1' : '0', 'payment');
    setSetting(branchId, 'payment.method_bank_enabled', methodBankEnabled ? '1' : '0', 'payment');
    setSetting(branchId, 'payment.method_benefit_enabled', methodBenefitEnabled ? '1' : '0', 'payment');
    setSetting(branchId, 'partner.profit_share_default', partnerProfitShareDefault, 'partner');
    setSetting(branchId, 'partner.report_period', partnerReportPeriod, 'partner');
    setSetting(branchId, 'partner.warn_limit', partnerWarnLimit, 'partner');
    if (isOwner) {
      setSetting(branchId, 'finance.opening_cash', openingCash || '0', 'finance');
      setSetting(branchId, 'finance.opening_bank', openingBank || '0', 'finance');
      setSetting(branchId, 'finance.opening_benefit', openingBenefit || '0', 'finance');
    }
    setSetting(branchId, 'finance.monthly_target', (monthlyTarget || '').trim(), 'finance');
    setSaved('Tax, payment & partner settings saved.');
  }

  const schemes = [
    { value: 'MARGIN', label: 'Margin', desc: 'VAT on profit margin (hidden from customer)' },
    { value: 'VAT_10', label: 'VAT 10%', desc: 'VAT 10% on net sale price' },
    { value: 'ZERO',   label: 'Zero',   desc: '0% — no VAT' },
  ];

  return (
    <div>
      <SectionTitle>Tax / VAT Configuration</SectionTitle>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}
      <Card>
        <div style={{ padding: 8 }}>
          <FieldRow label="Standard VAT Rate">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input
                type="number" value={stdRate} onChange={e => setStdRate(e.target.value)}
                placeholder="10" style={{ maxWidth: 100 }}
              />
              <span style={{ fontSize: 13, color: '#6B7280' }}>%</span>
            </div>
          </FieldRow>
          <FieldRow label="Margin Scheme Rate">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input
                type="number" value={marginRate} onChange={e => setMarginRate(e.target.value)}
                placeholder="10" style={{ maxWidth: 100 }}
              />
              <span style={{ fontSize: 13, color: '#6B7280' }}>%</span>
            </div>
          </FieldRow>
          <FieldRow label="Default Tax Scheme">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {schemes.map(s => (
                <button
                  key={s.value}
                  onClick={() => setDefaultScheme(s.value)}
                  className="cursor-pointer rounded-lg transition-all duration-200"
                  style={{
                    padding: '12px 18px', textAlign: 'left',
                    border: `1px solid ${defaultScheme === s.value ? '#0F0F10' : '#D5D9DE'}`,
                    color: defaultScheme === s.value ? '#0F0F10' : '#4B5563',
                    background: defaultScheme === s.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </FieldRow>
          <FieldRow label="Card Processing Fee">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#6B7280', minWidth: 150 }}>Normal (Visa / MC / Debit)</span>
              <Input
                type="number" step="0.01" value={cardFeeRate} onChange={e => setCardFeeRate(e.target.value)}
                placeholder="2.2" style={{ maxWidth: 90 }}
              />
              <span style={{ fontSize: 13, color: '#6B7280' }}>%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 12, color: '#6B7280', minWidth: 150 }}>Amex (American Express)</span>
              <Input
                type="number" step="0.01" value={amexFeeRate} onChange={e => setAmexFeeRate(e.target.value)}
                placeholder="2.5" style={{ maxWidth: 90 }}
              />
              <span style={{ fontSize: 13, color: '#6B7280' }}>% deducted by bank on every card payment</span>
            </div>
          </FieldRow>
          <FieldRow label="Fiscal Year Starts In">
            <select
              value={fyStartMonth}
              onChange={e => setFyStartMonth(e.target.value)}
              style={{
                background: '#F2F7FA', border: '1px solid #D5D9DE', borderRadius: 8,
                color: '#0F0F10', padding: '10px 12px', fontSize: 13, minWidth: 160,
              }}
            >
              {['January','February','March','April','May','June','July','August','September','October','November','December'].map((m, i) => (
                <option key={m} value={String(i + 1)}>{m}</option>
              ))}
            </select>
          </FieldRow>

          <div style={{ borderTop: '1px solid #E5E9EE', margin: '16px 0 8px', paddingTop: 14 }}>
            <span className="text-overline">OPENING BALANCES (STATUS QUO)</span>
            <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
              {isOwner
                ? 'Starting balance for cash, bank, and Benefit at the moment you begin using LATAIF. Used as the baseline for the cashflow calculation.'
                : 'Only an Admin can edit opening balances.'}
            </p>
          </div>
          <FieldRow label="Opening Cash">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input
                type="number" step="0.01" value={openingCash} onChange={e => setOpeningCash(e.target.value)}
                placeholder="0" style={{ maxWidth: 160 }} disabled={!isOwner}
              />
              <span style={{ fontSize: 13, color: '#6B7280' }}>BHD on hand (cash)</span>
            </div>
          </FieldRow>
          <FieldRow label="Opening Bank">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input
                type="number" step="0.01" value={openingBank} onChange={e => setOpeningBank(e.target.value)}
                placeholder="0" style={{ maxWidth: 160 }} disabled={!isOwner}
              />
              <span style={{ fontSize: 13, color: '#6B7280' }}>BHD in bank accounts</span>
            </div>
          </FieldRow>
          <FieldRow label="Opening Benefit">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input
                type="number" step="0.01" value={openingBenefit} onChange={e => setOpeningBenefit(e.target.value)}
                placeholder="0" style={{ maxWidth: 160 }} disabled={!isOwner}
              />
              <span style={{ fontSize: 13, color: '#6B7280' }}>BHD in BenefitPay app balance</span>
            </div>
          </FieldRow>

          {/* Sales Overview gauge target — overrides auto-logic when set. */}
          <div style={{ borderTop: '1px solid #E5E9EE', margin: '16px 0 8px', paddingTop: 14 }}>
            <span className="text-overline">DASHBOARD TARGETS</span>
          </div>
          <FieldRow label="Monthly Sales Target">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input type="number" step="100" value={monthlyTarget} onChange={e => setMonthlyTarget(e.target.value)}
                placeholder="Auto" style={{ maxWidth: 160 }} />
              <span style={{ fontSize: 13, color: '#6B7280' }}>BHD — leave empty for auto (best month / last year +10%)</span>
            </div>
          </FieldRow>

          {/* Plan §Tax §3 Margin toggle */}
          <div style={{ borderTop: '1px solid #E5E9EE', margin: '16px 0 8px', paddingTop: 14 }}>
            <span className="text-overline">MARGIN SCHEME (Plan §Tax §3.C)</span>
          </div>
          <FieldRow label="Enable Margin Scheme">
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#4B5563', cursor: 'pointer' }}>
              <input type="checkbox" checked={marginEnabled} onChange={e => setMarginEnabled(e.target.checked)} />
              <span>Allow MARGIN tax scheme on invoice lines (profit/11 hidden from customer)</span>
            </label>
          </FieldRow>

          {/* Plan §Settings §3.D Payment Settings */}
          <div style={{ borderTop: '1px solid #E5E9EE', margin: '16px 0 8px', paddingTop: 14 }}>
            <span className="text-overline">PAYMENT METHODS (Plan §Settings §3.D)</span>
          </div>
          <FieldRow label="Enabled methods">
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, color: '#4B5563' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={methodCashEnabled} onChange={e => setMethodCashEnabled(e.target.checked)} /> Cash
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={methodBankEnabled} onChange={e => setMethodBankEnabled(e.target.checked)} /> Bank transfer
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={methodBenefitEnabled} onChange={e => setMethodBenefitEnabled(e.target.checked)} /> Benefit
              </label>
            </div>
          </FieldRow>
          <FieldRow label="Default inflow account">
            <select value={defaultInflowAccount} onChange={e => setDefaultInflowAccount(e.target.value)}
              style={{ background: '#F2F7FA', border: '1px solid #D5D9DE', borderRadius: 8, color: '#0F0F10', padding: '10px 12px', fontSize: 13, minWidth: 160 }}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
              <option value="benefit">Benefit</option>
            </select>
          </FieldRow>
          <FieldRow label="Default outflow account">
            <select value={defaultOutflowAccount} onChange={e => setDefaultOutflowAccount(e.target.value)}
              style={{ background: '#F2F7FA', border: '1px solid #D5D9DE', borderRadius: 8, color: '#0F0F10', padding: '10px 12px', fontSize: 13, minWidth: 160 }}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
              <option value="benefit">Benefit</option>
            </select>
          </FieldRow>

          {/* Plan §Settings §3.H Partner Settings */}
          <div style={{ borderTop: '1px solid #E5E9EE', margin: '16px 0 8px', paddingTop: 14 }}>
            <span className="text-overline">PARTNER SETTINGS (Plan §Settings §3.H)</span>
          </div>
          <FieldRow label="Default profit share">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input type="number" step="0.01" value={partnerProfitShareDefault} onChange={e => setPartnerProfitShareDefault(e.target.value)}
                placeholder="0" style={{ maxWidth: 100 }} />
              <span style={{ fontSize: 13, color: '#6B7280' }}>% applied to new partners unless overridden</span>
            </div>
          </FieldRow>
          <FieldRow label="Reporting period">
            <select value={partnerReportPeriod} onChange={e => setPartnerReportPeriod(e.target.value)}
              style={{ background: '#F2F7FA', border: '1px solid #D5D9DE', borderRadius: 8, color: '#0F0F10', padding: '10px 12px', fontSize: 13, minWidth: 160 }}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </FieldRow>
          <FieldRow label="Warning limit">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input type="number" step="0.01" value={partnerWarnLimit} onChange={e => setPartnerWarnLimit(e.target.value)}
                placeholder="0" style={{ maxWidth: 160 }} />
              <span style={{ fontSize: 13, color: '#6B7280' }}>BHD — alert when partner balance drops below</span>
            </div>
          </FieldRow>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <Button variant="primary" onClick={save}>Save Changes</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// CATEGORIES TAB
// ═══════════════════════════════════════════════════════════

function CategoriesTab() {
  const { categories, loadCategories, createCategory, updateCategory } = useProductStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [saved, setSaved] = useState('');

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editIcon, setEditIcon] = useState('');

  // New category form
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#0F0F10');
  const [newIcon, setNewIcon] = useState('Package');
  const [newAttributes, setNewAttributes] = useState<CategoryAttribute[]>([]);

  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Load all categories including inactive
  const allCategories = (() => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM categories WHERE branch_id = ? ORDER BY sort_order', [branchId]);
      return rows.map((row): Category => ({
        id: row.id as string,
        name: row.name as string,
        icon: (row.icon as string) || 'Package',
        color: (row.color as string) || '#0F0F10',
        attributes: JSON.parse((row.attributes as string) || '[]'),
        scopeOptions: JSON.parse((row.scope_options as string) || '[]'),
        conditionOptions: JSON.parse((row.condition_options as string) || '[]'),
        active: row.active === 1,
        sortOrder: (row.sort_order as number) || 0,
        createdAt: row.created_at as string,
      }));
    } catch {
      return categories;
    }
  })();

  function startEdit(cat: Category) {
    setEditingId(cat.id);
    setEditName(cat.name);
    setEditColor(cat.color);
    setEditIcon(cat.icon);
  }

  function saveEdit() {
    if (!editingId || !editName.trim()) return;
    updateCategory(editingId, { name: editName.trim(), color: editColor, icon: editIcon });
    setEditingId(null);
    setSaved('Category updated.');
    loadCategories();
  }

  function toggleActive(cat: Category) {
    updateCategory(cat.id, { active: !cat.active });
    setSaved(cat.active ? 'Category deactivated.' : 'Category activated.');
    loadCategories();
  }

  function addNewAttribute() {
    setNewAttributes([...newAttributes, {
      key: '', label: '', type: 'text' as AttributeType, required: false, showInList: false,
    }]);
  }

  function updateNewAttribute(idx: number, field: keyof CategoryAttribute, value: unknown) {
    const updated = [...newAttributes];
    (updated[idx] as unknown as Record<string, unknown>)[field] = value;
    if (field === 'label' && !updated[idx].key) {
      updated[idx].key = (value as string).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    }
    setNewAttributes(updated);
  }

  function removeNewAttribute(idx: number) {
    setNewAttributes(newAttributes.filter((_, i) => i !== idx));
  }

  function handleCreateCategory() {
    if (!newName.trim()) return;
    const validAttrs = newAttributes.filter(a => a.key && a.label);
    createCategory({
      name: newName.trim(), color: newColor, icon: newIcon,
      attributes: validAttrs, scopeOptions: [], conditionOptions: [],
    });
    setShowNewModal(false);
    setNewName(''); setNewColor('#0F0F10'); setNewIcon('Package'); setNewAttributes([]);
    setSaved('Category created.');
    loadCategories();
  }

  const presetColors = ['#0F0F10', '#A76ECF', '#CF8A6E', '#6E9FCF', '#6ECF9A', '#CFCF6E', '#B9D4F1', '#CF6E6E', '#6ECFCF'];
  const iconOptions = ['Package', 'Watch', 'Gem', 'ShoppingBag', 'Footprints', 'Glasses', 'Wrench', 'Diamond', 'Crown', 'Star', 'Heart', 'Sparkles'];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionTitle>Product Categories</SectionTitle>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowNewModal(true)}>
          New Category
        </Button>
      </div>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {allCategories.map(cat => (
          <Card key={cat.id}>
            {editingId === cat.id ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Input label="NAME" value={editName} onChange={e => setEditName(e.target.value)} />
                  <Input label="ICON" value={editIcon} onChange={e => setEditIcon(e.target.value)} placeholder="Lucide icon name" />
                </div>
                <div>
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7280', marginBottom: 8, display: 'block' }}>COLOR</span>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {presetColors.map(c => (
                      <button key={c} onClick={() => setEditColor(c)}
                        className="cursor-pointer transition-all duration-200"
                        style={{
                          width: 28, height: 28, borderRadius: '50%', background: c,
                          border: editColor === c ? '2px solid #0F0F10' : '2px solid transparent',
                          outline: editColor === c ? '2px solid ' + c : 'none',
                          outlineOffset: 2,
                        }}
                      />
                    ))}
                    <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)}
                      style={{ width: 28, height: 28, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <Button variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                  <Button variant="primary" onClick={saveEdit}>Save</Button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: cat.color + '15', border: `1px solid ${cat.color}30`,
                  }}>
                    <span style={{ fontSize: 11, color: cat.color, fontWeight: 600 }}>{cat.icon.substring(0, 2).toUpperCase()}</span>
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 500, color: '#0F0F10' }}>{cat.name}</span>
                      {!cat.active && (
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(107,107,115,0.1)', color: '#6B7280', border: '1px solid #D5D9DE' }}>
                          Inactive
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: '#6B7280' }}>
                      {cat.attributes.length} attributes  ·  {cat.scopeOptions.length} scope options  ·  {cat.conditionOptions.length} conditions
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => toggleActive(cat)}
                    className="cursor-pointer transition-colors duration-200"
                    title={cat.active ? 'Deactivate' : 'Activate'}
                    style={{ padding: 8, borderRadius: 6, border: 'none', background: 'transparent', color: cat.active ? '#7EAA6E' : '#6B7280' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Power size={14} />
                  </button>
                  <button onClick={() => startEdit(cat)}
                    className="cursor-pointer transition-colors duration-200"
                    style={{ padding: 8, borderRadius: 6, border: 'none', background: 'transparent', color: '#4B5563' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* New Category Modal */}
      <Modal open={showNewModal} onClose={() => setShowNewModal(false)} title="New Category" width={600}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Input label="CATEGORY NAME" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Pens, Accessories" />

          <div>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7280', marginBottom: 8, display: 'block' }}>ICON</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {iconOptions.map(ic => (
                <button key={ic} onClick={() => setNewIcon(ic)}
                  className="cursor-pointer transition-all duration-200"
                  style={{
                    padding: '6px 12px', fontSize: 11, borderRadius: 6,
                    border: `1px solid ${newIcon === ic ? '#0F0F10' : '#D5D9DE'}`,
                    color: newIcon === ic ? '#0F0F10' : '#6B7280',
                    background: newIcon === ic ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{ic}</button>
              ))}
            </div>
          </div>

          <div>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7280', marginBottom: 8, display: 'block' }}>COLOR</span>
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {presetColors.map(c => (
                <button key={c} onClick={() => setNewColor(c)}
                  className="cursor-pointer transition-all duration-200"
                  style={{
                    width: 28, height: 28, borderRadius: '50%', background: c, border: 'none',
                    outline: newColor === c ? '2px solid #0F0F10' : 'none', outlineOffset: 2,
                  }}
                />
              ))}
              <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)}
                style={{ width: 28, height: 28, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
              />
            </div>
          </div>

          {/* Custom Attributes */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7280' }}>CUSTOM ATTRIBUTES</span>
              <button onClick={addNewAttribute}
                className="cursor-pointer transition-colors duration-200"
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#0F0F10', background: 'none', border: 'none' }}
              >
                <Plus size={13} /> Add Attribute
              </button>
            </div>
            {newAttributes.length === 0 && (
              <p style={{ fontSize: 12, color: '#6B7280', padding: '12px 0' }}>No custom attributes yet. Click "Add Attribute" to define category-specific fields.</p>
            )}
            {newAttributes.map((attr, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto auto', gap: 10, alignItems: 'center', marginBottom: 10 }}>
                <Input placeholder="Label" value={attr.label}
                  onChange={e => updateNewAttribute(idx, 'label', e.target.value)} />
                <select
                  value={attr.type}
                  onChange={e => updateNewAttribute(idx, 'type', e.target.value)}
                  style={{
                    background: 'transparent', border: 'none', borderBottom: '1px solid #D5D9DE',
                    color: '#0F0F10', fontSize: 14, padding: '10px 0', outline: 'none',
                  }}
                >
                  <option value="text" style={{ background: '#FFFFFF' }}>Text</option>
                  <option value="number" style={{ background: '#FFFFFF' }}>Number</option>
                  <option value="select" style={{ background: '#FFFFFF' }}>Select</option>
                  <option value="boolean" style={{ background: '#FFFFFF' }}>Boolean</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6B7280', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={attr.required}
                    onChange={e => updateNewAttribute(idx, 'required', e.target.checked)}
                    style={{ accentColor: '#0F0F10' }}
                  /> Req
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6B7280', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={attr.showInList}
                    onChange={e => updateNewAttribute(idx, 'showInList', e.target.checked)}
                    style={{ accentColor: '#0F0F10' }}
                  /> List
                </label>
                <button onClick={() => removeNewAttribute(idx)}
                  className="cursor-pointer" style={{ color: '#AA6E6E', background: 'none', border: 'none', padding: 4 }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNewModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateCategory}>Create Category</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// BRANCH TAB
// ═══════════════════════════════════════════════════════════

function BranchTab() {
  const { session } = useAuthStore();
  const [branchName, setBranchName] = useState('');
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [address, setAddress] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (!session) return;
    const rows = query('SELECT * FROM branches WHERE id = ?', [session.branchId]);
    if (rows.length > 0) {
      setBranchName(rows[0].name as string);
      setCountry(rows[0].country as string);
      setCurrency(rows[0].currency as string);
      setAddress((rows[0].address as string) || '');
    }
  }, [session]);

  function save() {
    if (!session) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      'UPDATE branches SET name = ?, country = ?, currency = ?, address = ?, updated_at = ? WHERE id = ?',
      [branchName, country, currency, address, now, session.branchId]
    );
    saveDatabase();
    setSaved('Branch settings saved.');
  }

  const currencies = ['BHD', 'USD', 'EUR', 'GBP', 'SAR', 'AED'];

  return (
    <div>
      <SectionTitle>Branch Management</SectionTitle>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}
      <Card>
        <div style={{ padding: 8 }}>
          <div style={{
            padding: '12px 16px', borderRadius: 8, marginBottom: 24,
            background: 'rgba(198,163,109,0.04)', border: '1px solid rgba(15,15,16,0.1)',
          }}>
            <span style={{ fontSize: 11, color: '#0F0F10', fontWeight: 600, letterSpacing: '0.08em' }}>CURRENT BRANCH</span>
            <div style={{ fontSize: 13, color: '#4B5563', marginTop: 4 }}>
              ID: <span className="font-mono" style={{ color: '#6B7280' }}>{session?.branchId}</span>
            </div>
          </div>
          <FieldRow label="Branch Name">
            <Input value={branchName} onChange={e => setBranchName(e.target.value)} placeholder="Branch name" />
          </FieldRow>
          <FieldRow label="Country">
            <Input value={country} onChange={e => setCountry(e.target.value)} placeholder="BH" />
          </FieldRow>
          <FieldRow label="Currency">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {currencies.map(c => (
                <button key={c} onClick={() => setCurrency(c)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 16px', fontSize: 12,
                    border: `1px solid ${currency === c ? '#0F0F10' : '#D5D9DE'}`,
                    color: currency === c ? '#0F0F10' : '#6B7280',
                    background: currency === c ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{c}</button>
              ))}
            </div>
          </FieldRow>
          <FieldRow label="Address">
            <Input value={address} onChange={e => setAddress(e.target.value)} placeholder="Branch address" />
          </FieldRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <Button variant="primary" onClick={save}>Save Changes</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// BRANCHES TAB (all tenant branches)
// ═══════════════════════════════════════════════════════════

interface BranchRow {
  id: string;
  name: string;
  country: string;
  currency: string;
  address: string;
  active: boolean;
}

function BranchesTab() {
  const { session } = useAuthStore();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [showNewModal, setShowNewModal] = useState(false);
  const [saved, setSaved] = useState('');

  // New branch form
  const [newName, setNewName] = useState('');
  const [newCountry, setNewCountry] = useState('BH');
  const [newCurrency, setNewCurrency] = useState('BHD');
  const [newAddress, setNewAddress] = useState('');
  const [formError, setFormError] = useState('');

  const loadBranches = useCallback(() => {
    if (!session) return;
    const rows = query(
      `SELECT * FROM branches WHERE tenant_id = (SELECT tenant_id FROM users WHERE id = ?) ORDER BY name`,
      [session.userId]
    );
    setBranches(rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      country: r.country as string,
      currency: r.currency as string,
      address: (r.address as string) || '',
      active: r.active === 1,
    })));
  }, [session]);

  useEffect(() => { loadBranches(); }, [loadBranches]);

  function toggleBranchActive(branch: BranchRow) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run('UPDATE branches SET active = ?, updated_at = ? WHERE id = ?', [branch.active ? 0 : 1, now, branch.id]);
    saveDatabase();
    setSaved(branch.active ? 'Branch deactivated.' : 'Branch activated.');
    loadBranches();
  }

  function handleCreateBranch() {
    if (!newName.trim()) {
      setFormError('Branch name is required.');
      return;
    }
    if (!session) return;
    setFormError('');

    try {
      const db = getDatabase();
      const now = new Date().toISOString();
      const id = uuid();

      // Get tenant_id from current user
      const tenantRows = query('SELECT tenant_id FROM users WHERE id = ?', [session.userId]);
      const tenantId = tenantRows.length > 0 ? tenantRows[0].tenant_id as string : 'tenant-1';

      db.run(
        `INSERT INTO branches (id, tenant_id, name, country, currency, address, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, tenantId, newName.trim(), newCountry, newCurrency, newAddress.trim(), now, now]
      );
      saveDatabase();
      setShowNewModal(false);
      setNewName(''); setNewCountry('BH'); setNewCurrency('BHD'); setNewAddress('');
      setSaved('Branch created.');
      loadBranches();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  const currencies = ['BHD', 'USD', 'EUR', 'GBP', 'SAR', 'AED'];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionTitle>Tenant Branches</SectionTitle>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowNewModal(true)}>
          Add Branch
        </Button>
      </div>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {branches.map(branch => (
          <Card key={branch.id}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: branch.active ? 'rgba(15,15,16,0.08)' : 'rgba(107,107,115,0.08)',
                  border: `1px solid ${branch.active ? 'rgba(15,15,16,0.15)' : '#D5D9DE'}`,
                }}>
                  <GitBranch size={16} style={{ color: branch.active ? '#0F0F10' : '#6B7280' }} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 500, color: branch.active ? '#0F0F10' : '#6B7280' }}>{branch.name}</span>
                    {session?.branchId === branch.id && (
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(126,170,110,0.08)', color: '#7EAA6E', border: '1px solid rgba(126,170,110,0.2)' }}>
                        Current
                      </span>
                    )}
                    {!branch.active && (
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(220,38,38,0.08)', color: '#AA6E6E', border: '1px solid rgba(220,38,38,0.2)' }}>
                        Inactive
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>
                    {branch.country}  ·  {branch.currency}
                    {branch.address ? `  ·  ${branch.address}` : ''}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => toggleBranchActive(branch)}
                  className="cursor-pointer transition-colors duration-200"
                  title={branch.active ? 'Deactivate' : 'Activate'}
                  style={{ padding: 8, borderRadius: 6, border: 'none', background: 'transparent', color: branch.active ? '#7EAA6E' : '#6B7280' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <Power size={13} />
                </button>
              </div>
            </div>
          </Card>
        ))}
        {branches.length === 0 && (
          <p style={{ textAlign: 'center', color: '#6B7280', fontSize: 13, padding: '40px 0' }}>No branches found.</p>
        )}
      </div>

      {/* New Branch Modal */}
      <Modal open={showNewModal} onClose={() => { setShowNewModal(false); setFormError(''); }} title="New Branch" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {formError && (
            <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 12, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#AA6E6E' }}>
              {formError}
            </div>
          )}
          <Input label="BRANCH NAME" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Main Showroom" />
          <Input label="COUNTRY" value={newCountry} onChange={e => setNewCountry(e.target.value)} placeholder="BH" />
          <div>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7280', marginBottom: 8, display: 'block' }}>CURRENCY</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {currencies.map(c => (
                <button key={c} onClick={() => setNewCurrency(c)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 16px', fontSize: 12,
                    border: `1px solid ${newCurrency === c ? '#0F0F10' : '#D5D9DE'}`,
                    color: newCurrency === c ? '#0F0F10' : '#6B7280',
                    background: newCurrency === c ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{c}</button>
              ))}
            </div>
          </div>
          <Input label="ADDRESS" value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder="Branch address" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setShowNewModal(false); setFormError(''); }}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateBranch}>Create Branch</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// USERS TAB
// ═══════════════════════════════════════════════════════════

interface UserRow {
  id: string;
  name: string;
  email: string;
  active: boolean;
  role: UserRole;
  lastLoginAt: string | null;
}

function UsersTab() {
  const { session } = useAuthStore();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [showNewModal, setShowNewModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<UserRole>('viewer');
  const [saved, setSaved] = useState('');

  // New user form
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('viewer');
  const [formError, setFormError] = useState('');

  const loadUsers = useCallback(() => {
    if (!session) return;
    const rows = query(
      `SELECT u.id, u.name, u.email, u.active, ub.role, u.last_login_at
       FROM users u
       JOIN user_branches ub ON ub.user_id = u.id
       WHERE ub.branch_id = ?
       ORDER BY u.name`,
      [session.branchId]
    );
    setUsers(rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      email: r.email as string,
      active: r.active === 1,
      role: r.role as UserRole,
      lastLoginAt: r.last_login_at as string | null,
    })));
  }, [session]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  function startEditRole(user: UserRow) {
    setEditingId(user.id);
    setEditRole(user.role);
  }

  function saveRole() {
    if (!editingId || !session) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      'UPDATE user_branches SET role = ? WHERE user_id = ? AND branch_id = ?',
      [editRole, editingId, session.branchId]
    );
    db.run('UPDATE users SET updated_at = ? WHERE id = ?', [now, editingId]);
    saveDatabase();
    setEditingId(null);
    setSaved('User role updated.');
    loadUsers();
  }

  function toggleUserActive(user: UserRow) {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run('UPDATE users SET active = ?, updated_at = ? WHERE id = ?', [user.active ? 0 : 1, now, user.id]);
    saveDatabase();
    setSaved(user.active ? 'User deactivated.' : 'User activated.');
    loadUsers();
  }

  async function handleCreateUser() {
    if (!newName.trim() || !newEmail.trim() || !newPassword) {
      setFormError('All fields are required.');
      return;
    }
    if (!session) return;
    setFormError('');

    try {
      const db = getDatabase();
      const now = new Date().toISOString();
      const id = uuid();
      const hash = await hashPassword(newPassword);

      // Check if email exists
      const existing = query('SELECT id FROM users WHERE email = ?', [newEmail.trim()]);
      if (existing.length > 0) {
        setFormError('Email already registered.');
        return;
      }

      // Get tenant_id from session branch
      const branchRows = query('SELECT tenant_id FROM branches WHERE id = ?', [session.branchId]);
      const tenantId = branchRows.length > 0 ? branchRows[0].tenant_id as string : 'tenant-1';

      db.run(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, tenantId, newEmail.trim(), hash, newName.trim(), now, now]
      );
      db.run(
        `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
         VALUES (?, ?, ?, 1, ?)`,
        [id, session.branchId, newRole, now]
      );
      saveDatabase();
      setShowNewModal(false);
      setNewName(''); setNewEmail(''); setNewPassword(''); setNewRole('viewer');
      setSaved('User created.');
      loadUsers();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionTitle>Users in Current Branch</SectionTitle>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowNewModal(true)}>
          New User
        </Button>
      </div>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {users.map(user => (
          <Card key={user.id}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: user.active ? 'rgba(15,15,16,0.08)' : 'rgba(107,107,115,0.08)',
                  border: `1px solid ${user.active ? 'rgba(15,15,16,0.15)' : '#D5D9DE'}`,
                  fontSize: 14, fontWeight: 600, color: user.active ? '#0F0F10' : '#6B7280',
                }}>
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 500, color: user.active ? '#0F0F10' : '#6B7280' }}>{user.name}</span>
                    {!user.active && (
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: 'rgba(220,38,38,0.08)', color: '#AA6E6E', border: '1px solid rgba(220,38,38,0.2)' }}>
                        Inactive
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: '#6B7280' }}>{user.email}</span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {editingId === user.id ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <select
                      value={editRole}
                      onChange={e => setEditRole(e.target.value as UserRole)}
                      style={{
                        background: '#FFFFFF', border: '1px solid #D5D9DE', borderRadius: 6,
                        color: '#0F0F10', fontSize: 12, padding: '6px 10px', outline: 'none',
                      }}
                    >
                      {ROLES.map(r => (
                        <option key={r} value={r} style={{ background: '#FFFFFF' }}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                    <button onClick={saveRole}
                      className="cursor-pointer" style={{ color: '#7EAA6E', background: 'none', border: 'none', padding: 4 }}>
                      <Check size={14} />
                    </button>
                    <button onClick={() => setEditingId(null)}
                      className="cursor-pointer" style={{ color: '#6B7280', background: 'none', border: 'none', padding: 4 }}>
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span style={{
                      fontSize: 11, padding: '4px 12px', borderRadius: 999,
                      background: 'rgba(15,15,16,0.06)', color: '#0F0F10', border: '1px solid rgba(15,15,16,0.15)',
                    }}>
                      {ROLE_LABELS[user.role]}
                    </span>
                    <button onClick={() => startEditRole(user)}
                      className="cursor-pointer transition-colors duration-200"
                      style={{ padding: 8, borderRadius: 6, border: 'none', background: 'transparent', color: '#4B5563' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => toggleUserActive(user)}
                      className="cursor-pointer transition-colors duration-200"
                      title={user.active ? 'Deactivate' : 'Activate'}
                      style={{ padding: 8, borderRadius: 6, border: 'none', background: 'transparent', color: user.active ? '#7EAA6E' : '#6B7280' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Power size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </Card>
        ))}
        {users.length === 0 && (
          <p style={{ textAlign: 'center', color: '#6B7280', fontSize: 13, padding: '40px 0' }}>No users found in this branch.</p>
        )}
      </div>

      {/* New User Modal */}
      <Modal open={showNewModal} onClose={() => { setShowNewModal(false); setFormError(''); }} title="New User" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {formError && (
            <div style={{ padding: '10px 14px', borderRadius: 8, fontSize: 12, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#AA6E6E' }}>
              {formError}
            </div>
          )}
          <Input label="FULL NAME" value={newName} onChange={e => setNewName(e.target.value)} placeholder="John Doe" />
          <Input label="EMAIL" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="user@company.com" type="email" />
          <Input label="PASSWORD" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Minimum 6 characters" type="password" />
          <div>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#6B7280', marginBottom: 8, display: 'block' }}>ROLE</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {ROLES.map(r => (
                <button key={r} onClick={() => setNewRole(r)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '7px 14px', fontSize: 12,
                    border: `1px solid ${newRole === r ? '#0F0F10' : '#D5D9DE'}`,
                    color: newRole === r ? '#0F0F10' : '#6B7280',
                    background: newRole === r ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>{ROLE_LABELS[r]}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setShowNewModal(false); setFormError(''); }}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateUser}>Create User</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// NUMBER RANGES TAB
// ═══════════════════════════════════════════════════════════

interface DocSequenceRow {
  docType: string;
  label: string;
  prefix: string;
  nextNumber: number;
  includeYear: boolean;
  padding: number;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  INV:  'Final Invoice',
  PINV: 'Partial Invoice',
  PUR:  'Purchase',
  PRET: 'Purchase Return',
  RET:  'Sales Return',
  REP:  'Repair',
  AGD:  'Agent Document',
  LOA:  'Loan',
  PRD:  'Production Record',
  PST:  'Partner Investment',
  PWD:  'Partner Withdrawal',
  CON:  'Consignment Intake',
  EXP:  'Expense',
  OFF:  'Offer',
  TRF:  'Transfer',
};

function NumberRangesTab() {
  const [saved, setSaved] = useState('');
  const [rows, setRows] = useState<DocSequenceRow[]>([]);
  const year = new Date().getFullYear();

  useEffect(() => { load(); }, []);

  function load() {
    try {
      const res = query(
        `SELECT doc_type, prefix, next_number, include_year, padding FROM document_sequences ORDER BY doc_type`,
        []
      );
      setRows(res.map(r => ({
        docType: r.doc_type as string,
        label: DOC_TYPE_LABELS[r.doc_type as string] || (r.doc_type as string),
        prefix: r.prefix as string,
        nextNumber: Number(r.next_number) || 1,
        includeYear: Number(r.include_year) === 1,
        padding: Number(r.padding) || 6,
      })));
    } catch {
      setRows([]);
    }
  }

  function updateRow(docType: string, patch: Partial<DocSequenceRow>) {
    setRows(rs => rs.map(r => r.docType === docType ? { ...r, ...patch } : r));
  }

  function save() {
    const db = getDatabase();
    const now = new Date().toISOString();
    for (const r of rows) {
      db.run(
        `UPDATE document_sequences SET prefix = ?, next_number = ?, include_year = ?, padding = ?, updated_at = ? WHERE doc_type = ?`,
        [r.prefix.toUpperCase(), r.nextNumber, r.includeYear ? 1 : 0, r.padding, now, r.docType]
      );
    }
    saveDatabase();
    setSaved('Document prefixes saved.');
  }

  function preview(r: DocSequenceRow): string {
    const seq = String(r.nextNumber).padStart(r.padding, '0');
    return r.includeYear ? `${r.prefix}-${year}-${seq}` : `${r.prefix}-${seq}`;
  }

  return (
    <div>
      <SectionTitle>Document Prefixes &amp; Number Ranges</SectionTitle>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}
      <Card>
        <div style={{ padding: 8 }}>
          <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 20 }}>
            Configure prefix, next number and format per document type (Plan §Settings §B). Format: PREFIX-YEAR-SEQUENCE (year optional).
            <br />Numbers are never reused — the system always takes the next available one.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.8fr 0.7fr 0.7fr 1.6fr', gap: 10, padding: '4px 8px', marginBottom: 6 }}>
            <span className="text-overline">DOC TYPE</span>
            <span className="text-overline">PREFIX</span>
            <span className="text-overline">NEXT #</span>
            <span className="text-overline">YEAR</span>
            <span className="text-overline">PAD</span>
            <span className="text-overline">PREVIEW</span>
          </div>
          {rows.map(r => (
            <div key={r.docType} style={{
              display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.8fr 0.7fr 0.7fr 1.6fr',
              gap: 10, alignItems: 'center',
              padding: '10px 8px', borderBottom: '1px solid #E5E9EE',
            }}>
              <div>
                <span style={{ fontSize: 13, color: '#0F0F10' }}>{r.label}</span>
                <div style={{ fontSize: 10, color: '#9CA3AF', fontFamily: 'monospace' }}>{r.docType}</div>
              </div>
              <Input value={r.prefix} onChange={e => updateRow(r.docType, { prefix: e.target.value.toUpperCase() })} style={{ maxWidth: 100 }} />
              <Input type="number" value={r.nextNumber} onChange={e => updateRow(r.docType, { nextNumber: parseInt(e.target.value) || 1 })} style={{ maxWidth: 90 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#4B5563' }}>
                <input type="checkbox" checked={r.includeYear} onChange={e => updateRow(r.docType, { includeYear: e.target.checked })} />
                YYYY
              </label>
              <Input type="number" value={r.padding} onChange={e => updateRow(r.docType, { padding: Math.max(1, parseInt(e.target.value) || 6) })} style={{ maxWidth: 70 }} />
              <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>{preview(r)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="primary" onClick={save}>Save Changes</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// LANGUAGE TAB
// ═══════════════════════════════════════════════════════════

function LanguageTab() {
  const [saved, setSaved] = useState('');
  const [lang, setLangLocal] = useState<'en' | 'ar'>('en');

  useEffect(() => {
    import('@/core/i18n/i18n').then(i18n => {
      setLangLocal(i18n.getLanguage());
    });
  }, []);

  async function handleChange(newLang: 'en' | 'ar') {
    const i18n = await import('@/core/i18n/i18n');
    i18n.setLanguage(newLang);
    setLangLocal(newLang);
    setSaved(newLang === 'en' ? 'Language set to English.' : 'تم تغيير اللغة إلى العربية');
  }

  return (
    <div>
      <SectionTitle>Language / اللغة</SectionTitle>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}
      <Card>
        <div style={{ padding: 8 }}>
          <div className="flex gap-4">
            <button onClick={() => handleChange('en')}
              className="cursor-pointer rounded-xl transition-all flex-1"
              style={{
                padding: '24px 20px', textAlign: 'center',
                border: `2px solid ${lang === 'en' ? '#0F0F10' : '#E5E9EE'}`,
                background: lang === 'en' ? 'rgba(15,15,16,0.06)' : 'transparent',
              }}>
              <span style={{ fontSize: 28, display: 'block', marginBottom: 8 }}>EN</span>
              <span style={{ fontSize: 14, color: lang === 'en' ? '#0F0F10' : '#4B5563', fontWeight: 500 }}>English</span>
            </button>
            <button onClick={() => handleChange('ar')}
              className="cursor-pointer rounded-xl transition-all flex-1"
              style={{
                padding: '24px 20px', textAlign: 'center',
                border: `2px solid ${lang === 'ar' ? '#0F0F10' : '#E5E9EE'}`,
                background: lang === 'ar' ? 'rgba(15,15,16,0.06)' : 'transparent',
              }}>
              <span style={{ fontSize: 28, display: 'block', marginBottom: 8, fontFamily: 'Arial' }}>عر</span>
              <span style={{ fontSize: 14, color: lang === 'ar' ? '#0F0F10' : '#4B5563', fontWeight: 500 }}>العربية</span>
            </button>
          </div>
          <p style={{ fontSize: 12, color: '#6B7280', marginTop: 16, lineHeight: 1.6 }}>
            {lang === 'ar'
              ? 'تغيير اللغة يؤثر على واجهة المستخدم. البيانات تبقى كما هي.'
              : 'Changing the language affects the UI. Your data remains unchanged.'}
          </p>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// COUNTRY CODES TAB — Erweiterung der PhoneInput-Country-Liste.
// Built-in Laender sind read-only; eigene Eintraege werden in der `settings`
// Tabelle (key: contacts.custom_countries) persistiert.
// ═══════════════════════════════════════════════════════════

function CountryCodesTab() {
  const customCountries = useCountryCodesStore(s => s.customCountries);
  const loaded = useCountryCodesStore(s => s.loaded);
  const load = useCountryCodesStore(s => s.load);
  const addCountry = useCountryCodesStore(s => s.add);
  const updateCountry = useCountryCodesStore(s => s.update);
  const removeCountry = useCountryCodesStore(s => s.remove);

  useEffect(() => { if (!loaded) load(); }, [loaded, load]);

  const [showForm, setShowForm] = useState(false);
  const [editIso, setEditIso] = useState<string | null>(null);
  const [form, setForm] = useState<CountryCode>({ iso: '', dial: '', label: '', flag: '', example: '', maxLength: undefined });
  const [error, setError] = useState('');

  function reset() {
    setForm({ iso: '', dial: '', label: '', flag: '', example: '', maxLength: undefined });
    setEditIso(null);
    setError('');
  }
  function openNew() {
    reset();
    setShowForm(true);
  }
  function openEdit(c: CountryCode) {
    setForm({ ...c });
    setEditIso(c.iso);
    setError('');
    setShowForm(true);
  }
  function closeForm() {
    setShowForm(false);
    reset();
  }

  function validate(): string | null {
    const iso = form.iso.trim().toUpperCase();
    const dial = form.dial.trim();
    const label = form.label.trim();
    const flag = form.flag.trim();
    if (!/^[A-Z]{2}$/.test(iso)) return 'ISO must be 2 uppercase letters (e.g. OM, EG, IN).';
    if (!/^\+\d{1,4}$/.test(dial)) return 'Dial code must start with "+" followed by 1–4 digits (e.g. +968).';
    if (!label) return 'Label is required.';
    if (!flag) return 'Flag emoji is required (paste from emojipedia).';

    const builtinClash = COUNTRIES.some(b => b.iso === iso);
    if (builtinClash) return `ISO "${iso}" already exists as a built-in country.`;
    const customClash = customCountries.some(c => c.iso === iso && c.iso !== editIso);
    if (customClash) return `ISO "${iso}" is already used by another custom country.`;
    return null;
  }

  function handleSave() {
    const err = validate();
    if (err) { setError(err); return; }
    const cleaned: CountryCode = {
      iso: form.iso.trim().toUpperCase(),
      dial: form.dial.trim(),
      label: form.label.trim(),
      flag: form.flag.trim(),
      example: form.example?.trim() || undefined,
      maxLength: form.maxLength && form.maxLength > 0 ? Number(form.maxLength) : undefined,
    };
    if (editIso && editIso !== cleaned.iso) {
      // ISO has changed → remove old, add new (uncommon but valid).
      removeCountry(editIso);
      addCountry(cleaned);
    } else if (editIso) {
      updateCountry(editIso, cleaned);
    } else {
      addCountry(cleaned);
    }
    closeForm();
  }

  function handleDelete(iso: string) {
    if (!confirm(`Remove "${iso}"? Existing phone numbers stored with this code will still be readable but displayed under the default country.`)) return;
    removeCountry(iso);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '32px 32px 0', maxWidth: 760 }}>
      <Card>
        <h2 style={{ fontSize: 16, color: '#0F0F10', marginBottom: 8 }}>Country Codes</h2>
        <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 16, lineHeight: 1.5 }}>
          The PhoneInput dropdown shows these countries when creating/editing clients, suppliers, agents, partners, and employees.
          Built-in countries are read-only. Add your own to extend the list.
        </p>

        {/* Built-in list */}
        <div style={{ marginBottom: 20 }}>
          <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>BUILT-IN ({COUNTRIES.length})</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {COUNTRIES.map(c => (
              <div key={c.iso} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px', background: '#F2F7FA', borderRadius: 6,
                border: '1px solid #E5E9EE', fontSize: 13,
              }}>
                <span style={{ fontSize: 16 }}>{c.flag}</span>
                <span style={{ flex: 1, color: '#0F0F10' }}>{c.label}</span>
                <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>{c.dial}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Custom list + add */}
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <span className="text-overline">CUSTOM ({customCountries.length})</span>
          <Button variant="primary" onClick={openNew}><Plus size={12} /> Add Country</Button>
        </div>

        {customCountries.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', fontSize: 13, color: '#6B7280',
                       border: '1px dashed #D5D9DE', borderRadius: 8 }}>
            No custom countries yet. Click "Add Country" to extend the list.
          </div>
        )}

        {customCountries.map(c => (
          <div key={c.iso} className="flex items-center" style={{
            gap: 10, padding: '10px 12px', borderBottom: '1px solid #E5E9EE', fontSize: 13,
          }}>
            <span style={{ fontSize: 18 }}>{c.flag}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#0F0F10' }}>{c.label}</div>
              <div style={{ fontSize: 11, color: '#6B7280' }}>
                <span className="font-mono">{c.dial}</span>
                <span style={{ marginLeft: 8 }}>· {c.iso}</span>
                {c.example && <span style={{ marginLeft: 8 }}>· e.g. {c.example}</span>}
                {c.maxLength && <span style={{ marginLeft: 8 }}>· max {c.maxLength} digits</span>}
              </div>
            </div>
            <button onClick={() => openEdit(c)}
              className="cursor-pointer"
              style={{ padding: '6px 10px', fontSize: 12, color: '#4B5563',
                       background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6 }}>
              <Pencil size={12} />
            </button>
            <button onClick={() => handleDelete(c.iso)}
              className="cursor-pointer"
              style={{ padding: '6px 10px', fontSize: 12, color: '#DC2626',
                       background: 'transparent', border: '1px solid rgba(220,38,38,0.30)', borderRadius: 6 }}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </Card>

      {/* Add/Edit Modal */}
      <Modal open={showForm} onClose={closeForm} title={editIso ? `Edit ${editIso}` : 'Add Country Code'} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div style={{ padding: '10px 12px', background: 'rgba(220,38,38,0.06)',
                         border: '1px solid rgba(220,38,38,0.30)', borderRadius: 8,
                         fontSize: 12, color: '#DC2626' }}>{error}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Input required label="FLAG" placeholder="🇴🇲"
              value={form.flag} onChange={e => setForm({ ...form, flag: e.target.value })} />
            <Input required label="ISO (2 letters)" placeholder="OM"
              value={form.iso} onChange={e => setForm({ ...form, iso: e.target.value.toUpperCase() })} />
            <Input required label="DIAL CODE" placeholder="+968"
              value={form.dial} onChange={e => setForm({ ...form, dial: e.target.value })} />
          </div>
          <Input required label="LABEL" placeholder="Oman"
            value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="EXAMPLE (optional)" placeholder="9xxxxxxx"
              value={form.example || ''} onChange={e => setForm({ ...form, example: e.target.value })} />
            <Input label="MAX DIGITS (optional)" type="number" placeholder="8"
              value={form.maxLength ?? ''} onChange={e => setForm({ ...form, maxLength: parseInt(e.target.value) || undefined })} />
          </div>
          <p style={{ fontSize: 11, color: '#6B7280', lineHeight: 1.5 }}>
            Find values: ISO at <span className="font-mono">en.wikipedia.org/wiki/ISO_3166-1_alpha-2</span>,
            dial code at <span className="font-mono">en.wikipedia.org/wiki/List_of_country_calling_codes</span>,
            flag emoji at <span className="font-mono">emojipedia.org/flags</span>.
          </p>
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={closeForm}>Cancel</Button>
            <Button variant="primary" onClick={handleSave}>{editIso ? 'Save' : 'Add Country'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// AI TAB
// ═══════════════════════════════════════════════════════════

function AiTab() {
  const [apiKey, setApiKeyLocal] = useState('');
  const [model, setModelLocal] = useState('gpt-4o');
  const [saved, setSaved] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    import('@/core/ai/ai-service').then(ai => {
      setApiKeyLocal(ai.getApiKey());
      setModelLocal(ai.getModel());
    });
  }, []);

  async function handleSave() {
    const ai = await import('@/core/ai/ai-service');
    ai.setApiKey(apiKey);
    ai.setModel(model);
    setSaved('AI settings saved.');
  }

  async function handleTest() {
    setTesting(true);
    setTestResult('');
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (res.ok) {
        setTestResult('Connection successful! API key is valid.');
      } else {
        setTestResult(`Error: ${res.status} — check your API key.`);
      }
    } catch {
      setTestResult('Connection failed — check your internet.');
    }
    setTesting(false);
  }

  const models = [
    { value: 'gpt-4o', label: 'GPT-4o', desc: 'Best quality, vision support' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini', desc: 'Faster, cheaper' },
    { value: 'gpt-4.1', label: 'GPT-4.1', desc: 'Latest model' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', desc: 'Latest, faster' },
  ];

  return (
    <div>
      <SectionTitle>AI Configuration (OpenAI)</SectionTitle>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}

      <Card>
        <div style={{ padding: 8 }}>
          <FieldRow label="API Key">
            <Input
              type="password"
              value={apiKey}
              onChange={e => setApiKeyLocal(e.target.value)}
              placeholder="sk-..."
            />
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
              Get your key at platform.openai.com/api-keys
            </p>
          </FieldRow>

          <FieldRow label="Model">
            <div className="flex flex-wrap gap-2">
              {models.map(m => (
                <button key={m.value}
                  onClick={() => setModelLocal(m.value)}
                  className="cursor-pointer rounded-lg transition-all duration-200"
                  style={{
                    padding: '8px 14px', fontSize: 12, textAlign: 'left',
                    border: `1px solid ${model === m.value ? '#0F0F10' : '#D5D9DE'}`,
                    color: model === m.value ? '#0F0F10' : '#6B7280',
                    background: model === m.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  <span style={{ fontWeight: 500, display: 'block' }}>{m.label}</span>
                  <span style={{ fontSize: 10, color: '#6B7280' }}>{m.desc}</span>
                </button>
              ))}
            </div>
          </FieldRow>

          {testResult && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 6, fontSize: 13,
              background: testResult.includes('successful') ? 'rgba(126,170,110,0.08)' : 'rgba(220,38,38,0.08)',
              color: testResult.includes('successful') ? '#7EAA6E' : '#AA6E6E',
            }}>{testResult}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <Button variant="ghost" onClick={handleTest} disabled={testing || !apiKey}>
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>
            <Button variant="primary" onClick={handleSave}>Save</Button>
          </div>
        </div>
      </Card>

      {/* What AI does */}
      <div style={{ marginTop: 16 }}>
        <Card>
          <div style={{ padding: 8 }}>
            <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 12 }}>AI Features</h4>
            {[
              { label: 'Product Recognition', desc: 'Upload a photo to auto-fill brand, model, reference, and estimated value' },
              { label: 'Price Suggestions', desc: 'Get market-based pricing recommendations for your products' },
              { label: 'Offer Text Generation', desc: 'Generate professional offer messages for customers' },
              { label: 'Customer Messages', desc: 'Generate follow-up, repair-ready, and thank-you messages' },
            ].map((f, i) => (
              <div key={i} style={{ padding: '10px 0', borderBottom: i < 3 ? '1px solid #E5E9EE' : 'none' }}>
                <span style={{ fontSize: 13, color: '#0F0F10', fontWeight: 500 }}>{f.label}</span>
                <span style={{ fontSize: 12, color: '#6B7280', display: 'block', marginTop: 2 }}>{f.desc}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SYNC TAB
// ═══════════════════════════════════════════════════════════

function SyncTab() {
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState('');
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState('');
  const [lanMode, setLanModeUi] = useState<'server' | 'client' | 'manual' | 'off' | 'unknown'>('unknown');
  const [serverStatus, setServerStatus] = useState<{ running: boolean; port: number; ip: string; url: string } | null>(null);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  // M6-B2A2: die serverseitig gehaltene Rolle. localStorage ist hier nur noch Anzeige.
  const [primaryState, setPrimaryState] = useState<string>('');

  // M6-B2A4: hat dieser Server ueberhaupt schon ein Owner-Passwort? Bis dahin ist
  // gar nichts moeglich — kein Login, kein Serverstart, keine Owner-Aktion.
  const [ownerSetupRequired, setOwnerSetupRequired] = useState(false);

  async function refreshServer() {
    const { getServerStatus } = await import('@/core/sync/sync-server');
    const s = await getServerStatus();
    setServerStatus(s);
    const lan = await import('@/core/sync/auto-lan');
    const st = await lan.getPrimaryStatus();
    setPrimaryState(st?.state ?? '');
    const { getServerOwnerStatus } = await import('@/core/sync/server-owner');
    const owner = await getServerOwnerStatus();
    setOwnerSetupRequired(owner?.provisioningRequired ?? false);
  }

  // M6-B2A4: Erst-Provisionierung des Server-Owner-Passworts.
  //
  // Bis v0.8.23 lieferte jede Installation `admin@lataif.com` / `admin` als
  // funktionierenden Owner aus — dieselbe Konstante ueberall, unaenderbar. Sie erfuellte
  // die Owner-Pruefung UND `/auth/login`, das ein Owner-JWT ausstellt und damit
  // `/sync/push` fuer jeden im WLAN oeffnete. Jetzt gibt es gar kein Passwort mehr,
  // bis der Owner hier eines setzt.
  //
  // Diese Seite ist KEINE Sicherheitsgrenze: sie sammelt nur ein. Rust prueft Phrase,
  // Laenge und Bestaetigung und lehnt eine zweite Provisionierung ab.
  async function handleProvisionOwner() {
    const { provisionServerOwner, getServerOwnerStatus } = await import('@/core/sync/server-owner');
    const status = await getServerOwnerStatus();
    if (!status) return;

    const password = window.prompt(
      `Choose a password for this machine's sync server owner (min ${status.minPasswordLength} characters).\n\n` +
      `This replaces the old shared default. Other devices will use it to sync to this machine.`
    );
    if (!password) return;
    const confirm = window.prompt('Repeat the password:');
    if (!confirm) return;
    if (!window.confirm(
      'Set this machine as the sync server owner?\n\n' +
      'Keep this password safe — it is the only way to change the sync role later.'
    )) return;

    try {
      await provisionServerOwner(password, confirm, status.confirmationPhrase);
      await refreshServer();
      setResult('Server owner password set. You can now start the LAN sync server.');
    } catch (err) {
      setResult(explain(String(err)));
    }
  }

  async function handleChangeOwnerPassword() {
    const { changeServerOwnerPassword } = await import('@/core/sync/server-owner');
    const email = window.prompt('Owner email:');
    if (!email) return;
    const current = window.prompt('Current owner password:');
    if (!current) return;
    const next = window.prompt('New password (min 12 characters):');
    if (!next) return;
    const confirm = window.prompt('Repeat the new password:');
    if (!confirm) return;
    try {
      await changeServerOwnerPassword(email, current, next, confirm);
      setResult('Server owner password changed.');
    } catch (err) {
      setResult(explain(String(err)));
    }
  }

  useEffect(() => {
    import('@/core/sync/sync-service').then(sync => {
      setServerUrl(sync.getSyncUrl() || 'http://localhost:3001');
      setStatus(sync.isSyncConfigured() ? 'Connected' : 'Not connected');
      sync.onSyncStatus((s, msg) => {
        setStatus(s === 'synced' ? `Synced${msg ? ` (${msg})` : ''}` : s === 'syncing' ? 'Syncing...' : s === 'error' ? `Error: ${msg}` : 'Offline');
      });
    });
    import('@/core/sync/auto-lan').then(lan => setLanModeUi(lan.getLanMode()));
    refreshServer();
  }, []);

  // M6-B2A/B2A1: Der Server startet nicht mehr "einfach so" — er startet, WEIL diese
  // Installation ausdruecklich als Primary konfiguriert wurde, und das darf nur der Owner.
  //
  // Diese Seite ist KEINE Sicherheitsgrenze: sie sammelt die Credentials nur ein, Rust
  // prueft sie gegen den bcrypt-Hash in der Server-DB. Ein `invoke` an dieser UI vorbei
  // scheitert an derselben Pruefung. Die Rollenanzeige hier ist reine UX.
  //
  // Ausschalten setzt die Rolle auf `client` (nicht `unconfigured`): das Geraet soll
  // weiter synchronisieren duerfen, nur nicht mehr selbst Host sein.
  function explain(msg: string): string {
    if (msg.includes('OWNER_PROVISIONING_REQUIRED')) return 'This server has no owner password yet. Set one first (Server owner setup).';
    if (msg.includes('OWNER_ALREADY_PROVISIONED')) return 'This server already has an owner password. Use "Change password" instead.';
    if (msg.includes('PROVISION_PASSWORD_TOO_SHORT')) return 'Password too short (minimum 12 characters).';
    if (msg.includes('PROVISION_PASSWORD_MISMATCH')) return 'The two passwords do not match.';
    if (msg.includes('PROVISION_CONFIRMATION_REQUIRED')) return 'Setup was not confirmed.';
    if (msg.includes('OWNER_AUTHORIZATION_REQUIRED')) return 'Not authorized: owner credentials required.';
    if (msg.includes('INSTANCE_ID_MISMATCH')) return 'This server database belongs to a different installation. The role cannot be changed here.';
    if (msg.includes('LEGACY_ADOPTION_NOT_CONFIRMED')) return 'Adoption was not confirmed.';
    if (msg.includes('NO_LEGACY_ADOPTION_PENDING')) return 'No legacy server role is pending adoption on this device.';
    return msg;
  }

  async function handleToggleServer() {
    const { startSyncServer, stopSyncServer } = await import('@/core/sync/sync-server');
    const lan = await import('@/core/sync/auto-lan');
    const target: 'primary' | 'client' = serverStatus?.running ? 'client' : 'primary';

    const email = window.prompt('Owner email (required to change the sync role):');
    if (!email) return;
    const password = window.prompt('Owner password:');
    if (!password) return;

    try {
      if (target === 'client') {
        await stopSyncServer(email, password);
        await lan.configurePrimaryMode('client', email, password);
        lan.setLanMode('off');
        setLanModeUi('off');
      } else {
        await lan.configurePrimaryMode('primary', email, password);   // erst die Rolle …
        await startSyncServer();                                      // … dann der Start
        lan.setLanMode('server');
        setLanModeUi('server');
      }
      await refreshServer();
    } catch (err) {
      setResult(explain(String(err)));
    }
  }

  // M6-B2A2: Einmalige Bestaetigung einer erkannten Legacy-Serverrolle. Sichtbar nur,
  // solange `primary_status.state === 'legacy_adoption_required'` — danach nie wieder.
  async function handleAdoptLegacy() {
    const lan = await import('@/core/sync/auto-lan');
    const { startSyncServer } = await import('@/core/sync/sync-server');
    if (!window.confirm(
      'This device was a sync server before the update. Adopting it makes THIS installation the primary.\n\n' +
      'Only do this if this is the real host. A copied server database must not be adopted here.'
    )) return;
    const email = window.prompt('Owner email (required to adopt the legacy server role):');
    if (!email) return;
    const password = window.prompt('Owner password:');
    if (!password) return;
    try {
      await lan.adoptLegacyPrimary(email, password);
      await startSyncServer();
      lan.setLanMode('server');
      setLanModeUi('server');
      setPrimaryState('primary');
      await refreshServer();
      setResult('This device is now the sync primary.');
    } catch (err) {
      setResult(explain(String(err)));
    }
  }

  async function handleDiscover() {
    setDiscovering(true);
    const { discoverLanServers } = await import('@/core/sync/sync-server');
    try {
      const found = await discoverLanServers(3);
      setDiscovered(found);
    } finally {
      setDiscovering(false);
    }
  }

  function useDiscoveredUrl(url: string) {
    setServerUrl(url);
    setSaved(`URL updated to ${url}. Login below to connect.`);
  }

  async function handleConnect() {
    setConnecting(true);
    setResult('');
    const sync = await import('@/core/sync/sync-service');
    const res = await sync.connectToServer(serverUrl, email, password);
    if (res.success) {
      setResult('Connected successfully!');
      setStatus('Connected');
      setSaved('Server connection saved.');
    } else {
      setResult(res.error || 'Connection failed');
    }
    setConnecting(false);
  }

  async function handleDisconnect() {
    const sync = await import('@/core/sync/sync-service');
    sync.clearSyncConfig();
    sync.stopAutoSync();
    setStatus('Not connected');
    setSaved('Disconnected from server.');
  }

  async function handleSyncNow() {
    const sync = await import('@/core/sync/sync-service');
    await sync.syncNow();
  }

  return (
    <div>
      <SectionTitle>Server Synchronization</SectionTitle>
      {saved && <SuccessBanner message={saved} onDone={() => setSaved('')} />}

      {/* LAN Server role */}
      {serverStatus && (
        <Card>
          <div style={{ padding: 8 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
              <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10' }}>This machine</h4>
              <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, color: serverStatus.running ? '#7EAA6E' : '#6B7280', background: serverStatus.running ? 'rgba(126,170,110,0.08)' : 'rgba(107,107,115,0.08)', border: `1px solid ${serverStatus.running ? 'rgba(126,170,110,0.2)' : 'rgba(107,107,115,0.15)'}` }}>
                {serverStatus.running ? (lanMode === 'server' ? 'SERVER ACTIVE' : 'SERVER RUNNING') : 'CLIENT ONLY'}
              </span>
            </div>
            <p style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.6, marginBottom: 12 }}>
              {serverStatus.running
                ? `Other LATAIF installations in your network can sync to this machine. Share this URL with other devices: `
                : `Start this machine as a sync server if you want other LATAIF installations in the same network (same Wi-Fi or LAN) to sync against it. This is an explicit owner decision — no device ever becomes the server on its own.`}
              {serverStatus.running && (
                <code style={{ color: '#0F0F10', background: '#F2F7FA', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{serverStatus.url}</code>
              )}
            </p>
            {/* M6-B2A4: ohne Owner-Passwort geht gar nichts — zuerst anzeigen. */}
            {ownerSetupRequired && (
              <div style={{ marginBottom: 12, padding: '10px 12px', background: '#EFF6FF', borderRadius: 6, border: '1px solid #93C5FD' }}>
                <p style={{ fontSize: 12, color: '#1E3A8A', lineHeight: 1.6, marginBottom: 8 }}>
                  <strong>Server owner setup required.</strong>{' '}
                  This machine has no sync server password yet. Earlier versions shipped a
                  shared default; it has been disabled. Set your own password before starting
                  the LAN server.
                </p>
                <Button variant="primary" onClick={handleProvisionOwner}>Set server owner password</Button>
              </div>
            )}
            {!ownerSetupRequired && (
              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={handleChangeOwnerPassword}
                  style={{ fontSize: 12, color: '#6B7280', textDecoration: 'underline', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  Change server owner password
                </button>
              </div>
            )}
            {/* M6-B2A2: einmalige Bestaetigung einer erkannten Legacy-Serverrolle. */}
            {primaryState === 'legacy_adoption_required' && (
              <div style={{ marginBottom: 12, padding: '10px 12px', background: '#FFF7ED', borderRadius: 6, border: '1px solid #FDBA74' }}>
                <p style={{ fontSize: 12, color: '#9A3412', lineHeight: 1.6, marginBottom: 8 }}>
                  This device was configured as a sync server before the update. Confirm once that
                  <strong>{' '}this installation{' '}</strong>
                  is the real host — a copied server database must not be adopted here.
                </p>
                <Button variant="primary" onClick={handleAdoptLegacy}>Adopt this device as sync primary</Button>
              </div>
            )}
            {primaryState === 'read_only' && (
              <div style={{ marginBottom: 12, padding: '10px 12px', background: '#FEF2F2', borderRadius: 6, border: '1px solid #FCA5A5' }}>
                <p style={{ fontSize: 12, color: '#991B1B', lineHeight: 1.6 }}>
                  This server database belongs to a different installation (read-only). Sync writes are refused.
                </p>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button variant={serverStatus.running ? 'danger' : 'primary'} onClick={handleToggleServer}>
                {serverStatus.running ? 'Stop Server' : 'Start as Server'}
              </Button>
              <Button variant="secondary" onClick={handleDiscover} disabled={discovering}>
                {discovering ? 'Searching...' : 'Find Servers on LAN'}
              </Button>
            </div>
            {discovered.length > 0 && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: '#F2F7FA', borderRadius: 6, border: '1px solid #E5E9EE' }}>
                <span style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Discovered servers</span>
                {discovered.map(u => (
                  <div key={u} className="flex items-center justify-between" style={{ marginTop: 8 }}>
                    <code style={{ fontSize: 12, color: '#0F0F10' }}>{u}</code>
                    <Button variant="ghost" onClick={() => useDiscoveredUrl(u)}>Use</Button>
                  </div>
                ))}
              </div>
            )}
            {discovered.length === 0 && discovering === false && (
              <p style={{ fontSize: 11, color: '#6B7280', marginTop: 10 }}>
                No servers discovered yet. Click "Find Servers on LAN" to search.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Status */}
      <div style={{ marginTop: 16 }}>
      <Card>
        <div style={{ padding: 8 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
            <div className="flex items-center gap-3">
              <span className="rounded-full" style={{
                width: 10, height: 10,
                background: status.startsWith('Synced') || status === 'Connected' ? '#7EAA6E' : status === 'Syncing...' ? '#0F0F10' : '#AA6E6E',
              }} />
              <span style={{ fontSize: 14, color: '#0F0F10' }}>{status}</span>
            </div>
            {status !== 'Not connected' && status !== 'Offline' && (
              <div className="flex gap-2">
                <Button variant="ghost" onClick={handleSyncNow}>Sync Now</Button>
                <Button variant="danger" onClick={handleDisconnect}>Disconnect</Button>
              </div>
            )}
          </div>
        </div>
      </Card>
      </div>

      {/* Connect */}
      <div style={{ marginTop: 16 }}>
        <Card>
          <div style={{ padding: 8 }}>
            <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 16 }}>Connect to Server</h4>
            <FieldRow label="Server URL">
              <Input value={serverUrl} onChange={e => setServerUrl(e.target.value)} placeholder="http://your-server:3001" />
            </FieldRow>
            <FieldRow label="Email">
              <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" />
            </FieldRow>
            <FieldRow label="Password">
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
            </FieldRow>
            {result && (
              <div style={{
                marginBottom: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13,
                background: result.includes('success') ? 'rgba(126,170,110,0.08)' : 'rgba(220,38,38,0.08)',
                color: result.includes('success') ? '#7EAA6E' : '#AA6E6E',
              }}>{result}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="primary" onClick={handleConnect} disabled={connecting || !serverUrl || !email || !password}>
                {connecting ? 'Connecting...' : 'Connect'}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Info */}
      <div style={{ marginTop: 16, padding: '14px 20px', background: '#FFFFFF', borderRadius: 8, border: '1px solid #E5E9EE' }}>
        <p style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.6 }}>
          Connect to a LATAIF sync server to synchronize data between multiple devices.
          Changes are synced automatically every 30 seconds. The app works offline — changes are queued and synced when the server is reachable again.
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// DANGER ZONE TAB
// ═══════════════════════════════════════════════════════════

// ── Duplicates Tab — Cluster-basiert (Union-Find auf dem Aehnlichkeits-Graph) ──
// Pro Verbindungskomponente eine Gruppe; transitive Duplikate (A~B, B~C → {A,B,C})
// landen in derselben Karte. Master-Suggestion via Score:
//   linked records +1000, SKU +100, Stock +50, Stammdaten +20, Bilder +5/each, Alter
// User kann Master manuell überschreiben, einzelne Items aus der Gruppe entfernen
// (False-Positive), oder die ganze Gruppe ignorieren. Sicherheits-Check: Produkte
// mit linked records werden niemals gelöscht — Delete fällt auf Merge zurück.

interface DuplicateEdge {
  otherId: string;
  score: number;
  reasons: string[];
}

interface DuplicateGroup {
  id: string;                                         // sorted-member-ids als stable key
  members: Product[];
  edgesByMember: Map<string, DuplicateEdge[]>;
  maxScore: number;
  topReasons: string[];                                // unique, by frequency
  suggestedMasterId: string;
  masterReasons: string[];                             // why this is the suggested master
  linkedCounts: Map<string, number>;
}

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();
  constructor(ids: string[]) {
    for (const id of ids) { this.parent.set(id, id); this.rank.set(id, 0); }
  }
  find(x: string): string {
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      const p = this.parent.get(cur)!;
      this.parent.set(cur, this.parent.get(p)!);
      cur = this.parent.get(cur)!;
    }
    return cur;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) || 0;
    const rankB = this.rank.get(rb) || 0;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else { this.parent.set(rb, ra); this.rank.set(ra, rankA + 1); }
  }
}

function computeMasterScore(p: Product, linkedCount: number): number {
  let s = 0;
  if (linkedCount > 0) s += 1000 + Math.min(linkedCount, 10) * 10;     // 1) linked > all
  if (p.sku) s += 100;                                                  // 2) hat SKU
  if ((p.quantity || 0) > 0 && p.stockStatus === 'in_stock') s += 50;  // 3) Bestand
  if (p.brand) s += 20;                                                 // 4) Stammdaten
  if (p.name) s += 20;
  if (p.plannedSalePrice && p.plannedSalePrice > 0) s += 20;
  if (p.notes) s += 10;
  s += Math.min(p.images.length, 5) * 5;                                // 5) Bilder
  // 6) Alter — bis zu 10 Punkte (1 pro Monat, gecappt)
  try {
    const days = (Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    s += Math.min(days / 30, 10);
  } catch { /* */ }
  return s;
}

function describeMasterReasons(p: Product, linkedCount: number): string[] {
  const out: string[] = [];
  if (linkedCount > 0) out.push(`${linkedCount} verknüpfte Datensätze`);
  if (p.sku) out.push(`hat SKU (${p.sku})`);
  if ((p.quantity || 0) > 0 && p.stockStatus === 'in_stock') out.push(`auf Lager`);
  const stammdatenCount = [p.brand, p.name, p.plannedSalePrice].filter(Boolean).length;
  if (stammdatenCount === 3) out.push('vollständige Stammdaten');
  if (p.images.length > 1) out.push(`${p.images.length} Bilder`);
  return out;
}

function severityFromScore(score: number): { text: string; color: string; bg: string } {
  // 2026-05-18 — neue Schwellen passend zu STRONG (>=80) / POSSIBLE (60-79).
  if (score >= 150) return { text: 'Almost certainly duplicate', color: '#AA6E6E', bg: 'rgba(170,110,110,0.10)' };
  if (score >= 80)  return { text: 'Likely duplicate',           color: '#AA956E', bg: 'rgba(170,149,110,0.12)' };
  return { text: 'Possibly similar', color: '#6E8AAA', bg: 'rgba(110,138,170,0.12)' };
}

function StatusCell({ label, value, sub, tone }: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'muted';
}) {
  const valueColor = tone === 'good' ? '#5C8550' : tone === 'warn' ? '#AA956E' : '#0F0F10';
  return (
    <div>
      <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {label}
      </div>
      <div className="font-display" style={{ fontSize: 22, color: valueColor, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function DuplicatesTab() {
  const { products, updateProduct, deleteProduct, mergeIntoExisting, getLinkedRecordCounts, loadProducts } = useProductStore();
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ stage: string; current: number; total: number } | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [ignoredGroups, setIgnoredGroups] = useState<Set<string>>(new Set());
  const [actionMsg, setActionMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Backfill-State
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ current: number; total: number; errors: number } | null>(null);

  // Status: wie viele Produkte haben AI-Embedding, wie viele nicht, wie viele
  // gar kein Foto. Damit der User sieht was Stage-1 ueberhaupt vergleichen kann.
  const embeddingStatus = useMemo(() => {
    let withEmb = 0, withImgNoEmb = 0, noImg = 0;
    for (const p of products) {
      if (!p.images || p.images.length === 0) { noImg++; continue; }
      if (p.imageEmbedding && p.imageEmbedding.length > 0) withEmb++;
      else withImgNoEmb++;
    }
    return { withEmb, withImgNoEmb, noImg, total: products.length };
  }, [products]);

  const apiKeyOk = isAiConfigured();

  // 2026-05-18 — Two-Stage Duplicate Scan:
  //   Stage 1 (lokal, kostenlos): paarweise Cosine-Similarity der gespeicherten
  //     AI-Embeddings + Kategorie-Filter. Findet ~30-100 Kandidaten aus 200 Items.
  //   Stage 2 (GPT-4o-mini Vision): schickt beide Fotos direkt an die LLM mit
  //     Prompt "same physical product yes/no?". Nur isMatch=true (high
  //     confidence) wird als STRONG-Edge im Cluster verwendet. Andere Antworten
  //     ("uncertain" / "no") werden verworfen.
  //
  // Vorteil ggue. dem alten Text-Score: das Text-Embedding einer Bild-Beschreibung
  // misst Sprach-Naehe, nicht Produkt-Identitaet. GPT-4o-Vision sieht die echten
  // Identitaets-Merkmale (Modell-Nummer, Zifferblatt-Layout, Bezel-Form, Lume-
  // Pattern). Two-Stage ist Standard-Pattern (Pinecone, Algolia Re-Ranking).
  async function scan() {
    setScanning(true);
    setActionMsg(null);
    setScanProgress({ stage: 'Pre-Filter (Embeddings)', current: 0, total: 0 });

    try {
      // ── Stage 1: lokaler Embedding-Pre-Filter ────────────────────────────
      const withEmbedding = products.filter(p => p.imageEmbedding && p.imageEmbedding.length > 0 && p.images && p.images.length > 0);
      if (withEmbedding.length < 2) {
        setActionMsg({
          text: withEmbedding.length === 0
            ? 'Keine Produkte mit AI-Embedding gefunden — bitte zuerst "Backfill Embeddings" laufen lassen.'
            : 'Nur 1 Produkt mit Embedding — fuer Vergleich werden mindestens 2 gebraucht.',
          ok: false,
        });
        setGroups([]);
        setScanning(false);
        setScanProgress(null);
        return;
      }

      const STAGE1_THRESHOLD = 0.75;
      const candidatePairs: Array<{ a: Product; b: Product; cosine: number }> = [];
      for (let i = 0; i < withEmbedding.length; i++) {
        for (let j = i + 1; j < withEmbedding.length; j++) {
          const a = withEmbedding[i], b = withEmbedding[j];
          // Kategorie-Filter: nur gleiche Kategorie vergleichen — Watches mit
          // Watches, Jewelry mit Jewelry. Spart LLM-Calls fuer offensichtlich
          // verschiedene Items.
          if (a.categoryId !== b.categoryId) continue;
          const cos = cosineSimilarity(a.imageEmbedding!, b.imageEmbedding!);
          if (cos >= STAGE1_THRESHOLD) {
            candidatePairs.push({ a, b, cosine: cos });
          }
        }
      }
      candidatePairs.sort((x, y) => y.cosine - x.cosine);

      if (candidatePairs.length === 0) {
        setGroups([]);
        setIgnoredGroups(new Set());
        setScanning(false);
        setScanProgress(null);
        setActionMsg({ text: 'Keine aehnlichen Produkte gefunden (Stage-1 leer).', ok: true });
        return;
      }

      // ── Stage 2: GPT-4o-mini-Vision bestaetigt jedes Kandidaten-Paar ─────
      if (!apiKeyOk) {
        setActionMsg({ text: 'API-Key fehlt — Stage 2 (AI-Vision) nicht moeglich. Bitte in Settings → AI Setup eintragen.', ok: false });
        setGroups([]);
        setScanning(false);
        setScanProgress(null);
        return;
      }

      setScanProgress({ stage: 'AI Vision Check', current: 0, total: candidatePairs.length });

      type Confirmed = { a: string; b: string; cosine: number; reason: string; confidence: 'high' | 'medium' | 'low' };
      const confirmed: Confirmed[] = [];

      // Parallel mit Concurrency-Limit (OpenAI rate-limit-freundlich).
      const CONCURRENCY = 4;
      let nextIdx = 0;
      let doneCount = 0;
      async function worker() {
        while (true) {
          const idx = nextIdx++;
          if (idx >= candidatePairs.length) break;
          const pair = candidatePairs[idx];
          try {
            const result = await pairwiseVisualMatch(pair.a.images[0], pair.b.images[0]);
            if (result.isMatch) {
              confirmed.push({
                a: pair.a.id,
                b: pair.b.id,
                cosine: pair.cosine,
                reason: result.reason || 'AI confirmed same product',
                confidence: result.confidence,
              });
            }
          } catch (err) {
            console.warn('[duplicate-scan] pairwise check failed:', err);
          }
          doneCount++;
          setScanProgress({ stage: 'AI Vision Check', current: doneCount, total: candidatePairs.length });
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidatePairs.length) }, () => worker()));

      if (confirmed.length === 0) {
        setGroups([]);
        setIgnoredGroups(new Set());
        setScanning(false);
        setScanProgress(null);
        setActionMsg({ text: `Stage-1 fand ${candidatePairs.length} Kandidaten — AI hat keinen als sicheres Duplikat bestaetigt.`, ok: true });
        return;
      }

      // ── Cluster-Builder via Union-Find auf den bestaetigten Paaren ───────
      const involvedIds = new Set<string>();
      for (const e of confirmed) { involvedIds.add(e.a); involvedIds.add(e.b); }
      const uf = new UnionFind([...involvedIds]);
      for (const e of confirmed) uf.union(e.a, e.b);

      const rootBuckets = new Map<string, { ids: Set<string>; edges: Confirmed[] }>();
      for (const e of confirmed) {
        const r = uf.find(e.a);
        if (!rootBuckets.has(r)) rootBuckets.set(r, { ids: new Set(), edges: [] });
        const bucket = rootBuckets.get(r)!;
        bucket.ids.add(e.a); bucket.ids.add(e.b); bucket.edges.push(e);
      }

      const allClusterIds = [...rootBuckets.values()].flatMap(b => [...b.ids]);
      const linkedAll = getLinkedRecordCounts(allClusterIds);

      const out: DuplicateGroup[] = [];
      for (const { ids, edges: groupEdges } of rootBuckets.values()) {
        if (ids.size < 2) continue;
        const members = [...ids].map(id => products.find(p => p.id === id)).filter(Boolean) as Product[];
        if (members.length < 2) continue;

        const edgesByMember = new Map<string, DuplicateEdge[]>();
        for (const e of groupEdges) {
          const score = Math.round(e.cosine * 100);
          const reasons = [`AI Vision: ${e.reason}`, `Cosine ${e.cosine.toFixed(2)}`];
          if (!edgesByMember.has(e.a)) edgesByMember.set(e.a, []);
          if (!edgesByMember.has(e.b)) edgesByMember.set(e.b, []);
          edgesByMember.get(e.a)!.push({ otherId: e.b, score, reasons });
          edgesByMember.get(e.b)!.push({ otherId: e.a, score, reasons });
        }

        const maxScore = Math.round(Math.max(...groupEdges.map(e => e.cosine)) * 100);
        const topReasons = Array.from(new Set(groupEdges.map(e => e.reason))).slice(0, 4);

        const scored = members.map(p => ({
          product: p,
          score: computeMasterScore(p, linkedAll.get(p.id) || 0),
          linked: linkedAll.get(p.id) || 0,
        })).sort((a, b) => b.score - a.score);
        const suggested = scored[0].product;
        const masterReasons = describeMasterReasons(suggested, scored[0].linked);

        const linkedCounts = new Map<string, number>();
        for (const m of members) linkedCounts.set(m.id, linkedAll.get(m.id) || 0);

        out.push({
          id: [...ids].sort().join('|'),
          members,
          edgesByMember,
          maxScore,
          topReasons,
          suggestedMasterId: suggested.id,
          masterReasons,
          linkedCounts,
        });
      }
      out.sort((a, b) => b.maxScore - a.maxScore);
      setGroups(out);
      setIgnoredGroups(new Set());
      setActionMsg({
        text: `Fertig — ${candidatePairs.length} Kandidaten gepruft, ${confirmed.length} bestaetigt, ${out.length} Cluster gebildet.`,
        ok: true,
      });
    } catch (err) {
      console.error('[duplicate-scan] failed:', err);
      setActionMsg({ text: `Scan fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

  // ── Backfill Embeddings ─────────────────────────────────────────────────
  // Geht alle Produkte mit Foto aber ohne imageEmbedding durch und laesst
  // GPT-4o-mini-Vision eine Beschreibung machen + text-embedding-3-small den
  // Vektor erzeugen. Aendert NICHT die User-Felder (brand/name/sku/etc.) —
  // nur imageDescription + imageEmbedding werden befuellt.
  async function runBackfill() {
    if (!apiKeyOk) {
      setActionMsg({ text: 'API-Key fehlt — bitte in Settings → AI Setup eintragen.', ok: false });
      return;
    }
    const todo = products.filter(p => p.images && p.images.length > 0 && (!p.imageEmbedding || p.imageEmbedding.length === 0));
    if (todo.length === 0) {
      setActionMsg({ text: 'Nichts zu tun — alle Produkte mit Foto haben bereits ein Embedding.', ok: true });
      return;
    }
    setBackfilling(true);
    setBackfillProgress({ current: 0, total: todo.length, errors: 0 });
    setActionMsg(null);

    let errors = 0;
    for (let i = 0; i < todo.length; i++) {
      const p = todo[i];
      try {
        const { description, embedding } = await computeImageEmbedding(p.images[0]);
        updateProduct(p.id, { imageDescription: description, imageEmbedding: embedding });
      } catch (err) {
        errors++;
        console.warn('[backfill] embedding failed for', p.id, err);
      }
      setBackfillProgress({ current: i + 1, total: todo.length, errors });
    }
    setBackfilling(false);
    setBackfillProgress(null);
    loadProducts();
    setActionMsg({
      text: `Backfill fertig — ${todo.length - errors} von ${todo.length} Produkten analysiert${errors > 0 ? `, ${errors} Fehler` : ''}.`,
      ok: errors === 0,
    });
  }

  function ignoreGroup(groupId: string) {
    setIgnoredGroups(prev => { const next = new Set(prev); next.add(groupId); return next; });
    setActionMsg({ text: 'Gruppe als „kein Duplikat" markiert.', ok: true });
  }

  function handleDelete(productId: string, label: string) {
    try {
      deleteProduct(productId);
      setActionMsg({ text: `„${label}" gelöscht.`, ok: true });
      loadProducts();
      // Cluster nach Löschung neu bauen — entferntes Item kann ganze Gruppe auflösen.
      setGroups(prev => prev?.map(g => ({
        ...g,
        members: g.members.filter(m => m.id !== productId),
      })).filter(g => g.members.length >= 2) || null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActionMsg({ text: `Löschen nicht möglich — ${msg} (Item hat verknüpfte Datensätze — stattdessen mergen oder das Master-Item wechseln).`, ok: false });
    }
  }

  function handleMergeAllIntoMaster(group: DuplicateGroup, masterId: string) {
    const master = group.members.find(m => m.id === masterId);
    if (!master) return;
    let merged = 0, failed = 0;
    for (const m of group.members) {
      if (m.id === masterId) continue;
      try {
        mergeIntoExisting(m.id, masterId);
        merged++;
      } catch (e) {
        failed++;
        console.warn('[duplicates] merge failed for', m.id, e);
      }
    }
    setActionMsg({
      text: failed === 0
        ? `${merged} Items in „${master.brand} ${master.name}" zusammengeführt.`
        : `${merged} zusammengeführt, ${failed} fehlgeschlagen (verknüpfte Datensätze).`,
      ok: failed === 0,
    });
    loadProducts();
    setGroups(prev => prev?.filter(g => g.id !== group.id) || null);
  }

  function handleDeleteAllExceptMaster(group: DuplicateGroup, masterId: string) {
    const safe: Product[] = [];
    const unsafe: Product[] = [];
    for (const m of group.members) {
      if (m.id === masterId) continue;
      if ((group.linkedCounts.get(m.id) || 0) > 0) unsafe.push(m);
      else safe.push(m);
    }
    if (unsafe.length > 0) {
      setActionMsg({
        text: `${unsafe.length} Items haben verknüpfte Datensätze und können nicht gelöscht werden — nutze „Alle in Master mergen" statt dessen, oder wechsle das Master.`,
        ok: false,
      });
      return;
    }
    let deleted = 0;
    for (const m of safe) {
      try { deleteProduct(m.id); deleted++; }
      catch (err) { console.warn('[duplicates] delete failed:', err); }
    }
    setActionMsg({ text: `${deleted} Items gelöscht. Master behalten.`, ok: true });
    loadProducts();
    setGroups(prev => prev?.filter(g => g.id !== group.id) || null);
  }

  const visibleGroups = (groups || []).filter(g => !ignoredGroups.has(g.id));
  const totalCount = groups?.length || 0;
  const ignoredCount = totalCount - visibleGroups.length;
  const totalProductsInGroups = visibleGroups.reduce((sum, g) => sum + g.members.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex items-start justify-between gap-4" style={{ flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="text-display-xs" style={{ color: '#0F0F10' }}>Doppelte Artikel finden</h2>
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4, maxWidth: 600 }}>
              <strong>Two-Stage AI-Scan:</strong> Stage 1 vergleicht die Foto-Embeddings (lokal, gratis). Stage 2 schickt verdaechtige Paare an GPT-4o-mini-Vision, das beide Fotos direkt anschaut. Cluster werden NUR aus AI-bestaetigten Paaren gebildet.
            </p>
          </div>
          <div className="flex flex-col gap-2" style={{ minWidth: 200 }}>
            <Button variant="primary" onClick={scan} disabled={scanning || backfilling || embeddingStatus.withEmb < 2}>
              {scanning ? (scanProgress ? `${scanProgress.stage} ${scanProgress.current}/${scanProgress.total}` : 'Scanning…') : groups ? 'Re-scan with AI' : 'Find Duplicates (AI)'}
            </Button>
            <Button variant="secondary" onClick={runBackfill} disabled={scanning || backfilling || !apiKeyOk || embeddingStatus.withImgNoEmb === 0}>
              {backfilling
                ? (backfillProgress ? `Backfill ${backfillProgress.current}/${backfillProgress.total}…` : 'Backfilling…')
                : embeddingStatus.withImgNoEmb > 0
                  ? `Backfill Embeddings (${embeddingStatus.withImgNoEmb})`
                  : 'Backfill Embeddings'}
            </Button>
          </div>
        </div>

        {/* Status-Panel: zeigt wie viele Produkte AI-vergleichbar sind und wo die Luecken sind. */}
        <div style={{
          marginTop: 16, padding: '12px 14px', borderRadius: 8,
          background: '#FAFBFC', border: '1px solid #E5E9EE',
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12,
        }}>
          <StatusCell label="Total Items" value={String(embeddingStatus.total)} sub="im Bestand" />
          <StatusCell
            label="AI Foto-Analyse"
            value={`${embeddingStatus.withEmb}`}
            sub={`von ${embeddingStatus.total - embeddingStatus.noImg} mit Foto`}
            tone={embeddingStatus.withEmb === embeddingStatus.total - embeddingStatus.noImg ? 'good' : 'warn'}
          />
          <StatusCell
            label="Foto, kein Embedding"
            value={String(embeddingStatus.withImgNoEmb)}
            sub={embeddingStatus.withImgNoEmb > 0 ? 'Backfill noetig' : '—'}
            tone={embeddingStatus.withImgNoEmb > 0 ? 'warn' : 'good'}
          />
          <StatusCell
            label="Ohne Foto"
            value={String(embeddingStatus.noImg)}
            sub="nicht visuell vergleichbar"
            tone={embeddingStatus.noImg > 0 ? 'muted' : 'good'}
          />
        </div>

        {!apiKeyOk && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 8,
            background: 'rgba(170,110,110,0.08)', border: '1px solid rgba(170,110,110,0.30)',
            fontSize: 12, color: '#7A3535',
          }}>
            <strong>API-Key fehlt</strong> — fuer AI-Backfill und AI-Vision-Scan brauchst du einen OpenAI-Key. Settings → AI Setup.
          </div>
        )}

        {actionMsg && (
          <div style={{
            marginTop: 16, padding: '10px 14px', borderRadius: 8,
            background: actionMsg.ok ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)',
            border: `1px solid ${actionMsg.ok ? 'rgba(126,170,110,0.35)' : 'rgba(170,110,110,0.35)'}`,
            color: actionMsg.ok ? '#3F6E2F' : '#7A3535', fontSize: 12,
          }}>
            {actionMsg.text}
          </div>
        )}
      </Card>

      {groups !== null && (
        <Card>
          {totalCount === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center' }}>
              <Check size={32} strokeWidth={1.5} style={{ color: '#7EAA6E', margin: '0 auto 12px' }} />
              <p style={{ fontSize: 14, color: '#0F0F10' }}>Keine Duplikate gefunden.</p>
              <p style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
                {products.length} Produkte gescannt, keine Cluster mit Score ≥ 40.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500 }}>
                    {visibleGroups.length} Gruppe{visibleGroups.length === 1 ? '' : 'n'} · {totalProductsInGroups} Produkte
                  </span>
                  {ignoredCount > 0 && (
                    <span style={{ fontSize: 12, color: '#6B7280', marginLeft: 10 }}>
                      ({ignoredCount} ignoriert)
                    </span>
                  )}
                </div>
                {ignoredCount > 0 && (
                  <Button variant="ghost" onClick={() => setIgnoredGroups(new Set())}>
                    Ignorierte wieder einblenden
                  </Button>
                )}
              </div>

              <div className="flex flex-col gap-4">
                {visibleGroups.map(group => (
                  <DuplicateGroupCard
                    key={group.id}
                    group={group}
                    onOpen={pid => navigate(`/collection/${pid}`)}
                    onDelete={(pid, label) => handleDelete(pid, label)}
                    onMergeAllIntoMaster={masterId => handleMergeAllIntoMaster(group, masterId)}
                    onDeleteAllExceptMaster={masterId => handleDeleteAllExceptMaster(group, masterId)}
                    onIgnoreGroup={() => ignoreGroup(group.id)}
                  />
                ))}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function DuplicateGroupCard({
  group, onOpen, onDelete, onMergeAllIntoMaster, onDeleteAllExceptMaster, onIgnoreGroup,
}: {
  group: DuplicateGroup;
  onOpen: (productId: string) => void;
  onDelete: (productId: string, label: string) => void;
  onMergeAllIntoMaster: (masterId: string) => void;
  onDeleteAllExceptMaster: (masterId: string) => void;
  onIgnoreGroup: () => void;
}) {
  const [overrideMaster, setOverrideMaster] = useState<string | null>(null);
  const [removedFromGroup, setRemovedFromGroup] = useState<Set<string>>(new Set());
  const masterId = overrideMaster || group.suggestedMasterId;
  const visibleMembers = group.members.filter(m => !removedFromGroup.has(m.id));
  if (visibleMembers.length < 2) return null;

  const sev = severityFromScore(group.maxScore);
  const masterProduct = visibleMembers.find(m => m.id === masterId) || visibleMembers[0];
  const nonMasterUnsafeCount = visibleMembers.filter(m => m.id !== masterId && (group.linkedCounts.get(m.id) || 0) > 0).length;

  return (
    <div style={{
      border: `1px solid ${sev.color}40`, borderRadius: 12,
      background: sev.bg, padding: 16,
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3" style={{ flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, color: '#0F0F10', fontWeight: 600 }}>Mögliche Duplikat-Gruppe</span>
            <span style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 999,
              background: '#FFFFFF', color: '#0F0F10', border: '1px solid #D5D9DE',
            }}>{visibleMembers.length} Produkte</span>
            <span style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 999,
              color: sev.color, background: '#FFFFFF', border: `1px solid ${sev.color}50`, fontWeight: 500,
            }}>{sev.text} · max Score {group.maxScore}</span>
          </div>
          <div className="flex items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
            {group.topReasons.map((r, i) => (
              <span key={i} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999,
                background: '#FFFFFF', color: '#4B5563', border: '1px solid #E5E9EE',
              }}>{r}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Member list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visibleMembers.map(m => {
          const isMaster = m.id === masterId;
          const isSuggested = m.id === group.suggestedMasterId;
          const linked = group.linkedCounts.get(m.id) || 0;
          return (
            <DuplicateMemberRow
              key={m.id}
              product={m}
              isMaster={isMaster}
              isSuggested={isSuggested}
              linkedCount={linked}
              suggestedReasons={isSuggested ? group.masterReasons : []}
              edgesToOthers={group.edgesByMember.get(m.id) || []}
              onMakeMaster={() => setOverrideMaster(m.id)}
              onRemoveFromGroup={() => setRemovedFromGroup(s => new Set(s).add(m.id))}
              onOpen={() => onOpen(m.id)}
              onDelete={() => onDelete(m.id, `${m.brand} ${m.name}`)}
            />
          );
        })}
      </div>

      {/* Footer: group-level actions */}
      <div className="flex items-center justify-between" style={{
        paddingTop: 10, borderTop: '1px solid rgba(0,0,0,0.06)', flexWrap: 'wrap', gap: 8,
      }}>
        <div style={{ fontSize: 11, color: '#6B7280' }}>
          Hauptprodukt: <strong style={{ color: '#0F0F10' }}>{masterProduct.brand} {masterProduct.name}</strong>
        </div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <Button variant="ghost" onClick={onIgnoreGroup}>Gruppe ignorieren</Button>
          <Button variant="secondary" onClick={() => onMergeAllIntoMaster(masterId)}>
            Alle in Master mergen ({visibleMembers.length - 1})
          </Button>
          <Button
            variant="secondary"
            onClick={() => onDeleteAllExceptMaster(masterId)}
            disabled={nonMasterUnsafeCount > 0}
            title={nonMasterUnsafeCount > 0 ? `${nonMasterUnsafeCount} mit linked records — nicht löschbar` : ''}
          >
            <Trash2 size={12} /> Alle außer Master löschen
          </Button>
        </div>
      </div>
    </div>
  );
}

function DuplicateMemberRow({
  product, isMaster, isSuggested, linkedCount, suggestedReasons, edgesToOthers, onMakeMaster, onRemoveFromGroup, onOpen, onDelete,
}: {
  product: Product;
  isMaster: boolean;
  isSuggested: boolean;
  linkedCount: number;
  suggestedReasons: string[];
  edgesToOthers: DuplicateEdge[];
  onMakeMaster: () => void;
  onRemoveFromGroup: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const attrs = product.attributes || {};
  const ref = String(attrs.reference_number || attrs.reference || attrs.referenceNo || '').trim();
  const serial = String(attrs.serial_number || attrs.serialNo || '').trim();
  const weight = Number(attrs.weight) || 0;
  const karat = String(attrs.karat || '').trim();
  const status = product.stockStatus || 'in_stock';
  const topEdgeScore = edgesToOthers.length > 0 ? Math.max(...edgesToOthers.map(e => e.score)) : 0;

  return (
    <div style={{
      background: '#FFFFFF',
      border: isMaster ? '2px solid #AA956E' : '1px solid #E5E9EE',
      borderRadius: 10,
      padding: 12,
      display: 'grid', gridTemplateColumns: '72px 1fr auto', gap: 12, alignItems: 'center',
      position: 'relative',
    }}>
      {/* Image */}
      <div style={{
        width: 72, height: 72, background: '#F2F7FA', borderRadius: 8, overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #E5E9EE',
      }}>
        {product.images?.[0] ? (
          <img src={product.images[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <Package size={26} strokeWidth={1} style={{ color: '#6B7280' }} />
        )}
      </div>

      {/* Details */}
      <div style={{ minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
          {isMaster && (
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 999,
              background: '#AA956E', color: '#FFFFFF', fontWeight: 600, letterSpacing: 0.5,
            }}>MASTER</span>
          )}
          {isSuggested && !isMaster && (
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 999,
              background: 'rgba(170,149,110,0.15)', color: '#AA956E', border: '1px solid rgba(170,149,110,0.35)',
            }}>Empfohlen</span>
          )}
          <span style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{product.brand}</span>
        </div>
        <div style={{ fontSize: 13, color: '#0F0F10', fontWeight: 500, lineHeight: 1.3 }}>{product.name || '—'}</div>
        <div className="flex items-center" style={{ gap: 10, marginTop: 4, fontSize: 11, color: '#4B5563', flexWrap: 'wrap' }}>
          {product.sku && <span className="font-mono">{product.sku}</span>}
          <span style={{
            padding: '1px 6px', borderRadius: 999,
            background: status === 'in_stock' ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)',
            color: status === 'in_stock' ? '#3F6E2F' : '#7A3535', fontSize: 10,
          }}>{status === 'in_stock' ? 'In Stock' : status === 'sold' ? 'Sold' : status}</span>
          {linkedCount > 0 && (
            <span style={{
              padding: '1px 6px', borderRadius: 999,
              background: 'rgba(170,110,110,0.10)', color: '#7A3535', fontSize: 10,
            }}>{linkedCount} linked record{linkedCount === 1 ? '' : 's'} — nicht löschbar</span>
          )}
          {ref && <span className="font-mono" style={{ color: '#6B7280' }}>Ref {ref}</span>}
          {serial && <span className="font-mono" style={{ color: '#6B7280' }}>SN {serial}</span>}
          {weight > 0 && <span className="font-mono" style={{ color: '#6B7280' }}>{weight}g{karat ? ` · ${karat}` : ''}</span>}
          {topEdgeScore > 0 && <span style={{ color: '#6B7280' }}>Score {topEdgeScore}</span>}
        </div>
        {isSuggested && suggestedReasons.length > 0 && (
          <div className="flex items-center" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: '#AA956E', fontWeight: 500 }}>Warum Master:</span>
            {suggestedReasons.map((r, i) => (
              <span key={i} style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 999,
                background: 'rgba(170,149,110,0.10)', color: '#AA956E', border: '1px solid rgba(170,149,110,0.25)',
              }}>{r}</span>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col" style={{ gap: 4, alignItems: 'flex-end' }}>
        {!isMaster && (
          <Button variant="ghost" onClick={onMakeMaster}>Als Master setzen</Button>
        )}
        <div className="flex" style={{ gap: 4 }}>
          <Button variant="ghost" onClick={onOpen}><ExternalLink size={12} /></Button>
          <Button variant="ghost" onClick={onRemoveFromGroup} title="Aus Gruppe entfernen (False Positive)">
            <X size={12} />
          </Button>
          {!isMaster && (
            <Button variant="ghost" onClick={onDelete} disabled={linkedCount > 0}
              title={linkedCount > 0 ? 'Hat linked records — nicht löschbar' : 'Diesen Eintrag löschen'}
            >
              <Trash2 size={12} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function DangerZoneTab() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const [purgeSuccess, setPurgeSuccess] = useState('');
  const [purgeError, setPurgeError] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetBlocked, setResetBlocked] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');

  // D3b: Beim Öffnen des Factory-Reset-Modals prüfen, ob Sync/LAN konfiguriert ist.
  // Ist es das, wird der Reset blockiert (lokaler Reset könnte Server-Daten resurrecten).
  useEffect(() => {
    if (!confirmOpen) return;
    let cancelled = false;
    (async () => {
      const sync = await import('@/core/sync/sync-service');
      const lan = await import('@/core/sync/auto-lan');
      if (!cancelled) {
        setResetBlocked(isFactoryResetBlocked({ syncConfigured: sync.isSyncConfigured(), lanMode: lan.getLanMode() }));
      }
    })();
    return () => { cancelled = true; };
  }, [confirmOpen]);

  // D3: Anzahl betroffener Datensätze für die Bestätigung (read-only, zählt nur).
  const purgeCount = useMemo<number | null>(() => {
    if (!purgeTarget) return null;
    const steps = PURGE_PLANS[purgeTarget];
    if (!steps) return null;
    try {
      return countPurge(getDatabase() as unknown as PurgeDb, steps, currentBranchId()).total;
    } catch {
      return null;
    }
  }, [purgeTarget]);

  async function handleBackup() {
    try {
      const db = getDatabase();
      const data = db.export();
      await exportFile(
        `lataif_backup_${new Date().toISOString().split('T')[0]}.db`,
        new Uint8Array(data),
        'application/octet-stream'
      );
      setBackupMsg('Backup gespeichert.');
    } catch (e) { setBackupMsg(`Backup failed: ${e}`); }
  }

  function handleRestore(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = new Uint8Array(reader.result as ArrayBuffer);
        const initSqlJs = (await import('sql.js')).default;
        const wasmUrl = (await import('sql.js/dist/sql-wasm.wasm?url')).default;
        const SQL = await initSqlJs({ locateFile: () => wasmUrl });
        // Validate it's a real SQLite DB
        const testDb = new SQL.Database(data);
        testDb.exec('SELECT COUNT(*) FROM tenants');
        testDb.close();
        // Save it
        // Write to storage
        localStorage.setItem('lataif_db_v2', btoa(String.fromCharCode(...data)));
        setBackupMsg('Restore successful! Reloading...');
        setTimeout(() => window.location.reload(), 1000);
      } catch (err) { setBackupMsg(`Restore failed: invalid backup file. ${err}`); }
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleReset() {
    if (confirmText !== 'RESET' || purgeBusy) return;
    // D3b: Sync/LAN-Signale frisch lesen (Guard = defense-in-depth zusätzlich zur UI-Sperre).
    const sync = await import('@/core/sync/sync-service');
    const lan = await import('@/core/sync/auto-lan');
    setPurgeBusy(true);
    setResetError('');
    try {
      const result = await runGuardedReset({
        syncConfigured: sync.isSyncConfigured(),
        lanMode: lan.getLanMode(),
        // Backup nur, wenn NICHT blockiert. Vorher flushen, damit es die neuesten Daten erfasst.
        backup: async () => { await flushDatabase().catch(() => {}); return createPreDestructiveBackup('factory-reset'); },
        reset: resetDatabase,
        onBlocked: () => setResetBlocked(true), // Banner zeigt FACTORY_RESET_BLOCKED_MESSAGE
      });
      if (result.blocked) { setPurgeBusy(false); return; } // KEINE DB gelöscht, KEIN Backup
      localStorage.removeItem('lataif_session');
      window.location.reload();
    } catch (err) {
      setResetError(`Reset abgebrochen — es wurde nichts gelöscht. Grund: ${err instanceof Error ? err.message : String(err)}`);
      setPurgeBusy(false);
    }
  }

  // D3: Sicherer Purge — Auto-Backup ZUERST, dann atomarer, getrackter Purge.
  // Für JEDEN gelöschten Record wird ein Sync-Delete-Change geschrieben (bestehendes
  // trackDelete-Format), damit ein späterer Pull/Replay gelöschte Records NICHT wiederbelebt.
  // Backup-Fehler ODER Purge-Fehler → alles rollt zurück, es wird nichts (halb) gelöscht.
  async function handlePurge() {
    if (!purgeTarget || confirmText !== 'DELETE' || purgeBusy) return;
    const steps = PURGE_PLANS[purgeTarget];
    if (!steps) return;
    const branchId = currentBranchId();
    setPurgeBusy(true);
    setPurgeError('');
    try {
      // Aktuellen Stand persistieren, damit das Backup die neuesten Daten erfasst.
      await flushDatabase().catch(() => {});
      const result = await runSafePurge(steps, branchId, {
        db: getDatabase() as unknown as PurgeDb,
        backup: () => createPreDestructiveBackup(`purge:${purgeTarget}`),
        begin: beginLedgerTransaction,
        commit: commitLedgerTransaction,
        rollback: rollbackLedgerTransaction,
        onDelete: trackDelete,
      });
      // Purge-Ergebnis dauerhaft schreiben + betroffene Ansichten aktualisieren.
      await flushDatabase().catch(() => {});
      useProductStore.getState().loadProducts();
      setPurgeTarget(null);
      setConfirmText('');
      setPurgeSuccess(
        `${result.total} Datensätze gelöscht (Sync-Delete-Changes geschrieben). Backup: ${result.backupLocation}`
      );
    } catch (err) {
      setPurgeError(
        `Abgebrochen — es wurde NICHTS gelöscht. Grund: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setPurgeBusy(false);
    }
  }

  const purgeOptions = [
    { key: 'products', label: 'All Products', desc: 'Delete all products from this branch' },
    { key: 'customers', label: 'All Customers', desc: 'Delete all customers from this branch' },
    { key: 'offers', label: 'All Offers', desc: 'Delete all offers and lines' },
    { key: 'invoices', label: 'All Invoices', desc: 'Delete all invoices, lines, and payments' },
    { key: 'repairs', label: 'All Repairs', desc: 'Delete all repairs' },
    { key: 'orders', label: 'All Orders', desc: 'Delete all orders' },
    { key: 'tasks', label: 'All Tasks', desc: 'Delete all tasks' },
    { key: 'all_data', label: 'ALL DATA', desc: 'Delete everything except users, settings, and categories' },
  ];

  return (
    <div>
      {/* Backup & Restore */}
      <SectionTitle>Backup & Restore</SectionTitle>
      {backupMsg && <SuccessBanner message={backupMsg} onDone={() => setBackupMsg('')} />}
      <Card>
        <div style={{ padding: 8, display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 4 }}>Export Backup</h4>
            <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>Download the entire database as a file. Keep it safe.</p>
            <Button variant="secondary" onClick={handleBackup}>Download Backup</Button>
          </div>
          <div style={{ width: 1, background: '#E5E9EE' }} />
          <div style={{ flex: 1 }}>
            <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 4 }}>Restore from Backup</h4>
            <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>Upload a .db backup file. Current data will be replaced.</p>
            <label className="cursor-pointer">
              <span style={{ display: 'inline-block', padding: '8px 16px', fontSize: 13, borderRadius: 6, border: '1px solid #D5D9DE', color: '#4B5563', background: 'transparent' }}>Upload Backup File</span>
              <input type="file" accept=".db" style={{ display: 'none' }} onChange={handleRestore} />
            </label>
          </div>
        </div>
      </Card>

      <div style={{ marginTop: 24 }} />
      <SectionTitle>Danger Zone</SectionTitle>

      {purgeSuccess && <SuccessBanner message={purgeSuccess} onDone={() => setPurgeSuccess('')} />}

      {/* Purge by type */}
      <Card>
        <div style={{ padding: 8 }}>
          <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 12 }}>Delete Data</h4>
          <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 16 }}>Delete specific data types. Settings, users, and categories are kept.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {purgeOptions.map(opt => (
              <button key={opt.key}
                onClick={() => { setPurgeTarget(opt.key); setConfirmText(''); }}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '10px 14px', textAlign: 'left', borderRadius: 6,
                  border: '1px solid rgba(170,110,110,0.15)', background: 'rgba(170,110,110,0.03)',
                  color: opt.key === 'all_data' ? '#AA6E6E' : '#4B5563', fontSize: 12,
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(170,110,110,0.4)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(170,110,110,0.15)')}
              >
                <span style={{ fontWeight: 500, display: 'block' }}>{opt.label}</span>
                <span style={{ fontSize: 11, color: '#6B7280' }}>{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Full reset */}
      <div style={{ marginTop: 16 }}>
        <Card>
          <div style={{
            padding: 8,
            border: '1px solid rgba(220,38,38,0.2)',
            borderRadius: 8,
            background: 'rgba(170,110,110,0.03)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <h4 style={{ fontSize: 14, fontWeight: 500, color: '#AA6E6E', marginBottom: 4 }}>Factory Reset</h4>
                <p style={{ fontSize: 12, color: '#6B7280', maxWidth: 400 }}>
                  Delete EVERYTHING — all data, settings, users. Starts completely fresh.
                </p>
              </div>
              <Button variant="danger" onClick={() => { setConfirmOpen(true); setConfirmText(''); }}>Factory Reset</Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Purge confirmation */}
      <Modal open={!!purgeTarget} onClose={() => { if (!purgeBusy) { setPurgeTarget(null); setPurgeError(''); } }} title={`Delete ${purgeTarget?.replace('_', ' ')}`} width={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(170,110,110,0.06)', border: '1px solid rgba(220,38,38,0.2)' }}>
            <p style={{ fontSize: 13, color: '#AA6E6E', lineHeight: 1.5 }}>
              This permanently deletes{' '}
              <b>{purgeCount != null ? `${purgeCount} record${purgeCount === 1 ? '' : 's'}` : `all ${purgeTarget?.replace('_', ' ')}`}</b>{' '}
              from this branch.
            </p>
            <ul style={{ fontSize: 12, color: '#8A5A5A', lineHeight: 1.6, margin: '8px 0 0', paddingLeft: 18 }}>
              <li>A local backup is created automatically before anything is deleted.</li>
              <li>Sync delete-changes are written, so deletions propagate and won{"'"}t come back after a sync.</li>
              <li>This cannot be undone except by restoring the backup.</li>
            </ul>
          </div>
          {purgeError && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.35)' }}>
              <p style={{ fontSize: 12, color: '#B91C1C', lineHeight: 1.5 }}>{purgeError}</p>
            </div>
          )}
          <p style={{ fontSize: 13, color: '#4B5563' }}>
            Type <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 600 }}>DELETE</span> to confirm:
          </p>
          <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="Type DELETE" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setPurgeTarget(null); setPurgeError(''); }} disabled={purgeBusy}>Cancel</Button>
            <Button variant="danger" onClick={handlePurge} disabled={confirmText !== 'DELETE' || purgeBusy}>{purgeBusy ? 'Backing up & deleting…' : 'Delete'}</Button>
          </div>
        </div>
      </Modal>

      {/* Factory reset confirmation */}
      <Modal open={confirmOpen} onClose={() => { if (!purgeBusy) { setConfirmOpen(false); setConfirmText(''); setResetError(''); } }} title="Factory Reset" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {resetBlocked ? (
            <div style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.35)' }}>
              <p style={{ fontSize: 13, color: '#B91C1C', fontWeight: 600, lineHeight: 1.5, marginBottom: 8 }}>
                {FACTORY_RESET_BLOCKED_MESSAGE}
              </p>
              <ul style={{ fontSize: 12, color: '#B04A4A', lineHeight: 1.6, margin: 0, paddingLeft: 18 }}>
                <li>Factory Reset only deletes data locally.</li>
                <li>The sync server can push the old data back afterwards.</li>
                <li>For sync-tracked data, use Safe Purge (Delete Data) above instead.</li>
                <li>A full server baseline/compaction is coming in D4.</li>
              </ul>
              <p style={{ fontSize: 12, color: '#8A5A5A', lineHeight: 1.6, margin: '8px 0 0' }}>
                To reset anyway, first disconnect sync deliberately (Sync tab {'→'} Disconnect).
              </p>
            </div>
          ) : (
            <>
              <div style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(170,110,110,0.06)', border: '1px solid rgba(220,38,38,0.2)' }}>
                <p style={{ fontSize: 13, color: '#AA6E6E', lineHeight: 1.5 }}>
                  This will permanently delete ALL data, users, and settings. The app will restart completely fresh.
                </p>
                <p style={{ fontSize: 12, color: '#8A5A5A', lineHeight: 1.6, margin: '8px 0 0' }}>
                  A local backup is created automatically first. This cannot be undone except by restoring the backup.
                </p>
              </div>
              {resetError && (
                <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.35)' }}>
                  <p style={{ fontSize: 12, color: '#B91C1C', lineHeight: 1.5 }}>{resetError}</p>
                </div>
              )}
              <p style={{ fontSize: 13, color: '#4B5563' }}>
                Type <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 600 }}>RESET</span> to confirm:
              </p>
              <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="Type RESET" />
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setConfirmOpen(false); setConfirmText(''); setResetError(''); }} disabled={purgeBusy}>{resetBlocked ? 'Close' : 'Cancel'}</Button>
            {!resetBlocked && (
              <Button variant="danger" onClick={handleReset} disabled={confirmText !== 'RESET' || purgeBusy}>{purgeBusy ? 'Backing up & resetting…' : 'Factory Reset'}</Button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN SETTINGS PAGE
// ═══════════════════════════════════════════════════════════

export function SettingsPage() {
  const perm = usePermission();
  // Initial-Tab via ?tab=<key>. Erlaubt Deeplinks von anderen Seiten (z.B.
  // Collection "Find Duplicates" → ?tab=duplicates).
  const initialTab = ((): TabKey => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      const valid: TabKey[] = ['company', 'tax', 'categories', 'branch', 'branches', 'users', 'numbering', 'language', 'phone', 'ai', 'sync', 'updates', 'duplicates', 'danger'];
      if (t && valid.includes(t as TabKey)) return t as TabKey;
    } catch { /* */ }
    return 'company';
  })();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [hoveredTab, setHoveredTab] = useState<TabKey | null>(null);

  // Route-Guard: ohne ADMIN keine Settings-Seite. Verhindert auch UI-basierte Manipulation.
  if (!perm.canManageSettings) {
    return (
      <div className="app-content" style={{ background: '#FFFFFF', padding: 48 }}>
        <h1 className="text-display-s" style={{ color: '#0F0F10', marginBottom: 12 }}>Settings</h1>
        <p style={{ fontSize: 14, color: '#6B7280' }}>
          You don't have permission to access settings. Contact your administrator.
        </p>
      </div>
    );
  }

  const renderTab = () => {
    switch (activeTab) {
      case 'company': return <CompanyTab />;
      case 'tax': return <TaxTab />;
      case 'categories': return <CategoriesTab />;
      case 'branch': return <BranchTab />;
      case 'branches': return <BranchesTab />;
      case 'users': return <UsersTab />;
      case 'numbering': return <NumberRangesTab />;
      case 'language': return <LanguageTab />;
      case 'phone': return <CountryCodesTab />;
      case 'ai': return <AiTab />;
      case 'sync': return <SyncTab />;
      case 'updates': return <UpdatesTab />;
      case 'duplicates': return <DuplicatesTab />;
      case 'danger': return <DangerZoneTab />;
    }
  };

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10"
        style={{
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #E5E9EE',
        }}
      >
        <div style={{ padding: '24px 48px' }}>
          <h1 className="text-display-s" style={{ color: '#0F0F10' }}>Settings</h1>
          <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>Manage your workspace configuration</p>
        </div>
      </header>

      {/* Body: sidebar tabs + content */}
      <div className="animate-fade-in" style={{ display: 'flex', padding: '0 48px 48px', gap: 0, minHeight: 'calc(100vh - 100px)' }}>
        {/* Left Sidebar Tabs */}
        <nav style={{
          width: 220, flexShrink: 0, paddingTop: 32, paddingRight: 32,
          borderRight: '1px solid #E5E9EE',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, position: 'sticky', top: 100 }}>
            {TABS.map(tab => {
              const isActive = activeTab === tab.key;
              const isHovered = hoveredTab === tab.key;
              const isDanger = tab.key === 'danger';
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  onMouseEnter={() => setHoveredTab(tab.key)}
                  onMouseLeave={() => setHoveredTab(null)}
                  className="cursor-pointer transition-all duration-200"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                    border: 'none', textAlign: 'left', width: '100%',
                    background: isActive
                      ? (isDanger ? 'rgba(170,110,110,0.06)' : 'rgba(15,15,16,0.06)')
                      : (isHovered ? 'rgba(255,255,255,0.02)' : 'transparent'),
                    color: isActive
                      ? (isDanger ? '#AA6E6E' : '#0F0F10')
                      : (isHovered ? '#0F0F10' : '#4B5563'),
                    borderLeft: isActive
                      ? `2px solid ${isDanger ? '#AA6E6E' : '#0F0F10'}`
                      : '2px solid transparent',
                  }}
                >
                  <span style={{ opacity: isActive ? 1 : 0.6 }}>{tab.icon}</span>
                  {tab.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Right Content */}
        <main style={{ flex: 1, padding: '32px 0 0 40px', maxWidth: 800 }}>
          {renderTab()}
        </main>
      </div>
    </div>
  );
}

// ── Plan §Auto-Update — installierte Version anzeigen + manuell prüfen ──
function UpdatesTab() {
  const [installedVersion, setInstalledVersion] = useState<string>('—');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string>('');

  useEffect(() => {
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      setInstalledVersion('Browser-Modus (kein Auto-Update)');
      return;
    }
    import('@tauri-apps/api/app').then(({ getVersion }) =>
      getVersion().then(v => setInstalledVersion(v)).catch(() => setInstalledVersion('?'))
    );
  }, []);

  async function manualCheck() {
    setChecking(true); setResult('');
    // v0.4.5 — den Update-Banner unten rechts mit-triggern (eigener State).
    window.dispatchEvent(new CustomEvent('lataif:check-update'));
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) setResult(`✔ Update verfügbar: v${update.version} — Banner erscheint unten rechts.`);
      else setResult('✔ Du hast bereits die neueste Version installiert.');
    } catch (err) {
      setResult('✘ Fehler: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      <h2 className="font-display" style={{ fontSize: 22, color: '#0F0F10', marginBottom: 4 }}>Updates</h2>
      <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 24 }}>
        LATAIF prüft beim App-Start automatisch ob ein neues Update verfügbar ist. Du kannst auch manuell suchen.
      </p>

      <div style={{ padding: '20px 24px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12, marginBottom: 16 }}>
        <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>INSTALLIERTE VERSION</span>
        <div className="font-display" style={{ fontSize: 26, color: '#0F0F10' }}>
          v{installedVersion}
        </div>
      </div>

      <div style={{ padding: '20px 24px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12 }}>
        <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>UPDATE-CHECK</span>
        <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>
          Manuell jetzt prüfen ob ein neueres Release auf GitHub verfügbar ist.
        </p>
        <button onClick={manualCheck} disabled={checking}
          className="cursor-pointer"
          style={{
            padding: '10px 20px', background: '#0F0F10', color: '#FFFFFF',
            border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 500,
          }}>
          {checking ? 'Prüfe…' : 'Jetzt nach Update suchen'}
        </button>
        {result && (
          <div style={{ marginTop: 14, padding: 12, background: '#F2F7FA', borderRadius: 8, fontSize: 13, color: '#0F0F10' }}>
            {result}
          </div>
        )}
      </div>
    </div>
  );
}
