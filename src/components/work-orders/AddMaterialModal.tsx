// ═══════════════════════════════════════════════════════════
// LATAIF — Shared Add-Material Modal (v0.2.1)
//
// Eine Modal-Komponente fuer Repair + Custom-Order. Erfasst:
//  - Material-Kind: Diamond | Stone | Gold-Piece
//  - Description (z.B. "Round Brilliant")
//  - Quantity (pieces) + Carat per piece (bei Diamond/Stone)
//  - Karat + Gramm (bei Gold-Piece)
//  - Cost (BHD)
//  - Customer-Price (optional, mit Markup-Toggle, nur in Order-Mode)
//  - Supplier (optional): wenn gesetzt → A/P-Expense entsteht beim
//    commitOrderLineExpenses/commitRepairLineExpenses
//
// Der Modal ruft `onSubmit(data)` mit der vollstaendigen MaterialLineInput
// auf — der Caller (RepairDetail / OrderCreate / OrderDetail) entscheidet
// wie es persistiert wird (repair_line vs order_line).
// ═══════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useSupplierStore } from '@/stores/supplierStore';

export interface MaterialLineInput {
  materialKind: 'diamond' | 'stone' | 'gold';
  description: string;
  quantity: number;
  caratPerPiece?: number;      // diamond/stone
  weightGrams?: number;         // gold
  karat?: string;               // gold
  totalCost: number;            // BHD
  customerPrice?: number;       // optional Markup (nur Order-Mode)
  supplierId?: string;          // wenn gesetzt → A/P
  supplierName?: string;        // snapshot
}

interface AddMaterialModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: MaterialLineInput) => void;
  showCustomerPrice?: boolean;  // Custom-Order: ja; Repair: nein
}

const KARAT_OPTIONS = ['24K', '22K', '21K', '18K', '14K', '9K'];

export function AddMaterialModal({ open, onClose, onSubmit, showCustomerPrice = false }: AddMaterialModalProps) {
  const { suppliers, loadSuppliers } = useSupplierStore();
  const [kind, setKind] = useState<'diamond' | 'stone' | 'gold'>('diamond');
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('1');
  const [ct, setCt] = useState('');
  const [karat, setKarat] = useState('22K');
  const [grams, setGrams] = useState('');
  const [cost, setCost] = useState('');
  const [customerPrice, setCustomerPrice] = useState('');
  const [showMarkup, setShowMarkup] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setKind('diamond');
      setDescription('');
      setQty('1');
      setCt('');
      setKarat('22K');
      setGrams('');
      setCost('');
      setCustomerPrice('');
      setShowMarkup(false);
      setSupplierId('');
      setError('');
      loadSuppliers();
    }
  }, [open, loadSuppliers]);

  const supplierOptions = useMemo(() =>
    suppliers.filter(s => s.active).map(s => ({
      id: s.id, label: s.name, subtitle: s.phone || '', meta: s.email || '',
    })), [suppliers]);

  function handleConfirm() {
    setError('');
    const costNum = parseFloat(cost) || 0;
    if (!description.trim()) { setError('Description ist Pflicht'); return; }
    if (costNum <= 0) { setError('Cost > 0 erforderlich'); return; }
    const qtyNum = parseFloat(qty) || 1;
    if (qtyNum <= 0) { setError('Quantity > 0 erforderlich'); return; }

    const data: MaterialLineInput = {
      materialKind: kind,
      description: description.trim(),
      quantity: qtyNum,
      totalCost: costNum,
      supplierId: supplierId || undefined,
      supplierName: supplierId ? (suppliers.find(s => s.id === supplierId)?.name || undefined) : undefined,
    };
    if (kind === 'diamond' || kind === 'stone') {
      const ctNum = parseFloat(ct) || 0;
      if (ctNum <= 0) { setError('Carat per piece > 0 erforderlich fuer Diamond/Stone'); return; }
      data.caratPerPiece = ctNum;
    }
    if (kind === 'gold') {
      const g = parseFloat(grams) || 0;
      if (g <= 0) { setError('Gramm > 0 erforderlich fuer Gold-Piece'); return; }
      data.weightGrams = g;
      data.karat = karat;
    }
    if (showCustomerPrice) {
      const cp = parseFloat(customerPrice) || 0;
      data.customerPrice = showMarkup && cp > 0 ? cp : costNum;
    }
    onSubmit(data);
    onClose();
  }

  const kindButtons: Array<{ value: typeof kind; label: string; emoji: string }> = [
    { value: 'diamond', label: 'Diamond', emoji: '💎' },
    { value: 'stone', label: 'Stone', emoji: '🔮' },
    { value: 'gold', label: 'Gold piece', emoji: '🟡' },
  ];

  return (
    <Modal open={open} onClose={onClose} title="Add Material" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Material Kind picker */}
        <div>
          <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>MATERIAL KIND</span>
          <div className="flex gap-2 flex-wrap">
            {kindButtons.map(b => (
              <button
                key={b.value}
                type="button"
                onClick={() => setKind(b.value)}
                className="cursor-pointer rounded transition-all duration-200"
                style={{
                  padding: '8px 14px', fontSize: 13,
                  border: `1px solid ${kind === b.value ? '#0F0F10' : '#D5D9DE'}`,
                  color: kind === b.value ? '#0F0F10' : '#6B7280',
                  background: kind === b.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}
              >
                <span style={{ marginRight: 6 }}>{b.emoji}</span>{b.label}
              </button>
            ))}
          </div>
        </div>

        <Input
          label="DESCRIPTION"
          placeholder={kind === 'diamond' ? 'Round Brilliant, Princess cut...' : kind === 'stone' ? 'Sapphire, Ruby, ...' : 'Bar, Coin, Chain...'}
          value={description}
          onChange={e => setDescription(e.target.value)}
          autoFocus
        />

        {/* Quantity + Carat/Grams */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input
            label="QUANTITY"
            type="number"
            step="1"
            min="1"
            value={qty}
            onChange={e => setQty(e.target.value)}
          />
          {(kind === 'diamond' || kind === 'stone') && (
            <Input
              label="CARAT (CT) PER PIECE"
              type="number"
              step="0.01"
              placeholder="0.50"
              value={ct}
              onChange={e => setCt(e.target.value)}
            />
          )}
          {kind === 'gold' && (
            <Input
              label="WEIGHT (GRAMS)"
              type="number"
              step="0.001"
              placeholder="0.000"
              value={grams}
              onChange={e => setGrams(e.target.value)}
            />
          )}
        </div>

        {kind === 'gold' && (
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>KARAT</span>
            <div className="flex gap-2 flex-wrap">
              {KARAT_OPTIONS.map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKarat(k)}
                  className="cursor-pointer rounded"
                  style={{
                    padding: '6px 12px', fontSize: 12,
                    border: `1px solid ${karat === k ? '#0F0F10' : '#D5D9DE'}`,
                    color: karat === k ? '#0F0F10' : '#6B7280',
                    background: karat === k ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}
                >{k}</button>
              ))}
            </div>
          </div>
        )}

        {/* Cost + Customer Price */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Input
            label="TOTAL COST (BHD)"
            type="number"
            step="0.001"
            placeholder="0.000"
            value={cost}
            onChange={e => setCost(e.target.value)}
          />
          {showCustomerPrice && (
            <div>
              <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                <span className="text-overline">CUSTOMER PRICE (BHD)</span>
                <button
                  type="button"
                  onClick={() => setShowMarkup(!showMarkup)}
                  style={{
                    fontSize: 10, color: '#3D7FFF', background: 'transparent',
                    border: 'none', cursor: 'pointer', textDecoration: 'underline',
                  }}
                >
                  {showMarkup ? 'Use 1:1' : 'Add markup'}
                </button>
              </div>
              <Input
                label=""
                type="number"
                step="0.001"
                placeholder={showMarkup ? '0.000' : '(same as cost)'}
                value={showMarkup ? customerPrice : cost}
                onChange={e => setCustomerPrice(e.target.value)}
                disabled={!showMarkup}
              />
            </div>
          )}
        </div>

        {/* Supplier picker */}
        <div>
          <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
            SUPPLIER (OPTIONAL — wenn gesetzt: A/P wird gebucht)
          </span>
          <SearchSelect
            options={supplierOptions}
            value={supplierId}
            onChange={(id) => setSupplierId(id)}
            placeholder="Pick a supplier — leer = aus eigenem Bestand"
          />
          {supplierId && (
            <p style={{ fontSize: 11, color: '#16A34A', marginTop: 6 }}>
              ✓ A/P-Schuld an {suppliers.find(s => s.id === supplierId)?.name} wird beim Status-Wechsel zu „arrived" gebucht.
            </p>
          )}
        </div>

        {error && (
          <div style={{
            padding: '8px 10px', background: 'rgba(220,38,38,0.06)',
            border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6,
            fontSize: 12, color: '#DC2626',
          }}>{error}</div>
        )}

        <div className="flex justify-end gap-3" style={{ paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm}>Add Material</Button>
        </div>
      </div>
    </Modal>
  );
}
