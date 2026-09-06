//! CENTRAL-C4 FINAL — die Rechte, mit denen eine Anfrage wirklich läuft.
//!
//! ## Der Befund
//!
//! Ein Token dieses Servers gilt **dreißig Tage** (`auth::create_token`). Seine Ansprüche —
//! Benutzer, Mandant, Filiale und **Rolle** — sind ein Abzug vom Moment der Anmeldung. Bis hierher
//! war dieser Abzug die einzige Wahrheit: wer als Verwalter angemeldet war, blieb einen Monat lang
//! Verwalter, auch wenn seine Zeile in `user_branches` inzwischen etwas anderes sagte oder sein
//! Konto abgeschaltet wurde.
//!
//! Solange keine Oberfläche Rollen ändert, ist das theoretisch. Es bleibt aber ein Abzug, und der
//! Zustand, gegen den die Anmeldung selbst prüft, liegt ohnehin schon in dieser Datenbank:
//! `users.active`, der Berechtigungszustand aus `credentials` und die Rolle aus `user_branches`.
//! Diese Stelle liest ihn bei JEDER Anfrage noch einmal — dieselbe Quelle, dieselbe Bedingung wie
//! beim Anmelden. Mehr ist es nicht, und mehr soll es nicht sein: keine Widerrufsliste, keine
//! zweite Sitzungsverwaltung, keine kurzlebigen Token.
//!
//! ## Der eine Sonderfall
//!
//! Der Desktop stellt sich beim Start ein eigenes Token für `self-desktop` aus — einen Namen, der
//! in `users` bewusst NICHT existiert (`sync::mod`). Er ist die einzige Ausnahme, und er ist
//! ausdrücklich benannt: jeder ANDERE unbekannte Benutzer wird abgewiesen. Damit ist auch das
//! Löschen eines Kontos ein Widerruf — vorher wäre es genau umgekehrt gewesen.

use super::models::Claims;
use axum::http::StatusCode;
use rusqlite::Connection;

/// Der Name, unter dem sich der Desktop selbst ein Token ausstellt. Er hat keine Zeile in `users`.
pub const SELF_PRINCIPAL_ID: &str = "self-desktop";

/// Was die Datenbank JETZT über diesen Absender sagt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrincipalState {
    /// Keine Zeile — entweder der Selbst-Absender oder ein gelöschtes Konto.
    Unknown,
    /// Es gibt ihn, aber er darf sich nicht (mehr) anmelden: `active = 0` oder gesperrte Anmeldedaten.
    Revoked,
    /// Es gibt ihn, und dies ist seine AKTUELLE Rolle — nicht die aus dem Token.
    Active { role: String },
}

/// Dieselbe Bedingung wie beim Anmelden: aktiver Benutzer, Standardfiliale, Rolle von dort.
/// Ein Fehler beim Lesen ist KEIN „unbekannt": er wird als Widerruf behandelt, weil eine Anfrage
/// nicht auf einer Datenbank laufen darf, die keine Auskunft geben kann.
pub fn lookup_principal(conn: &Connection, user_id: &str) -> PrincipalState {
    if user_id == SELF_PRINCIPAL_ID {
        return PrincipalState::Unknown;
    }
    let row: rusqlite::Result<(i64, String)> = conn
        .prepare(
            "SELECT u.active, ub.role
               FROM users u
               JOIN user_branches ub ON ub.user_id = u.id AND ub.is_default = 1
              WHERE u.id = ?1",
        )
        .and_then(|mut s| s.query_row(rusqlite::params![user_id], |r| Ok((r.get(0)?, r.get(1)?))));

    match row {
        Err(rusqlite::Error::QueryReturnedNoRows) => PrincipalState::Unknown,
        Err(_) => PrincipalState::Revoked,
        Ok((active, _)) if active != 1 => PrincipalState::Revoked,
        Ok((_, role)) => {
            if !super::credentials::state_of(conn, user_id).may_authenticate() {
                return PrincipalState::Revoked;
            }
            PrincipalState::Active { role }
        }
    }
}

/// Die reine Entscheidung — ohne Datenbank, damit sie sich einzeln prüfen lässt.
///
/// * **Aktiv** → die Ansprüche laufen mit der AKTUELLEN Rolle weiter. Das Token bleibt gültig;
///   nur was es über Rechte behauptet, wird ersetzt.
/// * **Widerrufen** → 401. Ein abgeschaltetes Konto arbeitet nicht bis zum Ablauf weiter.
/// * **Unbekannt** → nur der ausdrücklich benannte Selbst-Absender darf so weiterlaufen; jeder
///   andere unbekannte Benutzer ist ein gelöschtes Konto und wird abgewiesen.
pub fn reauthorize(claims: Claims, state: PrincipalState) -> Result<Claims, StatusCode> {
    match state {
        PrincipalState::Active { role } => Ok(Claims { role, ..claims }),
        PrincipalState::Revoked => Err(StatusCode::UNAUTHORIZED),
        PrincipalState::Unknown => {
            if claims.sub == SELF_PRINCIPAL_ID {
                Ok(claims)
            } else {
                Err(StatusCode::UNAUTHORIZED)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(sub: &str, role: &str) -> Claims {
        Claims {
            sub: sub.to_string(),
            tenant_id: "tenant-1".to_string(),
            branch_id: "branch-main".to_string(),
            role: role.to_string(),
            exp: 4102444800,
        }
    }

    #[test]
    fn the_current_role_replaces_the_one_in_the_token() {
        let out = reauthorize(
            claims("u1", "ADMIN"),
            PrincipalState::Active { role: "SALES".into() },
        )
        .unwrap();
        assert_eq!(out.role, "SALES", "die Datenbank entscheidet, nicht der Abzug von vor drei Wochen");
        assert_eq!(out.sub, "u1");
        assert_eq!(out.tenant_id, "tenant-1");
        assert_eq!(out.branch_id, "branch-main");
    }

    #[test]
    fn an_upgraded_role_is_honoured_too() {
        let out = reauthorize(
            claims("u1", "SALES"),
            PrincipalState::Active { role: "ADMIN".into() },
        )
        .unwrap();
        assert_eq!(out.role, "ADMIN", "es wirkt in beide Richtungen — es ist keine Sperre, sondern die Wahrheit");
    }

    #[test]
    fn a_revoked_account_does_not_work_until_the_token_expires() {
        assert_eq!(
            reauthorize(claims("u1", "ADMIN"), PrincipalState::Revoked).err(),
            Some(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn a_deleted_account_is_refused_and_the_self_principal_is_not() {
        // Ein geloeschtes Konto hat keine Zeile mehr — und darf gerade DESHALB nicht durch.
        assert_eq!(
            reauthorize(claims("u-gone", "ADMIN"), PrincipalState::Unknown).err(),
            Some(StatusCode::UNAUTHORIZED)
        );
        // Der Selbst-Absender des Desktops hat nie eine gehabt.
        let out = reauthorize(claims(SELF_PRINCIPAL_ID, "owner"), PrincipalState::Unknown).unwrap();
        assert_eq!(out.role, "owner");
    }

    #[test]
    fn the_self_principal_is_never_looked_up_in_the_user_table() {
        let conn = Connection::open_in_memory().unwrap();
        // Absichtlich OHNE Tabellen: der Selbst-Absender darf sie gar nicht erst brauchen.
        assert_eq!(lookup_principal(&conn, SELF_PRINCIPAL_ID), PrincipalState::Unknown);
    }

    fn db_with_user(active: i64, role: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, password_hash TEXT,
                                 name TEXT, active INTEGER, created_at TEXT, updated_at TEXT);
             CREATE TABLE user_branches (user_id TEXT, branch_id TEXT, role TEXT, is_default INTEGER,
                                         created_at TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at)
             VALUES ('u1','tenant-1','a@b','x','A',?1,'t','t')",
            rusqlite::params![active],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
             VALUES ('u1','branch-main',?1,1,'t')",
            rusqlite::params![role],
        )
        .unwrap();
        conn
    }

    #[test]
    fn an_inactive_user_reads_as_revoked() {
        let conn = db_with_user(0, "ADMIN");
        assert_eq!(lookup_principal(&conn, "u1"), PrincipalState::Revoked);
    }

    #[test]
    fn a_missing_user_reads_as_unknown() {
        let conn = db_with_user(1, "ADMIN");
        assert_eq!(lookup_principal(&conn, "someone-else"), PrincipalState::Unknown);
        // …und „unbekannt" ist fuer jeden ausser dem Selbst-Absender ein Nein.
        assert_eq!(
            reauthorize(claims("someone-else", "ADMIN"), lookup_principal(&conn, "someone-else")).err(),
            Some(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn an_unreadable_database_is_a_refusal_not_a_pass() {
        // Keine Tabellen: das Lesen scheitert. Fail-closed — nicht „unbekannt, also durch".
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(lookup_principal(&conn, "u1"), PrincipalState::Revoked);
    }
}
