// CENTRAL-UI-PARITY R2B — die ehrliche Antwort für das, was NICHT über das Netz geht.
//
// Die Oberfläche ist auf beiden Rechnern dieselbe, und genau deshalb braucht es diese Stelle:
// ein paar Bereiche gehören nicht zur Geschäftsansicht, sondern zur MASCHINE — Einstellungen,
// Sicherung, Datenort, Wartung, Entwicklerwerkzeuge. Sie wirken dort, wo die Datenbank liegt.
// Aus der Ferne dieselbe Maske zu zeigen, wäre eine Lüge: die Schalter würden entweder nichts
// tun oder am falschen Rechner wirken.
//
// Also wird gesagt, was ist. Kein leerer Bildschirm, keine Nullen, keine Fehlermeldung, die
// nach einem Defekt aussieht — ein Satz, der den Weg nennt.
//
// Das ist ausdrücklich KEIN zweiter Oberflächenzweig: die Geschäftsflächen laufen auf beiden
// Rechnern durch denselben Code. Diese Notiz erscheint nur dort, wo die Sache selbst am
// Hauptrechner hängt.
import { Monitor } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Card } from '@/components/ui/Card';

interface PrimaryOnlyNoticeProps {
  /** Der Name der Fläche, so wie er in der Navigation steht. */
  title: string;
  /** Warum genau diese Fläche am Hauptrechner hängt — ein Satz, in der Sprache des Benutzers. */
  reason: string;
}

export function PrimaryOnlyNotice({ title, reason }: PrimaryOnlyNoticeProps) {
  return (
    <PageLayout title={title}>
      <div style={{ padding: '32px 48px', maxWidth: 720 }}>
        <Card>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div
              style={{
                width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                background: '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Monitor size={20} style={{ color: '#6B7280' }} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#0F0F10', marginBottom: 6 }}>
                Only available on the main computer
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: '#6B7280' }}>
                {reason}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </PageLayout>
  );
}
