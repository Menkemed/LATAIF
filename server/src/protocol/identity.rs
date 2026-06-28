//! Deterministic UUIDv5 identities (server-derived child IDs).
//!
//! Child record IDs are `uuidv5(NS_LATAIF_FIN_OPS, name)` where `name` is built
//! from frozen component templates. No name component may contain `|`. Only
//! UUIDv5 is used — never UUIDv4 / randomness — so a retry derives identical IDs.

use crate::protocol::error::ProtocolError;
use uuid::Uuid;

/// Frozen protocol namespace
/// (`uuidv5(RFC4122-URL-namespace, "urn:lataif:fin-ops:protocol:v4")`).
pub const NS_LATAIF_FIN_OPS: &str = "9520db11-5c48-5d8f-a288-56f1876c0781";

/// Lowercase canonical UUIDv5 string for `name` under namespace `ns`.
pub fn uuid5(ns: &str, name: &str) -> String {
    let namespace = Uuid::parse_str(ns).expect("namespace must be a valid UUID");
    Uuid::new_v5(&namespace, name.as_bytes()).to_string()
}

/// True iff `s` is a canonical `8-4-4-4-12` lowercase/uppercase-hex UUID string.
pub fn is_canonical_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| {
            if i == 8 || i == 13 || i == 18 || i == 23 {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// A server-derived child identity. The borrowed component strings must not
/// contain the `|` delimiter.
#[derive(Debug, Clone, Copy)]
pub enum ChildId<'a> {
    /// `operationId + "|ledger-tx"`.
    LedgerTransaction { operation_id: &'a str },
    /// `operationId + "|exp-pmt|" + expenseId + "|" + creditId + "|" + ordinal`.
    ExpensePayment {
        operation_id: &'a str,
        expense_id: &'a str,
        credit_id: &'a str,
        ordinal: u32,
    },
    /// `operationId + "|entry|" + ordinal + "|" + direction + "|" + account`.
    LedgerEntry {
        operation_id: &'a str,
        ordinal: u32,
        direction: &'a str,
        account: &'a str,
    },
}

impl<'a> ChildId<'a> {
    /// The free-text components that must each be `|`-free (the ordinal, a
    /// rendered integer, can never contain `|`, so it is excluded).
    fn components(&self) -> Vec<&'a str> {
        match *self {
            ChildId::LedgerTransaction { operation_id } => vec![operation_id],
            ChildId::ExpensePayment {
                operation_id,
                expense_id,
                credit_id,
                ..
            } => vec![operation_id, expense_id, credit_id],
            ChildId::LedgerEntry {
                operation_id,
                direction,
                account,
                ..
            } => vec![operation_id, direction, account],
        }
    }

    /// The exact UUIDv5 name string, after verifying every component is
    /// `|`-free.
    pub fn name_string(&self) -> Result<String, ProtocolError> {
        if self.components().iter().any(|c| c.contains('|')) {
            return Err(ProtocolError::ChildIdComponentHasDelimiter);
        }
        Ok(match *self {
            ChildId::LedgerTransaction { operation_id } => format!("{}|ledger-tx", operation_id),
            ChildId::ExpensePayment {
                operation_id,
                expense_id,
                credit_id,
                ordinal,
            } => format!(
                "{}|exp-pmt|{}|{}|{}",
                operation_id, expense_id, credit_id, ordinal
            ),
            ChildId::LedgerEntry {
                operation_id,
                ordinal,
                direction,
                account,
            } => format!(
                "{}|entry|{}|{}|{}",
                operation_id, ordinal, direction, account
            ),
        })
    }

    /// Derive the deterministic UUIDv5 child ID.
    pub fn derive(&self) -> Result<String, ProtocolError> {
        Ok(uuid5(NS_LATAIF_FIN_OPS, &self.name_string()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_namespace_derivation() {
        assert_eq!(
            uuid5(
                "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
                "urn:lataif:fin-ops:protocol:v4"
            ),
            NS_LATAIF_FIN_OPS
        );
    }

    #[test]
    fn well_known_uuid5_vector() {
        assert_eq!(
            uuid5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
            "2ed6657d-e927-568b-95e1-2665a8aea6a2"
        );
    }

    #[test]
    fn child_id_deterministic() {
        let c = ChildId::LedgerTransaction {
            operation_id: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
        };
        assert_eq!(c.derive().unwrap(), "430f4321-f9ec-59c4-8508-797c370eb150");
        assert_eq!(c.derive().unwrap(), c.derive().unwrap());
    }

    #[test]
    fn pipe_in_component_rejected() {
        let c = ChildId::ExpensePayment {
            operation_id: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
            expense_id: "exp|1",
            credit_id: "cred-1",
            ordinal: 0,
        };
        assert_eq!(
            c.name_string(),
            Err(ProtocolError::ChildIdComponentHasDelimiter)
        );
        assert_eq!(c.derive(), Err(ProtocolError::ChildIdComponentHasDelimiter));
    }

    #[test]
    fn uuid_format_check() {
        assert!(is_canonical_uuid("aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa"));
        assert!(!is_canonical_uuid("not-a-uuid"));
    }
}
