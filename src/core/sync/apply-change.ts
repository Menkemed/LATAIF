// ═══════════════════════════════════════════════════════════
// LATAIF — Sync apply dispatcher (node-safe, no browser imports)
// ═══════════════════════════════════════════════════════════
//
// M6-B2DE4 §5 — this module holds the REAL apply path (control-plane guard, identifier gates,
// `applyUpsert`, the DELETE branch and the `applySyncChange` dispatcher). It was extracted out of
// `sync-service.ts` for ONE reason the behavioral proof demanded: `sync-service.ts` imports the
// browser/Tauri database layer at module load, so it cannot be imported under Node. The apply
// logic itself touches nothing but the `db` handle passed to it, so it lives here and both
// `sync-service.ts` (production) and the m6b2de4 regression gate (a real sql.js database) import
// the SAME functions — no mirrored second implementation.
//
// Nothing about the applyUpsert CONFLICT logic (SELECT COUNT → UPDATE-if-exists else INSERT)
// changed in the move; only its home did.

// The minimal shape of the sql.js database handle the apply path uses. Kept structural so a
// test can pass a real sql.js `Database` (production) without a dependency on this module.
export interface SqlDb {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export interface ApplyChange {
  table_name: string;
  record_id: string;
  action: string;
  data: string;
}

// ── Stable error codes (the contract the client and the tests assert on) ────────
export const SYNC_CONTROL_PLANE_TABLE_FORBIDDEN = 'SYNC_CONTROL_PLANE_TABLE_FORBIDDEN';
export const SYNC_TABLE_NAME_INVALID = 'SYNC_TABLE_NAME_INVALID';
export const SYNC_COLUMN_NAME_INVALID = 'SYNC_COLUMN_NAME_INVALID';

// ═══════════════════════════════════════════════════════════
// M6-B2DE1 §6 — control-plane denylist, the CLIENT'S second line of defence.
//
// The server already filters these tables out of every pull, so in a healthy system this list
// never fires. It exists for the unhealthy one: a tampered server, a version skew, a stale row
// that predates the server-side filter. If a control-plane row ever reaches the apply path, the
// client refuses the WHOLE batch fail-closed rather than write a single trust or identity row.
//
// These arrays MUST stay identical to `CONTROL_PLANE_TABLES` / `INTERNAL_TABLES` in
// `src-tauri/src/sync/sync_policy.rs` (the canonical policy; this is a drift-secured mirror).
// The `@sync-policy:*:begin/end` markers are STRUCTURED anchors: the Rust test
// `ts_client_denylist_matches_rust_ssot` reads this file, pulls every quoted table name between a
// marker pair and compares the sets to the Rust SSOT — independent of array syntax.
// @sync-policy:control-plane:begin
const CONTROL_PLANE_TABLES: readonly string[] = [
  'server_credentials',
  'primary_host_config',
  'users',
  'user_branches',
  'tenant_trust_roots',
  'authority_certificates',
  'authority_revocations',
  'authority_transfers',
  'root_custody',
  'enrolled_devices',
  'device_certificates',
  'device_enrollment_requests',
  'device_revocations',
  'legacy_device_inventory',
  'legacy_inventory_attestations',
  'sync_cutover_state',
];
// @sync-policy:control-plane:end
// @sync-policy:internal:begin
const INTERNAL_TABLES: readonly string[] = [
  'sync_changelog',
  'canonical_records',
  'operations',
  'schema_migrations',
];
// @sync-policy:internal:end

/** M6-B2DE1 §6 — is this table one the business sync must never apply to? */
export function isControlPlaneTable(table: string): boolean {
  return CONTROL_PLANE_TABLES.includes(table) || INTERNAL_TABLES.includes(table);
}

// M6-B2DE3 §3 — dynamic identifier safety. On the apply path `table_name` AND every column key of
// a payload are interpolated into SQL text (`INSERT INTO ${table} (${cols}) …`); identifiers
// cannot be bound like values. The control-plane denylist stops KNOWN trust tables; this stops
// the other half — any name that is not a clean identifier (`foo"; DROP …`, `Products`, a leading
// digit, empty, oversized). A real table/column here is always ASCII lowercase snake_case, so
// refusing anything else costs nothing and closes the injection class. The Rust SSOT
// (`sync_policy::is_valid_sync_identifier`) carries the same charset; the drift tests read the
// marked regex below AND run a shared vector set through both validators (semantic drift).
// @sync-policy:identifier-charset:begin
const SYNC_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,63}$/;
// @sync-policy:identifier-charset:end

/** M6-B2DE3 §3 — is this a canonical sync identifier (table or column)? */
export function isValidSyncIdentifier(name: unknown): boolean {
  return typeof name === 'string' && SYNC_IDENTIFIER_RE.test(name);
}

// M6-B2DE4 §3/§5 — never echo an untrusted identifier raw into an error or log. Any character
// that is not part of a canonical identifier is exactly the attack (a quote, a newline, a
// control byte, a semicolon), so replace every non-`[a-zA-Z0-9_]` char with `?`, cap the preview
// at 24 chars and append the true length. Bounded and injection-free.
export function redactIdentifier(name: unknown): string {
  const s = typeof name === 'string' ? name : String(name);
  const preview = Array.from(s).slice(0, 24).map(c => (/[a-zA-Z0-9_]/.test(c) ? c : '?')).join('');
  return `${preview}<len=${s.length}>`;
}

/** Fail-closed gate: throws the stable code (`SYNC_TABLE_NAME_INVALID` / `SYNC_COLUMN_NAME_INVALID`)
 *  on any non-canonical identifier, so a crafted table or column name aborts the whole apply
 *  batch instead of reaching SQL. The thrown message carries only a REDACTED preview. */
export function assertSyncIdentifier(kind: 'table' | 'column', name: unknown): void {
  if (!isValidSyncIdentifier(name)) {
    const code = kind === 'table' ? SYNC_TABLE_NAME_INVALID : SYNC_COLUMN_NAME_INVALID;
    throw new Error(
      `[Sync] ${code}: refusing to use ${kind} name ${redactIdentifier(name)} as a SQL ` +
        `identifier — not a canonical [a-z][a-z0-9_]* name. Whole batch rejected.`,
    );
  }
}

// ── The upsert (conflict logic UNCHANGED from sync-service.ts) ──────────────────
export function applyUpsert(db: SqlDb, table: string, id: string, data: Record<string, unknown>): void {
  // M6-B2DE3 §3 — this function builds SQL by interpolating the table name AND every column key
  // as identifiers. Gate both against the canonical charset before any string-building. The
  // dispatcher already gates the table, but applyUpsert is a reusable sink and must not rely on
  // its caller — and the column keys come straight from the (attacker-reachable) payload.
  assertSyncIdentifier('table', table);
  // v0.4.1 — `id` aus den Spalten herausfiltern. Die /mobile-Capture-Seite schickt `id` MIT im
  // data-Objekt. Ohne diesen Filter entsteht `INSERT INTO t (id, id, …)` → der Change scheitert.
  const keys = Object.keys(data).filter(k => k !== 'id');
  if (keys.length === 0) return;
  // Every remaining key is interpolated as a column identifier below.
  for (const k of keys) assertSyncIdentifier('column', k);

  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => {
    const v = data[k];
    // typeof null === 'object' → JSON.stringify(null) ergäbe den TEXT 'null' in der DB. Der
    // bricht jede IS-NULL-Logik. null/undefined müssen als echtes SQL-NULL binden.
    if (v === null || v === undefined) return null;
    return typeof v === 'object' ? JSON.stringify(v) : v;
  });

  const result = db.exec(`SELECT COUNT(*) FROM ${table} WHERE id = ?`, [id]);
  const exists = result.length > 0 && (result[0].values[0][0] as number) > 0;

  if (exists) {
    db.run(`UPDATE ${table} SET ${setClause} WHERE id = ?`, [...values, id]);
  } else {
    const allKeys = ['id', ...keys];
    const placeholders = allKeys.map(() => '?').join(', ');
    db.run(`INSERT INTO ${table} (${allKeys.join(', ')}) VALUES (${placeholders})`, [id, ...values]);
  }
}

/**
 * M6-B2DE4 §5 — the ONE apply dispatcher, used by the production pull loop and driven directly by
 * the behavioral gate. Every guard runs BEFORE any SQL string is built:
 *   1. control-plane denylist  → SYNC_CONTROL_PLANE_TABLE_FORBIDDEN
 *   2. canonical table name    → SYNC_TABLE_NAME_INVALID
 *   3. canonical column names  → SYNC_COLUMN_NAME_INVALID (inside applyUpsert)
 * `record_id` stays a bound parameter, never an identifier. A throw here aborts the whole batch
 * (applyChangesAtomic rolls back) so a poisoned change is never applied and the cursor never
 * advances past it.
 */
export function applySyncChange(db: SqlDb, change: ApplyChange): void {
  if (isControlPlaneTable(change.table_name)) {
    throw new Error(
      `[Sync] ${SYNC_CONTROL_PLANE_TABLE_FORBIDDEN}: refusing to apply ` +
        `${redactIdentifier(change.table_name)} from the sync stream (control-plane table). ` +
        `Whole batch rejected.`,
    );
  }
  assertSyncIdentifier('table', change.table_name);
  // change.data kann ein base64-Foto (~1 MB) sein — NIE das ganze Objekt loggen.
  const data = JSON.parse(change.data);
  if (change.action === 'insert' || change.action === 'update') {
    applyUpsert(db, change.table_name, change.record_id, data);
  } else if (change.action === 'delete') {
    db.run(`DELETE FROM ${change.table_name} WHERE id = ?`, [change.record_id]);
  }
}
