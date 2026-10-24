// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT Phase 2 — „Edit purchase": was nach dem Anlegen noch richtig werden muss.
//
// Eine Maske, EINE Buchung beim Speichern (`purchases.update` für Notiz/Mitarbeiter/Ausweisfoto,
// `purchases.correct` für Datum/Lieferant/Preis/Menge — nur Owner). Was gesperrt ist und warum,
// sagt die Auskunft `purchase.edit_check.get` — dieselben Sperren, mit denen die Hausfolge am
// Primary prüft; die Maske rechnet nichts selbst, sie zeigt nur die Wirkung vorab.
//
// Nummer, Originalbelege, Zahlungen und Protokoll bleiben; die Rechnung eines verkauften Stücks
// bleibt unverändert (D1: eigene Einstandskorrektur). Artikelangaben und Fotos ändert „Edit item"
// am Artikel selbst (D13: derselbe Artikel in Collections).
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Lock, Save, Edit3 } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { StaffSelect } from '@/components/employees/StaffSelect';
import { IdentityPhotoField } from '@/components/identity/IdentityPhotoField';
import { WriteError } from '@/components/shared/WriteError';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useProductStore } from '@/stores/productStore';
import { usePermission } from '@/hooks/usePermission';
import { useSharedRead } from '@/core/data/shared-read';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import { viaWrites } from '@/core/payables/payables-save';
import { latestBusinessDate } from '@/core/utils/business-date';
import { productDisplayName } from '@/core/products/display-name';
import type { Product, PurchaseIdentityReference } from '@/core/models/types';
import { loadPurchaseIdentityPhoto, revokeIdentityPhoto, type IdentityPhotoView } from '@/core/identity/identity-photo-view';
import {
  PURCHASE_EDIT_CHECK_OP, PURCHASE_EDIT_OP, purchaseEditCheck,
  type CorrectionKind, type EditLock, type PurchaseEditCheck,
} from '@/core/purchases/purchase-edit-house';
import { isFinancialPurchaseEdit, savePurchaseEdit, type PurchaseEditForm } from '@/core/purchases/purchase-house';

const R3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Warum ein Feld zu ist — klein unter dem Feld, nie ein stiller grauer Kasten. */
function Gesperrt({ lock }: { lock: EditLock | undefined }) {
  if (!lock) return null;
  if (lock.allowed) return lock.note ? <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>{lock.note}</div> : null;
  return (
    <div style={{ fontSize: 11, color: '#B45309', marginTop: 4, display: 'flex', gap: 4, alignItems: 'flex-start' }} data-purchase-edit-locked={lock.code}>
      <Lock size={11} style={{ marginTop: 2, flexShrink: 0 }} /> {lock.reason}
    </div>
  );
}

function labelFor(products: readonly Product[], pid: string): string {
  const p = products.find((x) => x.id === pid);
  return p ? productDisplayName(p) : pid.slice(0, 8);
}

const NUR_OWNER_TEXT = 'Only the owner corrects date, supplier, prices and quantities.';
const NUR_OWNER: EditLock = { allowed: false, code: 'PURCHASE_EDIT_OWNER_ONLY', reason: NUR_OWNER_TEXT };

export function PurchaseEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack(`/purchases/${id ?? ''}`);
  const { purchases, loadPurchases } = usePurchaseStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const { products, loadProducts } = useProductStore();
  const perm = usePermission();
  const w = useSharedWrites();
  const [tick, setTick] = useState(0);
  useEffect(() => { loadPurchases(); loadSuppliers(); loadProducts(); }, [loadPurchases, loadSuppliers, loadProducts]);

  const purchase = useMemo(() => purchases.find((p) => p.id === id), [purchases, id]);
  const check = useSharedRead<PurchaseEditCheck | null>(
    PURCHASE_EDIT_CHECK_OP, { purchaseId: id ?? '', v: tick },
    (ctx) => {
      try { return purchaseEditCheck(id ?? '', ctx.branchId, new Date().toISOString()); } catch { return null; }
    },
    null, [id, purchases, tick],
  );

  // ── Die Eingaben (Ausgangsstand = der geladene Beleg) ──
  const [startedFor, setStartedFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [confirmPay, setConfirmPay] = useState(false);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<CorrectionKind>('ENTRY_ERROR');
  const [idPhoto, setIdPhoto] = useState<string | undefined>(undefined);
  const [alsoPerson, setAlsoPerson] = useState(false);
  const [fehler, setFehler] = useState('');

  useEffect(() => {
    if (!purchase || startedFor === purchase.id) return;
    setStartedFor(purchase.id);
    setNotes(purchase.notes ?? '');
    setStaffId(purchase.staffId ?? '');
    setDate(String(purchase.purchaseDate ?? '').slice(0, 10));
    setSupplierId(purchase.supplierId);
    setPrices(Object.fromEntries(purchase.lines.map((l) => [l.id, String(l.unitPrice)])));
    setQtys(Object.fromEntries(purchase.lines.map((l) => [l.id, String(l.quantity)])));
  }, [purchase, startedFor]);

  // Der Ausweis, wie er heute am Beleg gilt (nur die aktuelle Fassung — D10: kein sichtbarer Verlauf).
  const idReferenz = JSON.stringify(purchase?.supplierSnapshot?.identity ?? null);
  const [idAnsicht, setIdAnsicht] = useState<{ key: string; view: IdentityPhotoView | null } | null>(null);
  useEffect(() => {
    const ref = JSON.parse(idReferenz) as PurchaseIdentityReference | null;
    if (!ref) return;
    let lebt = true;
    let sicht: IdentityPhotoView | null = null;
    void loadPurchaseIdentityPhoto(ref)
      .then((v) => { if (!lebt) { revokeIdentityPhoto(v); return; } sicht = v; setIdAnsicht({ key: idReferenz, view: v }); })
      .catch(() => { if (lebt) setIdAnsicht({ key: idReferenz, view: null }); });
    return () => { lebt = false; revokeIdentityPhoto(sicht); };
  }, [idReferenz]);
  const idUrl = idAnsicht && idAnsicht.key === idReferenz ? idAnsicht.view?.url ?? null : null;
  const legacyIdUrl = purchase?.supplierSnapshot?.cprImage ?? null;

  const supplierOptions = useMemo(() => suppliers
    .filter((s) => s.active || s.id === purchase?.supplierId)
    .map((s) => ({ id: s.id, label: s.name, subtitle: s.phone || s.email })), [suppliers, purchase?.supplierId]);

  // ── Was sich geändert hat → das Formular für die Hausfolge ──
  const geaendert = useMemo(() => {
    if (!purchase) return null;
    const lines: NonNullable<PurchaseEditForm['lines']> = [];
    let invalid = '';
    for (const l of purchase.lines) {
      const pRaw = prices[l.id] ?? String(l.unitPrice);
      const qRaw = qtys[l.id] ?? String(l.quantity);
      // Ein leeres Feld ist keine 0 (Number('') wäre 0) — sonst würde ein gelöschter Preis still zu 0.
      const p = pRaw.trim() === '' ? NaN : Number(pRaw);
      const q = qRaw.trim() === '' ? NaN : Number(qRaw);
      if (!Number.isFinite(p) || p < 0) { invalid = 'Every unit price must be a number of 0 or more.'; continue; }
      if (!Number.isInteger(q) || q < 1) { invalid = 'Every quantity must be a whole number of at least 1.'; continue; }
      const priceChanged = Math.abs(R3(p) - R3(l.unitPrice)) >= 0.0005;
      const qtyChanged = q !== l.quantity;
      if (priceChanged || qtyChanged) {
        lines.push({ lineId: l.id, ...(priceChanged ? { unitPrice: R3(p) } : {}), ...(qtyChanged ? { quantity: q } : {}) });
      }
    }
    const form: PurchaseEditForm = { reason: reason.trim() };
    if (notes.trim() !== (purchase.notes ?? '').trim()) form.notes = notes.trim() === '' ? null : notes.trim();
    if (staffId !== (purchase.staffId ?? '')) form.staffId = staffId || null;
    if (date && date !== String(purchase.purchaseDate ?? '').slice(0, 10)) form.purchaseDate = date;
    if (supplierId && supplierId !== purchase.supplierId) {
      form.supplierId = supplierId;
      if ((check?.livePayments ?? 0) > 0) form.confirmPaymentsToNewSupplier = confirmPay;
    }
    if (lines.length > 0) form.lines = lines;
    if (lines.some((l) => l.unitPrice !== undefined)) form.correctionKind = kind;
    if (idPhoto) form.identityPhoto = { dataUrl: idPhoto, alsoUpdatePerson: alsoPerson };
    const anything = form.notes !== undefined || form.staffId !== undefined || form.purchaseDate !== undefined
      || form.supplierId !== undefined || lines.length > 0 || !!form.identityPhoto;
    return { form, invalid, anything };
  }, [purchase, prices, qtys, reason, notes, staffId, date, supplierId, confirmPay, kind, idPhoto, alsoPerson, check?.livePayments]);

  // ── Die Wirkung vorab (nur Anzeige — die Zahlen rechnet beim Speichern der Primary) ──
  const vorschau = useMemo(() => {
    if (!purchase || !check || !geaendert) return null;
    const lineCheck = new Map(check.lines.map((c) => [c.lineId, c]));
    let neu = 0;
    const hinweise: string[] = [];
    for (const l of purchase.lines) {
      const ch = geaendert.form.lines?.find((x) => x.lineId === l.id);
      const price = ch?.unitPrice ?? l.unitPrice;
      const qty = ch?.quantity ?? l.quantity;
      neu += price * qty;
      if (!ch) continue;
      const c = lineCheck.get(l.id);
      const name = l.productId ? labelFor(products, l.productId) : (l.description || 'line');
      if (ch.unitPrice !== undefined) {
        const delta = ch.unitPrice - l.unitPrice;
        const deltaNet = l.taxScheme === 'VAT_10' ? delta / 1.1 : delta;
        if (c && c.soldUnits > 0) {
          hinweise.push(`${name}: ${c.soldUnits} sold piece(s) get a cost correction of ${fmt(deltaNet * c.soldUnits)} BHD — booked today, profit attributed to the sale month. The sales invoice stays unchanged.`);
        }
        if (l.taxScheme === 'VAT_10') hinweise.push(`${name}: the 10% input VAT of this line is recalculated (${fmt(delta - deltaNet)} BHD VAT difference).`);
        hinweise.push(c?.productFollows
          ? `${name}: the item's purchase price in Collections follows (${fmt(delta)} BHD per piece). Sale prices are not changed.`
          : `${name}: the item keeps its purchase price — it is not tied to this purchase line only. Sale prices are not changed.`);
      }
      if (ch.quantity !== undefined) hinweise.push(`${name}: stock of this line becomes ${ch.quantity} piece(s).`);
    }
    if (geaendert.form.purchaseDate) hinweise.push('The stock lots of this purchase take the new date (stock age); the booking is reversed and posted again today.');
    if (geaendert.form.supplierId) {
      hinweise.push('The payable moves to the new supplier; the old supplier\'s details stay hidden with the purchase.');
      if (check.livePayments > 0) hinweise.push(`${check.livePayments} recorded payment(s) are re-booked to the new supplier — only if the money really went to them.`);
    }
    const total = R3(neu);
    const paid = purchase.paidAmount;
    return { total, delta: R3(total - purchase.totalAmount), remaining: R3(Math.max(0, total - paid)), overpaid: R3(Math.max(0, paid - total)), hinweise };
  }, [purchase, check, geaendert, products]);

  if (!purchase) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Purchase not found</p>
      </div>
    );
  }

  const owner = perm.isOwner;
  const financial = geaendert ? isFinancialPurchaseEdit(geaendert.form) : false;
  const dateLock: EditLock | undefined = !owner ? NUR_OWNER : check?.date;
  const supplierLock: EditLock | undefined = !owner ? NUR_OWNER : check?.supplier;
  const needsPayConfirm = !!geaendert?.form.supplierId && (check?.livePayments ?? 0) > 0;
  const blocker = !check ? 'Checking what can be edited…'
    : purchase.status === 'CANCELLED' ? 'A cancelled purchase is not edited.'
    : geaendert?.invalid ? geaendert.invalid
    : !geaendert?.anything ? 'Nothing changed yet.'
    : !reason.trim() ? 'Please enter a reason for this edit.'
    : financial && !owner ? NUR_OWNER_TEXT
    : needsPayConfirm && !confirmPay ? 'Confirm that the recorded payments went to the new supplier.'
    : '';

  async function speichern() {
    if (!purchase || !geaendert || blocker || w.busy) return;
    setFehler('');
    const op = isFinancialPurchaseEdit(geaendert.form) ? PURCHASE_EDIT_OP.CORRECT : PURCHASE_EDIT_OP.UPDATE;
    const r = await savePurchaseEdit(viaWrites(w, op), purchase, geaendert.form);
    if (r.kind !== 'ok') {
      setFehler(fehlertext(r));
      // Ein Nein (z. B. RECORD_CHANGED) lädt Beleg und Sperren neu — der nächste Klick prüft gegen die neue Fassung.
      // Ein OFFENER Ausgang (Antwort verloren) lädt bewusst nichts: der nächste Klick muss DENSELBEN Auftrag mit
      // derselben Kennung wiederholen (sonst wiese die Ablage ihn als „geändert" ab und er bliebe ungeklärt).
      if (r.kind !== 'unknown') { setTick((t) => t + 1); loadPurchases(); }
      return;
    }
    loadPurchases(); loadProducts(); loadSuppliers();
    navigate(`/purchases/${purchase.id}`);
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }} data-purchase-edit-page>
        <div className="flex items-center justify-between" style={{ marginBottom: 24 }}>
          <button onClick={goBack} className="flex items-center gap-2 cursor-pointer"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}>
            <ArrowLeft size={16} /> Back
          </button>
          <Button variant="primary" onClick={() => void speichern()} disabled={!!blocker || w.busy} data-purchase-edit-save>
            <Save size={14} /> {w.busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>

        <h1 className="text-display-m" style={{ color: '#0F0F10' }}>Edit {purchase.purchaseNumber}</h1>
        <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4, marginBottom: 24 }}>
          The purchase keeps its number, documents, payments and history. Every change is logged with its reason.
        </p>

        {/* Grund — Pflicht */}
        <Card>
          <Input required label="REASON FOR THIS EDIT" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. price entered wrongly, wrong supplier selected" data-purchase-edit-reason />
        </Card>

        {/* Kopf */}
        <div style={{ marginTop: 20 }}><Card>
          <span className="text-overline">PURCHASE</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 12 }}>
            <div>
              <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>SUPPLIER</label>
              <SearchSelect placeholder="Search suppliers..." options={supplierOptions} value={supplierId}
                onChange={setSupplierId} disabled={!supplierLock?.allowed || w.busy} />
              <Gesperrt lock={supplierLock} />
              {needsPayConfirm && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#0F0F10', marginTop: 8 }}>
                  <input type="checkbox" checked={confirmPay} onChange={(e) => setConfirmPay(e.target.checked)} data-purchase-edit-confirm-pay />
                  The {check?.livePayments} recorded payment(s) really went to the new supplier.
                </label>
              )}
            </div>
            <div>
              <Input label="PURCHASE DATE" type="date" max={latestBusinessDate()} value={date}
                onChange={(e) => setDate(e.target.value)} disabled={!dateLock?.allowed || w.busy} data-purchase-edit-date />
              <Gesperrt lock={dateLock} />
            </div>
            <div>
              <StaffSelect value={staffId} onChange={setStaffId} helper="Who handled this purchase (optional)." />
              <Gesperrt lock={check?.staff} />
            </div>
            <div>
              <Input label="NOTES" value={notes} onChange={(e) => setNotes(e.target.value)}
                disabled={!check?.notes.allowed || w.busy} data-purchase-edit-notes />
              <Gesperrt lock={check?.notes} />
            </div>
          </div>
        </Card></div>

        {/* Zeilen */}
        <div style={{ marginTop: 20 }}><Card>
          <span className="text-overline">ITEMS</span>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {purchase.lines.map((l) => {
              const c = check?.lines.find((x) => x.lineId === l.id);
              const priceLock: EditLock | undefined = !owner ? NUR_OWNER : c?.price;
              const qtyLock: EditLock | undefined = !owner ? NUR_OWNER : c?.quantityLock;
              return (
                <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 14, alignItems: 'start', paddingBottom: 12, borderBottom: '1px solid rgba(229,225,214,0.5)' }}
                  data-purchase-edit-line={l.id}>
                  <div>
                    <div style={{ fontSize: 13, color: '#0F0F10' }}>{l.productId ? labelFor(products, l.productId) : (l.description || '—')}</div>
                    <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                      {l.taxScheme === 'VAT_10' ? 'VAT 10% included' : 'No input VAT'}
                      {c && c.soldUnits > 0 ? ` · ${c.soldUnits} sold` : ''}
                    </div>
                  </div>
                  <div>
                    <Input label="UNIT PRICE (BHD)" type="number" step="0.001" min="0" value={prices[l.id] ?? ''}
                      onChange={(e) => setPrices((s) => ({ ...s, [l.id]: e.target.value }))}
                      disabled={!priceLock?.allowed || w.busy} data-purchase-edit-price={l.id} />
                    <Gesperrt lock={priceLock} />
                  </div>
                  <div>
                    <Input label="QUANTITY" type="number" step="1" min="1" value={qtys[l.id] ?? ''}
                      onChange={(e) => setQtys((s) => ({ ...s, [l.id]: e.target.value }))}
                      disabled={!qtyLock?.allowed || w.busy} data-purchase-edit-qty={l.id} />
                    <Gesperrt lock={qtyLock} />
                  </div>
                  <div style={{ paddingTop: 20 }}>
                    {l.productId && (
                      <Button variant="ghost" onClick={() => navigate(`/collection/${l.productId}?edit=1&fromPurchase=${purchase.id}`)}
                        data-purchase-edit-item={l.productId}>
                        <Edit3 size={13} /> Edit item
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {geaendert?.form.correctionKind !== undefined && check && (
            <div style={{ marginTop: 14 }}>
              <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>WHY DOES THE PRICE CHANGE?</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {check.correctionKinds.map((ck) => (
                  <label key={ck.kind} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: ck.allowed ? '#0F0F10' : '#9CA3AF' }}>
                    <input type="radio" name="correction-kind" checked={kind === ck.kind} disabled={!ck.allowed}
                      onChange={() => setKind(ck.kind)} data-purchase-edit-kind={ck.kind} />
                    <span>
                      {ck.kind === 'ENTRY_ERROR' ? 'The price was entered wrongly' : 'The supplier gave a discount later'}
                      {!ck.allowed && ck.reason ? <span style={{ display: 'block', fontSize: 11, color: '#B45309' }}>{ck.reason}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </Card></div>

        {/* Ausweisfoto (D10) */}
        <div style={{ marginTop: 20 }}><Card>
          <span className="text-overline">SUPPLIER ID PHOTO</span>
          <div style={{ display: 'flex', gap: 32, marginTop: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 6 }}>Current photo of this purchase</div>
              {idUrl || legacyIdUrl
                ? <img src={idUrl ?? legacyIdUrl ?? ''} alt="Current ID photo" style={{ maxWidth: 240, maxHeight: 150, border: '1px solid #E5E9EE', borderRadius: 6, objectFit: 'contain' }} />
                : <div style={{ fontSize: 12, color: '#9CA3AF' }}>No ID photo on this purchase</div>}
            </div>
            <div>
              <IdentityPhotoField refDoc={null} value={idPhoto} label="New ID photo (camera or file)"
                onChange={(v) => setIdPhoto(typeof v === 'string' ? v : undefined)}
                editable={!!check?.identityPhoto.allowed && !w.busy} />
              <Gesperrt lock={check?.identityPhoto} />
              {idPhoto && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#0F0F10', marginTop: 8 }}>
                  <input type="checkbox" checked={alsoPerson} onChange={(e) => setAlsoPerson(e.target.checked)} data-purchase-edit-id-person />
                  Also make it the supplier's current ID document (otherwise only this purchase changes).
                </label>
              )}
            </div>
          </div>
          <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 10 }}>
            The replaced photo is kept hidden as the original record; other purchases keep their own photo.
          </p>
        </Card></div>

        {/* Wirkung vorab */}
        {vorschau && geaendert?.anything && (
          <div style={{ marginTop: 20 }} data-purchase-edit-preview><Card>
            <span className="text-overline">WHAT SAVING WILL DO</span>
            <div style={{ display: 'flex', gap: 32, marginTop: 12, fontSize: 13 }}>
              <div>Total <span className="font-mono"><Bhd v={purchase.totalAmount} /> → <Bhd v={vorschau.total} /> BHD</span></div>
              <div>Remaining <span className="font-mono"><Bhd v={vorschau.remaining} /> BHD</span></div>
              {vorschau.overpaid > 0 && <div style={{ color: '#B45309' }}>Overpaid <span className="font-mono"><Bhd v={vorschau.overpaid} /> BHD</span> → supplier credit</div>}
            </div>
            {vorschau.hinweise.length > 0 && (
              <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 12, color: '#4B5563', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {vorschau.hinweise.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            )}
          </Card></div>
        )}

        <div style={{ marginTop: 16 }}>
          {blocker && (geaendert?.anything || !!geaendert?.invalid) && <div style={{ fontSize: 12, color: '#6B7280' }} data-purchase-edit-blocker>{blocker}</div>}
          <WriteError text={fehler} />
        </div>
      </div>
    </div>
  );
}
