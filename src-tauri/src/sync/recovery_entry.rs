//! M6-B2BC1-R §5 — the recovery entry path, re-audited on the provisioned-owner
//! foundation. **AUDIT ONLY — no production code.**
//!
//! ## Why this module is now inverted
//!
//! It was written to answer one question with executable evidence: *what actually happens
//! when the owner walks up to a brand-new machine with a valid recovery bundle and
//! nothing else?* At the B2BC1 state the answer was alarming — recovery was not
//! deadlocked, it **succeeded**, because `init_database` silently re-seeded a lost server
//! DB with `admin@lataif.com` / `admin` and every "owner authorization" in the chain
//! accepted a constant printed in the source.
//!
//! M6-B2A4 (`d099bc2`) closed that. Every finding here is therefore **inverted**: the same
//! scenarios that once demonstrated the hole now hold it shut. They are regression guards
//! — if one of them ever fails, the shared default credential is back.
//!
//! ## The two cases §5 asks to separate
//!
//! **A. Server DB present** → provisioned owner credentials + recovery passphrase
//!    (`recovery_case_a_*`).
//! **B. Server DB lost entirely** → a fresh DB has NO usable owner, so ordinary owner
//!    authentication is impossible *by construction*. What carries the case is the
//!    **local recovery credential ceremony**: a local Tauri call, a valid bundle and its
//!    passphrase. That proves knowledge of the recovery secret — not the identity of a
//!    person. The distinction is named, not blurred (`recovery_case_b_*`).

#[cfg(test)]
mod audit {
    use crate::sync::trust_root::testkit::*;
    use crate::sync::{credentials, db, primary, recovery, trust_root};
    use rusqlite::Connection;

    /// The install id these tests found their root under. A fixed UUID rather than a
    /// random one: M6-B2C4 records custody per install, and a value that changed between
    /// calls would make the custody row point at a machine the next call is not.
    const TEST_INSTALL: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


    /// The credentials `init_database` used to seed into every fresh server DB. Kept for
    /// exactly one purpose: proving they no longer work anywhere.
    const LEGACY_EMAIL: &str = "admin@lataif.com";
    const LEGACY_PASSWORD: &str = "admin";
    const OWNER_PW: &str = "a-real-owner-password";
    const RECOVERY_PW: &str = "the-owners-secret-passphrase";

    /// A brand-new host: empty app data dir, no server DB, no key file, no config row.
    ///
    /// `conn` before `dir`, and deliberately NO `Drop` on this struct: `Drop::drop` runs
    /// BEFORE a struct's fields are dropped, so a container-level cleanup would try to
    /// delete the directory while its own connection still holds the DB open (Windows
    /// refuses, and a tenant root key survives in TEMP). Fields drop in declaration
    /// order, so the connection closes first and then the guard deletes (§19).
    struct Host {
        conn: Connection,
        dir: TempDir,
    }

    fn fresh_host() -> Host {
        let dir = tmp_dir();
        // Exactly what `trust_ctx` → `open_config_db` does on a machine with no DB.
        let conn = db::init_database(&dir.join("lataif_sync_server.db")).unwrap();
        Host { conn, dir }
    }

    /// A host whose owner has completed the local provisioning ceremony (B2A4).
    fn provisioned_host() -> Host {
        let h = fresh_host();
        credentials::provision_owner(
            &h.conn,
            OWNER_PW,
            OWNER_PW,
            credentials::PROVISION_CONFIRMATION,
        )
        .unwrap();
        h
    }

    fn owner_of(h: &Host) -> primary::OwnerAuth {
        primary::authorize_owner(&h.conn, "tenant-1", "branch-main", LEGACY_EMAIL, OWNER_PW).unwrap()
    }

    fn make_primary(h: &Host) -> String {
        let id = crate::sync::install_id::load_or_create_in_dir(&h.dir).unwrap();
        let owner = owner_of(h);
        primary::configure_as_owner(
            &h.conn,
            "tenant-1",
            "branch-main",
            primary::Mode::Primary,
            &id,
            &owner,
        )
        .unwrap();
        id
    }

    // ── The inverted findings: the B2BC1 hole is shut ────────────────────────

    /// Was: *"`authorize_owner` does not fail for lack of a database — a fresh one is
    /// created and it accepts the shipped default. The check is not impossible; it is
    /// worthless."* Now a lost database yields a host with no usable owner at all.
    #[test]
    fn regression_lost_database_no_longer_hands_out_owner_authorization() {
        let h = fresh_host();
        for pw in [LEGACY_PASSWORD, "", "Admin", "!"] {
            assert_eq!(
                primary::authorize_owner(&h.conn, "tenant-1", "branch-main", LEGACY_EMAIL, pw)
                    .unwrap_err(),
                primary::ERR_OWNER_PROVISIONING_REQUIRED,
                "a re-created server DB must not authorize {pw:?}"
            );
        }
        assert!(!credentials::owner_credentials_ready(&h.conn));
    }

    /// Was: *"nothing in the application can change the default."* Now the default does
    /// not exist: the seed writes an unusable sentinel instead of hashing a constant.
    #[test]
    fn regression_the_shipped_default_no_longer_exists() {
        let h = fresh_host();
        let hash: String = h
            .conn
            .query_row("SELECT password_hash FROM users WHERE id='user-owner'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hash, credentials::UNUSABLE_HASH, "no password, not merely a gated one");
        assert!(!bcrypt::verify(LEGACY_PASSWORD, &hash).unwrap_or(false));
        assert_eq!(
            credentials::state_of(&h.conn, "user-owner"),
            credentials::CredentialState::Unprovisioned
        );

        // …and `db.rs` no longer CALLS it. Comment lines are stripped first: the seed
        // still explains in prose what it used to do, and that history is worth keeping —
        // it is the executable code that must be gone.
        let src_db = include_str!("db.rs");
        let prod: String = src_db[..src_db.find("#[cfg(test)]").unwrap_or(src_db.len())]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !prod.contains(r#"bcrypt::hash("admin""#),
            "the seed must never hash a constant password again"
        );
        // Sanity: the scanner can see real code in this file at all.
        assert!(prod.contains("UNUSABLE_HASH"), "scanner sees the seed's actual code");
    }

    /// Was: *"the B2A2 adoption ceremony is satisfied by `admin@lataif.com`/`admin`."*
    /// Now it cannot be satisfied at all until an owner exists.
    #[test]
    fn regression_legacy_adoption_no_longer_rests_on_a_shared_default() {
        let h = fresh_host();
        let id = crate::sync::install_id::load_or_create_in_dir(&h.dir).unwrap();
        h.conn
            .execute(
                "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
                 VALUES ('tenant-1','branch-main','products','p1','update','{}','self-desktop','n')",
                [],
            )
            .unwrap();
        let legacy = primary::LegacyLanConfig { mode: Some("server".into()), setup_done: true };
        // B2A2 still holds: a copyable hint never grants a role…
        assert_eq!(
            primary::migrate_once(&h.conn, "tenant-1", "branch-main", &legacy, &id).unwrap(),
            primary::Mode::LegacyPending
        );
        // …and the confirming owner can no longer be conjured from a public constant.
        assert_eq!(
            primary::authorize_owner(&h.conn, "tenant-1", "branch-main", LEGACY_EMAIL, LEGACY_PASSWORD)
                .unwrap_err(),
            primary::ERR_OWNER_PROVISIONING_REQUIRED
        );
    }

    /// Was: the end-to-end disaster case succeeding on default credentials. Now the same
    /// walk-up is stopped at the first step.
    #[test]
    fn regression_disaster_case_no_longer_opens_on_a_public_constant() {
        let new = fresh_host();
        let id = crate::sync::install_id::load_or_create_in_dir(&new.dir).unwrap();

        // Step 1 — become primary with the old shared password: refused.
        let err = primary::authorize_owner(
            &new.conn,
            "tenant-1",
            "branch-main",
            LEGACY_EMAIL,
            LEGACY_PASSWORD,
        )
        .unwrap_err();
        assert_eq!(err, primary::ERR_OWNER_PROVISIONING_REQUIRED);

        // …so nothing downstream is reachable: no role, no root, no server.
        assert!(primary::load_config(&new.conn, "tenant-1", "branch-main").unwrap().is_none());
        assert!(!primary::resolve_state(None, &id).may_write_sync());
        assert_eq!(
            trust_root::resolve_trust_state(&new.conn, &new.dir, "tenant-1"),
            trust_root::TrustState::None
        );
        assert!(!credentials::owner_credentials_ready(&new.conn), "no writing server either");
    }

    // ── §5 case A: server DB present ─────────────────────────────────────────
    #[test]
    fn recovery_case_a_requires_provisioned_owner_and_passphrase() {
        let src = provisioned_host();
        make_primary(&src);
        let owner = owner_of(&src);
        let root = trust_root::initialize_root(
            &src.conn,
            &src.dir,
            "tenant-1",
            TEST_INSTALL,
            primary::State::Primary,
            &owner,
        )
        .unwrap();
        let key = trust_root::load_key(&src.dir, &root).unwrap();
        let bundle = recovery::serialize_bundle(
            &recovery::export_bundle(
                &key,
                &root,
                "2026-07-17T00:00:00Z",
                RECOVERY_PW,
                &recovery::AuthorityHints::default(),
            )
            .unwrap(),
        )
        .unwrap();
        drop(key);

        // The rescued DB, key file gone (recovery case C).
        std::fs::remove_file(key_file_path(&src.dir)).unwrap();
        assert_eq!(
            trust_root::resolve_trust_state(&src.conn, &src.dir, "tenant-1"),
            trust_root::TrustState::RecoveryRequired
        );

        // A wrong passphrase is refused…
        assert!(recovery::import_bundle(&bundle, "tenant-1", "wrong-passphrase").is_err());
        // …the right one restores exactly the same root.
        let imported = recovery::import_bundle(&bundle, "tenant-1", RECOVERY_PW).unwrap();
        trust_root::restore_root(&src.conn, &src.dir, &imported.record, imported.seed, TEST_INSTALL, &owner)
            .unwrap();
        assert_eq!(
            trust_root::resolve_trust_state(&src.conn, &src.dir, "tenant-1"),
            trust_root::TrustState::Ready
        );
    }

    // ── §5 case B: the server DB is gone ─────────────────────────────────────
    //
    // The honest shape. A fresh DB has NO usable owner — that is B2A4 working as
    // designed — so ordinary owner authentication is impossible here, not merely
    // inconvenient. The case rests on a DIFFERENT credential: the recovery passphrase,
    // presented through a local Tauri call. It proves knowledge of the recovery secret,
    // never the identity of a person, and this module calls it that.
    #[test]
    fn recovery_case_b_is_a_local_recovery_credential_ceremony_not_owner_login() {
        // A bundle from the shop that burned down.
        let old = provisioned_host();
        make_primary(&old);
        let old_owner = owner_of(&old);
        let root = trust_root::initialize_root(
            &old.conn,
            &old.dir,
            "tenant-1",
            TEST_INSTALL,
            primary::State::Primary,
            &old_owner,
        )
        .unwrap();
        let key = trust_root::load_key(&old.dir, &root).unwrap();
        let bundle = recovery::serialize_bundle(
            &recovery::export_bundle(
                &key,
                &root,
                "2026-07-17T00:00:00Z",
                RECOVERY_PW,
                &recovery::AuthorityHints::default(),
            )
            .unwrap(),
        )
        .unwrap();
        drop(key);
        drop(old_owner);
        drop(old); // machine, key file and server DB all gone

        // A brand-new machine. Nothing survives but the bundle.
        let new = fresh_host();
        assert!(!trust_root::key_file_exists(&new.dir));
        assert!(primary::load_config(&new.conn, "tenant-1", "branch-main").unwrap().is_none());

        // Owner authentication is IMPOSSIBLE here — no owner yet, and no constant to fall
        // back on. That is the fact the ceremony has to work around, not a bug.
        assert_eq!(
            primary::authorize_owner(&new.conn, "tenant-1", "branch-main", LEGACY_EMAIL, LEGACY_PASSWORD)
                .unwrap_err(),
            primary::ERR_OWNER_PROVISIONING_REQUIRED
        );

        // The ceremony: local provisioning establishes WHO owns this machine…
        credentials::provision_owner(
            &new.conn,
            OWNER_PW,
            OWNER_PW,
            credentials::PROVISION_CONFIRMATION,
        )
        .unwrap();
        make_primary(&new);
        let new_owner = owner_of(&new);

        // …and the bundle + passphrase prove entitlement to THIS tenant's root.
        let imported = recovery::import_bundle(&bundle, "tenant-1", RECOVERY_PW).unwrap();
        trust_root::restore_root(&new.conn, &new.dir, &imported.record, imported.seed, TEST_INSTALL, &new_owner)
            .unwrap();

        let restored = trust_root::load_active_root(&new.conn, "tenant-1").unwrap().unwrap();
        assert_eq!(restored, root, "the same trust root continues");

        // The boundary is local control of the machine PLUS the recovery passphrase —
        // not a remotely authenticated owner identity.
        assert!(recovery::import_bundle(&bundle, "tenant-1", "not-the-passphrase").is_err());
        assert!(recovery::import_bundle(&bundle, "tenant-2", RECOVERY_PW).is_err());
    }

    // ── §5: still local-only, still no HTTP ──────────────────────────────────
    #[test]
    fn recovery_is_reachable_only_through_local_tauri_commands() {
        let src = include_str!("routes.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        for cmd in [
            "trust_root_import_recovery",
            "trust_root_export_recovery",
            "server_owner_provision",
            "primary_configure",
        ] {
            assert!(!prod.contains(cmd), "§5: {cmd} must not be reachable over HTTP");
        }
    }

    // ── §15 / O1–O10: every B2BC mutation sits behind the hardened owner gate ──
    //
    // The point of B2BC1-R §4: the trust and authority commands must not carry their own
    // notion of "owner". They call the same `authorize_owner` that B2A4 hardened, so the
    // provisioning gate reaches them for free — and these tests hold that wiring in place.

    /// O1/O4 — with the old shared default, nothing can be created.
    #[test]
    fn o1_o4_default_credentials_create_no_trust_root_and_no_authority() {
        let h = fresh_host();
        // O1 — a trust root needs a verified owner; there is none.
        assert_eq!(
            primary::authorize_owner(&h.conn, "tenant-1", "branch-main", LEGACY_EMAIL, LEGACY_PASSWORD)
                .unwrap_err(),
            primary::ERR_OWNER_PROVISIONING_REQUIRED
        );
        assert!(!trust_root::key_file_exists(&h.dir), "O1: no key file appeared");
        assert!(
            trust_root::load_active_root(&h.conn, "tenant-1").unwrap().is_none(),
            "O1: no trust root row"
        );
        // O4 — and with no root there is nothing to sign an authority with either.
        assert_eq!(
            crate::sync::authority::highest_known_epoch(&h.conn, "tenant-1", "branch-main").unwrap(),
            0
        );
        assert_eq!(
            trust_root::require_signing_root(&h.conn, &h.dir, "tenant-1").unwrap_err(),
            trust_root::ERR_ROOT_KEY_MISSING
        );
    }

    /// O2/O3/O5 — every command that acts on the SOURCE begins with `authorize_owner`, so
    /// the same refusal covers them all. Pinned at the source text: a future command must
    /// not grow its own auth and quietly bypass the gate.
    #[test]
    fn o2_o3_o5_every_b2bc_command_funnels_through_authorize_owner() {
        let src = include_str!("../lib.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];

        let body_of = |cmd: &str| -> &str {
            let start = prod.find(cmd).unwrap_or_else(|| panic!("{cmd} not found"));
            let rest = &prod[start..];
            let end = rest[1..].find("\n#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
            &rest[..end]
        };

        for cmd in [
            "async fn trust_root_initialize",
            "async fn trust_root_export_recovery",
            "async fn trust_root_import_recovery",
            "async fn authority_initialize",
            // M6-B2C4 — the source half of the two-phase transfer.
            "async fn authority_transfer_issue",
            "async fn authority_transfer_confirm",
            "async fn authority_transfer_commit",
            "async fn authority_transfer_commit_token",
            "async fn authority_transfer_abort",
            "async fn authority_prepare_recovery",
            "async fn authority_revoke",
        ] {
            let body = body_of(cmd);
            assert!(
                body.contains("authorize_owner"),
                "{cmd} must go through the central owner check, not its own"
            );
            // …and none of them may treat the self-token or a caller-supplied id as proof.
            assert!(!body.contains("self_token"), "{cmd}: the self-token is not an owner proof");
            assert!(
                !body.contains("actor_id") && !body.contains("configured_by:"),
                "{cmd}: no renderer-supplied actor"
            );
        }
    }

    /// M6-B2C4 §15 — the TARGET's commands have a different gate, and say so.
    ///
    /// This is the uncomfortable half and it gets its own test rather than a footnote. A
    /// fresh target has no users table for this tenant, so there is no owner to
    /// authenticate against — `authorize_owner` there would either always fail or, worse,
    /// authenticate against whatever unrelated user rows that machine happens to hold.
    ///
    /// So their gate is: possession of the package, its passphrase, and the install-id
    /// binding in the AEAD's AAD. That is genuinely weaker than owner authentication, and
    /// the honest move is to name it — never to call `authorize_owner` somewhere it proves
    /// nothing just so a scan like the one above goes green.
    #[test]
    fn target_local_commands_do_not_pretend_to_be_owner_authenticated() {
        let src = include_str!("../lib.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];

        for cmd in [
            "async fn authority_transfer_import",
            "async fn authority_transfer_receipt",
            "async fn authority_transfer_activate",
            "async fn authority_transfer_abort_import",
            // M6-B2DE — the device side has the same shape and the same reason: a machine
            // that has only ever created a keypair has no owner row for this tenant, because
            // `users` is not synced.
            "async fn device_status",
            "async fn device_create_enrollment_request",
            "async fn device_import_enrollment_response",
        ] {
            let start = prod.find(cmd).unwrap_or_else(|| panic!("{cmd} not found"));
            let rest = &prod[start..];
            let end = rest[1..].find("\n#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
            // EXECUTABLE lines only. The window between one command and the next contains
            // prose, and that prose is where the boundary is explained — including the
            // sentence "calling authorize_owner here would be theatre". A scan that could
            // not tell a prohibition from a call would force us to delete the explanation to
            // keep the test green, which is backwards. (M6-B2DE hit exactly this.)
            let body: String = rest[..end]
                .lines()
                .map(|l| l.trim_start())
                .filter(|l| !l.starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !body.contains("authorize_owner"),
                "{cmd} runs on a machine that may have no owner — calling authorize_owner \
                 here would be authentication theatre"
            );
            // They must not take credentials they cannot check, either. A command with an
            // `email`/`password` parameter that never verifies them is worse than one with
            // no parameters: it *looks* authenticated.
            assert!(
                !body.contains("email: String") && !body.contains("password: String"),
                "{cmd}: do not accept credentials that this machine cannot verify"
            );
        }

        // And the boundary is written down where a reader will find it, not only here.
        assert!(
            prod.contains("OWNER BOUNDARY"),
            "the source/target authorization split must be documented at the commands"
        );
        // The comment filter above must not have turned this test into a no-op: the
        // owner-gated commands still have to trip it. If this stops failing, the filter ate
        // the code as well as the prose.
        let owner_gated = {
            let start = prod.find("async fn authority_transfer_issue").unwrap();
            let rest = &prod[start..];
            let end = rest[1..].find("\n#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
            rest[..end]
                .lines()
                .map(|l| l.trim_start())
                .filter(|l| !l.starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert!(
            owner_gated.contains("authorize_owner"),
            "the filter must still see real calls, not just strip everything"
        );
    }

    /// O6 — an unprovisioned server blocks every B2BC mutation, at one place.
    #[test]
    fn o6_unprovisioned_server_blocks_all_b2bc_mutations() {
        let h = fresh_host();
        assert!(!credentials::owner_credentials_ready(&h.conn));
        // Every command's first step is this call, and it fails for all of them alike.
        for (email, pw) in [
            (LEGACY_EMAIL, LEGACY_PASSWORD),
            (LEGACY_EMAIL, OWNER_PW),
            ("someone@else.com", "whatever"),
        ] {
            assert!(
                primary::authorize_owner(&h.conn, "tenant-1", "branch-main", email, pw).is_err(),
                "{email} must not authorize on an unprovisioned server"
            );
        }
    }

    /// O7 — after local provisioning the owner may do the permitted things.
    #[test]
    fn o7_provisioned_owner_may_act() {
        let h = provisioned_host();
        make_primary(&h);
        let owner = owner_of(&h);

        // The SAME install id founds the root and issues the authority — as production does
        // (both take `c.install_id`). M6-B2C4 records custody per install, so using one id
        // here and another below would test a machine that does not exist.
        let install = crate::sync::install_id::load_or_create_in_dir(&h.dir).unwrap();
        let root =
            trust_root::initialize_root(&h.conn, &h.dir, "tenant-1", &install, primary::State::Primary, &owner)
                .unwrap();
        assert_eq!(root.generation, 1);

        let key = trust_root::load_key(&h.dir, &root).unwrap();
        let bundle =
            recovery::export_bundle(&key, &root, "n", RECOVERY_PW, &recovery::AuthorityHints::default())
                .unwrap();
        assert!(recovery::serialize_bundle(&bundle).is_ok());

        let ctx = crate::sync::authority::IssueContext {
            conn: &h.conn,
            tenant_id: "tenant-1",
            branch_id: "branch-main",
            install_id: &install,
            primary_state: primary::State::Primary,
            root: &root,
            key: &key,
            owner: &owner,
        };
        let cert = crate::sync::authority::initialize_authority(&ctx).unwrap();
        assert_eq!(cert.payload.authority_epoch, 1);
        // …and founding the root gave this machine the custody the §9 gate requires.
        assert_eq!(
            crate::sync::transfer::custody_state(&h.conn, "tenant-1", &install).unwrap(),
            Some(crate::sync::transfer::CustodyState::SourceActive)
        );
    }

    /// O8/O9 — a wrong password and a staff account are both refused on a provisioned
    /// server, and they are refused with the generic code (no oracle).
    #[test]
    fn o8_o9_wrong_password_and_staff_are_refused() {
        let h = provisioned_host();
        // O8
        assert_eq!(
            primary::authorize_owner(&h.conn, "tenant-1", "branch-main", LEGACY_EMAIL, "not-the-password")
                .unwrap_err(),
            primary::ERR_OWNER_REQUIRED
        );
        // O9 — staff with correct credentials, wrong role.
        let sh = bcrypt::hash("staff-pw", 4).unwrap();
        h.conn
            .execute(
                "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
                 VALUES ('user-staff','tenant-1','staff@x.com',?1,'S',1,'n','n')",
                rusqlite::params![sh],
            )
            .unwrap();
        h.conn
            .execute_batch(
                "INSERT INTO user_branches VALUES ('user-staff','branch-main','staff',0,'n');
                 INSERT INTO server_credentials (user_id, credential_state, password_changed_at, created_at, updated_at)
                 VALUES ('user-staff','active','n','n','n');",
            )
            .unwrap();
        assert_eq!(
            primary::authorize_owner(&h.conn, "tenant-1", "branch-main", "staff@x.com", "staff-pw")
                .unwrap_err(),
            primary::ERR_OWNER_REQUIRED,
            "correct credentials, wrong role"
        );
        // …and the wrong tenant/branch stays shut too.
        for (t, b) in [("tenant-FREMD", "branch-main"), ("tenant-1", "branch-FREMD")] {
            assert!(primary::authorize_owner(&h.conn, t, b, LEGACY_EMAIL, OWNER_PW).is_err());
        }
    }

    /// O10 — changing the password invalidates the old one for B2BC too. It must, because
    /// there is only one door: the same `authorize_owner` the B2BC commands call.
    #[test]
    fn o10_password_change_invalidates_old_credentials_for_b2bc() {
        let h = provisioned_host();
        make_primary(&h);
        const NEW_PW: &str = "an-even-better-password";
        credentials::change_owner_password(&h.conn, LEGACY_EMAIL, OWNER_PW, NEW_PW, NEW_PW).unwrap();

        // The old password no longer opens the trust-root path…
        assert_eq!(
            primary::authorize_owner(&h.conn, "tenant-1", "branch-main", LEGACY_EMAIL, OWNER_PW)
                .unwrap_err(),
            primary::ERR_OWNER_REQUIRED
        );
        // …and the new one does.
        let owner =
            primary::authorize_owner(&h.conn, "tenant-1", "branch-main", LEGACY_EMAIL, NEW_PW).unwrap();
        assert!(
            trust_root::initialize_root(&h.conn, &h.dir, "tenant-1", TEST_INSTALL, primary::State::Primary, &owner)
                .is_ok()
        );
    }

    // ── §6: recovery creates no primary and starts no server ─────────────────
    #[test]
    fn import_creates_no_primary_and_starts_no_server() {
        let h = provisioned_host();
        let id = crate::sync::install_id::load_or_create_in_dir(&h.dir).unwrap();

        // Even with changelog history present, importing a root must not write a role.
        h.conn
            .execute(
                "INSERT INTO sync_changelog (tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
                 VALUES ('tenant-1','branch-main','products','p1','update','{}','self-desktop','n')",
                [],
            )
            .unwrap();

        let src = include_str!("../lib.rs");
        let start = src.find("async fn trust_root_import_recovery").unwrap();
        let rest = &src[start..];
        let end = rest[1..].find("\n#[tauri::command]").map(|i| i + 1).unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(!body.contains("set_mode"), "§6: import writes no role");
        assert!(!body.contains("configure_as_owner"), "§6: import writes no role");
        assert!(!body.contains("adopt_legacy_as_owner"), "§6: import adopts nothing");
        assert!(!body.contains("server.start"), "§6: import starts no server");

        assert!(
            primary::load_config(&h.conn, "tenant-1", "branch-main").unwrap().is_none(),
            "§6: no primary binding"
        );
        assert_eq!(primary::resolve_state(None, &id), primary::State::Unconfigured);
        assert!(!primary::resolve_state(None, &id).may_write_sync());
    }
}
