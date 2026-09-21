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
        (AiError::UnknownForm, 400),
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

// ── REPAIR-INTAKE §3/§4 — the second form kind ──────────────────────────────
//
// Same posture as the product filter: the model may answer with anything at all, and exactly six
// keys are believed. A repair intake sits next to money (a cost estimate, a deposit) and next to
// customer data, so everything outside those six is dropped rather than "ignored downstream".

const REPAIR_SIX: [&str; 6] = [
    "itemBrand", "itemModel", "itemReference", "itemSerial", "itemDescription", "issueDescription",
];

fn hostile_repair_answer() -> serde_json::Value {
    serde_json::json!({
        "itemBrand": "Rolex",
        "itemModel": "Submariner Date",
        "itemReference": "126610LN",
        "itemSerial": "  7K5N2X1  ",
        "itemDescription": "Steel diver's watch on an Oyster bracelet",
        "issueDescription": "Cracked crystal at 3 o'clock, bezel does not turn",
        // Everything below is what the model volunteers and the repair form must never adopt.
        "estimatedCost": 180,
        "repairCost": "180 BHD",
        "customerId": "cust-4711",
        "customerName": "Ahmed",
        "customerPhone": "+973 3000 0000",
        "status": "IN_PROGRESS",
        "repairNumber": "RPR-2026-0001",
        "id": "some-other-repair",
        "dueDate": "2026-10-01",
        "createdAt": "2026-09-16T10:00:00Z",
        "notes": "should not be adopted either"
    })
}

#[test]
fn the_repair_filter_keeps_exactly_the_six_allowed_fields() {
    let out = filter_for_repair(&hostile_repair_answer());
    let keys: Vec<&str> = out.keys().map(String::as_str).collect();
    let mut expected: Vec<&str> = REPAIR_SIX.to_vec();
    expected.sort_unstable();
    assert_eq!(keys, expected, "exactly the six contract fields, nothing else");
    assert_eq!(out.get("itemBrand").map(String::as_str), Some("Rolex"));
    assert_eq!(out.get("itemReference").map(String::as_str), Some("126610LN"));
    // Whitespace around a value is the model's, not the user's.
    assert_eq!(out.get("itemSerial").map(String::as_str), Some("7K5N2X1"));
    assert_eq!(
        out.get("issueDescription").map(String::as_str),
        Some("Cracked crystal at 3 o'clock, bezel does not turn")
    );
}

#[test]
fn no_cost_customer_id_status_or_date_survives_the_repair_filter() {
    let out = filter_for_repair(&hostile_repair_answer());
    let json = serde_json::to_string(&out).unwrap();
    for forbidden in [
        "estimatedCost", "repairCost", "customerId", "customerName", "customerPhone",
        "status", "repairNumber", "id", "dueDate", "createdAt", "notes",
        "180", "cust-4711", "Ahmed", "IN_PROGRESS", "RPR-2026-0001", "some-other-repair",
        "2026-10-01",
    ] {
        assert!(!json.contains(forbidden), "{forbidden} leaked through the repair filter: {json}");
    }
    for key in out.keys() {
        assert!(REPAIR_SIX.contains(&key.as_str()), "{key} is not an allowed repair field");
    }
}

#[test]
fn repair_null_like_and_non_string_answers_are_dropped() {
    let raw = serde_json::json!({
        "itemBrand": "null",
        "itemModel": "N/A",
        "itemReference": "-",
        "itemSerial": "   ",
        // A number, an object and an array are hallucinated shapes, not values.
        "itemDescription": 42,
        "issueDescription": { "text": "broken" }
    });
    let out = filter_for_repair(&raw);
    assert!(out.is_empty(), "nothing is invented when the model knows nothing: {out:?}");

    let arrays = serde_json::json!({ "itemBrand": ["Rolex"], "itemModel": true, "itemSerial": null });
    assert!(filter_for_repair(&arrays).is_empty(), "only strings are believed");
    assert!(filter_for_repair(&serde_json::json!({})).is_empty());
    assert!(filter_for_repair(&serde_json::json!("not an object")).is_empty());
}

#[test]
fn an_over_long_repair_value_is_truncated_rather_than_adopted_whole() {
    let long = "ä".repeat(REPAIR_MAX_VALUE_LEN + 250);
    let raw = serde_json::json!({ "issueDescription": format!("  {long}  ") });
    let out = filter_for_repair(&raw);
    let v = out.get("issueDescription").expect("a long value is kept, capped");
    assert_eq!(v.chars().count(), REPAIR_MAX_VALUE_LEN, "capped by characters, not bytes");
    // Truncating a multi-byte string by bytes would produce invalid UTF-8 or a split character.
    assert!(v.chars().all(|c| c == 'ä'));
}

/// The model sometimes echoes the `{ … }` skeleton it was shown wrapped in a `fields` object.
#[test]
fn a_repair_answer_wrapped_in_fields_is_read_the_same_way() {
    let raw = serde_json::json!({ "fields": { "itemBrand": "Cartier", "customerId": "c-1" } });
    let out = filter_for_repair(&raw);
    assert_eq!(out.get("itemBrand").map(String::as_str), Some("Cartier"));
    assert!(!out.contains_key("customerId"));
}

#[test]
fn the_repair_response_serialises_under_a_fields_envelope() {
    let out = AiIdentifyOutcome::Repair(RepairIdentifyResponse {
        fields: filter_for_repair(&serde_json::json!({ "itemBrand": "Rolex" })),
    });
    assert_eq!(serde_json::to_string(&out).unwrap(), r#"{"fields":{"itemBrand":"Rolex"}}"#);
    // …while the product arm keeps the shape it always had.
    let product = AiIdentifyOutcome::Product(AiIdentifyResponse::default());
    assert_eq!(serde_json::to_string(&product).unwrap(), r#"{"attributes":{}}"#);
}

// ── REPAIR-INTAKE §4 — request shape and dispatch ───────────────────────────
#[test]
fn kind_defaults_to_product_when_the_client_does_not_send_one() {
    let req: AiIdentifyRequest = serde_json::from_str(
        r#"{"category_id":"cat-watch","image":"data:image/jpeg;base64,AAAA"}"#,
    )
    .expect("an older client sends no kind at all");
    assert_eq!(req.kind, "product", "an absent kind is the product form, never an error");

    let explicit: AiIdentifyRequest = serde_json::from_str(
        r#"{"category_id":"","image":"data:image/jpeg;base64,AAAA","kind":"repair"}"#,
    )
    .unwrap();
    assert_eq!(explicit.kind, "repair");
}

fn req(kind: &str, category_id: &str) -> AiIdentifyRequest {
    serde_json::from_value(serde_json::json!({
        "category_id": category_id,
        "image": img("image/jpeg", OK_BODY),
        "kind": kind,
    }))
    .unwrap()
}

#[tokio::test]
async fn the_repair_form_needs_no_category_while_the_product_form_still_does() {
    // An empty directory: no key. Getting as far as KeyMissing proves the category was never
    // consulted, and no network call can happen without a key.
    let dir = std::env::temp_dir().join(format!("com.lataif.aikind-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&dir).unwrap();

    for category in ["", "   ", "cat-nonsense", "cat-watch"] {
        assert_eq!(
            identify(&dir, &req("repair", category)).await.unwrap_err(),
            AiError::KeyMissing,
            "the repair form ignores category_id ({category:?})"
        );
    }
    // The product form is unchanged: an unknown category is refused before anything else.
    assert_eq!(
        identify(&dir, &req("product", "cat-nonsense")).await.unwrap_err(),
        AiError::UnknownCategory
    );
    assert_eq!(identify(&dir, &req("", "cat-watch")).await.unwrap_err(), AiError::KeyMissing);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_unknown_form_kind_is_refused_with_its_own_code() {
    let dir = std::env::temp_dir().join(format!("com.lataif.aikind-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&dir).unwrap();
    for kind in ["Repair", "repairs", "product-v2", "invoice", "../repair"] {
        let err = identify(&dir, &req(kind, "cat-watch")).await.unwrap_err();
        assert_eq!(err, AiError::UnknownForm, "{kind} must not resolve to a form");
        assert_eq!(err.code(), "AI_UNKNOWN_FORM");
        assert_eq!(err.status(), 400);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_repair_form_validates_the_image_exactly_like_the_product_form() {
    let dir = std::env::temp_dir().join(format!("com.lataif.aikind-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&dir).unwrap();
    for (image, expected) in [
        ("", AiError::NoImage),
        ("https://evil.example/pixel.jpg", AiError::UnsupportedMediaType),
        ("file:///etc/passwd", AiError::UnsupportedMediaType),
        ("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", AiError::UnsupportedMediaType),
    ] {
        let r: AiIdentifyRequest = serde_json::from_value(serde_json::json!({
            "category_id": "", "image": image, "kind": "repair",
        }))
        .unwrap();
        assert_eq!(identify(&dir, &r).await.unwrap_err(), expected, "repair: {image}");
    }
    let _ = std::fs::remove_dir_all(&dir);
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

// ── MOBILE-I1F §3 — the upstream endpoint cannot be redirected in production ──
//
// The override is compiled out of the production binary, so this pair of tests reads differently in
// each build and that is the point: with `e2e` absent the environment is ignored entirely.
#[test]
fn the_upstream_endpoint_is_a_constant_in_a_production_build() {
    // Set the variable regardless; a production build must not even look at it.
    std::env::set_var("LATAIF_E2E_AI_UPSTREAM", "http://127.0.0.1:1/hijack");
    let resolved = upstream_url();
    #[cfg(not(feature = "e2e"))]
    assert_eq!(resolved, OPENAI_URL, "a production build must ignore any upstream override");
    #[cfg(feature = "e2e")]
    assert_eq!(resolved, "http://127.0.0.1:1/hijack", "the e2e build honours its own environment");
    std::env::remove_var("LATAIF_E2E_AI_UPSTREAM");
    assert_eq!(upstream_url(), OPENAI_URL, "with no override the constant endpoint is used");
}

/// The request shape carries no endpoint field at all — a client cannot name a destination even if
/// a future build did read one.
#[test]
fn the_request_contract_has_no_endpoint_field() {
    let parsed: Result<AiIdentifyRequest, _> = serde_json::from_str(
        r#"{"category_id":"cat-watch","image":"data:image/jpeg;base64,AAAA","base_url":"http://evil.example","endpoint":"http://evil.example"}"#,
    );
    let req = parsed.expect("unknown keys are ignored, not adopted");
    assert_eq!(req.category_id, "cat-watch");
    // Nothing on the struct can hold a destination.
    let json = serde_json::to_string(&serde_json::json!({
        "category_id": req.category_id, "image": req.image, "hints": req.hints
    })).unwrap();
    assert!(!json.contains("evil.example"), "no client-supplied endpoint survives parsing");
}

// -- POST-PARITY R7B PP-3 -- /ai/status answers from the same key file, and only yes/no --------------
#[test]
fn key_present_follows_the_key_file_and_nothing_else() {
    use base64::Engine;
    let dir = std::env::temp_dir().join(format!("com.lataif.aistatus-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(!key_present(&dir), "no file: not ready");
    std::fs::write(dir.join("openai.key"), "   ").unwrap();
    assert!(!key_present(&dir), "an empty file: not ready");
    let plain = b"sk-status-check";
    let obf: Vec<u8> = plain.iter().enumerate().map(|(i, b)| b ^ OBF_SEED[i % OBF_SEED.len()]).collect();
    std::fs::write(dir.join("openai.key"), base64::engine::general_purpose::STANDARD.encode(obf)).unwrap();
    assert!(key_present(&dir), "a readable key: ready");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_status_route_returns_one_boolean_and_never_the_key() {
    // Zeilenenden vereinheitlichen: ein Windows-Checkout (autocrlf) liefert CRLF, sonst fände "\n}\n" nie ein Ende.
    let src = include_str!("routes.rs").replace("\r\n", "\n");
    let i = src.find("async fn ai_status_route").expect("the status handler exists");
    let end = i + src[i..].find("\n}\n").expect("handler end");
    let body = &src[i..end];
    assert!(body.contains("key_present(state.data_root.path())"), "asks the same data root as identify");
    assert!(body.contains(r#""identify": ready"#), "answers one boolean");
    assert!(!body.contains("read_api_key"), "the handler never holds the key itself");
    assert!(body.contains("claims.role.trim().is_empty()"), "the same role check as identify");
    assert!(src.contains(r#".route("/ai/status", get(ai_status_route))"#), "a GET inside the protected group");
}
