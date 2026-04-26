import { type ReactNode } from 'react';
import { Search } from 'lucide-react';

interface PageLayoutProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  showSearch?: boolean;
  onSearch?: (query: string) => void;
  searchPlaceholder?: string;
}

export function PageLayout({
  children, title, subtitle, actions,
  showSearch = false, onSearch, searchPlaceholder = 'Search...',
}: PageLayoutProps) {
  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10"
        style={{
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #E5E1D6',
        }}
      >
        <div style={{ padding: '24px 48px' }}>
          {showSearch && (
            <div style={{ marginBottom: 20, maxWidth: 480 }}>
              <div className="relative">
                <Search
                  size={15}
                  className="absolute top-1/2 -translate-y-1/2"
                  style={{ left: 14, color: '#6B7280' }}
                />
                <input
                  type="text"
                  placeholder={searchPlaceholder}
                  onChange={(e) => onSearch?.(e.target.value)}
                  className="w-full outline-none transition-colors duration-300"
                  style={{
                    background: '#EFECE2',
                    border: '1px solid #E5E1D6',
                    borderRadius: 8,
                    padding: '10px 14px 10px 40px',
                    fontSize: 13,
                    color: '#0F0F10',
                  }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#D5D1C4')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#E5E1D6')}
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              {title && <h1 className="text-display-s" style={{ color: '#0F0F10' }}>{title}</h1>}
              {subtitle && <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-3">{actions}</div>}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="animate-fade-in" style={{ padding: '32px 48px 48px' }}>
        {children}
      </main>
    </div>
  );
}
