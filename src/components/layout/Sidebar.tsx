import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Package, FileText,
  Receipt, CheckSquare, BarChart3, Settings, LogOut, Building2,
  Wrench, Handshake, UserCheck, ShoppingCart, FolderOpen,
  HandCoins, Sparkles, Truck, Wallet, Landmark, UserPlus, Factory,
} from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';

interface NavGroup {
  label?: string;
  items: { to: string; label: string; icon: typeof LayoutDashboard }[];
}

const navGroups: NavGroup[] = [
  // 1. Dashboard
  {
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  // 2. Sales — Kunden & Verkauf
  {
    label: 'SALES',
    items: [
      { to: '/clients', label: 'Clients', icon: Users },
      { to: '/offers', label: 'Offers', icon: FileText },
      { to: '/invoices', label: 'Invoices', icon: Receipt },
      { to: '/orders', label: 'Orders', icon: ShoppingCart },
      { to: '/agents', label: 'Approval', icon: UserCheck },
      { to: '/consignments', label: 'Consignment', icon: Handshake },
    ],
  },
  // 3. Inventory
  {
    label: 'INVENTORY',
    items: [
      { to: '/collection', label: 'Collection', icon: Package },
    ],
  },
  // 4. Procurement
  {
    label: 'PROCUREMENT',
    items: [
      { to: '/suppliers', label: 'Suppliers', icon: Truck },
      { to: '/purchases', label: 'Purchases', icon: ShoppingCart },
    ],
  },
  // 5. Production
  {
    label: 'PRODUCTION',
    items: [
      { to: '/production', label: 'Production', icon: Factory },
    ],
  },
  // 6. Services
  {
    label: 'SERVICES',
    items: [
      { to: '/repairs', label: 'Repairs', icon: Wrench },
    ],
  },
  // 7. Finance
  {
    label: 'FINANCE',
    items: [
      { to: '/expenses', label: 'Expenses', icon: Wallet },
      { to: '/banking', label: 'Banking', icon: Landmark },
      { to: '/debts', label: 'Debts', icon: HandCoins },
    ],
  },
  // 8. Documents
  {
    label: 'DOCUMENTS',
    items: [
      { to: '/documents', label: 'Documents', icon: FolderOpen },
    ],
  },
  // 9. Business Management
  {
    label: 'BUSINESS MANAGEMENT',
    items: [
      { to: '/partners', label: 'Partners', icon: UserPlus },
      { to: '/tasks', label: 'Tasks', icon: CheckSquare },
    ],
  },
  // 10. Analytics & Reports
  {
    label: 'ANALYTICS & REPORTS',
    items: [
      { to: '/analytics', label: 'Analytics', icon: BarChart3 },
      { to: '/business-reports', label: 'Business Reports', icon: BarChart3 },
    ],
  },
  // 11. AI
  {
    label: 'AI',
    items: [
      { to: '/reports', label: 'Reports AI', icon: Sparkles },
    ],
  },
];

export function Sidebar() {
  const location = useLocation();
  const { session, branches, logout, switchBranch } = useAuthStore();
  const [branchOpen, setBranchOpen] = useState(false);

  const userName = session?.user.name || 'User';
  const userInitials = userName.split(' ').map(n => n[0]).join('').slice(0, 2);
  const branchName = session?.branch.name || 'Branch';
  const roleName = session?.role || 'viewer';

  return (
    <aside
      className="app-sidebar flex flex-col select-none"
      style={{
        width: 260, minWidth: 260,
        background: '#EFECE2', borderRight: '1px solid #E5E1D6',
      }}
    >
      {/* Logo + Branch */}
      <div className="px-6 pt-8 pb-2">
        <h1 className="font-display" style={{ fontSize: 20, letterSpacing: '0.3em', color: '#0F0F10', fontWeight: 300 }}>
          LATAIF
        </h1>
      </div>

      {/* Branch Indicator */}
      <div className="px-6 pb-6 relative">
        <div
          className="flex items-center justify-between rounded-md cursor-pointer transition-colors"
          style={{ padding: '6px 8px', margin: '0 -8px', background: 'rgba(15,15,16,0.04)' }}
          onClick={() => branches.length > 1 && setBranchOpen(!branchOpen)}
        >
          <div className="flex items-center gap-2">
            <Building2 size={13} style={{ color: '#0F0F10' }} />
            <span style={{ fontSize: 11, color: '#0F0F10', letterSpacing: '0.04em' }}>{branchName}</span>
          </div>
          {branches.length > 1 && <ChevronDown size={12} style={{ color: '#0F0F10', transform: branchOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />}
        </div>
        {branchOpen && branches.length > 1 && (
          <div className="absolute left-6 right-6 rounded-md" style={{ marginTop: 4, background: '#FFFFFF', border: '1px solid #E5E1D6', zIndex: 50 }}>
            {branches.map(b => (
              <div key={b.branchId}
                className="cursor-pointer transition-colors"
                style={{
                  padding: '8px 12px', fontSize: 12,
                  color: b.branchId === session?.branchId ? '#0F0F10' : '#4B5563',
                  background: b.branchId === session?.branchId ? 'rgba(15,15,16,0.04)' : 'transparent',
                }}
                onClick={() => { switchBranch(b.branchId); setBranchOpen(false); }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.06)')}
                onMouseLeave={e => (e.currentTarget.style.background = b.branchId === session?.branchId ? 'rgba(15,15,16,0.04)' : 'transparent')}
              >
                {b.branchName} <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>{b.role}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3">
        {navGroups.map((group, gi) => (
          <div key={gi} style={{ marginBottom: group.label ? 4 : 0 }}>
            {group.label && (
              <span style={{ display: 'block', fontSize: 10, letterSpacing: '0.08em', color: '#6B7280', padding: '16px 16px 6px', fontWeight: 500 }}>
                {group.label}
              </span>
            )}
            {group.items.map(({ to, label, icon: Icon }) => {
              const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
              return (
                <NavLink
                  key={to} to={to}
                  className="relative flex items-center gap-3 rounded-md transition-all duration-200"
                  style={{ padding: '10px 16px', fontSize: 14, color: isActive ? '#0F0F10' : '#6B7280' }}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.color = '#4B5563'; }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.color = '#6B7280'; }}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r"
                      style={{ width: 2, height: 20, background: '#0F0F10' }} />
                  )}
                  <Icon size={18} strokeWidth={1.5} />
                  <span>{label}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 space-y-0.5">
        <NavLink
          to="/settings"
          className="flex items-center gap-3 rounded-md transition-all duration-200"
          style={{ padding: '11px 16px', fontSize: 14, color: location.pathname.startsWith('/settings') ? '#0F0F10' : '#6B7280' }}
        >
          <Settings size={19} strokeWidth={1.5} />
          <span>Settings</span>
        </NavLink>

        <button
          onClick={logout}
          className="w-full flex items-center gap-3 rounded-md transition-all duration-200 cursor-pointer"
          style={{ padding: '11px 16px', fontSize: 14, color: '#6B7280', background: 'none', border: 'none', textAlign: 'left' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#AA6E6E')}
          onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
        >
          <LogOut size={19} strokeWidth={1.5} />
          <span>Sign Out</span>
        </button>

        {/* User Info */}
        <div className="flex items-center gap-3" style={{ padding: '12px 16px', borderTop: '1px solid #E5E1D6', marginTop: 8 }}>
          <div
            className="flex items-center justify-center rounded-full shrink-0"
            style={{ width: 34, height: 34, background: '#E5E1D6', border: '1px solid #D5D1C4', fontSize: 11, color: '#4B5563', fontWeight: 500 }}
          >
            {userInitials}
          </div>
          <div>
            <div style={{ fontSize: 13, color: '#0F0F10' }}>{userName}</div>
            <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'capitalize' }}>{roleName}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
