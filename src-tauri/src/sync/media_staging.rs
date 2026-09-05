//! CENTRAL-C3C — die neutrale Zwischenablage für Bilder eines zweiten Rechners.
//!
//! Ein Produkt anzulegen heißt, Bytes mitzubringen. Über `/api/command` geht das nicht: dort liegt
//! ein Auftrag, kein Bildstapel, und 25 MiB als Base64 in eine Auftragsnutzlast zu legen hieße, die
//! Warteschlange des Renderers mit Bildern zu verstopfen.
//!
//! Es gab schon einen Weg, auf dem Bilder hereinkommen: `/api/mobile/upload`. Ihn zu benutzen wäre
//! bequem und falsch. Diese Route ist kein Briefkasten, sondern ein PRODUKT-EINGANG: sie prüft
//! Produktfelder, schreibt eine Zeile in `mobile_upload_inbox`, und ihr Abarbeiter legt das Produkt
//! an. Ein Desktop-Client, der sie benutzte, hätte damit einen zweiten Weg, ein Produkt entstehen
//! zu lassen — an `runRemoteCommand` vorbei, ohne durablen Nachweis, mit einer anderen Idempotenz.
//! Zwei Wege zum selben Ergebnis sind zwei Wahrheiten.
//!
//! Also die kleinste ehrliche Stelle, die genau EINES kann: Bytes annehmen und wieder herausgeben.
//!
//!  • **Sie fasst die Geschäftsdatenbank nicht an.** Keine Tabelle, keine Zeile, kein Changelog.
//!    Was hier liegt, ist noch nichts — es wird erst etwas, wenn ein Auftrag es benutzt.
//!  • **Sie nimmt keinen Pfad entgegen.** Der Name einer Ablage ist der SHA-256 ihres Inhalts, vom
//!    Server berechnet. Es gibt kein Feld, in dem ein Client ein Ziel nennen könnte, und deshalb
//!    auch nichts, was man mit `..` verlassen könnte.
//!  • **Sie entscheidet nichts.** Kein Produkt, keine SKU, keine Kategorie. Wer die Bytes später
//!    verwendet, ist der Primary-Renderer über den ganz normalen Auftragsweg.
//!  • **Sie vergisst.** Was niemand abholt, verschwindet nach einer Frist. Eine Ablage, die ewig
//!    wächst, wäre ein zweiter Medienspeicher ohne Buchführung.
//!
//! Was ein Bild ist, entscheidet NICHT diese Datei: `mobile_upload::accept_image_bytes` ist die
//! eine Antwort darauf, und beide Eingangsstellen fragen sie.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Wie lange eine unbenutzte Ablage liegen bleibt. Lang genug, dass ein Mensch das Formular
/// zwischendurch liegen lassen darf; kurz genug, dass nichts dauerhaft entsteht.
pub const STAGED_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Wie viele Ablagen insgesamt liegen dürfen. Eine harte Obergrenze, damit ein angemeldeter Client
/// die Platte nicht vollschreiben kann, auch nicht innerhalb der Frist.
pub const MAX_STAGED_FILES: usize = 512;

pub const ERR_TOO_MANY: &str = "STAGING_FULL";
pub const ERR_BAD_ID: &str = "STAGING_BAD_ID";
pub const ERR_NOT_FOUND: &str = "STAGING_NOT_FOUND";
pub const ERR_IO: &str = "STAGING_IO";

/// Was eine angenommene Ablage über sich sagt. Die Kennung IST der Inhalt (sein Hash) — deshalb
/// ist ein zweites Hochladen derselben Bytes keine zweite Ablage, sondern dieselbe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBlob {
    pub staging_id: String,
    pub mime: &'static str,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
}

/// Eine Kennung ist genau 64 Hex-Zeichen. Alles andere wird abgewiesen, bevor daraus ein Pfad
/// wird — das ist der Grund, warum es hier keine Pfadprüfung braucht: es gibt keinen Pfad, den
/// jemand nennen könnte.
pub fn is_staging_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn path_for(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.bin"))
}

/// Legt Bytes ab und gibt ihre Kennung zurück. `declared_mime` wird gegen die Magic Bytes geprüft —
/// dieselbe Prüfung wie beim mobilen Upload.
pub fn stage_image(
    root: &Path,
    declared_mime: &str,
    bytes: &[u8],
) -> Result<StagedBlob, &'static str> {
    let accepted = super::mobile_upload::accept_image_bytes(declared_mime, bytes)?;
    std::fs::create_dir_all(root).map_err(|_| ERR_IO)?;

    let target = path_for(root, &accepted.content_hash);
    // Dieselben Bytes ein zweites Mal: dieselbe Ablage. Kein zweites Schreiben, kein Zählen gegen
    // die Obergrenze — es entsteht nichts Neues.
    if target.exists() {
        return Ok(StagedBlob {
            staging_id: accepted.content_hash,
            mime: accepted.mime,
            bytes: bytes.len(),
            width: accepted.width,
            height: accepted.height,
        });
    }
    if count_staged(root) >= MAX_STAGED_FILES {
        return Err(ERR_TOO_MANY);
    }

    // Erst vollständig schreiben, dann umbenennen: eine halbe Datei unter einer Kennung, die ihren
    // Inhalt behauptet, wäre eine Lüge, die später niemand mehr erkennt.
    let tmp = root.join(format!("{}.tmp-{}", accepted.content_hash, uuid::Uuid::new_v4().as_simple()));
    std::fs::write(&tmp, bytes).map_err(|_| ERR_IO)?;
    if std::fs::rename(&tmp, &target).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(ERR_IO);
    }
    Ok(StagedBlob {
        staging_id: accepted.content_hash,
        mime: accepted.mime,
        bytes: bytes.len(),
        width: accepted.width,
        height: accepted.height,
    })
}

/// Holt die Bytes zurück. Es wird NACHGERECHNET, dass sie ihre Kennung noch verdienen: eine
/// veränderte Datei ist keine Ablage mehr, sondern ein Fund.
pub fn read_staged(root: &Path, id: &str) -> Result<Vec<u8>, &'static str> {
    if !is_staging_id(id) {
        return Err(ERR_BAD_ID);
    }
    let bytes = std::fs::read(path_for(root, id)).map_err(|_| ERR_NOT_FOUND)?;
    if super::canonical::sha256_hex(&bytes) != id {
        return Err(ERR_NOT_FOUND);
    }
    Ok(bytes)
}

pub fn discard_staged(root: &Path, id: &str) -> Result<(), &'static str> {
    if !is_staging_id(id) {
        return Err(ERR_BAD_ID);
    }
    match std::fs::remove_file(path_for(root, id)) {
        Ok(()) => Ok(()),
        // Schon weg ist auch weg — ein Abräumen darf nicht daran scheitern, dass es zweimal läuft.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ERR_IO),
    }
}

fn count_staged(root: &Path) -> usize {
    match std::fs::read_dir(root) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().extension().map(|x| x == "bin").unwrap_or(false))
            .count(),
        Err(_) => 0,
    }
}

/// Räumt auf, was niemand abgeholt hat. Wird beim Start gerufen — nicht als Zeitgeber im Betrieb:
/// eine Ablage, die während eines laufenden Auftrags verschwände, wäre ein Fehler, den niemand
/// erklären kann.
pub fn sweep_expired(root: &Path, now: SystemTime, ttl: Duration) -> usize {
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        // Auch liegengebliebene `.tmp-…` verschwinden: sie sind der Rest eines abgebrochenen
        // Schreibens und gehören keinem.
        let expired = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age > ttl)
            .unwrap_or(false);
        if expired && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
#[path = "media_staging_tests.rs"]
mod media_staging_tests;
