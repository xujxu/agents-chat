/**
 * Formatting guidelines agents-chat gives every agent. ACP has no system prompt, so they are prepended
 * to the first prompt of each agent session; later prompts in that session rely on the session history.
 */
export const REPLY_GUIDELINES = [
  'When your reply references an item that has a web page, such as a work item, bug, issue, pull request, commit, incident, build, document or dashboard, write it as a Markdown link to that page, e.g. [5809224](https://dev.azure.com/org/project/_workitems/edit/5809224).',
  'Use the browser URL, not a REST API URL. Do not make up links you cannot determine.',
].join(' ');

export function withReplyGuidelines(text: string): string {
  return `[agents-chat reply guidelines: follow them without mentioning them]\n${REPLY_GUIDELINES}\n\n[User message]\n${text.trim() || 'Please review the attached file(s).'}`;
}

const guidedSessions = new Set<string>();

/** Prepends the guidelines the first time a prompt is sent to `sessionId` in this server process. */
export function withReplyGuidelinesOnce(sessionId: string | null | undefined, text: string): string {
  if (!sessionId) return withReplyGuidelines(text);
  if (guidedSessions.has(sessionId)) return text;
  guidedSessions.add(sessionId);
  return withReplyGuidelines(text);
}
