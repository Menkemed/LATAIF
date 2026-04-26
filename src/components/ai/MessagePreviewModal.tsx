import { useEffect, useState } from 'react';
import { Copy, RefreshCw, Download, Send, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useCustomerMessageStore } from '@/stores/customerMessageStore';

export type MessageType = 'follow_up' | 'repair_ready' | 'order_arrived' | 'promotion' | 'thank_you';

interface Props {
  open: boolean;
  onClose: () => void;
  type: MessageType;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerWhatsapp?: string;
  productImage?: string;
  productLabel?: string;
  details?: string;
  language?: string;
  allowTypeChange?: boolean;
  linkedEntityType?: string;
  linkedEntityId?: string;
}

const TITLES: Record<MessageType, string> = {
  follow_up: 'AI Follow-Up',
  repair_ready: 'AI Repair Ready Notification',
  order_arrived: 'AI Order Arrival Notification',
  promotion: 'AI Promotion Message',
  thank_you: 'AI Thank-You Message',
};

function sanitizePhone(raw?: string): string {
  if (!raw) return '';
  return raw.replace(/[^\d]/g, '');
}

export function MessagePreviewModal({
  open, onClose, type: initialType, customerId, customerName,
  customerPhone, customerWhatsapp,
  productImage, productLabel,
  details, language, allowTypeChange = false,
  linkedEntityType, linkedEntityId,
}: Props) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [type, setType] = useState<MessageType>(initialType);
  const { logMessage } = useCustomerMessageStore();

  const waNumber = sanitizePhone(customerWhatsapp || customerPhone);

  function log(channel: 'whatsapp' | 'ai_copy') {
    if (!customerId || !text.trim()) return;
    logMessage({
      customerId, channel, body: text,
      kind: type, linkedEntityType, linkedEntityId,
    });
  }

  async function generate(t: MessageType) {
    setLoading(true); setError(null);
    try {
      const ai = await import('@/core/ai/ai-service');
      if (!ai.isAiConfigured()) {
        setError('Set your OpenAI API key in Settings > AI');
        setLoading(false);
        return;
      }
      const result = await ai.generateMessage({
        type: t, customerName,
        details: [productLabel ? `Item: ${productLabel}` : '', details || ''].filter(Boolean).join('\n'),
        language: language || 'English',
      });
      setText(result.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }

  useEffect(() => {
    if (open) {
      setType(initialType);
      setText(''); setError(null); setCopied(false);
      generate(initialType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialType, customerName, productLabel]);

  function handleTypeChange(t: MessageType) {
    setType(t);
    generate(t);
  }

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    log('ai_copy');
    setTimeout(() => setCopied(false), 1500);
  }

  function handleWhatsApp() {
    if (!waNumber) { alert('No phone/WhatsApp number on this customer'); return; }
    const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`;
    log('whatsapp');
    window.open(url, '_blank');
  }

  function handleDownloadImage() {
    if (!productImage) return;
    const a = document.createElement('a');
    a.href = productImage;
    a.download = `${productLabel || 'item'}.jpg`.replace(/[^\w.\- ]/g, '_');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <Modal open={open} onClose={onClose} title={TITLES[type]} width={760}>
      <div style={{ display: 'grid', gridTemplateColumns: productImage ? '220px 1fr' : '1fr', gap: 20 }}>
        {productImage && (
          <div>
            <div
              style={{
                width: '100%', aspectRatio: '1 / 1', borderRadius: 8,
                background: `#EFECE2 center/cover no-repeat url(${productImage})`,
                border: '1px solid #E5E1D6',
              }}
            />
            {productLabel && (
              <div style={{ marginTop: 10, fontSize: 12, color: '#4B5563', textAlign: 'center' }}>
                {productLabel}
              </div>
            )}
            <button
              onClick={handleDownloadImage}
              className="cursor-pointer flex items-center justify-center gap-2 w-full transition-colors"
              style={{
                marginTop: 10, padding: '8px 10px', fontSize: 11,
                background: 'transparent', border: '1px solid #D5D1C4',
                borderRadius: 6, color: '#4B5563',
              }}
            >
              <Download size={12} /> Download image
            </button>
            <p style={{ marginTop: 10, fontSize: 10, color: '#6B7280', lineHeight: 1.5 }}>
              WhatsApp can't attach images from a browser link. Download and send it alongside the text.
            </p>
          </div>
        )}

        <div className="flex flex-col" style={{ minHeight: 300 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <span className="text-overline">To: {customerName}{waNumber ? ` \u00b7 +${waNumber}` : ''}</span>
            <button
              onClick={() => generate(type)}
              disabled={loading}
              className="cursor-pointer flex items-center gap-1 transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, opacity: loading ? 0.4 : 1 }}
            >
              <RefreshCw size={12} /> Regenerate
            </button>
          </div>

          {allowTypeChange && (
            <div className="flex flex-wrap gap-1" style={{ marginBottom: 10 }}>
              {(['follow_up', 'thank_you', 'promotion', 'repair_ready', 'order_arrived'] as MessageType[]).map(t => (
                <button
                  key={t}
                  onClick={() => handleTypeChange(t)}
                  disabled={loading}
                  className="cursor-pointer transition-colors"
                  style={{
                    padding: '4px 10px', fontSize: 11, borderRadius: 999, border: 'none',
                    background: type === t ? 'rgba(15,15,16,0.1)' : 'transparent',
                    color: type === t ? '#0F0F10' : '#6B7280',
                    opacity: loading && type !== t ? 0.4 : 1,
                  }}
                >
                  {t.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </button>
              ))}
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2" style={{ padding: '40px 0', color: '#6B7280', fontSize: 13 }}>
              <Sparkles size={14} /> Generating...
            </div>
          )}

          {error && (
            <div style={{ padding: '12px 14px', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(170,110,110,0.25)', borderRadius: 6, color: '#CC8888', fontSize: 12 }}>
              {error}
            </div>
          )}

          {!loading && !error && (
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={8}
              className="w-full outline-none"
              style={{
                background: '#EFECE2', border: '1px solid #E5E1D6', borderRadius: 6,
                padding: 12, fontSize: 13, color: '#0F0F10', resize: 'vertical',
                lineHeight: 1.6, fontFamily: 'inherit',
              }}
            />
          )}

          <div className="flex justify-end gap-2" style={{ marginTop: 16 }}>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="secondary" onClick={handleCopy} disabled={!text || loading}>
              <Copy size={14} /> {copied ? 'Copied!' : 'Copy'}
            </Button>
            <Button variant="primary" onClick={handleWhatsApp} disabled={!text || loading || !waNumber}>
              <Send size={14} /> WhatsApp
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
