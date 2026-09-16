// MOBILE-I1B §1 — proof that the two AI implementations are ONE contract.
//
// The fingerprint below is produced by the TypeScript side (`contractFingerprint()` in
// identify-prompt.ts, asserted against the RELEASED ff038ad prompt by
// test/ai/identify-contract-parity.test.ts). If this Rust assembly ever differs by a single
// character — a reordered field, a lost newline, a placeholder resolved differently — the hash
// changes and this test fails. That is the only reason a second execution path is acceptable.

use super::*;

/// Must equal `contractFingerprint()` on the TypeScript side.
/// REPAIR-INTAKE §5 — was `0b50cba3b834d514` while the contract knew only product categories; the
/// repair form's three prompt lines are now part of the same input, appended after the category
/// lines, so the value moved once and deliberately.
const EXPECTED_FINGERPRINT: &str = "0c33a03188de4b83";

#[test]
fn rust_and_typescript_assemble_the_identical_prompts() {
    assert_eq!(
        contract_fingerprint(),
        EXPECTED_FINGERPRINT,
        "the Rust prompt assembly has drifted from the TypeScript one — both read \
         identify-contract.json, so a difference here means one of the two assemblers changed"
    );
}

#[test]
fn fnv1a_matches_the_reference_implementation() {
    // Same vectors the TypeScript gate asserts, so the hash function itself cannot be the drift.
    assert_eq!(fnv1a64(""), "cbf29ce484222325");
    assert_eq!(fnv1a64("a"), "af63dc4c8601ec8c");
    assert_eq!(fnv1a64("foobar"), "85944171f73967e8");
}

#[test]
fn the_contract_carries_all_six_categories() {
    let c = contract();
    assert_eq!(c.contract_version, 1);
    assert_eq!(c.categories.len(), 6, "six categories, same as the desktop field contract");
    for id in [
        "cat-watch",
        "cat-gold-jewelry",
        "cat-branded-gold-jewelry",
        "cat-original-gold-jewelry",
        "cat-accessory",
        "cat-spare-part",
    ] {
        assert!(category_spec(id).is_some(), "{id} must exist in the shared contract");
    }
    assert!(category_spec("cat-nonsense").is_none(), "an unknown category is refused, never guessed");
}

#[test]
fn prompts_resolve_every_placeholder() {
    for id in contract().categories.keys() {
        let sys = build_system_prompt(id).unwrap();
        let usr = build_user_prompt(id, "").unwrap();
        for probe in ["{{CATEGORY_NAME}}", "{{REQUIRED}}", "{{OPTIONAL}}", "{{CONDITION_OPTIONS}}",
                      "{{SCOPE_OPTIONS}}", "{{NOTES}}", "{{ATTRIBUTE_NULLS}}", "{{HINTS}}", "{{WATCH_EXTRA}}"] {
            assert!(!sys.contains(probe), "{id}: unresolved {probe} in system prompt");
            assert!(!usr.contains(probe), "{id}: unresolved {probe} in user prompt");
        }
        assert!(!sys.is_empty() && !usr.is_empty());
    }
}

#[test]
fn the_watch_suffix_is_watch_only() {
    let marker = "the three CRITICAL fields are reference_number";
    assert!(build_user_prompt("cat-watch", "").unwrap().contains(marker));
    for id in ["cat-gold-jewelry", "cat-accessory", "cat-spare-part"] {
        assert!(
            !build_user_prompt(id, "").unwrap().contains(marker),
            "{id} must not inherit the watch-specific instruction"
        );
    }
}

#[test]
fn hints_change_the_user_prompt_and_are_inserted_verbatim() {
    let plain = build_user_prompt("cat-watch", "").unwrap();
    let hinted = build_user_prompt("cat-watch", "brand: Rolex").unwrap();
    assert_ne!(plain, hinted);
    assert!(hinted.contains("brand: Rolex"));
    assert!(hinted.starts_with("User-provided hints:"));
}

/// §5 — the mobile allow/deny lists are data in the shared file, and money is on the deny side.
#[test]
fn money_quantity_and_system_fields_are_denied_for_mobile() {
    let c = contract();
    for denied in [
        "estimatedValue", "purchasePriceEstimate", "minSalePrice", "maxSalePrice",
        "purchasePrice", "plannedSalePrice", "lastOfferPrice", "lastSalePrice",
        "quantity", "images", "id", "stockStatus", "syncStatus", "categoryId",
    ] {
        assert!(
            c.mobile_forbidden_fields.iter().any(|f| f == denied),
            "{denied} must be on the mobile deny list"
        );
        assert!(
            !c.mobile_allowed_fields.iter().any(|f| f == denied),
            "{denied} must not be on the mobile allow list"
        );
    }
    assert!(c.mobile_allowed_fields.iter().any(|f| f == "brand"));
    assert!(c.mobile_allowed_fields.iter().any(|f| f == "name"));
    for a in &c.mobile_allowed_fields {
        assert!(!c.mobile_forbidden_fields.contains(a), "{a} cannot be both allowed and forbidden");
    }
}

// ── REPAIR-INTAKE §1/§2 — the second form kind ──────────────────────────────

/// The six names are repeated here on purpose: if someone widens the contract's list, this test is
/// the thing that has to be edited too, in the open.
const REPAIR_SIX: [&str; 6] = [
    "itemBrand",
    "itemModel",
    "itemReference",
    "itemSerial",
    "itemDescription",
    "issueDescription",
];

/// The sentence that refuses invention. Written without its leading "Never"/"never" so the same
/// marker matches the system prompt and both user prompts.
const REPAIR_FORBID: &str =
    "invent, estimate or output prices, costs, repair estimates, customer data, ids, record numbers, status values or dates";

#[test]
fn the_repair_form_declares_exactly_six_fields_and_is_not_a_category() {
    assert_eq!(repair_fields(), &REPAIR_SIX.map(String::from));
    // A repair intake must never appear in the product category enumeration.
    assert!(category_spec("repair").is_none(), "repair is not a product category");
    assert!(category_spec("cat-repair").is_none());
    assert_eq!(contract().categories.len(), 6, "the product categories are untouched");
}

#[test]
fn the_repair_prompts_assemble_and_name_every_allowed_field() {
    let sys = build_repair_system_prompt();
    let plain = build_repair_user_prompt("");
    let hinted = build_repair_user_prompt("brand: Rolex");

    for p in [&sys, &plain, &hinted] {
        assert!(!p.is_empty());
        for probe in ["{{FIELDS}}", "{{FIELD_NULLS}}", "{{HINTS}}", "{{FORM_NAME}}", "{{CATEGORY_NAME}}"] {
            assert!(!p.contains(probe), "unresolved {probe} in a repair prompt");
        }
        for field in REPAIR_SIX {
            assert!(p.contains(field), "a repair prompt must name {field}");
        }
        assert!(
            p.contains("REPAIR INTAKE"),
            "the model must be told this is a repair intake photo, not an item for sale"
        );
        assert!(p.contains(REPAIR_FORBID), "a repair prompt must forbid invented money/ids/dates");
    }
    assert!(sys.contains("jewellery"), "the domain is stated");
    assert!(hinted.starts_with("User-provided hints:"));
    assert!(hinted.contains("brand: Rolex"));
    assert_ne!(plain, hinted);
}

#[test]
fn the_repair_prompt_never_asks_for_a_product_field() {
    let all = format!("{}{}", build_repair_system_prompt(), build_repair_user_prompt(""));
    for never in [
        "estimatedValue", "purchasePriceEstimate", "minSalePrice", "maxSalePrice",
        "taxScheme", "scopeOfDelivery", "sku", "quantity",
    ] {
        assert!(!all.contains(never), "the repair form must not ask for {never}");
    }
}

/// MOBILE-I1C §5 — the fingerprint may stay separator-free only while its input is unambiguous:
/// a fixed number of components, a fixed order, and each component ending in a fixed-width digest.
#[test]
fn the_fingerprint_input_is_structurally_unambiguous() {
    let parts = fingerprint_components();
    assert_eq!(parts.len(), 21, "6 categories x 3 prompts + the repair form's 3 - a fixed count");
    assert_eq!(parts.len(), contract().categories.len() * 3 + 3);

    let mut seen = std::collections::BTreeSet::new();
    for (i, line) in parts.iter().enumerate() {
        let (head, digest) = line.rsplit_once(':').expect("every component ends in :<digest>");
        assert_eq!(digest.len(), 16, "component {i} digest must be fixed width: {line}");
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()), "component {i} must end in hex");
        assert!(seen.insert(head.to_string()), "component key {head} appears twice");
        let kind = head.rsplit(':').next().unwrap();
        assert!(matches!(kind, "system" | "user" | "user-hints"), "unexpected kind {kind}");
    }

    // Fixed order: sorted category ids, and within a category always system, user, user-hints.
    let ids: Vec<&str> = parts.iter().step_by(3).map(|l| l.split(':').next().unwrap()).collect();
    let cats = &ids[..ids.len() - 1];
    let mut sorted = cats.to_vec();
    sorted.sort_unstable();
    assert_eq!(cats, sorted.as_slice(), "categories must be emitted in sorted order");
    // REPAIR-INTAKE §5 — the repair triple is APPENDED last, so the category lines keep the exact
    // positions they had before a second form kind existed.
    assert_eq!(*ids.last().unwrap(), "repair", "the repair form's lines come after every category");
    assert_eq!(parts[18], format!("repair:system:{}", fnv1a64(&build_repair_system_prompt())));
    assert_eq!(parts[19], format!("repair:user:{}", fnv1a64(&build_repair_user_prompt(""))));
    assert_eq!(
        parts[20],
        format!("repair:user-hints:{}", fnv1a64(&build_repair_user_prompt("brand: Rolex")))
    );
    for chunk in parts.chunks(3) {
        assert!(chunk[0].contains(":system:"));
        assert!(chunk[1].contains(":user:"));
        assert!(chunk[2].contains(":user-hints:"));
    }

    // A separator can never be produced BY a component, so the join stays unambiguous.
    for line in &parts {
        assert!(!line.contains('|'), "a component must not contain the join separator: {line}");
    }
}
