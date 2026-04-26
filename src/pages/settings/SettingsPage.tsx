import { useEffect, useState, useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import {
  Building2, Receipt, Tags, GitBranch, Users, Hash, AlertTriangle,
  Plus, Pencil, Trash2, Check, X, Power, Cloud, Sparkles, Globe,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { getDatabase, saveDatabase, resetDatabase } from '@/core/db/database';
import { exportFile } from '@/core/utils/export-file';
import { query, currentBranchId } from '@/core/db/helpers';
import { useProductStore } from '@/stores/productStore';
import { useAuthStore } from '@/stores/authStore';
import type { Category, CategoryAttribute, AttributeType, UserRole } from '@/core/models/types';

// ── Constants ──

type TabKey = 'company' | 'tax' | 'categories' | 'branch' | 'branches' | 'users' | 'numbering' | 'language' | 'ai' | 'sync' | 'updates' | 'danger';

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
  { key: 'ai', label: 'AI / OpenAI', icon: <Sparkles size={16} /> },
  { key: 'sync', label: 'Sync / Server', icon: <Cloud size={16} /> },
  { key: 'updates', label: 'Updates', icon: <Cloud size={16} /> },
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
  const isOwner = role === 'owner';
  const [stdRate, setStdRate] = useState('');
  const [marginRate, setMarginRate] = useState('');
  const [marginEnabled, setMarginEnabled] = useState(true);
  const [defaultScheme, setDefaultScheme] = useState('');
  const [cardFeeRate, setCardFeeRate] = useState('');
  const [fyStartMonth, setFyStartMonth] = useState('');
  const [openingCash, setOpeningCash] = useState('');
  const [openingBank, setOpeningBank] = useState('');
  const [monthlyTarget, setMonthlyTarget] = useState('');
  // Plan §Settings §3.D Payment + §3.H Partner
  const [defaultInflowAccount, setDefaultInflowAccount] = useState('bank');
  const [defaultOutflowAccount, setDefaultOutflowAccount] = useState('bank');
  const [methodCashEnabled, setMethodCashEnabled] = useState(true);
  const [methodBankEnabled, setMethodBankEnabled] = useState(true);
  const [methodCardEnabled, setMethodCardEnabled] = useState(true);
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
    setFyStartMonth(getSetting(branchId, 'finance.fiscal_year_start_month') || '1');
    setOpeningCash(getSetting(branchId, 'finance.opening_cash') || '0');
    setOpeningBank(getSetting(branchId, 'finance.opening_bank') || '0');
    setMonthlyTarget(getSetting(branchId, 'finance.monthly_target') || '');
    setDefaultInflowAccount(getSetting(branchId, 'payment.default_inflow_account') || 'bank');
    setDefaultOutflowAccount(getSetting(branchId, 'payment.default_outflow_account') || 'bank');
    setMethodCashEnabled((getSetting(branchId, 'payment.method_cash_enabled') || '1') !== '0');
    setMethodBankEnabled((getSetting(branchId, 'payment.method_bank_enabled') || '1') !== '0');
    setMethodCardEnabled((getSetting(branchId, 'payment.method_card_enabled') || '1') !== '0');
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
    setSetting(branchId, 'finance.fiscal_year_start_month', fyStartMonth, 'finance');
    setSetting(branchId, 'payment.default_inflow_account', defaultInflowAccount, 'payment');
    setSetting(branchId, 'payment.default_outflow_account', defaultOutflowAccount, 'payment');
    setSetting(branchId, 'payment.method_cash_enabled', methodCashEnabled ? '1' : '0', 'payment');
    setSetting(branchId, 'payment.method_bank_enabled', methodBankEnabled ? '1' : '0', 'payment');
    setSetting(branchId, 'payment.method_card_enabled', methodCardEnabled ? '1' : '0', 'payment');
    setSetting(branchId, 'partner.profit_share_default', partnerProfitShareDefault, 'partner');
    setSetting(branchId, 'partner.report_period', partnerReportPeriod, 'partner');
    setSetting(branchId, 'partner.warn_limit', partnerWarnLimit, 'partner');
    if (isOwner) {
      setSetting(branchId, 'finance.opening_cash', openingCash || '0', 'finance');
      setSetting(branchId, 'finance.opening_bank', openingBank || '0', 'finance');
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
              <Input
                type="number" step="0.01" value={cardFeeRate} onChange={e => setCardFeeRate(e.target.value)}
                placeholder="2.2" style={{ maxWidth: 100 }}
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
                ? 'Starting balance for cash and bank at the moment you begin using LATAIF. Used as the baseline for the cashflow calculation.'
                : 'Only the owner can edit opening balances.'}
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
                <input type="checkbox" checked={methodCardEnabled} onChange={e => setMethodCardEnabled(e.target.checked)} /> Card
              </label>
            </div>
          </FieldRow>
          <FieldRow label="Default inflow account">
            <select value={defaultInflowAccount} onChange={e => setDefaultInflowAccount(e.target.value)}
              style={{ background: '#F2F7FA', border: '1px solid #D5D9DE', borderRadius: 8, color: '#0F0F10', padding: '10px 12px', fontSize: 13, minWidth: 160 }}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
            </select>
          </FieldRow>
          <FieldRow label="Default outflow account">
            <select value={defaultOutflowAccount} onChange={e => setDefaultOutflowAccount(e.target.value)}
              style={{ background: '#F2F7FA', border: '1px solid #D5D9DE', borderRadius: 8, color: '#0F0F10', padding: '10px 12px', fontSize: 13, minWidth: 160 }}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
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

  async function refreshServer() {
    const { getServerStatus } = await import('@/core/sync/sync-server');
    const s = await getServerStatus();
    setServerStatus(s);
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

  async function handleToggleServer() {
    const { startSyncServer, stopSyncServer } = await import('@/core/sync/sync-server');
    try {
      if (serverStatus?.running) {
        await stopSyncServer();
        (await import('@/core/sync/auto-lan')).setLanMode('off');
        setLanModeUi('off');
      } else {
        await startSyncServer();
        (await import('@/core/sync/auto-lan')).setLanMode('server');
        setLanModeUi('server');
      }
      await refreshServer();
    } catch (err) {
      setResult(String(err));
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
                : `Start this machine as a sync server if you want other LATAIF installations in the same network (same Wi-Fi or LAN) to sync against it. First installation to start usually becomes the server.`}
              {serverStatus.running && (
                <code style={{ color: '#0F0F10', background: '#F2F7FA', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{serverStatus.url}</code>
              )}
            </p>
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

function DangerZoneTab() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const [purgeSuccess, setPurgeSuccess] = useState('');
  const [backupMsg, setBackupMsg] = useState('');

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
    if (confirmText !== 'RESET') return;
    await resetDatabase();
    localStorage.removeItem('lataif_session');
    window.location.reload();
  }

  function handlePurge() {
    if (!purgeTarget || confirmText !== 'DELETE') return;
    const db = getDatabase();
    const branchId = currentBranchId();
    const tables: Record<string, string[]> = {
      products: ['DELETE FROM offer_lines WHERE offer_id IN (SELECT id FROM offers WHERE branch_id = ?)', 'DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE branch_id = ?)', 'DELETE FROM products WHERE branch_id = ?'],
      customers: ['DELETE FROM customers WHERE branch_id = ?'],
      offers: ['DELETE FROM offer_lines WHERE offer_id IN (SELECT id FROM offers WHERE branch_id = ?)', 'DELETE FROM offers WHERE branch_id = ?'],
      invoices: ['DELETE FROM payments WHERE branch_id = ?', 'DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE branch_id = ?)', 'DELETE FROM invoices WHERE branch_id = ?'],
      repairs: ['DELETE FROM repairs WHERE branch_id = ?'],
      consignments: ['DELETE FROM consignments WHERE branch_id = ?'],
      agents: ['DELETE FROM agent_transfers WHERE branch_id = ?', 'DELETE FROM agents WHERE branch_id = ?'],
      orders: ['DELETE FROM orders WHERE branch_id = ?'],
      tasks: ['DELETE FROM tasks WHERE branch_id = ?'],
      documents: ['DELETE FROM documents WHERE branch_id = ?'],
      all_data: [
        'DELETE FROM offer_lines WHERE offer_id IN (SELECT id FROM offers WHERE branch_id = ?)',
        'DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE branch_id = ?)',
        'DELETE FROM payments WHERE branch_id = ?',
        'DELETE FROM agent_transfers WHERE branch_id = ?',
        'DELETE FROM offers WHERE branch_id = ?',
        'DELETE FROM invoices WHERE branch_id = ?',
        'DELETE FROM repairs WHERE branch_id = ?',
        'DELETE FROM consignments WHERE branch_id = ?',
        'DELETE FROM agents WHERE branch_id = ?',
        'DELETE FROM orders WHERE branch_id = ?',
        'DELETE FROM tasks WHERE branch_id = ?',
        'DELETE FROM documents WHERE branch_id = ?',
        'DELETE FROM products WHERE branch_id = ?',
        'DELETE FROM customers WHERE branch_id = ?',
      ],
    };
    const queries = tables[purgeTarget];
    if (!queries) return;
    for (const sql of queries) {
      db.run(sql, [branchId]);
    }
    saveDatabase();
    setPurgeTarget(null);
    setConfirmText('');
    setPurgeSuccess(`All ${purgeTarget.replace('_', ' ')} deleted.`);
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
      <Modal open={!!purgeTarget} onClose={() => setPurgeTarget(null)} title={`Delete ${purgeTarget?.replace('_', ' ')}`} width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(170,110,110,0.06)', border: '1px solid rgba(220,38,38,0.2)' }}>
            <p style={{ fontSize: 13, color: '#AA6E6E', lineHeight: 1.5 }}>
              This will permanently delete all {purgeTarget?.replace('_', ' ')} from this branch. This cannot be undone.
            </p>
          </div>
          <p style={{ fontSize: 13, color: '#4B5563' }}>
            Type <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 600 }}>DELETE</span> to confirm:
          </p>
          <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="Type DELETE" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setPurgeTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={handlePurge} disabled={confirmText !== 'DELETE'}>Delete</Button>
          </div>
        </div>
      </Modal>

      {/* Factory reset confirmation */}
      <Modal open={confirmOpen} onClose={() => { setConfirmOpen(false); setConfirmText(''); }} title="Factory Reset" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(170,110,110,0.06)', border: '1px solid rgba(220,38,38,0.2)' }}>
            <p style={{ fontSize: 13, color: '#AA6E6E', lineHeight: 1.5 }}>
              This will permanently delete ALL data, users, and settings. The app will restart completely fresh.
            </p>
          </div>
          <p style={{ fontSize: 13, color: '#4B5563' }}>
            Type <span className="font-mono" style={{ color: '#0F0F10', fontWeight: 600 }}>RESET</span> to confirm:
          </p>
          <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="Type RESET" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setConfirmOpen(false); setConfirmText(''); }}>Cancel</Button>
            <Button variant="danger" onClick={handleReset} disabled={confirmText !== 'RESET'}>Factory Reset</Button>
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
  const [activeTab, setActiveTab] = useState<TabKey>('company');
  const [hoveredTab, setHoveredTab] = useState<TabKey | null>(null);

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
      case 'ai': return <AiTab />;
      case 'sync': return <SyncTab />;
      case 'updates': return <UpdatesTab />;
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
