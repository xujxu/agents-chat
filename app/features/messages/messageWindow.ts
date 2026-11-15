export const MESSAGE_WINDOW_STEP = 40;

/**
 * Index of the first rendered message. `startId` undefined means "not chosen yet" (newest
 * MESSAGE_WINDOW_STEP), null means "everything", and an id that is no longer present (for
 * example after a rewind) falls back to the default window.
 */
export function resolveMessageWindowStart(messages: Array<{ id: string }>, startId: string | null | undefined): number {
  if (startId === null) return 0;
  if (startId !== undefined) {
    const index = messages.findIndex((message) => message.id === startId);
    if (index >= 0) return index;
  }
  return Math.max(0, messages.length - MESSAGE_WINDOW_STEP);
}