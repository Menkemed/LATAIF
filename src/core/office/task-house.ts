// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — die Aufgabe am Haus: anlegen und ändern. EINE Hausfolge für die Maske am
// Primary (`createTaskOnPrimary`/`updateTaskOnPrimary` in `taskStore.ts`) und für die Fernbefehle
// von PC2 (`bridge/office-commands.ts`).
//
// Was vorher geschah (auditiert, nicht angenommen):
//
//   • `createTask` fiel ohne Sitzung still auf 'branch-main' zurück.
//   • `updateTask` und `completeTask` schrieben `WHERE id = ?` — ohne Filiale, ohne Fassung, ohne
//     jede Prüfung: jeder Text wurde als Status, Typ oder Priorität gespeichert, und eine erledigte
//     oder abgebrochene Aufgabe ließ sich noch einmal „erledigen" (mit neuem Zeitstempel).
//   • Die Verknüpfung war eine frei getippte Kennung — ungeprüft, auch eine aus einer fremden Filiale.
//   • Die Maske schloss sich VOR dem Ergebnis; ein Fehler ging verloren.
//
// Zwei Handlungen, nicht drei: „Erledigen" ist eine Änderung des Status — derselbe Befehl, dieselbe
// Fassung, dieselben Prüfungen. Den Zeitpunkt des Erledigens setzt der Primary, nie der Rumpf.
//
// Alles läuft INNERHALB der Transaktion des Aufrufers (`runOnPrimary` am Primary, `runRemoteCommand`
// für PC2); diese Datei öffnet und schließt keine und speichert nicht durabel.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import type { LinkedEntityType, TaskPriority, TaskStatus, TaskType } from '@/core/models/types';
import {
  OfficeRejected, assertLinkedEntity, assertOfficeHere, assertRevision, isLinkedEntityType, optionalText,
  trackOfficeWrite, LINK_INVALID, type OfficeCtx,
} from './office-rules';

export const TASK_PRIMARY_ONLY = 'TASK_PRIMARY_ONLY';
export const TASK_NOT_FOUND = 'TASK_NOT_FOUND';
export const TASK_FIELD_INVALID = 'TASK_FIELD_INVALID';
export const TASK_TITLE_REQUIRED = 'TASK_TITLE_REQUIRED';
export const TASK_TYPE_INVALID = 'TASK_TYPE_INVALID';
export const TASK_PRIORITY_INVALID = 'TASK_PRIORITY_INVALID';
export const TASK_STATUS_INVALID = 'TASK_STATUS_INVALID';
export const TASK_DUE_INVALID = 'TASK_DUE_INVALID';
export const TASK_INVALID_TRANSITION = 'TASK_INVALID_TRANSITION';
export const TASK_ASSIGNEE_NOT_FOUND = 'TASK_ASSIGNEE_NOT_FOUND';

/** Das Vokabular der Maske (`TASK_TYPES`, `PRIORITIES`, `STATUS_OPTIONS` in `TaskList`) — nichts darüber hinaus. */
export const TASK_TYPES: readonly TaskType[] = [
  'general', 'follow_up', 'review', 'price_check', 'reactivation', 'payment_reminder',
  'repair_ready', 'consignment_expiry', 'agent_return', 'order_delivery',
];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'completed', 'cancelled'];

/** „Complete" steht nur an einer Aufgabe, die weder erledigt noch abgebrochen ist (`TaskRow`: `!isCompleted`). */
const COMPLETABLE_FROM: readonly string[] = ['open', 'in_progress'];

// ── Die Eingaben ────────────────────────────────────────────────────────────

export interface TaskCreateInput {
  title: string;
  description?: string | null;
  type?: TaskType;
  priority?: TaskPriority;
  dueAt?: string | null;
  linkedEntityType?: LinkedEntityType | null;
  linkedEntityId?: string | null;
  assignedTo?: string | null;
}

export interface TaskUpdateInput {
  taskId: string;
  /** Die gesehene Fassung. Der Fernbefehl verlangt sie; die alten Store-Aufrufe kennen keine. */
  expectedRevision?: number;
  title?: string;
  description?: string | null;
  type?: TaskType;
  priority?: TaskPriority;
  dueAt?: string | null;
  linkedEntityType?: LinkedEntityType | null;
  linkedEntityId?: string | null;
  assignedTo?: string | null;
  status?: TaskStatus;
}

interface TaskCreateChecked {
  title: string; description: string | null; type: TaskType; priority: TaskPriority; dueAt: string | null;
  linkedEntityType: LinkedEntityType | null; linkedEntityId: string | null; assignedTo: string | null;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], code: string, what: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) {
    throw new OfficeRejected(code, `${what} must be one of ${list.join(', ')}`);
  }
  return v as T;
}

function titleOf(v: unknown): string {
  // Die Maske sperrt „Create Task" ohne Titel (`!form.title.trim()`) — dieselbe Regel hier.
  if (typeof v !== 'string' || !v.trim()) throw new OfficeRejected(TASK_TITLE_REQUIRED, 'a task needs a title');
  return v.trim();
}

const DUE = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Das Fälligkeitsdatum. Die Maske schickt den Tag aus dem Datumsfeld (`YYYY-MM-DD`), die
 * Automatik einen vollständigen ISO-Zeitpunkt. Gespeichert wird wie bisher `toISOString()` — ein
 * Tag wird damit Mitternacht UTC, genau das, was die Maske vorher selbst rechnete. Ein Zeitpunkt
 * ohne Zone wäre mehrdeutig, ein 30. Februar kein Datum: beides nein.
 */
function dueOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const m = typeof v === 'string' ? DUE.exec(v.trim()) : null;
  if (!m) throw new OfficeRejected(TASK_DUE_INVALID, 'the due date must be a date (YYYY-MM-DD) or an ISO timestamp');
  const d = new Date(v as string);
  if (!Number.isFinite(d.getTime())) throw new OfficeRejected(TASK_DUE_INVALID, 'the due date is not a real date');
  if (!m[2] && d.toISOString().slice(0, 10) !== m[1]) throw new OfficeRejected(TASK_DUE_INVALID, 'the due date is not a real date');
  return d.toISOString();
}

function linkTypeOf(v: unknown): LinkedEntityType | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!isLinkedEntityType(v)) throw new OfficeRejected(LINK_INVALID, `unknown link type ${String(v)}`);
  return v;
}

function recordOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OfficeRejected(TASK_FIELD_INVALID, 'a task must be an object');
  return raw as Record<string, unknown>;
}

/** „Create Task": Titel Pflicht, Typ/Priorität aus dem Vokabular (sonst die Vorgaben des Stores). */
export function taskCreateInput(rawIn: unknown): TaskCreateChecked {
  const raw = recordOf(rawIn);
  return {
    title: titleOf(raw.title),
    description: optionalText(raw.description, 'description', TASK_FIELD_INVALID) ?? null,
    type: raw.type === undefined || raw.type === null ? 'general' : oneOf(raw.type, TASK_TYPES, TASK_TYPE_INVALID, 'type'),
    priority: raw.priority === undefined || raw.priority === null ? 'medium' : oneOf(raw.priority, TASK_PRIORITIES, TASK_PRIORITY_INVALID, 'priority'),
    dueAt: dueOf(raw.dueAt) ?? null,
    linkedEntityType: linkTypeOf(raw.linkedEntityType) ?? null,
    linkedEntityId: optionalText(raw.linkedEntityId, 'linkedEntityId', LINK_INVALID) ?? null,
    assignedTo: optionalText(raw.assignedTo, 'assignedTo', TASK_FIELD_INVALID) ?? null,
  };
}

/** „Save Changes" und „Complete": genannt = ändern, `null` = leeren, nicht genannt = bleibt. */
export function taskUpdateInput(rawIn: unknown): TaskUpdateInput {
  const raw = recordOf(rawIn);
  if (typeof raw.taskId !== 'string' || !raw.taskId) throw new OfficeRejected(TASK_FIELD_INVALID, 'taskId is required');
  const rev = raw.expectedRevision;
  if (rev !== undefined && (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1)) {
    throw new OfficeRejected(TASK_FIELD_INVALID, 'expectedRevision must be a positive whole number');
  }
  const out: TaskUpdateInput = { taskId: raw.taskId };
  if (rev !== undefined) out.expectedRevision = rev as number;
  if (raw.title !== undefined) out.title = titleOf(raw.title);
  if (raw.description !== undefined) out.description = optionalText(raw.description, 'description', TASK_FIELD_INVALID) ?? null;
  if (raw.type !== undefined) out.type = oneOf(raw.type, TASK_TYPES, TASK_TYPE_INVALID, 'type');
  if (raw.priority !== undefined) out.priority = oneOf(raw.priority, TASK_PRIORITIES, TASK_PRIORITY_INVALID, 'priority');
  if (raw.dueAt !== undefined) out.dueAt = dueOf(raw.dueAt) ?? null;
  if (raw.linkedEntityType !== undefined) out.linkedEntityType = linkTypeOf(raw.linkedEntityType) ?? null;
  if (raw.linkedEntityId !== undefined) out.linkedEntityId = optionalText(raw.linkedEntityId, 'linkedEntityId', LINK_INVALID) ?? null;
  if (raw.assignedTo !== undefined) out.assignedTo = optionalText(raw.assignedTo, 'assignedTo', TASK_FIELD_INVALID) ?? null;
  if (raw.status !== undefined) out.status = oneOf(raw.status, TASK_STATUSES, TASK_STATUS_INVALID, 'status');
  return out;
}

// ── Was das Haus weiß ───────────────────────────────────────────────────────

export function assertTasksHere(): void {
  assertOfficeHere(TASK_PRIMARY_ONLY, 'tasks');
}

/** Die Aufgabe, wie sie in der DATENBANK steht — in DIESER Filiale, sonst gibt es sie nicht. */
function liveTask(taskId: string, branchId: string): Record<string, unknown> {
  const t = query('SELECT * FROM tasks WHERE id = ? AND branch_id = ?', [taskId, branchId])[0];
  if (!t) throw new OfficeRejected(TASK_NOT_FOUND, 'no such task in this branch');
  return t;
}

/**
 * Wem eine Aufgabe zugewiesen werden kann: ein aktiver Benutzer DIESER Filiale — dieselbe Menge
 * wie die Benutzerliste der Einstellungen (`users` ⋈ `user_branches`), ohne die deaktivierten, die
 * sich nicht mehr anmelden können. Die Maske bietet heute keine Zuweisung an; der Rumpf darf sie
 * nennen, aber nur so.
 */
function assertAssignee(userId: string, branchId: string): void {
  const u = query(
    `SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id = u.id
      WHERE u.id = ? AND ub.branch_id = ? AND COALESCE(u.active, 1) = 1`,
    [userId, branchId],
  )[0];
  if (!u) throw new OfficeRejected(TASK_ASSIGNEE_NOT_FOUND, 'no such active user in this branch');
}

function revisionOf(taskId: string): number {
  return Number(query('SELECT revision FROM tasks WHERE id = ?', [taskId])[0]?.revision ?? 0);
}

const orNull = (v: unknown): unknown => (v === undefined || v === '' ? null : v);

// ── tasks.create ────────────────────────────────────────────────────────────

export interface TaskCreated { taskId: string; revision: number }

/**
 * „Create Task": in der Filiale des Handelnden, Status „open", angelegt von ihm (fern: der geprüfte
 * Absender, nie der Rumpf), Zeitpunkt des Primary. Verknüpfung und Zuweisung zeigen in DIESE Filiale.
 */
export function createTaskInHouse(raw: TaskCreateInput, ctx: OfficeCtx): TaskCreated {
  assertTasksHere();
  const v = taskCreateInput(raw);
  assertLinkedEntity(v.linkedEntityType, v.linkedEntityId, ctx.branchId);
  if (v.assignedTo) assertAssignee(v.assignedTo, ctx.branchId);

  const id = uuid();
  const now = new Date().toISOString();
  getDatabase().run(
    `INSERT INTO tasks (id, branch_id, title, description, type, priority, due_at, linked_entity_type, linked_entity_id, assigned_to, status, auto_generated, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
    [id, ctx.branchId, v.title, v.description, v.type, v.priority, v.dueAt,
      v.linkedEntityType, v.linkedEntityId, v.assignedTo, now, ctx.userId || null],
  );
  trackOfficeWrite('tasks', id, 'insert', { title: v.title, type: v.type });
  // Dasselbe Ereignis wie bisher (heute ohne Abonnenten) — NACH dem Schreiben, ohne Wirkung auf die Zeile.
  void eventBus.emit('task.created', 'task', id, { title: v.title, type: v.type });
  return { taskId: id, revision: revisionOf(id) };
}

// ── tasks.update ────────────────────────────────────────────────────────────

export interface TaskUpdated { taskId: string; revision: number; status: TaskStatus; changed: boolean }

/**
 * „Save Changes" und „Complete". Geschrieben wird nur, was sich wirklich ändert; eine geänderte
 * Verknüpfung oder Zuweisung wird geprüft (eine alte, unveränderte nicht — sonst ließe sich eine
 * Aufgabe zu einem inzwischen gelöschten Angebot nie mehr umbenennen). Beim Wechsel nach
 * „completed" setzt der Primary `completed_at`; wer eine Aufgabe wieder öffnet, leert es.
 */
export function updateTaskInHouse(raw: TaskUpdateInput, ctx: OfficeCtx): TaskUpdated {
  assertTasksHere();
  const v = taskUpdateInput(raw);
  const t = liveTask(v.taskId, ctx.branchId);
  assertRevision('task', t, v.expectedRevision);
  const from = String(t.status || 'open') as TaskStatus;

  const sets: Array<[string, string, unknown]> = [];
  const was = (col: string): unknown => orNull(t[col]);
  const want = (col: string, key: string, next: unknown): void => {
    if (next !== undefined && orNull(next) !== was(col)) sets.push([col, key, orNull(next)]);
  };
  want('title', 'title', v.title);
  want('description', 'description', v.description);
  want('type', 'type', v.type);
  want('priority', 'priority', v.priority);
  want('due_at', 'dueAt', v.dueAt);

  const linkType = v.linkedEntityType !== undefined ? v.linkedEntityType : (was('linked_entity_type') as string | null);
  const linkId = v.linkedEntityId !== undefined ? v.linkedEntityId : (was('linked_entity_id') as string | null);
  if (linkType !== was('linked_entity_type') || linkId !== was('linked_entity_id')) {
    assertLinkedEntity(linkType, linkId, ctx.branchId);
    want('linked_entity_type', 'linkedEntityType', linkType);
    want('linked_entity_id', 'linkedEntityId', linkId);
  }
  if (v.assignedTo !== undefined && v.assignedTo !== was('assigned_to')) {
    if (v.assignedTo) assertAssignee(v.assignedTo, ctx.branchId);
    sets.push(['assigned_to', 'assignedTo', v.assignedTo]);
  }

  let completing = false;
  if (v.status !== undefined && v.status !== from) {
    if (v.status === 'completed' && !COMPLETABLE_FROM.includes(from)) {
      throw new OfficeRejected(TASK_INVALID_TRANSITION, `a task that is ${from} cannot be completed`);
    }
    sets.push(['status', 'status', v.status]);
    if (v.status === 'completed') {
      completing = true;
      sets.push(['completed_at', 'completedAt', new Date().toISOString()]);
    } else if (from === 'completed') {
      sets.push(['completed_at', 'completedAt', null]);
    }
  }

  if (sets.length === 0) {
    return { taskId: v.taskId, revision: Number(t.revision ?? 0), status: from, changed: false };
  }
  getDatabase().run(
    `UPDATE tasks SET ${sets.map(([col]) => `${col} = ?`).join(', ')} WHERE id = ? AND branch_id = ?`,
    [...sets.map(([, , val]) => val), v.taskId, ctx.branchId],
  );
  trackOfficeWrite('tasks', v.taskId, 'update', Object.fromEntries(sets.map(([, key, val]) => [key, val])));
  if (completing) void eventBus.emit('task.completed', 'task', v.taskId, {});
  return { taskId: v.taskId, revision: revisionOf(v.taskId), status: v.status ?? from, changed: true };
}

// ── Die Rümpfe der Maske ────────────────────────────────────────────────────

/** Was das Formular hält (`TaskFormData` in `TaskList`). NOTES hat keine Spalte — es reist nicht mit. */
export interface TaskFormValues {
  title: string;
  description: string;
  type: string;
  priority: string;
  dueAt: string;
  linkedEntityType: string;
  linkedEntityId: string;
}

/** Der Rumpf für „Create Task" — am Primary dieselbe Eingabe wie für PC2. Leeres Feld = `null`. */
export function taskCreateBody(f: TaskFormValues): Record<string, unknown> {
  return {
    title: f.title,
    description: f.description.trim() || null,
    type: f.type,
    priority: f.priority,
    dueAt: f.dueAt || null,
    linkedEntityType: f.linkedEntityType || null,
    linkedEntityId: f.linkedEntityId.trim() || null,
  };
}

/** „Save Changes": derselbe Rumpf plus Kennung und die gesehene Fassung. */
export function taskUpdateBody(t: { id: string; revision?: number }, f: TaskFormValues): Record<string, unknown> {
  return { taskId: t.id, expectedRevision: t.revision, ...taskCreateBody(f) };
}

/** „Complete": nur der Zielstatus — den Zeitpunkt setzt der Primary. */
export function taskCompleteBody(t: { id: string; revision?: number }): Record<string, unknown> {
  return { taskId: t.id, expectedRevision: t.revision, status: 'completed' };
}
