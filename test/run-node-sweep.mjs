// RELEASE-RC — canonical node-gate sweep runner.
//
// Discovers EVERY committed node gate (test/**/*.test.ts — no hardcoded list, so
// the set can never silently shrink), runs each in its own node process, and
// exits with a strict contract:
//   • any failing gate  → exit code = number of failures (non-zero)
//   • all gates pass     → exit 0
// No error suppression, no test-set reduction. Prints a per-gate + summary line.
//
// Run: node test/run-node-sweep.mjs
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const testDir = dirname(fileURLToPath(import.meta.url));

/** Recursively collect every *.test.ts under test/. */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const gates = collect(testDir).sort();

// Zero-tests guard: an empty discovery is a failure, never a silent pass.
if (gates.length === 0) {
  console.error('NODE SWEEP: no *.test.ts gates discovered under ' + testDir);
  process.exit(1);
}

let pass = 0;
const failed = [];
for (const g of gates) {
  const rel = g.slice(testDir.length + 1).split(sep).join('/');
  try {
    // `inherit` keeps each gate's stdout/stderr visible; execFileSync throws on a
    // non-zero exit, spawn error, or terminating signal → counted as failed.
    execFileSync(process.execPath, [g], { stdio: 'inherit' });
    pass++;
  } catch {
    failed.push(rel);
    console.error('  ✗ ' + rel);
  }
}

console.log(`NODE SWEEP: ${pass}/${gates.length} gates passed`);
if (failed.length) {
  console.error(`FAILED (${failed.length}): ${failed.join(', ')}`);
  process.exit(failed.length);
}
console.log('ALL GATES GREEN');
process.exit(0);
