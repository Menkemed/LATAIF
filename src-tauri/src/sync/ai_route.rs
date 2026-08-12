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
            | AiError::MalformedRequest => 400,
            AiError::ImageTooLarge => 413,
            AiError::KeyMissing => 503,
            AiError::UpstreamFailed => 502,
            AiError::MalformedResponse => 502,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct AiIdentifyRequest {
    pub category_id: String,
    /// A `data:` URL carrying the photo. Bytes only — never a path, never an http(s) location.
    pub image: String,
    #[serde(default)]
    pub hints: Option<String>,
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
pub async fn identify(
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
                { "type": "image_url", "image_url": { "url": req.image } }
            ]}
        ]
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|_| AiError::UpstreamFailed)?;
    let res = client
        .post(OPENAI_URL)
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
    let parsed = parse_completion(&body)?;
    Ok(filter_for_mobile(&parsed, category_id))
}

#[cfg(test)]
#[path = "ai_route_tests.rs"]
mod ai_route_tests;
