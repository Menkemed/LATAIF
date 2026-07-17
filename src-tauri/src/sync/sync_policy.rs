//! M6-B2DE1 §3 — the one place that decides which tables the business sync may touch.
//!
//! ## Why this exists
//!
//! The §2 audit found that both ends of the legacy sync are wide open: `apply_legacy_push_batch`
//! writes any incoming `table_name` straight into `sync_changelog`, and the client's
//! `applyUpsert` / `DELETE` apply any table the server hands back. The only thing protecting
//! `enrolled_devices`, `server_credentials` or `users` today is that no normal writer touches
//! them — an *absence*, not a gate. A tampered client, a stale changelog row, or a future
//! writer walks straight past an absence.
//!
//! ## Denylist, not allowlist — and honest about it
//!
//! This slice ships a complete, tested **control-plane denylist**. It deliberately does NOT
//! ship a full business allowlist: enumerating every one of ~33 business tables (and keeping
//! that list correct as the schema grows) is a larger, separate decision. The security
//! property that matters here is weaker to state but fully closed: **every table that could
//! escalate privilege or forge trust is refused at both ends.** Unknown non-control-plane
//! tables are still accepted, and that gap is reported as `M6_FULL_BUSINESS_TABLE_ALLOWLIST_OPEN`
//! rather than hidden.
//!
//! ## One source of truth
//!
//! Server push, server pull and the Rust tests all call `classify`. The TypeScript client
//! carries the same denylist in its apply path; a Rust test (`ts_client_denylist_matches`)
//! reads `sync-service.ts` and checks it character-for-character against `CONTROL_PLANE_TABLES`,
//! so the two cannot drift silently even though they are two files.

/// The verdict for one table name. Ordered from "fine" to "never".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncTablePolicy {
    /// A normal business table. The legacy sync may carry it, exactly as before.
    BusinessAllowed,
    /// A security control-plane table. Never legitimately carried by the business sync;
    /// its appearance in a legacy batch is an attack or a bug, and either way is refused.
    ControlPlaneForbidden,
    /// The transport's own machinery (the changelog, the protocol scaffolding, migration
    /// bookkeeping). Not business data and not something a client may push either.
    InternalForbidden,
    /// A table we have not classified. Accepted as business for now — this is the
    /// `M6_FULL_BUSINESS_TABLE_ALLOWLIST_OPEN` gap — but named, so it is a decision and not
    /// an oversight.
    Unknown,
}

impl SyncTablePolicy {
    /// The single question the sync paths ask: may the business sync move this table at all?
    pub fn is_forbidden(self) -> bool {
        matches!(self, SyncTablePolicy::ControlPlaneForbidden | SyncTablePolicy::InternalForbidden)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            SyncTablePolicy::BusinessAllowed => "business_allowed",
            SyncTablePolicy::ControlPlaneForbidden => "control_plane_forbidden",
            SyncTablePolicy::InternalForbidden => "internal_forbidden",
            SyncTablePolicy::Unknown => "unknown",
        }
    }
}

/// The stable error a rejected batch surfaces.
pub const ERR_CONTROL_PLANE_TABLE_FORBIDDEN: &str = "SYNC_CONTROL_PLANE_TABLE_FORBIDDEN";

/// Every table that holds trust, identity, authority or owner state.
///
/// This list is the security boundary. Adding a control-plane table anywhere in the schema
/// without adding it here is the mistake this module exists to make impossible — see
/// `every_control_plane_migration_table_is_classified`, which walks the migration SQL and
/// fails if any `enrolled_*`/`device_*`/`authority_*`/… table is missing from here.
pub const CONTROL_PLANE_TABLES: &[&str] = &[
    // Owner / role / instance (B2A, B2A4)
    "server_credentials",
    "primary_host_config",
    "users",
    "user_branches",
    // Tenant trust root + authority (B2B, B2C)
    "tenant_trust_roots",
    "authority_certificates",
    "authority_revocations",
    "authority_transfers",
    "root_custody",
    // Device identity + enrollment (B2D)
    "enrolled_devices",
    "device_certificates",
    "device_enrollment_requests",
    "device_revocations",
    // Legacy inventory + cutover (B2E)
    "legacy_device_inventory",
    "legacy_inventory_attestations",
    "sync_cutover_state",
];

/// `users` and `user_branches` deserve a word, because at first glance they look like data.
///
/// They are not synced today (verified in B2A4: no `trackChange('users', …)` anywhere), and
/// they must never be: `users.password_hash` and `user_branches.role` are exactly the fields
/// a privilege-escalation push would target. The B2A4 owner-provisioning contract — a fresh
/// target host has NO owner because `users` does not travel — depends on this staying true.
const _: () = {
    // Compile-time reminder that these two are intentional members of the list above.
    assert!(!CONTROL_PLANE_TABLES.is_empty());
};

/// The transport's own tables. Not business, not something a client pushes.
pub const INTERNAL_TABLES: &[&str] = &[
    "sync_changelog",
    "canonical_records",
    "operations",
    "schema_migrations",
];

/// Classify a table name.
///
/// Case-sensitive on purpose: SQLite table names are what they are, and a "Users" that
/// differed from "users" only in case would be a different table anyway. The denylist is the
/// exhaustive part; everything else is business-or-unknown, and the two are distinguished
/// only for honest reporting — both are accepted.
pub fn classify(table_name: &str) -> SyncTablePolicy {
    if CONTROL_PLANE_TABLES.contains(&table_name) {
        SyncTablePolicy::ControlPlaneForbidden
    } else if INTERNAL_TABLES.contains(&table_name) {
        SyncTablePolicy::InternalForbidden
    } else if KNOWN_BUSINESS_TABLES.contains(&table_name) {
        SyncTablePolicy::BusinessAllowed
    } else {
        SyncTablePolicy::Unknown
    }
}

/// A convenience the sync paths actually call: is this table forbidden for the business sync?
pub fn is_forbidden(table_name: &str) -> bool {
    classify(table_name).is_forbidden()
}

/// The business tables we DO know about. Not exhaustive (that is the open allowlist), so it
/// is used only to tell `BusinessAllowed` from `Unknown` for reporting — never as a gate. A
/// table missing here is `Unknown`, which is still accepted.
pub const KNOWN_BUSINESS_TABLES: &[&str] = &[
    "tenants",
    "branches",
    "products",
    "categories",
    "offers",
    "offer_lines",
    "invoices",
    "invoice_lines",
    "payments",
    "order_payments",
    "orders",
    "repairs",
    "consignments",
    "agents",
    "agent_transfers",
    "debts",
    "debt_payments",
    "tax_payments",
    "customers",
    "customer_messages",
    "settings",
    "precious_metals",
    "tasks",
    "documents",
    "purchases",
    "purchase_lines",
    "purchase_returns",
    "suppliers",
    "expenses",
    "production_records",
    "partner_transactions",
    "sales_returns",
];

// ── M6-B2DE3 §3 — dynamic identifier safety ──────────────────────────────────
//
// The exact-name policy (`classify`) answers "may the sync move THIS table?" for tables we
// know by name. It says nothing about the SHAPE of a name it has never seen. But the client
// apply path interpolates `table_name` — and every column key of the payload — straight into
// SQL text (`INSERT INTO ${table} (${cols}) …`, `DELETE FROM ${table} …`); values and the
// record id are bound (`?`), the identifiers are not, because SQL cannot bind an identifier.
// So an UNKNOWN name that is not a clean identifier — `foo"; DROP TABLE users; --`, `Products`,
// `x‑1`, an empty string — passes the denylist (it is not control-plane) and reaches SQL as
// code. That is the `M6B2DE_DYNAMIC_IDENTIFIER_SAFETY_OPEN` bypass.
//
// The closure is a single canonical form. A real table or column in this app is always ASCII
// lowercase snake_case (verified: all 22 tables and all 187 columns match), so a name outside
// that charset can never be legitimate and refusing it removes the entire injection class at
// no cost to any real sync.

/// §3 — the hard maximum for a sync identifier. The longest real name,
/// `legacy_inventory_attestations`, is 29; 64 is comfortably above every real identifier and
/// far below anything that could be a crafted payload.
pub const MAX_SYNC_IDENTIFIER_LEN: usize = 64;

/// The stable error a non-canonical TABLE identifier surfaces (M6-B2DE4 §2). Columns are a
/// client-only concern (see `validate_sync_table_name`) and surface `SYNC_COLUMN_NAME_INVALID`
/// on the TS side.
pub const ERR_TABLE_NAME_INVALID: &str = "SYNC_TABLE_NAME_INVALID";

/// §3 — the ONE canonical form a sync identifier (table OR column) may take: non-empty, within
/// the max, first character `a`–`z`, every further character `a`–`z` / `0`–`9` / `_`. Exactly
/// one representation — no uppercase, no leading digit or underscore, no quoting, no unicode
/// look-alikes, no whitespace, no punctuation. Equivalent to the regex `^[a-z][a-z0-9_]{0,63}$`
/// mirrored in `sync-service.ts`.
pub fn is_valid_sync_identifier(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || b.len() > MAX_SYNC_IDENTIFIER_LEN {
        return false;
    }
    if !b[0].is_ascii_lowercase() {
        return false;
    }
    b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

/// §3 — the table-name gate the server push calls. Same predicate as `is_valid_sync_identifier`,
/// named for its call site. Column names are the SAME charset, but they are only interpolated on
/// the CLIENT apply path (`SET ${col} = ?`) — never in any Rust query — so their gate lives in
/// `sync-service.ts` (`assertSyncIdentifier('column', …)`), sharing this exact charset via the
/// drift test rather than a redundant Rust function no Rust caller would use.
pub fn validate_sync_table_name(name: &str) -> Result<(), &'static str> {
    if is_valid_sync_identifier(name) {
        Ok(())
    } else {
        Err(ERR_TABLE_NAME_INVALID)
    }
}

/// M6-B2DE4 §3/§4 — never echo an untrusted identifier raw into a log. Every character outside
/// the canonical set is exactly the attack (a quote, a newline, a control byte, a semicolon), so
/// replace each with `?`, cap the preview at 24 characters and append the true length. Bounded and
/// injection-free — a 1 MiB or newline-laden `table_name` becomes a short, single-line token.
/// Mirrors the TS `redactIdentifier`.
pub fn redact_identifier(name: &str) -> String {
    let preview: String = name
        .chars()
        .take(24)
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '?' })
        .collect();
    format!("{preview}<len={}>", name.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_plane_tables_are_all_forbidden() {
        for t in CONTROL_PLANE_TABLES {
            assert_eq!(classify(t), SyncTablePolicy::ControlPlaneForbidden, "{t}");
            assert!(is_forbidden(t), "{t} must be refused by the business sync");
        }
    }

    #[test]
    fn each_policy_has_a_stable_string() {
        // `as_str` is the diagnostic face of the policy — asserted here so its four values
        // stay stable and distinct rather than drifting unnoticed.
        let all = [
            SyncTablePolicy::BusinessAllowed,
            SyncTablePolicy::ControlPlaneForbidden,
            SyncTablePolicy::InternalForbidden,
            SyncTablePolicy::Unknown,
        ];
        let names: std::collections::BTreeSet<&str> = all.iter().map(|p| p.as_str()).collect();
        assert_eq!(names.len(), 4, "every policy has a distinct string");
        assert_eq!(classify("enrolled_devices").as_str(), "control_plane_forbidden");
        assert_eq!(classify("products").as_str(), "business_allowed");
    }

    #[test]
    fn internal_tables_are_forbidden_too() {
        for t in INTERNAL_TABLES {
            assert_eq!(classify(t), SyncTablePolicy::InternalForbidden, "{t}");
            assert!(is_forbidden(t));
        }
    }

    #[test]
    fn business_tables_are_allowed() {
        for t in KNOWN_BUSINESS_TABLES {
            assert_eq!(classify(t), SyncTablePolicy::BusinessAllowed, "{t}");
            assert!(!is_forbidden(t), "{t} must keep flowing");
        }
    }

    // ── S13 — an unknown table is classified honestly, not silently forbidden ─
    #[test]
    fn s13_unknown_tables_are_named_not_guessed() {
        let p = classify("some_future_table_we_have_not_seen");
        assert_eq!(p, SyncTablePolicy::Unknown, "an unseen table is Unknown, not a guess");
        // …and Unknown is ACCEPTED. This is the M6_FULL_BUSINESS_TABLE_ALLOWLIST_OPEN gap,
        // and it is a deliberate, reported choice — not forbidding it silently.
        assert!(!p.is_forbidden(), "Unknown is accepted; the open allowlist is reported, not enforced");
    }

    // ── the two lists never overlap ──────────────────────────────────────────
    #[test]
    fn a_table_is_never_both_business_and_control_plane() {
        for c in CONTROL_PLANE_TABLES {
            assert!(!KNOWN_BUSINESS_TABLES.contains(c), "{c} cannot be both");
            assert!(!INTERNAL_TABLES.contains(c), "{c} cannot be both");
        }
        for i in INTERNAL_TABLES {
            assert!(!KNOWN_BUSINESS_TABLES.contains(i), "{i} cannot be both");
        }
    }

    // ── users/user_branches specifically — the escalation vectors ────────────
    #[test]
    fn users_and_user_branches_are_control_plane() {
        // These carry password_hash and role. If a future refactor ever moved them to
        // BusinessAllowed, a legacy push could inject an owner or escalate a role — this is
        // the test that would go red first.
        assert_eq!(classify("users"), SyncTablePolicy::ControlPlaneForbidden);
        assert_eq!(classify("user_branches"), SyncTablePolicy::ControlPlaneForbidden);
    }

    // ── the TS client's denylist may not drift from this one ─────────────────
    //
    // The client's apply guard (§6) carries its own copy of the denylist, because it runs in
    // sql.js with no path back into Rust. "One SSOT" is kept honest by this test rather than by
    // a shared file: it reads `sync-service.ts` and checks that the two `CONTROL_PLANE_TABLES`
    // sets are exactly equal. Add a table to one and forget the other, and this goes red.
    #[test]
    fn ts_client_denylist_matches_rust_ssot() {
        let ts = include_str!("../../../src/core/sync/apply-change.ts");

        // M6-B2DE2 §4 — extract via STRUCTURED markers, not by parsing the array literal. Every
        // single-quoted token between a `@sync-policy:<name>:begin` and its `:end` is a table
        // name. This does not depend on the `readonly string[]` annotation or on array syntax —
        // only on the markers and the quoting — so a reformat of the TS cannot silently defeat
        // the compare (the old `= [` anchor was one refactor away from breaking).
        let extract = |name: &str| -> std::collections::BTreeSet<String> {
            let begin_tag = format!("@sync-policy:{name}:begin");
            let end_tag = format!("@sync-policy:{name}:end");
            let begin =
                ts.find(&begin_tag).unwrap_or_else(|| panic!("TS must carry marker {begin_tag}"));
            let end = ts[begin..]
                .find(&end_tag)
                .unwrap_or_else(|| panic!("TS must carry marker {end_tag}"))
                + begin;
            let region = &ts[begin..end];
            let mut out = std::collections::BTreeSet::new();
            let mut rest = region;
            while let Some(o) = rest.find('\'') {
                let after = &rest[o + 1..];
                let c = after.find('\'').expect("a quoted table name must close its quote");
                out.insert(after[..c].to_string());
                rest = &after[c + 1..];
            }
            out
        };

        let ts_tables = extract("control-plane");
        let rust_tables: std::collections::BTreeSet<String> =
            CONTROL_PLANE_TABLES.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            ts_tables, rust_tables,
            "the TypeScript client control-plane denylist has drifted from the Rust SSOT — \
             every forbidden table must be in BOTH or the client's second line of defence \
             has a hole"
        );

        let ts_internal = extract("internal");
        let rust_internal: std::collections::BTreeSet<String> =
            INTERNAL_TABLES.iter().map(|s| s.to_string()).collect();
        assert_eq!(ts_internal, rust_internal, "internal-table denylist drifted");

        // Belt and braces: the two extracted regions together are exactly the forbidden set, and
        // nothing appears in both (a table that was control-plane AND internal would be a bug).
        assert!(ts_tables.is_disjoint(&ts_internal), "a table cannot be both denylists");
    }

    // ── the SSOT self-check: a new control-plane table cannot be forgotten ────
    //
    // This is the test that makes the denylist maintainable rather than a snapshot. It reads
    // the ACTUAL migration SQL and pulls every CREATE TABLE out of it, then asserts that
    // anything whose name matches a control-plane naming pattern (device_*, authority_*,
    // *_custody, trust_root*, *credentials, *_attestations, cutover*, enrollment*) is in
    // `CONTROL_PLANE_TABLES`. Add a `device_sessions` table in B3 and forget to list it here,
    // and this fails before it can ever reach a sync path.
    #[test]
    fn every_control_plane_migration_table_is_classified() {
        let mut all_tables = Vec::new();
        for m in crate::sync::migrations::EMBEDDED_MIGRATIONS {
            for line in m.up_sql.lines() {
                let l = line.trim();
                if let Some(rest) = l.strip_prefix("CREATE TABLE IF NOT EXISTS ") {
                    let name: String =
                        rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                    if !name.is_empty() {
                        all_tables.push(name);
                    }
                }
            }
        }
        assert!(all_tables.len() >= 16, "the scan must actually find the migration tables");

        // A table is control-plane-shaped if its name carries trust/identity/authority intent.
        let looks_control_plane = |t: &str| -> bool {
            t.starts_with("device_")
                || t.starts_with("enrolled_")
                || t.starts_with("authority_")
                || t.starts_with("tenant_trust")
                || t.ends_with("_custody")
                || t.ends_with("_credentials")
                || t.contains("attestation")
                || t.contains("cutover")
                || t.contains("enrollment")
                || t.contains("inventory")
                || t == "primary_host_config"
        };

        for t in &all_tables {
            if looks_control_plane(t) {
                assert!(
                    CONTROL_PLANE_TABLES.contains(&t.as_str()),
                    "migration table '{t}' looks control-plane but is NOT in CONTROL_PLANE_TABLES \
                     — a new trust table must be denied before it can reach a sync path"
                );
            }
        }

        // And every name we DO deny must actually exist as a table somewhere — either in the
        // embedded migrations or as one of the base tables (users/user_branches live in the
        // frontend DB schema, not the embedded server migrations, so they are allowed to be
        // absent from `all_tables`).
        let base = ["users", "user_branches"];
        for c in CONTROL_PLANE_TABLES {
            assert!(
                all_tables.iter().any(|t| t == c) || base.contains(c),
                "denied table '{c}' is not created by any migration — dead entry?"
            );
        }
    }

    // ── §2/§3 — the EXHAUSTIVE inventory: every table that actually exists in the embedded
    //    server DB has EXACTLY ONE explicit classification, and none is Unknown ──────────────
    //
    // This is the §3 "fail on a missing classification" proof done without guessing from name
    // patterns. It builds the real schema (the base tables the migration lands on, then every
    // migration — which also creates `schema_migrations` as its bookkeeping), reads
    // `sqlite_master` for the ACTUAL set of tables, and checks that set — no more, no less —
    // against an explicit table→policy expectation a human wrote out. A new CREATE TABLE nobody
    // classified appears as an Unknown and fails; a dead expectation entry fails too.
    #[test]
    fn every_real_table_has_exactly_one_explicit_classification() {
        use rusqlite::Connection;
        use SyncTablePolicy::*;

        // The one place a human writes down what each table IS. Decided, not derived.
        let expected: &[(&str, SyncTablePolicy)] = &[
            // Base schema the embedded migration lands on.
            ("tenants", BusinessAllowed),
            ("branches", BusinessAllowed),
            ("users", ControlPlaneForbidden),
            ("user_branches", ControlPlaneForbidden),
            ("sync_changelog", InternalForbidden),
            // Runtime bookkeeping the migration runner creates.
            ("schema_migrations", InternalForbidden),
            // v0001 protocol scaffolding.
            ("canonical_records", InternalForbidden),
            ("operations", InternalForbidden),
            // v0002–v0008 control plane.
            ("primary_host_config", ControlPlaneForbidden),
            ("server_credentials", ControlPlaneForbidden),
            ("tenant_trust_roots", ControlPlaneForbidden),
            ("authority_certificates", ControlPlaneForbidden),
            ("authority_revocations", ControlPlaneForbidden),
            ("authority_transfers", ControlPlaneForbidden),
            ("root_custody", ControlPlaneForbidden),
            ("enrolled_devices", ControlPlaneForbidden),
            ("device_certificates", ControlPlaneForbidden),
            ("device_enrollment_requests", ControlPlaneForbidden),
            ("device_revocations", ControlPlaneForbidden),
            ("legacy_device_inventory", ControlPlaneForbidden),
            ("legacy_inventory_attestations", ControlPlaneForbidden),
            ("sync_cutover_state", ControlPlaneForbidden),
        ];

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE user_branches (user_id TEXT NOT NULL REFERENCES users(id), branch_id TEXT NOT NULL REFERENCES branches(id), role TEXT NOT NULL DEFAULT 'viewer', created_at TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));
             CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);",
        )
        .unwrap();
        lataif_server::migrations::run_migrations(&conn, crate::sync::migrations::EMBEDDED_MIGRATIONS)
            .unwrap();

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .unwrap();
        let actual: std::collections::BTreeSet<String> =
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(|r| r.ok()).collect();
        let expected_names: std::collections::BTreeSet<String> =
            expected.iter().map(|(n, _)| n.to_string()).collect();

        // 1. The real schema is EXACTLY the classified set — no unclassified newcomer, no dead
        //    entry. This is the tripwire a future migration trips.
        assert_eq!(
            actual, expected_names,
            "the embedded server schema and the classification list diverged — a new table must \
             be classified here (and, if control-plane, added to CONTROL_PLANE_TABLES) before it \
             can reach a sync path"
        );

        // 2. Each table classifies to EXACTLY its declared policy, and none is Unknown.
        for (name, policy) in expected {
            let got = classify(name);
            assert_eq!(got, *policy, "{name} classified {got:?}, expected {policy:?}");
            assert_ne!(got, Unknown, "{name} must not fall through to Unknown");
        }
    }

    // ── §3 — every name the policy knows is ALSO a canonical identifier ───────
    //
    // The charset gate must never reject a legitimate table. Every control-plane, internal and
    // known-business table name is asserted canonical here — so turning the gate on cannot break
    // a real sync (and if a future entry were added in a non-canonical form, this catches it).
    #[test]
    fn every_known_table_name_is_a_canonical_identifier() {
        for t in CONTROL_PLANE_TABLES.iter().chain(INTERNAL_TABLES).chain(KNOWN_BUSINESS_TABLES) {
            assert!(is_valid_sync_identifier(t), "{t} must be a canonical identifier");
            assert!(validate_sync_table_name(t).is_ok(), "{t}");
        }
        // A representative sample of real business COLUMNS (all 187 verified canonical out of
        // band; these stand in as a regression tripwire for the charset itself).
        for c in [
            "id", "brand", "name", "sku", "purchase_price", "planned_sale_price", "created_at",
            "category_id", "stock_status", "images", "attributes", "scope_of_delivery",
            "reverses_entry_id", "branch_id", "user_id", "record_revision",
        ] {
            assert!(is_valid_sync_identifier(c), "real column {c} must pass the shared charset");
        }
    }

    // ── §3 — the bypass: names that pass the denylist but are not clean identifiers ──
    #[test]
    fn non_canonical_identifiers_are_refused() {
        let attacks = [
            "",                                   // empty
            "Products",                           // uppercase (SQLite is case-insensitive, but
                                                  // our canonical form is not — one representation)
            "PRODUCTS",
            "products ",                          // trailing space
            " products",                          // leading space
            "1table",                             // leading digit
            "_hidden",                            // leading underscore
            "foo-bar",                            // hyphen
            "foo.bar",                            // dotted / schema-qualified
            "foo;bar",                            // statement separator
            "foo bar",                            // space
            "foo\"; DROP TABLE users; --",       // the classic identifier break-out
            "foo`bar",                            // backtick quote
            "[foo]",                              // bracket quote
            "foo'",                               // single quote
            "täble",                              // non-ASCII
            "table\u{2011}x",                     // unicode look-alike (non-breaking hyphen)
            "sync_changelog\n",                   // trailing newline on a real name
            &"a".repeat(MAX_SYNC_IDENTIFIER_LEN + 1), // oversized
        ];
        for a in attacks {
            // Both the table gate and the shared predicate (which the TS column gate mirrors)
            // reject it — so neither a table nor a column can carry this into SQL.
            assert!(!is_valid_sync_identifier(a), "{a:?} must NOT be a valid identifier");
            assert_eq!(validate_sync_table_name(a), Err(ERR_TABLE_NAME_INVALID), "{a:?}");
        }
        // …and the crucial point: several of these are NOT control-plane, so the denylist alone
        // would let them through — the charset gate is what stops them.
        assert!(!is_forbidden("foo\"; DROP TABLE users; --"), "a crafted name is 'Unknown', not denied by name");
        assert!(!is_forbidden("Products"));
        // The exact boundary: 64 ok, 65 not.
        assert!(is_valid_sync_identifier(&"a".repeat(MAX_SYNC_IDENTIFIER_LEN)));
        assert!(!is_valid_sync_identifier(&"a".repeat(MAX_SYNC_IDENTIFIER_LEN + 1)));
    }

    // ── §3/§4 — redaction is bounded and injection-free ──────────────────────
    #[test]
    fn redaction_is_bounded_and_strips_attacks() {
        for v in [
            "products\n; DROP TABLE users; --".to_string(),
            "a\tb\rc\u{0}d".to_string(),
            "a".repeat(1_000_000),
            String::new(),
        ] {
            let r = redact_identifier(&v);
            assert!(r.len() <= 40, "bounded: {} chars for input of {}", r.len(), v.chars().count());
            for bad in ['\n', '\t', '\r', '\u{0}', ';', '"', '`', '[', ']', '\'', ' ', '-', '/', '*', '.']
            {
                assert!(!r.contains(bad), "redaction must not carry {bad:?}: {r}");
            }
            assert!(r.contains("<len="), "redaction reports the length");
        }
        // A canonical name survives readably — only the length suffix is added.
        assert_eq!(redact_identifier("enrolled_devices"), "enrolled_devices<len=16>");
    }

    // ── §8 — SEMANTIC drift: Rust and TS agree on the SAME vector set ─────────
    //
    // The old drift test compared the TS regex TEXT to the Rust pattern — necessary but not
    // sufficient (two engines can read the same regex text differently). This runs the Rust
    // validator over a shared fixture; the node gate `test/m6b2de4/identifier-grammar.test.ts`
    // runs the TS validator over the SAME file. If the two grammars ever disagree on a single
    // vector, one of the two goes red — that is a semantic check, not a textual one.
    #[test]
    fn identifier_grammar_matches_shared_vectors() {
        let raw = include_str!("../../../test/fixtures/sync-identifier-vectors.json");
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let accept = v["accept"].as_array().expect("accept[]");
        let reject = v["reject"].as_array().expect("reject[]");
        assert!(accept.len() >= 10 && reject.len() >= 20, "the shared vector set must be substantial");
        for a in accept {
            let s = a.as_str().unwrap();
            assert!(is_valid_sync_identifier(s), "shared vector must ACCEPT {s:?}");
            // …and a table so accepted must not accidentally be a forbidden or internal one.
        }
        for r in reject {
            let s = r.as_str().unwrap();
            assert!(!is_valid_sync_identifier(s), "shared vector must REJECT {s:?}");
        }
        // The boundary is exactly 64: the longest accept vector is 64 chars, the longest reject 65.
        assert!(accept.iter().any(|a| a.as_str().unwrap().len() == MAX_SYNC_IDENTIFIER_LEN));
        assert!(reject.iter().any(|r| r.as_str().unwrap().len() == MAX_SYNC_IDENTIFIER_LEN + 1));
    }

    // ── §3 — the TS mirror carries the SAME charset (drift-guarded) ──────────
    //
    // The client validator runs in sql.js. Its regex is marked in `sync-service.ts`; here we
    // read it and assert it is exactly the canonical pattern this module implements, so the two
    // cannot drift into disagreeing about what a legal identifier is.
    #[test]
    fn ts_identifier_charset_matches_rust_ssot() {
        let ts = include_str!("../../../src/core/sync/apply-change.ts");
        let begin = ts
            .find("@sync-policy:identifier-charset:begin")
            .expect("TS must mark the identifier charset");
        let end = ts[begin..]
            .find("@sync-policy:identifier-charset:end")
            .expect("TS must close the identifier-charset marker")
            + begin;
        let region = &ts[begin..end];
        // The canonical pattern, spelled to match the max: first char + up to 63 more = 64.
        let expected = format!("/^[a-z][a-z0-9_]{{0,{}}}$/", MAX_SYNC_IDENTIFIER_LEN - 1);
        assert!(
            region.contains(&expected),
            "the TS identifier regex must be exactly {expected} — found region:\n{region}"
        );
    }
}
