// ════════════════════════════════════════════════════════════════════════════
// A0a — cross-client double-redemption defect harness :: CLIENT child
// ════════════════════════════════════════════════════════════════════════════
// Boots the REAL LATAIF client stack headless (Vite SSR) and exposes a stdin/
// stdout RPC so the coordinator can drive the REAL supplier-credit redemption
// writer (supplierStore.applySupplierCreditsToExpenses), the REAL sync engine
// (sync-service.syncNow → pushChanges/pullChanges/applyUpsert), and the REAL
// reconciliation (counterpartyAudit.runCounterpartyAudit + ledger/queries).
//
// NO production code is modified. The only adaptation lives at the harness
// boundary: browser globals (window/localStorage) are shimmed, and the sql.js
// wasm `?url` import is redirected (via a Vite plugin) to a node-loadable path.
// isTauri() is false → the Tauri code paths are never reached.
//
// Each client runs in its OWN process (own sql.js DB, own localStorage, own
// module graph) — two fully separate installations talking to ONE real server.
//
// argv: <label> <syncUrl> <token>
// RPC: parent writes one JSON line {rid,cmd,args} to our stdin; we reply with one
//      stdout line prefixed by RPC_MARK. ALL app console output goes to stderr so
//      stdout carries ONLY rpc replies.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const RPC = '@@RPC@@';
const [, , LABEL, SYNC_URL, TOKEN] = process.argv;
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(DESKTOP, 'src');
const WASM = path.join(DESKTOP, 'node_modules/sql.js/dist/sql-wasm.wasm');
const reqD = createRequire(path.join(DESKTOP, 'package.json'));
const importD = (s) => import(url.pathToFileURL(reqD.resolve(s)).href);

// redirect ALL app console.* to stderr; keep stdout clean for RPC
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  console[k] = (...a) => process.stderr.write(`[${LABEL}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
}
const reply = (obj) => process.stdout.write(RPC + JSON.stringify(obj) + '\n');

// ── browser shims (harness boundary only) ──
class LS { constructor(){ this.m = new Map(); } getItem(k){ return this.m.has(k)?this.m.get(k):null; } setItem(k,v){ this.m.set(k,String(v)); } removeItem(k){ this.m.delete(k); } clear(){ this.m.clear(); } }
globalThis.localStorage = new LS();
globalThis.window = { dispatchEvent(){ return true; }, addEventListener(){}, removeEventListener(){} };
globalThis.window.localStorage = globalThis.localStorage;
if (typeof globalThis.CustomEvent === 'undefined') globalThis.CustomEvent = class { constructor(t,o){ this.type=t; Object.assign(this,o);} };

let vite, db, mods = {}, ID = {};

async function boot() {
  // empty schema-less sql.js blob → "saved" path (no demo seed, no Tauri)
  const initSqlJsPkg = (await importD('sql.js')).default;
  const SQLpkg = await initSqlJsPkg({ locateFile: () => WASM });
  const eb = new SQLpkg.Database().export();
  let bin = ''; for (let i=0;i<eb.length;i+=8192) bin += String.fromCharCode(...eb.subarray(i,i+8192));
  globalThis.localStorage.setItem('lataif_db_v2', Buffer.from(bin,'binary').toString('base64'));

  const { createServer } = await importD('vite');
  const wasmPlugin = { name:'wasm-url-node', enforce:'pre',
    resolveId(id){ if (id.includes('sql-wasm.wasm') && id.includes('?url')) return '\0wasmurl'; },
    load(id){ if (id==='\0wasmurl') return `export default ${JSON.stringify(WASM)};`; } };
  vite = await createServer({ configFile:false, root:DESKTOP, appType:'custom', logLevel:'error',
    server:{ middlewareMode:true, hmr:false, ws:false }, resolve:{ alias:{ '@':SRC } },
    plugins:[wasmPlugin], optimizeDeps:{ noDiscovery:true, include:[] } });

  mods.database = await vite.ssrLoadModule('/src/core/db/database.ts');
  await mods.database.initDatabase();
  db = mods.database.getDatabase();
  mods.helpers  = await vite.ssrLoadModule('/src/core/db/helpers.ts');
  mods.sync     = await vite.ssrLoadModule('/src/core/sync/sync-service.ts');
  mods.supplier = await vite.ssrLoadModule('/src/stores/supplierStore.ts');
  mods.queries  = await vite.ssrLoadModule('/src/core/ledger/queries.ts');
  mods.cpaudit  = await vite.ssrLoadModule('/src/core/ledger/counterpartyAudit.ts');
}

const rows = (sql, params=[]) => { const r = db.exec(sql, params); if (!r.length) return []; const c=r[0].columns; return r[0].values.map(v=>{const o={};c.forEach((k,i)=>o[k]=v[i]);return o;}); };

function applyFixture(id) {
  ID = id;
  // auth session — currentBranchId()/currentUserId() + trackChange read this (harness boundary)
  globalThis.localStorage.setItem('lataif_session', JSON.stringify({ branchId: id.branch, userId: id.user, tenantId: id.tenant }));
  // ── controlled shared starting state via direct SQL (allowed by spec §3) ──
  db.run(`INSERT INTO branches (id,tenant_id,name,country,currency,active,created_at,updated_at) VALUES (?,?,?,?,?,1,datetime('now'),datetime('now'))`,
    [id.branch, id.tenant, 'A0a Branch', 'BH', 'BHD']);
  db.run(`INSERT INTO suppliers (id,branch_id,name,active,created_at,updated_at) VALUES (?,?,?,1,datetime('now'),datetime('now'))`,
    [id.supplier, id.branch, 'A0a Supplier']);
  db.run(`INSERT INTO expenses (id,branch_id,expense_number,category,amount,paid_amount,payment_method,expense_date,description,supplier_id,status,created_at,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`,
    [id.expense, id.branch, 'EXP-A0A-1', 'RepairCosts', id.amount, 0, 'bank', '2026-06-01', 'A0a supplier expense', id.supplier, 'PENDING', id.user]);
  db.run(`INSERT INTO supplier_credits (id,branch_id,supplier_id,source_return_id,source_purchase_id,amount,used_amount,status,note,created_at,created_by)
          VALUES (?,?,?,NULL,NULL,?,0,'OPEN',?,datetime('now'),?)`,
    [id.credit, id.branch, id.supplier, id.amount, 'A0a standalone credit', id.user]);
  // balanced fixture ledger so global + counterparty reconciliation start GREEN:
  //   expense booking : DR EXPENSES_OPERATING / CR ACCOUNTS_PAYABLE (cp SUPPLIER)
  //   credit grant    : DR SUPPLIER_CREDIT (cp SUPPLIER) / CR CASH (cp SUPPLIER)
  const L = (no,tx,acc,dir,cp,sm,sid) => db.run(
    `INSERT INTO ledger_entries (id,branch_id,entry_no,transaction_id,occurred_at,recorded_at,account,direction,amount,currency,counterparty_type,counterparty_id,source_module,source_id,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'BHD',?,?,?,?,?,datetime('now'))`,
    [`fix-${no}`, id.branch, no, tx, '2026-06-01', '2026-06-01', acc, dir, id.amount, cp, cp?id.supplier:null, sm, sid, id.user]);
  L(1,'ftx-exp','EXPENSES_OPERATING','DEBIT', null,'EXPENSE', id.expense);
  L(2,'ftx-exp','ACCOUNTS_PAYABLE','CREDIT','SUPPLIER','EXPENSE', id.expense);
  L(3,'ftx-cred','SUPPLIER_CREDIT','DEBIT','SUPPLIER','SUPPLIER_PREPAYMENT', id.credit);
  L(4,'ftx-cred','CASH','CREDIT','SUPPLIER','SUPPLIER_PREPAYMENT', id.credit);
  db.run(`INSERT INTO ledger_sequence (branch_id,next_no,updated_at) VALUES (?,?,datetime('now'))
          ON CONFLICT(branch_id) DO UPDATE SET next_no=excluded.next_no`, [id.branch, 5]);
}

function snapshot() {
  return {
    supplier_credits: rows(`SELECT id,amount,used_amount,status FROM supplier_credits ORDER BY id`),
    expenses: rows(`SELECT id,amount,paid_amount,status FROM expenses ORDER BY id`),
    expense_payments: rows(`SELECT id,expense_id,amount,method,reference FROM expense_payments ORDER BY id`),
    ledger_entries: rows(`SELECT entry_no,transaction_id,account,direction,amount,counterparty_type,counterparty_id,source_module,source_id FROM ledger_entries ORDER BY entry_no,id`),
    changelog: rows(`SELECT id,table_name,record_id,action,synced FROM sync_changelog ORDER BY id`),
    cursor: globalThis.localStorage.getItem('lataif_sync_last_id') || '0',
  };
}

function recon() {
  const run = (sql, params=[]) => mods.helpers.query(sql, params);
  const cp = mods.cpaudit.runCounterpartyAudit(run, ID.branch);
  return {
    globalImbalance: mods.queries.ledgerImbalance(ID.branch),
    imbalancedTransactions: mods.queries.findImbalancedTransactions(ID.branch),
    supplierAP_ledger: mods.queries.supplierBalance(ID.supplier, ID.branch),
    supplierCredit_ledger: mods.queries.balanceOf('SUPPLIER_CREDIT', { branchId: ID.branch, counterpartyType:'SUPPLIER', counterpartyId: ID.supplier }),
    counterparty: cp,
  };
}

// normalized content hash of the relevant domain + ledger rows (NOT raw SQLite
// file bytes — internal page layout may legitimately differ between instances).
function statehash() {
  const canon = (arr) => JSON.stringify(arr.map(r => { const o={}; Object.keys(r).sort().forEach(k=>o[k]=r[k]); return o; }));
  const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  const dom = [
    rows(`SELECT id,tenant_id,name FROM branches ORDER BY id`),
    rows(`SELECT id,branch_id,name,active FROM suppliers ORDER BY id`),
    rows(`SELECT id,branch_id,amount,paid_amount,status,supplier_id FROM expenses ORDER BY id`),
    rows(`SELECT id,branch_id,supplier_id,amount,used_amount,status FROM supplier_credits ORDER BY id`),
    rows(`SELECT id,expense_id,amount,method,reference FROM expense_payments ORDER BY id,expense_id`),
  ].flat();
  const led = rows(`SELECT entry_no,transaction_id,account,direction,amount,counterparty_type,counterparty_id,source_module,source_id FROM ledger_entries ORDER BY entry_no,id`);
  return {
    domainHash: h(canon(dom)), ledgerHash: h(canon(led)),
    changelogCount: Number(rows(`SELECT COUNT(*) c FROM sync_changelog`)[0].c),
    cursor: globalThis.localStorage.getItem('lataif_sync_last_id') || '0',
    fixtureIds: ID, pid: process.pid,
  };
}

const handlers = {
  fixture: (a) => { applyFixture(a.id); return { ok:true }; },
  statehash: () => statehash(),
  configure: () => { mods.sync.setSyncConfig(SYNC_URL, TOKEN); return { configured: mods.sync.isSyncConfigured() }; },
  redeem: (a) => { try { const r = mods.supplier.useSupplierStore.getState().applySupplierCreditsToExpenses(a.supplier, a.amount); return { ok:true, result:r }; } catch(e){ return { ok:false, error:String(e && e.message || e) }; } },
  sync: async () => { try { await mods.sync.syncNow(); const pend = Number(rows(`SELECT COUNT(*) c FROM sync_changelog WHERE synced=0`)[0].c); return { ok:true, pending:pend, cursor: globalThis.localStorage.getItem('lataif_sync_last_id')||'0' }; } catch(e){ return { ok:false, error:String(e&&e.message||e) }; } },
  snapshot: () => snapshot(),
  recon: () => recon(),
  ping: () => ({ pid: process.pid }),
  exit: async () => { try { await vite.close(); } catch {} setTimeout(()=>process.exit(0), 50); return { bye:true }; },
};

await boot();
reply({ ready:true, pid: process.pid });

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const t = line.trim(); if (!t) continue;
  let msg; try { msg = JSON.parse(t); } catch { continue; }
  const h = handlers[msg.cmd];
  if (!h) { reply({ rid: msg.rid, error: 'unknown cmd '+msg.cmd }); continue; }
  try { const res = await h(msg.args || {}); reply({ rid: msg.rid, res }); }
  catch (e) { reply({ rid: msg.rid, error: String(e && e.message || e) }); }
}
