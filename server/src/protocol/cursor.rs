//! Pure per-branch cursor / apply state machine (no persistence).
//!
//! `serverSequence` is a single global monotonic counter; a pull is for exactly
//! one branch with a cursor keyed per (plane, tenant, branch). Delivered
//! envelopes are sorted by `serverSequence`; for the pulled branch:
//! `serverSequence <= cursor` is an idempotent skip (the cursor never
//! regresses); an apply error blocks this and every later sequence (never
//! skipping ahead); otherwise apply and advance the cursor (it may advance even
//! for a non-mutating op). One branch never moves another's cursor.

/// The apply outcome of a delivered op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    Ok,
    Error,
}

/// A delivered op (its sequence is a canonical i64 string).
#[derive(Debug, Clone)]
pub struct DeliveredOp {
    pub server_sequence: String,
    pub branch_id: String,
    pub mutates: bool,
    pub apply_outcome: ApplyOutcome,
}

/// The result of applying delivered ops for one branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorRun {
    pub delivered_sorted_sequences: Vec<String>,
    pub applied_sequences: Vec<String>,
    pub mutated_sequences: Vec<String>,
    pub skipped_sequences: Vec<String>,
    pub blocked_sequences: Vec<String>,
    pub final_cursor: String,
}

/// Apply the delivered ops for `branch_id` starting from `initial_cursor`.
pub fn run_cursor(initial_cursor: &str, branch_id: &str, ops: &[DeliveredOp]) -> CursorRun {
    let mut sorted: Vec<&DeliveredOp> = ops.iter().collect();
    sorted.sort_by_key(|o| o.server_sequence.parse::<i64>().unwrap_or(0));

    let mut cursor: i64 = initial_cursor.parse().unwrap_or(0);
    let mut blocked = false;
    let mut delivered = Vec::new();
    let mut applied = Vec::new();
    let mut mutated = Vec::new();
    let mut skipped = Vec::new();
    let mut blocked_seqs = Vec::new();

    for o in sorted {
        if o.branch_id != branch_id {
            continue;
        }
        let seq = o.server_sequence.clone();
        let seq_n: i64 = seq.parse().unwrap_or(0);
        delivered.push(seq.clone());
        if blocked {
            blocked_seqs.push(seq);
            continue;
        }
        if seq_n <= cursor {
            skipped.push(seq);
            continue;
        }
        if o.apply_outcome == ApplyOutcome::Error {
            blocked = true;
            blocked_seqs.push(seq);
            continue;
        }
        applied.push(seq.clone());
        if o.mutates {
            mutated.push(seq);
        }
        cursor = seq_n;
    }

    CursorRun {
        delivered_sorted_sequences: delivered,
        applied_sequences: applied,
        mutated_sequences: mutated,
        skipped_sequences: skipped,
        blocked_sequences: blocked_seqs,
        final_cursor: cursor.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(seq: &str, branch: &str, mutates: bool, outcome: ApplyOutcome) -> DeliveredOp {
        DeliveredOp {
            server_sequence: seq.to_string(),
            branch_id: branch.to_string(),
            mutates,
            apply_outcome: outcome,
        }
    }

    #[test]
    fn apply_error_blocks_later() {
        let ops = vec![
            op("20", "branch-a", true, ApplyOutcome::Ok),
            op("40", "branch-a", true, ApplyOutcome::Error),
            op("60", "branch-a", true, ApplyOutcome::Ok),
        ];
        let r = run_cursor("0", "branch-a", &ops);
        assert_eq!(r.applied_sequences, vec!["20"]);
        assert_eq!(r.blocked_sequences, vec!["40", "60"]);
        assert_eq!(r.final_cursor, "20");
    }

    #[test]
    fn branch_isolation() {
        let ops = vec![
            op("10", "branch-a", true, ApplyOutcome::Ok),
            op("20", "branch-b", true, ApplyOutcome::Ok),
            op("40", "branch-b", true, ApplyOutcome::Ok),
            op("100", "branch-a", true, ApplyOutcome::Ok),
        ];
        let a = run_cursor("0", "branch-a", &ops);
        let b = run_cursor("0", "branch-b", &ops);
        assert_eq!(a.applied_sequences, vec!["10", "100"]);
        assert_eq!(a.final_cursor, "100");
        assert_eq!(b.applied_sequences, vec!["20", "40"]);
        assert_eq!(b.final_cursor, "40");
    }

    #[test]
    fn redeliver_is_skipped_cursor_never_regresses() {
        let ops = vec![op("10", "branch-a", true, ApplyOutcome::Ok)];
        let r = run_cursor("100", "branch-a", &ops);
        assert_eq!(r.skipped_sequences, vec!["10"]);
        assert_eq!(r.applied_sequences, Vec::<String>::new());
        assert_eq!(r.final_cursor, "100");
    }
}
