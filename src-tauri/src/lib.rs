#[cfg(windows)]
mod printing;
// MEDIA-04A-1 — isolated guarded image storage core. Compiled and unit-tested,
// but deliberately not yet wired to any command/UI/DB (see src/media/mod.rs).
mod media;
mod sync;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

struct AppHandleState {
    server: Arc<sync::SyncServer>,
    // MEDIA-04A-2A-R2 — the single, process-shared media ingest service.
    // Every #[tauri::command] handler clones this Arc, so all commands share
    // the same identity_locks registry and the per-(scope, id) serialisation
    // contract actually holds across concurrent handler invocations.
    media_ingest: Arc<media::ingest::MediaIngestService>,
}

const SYNC_PORT: u16 = 3001;

#[tauri::command]
async fn sync_server_start(state: tauri::State<'_, AppHandleState>) -> Result<String, String> {
    state.server.start().await
}

/// M6-B2A2 — der manuelle Stop ist eine Owner-Aktion.
///
/// Vorher konnte jeder Renderer den Primary-Server der Filiale abschalten. Der INTERNE
/// Shutdown (M4-D `finalize_application_shutdown`) ruft `server.stop()` direkt in Rust und
/// ist davon nicht betroffen — er braucht keine Credentials und aendert keine Rolle.
///
/// Der Stop veraendert `primary_host_config` NICHT: das Geraet bleibt primary und startet
/// beim naechsten Mal wieder korrekt.
#[tauri::command]
async fn sync_server_stop(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
) -> Result<String, String> {
    let (conn, _id) = open_config_db(&state.server)?;
    sync::primary::authorize_owner(&conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    drop(conn);
    state.server.stop().await
}

#[tauri::command]
async fn sync_server_status(
    state: tauri::State<'_, AppHandleState>,
) -> Result<serde_json::Value, String> {
    let (running, port, self_token) = state.server.status().await;
    let ip = local_ip_address::local_ip()
        .map(|i| i.to_string())
        .unwrap_or_else(|_| "0.0.0.0".into());
    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "ip": ip,
        "url": if running { format!("http://{}:{}", ip, port) } else { String::new() },
        // Self-Token wird nur returnt wenn Server gerade laeuft. JS in autoLanSetup
        // verwendet ihn als Sync-Auth-Token (kein expliziter Login noetig).
        "selfToken": self_token,
    }))
}

#[tauri::command]
async fn discover_lan_servers(timeout_secs: Option<u64>) -> Result<Vec<String>, String> {
    Ok(sync::discover_lan_servers(timeout_secs.unwrap_or(3)).await)
}

// ── M6-B2A — explicit static primary ────────────────────────────────────────
//
// The role now lives in the server DB, bound to this installation's id file — NOT in
// localStorage, which the client can rewrite and which cannot survive as an authority
// source. These commands are the only way the role ever changes; discovery cannot.

/// Open the server DB (creating/migrating it if needed) purely to read or write the role.
/// Kept separate from `SyncServer::start` so a client/unconfigured device can be asked
/// about its state without anything binding a port.
fn open_config_db(
    server: &sync::SyncServer,
) -> Result<(rusqlite::Connection, String), String> {
    let conn = sync::db::init_database(&server.db_path).map_err(|e| format!("DB init failed: {e}"))?;
    let id = sync::install_id::load_or_create(&server.db_path)
        .map_err(|e| format!("Install id unavailable: {e}"))?;
    Ok((conn, id))
}

#[tauri::command]
async fn primary_status(state: tauri::State<'_, AppHandleState>) -> Result<serde_json::Value, String> {
    let (conn, id) = open_config_db(&state.server)?;
    let cfg = sync::primary::load_config(&conn, "tenant-1", "branch-main")
        .map_err(|e| format!("Primary config unreadable: {e}"))?;
    let resolved = sync::primary::resolve_state(cfg.as_ref(), &id);
    Ok(serde_json::json!({
        "state": resolved.as_str(),
        "mode": cfg.as_ref().map(|c| c.mode.as_str()).unwrap_or("unconfigured"),
        "configured": cfg.is_some(),
        "mayWriteSync": resolved.may_write_sync(),
        "shouldServe": resolved.should_serve(),
        // Redacted on purpose: the full install id is a stable device identifier.
        "installIdShort": sync::install_id::redact(&id),
        "instanceMatches": cfg
            .as_ref()
            .and_then(|c| c.server_instance_id.as_deref())
            .map(|b| b == id),
    }))
}

/// Explicit, OWNER-AUTHORIZED action: set this installation's role. The only path that
/// ever writes `mode='primary'`, and it always binds to this install's id.
///
/// M6-B2A1 — why credentials: a Tauri command arrives from the renderer, and there is no
/// Rust-side session. A role or a `configured_by` passed in would be the caller vouching
/// for itself; a JWT would not help either, since the self-token carries `role="owner"`
/// and is handed to that same renderer. Only knowledge of the owner password — checked
/// against the bcrypt hash in the SERVER DB — is a boundary the renderer cannot cross by
/// itself. `configured_by` then comes from the verified lookup, never from the call.
#[tauri::command]
async fn primary_configure(
    state: tauri::State<'_, AppHandleState>,
    mode: String,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let m = sync::primary::Mode::parse(&mode).ok_or_else(|| format!("unknown mode '{mode}'"))?;
    let (conn, id) = open_config_db(&state.server)?;

    let owner = sync::primary::authorize_owner(&conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;

    let applied = sync::primary::configure_as_owner(&conn, "tenant-1", "branch-main", m, &id, &owner)
        .map_err(|code| code.to_string())?;

    Ok(serde_json::json!({ "mode": applied.as_str(), "configuredBy": owner.user_id() }))
}

/// M6-B2A2 — der einzige Weg von einem Legacy-Hinweis zu `primary`.
///
/// Verlangt verifizierte Owner-Credentials UND die woertliche Bestaetigung. Der Grund:
/// `lataif_lan_mode='server'` und die Changelog-Historie sind beide **kopierbar** — eine
/// Vor-v0002-Server-DB traegt echte Historie und keine Bindung, also wuerde jede Kopie
/// sich sonst an ihre neue Installation binden. Erst diese Erklaerung des Owners macht
/// aus einer Spur eine Rolle.
#[tauri::command]
async fn primary_adopt_legacy(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    confirmation: String,
) -> Result<serde_json::Value, String> {
    let (conn, id) = open_config_db(&state.server)?;
    let owner = sync::primary::authorize_owner(&conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let m = sync::primary::adopt_legacy_as_owner(
        &conn,
        "tenant-1",
        "branch-main",
        &id,
        &owner,
        &confirmation,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "mode": m.as_str(), "adoptedBy": owner.user_id() }))
}

/// One-time adoption of the legacy `lataif_lan_mode` / `lataif_lan_setup_done` values.
/// Idempotent: once a row exists the legacy values are ignored forever, so a stale or
/// cleared localStorage can never re-decide the role.
#[tauri::command]
async fn primary_migrate_legacy(
    state: tauri::State<'_, AppHandleState>,
    legacy_mode: Option<String>,
    setup_done: bool,
) -> Result<serde_json::Value, String> {
    let (conn, id) = open_config_db(&state.server)?;
    let legacy = sync::primary::LegacyLanConfig { mode: legacy_mode, setup_done };
    let m = sync::primary::migrate_once(&conn, "tenant-1", "branch-main", &legacy, &id)
        .map_err(|e| format!("Legacy migration failed: {e}"))?;
    Ok(serde_json::json!({ "mode": m.as_str() }))
}

// ── M6-B2A4 — server owner provisioning ─────────────────────────────────────
//
// Local Tauri commands only. There is deliberately NO HTTP route: before the first
// provisioning this machine has no way to tell its owner from anyone else, so the only
// boundary available is local control of the OS and the running app. That is a real
// boundary — it is not a remotely authenticated one, and nothing here pretends it is.
//
// What this replaces: `init_database` used to seed `admin@lataif.com` / `admin` as owner
// of tenant-1/branch-main into every empty server DB, and nothing could change it. That
// constant satisfied `authorize_owner` (so B2A1/B2A2's owner gate was decoration) and
// `/auth/login`, which returns an OWNER JWT and thereby unlocked `/sync/push` to anyone
// on the same Wi-Fi.

/// Read-only. Needs no credentials: whether this server still needs setup is not a secret,
/// and the UI must be able to ask before it can sensibly prompt for anything.
#[tauri::command]
async fn server_owner_status(
    state: tauri::State<'_, AppHandleState>,
) -> Result<serde_json::Value, String> {
    let (conn, _id) = open_config_db(&state.server)?;
    let ready = sync::credentials::owner_credentials_ready(&conn);
    Ok(serde_json::json!({
        "provisioned": ready,
        "provisioningRequired": !ready,
        "minPasswordLength": sync::credentials::MIN_PASSWORD_LEN,
        // The UI must send this verbatim; it is not free text.
        "confirmationPhrase": sync::credentials::PROVISION_CONFIRMATION,
    }))
}

/// §6 — first provisioning of the embedded server's owner password.
///
/// Takes no current password: there is none, by construction. `provisioned_by` is the
/// fixed constant `local-bootstrap` and is never taken from the caller — at this moment no
/// verified identity exists to name, and recording a renderer-supplied one would be
/// writing a claim down as a fact.
#[tauri::command]
async fn server_owner_provision(
    state: tauri::State<'_, AppHandleState>,
    password: String,
    password_confirmation: String,
    confirmation: String,
) -> Result<serde_json::Value, String> {
    let (conn, _id) = open_config_db(&state.server)?;
    let user_id =
        sync::credentials::provision_owner(&conn, &password, &password_confirmation, &confirmation)
            .map_err(|code| code.to_string())?;
    // Deliberately no automatic primary claim and no automatic root-key import: setting a
    // password says who the owner is, not what this machine's role should be.
    Ok(serde_json::json!({ "provisioned": true, "userId": user_id }))
}

/// §8 — change the password of an already-provisioned owner. Requires the current one.
#[tauri::command]
async fn server_owner_change_password(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    current_password: String,
    new_password: String,
    new_password_confirmation: String,
) -> Result<serde_json::Value, String> {
    let (conn, _id) = open_config_db(&state.server)?;
    let user_id = sync::credentials::change_owner_password(
        &conn,
        &email,
        &current_password,
        &new_password,
        &new_password_confirmation,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "changed": true, "userId": user_id }))
}

// ── M6-B2B/B2C — tenant trust root, recovery bundle, authority certificates ──
//
// INACTIVE. These commands create and verify trust material; nothing consults it yet.
// `/sync/push` is still gated solely by the B2A role (`may_write_sync()`), and it stays
// that way until an explicit later slice activates the new contract. See
// `authority::tests::a20_no_sync_write_gate_was_activated`.
//
// Why every mutating command re-checks the owner: a Tauri command arrives from the
// renderer and there is no Rust-side session. The same reasoning as M6-B2A1 — only
// knowledge of the owner password, verified against the bcrypt hash in the server DB, is
// a boundary the renderer cannot cross by itself. `configured_by` / `issued_by` therefore
// always come from `OwnerAuth`, never from the call.

/// Everything a trust/authority command needs, resolved once, in Rust.
struct TrustCtx {
    conn: rusqlite::Connection,
    install_id: String,
    app_data_dir: std::path::PathBuf,
    primary_state: sync::primary::State,
}

/// Resolve the context. The `primary_state` is re-derived here from
/// `primary_host_config` + the install-id file — never taken from the caller.
fn trust_ctx(server: &sync::SyncServer) -> Result<TrustCtx, String> {
    let (conn, install_id) = open_config_db(server)?;
    let app_data_dir = server
        .db_path
        .parent()
        .ok_or_else(|| "Could not determine the app data directory".to_string())?
        .to_path_buf();
    let cfg = sync::primary::load_config(&conn, "tenant-1", "branch-main")
        .map_err(|e| format!("Primary config unreadable: {e}"))?;
    let primary_state = sync::primary::resolve_state(cfg.as_ref(), &install_id);
    Ok(TrustCtx { conn, install_id, app_data_dir, primary_state })
}

/// Read-only. Deliberately needs no credentials: knowing *whether* a root exists is not
/// a secret, and the owner must be able to see the state before being asked for a password.
#[tauri::command]
async fn trust_root_status(
    state: tauri::State<'_, AppHandleState>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let trust = sync::trust_root::resolve_trust_state(&c.conn, &c.app_data_dir, "tenant-1");
    let rec = sync::trust_root::load_active_root(&c.conn, "tenant-1")
        .map_err(|e| format!("Trust root unreadable: {e}"))?;
    // M6-B2C4 §9 — custody is the other half of "may this machine sign?", and it is the
    // half that is invisible from the filesystem. After a transfer commit the key file and
    // the root record both still look perfectly healthy on the source; only this says it
    // has stopped. Reporting it here is what makes "why can't I sign?" answerable without
    // reading the DB by hand.
    let custody = sync::transfer::custody_state(&c.conn, "tenant-1", &c.install_id)
        .map_err(|e| format!("Custody unreadable: {e}"))?;
    Ok(serde_json::json!({
        "state": trust.as_str(),
        // Both must hold. `trust.may_sign()` alone was the whole answer before B2C4 and is
        // now only the local-key half of it.
        "maySign": trust.may_sign() && custody.is_some_and(|s| s.may_sign()),
        "trustMaySign": trust.may_sign(),
        "custodyState": custody.map(|s| s.as_str()),
        "custodyMaySign": custody.map(|s| s.may_sign()),
        "configured": rec.is_some(),
        "rootKeyIdShort": rec.as_ref().map(|r| sync::trust_root::redact(&r.root_key_id)),
        // The fingerprint is public by design — it is what an owner compares by phone.
        "fingerprint": rec.as_ref().map(|r| r.fingerprint.clone()),
        "generation": rec.as_ref().map(|r| r.generation),
        "primaryState": c.primary_state.as_str(),
    }))
}

#[tauri::command]
async fn trust_root_initialize(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let rec = sync::trust_root::initialize_root(
        &c.conn,
        &c.app_data_dir,
        "tenant-1",
        &c.install_id,
        c.primary_state,
        &owner,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "rootKeyIdShort": sync::trust_root::redact(&rec.root_key_id),
        "fingerprint": rec.fingerprint,
        "generation": rec.generation,
        "createdBy": owner.user_id(),
    }))
}

/// Export the encrypted recovery bundle.
///
/// Two passwords, on purpose: the owner's login password authorizes the *server* action,
/// and a separate recovery passphrase encrypts the *file*. The bundle leaves the building,
/// so it must not be unlockable by the same secret that unlocks the shop.
///
/// Returns the bundle as a string; writing it somewhere is the caller's decision, so this
/// command never picks a path — least of all inside the app data dir, where it would sit
/// next to the key it is supposed to be a backup of.
#[tauri::command]
async fn trust_root_export_recovery(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    recovery_password: String,
    recovery_password_confirmation: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let _owner =
        sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
            .map_err(|code| code.to_string())?;
    sync::recovery::validate_recovery_password(&recovery_password, &recovery_password_confirmation)
        .map_err(|code| code.to_string())?;

    let rec = sync::trust_root::load_active_root(&c.conn, "tenant-1")
        .map_err(|e| format!("Trust root unreadable: {e}"))?
        .ok_or_else(|| sync::trust_root::ERR_ROOT_KEY_MISSING.to_string())?;
    let key = sync::trust_root::load_key(&c.app_data_dir, &rec).map_err(|code| code.to_string())?;

    // Carry the last authority we know as a HINT. Recovery must not read it as a promise —
    // the lost primary may well have issued a higher epoch before it died (§14).
    let last = sync::authority::load_active(&c.conn, "tenant-1", "branch-main")
        .map_err(|e| format!("Authority unreadable: {e}"))?;
    let hints = sync::recovery::AuthorityHints {
        authority_id: last.as_ref().map(|a| a.authority_id.clone()),
        authority_epoch: last.as_ref().map(|a| a.authority_epoch),
        certificate_serial: last.as_ref().map(|a| a.certificate_serial.clone()),
    };

    let created_at: String = c
        .conn
        .query_row(
            "SELECT created_at FROM tenant_trust_roots WHERE root_key_id = ?1",
            rusqlite::params![rec.root_key_id],
            |r| r.get(0),
        )
        .unwrap_or_default();

    let bundle =
        sync::recovery::export_bundle(&key, &rec, &created_at, &recovery_password, &hints)
            .map_err(|code| code.to_string())?;
    let text = sync::recovery::serialize_bundle(&bundle).map_err(|code| code.to_string())?;

    Ok(serde_json::json!({
        "filename": sync::recovery::BUNDLE_FILENAME,
        "bundle": text,
        "fingerprint": rec.fingerprint,
    }))
}

#[tauri::command]
async fn trust_root_import_recovery(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    recovery_password: String,
    bundle: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    if !c.primary_state.may_write_sync() {
        return Err(sync::trust_root::ERR_ROOT_NOT_PRIMARY.to_string());
    }
    let imported = sync::recovery::import_bundle(&bundle, "tenant-1", &recovery_password)
        .map_err(|code| code.to_string())?;
    sync::trust_root::restore_root(
        &c.conn,
        &c.app_data_dir,
        &imported.record,
        imported.seed,
        &c.install_id,
        &owner,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "fingerprint": imported.record.fingerprint,
        "generation": imported.record.generation,
        // Hints only — the caller must treat these as "possibly stale" (§14).
        "lastKnownAuthorityEpoch": imported.hints.authority_epoch,
    }))
}

// ── M6-B2C commands ─────────────────────────────────────────────────────────

/// Build an issuing context. Fails closed if the root cannot sign.
fn issue_ready<'a>(
    c: &'a TrustCtx,
    rec: &'a sync::trust_root::TrustRootRecord,
    key: &'a sync::trust_root::RootKey,
    owner: &'a sync::primary::OwnerAuth,
) -> sync::authority::IssueContext<'a> {
    sync::authority::IssueContext {
        conn: &c.conn,
        tenant_id: "tenant-1",
        branch_id: "branch-main",
        install_id: &c.install_id,
        primary_state: c.primary_state,
        root: rec,
        key,
        owner,
    }
}

/// One door to a signing root, so every command reports the same precise reason when
/// there isn't one (missing → restore a bundle; lost → re-enrol; damaged → fix the file).
fn load_signing_root(
    c: &TrustCtx,
) -> Result<(sync::trust_root::TrustRootRecord, sync::trust_root::RootKey), String> {
    sync::trust_root::require_signing_root(&c.conn, &c.app_data_dir, "tenant-1")
        .map_err(|code| code.to_string())
}

#[tauri::command]
async fn authority_status(
    state: tauri::State<'_, AppHandleState>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let active = sync::authority::load_active(&c.conn, "tenant-1", "branch-main")
        .map_err(|e| format!("Authority unreadable: {e}"))?;
    let known = sync::authority::highest_known_epoch(&c.conn, "tenant-1", "branch-main")
        .map_err(|e| format!("Authority unreadable: {e}"))?;
    Ok(serde_json::json!({
        "configured": active.is_some(),
        "authorityEpoch": active.as_ref().map(|a| a.authority_epoch),
        "status": active.as_ref().map(|a| a.status.as_str()),
        "isThisInstallation": active
            .as_ref()
            .map(|a| a.server_instance_id == c.install_id),
        // "highest epoch THIS database knows" — deliberately not called "the" highest.
        "locallyKnownHighestEpoch": known,
        // The flag that keeps everyone honest about what this slice does.
        "enforcedForSyncWrites": false,
    }))
}

#[tauri::command]
async fn authority_initialize(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let (rec, key) = load_signing_root(&c)?;
    let cert = sync::authority::initialize_authority(&issue_ready(&c, &rec, &key, &owner))
        .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "authorityEpoch": cert.payload.authority_epoch,
        "certificateSerial": cert.payload.certificate_serial,
        "issuedBy": owner.user_id(),
    }))
}

// ── M6-B2C4 §8 — the two-phase transfer, T1 … T7 ────────────────────────────
//
// The old `authority_issue_transfer` / `authority_import_transfer` pair is gone. It moved a
// certificate and called that a transfer, while the private root key — the only thing that
// can sign — stayed on the source. These seven commands move the key, under the owner's
// passphrase, with one irreversible step in the middle.
//
// OWNER BOUNDARY, stated plainly: T1 (`issue`), T4 (`confirm`), T5 (`commit`) and the abort
// run on the SOURCE and go through the hardened `authorize_owner`. T2 (`import`), T3
// (`receipt`) and T7 (`activate`) run on the TARGET, which by definition may not have this
// tenant's user table yet — a fresh machine has no owner to authenticate against. Their gate
// is therefore local and different in kind: possession of the package plus its passphrase,
// and the install-id binding in the AAD. Claiming they were owner-authenticated would be a
// lie; this comment is where that is said out loud instead.

/// T1 — the source issues the transfer package. Nothing changes hands yet.
#[tauri::command]
async fn authority_transfer_issue(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    target_install_id: String,
    passphrase: String,
    passphrase_confirmation: String,
    confirmation: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let (rec, key) = load_signing_root(&c)?;
    let req = sync::transfer::IssueRequest {
        conn: &c.conn,
        tenant_id: "tenant-1",
        branch_id: "branch-main",
        install_id: &c.install_id,
        primary_state: c.primary_state,
        root: &rec,
        key: &key,
        owner: &owner,
    };
    let (bundle, record) = sync::transfer::issue(
        &req,
        target_install_id.trim(),
        &passphrase,
        &passphrase_confirmation,
        &confirmation,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "transferId": record.transfer_id,
        "bundle": bundle.to_json().map_err(|c| c.to_string())?,
        "filename": sync::transfer::TRANSFER_FILENAME,
        "state": record.state.as_str(),
    }))
}

/// T2 — the target imports the package. Local gate; see the boundary note above.
#[tauri::command]
async fn authority_transfer_import(
    state: tauri::State<'_, AppHandleState>,
    bundle: String,
    passphrase: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let outcome =
        sync::transfer::import(&c.conn, &c.app_data_dir, &bundle, &c.install_id, &passphrase)
            .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "outcome": format!("{outcome:?}") }))
}

/// T3 — the target proves the import. Re-runnable after a crash.
#[tauri::command]
async fn authority_transfer_receipt(
    state: tauri::State<'_, AppHandleState>,
    transfer_id: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let receipt =
        sync::transfer::create_receipt(&c.conn, &c.app_data_dir, transfer_id.trim(), &c.install_id)
            .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "receipt": receipt.to_json().map_err(|c| c.to_string())?,
        "confirmationLevel": receipt.confirmation_level,
    }))
}

/// T4 — the source verifies the receipt.
#[tauri::command]
async fn authority_transfer_confirm(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    receipt: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let (rec, _key) = load_signing_root(&c)?;
    sync::transfer::confirm_receipt(&c.conn, &c.app_data_dir, &receipt, &c.install_id, &rec)
        .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "state": "target_confirmed",
        "confirmationLevel": sync::transfer::CONFIRMATION_LEVEL,
    }))
}

/// T5 — the source stops being the authority. Irreversible.
#[tauri::command]
async fn authority_transfer_commit(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    transfer_id: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    sync::transfer::commit(&c.conn, transfer_id.trim(), &c.install_id, &owner)
        .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "state": "committed" }))
}

/// T6 — the source hands out the commit secret. Re-exportable after a crash.
#[tauri::command]
async fn authority_transfer_commit_token(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    transfer_id: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let token =
        sync::transfer::export_commit_token(&c.conn, &c.app_data_dir, transfer_id.trim(), &c.install_id)
            .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "token": token.to_json().map_err(|c| c.to_string())? }))
}

/// T7 — the target becomes the authority. Local gate; see the boundary note above.
#[tauri::command]
async fn authority_transfer_activate(
    state: tauri::State<'_, AppHandleState>,
    token: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let outcome = sync::transfer::activate(&c.conn, &c.app_data_dir, &token, &c.install_id)
        .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "outcome": format!("{outcome:?}"),
        // The transfer moves custody, never the B2A role. Saying so in the response keeps
        // the caller from assuming the machine is now a primary.
        "primaryRoleUnchanged": true,
    }))
}

/// §10 — the source aborts. Only before the commit.
#[tauri::command]
async fn authority_transfer_abort(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    transfer_id: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let (rec, _key) = load_signing_root(&c)?;
    let token = sync::transfer::abort(&c.conn, &c.app_data_dir, transfer_id.trim(), &c.install_id, &rec)
        .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "token": token.to_json().map_err(|c| c.to_string())? }))
}

/// §10 — the target stands down.
#[tauri::command]
async fn authority_transfer_abort_import(
    state: tauri::State<'_, AppHandleState>,
    token: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    sync::transfer::import_abort(&c.conn, &c.app_data_dir, &token, &c.install_id)
        .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "state": "aborted" }))
}

// ── M6-B2DE — device identity, enrollment and cutover readiness ──────────────
//
// OWNER BOUNDARY, restated for this slice because it is not the same on both sides:
//
//   * The DEVICE side (`device_status`, `device_create_enrollment_request`,
//     `device_import_enrollment_response`) runs on a machine that may have no owner at all —
//     `users` is not a synced table, so a fresh client has no owner row for this tenant.
//     Their gate is local: possession of the device key, and the install-id + public-key
//     binding the certificate carries. Calling `authorize_owner` there would be theatre.
//
//   * The SERVER side (`device_approve_enrollment`, `device_revoke`, `device_retire`,
//     `device_mark_compromised`, `device_begin_reenrollment`, and every inventory/cutover
//     command) runs on the primary and goes through the hardened `authorize_owner`.
//
// No HTTP route is added by any of this. /sync/push and /sync/pull are untouched (§14).

/// The device's own view of itself. Read-only; creates nothing.
#[tauri::command]
async fn device_status(state: tauri::State<'_, AppHandleState>) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    // The registry wins over the local files. A device whose owner revoked it an hour ago
    // still has a perfectly healthy key and certificate on disk — asking only the disk would
    // answer "Enrolled" forever, which is the one answer that must not be possible here.
    let st = sync::device::resolve_state_with_registry(&c.conn, &c.app_data_dir);
    let local_only = sync::device::resolve_state(&c.app_data_dir);
    let cert = sync::device::load_certificate(&c.app_data_dir).ok();
    Ok(serde_json::json!({
        "state": st.as_str(),
        "canProvePossession": st.can_prove_possession(),
        // Surfaced separately so the difference is visible rather than resolved silently:
        // when these disagree, the registry revoked a device that does not know it yet.
        "localFileState": local_only.as_str(),
        "deviceIdShort": sync::device::load_identity(&c.app_data_dir)
            .ok()
            .map(|k| sync::trust_root::redact(k.device_id())),
        "certificateSerial": cert.as_ref().map(|x| x.payload.certificate_serial.clone()),
        "deviceRole": cert.as_ref().map(|x| x.payload.device_role.clone()),
        "capabilities": cert.as_ref().map(|x| x.payload.capabilities.clone()),
        // §8 — whether a tenant root has been pinned out-of-band on this machine. Once true,
        // a re-import that names a different root is refused; the UI can show the pin status
        // so an owner knows the device is anchored, not merely holding a certificate.
        "trustAnchorPinned": sync::device::trust_anchor_exists(&c.app_data_dir),
        // §5 — whether the stored certificate still verifies against the PINNED anchor (same
        // tenant/branch/root/generation, signature by the pinned root). False when unenrolled,
        // or if a certificate and anchor ever disagreed — the honest signal the UI can show.
        "certificateMatchesAnchor":
            sync::device::verify_certificate_against_anchor(&c.app_data_dir).is_ok(),
        // The transfer of a certificate never grants a role on the LAN. Saying so in the
        // response keeps a caller from assuming enrollment changed anything about the host.
        "primaryRoleUnchanged": true,
    }))
}

/// §6 — the device creates its key (once) and a signed enrollment request.
#[tauri::command]
async fn device_create_enrollment_request(
    state: tauri::State<'_, AppHandleState>,
    requested_role: String,
    requested_capabilities: Vec<String>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    // `load_or_create` never re-keys a damaged or certificate-bearing install: it fails.
    let key = sync::device::load_or_create_identity(&c.app_data_dir).map_err(|e| e.to_string())?;
    let req = sync::device::create_enrollment_request(
        &key,
        &c.install_id,
        "tenant-1",
        "branch-main",
        requested_role.trim(),
        &requested_capabilities,
        1,
        3,
    )
    .map_err(|e| e.to_string())?;
    // §7 — persist the request locally the moment it is created. The import path checks the
    // signed approval's request id + nonce against THIS stored request, so it must be on disk
    // before the response ever comes back.
    sync::device::store_enrollment_request(&c.app_data_dir, &req).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "request": req.to_json().map_err(|e| e.to_string())?,
        "filename": "device-enrollment-request.lataif",
        "requestId": req.request_id,
        // What the file proves, spelled out where the caller sees it.
        "proves": "possession of this device's private key",
        "doesNotProve": "owner consent, tenant membership, or any capability",
    }))
}

/// §7 — the owner approves a request and the authority signs a device certificate.
#[tauri::command]
async fn device_approve_enrollment(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    request: String,
    granted_role: String,
    granted_capabilities: Vec<String>,
    device_label: Option<String>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let req = sync::device::EnrollmentRequest::from_json(&request).map_err(|e| e.to_string())?;
    let (rec, key) = load_signing_root(&c)?;
    // §7 — an active authority AND an active custody are required. `require_signing_authority`
    // is the M6-B2C4 gate; going around it would let a retired host mint device identities.
    let current = sync::authority::require_signing_authority(
        &c.conn, "tenant-1", "branch-main", &c.install_id, c.primary_state, &rec,
    )
    .map_err(|e| e.to_string())?;

    let grant = sync::device::EnrollmentGrant {
        tenant_id: "tenant-1",
        branch_id: "branch-main",
        device_role: granted_role.trim(),
        capabilities: &granted_capabilities,
        protocol_min: 1,
        protocol_max: 3,
        device_label: device_label.as_deref(),
    };
    let (cert, resp) = sync::device::approve_enrollment(
        &c.conn,
        &req,
        &grant,
        &rec,
        &key,
        &current.authority_id,
        current.authority_epoch,
        // §7 — the root-signed authority certificate, verbatim, so the target can verify the
        // whole chain from a root it does not yet trust.
        &current.certificate,
        &owner,
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "response": resp.to_json().map_err(|e| e.to_string())?,
        "filename": "device-enrollment-response.lataif",
        "certificateSerial": cert.payload.certificate_serial,
        "deviceId": cert.payload.device_id,
        // §8 — the fingerprint the TARGET owner must confirm out-of-band before importing.
        // Surfaced here so the primary's UI can show it (as text and a QR code) for a
        // side-by-side check. It is NOT a secret — it is a value that must be compared, and
        // comparing it is what anchors trust.
        "tenantRootFingerprint": resp.tenant_root_fingerprint,
        // The grant decides these, never the request.
        "grantedRole": cert.payload.device_role,
        "grantedCapabilities": cert.payload.capabilities,
    }))
}

/// §8 — the device adopts its certificate, pinning the tenant root out-of-band.
///
/// `expected_root_fingerprint` is the 64 hex characters the owner confirmed through a separate
/// channel (a QR code from the primary, a phone call). On a first import it is mandatory — the
/// target has no prior knowledge of the root, so this human-confirmed value is the anchor. It
/// is deliberately NOT read from the response file: a fingerprint taken from the same file that
/// carries the chain would let the file vouch for itself, which is exactly what §8 forbids.
///
/// Local gate; the target may have no owner (see the boundary note above), so there is no
/// `authorize_owner` here — possession of the device key, the install-id binding, and the
/// out-of-band fingerprint are the trust.
#[tauri::command]
async fn device_import_enrollment_response(
    state: tauri::State<'_, AppHandleState>,
    response: String,
    expected_root_fingerprint: Option<String>,
    expected_request_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let outcome = sync::device::import_enrollment_response(
        &c.app_data_dir,
        &response,
        &c.install_id,
        expected_root_fingerprint.as_deref(),
        expected_request_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "outcome": format!("{outcome:?}"),
        "state": sync::device::resolve_state(&c.app_data_dir).as_str(),
        // §8 — none of these happen here.
        "primaryClaimed": false,
        "serverStarted": false,
        "lanModeChanged": false,
    }))
}

/// §9 — the owner ends a device's life. One command, an explicit reason code.
#[tauri::command]
async fn device_revoke(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    device_id: String,
    reason_code: String,
    note: Option<String>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    // The three flavours are separate values, not a boolean: "revoked" and "compromised"
    // call for different responses from a human reading the log later.
    let reason = match reason_code.as_str() {
        "revoked" => sync::device::RevokeReason::Revoked,
        "retired" => sync::device::RevokeReason::Retired,
        "compromised" => sync::device::RevokeReason::Compromised,
        _ => return Err("DEVICE_REVOKE_REASON_INVALID".to_string()),
    };
    sync::device::revoke_device(&c.conn, device_id.trim(), reason, note.as_deref(), &owner)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "deviceId": device_id, "reasonCode": reason_code, "irreversible": true }))
}

/// §9 — the owner asks a device to come back with a new keypair.
#[tauri::command]
async fn device_begin_reenrollment(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    sync::device::begin_reenrollment(&c.conn, device_id.trim(), &owner).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "deviceId": device_id,
        "state": "reenrollment_required",
        // There is no silent key rotation: the old certificate names a key nobody holds.
        "oldCertificate": "superseded",
    }))
}

// ── §10/§11 — the legacy inventory ──────────────────────────────────────────

#[tauri::command]
async fn inventory_add_item(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    owner_label: String,
    device_description: Option<String>,
    expected_user_or_location: Option<String>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let id = sync::cutover::add_item(
        &c.conn,
        "tenant-1",
        "branch-main",
        &owner_label,
        device_description.as_deref(),
        expected_user_or_location.as_deref(),
        &owner,
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "inventoryItemId": id, "status": "expected" }))
}

/// §10 — link an item to a device. Explicit, by a human, always.
#[tauri::command]
async fn inventory_link_device(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    inventory_item_id: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    sync::cutover::link_to_device(&c.conn, inventory_item_id.trim(), device_id.trim(), &owner)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": "enrolled", "linkedBy": "owner" }))
}

#[tauri::command]
async fn inventory_resolve_item(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    inventory_item_id: String,
    status: String,
    reason: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let st = sync::cutover::ItemStatus::parse(&status).ok_or("INVENTORY_INVALID")?;
    sync::cutover::resolve_item(&c.conn, inventory_item_id.trim(), st, &reason, &owner)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": st.as_str(), "resolved": st.is_resolved() }))
}

#[tauri::command]
async fn inventory_list(state: tauri::State<'_, AppHandleState>) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let items = sync::cutover::list_items(&c.conn, "tenant-1", "branch-main")
        .map_err(|e| e.to_string())?;
    let rows: Vec<serde_json::Value> = items
        .iter()
        .map(|i| {
            serde_json::json!({
                "inventoryItemId": i.inventory_item_id,
                "ownerLabel": i.owner_label,
                "status": i.status.as_str(),
                "resolved": i.status.is_resolved(),
                "linkedDeviceId": i.linked_device_id,
                "resolutionReason": i.resolution_reason,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "items": rows,
        "unresolvedCount": items.iter().filter(|i| !i.status.is_resolved()).count(),
    }))
}

/// §11 — the owner attests the inventory is complete.
#[tauri::command]
async fn inventory_attest(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    confirmation: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let att =
        sync::cutover::attest_inventory(&c.conn, "tenant-1", "branch-main", &confirmation, &owner)
            .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "attestationId": att.attestation_id,
        "itemCount": att.item_count,
        "resolvedCount": att.resolved_count,
        "statementVersion": att.statement_version,
        // §11 — the app MUST show this. It is returned with the result so a UI cannot render
        // a success without the sentence that says what was actually claimed.
        "statement": sync::cutover::STATEMENT_TEXT,
        "isTechnicalProof": false,
    }))
}

/// §12 — readiness. Read-only, and it never activates anything.
#[tauri::command]
async fn cutover_readiness(state: tauri::State<'_, AppHandleState>) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let r = sync::cutover::evaluate_readiness(
        &c.conn, "tenant-1", "branch-main", &c.install_id, c.primary_state,
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "state": r.state.as_str(),
        "isReady": r.is_ready(),
        "blockingReasons": r.blocking_reasons,
        "hasAttestation": r.has_attestation,
        "allItemsResolved": r.all_items_resolved,
        "allEnrolledItemsHaveActiveCertificates": r.all_enrolled_items_have_active_certificates,
        "hasActiveAuthority": r.has_active_authority,
        "hasActiveRootCustody": r.has_active_root_custody,
        "ownerProvisioned": r.owner_provisioned,
        "staticPrimaryBindingValid": r.static_primary_binding_valid,
        "legacyActivityAfterAttestation": r.legacy_activity_after_attestation,
        // §12 — always false here. B3/B4 owns the v4 write path.
        "protocolV4WritePathReady": r.protocol_v4_write_path_ready,
        "readyMeansPreparedNotActivated": true,
    }))
}

#[tauri::command]
async fn cutover_mark_ready(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let r = sync::cutover::mark_ready(
        &c.conn, "tenant-1", "branch-main", &c.install_id, c.primary_state, &owner,
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "state": r.state.as_str(), "isReady": r.is_ready() }))
}

/// §12 — the activation attempt, which always refuses in this slice.
///
/// It exists so the refusal is a tested contract instead of an absence. Legacy clients keep
/// working; nothing here can stop them.
#[tauri::command]
async fn cutover_attempt_activation(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    sync::cutover::attempt_activation(
        &c.conn, "tenant-1", "branch-main", &c.install_id, c.primary_state,
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "activated": false }))
}

/// §14 — forced takeover when the old primary is gone for good.
///
/// The result is `recovery_pending` unless this database provably holds the full epoch
/// history. That is the honest answer: we cannot know what a machine we cannot reach
/// issued before it died, and inventing a safe-looking epoch jump would only hide it.
#[tauri::command]
async fn authority_prepare_recovery(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    confirmation: String,
    hint_epoch: Option<i64>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    let (rec, key) = load_signing_root(&c)?;
    let (cert, status) = sync::authority::prepare_recovery(
        &issue_ready(&c, &rec, &key, &owner),
        hint_epoch,
        &confirmation,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({
        "authorityEpoch": cert.payload.authority_epoch,
        "status": status.as_str(),
        "isActive": status == sync::authority::CertStatus::Active,
        "certificateSerial": cert.payload.certificate_serial,
    }))
}

#[tauri::command]
async fn authority_revoke(
    state: tauri::State<'_, AppHandleState>,
    email: String,
    password: String,
    authority_id: String,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    let c = trust_ctx(&state.server)?;
    let owner = sync::primary::authorize_owner(&c.conn, "tenant-1", "branch-main", &email, &password)
        .map_err(|code| code.to_string())?;
    sync::authority::revoke_authority(
        &c.conn,
        "tenant-1",
        "branch-main",
        &authority_id,
        reason.as_deref(),
        &owner,
    )
    .map_err(|code| code.to_string())?;
    Ok(serde_json::json!({ "revoked": true, "revokedBy": owner.user_id() }))
}

// Raw-Druck von ZPL an einen benannten Drucker (Zebra-Tags). Windows-only;
// auf anderen Plattformen ein sauberer Fehler statt Compile-Bruch.
#[tauri::command]
fn print_raw_zpl(printer: String, zpl: String) -> Result<u32, String> {
    #[cfg(windows)]
    {
        printing::print_raw(&printer, zpl.as_bytes())
    }
    #[cfg(not(windows))]
    {
        let _ = (printer, zpl);
        Err("Raw-Druck wird nur unter Windows unterstützt.".to_string())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// M4-D — Native Close Finalization (nach durablem Frontend-Flush)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ausgangslage (M4-C, empirisch belegt): der alte Close-Pfad rief im Webview `win.destroy()`
// (in Tauri v2 mangels `core:window:allow-destroy` still abgelehnt) und beendete den Prozess
// dann NUR ueber einen Webview-`setTimeout(2000) → proc.exit(0)`-Fallback. Wird der Webview
// suspendiert/okkludiert (minimiert), laeuft dieser JS-Timer nicht mehr → der Prozess terminiert
// nicht, Port 3001 bleibt belegt.
//
// Loesung: den finalen Prozess-Exit NICHT an einen Webview-Timer koppeln. Das Frontend ruft NACH
// bestaetigter durabler Persistenz genau diesen Command; ab hier uebernimmt Rust nativ: den
// eingebetteten Sync-Server idempotent stoppen (Port 3001 freigeben) und `AppHandle::exit(0)`.
// Der Finalizer fuehrt bewusst KEINE DB-/Persistenzoperation aus (die liegt vollstaendig im
// Frontend/M2/M4) und loggt keine Geschaeftsdaten.

// Idempotenz-Guard: der Shutdown-Finalizer darf pro Prozess nur EINMAL wirken (schneller Doppel-X
// bzw. doppelter invoke → kein zweiter Server-Stop, kein zweiter Exit).
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);

mod shutdown {
    use std::time::Duration;

    /// Reiner, injizierbarer Finalisierungs-Ablauf — ohne Tauri und ohne echten Prozess-Exit,
    /// damit Reihenfolge (Server-Stop VOR Exit), Idempotenz und Timeout-Verhalten unit-testbar sind.
    ///
    ///   proceed == false → Doppelaufruf: NICHTS tun (kein zweiter Stop, kein zweiter Exit).
    ///   sonst            → Sync-Server stoppen (mit hartem Zeitdeckel) → danach exit_application() 1×.
    ///
    /// Der Zeitdeckel garantiert, dass ein haengender/fehlerhafter Server-Stop den nativen Exit
    /// NIEMALS blockiert: der Frontend-Flush ist zu diesem Zeitpunkt bereits durabel bestaetigt, es
    /// darf nichts mehr die Terminierung offenhalten. Ein Timeout ist KEIN Fehler.
    /// Es gibt bewusst keinen DB-/Persistenz-Parameter — der Ablauf kann gar nichts speichern.
    pub async fn finalize_shutdown_sequence<S, F>(
        proceed: bool,
        stop_timeout: Duration,
        stop_server: S,
        exit_application: F,
    ) -> bool
    where
        S: std::future::Future<Output = ()>,
        F: FnOnce(),
    {
        if !proceed {
            return false;
        }
        // Server-Stop mit Deckel — bei Timeout ODER Erfolg geht es zum Exit (Ergebnis egal).
        let _ = tokio::time::timeout(stop_timeout, stop_server).await;
        exit_application();
        true
    }
}

// M4-D — Nativer Close-Finalizer. Das Frontend ruft diesen Command AUSSCHLIESSLICH nach einem
// erfolgreich bestaetigten durablen DB-Flush (prepareAndCloseApplication). Terminierung liegt
// damit nativ bei Rust statt an einem fragilen Webview-Timer.
#[tauri::command]
async fn finalize_application_shutdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppHandleState>,
) -> Result<(), String> {
    // Idempotenz gegen Doppel-X: nur der erste Aufruf wirkt (atomarer compare_exchange).
    let proceed = SHUTDOWN_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok();
    // Arc/Handle vor dem await klonen — kein State-Borrow ueber den await-Punkt.
    let server = state.server.clone();
    let app_handle = app.clone();
    shutdown::finalize_shutdown_sequence(
        proceed,
        std::time::Duration::from_secs(3),
        // Server-Stop ist idempotent (SyncServer::stop → Ok bei "nicht laufend"); Fehler/Timeout
        // duerfen den Exit nicht blockieren → Ergebnis bewusst verworfen.
        async move {
            let _ = server.stop().await;
        },
        move || app_handle.exit(0),
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod shutdown_tests {
    use super::shutdown::finalize_shutdown_sequence;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // Hinweis "keine DB-Operation": der Helper hat gar keinen DB-/Persistenz-Parameter — er KANN
    // strukturell nichts speichern. Diese Tests decken Reihenfolge, Idempotenz und Timeout ab.

    #[tokio::test]
    async fn stops_server_before_exit_when_running() {
        // Gemeinsames Reihenfolge-Log → "stop" muss vor "exit" stehen.
        let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let l1 = log.clone();
        let l2 = log.clone();
        let ran = finalize_shutdown_sequence(
            true,
            Duration::from_secs(1),
            async move {
                l1.lock().unwrap().push("stop");
            },
            move || l2.lock().unwrap().push("exit"),
        )
        .await;
        assert!(ran, "Finalisierung soll ausgefuehrt werden");
        assert_eq!(*log.lock().unwrap(), vec!["stop", "exit"]);
    }

    #[tokio::test]
    async fn exits_even_when_server_not_running() {
        // "Server nicht laufend" ist im echten Code ein Ok-Stop; hier tut der Stop-Future nichts.
        let exited = Arc::new(AtomicUsize::new(0));
        let e = exited.clone();
        let ran = finalize_shutdown_sequence(
            true,
            Duration::from_secs(1),
            async move { /* no-op: Server war nicht aktiv */ },
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert!(ran);
        assert_eq!(exited.load(Ordering::SeqCst), 1, "Exit auch ohne laufenden Server");
    }

    #[tokio::test]
    async fn double_call_does_nothing() {
        // proceed == false (zweiter invoke / Doppel-X) → weder Stop noch Exit.
        let stop = Arc::new(AtomicUsize::new(0));
        let exit = Arc::new(AtomicUsize::new(0));
        let s = stop.clone();
        let e = exit.clone();
        let ran = finalize_shutdown_sequence(
            false,
            Duration::from_secs(1),
            async move {
                s.fetch_add(1, Ordering::SeqCst);
            },
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert!(!ran);
        assert_eq!(stop.load(Ordering::SeqCst), 0, "kein zweiter Server-Stop");
        assert_eq!(exit.load(Ordering::SeqCst), 0, "kein zweiter Exit");
    }

    #[tokio::test]
    async fn hanging_stop_times_out_then_exits() {
        // Haengender Server-Stop → Timeout greift → Exit passiert trotzdem, ohne lange zu warten.
        let exit = Arc::new(AtomicUsize::new(0));
        let e = exit.clone();
        let start = Instant::now();
        let ran = finalize_shutdown_sequence(
            true,
            Duration::from_millis(50),
            std::future::pending::<()>(), // Stop, der NIE fertig wird
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert!(ran);
        assert_eq!(exit.load(Ordering::SeqCst), 1, "Exit trotz haengendem Stop");
        assert!(start.elapsed() >= Duration::from_millis(50), "Timeout muss abgelaufen sein");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "Exit darf nicht auf den haengenden Stop warten"
        );
    }

    #[tokio::test]
    async fn exit_called_exactly_once() {
        let exit = Arc::new(AtomicUsize::new(0));
        let e = exit.clone();
        finalize_shutdown_sequence(
            true,
            Duration::from_secs(1),
            async move {},
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert_eq!(exit.load(Ordering::SeqCst), 1, "Exit-Callback genau einmal");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// M5-B — Native WebView2 Reload-Accelerator-Bridge (F5 / Ctrl+R)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ausgangslage (empirisch belegt in M5-A1): Ein reiner JS-`keydown`-Interceptor mit
// preventDefault() kann den nativen WebView2-Reload NICHT verhindern — WebView2 feuert den
// Reload-Accelerator auf COM-Ebene, bevor/statt der DOM-keydown das Frontend erreicht.
//
// Loesung (gezielt, NICHT global): Auf dem ICoreWebView2Controller einen AcceleratorKeyPressed-
// Handler registrieren. NUR fuer F5 und Ctrl+R setzen wir SetHandled(true) → der native Reload
// unterbleibt. Danach melden wir den Reload-Wunsch als Tauri-Event ans Frontend, das den
// bestehenden M5-Flow faehrt (Sync pausieren → abwarten → durabel speichern → kontrolliert
// reloaden). Alle anderen Accelerator (Ctrl+F, Ctrl+P, F12, Zoom, …) bleiben voellig unberuehrt.

// Event-Name — muss exakt mit src/App.tsx (NATIVE_RELOAD_EVENT) uebereinstimmen.
#[cfg(windows)]
const NATIVE_RELOAD_EVENT: &str = "m5-native-reload-requested";

// Windows Virtual-Key-Codes (nur die fuer die Reload-Klassifikation benoetigten).
#[cfg(windows)]
const VK_F5_CODE: u32 = 0x74; // VK_F5
#[cfg(windows)]
const VK_R_CODE: u32 = 0x52; // 'R'

/// Reine, testbare Klassifikation: Ist dieses native Tastenereignis ein Reload-Accelerator
/// (F5 oder Ctrl+R), den wir abfangen und durch den M5-Flow leiten wollen?
///
/// Bewusste Entscheidungen (dokumentiert):
///   F5 (auch Ctrl+F5 / Shift+F5)  → true   — Hard-Reload ist ebenfalls ein Reload
///   Ctrl+R / Ctrl+Shift+R         → true   — Shift = Hard-Reload, trotzdem ein Reload
///   R ohne Ctrl                   → false
///   Ctrl+F / Ctrl+P / F3 / F12    → false  — kein Reload, unberuehrt lassen
///   Alt+irgendetwas               → false  — System-/Menue-Kombinationen nie abfangen
///   KeyUp                         → false  — nur der KeyDown loest aus
#[cfg(windows)]
fn is_reload_accelerator(
    virtual_key: u32,
    is_key_down: bool,
    ctrl: bool,
    alt: bool,
    _shift: bool,
) -> bool {
    if !is_key_down {
        return false;
    }
    if alt {
        return false;
    }
    if virtual_key == VK_F5_CODE {
        return true;
    }
    if virtual_key == VK_R_CODE && ctrl {
        return true;
    }
    false
}

#[cfg(windows)]
mod reload_bridge {
    use super::{is_reload_accelerator, NATIVE_RELOAD_EVENT};
    use tauri::{AppHandle, Emitter, WebviewWindow};
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
        COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_SHIFT,
    };

    // GetKeyState: High-Bit (0x8000) gesetzt = Taste ist aktuell gedrueckt.
    #[inline]
    fn key_is_down(vk: VIRTUAL_KEY) -> bool {
        (unsafe { GetKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
    }

    /// Registriert den AcceleratorKeyPressed-Handler auf dem Main-Webview-Controller.
    /// Der Handler laeuft auf dem Webview-(UI-)Thread. add_AcceleratorKeyPressed haelt den
    /// Handler per AddRef fuer die gesamte Controller-Lebenszeit am Leben — der Token wird nur
    /// zum spaeteren Entfernen gebraucht und hier bewusst verworfen. Fehler werden geloggt
    /// (kein unwrap/Panic), damit die App auch ohne Bruecke normal startet.
    pub fn install(window: &WebviewWindow, app: AppHandle) {
        let res = window.with_webview(move |pw| {
            let controller = pw.controller();
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };

                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                unsafe { args.KeyEventKind(&mut kind)? };
                let mut virtual_key: u32 = 0;
                unsafe { args.VirtualKey(&mut virtual_key)? };

                let is_key_down = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                    || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
                let ctrl = key_is_down(VK_CONTROL);
                let alt = key_is_down(VK_MENU);
                let shift = key_is_down(VK_SHIFT);

                if is_reload_accelerator(virtual_key, is_key_down, ctrl, alt, shift) {
                    // 1) Nativen Browser-Reload unterdruecken — das ist der eigentliche Fix.
                    unsafe { args.SetHandled(true)? };
                    // 2) Auto-Repeat (gehaltene Taste) erzeugt KEINE zweite Kette: nur beim ersten
                    //    KeyDown ein Event senden. WasKeyDown == true → Wiederholung → nichts senden.
                    let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    unsafe { args.PhysicalKeyStatus(&mut status)? };
                    if !status.WasKeyDown.as_bool() {
                        // 3) Reload-Wunsch ans Frontend (M5-Flow entscheidet ueber den Reload).
                        let _ = app.emit(NATIVE_RELOAD_EVENT, ());
                    }
                }
                Ok(())
            }));

            let mut token: i64 = 0;
            match unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) } {
                Ok(()) => eprintln!("[m5-reload-bridge] installed — F5/Ctrl+R are controlled"),
                Err(e) => eprintln!("[m5-reload-bridge] add_AcceleratorKeyPressed failed: {e:?}"),
            }
        });
        if let Err(e) = res {
            eprintln!("[m5-reload-bridge] with_webview failed: {e:?}");
        }
    }
}

#[cfg(all(test, windows))]
mod reload_bridge_tests {
    use super::is_reload_accelerator;

    // Virtual-Key-Codes fuer die Testfaelle.
    const VK_F5: u32 = 0x74;
    const VK_R: u32 = 0x52;
    const VK_F: u32 = 0x46;
    const VK_P: u32 = 0x50;
    const VK_F3: u32 = 0x72;
    const VK_F12: u32 = 0x7B;

    #[test]
    fn f5_keydown_is_reload() {
        assert!(is_reload_accelerator(VK_F5, true, false, false, false));
    }

    #[test]
    fn ctrl_r_keydown_is_reload() {
        assert!(is_reload_accelerator(VK_R, true, true, false, false));
    }

    #[test]
    fn ctrl_shift_r_is_reload() {
        // Ctrl+Shift+R (Hard-Reload) wird bewusst ebenfalls als Reload behandelt.
        assert!(is_reload_accelerator(VK_R, true, true, false, true));
    }

    #[test]
    fn ctrl_f5_is_reload() {
        // Ctrl+F5 (Hard-Reload) ebenfalls Reload.
        assert!(is_reload_accelerator(VK_F5, true, true, false, false));
    }

    #[test]
    fn r_without_ctrl_is_not_reload() {
        assert!(!is_reload_accelerator(VK_R, true, false, false, false));
    }

    #[test]
    fn ctrl_f_is_not_reload() {
        assert!(!is_reload_accelerator(VK_F, true, true, false, false));
    }

    #[test]
    fn ctrl_p_is_not_reload() {
        assert!(!is_reload_accelerator(VK_P, true, true, false, false));
    }

    #[test]
    fn f3_is_not_reload() {
        assert!(!is_reload_accelerator(VK_F3, true, false, false, false));
    }

    #[test]
    fn f12_is_not_reload() {
        assert!(!is_reload_accelerator(VK_F12, true, false, false, false));
    }

    #[test]
    fn keyup_is_never_reload() {
        // Gleiche Tasten, aber KeyUp → nie ausloesen (nur KeyDown loest aus).
        assert!(!is_reload_accelerator(VK_F5, false, false, false, false));
        assert!(!is_reload_accelerator(VK_R, false, true, false, false));
    }

    #[test]
    fn alt_combinations_are_never_reload() {
        // Alt+R / Alt+F5 → nie abfangen (System-/Menuekombination).
        assert!(!is_reload_accelerator(VK_R, true, true, true, false));
        assert!(!is_reload_accelerator(VK_F5, true, false, true, false));
    }

    #[test]
    fn repeat_same_state_stays_deterministic() {
        // Repeat-Unterdrueckung passiert im nativen Handler (WasKeyDown), nicht im Klassifikator:
        // fuer denselben Tastenzustand bleibt die Klassifikation deterministisch true.
        assert!(is_reload_accelerator(VK_R, true, true, false, false));
        assert!(is_reload_accelerator(VK_R, true, true, false, false));
    }
}

// ── MEDIA-04A-2A — guarded media command bridge ──────────────────────────────
// Thin wrappers over `media::ingest::MediaIngestService`. They resolve the
// production media root (`<app_data_dir>/media`) and delegate; all real logic,
// durability and idempotency live in the tested service. No UI calls these yet,
// and no SQL.js metadata is written. Errors are mapped to their stable public
// code string (no path/OS detail leaks to JS). Image bytes travel as `Vec<u8>`
// (never a base64 string and never a free source path); over IPC this currently
// serializes as a byte array — a raw-body transport is a later optimization when
// the UI wires these in (04A-2B/04A-3).

// MEDIA-04A-2A-R2 — return the shared, process-scoped ingest service. All 5
// command handlers reach the service through this helper, so they observe the
// same identity_locks registry and their per-(scope, id) serialisation
// actually stacks up. Previously this built a fresh service per call, which
// meant no two handlers ever shared a lock.
fn media_ingest_service(
    state: &tauri::State<'_, AppHandleState>,
) -> Arc<media::ingest::MediaIngestService> {
    state.media_ingest.clone()
}

#[tauri::command]
fn media_prepare_stock_image(
    state: tauri::State<'_, AppHandleState>,
    tenant_scope: String,
    ingest_request_id: String,
    request_hash: String,
    image_bytes: Vec<u8>,
    original_name: Option<String>,
) -> Result<media::ingest::PrepareResult, String> {
    // IPC boundary guard: refuse oversized uploads before allocating a service,
    // touching the media root or handing bytes to the image decoder. The same
    // ceiling is re-checked inside `prepare`, so any code path that bypasses
    // this wrapper still fails safe.
    if image_bytes.len() > media::ingest::MAX_INGEST_INPUT_BYTES {
        return Err("MEDIA_INGEST_INPUT_TOO_LARGE".to_string());
    }
    let svc = media_ingest_service(&state);
    svc.prepare(
        &tenant_scope,
        &ingest_request_id,
        &request_hash,
        &image_bytes,
        original_name.as_deref(),
    )
    .map_err(|e| e.code().to_string())
}

#[tauri::command]
fn media_commit_stock_image(
    state: tauri::State<'_, AppHandleState>,
    tenant_scope: String,
    ingest_request_id: String,
    request_hash: String,
) -> Result<media::ingest::CommitResult, String> {
    let svc = media_ingest_service(&state);
    svc.commit(&tenant_scope, &ingest_request_id, &request_hash)
        .map_err(|e| e.code().to_string())
}

#[tauri::command]
fn media_abort_stock_image(
    state: tauri::State<'_, AppHandleState>,
    tenant_scope: String,
    ingest_request_id: String,
) -> Result<media::ingest::AbortResult, String> {
    let svc = media_ingest_service(&state);
    svc.abort(&tenant_scope, &ingest_request_id)
        .map_err(|e| e.code().to_string())
}

#[tauri::command]
fn media_read_verified(
    state: tauri::State<'_, AppHandleState>,
    tenant_scope: String,
    hash: String,
    extension: String,
) -> Result<media::ingest::MediaBytes, String> {
    let svc = media_ingest_service(&state);
    svc.read(&tenant_scope, &hash, &extension)
        .map_err(|e| e.code().to_string())
}

#[tauri::command]
fn media_recover_ingests(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<media::ingest::RecoveryOutcome>, String> {
    let svc = media_ingest_service(&state);
    svc.recover().map_err(|e| e.code().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&app_dir);
            let db_path = app_dir.join("lataif_sync_server.db");

            let server = Arc::new(sync::SyncServer::new(db_path, SYNC_PORT));
            // MEDIA-04A-2A-R2 — build the ingest service exactly once, at app
            // setup, and share it via Tauri-managed state. Building one per
            // command handler (the previous shape) gave each handler its own
            // identity_locks map, silently breaking the concurrency contract.
            let media_ingest =
                Arc::new(media::ingest::MediaIngestService::new(app_dir.join("media")));
            app.manage(AppHandleState { server, media_ingest });

            // M5-B — native WebView2-Reload-Bruecke (nur Windows) auf dem Main-Webview
            // installieren: F5/Ctrl+R nativ unterdruecken und als Tauri-Event ans Frontend
            // melden, das den durablen M5-Save-vor-Reload-Flow faehrt.
            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    reload_bridge::install(&window, app.handle().clone());
                } else {
                    eprintln!("[m5-reload-bridge] main webview window not found — bridge not installed");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sync_server_start,
            primary_status,
            primary_configure,
            primary_adopt_legacy,
            primary_migrate_legacy,
            // M6-B2A4 — local-only owner provisioning. No HTTP equivalent exists.
            server_owner_status,
            server_owner_provision,
            server_owner_change_password,
            // M6-B2B/B2C — trust root + authority. INACTIVE: no route consults them.
            trust_root_status,
            trust_root_initialize,
            trust_root_export_recovery,
            trust_root_import_recovery,
            authority_status,
            authority_initialize,
            authority_transfer_issue,
            authority_transfer_import,
            authority_transfer_receipt,
            authority_transfer_confirm,
            authority_transfer_commit,
            authority_transfer_commit_token,
            authority_transfer_activate,
            authority_transfer_abort,
            authority_transfer_abort_import,
            authority_prepare_recovery,
            authority_revoke,
            device_status,
            device_create_enrollment_request,
            device_approve_enrollment,
            device_import_enrollment_response,
            device_revoke,
            device_begin_reenrollment,
            inventory_add_item,
            inventory_link_device,
            inventory_resolve_item,
            inventory_list,
            inventory_attest,
            cutover_readiness,
            cutover_mark_ready,
            cutover_attempt_activation,
            sync_server_stop,
            sync_server_status,
            discover_lan_servers,
            print_raw_zpl,
            // MEDIA-04A-2A — guarded media command bridge (registered; no UI caller yet).
            media_prepare_stock_image,
            media_commit_stock_image,
            media_abort_stock_image,
            media_read_verified,
            media_recover_ingests,
            finalize_application_shutdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
