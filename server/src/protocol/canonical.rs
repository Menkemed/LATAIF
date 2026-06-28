//! LCJ-v4 canonical JSON and the SHA-256 payload hash.
//!
//! LCJ-v4 = a restricted RFC 8785 / JCS profile with NFC normalization **inside**
//! the hash boundary and canonical decimal serialization for permitted integers.
//! Strings are NFC-normalized before escaping; object member names must be ASCII
//! `[A-Za-z0-9_]+` and are sorted by byte; arrays preserve order; the payload
//! hash is SHA-256 over the canonical UTF-8 bytes (lowercase hex, 64 chars).

use crate::protocol::error::ProtocolError;
use crate::protocol::integer::validate_types;
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// NFC-normalize and JCS-escape a string into a quoted canonical token.
fn canon_string(s: &str) -> String {
    let normalized: String = s.nfc().collect();
    let mut out = String::with_capacity(normalized.len() + 2);
    out.push('"');
    for ch in normalized.chars() {
        let cp = ch as u32;
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ if cp == 0x08 => out.push_str("\\b"),
            _ if cp == 0x09 => out.push_str("\\t"),
            _ if cp == 0x0a => out.push_str("\\n"),
            _ if cp == 0x0c => out.push_str("\\f"),
            _ if cp == 0x0d => out.push_str("\\r"),
            _ if cp < 0x20 => out.push_str(&format!("\\u{:04x}", cp)),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Serialize a JSON value to its LCJ-v4 canonical string. Pure canonicalization:
/// it enforces ASCII member names and integer numbers, but does **not** apply the
/// field/schema integer rules (use [`canonical_json_bytes`] for that).
pub fn canon(v: &Value) -> Result<String, ProtocolError> {
    match v {
        Value::Null => Ok("null".to_string()),
        Value::Bool(b) => Ok(if *b { "true" } else { "false" }.to_string()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.to_string())
            } else if let Some(u) = n.as_u64() {
                Ok(u.to_string())
            } else {
                Err(ProtocolError::NumberNotInteger)
            }
        }
        Value::String(s) => Ok(canon_string(s)),
        Value::Array(a) => {
            let mut parts = Vec::with_capacity(a.len());
            for e in a {
                parts.push(canon(e)?);
            }
            Ok(format!("[{}]", parts.join(",")))
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            for k in &keys {
                if k.is_empty() || !k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
                    return Err(ProtocolError::NonAsciiKey);
                }
            }
            keys.sort();
            let mut parts = Vec::with_capacity(keys.len());
            for k in keys {
                parts.push(format!("{}:{}", canon_string(k), canon(&m[k])?));
            }
            Ok(format!("{{{}}}", parts.join(",")))
        }
    }
}

/// Validate the field/schema integer rules, then return the canonical UTF-8
/// bytes. This is the byte basis for the payload hash.
pub fn canonical_json_bytes(v: &Value) -> Result<Vec<u8>, ProtocolError> {
    validate_types(v)?;
    Ok(canon(v)?.into_bytes())
}

/// Lowercase-hex SHA-256 over a byte slice (via the `sha2` crate).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// SHA-256 payload hash (lowercase hex, 64 chars) over the LCJ-v4 canonical
/// bytes of a type-valid value.
pub fn payload_hash_hex(v: &Value) -> Result<String, ProtocolError> {
    Ok(sha256_hex(&canonical_json_bytes(v)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sha256_known_answers() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn nfc_and_nfd_hash_equal() {
        let nfc = json!({ "memo": "caf\u{00e9}" });
        let nfd = json!({ "memo": "cafe\u{0301}" });
        assert_ne!(nfc, nfd, "the two inputs must differ before normalization");
        assert_eq!(
            payload_hash_hex(&nfc).unwrap(),
            payload_hash_hex(&nfd).unwrap()
        );
    }

    #[test]
    fn distinct_strings_distinct_hashes() {
        let a = json!({ "memo": "a" });
        let b = json!({ "memo": "b" });
        assert_ne!(payload_hash_hex(&a).unwrap(), payload_hash_hex(&b).unwrap());
    }

    #[test]
    fn keys_sorted_and_member_order_independent() {
        let a = json!({ "b": "2", "a": "1" });
        let b = json!({ "a": "1", "b": "2" });
        assert_eq!(canon(&a).unwrap(), "{\"a\":\"1\",\"b\":\"2\"}");
        assert_eq!(canon(&a).unwrap(), canon(&b).unwrap());
    }

    #[test]
    fn non_ascii_key_rejected() {
        let v = json!({ "mémo": "x" });
        assert_eq!(canon(&v), Err(ProtocolError::NonAsciiKey));
    }

    /// Object-member-name rule `^[A-Za-z0-9_]+$` (frozen): ASCII letters, digits
    /// and underscore, at least one character; a leading digit IS allowed (unlike
    /// `operationType`). Member names are NEVER NFC-normalized — only string
    /// VALUES are normalized inside the hash boundary. Mirrors the A0b `key-*`
    /// fixtures, asserted both via `canon` and the full canonical-bytes path.
    #[test]
    fn object_key_ascii_rule() {
        // allowed
        assert_eq!(canon(&json!({ "abc": "1" })).unwrap(), "{\"abc\":\"1\"}");
        assert_eq!(canon(&json!({ "A1_b": "1" })).unwrap(), "{\"A1_b\":\"1\"}");
        assert_eq!(canon(&json!({ "9abc": "1" })).unwrap(), "{\"9abc\":\"1\"}");
        // rejected → NON_ASCII_KEY (empty, hyphen, space, non-ASCII)
        for bad in [
            json!({ "": "1" }),
            json!({ "a-b": "1" }),
            json!({ "a b": "1" }),
            json!({ "mémo": "1" }),
        ] {
            assert_eq!(canon(&bad), Err(ProtocolError::NonAsciiKey));
            assert_eq!(
                canonical_json_bytes(&bad).err(),
                Some(ProtocolError::NonAsciiKey)
            );
        }
    }
}
