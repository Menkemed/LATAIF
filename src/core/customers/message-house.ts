// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — das Nachrichtenprotokoll am Kunden: EINE Hausfolge für die Maske des
// Primary und für den Fernbefehl von PC2 (`customers.log_message`).
//
// Die vier Einträge der Matrix („Nachricht kopieren", „WhatsApp", „AI-Benachrichtigung Auftrag",
// „AI-Benachrichtigung Reparatur") sind EINE Absicht: dieselbe Maske (`MessagePreviewModal`) hält
// fest, dass eine Nachricht an einen Kunden hinausging — über Kopieren oder WhatsApp, wahlweise mit
// dem Vorgang verknüpft, aus dem sie kam (Angebot, Auftrag, Reparatur). Also ein Befehl, eine Folge.
//
// Was vorher geschah (auditiert, nicht angenommen):
//
//   • `logMessage` schrieb ohne Prüfung: jeder Kunde, jede Verknüpfung, auch aus einer fremden
//     Filiale oder gar keine existierende.
//   • Ohne Sitzung fiel die Zeile still auf 'branch-main' / 'user-owner' zurück.
//   • Ein leerer Text und jeder Schreibfehler wurden zu einem stillen `null` (die Maske sagte seit
//     R6B wenigstens, dass nichts eingetragen wurde).
//   • Auf PC2 gab es gar keinen Eintrag — nur den ehrlichen Hinweis „not logged".
//
// Jetzt: prüfen (aus der DATENBANK, in der Filiale des Auftrags), dann EINE Zeile schreiben — in der
// Transaktion des Aufrufers (`runOnPrimary` am Primary, `runRemoteCommand` für PC2). Die Folge
// öffnet und schließt selbst keine Transaktion und speichert nicht durabel. Sie wirft, statt still
// `null` zu liefern; gezählt wird nur ein Erfolg.
//
// Das Protokoll ist nur-anhängend (keine Fassung, kein Ändern): eine Wiederholung derselben Absicht
// erkennt der Primary an der Auftragskennung, nicht an einer Fassung.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert } from '@/core/sync/track';
import { isClientMode } from '@/core/bridge/client-mode';

/** Ein fachliches Nein des Protokolls — eingefroren, wenn es aus einem Fernauftrag kommt. */
export class MessageRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MessageRejected';
    this.code = code;
  }
}

export const MESSAGE_PRIMARY_ONLY = 'MESSAGE_PRIMARY_ONLY';
export const MESSAGE_NO_SESSION = 'MESSAGE_NO_SESSION';
export const MESSAGE_EMPTY = 'MESSAGE_EMPTY';
export const MESSAGE_CHANNEL_INVALID = 'MESSAGE_CHANNEL_INVALID';
export const MESSAGE_KIND_INVALID = 'MESSAGE_KIND_INVALID';
export const MESSAGE_LINK_INVALID = 'MESSAGE_LINK_INVALID';
export const CUSTOMER_REQUIRED = 'CUSTOMER_REQUIRED';
export const CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND';
export const OFFER_NOT_FOUND = 'OFFER_NOT_FOUND';
export const ORDER_NOT_FOUND = 'ORDER_NOT_FOUND';
export const REPAIR_NOT_FOUND = 'REPAIR_NOT_FOUND';
export const LINKED_ENTITY_MISMATCH = 'LINKED_ENTITY_MISMATCH';

// ── Die Wertemengen: genau das, was die Maske und ihre vier Aufrufer schicken ─

/**
 * Die Wege, auf denen die Maske eine Nachricht hinausgibt: „Copy" (`ai_copy`) und „WhatsApp".
 * Der Store-Typ `MessageChannel` kennt noch weitere (E-Mail, SMS, …) — kein Knopf protokolliert sie,
 * also nimmt das Protokoll sie auch nicht an.
 */
export const LOGGED_CHANNELS = ['whatsapp', 'ai_copy'] as const;
export type LoggedChannel = typeof LOGGED_CHANNELS[number];

/** Die Nachrichtenarten der Maske (Titel und Umschalter in `MessagePreviewModal`). */
export const MESSAGE_KINDS = ['follow_up', 'repair_ready', 'order_arrived', 'promotion', 'thank_you'] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];

/**
 * Die Vorgänge, mit denen ein Aufrufer die Nachricht verknüpft — und ihre Tabelle. Der Kunde kommt
 * dort jeweils AUS dem Vorgang (`offer.customerId`, `order.customerId`, `repair.customerId`); die
 * Kundenansicht verknüpft nichts.
 */
export const MESSAGE_LINKS = {
  offer: { table: 'offers', notFound: OFFER_NOT_FOUND },
  order: { table: 'orders', notFound: ORDER_NOT_FOUND },
  repair: { table: 'repairs', notFound: REPAIR_NOT_FOUND },
} as const;
export type MessageLinkType = keyof typeof MESSAGE_LINKS;

export interface MessageLogInput {
  customerId: string;
  channel: LoggedChannel;
  body: string;
  kind?: MessageKind;
  linkedEntityType?: MessageLinkType;
  linkedEntityId?: string;
}

/** Die geschriebene Zeile, wie die Maske sie zurückbekommt. */
export interface LoggedMessage {
  id: string;
  customerId: string;
  channel: LoggedChannel;
  direction: 'outbound';
  kind?: MessageKind;
  body: string;
  linkedEntityType?: MessageLinkType;
  linkedEntityId?: string;
  sentAt: string;
  createdAt: string;
  createdBy: string | null;
}

// ── Die Eingabe: dieselbe Prüfung für Maske, Rumpf und Hausfolge ────────────
//
// Rein (keine Datenbank): die Maske fragt damit VOR dem Schicken, der Fernbefehl prüft damit den
// Rumpf, und die Hausfolge noch einmal — damit ein alter Aufruf nicht an ihr vorbeikommt.

const has = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

export function messageLogInput(raw: Record<string, unknown>): MessageLogInput {
  const customerId = typeof raw.customerId === 'string' ? raw.customerId.trim() : '';
  if (!customerId) throw new MessageRejected(CUSTOMER_REQUIRED, 'a message is logged against a customer');

  if (!(LOGGED_CHANNELS as readonly unknown[]).includes(raw.channel)) {
    throw new MessageRejected(MESSAGE_CHANNEL_INVALID, `channel must be one of ${LOGGED_CHANNELS.join(', ')}`);
  }
  // Der Text bleibt, wie er geschickt wurde (so stand er auch vorher in der Historie); nur ein
  // leerer ist keine Nachricht. Vorher wurde er still zu `null`.
  if (typeof raw.body !== 'string' || !raw.body.trim()) {
    throw new MessageRejected(MESSAGE_EMPTY, 'the message is empty — nothing to add to the customer history');
  }

  const out: MessageLogInput = { customerId, channel: raw.channel as LoggedChannel, body: raw.body };
  if (has(raw.kind)) {
    if (!(MESSAGE_KINDS as readonly unknown[]).includes(raw.kind)) {
      throw new MessageRejected(MESSAGE_KIND_INVALID, `kind must be one of ${MESSAGE_KINDS.join(', ')}`);
    }
    out.kind = raw.kind as MessageKind;
  }

  // Verknüpfung: beides oder nichts. Ein Typ ohne Kennung (oder umgekehrt) zeigt auf nichts.
  const withType = has(raw.linkedEntityType);
  const withId = has(raw.linkedEntityId);
  if (withType !== withId) {
    throw new MessageRejected(MESSAGE_LINK_INVALID, 'a linked record needs both its type and its id');
  }
  if (withType) {
    if (typeof raw.linkedEntityType !== 'string' || !Object.prototype.hasOwnProperty.call(MESSAGE_LINKS, raw.linkedEntityType)) {
      throw new MessageRejected(MESSAGE_LINK_INVALID, `a message links to ${Object.keys(MESSAGE_LINKS).join(', ')} only`);
    }
    if (typeof raw.linkedEntityId !== 'string' || !raw.linkedEntityId.trim()) {
      throw new MessageRejected(MESSAGE_LINK_INVALID, 'the linked record id must be text');
    }
    out.linkedEntityType = raw.linkedEntityType as MessageLinkType;
    out.linkedEntityId = raw.linkedEntityId.trim();
  }
  return out;
}

// ── Wo protokolliert wird ───────────────────────────────────────────────────

/** Die Filiale und der Mensch am Primary — aus der Sitzung, ohne stilles 'branch-main'. */
export interface MessageCtx {
  branchId: string;
  userId: string;
}

/**
 * Ein Rechner ohne Geschäftsdatenbank schreibt hier nie — auch nicht über einen vergessenen
 * direkten Aufruf. Die Maske auf PC2 geht über die Brücke; dieser Riegel steht davor.
 */
export function assertMessagesHere(): void {
  if (isClientMode()) {
    throw new MessageRejected(MESSAGE_PRIMARY_ONLY, 'the customer history is kept on the main computer — this window has no business database');
  }
}

export function localMessageCtx(): MessageCtx {
  let branchId = '';
  let userId = '';
  try { branchId = currentBranchId(); } catch { branchId = ''; }
  try { userId = currentUserId(); } catch { userId = ''; }
  if (!branchId) throw new MessageRejected(MESSAGE_NO_SESSION, 'no branch in this session — sign in again');
  return { branchId, userId };
}

// ── Die Hausfolge ───────────────────────────────────────────────────────────

/**
 * Hält eine hinausgegangene Nachricht am Kunden fest. Läuft INNERHALB der Transaktion des Aufrufers.
 *
 * `branchId`/`userId` sind fern die GEPRÜFTE Identität des Absenders, am Primary die Sitzung —
 * `created_by` nennt also den Menschen, der die Nachricht verschickt hat, nie den Anmeldenamen des
 * Primary. Kennung und Zeitpunkte vergibt das Haus.
 */
export function logCustomerMessageInHouse(input: MessageLogInput, branchId: string, userId: string): LoggedMessage {
  assertMessagesHere();
  if (!branchId) throw new MessageRejected(MESSAGE_NO_SESSION, 'no branch in this session — sign in again');
  const i = messageLogInput(input as unknown as Record<string, unknown>);

  if (!query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [i.customerId, branchId])[0]) {
    throw new MessageRejected(CUSTOMER_NOT_FOUND, 'this customer does not exist in this branch');
  }
  if (i.linkedEntityType && i.linkedEntityId) {
    const link = MESSAGE_LINKS[i.linkedEntityType];
    const r = query(`SELECT customer_id FROM ${link.table} WHERE id = ? AND branch_id = ?`, [i.linkedEntityId, branchId])[0];
    if (!r) throw new MessageRejected(link.notFound, `this ${i.linkedEntityType} does not exist in this branch`);
    // Jeder Aufrufer nimmt den Kunden AUS dem Vorgang; eine Nachricht an Kunde A, verknüpft mit dem
    // Auftrag von Kunde B, gäbe es in der Maske nicht — sie stünde in der falschen Historie.
    if (String(r.customer_id ?? '') !== i.customerId) {
      throw new MessageRejected(LINKED_ENTITY_MISMATCH, `this ${i.linkedEntityType} belongs to a different customer`);
    }
  }

  const id = uuid();
  const now = new Date().toISOString();
  const createdBy = userId || null;
  getDatabase().run(
    `INSERT INTO customer_messages
       (id, branch_id, customer_id, channel, direction, kind, subject, body,
        linked_entity_type, linked_entity_id, sent_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 'outbound', ?, NULL, ?, ?, ?, ?, ?, ?)`,
    [id, branchId, i.customerId, i.channel, i.kind ?? null, i.body,
     i.linkedEntityType ?? null, i.linkedEntityId ?? null, now, createdBy, now],
  );
  // customer_messages steht im Abgleichsvertrag — der Abgleich bleibt, wie er war.
  trackInsert('customer_messages', id, { customerId: i.customerId, channel: i.channel, kind: i.kind });

  return {
    id, customerId: i.customerId, channel: i.channel, direction: 'outbound', kind: i.kind, body: i.body,
    linkedEntityType: i.linkedEntityType, linkedEntityId: i.linkedEntityId,
    sentAt: now, createdAt: now, createdBy,
  };
}
