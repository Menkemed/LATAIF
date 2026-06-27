# LATAIF Sync Server

This folder is, from now on, the **tracked server source-of-truth** of the LATAIF
main repository. It is a normal directory of the main repo — **not** a submodule
and **not** its own git repository.

## Build / check

```bash
cargo check --manifest-path server/Cargo.toml
```

## Hard rules

- Runtime databases, secrets, `target/`, logs and binaries must **never** be
  committed (see `.gitignore`).
- `DATABASE_PATH` must always point at a **temporary** database in tests.
- The real production / user database must **never** be opened in tests.
