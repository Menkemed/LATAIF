import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: number;
}

export function Modal({ open, onClose, title, children, width = 520 }: ModalProps) {
  useEffect(() => {
    if (open) {
      const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 9999 }}>
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(15,15,16,0.45)', backdropFilter: 'blur(6px)' }}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        className="relative animate-fade-in rounded-xl"
        style={{
          width,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 80px)',
          background: '#FFFFFF',
          border: '1px solid #E5E1D6',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {title && (
          <div
            className="flex items-center justify-between shrink-0"
            style={{ padding: '20px 24px', borderBottom: '1px solid #E5E1D6' }}
          >
            <h2 style={{ fontSize: 17, fontWeight: 500, color: '#0F0F10' }}>{title}</h2>
            <button
              onClick={onClose}
              className="transition-colors cursor-pointer"
              style={{ color: '#6B7280', padding: 4 }}
              onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
              onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
