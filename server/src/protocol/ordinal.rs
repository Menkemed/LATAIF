//! Deterministic ordinals from canonical-JSON sort keys.
//!
//! An ordinal is the 0-based index after sorting on a canonical key by UTF-8
//! bytes (never locale-aware). Allocation keys are
//! `canonical-json([expenseId, creditId])`; ledger-leg keys are
//! `canonical-json([legRole, sourceId, account, direction, counterpartyType,
//! counterpartyId, amountFils])`. `legRole` is never dropped. A repeated key is
//! rejected.

use crate::protocol::canonical::canon;
use crate::protocol::error::ProtocolError;
use serde_json::Value;

/// Canonical JSON of an array of string components (infallible for strings).
fn canon_string_array(components: &[&str]) -> String {
    let arr = Value::Array(
        components
            .iter()
            .map(|s| Value::String((*s).to_string()))
            .collect(),
    );
    canon(&arr).expect("canonical-json of a string array is infallible")
}

/// A supplier-credit allocation (one expense settled by one credit).
#[derive(Debug, Clone)]
pub struct Allocation {
    pub expense_id: String,
    pub credit_id: String,
}

/// An allocation after sorting, with its assigned ordinal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedAllocation {
    pub ordinal: u32,
    pub canonical_key: String,
    pub expense_id: String,
    pub credit_id: String,
}

/// `canonical-json([expenseId, creditId])`.
pub fn allocation_canonical_key(a: &Allocation) -> String {
    canon_string_array(&[&a.expense_id, &a.credit_id])
}

/// Sort allocations by canonical key (UTF-8 bytes), assign dense ordinals, and
/// reject a duplicate key with [`ProtocolError::DuplicateAllocationKey`].
pub fn order_allocations(items: &[Allocation]) -> Result<Vec<OrderedAllocation>, ProtocolError> {
    let mut keyed: Vec<(String, &Allocation)> = items
        .iter()
        .map(|a| (allocation_canonical_key(a), a))
        .collect();
    if has_duplicate_key(&keyed) {
        return Err(ProtocolError::DuplicateAllocationKey);
    }
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(keyed
        .into_iter()
        .enumerate()
        .map(|(i, (key, a))| OrderedAllocation {
            ordinal: i as u32,
            canonical_key: key,
            expense_id: a.expense_id.clone(),
            credit_id: a.credit_id.clone(),
        })
        .collect())
}

/// A ledger leg (one balanced effect of an operation).
#[derive(Debug, Clone)]
pub struct LedgerLeg {
    pub leg_role: String,
    pub source_id: String,
    pub account: String,
    pub direction: String,
    pub counterparty_type: String,
    pub counterparty_id: String,
    pub amount_fils: String,
}

/// A ledger leg after sorting, with its assigned ordinal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderedLedgerLeg {
    pub ordinal: u32,
    pub canonical_key: String,
    pub direction: String,
    pub account: String,
}

/// `canonical-json([legRole, sourceId, account, direction, counterpartyType,
/// counterpartyId, amountFils])`.
pub fn ledger_leg_canonical_key(l: &LedgerLeg) -> String {
    canon_string_array(&[
        &l.leg_role,
        &l.source_id,
        &l.account,
        &l.direction,
        &l.counterparty_type,
        &l.counterparty_id,
        &l.amount_fils,
    ])
}

/// Sort ledger legs by canonical key (UTF-8 bytes), assign dense ordinals, and
/// reject a duplicate key with [`ProtocolError::DuplicateLedgerEffectKey`].
pub fn order_ledger_legs(items: &[LedgerLeg]) -> Result<Vec<OrderedLedgerLeg>, ProtocolError> {
    let mut keyed: Vec<(String, &LedgerLeg)> = items
        .iter()
        .map(|l| (ledger_leg_canonical_key(l), l))
        .collect();
    if has_duplicate_key(&keyed) {
        return Err(ProtocolError::DuplicateLedgerEffectKey);
    }
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(keyed
        .into_iter()
        .enumerate()
        .map(|(i, (key, l))| OrderedLedgerLeg {
            ordinal: i as u32,
            canonical_key: key,
            direction: l.direction.clone(),
            account: l.account.clone(),
        })
        .collect())
}

fn has_duplicate_key<T>(keyed: &[(String, T)]) -> bool {
    let mut keys: Vec<&String> = keyed.iter().map(|(k, _)| k).collect();
    keys.sort();
    keys.windows(2).any(|w| w[0] == w[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocations_sorted_with_ordinals() {
        let items = vec![
            Allocation {
                expense_id: "exp-2".into(),
                credit_id: "cred-1".into(),
            },
            Allocation {
                expense_id: "exp-1".into(),
                credit_id: "cred-1".into(),
            },
            Allocation {
                expense_id: "exp-1".into(),
                credit_id: "cred-2".into(),
            },
        ];
        let out = order_allocations(&items).unwrap();
        assert_eq!(out[0].canonical_key, "[\"exp-1\",\"cred-1\"]");
        assert_eq!(out[0].ordinal, 0);
        assert_eq!(out[1].canonical_key, "[\"exp-1\",\"cred-2\"]");
        assert_eq!(out[2].canonical_key, "[\"exp-2\",\"cred-1\"]");
    }

    #[test]
    fn duplicate_allocation_rejected() {
        let items = vec![
            Allocation {
                expense_id: "exp-1".into(),
                credit_id: "cred-1".into(),
            },
            Allocation {
                expense_id: "exp-1".into(),
                credit_id: "cred-1".into(),
            },
        ];
        assert_eq!(
            order_allocations(&items),
            Err(ProtocolError::DuplicateAllocationKey)
        );
    }

    #[test]
    fn duplicate_ledger_leg_rejected() {
        let leg = LedgerLeg {
            leg_role: "AP_SETTLE".into(),
            source_id: "s1".into(),
            account: "ACCOUNTS_PAYABLE".into(),
            direction: "DEBIT".into(),
            counterparty_type: "SUPPLIER".into(),
            counterparty_id: "sup-1".into(),
            amount_fils: "60000".into(),
        };
        let items = vec![leg.clone(), leg];
        assert_eq!(
            order_ledger_legs(&items),
            Err(ProtocolError::DuplicateLedgerEffectKey)
        );
    }
}
