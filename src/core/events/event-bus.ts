// ═══════════════════════════════════════════════════════════
// LATAIF — Event Bus (Closed-Loop Automation Core)
// ═══════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import type { EventType, DomainEvent } from '../models/types';

type EventHandler = (event: DomainEvent) => void | Promise<void>;

class EventBus {
  private handlers = new Map<EventType, EventHandler[]>();
  private eventLog: DomainEvent[] = [];

  on(type: EventType, handler: EventHandler): () => void {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);

    return () => {
      const updated = (this.handlers.get(type) || []).filter(h => h !== handler);
      this.handlers.set(type, updated);
    };
  }

  async emit(
    type: EventType,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown> = {},
    triggeredBy = 'system'
  ): Promise<DomainEvent> {
    const event: DomainEvent = {
      id: uuid(),
      type,
      entityType,
      entityId,
      payload,
      triggeredBy,
      processed: false,
      createdAt: new Date().toISOString(),
    };

    this.eventLog.push(event);

    const handlers = this.handlers.get(type) || [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[EventBus] Handler error for ${type}:`, err);
      }
    }

    event.processed = true;
    return event;
  }

  getLog(): DomainEvent[] {
    return [...this.eventLog];
  }

  getRecentLog(limit = 50): DomainEvent[] {
    return this.eventLog.slice(-limit).reverse();
  }

  clearLog(): void {
    this.eventLog = [];
  }
}

export const eventBus = new EventBus();
