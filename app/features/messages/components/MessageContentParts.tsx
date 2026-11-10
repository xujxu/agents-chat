'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../markdownHelpers';
import type { ContentPart } from '../../chat/chatTypes';
import { MessageToolCall } from './MessageToolCall';
import { getStatusDisplayText } from '../messageDisplayHelpers';
import { linkWorkItems } from '@/lib/workItemLinks';
export function MessageContentParts({
  parts,
  pending,
  statusText,
  workItemUrl,
}: {
  parts: ContentPart[];
  pending?: boolean;
  statusText?: string;
  workItemUrl?: string;
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
          return <MessageToolCall key={pi} part={part} displayName={displayName} />;
        }
        if (part.kind === 'user_answer') {
          return (
            <div key={pi} className="userAnswerPart">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.kind === 'text') {
          return (
            <div key={pi} className={`messageContent markdownBody ${pending ? 'pending' : ''}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{linkWorkItems(part.text, workItemUrl)}</ReactMarkdown>
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
