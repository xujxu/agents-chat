import type { AutoProbeEvidence } from '../../../lib/viewportDiagnostics';
import { PROBE_REASON_MESSAGES } from './NativeHistoryProbeControls';

const reasons: Record<AutoProbeEvidence['reason'], string> = {
  ...PROBE_REASON_MESSAGES,
  unassessed: 'This rotation could not be assessed safely. No correction was attempted.',
  nonunit: 'Intentional non-100% zoom is preserved by this controller.',
  overlay: 'A mobile overlay changed the navigation context. Automatic recovery stopped.',
  overflow: 'Document overflow prevents a reliable native-scale assessment.',
  superseded: 'Another rotation interrupted recovery. No automatic retry.',
  'stopped-by-user': 'Automatic recovery is stopped. Existing history is left intact.',
  'intent-unknown': 'A scale change could not be attributed to rotation. No forced reset.',
};

export function AutomaticRecoveryControls({
  evidence, arm, stop,
}: { evidence: AutoProbeEvidence; arm: () => void; stop: () => void }) {
  return (
    <section aria-label="Automatic native recovery" data-phase={evidence.phase}
      data-corrections={evidence.corrections} data-intent={evidence.intent}>
      <p className="viewportDiagnosticsHint">
        Opt-in experiment. Start in a fresh tab at 100% before pinching.
        Adds one same-page history entry. Unexpected rotation zoom may appear
        briefly before correction. Navigation or recovery errors stop the experiment.
      </p>
      {evidence.reason === 'fresh-tab' ? (
        <p><a href="/diagnostics/viewport-auto?viewportDiagnostics=baseline" target="_blank" rel="noopener noreferrer">
          Open a fresh automatic experiment tab
        </a></p>
      ) : null}
      <button type="button" onClick={arm} disabled={evidence.phase !== 'idle'}>
        Enable automatic recovery
      </button>
      <button type="button" onClick={stop} disabled={['stopped', 'error'].includes(evidence.phase)}>
        Stop automatic recovery
      </button>
      <p role="status" aria-live="polite" data-testid="automatic-recovery-status">
        {evidence.phase}. Corrections: {evidence.corrections}. {reasons[evidence.reason]}
      </p>
    </section>
  );
}
