//! MEDIA-04A-1 — byte-based content classification.
//!
//! Classification is derived exclusively from the actual leading bytes ("magic
//! numbers"), never from a file extension or a client-supplied MIME type. This
//! guarantees that a JPEG renamed `photo.png` is still handled as a JPEG and a
//! `report.jpg` that is really a PDF is rejected.

/// The concrete container the leading bytes describe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Jpeg,
    Png,
    Webp,
    Pdf,
    Other,
}

/// Classify a byte buffer by its magic number. Cheap: only the first few bytes
/// are inspected, so it is safe to call before attempting a full decode.
pub fn sniff_kind(bytes: &[u8]) -> Kind {
    // JPEG: FF D8 FF
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Kind::Jpeg;
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Kind::Png;
    }
    // WebP: "RIFF" .... "WEBP" (RIFF container tagged WEBP)
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Kind::Webp;
    }
    // PDF: "%PDF-"
    if bytes.len() >= 5 && &bytes[0..5] == b"%PDF-" {
        return Kind::Pdf;
    }
    Kind::Other
}
