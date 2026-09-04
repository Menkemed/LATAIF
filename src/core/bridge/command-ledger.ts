// CENTRAL-C3A — der durable Nachweis, dass ein Fernauftrag schon gelaufen ist.
//
// Der Audit hatte die Lücke genau benannt: `operation_ledger` liegt in der **Server**-Datenbank
// (rusqlite), die Geschäftswirkung in **sql.js**. Zwei Datenbanken, zwei Besitzer — sie können
// keine gemeinsame Transaktion haben. Ein Nachweis, der nicht mit der Buchung zusammen committet,
// ist aber wertlos: nach einem Absturz dazwischen wüsste niemand, was gilt.
//
// Also liegt der Nachweis hier, in `lataif.db`, in DERSELBEN Transaktion wie Buchung und
// Belegnummer. Er ist damit die einzige Quelle für „ist dieser Auftrag schon passiert?".
//
// ## Warum ein eingefrorenes Ergebnis, nicht nur ein Häkchen
//
// Nach einem verlorenen Antwortweg fragt der Client noch einmal. Ein Häkchen sagt ihm „ja, lief" —
// aber nicht, welche Rechnungsnummer dabei herauskam. Deshalb wird die Antwort selbst eingefroren
// und beim zweiten Mal wortgleich zurückgegeben, ohne den Geschäftscode noch einmal auszuführen.
//
// ## Drei Ausgänge, drei Bedeutungen
//
//   • `completed`  — der Auftrag lief, die Wirkung steht, die Antwort ist eingefroren.
//   • `rejected`   — er wurde fachlich abgelehnt, OHNE Wirkung, und zwar endgültig: dieselbe
//                    Eingabe führt immer zu derselben Ablehnung (eine Pflichtangabe fehlt, ein
//                    Datensatz gehört nicht zu dieser Filiale). Auch das wird eingefroren.
//   • gar nichts   — eine Störung (Datenbank, Speicherfehler). Sie darf NIE als erledigter
//                    Geschäftsvorgang festgehalten werden, sonst gilt ein Auftrag als gelaufen,
//                    der nie lief. Solche Fehler hinterlassen keine Zeile; der Client darf
//                    dieselbe Kennung erneut senden.
//
// Ein fachliches Nein, das vom ZUSTAND abhängt statt von der Eingabe — „der Bestand war schon
// weg" — ist ausdrücklich KEIN eingefrorenes Ergebnis. Wer morgen dieselbe Rechnung noch einmal
// versucht, weil inzwischen wieder Ware da ist, muss eine neue Antwort bekommen. Deshalb
// entscheidet der Aufrufer, welche seiner Ablehnungen endgültig sind (`terminal`).

import type { SqlDb } from '../sync/apply-change';

/** Die eine Tabelle. Additiv, wie jede Migration im Haus. */
export const COMMAND_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS remote_command_ledger (
    command_id    TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    branch_id     TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    op            TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('completed', 'rejected')),
    result_json   TEXT,
    error_code    TEXT,
    error_message TEXT,
    protocol      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
  )`;

export const COMMAND_LEDGER_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_remote_command_ledger_op ON remote_command_ledger (op, created_at)';

/** Die Fassung des Vertrags. Ändert sich die Bedeutung eines Eintrags, steigt sie. */
export const COMMAND_PROTOCOL = 1;

/** Wer den Auftrag stellt und was er ist — dieselben fünf Teile wie in der Brücke. */
export interface CommandIdentity {
  readonly commandId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly op: string;
  readonly payloadHash: string;
}

export type CommandRecord =
  | { readonly status: 'completed'; readonly identity: CommandIdentity; readonly result: unknown }
  | { readonly status: 'rejected'; readonly identity: CommandIdentity; readonly code: string; readonly message: string };

/** Was ein Nachschlagen ergeben kann. */
export type LedgerLookup =
  /** Diese Kennung ist neu — der Auftrag darf laufen. */
  | { readonly kind: 'fresh' }
  /** Schon gelaufen: dieselbe Absicht, eingefrorenes Ergebnis. */
  | { readonly kind: 'replay'; readonly record: CommandRecord }
  /** Dieselbe Kennung, aber etwas anderes dahinter. Fail-closed. */
  | { readonly kind: 'conflict'; readonly reason: string };

function rowsOf(db: SqlDb, sql: string, params: unknown[]): Record<string, unknown>[] {
  const res = db.exec(sql, params as never[]);
  if (res.length === 0) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

/**
 * Schlägt eine Kennung nach. Muss INNERHALB der Command-Transaktion laufen: sonst könnte zwischen
 * Nachschlagen und Buchen ein zweiter Auftrag dieselbe Kennung belegen.
 */
export function lookupCommand(db: SqlDb, identity: CommandIdentity): LedgerLookup {
  const found = rowsOf(
    db,
    `SELECT command_id, tenant_id, branch_id, user_id, op, payload_hash, status, result_json,
            error_code, error_message
       FROM remote_command_ledger WHERE command_id = ?`,
    [identity.commandId],
  );
  if (found.length === 0) return { kind: 'fresh' };

  const r = found[0];
  const stored: CommandIdentity = {
    commandId: String(r.command_id),
    tenantId: String(r.tenant_id),
    branchId: String(r.branch_id),
    userId: String(r.user_id),
    op: String(r.op),
    payloadHash: String(r.payload_hash),
  };
  // Jeder Teil muss stimmen. Eine Kennung benennt EINE Absicht — nicht „irgendetwas von diesem
  // Benutzer". Sonst könnte eine geratene Kennung an einem fremden Vorgang mitschreiben.
  for (const key of ['tenantId', 'branchId', 'userId', 'op', 'payloadHash'] as const) {
    if (stored[key] !== identity[key]) {
      return { kind: 'conflict', reason: `${key} differs from the recorded command` };
    }
  }

  if (String(r.status) === 'completed') {
    let result: unknown = null;
    try { result = JSON.parse(String(r.result_json ?? 'null')); } catch { result = null; }
    return { kind: 'replay', record: { status: 'completed', identity: stored, result } };
  }
  return {
    kind: 'replay',
    record: {
      status: 'rejected',
      identity: stored,
      code: String(r.error_code ?? 'REJECTED'),
      message: String(r.error_message ?? ''),
    },
  };
}

/**
 * Hält das Ergebnis fest. Muss in DERSELBEN Transaktion laufen wie die Wirkung, die es beschreibt —
 * das ist der ganze Punkt dieser Datei.
 */
export function recordCommand(db: SqlDb, record: CommandRecord, now: string): void {
  const i = record.identity;
  db.run(
    `INSERT INTO remote_command_ledger
       (command_id, tenant_id, branch_id, user_id, op, payload_hash, status,
        result_json, error_code, error_message, protocol, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      i.commandId, i.tenantId, i.branchId, i.userId, i.op, i.payloadHash,
      record.status,
      record.status === 'completed' ? JSON.stringify(record.result ?? null) : null,
      record.status === 'rejected' ? record.code : null,
      record.status === 'rejected' ? record.message : null,
      COMMAND_PROTOCOL,
      now,
    ],
  );
}

/** Nur zur Prüfung: wie viele Aufträge festgehalten sind. */
export function commandCount(db: SqlDb): number {
  const r = db.exec('SELECT COUNT(*) FROM remote_command_ledger');
  return r.length > 0 ? Number(r[0].values[0][0]) : 0;
}
