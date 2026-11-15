//! BILDSPEICHER — Größenklassen + Neu-Kodieren bestehender Bilder. Nur temporäre Wurzeln.

use super::*;
use crate::media::ingest::{canonical_request_hash, canonical_request_hash_profiled, MediaIngestService};
use crate::media::{create_thumbnail_profiled, normalize_stock_image, normalize_stock_image_profiled, SizeProfile};
use std::path::{Path, PathBuf};

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("lataif_recompress_{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        TempRoot(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const SCOPE: &str = "tenant-1";

/// Ein Foto-ähnliches Bild mit viel Struktur (Rauschen + Verlauf): groß genug, dass 30/60 KB
/// nur mit Qualitäts- bzw. Größenabschlag erreichbar sind.
fn textured_jpeg(w: u32, h: u32) -> Vec<u8> {
    let mut img = image::RgbImage::new(w, h);
    let mut s: u32 = 0x1234_5678;
    for y in 0..h {
        for x in 0..w {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let n = (s >> 24) as u8;
            img.put_pixel(x, y, image::Rgb([n / 2 + (x % 128) as u8, n / 3 + (y % 128) as u8, n]));
        }
    }
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::Cursor::new(&mut buf), 95)
        .encode(img.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .unwrap();
    buf
}

/// Das gespeicherte „100-KB-Hauptbild“ eines Altbestands erzeugen und veröffentlichen.
fn store_legacy_main(svc: &MediaIngestService, src: &[u8]) -> (String, usize) {
    let d = normalize_stock_image(src, &Limits::default()).unwrap();
    storage::publish_atomically(svc.media_root(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap();
    (d.hash, d.byte_size)
}

fn files_under(root: &Path) -> usize {
    fn walk(p: &Path, n: &mut usize) {
        for e in std::fs::read_dir(p).unwrap().flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(&path, n)
            } else {
                *n += 1
            }
        }
    }
    let mut n = 0;
    walk(root, &mut n);
    n
}

#[test]
fn profiles_respect_their_budgets() {
    let src = textured_jpeg(2000, 1500);
    for (p, main_max, thumb_max) in [
        (SizeProfile::Standard, 100_000, 20_000),
        (SizeProfile::Main60, 60_000, 10_000),
        (SizeProfile::Main30, 30_000, 10_000),
    ] {
        let m = normalize_stock_image_profiled(&src, &Limits::default(), p).unwrap();
        let t = create_thumbnail_profiled(&src, &Limits::default(), p).unwrap();
        assert!(m.byte_size <= main_max, "{p:?} main {}", m.byte_size);
        assert!(t.byte_size <= thumb_max, "{p:?} thumb {}", t.byte_size);
        assert_eq!(m.extension, "jpg");
        assert_eq!(p.main_max_bytes(), main_max);
        assert_eq!(p.thumb_max_bytes(), thumb_max);
    }
}

#[test]
fn standard_profile_hash_is_bit_identical_to_the_old_one() {
    let src = textured_jpeg(64, 64);
    assert_eq!(canonical_request_hash(SCOPE, &src), canonical_request_hash_profiled(SCOPE, &src, SizeProfile::Standard));
    assert_eq!(SizeProfile::Standard.norm_params(), "main<=100000;thumb<=20000;out=jpeg");
    let h60 = canonical_request_hash_profiled(SCOPE, &src, SizeProfile::Main60);
    let h30 = canonical_request_hash_profiled(SCOPE, &src, SizeProfile::Main30);
    assert_ne!(h60, canonical_request_hash(SCOPE, &src));
    assert_ne!(h60, h30);
}

#[test]
fn wire_names_round_trip_and_unknown_is_refused() {
    assert_eq!(SizeProfile::from_wire(None).unwrap(), SizeProfile::Standard);
    for p in [SizeProfile::Standard, SizeProfile::Main60, SizeProfile::Main30] {
        assert_eq!(SizeProfile::from_wire(Some(p.wire())).unwrap(), p);
    }
    assert_eq!(SizeProfile::from_wire(Some("main10")), Err(MediaError::InvalidSizeProfile));
    assert_eq!(SizeProfile::from_wire(Some("")), Err(MediaError::InvalidSizeProfile));
}

#[test]
fn prepare_profiled_binds_the_profile_into_the_request_hash() {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let src = textured_jpeg(1800, 1200);
    let id = "22222222-2222-4222-8222-222222222222";
    // Standard-Hash, aber Klasse 30 → Konflikt, nichts wird geschrieben.
    let std_hash = canonical_request_hash(SCOPE, &src);
    let e = svc.prepare_profiled(SCOPE, id, &std_hash, &src, None, SizeProfile::Main30).unwrap_err();
    assert_eq!(e, IngestError::RequestConflict);
    // Passender Hash → Hauptbild ≤ 30 KB, Vorschau ≤ 10 KB.
    let h30 = canonical_request_hash_profiled(SCOPE, &src, SizeProfile::Main30);
    let r = svc.prepare_profiled(SCOPE, id, &h30, &src, None, SizeProfile::Main30).unwrap();
    assert!(r.main_descriptor.byte_size <= 30_000);
    assert!(r.thumbnail_descriptor.byte_size <= 10_000);
    let c = svc.commit(SCOPE, id, &h30).unwrap();
    assert!(c.main_descriptor.byte_size <= 30_000);
}

#[test]
fn dry_run_writes_nothing_and_publish_is_verified_and_idempotent() {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let src = textured_jpeg(2000, 1500);
    let (old_hash, old_size) = store_legacy_main(&svc, &src);
    assert!(old_size > 60_000, "Testbild muss über 60 KB liegen ({old_size})");
    let before = files_under(root.path());

    let dry = recompress_stored(&svc, SCOPE, &old_hash, "jpg", Rendition::Main, 60_000, false, None).unwrap();
    assert!(!dry.published);
    assert!(dry.byte_size <= 60_000 && dry.byte_size < old_size);
    assert_eq!(files_under(root.path()), before, "Probelauf darf nichts schreiben");

    let real = recompress_stored(&svc, SCOPE, &old_hash, "jpg", Rendition::Main, 60_000, true, None).unwrap();
    assert!(real.published);
    assert_eq!(real.hash, dry.hash, "Probelauf und Lauf rechnen bitgleich");
    assert_eq!(real.storage_key, format!("{SCOPE}/{}/{}.jpg", &real.hash[0..2], real.hash));
    assert_eq!(files_under(root.path()), before + 1);
    // Wiederholung (Wiederaufnahme nach Absturz): dieselbe Datei, keine zweite.
    let again = recompress_stored(&svc, SCOPE, &old_hash, "jpg", Rendition::Main, 60_000, true, None).unwrap();
    assert_eq!(again.hash, real.hash);
    assert_eq!(files_under(root.path()), before + 1);
    // Die alte Datei bleibt unverändert lesbar.
    let old = svc.read(SCOPE, &old_hash, "jpg").unwrap();
    assert_eq!(old.byte_size, old_size);

    // Vorschau aus dem ALTEN Hauptbild, ≤ 10 KB.
    // Schwelle: über der Schwelle wird NICHT veröffentlicht.
    let n0 = files_under(root.path());
    let skip = recompress_stored(&svc, SCOPE, &old_hash, "jpg", Rendition::Main, 30_000, true, Some(1_000)).unwrap();
    assert!(!skip.published && skip.byte_size > 1_000);
    assert_eq!(files_under(root.path()), n0, "nichts geschrieben");

    let th = recompress_stored(&svc, SCOPE, &old_hash, "jpg", Rendition::Thumbnail, 10_000, true, None).unwrap();
    assert!(th.byte_size <= 10_000 && th.width.max(th.height) <= 256);
}

#[test]
fn bad_inputs_are_refused_without_reading_or_writing() {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let src = textured_jpeg(400, 300);
    let (h, _) = store_legacy_main(&svc, &src);
    let before = files_under(root.path());
    for (r, b) in [(Rendition::Main, 9_999), (Rendition::Main, 100_001), (Rendition::Thumbnail, 3_999), (Rendition::Thumbnail, 20_001)] {
        let e = recompress_stored(&svc, SCOPE, &h, "jpg", r, b, true, None).unwrap_err();
        assert_eq!(e.code(), "MEDIA_SIZE_PROFILE_INVALID");
    }
    assert_eq!(recompress_stored(&svc, SCOPE, "zz", "jpg", Rendition::Main, 30_000, true, None).unwrap_err(), IngestError::InvalidRequest);
    assert_eq!(recompress_stored(&svc, SCOPE, &h, "pdf", Rendition::Main, 30_000, true, None).unwrap_err(), IngestError::InvalidRequest);
    assert_eq!(recompress_stored(&svc, "../x", &h, "jpg", Rendition::Main, 30_000, true, None).unwrap_err(), IngestError::InvalidRequest);
    let missing = "a".repeat(64);
    assert_eq!(recompress_stored(&svc, SCOPE, &missing, "jpg", Rendition::Main, 30_000, true, None).unwrap_err().code(), "MEDIA_FILE_MISSING");
    assert_eq!(files_under(root.path()), before);
}

#[test]
fn a_tampered_source_is_never_recompressed() {
    let root = TempRoot::new();
    let svc = MediaIngestService::new(root.path().to_path_buf());
    let src = textured_jpeg(400, 300);
    let (h, _) = store_legacy_main(&svc, &src);
    let p = root.path().join(SCOPE).join(&h[0..2]).join(format!("{h}.jpg"));
    let mut b = std::fs::read(&p).unwrap();
    let n = b.len();
    b[n / 2] ^= 0xff;
    std::fs::write(&p, &b).unwrap();
    let e = recompress_stored(&svc, SCOPE, &h, "jpg", Rendition::Main, 30_000, true, None).unwrap_err();
    assert_eq!(e.code(), "MEDIA_FILE_HASH_MISMATCH");
}

/// Die schnelle Suche wählt für jedes Bild GENAU dasselbe wie die einfache Leiter (Bytes gleich).
#[test]
fn the_fast_budget_search_picks_exactly_what_the_simple_ladder_picks() {
    use crate::media::normalize::{encode_within_budget_for_test, encode_within_budget_reference};
    let mk = |w: u32, h: u32, amp: u32, seed: u32| {
        let mut img = image::RgbImage::new(w, h);
        let mut s: u32 = seed;
        for y in 0..h {
            for x in 0..w {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let n = ((s >> 24) % amp.max(1)) as u32;
                img.put_pixel(x, y, image::Rgb([((x * 255 / w) + n) as u8, ((y * 255 / h) + n / 2) as u8, (n * 2) as u8]));
            }
        }
        img
    };
    let mut cases = 0;
    for (w, h, amp, seed) in [(640, 480, 200, 1), (640, 480, 40, 2), (480, 640, 90, 3), (300, 200, 255, 4)] {
        let img = mk(w, h, amp, seed);
        for budget in [100_000usize, 60_000, 30_000, 15_000, 10_000, 6_000] {
            let fast = encode_within_budget_for_test(&img, 640, 96, budget);
            let slow = encode_within_budget_reference(&img, 640, 96, budget);
            match (fast, slow) {
                (Ok(a), Ok(b)) => assert!(a.0 == b.0 && a.1 == b.1 && a.2 == b.2, "{w}x{h} amp {amp} budget {budget}"),
                (Err(a), Err(b)) => assert_eq!(a, b),
                (a, b) => panic!("{w}x{h} budget {budget}: {:?} vs {:?}", a.map(|x| x.0.len()), b.map(|x| x.0.len())),
            }
            cases += 1;
        }
    }
    assert_eq!(cases, 24);
}
