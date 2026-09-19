import type { PreventiveProbeEvidence } from '../../../lib/viewportDiagnostics';
import { PROBE_REASON_MESSAGES } from './NativeHistoryProbeControls';

const reasons: Record<PreventiveProbeEvidence['reason'], string> = {
  ...PROBE_REASON_MESSAGES,
  nonunit: 'Non-original zoom is preserved. No preparation was requested.',
  overlay: 'A mobile overlay changed navigation ownership. The experiment stopped.',
  overflow: 'Document overflow prevents safe preparation.',
  superseded: 'Rotation cancelled this gesture. No post-rotation correction is attempted.',
  'stopped-by-user': 'Prevention is stopped. Existing history is left intact.',
  unassessed: 'This gesture did not establish a stable original-scale baseline. No retry.',
  'no-scale-change': 'No native scale departure was observed during the multi-touch gesture.',
  'counter-limit': 'The diagnostic counter limit was reached. Start a fresh experiment tab.',
};

export function PreventiveRecoveryControls({
  evidence, arm, stop,
}: { evidence: PreventiveProbeEvidence; arm: () => void; stop: () => void }) {
  return (
    <section aria-label="Native rotation prevention" data-phase={evidence.phase}
      data-preparations={evidence.preparations} data-intent={evidence.intent}>
      <p className="viewportDiagnosticsHint">
        Experiment only. Enable at 100% in a fresh tab. Adds one same-page history entry.
        After pinching back to the original scale, release all fingers and wait for
        the preparation count to increase before rotating. A completed preparation
        does not prove prevention. No post-rotation correction or retry.
      </p>
      {evidence.reason === 'fresh-tab' ? (
        <p><a href="/diagnostics/viewport-preventive?viewportDiagnostics=baseline" target="_blank" rel="noopener noreferrer">
          Open a fresh preventive experiment tab
        </a></p>
      ) : null}
      <button type="button" onClick={arm} disabled={evidence.phase !== 'idle'}>
        Enable rotation prevention
      </button>
      <button type="button" onClick={stop} disabled={['stopped', 'error'].includes(evidence.phase)}>
        Stop rotation prevention
      </button>
      <p role="status" aria-live="polite">
        {evidence.phase}. Preparations: {evidence.preparations}. {reasons[evidence.reason]}
      </p>
    </section>
  );
}
