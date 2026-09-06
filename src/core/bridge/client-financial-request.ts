// CENTRAL-C3G — was die Geldknöpfe des Clients entscheiden, ohne JSX.
//
// Bei Geld ist die Regel enger als sonst: der Rumpf trägt einen ausdrücklichen Betrag und die
// gelesene Fassung, sonst nichts. Kein „zahl den Rest", kein „rechne alles ab" — beides sind
// Zahlen, die sich zwischen Lesen und Ankommen ändern, und wer Geld bewegt, meint einen Betrag.
//
// Und jede dieser Handlungen ist ein EIGENER Vorsatz: ein offener Zahlungs-Berichtigungsversuch
// darf niemals als Löschung weiterlaufen. Deshalb bekommt jede ihren eigenen Wächter, nicht einen
// gemeinsamen — das steht in den Formularen, aber der Grund gehört hierher.

const numOrNull = (v: string): number | null => {
  const t = (v ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Ein Betrag, den ein Mensch eingetippt hat — oder nichts. */
export function amountOf(v: string): number | null {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
}

export function applyCreditRequest(invoiceId: string, revision: number, amount: string, note = ''): Record<string, unknown> {
  const body: Record<string, unknown> = {
    invoiceId,
    amount: amountOf(amount) ?? 0,
    expectedRevision: revision,
  };
  if (note.trim()) body.note = note.trim();
  return body;
}

export const PAYMENT_EDIT_FIELDS = ['amount', 'method', 'notes', 'receivedAt'] as const;

/**
 * Nur der Unterschied. Ein Formular, das alle vier Felder zurückschickt, bucht eine Zahlung neu,
 * die niemand angefasst hat — und jede Neubuchung ist eine Stornobuchung plus eine Buchung.
 */
export function updatePaymentRequest(
  invoiceId: string, paymentId: string, revision: number,
  base: Record<string, string>, now: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { invoiceId, paymentId, expectedRevision: revision };
  for (const f of PAYMENT_EDIT_FIELDS) {
    if ((base[f] ?? '') === (now[f] ?? '')) continue;
    const raw = (now[f] ?? '').trim();
    if (f === 'amount') {
      const n = amountOf(raw);
      // Ein leerer oder unmöglicher Betrag wird gar nicht erst geschickt — der Primary würde ihn
      // abweisen, und der Mensch bekäme eine Fehlermeldung statt einer Eingabehilfe.
      if (n === null) continue;
      body[f] = n;
      continue;
    }
    body[f] = raw;
  }
  return body;
}

export function deletePaymentRequest(invoiceId: string, paymentId: string, revision: number): Record<string, unknown> {
  return { invoiceId, paymentId, expectedRevision: revision };
}

/** Die Umwandlung trägt nichts als Kennung und Fassung: WELCHE Positionen, entscheidet das Haus. */
export function convertOrderRequest(orderId: string, revision: number): Record<string, unknown> {
  return { orderId, expectedRevision: revision };
}

export function recordPayoutRequest(
  consignmentId: string, revision: number, amount: string, method: string, reference = '',
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    consignmentId,
    amount: amountOf(amount) ?? 0,
    method,
    expectedRevision: revision,
  };
  if (reference.trim()) body.reference = reference.trim();
  return body;
}

export function markSoldRequest(
  transferId: string, revision: number, salePrice: string, buyerInfo = '', acknowledgeBelowPrice = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    transferId,
    salePrice: amountOf(salePrice) ?? 0,
    expectedRevision: revision,
  };
  if (buyerInfo.trim()) body.buyerInfo = buyerInfo.trim();
  // Nur wenn ein Mensch sie wirklich gegeben hat — und dann gilt sie für GENAU diesen Versuch.
  if (acknowledgeBelowPrice) body.acknowledgeBelowPrice = true;
  return body;
}

export function markSettledRequest(
  transferId: string, revision: number, amount: string, method: string,
): Record<string, unknown> {
  return {
    transferId,
    amount: amountOf(amount) ?? 0,
    method,
    expectedRevision: revision,
  };
}

/** Was ein Rumpf außer Kennungen und Fassung noch trägt. Nichts = nichts zu tun. */
export function changeCount(body: Record<string, unknown>): number {
  const keys = ['invoiceId', 'paymentId', 'orderId', 'consignmentId', 'transferId', 'expectedRevision'];
  return Object.keys(body).filter((k) => !keys.includes(k)).length;
}
