// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1B §1 — the SHARED AI-identify contract, Rust side.
//
// Reads the SAME `identify-contract.json` the desktop client imports and assembles the SAME prompt
// from it. Not a port, not a translation: one file, two readers. The parity test computes an FNV-1a
// fingerprint over every category's assembled prompts and compares it with the value the TypeScript
// side produces — if either implementation drifts, the number changes and the build fails.
//
// That gate is what makes a second execution path acceptable at all. Mobile cannot run the desktop
// client (it is a phone browser, and the OpenAI key must never leave this machine), so the request
// is executed here — but the INSTRUCTION is not written twice.
//
// This module builds text. It does not read the key and does not call a model; that belongs to the
// route, which keeps the secret on this side of the wire.
// ════════════════════════════════════════════════════════════════════════════

use serde::Deserialize;

/// The contract file, embedded at compile time. A missing or malformed file is a build failure
/// rather than a runtime surprise — the mobile route must never fall back to an invented prompt.
const CONTRACT_JSON: &str = include_str!("../../../src/core/ai/identify-contract.json");

#[derive(Debug, Deserialize)]
pub struct CategorySpec {
    pub name: String,
    pub required: Vec<String>,
    pub optional: Vec<String>,
    #[serde(rename = "conditionOptions")]
    pub condition_options: Vec<String>,
    #[serde(rename = "scopeOptions")]
    pub scope_options: Vec<String>,
    pub notes: String,
}

#[derive(Debug, Deserialize)]
pub struct ModelParams {
    #[serde(rename = "maxTokens")]
    pub max_tokens: u32,
    pub temperature: f64,
}

#[derive(Debug, Deserialize)]
pub struct IdentifyContract {
    #[serde(rename = "contractVersion")]
    pub contract_version: u32,
    pub model: ModelParams,
    #[serde(rename = "systemPromptTemplate")]
    pub system_prompt_template: String,
    #[serde(rename = "watchExtra")]
    pub watch_extra: String,
    #[serde(rename = "userPromptWithHints")]
    pub user_prompt_with_hints: String,
    #[serde(rename = "userPromptWithoutHints")]
    pub user_prompt_without_hints: String,
    pub categories: std::collections::BTreeMap<String, CategorySpec>,
    #[serde(rename = "mobileAllowedFields")]
    pub mobile_allowed_fields: Vec<String>,
    #[serde(rename = "mobileForbiddenFields")]
    pub mobile_forbidden_fields: Vec<String>,
}

pub fn contract() -> &'static IdentifyContract {
    use std::sync::OnceLock;
    static C: OnceLock<IdentifyContract> = OnceLock::new();
    C.get_or_init(|| {
        serde_json::from_str(CONTRACT_JSON).expect("identify-contract.json is malformed — the shared AI contract must parse")
    })
}

pub fn category_spec(category_id: &str) -> Option<&'static CategorySpec> {
    contract().categories.get(category_id)
}

/// Required keys then optional keys, each mapped to null — the exact order the desktop renders, and
/// part of the text the fingerprint covers.
fn attribute_nulls(spec: &CategorySpec) -> String {
    spec.required
        .iter()
        .chain(spec.optional.iter())
        .map(|k| format!("\"{k}\": null"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn fill(template: &str, spec: &CategorySpec) -> String {
    template
        .replace("{{CATEGORY_NAME}}", &spec.name)
        .replace("{{REQUIRED}}", &spec.required.join(", "))
        .replace("{{OPTIONAL}}", &spec.optional.join(", "))
        .replace("{{CONDITION_OPTIONS}}", &spec.condition_options.join(" | "))
        .replace("{{SCOPE_OPTIONS}}", &spec.scope_options.join(" | "))
        .replace("{{NOTES}}", &spec.notes)
        .replace("{{ATTRIBUTE_NULLS}}", &attribute_nulls(spec))
}

pub fn build_system_prompt(category_id: &str) -> Option<String> {
    Some(fill(&contract().system_prompt_template, category_spec(category_id)?))
}

pub fn build_user_prompt(category_id: &str, hints: &str) -> Option<String> {
    let spec = category_spec(category_id)?;
    let c = contract();
    let watch_extra = if category_id == "cat-watch" { c.watch_extra.as_str() } else { "" };
    let template = if hints.is_empty() { &c.user_prompt_without_hints } else { &c.user_prompt_with_hints };
    Some(
        fill(template, spec)
            .replace("{{HINTS}}", hints)
            .replace("{{WATCH_EXTRA}}", watch_extra),
    )
}

/// 64-bit FNV-1a, lowercase hex — byte-for-byte the same function the TypeScript side runs.
pub fn fnv1a64(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in input.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The drift detector: every category's assembled prompts, joined and hashed. The TypeScript
/// `contractFingerprint()` builds the identical string from the identical file.
pub fn contract_fingerprint() -> String {
    // Hash the per-prompt hashes rather than one concatenated blob: each prompt's digest is
    // unambiguous, so the result cannot depend on a separator convention or on how either language
    // joins a list. Each line reads `<id>:<kind>:<hash>`, which also makes a mismatch legible - the
    // differing line names the category and the prompt that drifted.
    let mut lines: Vec<String> = Vec::new();
    // BTreeMap iterates in sorted key order, matching the TS side's explicit sort.
    for id in contract().categories.keys() {
        lines.push(format!("{id}:system:{}", fnv1a64(&build_system_prompt(id).unwrap_or_default())));
        lines.push(format!("{id}:user:{}", fnv1a64(&build_user_prompt(id, "").unwrap_or_default())));
        lines.push(format!(
            "{id}:user-hints:{}",
            fnv1a64(&build_user_prompt(id, "brand: Rolex").unwrap_or_default())
        ));
    }
    fnv1a64(&lines.join("|"))
}

#[cfg(test)]
#[path = "ai_identify_tests.rs"]
mod ai_identify_tests;
