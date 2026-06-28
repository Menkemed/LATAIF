//! Settlement-payload syntactic validation (the A0b `schemaCases`).
//!
//! This small module composes the single-purpose validators (operation type,
//! operation id, timestamp, integer types) into the exact ordered check the A0b
//! contract defines for a settlement payload. It performs **only** syntactic
//! validation — it accepts no operation, resolves no handler and touches no
//! state.

use crate::protocol::error::ProtocolError;
use crate::protocol::identity::is_canonical_uuid;
use crate::protocol::integer::validate_types;
use crate::protocol::operation_type::is_valid_operation_type;
use serde_json::Value;

/// True iff `t` matches the frozen UTC business-timestamp pattern
/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
pub fn is_business_timestamp(t: &str) -> bool {
    let b = t.as_bytes();
    if b.len() != 24 {
        return false;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    (0..4).all(digit)
        && b[4] == b'-'
        && digit(5)
        && digit(6)
        && b[7] == b'-'
        && digit(8)
        && digit(9)
        && b[10] == b'T'
        && digit(11)
        && digit(12)
        && b[13] == b':'
        && digit(14)
        && digit(15)
        && b[16] == b':'
        && digit(17)
        && digit(18)
        && b[19] == b'.'
        && digit(20)
        && digit(21)
        && digit(22)
        && b[23] == b'Z'
}

/// Validate a settlement payload's syntactic shape in the frozen order:
/// `operationType` → `operationId` → `businessTimestamp` → integer-typed fields.
pub fn validate_settlement_payload(payload: &Value) -> Result<(), ProtocolError> {
    let op_type = payload.get("operationType").and_then(|v| v.as_str());
    if !op_type.map(is_valid_operation_type).unwrap_or(false) {
        return Err(ProtocolError::InvalidOperationType);
    }
    let op_id = payload.get("operationId").and_then(|v| v.as_str());
    if !op_id.map(is_canonical_uuid).unwrap_or(false) {
        return Err(ProtocolError::InvalidOperationId);
    }
    let ts = payload.get("businessTimestamp").and_then(|v| v.as_str());
    if !ts.map(is_business_timestamp).unwrap_or(false) {
        return Err(ProtocolError::BadTimestamp);
    }
    validate_types(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timestamp_pattern() {
        assert!(is_business_timestamp("2026-01-15T10:30:00.000Z"));
        assert!(!is_business_timestamp("2026-01-15 10:30:00Z"));
    }

    #[test]
    fn settlement_order() {
        let base = json!({
            "protocolVersion": 4,
            "operationType": "APPLY_SUPPLIER_CREDIT_TO_EXPENSES",
            "operationId": "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
            "businessTimestamp": "2026-01-15T10:30:00.000Z",
            "requestedAmountFils": "100000"
        });
        assert_eq!(validate_settlement_payload(&base), Ok(()));

        let mut bad_type = base.clone();
        bad_type["operationType"] = json!("apply");
        assert_eq!(
            validate_settlement_payload(&bad_type),
            Err(ProtocolError::InvalidOperationType)
        );

        let mut bad_id = base.clone();
        bad_id["operationId"] = json!("not-a-uuid");
        assert_eq!(
            validate_settlement_payload(&bad_id),
            Err(ProtocolError::InvalidOperationId)
        );

        let mut bad_ts = base.clone();
        bad_ts["businessTimestamp"] = json!("nope");
        assert_eq!(
            validate_settlement_payload(&bad_ts),
            Err(ProtocolError::BadTimestamp)
        );
    }
}
