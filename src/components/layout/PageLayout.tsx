import { useRef, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { SearchClearButton } from '@/components/ui/SearchClearButton';
import { useListScrollRestore } from '@/hooks/useListNav';

interface PageLayoutProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  showSearch?: boolean;
  onSearch?: (query: string) => void;
  searchPlaceholder?: string;
  /**
   * LIST NAVIGATION UX (v0.8.98) — der aktive Suchtext. Mit ihm zeigt das Feld immer genau die Suche, nach der die
   * Liste gefiltert ist (auch nach „Back"), und bietet ein „×" zum Löschen.
   */
  searchValue?: string;
}

export function PageLayout({
  children, title, subtitle, actions,
  showSearch = false, onSearch, searchPlaceholder = 'Search...', searchValue,
}: PageLayoutProps) {
  // LIST NAVIGATION UX (v0.8.98) — Scroll-Position je Verlaufsschritt: zurück per „Back" an dieselbe Stelle, nach
  // normaler Navigation oben. Solange die Wiederherstellung wartet, bleibt der Inhalt unsichtbar (kein Sprung).
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoring = useListScrollRestore(scrollRef);
  const inputRef = useRef<HTMLInputElement>(null);
  const controlled = searchValue !== undefined;
  return (
    <div ref={scrollRef} className="app-content" style={{ background: '#FFFFFF' }} data-page-scroll>
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
          {showSearch && (
            <div style={{ marginBottom: 20, maxWidth: 480 }}>
              <div className="relative">
                <Search
                  size={15}
                  className="absolute top-1/2 -translate-y-1/2"
                  style={{ left: 14, color: '#6B7280' }}
                />
                <input
                  ref={inputRef}
                  type="text"
                  placeholder={searchPlaceholder}
                  {...(controlled ? { value: searchValue } : {})}
                  onChange={(e) => onSearch?.(e.target.value)}
                  data-page-search
                  className="w-full outline-none transition-colors duration-300"
                  style={{
                    background: '#F2F7FA',
                    border: '1px solid #E5E9EE',
                    borderRadius: 8,
                    padding: controlled ? '10px 38px 10px 40px' : '10px 14px 10px 40px',
                    fontSize: 13,
                    color: '#0F0F10',
                  }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#D5D9DE')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#E5E9EE')}
                />
                {controlled && searchValue && (
                  <SearchClearButton onClear={() => { onSearch?.(''); inputRef.current?.focus(); }} />
                )}
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
      <main className="animate-fade-in" style={{ padding: '32px 48px 48px', visibility: restoring ? 'hidden' : undefined }}
        data-page-restoring={restoring ? '' : undefined}>
        {children}
      </main>
    </div>
  );
}
