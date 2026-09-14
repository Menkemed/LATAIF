import { useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw, Download, Send, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { logCustomerMessageOnPrimary } from '@/stores/customerMessageStore';
import { useSharedWrite, fehlertext } from '@/core/data/shared-write';
import {
  messageLogInput, type LoggedChannel, type MessageKind, type MessageLogInput,
} from '@/core/customers/message-house';
import { aiTextLocked, AI_TEXT_ON_PRIMARY } from '@/core/ai/ai-availability';

// Der Name des geprüften Fernbefehls (`bridge/message-commands.ts`). Hier als Wert, nicht als
// Import: die Oberfläche lädt die Befehlsdatei nicht (sie meldet beim Laden ihren Handler an).
const OP_CUSTOMERS_LOG_MESSAGE = 'customers.log_message';

// Die Nachrichtenarten wohnen im Haus — dieselbe Liste, die das Protokoll annimmt.
export type MessageType = MessageKind;

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
  const waNumber = sanitizePhone(customerWhatsapp || customerPhone);
  // POST-PARITY R7B PP-3 — auf PC2 schreibt die KI keinen Text (der Schlüssel bleibt am Primary);
  // die Maske sagt es gleich beim Öffnen, und der Text wird von Hand geschrieben.
  const aiLocked = aiTextLocked();

  // CENTRAL-UI-PARITY R6B/R6E — kein Schein-Erfolg beim Protokoll. Kopieren und WhatsApp gehen
  // immer; der Eintrag in der Kundenhistorie ist die EINE Schreibhandlung dieser Maske und läuft auf
  // beiden Rechnern über denselben Anschluss: am Primary die Hausfolge (`runOnPrimary`), auf PC2 der
  // geprüfte Fernbefehl `customers.log_message`. „Added" steht nur nach einem echten Erfolg; jeder
  // andere Ausgang wird mit seinem Grund gesagt (R6B sagte auf PC2 nur „not logged").
  const logWrite = useSharedWrite<{ messageId: string }>(OP_CUSTOMERS_LOG_MESSAGE);
  const [logNote, setLogNote] = useState('');
  const [logStatus, setLogStatus] = useState<'' | 'busy' | 'ok' | 'error'>('');
  // Der Rumpf des OFFENEN Versuchs. Bleibt ein Versuch ohne Antwort, wiederholt derselbe Klick mit
  // demselben Text DIESELBE Kennung (genau ein Eintrag). Ein anderer Weg oder Text ist eine andere
  // Nachricht — dann ein neuer Versuch; unter der alten Kennung wiese der Primary ihn ab.
  const offenerRumpf = useRef('');
  async function log(channel: LoggedChannel) {
    if (!customerId) return;
    let input: MessageLogInput;
    try {
      input = messageLogInput({ customerId, channel, body: text, kind: type, linkedEntityType, linkedEntityId });
    } catch (e) {
      // Dieselbe Eingaberegel wie am Primary — ein leerer Text verlässt den Rechner nicht.
      setLogStatus('error');
      setLogNote(e instanceof Error ? e.message : String(e));
      return;
    }
    const rumpf: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) rumpf[k] = v;
    const key = JSON.stringify(rumpf);
    if (logWrite.openCommandId && offenerRumpf.current !== key) logWrite.forget();
    offenerRumpf.current = key;
    setLogStatus('busy'); setLogNote('Adding to the customer history…');
    const r = await logWrite.save({
      local: async () => ({ messageId: (await logCustomerMessageOnPrimary(input)).id }),
      remote: () => rumpf,
      shape: (v) => ({ messageId: String(v.messageId ?? '') }),
    });
    if (r.kind === 'ok') {
      setLogStatus('ok');
      setLogNote('Added to the customer history.');
    } else {
      setLogStatus('error');
      // Ein offener Ausgang ist kein „nicht eingetragen" — er kann gelaufen sein.
      setLogNote(r.kind === 'unknown' ? fehlertext(r) : `Not added to the customer history: ${fehlertext(r)}`);
    }
  }

  async function generate(t: MessageType) {
    if (aiLocked) { setLoading(false); setError(null); return; }
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
      setText(''); setError(null); setCopied(false); setLogNote(''); setLogStatus('');
      generate(initialType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialType, customerName, productLabel]);

  function handleTypeChange(t: MessageType) {
    setType(t);
    generate(t);
  }

  // Die Handlung des Menschen zuerst und unabhängig vom Protokoll: Kopieren bzw. WhatsApp öffnen
  // passiert IM Klick (ein `window.open` nach einem `await` blockt der Browser als Popup). Das
  // Protokoll folgt und meldet seinen Ausgang selbst.
  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    void log('ai_copy');
  }

  function handleWhatsApp() {
    if (!waNumber) { alert('No phone/WhatsApp number on this customer'); return; }
    const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
    void log('whatsapp');
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
                background: `#F2F7FA center/cover no-repeat url(${productImage})`,
                border: '1px solid #E5E9EE',
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
                background: 'transparent', border: '1px solid #D5D9DE',
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
              disabled={loading || aiLocked}
              title={aiLocked ? AI_TEXT_ON_PRIMARY : undefined}
              data-ai-locked={aiLocked ? 'true' : undefined}
              className="cursor-pointer flex items-center gap-1 transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, opacity: loading || aiLocked ? 0.4 : 1 }}
            >
              <RefreshCw size={12} /> Regenerate
            </button>
          </div>
          {aiLocked && (
            <div data-ai-locked-note style={{ fontSize: 11, color: '#6B7280', marginBottom: 8 }}>{AI_TEXT_ON_PRIMARY}</div>
          )}

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
                background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 6,
                padding: 12, fontSize: 13, color: '#0F0F10', resize: 'vertical',
                lineHeight: 1.6, fontFamily: 'inherit',
              }}
            />
          )}

          <div className="flex justify-end gap-2" style={{ marginTop: 16 }}>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="secondary" data-message-copy onClick={handleCopy} disabled={!text || loading || logWrite.busy}>
              <Copy size={14} /> {copied ? 'Copied!' : 'Copy'}
            </Button>
            <Button variant="primary" data-message-whatsapp onClick={handleWhatsApp} disabled={!text || loading || !waNumber || logWrite.busy}>
              <Send size={14} /> WhatsApp
            </Button>
          </div>
          {logNote && (
            <div
              data-message-log-note
              data-message-log-status={logStatus}
              style={{ fontSize: 11, color: logStatus === 'error' ? '#AA6E6E' : '#4B5563', marginTop: 8, textAlign: 'right' }}
            >
              {logNote}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
