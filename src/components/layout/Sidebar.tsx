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
  { label: 'SERVICES', items: [{ to: '/repairs', label: 'Repairs', icon: Wrench, tone: 'purple' }] },
  {
    label: 'FINANCE',
    items: [
      { to: '/expenses', label: 'Expenses', icon: Wallet, tone: 'orange' },
      { to: '/banking', label: 'Banking', icon: Landmark, tone: 'blue' },
      { to: '/debts', label: 'Debts', icon: HandCoins, tone: 'pink' },
    ],
  },
  { label: 'DOCUMENTS', items: [{ to: '/documents', label: 'Documents', icon: FolderOpen, tone: 'cyan' }] },
  {
    label: 'BUSINESS MANAGEMENT',
    items: [
      { to: '/partners', label: 'Partners', icon: UserPlus, tone: 'purple' },
      { to: '/tasks', label: 'Tasks', icon: CheckSquare, tone: 'green' },
    ],
  },
  {
    label: 'ANALYTICS & REPORTS',
    items: [
      { to: '/analytics', label: 'Analytics', icon: BarChart3, tone: 'blue' },
      { to: '/business-reports', label: 'Business Reports', icon: BarChart3, tone: 'cyan' },
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
        {navGroups.map((group, gi) => (
          <div key={gi} style={{ marginBottom: group.label ? 6 : 0 }}>
            {group.label && (
              <span style={{ display: 'block', fontSize: 9, letterSpacing: '0.10em', color: '#9CA3AF', padding: '14px 14px 4px', fontWeight: 600 }}>
                {group.label}
              </span>
            )}
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
                  <span>{label}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-3" style={{ borderTop: '1px solid #E5E9EE', paddingTop: 8 }}>
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
