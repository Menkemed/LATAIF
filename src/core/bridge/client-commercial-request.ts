// CENTRAL-C3E — was die drei Handelsformulare des Clients wirklich entscheiden, ohne JSX drumherum.
//
// Es liegt aus demselben Grund hier wie schon `client-masterdata-draft`: ein Vertrag, den man nur
// im Browser laden kann, ist nicht prüfbar. Und der Vertrag ist der eigentliche Inhalt der
// Formulare — die Eingabefelder sind nur die Oberfläche darüber.
//
// Drei Regeln, alle aus demselben Grundsatz („der Client bestimmt nichts, was das Haus ableitet"):
//
//  1. **Beim Anlegen reist nur die Eingabe.** Keine Summe, kein Rest, keine Marge, keine Nummer,
//     keine SKU, kein Status. Der Bildschirm rechnet eine Summe für die ANZEIGE — sie wird nicht
//     mitgeschickt, und der Primary rechnet seine eigene. Kommt eine andere heraus, ist die des
//     Primary die richtige.
//  2. **Beim Ändern reist nur der Unterschied.** Ein Formular, das alle Felder zurückschickt,
//     überschreibt auch das, was jemand anderes inzwischen geändert hat (M-01). Was niemand
//     angefasst hat, steht nicht im Rumpf.
//  3. **Und die gesehene FASSUNG reist mit.** Sie ist nicht wählbar: sie ist genau die Zahl, die
//     der Lesevorgang geliefert hat. Ohne sie lehnt der Primary ab.

/** Eine Position, wie ein Mensch sie eingibt: ein Artikel, eine Menge, ein Preis. */
export interface DraftLine {
  productId: string;
  quantity: string;
  unitPrice: string;
  description?: string;
}

export type Draft = Record<string, string>;

const numOrNull = (v: string): number | null => {
  const t = (v ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Nur Positionen, die wirklich einen Artikel tragen — eine leere Zeile ist keine Position. */
export function usableLines(lines: readonly DraftLine[]): Array<{ productId: string; quantity: number; unitPrice: number; description?: string }> {
  const out: Array<{ productId: string; quantity: number; unitPrice: number; description?: string }> = [];
  for (const l of lines) {
    if (!l.productId) continue;
    const qty = numOrNull(l.quantity);
    const price = numOrNull(l.unitPrice);
    if (qty === null || qty <= 0 || !Number.isInteger(qty)) continue;
    if (price === null || price < 0) continue;
    const d = (l.description ?? '').trim();
    out.push({ productId: l.productId, quantity: qty, unitPrice: price, ...(d ? { description: d } : {}) });
  }
  return out;
}

/** Was der Bildschirm ANZEIGT. Ausdrücklich nicht das, was gebucht wird. */
export function previewTotal(lines: readonly DraftLine[]): number {
  return usableLines(lines).reduce((s, l) => s + l.quantity * l.unitPrice, 0);
}

// ── Einkauf ───────────────────────────────────────────────────────────────

export interface PurchaseDraft {
  supplierId: string;
  purchaseDate: string;
  taxScheme: string;
  notes: string;
  paymentAmount: string;
  paymentMethod: string;
}

export const EMPTY_PURCHASE: PurchaseDraft = {
  supplierId: '', purchaseDate: '', taxScheme: 'ZERO', notes: '', paymentAmount: '', paymentMethod: 'bank',
};

/**
 * Der Rumpf von `purchases.create`. Was leer bleibt, reist gar nicht mit — ein Feld mit `null`
 * wäre eine Aussage („kein Datum"), und die will hier niemand treffen.
 */
export function purchaseCreateRequest(d: PurchaseDraft, lines: readonly DraftLine[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    supplierId: d.supplierId,
    taxScheme: d.taxScheme === 'VAT_10' ? 'VAT_10' : 'ZERO',
    lines: usableLines(lines),
  };
  if (d.purchaseDate.trim()) body.purchaseDate = d.purchaseDate.trim();
  if (d.notes.trim()) body.notes = d.notes.trim();
  const amount = numOrNull(d.paymentAmount);
  if (amount !== null && amount > 0) {
    body.initialPayment = { amount, method: d.paymentMethod };
  }
  return body;
}

export function purchaseComplete(d: PurchaseDraft, lines: readonly DraftLine[]): boolean {
  return d.supplierId.trim() !== '' && usableLines(lines).length > 0;
}

// ── Kommission ────────────────────────────────────────────────────────────

export interface ConsignmentDraft {
  consignorId: string;
  brand: string;
  name: string;
  categoryId: string;
  condition: string;
  agreedPrice: string;
  minimumPrice: string;
  payoutModel: string;
  commissionRate: string;
  excessSplitPct: string;
  expiryDate: string;
  notes: string;
}

export const EMPTY_CONSIGNMENT: ConsignmentDraft = {
  consignorId: '', brand: '', name: '', categoryId: '', condition: '',
  agreedPrice: '', minimumPrice: '', payoutModel: 'percent', commissionRate: '15',
  excessSplitPct: '50', expiryDate: '', notes: '',
};

/**
 * Der Anteil eines Modells gehört zu DIESEM Modell. Was zu einem anderen gehört, reist nicht mit —
 * sonst trüge der Auftrag einen Parameter, den sein Modell gar nicht kennt, und der Primary müsste
 * ihn wegwerfen. Dieselbe Aufteilung wie am Primary-Bildschirm (`payoutFieldsFor`).
 */
export function payoutRequest(d: Pick<ConsignmentDraft, 'payoutModel' | 'commissionRate' | 'excessSplitPct'>): Record<string, unknown> {
  if (d.payoutModel === 'percent') {
    return { model: 'percent', commissionRate: numOrNull(d.commissionRate) ?? 0 };
  }
  if (d.payoutModel === 'cost_split') {
    return { model: 'cost_split', excessSplitPct: numOrNull(d.excessSplitPct) ?? 50 };
  }
  return { model: 'consignor_fixed' };
}

export function consignmentCreateRequest(d: ConsignmentDraft, acknowledgeDuplicate = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    consignorId: d.consignorId,
    product: {
      brand: d.brand.trim(),
      name: d.name.trim(),
      categoryId: d.categoryId,
      ...(d.condition.trim() ? { condition: d.condition.trim() } : {}),
    },
    agreedPrice: numOrNull(d.agreedPrice) ?? 0,
    payout: payoutRequest(d),
  };
  const min = numOrNull(d.minimumPrice);
  if (min !== null) body.minimumPrice = min;
  if (d.expiryDate.trim()) body.expiryDate = d.expiryDate.trim();
  if (d.notes.trim()) body.notes = d.notes.trim();
  if (acknowledgeDuplicate) body.acknowledgeDuplicate = true;
  return body;
}

export function consignmentComplete(d: ConsignmentDraft): boolean {
  return d.consignorId.trim() !== '' && d.brand.trim() !== '' && d.name.trim() !== ''
    && d.categoryId.trim() !== '' && (numOrNull(d.agreedPrice) ?? 0) > 0;
}

/** Genau die Kopffelder, die der „Save"-Knopf am Primary schreibt. */
export const CONSIGNMENT_EDIT_FIELDS = ['agreedPrice', 'minimumPrice', 'expiryDate', 'notes'] as const;
const CONSIGNMENT_EDIT_NUMERIC: readonly string[] = ['agreedPrice', 'minimumPrice'];

/**
 * Der Änderungsrumpf: die gesehene Fassung, der Unterschied im Kopf — und das Modell NUR, wenn es
 * sich wirklich geändert hat und noch offen ist. Ein Modell mitzuschicken, das gleich geblieben
 * ist, wäre nicht falsch, aber es liefe in die Sperre eines abgerechneten Datensatzes und ließe
 * eine reine Notizänderung scheitern.
 */
export function consignmentUpdateRequest(
  id: string,
  revision: number,
  base: Draft,
  now: Draft,
  opts: { payoutLocked: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = { id, expectedRevision: revision };
  for (const f of CONSIGNMENT_EDIT_FIELDS) {
    if ((base[f] ?? '') === (now[f] ?? '')) continue;
    const raw = (now[f] ?? '').trim();
    body[f] = CONSIGNMENT_EDIT_NUMERIC.includes(f)
      ? (raw === '' ? null : Number(raw))
      : (raw === '' ? null : raw);
  }
  if (!opts.payoutLocked) {
    const changed = (base.payoutModel ?? '') !== (now.payoutModel ?? '')
      || (base.commissionRate ?? '') !== (now.commissionRate ?? '')
      || (base.excessSplitPct ?? '') !== (now.excessSplitPct ?? '');
    if (changed) {
      body.payout = payoutRequest({
        payoutModel: now.payoutModel ?? '', commissionRate: now.commissionRate ?? '',
        excessSplitPct: now.excessSplitPct ?? '',
      });
    }
  }
  return body;
}

/** Was ein Änderungsauftrag außer der Kennung und der Fassung noch trägt. Nichts = nichts zu tun. */
export function changeCount(body: Record<string, unknown>): number {
  return Object.keys(body).filter((k) => k !== 'id' && k !== 'expectedRevision').length;
}

// ── Auftrag ───────────────────────────────────────────────────────────────

export interface OrderDraft {
  customerId: string;
  depositAmount: string;
  paymentMethod: string;
  cardBrand: string;
  expectedDelivery: string;
  supplierName: string;
  supplierPrice: string;
  notes: string;
}

export const EMPTY_ORDER: OrderDraft = {
  customerId: '', depositAmount: '', paymentMethod: 'cash', cardBrand: 'normal',
  expectedDelivery: '', supplierName: '', supplierPrice: '', notes: '',
};

export function orderCreateRequest(d: OrderDraft, lines: readonly DraftLine[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    customerId: d.customerId,
    lines: usableLines(lines),
  };
  const deposit = numOrNull(d.depositAmount);
  if (deposit !== null && deposit > 0) {
    body.depositAmount = deposit;
    body.paymentMethod = d.paymentMethod;
    // Die Marke gehört zur Karte — bei jeder anderen Zahlungsart wäre sie eine Angabe ohne Sinn.
    if (d.paymentMethod === 'card') body.cardBrand = d.cardBrand === 'amex' ? 'amex' : 'normal';
  }
  if (d.expectedDelivery.trim()) body.expectedDelivery = d.expectedDelivery.trim();
  if (d.supplierName.trim()) body.supplierName = d.supplierName.trim();
  const sp = numOrNull(d.supplierPrice);
  if (sp !== null) body.supplierPrice = sp;
  if (d.notes.trim()) body.notes = d.notes.trim();
  return body;
}

export function orderComplete(d: OrderDraft, lines: readonly DraftLine[]): boolean {
  return d.customerId.trim() !== '' && usableLines(lines).length > 0;
}

/** Genau die Felder des „Save"-Knopfs auf der Auftragsseite — ohne die beiden abgeleiteten. */
export const ORDER_EDIT_FIELDS = [
  'agreedPrice', 'depositAmount', 'supplierName', 'supplierPrice', 'expectedDelivery', 'notes',
] as const;
const ORDER_EDIT_NUMERIC: readonly string[] = ['agreedPrice', 'depositAmount', 'supplierPrice'];

export function orderUpdateRequest(id: string, revision: number, base: Draft, now: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = { id, expectedRevision: revision };
  for (const f of ORDER_EDIT_FIELDS) {
    if ((base[f] ?? '') === (now[f] ?? '')) continue;
    const raw = (now[f] ?? '').trim();
    body[f] = ORDER_EDIT_NUMERIC.includes(f)
      ? (raw === '' ? null : Number(raw))
      : (raw === '' ? null : raw);
  }
  return body;
}

/** Der geladene Datensatz als Formularstand — alles als Text, damit „unverändert" vergleichbar ist. */
export function draftOf(fields: readonly string[], row: Record<string, unknown>): Draft {
  const out: Draft = {};
  for (const f of fields) {
    const v = row[f];
    out[f] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}
