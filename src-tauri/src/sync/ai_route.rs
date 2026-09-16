// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1C §1–§3 — server-side execution of the SHARED identify contract.
//
// The phone cannot run the desktop identifier: it is a browser on someone else's device, and the
// OpenAI key must never leave this machine. So the request is executed HERE, with the prompt built
// by `ai_identify` from the one `identify-contract.json` the desktop client also reads.
//
// ## What this module refuses to do
//
// • It never returns, logs or echoes the key. The key is read from disk inside `call_openai` and
//   dropped there; no error path carries it, and the error codes below are fixed strings.
// • It never fetches a URL the client names. The only network call is to a compile-time constant
//   endpoint; the client may send image BYTES, never a location.
// • It never returns a field outside `mobileAllowedFields`. The filter is an allow-list applied to
//   the model's answer, so a hallucinated price or quantity cannot reach the form even if the model
//   invents one — which it does, regularly.
// ════════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};

/// The only endpoint this module talks to. A constant, so no request body can redirect it.
const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";

/// Resolve the upstream endpoint.
///
/// In a production build this function has ONE branch and returns the constant above: the
/// environment lookup below is compiled out entirely, so there is no variable, no flag and no
/// configuration a remote client or a hostile environment could use to redirect an identification
/// request. The override exists only in the `e2e` build, which is a different binary with a
/// different bundle identifier, and even there it comes from THIS process's environment - never
/// from a request body, a header or a query parameter.
fn upstream_url() -> String {
    #[cfg(feature = "e2e")]
    {
        if let Ok(u) = std::env::var("LATAIF_E2E_AI_UPSTREAM") {
            let u = u.trim().to_string();
            if !u.is_empty() {
                return u;
            }
        }
    }
    OPENAI_URL.to_string()
}
const DEFAULT_MODEL: &str = "gpt-4o";

/// Same ceiling the ingest path uses for one image (25 MiB of raw bytes). Applied to the DECODED
/// size, because a base64 payload is what arrives and 25 MiB of image is ~33 MiB of text.
pub const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Obfuscation seed shared with `ai-service.ts`. This is NOT encryption and is not treated as such —
/// it only keeps the key from being readable at a glance in a file listing, exactly as the desktop
/// client stores it. Both sides must agree or the key cannot be read at all.
const OBF_SEED: &[u8] = b"lataif-2026-key-obf";

#[derive(Debug, PartialEq, Eq)]
pub enum AiError {
    NoImage,
    UnsupportedMediaType,
    ImageTooLarge,
    UnknownCategory,
    /// A `kind` the contract does not know. Distinct from `UnknownCategory` so a caller can tell
    /// "this form does not exist" from "this product category does not exist".
    UnknownForm,
    MalformedRequest,
    KeyMissing,
    UpstreamFailed,
    MalformedResponse,
}

impl AiError {
    pub fn code(&self) -> &'static str {
        match self {
            AiError::NoImage => "AI_IMAGE_REQUIRED",
            AiError::UnsupportedMediaType => "AI_IMAGE_UNSUPPORTED_TYPE",
            AiError::ImageTooLarge => "AI_IMAGE_TOO_LARGE",
            AiError::UnknownCategory => "AI_UNKNOWN_CATEGORY",
            AiError::UnknownForm => "AI_UNKNOWN_FORM",
            AiError::MalformedRequest => "AI_MALFORMED_REQUEST",
            AiError::KeyMissing => "AI_NOT_CONFIGURED",
            AiError::UpstreamFailed => "AI_UPSTREAM_FAILED",
            AiError::MalformedResponse => "AI_MALFORMED_RESPONSE",
        }
    }
    /// HTTP status for this refusal. Deliberately explicit rather than derived, so a new variant
    /// has to state what it means to a caller instead of inheriting a default.
    pub fn status(&self) -> u16 {
        match self {
            AiError::NoImage
            | AiError::UnsupportedMediaType
            | AiError::UnknownCategory
            | AiError::UnknownForm
            | AiError::MalformedRequest => 400,
            AiError::ImageTooLarge => 413,
            AiError::KeyMissing => 503,
            AiError::UpstreamFailed => 502,
            AiError::MalformedResponse => 502,
        }
    }
}

/// The default form kind. An older client sends no `kind` at all and must keep behaving exactly as
/// it did, so the absent value resolves to the product form rather than to an error.
pub const KIND_PRODUCT: &str = "product";
pub const KIND_REPAIR: &str = "repair";

fn default_kind() -> String {
    KIND_PRODUCT.to_string()
}

#[derive(Debug, Deserialize)]
pub struct AiIdentifyRequest {
    pub category_id: String,
    /// A `data:` URL carrying the photo. Bytes only — never a path, never an http(s) location.
    pub image: String,
    #[serde(default)]
    pub hints: Option<String>,
    /// Which form is asking: `"product"` (the default, unchanged behaviour) or `"repair"`.
    #[serde(default = "default_kind")]
    pub kind: String,
}

#[derive(Debug, Serialize, Default, PartialEq)]
pub struct AiIdentifyResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub scope_of_delivery: Vec<String>,
    /// Only keys the requested category actually declares. A key the category does not know is
    /// dropped: it would become a stale attribute the v2 upload contract then rejects.
    pub attributes: std::collections::BTreeMap<String, String>,
}

/// The repair form's answer: one flat map of the six allowed keys, nested under `fields` so the
/// route's `{"result": …}` envelope stays one shape while the two form kinds stay distinguishable.
#[derive(Debug, Serialize, Default, PartialEq)]
pub struct RepairIdentifyResponse {
    pub fields: std::collections::BTreeMap<String, String>,
}

/// What one identification produced. Untagged: the product arm serialises EXACTLY as it always did
/// (`{"result": {…product fields…}}`), the repair arm as `{"result": {"fields": {…}}}`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum AiIdentifyOutcome {
    Product(AiIdentifyResponse),
    Repair(RepairIdentifyResponse),
}

/// Longest value a single repair field may carry. The model is asked for one short sentence; a
/// runaway paragraph is truncated rather than refused, because a clipped hint is still useful and a
/// dropped one is not.
pub const REPAIR_MAX_VALUE_LEN: usize = 400;

/// Validate the incoming image and return its decoded byte length.
///
/// Accepts exactly the three raster types the media core can normalise. A `data:` URL is the only
/// accepted shape, which is what makes "no local path, no remote fetch" structural rather than a
/// check someone can forget: there is no branch here that could ever open a file or a socket.
pub fn validate_image(data_url: &str) -> Result<usize, AiError> {
    let trimmed = data_url.trim();
    if trimmed.is_empty() {
        return Err(AiError::NoImage);
    }
    // A path or a URL is not merely unsupported — accepting one would turn this route into an
    // arbitrary-fetch primitive on the LAN, so both are refused before anything else.
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file://") {
        return Err(AiError::UnsupportedMediaType);
    }
    if !lower.starts_with("data:") {
        return Err(AiError::UnsupportedMediaType);
    }
    let Some(comma) = trimmed.find(',') else { return Err(AiError::MalformedRequest) };
    let header = &lower[..comma];
    if !header.contains(";base64") {
        return Err(AiError::UnsupportedMediaType);
    }
    let mime_ok = header.starts_with("data:image/jpeg")
        || header.starts_with("data:image/jpg")
        || header.starts_with("data:image/png")
        || header.starts_with("data:image/webp");
    if !mime_ok {
        return Err(AiError::UnsupportedMediaType);
    }
    let body = &trimmed[comma + 1..];
    if body.trim().is_empty() {
        return Err(AiError::NoImage);
    }
    // Decoded length without allocating: 4 base64 chars carry 3 bytes.
    let chars = body.chars().filter(|c| !c.is_whitespace()).count();
    let pad = body.trim_end().chars().rev().take_while(|c| *c == '=').count();
    let decoded = chars.saturating_mul(3) / 4 - pad.min(2);
    if decoded == 0 {
        return Err(AiError::NoImage);
    }
    if decoded > MAX_IMAGE_BYTES {
        return Err(AiError::ImageTooLarge);
    }
    Ok(decoded)
}

/// Read and de-obfuscate the key. Returns `KeyMissing` for absent, empty or undecodable — the route
/// then answers 503 without ever mentioning what it found.
pub fn read_api_key(app_data_dir: &std::path::Path) -> Result<String, AiError> {
    use base64::Engine;
    let blob = std::fs::read_to_string(app_data_dir.join("openai.key")).map_err(|_| AiError::KeyMissing)?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(blob.trim())
        .map_err(|_| AiError::KeyMissing)?;
    let key: String = raw
        .iter()
        .enumerate()
        .map(|(i, b)| (b ^ OBF_SEED[i % OBF_SEED.len()]) as char)
        .collect();
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(AiError::KeyMissing);
    }
    Ok(key)
}

/// POST-PARITY R7B PP-3 — can this machine identify? Asked by a client BEFORE it sends a photo.
/// The key is read exactly as the identify route reads it and dropped here; only yes/no leaves.
pub fn key_present(app_data_dir: &std::path::Path) -> bool {
    read_api_key(app_data_dir).is_ok()
}

/// Strip the model's answer down to what the mobile surface may adopt.
///
/// The allow-list comes from the shared contract, so "what mobile may take" is one decision made in
/// one file rather than a filter written twice. Everything else — prices, quantity, ids, status —
/// is dropped silently: the model is not asked to stop inventing them, it is simply never believed.
pub fn filter_for_mobile(raw: &serde_json::Value, category_id: &str) -> AiIdentifyResponse {
    let contract = super::ai_identify::contract();
    let allowed: std::collections::BTreeSet<&str> =
        contract.mobile_allowed_fields.iter().map(String::as_str).collect();

    let text = |key: &str| -> Option<String> {
        if !allowed.contains(key) {
            return None;
        }
        let v = raw.get(key)?.as_str()?.trim();
        // The model returns literal "null"/"N/A"/"-" instead of omitting a field it does not know.
        if v.is_empty() || v.eq_ignore_ascii_case("null") || v.eq_ignore_ascii_case("n/a") || v == "-" {
            return None;
        }
        Some(v.to_string())
    };

    let scope = if allowed.contains("scopeOfDelivery") {
        raw.get("scopeOfDelivery")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Attributes: only keys THIS category declares, only non-empty values.
    let mut attributes = std::collections::BTreeMap::new();
    if let Some(spec) = super::ai_identify::category_spec(category_id) {
        let known: std::collections::BTreeSet<&str> = spec
            .required
            .iter()
            .chain(spec.optional.iter())
            .map(String::as_str)
            .collect();
        if let Some(obj) = raw.get("attributes").and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if !known.contains(k.as_str()) {
                    continue;
                }
                let rendered = match v {
                    serde_json::Value::String(s) => s.trim().to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    _ => String::new(),
                };
                if rendered.is_empty()
                    || rendered.eq_ignore_ascii_case("null")
                    || rendered.eq_ignore_ascii_case("n/a")
                {
                    continue;
                }
                attributes.insert(k.clone(), rendered);
            }
        }
    }

    AiIdentifyResponse {
        brand: text("brand"),
        name: text("name"),
        condition: text("condition"),
        description: text("description"),
        storage_location: text("storageLocation"),
        notes: text("notes"),
        scope_of_delivery: scope,
        attributes,
    }
}

/// Strip a repair answer down to the six fields the repair form may adopt.
///
/// Same posture as `filter_for_mobile`: an allow-list from the shared contract, applied to the
/// model's answer. A cost estimate, a customer name, a record number or a status the model
/// volunteered is dropped silently — it is never believed, not merely discouraged in the prompt.
pub fn filter_for_repair(raw: &serde_json::Value) -> std::collections::BTreeMap<String, String> {
    // The model occasionally wraps its answer in the `fields` object it was shown; accept both
    // shapes, but read the values from exactly one of them.
    let src = raw
        .get("fields")
        .filter(|v| v.is_object())
        .unwrap_or(raw);

    let mut out = std::collections::BTreeMap::new();
    for key in super::ai_identify::repair_fields() {
        // Only strings. A number, an object or an array in one of these slots is a hallucinated
        // shape (a price, a nested record) and is dropped rather than rendered into text.
        let Some(value) = src.get(key.as_str()).and_then(|v| v.as_str()) else {
            continue;
        };
        let trimmed = value.trim();
        // The model returns literal "null"/"N/A"/"-" instead of omitting a field it does not know.
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("null")
            || trimmed.eq_ignore_ascii_case("n/a")
            || trimmed == "-"
        {
            continue;
        }
        // Truncate by CHARACTERS, never by bytes — a byte slice could split a multi-byte character.
        let capped: String = trimmed.chars().take(REPAIR_MAX_VALUE_LEN).collect();
        out.insert(key.clone(), capped);
    }
    out
}

/// Pull the JSON object out of a chat completion, tolerating the ```json fences the model adds.
pub fn parse_completion(body: &serde_json::Value) -> Result<serde_json::Value, AiError> {
    let content = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or(AiError::MalformedResponse)?;
    let cleaned = content
        .replace("```json", "")
        .replace("```", "")
        .trim()
        .to_string();
    serde_json::from_str(&cleaned).map_err(|_| AiError::MalformedResponse)
}

/// Execute one identification. The key is read here and never leaves this function.
///
/// Two form kinds share this path. `product` is the original behaviour, byte for byte: the same
/// category check, the same prompts, the same filter, the same response shape. `repair` ignores the
/// category entirely, uses the repair prompts and answers with the six-field map. The image
/// validation is the SAME call for both — no form gets a weaker check than another.
pub async fn identify(
    app_data_dir: &std::path::Path,
    req: &AiIdentifyRequest,
) -> Result<AiIdentifyOutcome, AiError> {
    let kind = req.kind.trim();
    // An empty string is what an over-eager client sends instead of omitting the field; it means
    // the same thing as absent.
    let kind = if kind.is_empty() { KIND_PRODUCT } else { kind };
    match kind {
        KIND_PRODUCT => identify_product(app_data_dir, req).await.map(AiIdentifyOutcome::Product),
        KIND_REPAIR => identify_repair(app_data_dir, req).await.map(AiIdentifyOutcome::Repair),
        _ => Err(AiError::UnknownForm),
    }
}

/// REPAIR-INTAKE §4 — the repair form. No category is consulted, so `category_id` may be empty or
/// nonsense; the only inputs that matter are the photo and the optional hints.
async fn identify_repair(
    app_data_dir: &std::path::Path,
    req: &AiIdentifyRequest,
) -> Result<RepairIdentifyResponse, AiError> {
    validate_image(&req.image)?;
    let system = super::ai_identify::build_repair_system_prompt();
    let hints = req.hints.as_deref().unwrap_or("").trim().to_string();
    let user_text = super::ai_identify::build_repair_user_prompt(&hints);
    let parsed = call_model(app_data_dir, &system, &user_text, &req.image).await?;
    Ok(RepairIdentifyResponse { fields: filter_for_repair(&parsed) })
}

async fn identify_product(
    app_data_dir: &std::path::Path,
    req: &AiIdentifyRequest,
) -> Result<AiIdentifyResponse, AiError> {
    let category_id = req.category_id.trim();
    if super::ai_identify::category_spec(category_id).is_none() {
        return Err(AiError::UnknownCategory);
    }
    validate_image(&req.image)?;

    let system = super::ai_identify::build_system_prompt(category_id).ok_or(AiError::UnknownCategory)?;
    let hints = req.hints.as_deref().unwrap_or("").trim().to_string();
    let user_text = super::ai_identify::build_user_prompt(category_id, &hints).ok_or(AiError::UnknownCategory)?;

    let parsed = call_model(app_data_dir, &system, &user_text, &req.image).await?;
    Ok(filter_for_mobile(&parsed, category_id))
}

/// One upstream call, shared by both form kinds so neither can drift into its own transport rules.
/// The key is read here and dropped here; no error path carries it.
async fn call_model(
    app_data_dir: &std::path::Path,
    system: &str,
    user_text: &str,
    image: &str,
) -> Result<serde_json::Value, AiError> {
    let params = &super::ai_identify::contract().model;

    let key = read_api_key(app_data_dir)?;
    let payload = serde_json::json!({
        "model": DEFAULT_MODEL,
        "max_tokens": params.max_tokens,
        "temperature": params.temperature,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": [
                { "type": "text", "text": user_text },
                { "type": "image_url", "image_url": { "url": image } }
            ]}
        ]
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|_| AiError::UpstreamFailed)?;
    let res = client
        .post(upstream_url())
        .bearer_auth(&key)
        .json(&payload)
        .send()
        .await
        .map_err(|_| AiError::UpstreamFailed)?;
    if !res.status().is_success() {
        // The upstream body can echo request fragments; it is never forwarded or logged.
        return Err(AiError::UpstreamFailed);
    }
    let body: serde_json::Value = res.json().await.map_err(|_| AiError::MalformedResponse)?;
    parse_completion(&body)
}

#[cfg(test)]
#[path = "ai_route_tests.rs"]
mod ai_route_tests;
