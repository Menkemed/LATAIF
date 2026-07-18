//! M6-B2E — legacy inventory, owner attestation and cutover readiness. **INACTIVE.**
//!
//! ## The fact this module is built around
//!
//! **v0.8.23 has no stable device identity.** The §2 audit settled it: a client is a JWT
//! naming a *user*, and `/sync/push` records `user_id` and nothing else. There is no scan,
//! no query and no heuristic that can enumerate the old fleet — technical completeness is
//! not unimplemented here, it is *impossible* against the data that exists.
//!
//! So everything below models an **administrative owner declaration**. The owner types what
//! they believe their devices are, resolves every one of them, and signs their name to a
//! sentence. That is worth something — it is a person taking responsibility — and it is not
//! a proof. This module must never present it as one.
//!
//! ## Why readiness is not activation
//!
//! Readiness means "the human preconditions are met". Activation means "legacy clients stop
//! working". The second belongs to B3/B4, which owns the v4 write path; until that path
//! exists, `protocol_v4_write_path_ready` stays `false` and activation returns
//! `PROTOCOL_V4_WRITE_PATH_NOT_READY`. A slice that could flip the switch without the path
//! behind it would be able to break every client in the field.

use rusqlite::{params, Connection, OptionalExtension};

use super::canonical::{self, sha256_hex, CanonicalWriter};
use super::device::{self, RegistryState};
use super::primary::OwnerAuth;

/// §11 — the exact phrase the owner must type. Not a checkbox: a sentence that is unpleasant
/// to type carelessly, and that says what is being claimed.
pub const ATTESTATION_CONFIRMATION: &str = "I_CONFIRM_THIS_IS_THE_COMPLETE_LEGACY_DEVICE_INVENTORY";

/// The wording is versioned. If it ever changes, old attestations must not silently inherit
/// the new meaning — they attested to *this* sentence.
pub const STATEMENT_VERSION: i64 = 1;
pub const STATEMENT_TEXT: &str = "The owner declares that the listed devices are the complete \
    set of installations that used this tenant before device enrollment existed. This is an \
    administrative declaration by a person, NOT a technically proven scan: v0.8.23 had no \
    stable device identity, so no software check can confirm or refute it.";

pub const MAX_LABEL_LEN: usize = 128;
pub const MAX_TEXT_LEN: usize = 512;

// ── Error codes ─────────────────────────────────────────────────────────────
pub const ERR_NOT_CONFIRMED: &str = "INVENTORY_ATTESTATION_NOT_CONFIRMED";
pub const ERR_UNRESOLVED_ITEMS: &str = "INVENTORY_HAS_UNRESOLVED_ITEMS";
pub const ERR_INVENTORY_EMPTY: &str = "INVENTORY_IS_EMPTY";
pub const ERR_INVALID: &str = "INVENTORY_INVALID";
pub const ERR_REASON_REQUIRED: &str = "INVENTORY_RESOLUTION_REASON_REQUIRED";
pub const ERR_DEVICE_NOT_ACTIVE: &str = "INVENTORY_LINKED_DEVICE_NOT_ACTIVE";
pub const ERR_NOT_READY: &str = "CUTOVER_NOT_READY";
/// M6-B3A §11 — an unresolved sync quarantine blocks cutover readiness.
pub const ERR_QUARANTINE_UNRESOLVED: &str = "SYNC_QUARANTINE_UNRESOLVED";
/// §12 — the one that keeps this slice from being a foot-gun.
pub const ERR_V4_NOT_READY: &str = "PROTOCOL_V4_WRITE_PATH_NOT_READY";

// ── §10 — inventory items ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemStatus {
    /// The owner believes this device exists and has not accounted for it yet.
    Expected,
    /// Explicitly linked, by a human, to an enrolled device.
    Enrolled,
    Retired,
    Lost,
    Excluded,
    /// The owner does not know. This is a legitimate answer and it blocks readiness — which
    /// is the point: "unknown" is information, and pretending otherwise is the failure mode.
    Unknown,
}

impl ItemStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemStatus::Expected => "expected",
            ItemStatus::Enrolled => "enrolled",
            ItemStatus::Retired => "retired",
            ItemStatus::Lost => "lost",
            ItemStatus::Excluded => "excluded",
            ItemStatus::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> Option<ItemStatus> {
        Some(match s {
            "expected" => ItemStatus::Expected,
            "enrolled" => ItemStatus::Enrolled,
            "retired" => ItemStatus::Retired,
            "lost" => ItemStatus::Lost,
            "excluded" => ItemStatus::Excluded,
            "unknown" => ItemStatus::Unknown,
            _ => return None,
        })
    }
    /// "Resolved" means the owner has said what became of this device — not that it is
    /// enrolled. A retired or written-off machine is accounted for; an `expected` one that
    /// nobody has touched is not, and neither is an `unknown`.
    pub fn is_resolved(self) -> bool {
        matches!(self, ItemStatus::Enrolled | ItemStatus::Retired | ItemStatus::Lost | ItemStatus::Excluded)
    }
    /// §10/§11 — writing a device off needs a sentence a person wrote.
    pub fn needs_reason(self) -> bool {
        matches!(self, ItemStatus::Retired | ItemStatus::Lost | ItemStatus::Excluded)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventoryItem {
    pub inventory_item_id: String,
    pub owner_label: String,
    pub status: ItemStatus,
    pub linked_device_id: Option<String>,
    pub resolution_reason: Option<String>,
}

/// §10 — the owner adds an item. Nothing discovers these.
pub fn add_item(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    owner_label: &str,
    device_description: Option<&str>,
    expected_user_or_location: Option<&str>,
    owner: &OwnerAuth,
) -> Result<String, &'static str> {
    let label = owner_label.trim();
    if label.is_empty() || label.len() > MAX_LABEL_LEN {
        return Err(ERR_INVALID);
    }
    for t in [device_description, expected_user_or_location] {
        if t.is_some_and(|s| s.len() > MAX_TEXT_LEN) {
            return Err(ERR_INVALID);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO legacy_device_inventory
           (inventory_item_id, tenant_id, branch_id, owner_label, device_description,
            expected_user_or_location, status, created_at, updated_at, created_by)
         VALUES (?1,?2,?3,?4,?5,?6,'expected',?7,?7,?8)",
        params![id, tenant_id, branch_id, label, device_description, expected_user_or_location, now, owner.user_id()],
    )
    .map_err(|_| ERR_INVALID)?;
    bump_revision(conn, tenant_id, branch_id, owner)?;
    Ok(id)
}

/// §10 — the owner links an item to an enrolled device. **Explicitly.**
///
/// There is deliberately no `auto_link_by_hostname`, no matching on IP, mDNS name or last
/// sync time. Every one of those is a guess, and a wrong guess marks a device as accounted
/// for when it is not — which is exactly the lie an attestation must not be able to contain.
pub fn link_to_device(
    conn: &Connection,
    inventory_item_id: &str,
    device_id: &str,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    let dev = device::load_device(conn, device_id)
        .map_err(|_| ERR_INVALID)?
        .ok_or(ERR_DEVICE_NOT_ACTIVE)?;
    // I3 — an item counts as enrolled only against a device that is actually usable. A
    // revoked device answering for an inventory item would be a resolved row with nothing
    // behind it.
    if !dev.state.is_usable() {
        return Err(ERR_DEVICE_NOT_ACTIVE);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let (tenant, branch) = item_scope(conn, inventory_item_id)?;
    conn.execute(
        "UPDATE legacy_device_inventory
            SET status = 'enrolled', linked_device_id = ?2, resolution_reason = ?3,
                resolved_at = ?4, resolved_by = ?5, updated_at = ?4
          WHERE inventory_item_id = ?1",
        params![
            inventory_item_id,
            device_id,
            format!("owner linked this item to device {}", super::trust_root::redact(device_id)),
            now,
            owner.user_id(),
        ],
    )
    .map_err(|_| ERR_INVALID)?;
    bump_revision(conn, &tenant, &branch, owner)?;
    Ok(())
}

/// §10 — the owner writes an item off, with a reason.
pub fn resolve_item(
    conn: &Connection,
    inventory_item_id: &str,
    status: ItemStatus,
    reason: &str,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    // I4 — `lost` / `retired` / `excluded` all need a human sentence. The DB enforces it
    // too; this is the legible error.
    if status.needs_reason() && reason.trim().is_empty() {
        return Err(ERR_REASON_REQUIRED);
    }
    if reason.len() > MAX_TEXT_LEN {
        return Err(ERR_INVALID);
    }
    // `enrolled` goes through `link_to_device`, which is the only path that names a device.
    if status == ItemStatus::Enrolled {
        return Err(ERR_INVALID);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let (tenant, branch) = item_scope(conn, inventory_item_id)?;
    let resolved_at = if status.is_resolved() { Some(now.clone()) } else { None };
    conn.execute(
        "UPDATE legacy_device_inventory
            SET status = ?2, resolution_reason = ?3, resolved_at = ?4, resolved_by = ?5,
                updated_at = ?6, linked_device_id = NULL
          WHERE inventory_item_id = ?1",
        params![inventory_item_id, status.as_str(), reason, resolved_at, owner.user_id(), now],
    )
    .map_err(|_| ERR_INVALID)?;
    bump_revision(conn, &tenant, &branch, owner)?;
    Ok(())
}

fn item_scope(conn: &Connection, item_id: &str) -> Result<(String, String), &'static str> {
    conn.query_row(
        "SELECT tenant_id, branch_id FROM legacy_device_inventory WHERE inventory_item_id = ?1",
        params![item_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|_| ERR_INVALID)?
    .ok_or(ERR_INVALID)
}

pub fn list_items(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
) -> Result<Vec<InventoryItem>, &'static str> {
    let mut st = conn
        .prepare(
            "SELECT inventory_item_id, owner_label, status, linked_device_id, resolution_reason
               FROM legacy_device_inventory
              WHERE tenant_id = ?1 AND branch_id = ?2
              ORDER BY created_at, inventory_item_id",
        )
        .map_err(|_| ERR_INVALID)?;
    let rows = st
        .query_map(params![tenant_id, branch_id], |r| {
            let s: String = r.get(2)?;
            Ok(InventoryItem {
                inventory_item_id: r.get(0)?,
                owner_label: r.get(1)?,
                // An unparseable status is `Unknown` — the value that blocks readiness. Never
                // a permissive default.
                status: ItemStatus::parse(&s).unwrap_or(ItemStatus::Unknown),
                linked_device_id: r.get(3)?,
                resolution_reason: r.get(4)?,
            })
        })
        .map_err(|_| ERR_INVALID)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|_| ERR_INVALID)
}

// ── §12 — cutover state ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CutoverState {
    LegacyOpen,
    InventoryDraft,
    InventoryAttested,
    EnrollmentInProgress,
    ReadyForProtocolActivation,
    ActivationBlocked,
}

impl CutoverState {
    pub fn as_str(self) -> &'static str {
        match self {
            CutoverState::LegacyOpen => "legacy_open",
            CutoverState::InventoryDraft => "inventory_draft",
            CutoverState::InventoryAttested => "inventory_attested",
            CutoverState::EnrollmentInProgress => "enrollment_in_progress",
            CutoverState::ReadyForProtocolActivation => "ready_for_protocol_activation",
            CutoverState::ActivationBlocked => "activation_blocked",
        }
    }
    pub fn parse(s: &str) -> Option<CutoverState> {
        Some(match s {
            "legacy_open" => CutoverState::LegacyOpen,
            "inventory_draft" => CutoverState::InventoryDraft,
            "inventory_attested" => CutoverState::InventoryAttested,
            "enrollment_in_progress" => CutoverState::EnrollmentInProgress,
            "ready_for_protocol_activation" => CutoverState::ReadyForProtocolActivation,
            "activation_blocked" => CutoverState::ActivationBlocked,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CutoverRecord {
    pub state: CutoverState,
    pub inventory_revision: i64,
    pub current_attestation_id: Option<String>,
    pub protocol_v4_write_path_ready: bool,
    pub legacy_activity_after_attestation: bool,
    pub blocked_reason: Option<String>,
}

pub fn load_state(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
) -> Result<CutoverRecord, &'static str> {
    let found = conn
        .query_row(
            "SELECT state, inventory_revision, current_attestation_id,
                    protocol_v4_write_path_ready, legacy_activity_after_attestation, blocked_reason
               FROM sync_cutover_state WHERE tenant_id = ?1 AND branch_id = ?2",
            params![tenant_id, branch_id],
            |r| {
                let s: String = r.get(0)?;
                Ok(CutoverRecord {
                    state: CutoverState::parse(&s).unwrap_or(CutoverState::ActivationBlocked),
                    inventory_revision: r.get(1)?,
                    current_attestation_id: r.get(2)?,
                    protocol_v4_write_path_ready: r.get::<_, i64>(3)? != 0,
                    legacy_activity_after_attestation: r.get::<_, i64>(4)? != 0,
                    blocked_reason: r.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|_| ERR_INVALID)?;
    // No row means nothing has started: legacy is open, which is the truthful default for
    // every tenant that has not begun this at all.
    Ok(found.unwrap_or(CutoverRecord {
        state: CutoverState::LegacyOpen,
        inventory_revision: 1,
        current_attestation_id: None,
        protocol_v4_write_path_ready: false,
        legacy_activity_after_attestation: false,
        blocked_reason: None,
    }))
}

/// Set the cutover state, carrying the existing attestation id along.
///
/// The attestation id has to be repeated in the INSERT even though `ON CONFLICT DO UPDATE`
/// would leave the stored one alone. SQLite evaluates CHECK constraints while building the
/// candidate row — BEFORE it notices the uniqueness conflict and switches to the UPDATE — so
/// the check `state <> 'ready_for_protocol_activation' OR current_attestation_id IS NOT NULL`
/// sees NULL and fires on a row that would never have been inserted. Carrying the value makes
/// the candidate row satisfy the same invariant the final row must.
fn upsert_state(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    state: CutoverState,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    let now = chrono::Utc::now().to_rfc3339();
    let cur = load_state(conn, tenant_id, branch_id)?;
    conn.execute(
        "INSERT INTO sync_cutover_state
           (tenant_id, branch_id, state, inventory_revision, current_attestation_id,
            updated_at, updated_by)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(tenant_id, branch_id) DO UPDATE SET
            state = excluded.state, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by",
        params![
            tenant_id,
            branch_id,
            state.as_str(),
            cur.inventory_revision,
            cur.current_attestation_id,
            now,
            owner.user_id(),
        ],
    )
    .map_err(|_| ERR_INVALID)?;
    Ok(())
}

/// Every inventory edit bumps the revision. An attestation names the revision it covered, so
/// editing the inventory afterwards cannot leave a stale attestation looking current.
fn bump_revision(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    owner: &OwnerAuth,
) -> Result<(), &'static str> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO sync_cutover_state
           (tenant_id, branch_id, state, inventory_revision, updated_at, updated_by)
         VALUES (?1,?2,'inventory_draft',2,?3,?4)
         ON CONFLICT(tenant_id, branch_id) DO UPDATE SET
            inventory_revision = sync_cutover_state.inventory_revision + 1,
            -- An edit invalidates the current attestation: it attested to a different list.
            state = CASE WHEN sync_cutover_state.state IN ('inventory_attested',
                                                           'ready_for_protocol_activation')
                         THEN 'inventory_draft' ELSE sync_cutover_state.state END,
            current_attestation_id = NULL,
            updated_at = excluded.updated_at",
        params![tenant_id, branch_id, now, owner.user_id()],
    )
    .map_err(|_| ERR_INVALID)?;
    // The old attestation is superseded, not deleted — it remains a record of what someone
    // declared and when.
    conn.execute(
        "UPDATE legacy_inventory_attestations SET superseded_at = ?3
          WHERE tenant_id = ?1 AND branch_id = ?2 AND superseded_at IS NULL",
        params![tenant_id, branch_id, now],
    )
    .map_err(|_| ERR_INVALID)?;
    Ok(())
}

/// The canonical hash of the inventory, so an attestation is tied to an exact list.
fn inventory_hash(items: &[InventoryItem]) -> String {
    let mut w = CanonicalWriter::new(canonical::DOMAIN_DEVICE_CERT, 1);
    w.i64(items.len() as i64);
    for i in items {
        w.string(&i.inventory_item_id)
            .string(&i.owner_label)
            .string(i.status.as_str())
            .opt_string(i.linked_device_id.as_deref());
    }
    sha256_hex(&w.finish())
}

// ── §11 — the attestation ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    pub attestation_id: String,
    pub inventory_revision: i64,
    pub item_count: i64,
    pub resolved_count: i64,
    pub unresolved_count: i64,
    pub statement_version: i64,
}

/// §11 — the owner declares the inventory complete.
///
/// Three things must hold, and none of them is a technical proof: the exact phrase was
/// typed, the inventory is not empty, and every single item is resolved. The last one is
/// what stops an attestation from quietly covering an `unknown` — a device the owner cannot
/// account for is precisely the device that matters.
pub fn attest_inventory(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    confirmation: &str,
    owner: &OwnerAuth,
) -> Result<Attestation, &'static str> {
    if confirmation != ATTESTATION_CONFIRMATION {
        return Err(ERR_NOT_CONFIRMED);
    }
    let items = list_items(conn, tenant_id, branch_id)?;
    // I1 — an empty inventory is not a complete one. "I have no devices" is a claim nobody
    // making this declaration means to make.
    if items.is_empty() {
        return Err(ERR_INVENTORY_EMPTY);
    }
    let unresolved = items.iter().filter(|i| !i.status.is_resolved()).count() as i64;
    // I2 — anything expected or unknown blocks the claim.
    if unresolved > 0 {
        return Err(ERR_UNRESOLVED_ITEMS);
    }
    // I3 — every linked device must still be usable at attestation time, not merely at link
    // time. A device revoked in between would make this list stale.
    for i in &items {
        if let Some(dev_id) = &i.linked_device_id {
            let dev = device::load_device(conn, dev_id).map_err(|_| ERR_INVALID)?;
            match dev {
                Some(d) if d.state.is_usable() => {}
                _ => return Err(ERR_DEVICE_NOT_ACTIVE),
            }
        }
    }

    let cur = load_state(conn, tenant_id, branch_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    let att = Attestation {
        attestation_id: uuid::Uuid::new_v4().to_string(),
        inventory_revision: cur.inventory_revision,
        item_count: items.len() as i64,
        resolved_count: items.len() as i64,
        unresolved_count: 0,
        statement_version: STATEMENT_VERSION,
    };

    let tx = conn.unchecked_transaction().map_err(|_| ERR_INVALID)?;
    tx.execute(
        "UPDATE legacy_inventory_attestations SET superseded_at = ?3
          WHERE tenant_id = ?1 AND branch_id = ?2 AND superseded_at IS NULL",
        params![tenant_id, branch_id, now],
    )
    .map_err(|_| ERR_INVALID)?;
    tx.execute(
        "INSERT INTO legacy_inventory_attestations
           (attestation_id, tenant_id, branch_id, inventory_revision, inventory_hash,
            item_count, resolved_count, unresolved_count, attested_at, attested_by,
            statement_version, statement_text)
         VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?10,?11)",
        params![
            att.attestation_id,
            tenant_id,
            branch_id,
            att.inventory_revision,
            inventory_hash(&items),
            att.item_count,
            att.resolved_count,
            now,
            owner.user_id(),
            STATEMENT_VERSION,
            STATEMENT_TEXT,
        ],
    )
    .map_err(|_| ERR_INVALID)?;
    tx.execute(
        "INSERT INTO sync_cutover_state
           (tenant_id, branch_id, state, inventory_revision, current_attestation_id,
            updated_at, updated_by)
         VALUES (?1,?2,'inventory_attested',?3,?4,?5,?6)
         ON CONFLICT(tenant_id, branch_id) DO UPDATE SET
            state = 'inventory_attested',
            current_attestation_id = excluded.current_attestation_id,
            -- A fresh attestation clears an earlier block: the owner has looked again.
            legacy_activity_after_attestation = 0,
            blocked_reason = NULL,
            updated_at = excluded.updated_at",
        params![tenant_id, branch_id, att.inventory_revision, att.attestation_id, now, owner.user_id()],
    )
    .map_err(|_| ERR_INVALID)?;
    tx.commit().map_err(|_| ERR_INVALID)?;
    Ok(att)
}

// ── §12 — readiness ─────────────────────────────────────────────────────────

/// Everything that must hold before a cutover could even be contemplated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadinessReport {
    pub state: CutoverState,
    pub has_attestation: bool,
    pub all_items_resolved: bool,
    pub all_enrolled_items_have_active_certificates: bool,
    pub has_active_authority: bool,
    pub has_active_root_custody: bool,
    pub owner_provisioned: bool,
    pub static_primary_binding_valid: bool,
    pub legacy_activity_after_attestation: bool,
    /// §12 — always false in this slice. B3/B4 owns the v4 write path.
    pub protocol_v4_write_path_ready: bool,
    pub blocking_reasons: Vec<String>,
}

impl ReadinessReport {
    /// Readiness is about the HUMAN preconditions. It never means "activate now".
    pub fn is_ready(&self) -> bool {
        self.blocking_reasons.is_empty()
    }
}

/// §12 — evaluate readiness. Read-only, and it never activates anything.
pub fn evaluate_readiness(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    install_id: &str,
    primary_state: super::primary::State,
) -> Result<ReadinessReport, &'static str> {
    let cur = load_state(conn, tenant_id, branch_id)?;
    let items = list_items(conn, tenant_id, branch_id)?;
    let mut blocking = Vec::new();

    let has_attestation = cur.current_attestation_id.is_some();
    if !has_attestation {
        blocking.push("no current owner attestation".to_string());
    }
    let all_resolved = !items.is_empty() && items.iter().all(|i| i.status.is_resolved());
    if items.is_empty() {
        blocking.push("inventory is empty".to_string());
    } else if !all_resolved {
        blocking.push("inventory has unresolved items".to_string());
    }

    // Every item the owner marked as enrolled must point at a device with an ACTIVE
    // certificate — not merely an active row. The certificate is the thing that can be
    // checked; the row is bookkeeping.
    let mut certs_ok = true;
    for i in &items {
        if i.status == ItemStatus::Enrolled {
            let ok = match device::load_device(conn, i.linked_device_id.as_deref().unwrap_or(""))
                .map_err(|_| ERR_INVALID)?
            {
                Some(d) if d.state == RegistryState::Active => match &d.active_certificate_serial {
                    Some(serial) => matches!(
                        device::certificate_status(conn, serial).map_err(|_| ERR_INVALID)?,
                        Some(ref s) if s == "active"
                    ),
                    None => false,
                },
                _ => false,
            };
            if !ok {
                certs_ok = false;
            }
        }
    }
    if !certs_ok {
        blocking.push("an enrolled inventory item has no active device certificate".to_string());
    }

    let root = super::trust_root::load_active_root(conn, tenant_id).map_err(|_| ERR_INVALID)?;
    let has_root = root.is_some();
    let has_authority = super::authority::load_active(conn, tenant_id, branch_id)
        .map_err(|_| ERR_INVALID)?
        .is_some();
    if !has_authority {
        blocking.push("no active authority certificate".to_string());
    }
    let has_custody = super::transfer::custody_state(conn, tenant_id, install_id)
        .map_err(|_| ERR_INVALID)?
        .is_some_and(|c| c.may_sign());
    if !has_custody {
        blocking.push("no active root custody on this installation".to_string());
    }
    let _ = has_root;

    let owner_ok = super::credentials::owner_credentials_ready(conn);
    if !owner_ok {
        blocking.push("server owner is not provisioned".to_string());
    }
    // The B2A binding: a copied DB resolves to read_only and must never be "ready".
    let primary_ok = primary_state.may_write_sync();
    if !primary_ok {
        blocking.push("static primary binding is not valid on this installation".to_string());
    }

    // §13 — legacy traffic after the attestation invalidates it.
    if cur.legacy_activity_after_attestation {
        blocking.push("legacy activity observed after the attestation".to_string());
    }

    // M6-B3A §11 — an unresolved sync quarantine blocks readiness. A poisoned or foreign change was
    // withheld and awaits owner review (`open`); calling the cutover complete while it sits there
    // would claim a clean, converged state that is not clean. `unwrap_or(0)` keeps a pre-v0009 DB
    // (no quarantine table) from being blocked by a query error rather than by real quarantine.
    let open_quarantine: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_change_quarantine WHERE state = 'open' AND tenant_id = ?1",
            rusqlite::params![tenant_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if open_quarantine > 0 {
        blocking.push(format!(
            "{ERR_QUARANTINE_UNRESOLVED}: {open_quarantine} open sync quarantine entr{}",
            if open_quarantine == 1 { "y" } else { "ies" }
        ));
    }

    Ok(ReadinessReport {
        state: cur.state,
        has_attestation,
        all_items_resolved: all_resolved,
        all_enrolled_items_have_active_certificates: certs_ok,
        has_active_authority: has_authority,
        has_active_root_custody: has_custody,
        owner_provisioned: owner_ok,
        static_primary_binding_valid: primary_ok,
        legacy_activity_after_attestation: cur.legacy_activity_after_attestation,
        protocol_v4_write_path_ready: cur.protocol_v4_write_path_ready,
        blocking_reasons: blocking,
    })
}

/// §12 — move to `ready_for_protocol_activation` if, and only if, everything holds.
pub fn mark_ready(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    install_id: &str,
    primary_state: super::primary::State,
    owner: &OwnerAuth,
) -> Result<ReadinessReport, &'static str> {
    let report = evaluate_readiness(conn, tenant_id, branch_id, install_id, primary_state)?;
    if !report.is_ready() {
        return Err(ERR_NOT_READY);
    }
    upsert_state(conn, tenant_id, branch_id, CutoverState::ReadyForProtocolActivation, owner)?;
    evaluate_readiness(conn, tenant_id, branch_id, install_id, primary_state)
}

/// §12 — the activation attempt. **Always refuses in this slice.**
///
/// It exists so the refusal is a tested contract rather than an absence. `protocol_v4_write_path_ready`
/// is written by nothing here: B3/B4 owns the v4 write path, and a switch that can be flipped
/// without the path behind it would break every client in the field the moment someone found
/// the button.
pub fn attempt_activation(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    install_id: &str,
    primary_state: super::primary::State,
) -> Result<(), &'static str> {
    let report = evaluate_readiness(conn, tenant_id, branch_id, install_id, primary_state)?;
    if !report.is_ready() {
        return Err(ERR_NOT_READY);
    }
    if !report.protocol_v4_write_path_ready {
        return Err(ERR_V4_NOT_READY);
    }
    // Unreachable in this slice, and deliberately not implemented: reaching here would mean
    // the flag became true, which only B3/B4 may cause.
    Err(ERR_V4_NOT_READY)
}

// ── §13 — legacy activity after an attestation ──────────────────────────────

/// §13 — record that legacy traffic was seen after the inventory was declared complete.
///
/// Note what is NOT recorded: which device did it. Legacy clients have no identity — that is
/// the whole premise of this module — so naming a culprit would be a fabrication. The honest
/// statement is "something that is not enrolled is still writing", and that is enough to
/// invalidate a completeness claim and send the owner back to look again.
///
/// ## Why this has no caller yet, and why that is correct
///
/// §13 wants legacy activity noticed. §14 forbids `/sync/push` from knowing anything about
/// cutover state — and `/sync/push` is the only place that sees legacy traffic. The two
/// requirements meet exactly here, and the resolution is deliberate: the FUNCTION exists and
/// is tested (I7/I8), the CALL SITE does not, because adding it would mean editing the sync
/// write path this slice froze.
///
/// Wiring it up is B3's, in the same change that makes the write path aware of protocol
/// versions at all. Until then a tenant can reach `ready_for_protocol_activation` while a
/// legacy client is quietly still writing — which is survivable precisely because readiness
/// activates nothing.
///
/// M6-B2DE1 §10 — now wired: `apply_legacy_push_batch` and `sync_pull` both call this after a
/// successful, authenticated legacy sync. It stays a pure observation — it never rejects the
/// sync that triggered it.
pub fn record_legacy_activity(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    observed_at: &str,
) -> Result<(), &'static str> {
    let cur = load_state(conn, tenant_id, branch_id)?;
    // Before an attestation, legacy traffic is simply normal operation.
    if cur.current_attestation_id.is_none() {
        return Ok(());
    }
    conn.execute(
        "UPDATE sync_cutover_state
            SET legacy_activity_after_attestation = 1,
                last_legacy_activity_at = ?3,
                state = 'activation_blocked',
                blocked_reason = 'legacy activity observed after the owner attested the \
                                  inventory as complete; the attestation must be renewed',
                updated_at = ?3
          WHERE tenant_id = ?1 AND branch_id = ?2",
        params![tenant_id, branch_id, observed_at],
    )
    .map_err(|_| ERR_INVALID)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::device::{self as dev, EnrollmentGrant};
    use crate::sync::primary::{self, State};
    use crate::sync::trust_root::{self, TrustRootRecord};

    const INSTALL_A: &str = "11111111-1111-4111-8111-111111111111";
    const INSTALL_B: &str = "22222222-2222-4222-8222-222222222222";
    const OWNER_PW: &str = "owner-password-1234";

    struct TempDir(std::path::PathBuf);
    impl std::ops::Deref for TempDir {
        type Target = std::path::Path;
        fn deref(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tmp_dir() -> TempDir {
        let d = std::env::temp_dir()
            .join(format!("com.lataif.m6b2dtest-{}", uuid::Uuid::new_v4().as_simple()));
        std::fs::create_dir_all(&d).unwrap();
        TempDir(d)
    }

    struct Env {
        conn: Connection,
        dir: TempDir,
        owner: OwnerAuth,
        root: TrustRootRecord,
        authority_id: String,
        authority_epoch: i64,
        authority_cert_json: String,
    }

    fn env() -> Env {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
                plan TEXT, active INTEGER, max_branches INTEGER, max_users INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                name TEXT NOT NULL, country TEXT, currency TEXT, address TEXT, active INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
                email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, active INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, email));
             CREATE TABLE user_branches (user_id TEXT NOT NULL REFERENCES users(id),
                branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL,
                is_default INTEGER, created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
             CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
                action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
             INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('tenant-1','T','t','n','n');
             INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','B','n','n');",
        )
        .unwrap();
        lataif_server::migrations::run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS)
            .unwrap();

        let hash = bcrypt::hash("placeholder", 4).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-owner','tenant-1','owner@x.com',?1,'O',1,'n','n')",
            params![hash],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO user_branches VALUES ('user-owner','branch-main','owner',1,'n');")
            .unwrap();
        crate::sync::credentials::provision_owner(
            &conn,
            OWNER_PW,
            OWNER_PW,
            crate::sync::credentials::PROVISION_CONFIRMATION,
        )
        .unwrap();
        let owner =
            primary::authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", OWNER_PW)
                .unwrap();

        let dir = tmp_dir();
        trust_root::initialize_root(&conn, &dir, "tenant-1", INSTALL_A, State::Primary, &owner)
            .unwrap();
        let root = trust_root::load_active_root(&conn, "tenant-1").unwrap().unwrap();
        let key = trust_root::load_key(&dir, &root).unwrap();
        let cert = crate::sync::authority::initialize_authority(
            &crate::sync::authority::IssueContext {
                conn: &conn,
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                install_id: INSTALL_A,
                primary_state: State::Primary,
                root: &root,
                key: &key,
                owner: &owner,
            },
        )
        .unwrap();
        let (aid, ep) = (cert.payload.authority_id.clone(), cert.payload.authority_epoch);
        let acert_json = cert.to_json().unwrap();
        drop(key);
        Env {
            conn,
            dir,
            owner,
            root,
            authority_id: aid,
            authority_epoch: ep,
            authority_cert_json: acert_json,
        }
    }

    impl Env {
        fn readiness(&self) -> ReadinessReport {
            evaluate_readiness(&self.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary)
                .unwrap()
        }
        /// Enroll a real device and return its id.
        fn enroll_device(&self, device_dir: &std::path::Path) -> String {
            let key = dev::create_identity(device_dir).unwrap();
            let req = dev::create_enrollment_request(
                &key, INSTALL_B, "tenant-1", "branch-main", "client", &["sync".to_string()], 1, 3,
            )
            .unwrap();
            let caps = vec!["sync".to_string()];
            let grant = EnrollmentGrant {
                tenant_id: "tenant-1",
                branch_id: "branch-main",
                device_role: "client",
                capabilities: &caps,
                protocol_min: 1,
                protocol_max: 3,
                device_label: Some("Counter"),
            };
            dev::approve_enrollment(
                &self.conn,
                &req,
                &grant,
                &self.root,
                &trust_root::load_key(&self.dir, &self.root).unwrap(),
                &self.authority_id,
                self.authority_epoch,
                &self.authority_cert_json,
                &self.owner,
            )
            .unwrap();
            req.device_id
        }
    }

    // ── I1: no attestation → not ready ───────────────────────────────────────
    #[test]
    fn i1_without_an_attestation_nothing_is_ready() {
        let e = env();
        let r = e.readiness();
        assert!(!r.is_ready(), "I1");
        assert!(!r.has_attestation);
        assert!(r.blocking_reasons.iter().any(|b| b.contains("attestation")));
        assert_eq!(r.state, CutoverState::LegacyOpen, "the truthful default");
        assert_eq!(
            mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
                .unwrap_err(),
            ERR_NOT_READY
        );
        // An empty inventory is not a complete one.
        assert_eq!(
            attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
                .unwrap_err(),
            ERR_INVENTORY_EMPTY
        );
    }

    // ── I2: an unresolved item blocks everything ─────────────────────────────
    #[test]
    fn i2_unresolved_items_block_readiness() {
        let e = env();
        add_item(&e.conn, "tenant-1", "branch-main", "Counter PC", None, None, &e.owner).unwrap();
        let unknown =
            add_item(&e.conn, "tenant-1", "branch-main", "Back office", None, None, &e.owner)
                .unwrap();

        // `expected` is unresolved: nobody has said what became of it.
        assert_eq!(
            attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
                .unwrap_err(),
            ERR_UNRESOLVED_ITEMS,
            "I2"
        );
        // …and so is `unknown`, which is the honest answer and still blocks.
        resolve_item(&e.conn, &unknown, ItemStatus::Unknown, "I do not know", &e.owner).unwrap();
        assert_eq!(
            attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
                .unwrap_err(),
            ERR_UNRESOLVED_ITEMS,
            "an 'unknown' device is exactly the one that matters"
        );
        assert!(!e.readiness().all_items_resolved);
        assert!(!e.readiness().is_ready());
    }

    // ── I3: expected → enrolled needs an ACTIVE device certificate ───────────
    #[test]
    fn i3_enrolled_items_need_an_active_device_certificate() {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        let item =
            add_item(&e.conn, "tenant-1", "branch-main", "Counter PC", None, None, &e.owner).unwrap();

        link_to_device(&e.conn, &item, &device_id, &e.owner).unwrap();
        let items = list_items(&e.conn, "tenant-1", "branch-main").unwrap();
        assert_eq!(items[0].status, ItemStatus::Enrolled);
        assert_eq!(items[0].linked_device_id.as_deref(), Some(device_id.as_str()));

        // Attestable now.
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
            .unwrap();
        assert!(e.readiness().all_enrolled_items_have_active_certificates);

        // Revoke the device: the item is still "enrolled" on paper, but the certificate is
        // gone — and readiness must notice, because the certificate is the checkable thing.
        dev::revoke_device(&e.conn, &device_id, dev::RevokeReason::Revoked, Some("stolen"), &e.owner)
            .unwrap();
        let r = e.readiness();
        assert!(!r.all_enrolled_items_have_active_certificates, "I3");
        assert!(!r.is_ready());
        assert!(r.blocking_reasons.iter().any(|b| b.contains("certificate")));

        // Linking to a revoked device is refused outright.
        let item2 =
            add_item(&e.conn, "tenant-1", "branch-main", "Another", None, None, &e.owner).unwrap();
        assert_eq!(
            link_to_device(&e.conn, &item2, &device_id, &e.owner).unwrap_err(),
            ERR_DEVICE_NOT_ACTIVE
        );
    }

    // ── I4: writing a device off needs an owner reason ───────────────────────
    #[test]
    fn i4_lost_retired_excluded_require_a_reason() {
        let e = env();
        for status in [ItemStatus::Lost, ItemStatus::Retired, ItemStatus::Excluded] {
            let item =
                add_item(&e.conn, "tenant-1", "branch-main", "Old laptop", None, None, &e.owner)
                    .unwrap();
            assert!(status.needs_reason());
            assert_eq!(
                resolve_item(&e.conn, &item, status, "   ", &e.owner).unwrap_err(),
                ERR_REASON_REQUIRED,
                "{status:?}: an unaccounted machine must not become a tidy row"
            );
            resolve_item(&e.conn, &item, status, "sold in 2025", &e.owner).unwrap();
            let items = list_items(&e.conn, "tenant-1", "branch-main").unwrap();
            let got = items.iter().find(|i| i.inventory_item_id == item).unwrap();
            assert_eq!(got.status, status);
            assert!(got.status.is_resolved());
            assert_eq!(got.resolution_reason.as_deref(), Some("sold in 2025"));
        }
        // `enrolled` cannot be reached this way — it needs a named device.
        let item = add_item(&e.conn, "tenant-1", "branch-main", "X", None, None, &e.owner).unwrap();
        assert_eq!(
            resolve_item(&e.conn, &item, ItemStatus::Enrolled, "because", &e.owner).unwrap_err(),
            ERR_INVALID
        );
    }

    // ── I5/I6: full attestation → ready, but activation stays blocked ────────
    #[test]
    fn i5_i6_ready_but_activation_still_refused() {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        let a = add_item(&e.conn, "tenant-1", "branch-main", "Counter", None, None, &e.owner).unwrap();
        let b = add_item(&e.conn, "tenant-1", "branch-main", "Old tablet", None, None, &e.owner)
            .unwrap();
        link_to_device(&e.conn, &a, &device_id, &e.owner).unwrap();
        resolve_item(&e.conn, &b, ItemStatus::Retired, "scrapped 2025", &e.owner).unwrap();

        // The phrase must be exact.
        for bad in ["", "yes", "I confirm", "i_confirm_this_is_the_complete_legacy_device_inventory"] {
            assert_eq!(
                attest_inventory(&e.conn, "tenant-1", "branch-main", bad, &e.owner).unwrap_err(),
                ERR_NOT_CONFIRMED
            );
        }
        let att =
            attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
                .unwrap();
        assert_eq!(att.item_count, 2);
        assert_eq!(att.resolved_count, 2);
        assert_eq!(att.unresolved_count, 0);
        assert_eq!(att.statement_version, STATEMENT_VERSION);

        // I5 — every precondition holds.
        let r = mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap();
        assert!(r.is_ready(), "I5: {:?}", r.blocking_reasons);
        assert_eq!(r.state, CutoverState::ReadyForProtocolActivation);
        assert!(r.has_attestation && r.all_items_resolved && r.has_active_authority);
        assert!(r.has_active_root_custody && r.owner_provisioned && r.static_primary_binding_valid);

        // I6 — and activation is STILL refused, because the v4 write path does not exist.
        assert!(!r.protocol_v4_write_path_ready, "I6: B3/B4 owns this flag, not us");
        assert_eq!(
            attempt_activation(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary)
                .unwrap_err(),
            ERR_V4_NOT_READY,
            "I6: ready is not activated"
        );
        // The forbidden states are not even expressible.
        assert_eq!(CutoverState::parse("v4_only"), None);
        assert_eq!(CutoverState::parse("legacy_blackout_active"), None);
        assert!(e
            .conn
            .execute(
                "UPDATE sync_cutover_state SET state = 'v4_only' WHERE tenant_id = 'tenant-1'",
                [],
            )
            .is_err(),
            "the schema refuses a blackout state in this slice");
    }

    // ── M6-B3A §11: an OPEN sync quarantine blocks cutover readiness ──────────
    #[test]
    fn b3a_open_quarantine_blocks_readiness() {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        let a = add_item(&e.conn, "tenant-1", "branch-main", "Counter", None, None, &e.owner).unwrap();
        let b = add_item(&e.conn, "tenant-1", "branch-main", "Old tablet", None, None, &e.owner).unwrap();
        link_to_device(&e.conn, &a, &device_id, &e.owner).unwrap();
        resolve_item(&e.conn, &b, ItemStatus::Retired, "scrapped 2025", &e.owner).unwrap();
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner).unwrap();

        // Precondition — ready with NO quarantine.
        let r0 = evaluate_readiness(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary).unwrap();
        assert!(r0.is_ready(), "precondition: ready without quarantine: {:?}", r0.blocking_reasons);

        // An OPEN quarantine entry for this tenant blocks readiness, naming SYNC_QUARANTINE_UNRESOLVED.
        e.conn
            .execute(
                "INSERT INTO sync_change_quarantine (quarantine_id, change_id, source, tenant_id, branch_id, \
                 table_name_redacted, record_id_hash, payload_hash, reason_code, first_seen_at, last_seen_at, \
                 occurrence_count, state) VALUES ('q:1', 1, 'pull_scan', 'tenant-1', 'branch-main', \
                 'products<len=8>', 'aaaaaaaa', 'bbbbbbbb', 'SYNC_FIELD_NOT_ALLOWED', 't', 't', 1, 'open')",
                [],
            )
            .unwrap();
        let r1 = evaluate_readiness(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary).unwrap();
        assert!(!r1.is_ready(), "an open quarantine must block readiness");
        assert!(
            r1.blocking_reasons.iter().any(|b| b.contains(ERR_QUARANTINE_UNRESOLVED)),
            "the block names SYNC_QUARANTINE_UNRESOLVED: {:?}",
            r1.blocking_reasons
        );

        // Resolving it restores readiness (no automatic deletion — a human transition).
        e.conn
            .execute(
                "UPDATE sync_change_quarantine SET state = 'resolved', resolved_at = 't' WHERE quarantine_id = 'q:1'",
                [],
            )
            .unwrap();
        let r2 = evaluate_readiness(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary).unwrap();
        assert!(r2.is_ready(), "resolving the quarantine restores readiness: {:?}", r2.blocking_reasons);
    }

    // ── I7/I8: legacy activity after the attestation blocks and needs a new one ──
    #[test]
    fn i7_i8_legacy_activity_blocks_and_requires_reattestation() {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        let a = add_item(&e.conn, "tenant-1", "branch-main", "Counter", None, None, &e.owner).unwrap();
        link_to_device(&e.conn, &a, &device_id, &e.owner).unwrap();
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
            .unwrap();
        assert!(mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap()
            .is_ready());

        // …and then something that is not enrolled writes.
        record_legacy_activity(&e.conn, "tenant-1", "branch-main", "2026-07-17T12:00:00Z").unwrap();

        let r = e.readiness();
        assert!(r.legacy_activity_after_attestation, "I7");
        assert!(!r.is_ready());
        assert_eq!(r.state, CutoverState::ActivationBlocked);
        assert!(r.blocking_reasons.iter().any(|b| b.contains("legacy activity")));
        let cur = load_state(&e.conn, "tenant-1", "branch-main").unwrap();
        assert!(cur.blocked_reason.is_some());
        // §13 — and we do NOT claim which device did it. There is no column for it.
        assert!(
            !cur.blocked_reason.as_deref().unwrap().contains(&device_id),
            "legacy clients have no identity; naming a culprit would be a fabrication"
        );

        // I8 — only a fresh owner attestation clears it.
        assert_eq!(
            mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
                .unwrap_err(),
            ERR_NOT_READY
        );
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
            .unwrap();
        let r2 = mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap();
        assert!(r2.is_ready(), "I8: the owner looked again and re-declared");
        assert!(!r2.legacy_activity_after_attestation);
    }

    // ── I9: nothing maps devices automatically ───────────────────────────────
    #[test]
    fn i9_no_automatic_device_mapping() {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        let item = add_item(&e.conn, "tenant-1", "branch-main", "Counter", None, None, &e.owner)
            .unwrap();

        // A device is enrolled and an item exists. NOTHING links them until a human does.
        let items = list_items(&e.conn, "tenant-1", "branch-main").unwrap();
        assert_eq!(items[0].status, ItemStatus::Expected, "I9: no auto-mapping");
        assert_eq!(items[0].linked_device_id, None);
        assert!(!e.readiness().is_ready());

        // The module carries no hostname/IP/mDNS/last-seen matcher. The absence of a feature
        // cannot be tested by behaviour, so this scans the source — but only the EXECUTABLE
        // lines. Comments are excluded on purpose: the doc comment on `link_to_device` says
        // "there is deliberately no auto_link_by_hostname", and a scan that could not tell a
        // prohibition from an implementation would force us to delete the explanation to
        // keep the test green. That trade is backwards.
        let src = include_str!("cutover.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let code: String = prod
            .lines()
            .map(|l| l.trim_start())
            .filter(|l| !l.starts_with("//") && !l.starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        for forbidden in ["hostname", "ip_address", "last_sync", "mdns", "auto_link"] {
            assert!(!code.contains(forbidden), "{forbidden}: an inventory link must never be inferred");
        }
        // …and the guard is real: the words ARE present in the prose, so the filter is doing
        // work rather than trivially passing.
        assert!(prod.to_lowercase().contains("hostname"), "the prohibition is documented");

        // Only the explicit call links.
        link_to_device(&e.conn, &item, &device_id, &e.owner).unwrap();
        let items = list_items(&e.conn, "tenant-1", "branch-main").unwrap();
        assert_eq!(items[0].linked_device_id.as_deref(), Some(device_id.as_str()));
        assert!(items[0].resolution_reason.is_some(), "and it records that a human did it");

        // One device answers for at most one item — the DB says so.
        let item2 = add_item(&e.conn, "tenant-1", "branch-main", "Other", None, None, &e.owner)
            .unwrap();
        assert!(
            link_to_device(&e.conn, &item2, &device_id, &e.owner).is_err(),
            "two items pointing at one machine would make the resolved count a lie"
        );
    }

    // ── I10: nothing activates a primary role or a cutover by itself ─────────
    #[test]
    fn i10_no_automatic_primary_or_cutover_activation() {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        // Enrolling a device changes no role and no cutover state.
        assert_eq!(load_state(&e.conn, "tenant-1", "branch-main").unwrap().state, CutoverState::LegacyOpen);
        let dev_row = dev::load_device(&e.conn, &device_id).unwrap().unwrap();
        assert_eq!(dev_row.device_role, "client", "an enrollment grants a client role, nothing more");

        // Even a fully ready tenant does not activate itself.
        let a = add_item(&e.conn, "tenant-1", "branch-main", "Counter", None, None, &e.owner).unwrap();
        link_to_device(&e.conn, &a, &device_id, &e.owner).unwrap();
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
            .unwrap();
        let r = mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap();
        assert!(r.is_ready());
        assert_eq!(r.state, CutoverState::ReadyForProtocolActivation);
        assert!(!r.protocol_v4_write_path_ready, "I10: still false, and only B3/B4 may change it");
        assert_eq!(
            attempt_activation(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary)
                .unwrap_err(),
            ERR_V4_NOT_READY
        );
        // Nothing in this module writes the flag.
        let src = include_str!("cutover.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(
            !prod.contains("protocol_v4_write_path_ready = 1")
                && !prod.contains("SET protocol_v4_write_path_ready"),
            "no path here may flip the v4 switch"
        );
    }

    // ── editing the inventory invalidates the attestation ────────────────────
    #[test]
    fn editing_the_inventory_invalidates_the_attestation() {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        let a = add_item(&e.conn, "tenant-1", "branch-main", "Counter", None, None, &e.owner).unwrap();
        link_to_device(&e.conn, &a, &device_id, &e.owner).unwrap();
        let att =
            attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
                .unwrap();
        assert!(mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap()
            .is_ready());

        // The owner remembers another machine. The old attestation covered a different list,
        // so it must stop counting — silently keeping it would make the declaration cover
        // devices the owner never saw.
        add_item(&e.conn, "tenant-1", "branch-main", "Forgotten laptop", None, None, &e.owner)
            .unwrap();
        let cur = load_state(&e.conn, "tenant-1", "branch-main").unwrap();
        assert_eq!(cur.state, CutoverState::InventoryDraft);
        assert_eq!(cur.current_attestation_id, None);
        assert!(cur.inventory_revision > att.inventory_revision);
        assert!(!e.readiness().is_ready());

        // The old attestation is superseded, not deleted — it stays a record of what someone
        // declared and when.
        let superseded: Option<String> = e
            .conn
            .query_row(
                "SELECT superseded_at FROM legacy_inventory_attestations WHERE attestation_id = ?1",
                params![att.attestation_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(superseded.is_some());
    }

// ═══════════════════════════════════════════════════════════════════════
    // M6-B2DE1 §14 — legacy activity after attestation invalidates readiness.
    //
    // These test the INTEGRATION: a real `apply_legacy_push_batch` (the push path) and the
    // pull path's `record_legacy_activity`, driven against an attested, ready tenant, and the
    // readiness that must fall as a result. The unit behaviour of `record_legacy_activity`
    // itself is I7/I8; these prove the sync paths actually invoke it.
    // ═══════════════════════════════════════════════════════════════════════

    /// Drive a tenant all the way to `ready_for_protocol_activation`.
    ///
    /// The device `TempDir` is returned, not dropped or forgotten: it holds a real device key,
    /// and §16 forbids leaking it. The caller binds it (even as `_d`) so RAII cleans it up when
    /// the test ends, panic included.
    fn attested_and_ready() -> (Env, String, TempDir) {
        let e = env();
        let d = tmp_dir();
        let device_id = e.enroll_device(&d);
        let item =
            add_item(&e.conn, "tenant-1", "branch-main", "Counter", None, None, &e.owner).unwrap();
        link_to_device(&e.conn, &item, &device_id, &e.owner).unwrap();
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
            .unwrap();
        let r = mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap();
        assert!(r.is_ready(), "precondition: {:?}", r.blocking_reasons);
        (e, device_id, d)
    }

    fn business_change(id: &str) -> crate::sync::models::SyncPushChange {
        crate::sync::models::SyncPushChange {
            table_name: "products".into(),
            record_id: id.into(),
            action: "update".into(),
            data: format!("{{\"id\":\"{id}\"}}"),
        }
    }

    // ── L1: attestation + no new activity → readiness stands ─────────────────
    #[test]
    fn l1_readiness_stands_without_new_activity() {
        let (e, _dev, _d) = attested_and_ready();
        // No legacy sync happened after the attestation.
        let cur = load_state(&e.conn, "tenant-1", "branch-main").unwrap();
        assert!(!cur.legacy_activity_after_attestation);
        assert_eq!(cur.state, CutoverState::ReadyForProtocolActivation, "L1");
        assert!(e.readiness().is_ready());
    }

    // ── L2/L5/L6: a successful legacy PUSH after attestation blocks readiness ─
    #[test]
    fn l2_legacy_push_after_attestation_blocks_readiness() {
        let (mut e, _dev, _d) = attested_and_ready();

        // A legacy client pushes a normal business change — allowed (L9), it succeeds…
        let n = crate::sync::routes::apply_legacy_push_batch(
            &mut e.conn, "tenant-1", "branch-main", "some-user", "2026-07-17T10:00:00Z",
            &[business_change("p1")],
        )
        .unwrap();
        assert_eq!(n, 1, "L9: the legacy push itself is still allowed");

        // …but readiness is now invalidated, in the SAME transaction as the push (§11).
        let cur = load_state(&e.conn, "tenant-1", "branch-main").unwrap();
        assert!(cur.legacy_activity_after_attestation, "L2");
        assert_eq!(cur.state, CutoverState::ActivationBlocked);
        // L5 — read the timestamp straight from the row (CutoverRecord doesn't surface it).
        let last: Option<String> = e
            .conn
            .query_row(
                "SELECT last_legacy_activity_at FROM sync_cutover_state WHERE tenant_id='tenant-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(last.as_deref(), Some("2026-07-17T10:00:00Z"), "L5");
        let r = e.readiness();
        assert!(!r.is_ready());
        // L6 — the attestation is marked overtaken. It stays referenced as history (the row
        // is not deleted), but the `legacy_activity_after_attestation` flag is what says "this
        // completeness claim no longer holds" — readiness reports exactly that reason, and a
        // new attestation is required to clear it.
        assert!(cur.legacy_activity_after_attestation, "L6: the attestation is marked overtaken");
        assert!(
            r.blocking_reasons.iter().any(|b| b.contains("legacy activity")),
            "L6: readiness names the stale attestation as the reason"
        );
        // The business row DID land — this is observation, not a gate (L9).
        let rows: i64 = e
            .conn
            .query_row("SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    // ── L3: a successful legacy PULL after attestation blocks readiness ──────
    #[test]
    fn l3_legacy_pull_after_attestation_blocks_readiness() {
        let (e, _dev, _d) = attested_and_ready();
        // The pull path calls record_legacy_activity after a successful authenticated pull.
        record_legacy_activity(&e.conn, "tenant-1", "branch-main", "2026-07-17T11:00:00Z").unwrap();
        let cur = load_state(&e.conn, "tenant-1", "branch-main").unwrap();
        assert!(cur.legacy_activity_after_attestation, "L3");
        assert_eq!(cur.state, CutoverState::ActivationBlocked);
        assert!(!e.readiness().is_ready());
    }

    // ── L4: no automatic device mapping happens from the activity ────────────
    #[test]
    fn l4_activity_does_not_map_to_any_device() {
        let (mut e, _dev, _d) = attested_and_ready();
        crate::sync::routes::apply_legacy_push_batch(
            &mut e.conn, "tenant-1", "branch-main", "some-user", "2026-07-17T10:00:00Z",
            &[business_change("p1")],
        )
        .unwrap();
        let cur = load_state(&e.conn, "tenant-1", "branch-main").unwrap();
        // §13 — the block reason names no device. Legacy clients have no identity.
        let reason = cur.blocked_reason.unwrap();
        assert!(!reason.contains("device"), "L4: no device is named");
        for dev_id in [&_dev] {
            assert!(!reason.contains(dev_id.as_str()), "L4: the culprit is never claimed");
        }
    }

    // ── L7/L8: a fresh owner attestation restores readiness ──────────────────
    #[test]
    fn l7_l8_reattestation_restores_readiness() {
        let (mut e, _dev, _d) = attested_and_ready();
        crate::sync::routes::apply_legacy_push_batch(
            &mut e.conn, "tenant-1", "branch-main", "u", "2026-07-17T10:00:00Z",
            &[business_change("p1")],
        )
        .unwrap();
        assert!(!e.readiness().is_ready(), "blocked after activity");
        // L7 — mark_ready alone cannot clear it; the owner must look again and re-attest.
        assert_eq!(
            mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
                .unwrap_err(),
            ERR_NOT_READY
        );
        // L8 — a new full attestation resets the activity flag and readiness can be reached.
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
            .unwrap();
        let r = mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap();
        assert!(r.is_ready(), "L8: re-declared, ready again");
        assert!(!r.legacy_activity_after_attestation);
    }

    // ── L10/L11: readiness never flips the v4 flag or auto-activates ─────────
    #[test]
    fn l10_l11_readiness_never_activates_cutover() {
        let (e, _dev, _d) = attested_and_ready();
        let r = e.readiness();
        assert!(!r.protocol_v4_write_path_ready, "L10: still false");
        assert_eq!(
            attempt_activation(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary)
                .unwrap_err(),
            ERR_V4_NOT_READY,
            "L11: no automatic cutover activation"
        );
    }

    // ── L12: activity DURING attestation ends deterministically fail-closed ──
    #[test]
    fn l12_concurrent_activity_and_attestation_is_deterministic() {
        // The ordering that matters: an owner attests, and a legacy push lands right after.
        // Whatever the interleaving, the end state must be blocked — never a "ready" tenant
        // with a legacy client still writing. Because the push marks activity in its own
        // committed transaction and readiness reads that flag, the LAST writer wins
        // deterministically, and a push after an attestation always leaves it blocked.
        let (mut e, _dev, _d) = attested_and_ready();
        // Interleave: push, then a second attestation, then another push.
        crate::sync::routes::apply_legacy_push_batch(
            &mut e.conn, "tenant-1", "branch-main", "u", "2026-07-17T10:00:00Z",
            &[business_change("p1")],
        )
        .unwrap();
        attest_inventory(&e.conn, "tenant-1", "branch-main", ATTESTATION_CONFIRMATION, &e.owner)
            .unwrap();
        // Ready again momentarily…
        assert!(mark_ready(&e.conn, "tenant-1", "branch-main", INSTALL_A, State::Primary, &e.owner)
            .unwrap()
            .is_ready());
        // …then another legacy push. Deterministically blocked.
        crate::sync::routes::apply_legacy_push_batch(
            &mut e.conn, "tenant-1", "branch-main", "u", "2026-07-17T10:05:00Z",
            &[business_change("p2")],
        )
        .unwrap();
        let cur = load_state(&e.conn, "tenant-1", "branch-main").unwrap();
        assert_eq!(cur.state, CutoverState::ActivationBlocked, "L12: last activity wins, fail-closed");
        assert!(!e.readiness().is_ready());
    }

    // ── the statement says what it is ────────────────────────────────────────
    #[test]
    fn the_statement_admits_it_is_not_a_scan() {
        // §11 — the app must show this. The wording is the deliverable, so it is asserted.
        assert!(STATEMENT_TEXT.contains("administrative declaration"));
        assert!(STATEMENT_TEXT.contains("NOT a technically proven scan"));
        assert!(STATEMENT_TEXT.contains("no stable device identity"));
        assert!(!STATEMENT_TEXT.to_lowercase().contains("all devices found"));
        assert!(!STATEMENT_TEXT.to_lowercase().contains("verified"));
        assert_eq!(ATTESTATION_CONFIRMATION, "I_CONFIRM_THIS_IS_THE_COMPLETE_LEGACY_DEVICE_INVENTORY");
        // The stored copy is versioned, so a future rewording cannot retroactively change
        // what an old owner agreed to.
        assert_eq!(STATEMENT_VERSION, 1);
    }

    // ── states ───────────────────────────────────────────────────────────────
    #[test]
    fn states_round_trip_and_resolution_is_explicit() {
        for s in [
            CutoverState::LegacyOpen,
            CutoverState::InventoryDraft,
            CutoverState::InventoryAttested,
            CutoverState::EnrollmentInProgress,
            CutoverState::ReadyForProtocolActivation,
            CutoverState::ActivationBlocked,
        ] {
            assert_eq!(CutoverState::parse(s.as_str()), Some(s));
        }
        for s in [
            ItemStatus::Expected,
            ItemStatus::Enrolled,
            ItemStatus::Retired,
            ItemStatus::Lost,
            ItemStatus::Excluded,
            ItemStatus::Unknown,
        ] {
            assert_eq!(ItemStatus::parse(s.as_str()), Some(s));
            // expected/unknown are the two that are NOT resolved, and that is the point.
            assert_eq!(
                s.is_resolved(),
                !matches!(s, ItemStatus::Expected | ItemStatus::Unknown)
            );
        }
        assert_eq!(ItemStatus::parse("probably_fine"), None);
    }
}
