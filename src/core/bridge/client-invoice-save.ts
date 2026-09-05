// CENTRAL-C3B/C3C — der Speichervertrag des Rechnungsformulars.
//
// Der Vertrag selbst ist nicht rechnungsspezifisch: eine Kennung pro VORSATZ, eine Zeitgrenze
// beendet keinen Versuch, ein fachliches Nein schon. Er liegt deshalb seit C3C in
// `client-command-save.ts` und gilt dort für JEDEN schreibenden Fernauftrag — Rechnung, Kunde,
// Produkt. Hier bleibt nur die Bindung an die eine Operation, damit das Formular nicht bei jedem
// Aufruf einen Namen mitschleppt, den es sowieso nie ändert.

import { CommandSaveAttempt, CommandSaveController, type SaveOutcome as GenericOutcome } from './client-command-save';
import { RemoteReadError } from './remote-read';

export const OP_INVOICES_CREATE = 'invoices.create';

/** Was der Primary bei einer Rechnung zurückgibt. */
export interface InvoiceSaveValue {
  invoiceId: string;
  invoiceNumber: string;
  grossAmount: number;
  replayed?: boolean;
}

/** Dieselben vier Ausgänge wie überall — nur mit den Feldern einer Rechnung im Erfolgsfall. */
export type SaveOutcome =
  | { kind: 'ok'; invoiceId: string; invoiceNumber: string; grossAmount: number; replayed: boolean }
  | { kind: 'business_error'; code: string; message: string }
  | { kind: 'not_executed'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string };

function shape(out: GenericOutcome<InvoiceSaveValue>): SaveOutcome {
  if (out.kind !== 'ok') return out;
  return {
    kind: 'ok',
    invoiceId: String(out.value.invoiceId ?? ''),
    invoiceNumber: String(out.value.invoiceNumber ?? ''),
    grossAmount: Number(out.value.grossAmount ?? 0),
    replayed: out.replayed,
  };
}

/** Der Speicherversuch einer Rechnung. Eine Kennung pro Vorsatz — siehe `client-command-save`. */
export class InvoiceSaveAttempt {
  private readonly inner: CommandSaveAttempt<InvoiceSaveValue>;

  /**
   * Nimmt entweder einen bestehenden Versuch (der Wächter reicht seinen eigenen herein — sonst
   * wüsste er nie, dass er beantwortet ist) oder legt einen neuen an.
   */
  constructor(from?: CommandSaveAttempt<InvoiceSaveValue> | string) {
    this.inner = from instanceof CommandSaveAttempt
      ? from
      : new CommandSaveAttempt<InvoiceSaveValue>(OP_INVOICES_CREATE, from);
  }

  get commandId(): string {
    return this.inner.commandId;
  }

  isSettled(): boolean {
    return this.inner.isSettled();
  }

  async send(payload: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<SaveOutcome> {
    return shape(await this.inner.send(payload, fetchFn));
  }
}

/** Der Wächter über die Kennungen des Rechnungsformulars. */
export class InvoiceSaveController {
  private readonly inner = new CommandSaveController<InvoiceSaveValue>(OP_INVOICES_CREATE);
  private wrapped: InvoiceSaveAttempt | null = null;

  beginAttempt(): InvoiceSaveAttempt {
    // WICHTIG: derselbe Versuch, nicht nur dieselbe Kennung. Eine Kopie wüsste nicht, dass der
    // Original-Versuch beantwortet ist — und der Wächter gäbe nie wieder eine neue Kennung heraus.
    const attempt = this.inner.beginAttempt();
    if (!this.wrapped || this.wrapped.commandId !== attempt.commandId) {
      this.wrapped = new InvoiceSaveAttempt(attempt);
    }
    return this.wrapped;
  }

  pendingAttempt(): InvoiceSaveAttempt | null {
    return this.wrapped && !this.wrapped.isSettled() ? this.wrapped : null;
  }

  forget(): void {
    this.inner.forget();
    this.wrapped = null;
  }
}

export { RemoteReadError };
