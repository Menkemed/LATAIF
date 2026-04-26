// ═══════════════════════════════════════════════════════════
// LATAIF — AI Business Review Engine (Chat UI)
// User asks in natural language, OpenAI calls our local
// tools, the page renders the structured result blocks.
// ═══════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Send, Loader2, Download, ExternalLink, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageLayout } from '@/components/layout/PageLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { isAiConfigured } from '@/core/ai/ai-service';
import { runBusinessQuery, type ChatMsg } from '@/core/ai/business-engine';
import type { AIBlock, Cell, KPI, Tone } from '@/core/ai/business-tools';
import { exportExcel } from '@/core/utils/export-file';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  blocks?: AIBlock[];
  error?: string;
}

const QUICK_PROMPTS: { label: string; query: string }[] = [
  { label: 'Top customers (30 days)',  query: 'Show me the top 10 customers of the last 30 days by revenue and margin.' },
  { label: 'Monthly business review',  query: 'Create a business review for this month.' },
  { label: 'Open receivables',         query: 'List all open receivables sorted by amount.' },
  { label: 'Slow inventory',           query: 'Which products tie up too much capital in stock right now?' },
  { label: 'Recent FINAL invoices',    query: 'List the 20 most recent FINAL invoices.' },
];

function toneColor(t?: Tone): string {
  switch (t) {
    case 'green':   return '#16A34A';
    case 'red':     return '#DC2626';
    case 'orange':  return '#FF8730';
    case 'blue':    return '#3D7FFF';
    default:        return '#0F0F10';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// Minimal Markdown → JSX (headings, bold, bullets, paragraphs).
function MarkdownView({ md }: { md: string }) {
  const out: any[] = [];
  let bullets: string[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push(<p key={`p${out.length}`} style={{ fontSize: 13, color: '#0F0F10', margin: '6px 0', lineHeight: 1.55 }} dangerouslySetInnerHTML={{ __html: para.join(' ') }} />); para = []; } };
  const flushBullets = () => { if (bullets.length) { out.push(<ul key={`u${out.length}`} style={{ fontSize: 13, color: '#0F0F10', margin: '6px 0 6px 18px', lineHeight: 1.6 }}>{bullets.map((b, i) => <li key={i} dangerouslySetInnerHTML={{ __html: b }} />)}</ul>); bullets = []; } };

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) { flushPara(); flushBullets(); continue; }
    const h2 = line.match(/^##\s+(.+)$/);
    const h3 = line.match(/^###\s+(.+)$/);
    const h1 = line.match(/^#\s+(.+)$/);
    const li = line.match(/^[-*]\s+(.+)$/);
    if (h1) { flushPara(); flushBullets(); out.push(<h2 key={`h${out.length}`} style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px' }}>{h1[1]}</h2>); continue; }
    if (h2) { flushPara(); flushBullets(); out.push(<h3 key={`h${out.length}`} style={{ fontSize: 15, fontWeight: 600, margin: '12px 0 6px' }}>{h2[1]}</h3>); continue; }
    if (h3) { flushPara(); flushBullets(); out.push(<h4 key={`h${out.length}`} style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 4px', color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h3[1]}</h4>); continue; }
    const withBold = escapeHtml(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
    if (li) { flushPara(); bullets.push(escapeHtml(li[1]).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')); continue; }
    flushBullets();
    para.push(withBold);
  }
  flushPara(); flushBullets();
  return <>{out}</>;
}

function downloadBlockAsExcel(b: AIBlock) {
  if (b.type !== 'table' && b.type !== 'review') return;
  const title = b.type === 'table' ? b.title : b.title;
  const rows: string[][] = [];
  if (b.type === 'table') {
    rows.push(b.columns);
    for (const r of b.rows) {
      rows.push(r.map(c => typeof c === 'object' ? c.text : String(c)));
    }
  } else if (b.type === 'review') {
    rows.push(['Metric', 'Value']);
    (b.kpis || []).forEach(k => rows.push([k.label, k.value]));
  }
  const header = rows[0];
  const body = rows.slice(1);
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8">
<style>table{border-collapse:collapse;font-family:Arial,sans-serif}th,td{border:1px solid #ccc;padding:6px 10px;font-size:12px}th{background:#F2F7FA}</style>
</head><body><h3>${escapeHtml(title)}</h3><table>
<thead><tr>${header.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
<tbody>${body.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></body></html>`;
  const safeName = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  exportExcel(`${safeName}.xls`, html);
}

function CellView({ c }: { c: Cell }) {
  if (typeof c === 'object' && c.link) {
    return (
      <Link to={c.link} className="cursor-pointer transition-colors" style={{ color: '#3D7FFF', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
        onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
        {c.text}
        <ExternalLink size={11} style={{ opacity: 0.5 }} />
      </Link>
    );
  }
  return <>{typeof c === 'object' ? c.text : c}</>;
}

function KpiGrid({ kpis }: { kpis: KPI[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(6, kpis.length)}, minmax(0, 1fr))`, gap: 10, marginBottom: 12 }}>
      {kpis.map((k, i) => (
        <div key={i} style={{ padding: '12px 14px', background: '#F2F7FA', borderRadius: 10, border: '1px solid #E5E9EE' }}>
          <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{k.label}</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: toneColor(k.tone), lineHeight: 1.2 }}>{k.value}</div>
          {k.hint && <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>{k.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function BlockView({ b }: { b: AIBlock }) {
  if (b.type === 'error') {
    return (
      <div style={{ padding: 12, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, color: '#DC2626', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
        <AlertTriangle size={14} /> {b.message}
      </div>
    );
  }

  if (b.type === 'text') {
    return <div style={{ padding: '8px 0' }}><MarkdownView md={b.markdown} /></div>;
  }

  if (b.type === 'kpis') {
    return (
      <Card>
        <div style={{ fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>{b.title}</div>
        <KpiGrid kpis={b.kpis} />
      </Card>
    );
  }

  if (b.type === 'review') {
    return (
      <Card>
        <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>{b.title}</div>
          <button onClick={() => downloadBlockAsExcel(b)} className="cursor-pointer transition-colors flex items-center gap-1"
            style={{ fontSize: 11, color: '#6B7280', background: 'none', border: '1px solid #E5E9EE', borderRadius: 6, padding: '4px 8px' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
            onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}>
            <Download size={12} /> Excel
          </button>
        </div>
        {b.kpis && b.kpis.length > 0 && <KpiGrid kpis={b.kpis} />}
        <MarkdownView md={b.markdown} />
        {b.recommendations && b.recommendations.length > 0 && (
          <div style={{ marginTop: 12, padding: 12, background: 'rgba(255,135,48,0.06)', border: '1px solid rgba(255,135,48,0.20)', borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: '#FF8730', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontWeight: 600 }}>Recommendations</div>
            <ul style={{ fontSize: 13, color: '#0F0F10', paddingLeft: 18, margin: 0, lineHeight: 1.55 }}>
              {b.recommendations.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
      </Card>
    );
  }

  // table
  const cols = b.columns;
  const align = b.align || cols.map(() => 'left' as const);
  const gridCols = cols.map(() => 'minmax(0, 1fr)').join(' ');
  return (
    <Card>
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>{b.title}</div>
        <button onClick={() => downloadBlockAsExcel(b)} className="cursor-pointer transition-colors flex items-center gap-1"
          style={{ fontSize: 11, color: '#6B7280', background: 'none', border: '1px solid #E5E9EE', borderRadius: 6, padding: '4px 8px' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#0F0F10')}
          onMouseLeave={e => (e.currentTarget.style.color = '#6B7280')}>
          <Download size={12} /> Excel
        </button>
      </div>
      <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 12px', background: '#F2F7FA', fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          {cols.map((c, i) => <span key={i} style={{ textAlign: align[i], minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c}</span>)}
        </div>
        {b.rows.map((row, ri) => (
          <div key={ri} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 12px', borderTop: '1px solid #E5E9EE', alignItems: 'center', fontSize: 13 }}>
            {row.map((c, ci) => (
              <span key={ci} style={{ textAlign: align[ci], minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#0F0F10', fontVariantNumeric: align[ci] === 'right' ? 'tabular-nums' : 'normal' }}>
                <CellView c={c} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AIPage() {
  const configured = isAiConfigured();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, loading]);

  async function ask(q: string) {
    if (!q.trim() || loading) return;
    const turnUser: ChatTurn = { id: `u-${Date.now()}`, role: 'user', text: q };
    setTurns(t => [...t, turnUser]);
    setInput('');
    setLoading(true);

    try {
      const result = await runBusinessQuery(q, history);
      setHistory(result.history);
      const turnAi: ChatTurn = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        text: result.finalText || undefined,
        blocks: result.blocks,
      };
      setTurns(t => [...t, turnAi]);
    } catch (e: any) {
      setTurns(t => [...t, { id: `e-${Date.now()}`, role: 'assistant', error: e?.message || String(e) }]);
    } finally {
      setLoading(false);
    }
  }

  const showWelcome = useMemo(() => turns.length === 0 && !loading, [turns, loading]);

  return (
    <PageLayout
      title="AI"
      subtitle="Business Review Engine — ask anything about your CRM data."
    >
      {!configured && (
        <Card>
          <div style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <AlertTriangle size={20} style={{ color: '#DC2626', flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10', marginBottom: 4 }}>OpenAI API key missing</div>
              <div style={{ fontSize: 13, color: '#6B7280' }}>Configure your API key in <Link to="/settings" style={{ color: '#3D7FFF' }}>Settings → AI</Link> to enable the engine.</div>
            </div>
          </div>
        </Card>
      )}

      {/* Chat scroll area */}
      <div ref={scrollRef} style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto', padding: '4px 4px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {showWelcome && (
          <Card>
            <div style={{ padding: 8 }}>
              <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
                <Sparkles size={16} style={{ color: '#715DE3' }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10' }}>What would you like to know?</span>
              </div>
              <p style={{ fontSize: 13, color: '#6B7280', margin: '6px 0 14px', lineHeight: 1.55 }}>
                Ask in German or English. The AI calls structured tools on your CRM data and returns tables, KPIs, or full reviews — with clickable links.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {QUICK_PROMPTS.map(p => (
                  <button key={p.label} onClick={() => ask(p.query)} disabled={!configured}
                    className="cursor-pointer transition-colors"
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 999, background: '#F2F7FA', border: '1px solid #E5E9EE', color: '#0F0F10' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#E5E9EE')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#F2F7FA')}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        )}

        {turns.map(t => (
          <div key={t.id}>
            {t.role === 'user' ? (
              <div className="flex justify-end">
                <div style={{ maxWidth: '80%', padding: '10px 14px', background: '#0F0F10', color: '#FFFFFF', borderRadius: 12, fontSize: 13, lineHeight: 1.5 }}>{t.text}</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {t.error && (
                  <div style={{ padding: 12, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 8, color: '#DC2626', fontSize: 13 }}>{t.error}</div>
                )}
                {t.blocks?.map((b, i) => <BlockView key={i} b={b} />)}
                {t.text && (
                  <Card>
                    <div className="flex items-start gap-2">
                      <Sparkles size={14} style={{ color: '#715DE3', marginTop: 2, flexShrink: 0 }} />
                      <div style={{ minWidth: 0, width: '100%' }}><MarkdownView md={t.text} /></div>
                    </div>
                  </Card>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2" style={{ fontSize: 13, color: '#6B7280', padding: 4 }}>
            <Loader2 size={14} className="animate-spin" /> Analysing…
          </div>
        )}
      </div>

      {/* Input bar */}
      <div style={{ position: 'sticky', bottom: 0, padding: '12px 0', background: '#FFFFFF', borderTop: '1px solid #E5E9EE' }}>
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            placeholder={configured ? 'Ask anything about your business — e.g. „Show me overdue invoices over 1 000 BHD"' : 'Configure API key in Settings to start.'}
            disabled={!configured || loading}
            rows={1}
            style={{
              flex: 1, minHeight: 44, maxHeight: 140, padding: '12px 14px', fontSize: 14, lineHeight: 1.4,
              border: '1px solid #D5D9DE', borderRadius: 10, background: '#FFFFFF', color: '#0F0F10',
              resize: 'none', fontFamily: 'inherit',
            }}
          />
          <Button variant="primary" onClick={() => ask(input)} disabled={!configured || loading || !input.trim()}>
            <Send size={14} /> Ask
          </Button>
        </div>
      </div>
    </PageLayout>
  );
}
