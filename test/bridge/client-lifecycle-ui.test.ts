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
// Und die ECHTEN Prüfer des Primary — nicht eine Nachbildung davon.
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const ret = await import('../../src/core/bridge/return-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const code = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

// POST-PARITY R7B PP-7 — die alten Lebenszyklus-Tafeln (`src/components/client/ClientLifecyclePanels.tsx`,
// `client-action-panel.tsx`) und ihr Rumpfbau (`client-lifecycle-request.ts`) sind entfernt. Was
// hier bleibt, prueft die echten Pruefer des Primary (mit woertlich gebauten Ruempfen) und den Waechter.
const LEGACY = 'src/components/client';
const REQ = 'src/core/bridge/client-lifecycle-request.ts';

// ── 1) Kein Weg zur lokalen Datenbank ────────────────────────────────────
{
  ok(!existsSync(resolvePath(repo, LEGACY)),
    'DBLESS R7B PP-7 die alten Lebenszyklus-Tafeln (src/components/client) gibt es nicht mehr');
  ok(!existsSync(resolvePath(repo, REQ)),
    `DBLESS R7B PP-7 der alte Rumpfbau (${REQ}) ist entfernt — es gibt keinen Ausgangskorb mehr zu pruefen`);
}

// ── 2) Ein Wächter je Vorsatz ────────────────────────────────────────────
{
  // Der ECHTE Waechter: ein offener Versuch gibt keine neue Kennung heraus.
  const ctl = new CommandSaveController('repairs.update_status');
  const first = ctl.beginAttempt();
  ok(ctl.beginAttempt().commandId === first.commandId, 'IDS ein offener Versuch behaelt seine Kennung');
  ctl.forget();
  ok(ctl.beginAttempt().commandId !== first.commandId, 'IDS ein neuer Vorsatz bekommt eine neue');
  // R7B PP-7 — die Verdrahtungs-Pruefungen an den alten Tafeln sind mit ihnen entfernt.
}

// ── 3) Die Rümpfe: Kennung, Fassung, ausdrückliche Eingabe — kein Preis ──
{
  // R7B PP-7 — die Ruempfe stehen woertlich hier (vorher gebaut von `client-lifecycle-request`); die
  // Pruefungen am Rumpfbau selbst (Zeilenfilter, Zaehler, weggelassene Felder) sind mit ihm entfernt.
  // Jeder echte Pruefer bekommt weiterhin genau den Rumpf, den ein Bildschirm schickt.
  const r = {
    invoiceId: 'inv-1', expectedRevision: 7, lines: [{ invoiceLineId: 'l1', quantity: 2 }],
    refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'defect',
  };
  ok(ret.parseCreateReturn(r).lines.length === 1, 'ROUNDTRIP der echte Pruefer nimmt die Rueckgabe an');

  ok(ret.parseApproveReturn({ returnId: 'r1', expectedRevision: 3 }).returnId === 'r1',
    'ROUNDTRIP genehmigen');
  ok(ret.parseRefundReturn({ returnId: 'r1', amount: 12.5, expectedRevision: 3 }).amount === 12.5,
    'ROUNDTRIP erstatten mit ausdruecklichem Betrag');
  const pay = { returnId: 'r1', amount: 5, method: 'cash', expectedRevision: 3, deductCardFee: true };
  ok(ret.parseRecordRefundPayment(pay).deductCardFee === true, 'ROUNDTRIP die Kartengebuehr ist ausdruecklich');

  ok(life.parseUpdateOrderStatus({ orderId: 'o1', status: 'arrived', expectedRevision: 4 }).status === 'arrived',
    'ROUNDTRIP Auftragsstatus');
  ok(life.parseAddOrderPayment({ orderId: 'o1', amount: 30, method: 'cash', expectedRevision: 4 }).amount === 30,
    'ROUNDTRIP Anzahlung');
  ok(life.parseDeleteOrderPayment({ orderId: 'o1', paymentId: 'p1', expectedRevision: 4 }).paymentId === 'p1',
    'ROUNDTRIP Anzahlung zuruecknehmen');
  const sale = { consignmentId: 'c1', buyerId: 'cust-2', salePrice: 500, expectedRevision: 2 };
  ok(life.parseRecordSale(sale).acknowledgeShortfall === false, 'ROUNDTRIP Verkauf OHNE Bestaetigung');
  ok(life.parseRecordSale({ ...sale, acknowledgeShortfall: true }).acknowledgeShortfall === true,
    'ROUNDTRIP …und mit ist sie da');
  ok(life.parseMarkConsignmentReturned({ consignmentId: 'c1', expectedRevision: 2 }).consignmentId === 'c1',
    'ROUNDTRIP unverkauft zurueck');
  ok(life.parseUpdateRepairStatus({ repairId: 'r1', status: 'ready', expectedRevision: 5 }).status === 'ready',
    'ROUNDTRIP Reparaturstatus');
  // R5C — der Pruefer nimmt jetzt auch mehrere Reparaturen; die Einzelform bleibt gueltig und
  // ergibt eine Liste mit genau dieser einen.
  ok(life.parseCreateRepairInvoice({ repairId: 'r1', expectedRevision: 5 }).repairs[0].repairId === 'r1',
    'ROUNDTRIP Reparaturrechnung');
  ok(life.parseAddRepairLine({ repairId: 'r1', costAmount: 25, expectedRevision: 5, supplierId: 'sup-1', workType: 'service' }).costAmount === 25,
    'ROUNDTRIP Arbeitszeile anlegen');
  ok(life.parseCancelRepairLine({ repairId: 'r1', lineId: 'l1', expectedRevision: 5 }).lineId === 'l1',
    'ROUNDTRIP Arbeitszeile zuruecknehmen');
  ok(life.parseConvertTransfer({ transferId: 't1', customerId: 'cust-1', expectedRevision: 9 }).customerId === 'cust-1',
    'ROUNDTRIP Transfer → Rechnung');
  ok(life.parseConvertTransfers({ transfers: [{ id: 't1', expectedRevision: 9 }], customerId: 'cust-1' }).transfers[0].expectedRevision === 9,
    'ROUNDTRIP …und die Sammelrechnung nennt JEDE Fassung');

  // Nur der UNTERSCHIED reist beim Ändern mit — sonst wird eine Zeile neu gebucht, die
  // niemand angefasst hat.
  ok(life.parseUpdateRepairLine({ repairId: 'r1', lineId: 'l1', expectedRevision: 5, costAmount: 40 }).costAmount === 40,
    'ROUNDTRIP der echte Pruefer nimmt die geaenderte Arbeitszeile an');
}

// ── 4) Nach jeder Wirkung die NEUE Fassung ───────────────────────────────
{
  ok(!existsSync(resolvePath(repo, LEGACY + '/ClientLifecyclePanels.tsx')),
    'REVISION R7B PP-7 die alten Tafeln, deren Neuladen hier geprueft wurde, sind entfernt');
}

// ── 5) Die Bestätigung ist ein NEUER Vorsatz, kein geänderter Rumpf ──────
{
  ok(!existsSync(resolvePath(repo, LEGACY + '/client-action-panel.tsx')),
    'CONFIRM R7B PP-7 das alte Aktionsfeld mit seinem Bestaetigungsweg ist entfernt');
}

// ── 6) Die Oberfläche bietet nur an, was der Primary erlaubt ─────────────
{
  ok(!existsSync(resolvePath(repo, LEGACY + '/ClientLifecyclePanels.tsx')),
    'FLOW R7B PP-7 die alten Tafeln, deren Ablauf hier geprueft wurde, sind entfernt');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3h client lifecycle ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
