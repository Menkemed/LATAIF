// ════════════════════════════════════════════════════════════════════════════
// MOBILE-FIELDS — generate the committed field-schema JSON from the desktop SSOT.
//   node --experimental-strip-types test/mobile-fields/gen-schema.mjs [--check]
//
// Writes src-tauri/src/sync/mobile_field_schema.json (embedded into the Rust /mobile page + Rust validator).
// With --check it exits non-zero if the committed JSON differs from the freshly generated one (drift guard,
// also asserted by test/mobile-fields/field-schema.test.ts).
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMobileFieldSchema } from '../../src/core/mobile/mobile-field-schema.ts';

export const OUT = join(process.cwd(), 'src-tauri', 'src', 'sync', 'mobile_field_schema.json');
export function render() { return JSON.stringify(buildMobileFieldSchema(), null, 2) + '\n'; }

const check = process.argv.includes('--check');
const next = render();
if (check) {
  let cur = '';
  try { cur = readFileSync(OUT, 'utf8'); } catch {}
  if (cur !== next) { console.error('DRIFT: mobile_field_schema.json is stale — run: node --experimental-strip-types test/mobile-fields/gen-schema.mjs'); process.exit(1); }
  console.log('mobile_field_schema.json up to date');
} else {
  writeFileSync(OUT, next);
  console.log('wrote ' + OUT);
}
