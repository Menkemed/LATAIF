// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — eine Handlung an der Maske des Primary: exklusiv, in EINER Transaktion,
// erst danach durabel.
//
// Dieselbe Klammer, die ein Fernauftrag von der Maschine bekommt (`runRemoteCommand`): ein Fehler
// irgendwo in der Handlung — nach dem Beleg, nach den Zeilen, nach einer Nebenbuchung — nimmt ALLES
// zurück. Ohne sie schrieb jede Hausfunktion für sich und rief `saveDatabase()`; eine Handlung aus
// mehreren Schritten ließ beim Scheitern die früheren stehen.
// ════════════════════════════════════════════════════════════════════════════
import { saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { runExclusive } from '@/core/bridge/command-scheduler';

/**
 * `work` läuft exklusiv in einer Ledger-Transaktion; `reload` liest danach die Listen der Stores neu
 * (auch nach einem Rollback — sonst zeigte die Maske, was es nicht mehr gibt).
 */
export function runOnPrimary<T>(work: () => T | Promise<T>, reload: () => void): Promise<T> {
  return runExclusive(async () => {
    beginLedgerTransaction();
    let out: T;
    try {
      out = await work();
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      reload();
      throw e;
    }
    await saveDatabaseDurably();
    reload();
    return out;
  });
}
