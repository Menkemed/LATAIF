// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — committed baseline, SEPARATED BY MEASUREMENT CLASS.
//
// baseline.json holds one bucket per class so numbers from different runtimes are NEVER merged into a shared
// p50. Classes:
//   node_sqlite_microbenchmark — the DB/query micro-benchmark (node:sqlite; NOT the app runtime).
//   release_e2e_ui             — real UI/IPC over the release e2e WebView2 build (list/search/detail/invoice).
//   release_e2e_app            — real startup + owner-gated GC + mobile ingress over the same build.
//   production_binary_startup  — the real production binary (no e2e). See its `measured`/`reason` fields.
//   diagnostic_debug           — debug-profile numbers, kept only for diagnosis, never a budget source.
//
// Each class records its own build provenance (profile / features / binary sha256 / fixture / sample count).
// Every class-write preserves the other classes (three separate processes populate the file).
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASELINE_PATH = join(process.cwd(), 'test', 'perf', 'baseline.json');

export const CLASSES = [
  'node_sqlite_microbenchmark',
  'release_e2e_ui',
  'release_e2e_app',
  'production_binary_startup',
  'diagnostic_debug',
];

export function loadBaseline() {
  try { return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); } catch { return null; }
}

/** Reduce measured results to committed p50/p95/min/max/stddev/mad + sample count (business-validated). */
export function baselineScenarios(results) {
  return Object.fromEntries(
    results.filter((r) => r && r.n >= 1 && !r.skipped).map((r) => [r.name, {
      p50: r.p50, p95: r.p95, min: r.min, max: r.max, stddev: r.stddev, mad: r.mad ?? null, sampleCount: r.n,
    }]),
  );
}

/**
 * Replace ONE class bucket, preserving every other class. `section` carries the class provenance + scenarios;
 * `reference` (optional) merges into the shared hardware/reference block.
 */
export function mergeBaselineClass(className, section, reference) {
  if (!CLASSES.includes(className)) throw new Error('unknown baseline class ' + className);
  let b = loadBaseline();
  if (!b || b.schema !== 2) {
    b = {
      schema: 2,
      note: 'Performance baselines SEPARATED BY MEASUREMENT CLASS (see test/perf/baseline.mjs). Values of '
        + 'different classes are never combined into a shared p50. Hardware-/environment-specific — only '
        + 'same-machine relative regression is meaningful. Regenerate: node test/perf/run.mjs baseline '
        + '(+ scenarios-app.mjs / scenarios-ui.mjs on the release e2e build).',
      reference: {},
      classes: {},
    };
  }
  if (reference) b.reference = { ...b.reference, ...reference };
  b.classes = b.classes || {};
  b.classes[className] = section;
  writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2) + '\n');
  return b;
}
