import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, ChevronDown } from 'lucide-react';

export interface SearchSelectOption {
  id: string;
  label: string;
  subtitle?: string;
  meta?: string;
}

interface SearchSelectProps {
  label?: string;
  placeholder?: string;
  options: SearchSelectOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

// Dropdown-Position aus Trigger-Rect berechnen — nutzt position:fixed,
// damit overflow:hidden / Tabellen / Modals den Dropdown nicht abschneiden.
function useDropdownPosition(triggerRef: React.RefObject<HTMLDivElement | null>, open: boolean) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number; openUp: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const update = () => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < 280 && r.top > 280;
      setPos({
        top: openUp ? r.top - 4 : r.bottom + 4,
        left: r.left,
        width: r.width,
        openUp,
      });
    };
    update();

    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, triggerRef]);

  return pos;
}

export function SearchSelect({ label, placeholder = 'Search...', options, value, onChange, disabled }: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pos = useDropdownPosition(triggerRef, open);

  const selected = options.find(o => o.id === value);

  const filtered = query
    ? options.filter(o => `${o.label} ${o.subtitle || ''} ${o.meta || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 50)
    : options.slice(0, 50);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function handleOpen() {
    if (disabled) return;
    setOpen(true);
    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function handleSelect(id: string) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
    setOpen(false);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {label && <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>{label}</span>}

      {/* Trigger */}
      <div
        ref={triggerRef}
        className="flex items-center justify-between cursor-pointer transition-colors"
        style={{
          padding: '9px 12px',
          background: '#F2F7FA',
          border: `1px solid ${open ? '#0F0F10' : '#E5E9EE'}`,
          borderRadius: 6,
          fontSize: 13,
          color: selected ? '#0F0F10' : '#6B7280',
          minHeight: 40,
        }}
        onClick={handleOpen}
      >
        <div className="flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? (
            <span>{selected.label}{selected.subtitle ? <span style={{ color: '#6B7280', marginLeft: 6, fontSize: 11 }}>{selected.subtitle}</span> : null}</span>
          ) : (
            <span style={{ color: '#6B7280' }}>{placeholder}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {value && !disabled && (
            <button onClick={handleClear} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280', padding: 2 }}>
              <X size={14} />
            </button>
          )}
          <ChevronDown size={14} style={{ color: '#6B7280', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        </div>
      </div>

      {/* Dropdown via Portal direkt in document.body — keine Vorfahren-Effekte mehr */}
      {open && pos && createPortal(
        <div ref={dropdownRef} style={{
          position: 'fixed',
          top: pos.openUp ? undefined : pos.top,
          bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
          left: Math.min(pos.left, window.innerWidth - Math.max(pos.width, 360) - 16),
          width: Math.max(pos.width, 360),
          maxWidth: 'calc(100vw - 32px)',
          background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 8,
          zIndex: 99999, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(15,15,16,0.18)',
        }}>
          {/* Search Input */}
          <div className="flex items-center gap-2" style={{ padding: '8px 12px', borderBottom: '1px solid #E5E9EE' }}>
            <Search size={14} style={{ color: '#6B7280', flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to search..."
              className="flex-1 outline-none"
              style={{ background: 'transparent', border: 'none', fontSize: 13, color: '#0F0F10' }}
            />
          </div>

          {/* Options */}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '16px 12px', textAlign: 'center', fontSize: 12, color: '#6B7280' }}>
                {query ? 'No results' : 'No options'}
              </div>
            )}
            {filtered.map(opt => (
              <div
                key={opt.id}
                className="cursor-pointer transition-colors"
                style={{
                  padding: '8px 12px',
                  background: opt.id === value ? 'rgba(15,15,16,0.06)' : 'transparent',
                  borderLeft: opt.id === value ? '2px solid #0F0F10' : '2px solid transparent',
                }}
                onClick={() => handleSelect(opt.id)}
                onMouseEnter={e => { if (opt.id !== value) e.currentTarget.style.background = 'rgba(15,15,16,0.04)'; }}
                onMouseLeave={e => { if (opt.id !== value) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ fontSize: 13, color: '#0F0F10' }}>{opt.label}</div>
                {(opt.subtitle || opt.meta) && (
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 1 }}>
                    {opt.subtitle}{opt.meta ? ` \u00b7 ${opt.meta}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Multi-select variant for products ──

interface SearchMultiSelectProps {
  label?: string;
  placeholder?: string;
  options: SearchSelectOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function SearchMultiSelect({ label, placeholder = 'Search and select...', options, value, onChange, disabled }: SearchMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pos = useDropdownPosition(triggerRef, open);

  const selectedOptions = options.filter(o => value.includes(o.id));

  const filtered = query
    ? options.filter(o => `${o.label} ${o.subtitle || ''} ${o.meta || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 100)
    : options.slice(0, 100);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function toggle(id: string) {
    if (value.includes(id)) onChange(value.filter(v => v !== id));
    else onChange([...value, id]);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {label && <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>{label}</span>}

      {/* Trigger */}
      <div
        ref={triggerRef}
        className="cursor-pointer transition-colors"
        style={{
          padding: '9px 12px',
          background: '#F2F7FA',
          border: `1px solid ${open ? '#0F0F10' : '#E5E9EE'}`,
          borderRadius: 6,
          fontSize: 13,
          minHeight: 40,
        }}
        onClick={() => { if (!disabled) { setOpen(!open); setQuery(''); setTimeout(() => inputRef.current?.focus(), 50); } }}
      >
        {selectedOptions.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {selectedOptions.map(o => (
              <span key={o.id} className="flex items-center gap-1" style={{
                padding: '2px 8px', fontSize: 11, borderRadius: 999,
                background: 'rgba(15,15,16,0.08)', border: '1px solid rgba(15,15,16,0.15)', color: '#0F0F10',
              }}>
                {o.label}
                <button onClick={e => { e.stopPropagation(); toggle(o.id); }} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#0F0F10', padding: 0 }}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span style={{ color: '#6B7280' }}>{placeholder}</span>
        )}
      </div>

      {/* Dropdown via Portal direkt in document.body */}
      {open && pos && createPortal(
        <div ref={dropdownRef} style={{
          position: 'fixed',
          top: pos.openUp ? undefined : pos.top,
          bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
          left: Math.min(pos.left, window.innerWidth - Math.max(pos.width, 360) - 16),
          width: Math.max(pos.width, 360),
          maxWidth: 'calc(100vw - 32px)',
          background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 8,
          zIndex: 99999, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(15,15,16,0.18)',
        }}>
          <div className="flex items-center gap-2" style={{ padding: '8px 12px', borderBottom: '1px solid #E5E9EE' }}>
            <Search size={14} style={{ color: '#6B7280', flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to search..."
              className="flex-1 outline-none"
              style={{ background: 'transparent', border: 'none', fontSize: 13, color: '#0F0F10' }}
            />
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '16px 12px', textAlign: 'center', fontSize: 12, color: '#6B7280' }}>
                {query ? 'No results' : 'No options'}
              </div>
            )}
            {filtered.map(opt => {
              const sel = value.includes(opt.id);
              return (
                <div
                  key={opt.id}
                  className="cursor-pointer transition-colors flex items-center gap-3"
                  style={{
                    padding: '8px 12px',
                    background: sel ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}
                  onClick={() => toggle(opt.id)}
                  onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'rgba(15,15,16,0.04)'; }}
                  onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{
                    width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                    border: sel ? '1px solid #0F0F10' : '1px solid #D5D9DE',
                    background: sel ? '#0F0F10' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, color: '#F2F7FA',
                  }}>{sel ? '\u2713' : ''}</span>
                  <div className="flex-1">
                    <div style={{ fontSize: 13, color: '#0F0F10' }}>{opt.label}</div>
                    {opt.meta && <div style={{ fontSize: 11, color: '#6B7280' }}>{opt.meta}</div>}
                  </div>
                  {opt.subtitle && <span className="font-mono" style={{ fontSize: 11, color: '#4B5563' }}>{opt.subtitle}</span>}
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
