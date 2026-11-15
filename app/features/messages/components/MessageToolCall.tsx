'use client';

import { useMemo } from 'react';
import type { ContentPart } from '../../chat/chatTypes';

type ToolPart = ContentPart & { kind: 'tool' };

const MAX_DISPLAY_CHARS = 2000;

/**
 * Tool call args/results are typically JSON.stringify'd payloads, which means
 * any embedded newlines/tabs appear as literal `\n` / `\r\n` / `\t` escape
 * sequences. Pretty-print the JSON when possible and convert those escapes back
 * to real whitespace so the content reads naturally in a <pre> block.
 */
function prettifyToolPayload(raw: string | undefined | null): string {
  if (!raw) return '';
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      text = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // not JSON — fall through and unescape any literal escape sequences below
  }
  text = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
  if (text.length > MAX_DISPLAY_CHARS) text = text.slice(0, MAX_DISPLAY_CHARS) + '…';
  return text;
}

export function MessageToolCall({ part, displayName, stopped }: { part: ToolPart; displayName?: string; stopped?: boolean }) {
  const argsText = useMemo(() => prettifyToolPayload(part.args), [part.args]);
  const resultText = useMemo(() => prettifyToolPayload(part.result), [part.result]);
  // A tool that never finished in a reply that is no longer running must not look like it is still working.
  const state = part.done ? 'complete' : stopped ? 'stopped' : 'running';
  return (
    <details className="toolCallItem" open={state === 'running'}>
      <summary className={`toolCallSummary ${state}`} title={state === 'stopped' ? 'Did not finish' : undefined}>
        <span className="toolCallIcon">{state === 'complete' ? '✅' : state === 'stopped' ? '⏹' : '⏳'}</span>
        <span className="toolCallName">{displayName || part.toolName}</span>
      </summary>
      {argsText && (
        <pre className="toolCallDetail">{argsText}</pre>
      )}
      {resultText && (
        <pre className="toolCallDetail toolCallResult">{resultText}</pre>
      )}
    </details>
  );
}
