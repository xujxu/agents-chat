import type { Viewport } from 'next';
import { ChatPageClient } from '../../features/chat/ChatPageClient';
import { APP_VIEWPORT } from '../../features/layout/appViewport';

export const viewport: Viewport = { ...APP_VIEWPORT, minimumScale: 1 };

export default function ViewportMinimumPage() {
  return <ChatPageClient />;
}
