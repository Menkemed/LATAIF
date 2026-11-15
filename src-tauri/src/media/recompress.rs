//! BILDSPEICHER — ein BESTEHENDES, gespeichertes Bild in einer kleineren Fassung neu schreiben.
//!
//! Das ist die Datei-Hälfte eines Generationswechsels (Migration bestehender Bilder). Die DB-Hälfte
//! (Generation n+1 anlegen, Zeiger umstellen, alte Generation `superseded`) schreibt der Renderer in
//! EINER sql.js-Transaktion — nur er hält die lebende Datenbank; ein Schreiben von hier aus würde von
//! seinem nächsten Speichern überschrieben.
//!
//! Ablauf je Aufruf:
//!   1. Quelle VERIFIZIERT lesen (Pfad im Medienstamm, kein Reparse-Punkt, SHA-256 = genannter Hash).
//!   2. Über denselben Normalisierer neu kodieren (`encode_rendition`) — derselbe Decoder, dieselbe
//!      Qualitätsleiter, derselbe Verkleinerer wie beim Upload; nur die Byte-Grenze ist Parameter.
//!   3. Nur wenn `publish`: inhaltsadressiert und atomar veröffentlichen (temp → fsync → rename; eine
//!      identische vorhandene Datei wird verifiziert wiederverwendet) und danach VERIFIZIERT zurücklesen.
//!
//! Ohne `publish` ist es der Probelauf: es wird nichts geschrieben, nur gemessen. Ein Abbruch zwischen
//! Schritt 3 und dem DB-Commit hinterlässt höchstens eine unverknüpfte Datei — die Medien-GC behandelt
//! sie als Waise (Quarantäne, nie stilles Löschen); ein erneuter Lauf erzeugt bitgleich dieselbe Datei
//! und verwendet sie wieder.
//!
//! Die alte Datei wird hier NIE angefasst.

use super::ingest::{storage_key, IngestError, MediaIngestService};
use super::normalize::{encode_rendition, rendition_budget_ok, Rendition};
use super::{storage, Limits, MediaError};
use serde::Serialize;

/// Ergebnis eines Neu-Kodierens. Keine Pfade, keine Bytes — nur der Inhalt-Steckbrief.
#[derive(Debug, Clone, Serialize)]
pub struct RecompressResult {
    pub rendition: &'static str,
    pub source_hash: String,
    pub source_byte_size: usize,
    pub hash: String,
    pub byte_size: usize,
    pub width: u32,
    pub height: u32,
    pub extension: String,
    pub content_kind: String,
    pub mime_type: String,
    /// Inhaltsadressierter Schlüssel der NEUEN Datei (`<scope>/<xx>/<hash>.jpg`).
    pub storage_key: String,
    /// `true`, wenn die neue Datei veröffentlicht und verifiziert zurückgelesen wurde.
    pub published: bool,
}

fn is_hash64(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn rendition_from_wire(s: &str) -> Result<Rendition, IngestError> {
    match s {
        "main" => Ok(Rendition::Main),
        "thumbnail" => Ok(Rendition::Thumbnail),
        _ => Err(IngestError::InvalidRequest),
    }
}

/// Die eine Operation (siehe Modulkopf).
pub fn recompress_stored(
    svc: &MediaIngestService,
    scope: &str,
    source_hash: &str,
    source_extension: &str,
    rendition: Rendition,
    max_bytes: usize,
    publish: bool,
    // Nur veröffentlichen, wenn die neue Fassung KLEINER als dieser Wert ist (die Mindestersparnis
    // rechnet der Aufrufer aus). So schreibt ein Lauf nie eine Datei, die er gleich wieder verwirft.
    publish_only_below: Option<usize>,
) -> Result<RecompressResult, IngestError> {
    if !storage::is_valid_scope(scope) || !is_hash64(source_hash) || source_extension != "jpg" {
        return Err(IngestError::InvalidRequest);
    }
    if !rendition_budget_ok(rendition, max_bytes) {
        return Err(IngestError::Core(MediaError::InvalidSizeProfile));
    }
    // 1) verifiziert lesen (Hash wird beim Lesen geprüft)
    let source = svc.read(scope, source_hash, source_extension)?;
    // 2) derselbe Normalisierer
    let desc = encode_rendition(&source.bytes, &Limits::default(), rendition, max_bytes)?;
    let key = storage_key(scope, &desc.hash);
    let mut published = false;
    let worth_it = publish_only_below.map_or(true, |t| desc.byte_size < t);
    if publish && worth_it {
        // 3) atomar, inhaltsadressiert; danach verifiziert zurücklesen
        storage::publish_atomically(svc.media_root(), scope, &desc.bytes, &desc.hash, &desc.extension)?;
        let back = svc.read(scope, &desc.hash, &desc.extension)?;
        if back.byte_size != desc.byte_size || back.hash != desc.hash {
            return Err(IngestError::Core(MediaError::FileHashMismatch));
        }
        published = true;
    }
    Ok(RecompressResult {
        rendition: match rendition {
            Rendition::Main => "main",
            Rendition::Thumbnail => "thumbnail",
        },
        source_hash: source_hash.to_string(),
        source_byte_size: source.byte_size,
        hash: desc.hash,
        byte_size: desc.byte_size,
        width: desc.width,
        height: desc.height,
        extension: desc.extension,
        content_kind: desc.content_kind,
        mime_type: desc.mime_type,
        storage_key: key,
        published,
    })
}

#[cfg(test)]
#[path = "recompress_tests.rs"]
mod recompress_tests;
