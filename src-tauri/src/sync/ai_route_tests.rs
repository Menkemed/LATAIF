// MOBILE-I1C §2/§3/§7 — the negative matrix and the output allow-list.
//
// Everything here runs without a network: validation and filtering are pure, which is exactly why
// they were separated from the request. The two properties worth proving are that a malformed or
// hostile input is refused BEFORE a key is ever read, and that no answer the model can produce —
// however confident, however well-formed — carries a price, a quantity or a system field into the
// mobile form.

use super::*;

fn img(mime: &str, body: &str) -> String {
    format!("data:{mime};base64,{body}")
}
const OK_BODY: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";

// ── §2 — input validation ───────────────────────────────────────────────────
#[test]
fn a_well_formed_image_of_each_supported_type_is_accepted() {
    for mime in ["image/jpeg", "image/jpg", "image/png", "image/webp"] {
        assert!(validate_image(&img(mime, OK_BODY)).is_ok(), "{mime} must be accepted");
    }
    // Case in the header must not matter.
    assert!(validate_image(&img("IMAGE/JPEG", OK_BODY)).is_ok());
}

#[test]
fn an_empty_or_missing_image_is_refused() {
    assert_eq!(validate_image("").unwrap_err(), AiError::NoImage);
    assert_eq!(validate_image("   ").unwrap_err(), AiError::NoImage);
    assert_eq!(validate_image(&img("image/jpeg", "")).unwrap_err(), AiError::NoImage);
    assert_eq!(validate_image(&img("image/jpeg", "   ")).unwrap_err(), AiError::NoImage);
}

#[test]
fn an_unsupported_media_type_is_refused() {
    for mime in ["image/gif", "image/svg+xml", "application/pdf", "text/html", "application/json"] {
        assert_eq!(
            validate_image(&img(mime, OK_BODY)).unwrap_err(),
            AiError::UnsupportedMediaType,
            "{mime} must be refused"
        );
    }
    // An SVG is the interesting one: it is an image to a browser and a script host to an attacker.
    assert_eq!(
        validate_image("data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=").unwrap_err(),
        AiError::UnsupportedMediaType
    );
}

/// §2 — the route must never become a fetch primitive. A URL or a path is refused structurally:
/// there is no branch that opens a socket or a file, and these assertions pin that shut.
#[test]
fn a_url_or_local_path_is_never_accepted_as_an_image() {
    for hostile in [
        "https://evil.example/pixel.jpg",
        "http://169.254.169.254/latest/meta-data/",
        "file:///C:/Users/nasbg/AppData/Roaming/com.lataif.app/openai.key",
        "file:///etc/passwd",
        "C:\\Users\\nasbg\\AppData\\Roaming\\com.lataif.app\\openai.key",
        "/etc/passwd",
        "\\\\server\\share\\x.jpg",
        "../../../openai.key",
    ] {
        assert_eq!(
            validate_image(hostile).unwrap_err(),
            AiError::UnsupportedMediaType,
            "{hostile} must never be treated as an image"
        );
    }
}

#[test]
fn a_non_base64_or_malformed_data_url_is_refused() {
    assert_eq!(validate_image("data:image/jpeg,rawtext").unwrap_err(), AiError::UnsupportedMediaType);
    assert_eq!(validate_image("data:image/jpeg;base64").unwrap_err(), AiError::MalformedRequest);
    assert_eq!(validate_image("notadataurl").unwrap_err(), AiError::UnsupportedMediaType);
}

#[test]
fn an_oversized_image_is_refused_with_its_own_code() {
    // 4 base64 chars per 3 bytes, so this decodes to just over the ceiling.
    let huge = "A".repeat((MAX_IMAGE_BYTES / 3 + 2) * 4);
    assert_eq!(validate_image(&img("image/jpeg", &huge)).unwrap_err(), AiError::ImageTooLarge);
    // …and one just under it is fine.
    let ok = "A".repeat((MAX_IMAGE_BYTES / 3 - 10) * 4 / 3);
    assert!(validate_image(&img("image/jpeg", &ok)).is_ok());
}

#[test]
fn every_refusal_has_a_distinct_code_and_an_explicit_status() {
    let all = [
        (AiError::NoImage, 400), (AiError::UnsupportedMediaType, 400),
        (AiError::ImageTooLarge, 413), (AiError::UnknownCategory, 400),
        (AiError::MalformedRequest, 400), (AiError::KeyMissing, 503),
        (AiError::UpstreamFailed, 502), (AiError::MalformedResponse, 502),
    ];
    let mut codes = std::collections::BTreeSet::new();
    for (e, status) in &all {
        assert_eq!(e.status(), *status, "{} has the wrong status", e.code());
        assert!(codes.insert(e.code()), "duplicate error code {}", e.code());
        // No refusal may ever carry a secret or a path in its text.
        assert!(e.code().starts_with("AI_"));
        assert!(!e.code().contains("key") && !e.code().to_lowercase().contains("sk-"));
    }
}

// ── §1 — the key never leaves this machine ──────────────────────────────────
#[test]
fn a_missing_or_unreadable_key_is_a_plain_refusal() {
    let dir = std::env::temp_dir().join(format!("com.lataif.aikey-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(read_api_key(&dir).unwrap_err(), AiError::KeyMissing, "absent file");
    std::fs::write(dir.join("openai.key"), "").unwrap();
    assert_eq!(read_api_key(&dir).unwrap_err(), AiError::KeyMissing, "empty file");
    std::fs::write(dir.join("openai.key"), "!!!not base64!!!").unwrap();
    assert_eq!(read_api_key(&dir).unwrap_err(), AiError::KeyMissing, "undecodable file");
}

/// The de-obfuscation must match `ai-service.ts` exactly, or the desktop-written key is unreadable
/// here — which would look like "AI not configured" with no way to tell why.
#[test]
fn a_key_written_the_desktop_way_round_trips() {
    use base64::Engine;
    const SEED: &[u8] = b"lataif-2026-key-obf";
    let plain = "sk-test-0123456789abcdefghijklmnop";
    let obf: Vec<u8> = plain.bytes().enumerate().map(|(i, b)| b ^ SEED[i % SEED.len()]).collect();
    let blob = base64::engine::general_purpose::STANDARD.encode(&obf);

    let dir = std::env::temp_dir().join(format!("com.lataif.aikey-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("openai.key"), &blob).unwrap();
    assert_eq!(read_api_key(&dir).unwrap(), plain);
    // The stored form is not the key — a file listing does not reveal it.
    assert!(!blob.contains("sk-test"));
}

// ── §3 — output allow-list ──────────────────────────────────────────────────
fn hostile_answer() -> serde_json::Value {
    serde_json::json!({
        "brand": "Rolex",
        "name": "Datejust 41 'Wimbledon'",
        "condition": "Pre-Owned",
        "description": "Slate dial, Roman numerals",
        "storageLocation": "Safe",
        "notes": "DD trail: considered A, B, C.",
        "scopeOfDelivery": ["Box", "Papers"],
        // Everything below is what the model volunteers and mobile must never adopt.
        "estimatedValue": 4200,
        "purchasePriceEstimate": 3100,
        "minSalePrice": 3900,
        "maxSalePrice": 4600,
        "purchasePrice": 3100,
        "plannedSalePrice": 4200,
        "quantity": 7,
        "sku": "RLX-FAKE-001",
        "taxScheme": "MARGIN",
        "id": "some-other-product",
        "stockStatus": "sold",
        "images": ["data:image/jpeg;base64,AAAA"],
        "syncStatus": "pending",
        "identificationConfidence": "high",
        "attributes": {
            "reference_number": "126334",
            "dial": "Slate Roman",
            "material": "Two-Tone Steel/Gold",
            "quantity": 7,
            "purchase_price": 3100,
            "not_a_real_key": "nonsense"
        }
    })
}

#[test]
fn no_price_quantity_or_system_field_survives_the_filter() {
    let out = filter_for_mobile(&hostile_answer(), "cat-watch");
    let json = serde_json::to_string(&out).unwrap();
    for forbidden in [
        "estimatedValue", "purchasePriceEstimate", "minSalePrice", "maxSalePrice",
        "purchasePrice", "plannedSalePrice", "quantity", "sku", "taxScheme",
        "stockStatus", "syncStatus", "images", "4200", "3100", "3900", "4600",
        "RLX-FAKE-001", "some-other-product", "\"7\"",
    ] {
        assert!(!json.contains(forbidden), "{forbidden} leaked through the mobile filter: {json}");
    }
}

#[test]
fn the_recognised_identity_fields_do_come_through() {
    let out = filter_for_mobile(&hostile_answer(), "cat-watch");
    assert_eq!(out.brand.as_deref(), Some("Rolex"));
    assert_eq!(out.name.as_deref(), Some("Datejust 41 'Wimbledon'"));
    assert_eq!(out.condition.as_deref(), Some("Pre-Owned"));
    assert_eq!(out.description.as_deref(), Some("Slate dial, Roman numerals"));
    assert_eq!(out.storage_location.as_deref(), Some("Safe"));
    assert_eq!(out.scope_of_delivery, vec!["Box".to_string(), "Papers".to_string()]);
}

#[test]
fn attributes_are_restricted_to_keys_the_category_declares() {
    let out = filter_for_mobile(&hostile_answer(), "cat-watch");
    assert_eq!(out.attributes.get("reference_number").map(String::as_str), Some("126334"));
    assert_eq!(out.attributes.get("dial").map(String::as_str), Some("Slate Roman"));
    assert!(!out.attributes.contains_key("quantity"), "quantity is not a watch attribute");
    assert!(!out.attributes.contains_key("purchase_price"), "a price is never an attribute");
    assert!(!out.attributes.contains_key("not_a_real_key"), "an unknown key is dropped, not stored");
    // A key belonging to ANOTHER category is dropped too.
    let gold = filter_for_mobile(&hostile_answer(), "cat-gold-jewelry");
    assert!(!gold.attributes.contains_key("reference_number"), "watch keys are not gold keys");
}

/// §3 — "unknown" must stay unknown. The model writes literal "null"/"N/A"/"-" instead of omitting
/// a field, and adopting those as text would fill a form with junk that looks deliberate.
#[test]
fn null_like_answers_become_absent_rather_than_text() {
    let raw = serde_json::json!({
        "brand": "null", "name": "N/A", "condition": "-", "description": "   ",
        "attributes": { "dial": "null", "material": "  ", "bezel": "N/A", "year": 0 }
    });
    let out = filter_for_mobile(&raw, "cat-watch");
    assert_eq!(out.brand, None);
    assert_eq!(out.name, None);
    assert_eq!(out.condition, None);
    assert_eq!(out.description, None);
    assert!(!out.attributes.contains_key("dial"));
    assert!(!out.attributes.contains_key("material"));
    assert!(!out.attributes.contains_key("bezel"));
    // A real 0 is a value, not an absence — the desktop learned that lesson with purchase_price.
    assert_eq!(out.attributes.get("year").map(String::as_str), Some("0"));
}

#[test]
fn an_empty_answer_yields_an_empty_patch_rather_than_defaults() {
    let out = filter_for_mobile(&serde_json::json!({}), "cat-watch");
    assert_eq!(out, AiIdentifyResponse::default());
    let json = serde_json::to_string(&out).unwrap();
    assert_eq!(json, "{\"attributes\":{}}", "nothing is invented when the model knows nothing");
}

#[test]
fn an_unknown_category_yields_no_attributes_at_all() {
    let out = filter_for_mobile(&hostile_answer(), "cat-nonsense");
    assert!(out.attributes.is_empty(), "an unknown category cannot declare keys");
}

// ── §7 — malformed upstream answers ─────────────────────────────────────────
#[test]
fn a_malformed_completion_is_refused_rather_than_guessed() {
    for bad in [
        serde_json::json!({}),
        serde_json::json!({ "choices": [] }),
        serde_json::json!({ "choices": [{ "message": {} }] }),
        serde_json::json!({ "choices": [{ "message": { "content": "I think it is a Rolex." } }] }),
        serde_json::json!({ "choices": [{ "message": { "content": "" } }] }),
        serde_json::json!({ "error": { "message": "rate limited" } }),
    ] {
        assert_eq!(parse_completion(&bad).unwrap_err(), AiError::MalformedResponse);
    }
}

#[test]
fn a_fenced_json_completion_is_parsed() {
    let body = serde_json::json!({
        "choices": [{ "message": { "content": "```json\n{\"brand\":\"Rolex\"}\n```" } }]
    });
    assert_eq!(parse_completion(&body).unwrap()["brand"], serde_json::json!("Rolex"));
}
