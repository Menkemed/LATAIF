//! POST-PARITY R7B PP-12 — EIN Bildweg für Belegbilder.
//!
//! Reparatur-, Altgold-, Ausweis-, Einkaufs- und Auftragsfotos wohnen weiter in ihrer Zeile (als
//! Daten-URL) — anders als das Artikelbild, das der Medienspeicher als Datei führt. Bis hierher kamen
//! sie dort ohne Byte-Grenze an: die Browser-Kompression war ein Ziel (800 px, Qualität 0,7), keine
//! Grenze, und der Primary prüfte nichts. Jetzt geht jedes NEUE Belegbild vor dem Speichern durch
//! DENSELBEN Normalisierer wie das Artikelbild (`normalize_stock_image`): Byte-Sniff (JPEG/PNG/WebP),
//! dieselben Eingangsgrenzen wie der mobile Eingang und die Zwischenablage (25 MiB, 8192 px, 24 MP),
//! EXIF-Ausrichtung, Metadaten weg, JPEG ≤ 100 000 B und ≤ 1600 px — oder ein Nein mit festem Code.
//!
//! Ein Vorschaubild (≤ 20 000 B) entsteht hier bewusst NICHT: die Zeile trägt je Eintrag genau ein
//! Bild, und keine Liste zeigt eine eigene Vorschau. Das Vorschaubild gehört zum Medienspeicher.

use super::{normalize_stock_image, Limits, MediaDescriptor};
use crate::sync::mobile_upload::{MAX_UPLOAD_IMAGE_BYTES, MAX_UPLOAD_IMAGE_DIM, MAX_UPLOAD_IMAGE_PIXELS};

/// Größer als der größte Eingang, den das Haus annimmt (dieselbe Grenze wie am mobilen Eingang).
pub const ERR_RECORD_IMAGE_TOO_LARGE: &str = "MEDIA_IMAGE_TOO_LARGE";

/// Die Eingangsgrenzen des Hauses für ein Foto — dieselben wie `/api/mobile/upload` und die Ablage.
pub fn record_image_limits() -> Limits {
    Limits {
        max_input_dim: MAX_UPLOAD_IMAGE_DIM,
        max_input_pixels: MAX_UPLOAD_IMAGE_PIXELS,
    }
}

/// Ist das schon ein gespeichertes Belegbild? JPEG, ≤ 100 000 B, beide Seiten ≤ 1600 px, KEIN
/// Metadaten-Segment (APP1…APP15: EXIF, XMP, ICC …) vor den Bilddaten, und es dekodiert vollständig.
/// Dann bleibt es Byte für Byte — ein zweites Rechnen verlöre nur Qualität (Generationsverlust).
fn already_stored_form(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() > RECORD_IMAGE_MAX_BYTES || bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        if marker == 0xDA {
            break; // Bilddaten beginnen — davor stand kein Metadaten-Segment.
        }
        if (0xE1..=0xEF).contains(&marker) {
            return None;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 || w > RECORD_IMAGE_MAX_DIM || h > RECORD_IMAGE_MAX_DIM {
        return None;
    }
    Some((w, h))
}

/// Die Grenzen des gespeicherten Belegbilds — dieselben wie das Hauptbild des Medienspeichers.
pub const RECORD_IMAGE_MAX_BYTES: usize = 100_000;
pub const RECORD_IMAGE_MAX_DIM: u32 = 1600;

/// Ein Belegbild → das gespeicherte (JPEG, ≤ 100 000 B, ≤ 1600 px, ohne Metadaten) oder der Code des
/// Neins. Was schon genau diese Form hat (z. B. am aufnehmenden Rechner normalisiert), bleibt Byte für
/// Byte und wird nur geprüft — damit ist die Funktion idempotent und am Primary billig.
pub fn normalize_record_image(bytes: &[u8]) -> Result<MediaDescriptor, String> {
    if bytes.len() > MAX_UPLOAD_IMAGE_BYTES {
        return Err(ERR_RECORD_IMAGE_TOO_LARGE.to_string());
    }
    if let Some((width, height)) = already_stored_form(bytes) {
        return Ok(MediaDescriptor {
            bytes: bytes.to_vec(),
            hash: super::sha256_hex(bytes),
            byte_size: bytes.len(),
            extension: "jpg".to_string(),
            content_kind: "raster_image".to_string(),
            mime_type: "image/jpeg".to_string(),
            width,
            height,
        });
    }
    normalize_stock_image(bytes, &record_image_limits()).map_err(|e| e.code().to_string())
}

/// Dieselbe Antwort wie `staging_media_read` (`mime`, `bytes`, `dataBase64`) plus die Maße.
pub fn record_image_json(bytes: &[u8]) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let d = normalize_record_image(bytes)?;
    Ok(serde_json::json!({
        "mime": d.mime_type,
        "bytes": d.byte_size,
        "width": d.width,
        "height": d.height,
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(&d.bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn noise(w: u32, h: u32, seed: u32) -> image::RgbImage {
        let mut s = seed;
        image::RgbImage::from_fn(w, h, |_, _| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            image::Rgb([s as u8, (s >> 8) as u8, (s >> 16) as u8])
        })
    }

    fn jpeg(img: &image::RgbImage, q: u8) -> Vec<u8> {
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut buf), q)
            .encode(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    #[test]
    fn a_large_photo_becomes_a_jpeg_of_at_most_100_000_bytes() {
        let src = jpeg(&noise(3000, 2000, 7), 92);
        assert!(src.len() > 1_000_000, "the fixture must be far over the limit: {}", src.len());
        let d = normalize_record_image(&src).unwrap();
        assert!(d.byte_size <= 100_000, "{}", d.byte_size);
        assert_eq!(d.byte_size, d.bytes.len());
        assert_eq!(d.mime_type, "image/jpeg");
        assert!(d.width.max(d.height) <= 1600);
        assert!(image::load_from_memory(&d.bytes).is_ok());
    }

    #[test]
    fn the_answer_is_the_staging_shape_with_the_normalized_bytes() {
        use base64::Engine;
        let src = jpeg(&noise(1200, 900, 11), 90);
        let v = record_image_json(&src).unwrap();
        assert_eq!(v["mime"], "image/jpeg");
        let b = base64::engine::general_purpose::STANDARD.decode(v["dataBase64"].as_str().unwrap()).unwrap();
        assert_eq!(b.len() as u64, v["bytes"].as_u64().unwrap());
        assert!(b.len() <= 100_000);
        assert!(v["width"].as_u64().unwrap() <= 1600 && v["height"].as_u64().unwrap() <= 1600);
    }

    #[test]
    fn the_stored_form_stays_byte_for_byte_and_normalizing_is_idempotent() {
        let first = normalize_record_image(&jpeg(&noise(2400, 1600, 21), 90)).unwrap();
        let again = normalize_record_image(&first.bytes).unwrap();
        assert_eq!(again.bytes, first.bytes, "a stored photo is only checked, never computed a second time");
        let small = jpeg(&noise(300, 200, 5), 70);
        assert!(small.len() <= 100_000);
        assert_eq!(normalize_record_image(&small).unwrap().bytes, small, "already in the stored form");
    }

    #[test]
    fn metadata_or_size_outside_the_stored_form_is_computed() {
        // A small JPEG WITH an APP1 (EXIF) segment: under 100 KB, but not the stored form.
        let plain = jpeg(&noise(300, 200, 6), 70);
        let mut with_exif = vec![0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x0E];
        with_exif.extend_from_slice(b"Exif\0\0GPS-X\0");
        with_exif.extend_from_slice(&plain[2..]);
        let out = normalize_record_image(&with_exif).unwrap();
        assert_ne!(out.bytes, with_exif);
        assert!(!out.bytes.windows(6).any(|w| w == b"Exif\0\0"), "metadata removed");
        // Wider than 1600 px, even if small in bytes: computed down.
        let wide = jpeg(&image::RgbImage::from_pixel(2000, 100, image::Rgb([200, 200, 200])), 80);
        assert!(wide.len() <= 100_000);
        let d = normalize_record_image(&wide).unwrap();
        assert!(d.width <= 1600 && d.bytes != wide);
        // A PNG is never the stored form.
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(noise(64, 64, 8)).write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        assert_eq!(normalize_record_image(&png).unwrap().mime_type, "image/jpeg");
    }

    #[test]
    fn not_an_image_is_a_fixed_no() {
        assert_eq!(normalize_record_image(b"%PDF-1.7\n").unwrap_err(), "MEDIA_UNSUPPORTED_CONTENT");
        assert_eq!(normalize_record_image(b"").unwrap_err(), "MEDIA_UNSUPPORTED_CONTENT");
        let mut broken = vec![0xFF, 0xD8, 0xFF];
        broken.extend_from_slice(&[0u8; 64]);
        assert_eq!(normalize_record_image(&broken).unwrap_err(), "MEDIA_IMAGE_DECODE_FAILED");
    }

    /// Fotoähnliche Vorlage für die Messungen: Verlauf, Formen, leichtes Rauschen.
    fn photo(w: u32, h: u32, seed: u32) -> image::RgbImage {
        let mut s = seed;
        let mut rnd = move || { s ^= s << 13; s ^= s >> 17; s ^= s << 5; s };
        let circles: Vec<(i64, i64, i64, [u8; 3])> = (0..600)
            .map(|_| ((rnd() % w) as i64, (rnd() % h) as i64, (4 + rnd() % 60) as i64, [rnd() as u8, (rnd() >> 8) as u8, (rnd() >> 16) as u8]))
            .collect();
        image::RgbImage::from_fn(w, h, |x, y| {
            let mut p = [(40 + x * 180 / w) as u8, (70 + y * 120 / h) as u8, (110 + (x + y) * 80 / (w + h)) as u8];
            for (cx, cy, r, c) in circles.iter().take(80) {
                let (dx, dy) = (x as i64 - cx, y as i64 - cy);
                if dx * dx + dy * dy < r * r { p = *c; }
            }
            let n = ((x.wrapping_mul(2654435761) ^ y.wrapping_mul(40503)) % 36) as i16 - 18;
            image::Rgb([(p[0] as i16 + n).clamp(0, 255) as u8, (p[1] as i16 + n).clamp(0, 255) as u8, (p[2] as i16 + n).clamp(0, 255) as u8])
        })
    }

    /// Messung (nicht im normalen Lauf): `cargo test --release --lib media::record_image::tests::bench -- --ignored --nocapture`.
    /// Fotoähnliche Vorlagen und reines Rauschen als Obergrenze.
    #[test]
    #[ignore]
    fn bench_normalize_times() {
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("photo 3000x2000 q92", jpeg(&photo(3000, 2000, 3), 92)),
            ("photo 1600x1067 q85 (desktop/phone capture)", jpeg(&photo(1600, 1067, 5), 85)),
            ("photo 800x533 q70 (old desktop capture)", jpeg(&photo(800, 533, 7), 70)),
            ("noise 3000x2000 q92 (upper bound)", jpeg(&noise(3000, 2000, 9), 92)),
        ];
        for (name, src) in &cases {
            let t = std::time::Instant::now();
            let d = normalize_record_image(src).unwrap();
            let rec = t.elapsed();
            let t2 = std::time::Instant::now();
            let th = super::super::create_thumbnail(src, &record_image_limits()).unwrap();
            let thumb = t2.elapsed();
            println!("BENCH {name}: in {} B -> main {} B {}x{} in {} ms; thumbnail {} B in {} ms",
                src.len(), d.byte_size, d.width, d.height, rec.as_millis(), th.byte_size, thumb.as_millis());
        }
    }

    /// Aufnahmeprofil 800 vs. 1600 px auf den echten Wegen (nicht im normalen Lauf):
    /// `cargo test --release --lib media::record_image::tests::bench_capture -- --ignored --nocapture`.
    /// Artikel = 8 Aufnahmen (Höchstzahl eines Artikels), je Aufnahme `normalize_stock_image` + `create_thumbnail`
    /// mit `Limits::default()` — genau das Vorbereiten in `ingest.rs`, das der Primary IM Befehl rechnet.
    /// Belegbild = `normalize_record_image`. Jede Aufnahme trägt ein APP1-Segment (wie eine Aufnahme mit
    /// Metadaten) und ist damit nicht die gespeicherte Form, wird also gerechnet. Der Hash der Ausgabe macht
    /// Debug- und Release-Lauf vergleichbar (gleiche Bytes → die im Debug-Fenster gemessene Qualität gilt).
    #[test]
    #[ignore]
    fn bench_capture_profile() {
        use sha2::{Digest, Sha256};
        fn with_app1(plain: &[u8]) -> Vec<u8> {
            let mut v = vec![0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x0E];
            v.extend_from_slice(b"Exif\0\0GPS-X\0");
            v.extend_from_slice(&plain[2..]);
            v
        }
        let limits = Limits::default();
        for (name, w, h, q) in [("800x533 q70", 800u32, 533u32, 70u8), ("1600x1067 q85", 1600, 1067, 85)] {
            let shots: Vec<Vec<u8>> = (0..8u32).map(|i| with_app1(&jpeg(&photo(w, h, 11 + i), q))).collect();
            let mut hash = Sha256::new();
            let (mut main_max, mut thumb_max) = (0u64, 0u64);
            let t = std::time::Instant::now();
            for s in &shots {
                let m = normalize_stock_image(s, &limits).unwrap();
                let th = super::super::create_thumbnail(s, &limits).unwrap();
                main_max = main_max.max(m.byte_size as u64);
                thumb_max = thumb_max.max(th.byte_size as u64);
                hash.update(&m.bytes);
                hash.update(&th.bytes);
            }
            let article = t.elapsed();
            let mut rec_hash = Sha256::new();
            let mut rec_dims = (0u32, 0u32);
            let t2 = std::time::Instant::now();
            for s in &shots {
                let r = normalize_record_image(s).unwrap();
                assert!(r.bytes != *s, "a capture with metadata is not the stored form");
                rec_dims = (r.width, r.height);
                rec_hash.update(&r.bytes);
            }
            let record = t2.elapsed();
            let hex = |d: &[u8]| d.iter().take(6).map(|b| format!("{b:02x}")).collect::<String>();
            println!("CAPTURE {name}: in {}..{} B; article 8 x (main + thumbnail) {} ms ({} ms/photo), main <= {} B, thumbnail <= {} B, out {}; record 8 x {} ms ({} ms/photo) {}x{}, out {}",
                shots.iter().map(|s| s.len()).min().unwrap(), shots.iter().map(|s| s.len()).max().unwrap(),
                article.as_millis(), article.as_millis() / 8, main_max, thumb_max, hex(&hash.finalize()),
                record.as_millis(), record.as_millis() / 8, rec_dims.0, rec_dims.1, hex(&rec_hash.finalize()));
        }
    }

    #[test]
    fn the_house_input_limits_apply() {
        assert_eq!(record_image_limits().max_input_dim, 8192);
        assert_eq!(record_image_limits().max_input_pixels, 24 * 1024 * 1024);
        let too_big = vec![0u8; MAX_UPLOAD_IMAGE_BYTES + 1];
        assert_eq!(normalize_record_image(&too_big).unwrap_err(), ERR_RECORD_IMAGE_TOO_LARGE);
    }
}
