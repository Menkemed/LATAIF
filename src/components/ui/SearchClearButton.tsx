// LIST NAVIGATION UX (v0.8.98) — das „×" in einem Suchfeld: löscht den Suchtext vollständig, die Liste folgt sofort.
import { X } from 'lucide-react';

export function SearchClearButton({ onClear, right = 10 }: { onClear: () => void; right?: number }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title="Clear search"
      aria-label="Clear search"
      data-search-clear
      className="absolute top-1/2 -translate-y-1/2 cursor-pointer"
      style={{
        right, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: 999, background: 'transparent', color: '#6B7280', padding: 0,
      }}
    >
      <X size={14} />
    </button>
  );
}
