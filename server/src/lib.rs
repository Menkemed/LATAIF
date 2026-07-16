//! LATAIF server library surface.
//!
//! A1b: the [`protocol`] module is the deterministic, side-effect-free
//! implementation of the frozen A0b operation-protocol contract (protocol v4).
//! It is production code but is **not** wired into the running Axum binary — it
//! accepts no operations, registers no routes, and touches neither database nor
//! network.
//!
//! M6-B1: [`migrations`] is exported so the **embedded** Tauri sync server
//! (`src-tauri/src/sync/`) reuses this exact runner instead of growing a second
//! one. It is the shared core; each server passes its OWN migration list to
//! [`migrations::run_migrations`], so the lists stay independent while the
//! versioning, checksum and drift-detection rules have a single implementation.
//! Unlike [`protocol`], it does touch a database — it is not side-effect-free.

pub mod migrations;
pub mod money;
pub mod protocol;
