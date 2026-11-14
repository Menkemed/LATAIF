// ════════════════════════════════════════════════════════════════════════════
// COLLECTIONS-S2 — „ist dieses Element sichtbar oder bald sichtbar?"
//
// Ein IntersectionObserver je Scroll-Container (geteilt von allen Karten darin), mit Vorlauf
// `NEAR_VIEWPORT_MARGIN`: eine Karte lädt ihr Bild, kurz bevor sie ins Bild scrollt — nicht alle
// 460 beim Öffnen. Einmal nah, bleibt die Antwort `true` (die Karte behält ihr Bild beim
// Weiterscrollen). Ohne IntersectionObserver (z. B. node) gilt jedes Element als nah.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';

/** Vorlauf über und unter dem sichtbaren Bereich (≈ 2–3 Kartenreihen). */
export const NEAR_VIEWPORT_MARGIN = '600px 0px';

type Shared = { io: IntersectionObserver; onNear: Map<Element, () => void> };
const observers = new WeakMap<object, Shared>();

/** Der nächste Vorfahr, der selbst vertikal scrollt — sonst der Viewport (`null`). */
function scrollRootOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p;
  }
  return null;
}

function sharedObserverFor(root: Element | null): Shared {
  const key: object = root ?? document;
  let s = observers.get(key);
  if (!s) {
    const onNear = new Map<Element, () => void>();
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) if (r.isIntersecting) onNear.get(r.target)?.();
      },
      { root, rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    s = { io, onNear };
    observers.set(key, s);
  }
  return s;
}

export function useNearViewport(el: Element | null): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !el) return;
    const s = sharedObserverFor(scrollRootOf(el));
    s.onNear.set(el, () => setNear(true));
    s.io.observe(el);
    return () => {
      s.io.unobserve(el);
      s.onNear.delete(el);
    };
  }, [near, el]);
  return near;
}
