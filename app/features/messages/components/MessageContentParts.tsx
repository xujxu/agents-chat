'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../markdownHelpers';
import type { ContentPart } from '../../chat/chatTypes';
import { MessageToolCall as ToolCall } from './MessageToolCall';
import { getStatusDisplayText } from '../messageDisplayHelpers';

// Streaming polls reuse unchanged part objects, so memoizing lets only new or growing parts re-render.
const MessageToolCall = memo(ToolCall);
const MarkdownPart = memo(function MarkdownPart({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>;
});

export function MessageContentParts({
  parts,
  pending,
  statusText,
}: {
  parts: ContentPart[];
  pending?: boolean;
  statusText?: string;
}) {
  return (
    <>
      {parts.map((part, pi) => {
        if (part.kind === 'thinking') {
          return (
            <div key={pi} className="thinkingPart">
              <div className="thinkingPartText">{part.text}</div>
            </div>
          );
        }
        if (part.kind === 'tool') {
          const displayName = statusText === 'Interrupted'
            && pi === parts.length - 1
            && part.toolName === 'Reading shell output'
            ? 'Interrupted shell output'
            : undefined;
          return <MessageToolCall key={pi} part={part} displayName={displayName} stopped={!pending} />;
        }
        if (part.kind === 'user_answer') {
          return (
            <div key={pi} className="userAnswerPart">
              <MarkdownPart text={part.text} />
            </div>
          );
        }
        if (part.kind === 'text') {
          return (
            <div key={pi} className={`messageContent markdownBody ${pending ? 'pending' : ''}`}>
              <MarkdownPart text={part.text} />
            </div>
          );
        }
        return null;
      })}
      {pending && (
        <div className="streamingIndicator">
          <span className="streamingPulse" />
          <span>{getStatusDisplayText(statusText, 'Generating')}</span>
        </div>
      )}
    </>
  );
}
