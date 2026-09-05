// CENTRAL-C3E — die Maße der drei Handelsformulare.
//
// Sie stehen in einer eigenen Datei ohne Komponenten, weil eine Datei, die BEIDES exportiert, das
// Nachladen im Betrieb (Fast Refresh) unbrauchbar macht: React kann dann nicht mehr unterscheiden,
// was eine Komponente ist und was eine Konstante — und lädt im Zweifel die ganze Seite neu.

import type { CSSProperties } from 'react';

export const box: CSSProperties = { padding: 16, maxWidth: 860 };
export const label: CSSProperties = { display: 'block', fontSize: 12, opacity: 0.7, marginBottom: 4 };
export const field: CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,0.4)',
  background: 'transparent', color: 'inherit',
};
export const warn: CSSProperties = {
  marginTop: 12, padding: '8px 10px', borderRadius: 6,
  border: '1px solid rgba(200,150,0,0.5)', background: 'rgba(200,150,0,0.08)',
};

export function btn(primary: boolean): CSSProperties {
  return {
    marginTop: 8, padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)',
    background: primary ? 'rgba(90,140,255,0.18)' : 'transparent', color: 'inherit',
  };
}
