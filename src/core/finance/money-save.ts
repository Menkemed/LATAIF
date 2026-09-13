// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — die gemeinsame Speicherfolge der Geldmasken (Steuerzahlung, Umbuchung,
// Gesellschafterbewegung, Darlehen anlegen/zurückzahlen/berichtigen).
//
// Jede Maske ruft EINE Funktion dieser Datei. Sie kennt zwei Anschlüsse und keine eigene Regel:
//
//   • am Primary die Hausfolge (`money-house.ts`) — exklusiv, in EINER Transaktion, erst danach
//     durabel (`…OnPrimary` = `runOnPrimary`). Vorher schrieb die Maske synchron an der
//     Schreibreihenfolge vorbei und buchte mit verschlucktem Fehler;
//   • auf dem Rechner ohne Datenbank der geprüfte Fernbefehl (`tax.record_payment`, …).
//
// Geprüft wird VOR dem Schicken mit derselben Eingaberegel, die der Primary anwendet — ein
// unbrauchbarer Rumpf verlässt den Rechner nicht, und beide Rechner sagen dasselbe. Nach einem
// Erfolg auf PC2 holen die Stores ihren Stand frisch vom Primary.
// ════════════════════════════════════════════════════════════════════════════
import { runOnPrimary } from '@/core/data/primary-action';
import type { WriteAdapters, WriteOutcome } from '@/core/data/shared-write';
import { useBankingStore } from '@/stores/bankingStore';
import { usePartnerStore } from '@/stores/partnerStore';
import { useDebtStore, type DebtView } from '@/stores/debtStore';
import { useAnalyticsStore } from '@/stores/analyticsStore';
import type { BankTransfer, CashSource, PartnerTransactionType } from '@/core/models/types';
import {
  bankTransferInput, createBankTransferInHouse, createDebtInHouse, debtCreateInput, debtPaymentInput,
  debtUpdateInput, localMoneyCtx, partnerTxInput, recordDebtPaymentInHouse, recordPartnerTxInHouse,
  recordTaxPaymentInHouse, taxPaymentInput, toFils, updateDebtInHouse,
  type BankTransferInput, type DebtCreateInput, type DebtPaymentInput, type DebtUpdateInput,
  type PartnerTxInput, type TaxPaymentInput,
} from './money-house';

// Die Namen der geprüften Fernbefehle (`bridge/money-commands.ts`). Hier als Wert, nicht als Import:
// die Oberfläche lädt die Befehlsdatei nicht (sie meldet beim Laden ihre Handler an).
const OP_TAX_RECORD_PAYMENT = 'tax.record_payment';
const OP_BANKING_TRANSFER = 'banking.transfer';
const OP_PARTNERS_RECORD_TX = 'partners.record_tx';
const OP_DEBTS_CREATE = 'debts.create';
const OP_DEBTS_RECORD_PAYMENT = 'debts.record_payment';
const OP_DEBTS_UPDATE = 'debts.update';

/** Was eine Maske von ihrer Schreibweiche braucht — `useSharedWrites()` passt. */
export interface MoneyWrite {
  readonly remote: boolean;
  save: <T>(op: string, adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
}

function absage<T>(e: unknown): WriteOutcome<T> {
  const code = (e as { code?: unknown })?.code;
  return {
    kind: 'business_error',
    code: typeof code === 'string' && code ? code : 'LOCAL_WRITE_REJECTED',
    message: e instanceof Error ? e.message : String(e),
  };
}

/** Der Rumpf: nur, was gesetzt ist (ein `undefined` ist kein Wert, den ein Rumpf trägt). */
function rumpf(input: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  return out;
}

/** Eine Zahl aus dem Eingabefeld; leer oder unlesbar bleibt NaN — die Eingaberegel sagt dann nein. */
export function amountFromField(v: string | number): number {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').trim();
  return t === '' ? Number.NaN : Number(t);
}

// ── Die Listen danach ───────────────────────────────────────────────────────

const analyticsNeu = () => useAnalyticsStore.getState().loadAnalytics();
const bankingNeu = () => useBankingStore.getState().loadTransfers();
const partnersNeu = () => { usePartnerStore.getState().loadPartners(); usePartnerStore.getState().loadTransactions(); };
const debtsNeu = (debtId?: string) => {
  useDebtStore.getState().loadDebts();
  if (debtId) useDebtStore.getState().loadPaymentsForDebt(debtId);
};

// ── Am Primary: die Hausfolge in der Schreibreihenfolge ─────────────────────

export function recordTaxPaymentOnPrimary(input: TaxPaymentInput) {
  return runOnPrimary(() => recordTaxPaymentInHouse(input, localMoneyCtx()), analyticsNeu);
}
export function createBankTransferOnPrimary(input: BankTransferInput) {
  return runOnPrimary(() => createBankTransferInHouse(input, localMoneyCtx()), bankingNeu);
}
export function recordPartnerTxOnPrimary(input: PartnerTxInput) {
  return runOnPrimary(() => recordPartnerTxInHouse(input, localMoneyCtx()), partnersNeu);
}
export function createDebtOnPrimary(input: DebtCreateInput) {
  return runOnPrimary(() => createDebtInHouse(input, localMoneyCtx()), () => debtsNeu());
}
export function recordDebtPaymentOnPrimary(input: DebtPaymentInput) {
  return runOnPrimary(() => recordDebtPaymentInHouse(input, localMoneyCtx()), () => debtsNeu(input.debtId));
}
export function updateDebtOnPrimary(input: DebtUpdateInput) {
  return runOnPrimary(() => updateDebtInHouse(input, localMoneyCtx()), () => debtsNeu(input.debtId));
}

// ── Die Masken ──────────────────────────────────────────────────────────────

/** „Record VAT Payment" (Auswertung, Quartalszeile „Mark paid"). */
export async function saveTaxPayment(
  w: MoneyWrite,
  form: { year: number; quarter: number; amount: string | number; source: 'cash' | 'bank'; paidAt: string; note?: string },
): Promise<WriteOutcome<{ taxPaymentId: string }>> {
  let input: TaxPaymentInput;
  try { input = taxPaymentInput({ ...form, amount: amountFromField(form.amount) }); } catch (e) { return absage(e); }
  const r = await w.save<{ taxPaymentId: string }>(OP_TAX_RECORD_PAYMENT, {
    local: async () => ({ taxPaymentId: (await recordTaxPaymentOnPrimary(input)).taxPaymentId }),
    remote: () => rumpf(input),
    shape: (v) => ({ taxPaymentId: String(v.taxPaymentId ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) analyticsNeu();
  return r;
}

/** „Create Transfer" (Bankseite). */
export async function saveBankTransfer(
  w: MoneyWrite,
  form: { direction: BankTransfer['direction']; amount: string | number; transferDate: string; notes?: string },
): Promise<WriteOutcome<{ transferId: string }>> {
  let input: BankTransferInput;
  try { input = bankTransferInput({ ...form, amount: amountFromField(form.amount) }); } catch (e) { return absage(e); }
  const r = await w.save<{ transferId: string }>(OP_BANKING_TRANSFER, {
    local: async () => ({ transferId: (await createBankTransferOnPrimary(input)).id }),
    remote: () => rumpf(input),
    shape: (v) => ({ transferId: String(v.transferId ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) bankingNeu();
  return r;
}

/** „Invest / Withdraw / Profit Share" (Partnerseite). */
export async function savePartnerTx(
  w: MoneyWrite,
  form: { partnerId: string; kind: PartnerTransactionType; amount: string | number; method: CashSource; date: string; notes?: string },
): Promise<WriteOutcome<{ transactionId: string; transactionNumber: string }>> {
  let input: PartnerTxInput;
  try { input = partnerTxInput({ ...form, amount: amountFromField(form.amount) }); } catch (e) { return absage(e); }
  const r = await w.save<{ transactionId: string; transactionNumber: string }>(OP_PARTNERS_RECORD_TX, {
    local: async () => {
      const tx = await recordPartnerTxOnPrimary(input);
      return { transactionId: tx.id, transactionNumber: tx.transactionNumber };
    },
    remote: () => rumpf(input),
    shape: (v) => ({ transactionId: String(v.transactionId ?? ''), transactionNumber: String(v.transactionNumber ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) partnersNeu();
  return r;
}

/** „Create Debt" (Darlehensseite). Die Gegenpartei bestimmt der Primary aus dem Kunden. */
export async function saveDebtCreate(
  w: MoneyWrite,
  form: { direction: string; customerId: string; amount: string | number; source: CashSource; dueDate?: string; notes?: string; staffId?: string },
): Promise<WriteOutcome<{ debtId: string; loanNumber: string }>> {
  let input: DebtCreateInput;
  try { input = debtCreateInput({ ...form, amount: amountFromField(form.amount) }); } catch (e) { return absage(e); }
  const r = await w.save<{ debtId: string; loanNumber: string }>(OP_DEBTS_CREATE, {
    local: async () => {
      const { debt } = await createDebtOnPrimary(input);
      return { debtId: debt.id, loanNumber: debt.loanNumber ?? '' };
    },
    remote: () => rumpf(input),
    shape: (v) => ({ debtId: String(v.debtId ?? ''), loanNumber: String(v.loanNumber ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) debtsNeu();
  return r;
}

/** „Record Repayment" — mit der Fassung, die die Maske gesehen hat. */
export async function saveDebtPayment(
  w: MoneyWrite,
  debt: DebtView,
  form: { amount: string | number; source: CashSource; paidAt: string; notes?: string },
): Promise<WriteOutcome<{ paymentId: string }>> {
  let input: DebtPaymentInput;
  try {
    input = debtPaymentInput({ debtId: debt.id, expectedRevision: debt.revision, ...form, amount: amountFromField(form.amount) });
  } catch (e) { return absage(e); }
  const r = await w.save<{ paymentId: string }>(OP_DEBTS_RECORD_PAYMENT, {
    local: async () => ({ paymentId: (await recordDebtPaymentOnPrimary(input)).payment.id }),
    remote: () => rumpf(input),
    shape: (v) => ({ paymentId: String(v.paymentId ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) debtsNeu(debt.id);
  return r;
}

/**
 * „Edit Debt" — nur, was sich gegen den geladenen Stand geändert hat (vorher reiste jedes Mal der
 * ganze Stand samt Betrag, und ein Betrag 0 warf ungefangen). Ohne Änderung: nichts zu tun.
 */
export async function saveDebtUpdate(
  w: MoneyWrite,
  base: DebtView,
  form: { counterparty: string; amount: string | number; dueDate: string; notes: string; source: CashSource },
): Promise<WriteOutcome<{ debtId: string }>> {
  const patch: Record<string, unknown> = {};
  if (form.counterparty.trim() !== (base.counterparty ?? '')) patch.counterparty = form.counterparty;
  const amount = amountFromField(form.amount);
  if (!Number.isFinite(amount) || toFils(amount) !== toFils(base.amount)) patch.amount = amount;
  const due = form.dueDate || null;
  if (due !== (base.dueDate || null)) patch.dueDate = due;
  const notes = form.notes.trim() || null;
  if (notes !== (base.notes || null)) patch.notes = notes;
  if (form.source !== base.source) patch.source = form.source;
  if (Object.keys(patch).length === 0) return { kind: 'ok', value: { debtId: base.id }, replayed: false };

  let input: DebtUpdateInput;
  try { input = debtUpdateInput({ debtId: base.id, expectedRevision: base.revision, ...patch }); } catch (e) { return absage(e); }
  const r = await w.save<{ debtId: string }>(OP_DEBTS_UPDATE, {
    local: async () => { await updateDebtOnPrimary(input); return { debtId: base.id }; },
    // `null` reist mit: es heißt „löschen" (Fälligkeit, Notiz).
    remote: () => rumpf(input),
    shape: () => ({ debtId: base.id }),
  });
  if (r.kind === 'ok' && w.remote) debtsNeu(base.id);
  return r;
}
