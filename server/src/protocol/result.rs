//! Final vs transient operation results and the idempotent-retry decision.
//!
//! Final (stored authoritative outcome): `accepted`, `conflict`,
//! `validation_rejected`. Transient (never stored as a final decision):
//! `FINANCE_NOT_BOOTSTRAPPED`, `READ_ONLY`, `SERVICE_UNAVAILABLE`, `DB_LOCKED`,
//! `RATE_LIMITED`, `INTERNAL_ERROR_BEFORE_COMMIT`, `UNKNOWN_COMMIT_STATUS`.

/// The three final statuses.
pub const FINAL_STATUSES: [&str; 3] = ["accepted", "conflict", "validation_rejected"];

/// The seven transient statuses.
pub const TRANSIENT_STATUSES: [&str; 7] = [
    "FINANCE_NOT_BOOTSTRAPPED",
    "READ_ONLY",
    "SERVICE_UNAVAILABLE",
    "DB_LOCKED",
    "RATE_LIMITED",
    "INTERNAL_ERROR_BEFORE_COMMIT",
    "UNKNOWN_COMMIT_STATUS",
];

/// True iff `status` is one of the three final statuses.
pub fn is_final_status(status: &str) -> bool {
    FINAL_STATUSES.contains(&status)
}

/// True iff `status` is one of the seven transient statuses.
pub fn is_transient_status(status: &str) -> bool {
    TRANSIENT_STATUSES.contains(&status)
}

/// A previously stored decision for an `operationId`.
#[derive(Debug, Clone)]
pub struct StoredDecision {
    pub exists: bool,
    /// The stored final status, if any.
    pub status: Option<String>,
    /// The stored payload hash, if any.
    pub hash: Option<String>,
}

/// An incoming (retried) request for an `operationId`.
#[derive(Debug, Clone)]
pub struct IncomingOperation {
    pub hash: String,
    /// The prior outcome observed by the client, if any.
    pub prior_outcome: Option<String>,
}

/// The decision for a retried request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryAction {
    /// A final decision is stored for the same hash → return the stored result.
    ReplayStored { result_status: String },
    /// A final decision is stored for a different hash on the same id.
    OperationIdReused,
    /// No stored decision; the prior outcome was specifically
    /// `UNKNOWN_COMMIT_STATUS` → query the committed status before retrying.
    StatusQuery,
    /// No stored decision; the same id+hash may be retried.
    RetryAllowed,
}

impl RetryAction {
    /// The stable action code.
    pub fn action_code(&self) -> &'static str {
        match self {
            RetryAction::ReplayStored { .. } => "REPLAY_STORED",
            RetryAction::OperationIdReused => "OPERATION_ID_REUSED",
            RetryAction::StatusQuery => "STATUS_QUERY",
            RetryAction::RetryAllowed => "RETRY_ALLOWED",
        }
    }
}

/// Classify a retry: at-most-once acceptance with idempotent replay.
pub fn classify_retry(stored: &StoredDecision, incoming: &IncomingOperation) -> RetryAction {
    if stored.exists {
        if stored.hash.as_deref() == Some(incoming.hash.as_str()) {
            RetryAction::ReplayStored {
                result_status: stored.status.clone().unwrap_or_default(),
            }
        } else {
            RetryAction::OperationIdReused
        }
    } else if incoming.prior_outcome.as_deref() == Some("UNKNOWN_COMMIT_STATUS") {
        // Only UNKNOWN_COMMIT_STATUS forces a status query before retry. The six
        // SAFE transients (FINANCE_NOT_BOOTSTRAPPED, READ_ONLY, SERVICE_UNAVAILABLE,
        // DB_LOCKED, RATE_LIMITED, INTERNAL_ERROR_BEFORE_COMMIT) and an absent prior
        // outcome are plain RETRY_ALLOWED. The distinction is enforced field-by-field
        // and never collapsed into a single "any transient" test.
        RetryAction::StatusQuery
    } else {
        RetryAction::RetryAllowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        assert!(is_final_status("accepted"));
        assert!(is_final_status("conflict"));
        assert!(is_final_status("validation_rejected"));
        assert!(!is_final_status("UNKNOWN_COMMIT_STATUS"));
        assert!(is_transient_status("DB_LOCKED"));
    }

    #[test]
    fn replay_same_hash() {
        let stored = StoredDecision {
            exists: true,
            status: Some("accepted".into()),
            hash: Some("h1".into()),
        };
        let incoming = IncomingOperation {
            hash: "h1".into(),
            prior_outcome: None,
        };
        assert_eq!(
            classify_retry(&stored, &incoming),
            RetryAction::ReplayStored {
                result_status: "accepted".into()
            }
        );
    }

    #[test]
    fn reuse_different_hash() {
        let stored = StoredDecision {
            exists: true,
            status: Some("accepted".into()),
            hash: Some("h1".into()),
        };
        let incoming = IncomingOperation {
            hash: "h2".into(),
            prior_outcome: None,
        };
        assert_eq!(
            classify_retry(&stored, &incoming),
            RetryAction::OperationIdReused
        );
    }

    #[test]
    fn unknown_commit_status_queries_first() {
        let stored = StoredDecision {
            exists: false,
            status: None,
            hash: None,
        };
        let incoming = IncomingOperation {
            hash: "h1".into(),
            prior_outcome: Some("UNKNOWN_COMMIT_STATUS".into()),
        };
        assert_eq!(classify_retry(&stored, &incoming), RetryAction::StatusQuery);
    }

    #[test]
    fn no_decision_retry_allowed() {
        let stored = StoredDecision {
            exists: false,
            status: None,
            hash: None,
        };
        let incoming = IncomingOperation {
            hash: "h1".into(),
            prior_outcome: None,
        };
        assert_eq!(
            classify_retry(&stored, &incoming),
            RetryAction::RetryAllowed
        );
    }

    /// Explicit per-code matrix over ALL seven transient prior outcomes when no
    /// final decision is stored. The six safe transients retry directly; ONLY
    /// `UNKNOWN_COMMIT_STATUS` queries first. Asserted code-by-code so a
    /// regression that collapses the two classes cannot pass silently.
    #[test]
    fn each_transient_prior_outcome_without_stored_decision() {
        let no_stored = StoredDecision {
            exists: false,
            status: None,
            hash: None,
        };
        let matrix: [(&str, RetryAction); 7] = [
            ("FINANCE_NOT_BOOTSTRAPPED", RetryAction::RetryAllowed),
            ("READ_ONLY", RetryAction::RetryAllowed),
            ("SERVICE_UNAVAILABLE", RetryAction::RetryAllowed),
            ("DB_LOCKED", RetryAction::RetryAllowed),
            ("RATE_LIMITED", RetryAction::RetryAllowed),
            ("INTERNAL_ERROR_BEFORE_COMMIT", RetryAction::RetryAllowed),
            ("UNKNOWN_COMMIT_STATUS", RetryAction::StatusQuery),
        ];
        // All six safe transients must be present and map to RETRY_ALLOWED.
        assert_eq!(
            matrix
                .iter()
                .filter(|(_, a)| *a == RetryAction::RetryAllowed)
                .count(),
            6
        );
        for (code, expected) in matrix {
            let incoming = IncomingOperation {
                hash: "h1".into(),
                prior_outcome: Some(code.to_string()),
            };
            assert_eq!(
                classify_retry(&no_stored, &incoming),
                expected,
                "transient prior outcome {code}"
            );
            // Every entry of the matrix is one of the seven frozen transients.
            assert!(is_transient_status(code), "{code} must be a transient code");
        }
    }
}
