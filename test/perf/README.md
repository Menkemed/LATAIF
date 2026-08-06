# LATAIF Performance Suite

Reproducible, **non-destructive** performance baselines for the critical ERP workflows. Nothing here ever
opens or copies the production DB or the production media root; there is no real customer data.

## Run it

```bash
node test/perf/run.mjs smoke     # SMALL fixture — fast baseline (fits a normal dev gate)
node test/perf/run.mjs full      # MEDIUM fixture — realistic production volume
node test/perf/run.mjs large     # LARGE fixture — elevated load, run on demand
node test/perf/run.mjs baseline  # MEDIUM + (re)write test/perf/baseline.json
```

The real app suites run on the **release e2e** WebView2 build:

```bash
node test/perf/scenarios-app.mjs   # real startup (3 cold / 7 warm) + owner-gated GC + mobile ingress
node test/perf/scenarios-ui.mjs    # real UI: list/search/detail/invoice-open (7 reps) + full invoice flow (3)
```

Results (JSON + a Markdown summary) are written under `test/perf/artifacts/` (git-ignored — regenerate
locally). The committed `test/perf/baseline.json` holds p50/p95 per scenario, **separated by measurement class**
(see "Baseline classes" below) — numbers from different runtimes are never mixed into one p50.

Unit tests (`test/perf.test.ts`, part of the node sweep) prove the fixtures are **deterministic** and the
stats helper is correct.

## Fixture sizes

Deterministic, fixed-seed. Exact counts are recorded in every report and in `baseline.json`:

| size | products | customers | invoices | media files |
|---|--:|--:|--:|--:|
| SMALL  | 200 | 60 | 120 | ~88 |
| MEDIUM | 3000 | 800 | 2400 | ~1980 |
| LARGE  | 20000 | 4000 | 15000 | ~13000 |

Built from the **real** production business schema (`src/core/db/schema.sql`, 26 tables + indexes) plus a
lean `media_blob_generations` mirroring the columns the perf scenarios read. Invoices carry 1–4 lines with a
deterministic mix of fully-paid / partial / open balances; ~⅕ of media products carry a second (pinned)
generation. Every scenario **validates a business result** (count/total), so a fast-but-wrong query fails.

## Scenario groups

- **DB-layer** (`scenarios-db.mjs`) — inventory list, exact-SKU / brand / name search, no-hit, status filter,
  price sort, product detail, customer search, invoice list/open, finance totals + by-status aggregation,
  and a per-brand revenue join. Measured against the same SQLite engine the app's SQL.js uses.
- **Media-GC dry-run** — reference build (`SELECT storage_key`), filesystem scan, and the orphan diff — the
  same work the Rust `plan` does.
- **Backup selection** — the referenced-media enumeration.
- **Real Tauri/WebView2 app** (`scenarios-app.mjs`) — cold/warm startup to health-200 + interactive route, a
  real owner-gated GC dry-run over the running app, and a mobile upload ingress, all on an **isolated** app
  id / AppData / test port (production port 3001 + prod DB untouched).
- **Real UI** (`scenarios-ui.mjs`) — over the release e2e WebView2 build with a pre-seeded MEDIUM fixture:
  inventory/customers/invoices list, dashboard, product detail, invoice open, and SKU search each run **7
  measured reps** with a per-rep state reset (navigate away / clear the box), plus the **full sales invoice
  flow** (`ui.invoice.create`, 3 isolated reps): open the create form, pick a seeded customer via the real
  customer search, add **3** products via the real product search, set qty + gross, validate Net/VAT/Gross/
  Remaining on the form, save, find the new number in the invoice list, reopen it, and re-validate lines /
  customer / gross / VAT / paid / remaining. Each rep uses a unique customer + number; the timing end marker
  is the re-validated detail, never a fixed sleep.

## Reading the numbers & regression rules

- `cold` = fresh connection/boot; `warm` = repeated. Reported separately.
- `p95` is marked `*` (estimate) below 20 samples. Outliers are **never** dropped — they show up in `max`/`stddev`.
- Numbers are **machine-specific**. Do **not** compare across different hardware — only relative regression on
  the same machine is meaningful.
- Suggested budgets (I1 is a baseline, not a hard target factory):
  - **Hard fail** only on: timeout / crash / error / wrong business result / a memory-leak indicator (leftover
    process, growing temp dir, unreleased listener) / a *massive* regression (e.g. > 3× baseline p50).
  - **Warn** on a statistically clear or repeatedly reproducible slowdown (e.g. p50 above baseline p95 by a
    wide margin) — do not turn noisy UI/startup timings into flaky hard CI gates.
- Absolute safety timeouts guard against hangs only.

## Node DB-layer harness vs. the real app — read this

`scenarios-db.mjs` is a **DB/query micro-benchmark**, NOT a proof of real UI/IPC end-to-end performance. It
runs the critical-path SQL against **`node:sqlite`**, which is a different runtime from the app's **`sql.js`**
(WASM, single-thread, in the WebView). Treat its numbers as a *lower bound / relative signal* for the data
layer only. Real UI/IPC/end-to-end numbers come from `scenarios-ui.mjs` + `scenarios-app.mjs` on the release
WebView2 build. Documented runtime differences:

- **Engine:** `node:sqlite` (native SQLite) vs `sql.js` (WASM) — absolute timings differ; use the real-UI run
  for user-facing figures.
- **PRAGMA/FK:** the fixture builds with `foreign_keys=OFF` + `journal_mode=WAL` to match how the app's SQL.js
  loads (FK enforcement off; bulk-seed order-free). The real app applies its own migrations on load.
- Where possible the DB scenarios use the **same SQL shape + parameters** as the real call-paths and validate
  the result against the expected business counts/totals (the real-UI run validates the same data rendered).

## Baseline classes (never mixed)

`baseline.json` (schema 2) buckets every number by the runtime that produced it — a shared `reference` block
(CPU/RAM/OS/node/commit) plus one bucket per class. **Values of different classes are never combined into one
p50.** Each bucket records its own build provenance (profile / features / binary sha256 / fixture / sample
count):

- `node_sqlite_microbenchmark` — the DB/query micro-benchmark (`node:sqlite`, FK OFF/WAL). A lower-bound /
  relative signal for the data layer; **not** the app's `sql.js` runtime.
- `release_e2e_ui` — real UI/IPC over the release e2e WebView2 build (lists, search, detail, invoice flow).
- `release_e2e_app` — real startup (3 cold / 7 warm) + owner-gated GC + mobile ingress on the same build.
- `production_binary_startup` — the real production binary (no `e2e`). See its `measured: false` + `reason`:
  it has no test-port override, so running it would bind 3001 and touch the prod DB; it is validated as a
  separate build gate only, and its provenance (sha256/bytes/commit) is recorded for parity.
- `diagnostic_debug` — debug-profile numbers, kept for diagnosis only, never a budget source.

## Binary parity (production vs release-e2e)

Two builds come off the same tree, same `release` optimisation profile, same product/query/render code:

| | production | release-e2e |
|---|---|---|
| feature `e2e` | off | on |
| binary | `target/release/lataif.exe` (sha256 recorded in `production_binary_startup`) | same path (sha256 recorded in `release_e2e_ui`) |
| CDP / automation | none | `--remote-debugging-port=9223 --enable-automation` (test window only) |
| sync port | hard-wired 3001 | honours `LATAIF_E2E_SYNC_PORT` (test port 3011) |
| identifier / AppData | `com.lataif.app` | `com.lataif.app.e2e` (isolated) |

The **entire** `e2e`-gated surface is: `resolve_sync_port()` (test-port override), the `e2e_support` test-only
re-exports (never on the render/query path), and `#[cfg(any(test, feature="e2e"))]` real-delete helpers in
`restore.rs` / `staging_gc.rs` (not on any measured UI path) — plus the e2e config (identifier / automation
flags / bundle off). No business, query, or rendering logic differs, and there is no extra debug
instrumentation in the measured call path. The measured-path difference is the WebView2 automation launch
flags on the e2e window, so the real-UI numbers are labelled a **release-e2e reference baseline**, not an
exact production-binary baseline. The normal production build remains a separate build gate; startup on the
production binary is not automated because it cannot be isolated from port 3001 / the prod DB.

## Reference environment & baseline contract

`baseline.json` is **hardware- and environment-specific** and is only comparable on the same reference machine
(recorded in every report: CPU model + core count, RAM, OS build, node version, git commit, `buildType`,
release binary sha256). **Never** compare across different hardware — only same-machine relative regression.

Suggested budget formula (derive from measured spread, not invented ms):
- **warn** when a scenario's p50 exceeds `baseline.p95 × 1.5` on the same machine (a clear, reproducible slowdown);
- **hard fail** only on: crash / timeout / error / wrong business result / cleanup failure (leftover process or
  listener, growing temp dir, unreleased lock) / a massive regression (p50 > `baseline.p50 × 3`).
- Do not turn normal UI/startup jitter into flaky hard gates — those are warnings first.

## Other caveats

- `buildType: node-harness` marks node-measured runs; `release`/`debug` mark the WebView2 E2E build.
- Harness-process RSS is **not** the app's RSS. "prod untouched" = the production server DB is byte-identical
  (sha256 + size + mtime) and its media-root file count is unchanged; the e2e app binds only test port 3011,
  never production port 3001.
- The real-UI run drives list/detail/search routes AND the full invoice create → save → reopen flow over the
  real customer/product search widgets on a pre-seeded MEDIUM fixture.
