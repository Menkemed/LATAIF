import { create } from 'zustand';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import {
  assertMessagesHere, localMessageCtx, logCustomerMessageInHouse,
  type LoggedMessage, type MessageLogInput,
} from '@/core/customers/message-house';

export type MessageChannel = 'whatsapp' | 'ai_copy' | 'email' | 'sms' | 'phone' | 'in_person';
export type MessageDirection = 'outbound' | 'inbound';

export interface CustomerMessage {
  id: string;
  customerId: string;
  channel: MessageChannel;
  direction: MessageDirection;
  kind?: string;
  subject?: string;
  body: string;
  linkedEntityType?: string;
  linkedEntityId?: string;
  sentAt: string;
  createdAt: string;
}

interface Store {
  messagesByCustomer: Record<string, CustomerMessage[]>;
  loadMessages: (customerId: string) => void;
  /** R6E — wirft bei einem Nein (kein stilles `null` mehr); siehe `logCustomerMessageOnPrimary`. */
  logMessage: (input: MessageLogInput) => Promise<LoggedMessage>;
  deleteMessage: (id: string, customerId: string) => void;
}

function rowToMessage(r: Record<string, unknown>): CustomerMessage {
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    channel: (r.channel as MessageChannel) || 'whatsapp',
    direction: (r.direction as MessageDirection) || 'outbound',
    kind: r.kind as string | undefined,
    subject: r.subject as string | undefined,
    body: r.body as string,
    linkedEntityType: r.linked_entity_type as string | undefined,
    linkedEntityId: r.linked_entity_id as string | undefined,
    sentAt: r.sent_at as string,
    createdAt: r.created_at as string,
  };
}

export const useCustomerMessageStore = create<Store>((set, get) => ({
  messagesByCustomer: {},

  loadMessages: (customerId) => {
    try {
      const rows = query(
        'SELECT * FROM customer_messages WHERE customer_id = ? ORDER BY sent_at DESC',
        [customerId]
      );
      set(s => ({ messagesByCustomer: { ...s.messagesByCustomer, [customerId]: rows.map(rowToMessage) } }));
    } catch {
      set(s => ({ messagesByCustomer: { ...s.messagesByCustomer, [customerId]: [] } }));
    }
  },

  // CENTRAL-UI-PARITY R6E — keine eigene Zeile mehr hier: dieselbe Hausfolge wie der Fernbefehl
  // `customers.log_message`, in der Schreibreihenfolge des Primary.
  logMessage: (input) => logCustomerMessageOnPrimary(input),

  deleteMessage: (id, customerId) => {
    const db = getDatabase();
    db.run(`DELETE FROM customer_messages WHERE id = ?`, [id]);
    saveDatabase();
    get().loadMessages(customerId);
  },
}));

/**
 * CENTRAL-UI-PARITY R6E — „Copy"/„WhatsApp" der Nachrichtenmaske am Primary: die Hausfolge
 * exklusiv, in EINER Transaktion, erst danach durabel (`runOnPrimary`). Vorher schrieb der Store
 * synchron an der Schreibreihenfolge vorbei, fiel ohne Sitzung auf 'branch-main'/'user-owner'
 * zurück und machte aus jedem Fehler ein stilles `null`.
 *
 * Auf einem Rechner ohne Datenbank verweigert der Riegel, BEVOR eine Transaktion geöffnet wird —
 * dort geht die Maske über die Brücke.
 */
export function logCustomerMessageOnPrimary(input: MessageLogInput): Promise<LoggedMessage> {
  try { assertMessagesHere(); } catch (e) { return Promise.reject(e); }
  return runOnPrimary(
    () => {
      const ctx = localMessageCtx();
      return logCustomerMessageInHouse(input, ctx.branchId, ctx.userId);
    },
    () => useCustomerMessageStore.getState().loadMessages(input.customerId),
  );
}
