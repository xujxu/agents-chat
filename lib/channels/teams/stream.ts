import { createLogger } from '@/lib/logger';
import type { TeamsConfig } from './config';
import { sendActivity, sendText, sendTyping, type ConversationRef } from './connector';
import { splitForTeams, TEAMS_MAX_TEXT } from './util';

const logger = createLogger('teams-stream');

const MIN_INTERVAL_MS = 1500;
const TYPING_INTERVAL_MS = 3000;
const MAX_STREAM_AGE_MS = 8 * 60_000;
const MAX_INFORMATIVE = 1000;

/**
 * Streams a growing agent response into a Teams 1:1 chat using the Teams streaming protocol.
 * Falls back to plain messages if streaming is rejected. Long or long-lived responses are
 * committed and continued in a new stream so each message stays within Teams limits.
 */
export class TeamsStreamer {
  private streamId: string | undefined;
  private sequence = 0;
  private streamStartedAt = 0;
  private lastSentAt = 0;
  private lastSegment = '';
  /** Characters of the response already committed as final messages. */
  private offset = 0;
  private anySent = false;
  private fallback = false;
  private busy: Promise<void> = Promise.resolve();
  /** True until the first message of the response (which carries the header) is delivered. */
  private headerPending: boolean;

  /** `header` (e.g. the agent name) is shown above the first message of the response. */
  constructor(private readonly config: TeamsConfig, private readonly ref: ConversationRef, private readonly maxText = TEAMS_MAX_TEXT, private readonly header = '') {
    this.headerPending = !!header;
  }

  /** Status line shown before any content arrives in the current stream. */
  informative(text: string): Promise<void> {
    return this.enqueue(async () => {
      if (!text || this.lastSegment || Date.now() - this.lastSentAt < MIN_INTERVAL_MS) return;
      if (this.fallback) return this.typing();
      await this.post('informative', text.slice(0, MAX_INFORMATIVE));
    });
  }

  /** Push the full response text so far (not a delta). */
  update(fullText: string): Promise<void> {
    return this.enqueue(async () => {
      if (Date.now() - this.lastSentAt < MIN_INTERVAL_MS) return;
      if (this.fallback) return this.typing();

      let segment = fullText.slice(this.offset);
      while (segment.length > this.maxText || (this.streamId && Date.now() - this.streamStartedAt > MAX_STREAM_AGE_MS)) {
        const [first] = splitForTeams(segment, this.maxText);
        if (!(await this.commit(first))) return;
        this.advance(segment, first.length);
        segment = fullText.slice(this.offset);
      }

      if (!segment.trim() || segment === this.lastSegment) return;
      // Teams requires each streamed chunk to extend the previous one.
      if (this.lastSegment && !segment.startsWith(this.lastSegment)) return;
      if (await this.post('streaming', this.withHeader(segment))) this.lastSegment = segment;
    });
  }

  /** Commit everything up to `fullText` (e.g. before asking the user a question); later text starts a new message. */
  flush(fullText: string): Promise<void> {
    return this.enqueue(() => this.commitRemaining(fullText));
  }

  /** Close the response with its final text. */
  finish(finalText: string): Promise<void> {
    return this.enqueue(async () => {
      await this.commitRemaining(finalText);
      if (!this.anySent) {
        await sendText(this.config, this.ref, this.withHeader('_(no response)_'));
        this.headerPending = false;
        this.anySent = true;
      }
    });
  }

  private async commitRemaining(fullText: string): Promise<void> {
    const remaining = fullText.slice(this.offset);
    if (remaining.trim()) {
      for (const chunk of splitForTeams(remaining, this.maxText)) {
        if (!(await this.commit(chunk))) {
          await sendText(this.config, this.ref, this.withHeader(chunk));
          this.headerPending = false;
          this.anySent = true;
        }
      }
    } else if (this.streamId && !this.fallback) {
      // Close an informative-only stream so the Teams progress indicator goes away.
      await this.commit(this.lastSegment || '…');
    }
    this.offset = Math.max(this.offset, fullText.length);
    this.resetStream();
  }

  /** Send `text` as a final message, closing the current stream if any. Returns false if it could not be delivered. */
  private async commit(segment: string): Promise<boolean> {
    const text = this.withHeader(segment);
    try {
      if (this.streamId && !this.fallback) {
        await sendActivity(this.config, this.ref, {
          type: 'message',
          textFormat: 'markdown',
          text,
          channelData: { streamId: this.streamId, streamType: 'final' },
          entities: [{ type: 'streaminfo', streamId: this.streamId, streamType: 'final' }],
        });
      } else {
        await sendText(this.config, this.ref, text);
      }
      this.anySent = true;
      this.headerPending = false;
      this.lastSentAt = Date.now();
      return true;
    } catch (err) {
      this.markFallback(err);
      return false;
    } finally {
      this.resetStream();
    }
  }

  private withHeader(text: string): string {
    return this.headerPending ? `${this.header}\n\n${text}` : text;
  }

  private advance(segment: string, length: number): void {
    const skipped = /^\n*/.exec(segment.slice(length))?.[0].length ?? 0;
    this.offset += length + skipped;
  }

  private resetStream(): void {
    this.streamId = undefined;
    this.sequence = 0;
    this.lastSegment = '';
  }

  private async post(streamType: 'informative' | 'streaming', text: string): Promise<boolean> {
    const sequence = this.sequence + 1;
    const streamInfo: Record<string, unknown> = { type: 'streaminfo', streamType, streamSequence: sequence };
    if (this.streamId) streamInfo.streamId = this.streamId;
    try {
      const id = await sendActivity(this.config, this.ref, {
        type: 'typing',
        text,
        channelData: { streamType, streamSequence: sequence, ...(this.streamId ? { streamId: this.streamId } : {}) },
        entities: [streamInfo],
      });
      if (!this.streamId) {
        if (!id) throw new Error('stream_id_missing');
        this.streamId = id;
        this.streamStartedAt = Date.now();
      }
      this.sequence = sequence;
      this.lastSentAt = Date.now();
      return true;
    } catch (err) {
      this.markFallback(err);
      return false;
    }
  }

  private async typing(): Promise<void> {
    if (Date.now() - this.lastSentAt < TYPING_INTERVAL_MS) return;
    this.lastSentAt = Date.now();
    await sendTyping(this.config, this.ref).catch(() => undefined);
  }

  private markFallback(err: unknown): void {
    if (!this.fallback) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), body: (err as { body?: string })?.body }, 'Teams streaming failed; falling back to plain messages');
    }
    this.fallback = true;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.busy.then(task, task);
    this.busy = next.catch(() => undefined);
    return next;
  }
}
