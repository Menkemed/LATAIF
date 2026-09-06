// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3H — die Lebenszyklus-Tafeln des Clients, ohne Datenbank.
// Run: node test/bridge/client-lifecycle-ui.test.ts
//
// Was hier bewiesen wird:
//   1. PC2 hat KEINEN Weg zur Geschäftsdatenbank, keinen Ausgangskorb, keinen Ersatzweg.
//   2. Jeder der sechzehn Vorsätze hat seinen eigenen Wächter — offene Versuche laufen nie
//      als etwas anderes weiter.
//   3. Der Rumpf trägt Kennung, Fassung und ausdrückliche Eingaben — und keinen Preis.
//   4. Der ECHTE Prüfer des Primary nimmt genau diese Rümpfe an.
//   5. Nach jeder Wirkung wird frisch geladen: die nächste Handlung nennt die NEUE Fassung.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      for (const cand of [p, p + '.ts', p + '.tsx']) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
      return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
};
(globalThis as { window?: unknown }).window = { localStorage: storage };
(globalThis as { localStorage?: unknown }).localStorage = storage;

const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');
const ui = await import('../../src/core/bridge/client-lifecycle-request.ts');
// Und die ECHTEN Prüfer des Primary — nicht eine Nachbildung davon.
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const ret = await import('../../src/core/bridge/return-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const code = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

const PANELS = 'src/components/client/ClientLifecyclePanels.tsx';
const ACTION = 'src/components/client/client-action-panel.tsx';
const REQ = 'src/core/bridge/client-lifecycle-request.ts';

// ── 1) Kein Weg zur lokalen Datenbank ────────────────────────────────────
{
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(resolvePath(repo, file), 'utf8');
    const stripped = text.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    }).join('\n');
    if (/\bgetDatabase\b|\binitDatabase\b|use[A-Z][A-Za-z]*Store\b/.test(stripped)) offenders.push(file);
    for (const m of stripped.matchAll(/from '(@\/[^']+)'/g)) {
      const rel = 'src/' + m[1].slice(2);
      for (const cand of [rel, rel + '.ts', rel + '.tsx']) {
        if (existsSync(resolvePath(repo, cand)) && /\.(ts|tsx)$/.test(cand)) { visit(cand); break; }
      }
    }
    for (const m of stripped.matchAll(/from '(\.[^']+)'/g)) {
      const base = resolvePath(dirname(resolvePath(repo, file)), m[1]);
      for (const cand of [base, base + '.ts', base + '.tsx']) {
        if (existsSync(cand)) {
          if (/\.(ts|tsx)$/.test(cand)) visit(cand.slice(repo.length + 1).replace(/\\/g, '/'));
          break;
        }
      }
    }
  };
  visit(PANELS);
  visit(ACTION);
  ok(offenders.length === 0,
    `DBLESS nirgends im Importbaum steht die lokale Datenbank oder ein Business-Store (${offenders.join(', ') || 'keine'})`);
  ok([...seen].every((f) => !f.startsWith('src/core/db/')), 'DBLESS und keine Datei aus der Datenschicht');
  for (const f of [PANELS, ACTION, REQ]) {
    ok(!/outbox|indexedDB|localStorage/i.test(code(f)), `DBLESS ${f} legt keinen Ausgangskorb an`);
  }
  // "async" enthaelt buchstaeblich "sync" — gesucht wird der ABGLEICH als Ersatzweg, also
  // seine echten Namen.
  ok(!/syncService|sync-service|trackChange|syncPush|syncPull/.test(code(PANELS)),
    'DBLESS und keinen Ersatzweg ueber den Abgleich');
  // Gelesen wird ausschliesslich beim Primary.
  ok(/remoteRead/.test(code(PANELS)), 'DBLESS gelesen wird ueber die Bruecke');
  const reads = [...code(PANELS).matchAll(/read<[^>]*>\('([^']+)'/g)].map((m) => m[1]);
  ok(reads.length > 0 && reads.every((r) => r.endsWith('.get') || r.endsWith('.list')),
    `DBLESS …und nur ueber freigegebene Lesenamen (${[...new Set(reads)].join(', ')})`);
}

// ── 2) Ein Wächter je Vorsatz ────────────────────────────────────────────
{
  const a = code(ACTION);
  ok(/new CommandSaveController<ActionValue>\(op\)/.test(a), 'IDS jede Aktion bekommt ihren eigenen Waechter');
  ok((a.match(/new CommandSaveController/g) ?? []).length === 2,
    'IDS …und der Bestaetigungsweg einen ZWEITEN — er darf die verbrannte Kennung nicht erben');
  ok(/if \(out\.kind === 'ok'\)[\s\S]{0,120}onDone/.test(a), 'IDS nach dem Erfolg wird der Aufrufer benachrichtigt');
  ok(/pending \? `Retry the same/.test(a), 'IDS ein offener Ausgang sagt „dieselbe Wiederholung"');
  // Der ECHTE Waechter: ein offener Versuch gibt keine neue Kennung heraus.
  const ctl = new CommandSaveController('repairs.update_status');
  const first = ctl.beginAttempt();
  ok(ctl.beginAttempt().commandId === first.commandId, 'IDS ein offener Versuch behaelt seine Kennung');
  ctl.forget();
  ok(ctl.beginAttempt().commandId !== first.commandId, 'IDS ein neuer Vorsatz bekommt eine neue');

  // Sechzehn Namen, und jeder wird in der Oberflaeche wirklich benutzt.
  const panels = code(PANELS);
  const OPS = [
    'returns.create', 'returns.approve', 'returns.refund', 'returns.record_refund_payment',
    'orders.update_status', 'orders.add_payment', 'orders.delete_payment',
    'consignments.record_sale', 'consignments.mark_returned',
    'repairs.update_status', 'repairs.create_invoice',
    'repairs.add_line', 'repairs.update_line', 'repairs.cancel_line',
    'transfers.convert_to_invoice',
  ];
  for (const op of OPS) ok(panels.includes(`op="${op}"`), `WIRED die Oberflaeche fuehrt ${op}`);
  ok((panels.match(/<ClientAction/g) ?? []).length >= OPS.length,
    'WIRED …jede als eigene Aktion mit eigenem Waechter');
  // Nichts Zerstoerendes steht in der Oberflaeche.
  for (const op of ['repairs.delete', 'invoices.delete', 'transfers.undo_convert',
    'consignments.cancel_sale', 'orders.cancel_with_money', 'invoices.set_special_mark']) {
    ok(!panels.includes(op), `WIRED ${op} steht NICHT in der Oberflaeche`);
  }
}

// ── 3) Die Rümpfe: Kennung, Fassung, ausdrückliche Eingabe — kein Preis ──
{
  const r = ui.createReturnRequest('inv-1', 7, [
    { invoiceLineId: 'l1', quantity: '2' },
    { invoiceLineId: 'l2', quantity: '' },
    { invoiceLineId: 'l3', quantity: '0' },
  ], { refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'defect' });
  ok(ui.returnLineCount(r) === 1, 'BODY nur Zeilen mit einer Menge > 0 reisen mit');
  ok(JSON.stringify(r).indexOf('unitPrice') === -1, 'BODY der Rumpf traegt KEINEN Preis');
  ok(JSON.stringify(r).indexOf('vatAmount') === -1, 'BODY …und keine Steuer');
  ok(r.expectedRevision === 7, 'BODY die gelesene Fassung faehrt mit');
  ok(ret.parseCreateReturn(r).lines.length === 1, 'ROUNDTRIP der echte Pruefer nimmt ihn an');

  const empty = ui.createReturnRequest('inv-1', 7, [{ invoiceLineId: 'l1', quantity: '' }]);
  ok(ui.returnLineCount(empty) === 0, 'BODY ohne Menge gibt es nichts zu schicken');

  ok(ret.parseApproveReturn(ui.approveReturnRequest('r1', 3)).returnId === 'r1',
    'ROUNDTRIP genehmigen');
  ok(ret.parseRefundReturn(ui.refundReturnRequest('r1', 3, '12.5')).amount === 12.5,
    'ROUNDTRIP erstatten mit ausdruecklichem Betrag');
  const pay = ui.recordRefundPaymentRequest('r1', 3, '5', 'cash', { deductCardFee: true });
  ok(ret.parseRecordRefundPayment(pay).deductCardFee === true, 'ROUNDTRIP die Kartengebuehr ist ausdruecklich');
  ok(!('deductCardFee' in ui.recordRefundPaymentRequest('r1', 3, '5', 'cash')),
    'BODY …und fehlt, wenn niemand sie gesetzt hat');

  ok(life.parseUpdateOrderStatus(ui.orderStatusRequest('o1', 4, 'arrived')).status === 'arrived',
    'ROUNDTRIP Auftragsstatus');
  ok(life.parseAddOrderPayment(ui.addOrderPaymentRequest('o1', 4, '30', 'cash')).amount === 30,
    'ROUNDTRIP Anzahlung');
  ok(life.parseDeleteOrderPayment(ui.deleteOrderPaymentRequest('o1', 'p1', 4)).paymentId === 'p1',
    'ROUNDTRIP Anzahlung zuruecknehmen');
  const sale = ui.recordSaleRequest('c1', 2, 'cust-2', '500');
  ok(life.parseRecordSale(sale).acknowledgeShortfall === false, 'ROUNDTRIP Verkauf OHNE Bestaetigung');
  ok(!('acknowledgeShortfall' in sale), 'BODY …die Bestaetigung fehlt, wenn niemand sie gab');
  const saleYes = ui.recordSaleRequest('c1', 2, 'cust-2', '500', { acknowledgeShortfall: true });
  ok(life.parseRecordSale(saleYes).acknowledgeShortfall === true, 'ROUNDTRIP …und mit ist sie da');
  ok(life.parseMarkConsignmentReturned(ui.consignmentReturnRequest('c1', 2)).consignmentId === 'c1',
    'ROUNDTRIP unverkauft zurueck');
  ok(life.parseUpdateRepairStatus(ui.repairStatusRequest('r1', 5, 'ready')).status === 'ready',
    'ROUNDTRIP Reparaturstatus');
  ok(life.parseCreateRepairInvoice(ui.repairInvoiceRequest('r1', 5)).repairId === 'r1',
    'ROUNDTRIP Reparaturrechnung');
  ok(life.parseAddRepairLine(ui.addRepairLineRequest('r1', 5, { costAmount: '25', supplierId: 'sup-1', workType: 'labor', description: '' })).costAmount === 25,
    'ROUNDTRIP Arbeitszeile anlegen');
  ok(life.parseCancelRepairLine(ui.cancelRepairLineRequest('r1', 'l1', 5)).lineId === 'l1',
    'ROUNDTRIP Arbeitszeile zuruecknehmen');
  ok(life.parseConvertTransfer(ui.convertTransferRequest('t1', 9, 'cust-1')).customerId === 'cust-1',
    'ROUNDTRIP Transfer → Rechnung');
  ok(life.parseConvertTransfers(ui.convertTransfersRequest([{ id: 't1', revision: 9 }], 'cust-1')).transfers[0].expectedRevision === 9,
    'ROUNDTRIP …und die Sammelrechnung nennt JEDE Fassung');

  // Nur der UNTERSCHIED reist beim Ändern mit — sonst wird eine Zeile neu gebucht, die
  // niemand angefasst hat.
  const base = { costAmount: '25', supplierId: 'sup-1', workType: 'labor', description: 'x', dueDate: '', notes: '' };
  const same = ui.updateRepairLineRequest('r1', 'l1', 5, base, base);
  ok(ui.lifecycleChangeCount(same) === 0, 'BODY ein unveraendertes Formular schickt nichts');
  const changed = ui.updateRepairLineRequest('r1', 'l1', 5, base, { ...base, costAmount: '40' });
  ok(ui.lifecycleChangeCount(changed) === 1, 'BODY …und ein geaendertes genau ein Feld');
  ok(life.parseUpdateRepairLine(changed).costAmount === 40, 'ROUNDTRIP der echte Pruefer nimmt es an');
}

// ── 4) Nach jeder Wirkung die NEUE Fassung ───────────────────────────────
{
  const panels = code(PANELS);
  // Die Tafeln laden nach jeder erfolgreichen Handlung neu — das ist ihre Art, die neue
  // Fassung zu übernehmen. In C3G FINAL war genau dieses Vergessen der Befund.
  ok(/note\(kind, replayed\);[\s\S]{0,120}reload\(\);/.test(panels),
    'REVISION erst die Bestaetigung merken, DANN neu laden — die Reihenfolge ist der Punkt');
  ok((panels.match(/onDone=\{doneOf\(/g) ?? []).length >= 10,
    'REVISION jede Aktion meldet ihren Namen und laedt danach neu');
  ok((panels.match(/doneOf\(/g) ?? []).length >= 15,
    'REVISION …und zwar ALLE, auch die, die zusaetzlich ihr Formular leeren');
  // Der Befund des Zwei-Instanzen-E2E: eine Handlung, die den Vorgang weiterschaltet, laesst
  // ihren eigenen Knopf verschwinden — und mit ihm seine Antwort. Die Bestaetigung gehoert
  // deshalb der TAFEL, nicht dem Knopf.
  ok(/data-client-done=\{k\}/.test(panels), 'REVISION die Bestaetigung ueberlebt das Verschwinden des Knopfes');
  ok((panels.match(/<Flash flash=\{flash\} \/>/g) ?? []).length === 5,
    'REVISION …in allen fuenf Tafeln');
  ok(/const revision = n\(row\.revision\)/.test(panels),
    'REVISION die Fassung kommt aus der frisch gelesenen Antwort, nicht aus einem Zustand');
  // Kein Zeitstempel als Sperre.
  ok(!/updatedAt/.test(panels), 'REVISION und kein Zeitstempel als Sperre');
}

// ── 5) Die Bestätigung ist ein NEUER Vorsatz, kein geänderter Rumpf ──────
{
  const a = code(ACTION);
  ok(/confirm\?: \{[\s\S]{0,220}codes: readonly string\[\]/.test(a),
    'CONFIRM eine Bestaetigung nennt GENAU die Urteile, nach denen sie erscheint');
  ok(/showConfirm = !!confirm && !!rejected && confirm\.codes\.includes\(rejected\)/.test(a),
    'CONFIRM …und erscheint nur nach diesen');
  ok(/which === 'confirm' \? confirmController : controller/.test(a),
    'CONFIRM sie faehrt ueber den ZWEITEN Waechter — neue Kennung');
  ok(/which === 'confirm' \? confirm!\.body\(\) : body\(\)/.test(a),
    'CONFIRM …mit ihrem eigenen Rumpf');
  const panels = code(PANELS);
  ok(/codes: \['SALE_BELOW_FLOOR'\]/.test(panels),
    'CONFIRM der Verkauf unter dem Boden ist der eine Fall, der eine braucht');
  ok(/acknowledgeShortfall: true/.test(panels), 'CONFIRM …und sie bestaetigt genau das');
  ok(!/acknowledge[A-Za-z]*: true[\s\S]{0,40}acknowledge/.test(panels),
    'CONFIRM keine Sammelbestaetigung, die mehreres auf einmal abschaltet');
}

// ── 6) Die Oberfläche bietet nur an, was der Primary erlaubt ─────────────
{
  const panels = code(PANELS);
  ok(/row\.nextStatus/.test(panels), 'FLOW der naechste Auftragsschritt kommt VOM PRIMARY');
  ok(/row\.allowedStatusTargets/.test(panels), 'FLOW die Reparaturschritte ebenso');
  ok(!/'pending'\s*,\s*'arrived'|'received'\s*,\s*'diagnosed'/.test(panels),
    'FLOW …und keine zweite Reihenfolge steht in der Oberflaeche');
  ok(/l\.returnableQuantity|returnableQuantity/.test(panels),
    'FLOW die noch rueckgebbare Menge kommt vom Primary');
  ok(!/quantity - .*returned/.test(panels), 'FLOW …und wird hier nicht nachgerechnet');
  ok(/p\.deletable/.test(panels), 'FLOW ob eine Anzahlung loeschbar ist, sagt der Primary');
  ok(/l\.editable/.test(panels), 'FLOW …und ob eine Arbeitszeile noch aenderbar ist');
  ok(/s\(c\.id\) !== s\(row\.consignorId\)/.test(panels),
    'FLOW der Einlieferer steht nicht in der Kaeuferliste');
  // Und gerechnet wird nichts.
  ok(!/\* *0?\.1|\/ *1\.1|vatRate|taxScheme/.test(panels), 'CALC die Oberflaeche rechnet keine Steuer');
  ok(!/commission|payout \* /.test(panels), 'CALC …und keine Provision');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3h client lifecycle ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
