//! A0b fixture-parity tests for the production `lataif_server::protocol` module.
//!
//! This is the THIRD independent implementation check of the frozen A0b contract
//! (alongside `test/a0b/verify-node.mjs` and `test/a0b/rust-verifier/`). It reads
//! the SAME pushed fixtures — `test/a0b/fixtures/*.json` — with NO copy, resolves
//! the path from `CARGO_MANIFEST_DIR` (working-directory independent), and drives
//! the production API. On any divergence the implementation is wrong, never the
//! fixture.

use lataif_server::protocol::canonical::{canonical_json_bytes, sha256_hex};
use lataif_server::protocol::cursor::{run_cursor, ApplyOutcome, DeliveredOp};
use lataif_server::protocol::envelope::validate_envelope;
use lataif_server::protocol::identity::{is_canonical_uuid, uuid5, ChildId, NS_LATAIF_FIN_OPS};
use lataif_server::protocol::integer::validate_u32;
use lataif_server::protocol::operation_type::is_valid_operation_type;
use lataif_server::protocol::ordinal::{
    order_allocations, order_ledger_legs, Allocation, LedgerLeg,
};
use lataif_server::protocol::result::{
    classify_retry, is_final_status, IncomingOperation, StoredDecision,
};
use lataif_server::protocol::schema::validate_settlement_payload;
use serde_json::Value;
use std::fs;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/a0b/fixtures");
const URL_NS: &str = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

fn load(name: &str) -> Value {
    let p = format!("{}/{}", FIX, name);
    serde_json::from_str(&fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {}", p, e)))
        .unwrap_or_else(|e| panic!("parse {}: {}", p, e))
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k)
        .and_then(|x| x.as_str())
        .unwrap_or_else(|| panic!("missing str {}", k))
}
fn u(v: &Value, k: &str) -> u64 {
    v.get(k)
        .and_then(|x| x.as_u64())
        .unwrap_or_else(|| panic!("missing u64 {}", k))
}
fn arr<'a>(v: &'a Value, k: &str) -> &'a Vec<Value> {
    v.get(k)
        .and_then(|x| x.as_array())
        .unwrap_or_else(|| panic!("missing arr {}", k))
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

/// Per-group case/assertion/failure counter.
struct Group {
    name: &'static str,
    cases: usize,
    pass: usize,
    fails: Vec<String>,
}
impl Group {
    fn new(name: &'static str) -> Self {
        Group {
            name,
            cases: 0,
            pass: 0,
            fails: Vec::new(),
        }
    }
    fn case(&mut self) {
        self.cases += 1;
    }
    fn eq<A: PartialEq + std::fmt::Debug>(&mut self, a: A, b: A, label: &str) {
        if a == b {
            self.pass += 1;
        } else {
            self.fails
                .push(format!("{}: got {:?} exp {:?}", label, a, b));
        }
    }
    fn ok(&mut self, c: bool, label: &str) {
        if c {
            self.pass += 1;
        } else {
            self.fails.push(label.to_string());
        }
    }
}

fn child_from(c: &Value) -> ChildId<'_> {
    let ord = || c.get("ordinal").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    match s(c, "kind") {
        "ledger-tx" => ChildId::LedgerTransaction {
            operation_id: s(c, "operationId"),
        },
        "exp-pmt" => ChildId::ExpensePayment {
            operation_id: s(c, "operationId"),
            expense_id: s(c, "expenseId"),
            credit_id: s(c, "creditId"),
            ordinal: ord(),
        },
        "ledger-entry" => ChildId::LedgerEntry {
            operation_id: s(c, "operationId"),
            ordinal: ord(),
            direction: s(c, "direction"),
            account: s(c, "account"),
        },
        other => panic!("unknown child kind {}", other),
    }
}

fn group_canonical_json() -> Group {
    let mut g = Group::new("canonical-json");
    let cj = load("canonical-json.json");
    let cases = arr(&cj, "canonicalCases");
    let find = |name: &str| cases.iter().find(|c| c["name"] == name).unwrap();
    for c in cases {
        g.case();
        let name = s(c, "name");
        let input = &c["input"];
        match canonical_json_bytes(input) {
            Ok(bytes) => {
                let canonical = String::from_utf8(bytes).unwrap();
                g.eq(s(c, "expect"), "valid", &format!("cj:{} expect", name));
                g.eq(
                    canonical.as_str(),
                    s(c, "canonical"),
                    &format!("cj:{} canonical", name),
                );
                g.eq(
                    canonical.len() as u64,
                    u(c, "utf8ByteLength"),
                    &format!("cj:{} len", name),
                );
                g.eq(
                    sha256_hex(canonical.as_bytes()),
                    s(c, "sha256").to_string(),
                    &format!("cj:{} sha256", name),
                );
                if let Some(o) = c.get("sameHashAs").and_then(|x| x.as_str()) {
                    g.eq(
                        s(c, "sha256"),
                        s(find(o), "sha256"),
                        &format!("cj:{} sameHashAs", name),
                    );
                }
                if let Some(o) = c.get("differentHashFrom").and_then(|x| x.as_str()) {
                    g.ok(
                        s(c, "sha256") != s(find(o), "sha256"),
                        &format!("cj:{} diffHash", name),
                    );
                }
                if let Some(o) = c.get("nfcEquivalence").and_then(|x| x.as_str()) {
                    let other = find(o);
                    g.ok(
                        c["input"] != other["input"],
                        &format!("cj:{} nfd!=nfc bytes", name),
                    );
                    let a = String::from_utf8(canonical_json_bytes(input).unwrap()).unwrap();
                    let b =
                        String::from_utf8(canonical_json_bytes(&other["input"]).unwrap()).unwrap();
                    g.eq(a, b, &format!("cj:{} canon(nfd)==canon(nfc)", name));
                }
            }
            Err(e) => g.eq(e.code(), s(c, "expect"), &format!("cj:{} reject", name)),
        }
    }
    for c in arr(&cj, "schemaCases") {
        g.case();
        let name = s(c, "name");
        let r = validate_settlement_payload(&c["input"]);
        if s(c, "expect") == "valid" {
            g.ok(
                r.is_ok(),
                &format!("cj-schema:{} expected valid, got {:?}", name, r),
            );
        } else {
            g.eq(
                r.err().map(|e| e.code()).unwrap_or("valid"),
                s(c, "expect"),
                &format!("cj-schema:{} reject", name),
            );
        }
    }
    g
}

fn group_uuidv5() -> Group {
    let mut g = Group::new("uuidv5");
    let u5 = load("uuidv5.json");
    g.case();
    g.eq(
        uuid5(URL_NS, s(&u5["namespace"]["derivation"], "nameString")),
        s(&u5["namespace"], "value").to_string(),
        "u5:namespace recompute",
    );
    g.eq(
        s(&u5["namespace"], "value"),
        NS_LATAIF_FIN_OPS,
        "u5:namespace frozen",
    );
    for kv in u5["knownAnswerVectors"]["uuid5"].as_array().unwrap() {
        g.case();
        g.eq(
            uuid5(s(kv, "namespace"), s(kv, "nameString")),
            s(kv, "expectedUuid").to_string(),
            &format!("u5:kav {}", s(kv, "name")),
        );
    }
    for kv in u5["knownAnswerVectors"]["sha256"].as_array().unwrap() {
        g.case();
        g.eq(
            sha256_hex(s(kv, "input").as_bytes()),
            s(kv, "hex").to_string(),
            "u5:sha256",
        );
    }
    let children = arr(&u5, "childIds");
    let cfind = |name: &str| children.iter().find(|c| c["name"] == name).unwrap();
    for c in children {
        g.case();
        let name = s(c, "name");
        let child = child_from(c);
        g.eq(
            child.name_string().unwrap(),
            s(c, "nameString").to_string(),
            &format!("u5:{} name", name),
        );
        g.eq(
            child.derive().unwrap(),
            s(c, "expectedUuid").to_string(),
            &format!("u5:{} uuid", name),
        );
        if let Some(o) = c.get("sameUuidAs").and_then(|x| x.as_str()) {
            g.eq(
                s(c, "expectedUuid"),
                s(cfind(o), "expectedUuid"),
                &format!("u5:{} sameUuid", name),
            );
        }
        if let Some(o) = c.get("differentUuidFrom").and_then(|x| x.as_str()) {
            g.ok(
                s(c, "expectedUuid") != s(cfind(o), "expectedUuid"),
                &format!("u5:{} diffUuid", name),
            );
        }
    }
    for c in arr(&u5, "rejectChildIds") {
        g.case();
        let got = child_from(c)
            .name_string()
            .err()
            .map(|e| e.code())
            .unwrap_or("ok");
        g.eq(got, s(c, "expect"), &format!("u5:{} reject", s(c, "name")));
    }
    {
        let a = &u5["ordinalStability"]["allocations"];
        let op = s(a, "operationId");
        let items: Vec<Allocation> = a["unsortedInput"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| Allocation {
                expense_id: s(x, "expenseId").into(),
                credit_id: s(x, "creditId").into(),
            })
            .collect();
        let sorted = order_allocations(&items).unwrap();
        for (i, oa) in sorted.iter().enumerate() {
            g.case();
            let e = &a["expectedSorted"][i];
            g.eq(
                oa.canonical_key.as_str(),
                s(e, "canonicalKey"),
                &format!("u5:alloc[{}] key", i),
            );
            g.eq(
                oa.ordinal as u64,
                e["ordinal"].as_u64().unwrap(),
                &format!("u5:alloc[{}] ord", i),
            );
            let uuid = ChildId::ExpensePayment {
                operation_id: op,
                expense_id: &oa.expense_id,
                credit_id: &oa.credit_id,
                ordinal: oa.ordinal,
            }
            .derive()
            .unwrap();
            g.eq(
                uuid,
                s(e, "expectedUuid").to_string(),
                &format!("u5:alloc[{}] uuid", i),
            );
        }
        g.case();
        let dups: Vec<Allocation> = a["duplicateRejectInput"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| Allocation {
                expense_id: s(x, "expenseId").into(),
                credit_id: s(x, "creditId").into(),
            })
            .collect();
        g.eq(
            order_allocations(&dups)
                .err()
                .map(|e| e.code())
                .unwrap_or("ok"),
            s(a, "duplicateExpect"),
            "u5:alloc dedup",
        );

        let lg = &u5["ordinalStability"]["ledgerLegs"];
        let lop = s(lg, "operationId");
        let leg_of = |x: &Value| LedgerLeg {
            leg_role: s(x, "legRole").into(),
            source_id: s(x, "sourceId").into(),
            account: s(x, "account").into(),
            direction: s(x, "direction").into(),
            counterparty_type: s(x, "counterpartyType").into(),
            counterparty_id: s(x, "counterpartyId").into(),
            amount_fils: s(x, "amountFils").into(),
        };
        let legs: Vec<LedgerLeg> = lg["unsortedInput"]
            .as_array()
            .unwrap()
            .iter()
            .map(leg_of)
            .collect();
        let lsorted = order_ledger_legs(&legs).unwrap();
        for (i, ol) in lsorted.iter().enumerate() {
            g.case();
            let e = &lg["expectedSorted"][i];
            g.eq(
                ol.canonical_key.as_str(),
                s(e, "canonicalKey"),
                &format!("u5:leg[{}] key", i),
            );
            g.eq(
                ol.ordinal as u64,
                e["ordinal"].as_u64().unwrap(),
                &format!("u5:leg[{}] ord", i),
            );
            let uuid = ChildId::LedgerEntry {
                operation_id: lop,
                ordinal: ol.ordinal,
                direction: &ol.direction,
                account: &ol.account,
            }
            .derive()
            .unwrap();
            g.eq(
                uuid,
                s(e, "expectedUuid").to_string(),
                &format!("u5:leg[{}] uuid", i),
            );
        }
        g.case();
        let ldups: Vec<LedgerLeg> = lg["duplicateRejectInput"]
            .as_array()
            .unwrap()
            .iter()
            .map(leg_of)
            .collect();
        g.eq(
            order_ledger_legs(&ldups)
                .err()
                .map(|e| e.code())
                .unwrap_or("ok"),
            s(lg, "duplicateExpect"),
            "u5:leg dedup",
        );
    }
    g
}

fn group_envelopes() -> Group {
    let mut g = Group::new("envelopes");
    let ev = load("envelopes.json");
    let max = u(&ev, "maxEnvelopeBytes") as usize;
    for c in arr(&ev, "u32Validity") {
        g.case();
        let got = validate_u32(&c["value"])
            .err()
            .map(|e| e.code())
            .unwrap_or("valid");
        g.eq(got, s(c, "expect"), &format!("env:u32 {}", s(c, "name")));
    }
    for c in arr(&ev, "cases") {
        g.case();
        let name = s(c, "name");
        match validate_envelope(&c["envelope"]) {
            Ok(r) => {
                g.eq(s(c, "expect"), "valid", &format!("env:{} expect", name));
                g.eq(
                    r.canonical.as_str(),
                    s(c, "canonical"),
                    &format!("env:{} canonical", name),
                );
                g.eq(
                    r.utf8_byte_length as u64,
                    u(c, "utf8ByteLength"),
                    &format!("env:{} len", name),
                );
                g.eq(
                    r.sha256,
                    s(c, "sha256").to_string(),
                    &format!("env:{} sha256", name),
                );
            }
            Err(e) => g.eq(e.code(), s(c, "expect"), &format!("env:{} reject", name)),
        }
    }
    {
        let sb = &ev["sizeBoundary"];
        let mut base = sb["baseEnvelope"].clone();
        base["mutations"][0]["payload"]["memo"] = Value::String(String::new());
        let base_len = validate_envelope(&base)
            .expect("boundary base valid")
            .utf8_byte_length;
        let need = max - base_len;

        g.case();
        let mut at = sb["baseEnvelope"].clone();
        at["mutations"][0]["payload"]["memo"] = Value::String("x".repeat(need));
        match validate_envelope(&at) {
            Ok(r) => g.eq(r.utf8_byte_length, max, "env:boundary at-limit length"),
            Err(e) => g
                .fails
                .push(format!("env:boundary at-limit rejected {}", e.code())),
        }

        g.case();
        let mut over = sb["baseEnvelope"].clone();
        over["mutations"][0]["payload"]["memo"] = Value::String("x".repeat(need + 1));
        g.eq(
            validate_envelope(&over)
                .err()
                .map(|e| e.code())
                .unwrap_or("valid"),
            s(sb, "overLimitExpect"),
            "env:boundary over-limit",
        );
    }
    g
}

fn op_of(o: &Value) -> DeliveredOp {
    DeliveredOp {
        server_sequence: s(o, "serverSequence").into(),
        branch_id: s(o, "branchId").into(),
        mutates: o["mutates"].as_bool().unwrap(),
        apply_outcome: if s(o, "applyOutcome") == "error" {
            ApplyOutcome::Error
        } else {
            ApplyOutcome::Ok
        },
    }
}

fn group_cursor() -> Group {
    let mut g = Group::new("cursor-sequences");
    let cs = load("cursor-sequences.json");
    for sc in arr(&cs, "scenarios") {
        g.case();
        let name = s(sc, "name");
        let ops: Vec<DeliveredOp> = arr(sc, "deliveredOps").iter().map(op_of).collect();
        let r = run_cursor(
            s(sc, "initialCursor"),
            s(&sc["branchKey"], "branchId"),
            &ops,
        );
        let e = &sc["expected"];
        g.eq(
            r.delivered_sorted_sequences,
            strs(&e["deliveredSortedSequences"]),
            &format!("cs:{} delivered", name),
        );
        g.eq(
            r.applied_sequences,
            strs(&e["appliedSequences"]),
            &format!("cs:{} applied", name),
        );
        g.eq(
            r.mutated_sequences,
            strs(&e["mutatedSequences"]),
            &format!("cs:{} mutated", name),
        );
        g.eq(
            r.skipped_sequences,
            strs(&e["skippedSequences"]),
            &format!("cs:{} skipped", name),
        );
        g.eq(
            r.blocked_sequences,
            strs(&e["blockedSequences"]),
            &format!("cs:{} blocked", name),
        );
        g.eq(
            r.final_cursor,
            s(e, "finalCursor").to_string(),
            &format!("cs:{} cursor", name),
        );
    }
    let iso = &cs["isolation"];
    let global: Vec<DeliveredOp> = iso["globalOps"]
        .as_array()
        .unwrap()
        .iter()
        .map(op_of)
        .collect();
    for side in ["branchA", "branchB"] {
        g.case();
        let b = &iso[side];
        let r = run_cursor(s(b, "initialCursor"), s(b, "branchId"), &global);
        g.eq(
            r.applied_sequences,
            strs(&b["expected"]["appliedSequences"]),
            &format!("cs:iso {} applied", side),
        );
        g.eq(
            r.final_cursor,
            s(&b["expected"], "finalCursor").to_string(),
            &format!("cs:iso {} cursor", side),
        );
    }
    g
}

fn group_results() -> Group {
    let mut g = Group::new("operation-results");
    let orr = load("operation-results.json");
    for c in arr(&orr, "classification") {
        g.case();
        g.eq(
            is_final_status(s(c, "status")),
            c["final"].as_bool().unwrap(),
            &format!("or:classify {}", s(c, "status")),
        );
    }
    for c in arr(&orr, "retryCases") {
        g.case();
        let name = s(c, "name");
        let st = &c["stored"];
        let stored = StoredDecision {
            exists: st["exists"].as_bool().unwrap(),
            status: st
                .get("status")
                .and_then(|x| x.as_str())
                .map(|x| x.to_string()),
            hash: st
                .get("hash")
                .and_then(|x| x.as_str())
                .map(|x| x.to_string()),
        };
        let inc = &c["incoming"];
        let incoming = IncomingOperation {
            hash: s(inc, "hash").into(),
            prior_outcome: inc
                .get("priorOutcome")
                .and_then(|x| x.as_str())
                .map(|x| x.to_string()),
        };
        let action = classify_retry(&stored, &incoming);
        g.eq(
            action.action_code(),
            s(c, "expectedAction"),
            &format!("or:retry {} action", name),
        );
        if let Some(es) = c.get("expectedResultStatus").and_then(|x| x.as_str()) {
            let got = match &action {
                lataif_server::protocol::result::RetryAction::ReplayStored { result_status } => {
                    result_status.clone()
                }
                _ => String::new(),
            };
            g.eq(got, es.to_string(), &format!("or:retry {} status", name));
        }
    }
    g
}

#[test]
fn a0b_fixture_parity() {
    // Sanity: the production operation-type validator accepts the pilot type.
    assert!(is_valid_operation_type("APPLY_SUPPLIER_CREDIT_TO_EXPENSES"));
    assert!(is_canonical_uuid("aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa"));

    let groups = [
        group_canonical_json(),
        group_uuidv5(),
        group_envelopes(),
        group_cursor(),
        group_results(),
    ];

    let mut total_cases = 0;
    let mut total_pass = 0;
    let mut total_fail = 0;
    println!("\nA0b protocol parity (production module):");
    for g in &groups {
        println!(
            "  {:<18} cases={:<3} assertions={:<3} failures={}",
            g.name,
            g.cases,
            g.pass,
            g.fails.len()
        );
        for f in &g.fails {
            println!("      FAIL {}", f);
        }
        total_cases += g.cases;
        total_pass += g.pass;
        total_fail += g.fails.len();
    }
    println!(
        "  total: {} cases, {} assertions, {} failures",
        total_cases, total_pass, total_fail
    );

    assert_eq!(total_fail, 0, "A0b parity failures");
}
