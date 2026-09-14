// R6F — der Push-Umfang nach BYTES, nicht nur nach Anzahl.
//
// Der `/api`-Router des Primary nimmt höchstens `MAX_SYNC_PUSH_BODY_BYTES` (src-tauri/src/sync/routes.rs,
// 50 MiB) je Anfrage; darüber antwortet er 413, NICHTS vom Stapel kommt an, und jeder weitere Push
// scheitert an denselben ersten Einträgen. Eine einzelne Änderung ist höchstens `limits.max_payload_bytes`
// (32 MiB) plus ihr Umschlag — zwei große Dokumente in einem Stapel von 100 aber nicht. Also wird der
// Stapel vorn abgeschnitten, sobald sein Rumpf die Grenze überschritte: der Rest geht im nächsten Push,
// in derselben Reihenfolge.

/** Die Körpergrenze des Rust-Routers (`MAX_SYNC_PUSH_BODY_BYTES`) — ein Test hält beide gleich. */
export const SYNC_PUSH_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/** Der Rumpf eines Pushs, genau so, wie `pushChanges` ihn schickt. */
export function pushBody<T>(changes: T[]): string {
  return JSON.stringify({ changes });
}

/**
 * Der längste Anfang von `changes` (mindestens einer), dessen Rumpf `pushBody` höchstens `limit` Bytes
 * (UTF-8) groß ist. Ein einzelner Eintrag über der Grenze geht allein — der Primary weist ihn ab, wie
 * bisher; er reißt aber keine anderen mehr mit.
 */
export function pushBatch<T>(changes: T[], limit: number = SYNC_PUSH_BODY_LIMIT_BYTES): T[] {
  const enc = new TextEncoder();
  let size = pushBody([]).length;
  const out: T[] = [];
  for (const c of changes) {
    const n = enc.encode(JSON.stringify(c)).length + (out.length > 0 ? 1 : 0);
    if (out.length > 0 && size + n > limit) break;
    out.push(c);
    size += n;
  }
  return out;
}
