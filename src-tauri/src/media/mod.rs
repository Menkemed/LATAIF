//! MEDIA-04A-1 — Guarded local image storage core (INACTIVE).
//!
//! This module is the isolated Rust core for safely turning an untrusted local
//! image into a durable, size-bounded, content-addressed file. It is deliberately
//! **not yet wired** to any Tauri command, React caller or the productive
//! database — it exists only to be exercised by its own `cargo test` suite. A
//! later slice will expose it. The `allow(dead_code)`/`unused_imports` reflect
//! that inactivity: the public API surface is re-exported but not yet consumed
//! outside the module's own `cargo test` suite.
#![allow(dead_code, unused_imports)]

mod detect;
mod normalize;
mod storage;

pub use normalize::{create_thumbnail, inspect_image_bytes, normalize_stock_image};
pub use storage::{
    derive_storage_path, publish_atomically, read_verified_media, resolve_within_root, sha256_hex,
    Published,
};

/// Stable, safe error codes surfaced by the media core. `code()` returns the
/// canonical string used as the wire/error contract; no error carries a path or
/// other potentially sensitive detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaError {
    /// Bytes are not a supported raster image (PDF, unknown binary, …).
    UnsupportedContent,
    /// Bytes claim to be a raster image but cannot be decoded.
    ImageDecodeFailed,
    /// Header dimensions/pixel count exceed the configured input limits.
    ImageTooLarge,
    /// No acceptable rendition fits the byte budget above the usable floor.
    ImageDetailInsufficient,
    /// A derived path would escape the media root (traversal/absolute path).
    PathOutsideRoot,
    /// A path component inside the media root is a symlink/junction/reparse
    /// point that could redirect reads or writes outside the root.
    PathReparsePointForbidden,
    /// A stored file at the expected hash path is larger than any rendition this
    /// writer can produce, so it is refused before being read into memory.
    FileTooLarge,
    /// A content hash is not exactly 64 lower-case hex characters.
    InvalidHash,
    /// An extension outside the allow-list was requested.
    InvalidExtension,
    /// A stored file expected to exist is missing.
    FileMissing,
    /// Stored bytes do not hash to the expected content hash.
    FileHashMismatch,
    /// Filesystem error (kind only, never a path).
    Io(String),
}

impl MediaError {
    pub fn code(&self) -> &'static str {
        match self {
            MediaError::UnsupportedContent => "MEDIA_UNSUPPORTED_CONTENT",
            MediaError::ImageDecodeFailed => "MEDIA_IMAGE_DECODE_FAILED",
            MediaError::ImageTooLarge => "MEDIA_IMAGE_TOO_LARGE",
            MediaError::ImageDetailInsufficient => "MEDIA_IMAGE_DETAIL_INSUFFICIENT",
            MediaError::PathOutsideRoot => "MEDIA_PATH_OUTSIDE_ROOT",
            MediaError::PathReparsePointForbidden => "MEDIA_PATH_REPARSE_POINT_FORBIDDEN",
            MediaError::FileTooLarge => "MEDIA_FILE_TOO_LARGE",
            MediaError::InvalidHash => "MEDIA_INVALID_HASH",
            MediaError::InvalidExtension => "MEDIA_INVALID_EXTENSION",
            MediaError::FileMissing => "MEDIA_FILE_MISSING",
            MediaError::FileHashMismatch => "MEDIA_FILE_HASH_MISMATCH",
            MediaError::Io(_) => "MEDIA_IO_ERROR",
        }
    }
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for MediaError {}

/// The content container a byte buffer describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentKind {
    RasterImage,
    Pdf,
    Other,
}

impl ContentKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContentKind::RasterImage => "raster_image",
            ContentKind::Pdf => "pdf",
            ContentKind::Other => "other",
        }
    }
}

/// Configurable input resource limits (injectable so tests can trip the guard
/// without allocating a real decode bomb).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_input_dim: u32,
    pub max_input_pixels: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_input_dim: 12_000,
            max_input_pixels: 40_000_000,
        }
    }
}

/// Result of [`inspect_image_bytes`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inspection {
    pub kind: ContentKind,
    pub width: u32,
    pub height: u32,
}

/// A produced, size-bounded rendition and its content-address metadata.
#[derive(Debug, Clone)]
pub struct MediaDescriptor {
    pub bytes: Vec<u8>,
    pub hash: String,
    pub extension: String,
    pub content_kind: String,
    pub mime_type: String,
    pub byte_size: usize,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests;
