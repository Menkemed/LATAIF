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
// M6-B3A §3/§4/§5 — the apply path is now bounded by the canonical business-schema SSOT
// (`sync-business-schema.json`): only allow-listed tables, only their exact payload fields, only
// insert/update/delete, and hard payload limits. A change that violates the contract throws a
// `SyncPoisonError` carrying a stable code; the pull orchestration turns that into a DURABLE
// QUARANTINE (never applied, never counted as applied) instead of a permanent head-of-line stall.
// Rust reads the SAME manifest file (`sync_schema.rs`); a drift gate proves the two never diverge.
//
// Nothing about the applyUpsert CONFLICT logic (SELECT COUNT → UPDATE-if-exists else INSERT)
// changed here; the stale-replay behaviour of a fully valid change is deliberately untouched.

// The canonical, machine-readable business-schema SSOT. Rust (`src-tauri/src/sync/sync_schema.rs`)
// reads the exact same file via include_str!; the m6b3a drift gate re-derives it from the live
// frontend schema and compares. Imported with an explicit JSON attribute so the SAME import line
// resolves under Vite (production bundle) AND `node` (the behavioral gate strips types).
import SYNC_BUSINESS_SCHEMA from './sync-business-schema.json' with { type: 'json' };

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

// ── Stable error codes (the contract the client, the server and the tests assert on) ────────
export const SYNC_CONTROL_PLANE_TABLE_FORBIDDEN = 'SYNC_CONTROL_PLANE_TABLE_FORBIDDEN';
export const SYNC_TABLE_NAME_INVALID = 'SYNC_TABLE_NAME_INVALID';
export const SYNC_COLUMN_NAME_INVALID = 'SYNC_COLUMN_NAME_INVALID';
// M6-B3A §4/§5 — schema-contract violations. All deterministic (the same change fails identically
// forever), so all are QUARANTINE-eligible, never transient.
export const SYNC_TABLE_NOT_ALLOWED = 'SYNC_TABLE_NOT_ALLOWED';
export const SYNC_FIELD_NOT_ALLOWED = 'SYNC_FIELD_NOT_ALLOWED';
export const SYNC_PAYLOAD_INVALID = 'SYNC_PAYLOAD_INVALID';
export const SYNC_PAYLOAD_TOO_LARGE = 'SYNC_PAYLOAD_TOO_LARGE';
// M6-B3A1 §3 — the change's operation is not one this table's contract permits. allowed_operations
// is now the EXACT set a production writer emits for the table (not a blanket insert/update/delete),
// so e.g. an insert into an update-only table, or a delete on an insert-only ledger, is refused.
export const SYNC_OPERATION_NOT_ALLOWED = 'SYNC_OPERATION_NOT_ALLOWED';
// M6-B3A1 §6 — the raw JSON carried a duplicate key (envelope or payload). serde_json / JSON.parse
// both silently keep the last; we refuse the whole batch rather than let a duplicate slip past a
// validator that only sees the collapsed object.
export const SYNC_PAYLOAD_DUPLICATE_KEY = 'SYNC_PAYLOAD_DUPLICATE_KEY';

// M6-B3A §9 — a DETERMINISTIC policy rejection (forbidden/unknown table, non-canonical or
// disallowed field, malformed or oversized payload). It carries a stable `code`. The pull
// orchestration (durable-cursor) treats a SyncPoisonError as "quarantine this one change and keep
// going", and ANY OTHER throw (a genuine sql.js/DB fault) as "transient → roll back the whole
// batch, do not advance the cursor". The distinction is the whole of the poison-vs-transient
// contract, so it is a structural marker (`isSyncPoison`) — durable-cursor stays dependency-free
// and never imports this class. The code is ALSO in the message so `message.includes(code)`
// (the m6b2de4 assertion style) keeps working.
export class SyncPoisonError extends Error {
  readonly code: string;
  readonly isSyncPoison = true as const;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SyncPoisonError';
    this.code = code;
  }
}

/** Is this a deterministic policy rejection (→ quarantine) rather than a transient DB fault
 *  (→ rollback)? Checked structurally so durable-cursor need not import the class. */
export function isSyncPoisonError(e: unknown): e is SyncPoisonError {
  return !!e && typeof e === 'object' && (e as { isSyncPoison?: unknown }).isSyncPoison === true;
}

// ═══════════════════════════════════════════════════════════
// M6-B2DE1 §6 — control-plane denylist, the CLIENT'S second line of defence.
//
// The server already filters these tables out of every pull, so in a healthy system this list
// never fires. It exists for the unhealthy one: a tampered server, a version skew, a stale row
// that predates the server-side filter. If a control-plane row ever reaches the apply path, the
// client refuses it fail-closed rather than write a single trust or identity row.
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
  'sync_change_quarantine',
  'canonical_records',
  'operations',
  // M6-B3B1 §14 — the server-authoritative CAS tables (v0010); server-only, never client-synced.
  // Kept identical to INTERNAL_TABLES in sync_policy.rs (a Rust test asserts exact set equality).
  'canonical_entities',
  'operation_ledger',
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
 *  on any non-canonical identifier, so a crafted table or column name is quarantined instead of
 *  reaching SQL. The thrown message carries only a REDACTED preview. */
export function assertSyncIdentifier(kind: 'table' | 'column', name: unknown): void {
  if (!isValidSyncIdentifier(name)) {
    const code = kind === 'table' ? SYNC_TABLE_NAME_INVALID : SYNC_COLUMN_NAME_INVALID;
    throw new SyncPoisonError(
      code,
      `[Sync] ${code}: refusing to use ${kind} name ${redactIdentifier(name)} as a SQL ` +
        `identifier — not a canonical [a-z][a-z0-9_]* name.`,
    );
  }
}

// ═══════════════════════════════════════════════════════════
// M6-B3A §3/§4/§5 — the business-schema SSOT, loaded once from the canonical manifest.
// ═══════════════════════════════════════════════════════════
interface TableContract {
  allowed_operations: string[];
  record_id_field: string;
  allowed_fields: string[];
  required_fields: string[];
  immutable_fields: string[];
}
interface SyncSchema {
  schema_version: number;
  limits: { max_payload_bytes: number; max_fields: number };
  tables: Record<string, TableContract>;
}
const SCHEMA = SYNC_BUSINESS_SCHEMA as unknown as SyncSchema;

interface CompiledContract {
  fields: Set<string>;
  ops: Set<string>;
  recordIdField: string;
}
const BUSINESS_TABLES: Map<string, CompiledContract> = new Map(
  Object.entries(SCHEMA.tables).map(([t, c]) => [
    t,
    { fields: new Set(c.allowed_fields), ops: new Set(c.allowed_operations), recordIdField: c.record_id_field },
  ]),
);
const MAX_PAYLOAD_CHARS = SCHEMA.limits.max_payload_bytes;
const MAX_FIELDS = SCHEMA.limits.max_fields;

/** M6-B3A §4 — is this table in the business allowlist (a canonical, explicitly-contracted table)? */
export function isBusinessSyncTable(table: string): boolean {
  return BUSINESS_TABLES.has(table);
}

export type SyncTableClass = 'business' | 'control-plane' | 'invalid' | 'unknown';

/** M6-B3A §4 — the four disjoint classes a sync `table_name` can fall into. `business` is the only
 *  transportable/appliable one; every other class is refused (control-plane/internal is filtered,
 *  invalid and unknown are quarantined). */
export function classifySyncTable(table: string): SyncTableClass {
  if (isControlPlaneTable(table)) return 'control-plane';
  if (!isValidSyncIdentifier(table)) return 'invalid';
  if (BUSINESS_TABLES.has(table)) return 'business';
  return 'unknown';
}

// M6-B3A §5 — count the TOP-LEVEL key:value separators in the raw JSON, skipping string contents
// (with escapes) and any nested object/array. If this exceeds the parsed key count, the payload
// carried DUPLICATE top-level keys — which JSON.parse silently collapses (last wins). trackChange
// never emits duplicates, so any is a crafted payload; refuse it rather than let client and server
// potentially resolve a duplicate differently.
function topLevelKeyCount(raw: string): number {
  let depth = 0, count = 0, inString = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ':' && depth === 1) count++;
  }
  return count;
}

/**
 * M6-B3A §5 — validate an insert/update payload against the table contract BEFORE any SQL is built.
 * Throws a `SyncPoisonError` (quarantine-eligible) on any violation. Returns the parsed object on
 * success. This does NOT invent business type/value rules — only transport-shape safety:
 *   • well-formed JSON object (not array/scalar/null)  → SYNC_PAYLOAD_INVALID
 *   • no duplicate top-level keys                        → SYNC_PAYLOAD_INVALID
 *   • within the char and field-count limits            → SYNC_PAYLOAD_TOO_LARGE
 *   • every key a canonical identifier                   → SYNC_COLUMN_NAME_INVALID
 *   • every key in the table's allowed_fields            → SYNC_FIELD_NOT_ALLOWED
 */
function validateBusinessPayload(contract: CompiledContract, rawData: string): Record<string, unknown> {
  // Size first — cheap and bounds everything below. `rawData.length` is UTF-16 units; UTF-8 bytes
  // are always ≥ that, so this can only ever be MORE permissive than a byte limit, never less —
  // fine for a DoS bound set far (32 MB) above any real photo payload.
  if (rawData.length > MAX_PAYLOAD_CHARS) {
    throw new SyncPoisonError(
      SYNC_PAYLOAD_TOO_LARGE,
      `[Sync] ${SYNC_PAYLOAD_TOO_LARGE}: payload of ${rawData.length} chars exceeds the ${MAX_PAYLOAD_CHARS} limit.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    throw new SyncPoisonError(SYNC_PAYLOAD_INVALID, `[Sync] ${SYNC_PAYLOAD_INVALID}: payload is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyncPoisonError(SYNC_PAYLOAD_INVALID, `[Sync] ${SYNC_PAYLOAD_INVALID}: payload is not a JSON object.`);
  }
  const data = parsed as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.length > MAX_FIELDS) {
    throw new SyncPoisonError(
      SYNC_PAYLOAD_TOO_LARGE,
      `[Sync] ${SYNC_PAYLOAD_TOO_LARGE}: payload has ${keys.length} fields, over the ${MAX_FIELDS} limit.`,
    );
  }
  if (topLevelKeyCount(rawData) > keys.length) {
    throw new SyncPoisonError(SYNC_PAYLOAD_DUPLICATE_KEY, `[Sync] ${SYNC_PAYLOAD_DUPLICATE_KEY}: payload has duplicate top-level keys.`);
  }
  for (const k of keys) {
    // Canonical charset first (a non-canonical key would poison the SQL identifier), then the
    // per-table allowlist (a canonical-but-unknown column is the exact poisoning case B3A closes).
    assertSyncIdentifier('column', k);
    if (!contract.fields.has(k)) {
      throw new SyncPoisonError(
        SYNC_FIELD_NOT_ALLOWED,
        `[Sync] ${SYNC_FIELD_NOT_ALLOWED}: field ${redactIdentifier(k)} is not in the table contract.`,
      );
    }
  }
  return data;
}

// ── The upsert (conflict logic UNCHANGED since M6-B2DE4) ────────────────────────
export function applyUpsert(db: SqlDb, table: string, id: string, data: Record<string, unknown>): void {
  // M6-B2DE3 §3 — this function builds SQL by interpolating the table name AND every column key
  // as identifiers. Gate both against the canonical charset before any string-building. The
  // dispatcher already gates the table AND the fields, but applyUpsert is a reusable sink and must
  // not rely on its caller — the column keys come straight from the (attacker-reachable) payload.
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
 * M6-B2DE4 §5 / M6-B3A §4/§5 — the ONE apply dispatcher, used by the production pull loop and driven
 * directly by the behavioral gate. Every guard runs BEFORE any SQL string is built:
 *   1. control-plane / internal denylist → SYNC_CONTROL_PLANE_TABLE_FORBIDDEN
 *   2. canonical table name              → SYNC_TABLE_NAME_INVALID
 *   3. business allowlist (unknown table)→ SYNC_TABLE_NOT_ALLOWED
 *   4. operation ∈ allowed_operations    → SYNC_PAYLOAD_INVALID
 *   5. payload shape / fields / limits    → SYNC_PAYLOAD_INVALID / SYNC_FIELD_NOT_ALLOWED /
 *                                           SYNC_COLUMN_NAME_INVALID / SYNC_PAYLOAD_TOO_LARGE
 * Every failure is a `SyncPoisonError` — deterministic, so the pull orchestration QUARANTINES the
 * one change (never applied, never counted as applied) instead of stalling the cursor. `record_id`
 * stays a bound parameter, never an identifier.
 */
/**
 * M6-B3A §3 — the PURE contract verdict (no DB, no apply, no throw). Returns the stable violation
 * code, or null if the change satisfies the business-schema contract. Same helpers as
 * `applySyncChange` (classifySyncTable + validateBusinessPayload), so the two cannot semantically
 * diverge; the Rust server mirrors this as `sync_schema::change_contract_violation`, and the
 * shared-vector drift gate runs one fixture through BOTH to prove they agree.
 */
export function changeContractViolation(table: string, action: string, rawData: string): string | null {
  const cls = classifySyncTable(table);
  if (cls === 'control-plane') return SYNC_CONTROL_PLANE_TABLE_FORBIDDEN;
  if (cls === 'invalid') return SYNC_TABLE_NAME_INVALID;
  if (cls === 'unknown') return SYNC_TABLE_NOT_ALLOWED;
  const contract = BUSINESS_TABLES.get(table) as CompiledContract;
  if (!contract.ops.has(action)) return SYNC_OPERATION_NOT_ALLOWED;
  if (action === 'insert' || action === 'update') {
    try {
      validateBusinessPayload(contract, rawData);
    } catch (e) {
      return isSyncPoisonError(e) ? e.code : SYNC_PAYLOAD_INVALID;
    }
  }
  return null;
}

export function applySyncChange(db: SqlDb, change: ApplyChange): void {
  const cls = classifySyncTable(change.table_name);
  if (cls === 'control-plane') {
    throw new SyncPoisonError(
      SYNC_CONTROL_PLANE_TABLE_FORBIDDEN,
      `[Sync] ${SYNC_CONTROL_PLANE_TABLE_FORBIDDEN}: refusing to apply ` +
        `${redactIdentifier(change.table_name)} from the sync stream (control-plane/internal table).`,
    );
  }
  if (cls === 'invalid') {
    // Non-canonical table name → SYNC_TABLE_NAME_INVALID (redacted), via the shared gate.
    assertSyncIdentifier('table', change.table_name);
  }
  if (cls === 'unknown') {
    throw new SyncPoisonError(
      SYNC_TABLE_NOT_ALLOWED,
      `[Sync] ${SYNC_TABLE_NOT_ALLOWED}: table ${redactIdentifier(change.table_name)} is canonical but not ` +
        `in the business-schema allowlist.`,
    );
  }
  // ── business table ──
  const contract = BUSINESS_TABLES.get(change.table_name) as CompiledContract;
  if (!contract.ops.has(change.action)) {
    throw new SyncPoisonError(
      SYNC_OPERATION_NOT_ALLOWED,
      `[Sync] ${SYNC_OPERATION_NOT_ALLOWED}: operation ${redactIdentifier(change.action)} is not permitted for this table.`,
    );
  }
  if (change.action === 'insert' || change.action === 'update') {
    // change.data kann ein base64-Foto (~1 MB) sein — NIE das ganze Objekt loggen.
    const data = validateBusinessPayload(contract, change.data);
    applyUpsert(db, change.table_name, change.record_id, data);
  } else if (change.action === 'delete') {
    // §5 — DELETE carries no data contract: the canonical, allow-listed table is validated above
    // and `record_id` is a bound parameter. Nothing else is required.
    db.run(`DELETE FROM ${change.table_name} WHERE id = ?`, [change.record_id]);
  }
}
