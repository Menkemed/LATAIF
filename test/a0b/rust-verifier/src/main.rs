// A0b — independent Rust verifier for the language-neutral protocol fixtures of
// the Authoritative-Operation-Commit (protocol v4). TEST-ONLY, isolated crate
// inside the tracked LATAIF/desktop repo. Imports NO production code. Uses
// established crates (serde_json, sha2, uuid v5, unicode-normalization); known-
// answer tests anchor the primitives to external RFC/well-known vectors.
//
// Reads the SAME fixtures as the Node verifier:
//   test/a0b/rust-verifier/  --(reads ../fixtures/*.json)-->  test/a0b/fixtures
//
// Run:  cargo run    -> exit 0 on PASS, 1 on FAIL
//       cargo test   -> known-answer + parity tests
//
// Wire format: 64-bit DOMAIN values (money fils, *Revision, serverSequence) are
// canonical i64 decimal strings; small SCHEMA-bound structural integers
// (protocolVersion == 4; mutationCount/ordinal in 0..=u32::MAX) are bounded JSON
// integers; number rejection is field/schema based; strings are NFC-normalized
// inside the hash boundary.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures");
const NS: &str = "9520db11-5c48-5d8f-a288-56f1876c0781";
const URL_NS: &str = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const U32_MAX_I64: i64 = 4294967295;

fn load(name: &str) -> Value {
    let p = format!("{}/{}", FIX, name);
    serde_json::from_str(&fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {}", p, e)))
        .unwrap_or_else(|e| panic!("parse {}: {}", p, e))
}

// ---------------- primitives via established crates ----------------
fn sha256hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}
fn uuid5(ns: &str, name: &str) -> String {
    let nsu = Uuid::parse_str(ns).expect("namespace uuid");
    Uuid::new_v5(&nsu, name.as_bytes()).to_string()
}

// ---------------- LCJ-v4 canonicalizer (NFC inside boundary) ----------------
fn canon_string(s: &str) -> String {
    let n: String = s.nfc().collect();
    let mut out = String::from("\"");
    for ch in n.chars() {
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
fn canon(v: &Value) -> Result<String, String> {
    match v {
        Value::Null => Ok("null".into()),
        Value::Bool(b) => Ok(if *b { "true" } else { "false" }.into()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i.to_string())
            } else if let Some(u) = n.as_u64() {
                Ok(u.to_string())
            } else {
                Err("NUMBER_NOT_INTEGER".into())
            }
        }
        Value::String(s) => Ok(canon_string(s)),
        Value::Array(a) => {
            let mut parts = Vec::new();
            for e in a {
                parts.push(canon(e)?);
            }
            Ok(format!("[{}]", parts.join(",")))
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            for k in &keys {
                if k.is_empty() || !k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
                    return Err("NON_ASCII_KEY".into());
                }
            }
            keys.sort();
            let mut parts = Vec::new();
            for k in keys {
                parts.push(format!("{}:{}", canon_string(k), canon(m.get(k).unwrap())?));
            }
            Ok(format!("{{{}}}", parts.join(",")))
        }
    }
}

// ---------------- typed-field validation (field/schema based) ----------------
fn validate_i64(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s,
        _ => return Some("EXPECTED_I64_STRING".into()),
    };
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return Some("I64_NOT_CANONICAL".into());
    }
    if s.len() > 1 && s.as_bytes()[0] == b'0' {
        return Some("I64_LEADING_ZERO".into());
    }
    match s.parse::<i64>() {
        Ok(_) => None,
        Err(_) => Some("INT_OUT_OF_RANGE".into()),
    }
}
fn validate_u32(v: &Value) -> Option<String> {
    match v {
        Value::String(_) => Some("EXPECTED_U32_INTEGER".into()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i < 0 {
                    Some("U32_NEGATIVE".into())
                } else if i > U32_MAX_I64 {
                    Some("U32_OUT_OF_RANGE".into())
                } else {
                    None
                }
            } else if n.as_u64().is_some() {
                Some("U32_OUT_OF_RANGE".into())
            } else {
                Some("U32_NOT_INTEGER".into())
            }
        }
        _ => Some("U32_NOT_INTEGER".into()),
    }
}
fn validate_protocol_version(v: &Value) -> Option<String> {
    match v {
        Value::String(_) => Some("EXPECTED_PROTOCOL_VERSION_INTEGER".into()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i != 4 {
                    Some("UNSUPPORTED_PROTOCOL_VERSION".into())
                } else {
                    None
                }
            } else if n.as_u64().is_some() {
                Some("UNSUPPORTED_PROTOCOL_VERSION".into())
            } else {
                Some("PROTOCOL_VERSION_NOT_INTEGER".into())
            }
        }
        _ => Some("PROTOCOL_VERSION_NOT_INTEGER".into()),
    }
}
fn is_i64_key(k: &str) -> bool {
    k.ends_with("Fils") || k.ends_with("Revision") || k == "serverSequence"
}
fn is_u32_key(k: &str) -> bool {
    k == "mutationCount" || k == "ordinal"
}
fn walk_types(v: &Value) -> Option<String> {
    match v {
        Value::Array(a) => {
            for e in a {
                if let Some(r) = walk_types(e) {
                    return Some(r);
                }
            }
            None
        }
        Value::Object(m) => {
            for (k, val) in m {
                if is_i64_key(k) {
                    if let Some(r) = validate_i64(val) {
                        return Some(r);
                    }
                } else if k == "protocolVersion" {
                    if let Some(r) = validate_protocol_version(val) {
                        return Some(r);
                    }
                } else if is_u32_key(k) {
                    if let Some(r) = validate_u32(val) {
                        return Some(r);
                    }
                } else if val.is_number() {
                    return Some("JSON_NUMBER_NOT_ALLOWED".into());
                } else if let Some(r) = walk_types(val) {
                    return Some(r);
                }
            }
            None
        }
        Value::Number(_) => Some("JSON_NUMBER_NOT_ALLOWED".into()),
        _ => None,
    }
}

// ---------------- accessors ----------------
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or_else(|| panic!("missing str {}", k))
}
fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(|x| x.as_u64()).unwrap_or_else(|| panic!("missing u64 {}", k))
}
fn arr<'a>(v: &'a Value, k: &str) -> &'a Vec<Value> {
    v.get(k).and_then(|x| x.as_array()).unwrap_or_else(|| panic!("missing arr {}", k))
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

const OP_TYPE_OK: fn(&str) -> bool = |t: &str| {
    let b = t.as_bytes();
    if b.len() < 3 || b.len() > 64 {
        return false;
    }
    if !b[0].is_ascii_uppercase() {
        return false;
    }
    b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
};
fn is_uuid(s: &str) -> bool {
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
fn ts_ok(t: &str) -> bool {
    let b = t.as_bytes();
    if b.len() != 24 {
        return false;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    (0..4).all(digit)
        && b[4] == b'-' && digit(5) && digit(6) && b[7] == b'-' && digit(8) && digit(9)
        && b[10] == b'T' && digit(11) && digit(12) && b[13] == b':' && digit(14) && digit(15)
        && b[16] == b':' && digit(17) && digit(18) && b[19] == b'.' && digit(20) && digit(21) && digit(22)
        && b[23] == b'Z'
}

// ---------------- checker ----------------
struct Checker {
    pass: usize,
    fails: Vec<String>,
}
impl Checker {
    fn new() -> Self {
        Checker { pass: 0, fails: Vec::new() }
    }
    fn eq<A: PartialEq + std::fmt::Debug>(&mut self, a: A, b: A, label: &str) {
        if a == b {
            self.pass += 1;
        } else {
            self.fails.push(format!("{}: got {:?} exp {:?}", label, a, b));
        }
    }
    fn ok(&mut self, c: bool, label: &str) {
        if c {
            self.pass += 1;
        } else {
            self.fails.push(label.into());
        }
    }
}

// ---------------- envelope validation ----------------
fn validate_envelope(env: &Value, max: usize) -> Result<(String, usize, String), String> {
    let otype = env.get("operationType").and_then(|x| x.as_str()).unwrap_or("");
    if !OP_TYPE_OK(otype) {
        return Err("INVALID_OPERATION_TYPE".into());
    }
    let oid = env.get("operationId").and_then(|x| x.as_str()).unwrap_or("");
    if !is_uuid(oid) {
        return Err("INVALID_OPERATION_ID".into());
    }
    if let Some(e) = walk_types(env) {
        return Err(e);
    }
    if s(env, "serverSequence").parse::<i64>().unwrap() < 1 {
        return Err("INVALID_SEQUENCE".into());
    }
    let muts = env["mutations"].as_array().unwrap();
    if env["mutationCount"].as_u64().unwrap() != muts.len() as u64 {
        return Err("MUTATION_COUNT_MISMATCH".into());
    }
    let ords: Vec<u64> = muts.iter().map(|m| m["ordinal"].as_u64().unwrap()).collect();
    let mut uniq = ords.clone();
    uniq.sort();
    uniq.dedup();
    if uniq.len() != ords.len() {
        return Err("DUPLICATE_ORDINAL".into());
    }
    let mut sorted = ords.clone();
    sorted.sort();
    for (i, o) in sorted.iter().enumerate() {
        if *o != i as u64 {
            return Err("ORDINAL_NOT_DENSE".into());
        }
    }
    let mut keyed: Vec<(u64, String)> = muts
        .iter()
        .map(|m| {
            let key = canon(&Value::Array(vec![m["table"].clone(), m["recordId"].clone()])).unwrap();
            (m["ordinal"].as_u64().unwrap(), key)
        })
        .collect();
    keyed.sort_by(|a, b| a.1.cmp(&b.1));
    for (i, (o, _)) in keyed.iter().enumerate() {
        if *o != i as u64 {
            return Err("MUTATION_ORDER_MISMATCH".into());
        }
    }
    for (i, m) in muts.iter().enumerate() {
        if m["ordinal"].as_u64().unwrap() != i as u64 {
            return Err("MUTATION_ORDER_MISMATCH".into());
        }
    }
    let c = canon(env)?;
    let len = c.as_bytes().len();
    if len > max {
        return Err("ENVELOPE_TOO_LARGE".into());
    }
    Ok((c.clone(), len, sha256hex(&c)))
}

// ---------------- the verification run ----------------
fn run() -> Checker {
    let mut k = Checker::new();

    // group 1: canonical-json
    let cj = load("canonical-json.json");
    let cases = arr(&cj, "canonicalCases");
    let find = |name: &str| cases.iter().find(|c| c["name"] == name).unwrap();
    for c in cases {
        let name = s(c, "name");
        let expect = s(c, "expect");
        let input = &c["input"];
        let result: Result<String, String> = match walk_types(input) {
            Some(code) => Err(code),
            None => canon(input),
        };
        match result {
            Ok(canonical) => {
                k.eq(expect, "valid", &format!("cj:{} expect", name));
                k.eq(canonical.as_str(), s(c, "canonical"), &format!("cj:{} canonical", name));
                k.eq(canonical.as_bytes().len() as u64, u(c, "utf8ByteLength"), &format!("cj:{} byteLength", name));
                k.eq(sha256hex(&canonical), s(c, "sha256").to_string(), &format!("cj:{} sha256", name));
                if let Some(o) = c.get("sameHashAs").and_then(|x| x.as_str()) {
                    k.eq(s(c, "sha256"), s(find(o), "sha256"), &format!("cj:{} sameHashAs", name));
                }
                if let Some(o) = c.get("differentHashFrom").and_then(|x| x.as_str()) {
                    k.ok(s(c, "sha256") != s(find(o), "sha256"), &format!("cj:{} differentHashFrom", name));
                }
                if let Some(o) = c.get("nfcEquivalence").and_then(|x| x.as_str()) {
                    let other = find(o);
                    k.ok(c["input"] != other["input"], &format!("cj:{} nfd!=nfc input", name));
                    k.eq(canon(input).unwrap(), canon(&other["input"]).unwrap(), &format!("cj:{} canon(nfd)==canon(nfc)", name));
                }
            }
            Err(code) => k.eq(code, expect.to_string(), &format!("cj:{} reject", name)),
        }
    }
    for c in arr(&cj, "schemaCases") {
        let name = s(c, "name");
        let p = &c["input"];
        let r: Option<String> = (|| {
            if !p.get("operationType").and_then(|x| x.as_str()).map(OP_TYPE_OK).unwrap_or(false) {
                return Some("INVALID_OPERATION_TYPE".into());
            }
            if !p.get("operationId").and_then(|x| x.as_str()).map(is_uuid).unwrap_or(false) {
                return Some("INVALID_OPERATION_ID".into());
            }
            if !p.get("businessTimestamp").and_then(|x| x.as_str()).map(ts_ok).unwrap_or(false) {
                return Some("BAD_TIMESTAMP".into());
            }
            walk_types(p)
        })();
        if s(c, "expect") == "valid" {
            k.ok(r.is_none(), &format!("cj-schema:{} expected valid, got {:?}", name, r));
        } else {
            k.eq(r.unwrap_or_default(), s(c, "expect").to_string(), &format!("cj-schema:{} reject", name));
        }
    }

    // group 2: uuidv5
    let u5 = load("uuidv5.json");
    k.eq(uuid5(URL_NS, s(&u5["namespace"]["derivation"], "nameString")), s(&u5["namespace"], "value").to_string(), "u5:namespace recompute");
    k.eq(s(&u5["namespace"], "value"), NS, "u5:namespace frozen");
    for kv in u5["knownAnswerVectors"]["uuid5"].as_array().unwrap() {
        k.eq(uuid5(s(kv, "namespace"), s(kv, "nameString")), s(kv, "expectedUuid").to_string(), &format!("u5:kav {}", s(kv, "name")));
    }
    for kv in u5["knownAnswerVectors"]["sha256"].as_array().unwrap() {
        k.eq(sha256hex(s(kv, "input")), s(kv, "hex").to_string(), &format!("u5:sha256 {:?}", s(kv, "input")));
    }
    let children = arr(&u5, "childIds");
    let cfind = |name: &str| children.iter().find(|c| c["name"] == name).unwrap();
    let ordn = |c: &Value| c["ordinal"].as_u64().unwrap();
    let child_name = |c: &Value| -> String {
        match s(c, "kind") {
            "ledger-tx" => format!("{}|ledger-tx", s(c, "operationId")),
            "exp-pmt" => format!("{}|exp-pmt|{}|{}|{}", s(c, "operationId"), s(c, "expenseId"), s(c, "creditId"), ordn(c)),
            "ledger-entry" => format!("{}|entry|{}|{}|{}", s(c, "operationId"), ordn(c), s(c, "direction"), s(c, "account")),
            other => panic!("kind {}", other),
        }
    };
    let components = |c: &Value| -> Vec<String> {
        match s(c, "kind") {
            "ledger-tx" => vec![s(c, "operationId").into()],
            "exp-pmt" => vec![s(c, "operationId").into(), s(c, "expenseId").into(), s(c, "creditId").into(), ordn(c).to_string()],
            _ => vec![s(c, "operationId").into(), ordn(c).to_string(), s(c, "direction").into(), s(c, "account").into()],
        }
    };
    for c in children {
        let name = s(c, "name");
        k.ok(components(c).iter().all(|x| !x.contains('|')), &format!("u5:{} pipe-free", name));
        k.eq(child_name(c), s(c, "nameString").to_string(), &format!("u5:{} nameString", name));
        k.eq(uuid5(NS, &child_name(c)), s(c, "expectedUuid").to_string(), &format!("u5:{} uuid", name));
        if let Some(o) = c.get("sameUuidAs").and_then(|x| x.as_str()) {
            k.eq(s(c, "expectedUuid"), s(cfind(o), "expectedUuid"), &format!("u5:{} sameUuidAs", name));
        }
        if let Some(o) = c.get("differentUuidFrom").and_then(|x| x.as_str()) {
            k.ok(s(c, "expectedUuid") != s(cfind(o), "expectedUuid"), &format!("u5:{} differentUuidFrom", name));
        }
    }
    for c in arr(&u5, "rejectChildIds") {
        let has_pipe = components(c).iter().any(|x| x.contains('|'));
        k.eq(if has_pipe { "CHILD_ID_COMPONENT_HAS_DELIMITER" } else { "ok" }, s(c, "expect"), &format!("u5:{} reject", s(c, "name")));
    }
    {
        let a = &u5["ordinalStability"]["allocations"];
        let opid = s(a, "operationId");
        let key = |x: &Value| canon(&Value::Array(vec![x["expenseId"].clone(), x["creditId"].clone()])).unwrap();
        let mut sorted: Vec<Value> = a["unsortedInput"].as_array().unwrap().clone();
        sorted.sort_by(|x, y| key(x).cmp(&key(y)));
        for (i, item) in sorted.iter().enumerate() {
            let e = &a["expectedSorted"][i];
            k.eq(key(item), s(e, "canonicalKey").to_string(), &format!("u5:alloc[{}] key", i));
            k.eq(i as u64, e["ordinal"].as_u64().unwrap(), &format!("u5:alloc[{}] ordinal", i));
            let n = format!("{}|exp-pmt|{}|{}|{}", opid, s(item, "expenseId"), s(item, "creditId"), i);
            k.eq(uuid5(NS, &n), s(e, "expectedUuid").to_string(), &format!("u5:alloc[{}] uuid", i));
        }
        let dk: Vec<String> = a["duplicateRejectInput"].as_array().unwrap().iter().map(|x| key(x)).collect();
        let mut ddk = dk.clone();
        ddk.sort();
        ddk.dedup();
        k.eq(if ddk.len() != dk.len() { "DUPLICATE_ALLOCATION_KEY" } else { "ok" }, s(a, "duplicateExpect"), "u5:alloc dedup");

        let lg = &u5["ordinalStability"]["ledgerLegs"];
        let lopid = s(lg, "operationId");
        let lkey = |x: &Value| {
            canon(&Value::Array(vec![
                x["legRole"].clone(), x["sourceId"].clone(), x["account"].clone(), x["direction"].clone(),
                x["counterpartyType"].clone(), x["counterpartyId"].clone(), x["amountFils"].clone(),
            ]))
            .unwrap()
        };
        let mut lsorted: Vec<Value> = lg["unsortedInput"].as_array().unwrap().clone();
        lsorted.sort_by(|x, y| lkey(x).cmp(&lkey(y)));
        for (i, item) in lsorted.iter().enumerate() {
            let e = &lg["expectedSorted"][i];
            k.eq(lkey(item), s(e, "canonicalKey").to_string(), &format!("u5:leg[{}] key", i));
            k.eq(i as u64, e["ordinal"].as_u64().unwrap(), &format!("u5:leg[{}] ordinal", i));
            let n = format!("{}|entry|{}|{}|{}", lopid, i, s(item, "direction"), s(item, "account"));
            k.eq(uuid5(NS, &n), s(e, "expectedUuid").to_string(), &format!("u5:leg[{}] uuid", i));
        }
        let ldk: Vec<String> = lg["duplicateRejectInput"].as_array().unwrap().iter().map(|x| lkey(x)).collect();
        let mut lddk = ldk.clone();
        lddk.sort();
        lddk.dedup();
        k.eq(if lddk.len() != ldk.len() { "DUPLICATE_LEDGER_EFFECT_KEY" } else { "ok" }, s(lg, "duplicateExpect"), "u5:leg dedup");
    }

    // group 3: envelopes
    let ev = load("envelopes.json");
    let max = u(&ev, "maxEnvelopeBytes") as usize;
    for c in arr(&ev, "u32Validity") {
        let r = validate_u32(&c["value"]);
        k.eq(r.unwrap_or_else(|| "valid".into()), s(c, "expect").to_string(), &format!("env:u32 {}", s(c, "name")));
    }
    for c in arr(&ev, "cases") {
        let name = s(c, "name");
        match validate_envelope(&c["envelope"], max) {
            Ok((canonical, len, h)) => {
                k.eq(s(c, "expect"), "valid", &format!("env:{} expect", name));
                k.eq(canonical.as_str(), s(c, "canonical"), &format!("env:{} canonical", name));
                k.eq(len as u64, u(c, "utf8ByteLength"), &format!("env:{} byteLength", name));
                k.eq(h, s(c, "sha256").to_string(), &format!("env:{} sha256", name));
            }
            Err(code) => k.eq(code, s(c, "expect").to_string(), &format!("env:{} reject", name)),
        }
    }
    {
        let sb = &ev["sizeBoundary"];
        let mut empty = sb["baseEnvelope"].clone();
        empty["mutations"][0]["payload"]["memo"] = Value::String(String::new());
        let (_, base_len, _) = validate_envelope(&empty, max).expect("boundary base valid");
        let need = max - base_len;
        let mut atl = sb["baseEnvelope"].clone();
        atl["mutations"][0]["payload"]["memo"] = Value::String("x".repeat(need));
        match validate_envelope(&atl, max) {
            Ok((_, len, _)) => k.eq(len, max, "env:boundary at-limit length"),
            Err(e) => k.fails.push(format!("env:boundary at-limit unexpectedly rejected: {}", e)),
        }
        let mut over = sb["baseEnvelope"].clone();
        over["mutations"][0]["payload"]["memo"] = Value::String("x".repeat(need + 1));
        match validate_envelope(&over, max) {
            Ok(_) => k.fails.push("env:boundary over-limit unexpectedly valid".into()),
            Err(e) => k.eq(e, s(sb, "overLimitExpect").to_string(), "env:boundary over-limit reject"),
        }
    }

    // group 4: cursor-sequences
    let cs = load("cursor-sequences.json");
    fn run_cursor(initial: &str, branch: &str, ops: &[Value]) -> (Vec<String>, Vec<String>, Vec<String>, Vec<String>, Vec<String>, String) {
        let mut sorted: Vec<&Value> = ops.iter().collect();
        sorted.sort_by_key(|o| o["serverSequence"].as_str().unwrap().parse::<i64>().unwrap());
        let mut cursor: i64 = initial.parse().unwrap();
        let mut blocked = false;
        let (mut applied, mut mutated, mut skipped, mut blk, mut delivered) = (vec![], vec![], vec![], vec![], vec![]);
        for o in &sorted {
            if o["branchId"].as_str().unwrap() != branch {
                continue;
            }
            let sv = o["serverSequence"].as_str().unwrap().to_string();
            let sn: i64 = sv.parse().unwrap();
            delivered.push(sv.clone());
            if blocked {
                blk.push(sv);
                continue;
            }
            if sn <= cursor {
                skipped.push(sv);
                continue;
            }
            if o["applyOutcome"].as_str().unwrap() == "error" {
                blocked = true;
                blk.push(sv);
                continue;
            }
            applied.push(sv.clone());
            if o["mutates"].as_bool().unwrap() {
                mutated.push(sv);
            }
            cursor = sn;
        }
        (delivered, applied, mutated, skipped, blk, cursor.to_string())
    }
    for sc in arr(&cs, "scenarios") {
        let name = s(sc, "name");
        let (d, ap, mu, sk, bl, fc) = run_cursor(s(sc, "initialCursor"), s(&sc["branchKey"], "branchId"), arr(sc, "deliveredOps"));
        let e = &sc["expected"];
        k.eq(d, strs(&e["deliveredSortedSequences"]), &format!("cs:{} delivered", name));
        k.eq(ap, strs(&e["appliedSequences"]), &format!("cs:{} applied", name));
        k.eq(mu, strs(&e["mutatedSequences"]), &format!("cs:{} mutated", name));
        k.eq(sk, strs(&e["skippedSequences"]), &format!("cs:{} skipped", name));
        k.eq(bl, strs(&e["blockedSequences"]), &format!("cs:{} blocked", name));
        k.eq(fc, s(e, "finalCursor").to_string(), &format!("cs:{} finalCursor", name));
    }
    let iso = &cs["isolation"];
    let global = iso["globalOps"].as_array().unwrap();
    for side in ["branchA", "branchB"] {
        let b = &iso[side];
        let (_, ap, _, _, _, fc) = run_cursor(s(b, "initialCursor"), s(b, "branchId"), global);
        k.eq(ap, strs(&b["expected"]["appliedSequences"]), &format!("cs:iso {} applied", side));
        k.eq(fc, s(&b["expected"], "finalCursor").to_string(), &format!("cs:iso {} finalCursor", side));
    }

    // group 5: operation-results
    let orr = load("operation-results.json");
    let finals: Vec<String> = strs(&orr["finalStatuses"]);
    let is_final = |st: &str| finals.iter().any(|f| f == st);
    for c in arr(&orr, "classification") {
        k.eq(is_final(s(c, "status")), c["final"].as_bool().unwrap(), &format!("or:classify {}", s(c, "status")));
    }
    for c in arr(&orr, "retryCases") {
        let name = s(c, "name");
        let stored = &c["stored"];
        let incoming = &c["incoming"];
        let (action, rstatus): (&str, Option<&str>) = if stored["exists"].as_bool().unwrap() {
            if incoming.get("hash").and_then(|x| x.as_str()) == stored.get("hash").and_then(|x| x.as_str()) {
                ("REPLAY_STORED", stored.get("status").and_then(|x| x.as_str()))
            } else {
                ("OPERATION_ID_REUSED", None)
            }
        } else if incoming.get("priorOutcome").and_then(|x| x.as_str()).map(|p| !is_final(p)).unwrap_or(false) {
            ("STATUS_QUERY", None)
        } else {
            ("RETRY_ALLOWED", None)
        };
        k.eq(action, s(c, "expectedAction"), &format!("or:retry {} action", name));
        if let Some(es) = c.get("expectedResultStatus").and_then(|x| x.as_str()) {
            k.eq(rstatus, Some(es), &format!("or:retry {} status", name));
        }
    }

    k
}

fn main() {
    let k = run();
    println!("A0b rust-verifier: {} assertions passed, {} failed", k.pass, k.fails.len());
    if !k.fails.is_empty() {
        for f in &k.fails {
            eprintln!("  - {}", f);
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitive_known_answers() {
        assert_eq!(sha256hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(uuid5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
        assert_eq!(uuid5(URL_NS, "urn:lataif:fin-ops:protocol:v4"), NS);
    }

    #[test]
    fn full_parity() {
        let k = run();
        assert!(k.fails.is_empty(), "failures:\n{}", k.fails.join("\n"));
    }
}
