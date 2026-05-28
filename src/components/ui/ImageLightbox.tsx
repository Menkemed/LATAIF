// ImageLightbox — fullscreen Overlay um ein Produkt-Foto anzuklicken und gross
// zu sehen. Wird ueberall genutzt wo Produkt-Bilder gezeigt werden
// (Collection, ProductDetail, Dashboard, Hover-Card, Purchase/Invoice/Repair/
// Production/Order Thumbs). Verhalten:
//   - ESC schliesst
//   - Klick auf Backdrop schliesst
//   - Galerie (>1 Foto): Prev/Next via Buttons + Pfeiltasten + Counter "2 / 5"
//   - Bild wird via `object-fit: contain` voll dargestellt
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';

interface ImageLightboxProps {
  images: string[];
  index?: number;
  onClose: () => void;
  alt?: string;
}

export function ImageLightbox({ images, index = 0, onClose, alt = '' }: ImageLightboxProps) {
  const [current, setCurrent] = useState(Math.max(0, Math.min(index, images.length - 1)));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setCurrent(c => (c - 1 + images.length) % images.length);
      else if (e.key === 'ArrowRight') setCurrent(c => (c + 1) % images.length);
    }
    window.addEventListener('keydown', onKey);
    // Body scrolling sperren waehrend Overlay offen
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [images.length, onClose]);

  if (!images || images.length === 0) return null;
  const hasMany = images.length > 1;
  const src = images[current];

  // v0.7.19 — Render via Portal an document.body, damit `position: fixed`
  // nicht von einem transformierten Layout-Ancestor (Sidebar/PageLayout)
  // als Containing-Block uebernommen wird. Sonst landet das Overlay nicht
  // im Viewport sondern hinter dem Sidebar/unterhalb des Folds.
  // v0.7.19 — Kompakter Popup-Stil (wie Modal): zentriert mit Backdrop-Blur,
  // Bild ~500px breit. Container via absolute+translate zentriert, damit das
  // img nicht in einem 0-Breite-Flex-Container kollabiert.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(15,15,16,0.45)',
          backdropFilter: 'blur(6px)',
          cursor: 'zoom-out',
        }}
      />

      {/* Bild-Container (popup-Style, kompakt, absolut zentriert) */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      >
        <img
          src={src}
          alt={alt}
          style={{
            // `display: block` macht img zu block-level → nimmt 100% des
            // 0-Breite-Parents = 0px. Stattdessen inline-block lassen, dann
            // wird das img bei seiner intrinsischen Groesse gerendert und
            // durch max-width/max-height begrenzt.
            // v0.7.19 — popup ~800×600, gecappt auf 90vw/85vh damit es bei
            // kleinen Fenstern nicht ueber den Rand laeuft. `object-fit:
            // contain` verhindert Hochskalieren ueber die Foto-Aufloesung.
            display: 'inline-block', verticalAlign: 'top',
            maxWidth: 'min(800px, 90vw)',
            maxHeight: 'min(600px, 85vh)',
            objectFit: 'contain',
            borderRadius: 10,
            boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
            background: '#FFFFFF',
          }}
        />

        {/* Close-Button (am Bild oben rechts) */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: -14, right: -14,
            background: '#FFFFFF', color: '#0F0F10',
            border: '1px solid #E5E9EE', borderRadius: 999,
            width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
          }}
        >
          <X size={16} />
        </button>

        {/* Prev / Next nur bei Galerie */}
        {hasMany && (
          <>
            <button
              onClick={() => setCurrent(c => (c - 1 + images.length) % images.length)}
              aria-label="Previous image"
              style={{
                position: 'absolute', left: -18, top: '50%', transform: 'translateY(-50%)',
                background: '#FFFFFF', color: '#0F0F10',
                border: '1px solid #E5E9EE', borderRadius: 999,
                width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
              }}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              onClick={() => setCurrent(c => (c + 1) % images.length)}
              aria-label="Next image"
              style={{
                position: 'absolute', right: -18, top: '50%', transform: 'translateY(-50%)',
                background: '#FFFFFF', color: '#0F0F10',
                border: '1px solid #E5E9EE', borderRadius: 999,
                width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
              }}
            >
              <ChevronRight size={18} />
            </button>
            <div
              style={{
                position: 'absolute', bottom: -28, left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(15,15,16,0.75)', color: '#FFF',
                borderRadius: 999, padding: '4px 10px',
                fontSize: 11, fontWeight: 500, letterSpacing: '0.04em',
              }}
            >
              {current + 1} / {images.length}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
