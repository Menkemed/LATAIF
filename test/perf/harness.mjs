// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — measurement harness. Reproducible, non-destructive.
//
// - Monotone high-resolution timer (performance.now()).
// - Warm-up runs are excluded from the stats.
// - Robust stats: p50/p95/min/max/mean/stddev + MAD (median absolute deviation). Outliers are NEVER silently
//   dropped — they show up in max and the spread.
// - Every scenario runs a business VALIDATION (expected counts/totals) so a "fast but wrong" result fails.
// - Machine-readable JSON + a compact Markdown summary, tagged with commit/version/fixture/env metadata.
// - No PII, no absolute user paths, no tokens/secrets are recorded.
// ════════════════════════════════════════════════════════════════════════════
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ARTIFACT_DIR = join(process.cwd(), 'test', 'perf', 'artifacts');

/** Deterministic PRNG (mulberry32) — fixtures must be identical every run; no Math.random / Date.now. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / (n || 1);
  const variance = n > 1 ? s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const p50 = quantile(s, 0.5);
  const mad = n ? quantile([...s.map((x) => Math.abs(x - p50))].sort((a, b) => a - b), 0.5) : null;
  return {
    n,
    min: n ? round(s[0]) : null,
    max: n ? round(s[n - 1]) : null,
    mean: round(mean),
    p50: round(p50),
    // p95 is only meaningful with enough samples; below 20 it is marked as an estimate.
    p95: n >= 5 ? round(quantile(s, 0.95)) : null,
    p95Estimate: n < 20,
    stddev: round(Math.sqrt(variance)),
    mad: round(mad),
  };
}
const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/**
 * Measure one operation. `op()` returns a value validated by `validate(value)` (throw/false ⇒ failure).
 * Cold and warm are measured/reported separately by the caller (two `measure` calls with different setup).
 *
 * `reset(i)` runs BEFORE each rep and is NOT timed — use it to restore deterministic state between runs
 *   (clear a search box, navigate away so the next route transition genuinely re-renders, open a fresh
 *   create form with a unique number). A reset that throws fails that rep (never silently reused as cold).
 * `perRep` records every measured rep: its ms, ok/fail, and the business result it validated — so a caller
 *   can prove each individual run produced the correct data (not just the aggregate).
 */
export async function measure(name, op, { warmup = 2, reps = 7, validate, meta = {}, reset } = {}) {
  const durations = [];
  const perRep = [];
  let ok = 0, fail = 0, lastErr = null, lastValue = null;
  for (let i = 0; i < warmup + reps; i++) {
    if (reset) {
      try { await reset(i); }
      catch (e) { if (i >= warmup) { fail++; perRep.push({ rep: i - warmup, ok: false, ms: null, error: 'reset: ' + String(e?.message || e).slice(0, 160) }); } continue; }
    }
    const t0 = performance.now();
    let value, threw = false;
    try { value = await op(); } catch (e) { threw = true; lastErr = String(e?.message || e).slice(0, 200); }
    const dt = performance.now() - t0;
    let valid = !threw;
    if (!threw && validate) { try { valid = validate(value) !== false; } catch (e) { valid = false; lastErr = String(e?.message || e).slice(0, 200); } }
    if (i < warmup) continue; // warm-up excluded
    if (valid) { ok++; durations.push(dt); lastValue = value; perRep.push({ rep: i - warmup, ok: true, ms: round(dt), value: summarize(value) }); }
    else { fail++; perRep.push({ rep: i - warmup, ok: false, ms: round(dt), value: summarize(value), error: lastErr }); }
  }
  return { name, ...stats(durations), reps, warmup, ok, fail, lastError: fail ? lastErr : null, meta, samples: durations.map((d) => round(d)), perRep, sampleValue: summarize(lastValue) };
}

function summarize(v) {
  if (v == null || typeof v !== 'object') return v ?? null;
  if (Array.isArray(v)) return { kind: 'array', length: v.length };
  const out = {};
  for (const k of Object.keys(v).slice(0, 8)) { const x = v[k]; out[k] = (x && typeof x === 'object') ? (Array.isArray(x) ? x.length : '{…}') : x; }
  return out;
}

export function envMeta() {
  let commit = 'unknown', dirty = null;
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch {}
  try { dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0; } catch {}
  let appVersion = 'unknown';
  try { appVersion = JSON.parse(execSync('type package.json 2>NUL || cat package.json', { encoding: 'utf8', shell: true })).version; } catch {}
  const cpus = os.cpus();
  return {
    commit, dirty, appVersion,
    node: process.version,
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus?.[0]?.model?.trim() || 'unknown',
    cpuCount: cpus?.length ?? null,
    totalRamGB: round(os.totalmem() / 2 ** 30),
    // Perf numbers below come from a DEBUG or node harness unless buildType is 'release'.
    buildType: process.env.PERF_BUILD_TYPE || 'node-harness',
  };
}

/** Write the machine-readable JSON + a compact Markdown summary under the (gitignored) artifact dir. */
export function writeReport(runId, suite, results, extra = {}) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const report = { runId, suite, env: envMeta(), generatedMonotonicMs: round(performance.now()), ...extra, results };
  const jsonPath = join(ARTIFACT_DIR, `${suite}-${runId}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const md = toMarkdown(report);
  const mdPath = join(ARTIFACT_DIR, `${suite}-${runId}.md`);
  writeFileSync(mdPath, md);
  return { jsonPath, mdPath, report };
}

function toMarkdown(r) {
  const lines = [];
  lines.push(`# Perf: ${r.suite} — run ${r.runId}`);
  lines.push('');
  lines.push(`commit \`${r.env.commit}\`${r.env.dirty ? ' (dirty)' : ''} · v${r.env.appVersion} · build \`${r.env.buildType}\` · ${r.env.cpu} ×${r.env.cpuCount} · ${r.env.totalRamGB} GB · ${r.env.os}`);
  if (r.fixture) lines.push(`fixture: **${r.fixture.size}** (${Object.entries(r.fixture.counts || {}).map(([k, v]) => `${k}=${v}`).join(', ')}) · db ${r.fixture.dbBytes ?? '?'} B`);
  lines.push('');
  lines.push('| scenario | cold | n | p50 ms | p95 ms | min | max | stddev | ok/fail |');
  lines.push('|---|---|--:|--:|--:|--:|--:|--:|--:|');
  for (const x of r.results) {
    lines.push(`| ${x.name} | ${x.meta?.cold ? 'cold' : 'warm'} | ${x.n} | ${x.p50 ?? '–'} | ${x.p95 ?? '–'}${x.p95Estimate && x.p95 != null ? '*' : ''} | ${x.min ?? '–'} | ${x.max ?? '–'} | ${x.stddev ?? '–'} | ${x.ok}/${x.fail} |`);
  }
  lines.push('');
  lines.push('_\\* p95 is an estimate below 20 samples. Outliers are kept (see max/stddev)._');
  return lines.join('\n') + '\n';
}
