/** Tool results are saved and shown up to this many characters; the rest is dropped. */
export const TOOL_RESULT_MAX_CHARS = 2000;

export function capToolResult(raw: unknown): { text: string; truncated: boolean } {
  const full = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return { text: full.slice(0, TOOL_RESULT_MAX_CHARS), truncated: full.length > TOOL_RESULT_MAX_CHARS };
}

/** Results saved before the flag existed were cut at exactly the cap, so that length marks them. */
export function isToolResultTruncated(part: { result?: string; resultTruncated?: boolean }): boolean {
  return part.resultTruncated ?? part.result?.length === TOOL_RESULT_MAX_CHARS;
}
