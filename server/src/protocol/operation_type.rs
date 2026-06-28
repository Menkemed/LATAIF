//! `operationType` syntactic validation.
//!
//! A1b validates only the syntactic form `^[A-Z][A-Z0-9_]{2,63}$` (a hand-rolled
//! ASCII check accepting exactly that language — no regex dependency). There is
//! no registry and no handler resolution: a syntactically valid type is not
//! checked against any set of "registered" types.

use crate::protocol::error::ProtocolError;

/// The pilot operation type.
pub const PILOT_OPERATION_TYPE: &str = "APPLY_SUPPLIER_CREDIT_TO_EXPENSES";

/// True iff `t` matches `^[A-Z][A-Z0-9_]{2,63}$` (length 3..=64; first byte an
/// ASCII uppercase letter; the rest uppercase letters, digits or `_`).
pub fn is_valid_operation_type(t: &str) -> bool {
    let b = t.as_bytes();
    if b.len() < 3 || b.len() > 64 {
        return false;
    }
    if !b[0].is_ascii_uppercase() {
        return false;
    }
    b[1..]
        .iter()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// Validate `operationType`, mapping a syntactic failure to the frozen code.
pub fn validate_operation_type(t: &str) -> Result<(), ProtocolError> {
    if is_valid_operation_type(t) {
        Ok(())
    } else {
        Err(ProtocolError::InvalidOperationType)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pilot_is_valid() {
        assert!(is_valid_operation_type(PILOT_OPERATION_TYPE));
    }

    #[test]
    fn length_bounds() {
        assert!(!is_valid_operation_type("AB")); // 2 chars, too short
        assert!(is_valid_operation_type("ABC")); // 3 chars, minimum
        assert!(is_valid_operation_type(&format!("A{}", "B".repeat(63)))); // 64, max
        assert!(!is_valid_operation_type(&format!("A{}", "B".repeat(64)))); // 65, too long
    }

    #[test]
    fn shape_rules() {
        assert!(!is_valid_operation_type("apply_supplier_credit")); // lowercase
        assert!(!is_valid_operation_type("9APPLY")); // leading digit
        assert!(is_valid_operation_type("A1_B2"));
    }

    #[test]
    fn validate_maps_code() {
        assert_eq!(
            validate_operation_type("ab"),
            Err(ProtocolError::InvalidOperationType)
        );
        assert_eq!(validate_operation_type("ABC"), Ok(()));
    }
}
