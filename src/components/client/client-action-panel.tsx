// CENTRAL-C3H — der eine Baustein, aus dem alle sechzehn Lebenszyklus-Knöpfe des Clients
// bestehen.
//
// Er entstand, weil sonst sechzehnmal dasselbe dagestanden hätte: ein eigener Wächter, ein
// „läuft gerade", die Wiederholung eines offenen Versuchs mit DERSELBEN Kennung, die Anzeige des
// Ausgangs, und — der Teil, der in C3G FINAL zweimal falsch war — das Übernehmen der NEUEN
// Fassung aus der Antwort. Sechzehn Abschriften davon wären sechzehn Stellen, an denen genau das
// wieder vergessen wird.
//
// Was der Baustein zusagt:
//
//   • **Ein Vorsatz, ein Wächter.** Jede Aktion bekommt ihren eigenen; ein hängengebliebener
//     Statuswechsel läuft nie als Zahlung weiter.
//   • **Offener Ausgang hält die Kennung.** Ein erneuter Klick wiederholt denselben Versuch,
//     statt einen zweiten Vorgang zu schreiben. Der Knopf sagt das auch.
//   • **Die Antwort trägt die neue Fassung**, und sie wird übernommen. Ohne das nennt die
//     nächste Aktion an demselben Vorgang einen Stand, den der eigene Klick gerade überholt hat.
//   • **Bestätigungen sind neue Vorsätze.** Wer nach einem „das ist unter Preis / unter dem
//     Boden" doch will, klickt einen ZWEITEN Knopf — und der beginnt einen neuen Versuch mit
//     einer neuen Kennung und einem ausdrücklichen, eng begrenzten Zusatz. Niemals dieselbe
//     Kennung mit geändertem Rumpf.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { CommandSaveController, type SaveOutcome } from '@/core/bridge/client-command-save';
import { Outcome } from './client-form-atoms';
import { btn } from './client-form-style';

export interface ActionValue {
  revision?: number;
  replayed?: boolean;
  [k: string]: unknown;
}

export interface ClientActionProps {
  /** Der freigegebene Name — er ist zugleich der Wächter dieses Vorsatzes. */
  op: string;
  /** Für die Prüfpunkte in der Oberfläche: `data-client-action="repair.status"`. */
  kind: string;
  label: string;
  /** Der Rumpf. Er entsteht in `client-lifecycle-request`, nicht hier. */
  body: () => Record<string, unknown>;
  disabled?: boolean;
  /** Was nach einem Erfolg passiert — vor allem: die neue Fassung übernehmen. */
  onDone?: (value: ActionValue, replayed: boolean) => void;
  /** Felder über dem Knopf. */
  children?: ReactNode;
  /**
   * Ein zweiter, ausdrücklicher Versuch nach einem bestimmten fachlichen Nein. `codes` nennt
   * GENAU die Urteile, nach denen er erscheint — nicht „nach jedem Fehler".
   */
  confirm?: {
    codes: readonly string[];
    label: string;
    body: () => Record<string, unknown>;
  };
}

export function ClientAction({
  op, kind, label, body, disabled, onDone, children, confirm,
}: ClientActionProps) {
  const controller = useMemo(() => new CommandSaveController<ActionValue>(op), [op]);
  // Der Bestätigungsweg hat einen EIGENEN Wächter: er ist ein anderer Vorsatz desselben
  // Menschen, und er darf die verbrannte Kennung des ersten nicht erben.
  const confirmController = useMemo(() => new CommandSaveController<ActionValue>(op), [op]);
  const [outcome, setOutcome] = useState<SaveOutcome<ActionValue> | null>(null);
  const [busy, setBusy] = useState(false);

  const send = useCallback(async (which: 'plain' | 'confirm') => {
    setBusy(true);
    try {
      const ctl = which === 'confirm' ? confirmController : controller;
      const attempt = ctl.beginAttempt();
      const out = await attempt.send(which === 'confirm' ? confirm!.body() : body());
      setOutcome(out);
      if (out.kind === 'ok') {
        onDone?.(out.value, out.replayed);
      }
    } finally {
      setBusy(false);
    }
  }, [controller, confirmController, body, confirm, onDone]);

  const pending = outcome?.kind === 'unknown';
  const rejected = outcome?.kind === 'business_error' ? outcome.code : null;
  const showConfirm = !!confirm && !!rejected && confirm.codes.includes(rejected);

  return (
    <div data-client-action={kind} style={{ marginTop: 12 }}>
      {children}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          data-client-action-send={kind}
          disabled={busy || (disabled && !pending)}
          onClick={() => send('plain')}
          style={btn(true)}
        >
          {pending ? `Retry the same ${label.toLowerCase()}` : label}
        </button>
        {showConfirm && (
          <button
            data-client-action-confirm={kind}
            disabled={busy}
            onClick={() => send('confirm')}
            style={btn(false)}
          >
            {confirm!.label}
          </button>
        )}
        {outcome?.kind === 'ok' && (
          <span data-client-action-ok={kind} style={{ alignSelf: 'center', opacity: 0.8 }}>
            {outcome.replayed ? 'Already done — this was the same attempt, not a second one.' : 'Done.'}
          </span>
        )}
      </div>
      <Outcome kind={kind} outcome={outcome} />
    </div>
  );
}
