// ════════════════════════════════════════════════════════════════════════════
// Wie ein Goldeinsatz GELESEN wird — eine Zeile, zwei Bildschirme.
//
// Der Verlauf hält fest, was passiert ist: was der Kunde gebracht hat, was verarbeitet wurde, was
// übrig blieb und wohin es ging — oder, beim Werkstattgold, dass daraus eine Gramm-Schuld wurde
// und wie sie ausgeglichen wird. Hier wird nichts gerechnet: die Zahlen stehen so in der Zeile.
// Rechner und Telefon benutzen denselben Satz, damit derselbe Vorgang nicht an zwei Orten
// verschieden heißt.
// ════════════════════════════════════════════════════════════════════════════

export interface GoldUsageView {
  source?: string | null;
  karat?: string | null;
  receivedGrams?: number | null;
  usedGrams?: number | null;
  remainderGrams?: number | null;
  leftover?: string | null;
  settlementType?: string | null;
}

const g = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(3)} g` : '';
};

/** Wohin der Rest des Kundengoldes ging — die drei Wörter des Hauses, ausgeschrieben. */
export function leftoverLabel(leftover?: string | null): string {
  if (leftover === 'credit') return 'kept as customer credit';
  if (leftover === 'shop_keep') return 'kept by the shop';
  if (leftover === 'return') return 'back to the customer';
  return '';
}

/** Wie die Schuld aus Werkstattgold ausgeglichen wird. */
export function settlementLabel(settlementType?: string | null): string {
  if (settlementType === 'pay_money') return 'settled in money';
  if (settlementType === 'return_gold') return 'settled in gold';
  return '';
}

/**
 * Die eine Zeile eines Goldeinsatzes:
 *   Kundengold  → `Received 5.000 g · Used 5.000 g · Remainder 0.000 g`
 *                 (mit Rest zusätzlich: `· back to the customer`)
 *   Werkstatt   → `Received 8.000 g · gold debt · settled in gold`
 */
export function goldUsageLine(h: GoldUsageView): string {
  const teile: string[] = [];
  const erhalten = g(h.receivedGrams);
  if (erhalten) teile.push(`Received ${erhalten}`);
  if (String(h.source || '') === 'workshop') {
    teile.push('gold debt');
    const s = settlementLabel(h.settlementType);
    if (s) teile.push(s);
    return teile.join(' · ');
  }
  const verbraucht = g(h.usedGrams);
  if (verbraucht) teile.push(`Used ${verbraucht}`);
  const rest = g(h.remainderGrams);
  if (rest) teile.push(`Remainder ${rest}`);
  // Wohin der Rest ging, sagt nur etwas, wenn es einen Rest GAB.
  if (Number(h.remainderGrams) > 0) {
    const l = leftoverLabel(h.leftover);
    if (l) teile.push(l);
  }
  return teile.join(' · ');
}
