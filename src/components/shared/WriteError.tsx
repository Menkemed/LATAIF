// CENTRAL-UI-PARITY R4C — der Ausgang eines Speicherversuchs, an einer Stelle formuliert.
//
// Jede Seite mit Schreibhandlungen hat GENAU eine solche Anzeige. Sie steht auch dann da, wenn
// der Ausgang offen ist — „keine Antwort" ist eine Auskunft, kein Erfolg und kein Nichts.
export function WriteError({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div data-save-error style={{
      margin: '12px 0', padding: '10px 14px', borderRadius: 6, fontSize: 12, lineHeight: 1.5,
      background: 'rgba(220,80,60,0.08)', border: '1px solid rgba(220,80,60,0.3)', color: '#8B2E22',
    }}>{text}</div>
  );
}
