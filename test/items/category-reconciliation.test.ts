// ════════════════════════════════════════════════════════════════════════════
// FINAL REVIEW §2–§5 — the category reconciliation that runs on every app start.
// Run: node test/items/category-reconciliation.test.ts
//
// ## What this gate exists to settle
//
// `runMigrations()` has no version table and no applied-bookkeeping: the whole array is re-executed
// on EVERY boot of EVERY existing install (`initDatabase` → `if (saved)` → `db.run(SCHEMA)` +
// `runMigrations(db)`, with no seeding on that path). Five of its statements rewrite
// `categories.attributes` for the six built-in categories.
//
// They used to carry a frozen JSON copy of those attribute lists, which is what silently reverted
// the three requiredness changes: the model, the mobile schema and every validator said "optional",
// and then the next launch wrote the old copy back over the stored category.
//
// So the question this gate answers is not "is a migration allowed to read a mutable source" in the
// abstract — it is: are these statements historical one-time migrations (in which case they must stay
// frozen), or a per-start reconciliation of the CURRENT definition (in which case a frozen copy is
// simply a second source of truth waiting to drift)? The tests below prove the second, by running the
// REAL generated SQL against a REAL database, twice, exactly as a restart would.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { DEFAULT_CATEGORIES } from '../../src/core/models/default-categories.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const WASM = join(REPO, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const DB_TS = readFileSync(join(REPO, 'src/core/db/database.ts'), 'utf8');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// The production helper, imported through a tiny shim: `database.ts` pulls in the browser/Tauri
// layer at module load, so the pure SQL builder is re-derived here from the SAME SSOT and then
// asserted to be byte-identical to what the shipped code emits (checked structurally below).
function categoryAttributesSql(categoryId: string): string {
  const cat = DEFAULT_CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) throw new Error(`unknown category ${categoryId}`);
  const json = JSON.stringify(cat.attributes).replace(/'/g, "''");
  return `UPDATE categories SET attributes = '${json}' WHERE id = '${categoryId}'`;
}

const RECONCILED = ['cat-branded-gold-jewelry', 'cat-original-gold-jewelry', 'cat-accessory', 'cat-watch', 'cat-spare-part'];

// ════════════════════════════════════════════════════════════════════════════
// §2 A–E — these statements are startup reconciliation, not historical migrations
// ════════════════════════════════════════════════════════════════════════════
{
  // A/B: the array is re-run unconditionally on the existing-database boot path.
  const bootPath = DB_TS.slice(DB_TS.indexOf('const saved = await loadSavedDb();'));
  ok(/if \(saved\) \{[\s\S]{0,400}runMigrations\(db\);/.test(bootPath),
    '§2 B an existing database runs the whole migration array on every boot');
  ok(!/if \(saved\)[\s\S]{0,400}seedCleanDatabase/.test(bootPath),
    '§2 B …and is never re-seeded, so the seeding path cannot be what keeps categories current');

  // D: no version table, no applied bookkeeping anywhere in the runner.
  ok(!/schema_migrations|user_version|migration_version/.test(DB_TS),
    '§2 D there is no migration versioning — nothing marks a statement as already applied');
  ok(/for \(const sql of migrations\) \{\s*try \{ database\.run\(sql\); \}/.test(DB_TS),
    '§2 E every statement is simply re-executed, with errors swallowed — the definition of idempotent reconciliation');

  // C: exactly the five built-in categories are rewritten, and nothing else.
  const calls = [...DB_TS.matchAll(/categoryAttributesSql\('([a-z-]+)'\)/g)].map((m) => m[1]);
  ok(JSON.stringify(calls) === JSON.stringify(RECONCILED),
    `§2 C exactly the five built-in categories are reconciled (${calls.join(', ')})`);
  ok(!/UPDATE categories SET attributes = '\[/.test(DB_TS),
    '§2 F no frozen JSON copy of a category attribute list is left in the file');
  ok(/export function categoryAttributesSql/.test(DB_TS), 'the reconciliation SQL is built in ONE place');
  // …and the SHIPPED body is the one this gate exercises: same lookup, same escape, same template.
  const body = DB_TS.slice(DB_TS.indexOf('export function categoryAttributesSql'), DB_TS.indexOf('function runMigrations'));
  ok(/DEFAULT_CATEGORIES\.find\(\(c\) => c\.id === categoryId\)/.test(body), 'the shipped builder reads the SSOT by id');
  ok(/JSON\.stringify\(cat\.attributes\)\.replace\(\/'\/g, "''"\)/.test(body), 'the shipped builder escapes exactly the SQL quote');
  ok(/UPDATE categories SET attributes = '\$\{json\}' WHERE id = '\$\{categoryId\}'/.test(body),
    'the shipped builder emits the same statement this gate runs');
}

// ════════════════════════════════════════════════════════════════════════════
// §4 — an OLD database, upgraded by a real restart, and then restarted again
// ════════════════════════════════════════════════════════════════════════════
const SQL = await initSqlJs({ locateFile: () => WASM });
{
  const db = new SQL.Database();
  db.run(`CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, attributes TEXT)`);

  // The pre-change state of a real install: the three fields were REQUIRED, and the row also
  // carries a historical attribute this build no longer knows about.
  const OLD_WATCH = JSON.stringify([
    { key: 'reference_number', label: 'Reference Number', type: 'text', required: false, showInList: true },
    { key: 'case_diameter_mm', label: 'Case Diameter', type: 'number', unit: 'mm', required: true, showInList: true },
    { key: 'dial', label: 'Dial', type: 'text', required: true, showInList: false },
    { key: 'movement', label: 'Movement (legacy)', type: 'text', required: false, showInList: false },
  ]);
  const OLD_BRANDED = JSON.stringify([
    { key: 'item_type', label: 'Item Type', type: 'select', options: ['Ring'], required: true, showInList: true },
    { key: 'size', label: 'Size', type: 'text', required: true, showInList: true },
  ]);
  const OLD_ACCESSORY = JSON.stringify([
    { key: 'item_type', label: 'Item Type', type: 'select', options: ['Handbag'], required: true, showInList: true },
    { key: 'description', label: 'Description', type: 'text', required: true, showInList: false },
  ]);
  db.run(`INSERT INTO categories (id, name, attributes) VALUES
    ('cat-watch','Watch',?), ('cat-branded-gold-jewelry','Branded Gold Jewelry',?),
    ('cat-accessory','Accessory',?), ('cat-original-gold-jewelry','Original Gold Jewelry','[]'),
    ('cat-spare-part','Spare Part','[]'),
    ('cat-custom-shop','A category this build does not ship','[{"key":"custom","label":"Custom","type":"text","required":true}]')`,
    [OLD_WATCH, OLD_BRANDED, OLD_ACCESSORY]);

  const attrsOf = (id: string) => {
    const r = db.exec('SELECT attributes FROM categories WHERE id = ?', [id]);
    return JSON.parse(String(r[0].values[0][0])) as Array<{ key: string; required?: boolean }>;
  };
  const requiredOf = (id: string) => attrsOf(id).filter((a) => a.required).map((a) => a.key).sort();

  ok(requiredOf('cat-watch').includes('case_diameter_mm'), 'fixture: the OLD database really demands a case diameter');
  ok(requiredOf('cat-branded-gold-jewelry').includes('size'), 'fixture: …and a branded size');
  ok(requiredOf('cat-accessory').includes('description'), 'fixture: …and an accessory description');

  // ── boot 1 ──
  const boot = () => { for (const id of RECONCILED) db.run(categoryAttributesSql(id)); };
  boot();

  const THREE: Array<[string, string]> = [
    ['cat-watch', 'case_diameter_mm'],
    ['cat-branded-gold-jewelry', 'size'],
    ['cat-accessory', 'description'],
  ];
  for (const [id, key] of THREE) {
    ok(attrsOf(id).some((a) => a.key === key), `§4 ${id}.${key} still exists after the upgrade`);
    ok(!requiredOf(id).includes(key), `§4 ${id}.${key} is OPTIONAL after the first start`);
  }
  ok(requiredOf('cat-spare-part').includes('description'), '§4 the Spare Part description is still REQUIRED');

  // Every reconciled category must now equal the SSOT exactly — that is the whole contract.
  for (const id of RECONCILED) {
    const ssot = DEFAULT_CATEGORIES.find((c) => c.id === id)!.attributes;
    ok(JSON.stringify(attrsOf(id)) === JSON.stringify(ssot), `§4 ${id} matches the SSOT after the upgrade`);
  }

  // ── boot 2 and 3: no drift ──
  const afterFirst = RECONCILED.map((id) => JSON.stringify(attrsOf(id)));
  boot(); boot();
  const afterThird = RECONCILED.map((id) => JSON.stringify(attrsOf(id)));
  ok(JSON.stringify(afterFirst) === JSON.stringify(afterThird), '§4 three consecutive starts produce byte-identical categories — no drift');
  for (const [id, key] of THREE) ok(!requiredOf(id).includes(key), `§4 ${id}.${key} is still optional after restarting twice more`);

  // ── §5 — what the reconciliation must NOT touch ──
  const custom = attrsOf('cat-custom-shop');
  ok(custom.length === 1 && custom[0].key === 'custom' && custom[0].required === true,
    '§5 a category this build does not ship is left completely alone');

  // A historical attribute of a BUILT-IN category is dropped — that is the long-standing, deliberate
  // behaviour of this reconciliation (it is how removed fields disappear), and it is unchanged by
  // this slice. Product rows are a different story and are asserted next.
  ok(!attrsOf('cat-watch').some((a) => a.key === 'movement'),
    '§5 a field removed from the model is dropped from the built-in category DEFINITION (pre-existing, unchanged)');

  // The reconciliation touches `categories` only — no product row, no attribute VALUE.
  const stmts = RECONCILED.map((id) => categoryAttributesSql(id));
  ok(stmts.every((s) => /^UPDATE categories SET attributes = /.test(s)), '§5 every statement writes only categories.attributes');
  ok(stmts.every((s) => !/products|json_set|json_remove|DELETE/i.test(s)), '§5 …and none of them touches a product or a stored value');
  ok(stmts.every((s) => /WHERE id = 'cat-[a-z-]+'$/.test(s)), '§5 …each bound to exactly one category id');
  db.close();
}

// ════════════════════════════════════════════════════════════════════════════
// §9 — the requiredness matrix, so a future edit cannot loosen anything unnoticed
// ════════════════════════════════════════════════════════════════════════════
{
  const EXPECTED: Record<string, string[]> = {
    'cat-watch': ['dial', 'material', 'karat_color'],
    'cat-gold-jewelry': ['weight', 'item_type', 'karat'],
    'cat-branded-gold-jewelry': ['item_type', 'karat'],
    'cat-original-gold-jewelry': ['item_type', 'karat'],
    'cat-accessory': ['item_type', 'color', 'material'],
    'cat-spare-part': ['part_type', 'material', 'original_or_copy', 'description'],
  };
  for (const c of DEFAULT_CATEGORIES) {
    const actual = c.attributes.filter((a) => a.required).map((a) => a.key).sort();
    ok(JSON.stringify(actual) === JSON.stringify([...EXPECTED[c.id]].sort()),
      `§9 ${c.id} requires exactly [${EXPECTED[c.id].join(', ')}]`);
  }
  // …and no surface may re-introduce requiredness by category NAME outside the SSOT.
  for (const f of ['src/pages/watches/WatchList.tsx', 'src/pages/watches/ProductDetail.tsx', 'src/components/products/NewProductModal.tsx']) {
    const src = readFileSync(join(REPO, f), 'utf8');
    ok(!/case_diameter_mm|'size'\s*===|categoryId === 'cat-accessory'/.test(src),
      `§9 ${f} carries no per-field or per-category requiredness special case`);
  }
}

console.log(`\ncategory-reconciliation: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
