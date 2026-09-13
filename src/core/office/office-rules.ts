// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — Aufgaben und Dokumente am Haus: was beide Hausfolgen teilen.
//
// Beide Flächen (`TaskList`, `DocumentList`) schrieben bisher direkt in die Datenbank: ohne Filiale
// im WHERE, ohne Fassung, mit einem stillen 'branch-main', wenn keine Sitzung da war, mit einer
// frei getippten Kennung als „Verknüpfung" — und die Texterkennung ganz ohne Abgleich-Eintrag.
// Hier liegen die Bausteine, die `task-house.ts` und `document-house.ts` gemeinsam benutzen:
//
//   • die Absage mit festem Code (dieselbe am Primary und für PC2),
//   • die Filiale und der Mensch — fern aus dem geprüften Ausweis, am Primary aus der Sitzung,
//   • die Verknüpfung: nur die Arten, die die Masken anbieten, und nur Datensätze DIESER Filiale,
//   • das Nachführen (Abgleich + Protokoll) mit hartem Fehler: ein Schreiben ohne Abgleich-Eintrag
//     ist eine Lücke, die erst auf dem anderen Rechner auffällt — also gar nicht erst.
//
// Nichts hier öffnet eine Transaktion außer den zwei ausdrücklichen Klammern für die alten
// Store-Aufrufe (`officeAction`/`officeActionSync`) — und die fügen sich in eine laufende ein.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction, inLedgerTransaction,
} from '@/core/ledger/posting';
import { trackChange, isSyncConfigured } from '@/core/sync/sync-service';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import type { LinkedEntityType } from '@/core/models/types';

/** Ein fachliches Nein der beiden Hausfolgen — mit festem Code, am Primary wie für PC2. */
export class OfficeRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OfficeRejected';
    this.code = code;
  }
}

export const OFFICE_NO_SESSION = 'OFFICE_NO_SESSION';
export const RECORD_CHANGED = 'RECORD_CHANGED';
export const LINK_INVALID = 'LINK_INVALID';
export const LINKED_ENTITY_NOT_FOUND = 'LINKED_ENTITY_NOT_FOUND';

/** Die Filiale und der Mensch: fern aus dem geprüften Ausweis, am Primary aus der Sitzung. */
export interface OfficeCtx {
  branchId: string;
  userId: string;
}

/** Die Sitzung des Primary. Kein stilles 'branch-main' mehr: ohne Filiale wird nichts geschrieben. */
export function localOfficeCtx(): OfficeCtx {
  let branchId = '';
  let userId = '';
  try { branchId = currentBranchId(); } catch { branchId = ''; }
  try { userId = currentUserId(); } catch { userId = ''; }
  if (!branchId) throw new OfficeRejected(OFFICE_NO_SESSION, 'no branch in this session — sign in again');
  return { branchId, userId };
}

/**
 * Für die alten Store-Aufrufe: dieselbe Hausfolge in einer eigenen Klammer. Läuft schon eine,
 * fügt sie sich ein — die äußerste Klammer entscheidet über COMMIT (`rollbackLedgerTransaction`
 * setzte sonst die GANZE Tiefe zurück, samt Nachweis eines Fernauftrags).
 */
export function officeActionSync<T>(guard: () => void, fn: (ctx: OfficeCtx) => T): T {
  guard();
  const ctx = localOfficeCtx();
  if (inLedgerTransaction()) return fn(ctx);
  beginLedgerTransaction();
  try {
    const out = fn(ctx);
    commitLedgerTransaction();
    return out;
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
}

/** Dieselbe Klammer für eine Hausfolge mit Wartepunkt (Texterkennung). Nur INNERHALB der Spur aufrufen. */
export async function officeAction<T>(guard: () => void, fn: (ctx: OfficeCtx) => T | Promise<T>): Promise<T> {
  guard();
  const ctx = localOfficeCtx();
  if (inLedgerTransaction()) return await fn(ctx);
  beginLedgerTransaction();
  try {
    const out = await fn(ctx);
    commitLedgerTransaction();
    return out;
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
}

// ── Die Verknüpfung ─────────────────────────────────────────────────────────

/**
 * Die Tabelle hinter jeder Verknüpfungsart — genau die acht, die beide Masken anbieten
 * (`ENTITY_TYPES` in `TaskList` und `DocumentList`, dasselbe `LinkedEntityType`). Jede dieser
 * Tabellen trägt eine Filiale.
 */
export const LINKED_ENTITY_TABLES: Readonly<Record<LinkedEntityType, string>> = {
  customer: 'customers',
  product: 'products',
  offer: 'offers',
  invoice: 'invoices',
  repair: 'repairs',
  consignment: 'consignments',
  agent_transfer: 'agent_transfers',
  order: 'orders',
};

export function isLinkedEntityType(v: unknown): v is LinkedEntityType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LINKED_ENTITY_TABLES, v);
}

/**
 * Eine Verknüpfung, wie die Masken sie senden: die Art aus der Auswahl, die Kennung frei getippt.
 * Bisher wurde beides ungeprüft gespeichert — ein Tippfehler war ein Verweis ins Nichts, eine
 * fremde Kennung ein Verweis in eine andere Filiale. Jetzt: die Art aus der Liste, und eine
 * genannte Kennung muss in DIESER Filiale existieren. Eine Art ohne Kennung bleibt erlaubt (so
 * lässt die Maske es heute zu) — sie verweist auf nichts und wird nicht geprüft.
 */
export function assertLinkedEntity(type: string | null, id: string | null, branchId: string): void {
  if (type !== null && !isLinkedEntityType(type)) {
    throw new OfficeRejected(LINK_INVALID, `unknown link type ${type}`);
  }
  if (id !== null && type === null) {
    throw new OfficeRejected(LINK_INVALID, 'a linked record needs its type');
  }
  if (type !== null && id !== null) {
    const table = LINKED_ENTITY_TABLES[type as LinkedEntityType];
    if (!query(`SELECT id FROM ${table} WHERE id = ? AND branch_id = ?`, [id, branchId])[0]) {
      throw new OfficeRejected(LINKED_ENTITY_NOT_FOUND, `no such ${type.replace(/_/g, ' ')} in this branch`);
    }
  }
}

// ── Eingaben ────────────────────────────────────────────────────────────────

/**
 * Ein optionaler Text: `undefined` = nicht genannt, `null` oder leer = leer. Ein anderer Typ ist
 * ein Nein mit dem Code des Aufrufers.
 */
export function optionalText(v: unknown, field: string, code: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new OfficeRejected(code, `${field} must be text`);
  const t = v.trim();
  return t === '' ? null : t;
}

// ── Nachführen: Abgleich und Protokoll ──────────────────────────────────────

function changelogRows(table: string, id: string): number {
  return Number(query('SELECT COUNT(*) AS n FROM sync_changelog WHERE table_name = ? AND record_id = ?', [table, id])[0]?.n ?? 0);
}

/**
 * Abgleich-Eintrag und Protokoll einer Schreibhandlung — beides mit hartem Fehler.
 *
 * `trackInsert`/`trackUpdate` schlucken ihre Fehler: ein gescheiterter Abgleich-Eintrag ließ die
 * Zeile hier stehen und auf dem anderen Rechner fehlen (genau die Lücke, die `extractOcr` sogar
 * ganz ohne Eintrag hatte). Hier wird nachgesehen: ist der Abgleich eingerichtet, MUSS der Eintrag
 * danach da sein — sonst geht die ganze Handlung zurück. Das Protokoll schreibt über die
 * werfende Variante (`logAuditOrThrow`), mit denselben Zeilen wie bisher (eine je Feld beim Ändern).
 */
export function trackOfficeWrite(
  table: 'tasks' | 'documents', id: string, action: 'insert' | 'update', data: Record<string, unknown>,
): void {
  const module = table === 'tasks' ? 'Tasks' : 'Documents';
  const vorher = changelogRows(table, id);
  trackChange(table, id, action, data);
  if (isSyncConfigured() && changelogRows(table, id) <= vorher) {
    throw new Error(`${table} ${action}: the sync change log was not written — the whole action is undone`);
  }
  if (action === 'insert') {
    logAuditOrThrow({ module, entityType: table, entityId: id, action: 'CREATE', newValue: data });
    return;
  }
  for (const [field, value] of Object.entries(data)) {
    logAuditOrThrow({ module, entityType: table, entityId: id, action: 'UPDATE', field, newValue: value });
  }
}

/** Die gesehene Fassung, verglichen INNERHALB der Transaktion: zwei Rechner gewinnen nicht beide. */
export function assertRevision(what: string, row: Record<string, unknown>, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = Number(row.revision ?? 0);
  if (now !== expected) {
    throw new OfficeRejected(RECORD_CHANGED, `this ${what} changed since you opened it (you saw ${expected}, it is now ${now}) — reopen it`);
  }
}

/**
 * Ein Rechner ohne Geschäftsdatenbank schreibt hier nie — auch nicht über einen vergessenen direkten
 * Store-Aufruf. Der Riegel steht vor dem ersten Zugriff auf eine Datenbank (dieselbe Regel wie R6B/R6D).
 */
export function assertOfficeHere(code: string, what: string): void {
  if (isClientMode()) {
    throw new OfficeRejected(code, `${what} are kept on the main computer — this window has no business database`);
  }
}
