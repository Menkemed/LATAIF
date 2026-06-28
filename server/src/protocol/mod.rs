//! Frozen A0b operation-protocol contract (protocol v4) — pure & deterministic.
//!
//! ## Determinism / inactivity guarantees
//!
//! Every function here is a pure input → output transformation:
//! - **no** database access (no `rusqlite`),
//! - **no** network or server runtime (no `axum`, no `tokio`),
//! - **no** system clock (no `std::time`, no `chrono::Utc::now`),
//! - **no** randomness and **no** UUIDv4 (only deterministic UUIDv5),
//! - **no** filesystem access in production code (only the tests read fixtures).
//!
//! The module accepts no operations, registers no routes, resolves no handlers
//! and writes to no table. It is the language-neutral A0b contract, ported to a
//! third independent Rust implementation that lives in the server crate.
//!
//! ## Wire model (frozen — mirrors `test/a0b/protocol-spec.md`)
//!
//! - 64-bit DOMAIN values (money `*Fils`, `*Revision`, `serverSequence`) are
//!   canonical i64 decimal **strings** (`^(0|[1-9][0-9]*)$`, max
//!   `9223372036854775807`).
//! - small SCHEMA-bound structural integers are bounded JSON **integers**:
//!   `protocolVersion` (exactly `4`), `mutationCount` / `ordinal` (u32,
//!   `0..=4294967295`).
//! - number rejection is FIELD/SCHEMA based, never a global ban.
//! - validation traversal is DETERMINISTIC (frozen §2.3): object members are
//!   validated in ascending UTF-8 byte order of their names, arrays in index
//!   order, first error wins — the rejected code is insertion-order independent.
//! - LCJ-v4 canonical JSON: NFC normalization **inside** the hash boundary;
//!   ASCII member names sorted by byte; arrays ordered; the payload hash is
//!   SHA-256 over the canonical UTF-8 bytes (lowercase hex).

pub mod canonical;
pub mod cursor;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod integer;
pub mod operation_type;
pub mod ordinal;
pub mod result;
pub mod schema;

pub use error::ProtocolError;

/// Frozen protocol version (a JSON integer on the wire).
pub const PROTOCOL_VERSION: i64 = 4;
