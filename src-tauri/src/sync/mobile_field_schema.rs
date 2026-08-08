// ════════════════════════════════════════════════════════════════════════════
// MOBILE-FIELDS — server-side product-field validation for the mobile uploader.
//
// The field model is the DESKTOP SSOT (`src/core/models/default-categories.ts`), compiled to
// `mobile_field_schema.json` by test/mobile-fields/gen-schema.mjs and embedded here via include_str!. A node
// drift test asserts the JSON matches the TS SSOT, so this validator can never diverge from the desktop.
//
// This is the AUTHORITATIVE gate: the mobile client is never trusted. We validate VALIDITY (allow-listed keys,
// known category, enum membership, finite non-negative numbers, string caps) and reject anything else BEFORE
// any staging/inbox write, so an invalid request leaves no blob/inbox leak. REQUIRED-ness is intentionally NOT
// enforced here — the client enforces it for UX, and leniency keeps old minimal payloads (brand/name/sku only)
// valid. An allow-list is inherently mass-assignment safe: no field outside the set can reach the product.
// ════════════════════════════════════════════════════════════════════════════

use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

const SCHEMA_JSON: &str = include_str!("mobile_field_schema.json");

// String caps — mirror MAX in src/core/mobile/mobile-field-schema.ts.
const MAX_BRAND: usize = 120;
const MAX_NAME: usize = 160;
const MAX_SKU: usize = 80;
const MAX_TEXT: usize = 2000;

const ALLOWED_TOP_KEYS: &[&str] = &[
    "categoryId",
    "brand",
    "name",
    "sku",
    "condition",
    "scopeOfDelivery",
    "attributes",
];

// MOBILE-PRICING — the three canonical product prices. Part of the transport surface ONLY under v2; under
// v1 they are rejected like any other unknown key (legacy surface unchanged). Mirror ALLOWED_PRICING_KEYS
// in src/core/mobile/mobile-field-schema.ts. Cost-accounting/margin/VAT/derived fields are NOT here.
const PRICING_KEYS: &[&str] = &["purchasePrice", "plannedSalePrice", "minSalePrice"];
// NO business ceiling: the desktop SSOT (plain REAL columns, no bound in the create/edit UIs) enforces
// none, so mobile must not invent a second, diverging rule. Only technical validity is enforced below
// (finite, non-negative), mirroring src/core/mobile/mobile-field-schema.ts.

#[derive(Debug, Deserialize)]
struct SchemaFile {
    #[allow(dead_code)]
    version: i64,
    categories: Vec<SchemaCategory>,
}

#[derive(Debug, Deserialize)]
struct SchemaCategory {
    id: String,
    #[serde(rename = "brandRequired")]
    brand_required: bool,
    #[serde(rename = "conditionOptions")]
    condition_options: Vec<String>,
    #[serde(rename = "scopeOptions")]
    scope_options: Vec<String>,
    attributes: Vec<SchemaAttr>,
}

#[derive(Debug, Deserialize)]
struct SchemaAttr {
    key: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    options: Vec<String>,
    required: bool,
    #[serde(rename = "dependsOn", default)]
    depends_on: Option<DependsOn>,
}

#[derive(Debug, Deserialize)]
struct DependsOn {
    key: String,
    #[serde(rename = "valueIncludes")]
    value_includes: Vec<String>,
}

fn schema() -> &'static SchemaFile {
    static SCHEMA: OnceLock<SchemaFile> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(SCHEMA_JSON).expect("mobile_field_schema.json is valid and matches the SSOT")
    })
}

/// A structured validation rejection. `code` is a stable machine token; `field` names the offending key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataError {
    pub code: &'static str,
    pub field: String,
    pub message: String,
}
impl MetadataError {
    fn new(code: &'static str, field: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code, field: field.into(), message: message.into() }
    }
}

/// Validate a mobile upload `metadata` object against the desktop field SSOT. `version` selects the contract:
/// v1 = legacy, VALIDITY only (allow-list/enum/number/caps) so old minimal payloads stay valid; v2 = full field
/// contract, additionally enforcing the SAME requiredness + dependsOn the desktop create flow enforces. Returns
/// the FIRST rejection, or Ok(()) when acceptable. Called before any staging so a reject leaks nothing.
pub fn validate_metadata(meta: &Value, version: i64) -> Result<(), MetadataError> {
    let obj = meta
        .as_object()
        .ok_or_else(|| MetadataError::new("META_NOT_OBJECT", "metadata", "metadata must be an object"))?;

    // 1) allow-list every top-level key (mass-assignment safe). Pricing keys are allowed ONLY on v2, so a
    //    v1 client that sends a price is rejected exactly like any other unknown field.
    let pricing_allowed = version >= 2;
    for k in obj.keys() {
        let ok = ALLOWED_TOP_KEYS.contains(&k.as_str()) || (pricing_allowed && PRICING_KEYS.contains(&k.as_str()));
        if !ok {
            return Err(MetadataError::new("UNKNOWN_FIELD", k.clone(), format!("field \"{k}\" is not allowed")));
        }
    }

    // 2) category must be a known id.
    let category_id = obj.get("categoryId").and_then(|v| v.as_str());
    let cat = match category_id.and_then(|id| schema().categories.iter().find(|c| c.id == id)) {
        Some(c) => c,
        None => {
            return Err(MetadataError::new(
                "UNKNOWN_CATEGORY",
                "categoryId",
                format!("unknown category \"{}\"", category_id.unwrap_or("")),
            ))
        }
    };

    // 3) universal identity strings.
    check_opt_string(obj.get("brand"), "brand", MAX_BRAND, false)?;
    check_opt_string(obj.get("name"), "name", MAX_NAME, false)?;
    check_opt_string(obj.get("sku"), "sku", MAX_SKU, true)?;

    // 4) condition ∈ conditionOptions (when present, non-empty).
    if let Some(v) = obj.get("condition") {
        if !v.is_null() {
            let s = v.as_str().ok_or_else(|| MetadataError::new("BAD_TYPE", "condition", "condition must be a string"))?;
            if !s.is_empty() && !cat.condition_options.iter().any(|o| o == s) {
                return Err(MetadataError::new("BAD_ENUM", "condition", format!("invalid condition \"{s}\"")));
            }
        }
    }

    // 5) scopeOfDelivery ⊆ scopeOptions.
    if let Some(v) = obj.get("scopeOfDelivery") {
        if !v.is_null() {
            let arr = v.as_array().ok_or_else(|| MetadataError::new("BAD_TYPE", "scopeOfDelivery", "scopeOfDelivery must be an array"))?;
            for item in arr {
                let s = item.as_str().ok_or_else(|| MetadataError::new("BAD_ENUM", "scopeOfDelivery", "scope entries must be strings"))?;
                if !cat.scope_options.iter().any(|o| o == s) {
                    return Err(MetadataError::new("BAD_ENUM", "scopeOfDelivery", format!("invalid scope \"{s}\"")));
                }
            }
        }
    }

    // 6) attributes: allow-listed per category + typed/enum/number/text validity (all versions).
    let empty_map = serde_json::Map::new();
    let attrs: &serde_json::Map<String, Value> = match obj.get("attributes") {
        Some(v) if !v.is_null() => v.as_object().ok_or_else(|| MetadataError::new("BAD_TYPE", "attributes", "attributes must be an object"))?,
        _ => &empty_map,
    };
    for (key, val) in attrs {
        let def = match cat.attributes.iter().find(|a| &a.key == key) {
            Some(d) => d,
            None => return Err(MetadataError::new("UNKNOWN_FIELD", key.clone(), format!("attribute \"{key}\" not valid for {}", cat.id))),
        };
        if val.is_null() || matches!(val, Value::String(s) if s.is_empty()) { continue; } // empty optional skipped
        validate_attr_value(def, val)?;
    }

    // 7) MOBILE-PRICING (v2 only) — each present price must be a finite, non-negative number. Optional:
    //    absent/null is fine. No upper bound and no relation rule (min≤sale) — the desktop enforces
    //    neither, and mobile must not add a rule the SSOT does not have. Values pass through unrounded.
    if pricing_allowed {
        for key in PRICING_KEYS {
            match obj.get(*key) {
                None | Some(Value::Null) => {}
                Some(v) => match v.as_f64().filter(|f| f.is_finite()) {
                    Some(f) if f < 0.0 => return Err(MetadataError::new("BAD_NUMBER", (*key).to_string(), format!("{key} must not be negative"))),
                    Some(_) => {}
                    None => return Err(MetadataError::new("BAD_NUMBER", (*key).to_string(), format!("{key} must be a finite number"))),
                },
            }
        }
    }

    // ── CONTRACT-V2 — full field contract: enforce the SAME requiredness the desktop create flow enforces, with
    // dependsOn recomputed independently of the client. A stale/hidden dependsOn field is rejected (fail-closed).
    // v1 stays lenient so legacy minimal payloads remain valid.
    if version >= 2 {
        if cat.brand_required {
            if !nonempty_str(obj.get("brand")) { return Err(MetadataError::new("REQUIRED", "brand", "Brand is required")); }
            if !nonempty_str(obj.get("name")) { return Err(MetadataError::new("REQUIRED", "name", "Name is required")); }
        }
        for def in &cat.attributes {
            let present = attr_present(attrs.get(&def.key));
            if let Some(dep) = &def.depends_on {
                let satisfied = attrs.get(&dep.key).and_then(|v| v.as_str())
                    .map(|s| dep.value_includes.iter().any(|x| x == s)).unwrap_or(false);
                if !satisfied {
                    if present { return Err(MetadataError::new("STALE_FIELD", def.key.clone(), format!("{} is not valid unless {} matches", def.key, dep.key))); }
                    continue;
                }
                if def.required && !present { return Err(MetadataError::new("REQUIRED", def.key.clone(), format!("{} is required", def.key))); }
            } else if def.required && !present {
                return Err(MetadataError::new("REQUIRED", def.key.clone(), format!("{} is required", def.key)));
            }
        }
    }

    Ok(())
}

fn nonempty_str(v: Option<&Value>) -> bool { matches!(v, Some(Value::String(s)) if !s.trim().is_empty()) }
fn attr_present(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        _ => true,
    }
}

fn check_opt_string(v: Option<&Value>, field: &str, max: usize, allow_null: bool) -> Result<(), MetadataError> {
    let Some(v) = v else { return Ok(()) };
    if v.is_null() {
        if allow_null { return Ok(()); }
        return Err(MetadataError::new("BAD_TYPE", field.to_string(), format!("{field} must be a string")));
    }
    let s = v.as_str().ok_or_else(|| MetadataError::new("BAD_TYPE", field.to_string(), format!("{field} must be a string")))?;
    if s.chars().count() > max {
        return Err(MetadataError::new("TOO_LONG", field.to_string(), format!("{field} exceeds {max} chars")));
    }
    Ok(())
}

fn validate_attr_value(def: &SchemaAttr, val: &Value) -> Result<(), MetadataError> {
    match def.kind.as_str() {
        "number" => {
            let n = val.as_f64().filter(|f| f.is_finite());
            match n {
                Some(f) if f >= 0.0 => Ok(()),
                Some(_) => Err(MetadataError::new("BAD_NUMBER", def.key.clone(), format!("{} must not be negative", def.key))),
                None => Err(MetadataError::new("BAD_NUMBER", def.key.clone(), format!("{} must be a finite number", def.key))),
            }
        }
        "select" => {
            let s = val.as_str().ok_or_else(|| MetadataError::new("BAD_ENUM", def.key.clone(), format!("{} must be one of its options", def.key)))?;
            if def.options.iter().any(|o| o == s) { Ok(()) } else { Err(MetadataError::new("BAD_ENUM", def.key.clone(), format!("invalid {} \"{s}\"", def.key))) }
        }
        "multiselect" => {
            let arr = val.as_array().ok_or_else(|| MetadataError::new("BAD_TYPE", def.key.clone(), format!("{} must be an array", def.key)))?;
            for item in arr {
                let s = item.as_str().ok_or_else(|| MetadataError::new("BAD_ENUM", def.key.clone(), format!("{} entries must be strings", def.key)))?;
                if !def.options.iter().any(|o| o == s) {
                    return Err(MetadataError::new("BAD_ENUM", def.key.clone(), format!("invalid {} \"{s}\"", def.key)));
                }
            }
            Ok(())
        }
        "boolean" => {
            if val.is_boolean() { Ok(()) } else { Err(MetadataError::new("BAD_TYPE", def.key.clone(), format!("{} must be true/false", def.key))) }
        }
        _ => {
            // text
            let s = val.as_str().ok_or_else(|| MetadataError::new("BAD_TYPE", def.key.clone(), format!("{} must be text", def.key)))?;
            if s.chars().count() > MAX_TEXT {
                return Err(MetadataError::new("TOO_LONG", def.key.clone(), format!("{} exceeds {MAX_TEXT} chars", def.key)));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_loads_and_has_all_categories() {
        let s = schema();
        let ids: Vec<&str> = s.categories.iter().map(|c| c.id.as_str()).collect();
        for id in ["cat-watch", "cat-gold-jewelry", "cat-branded-gold-jewelry", "cat-original-gold-jewelry", "cat-accessory", "cat-spare-part"] {
            assert!(ids.contains(&id), "missing category {id}");
        }
    }

    #[test]
    fn minimal_old_payload_is_accepted_v1() {
        // v1 backward compat: brand/name/sku only, no attributes/condition/scope.
        assert!(validate_metadata(&json!({ "categoryId": "cat-watch", "brand": "Rolex", "name": "Submariner", "sku": "R1" }), 1).is_ok());
        assert!(validate_metadata(&json!({ "categoryId": "cat-accessory", "brand": "", "name": "", "sku": null }), 1).is_ok());
    }

    #[test]
    fn full_watch_payload_is_accepted_both_versions() {
        let m = json!({
            "categoryId": "cat-watch", "brand": "Rolex", "name": "Submariner", "sku": "R-1",
            "condition": "Pre-Owned", "scopeOfDelivery": ["Box", "Papers"],
            "attributes": { "reference_number": "126610", "case_diameter_mm": 41, "serial_number": "X1",
                "dial": "Black", "material": "Steel", "description": "great", "year": 2020 }
        });
        assert_eq!(validate_metadata(&m, 1), Ok(()));
        assert_eq!(validate_metadata(&m, 2), Ok(()));
    }

    #[test]
    fn unknown_category_rejected() {
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-nope" }), 1).unwrap_err().code, "UNKNOWN_CATEGORY");
    }

    #[test]
    fn unknown_top_level_field_rejected() {
        let e = validate_metadata(&json!({ "categoryId": "cat-watch", "tenant_id": "t1" }), 1).unwrap_err();
        assert_eq!(e.code, "UNKNOWN_FIELD");
        assert_eq!(e.field, "tenant_id");
    }

    #[test]
    fn unknown_attribute_key_rejected() {
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-watch", "attributes": { "storage_key": "x" } }), 1).unwrap_err().code, "UNKNOWN_FIELD");
    }

    #[test]
    fn wrong_category_attribute_rejected() {
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-watch", "attributes": { "weight": 5 } }), 1).unwrap_err().code, "UNKNOWN_FIELD");
    }

    #[test]
    fn bad_enum_rejected() {
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-watch", "attributes": { "material": "Wood" } }), 1).unwrap_err().code, "BAD_ENUM");
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-gold-jewelry", "attributes": { "karat": "99K" } }), 1).unwrap_err().code, "BAD_ENUM");
    }

    #[test]
    fn negative_and_nonfinite_numbers_rejected() {
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-gold-jewelry", "attributes": { "weight": -1 } }), 1).unwrap_err().code, "BAD_NUMBER");
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-gold-jewelry", "attributes": { "weight": "1.25" } }), 1).unwrap_err().code, "BAD_NUMBER");
        assert!(validate_metadata(&json!({ "categoryId": "cat-gold-jewelry", "attributes": { "weight": 1.25 } }), 1).is_ok());
    }

    #[test]
    fn oversized_string_rejected() {
        let big = "x".repeat(3000);
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-accessory", "attributes": { "description": big } }), 1).unwrap_err().code, "TOO_LONG");
    }

    #[test]
    fn bad_condition_and_scope_rejected() {
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-watch", "condition": "Broken" }), 1).unwrap_err().code, "BAD_ENUM");
        // branded-gold has NO scope options → scope injection is rejected even on v1 (validity).
        assert_eq!(validate_metadata(&json!({ "categoryId": "cat-branded-gold-jewelry", "scopeOfDelivery": ["Box"] }), 1).unwrap_err().code, "BAD_ENUM");
    }

    #[test]
    fn valid_scope_and_condition_accepted() {
        assert!(validate_metadata(&json!({ "categoryId": "cat-watch", "condition": "Vintage", "scopeOfDelivery": ["Box", "Papers", "Pouch"] }), 1).is_ok());
    }

    // ── CONTRACT-V2 — requiredness + dependsOn (enforced only for v2; v1 stays lenient) ──
    #[test]
    fn v2_missing_required_attribute_rejected_but_v1_ok() {
        // Watch requires case_diameter_mm/dial/material; a minimal payload is fine on v1, rejected on v2.
        let m = json!({ "categoryId": "cat-watch", "brand": "Rolex", "name": "Sub" });
        assert!(validate_metadata(&m, 1).is_ok(), "v1 lenient");
        let e = validate_metadata(&m, 2).unwrap_err();
        assert_eq!(e.code, "REQUIRED");
    }

    #[test]
    fn v2_missing_required_brand_rejected() {
        // branded category (watch) → brand+name required on v2.
        let e = validate_metadata(&json!({ "categoryId": "cat-watch", "name": "Sub", "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Steel" } }), 2).unwrap_err();
        assert_eq!(e.code, "REQUIRED");
        assert_eq!(e.field, "brand");
        // gold + accessory are NOT brand-required.
        assert!(validate_metadata(&json!({ "categoryId": "cat-gold-jewelry", "attributes": { "weight": 5, "item_type": "Ring", "karat": "18K Yellow" } }), 2).is_ok());
    }

    #[test]
    fn v2_dependson_required_and_stale_field() {
        // karat_color is required ONLY when material is a gold variant, and forbidden otherwise (fail-closed).
        // material=Steel → karat_color must NOT be present.
        let stale = json!({ "categoryId": "cat-watch", "brand": "R", "name": "S",
            "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Steel", "karat_color": "18K Yellow" } });
        assert_eq!(validate_metadata(&stale, 2).unwrap_err().code, "STALE_FIELD");
        // material=Solid Gold but karat_color missing → REQUIRED.
        let missing = json!({ "categoryId": "cat-watch", "brand": "R", "name": "S",
            "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Solid Gold" } });
        assert_eq!(validate_metadata(&missing, 2).unwrap_err().code, "REQUIRED");
        // material=Solid Gold + karat_color present → ok.
        let good = json!({ "categoryId": "cat-watch", "brand": "R", "name": "S",
            "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Solid Gold", "karat_color": "18K Yellow" } });
        assert_eq!(validate_metadata(&good, 2), Ok(()));
    }

    // ── MOBILE-PRICING — the three canonical prices, v2 only, validity + mass-assignment ──
    #[test]
    fn v2_accepts_valid_optional_prices_including_decimals() {
        let base = |extra: Value| {
            let mut m = json!({ "categoryId": "cat-watch", "brand": "R", "name": "S", "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Steel" } });
            for (k, v) in extra.as_object().unwrap() { m[k] = v.clone(); }
            m
        };
        assert_eq!(validate_metadata(&base(json!({ "purchasePrice": 1.25, "plannedSalePrice": 2.5, "minSalePrice": 2.0 })), 2), Ok(()));
        assert_eq!(validate_metadata(&base(json!({ "purchasePrice": 0 })), 2), Ok(()), "zero purchase price allowed (desktop default)");
        assert_eq!(validate_metadata(&base(json!({ "plannedSalePrice": null })), 2), Ok(()), "null price is optional");
        // No relation enforced: min > sale is accepted (desktop enforces no product-save relation).
        assert_eq!(validate_metadata(&base(json!({ "plannedSalePrice": 1, "minSalePrice": 999 })), 2), Ok(()));
    }

    #[test]
    fn v1_rejects_pricing_keys_legacy_surface_unchanged() {
        // A v1 client that sends a price is rejected exactly like any other unknown field.
        let e = validate_metadata(&json!({ "categoryId": "cat-watch", "brand": "R", "name": "S", "purchasePrice": 10 }), 1).unwrap_err();
        assert_eq!(e.code, "UNKNOWN_FIELD");
        assert_eq!(e.field, "purchasePrice");
    }

    #[test]
    fn v2_rejects_bad_price_values() {
        let base = |k: &str, v: Value| {
            let mut m = json!({ "categoryId": "cat-watch", "brand": "R", "name": "S", "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Steel" } });
            m[k] = v; m
        };
        assert_eq!(validate_metadata(&base("purchasePrice", json!(-1)), 2).unwrap_err().code, "BAD_NUMBER");
        assert_eq!(validate_metadata(&base("plannedSalePrice", json!("100")), 2).unwrap_err().code, "BAD_NUMBER"); // string not number
        assert_eq!(validate_metadata(&base("minSalePrice", json!(true)), 2).unwrap_err().code, "BAD_NUMBER");
        assert_eq!(validate_metadata(&base("purchasePrice", json!([1])), 2).unwrap_err().code, "BAD_NUMBER");
        assert_eq!(validate_metadata(&base("purchasePrice", json!({ "x": 1 })), 2).unwrap_err().code, "BAD_NUMBER");
        // No invented ceiling: any finite non-negative number is a valid price, exactly like the desktop
        // REAL column (1.5e2 == 150, and a huge-but-finite value is still a number the DB can store).
        assert_eq!(validate_metadata(&base("purchasePrice", json!(1.5e2)), 2), Ok(()));
        assert_eq!(validate_metadata(&base("plannedSalePrice", json!(2_000_000_000.0)), 2), Ok(()));
        assert_eq!(validate_metadata(&base("purchasePrice", json!(1.5e300)), 2), Ok(()));
        // An overflow exponent (1e400) is not representable as an f64 → serde rejects it at JSON parse
        // time (before validation), i.e. the DTO deserialization is the first line of defence.
        assert!(serde_json::from_str::<Value>("{\"purchasePrice\":1e400}").is_err(), "overflow exponent rejected at parse");
    }

    #[test]
    fn v2_pricing_mass_assignment_still_blocked() {
        // A derived/system field disguised near pricing is still rejected (allow-list unchanged otherwise).
        for bad in ["expectedMargin", "expected_margin", "maxSalePrice", "vat_amount", "profit", "cost", "purchase_price"] {
            let mut m = json!({ "categoryId": "cat-watch", "brand": "R", "name": "S", "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Steel" } });
            m[bad] = json!(5);
            assert_eq!(validate_metadata(&m, 2).unwrap_err().code, "UNKNOWN_FIELD", "field {bad} must be rejected");
        }
    }

    #[test]
    fn v2_all_six_categories_have_a_satisfiable_required_set() {
        // A representative fully-required payload per category is accepted on v2 (proves the parsed required/
        // dependsOn map is coherent for every real category).
        let cases = [
            json!({ "categoryId": "cat-watch", "brand": "R", "name": "S", "attributes": { "case_diameter_mm": 40, "dial": "B", "material": "Steel" } }),
            json!({ "categoryId": "cat-gold-jewelry", "attributes": { "weight": 5.0, "item_type": "Ring", "karat": "18K Yellow" } }),
            json!({ "categoryId": "cat-branded-gold-jewelry", "brand": "Cartier", "name": "Love", "attributes": { "item_type": "Ring", "size": "52", "karat": "18K Yellow" } }),
            json!({ "categoryId": "cat-original-gold-jewelry", "brand": "X", "name": "Y", "attributes": { "item_type": "Ring", "karat": "21K Yellow" } }),
            json!({ "categoryId": "cat-accessory", "attributes": { "item_type": "Handbag", "color": "Black", "material": "Leather", "description": "nice" } }),
            json!({ "categoryId": "cat-spare-part", "brand": "X", "name": "Y", "attributes": { "part_type": "Dial", "material": "Steel", "original_or_copy": "Original", "description": "d" } }),
        ];
        for c in cases { assert_eq!(validate_metadata(&c, 2), Ok(()), "v2 required set unsatisfiable for {}", c["categoryId"]); }
    }
}
