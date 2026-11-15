'use client';

import { useMemo, useState } from 'react';
import type { ContentPart } from '../../chat/chatTypes';
import { isToolResultTruncated, TOOL_RESULT_MAX_CHARS } from '@/lib/acp/toolOutput';

type ToolPart = ContentPart & { kind: 'tool' };

const MAX_DISPLAY_CHARS = 2000;

/**
 * Tool call args/results are typically JSON.stringify'd payloads, which means
 * any embedded newlines/tabs appear as literal `\n` / `\r\n` / `\t` escape
 * sequences. Pretty-print the JSON when possible and convert those escapes back
 * to real whitespace so the content reads naturally in a <pre> block.
 */
function prettifyToolPayload(raw: string | undefined | null): { text: string; shortened: boolean } {
  if (!raw) return { text: '', shortened: false };
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
  if (text.length > MAX_DISPLAY_CHARS) return { text: text.slice(0, MAX_DISPLAY_CHARS) + '…', shortened: true };
  return { text, shortened: false };
}

export function MessageToolCall({ part, displayName, stopped }: { part: ToolPart; displayName?: string; stopped?: boolean }) {
  // A tool that never finished in a reply that is no longer running must not look like it is still working.
  const state = part.done ? 'complete' : stopped ? 'stopped' : 'running';
  const running = state === 'running';
  // `open` follows the running state exactly as before; the body only renders while the element is actually open.
  const [open, setOpen] = useState(running);
  return (
    <details className="toolCallItem" open={running} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={`toolCallSummary ${state}`} title={state === 'stopped' ? 'Did not finish' : undefined}>
        <span className="toolCallIcon">{state === 'complete' ? '✅' : state === 'stopped' ? '⏹' : '⏳'}</span>
        <span className="toolCallName">{displayName || part.toolName}</span>
      </summary>
      {(open || running) && <ToolCallBody part={part} />}
    </details>
  );
}

function ToolCallBody({ part }: { part: ToolPart }) {
  const args = useMemo(() => prettifyToolPayload(part.args), [part.args]);
  const result = useMemo(() => prettifyToolPayload(part.result), [part.result]);
  const resultCut = isToolResultTruncated(part);
  return (
    <>
      {args.text && <pre className="toolCallDetail">{args.text}</pre>}
      {args.shortened && <div className="toolCallTruncated">Input shortened: showing the first {MAX_DISPLAY_CHARS.toLocaleString('en-US')} characters.</div>}
      {result.text && <pre className="toolCallDetail toolCallResult">{result.text}</pre>}
      {(resultCut || result.shortened) && (
        <div className="toolCallTruncated">
          {resultCut
            ? `Output truncated: only the first ${TOOL_RESULT_MAX_CHARS.toLocaleString('en-US')} characters were saved.`
            : `Output shortened: showing the first ${MAX_DISPLAY_CHARS.toLocaleString('en-US')} characters.`}
        </div>
      )}
    </>
  );
}
