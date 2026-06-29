//! Exact BHD ↔ integer-fils conversion (1 BHD = 1000 fils).
//!
//! Authoritative settlement projections must never derive a balance from
//! `f64 * 1000`. This module converts a stored BHD amount through the JSON
//! number's own canonical decimal rendering — never through float
//! multiplication — into integer fils, rejecting everything the frozen row
//! contract forbids: negatives, more than three fractional digits, exponent
//! notation, NaN/Inf, malformed text and i64 overflow. An invalid value is
//! rejected, never silently rounded.

use serde_json::Value;

/// A typed money-conversion failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoneyError {
    /// The JSON value was not a number.
    NotANumber,
    /// A negative amount.
    Negative,
    /// More than three fractional digits (sub-fil precision).
    TooManyDecimals,
    /// Exponent notation (e.g. `1e3`) — not part of the row contract.
    Exponent,
    /// Empty, non-digit or otherwise malformed decimal text.
    Malformed,
    /// The resulting fils value does not fit in i64.
    OutOfRange,
}

impl MoneyError {
    /// A stable code for client-safe error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            MoneyError::NotANumber => "MONEY_NOT_A_NUMBER",
            MoneyError::Negative => "MONEY_NEGATIVE",
            MoneyError::TooManyDecimals => "MONEY_TOO_MANY_DECIMALS",
            MoneyError::Exponent => "MONEY_EXPONENT",
            MoneyError::Malformed => "MONEY_MALFORMED",
            MoneyError::OutOfRange => "MONEY_OUT_OF_RANGE",
        }
    }
}

/// Convert a JSON BHD amount to integer fils. Only `Value::Number` is accepted;
/// the conversion goes through the number's canonical decimal string, never
/// through `as_f64() * 1000`.
pub fn bhd_value_to_fils(v: &Value) -> Result<i64, MoneyError> {
    match v {
        Value::Number(n) => bhd_decimal_to_fils(&n.to_string()),
        _ => Err(MoneyError::NotANumber),
    }
}

/// Convert a canonical decimal string `int[.frac]` (1..=3 fractional digits) to
/// integer fils. Rejects sign, exponent, >3 decimals, malformed text, overflow.
pub fn bhd_decimal_to_fils(s: &str) -> Result<i64, MoneyError> {
    if s.is_empty() {
        return Err(MoneyError::Malformed);
    }
    if s.bytes().any(|b| b == b'e' || b == b'E') {
        return Err(MoneyError::Exponent);
    }
    if s.starts_with('-') {
        return Err(MoneyError::Negative);
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, f)) => (i, f),
        None => (s, ""),
    };
    // Integer part: at least one digit, all ASCII digits.
    if int_part.is_empty() || !int_part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(MoneyError::Malformed);
    }
    // A present decimal point demands exactly 1..=3 fractional digits.
    if s.contains('.') {
        if frac_part.is_empty() {
            return Err(MoneyError::Malformed);
        }
        if frac_part.len() > 3 {
            return Err(MoneyError::TooManyDecimals);
        }
        if !frac_part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(MoneyError::Malformed);
        }
    }
    let int_val: i64 = int_part.parse().map_err(|_| MoneyError::OutOfRange)?;
    // Right-pad the fractional digits to exactly three (milli-units = fils).
    let mut frac = [b'0'; 3];
    for (i, b) in frac_part.bytes().enumerate() {
        frac[i] = b;
    }
    let frac_val: i64 = std::str::from_utf8(&frac)
        .ok()
        .and_then(|t| t.parse().ok())
        .ok_or(MoneyError::Malformed)?;
    int_val
        .checked_mul(1000)
        .and_then(|x| x.checked_add(frac_val))
        .ok_or(MoneyError::OutOfRange)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn known_answers() {
        assert_eq!(bhd_value_to_fils(&json!(0)), Ok(0));
        assert_eq!(bhd_value_to_fils(&json!(1)), Ok(1000));
        assert_eq!(bhd_value_to_fils(&json!(1.2)), Ok(1200));
        assert_eq!(bhd_value_to_fils(&json!(1.23)), Ok(1230));
        assert_eq!(bhd_value_to_fils(&json!(1.234)), Ok(1234));
        assert_eq!(
            bhd_value_to_fils(&json!(1.2345)),
            Err(MoneyError::TooManyDecimals)
        );
        assert_eq!(bhd_value_to_fils(&json!(-1)), Err(MoneyError::Negative));
    }

    #[test]
    fn float_renderings() {
        assert_eq!(bhd_value_to_fils(&json!(100.0)), Ok(100000));
        assert_eq!(bhd_value_to_fils(&json!(100.5)), Ok(100500));
        assert_eq!(bhd_value_to_fils(&json!(0.001)), Ok(1));
        assert_eq!(bhd_value_to_fils(&json!(0.999)), Ok(999));
    }

    #[test]
    fn rejects_invalid() {
        assert_eq!(
            bhd_value_to_fils(&json!("100")),
            Err(MoneyError::NotANumber)
        );
        assert_eq!(bhd_value_to_fils(&json!(-0.5)), Err(MoneyError::Negative));
        assert_eq!(bhd_decimal_to_fils("1e3"), Err(MoneyError::Exponent));
        assert_eq!(
            bhd_decimal_to_fils("1.2345"),
            Err(MoneyError::TooManyDecimals)
        );
        assert_eq!(bhd_decimal_to_fils("1."), Err(MoneyError::Malformed));
        assert_eq!(bhd_decimal_to_fils(".5"), Err(MoneyError::Malformed));
        assert_eq!(bhd_decimal_to_fils("abc"), Err(MoneyError::Malformed));
        assert_eq!(bhd_decimal_to_fils(""), Err(MoneyError::Malformed));
        assert_eq!(
            bhd_decimal_to_fils("9223372036854776"),
            Err(MoneyError::OutOfRange)
        );
    }

    #[test]
    fn max_safe_value() {
        // i64::MAX fils = 9223372036854775.807 BHD
        assert_eq!(bhd_decimal_to_fils("9223372036854775.807"), Ok(i64::MAX));
    }
}
