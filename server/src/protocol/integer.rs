//! Field/schema-based integer-wire-type validation (no global number ban).
//!
//! - 64-bit DOMAIN values are canonical i64 decimal **strings** (keys ending in
//!   `Fils` or `Revision`, or `serverSequence`).
//! - small SCHEMA-bound structural integers are bounded JSON integers
//!   (`protocolVersion` == 4; `mutationCount` / `ordinal` are u32).
//! - a JSON number at any other field is rejected.

use crate::protocol::error::ProtocolError;
use serde_json::Value;

/// Inclusive maximum for u32 fields (`4294967295`).
pub const U32_MAX_I64: i64 = 4_294_967_295;

/// A field carries a 64-bit domain value iff its key ends with `Fils` or
/// `Revision`, or is exactly `serverSequence`.
pub fn is_i64_key(key: &str) -> bool {
    key.ends_with("Fils") || key.ends_with("Revision") || key == "serverSequence"
}

/// A field is a bounded u32 structural integer iff its key is `mutationCount`
/// or `ordinal`.
pub fn is_u32_key(key: &str) -> bool {
    key == "mutationCount" || key == "ordinal"
}

/// Validate a canonical i64 decimal string and return its parsed value.
pub fn validate_i64_string(v: &Value) -> Result<i64, ProtocolError> {
    let s = match v {
        Value::String(s) => s,
        _ => return Err(ProtocolError::ExpectedI64String),
    };
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return Err(ProtocolError::I64NotCanonical);
    }
    if s.len() > 1 && s.as_bytes()[0] == b'0' {
        return Err(ProtocolError::I64LeadingZero);
    }
    s.parse::<i64>().map_err(|_| ProtocolError::IntOutOfRange)
}

/// Validate a bounded u32 JSON integer and return its value.
pub fn validate_u32(v: &Value) -> Result<u32, ProtocolError> {
    match v {
        Value::String(_) => Err(ProtocolError::ExpectedU32Integer),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i < 0 {
                    Err(ProtocolError::U32Negative)
                } else if i > U32_MAX_I64 {
                    Err(ProtocolError::U32OutOfRange)
                } else {
                    Ok(i as u32)
                }
            } else if n.as_u64().is_some() {
                // Positive but beyond i64 range → above the u32 maximum.
                Err(ProtocolError::U32OutOfRange)
            } else {
                Err(ProtocolError::U32NotInteger)
            }
        }
        _ => Err(ProtocolError::U32NotInteger),
    }
}

/// Validate `protocolVersion`: a JSON integer, exactly `4`.
pub fn validate_protocol_version(v: &Value) -> Result<(), ProtocolError> {
    match v {
        Value::String(_) => Err(ProtocolError::ExpectedProtocolVersionInteger),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i != 4 {
                    Err(ProtocolError::UnsupportedProtocolVersion)
                } else {
                    Ok(())
                }
            } else if n.as_u64().is_some() {
                Err(ProtocolError::UnsupportedProtocolVersion)
            } else {
                Err(ProtocolError::ProtocolVersionNotInteger)
            }
        }
        _ => Err(ProtocolError::ProtocolVersionNotInteger),
    }
}

/// Recursively enforce the field/schema integer rules over a JSON value. A JSON
/// number is permitted only where the schema defines a bounded integer; any
/// other number is rejected with [`ProtocolError::JsonNumberNotAllowed`].
pub fn validate_types(v: &Value) -> Result<(), ProtocolError> {
    match v {
        Value::Array(a) => {
            for e in a {
                validate_types(e)?;
            }
            Ok(())
        }
        Value::Object(m) => {
            // Deterministic traversal (frozen A0b §2.3): validate members in
            // ascending UTF-8 byte order of their names, NOT in the map's own
            // iteration order. Rust's `str` ordering is byte-lexicographic, so an
            // explicit key sort makes the first-error-wins outcome independent of
            // serde_json's map representation (BTreeMap today, IndexMap under the
            // `preserve_order` feature) and of JSON insertion order. For each
            // member the key is classified first, then the value is recursed.
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            for k in keys {
                let val = &m[k];
                if is_i64_key(k) {
                    validate_i64_string(val)?;
                } else if k == "protocolVersion" {
                    validate_protocol_version(val)?;
                } else if is_u32_key(k) {
                    validate_u32(val)?;
                } else if val.is_number() {
                    return Err(ProtocolError::JsonNumberNotAllowed);
                } else {
                    validate_types(val)?;
                }
            }
            Ok(())
        }
        Value::Number(_) => Err(ProtocolError::JsonNumberNotAllowed),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn i64_string_rules() {
        assert_eq!(
            validate_i64_string(&json!("9223372036854775807")),
            Ok(i64::MAX)
        );
        assert_eq!(
            validate_i64_string(&json!("9223372036854775808")),
            Err(ProtocolError::IntOutOfRange)
        );
        assert_eq!(
            validate_i64_string(&json!(100000)),
            Err(ProtocolError::ExpectedI64String)
        );
        assert_eq!(
            validate_i64_string(&json!("100.5")),
            Err(ProtocolError::I64NotCanonical)
        );
        assert_eq!(
            validate_i64_string(&json!("00100")),
            Err(ProtocolError::I64LeadingZero)
        );
        assert_eq!(validate_i64_string(&json!("0")), Ok(0));
    }

    #[test]
    fn u32_rules() {
        assert_eq!(validate_u32(&json!(0)), Ok(0));
        assert_eq!(validate_u32(&json!(4294967295u64)), Ok(u32::MAX));
        assert_eq!(
            validate_u32(&json!(4294967296u64)),
            Err(ProtocolError::U32OutOfRange)
        );
        assert_eq!(validate_u32(&json!(-1)), Err(ProtocolError::U32Negative));
        assert_eq!(validate_u32(&json!(1.5)), Err(ProtocolError::U32NotInteger));
        assert_eq!(
            validate_u32(&json!("1")),
            Err(ProtocolError::ExpectedU32Integer)
        );
    }

    #[test]
    fn protocol_version_rules() {
        assert_eq!(validate_protocol_version(&json!(4)), Ok(()));
        assert_eq!(
            validate_protocol_version(&json!("4")),
            Err(ProtocolError::ExpectedProtocolVersionInteger)
        );
        assert_eq!(
            validate_protocol_version(&json!(5)),
            Err(ProtocolError::UnsupportedProtocolVersion)
        );
        assert_eq!(
            validate_protocol_version(&json!(4.5)),
            Err(ProtocolError::ProtocolVersionNotInteger)
        );
    }

    #[test]
    fn stray_number_rejected_but_bounded_integers_allowed() {
        assert_eq!(
            validate_types(&json!({ "protocolVersion": 4, "ordinal": 0 })),
            Ok(())
        );
        assert_eq!(
            validate_types(&json!({ "supplierTier": 3 })),
            Err(ProtocolError::JsonNumberNotAllowed)
        );
        assert_eq!(
            validate_types(&json!({ "requestedAmountFils": "100000" })),
            Ok(())
        );
    }

    /// Multi-error determinism: with several invalid fields, the reported code is
    /// the one for the member that sorts FIRST by UTF-8 byte order — never the one
    /// that happens to appear first in the input. Each pair is the same two fields
    /// in both insertion orders and must yield the identical code, matching the
    /// A0b `multi-error-*` fixtures exactly.
    #[test]
    fn multi_error_first_in_byte_order_wins() {
        // mutationCount (u32) < requestedAmountFils (i64) → EXPECTED_U32_INTEGER
        for input in [
            json!({ "mutationCount": "x", "requestedAmountFils": 100000 }),
            json!({ "requestedAmountFils": 100000, "mutationCount": "x" }),
        ] {
            assert_eq!(
                validate_types(&input),
                Err(ProtocolError::ExpectedU32Integer)
            );
        }
        // protocolVersion < requestedAmountFils → EXPECTED_PROTOCOL_VERSION_INTEGER
        for input in [
            json!({ "protocolVersion": "4", "requestedAmountFils": 100000 }),
            json!({ "requestedAmountFils": 100000, "protocolVersion": "4" }),
        ] {
            assert_eq!(
                validate_types(&input),
                Err(ProtocolError::ExpectedProtocolVersionInteger)
            );
        }
        // ordinal (u32) < supplierTier (stray number) → U32_NEGATIVE
        for input in [
            json!({ "ordinal": -1, "supplierTier": 3 }),
            json!({ "supplierTier": 3, "ordinal": -1 }),
        ] {
            assert_eq!(validate_types(&input), Err(ProtocolError::U32Negative));
        }
        // nested object: recursion preserves the byte-order traversal
        for input in [
            json!({ "wrapper": { "mutationCount": "x", "requestedAmountFils": 100000 } }),
            json!({ "wrapper": { "requestedAmountFils": 100000, "mutationCount": "x" } }),
        ] {
            assert_eq!(
                validate_types(&input),
                Err(ProtocolError::ExpectedU32Integer)
            );
        }
    }
}
