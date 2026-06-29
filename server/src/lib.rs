//! LATAIF server library surface.
//!
//! A1b: the only public library API is the deterministic, side-effect-free
//! [`protocol`] module implementing the frozen A0b operation-protocol contract
//! (protocol v4). It is production code but is **not** wired into the running
//! Axum binary — it accepts no operations, registers no routes, and touches
//! neither database nor network.

pub mod money;
pub mod protocol;
