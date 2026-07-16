//! M6-B2A — Explicit static primary: role resolution and legacy migration.
//!
//! ## What this replaces
//!
//! Until now `auto-lan.ts` decided the role by race: "browse mDNS for 3 s; found nothing
//! → become the server". A discovery timeout is indistinguishable from a switched-off
//! host, a slow WLAN or blocked mDNS — so two devices booting while the host was off
//! became two servers, each convinced it was authoritative (M6-A4 §2, option D).
//!
//! ## The rule
//!
//! A device is primary **only** because someone said so, and that decision is recorded in
//! `primary_host_config` bound to this installation's `install_id`. Discovery finds
//! servers; it never elects one.
//!
//! ## What this slice deliberately does NOT do
//!
//! No trust root, no authority certificate, no epoch, no transfer, no forced takeover,
//! no CAS. Those are M6-B2B/C and later. This is only: who may run a writing server.

use rusqlite::{params, Connection, OptionalExtension};

/// The configured role. Persisted in `primary_host_config.mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Unconfigured,
    Primary,
    Client,
    /// M6-B2A2 — ein Legacy-Hinweis sagt "dieses Geraet war Server", aber niemand hat es
    /// bestaetigt. Kein Serverstart, kein Sync-Write, keine Instance-Bindung, bis der
    /// Owner adoptiert. Das ist der Zustand, den eine kopierte Vor-B2A-DB erreicht.
    LegacyPending,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Unconfigured => "unconfigured",
            Mode::Primary => "primary",
            Mode::Client => "client",
            Mode::LegacyPending => "legacy_pending",
        }
    }
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "unconfigured" => Some(Mode::Unconfigured),
            "primary" => Some(Mode::Primary),
            "client" => Some(Mode::Client),
            "legacy_pending" => Some(Mode::LegacyPending),
            _ => None,
        }
    }
}

/// The EFFECTIVE state: the configured mode after checking it against this installation.
/// `ReadOnly` is what a configured primary degrades to when its recorded
/// `server_instance_id` does not belong to the installation it is running on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Unconfigured,
    Primary,
    Client,
    ReadOnly,
    /// M6-B2A2 — Legacy-Hinweis vorhanden, Owner-Adoption ausstehend.
    LegacyAdoptionRequired,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Unconfigured => "unconfigured",
            State::Primary => "primary",
            State::Client => "client",
            State::ReadOnly => "read_only",
            State::LegacyAdoptionRequired => "legacy_adoption_required",
        }
    }
    /// The one question the write gate asks.
    pub fn may_write_sync(self) -> bool {
        matches!(self, State::Primary)
    }
    /// Whether an embedded server should be listening at all.
    /// `LegacyAdoptionRequired` deliberately does NOT serve: an unconfirmed legacy hint
    /// must not put a writing server on the network.
    pub fn should_serve(self) -> bool {
        matches!(self, State::Primary | State::ReadOnly)
    }
}

/// Stable error codes surfaced to callers.
pub const ERR_PRIMARY_NOT_CONFIGURED: &str = "SYNC_PRIMARY_NOT_CONFIGURED";
pub const ERR_INSTANCE_ID_MISMATCH: &str = "INSTANCE_ID_MISMATCH";
pub const ERR_SERVER_READ_ONLY: &str = "SYNC_SERVER_READ_ONLY";
pub const ERR_OWNER_REQUIRED: &str = "OWNER_AUTHORIZATION_REQUIRED";
pub const ERR_TRANSITION_NOT_ALLOWED: &str = "PRIMARY_TRANSITION_NOT_ALLOWED";
pub const ERR_ADOPTION_NOT_CONFIRMED: &str = "LEGACY_ADOPTION_NOT_CONFIRMED";
pub const ERR_NO_LEGACY_ADOPTION_PENDING: &str = "NO_LEGACY_ADOPTION_PENDING";

// ── Owner-Autorisierung ─────────────────────────────────────────────────────
//
// Warum Credentials und nicht die Frontend-Rolle:
//
// Tauri-Commands kommen aus dem Renderer. Es gibt Rust-seitig KEINE Session — der
// Desktop-Login laeuft gegen `lataif.db` (sql.js) und hinterlaesst nur einen
// localStorage-Eintrag, den derselbe Renderer schreibt. Eine uebergebene Rolle oder ein
// uebergebenes `configured_by` waere also eine Selbstauskunft des Aufrufers.
//
// Ein JWT reicht ebenfalls nicht: der Self-Token traegt `role="owner"` und wird dem
// Renderer per `sync_server_status` ausgehaendigt — wer ihn hat, waere „Owner".
//
// Die einzige Grenze, die der Renderer nicht selbst passieren kann, ist Wissen: das
// Owner-Passwort, geprueft gegen den bcrypt-Hash in der SERVER-DB. `configured_by`
// stammt danach aus dem verifizierten DB-Lookup, nie aus dem Aufruf.

/// Eine verifizierte Owner-Identitaet. Nur `authorize_owner` kann sie erzeugen —
/// deshalb kann keine Aufrufstelle sie sich selbst ausstellen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerAuth {
    user_id: String,
}

impl OwnerAuth {
    /// Die verifizierte Identitaet fuer `configured_by`.
    pub fn user_id(&self) -> &str {
        &self.user_id
    }
}

/// Prueft Owner-Credentials gegen die Server-DB. Fehlerfaelle sind bewusst
/// ununterscheidbar (kein User-Enumeration-Orakel).
pub fn authorize_owner(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    email: &str,
    password: &str,
) -> Result<OwnerAuth, &'static str> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT u.id, u.password_hash, ub.role
               FROM users u
               JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?3
              WHERE u.email = ?1 AND u.tenant_id = ?2 AND u.active = 1",
            params![email, tenant_id, branch_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| ERR_OWNER_REQUIRED)?;

    let (user_id, hash, role) = row.ok_or(ERR_OWNER_REQUIRED)?;
    if !bcrypt::verify(password, &hash).unwrap_or(false) {
        return Err(ERR_OWNER_REQUIRED);
    }
    if role != "owner" {
        return Err(ERR_OWNER_REQUIRED);
    }
    Ok(OwnerAuth { user_id })
}

/// Welche Rollenwechsel sind ueberhaupt zulaessig?
///
/// `read_only -> primary` ist in B2A1 NICHT erlaubt: dieser Zustand bedeutet, dass die
/// Server-DB an eine andere Installation gebunden ist (Kopie/Restore). Sie hier
/// umzubinden waere genau das Promoten-durch-Kopieren, das der Slice verhindert — das
/// gehoert in den Authority-Transfer (M6-B2C).
pub fn transition_allowed(from: State, to: Mode) -> bool {
    match (from, to) {
        (State::Unconfigured, Mode::Primary) => true,
        (State::Unconfigured, Mode::Client) => true,
        (State::Client, Mode::Primary) => true,
        (State::Primary, Mode::Client) => true,
        (State::Primary, Mode::Unconfigured) => true,
        // Eine an eine fremde Installation gebundene DB darf sich nicht selbst umbinden.
        (State::ReadOnly, _) => false,
        // Ein ausstehender Legacy-Hinweis fuehrt NUR ueber `adopt_legacy_as_owner` zu
        // primary — nie ueber den generischen Rollenwechsel. Client/unconfigured darf der
        // Owner aber jederzeit waehlen (= den Hinweis verwerfen).
        (State::LegacyAdoptionRequired, Mode::Primary) => false,
        (State::LegacyAdoptionRequired, Mode::Client) => true,
        (State::LegacyAdoptionRequired, Mode::Unconfigured) => true,
        // `legacy_pending` ist kein Ziel eines Owner-Wechsels — es entsteht nur aus der
        // einmaligen Migration.
        (_, Mode::LegacyPending) => false,
        // Idempotente No-ops bleiben erlaubt.
        (State::Primary, Mode::Primary) => true,
        (State::Client, Mode::Client) => true,
        (State::Unconfigured, Mode::Unconfigured) => true,
        (State::Client, Mode::Unconfigured) => true,
    }
}

/// What the DB says, before it is checked against this installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredConfig {
    pub mode: Mode,
    pub server_instance_id: Option<String>,
    pub primary_host_id: Option<String>,
}

/// Pure core: config + this installation's id → effective state.
///
/// The mismatch branch is the point of the whole slice. A server DB that was copied or
/// restored onto another machine still says `mode='primary'` — its contents are intact
/// and self-consistent. Only the id file, which lives OUTSIDE the DB and did not travel
/// with it, reveals that this is not the installation the DB was bound to. We degrade to
/// read-only and never rewrite the binding: silently re-binding would make every copy
/// promote itself, which is exactly the split-brain we are removing.
pub fn resolve_state(config: Option<&StoredConfig>, install_id: &str) -> State {
    match config {
        None => State::Unconfigured,
        Some(c) => match c.mode {
            Mode::Unconfigured => State::Unconfigured,
            Mode::Client => State::Client,
            Mode::LegacyPending => State::LegacyAdoptionRequired,
            Mode::Primary => match c.server_instance_id.as_deref() {
                Some(bound) if bound == install_id => State::Primary,
                // Bound to a different installation, or not bound at all.
                _ => State::ReadOnly,
            },
        },
    }
}

/// The legacy `lataif_lan_mode` / `lataif_lan_setup_done` values, as read from the
/// client's localStorage and handed to Rust once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyLanConfig {
    pub mode: Option<String>,
    pub setup_done: bool,
}

/// Pure core: legacy localStorage → the mode to adopt once.
///
/// Only two legacy values carry an unambiguous decision:
///   `server` + setup_done → this device CLAIMS to be the host → `legacy_pending`,
///                           i.e. a question for the owner, never a role (see below)
///   `client`              → this device already syncs to someone else → `client`
///
/// Everything else becomes `unconfigured`, on purpose:
///   `off`     — the owner stopped the server in Settings. That says what it is NOT, not
///               what it is.
///   `manual`  — declared in the type, never written anywhere. Dead value.
///   missing   — nothing to migrate.
///   `server` without setup_done — `auto-lan` sets `setup_done` on the same first boot
///               that picks the mode, so this combination should not exist; treating it
///               as primary would be inferring a host from an incomplete record.
///
/// Note what is NOT inferred: `setup_done = 1` alone never yields a primary. The old
/// auto-claim wrote `mode='server'` on a discovery timeout, and that write is
/// indistinguishable from the explicit Settings toggle — so the legacy value cannot tell
/// a real host from a device that merely lost a race, which is the second reason this
/// migration decides nothing on its own.
///
/// M6-B2A2: `server + setup_done` ergibt **`LegacyPending`**, nicht `Primary`.
///
/// Warum die Verschaerfung: localStorage **und** `has_served_before()` sind kopierbar.
/// Eine Vor-v0002-Server-DB traegt echte Changelog-Historie und hat keine
/// `primary_host_config`-Zeile — kopiert man sie auf einen anderen Rechner, greift die
/// Instance-Bindung nicht (es gibt nichts zu vergleichen) und die Historie „belegt" den
/// Serverstatus. Beides sind Spuren, keine Autorisierungen. Deshalb entsteht aus einem
/// Legacy-Hinweis nie mehr eine Rolle, sondern nur eine Frage an den Owner.
pub fn migrate_legacy_mode(legacy: &LegacyLanConfig) -> Mode {
    match legacy.mode.as_deref() {
        Some("server") if legacy.setup_done => Mode::LegacyPending,
        Some("client") => Mode::Client,
        _ => Mode::Unconfigured,
    }
}

/// Read the stored config for a tenant/branch.
pub fn load_config(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
) -> rusqlite::Result<Option<StoredConfig>> {
    conn.query_row(
        "SELECT mode, server_instance_id, primary_host_id FROM primary_host_config
         WHERE tenant_id = ?1 AND branch_id = ?2",
        params![tenant_id, branch_id],
        |r| {
            let mode: String = r.get(0)?;
            Ok(StoredConfig {
                mode: Mode::parse(&mode).unwrap_or(Mode::Unconfigured),
                server_instance_id: r.get(1)?,
                primary_host_id: r.get(2)?,
            })
        },
    )
    .optional()
}

/// Write the role explicitly. `Primary` always binds to `install_id` — that binding is
/// what a copied DB cannot forge, because the id file stays behind.
///
/// Private: the only ways in are `configure_as_owner` (verified credentials) and
/// `migrate_once` (first run only). That is what keeps `configured_by` honest.
fn set_mode(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    mode: Mode,
    install_id: &str,
    configured_by: &str,
    hint: Option<&LegacyHint>,
) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    // NUR ein echter Primary wird gebunden. `legacy_pending` bleibt bewusst ungebunden —
    // das ist der Unterschied zwischen „behauptet" und „adoptiert".
    let (instance, host) = match mode {
        Mode::Primary => (Some(install_id), Some(install_id)),
        _ => (None, None),
    };
    let adopted = if mode == Mode::Primary { Some(now.as_str()) } else { None };
    let adopted_by = if mode == Mode::Primary { Some(configured_by) } else { None };
    conn.execute(
        "INSERT INTO primary_host_config
           (tenant_id, branch_id, primary_host_id, server_instance_id, mode, configured_at,
            configured_by, state, legacy_mode, legacy_setup_done, legacy_has_served,
            adopted_at, adopted_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (tenant_id, branch_id) DO UPDATE SET
           primary_host_id = excluded.primary_host_id,
           server_instance_id = excluded.server_instance_id,
           mode = excluded.mode,
           configured_at = excluded.configured_at,
           configured_by = excluded.configured_by,
           state = excluded.state,
           -- Der Legacy-Hinweis bleibt als Spur erhalten, wenn kein neuer mitkommt.
           legacy_mode = COALESCE(excluded.legacy_mode, primary_host_config.legacy_mode),
           legacy_setup_done = COALESCE(excluded.legacy_setup_done, primary_host_config.legacy_setup_done),
           legacy_has_served = COALESCE(excluded.legacy_has_served, primary_host_config.legacy_has_served),
           adopted_at = excluded.adopted_at,
           adopted_by = excluded.adopted_by",
        params![
            tenant_id,
            branch_id,
            host,
            instance,
            mode.as_str(),
            now,
            configured_by,
            hint.and_then(|h| h.mode.clone()),
            hint.map(|h| h.setup_done as i64),
            hint.map(|h| h.has_served as i64),
            adopted,
            adopted_by,
        ],
    )?;
    Ok(())
}

/// Die kopierbaren Spuren, die zu einer Migrationsentscheidung fuehrten — als Audit
/// gespeichert, nie als Autorisierung verwendet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyHint {
    pub mode: Option<String>,
    pub setup_done: bool,
    pub has_served: bool,
}

/// Der EINZIGE Weg, eine Rolle bewusst zu setzen. Verlangt verifizierte
/// Owner-Credentials und einen zulaessigen Uebergang; `configured_by` kommt aus der
/// verifizierten Identitaet, nie vom Aufrufer.
pub fn configure_as_owner(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    to: Mode,
    install_id: &str,
    owner: &OwnerAuth,
) -> Result<Mode, &'static str> {
    let current = resolve_state(
        load_config(conn, tenant_id, branch_id).map_err(|_| ERR_PRIMARY_NOT_CONFIGURED)?.as_ref(),
        install_id,
    );
    if !transition_allowed(current, to) {
        return Err(if current == State::ReadOnly {
            ERR_INSTANCE_ID_MISMATCH
        } else {
            ERR_TRANSITION_NOT_ALLOWED
        });
    }
    set_mode(conn, tenant_id, branch_id, to, install_id, owner.user_id(), None)
        .map_err(|_| ERR_TRANSITION_NOT_ALLOWED)?;
    Ok(to)
}

/// Die Bestaetigung, die der Owner woertlich mitschicken muss. Sie ersetzt keine
/// technische Garantie — sie verhindert eine beilaeufige oder versehentliche Promotion.
pub const ADOPTION_CONFIRMATION: &str = "ADOPT_THIS_DEVICE_AS_LEGACY_PRIMARY";

/// M6-B2A2 — der EINZIGE Weg von einem Legacy-Hinweis zu `primary`.
///
/// Verlangt: verifizierte Owner-Credentials **und** die woertliche Bestaetigung **und**
/// den Zustand `LegacyAdoptionRequired`. Erst hier entsteht die Bindung an die aktuelle
/// Install-ID — eine kopierte DB wird also nur adoptiert, wenn der Owner es ausdruecklich
/// fuer DIESES Geraet erklaert.
pub fn adopt_legacy_as_owner(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    install_id: &str,
    owner: &OwnerAuth,
    confirmation: &str,
) -> Result<Mode, &'static str> {
    if confirmation != ADOPTION_CONFIRMATION {
        return Err(ERR_ADOPTION_NOT_CONFIRMED);
    }
    let cfg = load_config(conn, tenant_id, branch_id).map_err(|_| ERR_TRANSITION_NOT_ALLOWED)?;
    match resolve_state(cfg.as_ref(), install_id) {
        State::LegacyAdoptionRequired => {}
        // L13: eine an eine fremde Installation gebundene DB darf sich auch ueber die
        // Legacy-Adoption nicht umbinden — dafuer gibt es den Authority-Transfer (B2C).
        State::ReadOnly => return Err(ERR_INSTANCE_ID_MISMATCH),
        // L8: bereits adoptiert -> idempotenter No-op statt Fehler.
        State::Primary => return Ok(Mode::Primary),
        _ => return Err(ERR_NO_LEGACY_ADOPTION_PENDING),
    }
    set_mode(conn, tenant_id, branch_id, Mode::Primary, install_id, owner.user_id(), None)
        .map_err(|_| ERR_TRANSITION_NOT_ALLOWED)?;
    Ok(Mode::Primary)
}

/// Hat diese Server-DB schon einmal Pushes angenommen? **NUR AUDIT — entscheidet nichts.**
///
/// B2A1 benutzte das noch als Haertung: ein Renderer kann `lataif_lan_mode='server'`
/// behaupten, aber keine Changelog-Historie erfinden (er hat keinen Schreibpfad in diese
/// DB). Das stimmt — und ging am Angriff vorbei: **niemand muss die Historie faelschen,
/// man kopiert sie.** Eine Vor-v0002-Server-DB traegt echte Historie und hat keine
/// `primary_host_config`-Zeile, also greift auch die Install-ID-Bindung nicht (es gibt
/// nichts zu vergleichen). Genau dieser Fall ist `l12_copied_pre_b2a_server_db_…`.
///
/// Deshalb ist der Rueckgabewert nur noch eine Spur fuer `legacy_has_served`: er sagt
/// „hier lief mal ein Server", nicht „hier lief DIESER Server".
pub fn has_served_before(conn: &Connection) -> bool {
    conn.query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// Einmalige Uebernahme der Legacy-localStorage-Rolle.
///
/// Diese Funktion vergibt **keine** Serverrolle. Ein Legacy-Serverhinweis wird zu
/// `legacy_pending` — einer Frage an den Owner —, egal ob die Server-DB Historie traegt.
/// Beide Quellen (localStorage UND Historie) sind kopierbar; nur `adopt_legacy_as_owner`
/// macht daraus `primary`, und erst dort entsteht die Bindung an diese Installation.
///
/// Idempotent: existiert die Zeile, werden die Legacy-Werte nie wieder gelesen.
/// `configured_by` ist fest `legacy-migration` — der Aufrufer liefert keine Actor-ID.
pub fn migrate_once(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    legacy: &LegacyLanConfig,
    install_id: &str,
) -> rusqlite::Result<Mode> {
    if let Some(existing) = load_config(conn, tenant_id, branch_id)? {
        return Ok(existing.mode);
    }
    // `has_served_before` ist jetzt reines AUDIT: es entscheidet nichts mehr. Historie ist
    // kopierbar (L12) und war damit nie eine Autorisierung.
    let hint = LegacyHint {
        mode: legacy.mode.clone(),
        setup_done: legacy.setup_done,
        has_served: has_served_before(conn),
    };
    let mode = migrate_legacy_mode(legacy);
    set_mode(conn, tenant_id, branch_id, mode, install_id, "legacy-migration", Some(&hint))?;
    Ok(mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lataif_server::migrations::run_migrations;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
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
        run_migrations(&conn, super::super::migrations::EMBEDDED_MIGRATIONS).unwrap();
        conn
    }

    const ID_A: &str = "11111111-1111-4111-8111-111111111111";
    const ID_B: &str = "22222222-2222-4222-8222-222222222222";

    /// Seedet Benutzer mit ECHTEN bcrypt-Hashes (cost 4 = schnell im Test).
    fn seed_users(conn: &Connection) {
        let owner = bcrypt::hash("owner-pw", 4).unwrap();
        let staff = bcrypt::hash("staff-pw", 4).unwrap();
        let inactive = bcrypt::hash("x", 4).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-owner','tenant-1','owner@x.com',?1,'O',1,'n','n')",
            params![owner],
        ).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-staff','tenant-1','staff@x.com',?1,'S',1,'n','n')",
            params![staff],
        ).unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('user-old','tenant-1','old@x.com',?1,'X',0,'n','n')",
            params![inactive],
        ).unwrap();
        conn.execute_batch(
            "INSERT INTO user_branches VALUES ('user-owner','branch-main','owner',1,'n');
             INSERT INTO user_branches VALUES ('user-staff','branch-main','staff',0,'n');
             INSERT INTO user_branches VALUES ('user-old','branch-main','owner',0,'n');",
        ).unwrap();
    }

    fn served(conn: &Connection) {
        conn.execute(
            "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
             VALUES ('tenant-1','branch-main','products','p1','update','{}','self-desktop','n')",
            [],
        ).unwrap();
    }

    // ── O1: Owner darf konfigurieren ────────────────────────────────────────
    #[test]
    fn o1_owner_may_configure_primary() {
        let conn = db();
        seed_users(&conn);
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        assert_eq!(owner.user_id(), "user-owner");
        let m = configure_as_owner(&conn, "tenant-1", "branch-main", Mode::Primary, ID_A, &owner).unwrap();
        assert_eq!(m, Mode::Primary);
        assert_eq!(resolve_state(load_config(&conn, "tenant-1", "branch-main").unwrap().as_ref(), ID_A), State::Primary);
    }

    // ── O2: Staff darf NICHT ────────────────────────────────────────────────
    #[test]
    fn o2_non_owner_role_is_rejected() {
        let conn = db();
        seed_users(&conn);
        let err = authorize_owner(&conn, "tenant-1", "branch-main", "staff@x.com", "staff-pw").unwrap_err();
        assert_eq!(err, ERR_OWNER_REQUIRED, "korrektes Passwort, aber Rolle != owner");
        assert!(load_config(&conn, "tenant-1", "branch-main").unwrap().is_none(), "nichts geschrieben");
    }

    // ── O3: falsche/fehlende Credentials ────────────────────────────────────
    #[test]
    fn o3_bad_credentials_are_rejected() {
        let conn = db();
        seed_users(&conn);
        for (mail, pw, why) in [
            ("owner@x.com", "falsch", "falsches Passwort"),
            ("owner@x.com", "", "leeres Passwort"),
            ("ghost@x.com", "owner-pw", "unbekannter Benutzer"),
            ("old@x.com", "x", "inaktiver Benutzer (active=0)"),
        ] {
            assert_eq!(
                authorize_owner(&conn, "tenant-1", "branch-main", mail, pw).unwrap_err(),
                ERR_OWNER_REQUIRED,
                "{why} muss abgelehnt werden — und ununterscheidbar (kein Enumerations-Orakel)"
            );
        }
    }

    // ── O4: configured_by kommt aus der Verifikation, nicht vom Aufrufer ────
    #[test]
    fn o4_configured_by_comes_from_the_verified_identity() {
        let conn = db();
        seed_users(&conn);
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        configure_as_owner(&conn, "tenant-1", "branch-main", Mode::Primary, ID_A, &owner).unwrap();
        let by: String = conn
            .query_row("SELECT configured_by FROM primary_host_config", [], |r| r.get(0))
            .unwrap();
        assert_eq!(by, "user-owner", "muss die verifizierte user_id sein");
        // OwnerAuth ist nur ueber authorize_owner konstruierbar -> kein Aufrufer kann sich
        // eine Identitaet ausstellen. (Compile-time garantiert durch das private Feld.)
    }

    // ── O6: fremder Tenant/Branch ───────────────────────────────────────────
    #[test]
    fn o6_foreign_tenant_or_branch_is_rejected() {
        let conn = db();
        seed_users(&conn);
        assert_eq!(
            authorize_owner(&conn, "tenant-FREMD", "branch-main", "owner@x.com", "owner-pw").unwrap_err(),
            ERR_OWNER_REQUIRED
        );
        assert_eq!(
            authorize_owner(&conn, "tenant-1", "branch-FREMD", "owner@x.com", "owner-pw").unwrap_err(),
            ERR_OWNER_REQUIRED
        );
    }

    // ── Transitionen ────────────────────────────────────────────────────────
    #[test]
    fn allowed_transitions_match_the_contract() {
        assert!(transition_allowed(State::Unconfigured, Mode::Primary));
        assert!(transition_allowed(State::Unconfigured, Mode::Client));
        assert!(transition_allowed(State::Client, Mode::Primary));
        assert!(transition_allowed(State::Primary, Mode::Client));
        assert!(transition_allowed(State::Primary, Mode::Unconfigured));
        // read_only ist eine KOPIE — sie darf sich nicht selbst freischalten.
        for to in [Mode::Primary, Mode::Client, Mode::Unconfigured] {
            assert!(!transition_allowed(State::ReadOnly, to), "read_only -> {to:?} verboten");
        }
    }

    #[test]
    fn read_only_cannot_promote_itself_even_with_owner_credentials() {
        let conn = db();
        seed_users(&conn);
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        // DB ist an ID_A gebunden, wir laufen aber auf ID_B -> read_only
        configure_as_owner(&conn, "tenant-1", "branch-main", Mode::Primary, ID_A, &owner).unwrap();
        let err = configure_as_owner(&conn, "tenant-1", "branch-main", Mode::Primary, ID_B, &owner).unwrap_err();
        assert_eq!(err, ERR_INSTANCE_ID_MISMATCH, "eine kopierte DB darf sich nicht umbinden");
        let cfg = load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert_eq!(cfg.server_instance_id.as_deref(), Some(ID_A), "Bindung unveraendert");
    }

    // ── L3 (Migration): kein Renderer promotet sich, egal was localStorage sagt ──
    //
    // B2A1 versuchte das noch mit `has_served_before` zu unterscheiden. B2A2 braucht die
    // Unterscheidung gar nicht mehr: der Legacy-Serverhinweis fuehrt IMMER nur in die
    // Owner-Adoption — mit oder ohne Historie.
    #[test]
    fn no_legacy_hint_ever_yields_primary_regardless_of_history() {
        for (history, label) in [(false, "ohne Historie (gefaelschter Client)"), (true, "mit Historie (echter Host ODER Kopie)")] {
            let conn = db();
            if history { served(&conn); }
            let claim = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
            let m = migrate_once(&conn, "tenant-1", "branch-main", &claim, ID_A).unwrap();
            assert_eq!(m, Mode::LegacyPending, "{label}: nie primary ohne Owner");
            assert!(
                load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap().server_instance_id.is_none(),
                "{label}: keine Bindung"
            );
        }
    }

    // ── L3: configured_by der Migration ist fest ────────────────────────────
    #[test]
    fn l3_migration_configured_by_is_fixed() {
        let conn = db();
        served(&conn);
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap();
        let by: String = conn
            .query_row("SELECT configured_by FROM primary_host_config", [], |r| r.get(0))
            .unwrap();
        assert_eq!(by, "legacy-migration", "kein Renderer-gelieferter Actor");
    }

    // Reines Audit-Verhalten. Der Name sagt bewusst NICHT "distinguishes a real host":
    // genau das kann es nicht (L12 — Historie ist kopierbar).
    #[test]
    fn has_served_before_reports_history_but_never_identity() {
        let conn = db();
        assert!(!has_served_before(&conn), "frische/leere Server-DB = keine Pushes angenommen");
        served(&conn);
        assert!(has_served_before(&conn), "angenommene Pushes = hier lief mal ein Server");
    }

    // ── L12: KOPIERTE VOR-B2A-SERVER-DB ─────────────────────────────────────
    //
    // Der Fall, den `has_served_before` NICHT abdeckt und der B2A1 zu Fall brachte:
    // eine Server-DB von vor v0002 hat echte Changelog-Historie UND keine
    // primary_host_config-Zeile (die Tabelle existierte damals nicht). Kopiert man sie auf
    // einen anderen Rechner, greift die ReadOnly-Bindung nicht — es gibt nichts zu
    // vergleichen — und `has_served_before` sagt "ja, war Server". Historie ist eben
    // kopierbar; sie ist ein Hinweis, keine Autorisierung.
    #[test]
    fn l12_copied_pre_b2a_server_db_is_never_adopted_automatically() {
        let conn = db();
        // Zustand exakt wie nach dem Kopieren einer Vor-B2A-DB:
        served(&conn);                                              // fremde Changelog-Historie
        assert!(load_config(&conn, "tenant-1", "branch-main").unwrap().is_none(),
            "Vor-v0002-DB hat keine primary_host_config-Zeile");
        // ... und der Renderer behauptet (oder die kopierte localStorage sagt) 'server'.
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };

        let outcome = migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_B).unwrap();

        assert_ne!(outcome, Mode::Primary, "eine kopierte DB darf sich NIE selbst promoten");
        assert_eq!(outcome, Mode::LegacyPending, "sie landet in der Owner-Bestaetigung");
        let cfg = load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert!(cfg.server_instance_id.is_none(), "KEINE Bindung an die neue Install-ID");
        let st = resolve_state(Some(&cfg), ID_B);
        assert_eq!(st, State::LegacyAdoptionRequired);
        assert!(!st.may_write_sync(), "kein Sync-Write vor der Adoption");
        assert!(!st.should_serve(), "kein schreibender Serverstart vor der Adoption");
    }

    // ── P9 / I6: instance binding ───────────────────────────────────────────
    #[test]
    fn p9_instance_mismatch_degrades_to_read_only() {
        let cfg = StoredConfig {
            mode: Mode::Primary,
            server_instance_id: Some(ID_A.into()),
            primary_host_id: Some(ID_A.into()),
        };
        assert_eq!(resolve_state(Some(&cfg), ID_A), State::Primary, "same install → primary");
        assert_eq!(resolve_state(Some(&cfg), ID_B), State::ReadOnly, "copied DB → read_only");
        assert!(!resolve_state(Some(&cfg), ID_B).may_write_sync());
    }

    #[test]
    fn primary_without_binding_is_read_only_not_primary() {
        let cfg = StoredConfig { mode: Mode::Primary, server_instance_id: None, primary_host_id: None };
        assert_eq!(resolve_state(Some(&cfg), ID_A), State::ReadOnly);
    }

    #[test]
    fn state_mapping_is_exhaustive() {
        assert_eq!(resolve_state(None, ID_A), State::Unconfigured);
        for (mode, want) in [(Mode::Unconfigured, State::Unconfigured), (Mode::Client, State::Client)] {
            let cfg = StoredConfig { mode, server_instance_id: None, primary_host_id: None };
            assert_eq!(resolve_state(Some(&cfg), ID_A), want);
        }
    }

    // ── write gate + serving ────────────────────────────────────────────────
    #[test]
    fn only_primary_may_write_sync() {
        assert!(State::Primary.may_write_sync());
        for s in [State::Client, State::Unconfigured, State::ReadOnly] {
            assert!(!s.may_write_sync(), "{s:?} must not write");
        }
    }

    #[test]
    fn p7_p8_client_and_unconfigured_do_not_serve() {
        assert!(State::Primary.should_serve());
        assert!(State::ReadOnly.should_serve(), "read_only still answers reads/diagnostics");
        assert!(!State::Client.should_serve(), "P7: a client never starts a server");
        assert!(!State::Unconfigured.should_serve(), "P8");
    }

    // ── P1/P2/P3: legacy migration ──────────────────────────────────────────
    // P1 (verschaerft in B2A2): ein Legacy-Serverhinweis fuehrt NICHT mehr direkt zu
    // primary, sondern in die Owner-Adoption.
    #[test]
    fn p1_legacy_server_with_setup_done_requires_adoption() {
        assert_eq!(
            migrate_legacy_mode(&LegacyLanConfig { mode: Some("server".into()), setup_done: true }),
            Mode::LegacyPending,
            "kopierbare Hinweise duerfen keine Rolle vergeben"
        );
    }

    #[test]
    fn p2_legacy_client_becomes_client() {
        for done in [true, false] {
            assert_eq!(
                migrate_legacy_mode(&LegacyLanConfig { mode: Some("client".into()), setup_done: done }),
                Mode::Client,
                "a client stays a client and is NEVER promoted"
            );
        }
    }

    #[test]
    fn p3_ambiguous_legacy_becomes_unconfigured() {
        let cases = [
            (None, true, "setup_done alone must NOT yield a primary"),
            (None, false, "nothing to migrate"),
            (Some("off"), true, "'off' says what it is not, not what it is"),
            (Some("manual"), true, "dead value, never written"),
            (Some("server"), false, "server without setup_done = incomplete record"),
            (Some("garbage"), true, "unknown value"),
        ];
        for (mode, done, why) in cases {
            assert_eq!(
                migrate_legacy_mode(&LegacyLanConfig { mode: mode.map(String::from), setup_done: done }),
                Mode::Unconfigured,
                "{why}"
            );
        }
    }

    // ── P10: migration is idempotent and cannot be re-decided later ─────────
    #[test]
    fn p10_migration_is_idempotent() {
        let conn = db();
        served(&conn);
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        assert_eq!(
            migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap(),
            Mode::LegacyPending
        );

        // A later start with DIFFERENT (e.g. cleared) localStorage must not re-decide.
        let cleared = LegacyLanConfig { mode: None, setup_done: false };
        assert_eq!(
            migrate_once(&conn, "tenant-1", "branch-main", &cleared, ID_A).unwrap(),
            Mode::LegacyPending,
            "once written, stale localStorage can never re-decide the outcome"
        );
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM primary_host_config", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    // L6/L10/L11: die Migration bindet NICHTS — erst die Adoption tut es.
    #[test]
    fn migration_never_binds_an_install_id() {
        let conn = db();
        served(&conn);
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap();
        let cfg = load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert!(cfg.server_instance_id.is_none(), "legacy_pending bindet keine Installation");
        // Auf JEDER Installation derselbe Zustand: die Frage an den Owner.
        assert_eq!(resolve_state(Some(&cfg), ID_A), State::LegacyAdoptionRequired);
        assert_eq!(resolve_state(Some(&cfg), ID_B), State::LegacyAdoptionRequired);
    }

    // ── L6/L10/L11 einzeln ──────────────────────────────────────────────────
    #[test]
    fn l10_has_served_alone_never_promotes() {
        let conn = db();
        served(&conn);   // Historie da, aber kein Legacy-Servermodus
        let legacy = LegacyLanConfig { mode: None, setup_done: false };
        assert_eq!(migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap(), Mode::Unconfigured);
    }

    #[test]
    fn l11_setup_done_alone_never_promotes() {
        let conn = db();
        served(&conn);
        let legacy = LegacyLanConfig { mode: None, setup_done: true };
        assert_eq!(migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap(), Mode::Unconfigured);
    }

    // ── L6: Adoption erst nach Owner + Bestaetigung ─────────────────────────
    #[test]
    fn l6_adoption_requires_owner_and_confirmation() {
        let conn = db();
        seed_users(&conn);
        served(&conn);
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap();

        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();

        // L4/L5 sind schon in authorize_owner abgedeckt; hier: fehlende Bestaetigung.
        assert_eq!(
            adopt_legacy_as_owner(&conn, "tenant-1", "branch-main", ID_A, &owner, "ja").unwrap_err(),
            ERR_ADOPTION_NOT_CONFIRMED
        );
        assert_eq!(
            load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap().mode,
            Mode::LegacyPending,
            "ohne Bestaetigung bleibt alles wie es war"
        );

        // Mit Owner + woertlicher Bestaetigung: adoptiert und an DIESE Installation gebunden.
        let m = adopt_legacy_as_owner(&conn, "tenant-1", "branch-main", ID_A, &owner, ADOPTION_CONFIRMATION).unwrap();
        assert_eq!(m, Mode::Primary);
        let cfg = load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert_eq!(cfg.server_instance_id.as_deref(), Some(ID_A));
        assert_eq!(resolve_state(Some(&cfg), ID_A), State::Primary);
        assert_eq!(resolve_state(Some(&cfg), ID_B), State::ReadOnly, "die Kopie bleibt read_only");
    }

    // ── L7: configured_by/adopted_by aus OwnerAuth ──────────────────────────
    #[test]
    fn l7_adoption_records_the_verified_owner() {
        let conn = db();
        seed_users(&conn);
        served(&conn);
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap();

        // Der Legacy-Hinweis ist als Audit erhalten.
        let (lm, lsd, lhs): (Option<String>, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT legacy_mode, legacy_setup_done, legacy_has_served FROM primary_host_config",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!(lm.as_deref(), Some("server"));
        assert_eq!(lsd, Some(1));
        assert_eq!(lhs, Some(1));

        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        adopt_legacy_as_owner(&conn, "tenant-1", "branch-main", ID_A, &owner, ADOPTION_CONFIRMATION).unwrap();
        let (by, adopted_by, adopted_at): (String, Option<String>, Option<String>) = conn
            .query_row("SELECT configured_by, adopted_by, adopted_at FROM primary_host_config", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(by, "user-owner");
        assert_eq!(adopted_by.as_deref(), Some("user-owner"));
        assert!(adopted_at.is_some(), "Adoptionszeitpunkt festgehalten");
        // Der Hinweis bleibt auch nach der Adoption als Spur erhalten.
        let lm2: Option<String> = conn
            .query_row("SELECT legacy_mode FROM primary_host_config", [], |r| r.get(0))
            .unwrap();
        assert_eq!(lm2.as_deref(), Some("server"), "Migrationsquelle bleibt nachvollziehbar");
    }

    // ── L8: zweite Adoption ist idempotent ──────────────────────────────────
    #[test]
    fn l8_second_adoption_is_idempotent() {
        let conn = db();
        seed_users(&conn);
        served(&conn);
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap();
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        adopt_legacy_as_owner(&conn, "tenant-1", "branch-main", ID_A, &owner, ADOPTION_CONFIRMATION).unwrap();
        let again = adopt_legacy_as_owner(&conn, "tenant-1", "branch-main", ID_A, &owner, ADOPTION_CONFIRMATION).unwrap();
        assert_eq!(again, Mode::Primary, "bereits adoptiert → No-op, kein Fehler");
    }

    // ── L13: read_only kann sich nicht ueber die Adoption umbinden ──────────
    #[test]
    fn l13_read_only_cannot_adopt() {
        let conn = db();
        seed_users(&conn);
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        configure_as_owner(&conn, "tenant-1", "branch-main", Mode::Primary, ID_A, &owner).unwrap();
        // Wir laufen auf ID_B → read_only
        let err = adopt_legacy_as_owner(&conn, "tenant-1", "branch-main", ID_B, &owner, ADOPTION_CONFIRMATION)
            .unwrap_err();
        assert_eq!(err, ERR_INSTANCE_ID_MISMATCH);
        let cfg = load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert_eq!(cfg.server_instance_id.as_deref(), Some(ID_A), "Bindung unveraendert");
    }

    #[test]
    fn adoption_without_a_pending_hint_is_rejected() {
        let conn = db();
        seed_users(&conn);
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        // unconfigured, kein Hinweis
        assert_eq!(
            adopt_legacy_as_owner(&conn, "tenant-1", "branch-main", ID_A, &owner, ADOPTION_CONFIRMATION).unwrap_err(),
            ERR_NO_LEGACY_ADOPTION_PENDING
        );
    }

    #[test]
    fn legacy_pending_cannot_be_reached_through_the_generic_owner_path() {
        let conn = db();
        seed_users(&conn);
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        assert!(configure_as_owner(&conn, "tenant-1", "branch-main", Mode::LegacyPending, ID_A, &owner).is_err());
    }

    #[test]
    fn owner_may_discard_a_legacy_hint_by_choosing_client() {
        let conn = db();
        seed_users(&conn);
        served(&conn);
        let legacy = LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap();
        let owner = authorize_owner(&conn, "tenant-1", "branch-main", "owner@x.com", "owner-pw").unwrap();
        assert_eq!(
            configure_as_owner(&conn, "tenant-1", "branch-main", Mode::Client, ID_A, &owner).unwrap(),
            Mode::Client
        );
    }

    #[test]
    fn migrated_client_has_no_instance_binding() {
        let conn = db();
        let legacy = LegacyLanConfig { mode: Some("client".into()), setup_done: true };
        migrate_once(&conn, "tenant-1", "branch-main", &legacy, ID_A).unwrap();
        let cfg = load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert!(cfg.server_instance_id.is_none(), "a client binds no instance");
        assert_eq!(resolve_state(Some(&cfg), ID_A), State::Client);
    }

    // ── set_mode round-trips + CHECK constraints hold ───────────────────────
    #[test]
    fn set_mode_roundtrips_and_rebinds() {
        let conn = db();
        set_mode(&conn, "tenant-1", "branch-main", Mode::Client, ID_A, "owner", None).unwrap();
        assert_eq!(load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap().mode, Mode::Client);
        set_mode(&conn, "tenant-1", "branch-main", Mode::Primary, ID_B, "owner", None).unwrap();
        let cfg = load_config(&conn, "tenant-1", "branch-main").unwrap().unwrap();
        assert_eq!(cfg.mode, Mode::Primary);
        assert_eq!(cfg.server_instance_id.as_deref(), Some(ID_B));
    }

    #[test]
    fn schema_rejects_a_primary_without_instance_binding() {
        let conn = db();
        let bad = conn.execute(
            "INSERT INTO primary_host_config (tenant_id, branch_id, mode, configured_at, state)
             VALUES ('tenant-1','branch-main','primary','now','primary')",
            [],
        );
        assert!(bad.is_err(), "CHECK must forbid an unbound primary");
    }

    #[test]
    fn schema_rejects_unknown_mode() {
        let conn = db();
        assert!(conn
            .execute(
                "INSERT INTO primary_host_config (tenant_id, branch_id, mode, configured_at, state)
                 VALUES ('tenant-1','branch-main','authority','now','primary')",
                [],
            )
            .is_err());
    }
}
