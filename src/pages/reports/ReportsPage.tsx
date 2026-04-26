import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Printer, Loader2, AlertTriangle, Zap, CheckCircle2, Bell } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { currentBranchId } from '@/core/db/helpers';
import { buildReportContext, periodForMonth, periodForQuarter, periodForYear, type ReportPeriod } from '@/core/reports/context';
import { generateExecutiveSummary, generateInsightAlerts, isAiConfigured, type InsightAlert } from '@/core/ai/ai-service';
import { useTaskStore } from '@/stores/taskStore';
import logoUrl from '@/assets/logo.png';

type Granularity = 'month' | 'quarter' | 'year';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  const flushPara = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.join(' ')}</p>`);
      paragraph = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); continue; }
    const h2 = line.match(/^##\s+(.+)$/);
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) { flushPara(); out.push(`<h1>${esc(h1[1])}</h1>`); continue; }
    if (h2) { flushPara(); out.push(`<h2>${esc(h2[1])}</h2>`); continue; }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) { flushPara(); out.push(`<li>${esc(bullet[1])}</li>`); continue; }
    // Bold **text**
    const withBold = esc(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    paragraph.push(withBold);
  }
  flushPara();
  return out.join('\n');
}

export function ReportsPage() {
  const now = new Date();
  const [branchId, setBranchId] = useState('');
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);
  const [summary, setSummary] = useState<string>('');
  const [summaryPeriod, setSummaryPeriod] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  // Insight alerts
  const [alerts, setAlerts] = useState<InsightAlert[] | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [createdTaskIds, setCreatedTaskIds] = useState<Set<number>>(new Set());
  const createTask = useTaskStore(s => s.createTask);

  useEffect(() => {
    try { setBranchId(currentBranchId()); } catch { setBranchId('branch-main'); }
  }, []);

  const period: ReportPeriod = useMemo(() => {
    if (granularity === 'year') return periodForYear(year);
    if (granularity === 'quarter') return periodForQuarter(year, quarter);
    return periodForMonth(year, month);
  }, [granularity, year, month, quarter]);

  const context = useMemo(() => {
    if (!branchId) return null;
    try { return buildReportContext({ branchId, period, withPreviousPeriod: true }); }
    catch (e) { console.warn('Report context failed', e); return null; }
  }, [branchId, period]);

  async function handleGenerate() {
    if (!isAiConfigured()) {
      setError('OpenAI API Key fehlt — trag ihn in den Einstellungen ein.');
      return;
    }
    if (!context) {
      setError('Kann keine Daten laden.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const text = await generateExecutiveSummary(context);
      setSummary(text);
      setSummaryPeriod(period.label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  async function handleInsights() {
    if (!isAiConfigured()) { setError('OpenAI API Key fehlt.'); return; }
    if (!branchId) return;
    setAlertsLoading(true);
    setError('');
    try {
      // Always scan the last 30 days for insights regardless of the selected report period
      const now = new Date();
      const from = new Date(Date.now() - 30 * 86400000);
      const scanPeriod: ReportPeriod = {
        label: 'Last 30 days',
        startISO: from.toISOString(),
        endISO: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
        granularity: 'custom',
      };
      const scanCtx = buildReportContext({ branchId, period: scanPeriod, withPreviousPeriod: true });
      const list = await generateInsightAlerts(scanCtx);
      setAlerts(list);
      setCreatedTaskIds(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAlertsLoading(false);
    }
  }

  function createTaskForAlert(idx: number, a: InsightAlert) {
    const priority = a.severity === 'urgent' ? 'urgent' : a.severity === 'warning' ? 'high' : 'medium';
    createTask({
      title: a.title,
      description: `${a.detail}\n\nEmpfohlen: ${a.suggestedAction}`,
      type: 'general',
      priority,
    });
    setCreatedTaskIds(prev => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }

  const fmt = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });

  return (
    <PageLayout
      title="Reports"
      subtitle="AI-generierter Business Review"
    >
      {/* Controls */}
      <Card className="no-print">
        <div style={{ padding: 4 }}>
          <div className="flex flex-wrap items-end gap-4">
            {/* Granularity */}
            <div>
              <span className="text-overline" style={{ marginBottom: 6 }}>ZEITRAUM</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {(['month', 'quarter', 'year'] as Granularity[]).map(g => (
                  <button key={g} onClick={() => setGranularity(g)}
                    className="cursor-pointer rounded" style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${granularity === g ? '#0F0F10' : '#D5D1C4'}`,
                      color: granularity === g ? '#0F0F10' : '#6B7280',
                      background: granularity === g ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{g === 'month' ? 'Monat' : g === 'quarter' ? 'Quartal' : 'Jahr'}</button>
                ))}
              </div>
            </div>

            {/* Year */}
            <div>
              <span className="text-overline" style={{ marginBottom: 6 }}>JAHR</span>
              <select value={year} onChange={e => setYear(parseInt(e.target.value))}
                style={{
                  marginTop: 8, background: '#EFECE2', border: '1px solid #D5D1C4', borderRadius: 8,
                  color: '#0F0F10', padding: '8px 12px', fontSize: 13, minWidth: 100,
                }}>
                {[now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear()].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            {/* Month */}
            {granularity === 'month' && (
              <div>
                <span className="text-overline" style={{ marginBottom: 6 }}>MONAT</span>
                <select value={month} onChange={e => setMonth(parseInt(e.target.value))}
                  style={{
                    marginTop: 8, background: '#EFECE2', border: '1px solid #D5D1C4', borderRadius: 8,
                    color: '#0F0F10', padding: '8px 12px', fontSize: 13, minWidth: 140,
                  }}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>{m}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Quarter */}
            {granularity === 'quarter' && (
              <div>
                <span className="text-overline" style={{ marginBottom: 6 }}>QUARTAL</span>
                <div className="flex gap-2" style={{ marginTop: 8 }}>
                  {[1, 2, 3, 4].map(q => (
                    <button key={q} onClick={() => setQuarter(q)}
                      className="cursor-pointer rounded" style={{
                        padding: '7px 14px', fontSize: 12,
                        border: `1px solid ${quarter === q ? '#0F0F10' : '#D5D1C4'}`,
                        color: quarter === q ? '#0F0F10' : '#6B7280',
                        background: quarter === q ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>Q{q}</button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ flex: 1 }} />

            <Button variant="secondary" onClick={handleInsights} disabled={alertsLoading}>
              {alertsLoading ? <><Loader2 size={14} className="animate-spin" /> Scan…</> : <><Zap size={14} /> Insight-Scan</>}
            </Button>
            <Button variant="primary" onClick={handleGenerate} disabled={loading}>
              {loading ? <><Loader2 size={14} className="animate-spin" /> Generiere…</> : <><Sparkles size={14} /> Review generieren</>}
            </Button>
          </div>

          {error && (
            <div className="flex items-center gap-2" style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
              <AlertTriangle size={14} style={{ color: '#AA6E6E' }} />
              <span style={{ fontSize: 12, color: '#AA6E6E' }}>{error}</span>
            </div>
          )}
        </div>
      </Card>

      {/* Insight Alerts */}
      {alerts && (
        <div className="no-print" style={{ marginTop: 20 }}>
          <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
            <Bell size={14} style={{ color: '#0F0F10' }} />
            <span className="text-overline">INSIGHT-SCAN · LETZTE 30 TAGE</span>
          </div>
          {alerts.length === 0 && (
            <div style={{ padding: '16px 20px', background: 'rgba(126,170,110,0.06)', border: '1px solid rgba(126,170,110,0.2)', borderRadius: 10, fontSize: 13, color: '#7EAA6E' }}>
              Nichts Auffälliges. Business läuft unauffällig.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {alerts.map((a, i) => {
              const sevColor = a.severity === 'urgent' ? '#AA6E6E' : a.severity === 'warning' ? '#AA956E' : '#6E8AAA';
              const sevBg = a.severity === 'urgent' ? 'rgba(170,110,110,0.06)' : a.severity === 'warning' ? 'rgba(170,149,110,0.06)' : 'rgba(110,138,170,0.06)';
              const done = createdTaskIds.has(i);
              return (
                <div key={i} style={{ padding: '14px 18px', background: sevBg, border: `1px solid ${sevColor}30`, borderRadius: 10 }}>
                  <div className="flex items-start justify-between gap-4">
                    <div style={{ flex: 1 }}>
                      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: sevColor, textTransform: 'uppercase' }}>
                          {a.severity} · {a.category}
                        </span>
                      </div>
                      <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500, marginBottom: 4 }}>{a.title}</div>
                      <div style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.5, marginBottom: 8 }}>{a.detail}</div>
                      <div style={{ fontSize: 12, color: sevColor, lineHeight: 1.5 }}>→ {a.suggestedAction}</div>
                    </div>
                    {done ? (
                      <div className="flex items-center gap-1" style={{ fontSize: 11, color: '#7EAA6E' }}>
                        <CheckCircle2 size={14} /> Task erstellt
                      </div>
                    ) : (
                      <button onClick={() => createTaskForAlert(i, a)}
                        className="cursor-pointer" style={{
                          padding: '6px 12px', fontSize: 11, background: 'rgba(15,15,16,0.08)',
                          border: '1px solid rgba(198,163,109,0.3)', borderRadius: 6, color: '#0F0F10',
                        }}>Task anlegen</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* KPI snapshot preview (even before AI runs) */}
      {context && (
        <div className="no-print" style={{ marginTop: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            <MiniKpi label="UMSATZ" value={fmt(context.revenue.grossRevenue)} unit="BHD" />
            <MiniKpi label="PROFIT" value={fmt(context.revenue.profit)} unit="BHD" />
            <MiniKpi label="MARGE" value={context.revenue.marginPct.toFixed(1)} unit="%" />
            <MiniKpi label="INVOICES" value={String(context.revenue.invoiceCount)} unit={context.previousPeriod ? `vs ${context.previousPeriod.invoiceCount}` : ''} />
          </div>
        </div>
      )}

      {/* Generated Review */}
      {summary && (
        <div style={{ marginTop: 32 }}>
          <div className="flex justify-between items-center no-print" style={{ marginBottom: 16 }}>
            <span className="text-overline">EXECUTIVE SUMMARY · {summaryPeriod}</span>
            <Button variant="secondary" onClick={handlePrint}><Printer size={14} /> PDF drucken</Button>
          </div>

          <div className="report-body" style={{
            padding: '40px 48px',
            background: '#FFFFFF',
            border: '1px solid #E5E1D6',
            borderRadius: 12,
            color: '#0F0F10',
            lineHeight: 1.7,
            fontSize: 14,
          }}>
            <div className="print-header" style={{ marginBottom: 24, paddingBottom: 18, borderBottom: '1px solid #E5E1D6', textAlign: 'center' }}>
              <img src={logoUrl} alt="Lataif Jewellery" style={{ width: '25%', maxWidth: 200, height: 'auto', display: 'block', margin: '0 auto 6px' }} />
              <div style={{ fontSize: 12, color: '#6B7280', marginTop: 6 }}>Executive Review · {summaryPeriod}</div>
            </div>
            <div dangerouslySetInnerHTML={{ __html: mdToHtml(summary) }} className="report-md" />
          </div>

          <style>{`
            .report-md h1 { font-family: 'Playfair Display', Georgia, serif; font-size: 26px; color: #0F0F10; margin: 0 0 14px; font-weight: 400; }
            .report-md h2 { font-family: 'Playfair Display', Georgia, serif; font-size: 18px; color: #0F0F10; margin: 24px 0 10px; font-weight: 400; letter-spacing: 0.02em; }
            .report-md p { margin: 10px 0; }
            .report-md li { margin: 6px 0 6px 20px; list-style-type: disc; }
            .report-md strong { color: #0F0F10; font-weight: 600; }
            @media print {
              .report-body { background: #fff !important; color: #000 !important; border: none !important; padding: 0 !important; }
              .report-md h1, .report-md h2, .report-md strong { color: #000 !important; }
              .report-md h2 { color: #0F0F10 !important; }
              .print-header { border-color: #ccc !important; }
              .print-header .gold-gradient { background: none !important; -webkit-text-fill-color: #0F0F10 !important; color: #0F0F10 !important; }
              .print-header div:last-child { color: #666 !important; }
            }
          `}</style>
        </div>
      )}
    </PageLayout>
  );
}

function MiniKpi({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ padding: '14px 18px', background: '#FFFFFF', border: '1px solid #E5E1D6', borderRadius: 10 }}>
      <span className="text-overline">{label}</span>
      <div style={{ fontSize: 22, fontFamily: "'Playfair Display', Georgia, serif", color: '#0F0F10', marginTop: 4 }}>
        {value} <span style={{ fontSize: 12, color: '#6B7280' }}>{unit}</span>
      </div>
    </div>
  );
}
