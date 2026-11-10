'use client';

import { useState } from 'react';
import type { FollowupItem, FollowupQueueController } from '../../chat/runtime/useFollowupQueue';

function FollowupRow({ item, index, controller }: { item: FollowupItem; index: number; controller: FollowupQueueController }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <li className="followupItem editing">
        <textarea className="followupEditInput" value={draft} rows={2} autoFocus aria-label={`Edit follow-up ${index + 1}`} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setDraft(null); }} />
        <div className="followupItemActions">
          <button type="button" disabled={controller.busy || !draft.trim()} onClick={() => void controller.update(item, draft).then(ok => { if (ok) setDraft(null); })}>Save</button>
          <button type="button" onClick={() => setDraft(null)}>Cancel</button>
        </div>
      </li>
    );
  }
  return (
    <li className="followupItem">
      <span className="followupIndex">{index + 1}.</span>
      <span className="followupText" title={item.text}>{item.text}</span>
      <div className="followupItemActions">
        <button type="button" disabled={controller.busy} onClick={() => setDraft(item.text)} aria-label={`Edit follow-up ${index + 1}`}>Edit</button>
        <button type="button" disabled={controller.busy} onClick={() => void controller.remove(item)} aria-label={`Remove follow-up ${index + 1}`}>Remove</button>
      </div>
    </li>
  );
}

export function FollowupQueueTray({ controller }: { controller: FollowupQueueController }) {
  if (!controller.items.length && !controller.error) return null;
  return (
    <div className="followupTray" aria-label="Queued follow-ups">
      {controller.items.length > 0 && (
        <>
          <div className="followupTrayHeader">
            <span>Queued follow-ups ({controller.items.length}) · sent together when the agent finishes{controller.paused ? ' — paused' : ''}</span>
            <button type="button" className="followupSendNow" disabled={controller.busy} onClick={() => void controller.sendNow()}>{controller.running ? 'Interrupt & send now' : 'Send now'}</button>
          </div>
          <ol className="followupList">
            {controller.items.map((item, index) => <FollowupRow key={`${item.id}:${item.version}`} item={item} index={index} controller={controller} />)}
          </ol>
        </>
      )}
      {controller.error && (
        <div className="followupError" role="alert">
          {controller.error}
          <button type="button" onClick={controller.dismissError} aria-label="Dismiss">×</button>
        </div>
      )}
    </div>
  );
}
