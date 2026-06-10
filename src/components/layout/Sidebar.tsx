import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Package, FileText,
  Receipt, CheckSquare, BarChart3, Settings, LogOut, Building2,
  Wrench, Handshake, UserCheck, ShoppingCart, FolderOpen,
  HandCoins, Sparkles, Truck, Wallet, Landmark, UserPlus, Factory, FileMinus, CreditCard, Coins,
} from 'lucide-react';
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useOrderStore } from '@/stores/orderStore';
import { useProductStore } from '@/stores/productStore';

// localStorage-Key fuer expanded-Group-Persistence. Speichert ein JSON-Array
// von Group-Labels, die der User offen lassen will.
const SIDEBAR_EXPANDED_KEY = 'lataif.sidebar.expandedGroups';

interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; tone?: 'blue' | 'purple' | 'green' | 'orange' | 'pink' | 'cyan' }
interface NavGroup { label?: string; items: NavItem[] }

const navGroups: NavGroup[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, tone: 'purple' }] },
  {
    label: 'SALES',
    items: [
      { to: '/clients', label: 'Clients', icon: Users, tone: 'blue' },
      { to: '/offers', label: 'Offers', icon: FileText, tone: 'cyan' },
      { to: '/invoices', label: 'Invoices', icon: Receipt, tone: 'green' },
      { to: '/credit-notes', label: 'Credit Notes', icon: FileMinus, tone: 'orange' },
      { to: '/orders', label: 'Orders', icon: ShoppingCart, tone: 'orange' },
      { to: '/agents', label: 'Approval', icon: UserCheck, tone: 'purple' },
      { to: '/consignments', label: 'Consignment', icon: Handshake, tone: 'pink' },
    ],
  },
  { label: 'INVENTORY', items: [{ to: '/collection', label: 'Collection', icon: Package, tone: 'blue' }] },
  {
    label: 'PROCUREMENT',
    items: [
      { to: '/suppliers', label: 'Suppliers', icon: Truck, tone: 'green' },
      { to: '/purchases', label: 'Purchases', icon: ShoppingCart, tone: 'orange' },
    ],
  },
  { label: 'PRODUCTION', items: [{ to: '/production', label: 'Production', icon: Factory, tone: 'cyan' }] },
  {
    label: 'SERVICES',
    items: [
      { to: '/repairs', label: 'Repairs', icon: Wrench, tone: 'purple' },
      { to: '/scrap-trades', label: 'Scrap Gold', icon: Coins, tone: 'orange' },
    ],
  },
  {
    label: 'FINANCE',
    items: [
      { to: '/expenses', label: 'Expenses', icon: Wallet, tone: 'orange' },
      { to: '/banking', label: 'Banking', icon: Landmark, tone: 'blue' },
      { to: '/receivables', label: 'Receivables', icon: FileText, tone: 'green' },
      { to: '/payables', label: 'Payables', icon: CreditCard, tone: 'purple' },
      { to: '/debts', label: 'Debts', icon: HandCoins, tone: 'pink' },
    ],
  },
  { label: 'DOCUMENTS', items: [{ to: '/documents', label: 'Documents', icon: FolderOpen, tone: 'cyan' }] },
  {
    label: 'BUSINESS MANAGEMENT',
    items: [
      { to: '/employees', label: 'Employees', icon: Users, tone: 'cyan' },
      { to: '/partners', label: 'Partners', icon: UserPlus, tone: 'purple' },
      { to: '/tasks', label: 'Tasks', icon: CheckSquare, tone: 'green' },
    ],
  },
  {
    label: 'ANALYTICS & REPORTS',
    items: [
      { to: '/analytics', label: 'Analytics', icon: BarChart3, tone: 'blue' },
      { to: '/business-reports', label: 'Business Reports', icon: BarChart3, tone: 'cyan' },
      { to: '/reconciliation', label: 'Reconciliation', icon: BarChart3, tone: 'orange' },
      // Backfill-Werkzeuge (Opening/Customer-Credits/…) — Route existierte schon,
      // war aber ohne Menüeintrag in der installierten App (keine Adresszeile) unerreichbar.
      { to: '/ledger-backfill', label: 'Ledger Backfill', icon: BarChart3, tone: 'pink' },
    ],
  },
  { label: 'AI', items: [{ to: '/ai', label: 'AI', icon: Sparkles, tone: 'purple' }] },
];

const TONE_BG: Record<string, string> = {
  blue:   'rgba(61,127,255,0.10)',
  purple: 'rgba(113,93,227,0.10)',
  green:  'rgba(22,163,74,0.10)',
  orange: 'rgba(255,135,48,0.10)',
  pink:   'rgba(236,72,153,0.10)',
  cyan:   'rgba(115,217,237,0.18)',
};
const TONE_FG: Record<string, string> = {
  blue: '#3D7FFF', purple: '#715DE3', green: '#16A34A',
  orange: '#FF8730', pink: '#EC4899', cyan: '#0EA5C5',
};

export function Sidebar() {
  const location = useLocation();
  const { session, branches, logout, switchBranch } = useAuthStore();
  const [branchOpen, setBranchOpen] = useState(false);

  // v0.6.9 — Live-Count fuer den „Need to Order"-Badge beim Orders-Menupunkt.
  // Reagiert auf Order- + Produkt-Mutationen; berechnet wird via Store-Selektor.
  const orders = useOrderStore(s => s.orders);
  const loadOrders = useOrderStore(s => s.loadOrders);
  const getOrderIdsNeedingPurchase = useOrderStore(s => s.getOrderIdsNeedingPurchase);
  const products = useProductStore(s => s.products);
  const loadProducts = useProductStore(s => s.loadProducts);
  useEffect(() => { loadOrders(); loadProducts(); }, [loadOrders, loadProducts]);
  const needToOrderCount = useMemo(
    () => {
      // v0.6.9 — gleiche Quelle wie OrderDetail-Action-Zelle: in-memory productStore.
      const qtyMap = new Map(products.map(p => [p.id, p.quantity ?? 0]));
      return getOrderIdsNeedingPurchase(qtyMap).size;
    },
    [orders, products, getOrderIdsNeedingPurchase]
  );

  // Group-Collapse: speichert nur die EXPANDED Labels. Default = leer = alle zu.
  // Hydration aus localStorage einmal beim Mount.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_EXPANDED_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr.filter(x => typeof x === 'string'));
      }
    } catch {}
    return new Set();
  });

  // Persistenz bei jeder Aenderung.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_EXPANDED_KEY, JSON.stringify(Array.from(expandedGroups)));
    } catch {}
  }, [expandedGroups]);

  // Welche Gruppe enthaelt die aktuelle Route? Die wird automatisch als "open" behandelt,
  // damit der User immer den Kontext sieht wo er gerade steht.
  const activeGroupLabel = useMemo(() => {
    for (const g of navGroups) {
      if (!g.label) continue;
      const hit = g.items.some(it => it.to === '/' ? location.pathname === '/' : location.pathname.startsWith(it.to));
      if (hit) return g.label;
    }
    return null;
  }, [location.pathname]);

  function isGroupOpen(label: string): boolean {
    if (label === activeGroupLabel) return true;
    return expandedGroups.has(label);
  }

  function toggleGroup(label: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  // Alle Gruppen mit Label — fuer Bulk-Toggle (Expand-/Collapse-All).
  const allLabels = useMemo(
    () => navGroups.map(g => g.label).filter((l): l is string => !!l),
    []
  );
  const allExpanded = allLabels.every(l => expandedGroups.has(l));
  function toggleAll() {
    setExpandedGroups(allExpanded ? new Set() : new Set(allLabels));
  }

  const userName = session?.user.name || 'User';
  const userInitials = userName.split(' ').map(n => n[0]).join('').slice(0, 2);
  const branchName = session?.branch.name || 'Branch';
  const roleName = session?.role || 'viewer';

  return (
    <aside
      className="app-sidebar flex flex-col select-none"
      style={{
        width: 260, minWidth: 260,
        background: '#FFFFFF', borderRight: '1px solid #E5E9EE',
      }}
    >
      {/* Logo */}
      <div className="px-6 pt-7 pb-2">
        <h1 style={{
          fontSize: 22, fontWeight: 700, letterSpacing: '0.18em',
          color: '#0F0F10', fontFamily: 'Inter, sans-serif',
        }}>
          LATAIF
        </h1>
      </div>

      {/* Branch Indicator */}
      <div className="px-4 pb-5 relative">
        <div
          className="flex items-center justify-between rounded-lg cursor-pointer transition-colors"
          style={{ padding: '8px 12px', background: '#F2F7FA', border: '1px solid #E5E9EE' }}
          onClick={() => branches.length > 1 && setBranchOpen(!branchOpen)}
        >
          <div className="flex items-center gap-2">
            <Building2 size={14} style={{ color: '#715DE3' }} />
            <span style={{ fontSize: 12, color: '#0F0F10', fontWeight: 500 }}>{branchName}</span>
          </div>
          {branches.length > 1 && <ChevronDown size={12} style={{ color: '#6B7280', transform: branchOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />}
        </div>
        {branchOpen && branches.length > 1 && (
          <div className="absolute left-4 right-4 rounded-lg" style={{ marginTop: 4, background: '#FFFFFF', border: '1px solid #E5E9EE', zIndex: 50, boxShadow: '0 8px 24px rgba(15,15,16,0.08)' }}>
            {branches.map(b => (
              <div key={b.branchId}
                className="cursor-pointer transition-colors"
                style={{
                  padding: '10px 14px', fontSize: 12,
                  color: b.branchId === session?.branchId ? '#715DE3' : '#4B5563',
                  background: b.branchId === session?.branchId ? 'rgba(113,93,227,0.06)' : 'transparent',
                  fontWeight: b.branchId === session?.branchId ? 500 : 400,
                }}
                onClick={() => { switchBranch(b.branchId); setBranchOpen(false); }}
                onMouseEnter={e => (e.currentTarget.style.background = '#F2F7FA')}
                onMouseLeave={e => (e.currentTarget.style.background = b.branchId === session?.branchId ? 'rgba(113,93,227,0.06)' : 'transparent')}
              >
                {b.branchName} <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>{b.role}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 overflow-y-auto">
        {navGroups.map((group, gi) => {
          // Gruppen ohne Label (z.B. Dashboard) sind nicht kollapsierbar.
          const collapsible = !!group.label;
          const open = collapsible ? isGroupOpen(group.label!) : true;
          const isActiveGroup = group.label === activeGroupLabel;
          return (
            <div key={gi} style={{ marginBottom: group.label ? 6 : 0 }}>
              {group.label && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label!)}
                  className="cursor-pointer transition-colors"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    width: '100%', padding: '10px 14px 6px',
                    background: 'transparent', border: 'none', textAlign: 'left',
                    fontSize: 9, letterSpacing: '0.10em',
                    color: isActiveGroup ? '#0F0F10' : '#9CA3AF',
                    fontWeight: 600, textTransform: 'none',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
                  onMouseLeave={e => (e.currentTarget.style.color = isActiveGroup ? '#0F0F10' : '#9CA3AF')}
                  aria-expanded={open}
                  aria-controls={`sidebar-group-${gi}`}
                >
                  <span>{group.label}</span>
                  <ChevronDown
                    size={11}
                    style={{
                      transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                      transition: 'transform 0.18s ease',
                      opacity: 0.7,
                    }}
                  />
                </button>
              )}
              {open && (
                <div id={`sidebar-group-${gi}`}>
                  {group.items.map(({ to, label, icon: Icon, tone = 'purple' }) => {
                    const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
                    const fg = TONE_FG[tone];
                    const bg = TONE_BG[tone];
                    return (
                      <NavLink
                        key={to} to={to}
                        className="relative flex items-center gap-3 rounded-lg transition-all"
                        style={{
                          padding: '8px 10px',
                          fontSize: 13,
                          fontWeight: isActive ? 600 : 500,
                          color: isActive ? '#0F0F10' : '#4B5563',
                          background: isActive ? '#F2F7FA' : 'transparent',
                          margin: '1px 0',
                        }}
                        onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#F8FAFC'; }}
                        onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{
                          width: 28, height: 28, borderRadius: 8,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: bg, color: fg, flexShrink: 0,
                        }}>
                          <Icon size={15} strokeWidth={2} />
                        </span>
                        <span style={{ flex: 1 }}>{label}</span>
                        {/* v0.6.9 — Orange Puls-Badge: Anzahl Orders die noch beim
                            Supplier bestellt werden muessen (PENDING + kein Bestand). */}
                        {to === '/orders' && needToOrderCount > 0 && (
                          <span
                            className="font-mono pulse-orange"
                            title={`${needToOrderCount} Order${needToOrderCount === 1 ? '' : 's'} warten auf Supplier-Bestellung`}
                            style={{
                              minWidth: 22, height: 20, borderRadius: 10,
                              padding: '0 7px',
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              background: '#D97706', color: '#FFFFFF',
                              fontSize: 11, fontWeight: 600, lineHeight: 1,
                              flexShrink: 0,
                            }}
                          >{needToOrderCount}</span>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-3" style={{ borderTop: '1px solid #E5E9EE', paddingTop: 8 }}>
        {/* Expand/Collapse-all toggle */}
        <button
          type="button"
          onClick={toggleAll}
          title={allExpanded ? 'Collapse all groups' : 'Expand all groups'}
          aria-label={allExpanded ? 'Collapse all groups' : 'Expand all groups'}
          className="w-full flex items-center gap-3 rounded-lg transition-all cursor-pointer"
          style={{
            padding: '8px 10px', fontSize: 13, margin: '1px 0', fontWeight: 500,
            color: '#4B5563', background: 'none', border: 'none', textAlign: 'left',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#F8FAFC'; e.currentTarget.style.color = '#0F0F10'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#4B5563'; }}
        >
          <span style={{
            width: 28, height: 28, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(107,114,128,0.10)', color: '#6B7280', flexShrink: 0,
          }}>
            {allExpanded ? <ChevronsDownUp size={15} strokeWidth={2} /> : <ChevronsUpDown size={15} strokeWidth={2} />}
          </span>
          <span>{allExpanded ? 'Collapse all' : 'Expand all'}</span>
        </button>

        <NavLink
          to="/settings"
          className="flex items-center gap-3 rounded-lg transition-all"
          style={{
            padding: '8px 10px', fontSize: 13, margin: '1px 0',
            color: location.pathname.startsWith('/settings') ? '#0F0F10' : '#4B5563',
            background: location.pathname.startsWith('/settings') ? '#F2F7FA' : 'transparent',
            fontWeight: location.pathname.startsWith('/settings') ? 600 : 500,
          }}
        >
          <span style={{
            width: 28, height: 28, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(107,114,128,0.10)', color: '#6B7280', flexShrink: 0,
          }}>
            <Settings size={15} strokeWidth={2} />
          </span>
          <span>Settings</span>
        </NavLink>

        <button
          onClick={logout}
          className="w-full flex items-center gap-3 rounded-lg transition-all cursor-pointer"
          style={{
            padding: '8px 10px', fontSize: 13, margin: '1px 0', fontWeight: 500,
            color: '#4B5563', background: 'none', border: 'none', textAlign: 'left',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,38,38,0.04)'; e.currentTarget.style.color = '#DC2626'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#4B5563'; }}
        >
          <span style={{
            width: 28, height: 28, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(220,38,38,0.08)', color: '#DC2626', flexShrink: 0,
          }}>
            <LogOut size={15} strokeWidth={2} />
          </span>
          <span>Sign Out</span>
        </button>

        {/* User Info */}
        <div className="flex items-center gap-3" style={{ padding: '10px 8px', marginTop: 8, borderTop: '1px solid #E5E9EE', paddingTop: 12 }}>
          <div
            className="flex items-center justify-center rounded-full shrink-0"
            style={{ width: 34, height: 34, background: 'linear-gradient(135deg, #715DE3, #3D7FFF)', color: '#FFFFFF', fontSize: 12, fontWeight: 600 }}
          >
            {userInitials}
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#0F0F10', fontWeight: 500 }}>{userName}</div>
            <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'capitalize' }}>{roleName}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
