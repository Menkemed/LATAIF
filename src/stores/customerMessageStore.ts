import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert } from '@/core/sync/track';

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

interface LogInput {
  customerId: string;
  channel: MessageChannel;
  body: string;
  kind?: string;
  subject?: string;
  linkedEntityType?: string;
  linkedEntityId?: string;
  direction?: MessageDirection;
}

interface Store {
  messagesByCustomer: Record<string, CustomerMessage[]>;
  loadMessages: (customerId: string) => void;
  logMessage: (input: LogInput) => CustomerMessage | null;
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

  logMessage: (input) => {
    if (!input.body?.trim()) return null;
    try {
      const db = getDatabase();
      const id = uuid();
      const now = new Date().toISOString();
      let branchId: string, userId: string;
      try { branchId = currentBranchId(); userId = currentUserId(); }
      catch { branchId = 'branch-main'; userId = 'user-owner'; }

      db.run(
        `INSERT INTO customer_messages
           (id, branch_id, customer_id, channel, direction, kind, subject, body,
            linked_entity_type, linked_entity_id, sent_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, branchId, input.customerId, input.channel, input.direction || 'outbound',
         input.kind || null, input.subject || null, input.body,
         input.linkedEntityType || null, input.linkedEntityId || null, now, userId, now]
      );
      saveDatabase();
      trackInsert('customer_messages', id, { customerId: input.customerId, channel: input.channel, kind: input.kind });
      get().loadMessages(input.customerId);
      return {
        id, customerId: input.customerId, channel: input.channel,
        direction: input.direction || 'outbound', kind: input.kind, subject: input.subject,
        body: input.body, linkedEntityType: input.linkedEntityType, linkedEntityId: input.linkedEntityId,
        sentAt: now, createdAt: now,
      };
    } catch (err) {
      console.warn('[CustomerMessages] log failed:', err);
      return null;
    }
  },

  deleteMessage: (id, customerId) => {
    const db = getDatabase();
    db.run(`DELETE FROM customer_messages WHERE id = ?`, [id]);
    saveDatabase();
    get().loadMessages(customerId);
  },
}));
