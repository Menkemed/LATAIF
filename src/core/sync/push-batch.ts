// R6F — der Push-Umfang nach BYTES, nicht nur nach Anzahl.
//
// Der `/api`-Router des Primary nimmt höchstens `MAX_SYNC_PUSH_BODY_BYTES` (src-tauri/src/sync/routes.rs,
// 50 MiB) je Anfrage; darüber antwortet er 413, NICHTS vom Stapel kommt an, und jeder weitere Push
// scheitert an denselben ersten Einträgen. Eine einzelne Änderung ist höchstens `limits.max_payload_bytes`
// (32 MiB) plus ihr Umschlag — zwei große Dokumente in einem Stapel von 100 aber nicht. Also wird der
// Stapel vorn abgeschnitten, sobald sein Rumpf die Grenze überschritte: der Rest geht im nächsten Push,
// in derselben Reihenfolge.
//
// Und eine Änderung, die der Primary NIE annehmen kann (ihre Daten über `max_payload_bytes` — so weist
// `validate_business_payload` sie ab — oder schon allein ein Rumpf über der Körpergrenze), wird nicht
// gesendet: sie bliebe sonst für immer vorn in der Warteschlange und hielte jede spätere Änderung auf.

import SYNC_BUSINESS_SCHEMA from './sync-business-schema.json' with { type: 'json' };

/** Die Körpergrenze des Rust-Routers (`MAX_SYNC_PUSH_BODY_BYTES`) — ein Test hält beide gleich. */
export const SYNC_PUSH_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/** Die Grenze EINER Änderung (insert/update) — aus dem Manifest, wie am Primary. */
export const SYNC_PAYLOAD_LIMIT_BYTES: number =
  (SYNC_BUSINESS_SCHEMA as unknown as { limits: { max_payload_bytes: number } }).limits.max_payload_bytes;

export interface PushChange { table_name: string; record_id: string; action: string; data: string }

/** Der Rumpf eines Pushs, genau so, wie `pushChanges` ihn schickt. */
export function pushBody(changes: PushChange[]): string {
  return JSON.stringify({ changes });
}

/** Die Stellen, die jetzt gehen (ein Stapel, Reihenfolge wie gelesen), und die, die nie gehen können. */
export interface PushPlan { send: number[]; refused: number[] }

/**
 * Plant EINEN Push über `changes` (in Reihenfolge): jede Änderung, die der Primary nie annehmen kann,
 * kommt nach `refused`; die übrigen gehen, solange der Rumpf (UTF-8) höchstens `limits.body` Bytes groß
 * ist. Die erste, die nicht mehr passt, beendet den Stapel — sie und alles danach gehen im nächsten Push.
 */
export function planPush(
  changes: PushChange[],
  limits: { payload: number; body: number } = { payload: SYNC_PAYLOAD_LIMIT_BYTES, body: SYNC_PUSH_BODY_LIMIT_BYTES },
): PushPlan {
  const enc = new TextEncoder();
  const empty = pushBody([]).length;
  const send: number[] = [];
  const refused: number[] = [];
  let size = empty;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const own = enc.encode(JSON.stringify(c)).length;
    const never = ((c.action === 'insert' || c.action === 'update') && enc.encode(c.data).length > limits.payload)
      || empty + own > limits.body;
    if (never) { refused.push(i); continue; }
    const n = own + (send.length > 0 ? 1 : 0);
    if (send.length > 0 && size + n > limits.body) break;
    send.push(i);
    size += n;
  }
  return { send, refused };
}
