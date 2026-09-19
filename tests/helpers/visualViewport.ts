import type { Page } from '@playwright/test';

export async function dispatchViewportTouches(page: Page, count: number): Promise<void> {
  await page.evaluate(value => {
    const event = new Event(value ? 'touchstart' : 'touchend');
    Object.defineProperty(event, 'touches', { value: Array.from({ length: value }, () => ({})) });
    window.dispatchEvent(event);
  }, count);
}

export async function installTestVisualViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let height: number | null = null;
    let offsetTop = 0;
    let scale = 1;
    const listeners = new Map<string, Set<EventListener>>();
    const visualViewport = {
      get height() { return height ?? window.innerHeight; },
      get width() { return window.innerWidth / scale; },
      get offsetTop() { return offsetTop; },
      get offsetLeft() { return 0; },
      get pageTop() { return offsetTop; },
      get pageLeft() { return 0; },
      get scale() { return scale; },
      addEventListener(type: string, listener: EventListener) {
        const handlers = listeners.get(type) || new Set<EventListener>();
        handlers.add(listener);
        listeners.set(type, handlers);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
    };

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    (window as typeof window & { setTestVisualViewport: (nextHeight: number, nextOffsetTop: number, nextScale?: number) => void })
      .setTestVisualViewport = (nextHeight, nextOffsetTop, nextScale = 1) => {
        height = nextHeight;
        offsetTop = nextOffsetTop;
        scale = nextScale;
        for (const listener of listeners.get('resize') || []) listener(new Event('resize'));
        for (const listener of listeners.get('scroll') || []) listener(new Event('scroll'));
      };
  });
}

export async function setTestVisualViewport(page: Page, height: number, offsetTop: number, scale = 1): Promise<void> {
  await page.evaluate(({ nextHeight, nextOffsetTop, nextScale }) => {
    (window as typeof window & { setTestVisualViewport: (height: number, top: number, scale?: number) => void })
      .setTestVisualViewport(nextHeight, nextOffsetTop, nextScale);
  }, { nextHeight: height, nextOffsetTop: offsetTop, nextScale: scale });
}
