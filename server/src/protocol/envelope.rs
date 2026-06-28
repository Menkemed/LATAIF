//! Operation-envelope validation (the unsplittable transport unit).
//!
//! Validation order (first failure wins) mirrors the A0b contract:
//! operationType → operationId → typed fields → serverSequence ≥ 1 →
//! mutationCount == mutations.len → unique ordinals → dense `{0…n-1}` →
//! canonical mutation order with `ordinal[i] == i` → canonical byte size ≤
//! `MAX_ENVELOPE_BYTES_V4`. A valid envelope yields its canonical string, UTF-8
//! byte length and SHA-256.

use crate::protocol::canonical::{canon, sha256_hex};
use crate::protocol::error::ProtocolError;
use crate::protocol::identity::is_canonical_uuid;
use crate::protocol::integer::validate_types;
use crate::protocol::operation_type::is_valid_operation_type;
use serde_json::Value;

/// Maximum canonical envelope size in bytes (exactly 1 MiB). A canonical
/// envelope of exactly this size is allowed; one byte more is rejected.
pub const MAX_ENVELOPE_BYTES_V4: usize = 1_048_576;

/// The result of validating an envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeValidation {
    pub canonical: String,
    pub utf8_byte_length: usize,
    pub sha256: String,
}

static NO_MUTATIONS: Vec<Value> = Vec::new();

/// Validate an operation envelope against the frozen A0b rules.
pub fn validate_envelope(env: &Value) -> Result<EnvelopeValidation, ProtocolError> {
    let op_type = env
        .get("operationType")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !is_valid_operation_type(op_type) {
        return Err(ProtocolError::InvalidOperationType);
    }
    let op_id = env
        .get("operationId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !is_canonical_uuid(op_id) {
        return Err(ProtocolError::InvalidOperationId);
    }

    // Typed-field rules (serverSequence i64 string, mutationCount/ordinal u32,
    // payload fils strings) — first typed failure wins.
    validate_types(env)?;

    let seq = env
        .get("serverSequence")
        .and_then(|v| v.as_str())
        .unwrap_or("0");
    if seq.parse::<i64>().unwrap_or(0) < 1 {
        return Err(ProtocolError::InvalidSequence);
    }

    let muts = env
        .get("mutations")
        .and_then(|v| v.as_array())
        .unwrap_or(&NO_MUTATIONS);
    let mutation_count = env
        .get("mutationCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(u64::MAX);
    if mutation_count != muts.len() as u64 {
        return Err(ProtocolError::MutationCountMismatch);
    }

    let ordinals: Vec<u64> = muts
        .iter()
        .map(|m| {
            m.get("ordinal")
                .and_then(|v| v.as_u64())
                .unwrap_or(u64::MAX)
        })
        .collect();

    let mut unique = ordinals.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != ordinals.len() {
        return Err(ProtocolError::DuplicateOrdinal);
    }

    let mut dense = ordinals.clone();
    dense.sort_unstable();
    for (i, o) in dense.iter().enumerate() {
        if *o != i as u64 {
            return Err(ProtocolError::OrdinalNotDense);
        }
    }

    // Canonical mutation order = sort by canonical-json([table, recordId]); the
    // ordinal at each canonical position must equal that position, and the array
    // as delivered must already be in that order.
    let mut keyed: Vec<(u64, String)> = Vec::with_capacity(muts.len());
    for m in muts {
        let table = m.get("table").cloned().unwrap_or(Value::Null);
        let record_id = m.get("recordId").cloned().unwrap_or(Value::Null);
        let key = canon(&Value::Array(vec![table, record_id]))?;
        let ordinal = m
            .get("ordinal")
            .and_then(|v| v.as_u64())
            .unwrap_or(u64::MAX);
        keyed.push((ordinal, key));
    }
    keyed.sort_by(|a, b| a.1.cmp(&b.1));
    for (i, (ordinal, _)) in keyed.iter().enumerate() {
        if *ordinal != i as u64 {
            return Err(ProtocolError::MutationOrderMismatch);
        }
    }
    for (i, ordinal) in ordinals.iter().enumerate() {
        if *ordinal != i as u64 {
            return Err(ProtocolError::MutationOrderMismatch);
        }
    }

    let canonical = canon(env)?;
    let utf8_byte_length = canonical.as_bytes().len();
    if utf8_byte_length > MAX_ENVELOPE_BYTES_V4 {
        return Err(ProtocolError::EnvelopeTooLarge);
    }
    let sha256 = sha256_hex(canonical.as_bytes());
    Ok(EnvelopeValidation {
        canonical,
        utf8_byte_length,
        sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_envelope() -> Value {
        json!({
            "operationId": "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
            "serverSequence": "5",
            "operationType": "APPLY_SUPPLIER_CREDIT_TO_EXPENSES",
            "branchId": "branch-a0b",
            "mutationCount": 1,
            "mutations": [
                { "ordinal": 0, "table": "expenses", "op": "update", "recordId": "exp-1", "payload": { "memo": "" } }
            ],
            "result": { "status": "accepted" }
        })
    }

    #[test]
    fn valid_envelope() {
        assert!(validate_envelope(&base_envelope()).is_ok());
    }

    #[test]
    fn envelope_at_exactly_one_mib_is_accepted_and_one_over_is_rejected() {
        let base = base_envelope();
        let base_len = validate_envelope(&base).unwrap().utf8_byte_length;
        let need = MAX_ENVELOPE_BYTES_V4 - base_len;

        let mut at_limit = base.clone();
        at_limit["mutations"][0]["payload"]["memo"] = Value::String("x".repeat(need));
        let r = validate_envelope(&at_limit).unwrap();
        assert_eq!(r.utf8_byte_length, MAX_ENVELOPE_BYTES_V4);

        let mut over = base;
        over["mutations"][0]["payload"]["memo"] = Value::String("x".repeat(need + 1));
        assert_eq!(
            validate_envelope(&over),
            Err(ProtocolError::EnvelopeTooLarge)
        );
    }

    #[test]
    fn duplicate_ordinal_rejected() {
        let mut env = base_envelope();
        env["mutationCount"] = json!(2);
        env["mutations"] = json!([
            { "ordinal": 0, "table": "a", "op": "insert", "recordId": "r1", "payload": {} },
            { "ordinal": 0, "table": "b", "op": "insert", "recordId": "r2", "payload": {} }
        ]);
        assert_eq!(
            validate_envelope(&env),
            Err(ProtocolError::DuplicateOrdinal)
        );
    }
}
