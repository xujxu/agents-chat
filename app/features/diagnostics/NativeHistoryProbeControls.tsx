import type { ProbeEvidence } from '../../../lib/viewportDiagnostics';

const reasons: Record<ProbeEvidence['reason'], string> = {
  none: '',
  'fresh-tab': 'Open this diagnostic URL in a fresh tab with one history entry.',
  geometry: 'Native viewport geometry does not meet this action\'s requirements.',
  touch: 'Release all touches before trying this action.',
  focus: 'Close the keyboard and leave editable fields before trying this action.',
  unstable: 'Wait for the native viewport to settle before restoring.',
  rotation: 'Reproduce the enlargement by rotating after the checkpoint.',
  ownership: 'History, URL, or chat identity changed. This attempt is invalid.',
  lifecycle: 'The experiment document was left. This attempt is invalid.',
  interrupted: 'A gesture, focus change, or navigation interrupted this attempt.',
  'history-error': 'The browser rejected a history operation. No automatic retry.',
  'ack-timeout': 'The expected same-document history traversal was not confirmed.',
  'scale-timeout': 'Native scale and viewport geometry did not return to 100%.',
};

export function NativeHistoryProbeControls({
  evidence, arm, restore,
}: { evidence: ProbeEvidence; arm: () => void; restore: () => void }) {
  return (
    <section aria-label="Native history probe" data-phase={evidence.phase}>
      <p className="viewportDiagnosticsHint">
        Experiment only. Start in a fresh tab before pinching. Establishing a checkpoint
        adds one same-page history entry. No reload or visual compensation.
      </p>
      <button type="button" onClick={arm} disabled={evidence.phase !== 'idle'}>
        Establish 100% checkpoint
      </button>
      <button type="button" onClick={restore} disabled={evidence.phase !== 'armed'}>
        Restore native scale
      </button>
      <p role="status" aria-live="polite" data-testid="native-history-status">
        {evidence.phase}. {reasons[evidence.reason]}
        {evidence.phase === 'armed' && evidence.reason === 'none'
          ? ' Pinch, return to 100%, rotate, then restore if enlarged.' : ''}
        {evidence.phase === 'restored' ? ' Native scale and geometry restored without replacing the chat DOM.' : ''}
      </p>
    </section>
  );
}
