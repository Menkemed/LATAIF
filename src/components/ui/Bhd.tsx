// Bhd-Amount-Komponente — zeigt BHD-Wert mit 3 Dezimalstellen, wobei
// die Nachkommastellen (".000") kleiner gerendert werden als die Ganzzahl.
// Farbe und font-weight erben vom Parent — nur die Groesse wird reduziert,
// damit die Hauptzahl visuell dominiert ohne grau zu wirken.
//
// Verwendung:
//   <Bhd v={750.000} />              → "750.000" mit kleinen ".000"
//   <Bhd v={1234.5} />                → "1,234.500" mit kleinen ".500"
//   <Bhd v={null} />                  → "0.000" mit kleinen ".000"
//
// Konvention: nur fuer SICHTBARE BHD-Anzeigen in JSX verwenden. Fuer
// String-Konkatenation (CSV, Tooltips, title= Props) weiter fmtBhd() aus
// core/utils/format nutzen — die liefert reinen String "750.000".

import { type CSSProperties } from 'react';

interface BhdProps {
  v: number | null | undefined;
  /** Optional override fuer die relative Groesse der Nachkommastellen.
   *  Default '0.7em'. */
  fracSize?: string;
  /** Optional extra-styling auf den Wrapper-Span. */
  style?: CSSProperties;
}

export function Bhd({ v, fracSize = '0.7em', style }: BhdProps) {
  const n = Number(v);
  const safe = isFinite(n) ? n : 0;
  const str = safe.toLocaleString('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
  const [whole, frac] = str.split('.');
  return (
    <span style={style}>
      {whole}
      <span style={{ fontSize: fracSize }}>.{frac || '000'}</span>
    </span>
  );
}
