//! M6-B3A §3/§4/§5 — the canonical business-schema SSOT, server side.
//!
//! This module is the Rust half of the sync allowlist. It reads the EXACT SAME manifest file the
//! TypeScript client imports (`src/core/sync/sync-business-schema.json`) via `include_str!`, so
//! there is one canonical source and no hand-copied second table or field list. A drift gate
//! (`m6b3a` node test + the Rust tests below) re-derives the manifest from the live frontend schema
//! and proves the two never diverge; a shared-vector semantic test proves the Rust and TS payload
//! validators agree byte-for-byte on accept/reject.
//!
//! Two questions, kept separate from the trust-boundary policy in `sync_policy.rs`:
//!   • `sync_policy::classify` / `is_forbidden` — is this a control-plane / internal table? (denylist)
//!   • `sync_schema::is_business_table` / `validate_business_payload` — is this an ALLOW-LISTED
//!     business table carrying only its contracted fields? (allowlist)
//!
//! The legacy sync transports FRONTEND business rows as opaque JSON in `sync_changelog.data`; the
//! server never holds these tables itself. So this validates the `table_name` and `data` of a
//! changelog row, not the server's own schema.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

// ── Stable error codes (mirrored in apply-change.ts) ────────────────────────────
pub const ERR_TABLE_NOT_ALLOWED: &str = "SYNC_TABLE_NOT_ALLOWED";
pub const ERR_FIELD_NOT_ALLOWED: &str = "SYNC_FIELD_NOT_ALLOWED";
pub const ERR_PAYLOAD_INVALID: &str = "SYNC_PAYLOAD_INVALID";
pub const ERR_PAYLOAD_TOO_LARGE: &str = "SYNC_PAYLOAD_TOO_LARGE";
pub const ERR_COLUMN_NAME_INVALID: &str = "SYNC_COLUMN_NAME_INVALID";
// M6-B3A1 §3 — the change's operation is not one this table's contract permits (allowed_operations
// is the EXACT per-table writer set, not a blanket insert/update/delete).
pub const ERR_OPERATION_NOT_ALLOWED: &str = "SYNC_OPERATION_NOT_ALLOWED";
// M6-B3A1 §6 — the raw JSON carried a duplicate key (envelope or payload).
pub const ERR_PAYLOAD_DUPLICATE_KEY: &str = "SYNC_PAYLOAD_DUPLICATE_KEY";

/// The canonical manifest, embedded at build time. Same file, same bytes as the TS import.
pub const MANIFEST_JSON: &str = include_str!("../../../src/core/sync/sync-business-schema.json");

#[derive(serde::Deserialize)]
struct RawContract {
    allowed_operations: Vec<String>,
    record_id_field: String,
    allowed_fields: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    required_fields: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    immutable_fields: Vec<String>,
}
#[derive(serde::Deserialize)]
struct RawLimits {
    max_payload_bytes: usize,
    max_fields: usize,
}
#[derive(serde::Deserialize)]
struct RawManifest {
    schema_version: u32,
    limits: RawLimits,
    tables: HashMap<String, RawContract>,
}

pub struct TableContract {
    pub fields: HashSet<String>,
    pub ops: HashSet<String>,
}
pub struct SyncSchema {
    pub max_payload_bytes: usize,
    pub max_fields: usize,
    pub tables: HashMap<String, TableContract>,
}

static SCHEMA: OnceLock<SyncSchema> = OnceLock::new();

/// The parsed manifest (parsed once). A malformed manifest is a build-time invariant — the file is
/// generated and drift-gated — so a parse failure or an unsupported version panics loudly rather
/// than degrading to "allow nothing" or "allow everything". `schema_version` and `record_id_field`
/// are validated HERE (the only supported version is 1; every record id is `id`) and then not
/// stored, since nothing downstream needs to read them.
pub fn schema() -> &'static SyncSchema {
    SCHEMA.get_or_init(|| {
        let raw: RawManifest = serde_json::from_str(MANIFEST_JSON)
            .expect("sync-business-schema.json is malformed — build-time invariant");
        assert_eq!(raw.schema_version, 1, "unsupported sync-business-schema version");
        let tables = raw
            .tables
            .into_iter()
            .map(|(k, v)| {
                assert_eq!(v.record_id_field, "id", "{k}: record_id_field must be id");
                (
                    k,
                    TableContract {
                        fields: v.allowed_fields.into_iter().collect(),
                        ops: v.allowed_operations.into_iter().collect(),
                    },
                )
            })
            .collect();
        SyncSchema { max_payload_bytes: raw.limits.max_payload_bytes, max_fields: raw.limits.max_fields, tables }
    })
}

/// §4 — is this table_name in the business allowlist (a canonical, explicitly-contracted table)?
pub fn is_business_table(name: &str) -> bool {
    schema().tables.contains_key(name)
}

/// §4 — the allowlist gate. `Ok` only for an allow-listed table; every other canonical name is
/// `SYNC_TABLE_NOT_ALLOWED`. (Control-plane/internal names are refused earlier by `sync_policy`.)
pub fn validate_business_table(name: &str) -> Result<(), &'static str> {
    if is_business_table(name) {
        Ok(())
    } else {
        Err(ERR_TABLE_NOT_ALLOWED)
    }
}

/// §5 — is `action` one of the operations the table's contract permits (insert/update/delete)?
pub fn is_operation_allowed(table: &str, action: &str) -> bool {
    schema().tables.get(table).is_some_and(|c| c.ops.contains(action))
}

// M6-B3A2 §6/§7 — duplicate-key detection over DECODED keys, BEFORE serde_json/JSON.parse collapse
// a duplicate object key to its last value. This is a serde DESERIALIZER, not a text scanner: it
// walks the JSON with serde_json's own tokenizer and sees each map key AFTER its string escapes are
// decoded (`\uXXXX`, surrogate pairs, `\n`, `\"`, …). So `"table_name"`, `"table_name"` and
// `"table_name"` all decode to the SAME key and are flagged as duplicates — the raw-byte
// scanner this replaces would have missed them. No Unicode normalisation beyond JSON decoding:
// distinct codepoint sequences that JSON decoding does not equate stay distinct.
const DUP_SENTINEL: &str = "m6b3a2-duplicate-json-key";

struct DupCheck;
impl<'de> serde::Deserialize<'de> for DupCheck {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(DupVisitor)?;
        Ok(DupCheck)
    }
}
struct DupVisitor;
impl<'de> serde::de::Visitor<'de> for DupVisitor {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        // `next_key::<String>()` yields the DECODED key (serde_json decodes escapes + surrogates).
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key) {
                return Err(serde::de::Error::custom(DUP_SENTINEL));
            }
            map.next_value::<DupCheck>()?; // recurse into the value (nested objects / arrays)
        }
        Ok(())
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while seq.next_element::<DupCheck>()?.is_some() {}
        Ok(())
    }
    // Scalars carry no keys — accept and ignore every leaf shape serde_json can produce.
    fn visit_bool<E>(self, _: bool) -> Result<(), E> { Ok(()) }
    fn visit_i64<E>(self, _: i64) -> Result<(), E> { Ok(()) }
    fn visit_u64<E>(self, _: u64) -> Result<(), E> { Ok(()) }
    fn visit_f64<E>(self, _: f64) -> Result<(), E> { Ok(()) }
    fn visit_str<E>(self, _: &str) -> Result<(), E> { Ok(()) }
    fn visit_borrowed_str<E>(self, _: &'de str) -> Result<(), E> { Ok(()) }
    fn visit_string<E>(self, _: String) -> Result<(), E> { Ok(()) }
    fn visit_unit<E>(self) -> Result<(), E> { Ok(()) }
    fn visit_none<E>(self) -> Result<(), E> { Ok(()) }
    fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(DupVisitor)
    }
}

/// M6-B3A2 §6/§7 — true iff the raw JSON contains a duplicate key at ANY object level, comparing
/// keys AFTER JSON string decoding. Malformed JSON returns `false` here (the caller's real parse
/// then surfaces the 400/`SYNC_PAYLOAD_INVALID`) — ONLY a genuine decoded-key duplicate returns true.
pub fn contains_duplicate_json_key(raw: &str) -> bool {
    match serde_json::from_str::<DupCheck>(raw) {
        Ok(_) => false,
        Err(e) => e.to_string().contains(DUP_SENTINEL),
    }
}

/// FNV-1a over UTF-16 code units → 8-hex. Byte-for-byte identical to `stableHash` in
/// `quarantine.ts` (JS `charCodeAt` = UTF-16 unit; `Math.imul` = 32-bit wrapping multiply;
/// `>>> 0` = the u32 value). A DIAGNOSTIC/dedup digest for redacted logging and quarantine rows —
/// never a security primitive, never used to gate anything.
pub fn digest_hex(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for u in s.encode_utf16() {
        h ^= u as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}


/// §5/§6 — validate an insert/update payload against the table contract. Transport-shape safety
/// only (no business type/value rules invented): well-formed JSON object, no duplicate top-level
/// keys, within the char/field limits, every key a canonical identifier that is in the table's
/// `allowed_fields`. Returns the stable error code on the first violation.
pub fn validate_business_payload(table: &str, data: &str) -> Result<(), &'static str> {
    let contract = schema().tables.get(table).ok_or(ERR_TABLE_NOT_ALLOWED)?;
    if data.len() > schema().max_payload_bytes {
        return Err(ERR_PAYLOAD_TOO_LARGE);
    }
    let value: serde_json::Value = serde_json::from_str(data).map_err(|_| ERR_PAYLOAD_INVALID)?;
    let obj = value.as_object().ok_or(ERR_PAYLOAD_INVALID)?;
    if obj.len() > schema().max_fields {
        return Err(ERR_PAYLOAD_TOO_LARGE);
    }
    // M6-B3A2 §8 — the inner `data` payload's own duplicate keys, over DECODED keys, refused BEFORE
    // the Value above lost them (serde_json::Value keeps the last of a duplicate). Same detector as
    // the envelope, so an escaped-equivalent duplicate field is caught here too.
    if contains_duplicate_json_key(data) {
        return Err(ERR_PAYLOAD_DUPLICATE_KEY);
    }
    for key in obj.keys() {
        // Canonical charset first (a non-canonical key would poison the client's SQL identifier),
        // then the per-table allowlist (a canonical-but-unknown column is the poisoning case).
        if !super::sync_policy::is_valid_sync_identifier(key) {
            return Err(ERR_COLUMN_NAME_INVALID);
        }
        if !contract.fields.contains(key.as_str()) {
            return Err(ERR_FIELD_NOT_ALLOWED);
        }
    }
    Ok(())
}

/// M6-B3A §3 — the PURE contract verdict, mirroring `changeContractViolation` in apply-change.ts
/// (same order, same codes). Returns the stable code, or None if the change satisfies the contract.
/// The shared-vector drift gate runs one fixture through this AND the TS function to prove they
/// agree. `is_forbidden` covers control-plane AND internal, exactly as the TS `classifySyncTable`.
pub fn change_contract_violation(table: &str, action: &str, data: &str) -> Option<&'static str> {
    use super::sync_policy;
    if sync_policy::is_forbidden(table) {
        return Some(sync_policy::ERR_CONTROL_PLANE_TABLE_FORBIDDEN);
    }
    if sync_policy::validate_sync_table_name(table).is_err() {
        return Some(sync_policy::ERR_TABLE_NAME_INVALID);
    }
    if let Err(code) = validate_business_table(table) {
        return Some(code);
    }
    if !is_operation_allowed(table, action) {
        return Some(ERR_OPERATION_NOT_ALLOWED);
    }
    if action == "insert" || action == "update" {
        if let Err(code) = validate_business_payload(table, data) {
            return Some(code);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses_and_is_non_trivial() {
        // schema() panics on a bad version / non-`id` record field, so reaching here proves both.
        let s = schema();
        assert!(s.tables.len() >= 50, "expected the full synced-table allowlist, got {}", s.tables.len());
        assert!(s.max_payload_bytes >= 1_000_000);
        assert!(s.max_fields >= 43);
    }

    // ── the KEY safety invariant: no allow-listed table is a forbidden one ──────
    #[test]
    fn no_manifest_table_is_forbidden_or_non_canonical() {
        for name in schema().tables.keys() {
            assert!(
                !super::super::sync_policy::is_forbidden(name),
                "{name} is in the business allowlist AND the control-plane/internal denylist"
            );
            assert!(
                super::super::sync_policy::is_valid_sync_identifier(name),
                "{name} is in the business allowlist but is not a canonical identifier"
            );
        }
    }

    #[test]
    fn every_manifest_field_is_canonical_and_records_have_id() {
        for (t, c) in &schema().tables {
            assert!(c.fields.contains("id"), "{t} allowed_fields must include id");
            for f in &c.fields {
                assert!(
                    super::super::sync_policy::is_valid_sync_identifier(f),
                    "{t}.{f} is not a canonical identifier"
                );
            }
            for op in &c.ops {
                assert!(matches!(op.as_str(), "insert" | "update" | "delete"), "{t}: bad op {op}");
            }
        }
    }

    #[test]
    fn allowlist_gate_accepts_business_rejects_unknown_and_control_plane() {
        assert!(is_business_table("products"));
        assert!(is_business_table("invoices"));
        assert!(validate_business_table("products").is_ok());
        // canonical but not synced (server base tables / non-sync tables) → not allowed
        for unknown in ["tenants", "branches", "categories", "settings", "tax_payments", "some_future_table"] {
            assert!(!is_business_table(unknown), "{unknown} must not be allow-listed");
            assert_eq!(validate_business_table(unknown), Err(ERR_TABLE_NOT_ALLOWED));
        }
        // control-plane names are not in the allowlist either
        for cp in ["users", "enrolled_devices", "sync_changelog"] {
            assert!(!is_business_table(cp));
        }
    }

    #[test]
    fn payload_validation_accepts_a_real_row_and_rejects_poison() {
        // a real products row shape (subset of columns — all real)
        assert!(validate_business_payload("products", r#"{"id":"p1","brand":"Rolex","name":"Sub"}"#).is_ok());
        // canonical-but-unknown column → SYNC_FIELD_NOT_ALLOWED (the confirmed poisoning case)
        assert_eq!(
            validate_business_payload("products", r#"{"id":"p1","bad_column":1}"#),
            Err(ERR_FIELD_NOT_ALLOWED)
        );
        // non-canonical column identifier → SYNC_COLUMN_NAME_INVALID
        assert_eq!(
            validate_business_payload("products", r#"{"id":"p1","BadColumn":1}"#),
            Err(ERR_COLUMN_NAME_INVALID)
        );
        // not a JSON object → SYNC_PAYLOAD_INVALID
        assert_eq!(validate_business_payload("products", "[1,2,3]"), Err(ERR_PAYLOAD_INVALID));
        assert_eq!(validate_business_payload("products", "not json"), Err(ERR_PAYLOAD_INVALID));
        // duplicate top-level key → SYNC_PAYLOAD_DUPLICATE_KEY (M6-B3A1 §6)
        assert_eq!(
            validate_business_payload("products", r#"{"brand":"a","brand":"b"}"#),
            Err(ERR_PAYLOAD_DUPLICATE_KEY)
        );
        // nested JSON string value with braces/colons must NOT false-positive as duplicates
        assert!(validate_business_payload("products", r#"{"id":"p1","attributes":"{\"k\":1,\"j\":2}"}"#).is_ok());
    }

    // ── §3 — Rust and TS agree on every shared payload vector (semantic drift) ──
    // The SAME fixture the TS drift gate (test/m6b3a/manifest-drift.test.ts) runs. Both map each
    // vector to the fixture's `expect`, so transitively the two validators agree byte-for-byte.
    #[test]
    fn rust_ts_agree_on_shared_payload_vectors() {
        let fixture = include_str!("../../../test/fixtures/sync-payload-vectors.json");
        let parsed: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let vectors = parsed["vectors"].as_array().expect("vectors array");
        assert!(vectors.len() >= 20, "a non-trivial shared vector set");
        for v in vectors {
            let table = v["table"].as_str().unwrap();
            let action = v["action"].as_str().unwrap();
            let data = v["data"].as_str().unwrap();
            let expect = v["expect"].as_str(); // None when JSON null → accepted
            let got = change_contract_violation(table, action, data);
            assert_eq!(got, expect, "vector {table}/{action} data={data:?}");
        }
    }

    // -- M6-B3A2 6/8/12 -- DECODED-key duplicate detection (J1-J9), every object level --
    #[test]
    fn dup_scanner_decoded_keys_escapes_and_surrogates() {
        // clean -- no duplicate
        assert!(!contains_duplicate_json_key(
            "{\"changes\":[{\"table_name\":\"products\",\"record_id\":\"p1\",\"action\":\"insert\",\"data\":\"{}\"}]}"
        ));
        // J1 -- raw identical duplicate table_name / action / record_id / top-level
        assert!(contains_duplicate_json_key("{\"table_name\":\"a\",\"table_name\":\"b\"}"));
        assert!(contains_duplicate_json_key("{\"action\":\"insert\",\"action\":\"delete\"}"));
        assert!(contains_duplicate_json_key("{\"record_id\":\"a\",\"record_id\":\"b\"}"));
        assert!(contains_duplicate_json_key("{\"changes\":[],\"changes\":[]}"));
        // J3 -- duplicate in an object inside an array; J4 -- nested-object duplicate
        assert!(contains_duplicate_json_key("{\"arr\":[{\"k\":1,\"k\":2}]}"));
        assert!(contains_duplicate_json_key("{\"a\":{\"c\":1,\"c\":2}}"));
        assert!(!contains_duplicate_json_key("{\"a\":[{\"k\":1},{\"k\":2}],\"b\":{\"c\":3}}"));

        // J2 -- DECODED equality: different raw bytes, SAME decoded key -> duplicate.
        // "table_name" with a \\u escape for 't' / 'n' equals the plain spelling.
        assert!(contains_duplicate_json_key("{\"\\u0074able_name\":1,\"table_name\":2}"));
        assert!(contains_duplicate_json_key("{\"table_\\u006eame\":1,\"table_name\":2}"));
        assert!(contains_duplicate_json_key("{\"\\u0074able_name\":1,\"table_\\u006eame\":2}"));
        // every simple escape equals its \\uXXXX form (\\b \\f \\n \\r \\t \\" \\\\ \\/ ), both valid JSON.
        for pair in [
            "{\"a\\nb\":1,\"a\\u000ab\":2}",
            "{\"a\\tb\":1,\"a\\u0009b\":2}",
            "{\"a\\rb\":1,\"a\\u000db\":2}",
            "{\"a\\bb\":1,\"a\\u0008b\":2}",
            "{\"a\\fb\":1,\"a\\u000cb\":2}",
            "{\"a\\\"b\":1,\"a\\u0022b\":2}",
            "{\"a\\\\b\":1,\"a\\u005cb\":2}",
            "{\"a\\/b\":1,\"a/b\":2}",
        ] {
            assert!(contains_duplicate_json_key(pair), "decoded-equal escape must be a duplicate: {pair}");
        }

        // J8 -- a valid surrogate pair decodes to one codepoint. Equal pair (U+1F600 twice, escaped)
        // is a duplicate (serde_json decodes surrogates without error); two DIFFERENT codepoints are
        // not. Escaped only -> source stays ASCII.
        assert!(contains_duplicate_json_key("{\"k\\ud83d\\ude00\":1,\"k\\ud83d\\ude00\":2}"));
        assert!(!contains_duplicate_json_key("{\"k\\ud83d\\ude00\":1,\"k\\ud83d\\ude01\":2}"));

        // J9 -- braces / colon / quotes INSIDE string values never false-positive; a key CONTAINING
        // them is still compared correctly.
        assert!(!contains_duplicate_json_key("{\"a\":\"{x:1,x:2}\",\"b\":2}"));
        assert!(!contains_duplicate_json_key("{\"a\":\":::\",\"b\":\"{}{}\"}"));
        assert!(contains_duplicate_json_key("{\"a:b\":1,\"a:b\":2}"));
        assert!(contains_duplicate_json_key("{\"a{b\":1,\"a{b\":2}"));

        // J5/J6/J7 -- malformed \\u / lone surrogates are a serde_json PARSE error, never a duplicate
        // (returns false; the caller's real parse surfaces the 400).
        assert!(!contains_duplicate_json_key("{\"a\\uZZZZb\":1}"));
        assert!(!contains_duplicate_json_key("{\"a\\ud83db\":1}"));
        assert!(!contains_duplicate_json_key("{\"a\\ude00b\":1}"));
        assert!(!contains_duplicate_json_key("not json at all"));
        assert!(!contains_duplicate_json_key(""));

        // J10 -- an overlong key must not crash or DoS the scanner (it is bounded by the 50 MB body
        // limit upstream). A duplicated long key is detected; a single long key is not a duplicate.
        let long_key = "k".repeat(100_000);
        assert!(contains_duplicate_json_key(&format!("{{\"{long_key}\":1,\"{long_key}\":2}}")));
        assert!(!contains_duplicate_json_key(&format!("{{\"{long_key}\":1,\"other\":2}}")));
    }

    #[test]
    fn operation_gate() {
        assert!(is_operation_allowed("products", "insert"));
        assert!(is_operation_allowed("products", "update"));
        assert!(is_operation_allowed("products", "delete"));
        assert!(!is_operation_allowed("products", "drop"));
        assert!(!is_operation_allowed("tenants", "insert")); // unknown table → no ops
    }
}
