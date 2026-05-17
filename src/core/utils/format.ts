// ═══════════════════════════════════════════════════════════
// Format-Helper — eine zentrale Quelle fuer Geld-/Prozent-/Mengen-
// Formatierung. Spiegelt die Bahrain-Konvention: BHD hat 3 Dezimalstellen
// (Fils = 1/1000 BHD), USD hat 2, Mengen sind Integer.
//
// Konvention im UI:
//   - KPI-Kacheln (Dashboard) zeigen Geld als INTEGER → fmtBhdInt()
//   - Detail-Views, Listen-Rows mit Einzelpreisen, Payments, VAT
//     → fmtBhd() mit 3 Dezimalen
//   - Spot-Ticker USD → fmtUsd() mit 2 Dezimalen (USD-Standard)
//   - Stueckzahlen → fmtQty()
//   - Margin / Prozente → fmtPct() default 1 Dezimal
// ═══════════════════════════════════════════════════════════

// BHD in voller Praezision (3 Dezimalen, immer angezeigt). Verwendung:
// Invoice-Lines, Payments, VAT-Betraege, Listen-Spalten mit Einzelpreisen, Detail-Cards.
export function fmtBhd(v: number | null | undefined): string {
  const n = Number(v);
  if (!isFinite(n)) return '0.000';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

// BHD ohne Dezimalen — fuer Dashboard-Aggregat-KPIs und grosse Uebersichts-Zahlen.
// Schoenere Optik bei grossen Summen ("287,700" statt "287,700.000").
export function fmtBhdInt(v: number | null | undefined): string {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// USD — 2 Dezimalen (internationale Konvention). Fuer Spot-Prices.
export function fmtUsd(v: number | null | undefined): string {
  const n = Number(v);
  if (!isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Prozente. Default 1 Dezimal ("33.5%"), Margin-Anzeigen.
export function fmtPct(v: number | null | undefined, decimals = 1): string {
  const n = Number(v);
  if (!isFinite(n)) return '0%';
  return n.toFixed(decimals) + '%';
}

// Mengen / Stueckzahlen — Integer.
export function fmtQty(v: number | null | undefined): string {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
