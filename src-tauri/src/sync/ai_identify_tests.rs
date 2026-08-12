// MOBILE-I1B §1 — proof that the two AI implementations are ONE contract.
//
// The fingerprint below is produced by the TypeScript side (`contractFingerprint()` in
// identify-prompt.ts, asserted against the RELEASED ff038ad prompt by
// test/ai/identify-contract-parity.test.ts). If this Rust assembly ever differs by a single
// character — a reordered field, a lost newline, a placeholder resolved differently — the hash
// changes and this test fails. That is the only reason a second execution path is acceptable.

use super::*;

/// Must equal `contractFingerprint()` on the TypeScript side.
const EXPECTED_FINGERPRINT: &str = "0b50cba3b834d514";

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
