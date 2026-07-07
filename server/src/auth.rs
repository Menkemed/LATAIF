use crate::models::Claims;
use crate::AppState;
use axum::{
    extract::Request, extract::State, http::StatusCode, middleware::Next, response::Response,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use std::sync::Arc;

/// The historical hard-coded development secret. Kept in exactly one place so the
/// loader can *reject* it in production — it is no longer a runtime fallback.
pub const DEV_JWT_SECRET: &str = "lataif_secret_2026_change_in_production";

/// Why the JWT secret could not be loaded. `Display` never contains a secret value.
#[derive(Debug, PartialEq, Eq)]
pub enum JwtSecretError {
    Missing,
    InsecureDevDefault,
}

impl std::fmt::Display for JwtSecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JwtSecretError::Missing => write!(
                f,
                "LATAIF_JWT_SECRET must be set. Refusing to start with an implicit development JWT secret."
            ),
            JwtSecretError::InsecureDevDefault => write!(
                f,
                "LATAIF_JWT_SECRET matches the known development default and is not secret. Set a unique value, or export LATAIF_ALLOW_DEV_JWT_SECRET=1 to permit it for local development only."
            ),
        }
    }
}

impl std::error::Error for JwtSecretError {}

/// Pure decision core (no environment access) so it is deterministically testable.
/// Fail-closed: an absent/blank secret — or the known dev default without an explicit
/// opt-in — is an error, never a silent fallback.
fn resolve_jwt_secret(
    configured: Option<String>,
    allow_dev: bool,
) -> Result<String, JwtSecretError> {
    let secret = configured.ok_or(JwtSecretError::Missing)?;
    if secret.trim().is_empty() {
        return Err(JwtSecretError::Missing);
    }
    if secret == DEV_JWT_SECRET && !allow_dev {
        return Err(JwtSecretError::InsecureDevDefault);
    }
    Ok(secret)
}

/// Load + validate the JWT signing secret from the environment. Fail-closed — there
/// is no silent fallback to a hard-coded secret.
///
/// Environment:
/// - `LATAIF_JWT_SECRET` (preferred) or `JWT_SECRET` (legacy) — the signing secret.
/// - `LATAIF_ALLOW_DEV_JWT_SECRET=1` — permit the known dev default (local dev/test only).
pub fn load_jwt_secret() -> Result<String, JwtSecretError> {
    let configured = std::env::var("LATAIF_JWT_SECRET")
        .ok()
        .or_else(|| std::env::var("JWT_SECRET").ok());
    let allow_dev = std::env::var("LATAIF_ALLOW_DEV_JWT_SECRET")
        .map(|v| v == "1")
        .unwrap_or(false);
    resolve_jwt_secret(configured, allow_dev)
}

pub fn create_token(
    user_id: &str,
    tenant_id: &str,
    branch_id: &str,
    role: &str,
    secret: &str,
) -> Result<String, StatusCode> {
    let expiration = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::days(30))
        .unwrap()
        .timestamp() as usize;

    let claims = Claims {
        sub: user_id.to_string(),
        tenant_id: tenant_id.to_string(),
        branch_id: branch_id.to_string(),
        role: role.to_string(),
        exp: expiration,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub fn verify_token(token: &str, secret: &str) -> Result<Claims, StatusCode> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| StatusCode::UNAUTHORIZED)
}

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Verify against the single validated secret held in AppState — no env re-read and
    // no implicit fallback. This is the same secret used to mint tokens at login.
    let claims = verify_token(token, &state.jwt_secret)?;

    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_secret_is_rejected() {
        assert_eq!(
            resolve_jwt_secret(None, false),
            Err(JwtSecretError::Missing)
        );
    }

    #[test]
    fn blank_secret_is_rejected() {
        assert_eq!(
            resolve_jwt_secret(Some("   ".to_string()), false),
            Err(JwtSecretError::Missing)
        );
    }

    #[test]
    fn known_dev_default_is_rejected_without_optin() {
        assert_eq!(
            resolve_jwt_secret(Some(DEV_JWT_SECRET.to_string()), false),
            Err(JwtSecretError::InsecureDevDefault)
        );
    }

    #[test]
    fn known_dev_default_allowed_only_with_explicit_optin() {
        assert_eq!(
            resolve_jwt_secret(Some(DEV_JWT_SECRET.to_string()), true),
            Ok(DEV_JWT_SECRET.to_string())
        );
    }

    #[test]
    fn real_secret_is_accepted() {
        assert_eq!(
            resolve_jwt_secret(Some("a-unique-strong-secret".to_string()), false),
            Ok("a-unique-strong-secret".to_string())
        );
    }

    #[test]
    fn error_display_never_leaks_secret_value() {
        // Neither error string may contain the secret bytes.
        assert!(!format!("{}", JwtSecretError::Missing).contains(DEV_JWT_SECRET));
        assert!(!format!("{}", JwtSecretError::InsecureDevDefault).contains(DEV_JWT_SECRET));
    }

    #[test]
    fn token_roundtrip_holds_claims_and_wrong_secret_is_rejected() {
        let t = create_token("u1", "t1", "b1", "owner", "secretA").unwrap();
        let claims = verify_token(&t, "secretA").unwrap();
        assert_eq!(claims.tenant_id, "t1");
        assert_eq!(claims.branch_id, "b1");
        assert_eq!(claims.role, "owner");
        // A token minted under a different secret must not verify.
        assert!(verify_token(&t, "secretB").is_err());
    }
}
