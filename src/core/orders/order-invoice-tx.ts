// B5-B — Order→Invoice Atomicity: reine, injizierbare Transaktions-Orchestrierung.
//
// Schliesst die Nicht-Atomaritaetsluecke: bisher liefen `createDirectInvoice` →
// `markOrderLinesInvoiced` → `updateOrder(invoiceId)` als DREI separate, selbst-speichernde
// Schritte. Schlug ein Schritt NACH der Invoice-Erstellung fehl (z.B. Line-Markierung bei einer
// lot-losen Position), blieb die Invoice bestehen, die Line billable → eine Wiederholung konnte
// eine ZWEITE Invoice erzeugen (der Lot-Guard schuetzt lot-lose Stuecke nicht).
//
// Loesung: alle Schritte in EINER Ledger-Transaktion. Jeder Fehler → vollstaendiger Rollback →
// KEINE Invoice, KEINE Ledger-Postings, KEINE Line-Markierung, KEINE Order-Aenderung. Eine
// Wiederholung startet damit sauber (es existiert keine halbe Invoice).
//
// Die Logik ist von den konkreten DB-/Store-Funktionen ENTKOPPELT (Dependency-Injection), damit
// GENAU dieser produktive Code getestet werden kann — mit echten Tx-Ops (node:sqlite BEGIN/
// COMMIT/ROLLBACK) und Fehler-Injektion an jeder Stelle. Der produktive Wrapper (orderStore)
// injiziert beginLedgerTransaction / createDirectInvoice / … — es wird KEINE Invoice-Logik
// dupliziert (createInvoice ruft das echte createDirectInvoice).

export interface OrderInvoiceTxOps {
  /** beginLedgerTransaction — oeffnet (ggf. verschachtelt) die Tx. */
  begin(): void;
  /** commitLedgerTransaction — nur das aeusserste COMMIT persistiert. */
  commit(): void;
  /** rollbackLedgerTransaction — verwirft ALLES seit begin(). */
  rollback(): void;
  /** frische Billable-Pruefung IN der Tx: wirft, wenn eine Ziel-Line bereits invoiced ist. */
  assertBillable(): void;
  /** createDirectInvoice (nested; oeffnet keine eigene Tx). Liefert die neue Invoice. */
  createInvoice(): { id: string };
  /** order_lines.invoice_id + orders.invoice_id setzen (tx-safe db.run, KEIN eigenes save/refresh). */
  linkLinesAndOrder(invoiceId: string): void;
  /** Store-State-Refresh (loadOrders/loadInvoices/loadProducts) — NUR nach commit/rollback. */
  refresh(): void;
}

// Fuehrt die Order→Invoice-Konvertierung ATOMAR aus. Reihenfolge in der Tx:
//   assertBillable → createInvoice → linkLinesAndOrder → commit.
// Bei JEDEM Fehler: rollback + refresh, dann rethrow (keine zweite Invoice bei Wiederholung).
export function convertOrderLinesToInvoiceTx(ops: OrderInvoiceTxOps): { id: string } {
  ops.begin();
  let invoice: { id: string };
  try {
    ops.assertBillable();               // Fehler VOR Invoice → nichts geschrieben
    invoice = ops.createInvoice();      // Fehler WAEHREND Invoice → Rollback verwirft Teilzustand
    ops.linkLinesAndOrder(invoice.id);  // Fehler NACH Invoice → Rollback verwirft AUCH die Invoice
    ops.commit();
  } catch (e) {
    ops.rollback();
    ops.refresh();                      // Cache nach Rollback korrigieren (uncommitted mid-tx reads)
    throw e;
  }
  ops.refresh();                        // Cache nach erfolgreichem COMMIT aktualisieren
  return invoice;
}
