// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B PP-3 — was die KI-Knöpfe VOR dem Klick über ihren Rechner wissen.
//
// Am Primary ändert sich nichts: dieselben Knöpfe, derselbe Hinweis auf „Settings → AI", wenn kein
// Schlüssel da ist (dort ist er zu setzen).
//
// Auf PC2 gibt es zwei Arten:
//   • Erkennen (AI Identify) läuft ÜBER den Primary (`primary-ai.ts`). Der Knopf ist gesperrt und
//     sagt warum, solange der Primary keine KI hat, nicht erreichbar ist oder kein Foto vorliegt.
//   • Textvorschläge (Preis, Nachricht, Angebotstext) und der KI-Assistent laufen bewusst NICHT
//     fern: sie bräuchten einen neuen Fernweg durch das Fenster des Primary, der Sekunden externer
//     Wartezeit in seiner Schreibreihenfolge hielte. Auf PC2 sind sie vor dem Klick gesperrt, mit
//     Grund; schreiben kann der Mensch den Text weiterhin selbst.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { isClientMode } from '@/core/bridge/client-mode';
import { primaryAiStatus, type PrimaryAiStatus } from './primary-ai';

export const AI_TEXT_ON_PRIMARY =
  'AI text suggestions run on the main computer, where the AI key lives. Open this there — or write the text yourself.';

/** Textvorschläge und Assistent: auf PC2 gesperrt (s. o.). */
export function aiTextLocked(): boolean {
  return isClientMode();
}

export interface AiGate {
  readonly client: boolean;
  readonly disabled: boolean;
  readonly reason?: string;
}

/** Die Regel für „AI Identify", ohne React — dieselbe Antwort für jede Maske. */
export function aiIdentifyGate(client: boolean, status: PrimaryAiStatus | 'checking', hasImage: boolean): AiGate {
  if (!client) return { client, disabled: false };
  if (status === 'checking') return { client, disabled: true, reason: 'Checking whether AI is set up on the main computer…' };
  if (status === 'not_configured') return { client, disabled: true, reason: 'AI is not set up on the main computer (Settings → AI there).' };
  if (status === 'unreachable') return { client, disabled: true, reason: 'The main computer cannot be reached for AI right now.' };
  if (!hasImage) return { client, disabled: true, reason: 'On this computer AI Identify works from a photo — add one first.' };
  return { client, disabled: false };
}

/** Am Knopf: fragt auf PC2 einmal beim Aufbau, ob der Primary KI hat. */
export function useAiIdentifyGate(hasImage: boolean): AiGate {
  const client = isClientMode();
  const [status, setStatus] = useState<PrimaryAiStatus | 'checking'>(client ? 'checking' : 'ready');
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void primaryAiStatus().then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, [client]);
  return aiIdentifyGate(client, status, hasImage);
}
