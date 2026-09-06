// CENTRAL-C3F — was die Reparatur- und Transferformulare des Clients entscheiden, ohne JSX.
//
// Dieselben drei Regeln wie bei den Handelsbelegen, weil es dieselben Gefahren sind:
//
//  1. **Beim Anlegen reist nur die Eingabe.** Keine Belegnummer, kein Gutscheincode, kein Status,
//     keine Marge, kein Agent. Der Bildschirm zeigt eine Marge zur Orientierung — geschickt wird
//     sie nicht, der Primary rechnet seine eigene.
//  2. **Beim Ändern reist nur der Unterschied.** Was niemand angefasst hat, steht nicht im Rumpf.
//  3. **Und die gesehene FASSUNG reist mit.** Sie ist nicht wählbar: genau die Zahl, die der
//     Lesevorgang geliefert hat. Ohne sie lehnt der Primary ab.

export type Draft = Record<string, string>;

const numOrNull = (v: string): number | null => {
  const t = (v ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Der geladene Datensatz als Formularstand — alles als Text, damit „unverändert" vergleichbar ist. */
export function draftOf(fields: readonly string[], row: Record<string, unknown>): Draft {
  const out: Draft = {};
  for (const f of fields) {
    const v = row[f];
    out[f] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/** Was ein Änderungsauftrag außer Kennung und Fassung noch trägt. Nichts = nichts zu tun. */
export function changeCount(body: Record<string, unknown>): number {
  return Object.keys(body).filter((k) => k !== 'id' && k !== 'expectedRevision').length;
}

// ── Reparatur ─────────────────────────────────────────────────────────────

export interface RepairDraft {
  customerId: string;
  itemBrand: string;
  itemModel: string;
  itemSerial: string;
  issueDescription: string;
  diagnosis: string;
  repairType: string;
  externalVendor: string;
  workshopSupplierId: string;
  estimatedCost: string;
  actualCost: string;
  internalCost: string;
  chargeToCustomer: string;
  estimatedReady: string;
  taxScheme: string;
  notes: string;
}

export const EMPTY_REPAIR: RepairDraft = {
  customerId: '', itemBrand: '', itemModel: '', itemSerial: '', issueDescription: '',
  diagnosis: '', repairType: 'internal', externalVendor: '', workshopSupplierId: '',
  estimatedCost: '', actualCost: '', internalCost: '', chargeToCustomer: '',
  estimatedReady: '', taxScheme: 'VAT_10', notes: '',
};

const REPAIR_CREATE_TEXT = ['itemBrand', 'itemModel', 'itemSerial', 'externalVendor',
  'workshopSupplierId', 'estimatedReady', 'notes'] as const;
const REPAIR_CREATE_MONEY = ['estimatedCost', 'internalCost', 'chargeToCustomer'] as const;

export function repairCreateRequest(d: RepairDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    customerId: d.customerId,
    issueDescription: d.issueDescription.trim(),
    repairType: d.repairType,
    taxScheme: d.taxScheme,
  };
  for (const f of REPAIR_CREATE_TEXT) {
    const v = (d[f] ?? '').trim();
    if (v) body[f] = v;
  }
  for (const f of REPAIR_CREATE_MONEY) {
    const v = numOrNull(d[f]);
    if (v !== null) body[f] = v;
  }
  return body;
}

export function repairComplete(d: RepairDraft): boolean {
  return d.customerId.trim() !== '' && d.issueDescription.trim() !== '';
}

/** Genau die Felder, die der „Save"-Knopf der Reparaturseite schreibt — ohne die abgeleiteten. */
export const REPAIR_EDIT_FIELDS = [
  'diagnosis', 'estimatedCost', 'actualCost', 'internalCost', 'chargeToCustomer',
  'repairType', 'externalVendor', 'workshopSupplierId', 'estimatedReady',
  'itemBrand', 'itemModel', 'itemSerial', 'notes',
] as const;
const REPAIR_EDIT_MONEY: readonly string[] = ['estimatedCost', 'actualCost', 'internalCost', 'chargeToCustomer'];

export function repairUpdateRequest(id: string, revision: number, base: Draft, now: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = { id, expectedRevision: revision };
  for (const f of REPAIR_EDIT_FIELDS) {
    if ((base[f] ?? '') === (now[f] ?? '')) continue;
    const raw = (now[f] ?? '').trim();
    if (REPAIR_EDIT_MONEY.includes(f)) {
      // Ein geleertes Zahlenfeld heißt „kein Wert", nicht 0. `internalCost` ist die Ausnahme:
      // der Primary leitet sie ohnehin ab und die Spalte trägt kein NULL.
      body[f] = raw === '' ? (f === 'internalCost' ? 0 : null) : Number(raw);
      continue;
    }
    body[f] = raw === '' ? null : raw;
  }
  return body;
}

/**
 * Die Marge, die der Bildschirm ZEIGT — wortgleich zur Ableitung am Primary. Sie reist NICHT mit:
 * der Primary rechnet seine eigene aus dem Stand, der nach der Änderung gilt.
 */
export function previewMargin(d: Pick<RepairDraft, 'repairType' | 'estimatedCost' | 'actualCost' | 'internalCost' | 'chargeToCustomer'>): number | null {
  const charge = numOrNull(d.chargeToCustomer);
  if (charge === null) return null;
  const estimated = numOrNull(d.estimatedCost);
  const actual = numOrNull(d.actualCost);
  const given = numOrNull(d.internalCost) ?? 0;
  const derived = actual ?? estimated ?? 0;
  const effective = d.repairType === 'hybrid' ? given : (given > 0 ? given : derived);
  const total = d.repairType === 'hybrid' ? effective + (estimated ?? 0) : effective;
  return charge - total;
}

// ── Agenten-Transfer ──────────────────────────────────────────────────────

export interface TransferDraft {
  customerId: string;
  productId: string;
  agentPrice: string;
  minimumPrice: string;
  settlementModel: string;
  excessSplitPct: string;
  returnBy: string;
  notes: string;
}

export const EMPTY_TRANSFER: TransferDraft = {
  customerId: '', productId: '', agentPrice: '', minimumPrice: '',
  settlementModel: 'full', excessSplitPct: '50', returnBy: '', notes: '',
};

/**
 * Der Mensch wählt einen KUNDEN und ein Stück Ware. Den Agenten dazu findet das Haus — ein
 * `agentId` gäbe es in diesem Rumpf nicht, und eine Transfernummer schon gar nicht.
 *
 * Der Gewinnanteil reist nur mit SEINEM Modell: bei „full" wäre er ein Parameter, den niemand
 * liest, und der Primary weist ihn ab.
 */
export function transferCreateRequest(d: TransferDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    customerId: d.customerId,
    productId: d.productId,
    agentPrice: numOrNull(d.agentPrice) ?? 0,
    settlementModel: d.settlementModel === 'split' ? 'split' : 'full',
  };
  if (d.settlementModel === 'split') body.excessSplitPct = numOrNull(d.excessSplitPct) ?? 50;
  if (d.returnBy.trim()) body.returnBy = d.returnBy.trim();
  if (d.notes.trim()) body.notes = d.notes.trim();
  return body;
}

export function transferComplete(d: TransferDraft): boolean {
  return d.customerId.trim() !== '' && d.productId.trim() !== '' && (numOrNull(d.agentPrice) ?? 0) > 0;
}

/** Genau die vier Felder, die an einem noch offenen Transfer geändert werden dürfen. */
export const TRANSFER_EDIT_FIELDS = ['agentPrice', 'minimumPrice', 'returnBy', 'notes'] as const;
const TRANSFER_EDIT_MONEY: readonly string[] = ['agentPrice', 'minimumPrice'];

export function transferUpdateRequest(id: string, revision: number, base: Draft, now: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = { id, expectedRevision: revision };
  for (const f of TRANSFER_EDIT_FIELDS) {
    if ((base[f] ?? '') === (now[f] ?? '')) continue;
    const raw = (now[f] ?? '').trim();
    body[f] = TRANSFER_EDIT_MONEY.includes(f) ? (raw === '' ? null : Number(raw)) : (raw === '' ? null : raw);
  }
  return body;
}

/** Die Rückgabe trägt nichts als die Kennung und die gesehene Fassung — mehr entscheidet sie nicht. */
export function transferReturnRequest(id: string, revision: number): Record<string, unknown> {
  return { id, expectedRevision: revision };
}
